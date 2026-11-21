'use server';

import { revalidatePath, updateTag } from 'next/cache';
import { headers } from 'next/headers';
import { z } from 'zod';

import { rethrowControlFlow } from '@/lib/control-flow';
import { classifyMfaCodeError } from '@/server/actions/auth-error-classify';
import { uncheckedAccessResult, unexpectedActionError } from '@/server/lib/action-error-result';
import { audit } from '@/server/services/audit';
import { assertCurrentAal2, ServiceError, withContext } from '@/server/services/context';
import { dispatchEvent } from '@/server/services/integration-events';
import { SESSION_CHANGED } from '@/server/services/step-up-held';
import {
  checkMfaCode,
  MFA_CHALLENGE_NOT_STARTED,
  MFA_CODE_BUDGET_SPENT,
  MFA_CODE_GOTRUE_LIMITED,
  MFA_CODE_NOT_CHECKED,
  MFA_CODE_REFUSED,
  MFA_SECOND_STEP_CANT_USE,
  MFA_SECOND_STEP_CANT_USE_WITH_APP,
  MFA_SESSION_ENDED,
  MFA_SETUP_NOT_OPEN,
  MFA_SETUP_UNREADABLE,
  signOutThisSession,
} from '@/lib/auth/mfa-code-attempts';
import { contextFactorsOf } from '@/lib/auth/context-factor-list';
import { factorsOf, readMfaFactorList, type MfaFactorList } from '@/lib/auth/mfa-factors';
import { enforcedMfaPolicy } from '@/lib/auth/mfa-policy';
import {
  accountIdHash,
  appFactorsForCode,
  FACTOR_CHECK_RETRY,
  factorChangeRefusal,
  passkeyRecordsUnread,
  readPasskeyBridge,
  refusedForCode,
} from '@/lib/auth/passkey-bridge';
import { requireOrgContext, requireSession } from '@/lib/auth/session';
import { isSessionEndedError } from '@/lib/auth/session-ended';
import { sessionAccountNow, type SessionAccountNow } from '@/lib/auth/session-account';
import { readVerifiedSessionClaims } from '@/lib/auth/verified-claims';
import { verifyPasswordSideChannel } from '@/lib/auth/verify-password';
import { reportError } from '@/lib/error-reporter';
import { clientIpFromHeaders } from '@/lib/client-ip';
import { checkRateLimit } from '@/lib/rate-limit';
import { createClient } from '@/lib/supabase/server';

import { err, ok, type ActionResult } from '@stockpilot/core';

type GoTrueError = { code?: unknown; name?: unknown; status?: unknown; message?: unknown };

/** GoTrue's structured code for a report, never its message. */
function goTrueCode(error: GoTrueError | null | undefined): { code?: string } {
  return typeof error?.code === 'string' ? { code: error.code } : {};
}

/**
 * The answer to an authenticator challenge or code check GoTrue did not pass,
 * chosen by how it answered (classifyMfaCodeError: code, SDK name, status),
 * never its message, which can carry factor and challenge identifiers (S31;
 * the words of docket S29-S32). Only a code GoTrue judged wrong is "not
 * valid"; a gone session, GoTrue's own rate limit and no answer say so; a
 * challenge that could not start, or an answer this does not know, is
 * reported (the latter as a warning).
 */
function mfaCodeFailure(
  step: 'challenge' | 'verify',
  error: GoTrueError | null | undefined,
  tag: string,
): ActionResult<never> {
  const outcome = classifyMfaCodeError(error);
  if (outcome === 'session_gone') return err('unauthenticated', MFA_SESSION_ENDED);
  if (outcome === 'limited') return err('rate_limited', MFA_CODE_GOTRUE_LIMITED);
  if (step === 'challenge') {
    return unexpectedActionError(error ?? new Error('mfa challenge returned no challenge'), tag, {
      message: MFA_CHALLENGE_NOT_STARTED,
      extra: goTrueCode(error),
    });
  }
  if (outcome === 'refused') return err('validation_error', MFA_CODE_REFUSED);
  if (outcome === 'unchecked') {
    return unexpectedActionError(error ?? new Error('mfa verify failed'), tag, {
      message: MFA_CODE_NOT_CHECKED,
      level: 'warning',
      extra: goTrueCode(error),
    });
  }
  return err('internal_error', MFA_CODE_NOT_CHECKED);
}

/** The set-up could not confirm the session's account before the code was checked. */
const SETUP_SESSION_UNCONFIRMED = 'Could not confirm your sign-in just now. Try again in a moment.';
/**
 * The set-up's code was accepted, then the session's account could not be
 * confirmed: the authenticator may be on, and the page shows it after a reload.
 */
const SETUP_ADDED_UNCONFIRMED =
  'Could not confirm your sign-in just now. Reload this page to see whether the authenticator was added.';

/**
 * The set-up's answer when the session no longer verifies as the account
 * whose password was checked: another account is signed out here; a session
 * that could not be verified is left alone.
 */
async function setUpSessionRefusal(
  supabase: Awaited<ReturnType<typeof createClient>>,
  now: Exclude<SessionAccountNow, { kind: 'same' }>,
  unverifiedMessage: string,
): Promise<ActionResult<never>> {
  if (now.kind === 'other') {
    await signOutThisSession(supabase);
    return err('unauthenticated', SESSION_CHANGED, { reason: 'session_changed' });
  }
  return err('internal_error', unverifiedMessage);
}

/** Reports of refused factor ids per account in one window (a closed counter, reports only). */
const REFUSED_FACTOR_REPORTS = 3;
const REFUSED_FACTOR_REPORT_WINDOW_MS = 60 * 60_000;

/**
 * stepUpMethodsAction's limits (review 2-3 finding 8), both closed: calls of
 * one account at one client address, then of the account at every address,
 * per window. The step-up modal asks once per opening, and only when the
 * browser lists a factor with the bridge's reserved name; a refusal leaves
 * the modal with the browser's own list without the reserved-name factors
 * (it never offers one for a code).
 */
const STEP_UP_METHODS_AT_ADDRESS = 20;
const STEP_UP_METHODS_PER_ACCOUNT = 60;
const STEP_UP_METHODS_WINDOW_MS = 15 * 60_000;
const STEP_UP_METHODS_PAUSED = 'Too many checks of your authenticators. Try again in a few minutes.';

/**
 * Begin TOTP enrollment for the current user. Supabase issues an unverified
 * factor row + QR code; the user must call verifyEnrollmentAction with a code
 * from their authenticator app to activate it.
 */
export async function enrollFactorAction(): Promise<
  ActionResult<{ factorId: string; qrCode: string; secret: string; uri: string }>
> {
  try {
    const session = await requireSession();
    const supabase = await createClient();

    // Clean up any prior unverified factors so listFactors stays tidy. Never
    // the account's recorded passkey bridge (lib/auth/passkey-bridge), which
    // is not the member's set-up, and, while the record cannot be read, no
    // factor that carries the reserved name (factorChangeRefusal: left for a
    // later clean-up; the failed read is reported). A reserved-name factor
    // that is not the recorded one goes like any unfinished set-up.
    const { data: existing } = await supabase.auth.mfa.listFactors();
    const unfinished = (existing?.all ?? []).filter((f) => f.status !== 'verified');
    const bridge = await readPasskeyBridge(session.userId, unfinished, 'enroll_cleanup');
    for (const f of unfinished) {
      if (factorChangeRefusal(bridge, f)) continue;
      await supabase.auth.mfa.unenroll({ factorId: f.id });
    }

    const { data, error } = await supabase.auth.mfa.enroll({
      factorType: 'totp',
      friendlyName: `StockPilot · ${new Date().toISOString().slice(0, 10)}`,
    });
    if (error || !data) {
      return unexpectedActionError(
        error ?? new Error('mfa enroll returned no factor'),
        'actions.mfa.enroll',
        {
          extra: goTrueCode(error),
        },
      );
    }
    if (data.type !== 'totp') {
      return err('internal_error', 'Unexpected factor type from Supabase');
    }
    return ok({
      factorId: data.id,
      qrCode: data.totp.qr_code,
      secret: data.totp.secret,
      uri: data.totp.uri,
    });
  } catch (e) {
    rethrowControlFlow(e);
    // A check of the caller's access that could not be read: its own sentence.
    const unchecked = uncheckedAccessResult(e, 'mfa.action');
    if (unchecked) return unchecked;
    if (e instanceof ServiceError) return err(e.code, e.message);
    // Don't console.error raw exception — Supabase auth errors can
    // include factor IDs and challenge tokens. Funnel through the
    // error reporter (which scrubs) and return a generic error.
    void reportError(e, { tag: 'mfa.action' });
    return err('internal_error', 'MFA action failed');
  }
}

const verifyEnrollmentSchema = z.object({
  factorId: z.string().min(1),
  code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code'),
  password: z.string().min(1, 'Confirm your password').max(128),
});

/**
 * Confirms a freshly enrolled factor. After this succeeds the factor becomes
 * `verified` and counts toward the user's AAL2.
 *
 * Password re-confirm is MANDATORY (SP-066). It is validated out-of-band so a
 * stolen mid-enrollment session cookie alone can't finish enrolling an
 * attacker-controlled factor. It used to be `.optional()` "for client-rollout
 * safety" and the check sat behind `if (parsed.data.password)` — so a direct
 * POST of this Server Action that simply OMITTED the field skipped both the
 * rate limit and the password check and still got the factor verified. That
 * let a thief holding an AAL1 cookie enroll their own authenticator, after
 * which the dashboard's enrolled-user hard gate ((dashboard)/layout.tsx, HI-6)
 * bounces the real owner to /signin/mfa forever — they have no recovery codes
 * and are locked out, while the attacker holds an AAL2-capable session.
 * Required now: every caller must prove the account password. The only caller
 * is components/settings/mfa-enrollment.tsx, which already always sends it
 * (and blocks client-side without it). Same hole, same fix as the sibling
 * consumeMfaRecoveryCodeAction in mfa-recovery.ts.
 */
export async function verifyEnrollmentAction(input: {
  factorId: string;
  code: string;
  password: string;
}): Promise<ActionResult<void>> {
  const parsed = verifyEnrollmentSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }
  try {
    const session = await requireSession();
    const supabase = await createClient();

    // No `if (parsed.data.password)` wrapper: the schema now REQUIRES the
    // password, so this gate is unconditional and a caller can no longer skip
    // the rate limit + password proof by omitting the field (SP-066).
    const rl = await checkRateLimit(
      `mfa-enroll-verify:${session.userId}`,
      5,
      15 * 60_000,
      'closed',
    );
    if (!rl.allowed) {
      return err(
        'validation_error',
        'Too many enrollment confirmations. Try again in a few minutes.',
      );
    }
    const pwRes = await verifyPasswordSideChannel(session.email, parsed.data.password);
    if (!pwRes.ok) {
      return err(
        pwRes.reason === 'invalid_password' ? 'forbidden' : 'internal_error',
        pwRes.message,
      );
    }

    // Only the set-up just started: the factor id must be one the account's
    // factor list shows as unverified. Nothing else is confirmed here, a
    // verified authenticator above all (its code is checked at sign-in and in
    // the step-up, with their own budget and record), and a set-up replaced
    // in another tab (enrollFactorAction removes unverified ones) is no longer
    // open. The set-up screen is not shown once a factor is verified.
    const { data: factors, error: factorsError } = await supabase.auth.mfa.listFactors();
    if (factorsError || !factors) {
      return err('internal_error', MFA_SETUP_UNREADABLE);
    }
    const openSetUp = (factors.all ?? []).some(
      (f) => f.id === parsed.data.factorId && f.status === 'unverified',
    );
    if (!openSetUp) {
      return err('validation_error', MFA_SETUP_NOT_OPEN);
    }
    // Never the account's recorded passkey bridge (lib/auth/passkey-bridge):
    // Auth would confirm it like a set-up while it is unverified (proof B4).
    // Read only when the factor named carries the reserved name; while the
    // record cannot be read, such a factor is not confirmed (try again in a
    // moment; the failed read is reported).
    const named = (factors.all ?? []).filter((f) => f.id === parsed.data.factorId);
    const bridge = await readPasskeyBridge(session.userId, named, 'verify_enrollment');
    const held = named[0] ? factorChangeRefusal(bridge, named[0]) : null;
    if (held === 'passkey_bridge') return err('validation_error', MFA_SETUP_NOT_OPEN);
    if (held === 'bridge_unreadable') return err('internal_error', FACTOR_CHECK_RETRY);
    // Only for the account whose password was just checked: the factor list
    // loads the cookie session, and a load can refresh it into another
    // account's (lib/auth/verified-claims). Read against that account here
    // and again after GoTrue's answer (lib/auth/session-account): another
    // account is signed out here and refused; a session that could not be
    // verified is refused and left alone.
    const beforeCode = await sessionAccountNow(supabase, session.userId);
    if (beforeCode.kind !== 'same') {
      return setUpSessionRefusal(supabase, beforeCode, SETUP_SESSION_UNCONFIRMED);
    }

    const { data: challenge, error: chErr } = await supabase.auth.mfa.challenge({
      factorId: parsed.data.factorId,
    });
    if (chErr || !challenge) {
      return mfaCodeFailure('challenge', chErr, 'actions.mfa.verify_enrollment');
    }
    const { error: vErr } = await supabase.auth.mfa.verify({
      factorId: parsed.data.factorId,
      challengeId: challenge.id,
      code: parsed.data.code,
    });
    if (vErr) {
      return mfaCodeFailure('verify', vErr, 'actions.mfa.verify_enrollment');
    }
    const afterCode = await sessionAccountNow(supabase, session.userId);
    if (afterCode.kind === 'unverified') {
      // GoTrue accepted the code, so the factor is verified on the account the
      // session holds; only the account could not be confirmed. No row; the
      // report shows the missing one.
      void reportError(new Error('An authenticator set-up was accepted but its account could not be confirmed'), {
        tag: 'actions.mfa.verify_enrollment_unconfirmed',
        level: 'warning',
        extra: { userId: session.userId },
      });
    }
    if (afterCode.kind !== 'same') {
      return setUpSessionRefusal(supabase, afterCode, SETUP_ADDED_UNCONFIRMED);
    }
    await audit({
      event: 'mfa.enrolled',
      entityType: 'user',
      entityId: session.userId,
      extra: { factorId: parsed.data.factorId },
    });
    revalidatePath('/dashboard/settings/security');
    return ok(undefined);
  } catch (e) {
    rethrowControlFlow(e);
    // A check of the caller's access that could not be read: its own sentence.
    const unchecked = uncheckedAccessResult(e, 'mfa.action');
    if (unchecked) return unchecked;
    if (e instanceof ServiceError) return err(e.code, e.message);
    // Don't console.error raw exception — Supabase auth errors can
    // include factor IDs and challenge tokens. Funnel through the
    // error reporter (which scrubs) and return a generic error.
    void reportError(e, { tag: 'mfa.action' });
    return err('internal_error', 'MFA action failed');
  }
}

const unenrollSchema = z.object({ factorId: z.string().min(1) });

export async function unenrollFactorAction(input: {
  factorId: string;
}): Promise<ActionResult<void>> {
  const parsed = unenrollSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', 'Invalid factor');
  }
  try {
    const session = await requireSession();
    const supabase = await createClient();

    // AAL2 step-up gate: removing a TOTP factor weakens the account's
    // security posture. The session MUST currently satisfy AAL2 (i.e.
    // the user completed the TOTP challenge this session) before they
    // can disable it. Without this gate, a stolen AAL1-only session
    // (eg. cookie theft from a still-AAL1 device) could strip MFA off
    // an account whose enrolled factor the attacker doesn't own.
    const svcCtx = await withContext();
    await assertCurrentAal2(svcCtx);

    // Block disabling if the user's org policy requires MFA.
    const ctx = await requireOrgContext();
    const { data: orgRow, error: orgError } = await supabase
      .from('organizations')
      .select('mfa_policy')
      .eq('id', ctx.organizationId)
      .maybeSingle();
    // An unreadable policy must not permit removing the factor. The read
    // ERROR was ignored until 2026-09-22 (postgrest-js returns it, it does not
    // throw), so a timeout landed on 'optional' and allowed the unenroll under
    // a policy that forbids it. Zero rows is held to the strictest policy.
    if (orgError) {
      return err('internal_error', "Could not check your organization's MFA policy. Try again.");
    }
    const policy = enforcedMfaPolicy(orgRow);
    const role = ctx.role;
    const required =
      policy === 'all_required' ||
      (policy === 'admins_required' && (role === 'owner' || role === 'admin'));
    if (required) {
      return err(
        'forbidden',
        'Your organization requires MFA. Ask an admin to lower the policy before disabling.',
      );
    }

    // Never the account's recorded passkey bridge (lib/auth/passkey-bridge):
    // Auth would remove it like any factor (proof B6) and the passkey would
    // stop working. Names first (review 2-3 finding 5): the factor list is
    // the one withContext() already read, so an account whose factor here
    // has no reserved name makes no extra Auth read, no record read and no
    // report. While the record cannot be read, a factor that carries the
    // reserved name is not removed (try again in a moment; the failed read is
    // reported). A list the context could not read, or another account's,
    // names nothing: the removal goes on as before (Auth decides).
    const listed = await contextFactorsOf(svcCtx, session.userId);
    const named = (listed ?? []).filter((f) => f.id === parsed.data.factorId);
    const bridge = await readPasskeyBridge(session.userId, named, 'unenroll');
    const held = named[0] ? factorChangeRefusal(bridge, named[0]) : null;
    if (held === 'passkey_bridge') return err('validation_error', 'Invalid factor');
    if (held === 'bridge_unreadable') return err('internal_error', FACTOR_CHECK_RETRY);

    const { error } = await supabase.auth.mfa.unenroll({ factorId: parsed.data.factorId });
    if (error) {
      return unexpectedActionError(error, 'actions.mfa.unenroll', {
        organizationId: ctx.organizationId,
        extra: goTrueCode(error),
      });
    }
    await audit({
      event: 'mfa.unenrolled',
      entityType: 'user',
      entityId: session.userId,
      extra: { factorId: parsed.data.factorId },
    });
    // Security feed: weakening an account's auth posture is exactly what a
    // #security channel exists for. Best-effort, off the response path.
    void dispatchEvent(ctx.organizationId, 'security.mfa_unenrolled', {
      email: session.email,
    });
    revalidatePath('/dashboard/settings/security');
    return ok(undefined);
  } catch (e) {
    rethrowControlFlow(e);
    // A check of the caller's access that could not be read: its own sentence.
    const unchecked = uncheckedAccessResult(e, 'mfa.action');
    if (unchecked) return unchecked;
    if (e instanceof ServiceError) return err(e.code, e.message);
    // Don't console.error raw exception — Supabase auth errors can
    // include factor IDs and challenge tokens. Funnel through the
    // error reporter (which scrubs) and return a generic error.
    void reportError(e, { tag: 'mfa.action' });
    return err('internal_error', 'MFA action failed');
  }
}

/**
 * Sign-in challenge: user already has password session at AAL1, supplies the
 * 6-digit code to upgrade to AAL2. Also the step-up modal's check
 * (components/auth/step-up-modal.tsx), at AAL1 or AAL2.
 *
 * Only a VERIFIED authenticator of the session's own account is checked here:
 * the factor id comes from the page, and the account's factor list must show
 * it as verified before any code attempt is spent. An unfinished set-up is
 * completed only by verifyEnrollmentAction, which asks for the account
 * password.
 *
 * Each press spends one attempt of the account's code budget (once at this
 * client address, then, only when that allowed it, once for the account at any
 * address), shared with the reset's code step, and a code GoTrue judged wrong
 * writes an mfa.code_refused row (lib/auth/mfa-code-attempts.ts).
 *
 * The answer counts only for the account the budget was spent on: once GoTrue
 * has judged the code, the session is read again against that account; a
 * session that now holds another account is signed out here and refused, and
 * one that could not be verified is refused and left alone (checkMfaCode).
 *
 * Auth round trips per press: the factor list (one), the challenge and the
 * verify. The verified claims, before and after, are a local signature check
 * once the key set is cached.
 */
const signInChallengeSchema = z.object({
  factorId: z.string().min(1),
  code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code'),
});

export async function challengeFactorAction(input: {
  factorId: string;
  code: string;
}): Promise<ActionResult<void>> {
  const parsed = signInChallengeSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid code');
  }
  try {
    const supabase = await createClient();
    // The account and level of THIS session, from its verified token: both
    // buckets of the budget are keyed on that account (one with the client
    // address), never on the input. No verified session, no code check
    // (lib/auth/mfa-code-attempts).
    const claims = await readVerifiedSessionClaims(supabase);
    if (!claims) return err('unauthenticated', MFA_SESSION_ENDED);

    // The account's own factor list: GoTrue's user answer, which says whose
    // list it is (lib/auth/mfa-factors). Read before the budget, so a factor
    // id that is not a verified authenticator of this account spends nothing.
    let list: MfaFactorList;
    try {
      list = await readMfaFactorList(supabase);
    } catch (e) {
      if (isSessionEndedError(e)) return err('unauthenticated', MFA_SESSION_ENDED);
      return unexpectedActionError(e, 'actions.mfa.challenge', {
        message: MFA_CHALLENGE_NOT_STARTED,
      });
    }
    const factors = factorsOf(list, claims.userId);
    if (!factors) {
      // The session now holds another account than the one it verified as:
      // it does not stay signed in here.
      await signOutThisSession(supabase);
      return err('unauthenticated', MFA_SESSION_ENDED);
    }
    const factor = factors.find((f) => f.id === parsed.data.factorId);
    // The account's recorded passkey bridge is no authenticator of the
    // member's (lib/auth/passkey-bridge): Auth would check a code for it like
    // any app. Nor is any factor carrying the reserved name: its code is one
    // no member has. With the records read and no record naming it (the lab
    // walk of stage 4, state S12) it is a second step that cannot be used
    // here; while the records cannot be read (a failed read, or the table
    // missing) it is refused all the same, with the "could not check, try
    // again" words (fail closed). The record is read only when the factor
    // named carries the reserved name, so an app's check is as it always was.
    let refused:
      | 'not_listed'
      | 'not_verified'
      | 'passkey_bridge'
      | 'reserved_name_unrecorded'
      | 'records_unread'
      | null = null;
    if (!factor) refused = 'not_listed';
    else if (factor.status !== 'verified') refused = 'not_verified';
    let hasApp = false;
    if (factor && !refused) {
      const bridge = await readPasskeyBridge(claims.userId, [factor], 'challenge');
      refused = refusedForCode(bridge, factor);
      // The account's own authenticator apps beside it, by the same rule.
      hasApp =
        appFactorsForCode(
          factors.filter(
            (f) =>
              f.status === 'verified' &&
              (f.factor_type ?? 'totp') === 'totp' &&
              f.id !== parsed.data.factorId,
          ),
          bridge,
        ).length > 0;
    }
    if (refused === 'records_unread') {
      // Fail closed, before any attempt of the code budget and before Auth
      // is asked: whether this factor is the account's bridge could not be
      // read, and no member has a code for a factor of that name either
      // way. The code page's own words for a code that could not be checked;
      // the failed read was reported where it was made (readPasskeyBridge).
      return err('internal_error', MFA_CODE_NOT_CHECKED);
    }
    if (refused === 'reserved_name_unrecorded') {
      // Fail closed, before any attempt of the code budget: the words of a
      // second step that cannot be used here (with an authenticator app of
      // the account's own, its code), and one report at error level, paced
      // by the same closed counter as the refusals below.
      const report = await checkRateLimit(
        `mfa-factor-refused-report:${claims.userId}`,
        REFUSED_FACTOR_REPORTS,
        REFUSED_FACTOR_REPORT_WINDOW_MS,
        'closed',
      );
      if (report.allowed) {
        void reportError(
          new Error(
            'A code press named a verified factor that carries the passkey bridge name and that no record names',
          ),
          {
            tag: 'actions.mfa.challenge',
            level: 'error',
            userIdHash: accountIdHash(claims.userId),
            extra: { factor: refused },
          },
        );
      }
      return err(
        'forbidden',
        hasApp ? MFA_SECOND_STEP_CANT_USE_WITH_APP : MFA_SECOND_STEP_CANT_USE,
      );
    }
    if (refused) {
      // The same words as a challenge that could not start, and no code
      // attempt spent. Reported with what the id named (never the id or the
      // code), at most REFUSED_FACTOR_REPORTS times per account in a window:
      // a closed counter that decides only whether to report.
      const report = await checkRateLimit(
        `mfa-factor-refused-report:${claims.userId}`,
        REFUSED_FACTOR_REPORTS,
        REFUSED_FACTOR_REPORT_WINDOW_MS,
        'closed',
      );
      if (!report.allowed) return err('internal_error', MFA_CHALLENGE_NOT_STARTED);
      return unexpectedActionError(
        new Error('A code press named a factor that is not a verified authenticator of the account'),
        'actions.mfa.challenge',
        {
          message: MFA_CHALLENGE_NOT_STARTED,
          level: 'warning',
          extra: { factor: refused },
        },
      );
    }

    const check = await checkMfaCode(supabase, {
      userId: claims.userId,
      factorId: parsed.data.factorId,
      code: parsed.data.code,
      path: 'challenge',
      sessionAal: claims.aal,
    });
    if (check.kind === 'verified') return ok(undefined);
    if (check.kind === 'budget_spent') return err('rate_limited', MFA_CODE_BUDGET_SPENT);
    // GoTrue judged the code while the session held another account than the
    // one the budget was spent on: this session was signed out here.
    if (check.kind === 'account_changed') return err('unauthenticated', MFA_SESSION_ENDED);
    // GoTrue judged the code, then the session could not be verified: the
    // attempt spent before the challenge stays spent, the answer is not used,
    // no row is written, and the session stays; the person can press again.
    if (check.kind === 'unconfirmed') return err('internal_error', MFA_CODE_NOT_CHECKED);
    // Plain words, never GoTrue's: its message can carry factor and challenge
    // identifiers.
    if (check.outcome === 'session_gone') return err('unauthenticated', MFA_SESSION_ENDED);
    if (check.outcome === 'limited') return err('rate_limited', MFA_CODE_GOTRUE_LIMITED);
    if (check.kind === 'challenge_failed') return err('internal_error', MFA_CHALLENGE_NOT_STARTED);
    if (check.outcome === 'refused') return err('validation_error', MFA_CODE_REFUSED);
    return err('internal_error', MFA_CODE_NOT_CHECKED);
  } catch (e) {
    rethrowControlFlow(e);
    // A check of the caller's access that could not be read: its own sentence.
    const unchecked = uncheckedAccessResult(e, 'mfa.action');
    if (unchecked) return unchecked;
    if (e instanceof ServiceError) return err(e.code, e.message);
    // Don't console.error raw exception — Supabase auth errors can
    // include factor IDs and challenge tokens. Funnel through the
    // error reporter (which scrubs) and return a generic error.
    void reportError(e, { tag: 'mfa.action' });
    return err('internal_error', 'MFA action failed');
  }
}

/**
 * The authenticator apps the step-up modal (components/auth/step-up-modal.tsx)
 * offers, when the browser's factor list shows a factor with the reserved
 * passkey bridge name (lib/auth/passkey-bridge-name): the browser cannot tell
 * the bridge from an app, so it asks here, once. The answer is the account's
 * verified TOTP factors without its RECORDED bridge and without any other
 * factor that carries the reserved name (lib/auth/passkey-bridge,
 * appFactorsForCode), in Auth's order. While the record cannot be read (a
 * failed read, or the table missing) the answer also says so
 * (`recordsUnread: true`), so a modal left with no app says "try again"
 * instead of "this cannot be done here".
 *
 * Reads only: the account from this session's verified token, that account's
 * own factor list (GoTrue's user answer, which says whose list it is) and its
 * own record. It runs at aal1 or aal2, like the code check it serves. Each
 * call first counts in two closed limits (the account at this address, then
 * the account: STEP_UP_METHODS_*); a refusal reads nothing, and the modal
 * keeps the browser's list without the reserved-name factors. The one change
 * it can make: a session whose
 * factor list is another account's is signed out here.
 */
export async function stepUpMethodsAction(): Promise<
  ActionResult<{
    apps: Array<{ id: string; friendlyName: string | null }>;
    /** Present only when the bridge record could not be read. */
    recordsUnread?: true;
  }>
> {
  try {
    const supabase = await createClient();
    const claims = await readVerifiedSessionClaims(supabase);
    if (!claims) return err('unauthenticated', MFA_SESSION_ENDED);
    // Limited before any read (review 2-3 finding 8): the account at this
    // address, then the account. Closed: a limiter that cannot answer refuses.
    const ip = clientIpFromHeaders(await headers());
    const atAddress = await checkRateLimit(
      `mfa-step-up-methods:${claims.userId}:${ip}`,
      STEP_UP_METHODS_AT_ADDRESS,
      STEP_UP_METHODS_WINDOW_MS,
      'closed',
    );
    if (!atAddress.allowed) return err('rate_limited', STEP_UP_METHODS_PAUSED);
    const forAccount = await checkRateLimit(
      `mfa-step-up-methods-account:${claims.userId}`,
      STEP_UP_METHODS_PER_ACCOUNT,
      STEP_UP_METHODS_WINDOW_MS,
      'closed',
    );
    if (!forAccount.allowed) return err('rate_limited', STEP_UP_METHODS_PAUSED);
    // A list that cannot be read throws to the catch below; the modal then
    // keeps the browser's own list, without the reserved-name factors.
    const factors = factorsOf(await readMfaFactorList(supabase), claims.userId);
    if (!factors) {
      // The session now holds another account than the one it verified as:
      // it does not stay signed in here.
      await signOutThisSession(supabase);
      return err('unauthenticated', MFA_SESSION_ENDED);
    }
    const verified = factors.filter(
      (f): f is typeof f & { id: string } =>
        f.status === 'verified' && f.factor_type === 'totp' && typeof f.id === 'string',
    );
    const bridge = await readPasskeyBridge(claims.userId, verified, 'step_up_methods');
    return ok({
      // Never the recorded bridge, nor any other factor that carries the
      // reserved name, whatever the record read answered (appFactorsForCode).
      apps: appFactorsForCode(verified, bridge).map((f) => ({
        id: f.id,
        friendlyName: f.friendly_name ?? null,
      })),
      ...(passkeyRecordsUnread(bridge) ? { recordsUnread: true as const } : {}),
    });
  } catch (e) {
    rethrowControlFlow(e);
    // A check of the caller's access that could not be read: its own sentence.
    const unchecked = uncheckedAccessResult(e, 'mfa.action');
    if (unchecked) return unchecked;
    if (isSessionEndedError(e)) return err('unauthenticated', MFA_SESSION_ENDED);
    if (e instanceof ServiceError) return err(e.code, e.message);
    // Don't console.error raw exception — Supabase auth errors can
    // include factor IDs and challenge tokens. Funnel through the
    // error reporter (which scrubs) and return a generic error.
    void reportError(e, { tag: 'mfa.action' });
    return err('internal_error', 'MFA action failed');
  }
}

const policySchema = z.object({
  policy: z.enum(['optional', 'admins_required', 'all_required']),
});

export async function setOrgMfaPolicyAction(input: {
  policy: 'optional' | 'admins_required' | 'all_required';
}): Promise<ActionResult<void>> {
  const parsed = policySchema.safeParse(input);
  if (!parsed.success) return err('validation_error', 'Invalid policy');
  try {
    const ctx = await requireOrgContext();
    if (ctx.role !== 'owner' && ctx.role !== 'admin') {
      return err('forbidden', 'Only admins can change the MFA policy.');
    }
    // AAL2 step-up: an admin changing the org-wide MFA policy is a
    // security-critical mutation (a malicious admin lowering policy
    // from `all_required` to `optional` opens the door to phishing
    // weaker accounts). Require the calling admin to have completed
    // their MFA challenge this session.
    const svcCtx = await withContext();
    await assertCurrentAal2(svcCtx);
    const supabase = await createClient();
    const { data: prev } = await supabase
      .from('organizations')
      .select('mfa_policy')
      .eq('id', ctx.organizationId)
      .maybeSingle();
    // A save of the policy the organization already has changes nothing: no
    // update, no audit row, no security event, no refresh. Only a policy that
    // was read counts as the same one; when the read gave no row the update
    // below runs.
    if (prev && prev.mfa_policy === parsed.data.policy) {
      return ok(undefined);
    }
    const { data: updated, error } = await supabase
      .from('organizations')
      .update({ mfa_policy: parsed.data.policy })
      .eq('id', ctx.organizationId)
      .select('id')
      .maybeSingle();
    if (error) {
      return unexpectedActionError(error, 'actions.mfa.policy', {
        organizationId: ctx.organizationId,
      });
    }
    // Fail CLOSED: a 0-row update means RLS blocked the write (stale/removed
    // admin) — never audit + report a policy change (incl. a downgrade) that
    // didn't actually land.
    if (!updated) {
      return err('internal_error', 'MFA policy did not persist (0 rows updated).');
    }
    await audit({
      event: 'organization.mfa_policy.changed',
      entityType: 'organization',
      entityId: ctx.organizationId,
      before: { mfa_policy: prev?.mfa_policy ?? null },
      after: { mfa_policy: parsed.data.policy },
    });
    // Security feed: org-wide auth-policy changes are forensic-relevant.
    void dispatchEvent(ctx.organizationId, 'security.mfa_policy_changed', {
      from: (prev?.mfa_policy as string | null) ?? 'optional',
      to: parsed.data.policy,
    });
    // Invalidate the cached org row (lib/dashboard/cached-org.ts) so
    // the new policy takes effect immediately for the MFA banner +
    // hard-gate on the next dashboard nav. Static cross-org tag.
    updateTag('dashboard-org');
    revalidatePath('/dashboard', 'layout');
    return ok(undefined);
  } catch (e) {
    rethrowControlFlow(e);
    // A check of the caller's access that could not be read: its own sentence.
    const unchecked = uncheckedAccessResult(e, 'mfa.action');
    if (unchecked) return unchecked;
    if (e instanceof ServiceError) return err(e.code, e.message);
    // Don't console.error raw exception — Supabase auth errors can
    // include factor IDs and challenge tokens. Funnel through the
    // error reporter (which scrubs) and return a generic error.
    void reportError(e, { tag: 'mfa.action' });
    return err('internal_error', 'MFA action failed');
  }
}

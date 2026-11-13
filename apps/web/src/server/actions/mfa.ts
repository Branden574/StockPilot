'use server';

import { revalidatePath, updateTag } from 'next/cache';
import { z } from 'zod';

import { rethrowControlFlow } from '@/lib/control-flow';
import { classifyMfaCodeError } from '@/server/actions/auth-error-classify';
import { unexpectedActionError } from '@/server/lib/action-error-result';
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
  MFA_SESSION_ENDED,
  MFA_SETUP_NOT_OPEN,
  MFA_SETUP_UNREADABLE,
  signOutThisSession,
} from '@/lib/auth/mfa-code-attempts';
import { factorsOf, readMfaFactorList, type MfaFactorList } from '@/lib/auth/mfa-factors';
import { enforcedMfaPolicy } from '@/lib/auth/mfa-policy';
import { requireOrgContext, requireSession } from '@/lib/auth/session';
import { isSessionEndedError } from '@/lib/auth/session-ended';
import { sessionAccountNow, type SessionAccountNow } from '@/lib/auth/session-account';
import { readVerifiedSessionClaims } from '@/lib/auth/verified-claims';
import { verifyPasswordSideChannel } from '@/lib/auth/verify-password';
import { reportError } from '@/lib/error-reporter';
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
 * Begin TOTP enrollment for the current user. Supabase issues an unverified
 * factor row + QR code; the user must call verifyEnrollmentAction with a code
 * from their authenticator app to activate it.
 */
export async function enrollFactorAction(): Promise<
  ActionResult<{ factorId: string; qrCode: string; secret: string; uri: string }>
> {
  try {
    await requireSession();
    const supabase = await createClient();

    // Clean up any prior unverified factors so listFactors stays tidy.
    const { data: existing } = await supabase.auth.mfa.listFactors();
    for (const f of existing?.all ?? []) {
      if (f.status !== 'verified') {
        await supabase.auth.mfa.unenroll({ factorId: f.id });
      }
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
    if (factor?.status !== 'verified') {
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
          extra: { factor: factor ? 'not_verified' : 'not_listed' },
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
    if (e instanceof ServiceError) return err(e.code, e.message);
    // Don't console.error raw exception — Supabase auth errors can
    // include factor IDs and challenge tokens. Funnel through the
    // error reporter (which scrubs) and return a generic error.
    void reportError(e, { tag: 'mfa.action' });
    return err('internal_error', 'MFA action failed');
  }
}

'use server';

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';

import { requireSession } from '@/lib/auth/session';
import { readVerifiedSessionTokenOf } from '@/lib/auth/verified-claims';
import { verifyPasswordSideChannel } from '@/lib/auth/verify-password';
import { clientIpFromHeaders } from '@/lib/client-ip';
import { rethrowControlFlow } from '@/lib/control-flow';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { createAccessTokenClient } from '@/lib/supabase/access-token-client';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import { recordAccountCodeBlocked } from '@/server/security/account-events';
import { emitAuthAudit, resolveDefaultOrgAndRole } from '@/server/services/auth-audit';
import { ServiceError } from '@/server/services/context';
import { SESSION_CHANGED } from '@/server/services/step-up-held';
import {
  actionErrorResult,
  NOT_SET_UP_MESSAGE,
  unexpectedActionError,
} from '@/server/lib/action-error-result';

import { err, ok, type ActionResult } from '@stockpilot/core';

/**
 * Generates 10 fresh recovery codes for the current user, wiping any
 * existing ones. Returns the plaintexts — the UI must show them now,
 * because they are unrecoverable after this call.
 */
export async function generateMfaRecoveryCodesAction(): Promise<
  ActionResult<{ codes: string[] }>
> {
  try {
    const session = await requireSession();
    // Block AAL1: this RPC mints fresh PLAINTEXT codes AND wipes the old set, so
    // an attacker with a stolen pre-MFA (AAL1) session could otherwise mint their
    // own recovery codes and use one to strip all MFA. Require a current AAL2
    // session. This is a per-USER check — do NOT use withContext() here: recovery
    // codes are not org-scoped, and withContext() → requireOrgContext() throws
    // NEXT_REDIRECT for an org-less caller, which this catch would swallow into a
    // generic internal_error.
    //
    // The level is the access token's `aal` claim once its signature checks
    // out (lib/auth/verified-claims), not getAuthenticatorAssuranceLevel()'s
    // unchecked decode of the cookie: a token that does not verify is refused.
    // It is the level of the account requireSession() validated, and only of
    // that account (readVerifiedSessionTokenOf, docket S50a); the codes are
    // then minted with that same verified token, so the level that allows the
    // call and the account the codes belong to are one account.
    const supabase = await createClient();
    const held = await readVerifiedSessionTokenOf(supabase, session.userId);
    if (held?.claims.aal !== 'aal2') {
      return err('forbidden', 'Re-authenticate with MFA before regenerating recovery codes.');
    }
    // Rate-limit regeneration: defends against a loop that repeatedly invalidates
    // the user's codes (TOTP-loss lockout). 3 / 15 min is generous for a human.
    const rl = await checkRateLimit(`mfa-recovery-gen:${session.userId}`, 3, 15 * 60_000, 'closed');
    if (!rl.allowed) {
      return err('validation_error', 'Too many recovery-code regenerations. Wait a few minutes and try again.');
    }
    // The RPC mints for auth.uid(). It runs on a client that acts as the
    // verified token alone and never loads or renews the cookie session, so
    // auth.uid() is the account checked above.
    const { data, error } = await createAccessTokenClient(held.token).rpc(
      'generate_mfa_recovery_codes',
    );
    if (error) throw new ServiceError('internal_error', error.message);
    const codes = ((data ?? []) as Array<{ code: string }>).map((r) => r.code);
    // How many codes, never which.
    const { organizationId } = await resolveDefaultOrgAndRole(session.userId);
    await emitAuthAudit({
      event: 'mfa.recovery.generated',
      userId: session.userId,
      organizationId,
      extra: { count: codes.length },
    });
    revalidatePath('/dashboard/settings/security');
    return ok({ codes });
  } catch (e) {
    return actionErrorResult(e, 'actions.mfa_recovery.generate_mfa_recovery_codes');
  }
}

/**
 * Returns how many unused recovery codes the user has remaining. Used
 * by the Security page to indicate "you've used N of 10".
 */
export async function getMfaRecoveryCodeStatus(): Promise<{
  total: number;
  unused: number;
}> {
  try {
    const session = await requireSession();
    const supabase = await createClient();
    const [allRes, unusedRes] = await Promise.all([
      supabase
        .from('mfa_recovery_codes')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', session.userId),
      supabase
        .from('mfa_recovery_codes')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', session.userId)
        .is('used_at', null),
    ]);
    return { total: allRes.count ?? 0, unused: unusedRes.count ?? 0 };
  } catch (e) {
    rethrowControlFlow(e);
    return { total: 0, unused: 0 };
  }
}

/** The words for every limit of the recovery code below. */
const RECOVERY_PAUSED = 'Too many recovery-code attempts. Wait a few minutes and try again.';
const RECOVERY_WINDOW_MS = 15 * 60_000;
/** Presses of one account at one client address in a window. */
const RECOVERY_PRESSES_AT_ADDRESS = 5;
/**
 * Presses of one account that carry a password, at every address, in a
 * window: set above what one address's own bucket lets through, so a person
 * at one address is not paused by this bucket alone.
 */
const RECOVERY_PASSWORD_CHECKS = 10;
/** Presses of one account whose password checked out, at every address, in a window. */
const RECOVERY_CODE_CHECKS = 5;

/**
 * One count in a bucket of the recovery code; closed: a limiter that cannot
 * answer refuses. A press refused because the bucket is over its count is a
 * security event in the account's organization (looked up after the
 * response), like a spent authenticator-code budget; a limiter that could not
 * count (`failed`) is not one.
 */
async function allowRecoveryPress(
  key: string,
  limit: number,
  userId: string,
  requestHeaders: Awaited<ReturnType<typeof headers>>,
): Promise<boolean> {
  const answer = await checkRateLimit(key, limit, RECOVERY_WINDOW_MS, 'closed');
  if (!answer.allowed && !answer.failed) {
    recordAccountCodeBlocked('recovery_code_checks_paused', userId, requestHeaders);
  }
  return answer.allowed;
}

/** The recovery code's function in 0475; its absence means today's path. */
const RECOVERY_WITH_PASSKEYS_FN = 'consume_recovery_code_with_passkeys';

type RecoveryAnswer =
  /** 0475 answered: whether the code was spent, and how many passkeys went. */
  | { kind: 'answered'; consumed: boolean; passkeysRemoved: number }
  /** The function does not exist yet (0475 not pushed): today's path, unchanged. */
  | { kind: 'not_yet' }
  /** Any other failure, or an answer in a shape this does not know. */
  | { kind: 'failed'; code: string };

/**
 * What consume_recovery_code_with_passkeys answered. The function does not
 * exist yet when PostgREST's schema cache answers PGRST202, or Postgres
 * 42883, naming it (the house rule: exception-occurrences.ts). Its answer is
 * one row; anything else is a failure, never a code read as spent or not.
 */
function recoveryAnswer(res: {
  data: unknown;
  error: { code?: unknown; message?: unknown } | null;
}): RecoveryAnswer {
  if (res.error) {
    const code = typeof res.error.code === 'string' ? res.error.code : 'none';
    const message = typeof res.error.message === 'string' ? res.error.message : '';
    if ((code === 'PGRST202' || code === '42883') && message.includes(RECOVERY_WITH_PASSKEYS_FN)) {
      return { kind: 'not_yet' };
    }
    return { kind: 'failed', code };
  }
  const row = Array.isArray(res.data) && res.data.length === 1 ? res.data[0] : null;
  if (
    row &&
    typeof row === 'object' &&
    typeof (row as { consumed?: unknown }).consumed === 'boolean' &&
    Number.isInteger((row as { passkeys_removed?: unknown }).passkeys_removed)
  ) {
    const r = row as { consumed: boolean; passkeys_removed: number };
    return { kind: 'answered', consumed: r.consumed, passkeysRemoved: r.passkeys_removed };
  }
  return { kind: 'failed', code: 'shape' };
}

/** How many passkeys passkey_remove_all removed, or null when it did not answer with its row. */
function removedCount(res: { data: unknown; error: unknown }): number | null {
  if (res.error) return null;
  const row = Array.isArray(res.data) && res.data.length === 1 ? res.data[0] : null;
  const removed =
    row && typeof row === 'object' ? (row as { removed?: unknown }).removed : undefined;
  return Number.isInteger(removed) ? (removed as number) : null;
}

/**
 * The one report of a recovery code whose passkey call failed: the failure's
 * code and whether passkey records may be left (false: the second removal
 * answered; 'unknown': it did not, or the code was not spent here). Never the
 * code, the account's passkeys or the bridge's id.
 */
function reportPasskeyRemoval(failure: string, recordsLeft: false | 'unknown'): void {
  void reportError(new Error('A recovery code could not remove the passkey records in one call'), {
    tag: 'actions.mfa_recovery.passkey_removal',
    level: 'error',
    extra: { failure, records_left: recordsLeft },
  });
}

/**
 * Used by /signin/mfa when the user can't reach their TOTP device.
 * Verifies one of their unused recovery codes, and on success removes their
 * passkeys (0475) and unenrolls every TOTP factor on the account using the
 * admin client (RLS on auth.mfa requires service-role for this). The user can
 * then sign in normally and re-enroll a fresh device.
 */
export async function consumeMfaRecoveryCodeAction(input: {
  code: string;
  password?: string;
}): Promise<ActionResult<{ unenrolled: number }>> {
  try {
    const session = await requireSession();

    // Rate-limit the recovery-code consume path, in three buckets, each
    // counted once per press and each closed:
    //   1. every press, first: the account at this client address
    //      (lib/client-ip, which trusts x-forwarded-for only on Vercel), 5 per
    //      15 minutes. A session of the account at one address cannot spend
    //      the bucket of the person at another;
    //   2. every press that carries a password, before the password check:
    //      the account at every address, 10 per 15 minutes, so password
    //      guesses here stay bounded for the account whatever the address
    //      (RECOVERY_PASSWORD_CHECKS). A pause of this bucket is reported;
    //   3. every press whose password checked out, before the code is
    //      checked: the account at every address, 5 per 15 minutes, so code
    //      guesses stay bounded for the account whatever the address.
    // The limiter checks and counts in one step (increment_rate_limit, 0048),
    // so each bucket counts the presses that reach its check, never a press
    // that stopped earlier: a press with no password spends only the first,
    // a wrong password never reaches the third.
    //
    // 'closed' is load-bearing: checkRateLimit defaults to mode 'open', which
    // answers `allowed: true` whenever the increment_rate_limit RPC errors —
    // and it reaches that RPC through createAdminClient, so the whole ceiling
    // evaporated during the 2026-07-21 service-key outage with nothing louder
    // than a console.warn. This limiter is also the ONLY throttle on the
    // password check below (verify-password.ts leaves rate-limiting to its
    // callers), so failing open here silently costs a whole defence layer on
    // the flow that strips every MFA factor off an account. Every sibling auth
    // front door (generate above, mfa.ts enroll-verify, auth.ts sign-in and
    // change-password, email-change request/resend) already passes 'closed';
    // this one had been missing it. The trade — a limiter outage blocks
    // recovery-code use for its duration — is the one they all already make.
    const requestHeaders = await headers();
    const ip = clientIpFromHeaders(requestHeaders);
    if (
      !(await allowRecoveryPress(
        `mfa-recovery:${session.userId}:${ip}`,
        RECOVERY_PRESSES_AT_ADDRESS,
        session.userId,
        requestHeaders,
      ))
    ) {
      return err('validation_error', RECOVERY_PAUSED);
    }

    // Password re-confirm is MANDATORY. This flow is inherently AAL1 (the user
    // lost their TOTP device, so AAL2 step-up is impossible), so the account
    // password — knowledge a cookie thief lacks — is the ONLY gate stopping a
    // stolen AAL1 session from stripping all MFA. It used to be optional
    // (`if (input.password)`), which let a direct call skip the check entirely.
    if (!input.password) {
      return err('forbidden', 'Your account password is required to use a recovery code.');
    }
    if (
      !(await allowRecoveryPress(
        `mfa-recovery-password:${session.userId}`,
        RECOVERY_PASSWORD_CHECKS,
        session.userId,
        requestHeaders,
      ))
    ) {
      // Presses from more than one address paused the account's password
      // checks. Reported with the account only: never the code, the password
      // or an address.
      void reportError(new Error('Recovery code password checks of one account paused'), {
        tag: 'actions.mfa_recovery.password_checks_paused',
        level: 'warning',
        extra: { userId: session.userId },
      });
      return err('validation_error', RECOVERY_PAUSED);
    }
    const pwRes = await verifyPasswordSideChannel(session.email, input.password);
    if (!pwRes.ok) {
      return err(
        pwRes.reason === 'invalid_password' ? 'forbidden' : 'internal_error',
        pwRes.message,
      );
    }

    // Today's consume runs as the account requireSession() validated, and
    // only as that account (docket S50a): with that account's verified access
    // token, on a client that acts as that token alone and never loads or
    // renews the cookie session. A cookie session that no longer verifies as
    // that account is refused before any code is checked; the factors removed
    // below are that account's.
    const supabase = await createClient();
    const held = await readVerifiedSessionTokenOf(supabase, session.userId);
    if (!held) return err('unauthenticated', SESSION_CHANGED, { reason: 'session_changed' });

    if (
      !(await allowRecoveryPress(
        `mfa-recovery-code:${session.userId}`,
        RECOVERY_CODE_CHECKS,
        session.userId,
        requestHeaders,
      ))
    ) {
      return err('validation_error', RECOVERY_PAUSED);
    }

    // The service client spends the code with the passkey records and removes
    // the factors, so it is made before any code is checked.
    let admin;
    try {
      admin = createAdminClient();
    } catch (e) {
      // Only a server without the service-role key throws here. On such a
      // server the closed limiter above (it needs the same client) refuses
      // before any code is checked, so no code is spent. Never the setting's
      // name to the person (S31).
      return unexpectedActionError(e, 'actions.mfa_recovery.consume', {
        message: NOT_SET_UP_MESSAGE,
        level: 'warning',
      });
    }

    // A recovery code removes every sign-in method of the account, passkeys
    // included (plan 2.6 G, review U3): ONE call, with the service role,
    // keyed on the validated account, spends the code and, only when it was
    // the account's and unspent, marks every passkey removed and deletes the
    // bridge record, in one transaction (0475). Before 0475 is live the
    // function does not exist and today's consume runs, unchanged. Any other
    // failure: today's consume spends the code, the factors are still removed
    // (the person must get in), the passkey removal is tried once more, and
    // one report at error level says whether records may be left.
    const withPasskeys = await admin.rpc('consume_recovery_code_with_passkeys', {
      p_user_id: session.userId,
      p_code: input.code,
    });
    const spent = recoveryAnswer(withPasskeys);
    let consumed: boolean;
    let passkeysRemoved: number | null = null;
    if (spent.kind === 'answered') {
      consumed = spent.consumed;
      passkeysRemoved = spent.passkeysRemoved;
    } else {
      const { data: ok_, error } = await createAccessTokenClient(held.token).rpc(
        'consume_mfa_recovery_code',
        { p_code: input.code },
      );
      if (error) throw new ServiceError('internal_error', error.message);
      consumed = Boolean(ok_);
      if (spent.kind === 'failed' && !consumed) {
        reportPasskeyRemoval(spent.code, 'unknown');
      }
    }
    if (!consumed) {
      // No organization, like a refused authenticator code (mfa.code_refused):
      // not shown to the organization's admins, never the person's own last
      // action. Never the code.
      await emitAuthAudit({
        event: 'mfa.recovery.failed',
        userId: session.userId,
        organizationId: null,
      });
      // A security event in the account's organization (looked up after the
      // response): what the organization's admins see is that a recovery
      // code was refused, from where, never the code.
      recordAccountCodeBlocked('wrong_recovery_code', session.userId, requestHeaders);
      return err('validation_error', 'That recovery code is invalid or already used.');
    }

    // Unenroll every TOTP factor for this user via the admin client: the
    // passkey bridge among them.
    const { data: factors } = await admin.auth.admin.mfa.listFactors({
      userId: session.userId,
    });
    let unenrolled = 0;
    for (const f of factors?.factors ?? []) {
      // We only deliberately enroll TOTP today; play it safe and only
      // remove totp factors so we don't surprise SSO/SAML setups later.
      if (f.factor_type !== 'totp') continue;
      const r = await admin.auth.admin.mfa.deleteFactor({
        userId: session.userId,
        id: f.id,
      });
      if (!r.error) unenrolled += 1;
    }

    if (spent.kind === 'failed') {
      // The code is spent and the factors are gone; the passkey records may
      // not be. One more try, then one report either way.
      const retry = await admin.rpc('passkey_remove_all', {
        p_user_id: session.userId,
        p_reason: 'recovery_code',
      });
      const removed = removedCount(retry);
      if (removed !== null) passkeysRemoved = removed;
      reportPasskeyRemoval(spent.code, removed === null ? 'unknown' : false);
    }

    // A used code removes every authenticator of the account: the person's
    // own act, recorded in their default organization. Never the code.
    const { organizationId } = await resolveDefaultOrgAndRole(session.userId);
    await emitAuthAudit({
      event: 'mfa.recovery.consumed',
      userId: session.userId,
      organizationId,
      extra:
        passkeysRemoved === null
          ? { unenrolled }
          : { unenrolled, passkeys_removed: passkeysRemoved },
    });
    revalidatePath('/dashboard', 'layout');
    return ok({ unenrolled });
  } catch (e) {
    return actionErrorResult(e, 'actions.mfa_recovery.consume_mfa_recovery_code');
  }
}

'use server';

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';

import { accountIdHash, reportPasskeyRecordsMissing } from '@/lib/auth/passkey-bridge';
import { carriesBridgeName } from '@/lib/auth/passkey-bridge-name';
import { requireSession } from '@/lib/auth/session';
import type { RecoveryCodeDone, RecoveryMethodsLeft } from '@/lib/auth/recovery-code-words';
import { readVerifiedSessionTokenOf, type VerifiedSessionToken } from '@/lib/auth/verified-claims';
import { verifyPasswordSideChannel } from '@/lib/auth/verify-password';
import { clientIpFromHeaders } from '@/lib/client-ip';
import { rethrowControlFlow } from '@/lib/control-flow';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { createAccessTokenClient } from '@/lib/supabase/access-token-client';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import { recordAccountCodeBlocked } from '@/server/security/account-events';
import { signOutAs } from '@/server/security/passkey-auth';
import { sendRecoveryCodeUsedEmail } from '@/server/security/recovery-code-email';
import { emitAuthAudit, resolveDefaultOrgAndRole } from '@/server/services/auth-audit';
import { ServiceError } from '@/server/services/context';
import { broadcastEndedSessions, listMySessionIds } from '@/server/services/sessions';
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
 * answered; 'unknown': it did not, or the code was not spent here), with a
 * hash of the account id so the operator can find the account
 * (passkey_account_states, runbook 10; review 2-3 finding 7). Never the code,
 * the account id, the account's passkeys or the bridge's id.
 */
function reportPasskeyRemoval(
  failure: string,
  recordsLeft: false | 'unknown',
  userId: string,
): void {
  void reportError(new Error('A recovery code could not remove the passkey records in one call'), {
    tag: 'actions.mfa_recovery.passkey_removal',
    level: 'error',
    userIdHash: accountIdHash(userId),
    extra: { failure, records_left: recordsLeft },
  });
}

/**
 * The answer when the combined call failed and today's consume then refused
 * the code: the combined call may have spent it before its answer was lost,
 * so the code is not called wrong (review 2-3 finding 12).
 */
const RECOVERY_NOT_CHECKED = 'Could not check your recovery code just now. Try again.';

/**
 * Whether Auth still holds the session of `token` (the held, verified token
 * of `userId`): GET /user with that token, which Auth answers only while the
 * session exists. The token was checked LOCALLY (getClaims) and PostgREST
 * accepts it until it expires, so a session already ended at Auth (signed
 * out, revoked from another device, ended by a used recovery code) could
 * still spend a code with the password while its token lasted (the second
 * lab walk, RS5 20). One round trip, made only for a press that got past the
 * three limiters and the password, right before any code is checked.
 *   - 'live': Auth answered with this account;
 *   - 'ended': Auth refused the token (auth-js names Auth's session_not_found
 *     AuthSessionMissingError; a 401 or 403), or answered another account;
 *   - 'unknown': any other error answer (Auth not reached, a 5xx).
 * The caller refuses both of the last two before any code is checked; a
 * throw goes to the action's catch, which refuses too. On 'ended' for
 * session_not_found, auth-js also removes the stored session of the client it
 * ran on, the cookie client here, so that answer clears this browser's
 * sign-in cookies too (the session is already gone at Auth; pinned in
 * mfa-recovery.held-reads.test.ts).
 *
 * With 'live' comes the account's own sign-in address as Auth answers it
 * (null when Auth gives none). The security email goes only to that address,
 * never to `session.email`, which for an account with no profile row is a
 * request header the caller can choose (lib/auth/session.ts; the release
 * review of stage 5, finding 1).
 */
async function sessionAtAuth(
  supabase: Awaited<ReturnType<typeof createClient>>,
  token: string,
  userId: string,
): Promise<{ state: 'live'; email: string | null } | { state: 'ended' } | { state: 'unknown' }> {
  // A throw is not caught here: it reaches the action's own catch
  // (actionErrorResult), which refuses before any code is checked.
  const { data, error } = await supabase.auth.getUser(token);
  if (error) {
    const { name, status } = error as { name?: string; status?: number };
    if (name === 'AuthSessionMissingError') return { state: 'ended' };
    if (name === 'AuthApiError' && (status === 401 || status === 403)) return { state: 'ended' };
    return { state: 'unknown' };
  }
  const user = data?.user;
  if (user?.id !== userId) return { state: 'ended' };
  const email = typeof user.email === 'string' && user.email ? user.email : null;
  return { state: 'live', email };
}

/** The client that acts as the held token alone (made once per press, when first needed). */
type MemberClient = ReturnType<typeof createAccessTokenClient>;

/** A factor as Auth's admin API lists it (only what the removal reads). */
type ListedAdminFactor = {
  id: string;
  factor_type: string;
  status?: string;
  friendly_name?: string | null;
};

/** What the factor removal did at Auth: the true count, and what is left there. */
type FactorRemoval = {
  /** The factors listed (none when the list could not be read). */
  factors: ListedAdminFactor[];
  /** TOTP factors deleted, the passkey's hidden one and any never set up included (the audit row's count). */
  unenrolled: number;
  /**
   * Of those, the sign-in methods: every one but a factor never set up
   * (unverified). A factor whose status is not given counts (closed).
   */
  methodsRemoved: number;
  /**
   * Of the sign-in methods, the authenticator apps: not the passkey's own
   * factor (no reserved name), and never a factor never set up, so the words
   * after the press agree with the email (the release review of stage 5,
   * finding 2).
   */
  appsRemoved: number;
  /** Deletes that failed (any factor). */
  failed: number;
  /** The list could not be read: no delete was tried. */
  unchecked: boolean;
  /** A verified authenticator app could not be deleted. */
  appLeft: boolean;
  /** A verified factor carrying the bridge's reserved name could not be deleted. */
  passkeyFactorLeft: boolean;
};

/**
 * Removes every TOTP factor of the account with the service role, reading
 * the list's error and each delete's error (the review of stage 5, finding
 * 1). A list that cannot be read (an error, or a throw) is `unchecked`: no
 * factor is deleted and none is called removed. A verified factor whose
 * delete failed (an error, or a throw) is left: the passkey's own when it
 * carries the bridge's reserved name, else an authenticator app. A factor
 * never set up (`unverified`) is no sign-in method, so its failed delete
 * leaves nothing. What the member is told is decided with the passkey
 * records' own outcome (methodsLeftOf). Never throws for a failed Auth call:
 * the code is already spent.
 */
async function removeFactors(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
): Promise<FactorRemoval> {
  let factors: ListedAdminFactor[];
  try {
    const listed = await admin.auth.admin.mfa.listFactors({ userId });
    if (listed.error || !listed.data) throw new Error('list');
    factors = (listed.data.factors ?? []) as ListedAdminFactor[];
  } catch {
    return {
      factors: [],
      unenrolled: 0,
      appsRemoved: 0,
      methodsRemoved: 0,
      failed: 0,
      unchecked: true,
      appLeft: false,
      passkeyFactorLeft: false,
    };
  }
  let unenrolled = 0;
  let appsRemoved = 0;
  let methodsRemoved = 0;
  let failed = 0;
  let appLeft = false;
  let passkeyFactorLeft = false;
  for (const f of factors) {
    // We only deliberately enroll TOTP today; play it safe and only
    // remove totp factors so we don't surprise SSO/SAML setups later.
    if (f.factor_type !== 'totp') continue;
    let deleted = false;
    try {
      const r = await admin.auth.admin.mfa.deleteFactor({ userId, id: f.id });
      deleted = !r.error;
    } catch {
      deleted = false;
    }
    if (deleted) {
      unenrolled += 1;
      // A factor never set up is removed, but it was no sign-in method.
      if (f.status === 'unverified') continue;
      methodsRemoved += 1;
      if (!carriesBridgeName(f)) appsRemoved += 1;
      continue;
    }
    failed += 1;
    if (f.status === 'unverified') continue;
    if (carriesBridgeName(f)) passkeyFactorLeft = true;
    else appLeft = true;
  }
  return {
    factors,
    unenrolled,
    appsRemoved,
    methodsRemoved,
    failed,
    unchecked: false,
    appLeft,
    passkeyFactorLeft,
  };
}

/**
 * What a used code left, for the answer and the email (the review of the
 * last deltas, findings 3 and 8), or undefined when nothing was:
 *   - the list of methods could not be read: no removal was tried
 *     ('unchecked');
 *   - `passkeyMaybeLeft` (a listed factor carries the bridge's reserved name
 *     and the passkey records are not known to be removed): a passkey may be
 *     left ('passkey', or 'app_and_passkey' with an app left), whether or not
 *     its factor went;
 *   - an app could not be deleted ('app');
 *   - the passkey records are known removed and only the passkey's own
 *     factor could not be deleted: the passkeys are removed, and the account
 *     still asks for a second step ('second_step').
 */
function methodsLeftOf(
  removal: FactorRemoval,
  passkeyMaybeLeft: boolean,
): RecoveryMethodsLeft | undefined {
  if (removal.unchecked) return 'unchecked';
  if (removal.appLeft) return passkeyMaybeLeft ? 'app_and_passkey' : 'app';
  if (passkeyMaybeLeft) return 'passkey';
  return removal.passkeyFactorLeft ? 'second_step' : undefined;
}

/**
 * Answers Q6 (stage 5 of the passkey plan): a used code ends every OTHER
 * session of the account, and the session that used it stays signed in.
 *   1. The sessions are listed first, as the member (they cannot be listed
 *      once ended), for the devices' message below.
 *   2. Auth's sign-out of scope `others`, AS the held token (never the cookie
 *      session, never `global` or `local`).
 *   3. When Auth's sign-out fails, the database ends them instead
 *      (revoke_my_other_sessions, 0213, as the member), keeping THIS
 *      session's id; only with an id, since null would end this one too.
 *   4. Once they ended, the devices hear which sessions ended, never the one
 *      that stays (services/sessions.ts broadcastEndedSessions).
 * A sign-out that could not be confirmed is reported: a warning when the
 * database ended them, an error when nothing did. The calls it makes answer
 * a failure rather than throw (a throw would reach the action's catch, after
 * the code is spent and the factors removed). Returns whether every other
 * session ended.
 */
async function endOtherSessions(
  held: VerifiedSessionToken,
  member: () => MemberClient,
  userId: string,
): Promise<boolean> {
  const keep = held.claims.sessionId;
  // Never throws: unreadable is null, and nothing is named to the devices.
  const listed = await listMySessionIds(member());
  const signedOut = await signOutAs(held.token, 'others');
  if (signedOut.ok) {
    if (keep) await broadcastEndedSessions(userId, listed, keep);
    return true;
  }
  let databaseRevoke: 'ok' | 'failed' | 'no_session_id' = 'no_session_id';
  if (keep) {
    // supabase-js answers a failed call (the network included) as `error`.
    const { error } = await member().rpc('revoke_my_other_sessions', {
      p_keep_session_id: keep,
    });
    databaseRevoke = error ? 'failed' : 'ok';
  }
  // Never the token, the code or a session id: Auth's code and status only.
  void reportError(new Error('A recovery code could not confirm that the other sessions ended'), {
    tag: 'actions.mfa_recovery.other_sessions_not_ended',
    level: databaseRevoke === 'ok' ? 'warning' : 'error',
    userIdHash: accountIdHash(userId),
    extra: { code: signedOut.code, status: signedOut.status, database_revoke: databaseRevoke },
  });
  if (databaseRevoke !== 'ok' || !keep) return false;
  await broadcastEndedSessions(userId, listed, keep);
  return true;
}

/**
 * Used by /signin/mfa when the user can't reach their TOTP device.
 * Verifies one of their unused recovery codes, and on success removes their
 * passkeys (0475) and unenrolls every TOTP factor on the account using the
 * admin client (RLS on auth.mfa requires service-role for this), then ends
 * the account's OTHER sessions (this one stays) and emails the account
 * (answers Q6 and Q7). The user then sets up a new method on this session.
 * `otherSessionsLeft` is there only when the other sessions could not be
 * ended, and `methodsLeft` only when something was left (methodsLeftOf), so
 * the form says so, as a warning. An account with passkeys also gets
 * `appsRemoved` and, only when its passkeys are KNOWN removed,
 * `passkeysRemoved`.
 */
export async function consumeMfaRecoveryCodeAction(input: {
  code: string;
  password?: string;
}): Promise<ActionResult<RecoveryCodeDone>> {
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
    const pwRes = await verifyPasswordSideChannel(session.email, input.password, session.userId);
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
    // One client of the held token for this press, made when first needed
    // (today's consume, the session list, the database revoke).
    let asMember: MemberClient | null = null;
    const member = () => (asMember ??= createAccessTokenClient(held.token));

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

    // The session must still exist at Auth, not only carry a token that has
    // not expired yet (RS5 20): an ended session spends no code, removes no
    // method and ends no other session. Closed: an answer that cannot be had
    // refuses too, with "try again".
    const atAuth = await sessionAtAuth(supabase, held.token, session.userId);
    if (atAuth.state === 'ended') {
      return err('unauthenticated', SESSION_CHANGED, { reason: 'session_changed' });
    }
    if (atAuth.state === 'unknown') return err('internal_error', RECOVERY_NOT_CHECKED);
    // The account's own address, as Auth answered it for the held token.
    const accountEmail = atAuth.email;

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
      const { data: ok_, error } = await member().rpc('consume_mfa_recovery_code', {
        p_code: input.code,
      });
      if (error) throw new ServiceError('internal_error', error.message);
      consumed = Boolean(ok_);
      if (spent.kind === 'failed' && !consumed) {
        // The combined call may have committed (the code spent, the passkeys
        // removed) and only its answer been lost; or the code is wrong. It is
        // not known which, so it is not judged: "try again", no refused-code
        // record and no audit row of a failed code. Reported.
        reportPasskeyRemoval(spent.code, 'unknown', session.userId);
        return err('internal_error', RECOVERY_NOT_CHECKED);
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
    // passkey bridge among them. The list's error and each delete's error are
    // read (the review of stage 5, finding 1): a list that cannot be read, or
    // a verified factor that could not be deleted, is a method that may be
    // left, said so in the answer and the email, never called removed.
    const removal = await removeFactors(admin, session.userId);
    const factors = removal.factors;
    // The function missing (0475 not live, or lost from the schema cache) and a
    // factor carrying the bridge's reserved name: a bridge may have existed,
    // and its passkey records were not removed. Reported at error level, once
    // per hour (review 2-3 finding 3); an account with no such factor reports
    // nothing.
    if (spent.kind === 'not_yet' && factors.some(carriesBridgeName)) {
      await reportPasskeyRecordsMissing('function', 'recovery_code', session.userId);
    }
    const { unenrolled, appsRemoved, methodsRemoved } = removal;

    // Whether the passkey records are KNOWN removed: the combined call
    // answered, or the second removal below did. Not when the function is
    // missing, and not when both calls failed.
    let recordsKnownRemoved = spent.kind === 'answered';
    if (spent.kind === 'failed') {
      // The code is spent and the factors are gone; the passkey records may
      // not be. One more try, then one report either way.
      const retry = await admin.rpc('passkey_remove_all', {
        p_user_id: session.userId,
        p_reason: 'recovery_code',
      });
      const removed = removedCount(retry);
      if (removed !== null) {
        passkeysRemoved = removed;
        recordsKnownRemoved = true;
      }
      reportPasskeyRemoval(spent.code, removed === null ? 'unknown' : false, session.userId);
    }

    // Q6: every OTHER session of the account ends; this one stays, whether
    // or not every method was removed.
    const othersEnded = await endOtherSessions(held, member, session.userId);
    // A listed factor carries the bridge's reserved name, and the passkey
    // records are not known removed: a passkey may be left, and is never
    // called removed (the review of the last deltas, finding 3). An account
    // with no such factor is told nothing about passkeys here.
    const reservedListed = factors.some(carriesBridgeName);
    const methodsLeft = methodsLeftOf(removal, reservedListed && !recordsKnownRemoved);
    if (methodsLeft) {
      // Which kind, and how many deletes failed: never a factor, the account
      // id or the code.
      void reportError(new Error('A recovery code could not remove every sign-in method'), {
        tag: 'actions.mfa_recovery.methods_left',
        level: 'error',
        userIdHash: accountIdHash(session.userId),
        extra: { methods_left: methodsLeft, failed: removal.failed },
      });
    }
    // The account had a passkey: one was removed, or a factor carrying the
    // bridge's reserved name was listed.
    const hadPasskeys = (passkeysRemoved ?? 0) > 0 || reservedListed;
    // Its passkeys are said removed only when that is known.
    const passkeysKnownRemoved = hadPasskeys && recordsKnownRemoved;

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
    // Q7: the security email, after the response, for every code known spent
    // here (a press refused before this point spent nothing and sends none;
    // a code the combined call may have spent before its answer was lost is
    // answered "try again" above and sends none either). It goes only to the
    // account's own address as Auth answered it for the held token, never to
    // `session.email` (the release review of stage 5, finding 1); an account
    // Auth gives no address gets no email, and that is reported, with no
    // address. It names passkeys only for an account that had one, and says
    // so when a method was left. Its sentences are only the true ones (the
    // second lab walk, RS5 25, and REVIEW-STAGE-6B finding 2): "removed" only
    // when a sign-in method was removed (a verified factor, or passkeys with
    // the code), "could not be removed" only when one was left; a code that
    // did neither (an account with no method, or only a factor never set up)
    // says only that a code was used and whether the other devices were
    // signed out.
    const nothingRemoved =
      methodsRemoved === 0 && (passkeysRemoved ?? 0) === 0 && methodsLeft === undefined;
    if (accountEmail) {
      sendRecoveryCodeUsedEmail(accountEmail, session.userId, {
        passkeys: hadPasskeys,
        othersSignedOut: othersEnded,
        ...(methodsLeft ? { methodsLeft } : {}),
        ...(methodsLeft === 'unchecked' && passkeysKnownRemoved ? { passkeysRemoved: true } : {}),
        ...(nothingRemoved ? { nothingRemoved: true } : {}),
      });
    } else {
      void reportError(new Error('A recovery code was used on an account with no sign-in address'), {
        tag: 'actions.mfa_recovery.email_no_address',
        level: 'warning',
        userIdHash: accountIdHash(session.userId),
      });
    }
    revalidatePath('/dashboard', 'layout');
    // `unenrolled` in the answer counts the sign-in methods removed at Auth,
    // never a factor never set up (the release review of stage 5, finding 2:
    // the words then agree with the email); the audit row above keeps the
    // count of every factor deleted. The answer of an account with no passkey
    // whose methods all went, and whose other sessions ended, is
    // `{ unenrolled }`, as before stage 5.
    const answer: RecoveryCodeDone = { unenrolled: methodsRemoved };
    if (hadPasskeys) {
      if (passkeysKnownRemoved) answer.passkeysRemoved = true;
      // The count of apps set up, apart from the passkey's own factor; not
      // known when the list could not be read.
      if (methodsLeft !== 'unchecked') answer.appsRemoved = appsRemoved;
    }
    if (methodsLeft) answer.methodsLeft = methodsLeft;
    if (!othersEnded) answer.otherSessionsLeft = true;
    return ok(answer);
  } catch (e) {
    return actionErrorResult(e, 'actions.mfa_recovery.consume_mfa_recovery_code');
  }
}

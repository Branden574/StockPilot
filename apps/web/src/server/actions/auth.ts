'use server';

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { after } from 'next/server';

import { loadAccountStatus, noteDisabledAccountBlocked } from '@/lib/auth/account-status';
import { noteLoginDevice } from '@/lib/auth/login-device';
import {
  checkMfaCode,
  MFA_CHALLENGE_NOT_STARTED,
  MFA_CODE_BUDGET_SPENT,
  MFA_CODE_GOTRUE_LIMITED,
  MFA_CODE_NOT_CHECKED,
  MFA_CODE_REFUSED,
  signOutThisSession,
} from '@/lib/auth/mfa-code-attempts';
import { sendPasswordResetEmail } from '@/lib/auth/password-reset-email';
import { openedFromResetLink } from '@/lib/auth/reset-link-session';
import { sessionAccountNow, type SessionAccountNow } from '@/lib/auth/session-account';
import { readVerifiedSessionClaims } from '@/lib/auth/verified-claims';
import { verifyPasswordSideChannel } from '@/lib/auth/verify-password';
import { broadcastToChannel } from '@/lib/realtime/broadcast';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { createClient } from '@/lib/supabase/server';
import {
  REMEMBER_SESSION_COOKIE,
  SUPABASE_AUTH_COOKIE,
  rememberPreferenceOptions,
} from '@/lib/supabase/session-cookies';
import {
  classifyPasswordUpdateError,
  isBannedUserAuthError,
} from '@/server/actions/auth-error-classify';
import { unexpectedActionError } from '@/server/lib/action-error-result';
import { audit } from '@/server/services/audit';
import { emitAuthAudit, resolveDefaultOrgAndRole } from '@/server/services/auth-audit';
import { revokeAllSessionsForUser } from '@/server/services/platform/sessions';
import { SESSION_CHANGED } from '@/server/services/step-up-held';
import { broadcastEndedSessions, listMySessionIds } from '@/server/services/sessions';

import {
  ACCOUNT_DISABLED_MESSAGE,
  changePasswordSchema,
  completePasswordResetSchema,
  err,
  ok,
  requestPasswordResetSchema,
  signInSchema,
  type ActionResult,
  type ChangePasswordInput,
  type CompletePasswordResetInput,
  type RequestPasswordResetInput,
  type SignInInput,
  type SignUpInput,
} from '@stockpilot/core';

/**
 * Best-effort client-IP extraction from request headers. Used as a
 * secondary rate-limit key on unauthenticated flows so an attacker can't
 * fan out across many email addresses from one host. `next/headers` is
 * async in Next 16.
 */
async function getClientIp(): Promise<string> {
  const h = await headers();
  return (
    h.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    h.get('x-real-ip') ??
    'unknown'
  );
}

/**
 * Public self-signup is disabled — this is an internal-company tool.
 * Accounts are created only by a team invite (acceptInviteWithSignupAction in
 * actions/team.ts), Platform > Provision (createOrgForCustomerAction in
 * actions/platform-admin.ts) and the B2B portal invite
 * (CustomersService.inviteUser in services/customers.ts).
 *
 * The function is kept exported (rather than deleted) so the existing
 * /signup page can render a "request access from your admin" notice
 * without import errors during the migration. Returns a forbidden error
 * if anything actually invokes it.
 */
 
export async function signUpAction(
  _input: SignUpInput,
): Promise<ActionResult<{ requiresEmailConfirm: boolean }>> {
  return err(
    'forbidden',
    'Public sign-up is disabled. Ask your administrator to send you an invite.',
  );
}

export async function signInAction(input: SignInInput): Promise<ActionResult<{ next: string }>> {
  const parsed = signInSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }

  // Rate-limit dual-keyed on email AND IP. 5/min/email blocks single-
  // account brute force; 30/min/ip stops a single host from fanning out
  // across many email addresses. Both gates run 'closed' — a DB outage
  // must NOT unlock unlimited attempts on the unauthenticated front
  // door. Return the typed `rate_limited` error (don't throw) so the
  // sign-in form can toast a clean message.
  const emailKey = parsed.data.email.toLowerCase();
  const ip = await getClientIp();
  const emailRl = await checkRateLimit(`signin:${emailKey}`, 5, 60_000, 'closed');
  if (!emailRl.allowed) {
    return err('rate_limited', 'Too many sign-in attempts. Try again in a minute.');
  }
  const ipRl = await checkRateLimit(`signin-ip:${ip}`, 30, 60_000, 'closed');
  if (!ipRl.allowed) {
    return err('rate_limited', 'Too many sign-in attempts. Try again in a minute.');
  }

  const supabase = await createClient({ rememberSession: parsed.data.rememberMe });
  const { data: signInData, error } = await supabase.auth.signInWithPassword({
    email: parsed.data.email,
    password: parsed.data.password,
  });
  if (error) {
    // Distinguish Supabase's auth rate-limit from a credential
    // mismatch — they have very different remediation. Supabase
    // returns HTTP 429 + `code: 'over_*_rate_limit'` when its
    // per-IP-per-window cap fires (e.g. a whole office signing
    // in from one NAT'd IP at the same time). Surfacing this
    // as "Invalid email or password" was actively misleading
    // and sent users on a wild-goose chase resetting passwords.
    //
    // The status check is the canonical signal (Supabase docs);
    // the code check is belt-and-suspenders for newer SDK
    // versions that may surface the code without the status.
    const errAny = error as unknown as {
      status?: number;
      code?: string;
      message?: string;
    };
    const isRateLimit =
      errAny.status === 429 ||
      (typeof errAny.code === 'string' && /rate.?limit/i.test(errAny.code));

    // A disabled account is not a credential problem. GoTrue rejects a banned
    // user with the structured code `user_banned` on every auth endpoint; left
    // alone it would fall into the generic "Invalid email or password" branch
    // below and send a locked-out user to reset a password that is perfectly
    // fine. Audited through the EXISTING sign-in-failure event with a distinct
    // reason rather than a new org-visible event — org visibility of a platform
    // disable is an open policy question.
    if (isBannedUserAuthError(errAny)) {
      noteDisabledAccountBlocked('login');
      await emitAuthAudit({
        event: 'user.sign_in_failed',
        userId: null,
        organizationId: null,
        extra: { email: parsed.data.email, reason: 'account_disabled' },
      });
      return err('account_disabled', ACCOUNT_DISABLED_MESSAGE);
    }

    await emitAuthAudit({
      event: 'user.sign_in_failed',
      userId: null,
      organizationId: null,
      extra: {
        email: parsed.data.email,
        reason: isRateLimit ? 'supabase_rate_limited' : 'invalid_credentials',
      },
    });
    if (isRateLimit) {
      return err(
        'rate_limited',
        'Sign-in is temporarily throttled for this network. Wait a couple of minutes and try again.',
      );
    }
    return err('unauthenticated', 'Invalid email or password');
  }

  const cookieStore = await cookies();
  cookieStore.set(
    REMEMBER_SESSION_COOKIE,
    parsed.data.rememberMe ? '1' : '0',
    rememberPreferenceOptions(parsed.data.rememberMe),
  );

  // If the user has any verified MFA factors, the password sign-in only
  // brings them to AAL1. They must complete the TOTP challenge to reach
  // AAL2 and access the dashboard.
  const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  const nextPath =
    aal && aal.currentLevel === 'aal1' && aal.nextLevel === 'aal2'
      ? '/signin/mfa'
      : '/dashboard';

  // Audit successful sign-in. Resolve org + role best-effort for
  // attribution — these are nullable on audit_logs so a brand-new user
  // (no membership) still gets a row.
  const userId = signInData.user?.id ?? null;
  let organizationId: string | null = null;
  let role: string | null = null;
  if (userId) {
    const resolved = await resolveDefaultOrgAndRole(userId);
    organizationId = resolved.organizationId;
    role = resolved.role;
  }
  await emitAuthAudit({
    event: 'user.signed_in',
    userId,
    organizationId,
    extra: {
      email: parsed.data.email,
      role,
      remember: parsed.data.rememberMe,
      mfa_required: nextPath === '/signin/mfa',
    },
  });

  // New-device sign-in alert. Runs AFTER the response (`after`) so it adds zero
  // latency to the login round-trip. Best-effort: emails only for a new device
  // on an account that already has known devices (first device = silent
  // baseline). Fires here on the password step — i.e. even before TOTP — so a
  // stolen password used from a new device still alerts the real owner.
  if (userId) {
    const ua = (await headers()).get('user-agent');
    after(() => noteLoginDevice({ userId, email: parsed.data.email, userAgent: ua, ip }));
  }

  return ok({ next: nextPath });
}

export async function signOutAction(): Promise<void> {
  const supabase = await createClient();

  // The account this sign-out is for, read BEFORE signOut so the broadcast
  // and the audit row below can name it after the session is gone. When
  // GoTrue's answer names nobody (a 5xx or no answer: auth-js then returns no
  // user and keeps the stored session), the session's verified claims name
  // it instead, read here because the sign-out clears the cookie. Only a
  // token whose signature checks out names anyone (lib/auth/verified-claims),
  // and with no verified account nothing is broadcast or written: anyone can
  // post this action with no session at all.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const claims = user ? null : await readVerifiedSessionClaims(supabase);
  const accountId = user?.id ?? claims?.userId ?? null;

  // scope: 'global' revokes ALL refresh tokens for the user across
  // every device + tab. Default ('local') only kills the calling
  // tab's token, leaving other browser tabs and the mobile app
  // alive until natural expiry (~1h). For an internal enterprise
  // tool, "Sign out" should mean "log me out everywhere."
  //
  // auth-js returns a failure rather than throwing, so the answer is read.
  // No error means nothing was reported, not that every session ended: GoTrue
  // answering 401/403/404 for this token is no error either.
  const { error: revokeError } = await supabase.auth.signOut({ scope: 'global' });
  const databaseRevoke = revokeError
    ? await endSessionsAfterFailedGlobalSignOut(revokeError, accountId, {
        tag: 'auth.sign_out_revoke_failed',
        message: 'Sign out could not confirm that every session ended',
      })
    : 'not_needed';
  // The revoke above only kills REFRESH tokens — devices coast on their
  // current access token for up to ~1h ("signed out on web, phone still
  // let me in", owner-observed 2026-07-02). The broadcast makes every
  // device's session-revocation listener sign out locally within ~1s.
  // keepId:null targets ALL sessions (see use-session-revocation.ts).
  //
  // Sent also when neither revoke could be confirmed: the person asked to be
  // signed out everywhere, and each device's listener decides what the
  // message means for its own session (a web tab asks GoTrue first and stays
  // while its session is alive). Not sent twice when the database revoke
  // already did.
  if (accountId && databaseRevoke !== 'ok') {
    await broadcastToChannel(`user:${accountId}:sessions`, 'revoked', { keepId: null });
  }
  const cookieStore = await cookies();
  cookieStore.delete(REMEMBER_SESSION_COOKIE);

  if (accountId) {
    const { organizationId } = await resolveDefaultOrgAndRole(accountId);
    await emitAuthAudit({
      event: 'user.signed_out',
      userId: accountId,
      organizationId,
      extra: {
        email: user?.email ?? null,
        scope: 'global',
        revoke_error: revokeErrorLabel(revokeError),
        database_revoke: databaseRevoke,
      },
    });
  }

  redirect('/');
}

/** The failure a sign-out returned, as auth-js hands it back. */
type SignOutError = { name: string; code?: string; status?: number };

/**
 * What an audit row says about a sign-out's answer: GoTrue's code, or the
 * error's name when it has none, or null when it returned no error. What is
 * known, never "confirmed": no error also covers GoTrue answering 401, 403 or
 * 404 for the token, which auth-js does not report.
 */
function revokeErrorLabel(error: SignOutError | null): string | null {
  return error ? (error.code ?? error.name) : null;
}

/**
 * The backstop for a global sign-out (Sign out, a finished password reset)
 * that returned an error instead of ending the account's sessions:
 *
 *   1. Every other session of the account is still alive, so they are ended
 *      in the database instead (revokeAllSessionsForUser, the by-user-id
 *      revoke behind member removal and account disable, which tells the
 *      devices itself when it worked). Only for an account a verified answer
 *      named.
 *   2. This browser's own session: when auth-js could not load it (an expired
 *      access token whose refresh failed) it returns that error BEFORE
 *      removing the local session, so the cookies would stay and be refreshed
 *      once the Auth server answers again. Its Supabase auth cookies are
 *      expired, as app/auth/session-ended/route.ts does.
 *   3. A warning report with the error's name, code and status, never
 *      GoTrue's message.
 *
 * Returns what the database revoke did, for the caller's broadcast and row.
 */
async function endSessionsAfterFailedGlobalSignOut(
  revokeError: SignOutError,
  accountId: string | null,
  report: { tag: string; message: string },
): Promise<'ok' | 'failed' | 'no_account'> {
  const databaseRevoke = accountId
    ? (await revokeAllSessionsForUser(accountId)).ok
      ? 'ok'
      : 'failed'
    : 'no_account';
  const cookieStore = await cookies();
  for (const c of cookieStore.getAll()) {
    if (SUPABASE_AUTH_COOKIE.test(c.name)) cookieStore.set(c.name, '', { path: '/', maxAge: 0 });
  }
  void reportError(new Error(report.message), {
    tag: report.tag,
    level: 'warning',
    extra: {
      name: revokeError.name,
      code: revokeError.code ?? null,
      status: revokeError.status ?? null,
      database_revoke: databaseRevoke,
    },
  });
  return databaseRevoke;
}

/**
 * A password change whose update answered for another account than the one
 * whose current password was checked: reported, that account signed out
 * everywhere (with the database revoke when GoTrue's sign-out fails), its
 * devices told, and its row written. Answers sign in again.
 */
async function endSessionsAfterPasswordSetForAnotherAccount(
  supabase: Awaited<ReturnType<typeof createClient>>,
  accountId: string,
  email: string | null,
): Promise<ActionResult<never>> {
  void reportError(new Error('A password change set the password of another account than the one checked'), {
    tag: 'auth.password_change_account_changed',
    level: 'error',
  });
  const { error: revokeError } = await supabase.auth.signOut({ scope: 'global' });
  const databaseRevoke = revokeError
    ? await endSessionsAfterFailedGlobalSignOut(revokeError, accountId, {
        tag: 'auth.password_change_revoke_failed',
        message: 'Password change could not confirm that every session ended',
      })
    : 'not_needed';
  if (databaseRevoke !== 'ok') {
    await broadcastToChannel(`user:${accountId}:sessions`, 'revoked', { keepId: null });
  }
  const { organizationId } = await resolveDefaultOrgAndRole(accountId);
  await emitAuthAudit({
    event: 'user.password.changed',
    userId: accountId,
    organizationId,
    extra: {
      email,
      account_changed: true,
      revoke_error: revokeErrorLabel(revokeError),
      database_revoke: databaseRevoke,
    },
  });
  return err('unauthenticated', SESSION_CHANGED, { reason: 'session_changed' });
}

export async function requestPasswordResetAction(
  input: RequestPasswordResetInput,
): Promise<ActionResult<{ ok: true }>> {
  const parsed = requestPasswordResetSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', 'Invalid email');

  // 3 requests / 15 min / email. Closed mode — a DB outage must NOT
  // unlock unlimited reset-email blasts (which would spam the user
  // and burn through Resend quota). Same generic ok() return on rate
  // hit to keep account-enumeration resistance.
  const emailKey = parsed.data.email.toLowerCase();
  const rl = await checkRateLimit(`pwreset-req:${emailKey}`, 3, 15 * 60_000, 'closed');
  if (!rl.allowed) {
    return ok({ ok: true });
  }

  // Mint + send via the shared helper (admin.generateLink → our
  // /auth/confirm URL → Resend; see sendPasswordResetEmail for the WHY on
  // both). The result is IGNORED on purpose: every failure (unknown email,
  // link or send error) must produce the same generic ok() — account-
  // enumeration resistance.
  await sendPasswordResetEmail(parsed.data.email);

  // Audit reset requests (email only; looking the user up to attach an id
  // would leak account-enumeration signal back to the caller). user_id
  // stays null.
  await emitAuthAudit({
    event: 'user.password.reset_requested',
    userId: null,
    organizationId: null,
    extra: { email: parsed.data.email },
  });

  // Always return ok to avoid account enumeration.
  return ok({ ok: true });
}

/**
 * Normalises a TOTP code typed into the reset form. Authenticator apps render
 * the code as `123 456`, and phone keyboards happily add a trailing space, so
 * strip whitespace before the shape check rather than rejecting a code the
 * user copied correctly.
 */
function normalizeTotpCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const code = raw.replace(/\s/g, '');
  return /^\d{6}$/.test(code) ? code : null;
}

/**
 * The reset form's request for the authenticator code. It answers a press
 * that came without one, and GoTrue's own refusal for want of AAL2, with
 * `details.reason: 'aal2_required'`, which makes the form show its code box.
 */
const RESET_CODE_ASK =
  'Enter the 6-digit code from your authenticator app to finish resetting your password.';

/** The reset link's session is gone: spent, expired, or ended in another tab. */
const RESET_LINK_GONE =
  'That link has expired or was already used. Choose Forgot? on the sign-in page to get a new link by email.';

/**
 * A session that did not come from an emailed link in the last hour
 * (lib/auth/reset-link-session.ts): a signed-in person changes their password
 * in Settings, Security, which asks for the current one.
 */
const RESET_NEEDS_LINK =
  'A new password can be set here only within an hour of opening the link in your email. Choose Forgot? on the sign-in page to get a new link. If you are signed in, use Change password in Settings → Security.';

/** The reset link's session could not be verified just now; it is left as it is. */
const RESET_UNCONFIRMED =
  'Could not confirm your reset link just now, so your password was not changed. Try again in a moment.';

/**
 * The reset's answer when its session no longer verifies as the account the
 * link opened (lib/auth/session-account): another account is signed out here;
 * a session that could not be verified is refused and left alone, so the
 * link's session stays for the next press.
 */
async function resetSessionRefusal(
  supabase: Awaited<ReturnType<typeof createClient>>,
  now: Exclude<SessionAccountNow, { kind: 'same' }>,
): Promise<ActionResult<never>> {
  if (now.kind === 'other') {
    await signOutThisSession(supabase);
    return err('unauthenticated', RESET_LINK_GONE);
  }
  return err('internal_error', RESET_UNCONFIRMED);
}

export async function completePasswordResetAction(
  // `totpCode` is additive and optional: the emailed recovery link and the
  // form both keep working without it, and it is read off the raw input rather
  // than through completePasswordResetSchema, so the shared schema stays as it
  // is. The reset form sends it once this action asks for it (docket B50). See
  // the MFA step-up block below for why it exists.
  input: CompletePasswordResetInput & { totpCode?: string },
): Promise<ActionResult<{ next: string }>> {
  const parsed = completePasswordResetSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }

  const supabase = await createClient();

  // ONLY A SESSION FROM AN EMAILED LINK (S77). A new password is set here
  // only on a session that an emailed link made in the last hour: its
  // VERIFIED `amr` claim holds that link's entry (lib/auth/reset-link-session.ts
  // lists the ways a person reaches this page and the method names). A
  // session made with a password changes its password through Change
  // password, which asks for the current one. Checked
  // first: a refused session costs no limiter count, no factor read and no
  // write. The account it verifies as is the account this press is for; the
  // code budget and the password update are held to it below.
  const linkClaims = await readVerifiedSessionClaims(supabase);
  if (!linkClaims) return err('unauthenticated', RESET_LINK_GONE);
  if (!openedFromResetLink(linkClaims.amr, Math.floor(Date.now() / 1000))) {
    return err('forbidden', RESET_NEEDS_LINK);
  }
  const accountId = linkClaims.userId;

  // 5 completes / 15 min / ip. Closed mode — the user is briefly
  // authenticated by the recovery token at this point, but the
  // endpoint is still effectively unauthenticated front door.
  const ip = await getClientIp();
  const rl = await checkRateLimit(`pwreset-complete:${ip}`, 5, 15 * 60_000, 'closed');
  if (!rl.allowed) {
    return err('rate_limited', 'Too many attempts. Try again in a few minutes.');
  }

  // MFA STEP-UP. GoTrue refuses `updateUser({ password })` outright when the
  // user has a verified factor and the calling session is not AAL2 — "AAL2
  // session is required to update email or password when MFA is enabled."
  // (internal/api/user.go; there is NO recovery-type exemption). The session
  // minted for a recovery link is AAL1: /auth/confirm calls verifyOtp
  // (type=recovery), and only mfa/verify ever raises a session to AAL2.
  //
  // So before this block, every TOTP-enrolled user — i.e. every admin in an
  // `admins_required` org, the highest-value accounts we have — was
  // PERMANENTLY unable to finish a password reset: the form showed GoTrue's
  // raw AAL2 message on every retry and the only way back in was an admin
  // stripping their factor. changePasswordAction already documents this exact
  // rule (see its WHY comment) for the signed-in flow; recovery never did.
  //
  // The fix keeps the second factor MANDATORY on recovery (challenge + verify
  // the user's own TOTP code to raise THIS session to AAL2) rather than
  // routing around GoTrue with the service-role admin API, which would make a
  // single intercepted reset link enough to take over an MFA-protected
  // account.
  const { data: factorsData, error: factorsError } = await supabase.auth.mfa.listFactors();
  if (factorsError) {
    // Deliberately NOT fail-closed: GoTrue itself is the enforcement point, so
    // an unreadable factor list must not block an UNENROLLED user's reset on a
    // transient blip. A genuinely enrolled user is still refused by updateUser
    // one step below — this branch only decides whether we can ask for a code.
    console.warn('[completePasswordResetAction] listFactors failed:', factorsError.message);
  }
  const totpFactorId =
    (factorsData?.totp ?? []).find((f) => f.status === 'verified')?.id ?? null;
  if (totpFactorId) {
    // The session as it verifies AFTER the factor list (a read that can
    // refresh the session into another account's), against the account this
    // press is for: another account is signed out here and refused, a session
    // that could not be verified is refused and left alone, both with nothing
    // spent. Its level decides whether the code is needed, and its account is
    // the one the code budget is spent on (shared with the sign-in code and
    // the step-up, lib/auth/mfa-code-attempts.ts).
    const heldNow = await sessionAccountNow(supabase, accountId);
    if (heldNow.kind !== 'same') return resetSessionRefusal(supabase, heldNow);
    const held = heldNow.claims;
    if (held.aal !== 'aal2') {
      const code = normalizeTotpCode(input.totpCode);
      if (!code) {
        // `details.reason` lets the reset form reveal its code field instead of
        // showing a dead end. Same vocabulary as the API gate's aal2_required.
        return err('forbidden', RESET_CODE_ASK, { reason: 'aal2_required' });
      }
      const check = await checkMfaCode(supabase, {
        userId: held.userId,
        factorId: totpFactorId,
        code,
        path: 'password_reset',
      });
      // GoTrue judged the code while the session held another account: this
      // session was signed out (checkMfaCode), and no password is set.
      if (check.kind === 'account_changed') return err('unauthenticated', RESET_LINK_GONE);
      // GoTrue judged the code, then the session could not be verified: the
      // answer is not used, the session is left alone, and no password is set.
      if (check.kind === 'unconfirmed') {
        return err('forbidden', MFA_CODE_NOT_CHECKED, { reason: 'aal2_required' });
      }
      // The two pauses (this account's code budget spent, GoTrue's own limit
      // on code checks) carry `reason` too: an authenticator code changes
      // every 30 seconds, so the one in the box is stale once the wait is
      // over. With the reason the form empties the box and shows the words
      // under it, as for a refused code; without it the form kept the code,
      // and the next press was certain to be refused.
      if (check.kind === 'budget_spent') {
        return err('rate_limited', MFA_CODE_BUDGET_SPENT, { reason: 'aal2_required' });
      }
      if (check.kind !== 'verified') {
        // Never echo GoTrue's message, which can carry factor/challenge
        // identifiers.
        if (check.outcome === 'session_gone') return err('unauthenticated', RESET_LINK_GONE);
        if (check.outcome === 'limited') {
          return err('rate_limited', MFA_CODE_GOTRUE_LIMITED, { reason: 'aal2_required' });
        }
        if (check.kind === 'challenge_failed') {
          return err('internal_error', MFA_CHALLENGE_NOT_STARTED);
        }
        return err(
          'forbidden',
          check.outcome === 'refused' ? MFA_CODE_REFUSED : MFA_CODE_NOT_CHECKED,
          { reason: 'aal2_required' },
        );
      }
    }
  }

  // The password is set only for the account this press is for, and only
  // while its session still carries the link's entry: the session is read
  // once more right before the update, against that account. One that now
  // holds another account is signed out here and refused; one that could not
  // be verified is refused and left alone.
  const atUpdateNow = await sessionAccountNow(supabase, accountId);
  if (atUpdateNow.kind !== 'same') return resetSessionRefusal(supabase, atUpdateNow);
  const atUpdate = atUpdateNow.claims;
  if (!openedFromResetLink(atUpdate.amr, Math.floor(Date.now() / 1000))) {
    return err('forbidden', RESET_NEEDS_LINK);
  }

  const { data: updated, error } = await supabase.auth.updateUser({
    password: parsed.data.password,
  });
  if (error) {
    // GoTrue's refusals of the new password, in plain words (docket B50). Read
    // by GoTrue's code only (auth-error-classify.ts); any other refusal is
    // reported and says the fixed sentence, never GoTrue's text (S31). Nothing
    // below has run: nobody is signed out and the old password still works.
    const refusal = classifyPasswordUpdateError(error);
    if (refusal?.kind === 'aal') {
      // GoTrue still wants AAL2, so the code step above did not run (as when
      // the factor list could not be read). Ask for the code, so the form
      // shows its box; a code sent with this press was never checked, so say
      // that.
      return err(
        'forbidden',
        normalizeTotpCode(input.totpCode) ? MFA_CODE_NOT_CHECKED : RESET_CODE_ASK,
        { reason: 'aal2_required' },
      );
    }
    if (refusal?.kind === 'same') {
      return err('validation_error', 'Choose a password that is different from your current one.');
    }
    if (refusal?.kind === 'weak') {
      return err(
        'validation_error',
        refusal.breached
          ? 'This password has appeared in a known data breach. Choose a different one.'
          : 'This password does not meet the password rules. Choose a stronger one.',
      );
    }
    if (refusal?.kind === 'session_gone') {
      // The link's session is gone (spent, expired, or ended by a reset
      // finished in another tab). The words follow the sign-in card's
      // LINK_FAILED_NOTICE (lib/auth/auth-page-notices.ts).
      return err('unauthenticated', RESET_LINK_GONE);
    }
    return unexpectedActionError(error, 'actions.auth.password_reset');
  }

  // The update's answer names the account the new password was set for. When
  // that is not the account the link's session verified as, the session
  // changed accounts between the last read and the update: that account's
  // sessions are ended and its row written, as for any finished reset, and
  // this press answers with sign in again.
  const updatedId = updated?.user?.id ?? null;
  const accountChanged = updatedId !== null && updatedId !== accountId;
  if (accountChanged) {
    void reportError(new Error('A password reset set the password of another account than the link verified'), {
      tag: 'auth.password_reset_account_changed',
      level: 'error',
    });
  }

  // The account the new password was set for, with the address the update's
  // own answer names, else the token's (only when it is the same account).
  const resetUser = accountChanged
    ? { id: updatedId, email: updated?.user?.email ?? null }
    : { id: accountId, email: updated?.user?.email ?? linkClaims.email ?? null };

  // SECURITY: after an email-recovery password update, force a fresh
  // sign-in rather than auto-elevating the recovery session into the
  // dashboard. The recovery link is the only factor that's been verified
  // here — an attacker who intercepted a reset link could otherwise
  // pivot straight into the account. scope: 'global' also kills every
  // other live session for this user across all devices so a leaked
  // legitimate session is forcibly evicted.
  //
  // auth-js returns a failure rather than throwing, so the answer is read.
  // When it is an error, the sessions are ended in the database instead and
  // this browser's auth cookies are expired: an AAL2 recovery session left in
  // the browser would otherwise pass the proxy's local token check for up to
  // an hour, the auto-elevation this block exists to prevent.
  const { error: revokeError } = await supabase.auth.signOut({ scope: 'global' });
  const databaseRevoke = revokeError
    ? await endSessionsAfterFailedGlobalSignOut(revokeError, resetUser.id, {
        tag: 'auth.password_reset_revoke_failed',
        message: 'Password reset could not confirm that every session ended',
      })
    : 'not_needed';
  // Evict live devices NOW, not at access-token expiry (≤1h): the whole
  // point of resetting a password is that existing sessions may be in
  // hostile hands. Same broadcast contract as device management. Not sent
  // twice when the database revoke already did.
  if (databaseRevoke !== 'ok') {
    await broadcastToChannel(`user:${resetUser.id}:sessions`, 'revoked', { keepId: null });
  }

  // Audit the successful recovery-based reset.
  const { organizationId } = await resolveDefaultOrgAndRole(resetUser.id);
  await emitAuthAudit({
    event: 'user.password.reset_completed',
    userId: resetUser.id,
    organizationId,
    extra: {
      email: resetUser.email,
      revoke_error: revokeErrorLabel(revokeError),
      database_revoke: databaseRevoke,
      ...(accountChanged ? { account_changed: true } : {}),
    },
  });
  if (accountChanged) return err('unauthenticated', SESSION_CHANGED, { reason: 'session_changed' });

  // Redirect to /signin. The sign-in form's existing success toast
  // ("Password updated.") still fires from the consumer page.
  return ok({ next: '/signin?reset=success' });
}

/**
 * Change the signed-in user's password. Re-authenticates with the current
 * password before applying the new one.
 *
 * Why we DON'T call signInWithPassword on the SSR client to verify the
 * current password: that rotates the cookie session, and a fresh
 * password-only sign-in is AAL1 even if the user was at AAL2. For
 * MFA-enabled accounts Supabase requires AAL2 on the calling session
 * to update the password, so the subsequent updateUser() fails with
 * "AAL2 session is required to update email or password when MFA is
 * enabled." The fix: verify the current password against an isolated,
 * in-memory-only Supabase client so the user's actual session is left
 * untouched (and stays at AAL2 if they have MFA).
 */
export async function changePasswordAction(
  input: ChangePasswordInput,
): Promise<ActionResult<{ ok: true }>> {
  const parsed = changePasswordSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }

  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !user.email) {
    return err('unauthenticated', 'Sign in required');
  }

  // ACCOUNT STATUS (0308). This action authenticates with a bare
  // auth.getUser(), which makes it a FOURTH identity funnel alongside
  // loadSessionAndContext, withApiContext and resolvePortalContext — none of
  // which run here. Without this check a disabled user with a live cookie could
  // still rotate their own password, which is precisely what an offboarded or
  // compromised account would do to establish a credential the operator does
  // not know before the GoTrue ban propagates.
  //
  // Placed BEFORE the rate-limit call on purpose: the 5-per-15-min budget is
  // keyed on the user, and spending it on a caller who is refused
  // unconditionally would let a disabled session burn the budget and lock the
  // account out of a legitimate password change after it is re-enabled.
  //
  // `unreadable` is kept distinct from `disabled`, the same way the three
  // chokepoints keep them apart: a failed read has authorized nothing and must
  // refuse, but it must not tell a healthy user their account was disabled.
  const accountStatus = await loadAccountStatus(supabase, user.id);
  if (accountStatus === 'unreadable') {
    return err('internal_error', 'Could not verify your account status. Please try again.');
  }
  if (accountStatus === 'disabled') {
    noteDisabledAccountBlocked('request', { userId: user.id, path: 'changePasswordAction' });
    return err('forbidden', ACCOUNT_DISABLED_MESSAGE);
  }

  // 5 attempts / 15 min / user. Closed mode — prevents an authenticated
  // attacker (or stolen-session scenario) from brute-forcing the
  // currentPassword check.
  const rl = await checkRateLimit(`pwchange:${user.id}`, 5, 15 * 60_000, 'closed');
  if (!rl.allowed) {
    return err('rate_limited', 'Too many password-change attempts. Try again in a few minutes.');
  }

  // Side-channel password check — does NOT persist a session anywhere.
  //
  // This used to be an inlined copy of lib/auth/verify-password.ts, which is
  // the SHARED implementation of this dance and whose docstring names
  // change-password as its first intended caller. The copy landed first and
  // the helper was extracted five days later without migrating this site, so
  // four flows (MFA enroll-verify, MFA recovery consume, team, email-change)
  // moved on and this one silently would not have followed any hardening
  // applied there. One implementation, one place to harden.
  const pw = await verifyPasswordSideChannel(user.email, parsed.data.currentPassword);
  if (!pw.ok) {
    // Keep the two failure shapes distinct: a wrong password is the user's to
    // fix, a thrown client is ours. (The inline copy let a thrown client
    // escape the action entirely.)
    if (pw.reason === 'internal_error') {
      return err('internal_error', 'Could not verify your current password. Please try again.');
    }
    return err('forbidden', 'Current password is incorrect');
  }

  // For MFA-enabled accounts, Supabase requires AAL2 on the SSR session
  // to update the password. Surface a clearer error than the generic
  // updateUser() one if the user's session somehow isn't at AAL2.
  const { data: factorsData, error: factorsError } = await supabase.auth.mfa.listFactors();
  // Unreadable is not "not enrolled": refuse rather than skip the AAL2 check.
  if (factorsError) {
    return err('internal_error', 'Could not check your two-factor status. Please try again.');
  }
  const hasVerifiedMfa = (factorsData?.totp ?? []).some(
    (f) => f.status === 'verified',
  );
  if (hasVerifiedMfa) {
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (aal?.currentLevel !== 'aal2') {
      return err(
        'forbidden',
        'Complete the MFA challenge before changing your password. Sign out and sign back in to step up.',
      );
    }
  }

  // The account's sessions, listed BEFORE the password changes, so the ones
  // the change ends can be named to their devices below: once ended they
  // cannot be listed. Never throws; unreadable is null and nothing is named.
  const listedSessions = await listMySessionIds(supabase);

  // The new password is set only for the account whose current password was
  // checked above: the reads since then loaded the cookie session again, and
  // a load can refresh it into another account's (lib/auth/verified-claims).
  // Read once more right before the update (lib/auth/session-account): a
  // session that now verifies as another account is signed out here and
  // refused; one that could not be verified is refused and left alone, and no
  // password is changed.
  const sessionNow = await sessionAccountNow(supabase, user.id);
  if (sessionNow.kind === 'other') {
    await signOutThisSession(supabase);
    return err('unauthenticated', SESSION_CHANGED, { reason: 'session_changed' });
  }
  if (sessionNow.kind === 'unverified') {
    return err(
      'internal_error',
      'Could not confirm your sign-in just now, so your password was not changed. Try again in a moment.',
    );
  }

  const { data: updated, error: updateError } = await supabase.auth.updateUser({
    password: parsed.data.newPassword,
  });
  if (updateError) return err('internal_error', updateError.message);

  // The update's answer names the account the new password was set for. When
  // that is not the account whose current password was checked, the session
  // changed accounts between the read above and the update: every session of
  // that account is ended, its row written, and this press answers with sign
  // in again.
  const updatedId = updated?.user?.id ?? null;
  if (updatedId !== null && updatedId !== user.id) {
    return endSessionsAfterPasswordSetForAnotherAccount(supabase, updatedId, updated?.user?.email ?? null);
  }

  // SECURITY: revoke every OTHER live session for this user (mobile,
  // other browsers, stale tabs) but keep the current tab signed in so
  // the in-app password change doesn't bounce the user to /signin.
  // Best-effort — never block the success response on a signOut error.
  //
  // auth-js RETURNS a failure rather than throwing, so the catch below never
  // saw one; the answer is read, and a returned error is answered below with
  // the database revoke of the other sessions.
  let othersError: SignOutError | null = null;
  try {
    ({ error: othersError } = await supabase.auth.signOut({ scope: 'others' }));
  } catch (e) {
    console.warn('[changePasswordAction] signOut others failed:', e);
  }
  let databaseRevoke: 'not_needed' | 'ok' | 'failed' | 'no_session_id' = 'not_needed';

  // The revoke above only kills REFRESH tokens. Every other live client coasts
  // on its current ACCESS token for up to ~1h: another browser's middleware
  // verifies the JWT locally (getClaims) and its RSC reads / Server Action
  // writes go to PostgREST, which honours the token until `exp`; the mobile app
  // keeps its direct PostgREST calls the same way. So a user who changes their
  // password precisely BECAUSE a device may be compromised believes that device
  // is out when it is not. Both platforms already run a session-revocation
  // listener for this window — the same one signOutAction and
  // completePasswordResetAction drive — it just was never told from here.
  //
  // The broadcast names the sessions that ended (the listed ones other than
  // this tab's), never the one that stays: the channel is public, and a live
  // session id must not go out on it (S5, services/sessions.ts). A
  // `keepId: null` payload means "evict EVERY session" (signOutAction's
  // semantics), so when the current session id can't be derived we SKIP the
  // broadcast rather than send a null we don't mean and bounce the user to
  // /signin mid-flow. The id is the access token's `session_id` claim once
  // its signature checks out (lib/auth/verified-claims), not getSession()'s
  // token decoded unchecked.
  try {
    const current = (await readVerifiedSessionClaims(supabase))?.sessionId ?? null;
    if (othersError) {
      // The other sessions are still alive. revoke_my_other_sessions (0213)
      // ends every session of auth.uid() except the one given, so it is called
      // only with this tab's verified session id: with null, `id is distinct
      // from null` would end this session too.
      databaseRevoke = current ? await revokeMyOtherSessions(supabase, current) : 'no_session_id';
    }
    if (current) {
      await broadcastEndedSessions(user.id, listedSessions, current);
    } else {
      console.warn(
        '[changePasswordAction] could not derive current session id — skipped revocation broadcast',
      );
    }
  } catch (e) {
    // Best-effort, exactly like the signOut above: the password IS changed and
    // refresh tokens ARE revoked; the broadcast only shortens the eviction lag.
    console.warn('[changePasswordAction] revocation broadcast failed:', e);
  }
  if (othersError) {
    // Never GoTrue's message: the name, code and status say what failed.
    void reportError(new Error('Password change could not confirm that the other sessions ended'), {
      tag: 'auth.password_change_revoke_failed',
      level: 'warning',
      extra: {
        name: othersError.name,
        code: othersError.code ?? null,
        status: othersError.status ?? null,
        database_revoke: databaseRevoke,
      },
    });
  }

  await audit({
    event: 'user.password.changed',
    entityType: 'user',
    entityId: user.id,
    extra: { revoke_error: revokeErrorLabel(othersError), database_revoke: databaseRevoke },
  });

  return ok({ ok: true });
}

/**
 * Ends every session of the signed-in account except `keepSessionId`, in the
 * database (revoke_my_other_sessions, 0213; granted to authenticated). Never
 * throws: what happened is the answer.
 */
async function revokeMyOtherSessions(
  supabase: Awaited<ReturnType<typeof createClient>>,
  keepSessionId: string,
): Promise<'ok' | 'failed'> {
  try {
    const { error } = await supabase.rpc('revoke_my_other_sessions', {
      p_keep_session_id: keepSessionId,
    });
    return error ? 'failed' : 'ok';
  } catch {
    return 'failed';
  }
}

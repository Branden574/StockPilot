/**
 * Whether a Supabase auth error means "this user is banned" (our temporary
 * account disable), as opposed to a bad password or a rate limit.
 *
 * ONLY the structured `code` is trusted. A message-string heuristic would be
 * fragile — error copy changes between SDK releases — and message text is not a
 * safe thing to branch authentication behaviour on.
 *
 * ── ACCOUNT ENUMERATION: A KNOWN, MEASURED TRADEOFF ────────────────────────
 * An earlier version of this comment claimed the code-only rule stopped the
 * sign-in form from "confirming that an account exists and is disabled". That
 * was wrong, and the contradiction is worth stating plainly rather than leaving
 * a false reassurance in the file.
 *
 * Returning the disabled copy at all IS an enumeration oracle: an attacker who
 * submits any password for an address and gets "account disabled" instead of
 * "invalid credentials" has learned the account exists. We cannot narrow that
 * to valid credentials only, because GoTrue does not give us the information.
 *
 * MEASURED against the local stack (GoTrue v2.189.0, POST
 * /auth/v1/token?grant_type=password):
 *
 *   active account  + wrong password -> 400 code=invalid_credentials
 *   BANNED account  + CORRECT pw     -> 400 code=user_banned
 *   BANNED account  + WRONG   pw     -> 400 code=user_banned      <-- the point
 *   nonexistent address + any pw     -> 400 code=invalid_credentials
 *
 * GoTrue evaluates the ban BEFORE it verifies the password, so a banned user's
 * response is identical either way. There is no server-side signal to gate the
 * disabled copy on "valid credentials only" — the distinction the brief asks
 * for does not exist in the data we receive.
 *
 * Suppressing the branch here would also not remove the oracle. That endpoint
 * is public and answers to the publishable (anon) key, so anyone can read
 * `user_banned` from GoTrue directly without going through this action. Hiding
 * it in our own copy would cost a locked-out user the one message that tells
 * them not to reset a perfectly good password, and would buy no secrecy.
 *
 * So the product decision stands: valid or not, a disabled account is told it
 * is disabled. If that oracle ever has to close, it closes upstream (a GoTrue
 * setting or a proxy in front of /auth/v1), not by lying in this function.
 *
 * Lives in its own module (not inside `auth.ts`) so it is testable without
 * dragging in the action file's `'use server'` directive, cookies, headers and
 * rate limiter.
 */
export function isBannedUserAuthError(
  error: { code?: unknown; status?: unknown; message?: unknown } | null | undefined,
): boolean {
  return error?.code === 'user_banned';
}

/**
 * How GoTrue refused `updateUser({ password })` on a reset link's session, so
 * completePasswordResetAction can answer in plain words (docket B50). Same rule
 * as above: the structured `code` only, never the message.
 *
 *   insufficient_aal          the account has a verified authenticator and the
 *                             session is not AAL2 (as when the action skipped
 *                             the code step because the factor list could not
 *                             be read)
 *   same_password             the new password is the current one
 *   weak_password             the password rules; with 'pwned' in `reasons`, a
 *                             password found in a known breach
 *   session_not_found,        the link's session is gone: spent, expired, or
 *   session_expired,          ended by a reset finished in another tab
 *   refresh_token_not_found
 *
 * The one exception is the SDK's own session-missing error. auth-js turns
 * GoTrue's session_not_found into AuthSessionMissingError, and raises it itself
 * when there is no session at all, and that error carries no code, so it is
 * matched by `name`: the field auth-js's own isAuthSessionMissingError() reads,
 * set by the SDK and never by text, as the phone does
 * (apps/mobile/src/lib/account-disabled-probe.ts).
 *
 * Anything else is null, and the caller keeps its own answer.
 */
export type PasswordUpdateRefusal =
  | { kind: 'aal' }
  | { kind: 'same' }
  | { kind: 'weak'; breached: boolean }
  | { kind: 'session_gone' };

const SESSION_GONE_CODES: ReadonlySet<unknown> = new Set([
  'session_not_found',
  'session_expired',
  'refresh_token_not_found',
]);

export function classifyPasswordUpdateError(
  error:
    | { code?: unknown; name?: unknown; reasons?: unknown; status?: unknown; message?: unknown }
    | null
    | undefined,
): PasswordUpdateRefusal | null {
  const code = error?.code;
  if (code === 'insufficient_aal') return { kind: 'aal' };
  if (code === 'same_password') return { kind: 'same' };
  if (code === 'weak_password') {
    const reasons = error?.reasons;
    return { kind: 'weak', breached: Array.isArray(reasons) && reasons.includes('pwned') };
  }
  if (SESSION_GONE_CODES.has(code) || error?.name === 'AuthSessionMissingError') {
    return { kind: 'session_gone' };
  }
  return null;
}

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

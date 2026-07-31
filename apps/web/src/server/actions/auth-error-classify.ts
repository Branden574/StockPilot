/**
 * Whether a Supabase auth error means "this user is banned" (our temporary
 * account disable), as opposed to a bad password or a rate limit.
 *
 * ONLY the structured `code` is trusted. A message-string heuristic would be
 * both fragile and dangerous: error copy changes between SDK releases, and any
 * text an attacker can influence must never be able to make the sign-in form
 * confirm that an account exists and is disabled.
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

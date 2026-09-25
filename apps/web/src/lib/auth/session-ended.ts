import { redirect } from 'next/navigation';

/**
 * A request whose SESSION NO LONGER EXISTS, as opposed to one whose data could
 * not be read.
 *
 * THE BUG (found during the S2 walk, 2026-09-24): the middleware verifies the
 * access token LOCALLY (auth.getClaims, no GoTrue round trip), so a session
 * revoked from another device, or ended by "sign out everywhere", still passes
 * it until the token expires (up to an hour). The dashboard layout's first
 * GoTrue call (the MFA factor list read) then fails with AuthSessionMissingError, and
 * the layout rendered its ERROR SCREEN (a 500) instead of sending the person to
 * sign in. Failing closed was right; the page was wrong.
 *
 * A plain redirect('/signin') would LOOP: the stale cookie still passes the
 * middleware, which bounces a signed-in visitor from /signin back to
 * /dashboard. A server component cannot clear cookies, so the redirect goes to
 * a route handler that can (app/auth/session-ended/route.ts): it signs out
 * locally, expires the auth cookies, and only then sends the browser to
 * /signin.
 *
 * Only AuthSessionMissingError maps here (auth-js raises it for a missing
 * stored session and for GoTrue's `session_not_found`). Every other failure is
 * still an unreadable read and still shows the error screen (#229).
 */
export const SESSION_ENDED_PATH = '/auth/session-ended';

export class SessionEndedError extends Error {
  constructor() {
    super('The session for this request no longer exists.');
    this.name = 'SessionEndedError';
  }
}

export function isSessionEndedError(e: unknown): boolean {
  return e instanceof SessionEndedError || (e as { name?: unknown } | null)?.name === 'SessionEndedError';
}

/** Await a request read; an ended session goes to sign-in (through the cookie-clearing route), never to the error screen. */
export async function orSessionEnded<T>(read: Promise<T>): Promise<T> {
  try {
    return await read;
  } catch (e) {
    if (isSessionEndedError(e)) redirect(SESSION_ENDED_PATH);
    throw e;
  }
}

import { classifyAuthProbe, type AuthProbeResult } from './account-disabled-probe';
import { PROBE_TIMEOUT_MS } from './account-eviction';
import { fetchAuthUser, supabase } from './supabase';

/**
 * Has this phone's session really ended? Asked of the Auth server before the
 * phone acts on a "signed out from another device" message
 * (use-session-revocation.ts).
 *
 * THE MESSAGE IS A CLAIM. The channel `user:<id>:sessions` is public (the
 * server posts to it with the public key and `private: false`,
 * apps/web/src/lib/realtime/broadcast.ts), so anyone holding the app's public
 * key and a person's user id, which every fellow member can read, can send
 * `{ keepId: 'x' }` to it. The phone used to act on any message aimed at it:
 * it signed out, and with S5 it also deleted its push token row and cleared
 * Notification Center, before anything had checked the claim. Every real
 * sender ends the sessions BEFORE it sends (apps/web/src/server/services/
 * sessions.ts and the sign-out, password and platform paths), so for a real
 * message the Auth server no longer knows this session. The web listener
 * already asks it (session-revocation-listener.tsx); the phone now asks too.
 *
 * WHY NOT supabase.auth.getUser(). For a session the server has ended, auth-js
 * removes the session from the device while it answers, even when the token is
 * passed in (supabase.ts fetchAuthUser), and the phone needs the session for
 * one more request: deleting its push token row (push-unbind.ts). So the
 * question goes out on its own, and whatever the answer, the session stays
 * where it is.
 */

export type SessionCheck =
  /** The Auth server accepts this phone's session: the message is forged or
   *  stale, and nothing happens. */
  | 'live'
  /** The Auth server says the session is over (ended, expired, or the account
   *  disabled): the message is true. */
  | 'gone'
  /** No answer: offline, timed out, the server failed, or no token to ask
   *  with. Nothing happens; a revoked session still ends when its token can no
   *  longer be refreshed. */
  | 'no-answer';

/**
 * The account gate's own reading of an Auth server answer
 * (account-disabled-probe.ts classifyAuthProbe), so "the session is gone"
 * means one thing on the phone: GoTrue's codes, never its free text.
 */
export function sessionCheckFromProbe(probe: AuthProbeResult): SessionCheck {
  if (probe === 'active') return 'live';
  if (probe === 'signed-out' || probe === 'disabled') return 'gone';
  return 'no-answer';
}

/**
 * The answer to GET /auth/v1/user. Any 2xx: the session is live. Otherwise
 * the error code, from `code` (the 2024-01-01 API version the request asks
 * for) or `error_code` (older servers, whose `code` is the status number).
 */
export function sessionCheckFromAuthAnswer(status: number, body: unknown): SessionCheck {
  if (status >= 200 && status < 300) return 'live';
  const b = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const code =
    typeof b.code === 'string'
      ? b.code
      : typeof b.error_code === 'string'
        ? b.error_code
        : undefined;
  return sessionCheckFromProbe(classifyAuthProbe({ data: null, error: { code, status } }));
}

/**
 * Ask the Auth server about the session on this phone, with its current
 * access token. Never throws, never removes the session, and answers within
 * `timeoutMs` (the request is aborted then).
 *
 * No token to ask with: when auth-js holds no session because the Auth server
 * has just refused to refresh it (auth-js removes the session itself then,
 * GoTrueClient _callRefreshToken), that refusal is the answer; offline, or no
 * session at all, is no answer.
 */
export async function checkThisSession(
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<SessionCheck> {
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<SessionCheck>((resolve) => {
    timer = setTimeout(() => {
      ctrl.abort();
      resolve('no-answer');
    }, timeoutMs);
  });
  // Settles whatever happens, so an answer after the deadline is dropped
  // rather than left rejected.
  const asked = (async (): Promise<SessionCheck> => {
    try {
      const { data, error } = await supabase.auth.getSession();
      const accessToken = data.session?.access_token;
      if (!accessToken) {
        return error
          ? sessionCheckFromProbe(classifyAuthProbe({ data: null, error }))
          : 'no-answer';
      }
      const res = await fetchAuthUser(accessToken, ctrl.signal);
      let body: unknown = null;
      if (!res.ok) {
        try {
          body = await res.json();
        } catch {
          body = null;
        }
      }
      return sessionCheckFromAuthAnswer(res.status, body);
    } catch {
      return 'no-answer';
    }
  })();
  try {
    return await Promise.race([asked, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

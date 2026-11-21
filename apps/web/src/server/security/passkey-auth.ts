import 'server-only';

import { env } from '@/lib/env';

/**
 * The Auth fetch helper of the passkey code (plan 2.1 rules 2 and 16).
 *
 * Every Auth call made AS the member (read the account, enrol, challenge,
 * verify, unenrol, sign out) is a plain `fetch` to Supabase Auth with the
 * member's verified access token in `Authorization`, and the anon key. Never
 * the cookie client and never a stored session: the token is a local variable
 * of the action that read it, handed in here.
 *
 * Each call sets `cache: 'no-store'` and a time limit. An enrol answer carries
 * a secret and a verify request carries a live code: neither is logged, put
 * in an error report or returned to a caller as raw text. A failure is
 * described by Auth's `error_code` (or `code`) and the HTTP status only.
 *
 * Nothing at module level holds a token, a client or a session (rule 1).
 */

/** How long one Auth call may take. */
export const AUTH_CALL_TIMEOUT_MS = 8_000;

export interface AuthAnswer {
  ok: boolean;
  status: number;
  /** Auth's error code (`error_code`, else a string `code`), or null. */
  code: string | null;
  /** The parsed JSON body (only when ok; never logged). */
  body: unknown;
}

const FAILED: AuthAnswer = { ok: false, status: 0, code: 'request_failed', body: null };

/** Auth's own error code of a body, never its message. */
function codeOf(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as { error_code?: unknown; code?: unknown };
  if (typeof b.error_code === 'string' && b.error_code) return b.error_code;
  if (typeof b.code === 'string' && b.code) return b.code;
  return null;
}

/**
 * One Auth call as the holder of `token`. Never throws: a network failure or
 * a time-out is `{ ok: false, code: 'request_failed' }`.
 */
export async function authCall(
  token: string,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: Record<string, unknown>,
): Promise<AuthAnswer> {
  try {
    const res = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1${path}`, {
      method,
      cache: 'no-store',
      signal: AbortSignal.timeout(AUTH_CALL_TIMEOUT_MS),
      headers: {
        apikey: env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
        authorization: `Bearer ${token}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    let parsed: unknown = null;
    try {
      parsed = await res.json();
    } catch {
      parsed = null;
    }
    if (res.ok) return { ok: true, status: res.status, code: null, body: parsed };
    return { ok: false, status: res.status, code: codeOf(parsed) ?? `http_${res.status}`, body: null };
  } catch {
    return FAILED;
  }
}

/** A factor as Auth lists it on the user. */
export interface AuthFactor {
  id: string;
  factor_type: string | null;
  status: string | null;
  friendly_name: string | null;
  created_at: string | null;
}

/** The account the token belongs to, with its factors and email, or null. */
export async function readAccountAs(
  token: string,
): Promise<{ id: string; email: string | null; factors: AuthFactor[] } | null> {
  const answer = await authCall(token, 'GET', '/user');
  if (!answer.ok || !answer.body || typeof answer.body !== 'object') return null;
  const user = answer.body as { id?: unknown; email?: unknown; factors?: unknown };
  if (typeof user.id !== 'string' || !user.id) return null;
  const factors: AuthFactor[] = [];
  for (const f of Array.isArray(user.factors) ? user.factors : []) {
    if (!f || typeof f !== 'object') continue;
    const x = f as Record<string, unknown>;
    if (typeof x.id !== 'string') continue;
    factors.push({
      id: x.id,
      factor_type: typeof x.factor_type === 'string' ? x.factor_type : null,
      status: typeof x.status === 'string' ? x.status : null,
      friendly_name: typeof x.friendly_name === 'string' ? x.friendly_name : null,
      created_at: typeof x.created_at === 'string' ? x.created_at : null,
    });
  }
  return {
    id: user.id,
    email: typeof user.email === 'string' && user.email ? user.email : null,
    factors,
  };
}

/** A new TOTP factor: its id and secret (kept by the caller in a local only). */
export async function enrolTotpAs(
  token: string,
  friendlyName: string,
): Promise<
  { ok: true; factorId: string; secret: string } | { ok: false; code: string; factorId?: string }
> {
  const answer = await authCall(token, 'POST', '/factors', {
    factor_type: 'totp',
    friendly_name: friendlyName,
  });
  if (!answer.ok) return { ok: false, code: answer.code ?? 'unknown' };
  const b = answer.body as { id?: unknown; totp?: { secret?: unknown } } | null;
  const factorId = typeof b?.id === 'string' ? b.id : null;
  const secret = typeof b?.totp?.secret === 'string' ? b.totp.secret : null;
  // An answer with an id but no secret made a factor all the same: its id is
  // given back so the caller deletes it (review 4 finding 8).
  if (!factorId || !secret)
    return { ok: false, code: 'enrol_answer_shape', ...(factorId ? { factorId } : {}) };
  return { ok: true, factorId, secret };
}

/** The tokens of a raised session (never logged). */
export interface RaisedSession {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  expires_at: number | null;
  token_type: string;
}

/** Challenge a factor, then verify `code` on it, in this one invocation. */
export async function challengeAndVerifyAs(
  token: string,
  factorId: string,
  code: string,
): Promise<{ ok: true; session: RaisedSession } | { ok: false; step: 'challenge' | 'verify'; code: string }> {
  const challenge = await authCall(token, 'POST', `/factors/${encodeURIComponent(factorId)}/challenge`, {});
  const challengeId =
    challenge.ok && challenge.body && typeof (challenge.body as { id?: unknown }).id === 'string'
      ? ((challenge.body as { id: string }).id as string)
      : null;
  if (!challengeId) {
    return { ok: false, step: 'challenge', code: challenge.ok ? 'challenge_answer_shape' : (challenge.code ?? 'unknown') };
  }
  const verify = await authCall(token, 'POST', `/factors/${encodeURIComponent(factorId)}/verify`, {
    challenge_id: challengeId,
    code,
  });
  if (!verify.ok) return { ok: false, step: 'verify', code: verify.code ?? 'unknown' };
  const b = verify.body as Record<string, unknown> | null;
  if (
    !b ||
    typeof b.access_token !== 'string' ||
    typeof b.refresh_token !== 'string' ||
    typeof b.expires_in !== 'number'
  ) {
    return { ok: false, step: 'verify', code: 'verify_answer_shape' };
  }
  return {
    ok: true,
    session: {
      access_token: b.access_token,
      refresh_token: b.refresh_token,
      expires_in: b.expires_in,
      expires_at: typeof b.expires_at === 'number' ? b.expires_at : null,
      token_type: typeof b.token_type === 'string' ? b.token_type : 'bearer',
    },
  };
}

/** Remove one of the token holder's factors (Auth asks aal2 for a verified one). */
export async function unenrolAs(token: string, factorId: string): Promise<AuthAnswer> {
  return authCall(token, 'DELETE', `/factors/${encodeURIComponent(factorId)}`);
}

/** Sign out: `local` ends this token's session, `others` every other one. */
export async function signOutAs(token: string, scope: 'local' | 'others'): Promise<AuthAnswer> {
  return authCall(token, 'POST', `/logout?scope=${scope}`);
}

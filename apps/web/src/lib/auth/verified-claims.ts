import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import { cache } from 'react';

import { createClient } from '@/lib/supabase/server';

/**
 * What the server may read from this request's cookie session: the claims of
 * its access token, AFTER the token's signature is checked.
 *
 * WHY NOT getSession() OR auth.mfa.getAuthenticatorAssuranceLevel(). On the
 * server both hand back whatever the auth cookie holds. getAuthenticator-
 * AssuranceLevel() with no argument loads the stored session, decodes the
 * access token without checking its signature, and reads `session.user` (the
 * user object the cookie carries, which nothing signs) for `nextLevel`.
 * auth-js wraps that stored user on a server client and logs "Using the user
 * object as returned from supabase.auth.getSession() ... could be insecure!"
 * every time one of its fields is read before getUser() has run on the same
 * client. That is the warning production logged on the dashboard pages and
 * actions of members with an authenticator: the dashboard layout's AAL2 gate
 * and resolveMfaState in withContext() each called it on a fresh client.
 *
 * HOW. The session is loaded once, for its access token only (never
 * `session.user`). Loading it refreshes a token within 90 s of expiry, exactly
 * as getAuthenticatorAssuranceLevel() did, and a session that cannot be loaded
 * or refreshed is no session. auth.getClaims(token) is the library's verified
 * read. With the project's asymmetric signing key (ES256 in production) it
 * checks the signature locally against the JWKS, which auth-js keeps in a
 * module-global cache shared by every client in the server instance for 10
 * minutes: no Auth round trip on the warm path, the same cost as the
 * unverified decode it replaces. It also refuses an expired token. When it
 * cannot answer locally (no key id, a symmetric algorithm, a key id the key
 * set does not list) it asks the Auth server itself.
 *
 * A verdict on the token is final: getClaims() refused it (bad signature,
 * expired, malformed), or the Auth server it asked refused it (401 or 403,
 * or session_not_found for a signed-out or revoked session).
 * Only when getClaims() could not check the token at all (the key set could
 * not be fetched, a key would not import) is the Auth server asked here:
 * getUser(token) on the same token, the fallback the proxy and session.ts take
 * for identity. Only a token GoTrue accepts is decoded, which is the rule the
 * bearer path already follows (aalFromJwt in api-context.ts reads `aal` only
 * after getUser(bearer)). That costs one round trip, and only when the local
 * check could not run.
 *
 * Never throws. No session, an expired or forged token, or anything this
 * cannot verify is null, and every caller treats null as "not verified":
 * not AAL2, no current session id.
 */
export interface VerifiedSessionClaims {
  /** The signed-in user: the token's subject. */
  userId: string;
  /** The `auth.sessions` row this token belongs to, or null when it has none. */
  sessionId: string | null;
  /** The session's assurance level; 'aal2' only after an MFA challenge. */
  aal: 'aal1' | 'aal2' | null;
  /** Authentication method references: which methods, and when (seconds). */
  amr: unknown;
}

/** The slice of a Supabase client this reads. */
type AuthReader = Pick<SupabaseClient, 'auth'>;

function toVerifiedClaims(claims: Record<string, unknown>): VerifiedSessionClaims | null {
  const sub = claims.sub;
  if (typeof sub !== 'string' || sub.length === 0) return null;
  return {
    userId: sub,
    sessionId:
      typeof claims.session_id === 'string' && claims.session_id.length > 0
        ? claims.session_id
        : null,
    aal: claims.aal === 'aal2' ? 'aal2' : claims.aal === 'aal1' ? 'aal1' : null,
    amr: claims.amr,
  };
}

/** The payload of a JWT, decoded only; the caller has the token verified. */
function decodePayload(token: string): Record<string, unknown> | null {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const payload: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Whether getClaims() reached a verdict on the token itself, so that asking
 * the Auth server again would only repeat it: the signature, expiry or shape
 * failed (AuthInvalidJwtError), or the Auth server that getClaims() asked
 * refused the token (401 or 403).
 *
 * GoTrue refuses a token of a session it no longer has (signed out, revoked
 * from another device) with 403 session_not_found, and auth-js raises that as
 * AuthSessionMissingError (status 400), not as an AuthApiError(403). The
 * token is always passed in explicitly here, so getClaims() never loads a
 * session and that error can only be GoTrue's answer about this token.
 */
function isVerdictOnToken(error: { name?: string; status?: number }): boolean {
  if (error.name === 'AuthInvalidJwtError') return true;
  if (error.name === 'AuthSessionMissingError') return true;
  return error.name === 'AuthApiError' && (error.status === 401 || error.status === 403);
}

export async function readVerifiedSessionClaims(
  supabase: AuthReader,
): Promise<VerifiedSessionClaims | null> {
  // The access token only: never `session.user`, the stored object auth-js
  // warns about.
  let token: string | undefined;
  try {
    const { data } = await supabase.auth.getSession();
    token = data.session?.access_token;
  } catch {
    return null;
  }
  if (!token) return null;

  try {
    const { data, error } = await supabase.auth.getClaims(token);
    // No error: the claims of a token whose signature checked out.
    if (!error) return data?.claims ? toVerifiedClaims(data.claims) : null;
    if (isVerdictOnToken(error)) return null;
  } catch {
    // getClaims() rethrows errors that are not Auth errors (a key that will
    // not import, no WebCrypto). The Auth server answers below.
  }
  try {
    const { data: answer, error } = await supabase.auth.getUser(token);
    if (error || !answer.user) return null;
    const payload = decodePayload(token);
    // GoTrue's answer is about this token's subject; anything else is not it.
    if (!payload || payload.sub !== answer.user.id) return null;
    return toVerifiedClaims(payload);
  } catch {
    return null;
  }
}

/**
 * This request's verified session claims (readVerifiedSessionClaims on the
 * cookie session), read ONCE per page render and shared through React
 * cache().
 *
 * WHY ONE READ, STARTED EARLY. Page renders run in their own server function,
 * apart from the proxy, so they keep their own key set: auth-js caches it per
 * server instance for 10 minutes, and the first read in an instance (or after
 * that cache expires) fetches it from the Auth server, a Supabase round trip.
 * The dashboard layout starts this read first thing, beside the factor list,
 * so that fetch runs alongside the layout's batch of reads instead of after
 * it. The page's withContext() and the Security page take the same read
 * instead of starting their own: auth-js does not share a key-set fetch that
 * is already in flight, so a second read on a cold cache would fetch again.
 *
 * Inside a Server Action or a Route Handler cache() does not memoize, so each
 * call reads again (a local check once the key set is cached).
 *
 * Never rejects: the layout awaits it only at its enrolled-member gate, and a
 * client that cannot be made is as unverified as a forged token (null).
 */
export const getVerifiedSessionClaimsForRequest = cache(
  async (): Promise<VerifiedSessionClaims | null> => {
    try {
      return await readVerifiedSessionClaims(await createClient());
    } catch {
      return null;
    }
  },
);

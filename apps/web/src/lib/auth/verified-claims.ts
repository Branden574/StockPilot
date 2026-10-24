import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

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
 * client. That is the warning production logged on every page and action of a
 * member with an authenticator: the dashboard layout's AAL2 gate and
 * resolveMfaState in withContext() each called it on a fresh client.
 *
 * HOW. auth.getClaims() is the library's verified read. With the project's
 * asymmetric signing key (ES256 in production) it checks the signature
 * locally against the JWKS, which auth-js keeps in a module-global cache
 * shared by every client in the server instance for 10 minutes: no Auth round
 * trip on the warm path, the same cost as the unverified decode it replaces.
 * It also refuses an expired token. When it cannot answer locally (a
 * symmetric key, no WebCrypto, a key id it does not know) it asks the Auth
 * server itself.
 *
 * When getClaims() fails without a verdict on the token (the JWKS could not be
 * fetched, a key would not import), the Auth server is asked instead, the same
 * fallback the proxy and session.ts take for identity: getUser(token) on the
 * session's own access token. Only a token GoTrue accepts is decoded, which is
 * the rule the bearer path already follows (aalFromJwt in api-context.ts reads
 * `aal` only after getUser(bearer)). That costs one round trip, and only when
 * the local check could not run. A token getClaims() refused (bad signature,
 * expired, malformed) is refused here without asking again.
 *
 * Loading the session still refreshes an access token within 90 s of expiry,
 * exactly as getAuthenticatorAssuranceLevel() did: both load it through
 * getSession() first.
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

export async function readVerifiedSessionClaims(
  supabase: AuthReader,
): Promise<VerifiedSessionClaims | null> {
  try {
    const { data, error } = await supabase.auth.getClaims();
    // No error is a verdict either way: verified claims, or no session at all.
    if (!error) return data?.claims ? toVerifiedClaims(data.claims) : null;
    // So is AuthInvalidJwtError: the token itself failed (its signature, its
    // expiry, its shape). Asking the Auth server about it would only repeat that.
    if (error.name === 'AuthInvalidJwtError') return null;
  } catch {
    // getClaims() rethrows errors that are not Auth errors (a key that will
    // not import, no WebCrypto). The Auth server answers below.
  }
  try {
    // The access token only: never `session.user`, the stored object auth-js
    // warns about. getClaims() takes the token the same way.
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) return null;
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

import { readVerifiedTokenClaims } from './verified-claims';

/**
 * The id of the session a sign-in just made, read from that session's own
 * access token, verified (lib/auth/verified-claims.ts). A sign-in alert keeps
 * it so Active sessions can show the alert on its session (part 3).
 *
 * Null when there is no token, when the token does not check out, or when it
 * names another account than the one that signed in. Callers run it after the
 * response, so it adds nothing to the sign-in. Never throws.
 */
export async function newSessionIdOf(
  supabase: Parameters<typeof readVerifiedTokenClaims>[0],
  accessToken: string | null | undefined,
  userId: string,
): Promise<string | null> {
  if (!accessToken) return null;
  try {
    const claims = await readVerifiedTokenClaims(supabase, accessToken);
    return claims && claims.userId === userId ? claims.sessionId : null;
  } catch {
    return null;
  }
}

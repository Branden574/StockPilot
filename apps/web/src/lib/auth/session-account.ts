import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { readVerifiedSessionClaims, type VerifiedSessionClaims } from '@/lib/auth/verified-claims';

/**
 * Which account the cookie session verifies as NOW, against the account an
 * action checked (`userId`): the same one, another one, or none that could be
 * verified. A read of the cookie session loads it again, and a load can
 * refresh it into another account's (lib/auth/verified-claims,
 * readVerifiedSessionClaimsOf), so an action that checked one account reads
 * this before, and after, the auth server acts for it.
 *
 * The three answers call for different steps, which is why this is not
 * readVerifiedSessionClaimsOf (null there is both "another account" and "could
 * not verify"):
 *   - 'same': go on;
 *   - 'other': a verified session of another account. The caller signs this
 *     session out here and refuses;
 *   - 'unverified': no session could be verified just now (no session, an
 *     expired or forged token, or no key set and no answer from the auth
 *     server). The caller refuses with could-not-check words and leaves the
 *     session alone: a person whose read failed once stays signed in and can
 *     press again.
 *
 * Never throws.
 */
export type SessionAccountNow =
  | { kind: 'same'; claims: VerifiedSessionClaims }
  | { kind: 'other' }
  | { kind: 'unverified' };

export async function sessionAccountNow(
  supabase: Pick<SupabaseClient, 'auth'>,
  userId: string,
): Promise<SessionAccountNow> {
  const claims = await readVerifiedSessionClaims(supabase);
  if (!claims) return { kind: 'unverified' };
  if (claims.userId === userId) return { kind: 'same', claims };
  // Never the ids: one fixed line, which the runtime logs can count.
  console.warn(
    '[session-account] the session now holds another account than the one this request validated',
  );
  return { kind: 'other' };
}

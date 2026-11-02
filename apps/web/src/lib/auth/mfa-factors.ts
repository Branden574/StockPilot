import 'server-only';

import { isAuthSessionMissingError, type SupabaseClient } from '@supabase/supabase-js';

import { SessionEndedError } from '@/lib/auth/session-ended';

export interface MfaFactor {
  status: string;
}

/** A factor list, and the account it is the list of. */
export interface MfaFactorList {
  /** The account GoTrue answered for: the factors are this account's. */
  userId: string;
  factors: MfaFactor[];
}

/**
 * The MFA factors of the account `supabase`'s session holds, with that
 * account's id. THROWS when they cannot be read.
 *
 * `auth.getUser()` is the GoTrue round trip `listFactors()` makes inside (it
 * lists `user.factors`), so this costs the same, and it also says WHOSE list it
 * is. That matters (S43a, review round s43ar): the read loads the cookie
 * session, and a load refreshes it with the cookie's own refresh token when
 * the cookie's own `expires_at` says so; nothing signs either field. A cookie
 * can pair an enrolled member's password-only (aal1) token with the refresh
 * token of an account with NO factor, so a list read after the request's
 * identity read can be that other account's: empty, which would read as "this
 * member has no authenticator". A caller that decides anything on the list
 * takes it through factorsOf() with the user the request validated.
 *
 * auth-js RESOLVES a failure as `{ data: { user: null }, error }` rather than
 * throwing. Read as "no verified factor", that let an enrolled user past the
 * dashboard layout's AAL2 gate and resolveMfaState's enrollment escalation
 * (HI-6), under an 'optional' policy, for as long as GoTrue was failing. An
 * unreadable authorization input must deny, so this throws, and a session
 * that no longer exists (revoked elsewhere, signed out everywhere) throws
 * SessionEndedError, which callers send to sign-in (lib/auth/session-ended).
 */
export async function readMfaFactorList(
  supabase: Pick<SupabaseClient, 'auth'>,
): Promise<MfaFactorList> {
  const { data, error } = await supabase.auth.getUser();
  if (error) {
    if (isAuthSessionMissingError(error)) throw new SessionEndedError();
    throw new Error(`getMfaFactorsForRequest: ${error.name || 'unreadable'}`);
  }
  const user = data.user;
  if (!user?.id) throw new Error('getMfaFactorsForRequest: unreadable');
  return { userId: user.id, factors: (user.factors ?? []) as MfaFactor[] };
}

/**
 * `list`'s factors when it is the list of `userId`, the member this request
 * validated (the context's user); null when it is another account's. A list of
 * another account says nothing about this member, least of all that they have
 * no authenticator, so every caller treats null as no answer and fails closed:
 * the dashboard layout sends the member to the MFA challenge, resolveMfaState
 * holds them at its gate, the ownership transfer refuses.
 */
export function factorsOf(list: MfaFactorList, userId: string): MfaFactor[] | null {
  if (list.userId === userId) return list.factors;
  // Never the ids: a fixed line, so a cookie built to swap accounts shows in
  // the runtime logs.
  console.warn(
    '[mfa-factors] the factor list is of another account than the one this request validated',
  );
  return null;
}

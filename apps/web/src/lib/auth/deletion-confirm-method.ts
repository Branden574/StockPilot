import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { factorsOf, readMfaFactorList } from '@/lib/auth/mfa-factors';

/**
 * What the Delete account dialog shows first for the account `userId`
 * (components/settings/delete-account-button): 'authenticator' for an account
 * with a verified authenticator, whose session entered its code to open the
 * page; 'password' otherwise. Only what to show: the server's own rule decides
 * (server/lib/account-deletion-credential), and the dialog shows the password
 * and code fields whenever the server asks for them. A list that cannot be
 * read, or is another account's, answers 'password'. Never throws.
 */
export async function deletionConfirmMethod(
  supabase: Pick<SupabaseClient, 'auth'>,
  userId: string,
): Promise<'password' | 'authenticator'> {
  try {
    const factors = factorsOf(await readMfaFactorList(supabase), userId);
    return factors?.some((f) => f.status === 'verified') ? 'authenticator' : 'password';
  } catch {
    return 'password';
  }
}

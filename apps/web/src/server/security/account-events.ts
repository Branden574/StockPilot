import 'server-only';

import { createAdminClient } from '@/lib/supabase/admin';
import { resolveDefaultOrgAndRole } from '@/server/services/auth-audit';
import { defer } from '@/server/services/lib/defer';

import { recordSecurityEvent, type SecurityEventHeaders } from './events';

/**
 * The password-guessing detectors of the web's sign-in, authenticator code
 * and recovery code checks (part 1 of the security tools). Each records a
 * password_guessing / blocked event in the organization of the account it is
 * about, so that organization's admins see it on Blocked activity.
 *
 * THE ORGANIZATION IS LOOKED UP AFTER THE RESPONSE (defer), never before the
 * caller answers: a sign-in refusal must take the same time for an email that
 * is an account and one that is not, or the answer's timing would tell which
 * emails have accounts. The request's headers are captured by the caller
 * before the response and passed in, for the place and the source hash.
 *
 * Server code only: `import 'server-only'` and never 'use server'
 * (server/security/events.guard.test.ts).
 */

/** The sign-in refusals that are recorded. */
export type SignInBlockedReason = 'sign_in_paused' | 'wrong_password' | 'auth_server_paused';

/** The code refusals that are recorded, for an account already past its password. */
export type AccountCodeBlockedReason = 'wrong_code' | 'code_checks_paused' | 'wrong_recovery_code';

/**
 * The organization of the account a typed sign-in email belongs to, or null.
 *
 * user_profiles.email is the verified projection of the account's auth email
 * (0345: only the auth identity's own address can be written there), a citext
 * column, so an exact match on the lower-cased address finds the account
 * whatever case was typed; never a pattern match on what was typed. Only an
 * account that is not deleted, and only when exactly one row answers. Then
 * the same organization every auth audit row is filed under
 * (resolveDefaultOrgAndRole: the default organization when it is an accepted
 * membership, else the oldest). Never throws: a read that fails is no
 * organization.
 */
export async function organizationForSignInEmail(email: string): Promise<string | null> {
  const address = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!address) return null;
  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from('user_profiles')
      .select('id')
      .eq('email', address)
      .is('deleted_at', null)
      .limit(2);
    if (error || !Array.isArray(data) || data.length !== 1) return null;
    const id = (data[0] as { id?: unknown }).id;
    if (typeof id !== 'string') return null;
    return (await resolveDefaultOrgAndRole(id)).organizationId;
  } catch {
    return null;
  }
}

/**
 * A refused web sign-in: the limiter paused it, the credentials were wrong,
 * or the Auth server's own limit answered. The organization comes from the
 * typed email, after the response. Returns at once.
 */
export function recordSignInBlocked(
  reason: SignInBlockedReason,
  email: string,
  headers: SecurityEventHeaders | null,
): void {
  defer(async () => {
    const organizationId = await organizationForSignInEmail(email);
    await recordSecurityEvent(
      { category: 'password_guessing', outcome: 'blocked', reason, source: 'web', organizationId },
      headers,
    );
  });
}

/**
 * A refused authenticator or recovery code of a signed-in account (past its
 * password). The organization is the account's (resolveDefaultOrgAndRole),
 * after the response. Returns at once.
 */
export function recordAccountCodeBlocked(
  reason: AccountCodeBlockedReason,
  userId: string,
  headers: SecurityEventHeaders | null,
): void {
  defer(async () => {
    const { organizationId } = await resolveDefaultOrgAndRole(userId);
    await recordSecurityEvent(
      { category: 'password_guessing', outcome: 'blocked', reason, source: 'web', organizationId },
      headers,
    );
  });
}

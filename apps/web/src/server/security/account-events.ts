import 'server-only';

import { createHash } from 'node:crypto';

import { createAdminClient } from '@/lib/supabase/admin';
import { resolveDefaultOrgAndRole } from '@/server/services/auth-audit';
import { defer } from '@/server/services/lib/defer';

import { recordSecurityEvent, type SecurityEventHeaders } from './events';

/**
 * The password-guessing detectors of the web's sign-in, authenticator code,
 * recovery code, set-up code and current-password checks (part 1 of the
 * security tools). Each records a
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

/**
 * The sign-in refusals that are recorded. `sign_in_refused_other` is a
 * password sign-in the sign-in service refused with the status of a wrong
 * password for a reason that is not one (a disabled account, an unconfirmed
 * email): recorded with NO organization (recordSignInBlocked).
 */
export type SignInBlockedReason =
  | 'sign_in_paused'
  | 'wrong_password'
  | 'auth_server_paused'
  | 'sign_in_refused_other';

/**
 * The refusals that are recorded for an account already signed in: a code,
 * a recovery code, the first code of an authenticator being set up
 * (`wrong_setup_code`), and the current password asked again before a
 * sensitive change (`wrong_current_password`).
 */
export type AccountCodeBlockedReason =
  | 'wrong_code'
  | 'code_checks_paused'
  | 'wrong_recovery_code'
  | 'recovery_code_checks_paused'
  | 'wrong_setup_code'
  | 'wrong_current_password';

/** How long the organization found for an email is remembered. */
export const SIGN_IN_ORGANIZATION_MEMORY_MS = 60_000;
/** How many emails are remembered at once; the oldest is dropped first. */
export const SIGN_IN_ORGANIZATION_MEMORY_MAX = 500;

/**
 * The last lookups of this server instance: a SHA-256 of the lower-cased
 * email (never the email itself) -> when it was looked up, and the lookup
 * (still running, or answered: an organization id, or null for none). A Map
 * keeps insertion order, so its first key is the oldest.
 */
let signInOrganizationMemory = new Map<string, { at: number; lookup: Promise<string | null> }>();

/** The organization of a live account with this address: read now, never remembered here. */
async function lookUpOrganization(address: string): Promise<{ organizationId: string | null; answered: boolean }> {
  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from('user_profiles')
      .select('id')
      .eq('email', address)
      .is('deleted_at', null)
      .limit(2);
    if (error || !Array.isArray(data)) return { organizationId: null, answered: false };
    if (data.length !== 1) return { organizationId: null, answered: true };
    const id = (data[0] as { id?: unknown }).id;
    if (typeof id !== 'string') return { organizationId: null, answered: true };
    return { organizationId: (await resolveDefaultOrgAndRole(id)).organizationId, answered: true };
  } catch {
    return { organizationId: null, answered: false };
  }
}

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
 *
 * REMEMBERED FOR A MINUTE. A host that keeps posting sign-ins for one email
 * after it is paused would otherwise cost one to three service-role reads per
 * refused request. The answer for an email (an organization, or none) is kept
 * in this instance's memory for SIGN_IN_ORGANIZATION_MEMORY_MS, and refusals
 * that arrive together share the one lookup. At most
 * SIGN_IN_ORGANIZATION_MEMORY_MAX emails, the oldest dropped first. A
 * profile read that failed is not remembered. (A membership read that fails
 * inside resolveDefaultOrgAndRole answers "no organization" like any account
 * without one, and that answer is remembered for the minute.) The memory is
 * read only here, and this
 * function runs only after the response (the callers below), so what it
 * holds can change no answer's timing. For up to a minute an event can be
 * filed under the organization an account has just left.
 */
export async function organizationForSignInEmail(email: string): Promise<string | null> {
  const address = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!address) return null;
  let key: string;
  try {
    key = createHash('sha256').update(address).digest('hex');
  } catch {
    return (await lookUpOrganization(address)).organizationId;
  }
  const now = Date.now();
  const remembered = signInOrganizationMemory.get(key);
  if (remembered) {
    const age = now - remembered.at;
    if (age >= 0 && age < SIGN_IN_ORGANIZATION_MEMORY_MS) return remembered.lookup;
    signInOrganizationMemory.delete(key);
  }
  const entry = {
    at: now,
    lookup: lookUpOrganization(address).then(({ organizationId, answered }) => {
      // A read that failed is forgotten, so the next refusal reads again.
      if (!answered && signInOrganizationMemory.get(key) === entry) {
        signInOrganizationMemory.delete(key);
      }
      return organizationId;
    }),
  };
  signInOrganizationMemory.set(key, entry);
  while (signInOrganizationMemory.size > SIGN_IN_ORGANIZATION_MEMORY_MAX) {
    const oldest = signInOrganizationMemory.keys().next().value;
    if (oldest === undefined) break;
    signInOrganizationMemory.delete(oldest);
  }
  return entry.lookup;
}

/** Test only: nothing remembered. */
export function __resetSignInOrganizationCacheForTests(): void {
  signInOrganizationMemory = new Map();
}

/** Test only: the keys held, oldest first. */
export function __signInOrganizationCacheKeysForTests(): string[] {
  return [...signInOrganizationMemory.keys()];
}

/**
 * A refused web sign-in: the limiter paused it, the credentials were wrong,
 * the Auth server's own limit answered, or it refused for another reason.
 * The organization comes from the typed email, after the response. Returns
 * at once.
 *
 * `sign_in_refused_other` IS RECORDED WITH NO ORGANIZATION, and the email is
 * not looked up at all: an organization's admins do not learn from this page
 * that, for instance, the platform disabled one of its accounts. The event
 * exists so that every password our server sends and the sign-in service
 * refuses has a record (server/security/auth-logs.ts compares the counts).
 */
export function recordSignInBlocked(
  reason: SignInBlockedReason,
  email: string,
  headers: SecurityEventHeaders | null,
): void {
  defer(async () => {
    const organizationId =
      reason === 'sign_in_refused_other' ? null : await organizationForSignInEmail(email);
    await recordSecurityEvent(
      { category: 'password_guessing', outcome: 'blocked', reason, source: 'web', organizationId },
      headers,
    );
  });
}

/**
 * A refused authenticator or recovery code, a refused first code of an
 * authenticator being set up, or a refused current password, of a signed-in
 * account. The organization is the account's (resolveDefaultOrgAndRole),
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

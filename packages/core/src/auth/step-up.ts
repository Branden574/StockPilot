/**
 * Does this session still owe its authenticator code?
 *
 * The one copy of the rule (docket S43a). The web's API context refuses such a
 * session before it reads anything (apps/web/src/lib/auth/api-context.ts), and
 * the phone's code gate and its push registration check read the same rule.
 *
 * Owed when the account has a VERIFIED factor of any type and the session is
 * not at aal2. A level that is missing or unreadable counts as not aal2 (fail
 * closed). An account with no verified factor never owes it here: whether an
 * organization's policy requires one is a different question, answered where
 * the policy is read.
 *
 * PURE: no platform imports, so the server and the Expo app share it. The
 * factors are GoTrue's (the user `getUser()` returns, or the copy a stored
 * session carries); only `status` is read.
 */
export function stepUpOwed(
  factors: ReadonlyArray<{ readonly status?: string | null } | null | undefined> | null | undefined,
  aal: string | null | undefined,
): boolean {
  const enrolled = (factors ?? []).some((factor) => factor?.status === 'verified');
  return enrolled && aal !== 'aal2';
}

/** An organization's authenticator policy (organizations.mfa_policy). */
export type OrganizationMfaPolicy = 'optional' | 'admins_required' | 'all_required';

/** What an organization whose row could not be read is held to: the strictest policy. */
export const UNREADABLE_ORG_MFA_POLICY: OrganizationMfaPolicy = 'all_required';

/**
 * The authenticator policy to ENFORCE, given an organization row as it was
 * read.
 *
 * `organizations.mfa_policy` is NOT NULL with a CHECK on the three values
 * (default 'admins_required'). So a missing or unrecognised value is never the
 * organization's real policy: it means the row could not be read. Row level
 * security hides it (`organizations_select` requires an accepted membership,
 * an account that is not disabled, and no expired impersonation grant), or it
 * went away mid-request. Unknown is held to the strictest policy an
 * organization can have: a session at aal2 still passes, any other is stopped.
 * Every accepted, enabled member can read their own organization's row, so
 * for them this never fires.
 *
 * Read errors are not handled here: a caller that gets an error back throws
 * or denies on its own. This is for the row that came back empty or odd.
 *
 * A row read through an embed (`organizations:organization_id (...)`) can come
 * back as an object or as an array; pass it through unwrapOrganizationEmbed
 * first, because an array has no `mfa_policy` of its own.
 */
export function enforcedMfaPolicy(
  org: { mfa_policy?: unknown } | null | undefined,
): OrganizationMfaPolicy {
  const policy = org?.mfa_policy;
  return policy === 'optional' || policy === 'admins_required' || policy === 'all_required'
    ? policy
    : UNREADABLE_ORG_MFA_POLICY;
}

/**
 * The organization row of a membership read with an embed
 * (`organizations:organization_id (...)`). PostgREST answers a to-one embed
 * as an object, and some client typings and older answers as an array of
 * one. Answers the object, the first element of an array, or null for
 * anything else (no row, an empty array, a value that is not an object).
 */
export function unwrapOrganizationEmbed<T extends object>(
  field: T | readonly T[] | null | undefined,
): T | null {
  const one: unknown = Array.isArray(field) ? (field as readonly unknown[])[0] : field;
  return one !== null && typeof one === 'object' && !Array.isArray(one) ? (one as T) : null;
}

/**
 * Does the organization's policy require an authenticator of a member in this
 * role? Everyone under 'all_required'; owners and admins under
 * 'admins_required'; no one under 'optional'.
 *
 * The caller passes the policy it ENFORCES: a row that could not be read is
 * held to 'all_required' before it gets here (enforcedMfaPolicy above).
 */
export function policyRequiresAuthenticator(policy: OrganizationMfaPolicy, role: string): boolean {
  if (policy === 'all_required') return true;
  return policy === 'admins_required' && (role === 'owner' || role === 'admin');
}

/**
 * Does this member owe authenticator SET-UP before anything else? True when
 * the policy requires an authenticator of their role and their own factor list
 * has no verified factor (an unverified one does not count). The sibling of
 * stepUpOwed above: that one is for an account that has an authenticator and
 * has not entered its code; this one is for an account that has none.
 *
 * Only `status` is read. A missing list has no verified factor.
 */
export function authenticatorSetUpOwed(
  policy: OrganizationMfaPolicy,
  role: string,
  factors: ReadonlyArray<{ readonly status?: string | null } | null | undefined> | null | undefined,
): boolean {
  if (!policyRequiresAuthenticator(policy, role)) return false;
  return !(factors ?? []).some((factor) => factor?.status === 'verified');
}

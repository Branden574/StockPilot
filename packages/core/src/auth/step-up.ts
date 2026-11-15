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

/**
 * Does the organization's policy require an authenticator of a member in this
 * role? Everyone under 'all_required'; owners and admins under
 * 'admins_required'; no one under 'optional'.
 *
 * The caller passes the policy it ENFORCES: on the web, a row that could not
 * be read is held to 'all_required' before it gets here
 * (apps/web/src/lib/auth/mfa-policy.ts).
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

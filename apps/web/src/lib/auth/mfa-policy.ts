/**
 * The MFA policy to ENFORCE, given an organization row as it was read.
 *
 * WHY THIS EXISTS. `organizations.mfa_policy` is NOT NULL with a CHECK on the
 * three values below (0009; default 'admins_required' since 0167). So a
 * missing or unrecognised value is never the organization's real policy. It
 * means the row could not be read. Row level security hides it
 * (`organizations_select` requires `is_org_member`: an accepted membership, an
 * account that is not disabled, and no expired impersonation grant), or it
 * went away mid-request.
 *
 * Until 2026-09-22 every reader turned that into `?? 'optional'`: the service
 * gate, the API gate, the dashboard's hard redirect and the "disable MFA"
 * check. A session whose organization row it could not see was therefore held
 * to NO policy, which is exactly backwards. The sessions that hit this are the
 * ones whose membership no longer holds.
 *
 * Unknown means the strictest policy an organization can have. A session
 * already at AAL2 still passes. An AAL1 session is stopped at the MFA gate. No
 * legitimate member is affected: row level security lets every accepted,
 * enabled member read their own organization's row, so for them this never
 * fires.
 *
 * READ ERRORS are not handled here. A caller that gets `error` back must throw
 * or deny on its own (see resolveApiMfaState and getOrgRowForRequest); this is
 * for the row that came back empty.
 */

export type MfaPolicy = 'optional' | 'admins_required' | 'all_required';

/** What an unreadable organization is held to. */
export const UNREADABLE_ORG_MFA_POLICY: MfaPolicy = 'all_required';

export function enforcedMfaPolicy(
  org: { mfa_policy?: unknown } | null | undefined,
): MfaPolicy {
  const policy = org?.mfa_policy;
  return policy === 'optional' || policy === 'admins_required' || policy === 'all_required'
    ? policy
    : UNREADABLE_ORG_MFA_POLICY;
}

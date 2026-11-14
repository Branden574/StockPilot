/**
 * The database's owner rule (migration 0458): no commit leaves an organization
 * that has real members (accepted, not an "Act as" seat) with no real owner,
 * whoever writes. It is checked at COMMIT, so a write through the Data API
 * answers its refusal as the request's error:
 *
 *  - P0001, message `organization_needs_owner`: the change would leave the
 *    organization with members and no owner (an owner removed or demoted
 *    while members remain, or a member joining an organization that has no
 *    owner). Nothing was applied.
 *  - 55P03, message `organization_owner_check_busy`: another change to the
 *    same organization's owners or members was being saved for longer than
 *    the check waits (2 to 6 seconds). Nothing was applied; trying again
 *    works.
 *
 * Only those two, by SQLSTATE and message, are the rule. Every other error
 * keeps its caller's own handling.
 */

export type OrganizationOwnerRefusal = 'needs_owner' | 'busy';

/** Every surface where the check can be busy. */
export const ORGANIZATION_OWNER_BUSY_COPY =
  "Another change to this organization's owners or members is being saved. Nothing was changed. Try again in a minute.";
/** A Team change or the ownership transfer that would leave no owner. */
export const ORGANIZATION_NEEDS_OWNER_COPY =
  'This change would leave the organization with members and no owner. Nothing was changed.';
/**
 * Accepting an invite into an organization that has no owner. It says only
 * what did not happen: on the sign-up path the account already exists.
 */
export const INVITE_ORGANIZATION_HAS_NO_OWNER_COPY =
  'This organization has no owner right now, so the invite cannot be accepted. You were not added.';
/** "Act as" whose grant would have replaced the platform admin's own, only, owner membership. */
export const ACT_AS_ONLY_OWNER_COPY = 'You are the only owner of this organization, so Act as did not start.';

export function organizationOwnerRefusal(
  error: { code?: string | null; message?: string | null } | null | undefined,
): OrganizationOwnerRefusal | null {
  if (!error) return null;
  if (error.code === 'P0001' && error.message === 'organization_needs_owner') return 'needs_owner';
  if (error.code === '55P03' && error.message === 'organization_owner_check_busy') return 'busy';
  return null;
}

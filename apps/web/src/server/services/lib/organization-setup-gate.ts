import { isAdminRole } from '@stockpilot/core';

import { assertPermission, mfaGateError, ServiceError, type ServiceContext } from '../context';

/**
 * The organization's setup: its warehouses, its charters and their links, and
 * the public request settings. Every write policy on these rows asks the admin
 * role (organizations_update, charters_admin_write and warehouses_admin_write
 * in 0140, wc_admin_write in 0321), while organization:update can be given to
 * a member below admin. Such a member's UPDATE or DELETE changed no row with no
 * error, and the screen said it was saved; an INSERT was refused and they read
 * "An internal error occurred" (B99). The screens offer these changes through
 * core canEditOrganizationSetup; the services check the same before any read or
 * write.
 */

/** W1: a member below admin, up front. */
export const WAREHOUSE_SETUP_OWNER_ADMIN_ONLY_COPY =
  'Only owners and admins can change warehouses and charters. Nothing was saved.';

/** W2: a member below admin, up front (Settings > Public requests). */
export const PUBLIC_REQUEST_SETTINGS_OWNER_ADMIN_ONLY_COPY =
  'Only owners and admins can change the public request settings. Nothing was saved.';

/**
 * W3: the check passed, but the save's first write was refused or changed no
 * row. Not role words: once the check has passed, a tab left on another
 * organization (the active organization is shared by every tab) or an expired
 * act-as seat refuses the same way.
 */
export const SETUP_NOTHING_SAVED_COPY = 'Nothing was saved. Reload the page and try again.';

/** W4: a later write of the save failed after an earlier one landed. */
export const SETUP_PARTLY_SAVED_COPY =
  'Part of this change was not saved. Reload the page to see what was saved.';

/**
 * Owner or admin who holds organization:update, in this order: the MFA
 * step-up first (as assertPermission does), then the role, with `refusal` (W1
 * or W2), then the permission, so an admin whose organization:update was
 * revoked keeps "Missing permission: organization:update". A service with a
 * module check runs that first.
 */
export function assertCanEditOrganizationSetup(ctx: ServiceContext, refusal: string): void {
  if (ctx.mfaRequired && !ctx.mfaSatisfied) throw mfaGateError(ctx);
  if (!isAdminRole(ctx.role)) throw new ServiceError('forbidden', refusal);
  assertPermission(ctx, 'organization:update');
}

/** W3 as the error a service throws. */
export function setupNothingSaved(): ServiceError {
  return new ServiceError('conflict', SETUP_NOTHING_SAVED_COPY);
}

/** W4 as the error a service throws. */
export function setupPartlySaved(): ServiceError {
  return new ServiceError('conflict', SETUP_PARTLY_SAVED_COPY);
}

/** A write the row policy refused (an INSERT, or an UPDATE's new row). */
export function isPolicyRefusal(error: { code?: string | null } | null | undefined): boolean {
  return error?.code === '42501';
}

import { can, type ModuleId, type Permission, type Role } from '@stockpilot/core';

import { drawerOffers } from './drawer-nav';

/**
 * WHO A SCREEN OPENS FOR, DECIDED ONCE IT IS KNOWN (S75, B124).
 *
 * The side menu hides a link a member may not use, but a screen can be
 * reached another way: a Home card, a deep link, a notification. Such a
 * screen asks drawerEntryAccess with its menu link, and gets the menu's own
 * answer (drawer-nav.ts drawerOffers: the module on, and one of the link's
 * permissions held), never a second rule.
 *
 * Unlike the menu, which draws from the role's defaults while the saved
 * values load, a screen deciding what it reads or shows waits for them:
 * 'unknown' until the saved permissions and the saved modules have been read
 * (use-effective-permissions.ts, enabled-modules.ts), and, with no
 * permissions saved (before the first sync, or just after a workspace
 * switch), until the role is known. Reading a device store takes
 * milliseconds and always ends, so nothing waits on it for long.
 *
 * Display only, like every gate on the phone: the server decides every read
 * and write it is asked for.
 */

export type ScreenAccess = 'unknown' | 'allowed' | 'denied';

export interface ScreenAccessInputs {
  /** The saved permission set, and whether it has been read (useEffectivePermissionsState). */
  saved: { permissions: ReadonlySet<Permission> | undefined; read: boolean };
  /** The saved module set, and whether it has been read (useEnabledModulesState). */
  modules: { modules: Set<ModuleId>; read: boolean };
  /** The member's role in the workspace on screen, or null while unknown (useRole). */
  role: Role | null;
  /** The role is being read for the workspace on screen. */
  roleLoading: boolean;
}

/**
 * With nothing saved, the role's defaults decide, once the role is known. A
 * role that could not be read decides nothing: denied.
 */
function roleWhenNothingSaved(
  input: Pick<ScreenAccessInputs, 'role' | 'roleLoading'>,
): Role | 'unknown' | 'denied' {
  if (input.role !== null) return input.role;
  return input.roleLoading ? 'unknown' : 'denied';
}

/** Whether the screen behind this side-menu link opens for the member. */
export function drawerEntryAccess(href: string, input: ScreenAccessInputs): ScreenAccess {
  if (!input.saved.read || !input.modules.read) return 'unknown';
  let role: Role;
  if (input.saved.permissions === undefined) {
    const known = roleWhenNothingSaved(input);
    if (known === 'unknown' || known === 'denied') return known;
    role = known;
  } else {
    // A saved set decides every permission; the role only matters to a link
    // kept for admins, and one not known yet is not an admin.
    role = input.role ?? 'viewer';
  }
  return drawerOffers(href, role, input.modules.modules, input.saved.permissions)
    ? 'allowed'
    : 'denied';
}

/**
 * Whether the member holds one permission, decided as drawerEntryAccess is:
 * 'unknown' until the saved permissions are read, then the saved set, or with
 * nothing saved the known role's defaults. For a control the server checks
 * with that permission alone (New item: items:create).
 */
export function permissionAccess(
  permission: Permission,
  input: Omit<ScreenAccessInputs, 'modules'>,
): ScreenAccess {
  if (!input.saved.read) return 'unknown';
  if (input.saved.permissions !== undefined) {
    return input.saved.permissions.has(permission) ? 'allowed' : 'denied';
  }
  const known = roleWhenNothingSaved(input);
  if (known === 'unknown' || known === 'denied') return known;
  return can({ role: known }, permission) ? 'allowed' : 'denied';
}

/** What the cycle-count screens say to a member who may not see cycle counts. */
export const CYCLE_COUNTS_NOT_AVAILABLE =
  'Cycle counts are not available to you in this workspace.';

/** What the bundle screens say to a member who may not see bundles. */
export const BUNDLES_NOT_AVAILABLE = 'Bundles are not available to you in this workspace.';

/** What New item says to a member who cannot create items (the server's items:create). */
export const ITEMS_CREATE_NOT_ALLOWED =
  'You do not have permission to add items in this workspace.';

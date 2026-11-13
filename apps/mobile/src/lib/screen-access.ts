import { can, type ModuleId, type Permission, type Role } from '@stockpilot/core';

import { drawerOffers } from './drawer-nav';

/**
 * WHO A SCREEN OPENS FOR, DECIDED ONLY FROM WHAT THIS ACCOUNT SAVED (S75, B124).
 *
 * The side menu hides a link a member may not use, but a screen can be
 * reached another way: a Home card, a deep link, a notification. Such a
 * screen asks drawerEntryAccess with its menu link, and gets the menu's own
 * answer (drawer-nav.ts drawerOffers: the module on, and one of the link's
 * permissions held), never a second rule.
 *
 * Unlike the menu, which draws from defaults while the saved values load, a
 * screen deciding what it reads or shows answers one of:
 *   - 'unknown' until the device store has ANSWERED for the saved
 *     permissions, the saved modules and whose cache this is, however long
 *     that takes (`answered` in use-effective-permissions.ts,
 *     enabled-modules.ts and use-cache-owner.ts; never `read`, which the
 *     menu's wait sets with defaults), and while nobody is signed in;
 *   - 'unreadable' when one of those reads failed: the screen says so and
 *     offers Try again (retrySavedAccess, use-screen-access.ts), never a
 *     spinner that does not end;
 *   - 'not-synced' when the saved access is not this member's answer yet:
 *     the cache is not recorded as the signed-in account's (a session that
 *     ended without a wipe leaves another account's saved access until the
 *     next account's first pull resets it, cache-owner.ts), or no permission
 *     set or no module set is saved (a workspace switch, a first install, a
 *     reset, an adopted cache: db.ts deletes both and only a pull writes them
 *     again, sync.ts). Nothing stored on the phone is read for it, except a
 *     count this account fetched from the server in this workspace
 *     (cycle-count-cache.ts countStoredForLiveAccount); a screen that can ask
 *     the server does, and the server decides;
 *   - otherwise 'allowed' or 'denied', from the saved sets. 'denied' is only
 *     ever the saved sets' answer.
 *
 * The role's default permissions decide nothing a screen reads or shows from
 * the phone. They may still decide whether a create control is offered
 * (createControlOffer), because the server checks the write. Otherwise the
 * role only matters to a link kept for admins, where a role not known yet
 * counts as no admin: it can close such a link, never open one.
 *
 * Display only, like every gate on the phone: the server decides every read
 * and write it is asked for.
 */

export type ScreenAccess = 'unknown' | 'unreadable' | 'not-synced' | 'allowed' | 'denied';

export interface ScreenAccessInputs {
  /** The saved permission set, and whether the store has answered (useEffectivePermissionsState). */
  saved: { permissions: ReadonlySet<Permission> | undefined; answered: boolean | 'failed' };
  /** The saved module set, and what the store answered (useEnabledModulesState). */
  modules: {
    modules: Set<ModuleId>;
    answered: false | 'saved' | 'nothing-saved' | 'failed';
  };
  /** Whose cache this is, and whether the store has answered (useCacheOwnerState). */
  owner: { ownerId: string | null; answered: boolean | 'failed' };
  /** The signed-in account, or null when nobody is (useAuth). */
  liveUserId: string | null;
  /** The member's role in the workspace on screen, or null while unknown (useRole). */
  role: Role | null;
  /** The role is being read for the workspace on screen. */
  roleLoading: boolean;
}

/**
 * What the saved access says before any permission is looked at: not yet
 * known, unreadable, or not this member's yet; null when the saved
 * permission set (and, for a module link, the saved module set) is this
 * member's to decide with.
 */
function beforeDeciding(
  input: Omit<ScreenAccessInputs, 'modules'> & {
    modules?: ScreenAccessInputs['modules'];
  },
): Exclude<ScreenAccess, 'allowed' | 'denied'> | null {
  const answers = [input.saved.answered, input.owner.answered, input.modules?.answered ?? true];
  if (answers.includes('failed')) return 'unreadable';
  if (answers.includes(false) || input.liveUserId === null) return 'unknown';
  if (input.owner.ownerId !== input.liveUserId) return 'not-synced';
  if (input.saved.permissions === undefined) return 'not-synced';
  if (input.modules && input.modules.answered !== 'saved') return 'not-synced';
  return null;
}

/** Whether the screen behind this side-menu link opens for the member. */
export function drawerEntryAccess(href: string, input: ScreenAccessInputs): ScreenAccess {
  const early = beforeDeciding(input);
  if (early !== null) return early;
  // A saved set decides every permission; the role only matters to a link
  // kept for admins, and one not known yet is not an admin.
  const role: Role = input.role ?? 'viewer';
  return drawerOffers(href, role, input.modules.modules, input.saved.permissions)
    ? 'allowed'
    : 'denied';
}

/**
 * Whether the member holds one permission, decided as drawerEntryAccess is,
 * without the modules: for a control the server checks with that permission
 * alone (New item: items:create).
 */
export function permissionAccess(
  permission: Permission,
  input: Omit<ScreenAccessInputs, 'modules'>,
): ScreenAccess {
  const early = beforeDeciding({ ...input, modules: undefined });
  if (early !== null) return early;
  return input.saved.permissions!.has(permission) ? 'allowed' : 'denied';
}

/**
 * Whether a control that only leads to a write the server checks with this
 * permission (the + on Inventory and Books, the Scan tab's add cards, the
 * Inventory tour's + step: items:create) is offered:
 *   - 'allowed': offered; 'denied' (a saved set's answer): hidden;
 *   - 'unknown': hidden, and 'pending' (not settled yet);
 *   - 'not-synced' and 'unreadable': by the role's default permissions once
 *     the role is known (as before the saved sets decided screens), and
 *     'pending' while it is not. Offered by mistake, the server refuses the
 *     write; nothing is read or shown from the phone for it.
 */
export type CreateControlOffer = 'offered' | 'hidden' | 'pending';

export function createControlOffer(
  access: ScreenAccess,
  permission: Permission,
  role: Role | null,
  roleLoading: boolean,
): CreateControlOffer {
  if (access === 'allowed') return 'offered';
  if (access === 'denied') return 'hidden';
  if (access === 'unknown') return 'pending';
  if (role === null || roleLoading) return 'pending';
  return can({ role }, permission) ? 'offered' : 'hidden';
}

/**
 * What a gated screen says while its access is 'not-synced' and it has
 * nothing to show: offline, or online after a sync that did not land.
 */
export const NOT_SYNCED_YET =
  'This phone has not finished syncing this workspace yet. Check your connection and try again.';

/** What a gated screen says when its access is 'unreadable' (with Try again). */
export const SAVED_ACCESS_UNREADABLE =
  'What this phone saved about your access could not be read. Try again.';

/** What the cycle-count screens say to a member who may not see cycle counts. */
export const CYCLE_COUNTS_NOT_AVAILABLE =
  'Cycle counts are not available to you in this workspace.';

/** What the bundle screens say to a member who may not see bundles. */
export const BUNDLES_NOT_AVAILABLE = 'Bundles are not available to you in this workspace.';

/** What New item says to a member who cannot create items (the server's items:create). */
export const ITEMS_CREATE_NOT_ALLOWED =
  'You do not have permission to add items in this workspace.';

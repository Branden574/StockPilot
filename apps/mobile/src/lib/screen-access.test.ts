import { DEFAULT_MODULE_IDS, type ModuleId, type Permission, type Role } from '@stockpilot/core';
import { describe, expect, it, vi } from 'vitest';

import {
  CYCLE_COUNTS_NOT_AVAILABLE,
  drawerEntryAccess,
  NOT_SYNCED_YET,
  permissionAccess,
  SAVED_ACCESS_UNREADABLE,
  type ScreenAccessInputs,
} from './screen-access';

// drawer-nav maps icon names to lucide components; the icons are irrelevant
// here and the native package does not load under node.
vi.mock('./nav-icons', () => ({ NAV_ICONS: new Proxy({}, { get: () => () => null }) }));

/**
 * WHO A SCREEN OPENS FOR, DECIDED ONLY FROM WHAT THIS ACCOUNT SAVED.
 *
 * A screen reached other than from the side menu (a Home card, a deep link,
 * a notification) answers by the menu's own rule (core resolveSurface on the
 * mobile_drawer surface, through drawer-nav.ts drawerOffers): the module on,
 * and one of the placement's permissions held. Four answers:
 *   - 'unknown' until the device store has answered for the saved
 *     permissions, the saved modules and whose cache this is, however long
 *     that takes;
 *   - 'unreadable' when one of those reads failed (the screen offers Try
 *     again);
 *   - 'not-synced' when the cache is not recorded as the signed-in account's,
 *     or no permission set or no module set is saved: nothing saved on the
 *     phone is this member's answer yet;
 *   - otherwise 'allowed' or 'denied', from the saved sets.
 * The role's static defaults decide nothing any more.
 *
 * screen-access.ts takes only `answered` from each state, never `read`, which
 * the menu's wait sets with defaults (use-effective-permissions.ts,
 * enabled-modules.ts).
 */

const ALL_MODULES = new Set<ModuleId>(DEFAULT_MODULE_IDS);
const withoutModule = (id: ModuleId) => new Set([...ALL_MODULES].filter((m) => m !== id));
const ME = 'u-me';
const SOMEONE_ELSE = 'u-other';

function inputs(over: {
  permissions?: Permission[] | undefined;
  permissionsAnswered?: boolean | 'failed';
  modules?: Set<ModuleId>;
  modulesAnswered?: false | 'saved' | 'nothing-saved' | 'failed';
  ownerId?: string | null;
  ownerAnswered?: boolean | 'failed';
  liveUserId?: string | null;
  role?: Role | null;
  roleLoading?: boolean;
}): ScreenAccessInputs {
  return {
    saved: {
      permissions: over.permissions ? new Set(over.permissions) : undefined,
      answered: over.permissionsAnswered ?? true,
    },
    modules: {
      modules: over.modules ?? ALL_MODULES,
      answered: over.modulesAnswered ?? 'saved',
    },
    owner: {
      ownerId: over.ownerId === undefined ? ME : over.ownerId,
      answered: over.ownerAnswered ?? true,
    },
    liveUserId: over.liveUserId === undefined ? ME : over.liveUserId,
    role: over.role === undefined ? 'staff' : over.role,
    roleLoading: over.roleLoading ?? false,
  };
}

describe('cycle counts: the module on, and cycle_counts:read or stock:adjust', () => {
  const access = (over: Parameters<typeof inputs>[0]) =>
    drawerEntryAccess('/cycle-counts', inputs(over));

  it('is unknown until the store has answered for the permissions, the modules and the owner', () => {
    expect(access({ permissions: ['stock:adjust'], permissionsAnswered: false })).toBe('unknown');
    expect(access({ permissions: ['stock:adjust'], modulesAnswered: false })).toBe('unknown');
    expect(access({ permissions: ['stock:adjust'], ownerAnswered: false })).toBe('unknown');
    expect(access({ permissions: ['stock:adjust'], liveUserId: null })).toBe('unknown');
  });

  it('a read that failed is unreadable (the screen offers Try again), never a decision', () => {
    expect(access({ permissions: ['stock:adjust'], permissionsAnswered: 'failed' })).toBe(
      'unreadable',
    );
    expect(access({ permissions: ['stock:adjust'], modulesAnswered: 'failed' })).toBe('unreadable');
    expect(access({ permissions: ['stock:adjust'], ownerAnswered: 'failed' })).toBe('unreadable');
  });

  it('a saved set decides, whatever the role', () => {
    expect(access({ permissions: ['items:read', 'members:read'] })).toBe('denied');
    expect(access({ permissions: ['cycle_counts:read'], role: 'viewer' })).toBe('allowed');
    expect(access({ permissions: ['stock:adjust'], role: null })).toBe('allowed');
    // A manager whose two permissions were revoked.
    expect(access({ permissions: ['items:read'], role: 'manager' })).toBe('denied');
  });

  it('the module off denies, whatever is held', () => {
    expect(
      access({
        permissions: ['cycle_counts:read', 'stock:adjust'],
        modules: withoutModule('cycle_counts'),
      }),
    ).toBe('denied');
  });

  it('no permission set saved: not synced yet, whatever the role (the role defaults decide nothing)', () => {
    expect(access({ permissions: undefined, role: 'staff' })).toBe('not-synced');
    expect(access({ permissions: undefined, role: 'viewer' })).toBe('not-synced');
    expect(access({ permissions: undefined, role: null })).toBe('not-synced');
  });

  it('no module set saved: not synced yet, never "not available"', () => {
    expect(access({ permissions: ['cycle_counts:read'], modulesAnswered: 'nothing-saved' })).toBe(
      'not-synced',
    );
    expect(access({ permissions: ['items:read'], modulesAnswered: 'nothing-saved' })).toBe(
      'not-synced',
    );
  });

  it("another account's saved access is never this member's: not synced yet", () => {
    // Account A's session ended without a wipe; account B signed in.
    expect(access({ permissions: ['cycle_counts:read'], ownerId: SOMEONE_ELSE })).toBe(
      'not-synced',
    );
    expect(access({ permissions: ['items:read'], ownerId: SOMEONE_ELSE })).toBe('not-synced');
    // No owner recorded: nobody's yet.
    expect(access({ permissions: ['cycle_counts:read'], ownerId: null })).toBe('not-synced');
  });
});

describe('what a screen says', () => {
  it('to a member who may not open it: names the screen and the workspace, plainly', () => {
    expect(CYCLE_COUNTS_NOT_AVAILABLE).toBe(
      'Cycle counts are not available to you in this workspace.',
    );
  });

  it('while this phone has not synced the workspace for this member', () => {
    expect(NOT_SYNCED_YET).toBe(
      'This phone has not finished syncing this workspace yet. Check your connection and try again.',
    );
  });

  it('when what the phone saved could not be read', () => {
    expect(SAVED_ACCESS_UNREADABLE).toBe(
      'What this phone saved about your access could not be read. Try again.',
    );
  });
});

describe('bundles: the module on, and bundles:read or bundles:distribute', () => {
  const access = (over: Parameters<typeof inputs>[0]) =>
    drawerEntryAccess('/bundles', inputs(over));

  it('follows the side menu entry', () => {
    expect(access({ permissions: ['bundles:read'], role: 'viewer' })).toBe('allowed');
    expect(access({ permissions: ['bundles:distribute'] })).toBe('allowed');
    expect(access({ permissions: ['items:read'] })).toBe('denied');
    expect(access({ permissions: ['bundles:read'], modules: withoutModule('bundles') })).toBe(
      'denied',
    );
    expect(access({ permissions: undefined, role: 'staff' })).toBe('not-synced');
    expect(access({ permissions: ['bundles:read'], modulesAnswered: false })).toBe('unknown');
    expect(access({ permissions: ['bundles:read'], modulesAnswered: 'nothing-saved' })).toBe(
      'not-synced',
    );
    expect(access({ permissions: ['bundles:read'], ownerId: SOMEONE_ELSE })).toBe('not-synced');
  });
});

describe('one permission: items:create', () => {
  const access = (over: Parameters<typeof inputs>[0]) =>
    permissionAccess('items:create', inputs(over));

  it('is unknown until the store has answered for the permissions and the owner', () => {
    expect(access({ permissions: ['items:create'], permissionsAnswered: false })).toBe('unknown');
    expect(access({ permissions: ['items:create'], ownerAnswered: false })).toBe('unknown');
    expect(access({ permissions: ['items:create'], permissionsAnswered: 'failed' })).toBe(
      'unreadable',
    );
  });

  it('a saved set of this account decides; otherwise not synced yet', () => {
    expect(access({ permissions: ['items:read'] })).toBe('denied');
    expect(access({ permissions: ['items:create'], role: 'viewer' })).toBe('allowed');
    expect(access({ permissions: undefined, role: 'staff' })).toBe('not-synced');
    expect(access({ permissions: ['items:create'], ownerId: SOMEONE_ELSE })).toBe('not-synced');
  });

  it('is not a module link: the saved module set plays no part', () => {
    expect(access({ permissions: ['items:create'], modulesAnswered: false })).toBe('allowed');
    expect(access({ permissions: ['items:create'], modulesAnswered: 'nothing-saved' })).toBe(
      'allowed',
    );
  });
});

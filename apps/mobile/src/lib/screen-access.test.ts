import { DEFAULT_MODULE_IDS, type ModuleId, type Permission, type Role } from '@stockpilot/core';
import { describe, expect, it, vi } from 'vitest';

import {
  CYCLE_COUNTS_NOT_AVAILABLE,
  drawerEntryAccess,
  permissionAccess,
  type ScreenAccessInputs,
} from './screen-access';

// drawer-nav maps icon names to lucide components; the icons are irrelevant
// here and the native package does not load under node.
vi.mock('./nav-icons', () => ({ NAV_ICONS: new Proxy({}, { get: () => () => null }) }));

/**
 * WHO A SCREEN OPENS FOR, DECIDED ONCE IT IS KNOWN.
 *
 * A screen reached other than from the side menu (a Home card, a deep link,
 * a notification) answers by the menu's own rule (core resolveSurface on the
 * mobile_drawer surface, through drawer-nav.ts drawerOffers): the module on,
 * and one of the placement's permissions held. It answers 'unknown' until the
 * device store has answered for the saved permissions and the saved modules,
 * however long that takes, and, with no permissions saved, until the role is
 * known: never from a default that has not loaded. With no module set saved,
 * a module's screen is denied until one is.
 */

const ALL_MODULES = new Set<ModuleId>(DEFAULT_MODULE_IDS);
const withoutModule = (id: ModuleId) => new Set([...ALL_MODULES].filter((m) => m !== id));

// screen-access.ts takes only `answered` from each state, never `read`,
// which the menu's wait sets with defaults (use-effective-permissions.ts,
// enabled-modules.ts): a store that has not answered is 'unknown' however
// long it takes.
function inputs(over: {
  permissions?: Permission[] | undefined;
  permissionsAnswered?: boolean;
  modules?: Set<ModuleId>;
  modulesAnswered?: false | 'saved' | 'nothing-saved';
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
    role: over.role === undefined ? 'staff' : over.role,
    roleLoading: over.roleLoading ?? false,
  };
}

describe('cycle counts: the module on, and cycle_counts:read or stock:adjust', () => {
  const access = (over: Parameters<typeof inputs>[0]) =>
    drawerEntryAccess('/cycle-counts', inputs(over));

  it('is unknown until the device store has answered for the saved permissions and modules, even after the wait', () => {
    expect(access({ permissions: ['stock:adjust'], permissionsAnswered: false })).toBe('unknown');
    expect(access({ permissions: undefined, permissionsAnswered: false })).toBe('unknown');
    expect(access({ permissions: ['stock:adjust'], modulesAnswered: false })).toBe('unknown');
  });

  it('no module set saved: denied, whatever is held, until a set is saved', () => {
    // The menu keeps drawing from the default set; a screen does not.
    expect(
      access({
        permissions: ['cycle_counts:read', 'stock:adjust'],
        modulesAnswered: 'nothing-saved',
      }),
    ).toBe('denied');
    expect(access({ permissions: undefined, modulesAnswered: 'nothing-saved' })).toBe('denied');
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

  it('with nothing saved, the role decides by its defaults once it is known', () => {
    expect(access({ permissions: undefined, role: 'staff' })).toBe('allowed');
    expect(access({ permissions: undefined, role: 'viewer' })).toBe('denied');
    expect(access({ permissions: undefined, role: null, roleLoading: true })).toBe('unknown');
    expect(access({ permissions: undefined, role: null, roleLoading: false })).toBe('denied');
  });
});

describe('what a screen says to a member who may not open it', () => {
  it('names the screen and the workspace, plainly', () => {
    expect(CYCLE_COUNTS_NOT_AVAILABLE).toBe(
      'Cycle counts are not available to you in this workspace.',
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
    expect(access({ permissions: undefined, role: 'viewer' })).toBe('denied');
    expect(access({ permissions: undefined, role: 'staff' })).toBe('allowed');
    expect(access({ permissions: ['bundles:read'], modulesAnswered: false })).toBe('unknown');
    expect(access({ permissions: ['bundles:read'], modulesAnswered: 'nothing-saved' })).toBe(
      'denied',
    );
  });
});

describe('one permission: items:create', () => {
  const access = (over: Parameters<typeof inputs>[0]) =>
    permissionAccess('items:create', inputs(over));

  it('is unknown until the device store has answered for the saved permissions, even after the wait', () => {
    expect(access({ permissions: ['items:create'], permissionsAnswered: false })).toBe('unknown');
    expect(access({ permissions: undefined, permissionsAnswered: false })).toBe('unknown');
  });

  it('is not a module link: the saved module set plays no part', () => {
    expect(access({ permissions: ['items:create'], modulesAnswered: false })).toBe('allowed');
    expect(access({ permissions: ['items:create'], modulesAnswered: 'nothing-saved' })).toBe(
      'allowed',
    );
  });

  it('a saved set decides; with none, the known role', () => {
    expect(access({ permissions: ['items:read'] })).toBe('denied');
    expect(access({ permissions: ['items:create'], role: 'viewer' })).toBe('allowed');
    expect(access({ permissions: undefined, role: 'viewer' })).toBe('denied');
    expect(access({ permissions: undefined, role: 'staff' })).toBe('allowed');
    expect(access({ permissions: undefined, role: null, roleLoading: true })).toBe('unknown');
    expect(access({ permissions: undefined, role: null, roleLoading: false })).toBe('denied');
  });
});

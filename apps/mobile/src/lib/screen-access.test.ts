import { DEFAULT_MODULE_IDS, type ModuleId, type Permission, type Role } from '@stockpilot/core';
import { describe, expect, it, vi } from 'vitest';

import { CYCLE_COUNTS_NOT_AVAILABLE, drawerEntryAccess, type ScreenAccessInputs } from './screen-access';

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
 * saved permissions and the saved modules have been read, and, with nothing
 * saved, until the role is known: never from a default that has not loaded.
 */

const ALL_MODULES = new Set<ModuleId>(DEFAULT_MODULE_IDS);
const withoutModule = (id: ModuleId) => new Set([...ALL_MODULES].filter((m) => m !== id));

function inputs(over: {
  permissions?: Permission[] | undefined;
  permissionsRead?: boolean;
  modules?: Set<ModuleId>;
  modulesRead?: boolean;
  role?: Role | null;
  roleLoading?: boolean;
}): ScreenAccessInputs {
  return {
    saved: {
      permissions: over.permissions ? new Set(over.permissions) : undefined,
      read: over.permissionsRead ?? true,
    },
    modules: { modules: over.modules ?? ALL_MODULES, read: over.modulesRead ?? true },
    role: over.role === undefined ? 'staff' : over.role,
    roleLoading: over.roleLoading ?? false,
  };
}

describe('cycle counts: the module on, and cycle_counts:read or stock:adjust', () => {
  const access = (over: Parameters<typeof inputs>[0]) => drawerEntryAccess('/cycle-counts', inputs(over));

  it('is unknown until the saved permissions and the saved modules are read', () => {
    expect(access({ permissions: ['stock:adjust'], permissionsRead: false })).toBe('unknown');
    expect(access({ permissions: ['stock:adjust'], modulesRead: false })).toBe('unknown');
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
      access({ permissions: ['cycle_counts:read', 'stock:adjust'], modules: withoutModule('cycle_counts') }),
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
    expect(CYCLE_COUNTS_NOT_AVAILABLE).toBe('Cycle counts are not available to you in this workspace.');
  });
});

describe('bundles: the module on, and bundles:read or bundles:distribute', () => {
  const access = (over: Parameters<typeof inputs>[0]) => drawerEntryAccess('/bundles', inputs(over));

  it('follows the side menu entry', () => {
    expect(access({ permissions: ['bundles:read'], role: 'viewer' })).toBe('allowed');
    expect(access({ permissions: ['bundles:distribute'] })).toBe('allowed');
    expect(access({ permissions: ['items:read'] })).toBe('denied');
    expect(access({ permissions: ['bundles:read'], modules: withoutModule('bundles') })).toBe('denied');
    expect(access({ permissions: undefined, role: 'viewer' })).toBe('denied');
    expect(access({ permissions: undefined, role: 'staff' })).toBe('allowed');
    expect(access({ permissions: ['bundles:read'], modulesRead: false })).toBe('unknown');
  });
});

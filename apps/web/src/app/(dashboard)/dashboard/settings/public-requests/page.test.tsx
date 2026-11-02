import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { effectivePermissions, type Permission, type Role } from '@stockpilot/core';

/**
 * Settings > Public requests (B99). The panel with the public request message
 * and the switches that let a warehouse take public requests writes
 * organizations and warehouses, whose write policies ask the admin role. It was
 * shown to anyone holding organization:update, which an owner or admin can give
 * a member below admin; that member's changes looked saved and never were. It
 * is now shown only to an owner or admin who holds organization:update. The
 * request links panel keeps its own permission, public_links:manage.
 */

const h = vi.hoisted(() => ({
  ctx: null as unknown,
  settingsRead: 0,
}));

vi.mock('@/lib/auth/session', () => ({ requireOrgContext: vi.fn(async () => h.ctx) }));
vi.mock('@/lib/modules/module-gate', () => ({
  checkModuleAccess: vi.fn(async () => ({ enabled: true, canManage: true })),
}));
vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: ({ href, children }: { href: string; children: React.ReactNode }) =>
      React.createElement('a', { href }, children),
  };
});
vi.mock('@/server/services/warehouses', () => ({
  WarehousesService: {
    forCurrentUser: async () => ({ listNames: async () => [{ id: 'wh-1', name: 'North DC' }] }),
  },
}));
vi.mock('@/server/services/public-links', () => ({
  PublicLinksService: { forCurrentUser: async () => ({ list: async () => [] }) },
}));
vi.mock('@/server/services/order-requests', () => ({
  OrderRequestsService: {
    forCurrentUser: async () => ({
      getPublicSettings: async () => {
        h.settingsRead += 1;
        return {
          hasToken: true,
          rotatedAt: null,
          blurb: 'Ask us',
          publicOrderableWarehouseIds: [],
        };
      },
    }),
  },
}));
// The two panels have their own tests; here they show which one the page drew.
vi.mock('@/components/settings/public-links-manager', () => ({
  PublicLinksManager: () => <section aria-label="Request links manager" />,
}));
vi.mock('@/components/settings/public-requests-global-settings', () => ({
  PublicRequestsGlobalSettings: () => (
    <section aria-label="Public message and warehouse switches" />
  ),
}));

import PublicRequestsSettingsPage from './page';

function contextOf(
  role: Role,
  overrides: Array<{ permission: Permission; granted: boolean }> = [],
) {
  return {
    organizationId: 'org-1',
    userId: 'u-me',
    role,
    permissions: effectivePermissions(role, overrides),
  };
}

const ORG_UPDATE = { permission: 'organization:update' as const, granted: true };
const LINKS_MANAGE = { permission: 'public_links:manage' as const, granted: true };

const globalSettings = () =>
  screen.queryByRole('region', { name: 'Public message and warehouse switches' });

beforeEach(() => {
  h.settingsRead = 0;
});

describe('Settings > Public requests', () => {
  it('an admin gets the public request message and the warehouse switches', async () => {
    h.ctx = contextOf('admin');
    render(await PublicRequestsSettingsPage());
    expect(globalSettings()).not.toBeNull();
    expect(h.settingsRead).toBe(1);
  });

  it('a manager granted organization:update but not Manage public links gets the full-page refusal', async () => {
    h.ctx = contextOf('manager', [ORG_UPDATE]);
    render(await PublicRequestsSettingsPage());
    expect(
      screen.getByRole('heading', { level: 1, name: 'Public request links' }),
    ).toBeInTheDocument();
    expect(globalSettings()).toBeNull();
    expect(h.settingsRead).toBe(0);
  });

  it('a manager granted both gets the request links, and not the message and switches', async () => {
    h.ctx = contextOf('manager', [ORG_UPDATE, LINKS_MANAGE]);
    render(await PublicRequestsSettingsPage());
    expect(screen.getByRole('region', { name: 'Request links manager' })).toBeInTheDocument();
    expect(globalSettings()).toBeNull();
    expect(h.settingsRead).toBe(0);
  });
});

import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * L96: /dashboard/orders/new skipped the Orders module check that
 * /dashboard/orders makes, so with Orders off the storefront still opened
 * (and its loaders read the catalog). It now answers ModuleNotEnabled first,
 * as the list page does, and reads nothing else.
 */

const m = vi.hoisted(() => ({
  checkModuleAccess: vi.fn(),
  notEnabledProps: vi.fn(),
  storefrontProps: vi.fn(),
  loadCatalogBundle: vi.fn(),
  getWarehousesForRequest: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock('next/navigation', () => ({ redirect: m.redirect }));
vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: ({ href, children }: { href: string; children: React.ReactNode }) =>
      React.createElement('a', { href }, children),
  };
});
vi.mock('@/lib/modules/module-gate', () => ({ checkModuleAccess: m.checkModuleAccess }));
vi.mock('@/components/dashboard/module-not-enabled', () => ({
  ModuleNotEnabled: (props: Record<string, unknown>) => {
    m.notEnabledProps(props);
    return null;
  },
}));
vi.mock('@/components/orders/storefront/orders-storefront', () => ({
  OrdersStorefront: (props: Record<string, unknown>) => {
    m.storefrontProps(props);
    return null;
  },
}));
const ctx = vi.hoisted(() => ({
  role: 'staff',
  permissions: new Set<string>(['orders:request']),
}));
vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    organizationId: 'org-1',
    userId: 'u-1',
    role: ctx.role,
    permissions: ctx.permissions,
    fullName: 'Pat',
    email: 'pat@example.com',
  })),
}));
vi.mock('@/lib/dashboard/cached-org', () => ({
  getCachedOrgTimezone: vi.fn(async () => 'America/Los_Angeles'),
  getOrgEmailRouting: vi.fn(async () => ({ state: 'unset' })),
}));
const modules = vi.hoisted(() => ({ value: new Set<string>(['orders']) as Set<string> | null }));
vi.mock('@/lib/dashboard/request-cache', () => ({
  getModulesForRequest: vi.fn(async () => {
    if (modules.value === null) throw new Error('modules unreadable');
    return modules.value;
  }),
  getWarehousesForRequest: m.getWarehousesForRequest,
}));
vi.mock('@/server/loaders/orders-frequently-ordered', () => ({
  loadFrequentlyOrdered: vi.fn(() => Promise.resolve([])),
}));
vi.mock('@/server/loaders/orders-kits', () => ({ loadOrderKits: vi.fn(() => Promise.resolve([])) }));
vi.mock('@/server/loaders/orders-new-catalog', () => ({
  loadCatalogBundle: m.loadCatalogBundle,
  loadChartersForWarehouse: vi.fn(async () => []),
}));

import NewOrderPage from './page';

function callPage() {
  return NewOrderPage({ searchParams: Promise.resolve({}) });
}

beforeEach(() => {
  vi.clearAllMocks();
  m.getWarehousesForRequest.mockResolvedValue([{ id: 'wh-1', name: 'Main' }]);
  m.loadCatalogBundle.mockReturnValue(new Promise(() => {}));
  ctx.role = 'staff';
  ctx.permissions = new Set(['orders:request']);
  modules.value = new Set(['orders']);
  delete process.env.ORDER_ITEMS_MANAGE_ORGS;
});
afterEach(() => {
  delete process.env.ORDER_ITEMS_MANAGE_ORGS;
});

describe('New order page: the Orders module gate (L96)', () => {
  it('with Orders off, shows ModuleNotEnabled and reads no warehouse or catalog', async () => {
    m.checkModuleAccess.mockResolvedValue({ enabled: false, canManage: true });

    render(await callPage());

    expect(m.checkModuleAccess).toHaveBeenCalledWith('orders');
    expect(m.notEnabledProps).toHaveBeenCalledWith(
      expect.objectContaining({ moduleId: 'orders', canManage: true }),
    );
    expect(m.storefrontProps).not.toHaveBeenCalled();
    expect(m.getWarehousesForRequest).not.toHaveBeenCalled();
    expect(m.loadCatalogBundle).not.toHaveBeenCalled();
  });

  it('with Orders on, opens the storefront', async () => {
    m.checkModuleAccess.mockResolvedValue({ enabled: true, canManage: false });

    render(await callPage());

    expect(m.notEnabledProps).not.toHaveBeenCalled();
    expect(m.storefrontProps).toHaveBeenCalledWith(expect.objectContaining({ warehouseId: 'wh-1' }));
  });
});

describe('New order page: no active warehouses (redesign P4.B2)', () => {
  it('keeps its words, the back link and the h1 in the shared page header and empty state, and reads no catalog', async () => {
    m.checkModuleAccess.mockResolvedValue({ enabled: true, canManage: false });
    m.getWarehousesForRequest.mockResolvedValue([]);

    const { container } = render(await callPage());

    expect(screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent)).toEqual([
      'Place an order',
    ]);
    expect(screen.getByRole('link', { name: '← Back to orders' }).getAttribute('href')).toBe(
      '/dashboard/orders',
    );
    const panel = container.querySelector('[data-slot="state-panel"]');
    expect(panel?.getAttribute('data-state-kind')).toBe('empty');
    expect(panel?.textContent).toBe(
      'No active warehouses are configured.Ask an admin to add one before placing an order request.',
    );
    expect(m.storefrontProps).not.toHaveBeenCalled();
    expect(m.loadCatalogBundle).not.toHaveBeenCalled();
  });
});

describe('New order page: Manage order items (ordering visibility, design 8.1)', () => {
  const managing = () => m.storefrontProps.mock.calls.at(-1)?.[0]?.canManageOrderItems;

  beforeEach(() => {
    m.checkModuleAccess.mockResolvedValue({ enabled: true, canManage: false });
  });

  it('offers it to a manager in an organization the switch names', async () => {
    process.env.ORDER_ITEMS_MANAGE_ORGS = 'org-1';
    ctx.role = 'manager';
    ctx.permissions = new Set(['orders:request', 'orders:manage_catalog_visibility']);
    render(await callPage());
    expect(managing()).toBe(true);
  });

  it('not without the effective permission (a denied manager, a staff member)', async () => {
    process.env.ORDER_ITEMS_MANAGE_ORGS = '*';
    ctx.role = 'manager';
    ctx.permissions = new Set(['orders:request']);
    render(await callPage());
    expect(managing()).toBe(false);
  });

  it('a staff member StockPilot allowed gets it', async () => {
    process.env.ORDER_ITEMS_MANAGE_ORGS = '*';
    ctx.role = 'staff';
    ctx.permissions = new Set(['orders:request', 'orders:manage_catalog_visibility']);
    render(await callPage());
    expect(managing()).toBe(true);
  });

  it('not while the switch is off for the organization', async () => {
    process.env.ORDER_ITEMS_MANAGE_ORGS = 'org-2';
    ctx.role = 'owner';
    ctx.permissions = new Set(['orders:request', 'orders:manage_catalog_visibility']);
    render(await callPage());
    expect(managing()).toBe(false);
  });

  it('not when the module set could not be read (fail closed), and the kits row keeps no place', async () => {
    process.env.ORDER_ITEMS_MANAGE_ORGS = '*';
    ctx.role = 'manager';
    ctx.permissions = new Set(['orders:request', 'orders:manage_catalog_visibility']);
    modules.value = null;
    render(await callPage());
    expect(managing()).toBe(false);
    expect(m.storefrontProps.mock.calls.at(-1)?.[0]?.kitsEnabled).toBe(false);
  });
});

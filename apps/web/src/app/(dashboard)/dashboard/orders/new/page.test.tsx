import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    organizationId: 'org-1',
    userId: 'u-1',
    role: 'staff',
    permissions: new Set(['orders:request']),
    fullName: 'Pat',
    email: 'pat@example.com',
  })),
}));
vi.mock('@/lib/dashboard/cached-org', () => ({
  getCachedOrgTimezone: vi.fn(async () => 'America/Los_Angeles'),
  getOrgEmailRouting: vi.fn(async () => ({ state: 'unset' })),
}));
vi.mock('@/lib/dashboard/request-cache', () => ({
  getModulesForRequest: vi.fn(async () => new Set(['orders'])),
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

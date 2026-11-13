import { render } from '@testing-library/react';
import type * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { classicDom, classicStructure, glassOnlyCount } from '@/test/classic-dom';

/**
 * CLASSIC IS SACRED (Liquid Glass stage 3, orders lane). Place an order draws
 * its own frame only when no warehouse is set up (the storefront owns the
 * page otherwise, and its DOM is not changed by Liquid Glass: only a
 * stylesheet import was added). That frame's Classic DOM, normalised as the
 * classic proof normalises it (src/test/classic-dom.ts), is pinned in
 * __classic__/ from the code BEFORE the glass hook was added; with the inert
 * hooks stripped it must stay exactly that under `off` (no glass-only element
 * at all) and under `default`. Fix the change, never the snapshot.
 */

const m = vi.hoisted(() => ({
  checkModuleAccess: vi.fn(),
  getWarehousesForRequest: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock('next/navigation', () => ({ redirect: m.redirect }));
vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    prefetch: _prefetch,
    ...rest
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; prefetch?: unknown }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/lib/modules/module-gate', () => ({ checkModuleAccess: m.checkModuleAccess }));
vi.mock('@/components/orders/storefront/orders-storefront', () => ({
  OrdersStorefront: () => null,
}));
vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    organizationId: 'org-1',
    userId: 'u-1',
    role: 'staff',
    permissions: new Set<string>(['orders:request']),
    fullName: 'Pat Example',
    email: 'pat@example.test',
  })),
}));
vi.mock('@/lib/dashboard/cached-org', () => ({
  getCachedOrgTimezone: vi.fn(async () => 'America/Los_Angeles'),
  getOrgEmailRouting: vi.fn(async () => ({ state: 'unset' })),
}));
vi.mock('@/lib/dashboard/request-cache', () => ({
  getModulesForRequest: vi.fn(async () => new Set<string>(['orders'])),
  getWarehousesForRequest: m.getWarehousesForRequest,
}));
vi.mock('@/server/loaders/orders-frequently-ordered', () => ({
  loadFrequentlyOrdered: vi.fn(() => Promise.resolve([])),
}));
vi.mock('@/server/loaders/orders-kits', () => ({
  loadOrderKits: vi.fn(() => Promise.resolve([])),
}));
vi.mock('@/server/loaders/orders-new-catalog', () => ({
  loadCatalogBundle: vi.fn(() => new Promise(() => {})),
  loadChartersForWarehouse: vi.fn(async () => []),
}));

import NewOrderPage from './page';

beforeEach(() => {
  m.checkModuleAccess.mockResolvedValue({ enabled: true, canManage: false });
  m.getWarehousesForRequest.mockResolvedValue([]);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

async function renderUnder(rollout: 'off' | 'default') {
  vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', rollout);
  const view = render(await NewOrderPage({ searchParams: Promise.resolve({}) }));
  const out = {
    dom: classicDom(view.container),
    structure: classicStructure(view.container),
    glassOnly: glassOnlyCount(view.container),
  };
  view.unmount();
  return out;
}

describe('Place an order, Classic DOM (no warehouse set up)', () => {
  it('is the pinned Classic DOM under off and under default', async () => {
    const off = await renderUnder('off');
    expect(off.glassOnly).toBe(0);
    const glass = await renderUnder('default');
    expect(glass.dom).toBe(off.dom);
    // No Classic element changes its place among its siblings (classicStructure).
    expect(glass.structure).toBe(off.structure);
    await expect(off.dom).toMatchFileSnapshot('./__classic__/order-new.no-warehouse.txt');
  });
});

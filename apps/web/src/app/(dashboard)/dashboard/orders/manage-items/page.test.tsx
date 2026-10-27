import { render, screen } from '@testing-library/react';
import type * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ORDER_ITEMS_FEATURE_DISABLED_COPY,
  ORDER_ITEMS_LOAD_FAILED_COPY,
  ORDER_ITEMS_MANAGE_SUBLINE_COPY,
  ORDER_ITEMS_MFA_REQUIRED_COPY,
  ORDER_ITEMS_NO_ACCESS_COPY,
} from '@stockpilot/core';

/**
 * /dashboard/orders/manage-items (ordering visibility, design 8.2): the server
 * page. The Orders module gate first; then the service's list, which gates
 * the rollout switch, MFA and the effective permission, and reads with the
 * caller's client. A member without the capability gets a plain sentence,
 * not a 404; a failed read is said as a failure with Try again, never as an
 * empty list. The URL's filters reach the service parsed by core.
 */

const m = vi.hoisted(() => ({
  checkModuleAccess: vi.fn(),
  withContext: vi.fn(),
  list: vi.fn(),
  categories: vi.fn(),
  warehouses: vi.fn(),
  manageProps: vi.fn(),
  unavailableProps: vi.fn(),
}));

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('@/lib/modules/module-gate', () => ({ checkModuleAccess: m.checkModuleAccess }));
vi.mock('@/components/dashboard/module-unavailable', () => ({
  ModuleUnavailable: (props: Record<string, unknown>) => {
    m.unavailableProps(props);
    return <p>module unavailable</p>;
  },
}));
vi.mock('@/components/orders/manage-items/manage-order-items', () => ({
  ManageOrderItems: (props: Record<string, unknown>) => {
    m.manageProps(props);
    return <p>manage list</p>;
  },
}));
vi.mock('@/server/services/context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/services/context')>()),
  withContext: m.withContext,
}));
vi.mock('@/server/services/order-catalog-visibility', () => ({
  OrderCatalogVisibilityService: class {
    list = m.list;
  },
}));
vi.mock('@/server/services/categories', () => ({
  CategoriesService: class {
    list = m.categories;
  },
}));
vi.mock('@/lib/dashboard/request-cache', () => ({ getWarehousesForRequest: m.warehouses }));
vi.mock('@/lib/dashboard/cached-org', () => ({
  getCachedOrgTimezone: vi.fn(async () => 'America/Chicago'),
}));

import { ServiceError } from '@/server/services/context';

import ManageOrderItemsPage from './page';

const ORG = '0a000000-0000-4000-8000-00000000000a';
const USER = '6d80b722-1e44-4059-aa99-efd69718cb14';
const WH = '0a000000-0000-4000-8000-0000000000d1';
const CAT = '0a000000-0000-4000-8000-0000000000c1';

const ANSWER = {
  organizationId: ORG,
  viewer: { canManage: true },
  page: 2,
  pageSize: 25,
  total: 30,
  rows: [],
};

async function renderPage(params: Record<string, string> = {}) {
  render(await ManageOrderItemsPage({ searchParams: Promise.resolve(params) }));
}

beforeEach(() => {
  vi.clearAllMocks();
  m.checkModuleAccess.mockResolvedValue({ enabled: true, canManage: false });
  m.withContext.mockResolvedValue({ organizationId: ORG, userId: USER, role: 'manager' });
  m.list.mockResolvedValue(ANSWER);
  m.categories.mockResolvedValue([{ id: CAT, name: 'Apparel', color: null }]);
  m.warehouses.mockResolvedValue([{ id: WH, name: 'North' }]);
});

describe('Manage order items page', () => {
  it('with Orders off shows the module panel and reads no item', async () => {
    m.checkModuleAccess.mockResolvedValue({ enabled: false, canManage: true });
    await renderPage();
    expect(m.unavailableProps).toHaveBeenCalledWith(
      expect.objectContaining({ moduleId: 'orders' }),
    );
    expect(m.list).not.toHaveBeenCalled();
  });

  it('reads the page the URL names through the service and hands the scope, filters and lookups to the list', async () => {
    await renderPage({
      q: ' shirt ',
      visibility: 'hidden',
      page: '2',
      warehouseId: WH,
      type: 'bogus',
    });
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Manage order items');
    expect(screen.getByText(ORDER_ITEMS_MANAGE_SUBLINE_COPY)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '← Back to orders' })).toHaveAttribute(
      'href',
      '/dashboard/orders',
    );
    const filters = {
      q: 'shirt',
      visibility: 'hidden',
      type: 'all',
      warehouseId: WH,
      categoryId: null,
      page: 2,
    };
    expect(m.list).toHaveBeenCalledWith(filters);
    expect(m.manageProps).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORG,
        userId: USER,
        answer: ANSWER,
        filters,
        warehouses: [{ id: WH, name: 'North' }],
        categories: [{ id: CAT, name: 'Apparel' }],
        orgTimezone: 'America/Chicago',
      }),
    );
  });

  it('a member without the capability (never had it, or denied) gets a sentence, not the list and not a 404', async () => {
    m.list.mockRejectedValue(new ServiceError('forbidden', 'x', { reason: 'forbidden' }));
    await renderPage();
    expect(screen.getByText(ORDER_ITEMS_NO_ACCESS_COPY)).toBeInTheDocument();
    expect(m.manageProps).not.toHaveBeenCalled();
  });

  it('says when Manage order items is not switched on for the organization', async () => {
    m.list.mockRejectedValue(new ServiceError('forbidden', 'x', { reason: 'feature_disabled' }));
    await renderPage();
    expect(screen.getByText(ORDER_ITEMS_FEATURE_DISABLED_COPY)).toBeInTheDocument();
  });

  it('sends a member who must enrol in MFA to set it up', async () => {
    m.list.mockRejectedValue(new ServiceError('forbidden', 'x', { reason: 'mfa_required' }));
    await renderPage();
    expect(screen.getByText(ORDER_ITEMS_MFA_REQUIRED_COPY)).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Set up multi-factor authentication' }),
    ).toHaveAttribute('href', '/dashboard/settings/security');
  });

  it('a failed read is a failure with Try again on the same view, never an empty list', async () => {
    m.list.mockRejectedValue(new ServiceError('internal_error', 'boom'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await renderPage({ visibility: 'hidden' });
    expect(screen.getByText(ORDER_ITEMS_LOAD_FAILED_COPY)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Try again' })).toHaveAttribute(
      'href',
      '/dashboard/orders/manage-items?visibility=hidden',
    );
    expect(m.manageProps).not.toHaveBeenCalled();
    expect(screen.queryByText('No items are hidden from Orders.')).toBeNull();
    error.mockRestore();
  });

  it('lookups that fail leave their filters out; the list still shows', async () => {
    m.categories.mockRejectedValue(new Error('categories down'));
    m.warehouses.mockRejectedValue(new Error('warehouses down'));
    await renderPage();
    expect(m.manageProps).toHaveBeenCalledWith(
      expect.objectContaining({ warehouses: [], categories: [] }),
    );
  });
});

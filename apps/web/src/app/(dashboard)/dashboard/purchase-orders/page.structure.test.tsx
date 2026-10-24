import { render, screen, within } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The purchase orders list in the redesign's patterns (page header, stat strip,
 * segmented status tabs, filter row, table card, state panels) keeps what the
 * page did: the heading and its rename, the count and value line, Export with
 * its URL, + New PO, the four stats, the six tabs (All without Cancelled) and
 * the Overdue view the Overview links to as a "Filter by status" navigation, the 800-PO split between the instant search
 * and the URL search, the 30-per-page pager with its past-end clamp, every
 * empty and failed state with its own words, the owner/admin threshold panel
 * and the module gate.
 */

const listStats = vi.fn();
const listPage = vi.fn();
const listOverdue = vi.fn();
const listForLookups = vi.fn();
const effectiveNavLabel = vi.fn();
const getActiveWarehouseFilter = vi.fn();
const checkModuleAccess = vi.fn();
const createClient = vi.fn();
let role = 'staff';

vi.mock('@/lib/modules/module-gate', () => ({
  checkModuleAccess: (...args: unknown[]) => checkModuleAccess(...args),
}));
vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    organizationId: 'org-1',
    userId: 'u1',
    role,
    permissions: null,
  })),
}));
vi.mock('@/lib/nav-labels', () => ({
  effectiveNavLabel: (...args: unknown[]) => effectiveNavLabel(...args),
}));
vi.mock('@/lib/supabase/server', () => ({ createClient: () => createClient() }));
vi.mock('@/lib/warehouse-filter', () => ({
  getActiveWarehouseFilter: () => getActiveWarehouseFilter(),
}));
vi.mock('@/server/services/purchase-orders', () => ({
  PurchaseOrdersService: {
    forCurrentUser: vi.fn(async () => ({ listStats, listPage, listOverdue })),
  },
}));
vi.mock('@/server/services/suppliers', () => ({
  SuppliersService: { forCurrentUser: vi.fn(async () => ({ listForLookups })) },
}));
vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    // Every prop but next/link's own reaches the anchor, so aria-current and
    // the names are read as the browser would see them.
    default: ({
      href,
      children,
      prefetch: _prefetch,
      scroll: _scroll,
      replace: _replace,
      ...rest
    }: {
      href: string;
      children: React.ReactNode;
      prefetch?: unknown;
      scroll?: unknown;
      replace?: unknown;
    }) => React.createElement('a', { href, ...rest }, children),
  };
});
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/components/po/po-search', () => ({
  PoSearch: ({ status, initialQuery }: { status: string; initialQuery: string }) => (
    <div data-testid="po-search" data-status={status} data-q={initialQuery} />
  ),
}));
vi.mock('@/components/settings/po-approval-panel', () => ({
  PoApprovalPanel: ({ initialAmount }: { initialAmount: number }) => (
    <div data-testid="approval-panel" data-amount={String(initialAmount)} />
  ),
}));
vi.mock('@/components/dashboard/module-not-enabled', () => ({
  ModuleNotEnabled: ({ moduleId, canManage }: { moduleId: string; canManage: boolean }) => (
    <div data-testid="module-off" data-module={moduleId} data-can-manage={String(canManage)} />
  ),
}));

import PurchaseOrdersPage from './page';

function stats(over: Partial<Record<string, unknown>> = {}) {
  return {
    totalCount: 30,
    totalValue: 58742.78,
    openCount: 16,
    committedValue: 16403.6,
    openSupplierCount: 7,
    inboundCount: 12,
    nextEtaPoNumber: 'PO-2026-0012',
    nextEtaExpectedAt: '2026-09-24T00:00:00.000Z',
    avgLeadDays: 6.6,
    ...over,
  };
}

function row(n: number, over: Record<string, unknown> = {}) {
  return {
    id: `po-${n}`,
    po_number: `PO-${n}`,
    status: 'ordered',
    supplier_id: 'sup-1',
    destination_location_id: null,
    expected_at: '2026-10-10T00:00:00.000Z',
    ordered_at: '2026-10-01T19:00:00.000Z',
    received_at: null,
    total: 100 * n,
    created_at: '2026-10-01T19:00:00.000Z',
    updated_at: '2026-10-01T19:00:00.000Z',
    line_count: n,
    ...over,
  };
}

async function renderList(params: { status?: string; q?: string; page?: string } = {}) {
  return render(await PurchaseOrdersPage({ searchParams: Promise.resolve(params) }));
}

function exportLink() {
  return screen.getByRole('link', { name: 'Export purchase orders to CSV' });
}

beforeEach(() => {
  vi.clearAllMocks();
  role = 'staff';
  checkModuleAccess.mockResolvedValue({ enabled: true, canManage: false });
  effectiveNavLabel.mockImplementation(async (_href: string, fallback: string) => fallback);
  getActiveWarehouseFilter.mockResolvedValue(null);
  listForLookups.mockResolvedValue([{ id: 'sup-1', name: 'Acme Supply' }]);
  listStats.mockResolvedValue(stats());
  listPage.mockResolvedValue({ rows: [row(1), row(2)], total: 2 });
  createClient.mockImplementation(async () => {
    throw new Error('read only for an owner or admin');
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the purchase orders list: header and stats', () => {
  it('titles the page with the sidebar entry’s name, renamed or not', async () => {
    effectiveNavLabel.mockResolvedValueOnce('Supplier orders');
    await renderList();
    expect(effectiveNavLabel).toHaveBeenCalledWith('/dashboard/purchase-orders', 'Purchase orders');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Supplier orders');
  });

  it('keeps its own heading when the name lookup fails', async () => {
    effectiveNavLabel.mockRejectedValueOnce(new Error('no org row'));
    await renderList();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Purchase orders');
  });

  it('says the count and the total value of every purchase order in scope', async () => {
    const { container } = await renderList();
    expect(container.textContent).toContain('30 POs · $58,742.78 total value');
    listStats.mockResolvedValue(stats({ totalCount: 1, totalValue: 12 }));
    const again = await renderList();
    expect(again.container.textContent).toContain('1 PO · $12.00 total value');
  });

  it('shows the four stats with their own words', async () => {
    const { container } = await renderList();
    const text = container.textContent ?? '';
    for (const words of [
      'Open POs',
      '16',
      'across 7 suppliers',
      'Committed value',
      '$16,403.60',
      'USD',
      'On the water',
      'PO-2026-0012 · ETA Sep 24',
      'Avg lead time',
      '7 d',
      'rolling 90-day',
    ]) {
      expect(text, words).toContain(words);
    }
  });

  it('says what is on the water when nothing has an ETA, and a dash for no lead time', async () => {
    listStats.mockResolvedValue(
      stats({ nextEtaPoNumber: null, nextEtaExpectedAt: null, avgLeadDays: null }),
    );
    const { container } = await renderList();
    expect(container.textContent).toContain('No ETA scheduled');
    listStats.mockResolvedValue(
      stats({ inboundCount: 0, nextEtaPoNumber: null, nextEtaExpectedAt: null }),
    );
    const again = await renderList();
    expect(again.container.textContent).toContain('Nothing inbound');
  });

  it('exports the tab, the URL search and the warehouse view as before, as a download', async () => {
    getActiveWarehouseFilter.mockResolvedValue('wh-1');
    await renderList();
    expect(exportLink()).toHaveAttribute(
      'href',
      '/api/purchase-orders/export.csv?status=all&warehouse=wh-1',
    );
    expect(exportLink()).toHaveAttribute('download');
  });

  it('offers + New PO to every reader', async () => {
    await renderList();
    expect(screen.getByRole('link', { name: '+ New PO' })).toHaveAttribute(
      'href',
      '/dashboard/purchase-orders/new',
    );
  });
});

describe('the purchase orders list: status tabs', () => {
  it('draws the six tabs and the Overdue view as the "Filter by status" navigation with the shown one current', async () => {
    await renderList({ status: 'in_transit' });
    const nav = screen.getByRole('navigation', { name: 'Filter by status' });
    const links = within(nav).getAllByRole('link');
    expect(links.map((l) => l.textContent)).toEqual([
      'All',
      'Overdue',
      'Draft',
      'Ordered',
      'In transit',
      'Received',
      'Cancelled',
    ]);
    expect(links.map((l) => l.getAttribute('href'))).toEqual([
      '/dashboard/purchase-orders?status=all',
      '/dashboard/purchase-orders?status=overdue',
      '/dashboard/purchase-orders?status=draft',
      '/dashboard/purchase-orders?status=ordered',
      '/dashboard/purchase-orders?status=in_transit',
      '/dashboard/purchase-orders?status=received',
      '/dashboard/purchase-orders?status=cancelled',
    ]);
    expect(within(nav).getByRole('link', { name: 'In transit' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(nav).getByRole('link', { name: 'All' })).not.toHaveAttribute('aria-current');
    expect(listPage).toHaveBeenCalledWith(
      expect.objectContaining({ statuses: ['expected_inbound', 'partially_received'] }),
    );
  });

  it('opens the Overview’s ?status=overdue on the Overdue view, read on its own (small fixes slice 8)', async () => {
    listOverdue.mockResolvedValue({ rows: [row(1)], asOfDay: '2026-10-11' });
    await renderList({ status: 'overdue' });
    const nav = screen.getByRole('navigation', { name: 'Filter by status' });
    expect(within(nav).getByRole('link', { name: 'Overdue' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(nav).getByRole('link', { name: 'All' })).not.toHaveAttribute('aria-current');
    expect(listOverdue).toHaveBeenCalledWith({ warehouseId: undefined });
    expect(listPage).not.toHaveBeenCalled();
  });

  it('treats an unknown status as All, which leaves out Cancelled', async () => {
    await renderList({ status: 'late' });
    const nav = screen.getByRole('navigation', { name: 'Filter by status' });
    expect(within(nav).getByRole('link', { name: 'All' })).toHaveAttribute('aria-current', 'page');
    const statuses = listPage.mock.calls[0]![0].statuses as string[];
    expect(statuses).not.toContain('cancelled');
    expect(statuses).toEqual(
      expect.arrayContaining([
        'draft',
        'ordered',
        'expected_inbound',
        'partially_received',
        'received',
      ]),
    );
  });
});

describe('the purchase orders list: the 800-PO split between the two searches', () => {
  it('up to 800: loads the whole tab and searches it as you type, ignoring a URL q', async () => {
    await renderList({ q: 'acme' });
    expect(listPage).toHaveBeenCalledWith(
      expect.objectContaining({ q: '', page: 1, perPage: 800 }),
    );
    expect(screen.getByRole('searchbox', { name: 'Search purchase orders' })).toBeInTheDocument();
    expect(screen.queryByTestId('po-search')).toBeNull();
    // The rows, each with its two links to the PO.
    expect(screen.getByRole('link', { name: 'PO-1' })).toHaveAttribute(
      'href',
      '/dashboard/purchase-orders/po-1',
    );
    expect(screen.getByRole('link', { name: 'Open PO-1' })).toHaveAttribute(
      'href',
      '/dashboard/purchase-orders/po-1',
    );
  });

  it('over 800: the URL search, one server page of 30, and the tab and q kept in Export and the tabs', async () => {
    listStats.mockResolvedValue(stats({ totalCount: 801 }));
    await renderList({ status: 'draft', q: 'acme', page: '2' });
    expect(listPage).toHaveBeenCalledWith(
      expect.objectContaining({ q: 'acme', page: 2, perPage: 30, statuses: ['draft'] }),
    );
    const search = screen.getByTestId('po-search');
    expect(search).toHaveAttribute('data-status', 'draft');
    expect(search).toHaveAttribute('data-q', 'acme');
    expect(screen.queryByRole('searchbox', { name: 'Search purchase orders' })).toBeNull();
    expect(exportLink()).toHaveAttribute(
      'href',
      '/api/purchase-orders/export.csv?status=draft&q=acme',
    );
    const nav = screen.getByRole('navigation', { name: 'Filter by status' });
    expect(within(nav).getByRole('link', { name: 'Received' })).toHaveAttribute(
      'href',
      '/dashboard/purchase-orders?status=received&q=acme',
    );
  });
});

describe('the purchase orders list: the server pager', () => {
  beforeEach(() => {
    listStats.mockResolvedValue(stats({ totalCount: 900 }));
  });

  it('pages 30 at a time with the range, the page and links that do not prefetch', async () => {
    listPage.mockResolvedValue({
      rows: Array.from({ length: 30 }, (_, i) => row(31 + i)),
      total: 95,
    });
    const { container } = await renderList({ page: '2' });
    expect(container.textContent).toContain('Showing 31–60 of 95');
    expect(container.textContent).toContain('Page 2 of 4');
    expect(screen.getByRole('link', { name: '← Prev' })).toHaveAttribute(
      'href',
      '/dashboard/purchase-orders?status=all',
    );
    expect(screen.getByRole('link', { name: 'Next →' })).toHaveAttribute(
      'href',
      '/dashboard/purchase-orders?status=all&page=3',
    );
  });

  it('shows no pager on a single page, and disables Prev on the first', async () => {
    listPage.mockResolvedValue({ rows: [row(1)], total: 1 });
    const { container } = await renderList();
    expect(container.textContent).not.toContain('Page 1 of 1');

    listPage.mockResolvedValue({
      rows: Array.from({ length: 30 }, (_, i) => row(i + 1)),
      total: 40,
    });
    await renderList();
    expect(screen.getByRole('button', { name: '← Prev' })).toBeDisabled();
    expect(screen.getByRole('link', { name: 'Next →' })).toBeInTheDocument();
  });

  it('a page past the end says so, keeps the pager and sends Prev to the last real page', async () => {
    listPage.mockResolvedValue({ rows: [], total: 95 });
    const { container } = await renderList({ page: '9' });
    expect(screen.getByRole('heading', { name: 'Nothing on this page' })).toBeInTheDocument();
    expect(container.textContent).toContain(
      'This page is past the end of the list — jump back with the pagination below.',
    );
    expect(container.textContent).toContain('95 matches on earlier pages');
    expect(container.textContent).toContain('Page 4 of 4');
    expect(screen.getByRole('link', { name: '← Prev' })).toHaveAttribute(
      'href',
      '/dashboard/purchase-orders?status=all&page=4',
    );
    expect(screen.getByRole('button', { name: 'Next →' })).toBeDisabled();
  });

  it('a URL search with no match says so with the search in its words', async () => {
    listPage.mockResolvedValue({ rows: [], total: 0 });
    const { container } = await renderList({ q: 'zzz' });
    expect(screen.getByRole('heading', { name: 'No POs match “zzz”' })).toBeInTheDocument();
    expect(container.textContent).toContain(
      'Try a different PO number or supplier, or clear the search.',
    );
  });
});

describe('the purchase orders list: empty and failed', () => {
  it('an empty tab says so and points at the other tabs', async () => {
    listPage.mockResolvedValue({ rows: [], total: 0 });
    const { container } = await renderList({ status: 'draft' });
    expect(screen.getByRole('heading', { name: 'Nothing in draft' })).toBeInTheDocument();
    expect(container.textContent).toContain(
      'Switch tabs above to see purchase orders in other stages.',
    );
  });

  it('an organization with no purchase orders gets the first-PO call to action', async () => {
    listStats.mockResolvedValue(stats({ totalCount: 0, totalValue: 0 }));
    listPage.mockResolvedValue({ rows: [], total: 0 });
    await renderList();
    expect(screen.getByRole('heading', { name: 'No purchase orders yet' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Create your first PO' })).toHaveAttribute(
      'href',
      '/dashboard/purchase-orders/new',
    );
  });

  it('a failed read keeps the header and the tabs and offers Try again, never the error page', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    listStats.mockRejectedValue(new Error('boom'));
    await renderList();
    expect(
      screen.getByRole('heading', { name: "We couldn't load purchase orders" }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Try again' })).toHaveAttribute(
      'href',
      '/dashboard/purchase-orders',
    );
    expect(screen.getByRole('navigation', { name: 'Filter by status' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Purchase orders');
  });
});

describe('the purchase orders list: the approval threshold and the module gate', () => {
  it('shows the threshold panel to an owner with the saved amount, and not to staff', async () => {
    role = 'owner';
    const maybeSingle = vi.fn(async () => ({
      data: { settings: { approvalThresholdAmount: 250 } },
    }));
    const eq2 = vi.fn(() => ({ maybeSingle }));
    const eq1 = vi.fn(() => ({ eq: eq2 }));
    const select = vi.fn(() => ({ eq: eq1 }));
    createClient.mockResolvedValue({ from: vi.fn(() => ({ select })) });
    await renderList();
    expect(screen.getByTestId('approval-panel')).toHaveAttribute('data-amount', '250');
    expect(eq2).toHaveBeenCalledWith('module_id', 'purchase_orders');

    role = 'staff';
    createClient.mockClear();
    const { container } = await renderList();
    expect(within(container).queryByTestId('approval-panel')).toBeNull();
    expect(createClient).not.toHaveBeenCalled();
  });

  it('with the module off it says so and reads nothing', async () => {
    checkModuleAccess.mockResolvedValue({ enabled: false, canManage: true });
    await renderList();
    expect(screen.getByTestId('module-off')).toHaveAttribute('data-module', 'purchase_orders');
    expect(screen.getByTestId('module-off')).toHaveAttribute('data-can-manage', 'true');
    expect(listStats).not.toHaveBeenCalled();
    expect(listPage).not.toHaveBeenCalled();
  });
});

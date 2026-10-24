import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The dashboard's "N overdue purchase orders" links to
 * /dashboard/purchase-orders?status=overdue. The list had no Overdue view, so
 * the link opened All (follow-up from #338). Now ?status=overdue opens an
 * Overdue view listing exactly what the dashboard counts
 * (PurchaseOrdersService.listOverdue, the count's own filter; small fixes
 * slice 8, item E), in the instant list (up to 800 purchase orders) and the
 * server-paged one (above 800), with the search and the pages the other views
 * have.
 */

const listStats = vi.fn();
const listPage = vi.fn();
const listOverdue = vi.fn();

vi.mock('@/lib/modules/module-gate', () => ({
  checkModuleAccess: vi.fn(async () => ({ enabled: true, canManage: false })),
}));
vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({ organizationId: 'org-1', userId: 'u1', role: 'staff', permissions: null })),
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => {
    throw new Error('not read for a staff member');
  }),
}));
vi.mock('@/lib/dashboard/request-cache', () => ({
  getOrgRowForRequest: vi.fn(async () => ({ timezone: 'America/Los_Angeles' })),
}));
vi.mock('@/lib/warehouse-filter', () => ({ getActiveWarehouseFilter: vi.fn(async () => 'wh-picked') }));
vi.mock('@/server/services/purchase-orders', () => ({
  PurchaseOrdersService: { forCurrentUser: vi.fn(async () => ({ listStats, listPage, listOverdue })) },
}));
vi.mock('@/server/services/suppliers', () => ({
  SuppliersService: {
    forCurrentUser: vi.fn(async () => ({
      listForLookups: vi.fn(async () => [
        { id: 'sup-1', name: 'Acme Paper' },
        { id: 'sup-2', name: 'TechSource' },
      ]),
    })),
  },
}));
vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) =>
      React.createElement('a', { href, ...rest }, children),
  };
});
vi.mock('@/components/po/po-search', () => ({ PoSearch: () => null }));
vi.mock('@/components/settings/po-approval-panel', () => ({ PoApprovalPanel: () => null }));
vi.mock('@/components/po/po-status-badge', () => ({ PoStatusBadge: () => null }));

import PurchaseOrdersPage from './page';

function stats(totalCount: number) {
  return {
    totalCount,
    totalValue: 0,
    openCount: 0,
    committedValue: 0,
    openSupplierCount: 0,
    inboundCount: 0,
    nextEtaPoNumber: null,
    nextEtaExpectedAt: null,
    avgLeadDays: null,
  };
}

function row(n: number, over: Record<string, unknown> = {}) {
  return {
    id: `po-${n}`,
    po_number: `PO-${String(n).padStart(3, '0')}`,
    status: 'ordered',
    supplier_id: n % 2 === 0 ? 'sup-2' : 'sup-1',
    destination_location_id: null,
    expected_at: '2026-10-01T00:00:00.000Z',
    ordered_at: '2026-09-20T19:00:00.000Z',
    received_at: null,
    total: 10,
    created_at: '2026-09-20T19:00:00.000Z',
    updated_at: '2026-09-20T19:00:00.000Z',
    line_count: 1,
    ...over,
  };
}

async function open(search: Record<string, string>) {
  return render(await PurchaseOrdersPage({ searchParams: Promise.resolve(search) }));
}

const tab = (name: string) => screen.getByRole('link', { name });

beforeEach(() => {
  vi.clearAllMocks();
  listPage.mockResolvedValue({ rows: [], total: 0 });
  listOverdue.mockResolvedValue({ rows: [row(1), row(2)], asOfDay: '2026-10-11' });
});

describe('the purchase orders list has the Overdue view the dashboard links to', () => {
  it('?status=overdue opens Overdue (not All), listing what the dashboard counts for the same warehouse', async () => {
    listStats.mockResolvedValue(stats(40));
    await open({ status: 'overdue' });

    expect(tab('Overdue')).toHaveAttribute('aria-current', 'page');
    expect(tab('All')).not.toHaveAttribute('aria-current');
    // The view's own read, scoped to the warehouse picked in the header, as
    // the dashboard's count is; never the status page of All.
    expect(listOverdue).toHaveBeenCalledWith({ warehouseId: 'wh-picked' });
    expect(listPage).not.toHaveBeenCalled();
    expect(screen.getByText('PO-001')).toBeInTheDocument();
    expect(screen.getByText('PO-002')).toBeInTheDocument();
    // The count and the rule, as the dashboard counts them.
    expect(
      screen.getByText(
        "2 purchase orders are overdue: not fully received, with an expected date before today, Oct 11, in your organization's time zone.",
      ),
    ).toBeInTheDocument();
  });

  it('every other view still lists by status, and links to Overdue', async () => {
    listStats.mockResolvedValue(stats(40));
    await open({});
    expect(listOverdue).not.toHaveBeenCalled();
    expect(listPage).toHaveBeenCalledTimes(1);
    expect(tab('Overdue')).toHaveAttribute('href', '/dashboard/purchase-orders?status=overdue');
  });

  it('nothing overdue says so, in the rule\'s words', async () => {
    listStats.mockResolvedValue(stats(40));
    listOverdue.mockResolvedValueOnce({ rows: [], asOfDay: '2026-10-11' });
    await open({ status: 'overdue' });
    expect(screen.getByText('Nothing overdue')).toBeInTheDocument();
    expect(
      screen.getByText(
        "No purchase order that is ordered or in transit has an expected date before today in your organization's time zone.",
      ),
    ).toBeInTheDocument();
  });

  it('above 800 purchase orders: searched and paged on the server, 30 to a page, with the count of the search', async () => {
    listStats.mockResolvedValue(stats(900));
    const rows = Array.from({ length: 45 }, (_, i) => row(i + 1));
    listOverdue.mockResolvedValue({ rows, asOfDay: '2026-10-11' });

    // Page 2 of every overdue purchase order.
    const second = await open({ status: 'overdue', page: '2' });
    expect(within(second.container).getByText('PO-031')).toBeInTheDocument();
    expect(within(second.container).queryByText('PO-030')).toBeNull();
    expect(second.container.textContent).toContain('Showing 31–45 of 45');
    second.unmount();

    // A search by supplier name (TechSource holds the even numbers), as the
    // other views search: PO number or supplier, any case. One page, so no
    // pager: the rows are the answer.
    const rowsShown = (c: HTMLElement) => c.querySelectorAll('tbody tr').length;
    const searched = await open({ status: 'overdue', q: 'techsource' });
    expect(rowsShown(searched.container)).toBe(22);
    expect(within(searched.container).getByText('PO-002')).toBeInTheDocument();
    expect(within(searched.container).queryByText('PO-001')).toBeNull();
    searched.unmount();

    const byNumber = await open({ status: 'overdue', q: 'po-04' });
    expect(rowsShown(byNumber.container)).toBe(6);
    byNumber.unmount();

    const none = await open({ status: 'overdue', q: 'nothing like it' });
    expect(within(none.container).getByText('No POs match “nothing like it”')).toBeInTheDocument();
  });
});

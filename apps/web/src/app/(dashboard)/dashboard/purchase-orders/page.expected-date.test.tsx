import { render, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A purchase order's expected date is the DAY the buyer picked, stored as that
 * day's midnight UTC (the PO form and both PO imports). The list prints it in
 * three places: the instant table (an organization with up to 800 purchase
 * orders, read in UTC since #331), and, from the server, the On the water
 * card's "ETA" and the server-paged table's Expected column. Those two used
 * formatDateShort with no zone, so they printed the day in the server's zone:
 * the picked day on Vercel (UTC) and the day before on any server west of UTC.
 * All three now read it through @stockpilot/core's formatCalendarDate, the
 * rule the phone and the PO page use.
 */

const listStats = vi.fn();
const listPage = vi.fn();

vi.mock('@/lib/modules/module-gate', () => ({
  checkModuleAccess: vi.fn(async () => ({ enabled: true, canManage: false })),
}));
vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    organizationId: 'org-1',
    userId: 'u1',
    role: 'staff',
    permissions: null,
  })),
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => {
    throw new Error('not read for a staff member');
  }),
}));
vi.mock('@/lib/warehouse-filter', () => ({ getActiveWarehouseFilter: vi.fn(async () => null) }));
vi.mock('@/server/services/purchase-orders', () => ({
  PurchaseOrdersService: { forCurrentUser: vi.fn(async () => ({ listStats, listPage })) },
}));
vi.mock('@/server/services/suppliers', () => ({
  SuppliersService: {
    forCurrentUser: vi.fn(async () => ({
      listForLookups: vi.fn(async () => [{ id: 'sup-1', name: 'Acme' }]),
    })),
  },
}));
vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: ({ href, children }: { href: string; children: React.ReactNode }) =>
      React.createElement('a', { href }, children),
  };
});
vi.mock('@/components/po/po-search', () => ({ PoSearch: () => null }));
vi.mock('@/components/settings/po-approval-panel', () => ({ PoApprovalPanel: () => null }));
vi.mock('@/components/po/po-status-badge', () => ({ PoStatusBadge: () => null }));

import PurchaseOrdersPage from './page';

const OCT_10 = '2026-10-10T00:00:00.000Z';

function stats(totalCount: number) {
  return {
    totalCount,
    totalValue: 1200,
    openCount: 1,
    committedValue: 1200,
    openSupplierCount: 1,
    inboundCount: 1,
    nextEtaPoNumber: 'PO-7',
    nextEtaExpectedAt: OCT_10,
    avgLeadDays: null,
  };
}

const ROW = {
  id: 'po-7',
  po_number: 'PO-7',
  status: 'ordered',
  supplier_id: 'sup-1',
  destination_location_id: null,
  expected_at: OCT_10,
  // Midday UTC, so the Placed day is Oct 1 in every US zone and this test
  // reads only the Expected day.
  ordered_at: '2026-10-01T19:00:00.000Z',
  received_at: null,
  total: 1200,
  created_at: '2026-10-01T19:00:00.000Z',
  updated_at: '2026-10-01T19:00:00.000Z',
  line_count: 3,
};

async function renderList() {
  return render(await PurchaseOrdersPage({ searchParams: Promise.resolve({}) }));
}

/** The text of the row's cell under the Expected header. */
function expectedCell(container: HTMLElement): string | null {
  const headers = Array.from(container.querySelectorAll('th')).map((th) => th.textContent);
  const at = headers.indexOf('Expected');
  const row = within(container).getByText('PO-7', { selector: 'a' }).closest('tr');
  return row?.querySelectorAll('td')[at]?.textContent ?? null;
}

describe('the purchase orders list prints each expected date as the day that was set', () => {
  const previousZone = process.env.TZ;
  beforeEach(() => {
    vi.clearAllMocks();
    listPage.mockResolvedValue({ rows: [ROW], total: 1 });
  });
  afterEach(() => {
    if (previousZone === undefined) delete process.env.TZ;
    else process.env.TZ = previousZone;
  });

  it('server-paged (over 800 purchase orders) on a server in Los Angeles: the ETA card and the Expected column say Oct 10', async () => {
    process.env.TZ = 'America/Los_Angeles';
    listStats.mockResolvedValue(stats(900));
    const { container, getByText } = await renderList();
    expect(getByText('PO-7 · ETA Oct 10')).toBeTruthy();
    expect(expectedCell(container)).toBe('Oct 10');
  });

  it('server-paged on a server in UTC (Vercel): the same words as before', async () => {
    process.env.TZ = 'UTC';
    listStats.mockResolvedValue(stats(900));
    const { container, getByText } = await renderList();
    expect(getByText('PO-7 · ETA Oct 10')).toBeTruthy();
    expect(expectedCell(container)).toBe('Oct 10');
  });

  it('the instant table (800 or fewer) agrees: Oct 10 in Los Angeles', async () => {
    process.env.TZ = 'America/Los_Angeles';
    listStats.mockResolvedValue(stats(1));
    const { container, getByText } = await renderList();
    expect(getByText('PO-7 · ETA Oct 10')).toBeTruthy();
    expect(expectedCell(container)).toBe('Oct 10');
  });
});

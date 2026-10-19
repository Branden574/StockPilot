import { within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { hydrateAcrossClockShift } from '@/test/hydration';

/**
 * CONFLICTS D12: over 800 purchase orders the list is paged on the server, and
 * its Placed column was printed there with formatDateShort, in the server's
 * zone (UTC on Vercel). Placed is an instant, so an order placed at 7:30 PM in
 * Los Angeles on Oct 5 read "Oct 6" to that viewer, for good: the server's text
 * was static. The instant table (800 or fewer) already waited for the
 * viewer's zone; both modes now draw the same client table, so the
 * server-paged list prints no Placed day on the server and the viewer's day
 * once hydrated, with no hydration error.
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
vi.mock('@/lib/nav-labels', () => ({
  effectiveNavLabel: vi.fn(async (_href: string, fallback: string) => fallback),
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
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/components/settings/po-approval-panel', () => ({ PoApprovalPanel: () => null }));

import PurchaseOrdersPage from './page';

/** Oct 6 03:00 UTC: Oct 5, 8 PM in Los Angeles. */
const T0 = Date.parse('2026-10-06T03:00:00.000Z');

const ROW = {
  id: 'po-7',
  po_number: 'PO-7',
  status: 'ordered',
  supplier_id: 'sup-1',
  destination_location_id: null,
  expected_at: '2026-10-10T00:00:00.000Z',
  // 7:30 PM on Oct 5 in Los Angeles; Oct 6 in UTC.
  ordered_at: '2026-10-06T02:30:00.000Z',
  received_at: null,
  total: 1200,
  created_at: '2026-10-01T19:00:00.000Z',
  updated_at: '2026-10-06T02:30:00.000Z',
  line_count: 3,
};

function stats(totalCount: number) {
  return {
    totalCount,
    totalValue: 1200,
    openCount: 1,
    committedValue: 1200,
    openSupplierCount: 1,
    inboundCount: 0,
    nextEtaPoNumber: null,
    nextEtaExpectedAt: null,
    avgLeadDays: null,
  };
}

/** The text of the row's cell under the Placed header. */
function placedCell(container: HTMLElement): string | null {
  const headers = Array.from(container.querySelectorAll('th')).map((th) => th.textContent);
  const at = headers.indexOf('Placed');
  const row = within(container).getByText('PO-7', { selector: 'a' }).closest('tr');
  return row?.querySelectorAll('td')[at]?.textContent ?? null;
}

describe("the server-paged purchase orders list prints Placed as the viewer's day", () => {
  const previousZone = process.env.TZ;
  beforeEach(() => {
    vi.clearAllMocks();
    listPage.mockResolvedValue({ rows: [ROW], total: 1 });
  });
  afterEach(() => {
    if (previousZone === undefined) delete process.env.TZ;
    else process.env.TZ = previousZone;
  });

  it('over 800 purchase orders, rendered by a server in UTC and read in Los Angeles: Oct 5, never Oct 6', async () => {
    listStats.mockResolvedValue(stats(900));
    // The page renders on the server, in UTC as on Vercel.
    process.env.TZ = 'UTC';
    const page = await PurchaseOrdersPage({ searchParams: Promise.resolve({}) });

    const run = await hydrateAcrossClockShift(() => page, {
      serverNow: T0,
      browserNow: T0 + 60_000,
    });
    try {
      expect(run.errors).toEqual([]);
      // The server's day is never printed...
      expect(run.html).not.toContain('Oct 6');
      // ...and the viewer reads their own day once the page has hydrated.
      expect(placedCell(run.container)).toBe('Oct 5');
      // This is the server-paged list: one page of 30 from the server.
      expect(listPage).toHaveBeenCalledWith(expect.objectContaining({ perPage: 30 }));
    } finally {
      run.unmount();
    }
  });

  it('the instant table (800 or fewer) agrees', async () => {
    listStats.mockResolvedValue(stats(1));
    process.env.TZ = 'UTC';
    const page = await PurchaseOrdersPage({ searchParams: Promise.resolve({}) });

    const run = await hydrateAcrossClockShift(() => page, {
      serverNow: T0,
      browserNow: T0 + 60_000,
    });
    try {
      expect(run.errors).toEqual([]);
      expect(run.html).not.toContain('Oct 6');
      expect(placedCell(run.container)).toBe('Oct 5');
      expect(listPage).toHaveBeenCalledWith(expect.objectContaining({ perPage: 800 }));
    } finally {
      run.unmount();
    }
  });
});

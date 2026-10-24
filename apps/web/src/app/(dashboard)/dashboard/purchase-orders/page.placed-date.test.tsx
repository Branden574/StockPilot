import { within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { hydrateAcrossClockShift } from '@/test/hydration';

/**
 * The list's Placed column: the day a purchase order was placed (ordered_at,
 * an instant).
 *
 * CONFLICTS D12: over 800 purchase orders the list is paged on the server, and
 * its Placed column was printed there with formatDateShort, in the server's
 * zone (UTC on Vercel). An order placed at 7:30 PM in Los Angeles on Oct 5
 * read "Oct 6" to that viewer, for good, and one placed at 1:30 AM on Oct 6 in
 * Sydney read "Oct 5". The redesign drew both modes with the same client
 * table, which waited for the viewer's zone.
 *
 * Small fixes slice 8 (item H) prints the ORGANIZATION's day in both modes, as
 * every other instant the slice dates prints it (core org-timezone): the zone
 * comes from the request-cached organization row, an unreadable row is the
 * documented default zone, reported, never an error page. A fixed zone prints
 * the same text on the server and in the browser, so there is no hydration
 * gate and no hydration error, and a viewer outside the organization's zone
 * sees the organization's day. (Owner question in the PR, with this default.)
 */

const listStats = vi.fn();
const listPage = vi.fn();
const getOrgRowForRequest = vi.fn();
const reportError = vi.fn();

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
vi.mock('@/lib/dashboard/request-cache', () => ({
  getOrgRowForRequest: (...args: unknown[]) => getOrgRowForRequest(...args),
}));
vi.mock('@/lib/error-reporter', () => ({
  reportError: (...args: unknown[]) => reportError(...args),
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

/** Renders the page as the server does (in UTC), then hydrates it in `browserZone`. */
async function hydratedPlacedCell(browserZone?: string) {
  process.env.TZ = 'UTC';
  const page = await PurchaseOrdersPage({ searchParams: Promise.resolve({}) });
  return hydrateAcrossClockShift(() => page, {
    serverNow: T0,
    browserNow: T0 + 60_000,
    ...(browserZone ? { browserZone } : {}),
  });
}

const previousZone = process.env.TZ;
beforeEach(() => {
  vi.clearAllMocks();
  listPage.mockResolvedValue({ rows: [ROW], total: 1 });
  getOrgRowForRequest.mockResolvedValue({ timezone: 'America/Los_Angeles' });
});
afterEach(() => {
  if (previousZone === undefined) delete process.env.TZ;
  else process.env.TZ = previousZone;
});

describe("the purchase orders list prints Placed as the organization's day", () => {
  it('over 800 purchase orders, rendered by a server in UTC for a Los Angeles organization: Oct 5, never Oct 6', async () => {
    listStats.mockResolvedValue(stats(900));
    const run = await hydratedPlacedCell();
    try {
      expect(run.errors).toEqual([]);
      // The organization's day is printed by the server itself, never the
      // server's own UTC day, and the browser keeps it.
      expect(run.html).not.toContain('Oct 6');
      expect(run.html).toContain('Oct 5');
      expect(placedCell(run.container)).toBe('Oct 5');
      // This is the server-paged list: one page of 30 from the server.
      expect(listPage).toHaveBeenCalledWith(expect.objectContaining({ perPage: 30 }));
      expect(getOrgRowForRequest).toHaveBeenCalledWith('org-1');
    } finally {
      run.unmount();
    }
  });

  it('the instant table (800 or fewer) agrees', async () => {
    listStats.mockResolvedValue(stats(1));
    const run = await hydratedPlacedCell();
    try {
      expect(run.errors).toEqual([]);
      expect(run.html).not.toContain('Oct 6');
      expect(placedCell(run.container)).toBe('Oct 5');
      expect(listPage).toHaveBeenCalledWith(expect.objectContaining({ perPage: 800 }));
    } finally {
      run.unmount();
    }
  });

  it("a viewer in New York reads the Los Angeles organization's day, with no hydration error", async () => {
    listStats.mockResolvedValue(stats(1));
    // 11:30 PM on Oct 5 in Los Angeles; 2:30 AM on Oct 6 in New York.
    listPage.mockResolvedValue({
      rows: [{ ...ROW, ordered_at: '2026-10-06T06:30:00.000Z' }],
      total: 1,
    });
    const run = await hydratedPlacedCell('America/New_York');
    try {
      expect(run.errors).toEqual([]);
      expect(placedCell(run.container)).toBe('Oct 5');
    } finally {
      run.unmount();
    }
  });

  it("an organization in Sydney: its own day, Oct 6, not the server's Oct 5", async () => {
    listStats.mockResolvedValue(stats(900));
    getOrgRowForRequest.mockResolvedValue({ timezone: 'Australia/Sydney' });
    // 7:30 AM on Oct 5 in Los Angeles; 1:30 AM on Oct 6 in Sydney; Oct 5 in UTC.
    listPage.mockResolvedValue({
      rows: [{ ...ROW, ordered_at: '2026-10-05T14:30:00.000Z' }],
      total: 1,
    });
    const run = await hydratedPlacedCell();
    try {
      expect(run.errors).toEqual([]);
      expect(placedCell(run.container)).toBe('Oct 6');
    } finally {
      run.unmount();
    }
  });

  it('an unreadable organization row is the documented default zone, reported, never an error page', async () => {
    listStats.mockResolvedValue(stats(900));
    getOrgRowForRequest.mockRejectedValue(new Error('getOrgRowForRequest: statement timeout'));
    const run = await hydratedPlacedCell();
    try {
      expect(run.errors).toEqual([]);
      expect(placedCell(run.container)).toBe('Oct 5');
      expect(reportError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          tag: 'purchase_orders.list.org_timezone_failed',
          level: 'warning',
        }),
      );
    } finally {
      run.unmount();
    }
  });
});

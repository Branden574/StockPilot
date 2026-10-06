/**
 * PurchaseOrdersService.overdueCount: the dashboard's "N overdue purchase
 * orders", the Insights page's overdue signal and the morning briefing.
 *
 * A purchase order's expected date is a DAY, stored as that day's midnight UTC.
 * The count filtered `expected_at < now`, so a purchase order expected Oct 10
 * counted as overdue from 5 PM Pacific on Oct 9 (the evening before), and in a
 * Sydney organization from 11 AM on Oct 10 (on the day). The rule (core
 * isPastExpectedDay): overdue once the organization's current date is AFTER the
 * expected day. As a database filter that is `expected_at <` the organization's
 * today at midnight UTC (core pastExpectedDayCutoff): these tests pin the
 * cutoff the query is given, and count the way Postgres compares timestamps.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub, type MockCall, type QueryResult } from '@/test/supabase-mock';

const { getWarehouseAccessMock, getOrgRowForRequestMock, reportErrorMock } = vi.hoisted(() => ({
  getWarehouseAccessMock: vi.fn(),
  getOrgRowForRequestMock: vi.fn(),
  reportErrorMock: vi.fn(),
}));

vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: getWarehouseAccessMock,
  assertWarehouseAccess: vi.fn(),
  forcedWarehouseId: vi.fn(async () => null),
  ForbiddenError: class ForbiddenError extends Error {
    readonly code = 'forbidden' as const;
  },
}));
vi.mock('@/lib/dashboard/request-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/dashboard/request-cache')>()),
  getOrgRowForRequest: getOrgRowForRequestMock,
}));
vi.mock('@/lib/error-reporter', () => ({ reportError: reportErrorMock }));
vi.mock('./audit', () => ({ audit: vi.fn(async () => {}) }));
vi.mock('./integration-events', () => ({ dispatchEvent: vi.fn(async () => {}) }));
vi.mock('./notifications', () => ({ createNotification: vi.fn(async () => 'notif-id') }));
vi.mock('./item-images', () => ({ ItemImagesService: class {} }));
vi.mock('./inventory', () => ({ InventoryService: class {} }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }));

import { PurchaseOrdersService } from './purchase-orders';

const LA = 'America/Los_Angeles';
const SYDNEY = 'Australia/Sydney';

interface PoRow {
  id: string;
  organization_id: string;
  status: string;
  expected_at: string | null;
}

const po = (id: string, expected_at: string | null, status = 'ordered'): PoRow => ({
  id,
  organization_id: 'org-test',
  status,
  expected_at,
});

/** Expected Oct 10, as every writer stores it. */
const OCT_10 = po('po-oct-10', '2026-10-10T00:00:00.000Z');

/**
 * A head count answered as Postgres would: the query's own filters, with the
 * expected date compared as a timestamp (never as text). Any filter it does not
 * know fails the test rather than being ignored.
 */
function countedLikePostgres(rows: PoRow[]) {
  return (call: MockCall): QueryResult => {
    let out = [...rows];
    call.methods.forEach((method, i) => {
      const [col, a, b] = (call.args[i] ?? []) as [keyof PoRow, unknown, unknown];
      switch (method) {
        case 'select':
          break;
        case 'eq':
          out = out.filter((r) => r[col] === a);
          break;
        case 'in':
          out = out.filter((r) => (a as unknown[]).includes(r[col]));
          break;
        case 'not':
          if (a !== 'is' || b !== null) throw new Error(`unexpected .not(${String(col)}, ${String(a)})`);
          out = out.filter((r) => r[col] !== null);
          break;
        case 'lt':
          out = out.filter(
            (r) => r[col] !== null && Date.parse(String(r[col])) < Date.parse(String(a)),
          );
          break;
        default:
          throw new Error(`countedLikePostgres cannot evaluate .${method}()`);
      }
    });
    return { data: null, error: null, count: out.length };
  };
}

function stubFor(zone: string | null, rows: PoRow[]) {
  return makeSupabaseStub({
    'organizations.select': { data: [{ timezone: zone }], error: null },
    'purchase_orders.select': countedLikePostgres(rows),
  });
}

/** The cutoff the count's query was given: its `.lt('expected_at', …)`. */
function cutoffOf(stub: ReturnType<typeof makeSupabaseStub>): unknown {
  const chain = stub.chains.get('purchase_orders.select') ?? [];
  const args = stub.chainArgs.get('purchase_orders.select') ?? [];
  const at = chain.indexOf('lt');
  return at === -1 ? undefined : args[at];
}

async function countAt(at: string, zone: string | null, rows: PoRow[] = [OCT_10]) {
  vi.setSystemTime(new Date(at));
  const stub = stubFor(zone, rows);
  const count = await new PurchaseOrdersService(makeServiceContext(stub.client) as never).overdueCount();
  return { count, stub };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  getWarehouseAccessMock.mockResolvedValue({
    hasAllAccess: true,
    readableIds: [],
    writableIds: [],
    primaryWarehouseId: null,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('overdueCount counts a purchase order only after its expected day, in the organization zone', () => {
  it('Los Angeles: not at 5:30 PM the evening before, not on the day, from midnight after it', async () => {
    // Oct 9, 5:30 PM PDT: the stored midnight (Oct 10 00:00 UTC) is behind
    // this instant, which is what the old filter counted.
    expect((await countAt('2026-10-10T00:30:00.000Z', LA)).count).toBe(0);
    expect((await countAt('2026-10-10T19:00:00.000Z', LA)).count).toBe(0); // Oct 10, noon
    expect((await countAt('2026-10-11T06:59:59.999Z', LA)).count).toBe(0); // Oct 10, 11:59 PM
    expect((await countAt('2026-10-11T07:00:00.000Z', LA)).count).toBe(1); // Oct 11, 12:00 AM
  });

  it('Sydney: not at noon on the expected day, from midnight after it', async () => {
    expect((await countAt('2026-10-09T13:00:00.000Z', SYDNEY)).count).toBe(0); // Oct 10, 12:00 AM
    expect((await countAt('2026-10-10T01:00:00.000Z', SYDNEY)).count).toBe(0); // Oct 10, noon
    expect((await countAt('2026-10-10T13:00:00.000Z', SYDNEY)).count).toBe(1); // Oct 11, 12:00 AM
  });

  it("gives the query the organization's today at midnight UTC as the cutoff", async () => {
    expect(cutoffOf((await countAt('2026-10-10T00:30:00.000Z', LA)).stub)).toEqual([
      'expected_at',
      '2026-10-09T00:00:00.000Z',
    ]);
    expect(cutoffOf((await countAt('2026-10-11T07:00:00.000Z', LA)).stub)).toEqual([
      'expected_at',
      '2026-10-11T00:00:00.000Z',
    ]);
    expect(cutoffOf((await countAt('2026-10-10T01:00:00.000Z', SYDNEY)).stub)).toEqual([
      'expected_at',
      '2026-10-10T00:00:00.000Z',
    ]);
  });

  it('still counts only receivable purchase orders that have an expected date', async () => {
    const rows = [
      po('ordered', '2026-10-08T00:00:00.000Z', 'ordered'),
      po('inbound', '2026-10-08T00:00:00.000Z', 'expected_inbound'),
      po('partial', '2026-10-08T00:00:00.000Z', 'partially_received'),
      po('received', '2026-10-08T00:00:00.000Z', 'received'),
      po('draft', '2026-10-08T00:00:00.000Z', 'draft'),
      po('cancelled', '2026-10-08T00:00:00.000Z', 'cancelled'),
      po('no-date', null, 'ordered'),
      po('today', '2026-10-10T00:00:00.000Z', 'ordered'),
    ];
    expect((await countAt('2026-10-10T19:00:00.000Z', LA, rows)).count).toBe(3);
  });

  it("reads the zone from the organization row (organizations.timezone)", async () => {
    const { stub } = await countAt('2026-10-10T19:00:00.000Z', LA);
    expect(stub.fromCalls).toContain('organizations');
    expect(stub.chains.get('organizations.select')).toEqual(['select', 'eq']);
    expect(stub.chainArgs.get('organizations.select')).toEqual([['timezone'], ['id', 'org-test']]);
  });

  it('on the request’s own cookie session (the dashboard) takes the request-cached org row, with no read of its own', async () => {
    vi.setSystemTime(new Date('2026-10-10T01:00:00.000Z')); // Oct 10, noon in Sydney
    getOrgRowForRequestMock.mockResolvedValue({ timezone: SYDNEY });
    const stub = stubFor(LA, [OCT_10]);
    const ctx = { ...makeServiceContext(stub.client), cookieClient: stub.client };
    const count = await new PurchaseOrdersService(ctx as never).overdueCount();
    expect(getOrgRowForRequestMock).toHaveBeenCalledWith('org-test');
    expect(stub.fromCalls).not.toContain('organizations');
    expect(count).toBe(0);
    expect(cutoffOf(stub)).toEqual(['expected_at', '2026-10-10T00:00:00.000Z']);
  });

  it('an unreadable organization row falls back to the documented default zone, and is reported', async () => {
    vi.setSystemTime(new Date('2026-10-10T00:30:00.000Z')); // Oct 9, 5:30 PM in Los Angeles
    const stub = makeSupabaseStub({
      'organizations.select': { data: null, error: { message: 'permission denied' } },
      'purchase_orders.select': countedLikePostgres([OCT_10]),
    });
    const count = await new PurchaseOrdersService(makeServiceContext(stub.client) as never).overdueCount();
    expect(count).toBe(0);
    expect(cutoffOf(stub)).toEqual(['expected_at', '2026-10-09T00:00:00.000Z']);
    expect(reportErrorMock).toHaveBeenCalledTimes(1);
    expect(reportErrorMock.mock.calls[0]![1]).toMatchObject({
      tag: 'purchase-orders.overdue_count.org_timezone',
      level: 'warning',
    });
  });
});

/**
 * PurchaseOrdersService.listOverdue: the rows behind the purchase orders
 * list's Overdue view (small fixes slice 8, item E). The dashboard's "N
 * overdue purchase orders" links to /dashboard/purchase-orders?status=overdue,
 * but the list had no such view and showed All (follow-up from #338).
 *
 * The view must list exactly what the dashboard counts (overdueCount, #338's
 * rule: receivable, not fully received, and the organization's date is after
 * the expected day; `expected_at <` the organization's today at midnight UTC,
 * core pastExpectedDayCutoff), with the same warehouse scope. Both are built
 * from one filter here, and this file answers both queries the way PostgREST
 * and Postgres would, so a filter dropped from either fails.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub, type MockCall, type QueryResult } from '@/test/supabase-mock';

const { getWarehouseAccessMock } = vi.hoisted(() => ({ getWarehouseAccessMock: vi.fn() }));

vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: getWarehouseAccessMock,
  assertWarehouseAccess: vi.fn(),
  forcedWarehouseId: vi.fn(async () => null),
  ForbiddenError: class ForbiddenError extends Error {
    readonly code = 'forbidden' as const;
  },
}));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn() }));
vi.mock('./audit', () => ({ audit: vi.fn(async () => {}) }));
vi.mock('./integration-events', () => ({ dispatchEvent: vi.fn(async () => {}) }));
vi.mock('./notifications', () => ({ createNotification: vi.fn(async () => 'notif-id') }));
vi.mock('./item-images', () => ({ ItemImagesService: class {} }));
vi.mock('./inventory', () => ({ InventoryService: class {} }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }));

import { ServiceError } from './context';
import { PurchaseOrdersService } from './purchase-orders';

const WH_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const WH_B = 'aaaaaaaa-0000-4000-8000-000000000002';

interface Row {
  id: string;
  organization_id: string;
  po_number: string;
  status: string;
  supplier_id: string | null;
  destination_location_id: string | null;
  expected_at: string | null;
  ordered_at: string | null;
  received_at: string | null;
  total: number;
  created_at: string;
  updated_at: string;
  /** The embedded destination location, as PostgREST would join it. */
  destination: { warehouse_id: string | null } | null;
  purchase_order_items: Array<{ count: number }>;
}

let seq = 0;
function po(status: string, expected_at: string | null, over: Partial<Row> = {}): Row {
  seq += 1;
  return {
    id: `po-${seq}`,
    organization_id: 'org-test',
    po_number: `PO-${String(seq).padStart(3, '0')}`,
    status,
    supplier_id: null,
    destination_location_id: 'loc-a',
    expected_at,
    ordered_at: '2026-10-01T17:00:00.000Z',
    received_at: null,
    total: 100,
    created_at: `2026-10-0${(seq % 9) + 1}T12:00:00.000Z`,
    updated_at: '2026-10-01T17:00:00.000Z',
    destination: { warehouse_id: WH_A },
    purchase_order_items: [{ count: seq }],
    ...over,
  };
}

/**
 * purchase_orders answered as PostgREST and Postgres would: the query's own
 * filters (timestamps compared as instants, a filter on the embedded
 * destination dropping rows the inner join drops), its order and range, and a
 * head count when asked. Any other method fails the test.
 */
function servedLikePostgres(rows: Row[]) {
  return (call: MockCall): QueryResult => {
    let out = [...rows];
    let from = 0;
    let to = 999;
    let head = false;
    const order: Array<{ col: keyof Row; ascending: boolean }> = [];
    call.methods.forEach((method, i) => {
      const [col, a, b] = (call.args[i] ?? []) as [string, unknown, unknown];
      const value = (r: Row): unknown =>
        col.startsWith('destination.') ? r.destination?.[col.slice(12) as 'warehouse_id'] : r[col as keyof Row];
      switch (method) {
        case 'select':
          head = (a as { head?: boolean } | undefined)?.head === true;
          if (String(col).includes('!inner')) out = out.filter((r) => r.destination !== null);
          break;
        case 'eq':
          out = out.filter((r) => value(r) === a);
          break;
        case 'in':
          out = out.filter((r) => (a as unknown[]).includes(value(r)));
          break;
        case 'not':
          if (a !== 'is' || b !== null) throw new Error(`unexpected .not(${col}, ${String(a)})`);
          out = out.filter((r) => value(r) !== null);
          break;
        case 'lt':
          out = out.filter((r) => value(r) !== null && Date.parse(String(value(r))) < Date.parse(String(a)));
          break;
        case 'order':
          order.push({ col: col as keyof Row, ascending: (a as { ascending?: boolean })?.ascending !== false });
          break;
        case 'range':
          from = Number(col);
          to = Number(a);
          break;
        default:
          throw new Error(`servedLikePostgres cannot evaluate .${method}()`);
      }
    });
    if (head) return { data: null, error: null, count: out.length };
    out.sort((x, y) => {
      for (const { col, ascending } of order) {
        const c = String(x[col]) < String(y[col]) ? -1 : String(x[col]) > String(y[col]) ? 1 : 0;
        if (c !== 0) return ascending ? c : -c;
      }
      return 0;
    });
    return { data: out.slice(from, to + 1), error: null };
  };
}

function svcFor(rows: Row[], zone = 'America/Los_Angeles') {
  const stub = makeSupabaseStub({
    'organizations.select': { data: [{ timezone: zone }], error: null },
    'purchase_orders.select': servedLikePostgres(rows),
  });
  return { stub, svc: new PurchaseOrdersService(makeServiceContext(stub.client) as never) };
}

beforeEach(() => {
  vi.clearAllMocks();
  seq = 0;
  vi.useFakeTimers({ toFake: ['Date'] });
  // Oct 10, noon in Los Angeles.
  vi.setSystemTime(new Date('2026-10-10T19:00:00.000Z'));
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

describe('listOverdue lists exactly what the dashboard counts', () => {
  it('receivable purchase orders past their expected day in the organization zone, newest first, as many as overdueCount says', async () => {
    const rows = [
      po('ordered', '2026-10-08T00:00:00.000Z'),
      po('expected_inbound', '2026-10-09T00:00:00.000Z'),
      po('partially_received', '2026-09-30T00:00:00.000Z'),
      po('received', '2026-10-08T00:00:00.000Z'),
      po('draft', '2026-10-08T00:00:00.000Z'),
      po('cancelled', '2026-10-08T00:00:00.000Z'),
      po('ordered', null),
      // Expected today: not overdue until tomorrow in Los Angeles.
      po('ordered', '2026-10-10T00:00:00.000Z'),
      // Another organization's.
      po('ordered', '2026-10-01T00:00:00.000Z', { organization_id: 'org-other' }),
    ];
    const { svc } = svcFor(rows);

    const listed = await svc.listOverdue();
    const counted = await svc.overdueCount();

    expect(listed.rows.map((r) => r.status).sort()).toEqual(['expected_inbound', 'ordered', 'partially_received']);
    expect(listed.rows).toHaveLength(counted);
    expect(counted).toBe(3);
    // Newest first, as the list's other views.
    const created = listed.rows.map((r) => r.created_at);
    expect(created).toEqual([...created].sort().reverse());
    // Each row in the list's own shape, with its line count.
    expect(listed.rows[0]).toEqual(
      expect.objectContaining({ id: expect.any(String), po_number: expect.any(String), line_count: expect.any(Number) }),
    );
    expect(listed.rows[0]).not.toHaveProperty('destination');
    expect(listed.rows[0]).not.toHaveProperty('purchase_order_items');
    // The organization's day the rule was applied on.
    expect(listed.asOfDay).toBe('2026-10-10');
  });

  it('east of UTC the day is the organization\'s too (Sydney: Oct 11 already)', async () => {
    const rows = [po('ordered', '2026-10-10T00:00:00.000Z')];
    const { svc } = svcFor(rows, 'Australia/Sydney');
    const listed = await svc.listOverdue();
    expect(listed.asOfDay).toBe('2026-10-11');
    expect(listed.rows).toHaveLength(1);
    expect(await svc.overdueCount()).toBe(1);
  });

  it('a member scoped to warehouses lists only their warehouses, as the count counts', async () => {
    getWarehouseAccessMock.mockResolvedValue({
      hasAllAccess: false,
      readableIds: [WH_A],
      writableIds: [WH_A],
      primaryWarehouseId: WH_A,
    });
    const rows = [
      po('ordered', '2026-10-01T00:00:00.000Z'),
      po('ordered', '2026-10-01T00:00:00.000Z', { destination: { warehouse_id: WH_B } }),
      po('ordered', '2026-10-01T00:00:00.000Z', { destination_location_id: null, destination: null }),
    ];
    const { svc } = svcFor(rows);
    const listed = await svc.listOverdue();
    expect(listed.rows).toHaveLength(1);
    expect(await svc.overdueCount()).toBe(1);
  });

  it('the warehouse picked in the header narrows an all-access member, as on the dashboard', async () => {
    const rows = [
      po('ordered', '2026-10-01T00:00:00.000Z'),
      po('ordered', '2026-10-01T00:00:00.000Z', { destination: { warehouse_id: WH_B } }),
    ];
    const { svc } = svcFor(rows);
    expect((await svc.listOverdue({ warehouseId: WH_B })).rows).toHaveLength(1);
    expect(await svc.overdueCount({ warehouseId: WH_B })).toBe(1);
    expect((await svc.listOverdue()).rows).toHaveLength(2);
  });

  it('a member with no readable warehouse lists nothing, as the count counts nothing', async () => {
    getWarehouseAccessMock.mockResolvedValue({
      hasAllAccess: false,
      readableIds: [],
      writableIds: [],
      primaryWarehouseId: null,
    });
    const { svc, stub } = svcFor([po('ordered', '2026-10-01T00:00:00.000Z')]);
    expect((await svc.listOverdue()).rows).toEqual([]);
    expect(stub.fromCalls).not.toContain('purchase_orders');
  });

  it('pages past 1000 rows (an organization that is very behind still sees every one)', async () => {
    const rows = Array.from({ length: 1205 }, () => po('ordered', '2026-10-01T00:00:00.000Z'));
    const { svc } = svcFor(rows);
    expect((await svc.listOverdue()).rows).toHaveLength(1205);
  });

  it('a failed read is an error, never an empty view', async () => {
    const stub = makeSupabaseStub({
      'organizations.select': { data: [{ timezone: 'America/Los_Angeles' }], error: null },
      'purchase_orders.select': { data: null, error: { message: 'statement timeout' } },
    });
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client) as never);
    await expect(svc.listOverdue()).rejects.toBeInstanceOf(ServiceError);
  });
});

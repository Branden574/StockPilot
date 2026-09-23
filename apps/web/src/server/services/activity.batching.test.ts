import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The movement label lookups batch their id lists.
 *
 * The movements export reaches up to 50,000 rows and the rental items page
 * passes every rental item, so these id lists have no ceiling. One `.in()`
 * past ~215 uuids fails with a 414 locally and a bare "fetch failed" in
 * production (after ~7 s of retries). Labels are cosmetic, so a failure
 * degrades to the fallback label AND is reported, never silently.
 */

const reportError = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/lib/error-reporter', () => ({ reportError }));
vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: vi.fn(async () => ({
    readableIds: ['wh-a'],
    writableIds: ['wh-a'],
    hasAllAccess: true,
    primaryWarehouseId: 'wh-a',
  })),
}));

import {
  inFilters,
  makeServiceContext,
  makeSupabaseStub,
  type MockCall,
} from '@/test/supabase-mock';

import {
  resolveBundleNames,
  resolveOrderNumbers,
  resolveReceiptPoNumbers,
  resolveReturnNumbers,
} from './activity';
import { getItemTrends, MovementsService } from './movements';

const uuid = (i: number, prefix = '0') =>
  `${prefix.repeat(8)}-0000-4000-8000-${String(i).padStart(12, '0')}`;
const ids = (n: number, prefix?: string) => Array.from({ length: n }, (_, i) => uuid(i, prefix));

/** Serves one row per requested id, recording every `.in` list. */
function perIdTable(row: (id: string) => Record<string, unknown>, failBatch?: number) {
  const lists: unknown[][] = [];
  const fn = (call: MockCall) => {
    const list = inFilters(call).find(([c]) => c === 'id' || c === 'item_id')?.[1] ?? [];
    lists.push(list);
    if (failBatch !== undefined && lists.length === failBatch) {
      return { data: null, error: { message: 'URI too long' } };
    }
    return { data: (list as string[]).map(row), error: null };
  };
  return { fn, lists };
}

beforeEach(() => {
  reportError.mockClear();
});

describe('activity label resolvers', () => {
  const cases = [
    {
      name: 'resolveReceiptPoNumbers',
      table: 'receipts',
      run: (ctx: ReturnType<typeof makeServiceContext>, list: string[]) =>
        resolveReceiptPoNumbers(ctx, list),
      row: (id: string) => ({ id, purchase_orders: { po_number: `PO-${id.slice(-3)}` } }),
      tag: 'activity.receipt_po_numbers',
    },
    {
      name: 'resolveOrderNumbers',
      table: 'order_requests',
      run: (ctx: ReturnType<typeof makeServiceContext>, list: string[]) =>
        resolveOrderNumbers(ctx, list),
      row: (id: string) => ({ id, order_number: Number(id.slice(-3)) + 1 }),
      tag: 'activity.order_numbers',
    },
    {
      name: 'resolveReturnNumbers',
      table: 'returns',
      run: (ctx: ReturnType<typeof makeServiceContext>, list: string[]) =>
        resolveReturnNumbers(ctx, list),
      row: (id: string) => ({ id, return_number: `RMA-${id.slice(-3)}` }),
      tag: 'activity.return_numbers',
    },
    {
      name: 'resolveBundleNames',
      table: 'bundles',
      run: (ctx: ReturnType<typeof makeServiceContext>, list: string[]) =>
        resolveBundleNames(ctx, list),
      row: (id: string) => ({ id, name: `Kit ${id.slice(-3)}` }),
      tag: 'activity.bundle_names',
    },
  ];

  it.each(cases)('$name resolves 250 ids in batches of at most 100', async (c) => {
    const t = perIdTable(c.row);
    const stub = makeSupabaseStub({ [`${c.table}.select`]: t.fn });
    const map = await c.run(makeServiceContext(stub.client), ids(250));
    expect(t.lists.map((l) => l.length)).toEqual([100, 100, 50]);
    expect(map.size).toBe(250);
    // A label from the last batch is present: nothing past the first batch was lost.
    expect(map.has(uuid(249))).toBe(true);
  });

  it.each(cases)('$name degrades to an empty map and reports when a batch fails', async (c) => {
    const t = perIdTable(c.row, 2);
    const stub = makeSupabaseStub({ [`${c.table}.select`]: t.fn });
    const map = await c.run(makeServiceContext(stub.client), ids(250));
    expect(map.size).toBe(0);
    expect(reportError).toHaveBeenCalledTimes(1);
    const [, ctx] = reportError.mock.calls[0] as unknown as [
      Error,
      { tag: string; level: string; extra: Record<string, unknown> },
    ];
    expect(ctx.tag).toBe(c.tag);
    expect(ctx.level).toBe('warning');
    expect(ctx.extra.detail).toBe('URI too long');
  });
});

describe('getItemTrends', () => {
  it('reads movements for 250 items in batches of at most 100', async () => {
    const lists: unknown[][] = [];
    const stub = makeSupabaseStub({
      'stock_movements.select': (call) => {
        const list = inFilters(call).find(([c]) => c === 'item_id')?.[1] ?? [];
        lists.push(list);
        return {
          data: (list as string[]).map((item_id) => ({
            item_id,
            quantity_change: 1,
            created_at: new Date().toISOString(),
          })),
          error: null,
        };
      },
    });
    const items = ids(250).map((id) => ({ id, quantityOnHand: 5 }));
    const trends = await getItemTrends(items, { ctx: makeServiceContext(stub.client) });
    expect(lists.map((l) => l.length)).toEqual([100, 100, 50]);
    expect(trends.size).toBe(250);
    // The last item's movement was read (its move series is not all zeros).
    expect(trends.get(uuid(249))?.moveSeries.some((n) => n !== 0)).toBe(true);
  });
});

describe('MovementsService.exportRows location names', () => {
  function movementRows(n: number) {
    return Array.from({ length: n }, (_, i) => ({
      id: uuid(i, '1'),
      movement_type: 'transfer',
      quantity_change: 0,
      previous_quantity: 1,
      new_quantity: 1,
      from_location_id: uuid(i, '2'),
      to_location_id: uuid(i, '3'),
      reference_type: null,
      reference_id: null,
      reason: null,
      notes: null,
      created_at: '2026-09-01T00:00:00Z',
      item_id: uuid(i, '4'),
      user_id: null,
      item: { id: uuid(i, '4'), name: 'Item', sku: 'SKU', warehouse_id: 'wh-a', deleted_at: null },
      actor: null,
    }));
  }

  function service(client: unknown) {
    return new (MovementsService as unknown as new (ctx: unknown) => MovementsService)(
      makeServiceContext(client),
    );
  }

  it('names every location of a 150-movement export (300 location ids)', async () => {
    const lists: unknown[][] = [];
    const stub = makeSupabaseStub({
      'stock_movements.select': { data: movementRows(150), error: null, count: 150 },
      'locations.select': (call) => {
        const list = inFilters(call).find(([c]) => c === 'id')?.[1] ?? [];
        lists.push(list);
        return {
          data: (list as string[]).map((id) => ({ id, name: `L-${id.slice(0, 1)}` })),
          error: null,
        };
      },
    });
    const { rows } = await service(stub.client).exportRows({});
    expect(lists.map((l) => l.length)).toEqual([100, 100, 100]);
    expect(rows).toHaveLength(150);
    expect(rows.every((r) => r.fromLocation === 'L-2' && r.toLocation === 'L-3')).toBe(true);
  });

  it('leaves location cells blank and reports when the lookup fails', async () => {
    let n = 0;
    const stub = makeSupabaseStub({
      'stock_movements.select': { data: movementRows(150), error: null, count: 150 },
      'locations.select': () => {
        n += 1;
        return n === 3
          ? { data: null, error: { message: 'fetch failed' } }
          : { data: [], error: null };
      },
    });
    const { rows } = await service(stub.client).exportRows({});
    expect(rows).toHaveLength(150);
    expect(rows.every((r) => r.fromLocation === null)).toBe(true);
    const tags = reportError.mock.calls.map(
      (c) => (c as unknown as [Error, { tag: string }])[1].tag,
    );
    expect(tags).toContain('movements.export.location_names');
  });
});

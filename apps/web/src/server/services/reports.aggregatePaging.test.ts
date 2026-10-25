import { describe, expect, it, vi } from 'vitest';

/**
 * The per-item and per-bundle report aggregates are read in full (B32).
 *
 * report_item_out_movements (velocity classes, dead stock) and the two bundle
 * activity aggregates return one row per item or bundle, and were read in one
 * unpaged request. PostgREST answers any request with at most 1000 rows
 * (`max_rows`), with no error, so past 1000 rows:
 *   - velocity: an item that moved got no units out and was classed D (dead),
 *     and the total value out was short;
 *   - dead stock: an item that moved was listed as dead stock;
 *   - bundle activity: bundles and their runs, kits and value went missing
 *     from the totals.
 * Each read is now paged in 1000-row windows in a stable order, and a refusal
 * is still mapped to its own words (reportRpcError).
 *
 * The stub answers the aggregates like PostgREST (servedLikePostgrest): an
 * unpaged call gets the first 1000 rows, as production would.
 */

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => {
    throw new Error('ReportsService must not use the service-role client (0380)');
  },
}));

import {
  callArgs,
  makeServiceContext,
  makeSupabaseStub,
  servedLikePostgrest,
  type MockCall,
} from '@/test/supabase-mock';

import { ServiceError } from './context';
import { ReportsService } from './reports';

const uuid = (i: number) => `bbbbbbbb-0000-4000-8000-${String(i).padStart(12, '0')}`;
const SINCE = '2026-10-01T00:00:00.000Z';

/** A detail stream that honours only `.range()` (its `.or()` filter is not
 *  what these tests are about), the way fetchAllRows pages it. */
function ranged(rows: Array<Record<string, unknown>>) {
  return (call: MockCall) => {
    const [from, to] = (callArgs(call, 'range') ?? [0, 999]) as [number, number];
    return { data: rows.slice(from, Math.min(to, from + 999) + 1), error: null };
  };
}

function items(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: uuid(i),
    sku: `SKU-${i}`,
    name: `Item ${i}`,
    quantity_on_hand: 2,
    unit_cost: 1,
    created_at: '2025-01-01T00:00:00.000Z',
    warehouse: { name: 'Main' },
    category: null,
  }));
}

/** Every one of the n items moved out once in the window. */
function outMovements(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    item_id: uuid(i),
    units_out: 1,
    last_out_at: SINCE,
  }));
}

/** n bundles, each run once for 2 kits, with 3 of component value out. */
function bundles(n: number) {
  return {
    activity: Array.from({ length: n }, (_, i) => ({
      bundle_id: uuid(i),
      bundle_name: `Kit ${i}`,
      bundle_sku: `KIT-${i}`,
      runs: 1,
      kits_out: 2,
      last_run_at: SINCE,
      top_warehouse_name: 'Main',
    })),
    value: Array.from({ length: n }, (_, i) => ({ bundle_id: uuid(i), component_value_out: 3 })),
  };
}

/**
 * PostgREST over a function with no ORDER BY of its own. Every page re-runs
 * the function, and without an `.order()` one run's rows can come back in
 * another order than the last run's: here the first page comes back in key
 * order and every later page in reverse, so offset pages repeat some rows and
 * skip others, as an unordered plan can. With `.order()` it answers in that
 * order, like servedLikePostgrest. Keyed on the window asked for, not on a
 * counter: the stub answers a chained rpc twice.
 */
function unstableUnlessOrdered(rows: Array<Record<string, unknown>>) {
  const inKeyOrder = servedLikePostgrest(rows);
  const reversed = servedLikePostgrest([...rows].reverse());
  return (call: MockCall) => {
    if (call.methods.includes('order')) return inKeyOrder(call);
    const from = (callArgs(call, 'range')?.[0] as number | undefined) ?? 0;
    return from === 0 ? inKeyOrder(call) : reversed(call);
  };
}

/** Answers like servedLikePostgrest, and records the window each page asked
 *  for after checking that the page is in `key` order. */
function pagesInKeyOrder(rows: Array<Record<string, unknown>>, key: string) {
  const pages: unknown[][] = [];
  const served = servedLikePostgrest(rows);
  const answer = (call: MockCall) => {
    if (call.methods.length > 1) {
      expect(callArgs(call, 'order'), key).toEqual([key, { ascending: true }]);
      pages.push(callArgs(call, 'range') ?? []);
    }
    return served(call);
  };
  return { pages, answer };
}

function svcWith(results: Parameters<typeof makeSupabaseStub>[0]) {
  const stub = makeSupabaseStub(results);
  return { svc: new ReportsService(makeServiceContext(stub.client)), stub };
}

/** The aggregate reads the code awaited (the stub also answers a chained rpc
 *  once at call time, before its chain exists). */
function awaitedRpcRanges(stub: ReturnType<typeof makeSupabaseStub>, fn: string) {
  return stub.rpcCalls.filter((c) => c.name === fn).length;
}

describe('velocityClass: every item that moved counts', () => {
  it('1000 out-moving items: none is classed dead', async () => {
    const { svc } = svcWith({
      'rpc:report_item_out_movements': servedLikePostgrest(outMovements(1000)),
      'inventory_items.select': ranged(items(1000)),
    });
    const report = await svc.velocityClass(90);
    expect(report.summary.D).toBe(0);
    expect(report.totalValueOut).toBe(1000);
  });

  // Mutation caught: the unpaged rpc read.
  it('1001 out-moving items: none is classed dead, and the value out counts all 1001', async () => {
    const { svc } = svcWith({
      'rpc:report_item_out_movements': servedLikePostgrest(outMovements(1001)),
      'inventory_items.select': ranged(items(1001)),
    });
    const report = await svc.velocityClass(90);
    expect(report.rows).toHaveLength(1001);
    expect(report.summary.D).toBe(0);
    expect(report.totalValueOut).toBe(1001);
  });
});

describe('deadStock: an item that moved is never dead stock', () => {
  it('1000 stocked items that all moved: no dead stock', async () => {
    const { svc } = svcWith({
      'rpc:report_item_out_movements': servedLikePostgrest(outMovements(1000)),
      'inventory_items.select': ranged(items(1000)),
    });
    expect((await svc.deadStock(90)).rows).toEqual([]);
  });

  // Mutation caught: the unpaged rpc read listed the 1001st item as dead.
  it('1001 stocked items that all moved: no dead stock', async () => {
    const { svc } = svcWith({
      'rpc:report_item_out_movements': servedLikePostgrest(outMovements(1001)),
      'inventory_items.select': ranged(items(1001)),
    });
    const report = await svc.deadStock(90);
    expect(report.rows).toEqual([]);
    expect(report.itemCount).toBe(0);
  });

  it('pages the aggregate in item_id order, a window at a time', async () => {
    const pages: unknown[][] = [];
    const served = servedLikePostgrest(outMovements(1001));
    const { svc } = svcWith({
      'rpc:report_item_out_movements': (call) => {
        if (call.methods.length > 1) {
          expect(callArgs(call, 'order')).toEqual(['item_id', { ascending: true }]);
          pages.push(callArgs(call, 'range') ?? []);
        }
        return served(call);
      },
      'inventory_items.select': ranged(items(3)),
    });
    await svc.deadStock(90);
    expect(pages).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
  });
});

describe('bundleActivity: every bundle counts in the totals', () => {
  it('1000 bundles: all of them', async () => {
    const b = bundles(1000);
    const { svc } = svcWith({
      'rpc:report_bundle_activity': servedLikePostgrest(b.activity),
      'rpc:report_bundle_component_value': servedLikePostgrest(b.value),
    });
    const report = await svc.bundleActivity(90);
    expect(report.rows).toHaveLength(1000);
    expect(report.totalValueOut).toBe(3000);
  });

  // Mutation caught: either aggregate read unpaged.
  it('1001 bundles: all of them, with every bundle in the runs, kits and value totals', async () => {
    const b = bundles(1001);
    const { svc } = svcWith({
      'rpc:report_bundle_activity': servedLikePostgrest(b.activity),
      'rpc:report_bundle_component_value': servedLikePostgrest(b.value),
    });
    const report = await svc.bundleActivity(90);
    expect(report.rows).toHaveLength(1001);
    expect(report.totalRuns).toBe(1001);
    expect(report.totalKits).toBe(2002);
    expect(report.totalValueOut).toBe(3003);
    expect(report.rows.every((r) => r.componentValueOut === 3)).toBe(true);
  });
});

// Each page re-runs the aggregate, so offset pages only fit together when
// every page asks for the same order on the function's unique key. Only dead
// stock's order was checked (above); velocity class and both bundle reads
// could lose theirs with every test green, and then repeat some rows and skip
// others past 1000.
describe('every aggregate read pages in the order of its unique key', () => {
  it('the stand-in plan repeats and skips rows when a read pages without an order (vacuity control)', () => {
    const answer = unstableUnlessOrdered(outMovements(1001));
    const page = (from: number) =>
      (
        answer({
          table: 'report_item_out_movements',
          op: 'rpc',
          methods: ['rpc', 'range'],
          args: [[{}], [from, from + 999]],
        }).data as Array<{ item_id: string }>
      ).map((r) => r.item_id);
    const seen = [...page(0), ...page(1000)];
    expect(seen).toHaveLength(1001);
    expect(new Set(seen).size).toBe(1000);
    expect(seen).not.toContain(uuid(1000));
  });

  // Mutation caught: velocityClass's read without `.order('item_id')` (the
  // 1001st item, skipped, was classed D).
  it('velocity class: each of 1001 items that moved is counted, none is classed D', async () => {
    const { svc } = svcWith({
      'rpc:report_item_out_movements': unstableUnlessOrdered(outMovements(1001)),
      'inventory_items.select': ranged(items(1001)),
    });
    const report = await svc.velocityClass(90);
    expect(report.summary.D).toBe(0);
    expect(report.totalValueOut).toBe(1001);
  });

  // Mutation caught: deadStock's read without `.order('item_id')`.
  it('dead stock: none of 1001 stocked items that moved is listed', async () => {
    const { svc } = svcWith({
      'rpc:report_item_out_movements': unstableUnlessOrdered(outMovements(1001)),
      'inventory_items.select': ranged(items(1001)),
    });
    expect((await svc.deadStock(90)).rows).toEqual([]);
  });

  // Mutation caught: the bundle activity read without `.order('bundle_id')`
  // (one bundle twice, another missing).
  it('bundle activity: each of 1001 bundles once', async () => {
    const b = bundles(1001);
    const { svc } = svcWith({
      'rpc:report_bundle_activity': unstableUnlessOrdered(b.activity),
      'rpc:report_bundle_component_value': servedLikePostgrest(b.value),
    });
    const report = await svc.bundleActivity(90);
    expect(report.rows).toHaveLength(1001);
    expect(new Set(report.rows.map((r) => r.bundleId)).size).toBe(1001);
  });

  // Mutation caught: the component value read without `.order('bundle_id')`
  // (the skipped bundle's value was left out of the total).
  it("bundle component value: every bundle's value counts", async () => {
    const b = bundles(1001);
    const { svc } = svcWith({
      'rpc:report_bundle_activity': servedLikePostgrest(b.activity),
      'rpc:report_bundle_component_value': unstableUnlessOrdered(b.value),
    });
    const report = await svc.bundleActivity(90);
    expect(report.totalValueOut).toBe(3003);
    expect(report.rows.every((r) => r.componentValueOut === 3)).toBe(true);
  });

  it('velocity class asks for item_id order, a window at a time', async () => {
    const out = pagesInKeyOrder(outMovements(1001), 'item_id');
    const { svc } = svcWith({
      'rpc:report_item_out_movements': out.answer,
      'inventory_items.select': ranged(items(3)),
    });
    await svc.velocityClass(90);
    expect(out.pages).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
  });

  it('both bundle reads ask for bundle_id order, a window at a time', async () => {
    const b = bundles(1001);
    const activity = pagesInKeyOrder(b.activity, 'bundle_id');
    const value = pagesInKeyOrder(b.value, 'bundle_id');
    const { svc } = svcWith({
      'rpc:report_bundle_activity': activity.answer,
      'rpc:report_bundle_component_value': value.answer,
    });
    await svc.bundleActivity(90);
    for (const read of [activity, value]) {
      expect(read.pages).toEqual([
        [0, 999],
        [1000, 1999],
      ]);
    }
  });
});

describe('a refused aggregate keeps its own words', () => {
  it('forbidden from the function is a forbidden ServiceError, not an internal error', async () => {
    const { svc } = svcWith({
      'rpc:report_item_out_movements': {
        data: null,
        error: { message: 'forbidden', code: '42501', hint: 'forbidden' },
      },
      'inventory_items.select': ranged(items(1)),
    });
    const err = await svc.velocityClass(90).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe('forbidden');
  });

  it('a module turned off answers module_disabled', async () => {
    const { svc } = svcWith({
      'rpc:report_bundle_activity': {
        data: null,
        error: { message: 'module disabled', code: 'P0001', hint: 'module_disabled' },
      },
      'rpc:report_bundle_component_value': { data: [], error: null },
    });
    const err = await svc.bundleActivity(90).catch((e: unknown) => e);
    expect((err as ServiceError).code).toBe('module_disabled');
  });

  it('a failed second page fails the report instead of showing the first page as the whole', async () => {
    const first = outMovements(1000);
    const { svc } = svcWith({
      'rpc:report_item_out_movements': (call) =>
        (callArgs(call, 'range')?.[0] as number | undefined) === 1000
          ? { data: null, error: { message: 'canceling statement due to statement timeout' } }
          : { data: first, error: null },
      'inventory_items.select': ranged(items(1)),
    });
    const err = await svc.velocityClass(90).catch((e: unknown) => e);
    expect((err as ServiceError).code).toBe('internal_error');
  });
});

it('the aggregates are still read once per report run (one call per page)', async () => {
  const { svc, stub } = svcWith({
    'rpc:report_item_out_movements': servedLikePostgrest(outMovements(5)),
    'inventory_items.select': ranged(items(5)),
  });
  await svc.velocityClass(90);
  expect(awaitedRpcRanges(stub, 'report_item_out_movements')).toBe(1);
});

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

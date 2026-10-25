import { afterEach, describe, expect, it, vi } from 'vitest';

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
 *
 * Each read is now paged by KEY (integrator decision 2): every page asks for
 * the rows after the last key it has, in key order, PAGE_SIZE at a time. Each
 * page re-runs the aggregate, so an OFFSET window shifts when a row appears or
 * goes between two pages: a row could be counted twice or skipped. A key
 * cursor never repeats a row and never skips one that was there all along.
 * The read is bounded at AGGREGATE_MAX_PAGES pages: past it the report fails
 * with a log line, never a set cut short without a word. A refusal is still
 * mapped to its own words (reportRpcError).
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
import { PAGE_SIZE } from './lib/paginate';
import { AGGREGATE_MAX_PAGES, ReportsService } from './reports';

const uuid = (i: number) => `bbbbbbbb-0000-4000-8000-${String(i).padStart(12, '0')}`;
const SINCE = '2026-10-01T00:00:00.000Z';

afterEach(() => {
  vi.restoreAllMocks();
});

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

/** One bundle's activity row: run once for 2 kits. */
function activityRow(bundleId: string) {
  return {
    bundle_id: bundleId,
    bundle_name: `Kit ${bundleId.slice(-4)}`,
    bundle_sku: `KIT-${bundleId.slice(-4)}`,
    runs: 1,
    kits_out: 2,
    last_run_at: SINCE,
    top_warehouse_name: 'Main',
  };
}

/** n bundles, each run once for 2 kits, with 3 of component value out. */
function bundles(n: number) {
  return {
    activity: Array.from({ length: n }, (_, i) => activityRow(uuid(i))),
    value: Array.from({ length: n }, (_, i) => ({ bundle_id: uuid(i), component_value_out: 3 })),
  };
}

/** True for the read the code awaited: the stub also answers a chained rpc
 *  once at call time, before its chain exists (supabase-mock makeRpcChain). */
const awaited = (call: MockCall) => call.methods.length > 1;

/**
 * PostgREST over a function with no ORDER BY of its own. Every page re-runs
 * the function, and without an `.order()` a run can hand its rows back in any
 * order: here, in reverse. A key cursor then starts after the wrong row, so
 * pages repeat some rows and skip others. With `.order()` it answers in that
 * order, like servedLikePostgrest.
 */
function unstableUnlessOrdered(rows: Array<Record<string, unknown>>) {
  const inKeyOrder = servedLikePostgrest(rows);
  const reversed = servedLikePostgrest([...rows].reverse());
  return (call: MockCall) =>
    call.methods.includes('order') ? inKeyOrder(call) : reversed(call);
}

/** One page as the code asked for it: the key it starts after (null for the
 *  first page), its order and its size. */
type PageAsked = { after: unknown; order: unknown[] | undefined; limit: unknown; range: unknown };

/** Answers like servedLikePostgrest and records each awaited page. */
function recordingPages(rows: Array<Record<string, unknown>> | (() => Array<Record<string, unknown>>)) {
  const pages: PageAsked[] = [];
  const served = servedLikePostgrest(rows);
  const answer = (call: MockCall) => {
    if (awaited(call)) {
      pages.push({
        after: callArgs(call, 'gt')?.[1] ?? null,
        order: callArgs(call, 'order'),
        limit: callArgs(call, 'limit')?.[0],
        range: callArgs(call, 'range'),
      });
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

// Each page re-runs the aggregate. Pages fit together only when every page
// asks for the rows after the last key it has, in the order of that key: the
// keyset cursor of decision 2, with the shared PAGE_SIZE.
describe('every aggregate read pages by its unique key', () => {
  const expectKeyset = (pages: PageAsked[], key: string, lastKeyOfFirstPage: string) => {
    expect(pages).toEqual([
      { after: null, order: [key, { ascending: true }], limit: PAGE_SIZE, range: undefined },
      {
        after: lastKeyOfFirstPage,
        order: [key, { ascending: true }],
        limit: PAGE_SIZE,
        range: undefined,
      },
    ]);
  };

  it('pages hold PAGE_SIZE rows (the shared constant, PostgREST max_rows)', () => {
    expect(PAGE_SIZE).toBe(1000);
  });

  // Mutation caught: offset paging (`.range(from, to)`), a page size of its
  // own, or a cursor that starts anywhere but after the last key read.
  it('velocity class: the second page asks for the items after the first page’s last item, in item_id order', async () => {
    const out = recordingPages(outMovements(1001));
    const { svc } = svcWith({
      'rpc:report_item_out_movements': out.answer,
      'inventory_items.select': ranged(items(3)),
    });
    await svc.velocityClass(90);
    expectKeyset(out.pages, 'item_id', uuid(999));
  });

  it('dead stock: the second page asks for the items after the first page’s last item, in item_id order', async () => {
    const out = recordingPages(outMovements(1001));
    const { svc } = svcWith({
      'rpc:report_item_out_movements': out.answer,
      'inventory_items.select': ranged(items(3)),
    });
    await svc.deadStock(90);
    expectKeyset(out.pages, 'item_id', uuid(999));
  });

  it('both bundle reads: the second page asks for the bundles after the first page’s last bundle, in bundle_id order', async () => {
    const b = bundles(1001);
    const activity = recordingPages(b.activity);
    const value = recordingPages(b.value);
    const { svc } = svcWith({
      'rpc:report_bundle_activity': activity.answer,
      'rpc:report_bundle_component_value': value.answer,
    });
    await svc.bundleActivity(90);
    expectKeyset(activity.pages, 'bundle_id', uuid(999));
    expectKeyset(value.pages, 'bundle_id', uuid(999));
  });

  it('a page short of PAGE_SIZE is the last: 3 pages for 2,001 rows, 1 for 999', async () => {
    const big = recordingPages(outMovements(2001));
    const { svc } = svcWith({
      'rpc:report_item_out_movements': big.answer,
      'inventory_items.select': ranged(items(3)),
    });
    await svc.deadStock(90);
    expect(big.pages.map((p) => p.after)).toEqual([null, uuid(999), uuid(1999)]);

    const small = recordingPages(outMovements(999));
    const { svc: svc2 } = svcWith({
      'rpc:report_item_out_movements': small.answer,
      'inventory_items.select': ranged(items(3)),
    });
    await svc2.deadStock(90);
    expect(small.pages.map((p) => p.after)).toEqual([null]);
  });
});

describe('a row that appears or goes between two pages', () => {
  /**
   * The aggregate's rows change once the first page has been served, as when
   * a movement or a bundle run is recorded while the report reads.
   */
  function changingAfterFirstPage(
    rows: Array<Record<string, unknown>>,
    change: (rows: Array<Record<string, unknown>>) => Array<Record<string, unknown>>,
  ) {
    let current = rows;
    let firstPageServed = false;
    const answer = (call: MockCall) => {
      const res = servedLikePostgrest(current)(call);
      if (awaited(call) && !firstPageServed) {
        firstPageServed = true;
        current = change(current);
      }
      return res;
    };
    return answer;
  }

  // A key that sorts inside the first page: hex letters sort after digits,
  // so ...0000000005aa sits between uuid(599) and uuid(600).
  const EARLY_KEY = 'bbbbbbbb-0000-4000-8000-0000000005aa';

  // Mutation caught: offset paging. The new row pushes uuid(999) into the
  // second offset window, and the bundle was counted twice.
  it('a bundle run recorded mid-report: every bundle once, none twice', async () => {
    const b = bundles(1001);
    const { svc } = svcWith({
      'rpc:report_bundle_activity': changingAfterFirstPage(b.activity, (rows) => [
        ...rows,
        activityRow(EARLY_KEY),
      ]),
      'rpc:report_bundle_component_value': servedLikePostgrest(b.value),
    });
    const report = await svc.bundleActivity(90);
    const ids = report.rows.map((r) => r.bundleId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(1001);
    expect(report.totalRuns).toBe(1001);
    expect(report.totalKits).toBe(2002);
  });

  // Mutation caught: offset paging. With a row gone from the first window,
  // the second offset window starts one row late and uuid(1000), there all
  // along, was skipped and classed D.
  it('an item whose row goes mid-report: the items after the cursor are all read, none skipped', async () => {
    const { svc } = svcWith({
      'rpc:report_item_out_movements': changingAfterFirstPage(outMovements(1001), (rows) =>
        rows.filter((r) => r.item_id !== uuid(5)),
      ),
      'inventory_items.select': ranged(items(1001)),
    });
    const report = await svc.velocityClass(90);
    const classOf = new Map(report.rows.map((r) => [r.itemId, r.velocityClass]));
    expect(classOf.get(uuid(1000))).not.toBe('D');
    // The one item read on the first page keeps its class too.
    expect(classOf.get(uuid(5))).not.toBe('D');
  });
});

describe('every aggregate read asks for an order', () => {
  it('the stand-in plan repeats and skips rows when key pages come back unordered (vacuity control)', () => {
    const answer = unstableUnlessOrdered(outMovements(1001));
    const page = (after: string | null) => {
      const methods = after === null ? ['rpc', 'limit'] : ['rpc', 'gt', 'limit'];
      const args = after === null ? [[{}], [PAGE_SIZE]] : [[{}], ['item_id', after], [PAGE_SIZE]];
      return (answer({ table: 'report_item_out_movements', op: 'rpc', methods, args }).data as Array<{
        item_id: string;
      }>).map((r) => r.item_id);
    };
    const first = page(null);
    const seen = [...first, ...page(first.at(-1)!)];
    expect(new Set(seen).size).toBeLessThan(seen.length);
    expect(seen).not.toContain(uuid(0));
  });

  // Mutation caught: velocityClass's read without `.order('item_id')` (the
  // skipped item was classed D).
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

  // Mutation caught: the bundle activity read without `.order('bundle_id')`.
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

  // Mutation caught: the component value read without `.order('bundle_id')`.
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
});

describe('the read is bounded', () => {
  it('reads at most 20 pages (20,000 rows)', () => {
    expect(AGGREGATE_MAX_PAGES).toBe(20);
  });

  // Mutation caught: no bound (it reads on), or a bound that keeps the pages
  // it read and answers them as the whole set.
  it('a 20th full page fails the report with a log line naming the aggregate, instead of reading on or cutting the set', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const b = bundles(AGGREGATE_MAX_PAGES * PAGE_SIZE);
    const read = recordingPages(b.activity);
    const { svc } = svcWith({
      'rpc:report_bundle_activity': read.answer,
      'rpc:report_bundle_component_value': servedLikePostgrest([]),
    });
    const err = await svc.bundleActivity(90).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe('internal_error');
    expect(read.pages).toHaveLength(AGGREGATE_MAX_PAGES);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]?.[0])).toMatch(
      /report_bundle_activity.*more than 20000 rows/,
    );
  });

  it('19 full pages and a short 20th: every row, no log', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const n = AGGREGATE_MAX_PAGES * PAGE_SIZE - 1;
    const b = bundles(n);
    const { svc } = svcWith({
      'rpc:report_bundle_activity': servedLikePostgrest(b.activity),
      'rpc:report_bundle_component_value': servedLikePostgrest([]),
    });
    const report = await svc.bundleActivity(90);
    expect(report.rows).toHaveLength(n);
    expect(log).not.toHaveBeenCalled();
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

  // Mutation caught: a failed later page answered by the pages before it.
  it('a failed second page fails the report instead of showing the first page as the whole', async () => {
    const first = outMovements(1000);
    const { svc } = svcWith({
      'rpc:report_item_out_movements': (call) =>
        callArgs(call, 'gt') !== undefined
          ? { data: null, error: { message: 'canceling statement due to statement timeout' } }
          : { data: first, error: null },
      'inventory_items.select': ranged(items(1)),
    });
    const err = await svc.velocityClass(90).catch((e: unknown) => e);
    expect((err as ServiceError).code).toBe('internal_error');
  });

  it('a failed second bundle page fails the bundle report too', async () => {
    const b = bundles(1001);
    const { svc } = svcWith({
      'rpc:report_bundle_activity': servedLikePostgrest(b.activity),
      'rpc:report_bundle_component_value': (call) =>
        callArgs(call, 'gt') !== undefined
          ? { data: null, error: { message: 'fetch failed' } }
          : servedLikePostgrest(b.value)(call),
    });
    const err = await svc.bundleActivity(90).catch((e: unknown) => e);
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

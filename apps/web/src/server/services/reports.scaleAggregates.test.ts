import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * Scale-correctness parity suite for the Reports service aggregates that used
 * to sum a CAPPED rowset in JS (migration 0225 moved the truncation-prone
 * roll-ups into Postgres via service-role RPCs; the valuation totals now come
 * from the vw_inventory_valuation_* views).
 *
 * Strategy for each report:
 *   1. `oldAggregate*` — a faithful copy of the PRE-0225 JS aggregation, run
 *      over a fixture that fits UNDER the old cap (so the old path did NOT
 *      truncate — the two paths must agree there).
 *   2. `simRpc*` — computes exactly what the new SQL RPC returns for the same
 *      fixture (a JS stand-in for the GROUP BY). Wired into the mocked
 *      service-role client.
 *   3. Run the real service method (RPC mocked + detail-row stream stubbed)
 *      and assert its output deep-equals the old JS result → the mapping is
 *      equivalent.
 *   4. Separate "beyond cap" assertions prove the new totals are sourced from
 *      the RPC / view (untruncatable) rather than a summed rowset.
 */

const { rpcMock } = vi.hoisted(() => ({ rpcMock: vi.fn() }));

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({ rpc: rpcMock }),
}));

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

import { ReportsService } from './reports';

beforeEach(() => {
  rpcMock.mockReset();
});

/** Dispatch rpcMock by function name using a handler map. */
function wireRpc(handlers: Record<string, (args: Record<string, unknown>) => unknown[]>) {
  rpcMock.mockImplementation((name: string, args: Record<string, unknown>) => {
    const h = handlers[name];
    if (!h) throw new Error(`unexpected rpc: ${name}`);
    return Promise.resolve({ data: h(args), error: null });
  });
}

// ───────────────────────────────────────────────────────────────────────────
// movementSummary
// ───────────────────────────────────────────────────────────────────────────

type Move = {
  item_id: string;
  movement_type: string;
  quantity_change: number;
  created_at: string;
  item: { id: string; sku: string; name: string };
};

/** PRE-0225 movementSummary JS aggregation (verbatim math). */
function oldMovementSummary(days: number, moves: Move[]) {
  const byType = new Map<string, { count: number; totalQty: number }>();
  const perItem = new Map<
    string,
    { sku: string; name: string; totalIn: number; totalOut: number; movementCount: number }
  >();
  for (const r of moves) {
    const t = r.movement_type;
    const change = Number(r.quantity_change) || 0;
    const te = byType.get(t) ?? { count: 0, totalQty: 0 };
    te.count++;
    te.totalQty += Math.abs(change);
    byType.set(t, te);
    const item = r.item;
    const e = perItem.get(item.id) ?? {
      sku: item.sku,
      name: item.name,
      totalIn: 0,
      totalOut: 0,
      movementCount: 0,
    };
    e.movementCount++;
    if (change >= 0) e.totalIn += change;
    else e.totalOut += -change;
    perItem.set(item.id, e);
  }
  const topMovers = [...perItem.entries()]
    .map(([itemId, v]) => ({
      itemId,
      sku: v.sku,
      name: v.name,
      totalIn: v.totalIn,
      totalOut: v.totalOut,
      netChange: v.totalIn - v.totalOut,
      movementCount: v.movementCount,
    }))
    .sort((a, b) => b.totalIn + b.totalOut - (a.totalIn + a.totalOut))
    .slice(0, 50);
  return {
    rangeDays: days,
    byType: [...byType.entries()]
      .map(([movementType, v]) => ({ movementType, count: v.count, totalQty: v.totalQty }))
      .sort((a, b) => b.count - a.count),
    topMovers,
    totalMovements: moves.length,
  };
}

/** SQL stand-in for report_movement_type_summary. */
function simTypeSummary(moves: Move[]) {
  const m = new Map<string, { c: number; q: number }>();
  for (const r of moves) {
    const e = m.get(r.movement_type) ?? { c: 0, q: 0 };
    e.c++;
    e.q += Math.abs(r.quantity_change);
    m.set(r.movement_type, e);
  }
  return [...m.entries()].map(([movement_type, v]) => ({
    movement_type,
    movement_count: v.c,
    total_qty: v.q,
  }));
}

/** SQL stand-in for report_top_movers (order by (in+out) desc, item_id asc). */
function simTopMovers(moves: Move[], limit: number) {
  const m = new Map<string, { sku: string; name: string; tin: number; tout: number; c: number }>();
  for (const r of moves) {
    const e = m.get(r.item_id) ?? { sku: r.item.sku, name: r.item.name, tin: 0, tout: 0, c: 0 };
    e.c++;
    if (r.quantity_change >= 0) e.tin += r.quantity_change;
    else e.tout += -r.quantity_change;
    m.set(r.item_id, e);
  }
  return [...m.entries()]
    .map(([item_id, v]) => ({
      item_id,
      sku: v.sku,
      name: v.name,
      total_in: v.tin,
      total_out: v.tout,
      movement_count: v.c,
    }))
    .sort((a, b) =>
      b.total_in + b.total_out - (a.total_in + a.total_out) ||
      (a.item_id < b.item_id ? -1 : 1),
    )
    .slice(0, limit);
}

describe('ReportsService.movementSummary (scale parity)', () => {
  const moves: Move[] = [
    // itemA: gross 30 (in 20, out 10)
    { item_id: 'a', movement_type: 'add', quantity_change: 20, created_at: '2026-01-05T00:00:00Z', item: { id: 'a', sku: 'A', name: 'Item A' } },
    { item_id: 'a', movement_type: 'remove', quantity_change: -10, created_at: '2026-01-06T00:00:00Z', item: { id: 'a', sku: 'A', name: 'Item A' } },
    // itemB: gross 15 (in 15)
    { item_id: 'b', movement_type: 'add', quantity_change: 15, created_at: '2026-01-05T00:00:00Z', item: { id: 'b', sku: 'B', name: 'Item B' } },
    // itemC: gross 7 (out 7)
    { item_id: 'c', movement_type: 'adjust', quantity_change: -7, created_at: '2026-01-05T00:00:00Z', item: { id: 'c', sku: 'C', name: 'Item C' } },
  ];

  it('maps the RPC roll-ups to the exact pre-0225 JS aggregation', async () => {
    wireRpc({
      report_movement_type_summary: () => simTypeSummary(moves),
      report_top_movers: (args) => simTopMovers(moves, Number(args.p_limit)),
    });
    const svc = new ReportsService(makeServiceContext(makeSupabaseStub().client));
    const result = await svc.movementSummary(30);
    expect(result).toEqual(oldMovementSummary(30, moves));
  });

  it('totalMovements comes from the DB roll-up (untruncatable past the old 50k cap)', async () => {
    // Simulate a high-volume org: 75,000 movements across two types. The old
    // path would have summed a 50k-row SUBSET; the new path sums the RPC's
    // by-type counts → the true total.
    wireRpc({
      report_movement_type_summary: () => [
        { movement_type: 'add', movement_count: 50_000, total_qty: 123_456 },
        { movement_type: 'remove', movement_count: 25_000, total_qty: 654_321 },
      ],
      report_top_movers: () => [],
    });
    const svc = new ReportsService(makeServiceContext(makeSupabaseStub().client));
    const result = await svc.movementSummary(30);
    expect(result.totalMovements).toBe(75_000);
    expect(result.byType[0]).toEqual({ movementType: 'add', count: 50_000, totalQty: 123_456 });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// shrinkage
// ───────────────────────────────────────────────────────────────────────────

type ShrMove = {
  id: string;
  item_id: string;
  quantity_change: number;
  reason: string | null;
  notes: string | null;
  created_at: string;
  item: { id: string; sku: string; name: string; unit_cost: number };
};

function oldShrinkage(days: number, moves: ShrMove[]) {
  const rows = [];
  let totalUnits = 0;
  let totalCost = 0;
  for (const r of moves) {
    const item = r.item;
    const change = Number(r.quantity_change) || 0;
    const unitCost = Number(item.unit_cost) || 0;
    const lost = Math.abs(change);
    const cost = lost * unitCost;
    totalUnits += lost;
    totalCost += cost;
    rows.push({
      movementId: r.id,
      createdAt: r.created_at,
      itemId: item.id,
      sku: item.sku,
      itemName: item.name,
      quantityChange: change,
      unitCost,
      costImpact: cost,
      reason: r.reason,
      notes: r.notes,
    });
  }
  rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return { rangeDays: days, rows, totalUnits, totalCost };
}

describe('ReportsService.shrinkage (scale parity)', () => {
  const moves: ShrMove[] = [
    { id: 'm1', item_id: 'a', quantity_change: -3, reason: 'damage', notes: null, created_at: '2026-01-05T00:00:00Z', item: { id: 'a', sku: 'A', name: 'Item A', unit_cost: 10 } },
    { id: 'm2', item_id: 'b', quantity_change: -5, reason: null, notes: 'broke', created_at: '2026-01-07T00:00:00Z', item: { id: 'b', sku: 'B', name: 'Item B', unit_cost: 4 } },
  ];

  it('totals from the RPC + streamed detail rows deep-equal the pre-0225 JS result', async () => {
    // totals via RPC (sum abs, sum abs*cost); detail rows via the streamed
    // stock_movements select.
    const totalUnits = moves.reduce((s, m) => s + Math.abs(m.quantity_change), 0);
    const totalCost = moves.reduce((s, m) => s + Math.abs(m.quantity_change) * m.item.unit_cost, 0);
    wireRpc({
      report_shrinkage_totals: () => [{ total_units: totalUnits, total_cost: totalCost }],
    });
    const stub = makeSupabaseStub({
      'stock_movements.select': { data: moves, error: null },
    });
    const svc = new ReportsService(makeServiceContext(stub.client));
    const result = await svc.shrinkage(30);
    expect(result).toEqual(oldShrinkage(30, moves));
  });

  it('totals come from the RPC even if the streamed rows were truncated', async () => {
    // RPC returns the TRUE totals; the streamed detail rows are deliberately a
    // subset. The report total must reflect the RPC, not the row sum.
    wireRpc({
      report_shrinkage_totals: () => [{ total_units: 99_999, total_cost: 424_242 }],
    });
    const stub = makeSupabaseStub({
      'stock_movements.select': { data: [moves[0]], error: null },
    });
    const svc = new ReportsService(makeServiceContext(stub.client));
    const result = await svc.shrinkage(30);
    expect(result.totalUnits).toBe(99_999);
    expect(result.totalCost).toBe(424_242);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// velocityClass
// ───────────────────────────────────────────────────────────────────────────

type VItem = {
  id: string;
  sku: string;
  name: string;
  quantity_on_hand: number;
  unit_cost: number;
  warehouse: { name: string } | null;
  category: { name: string } | null;
};
type OutMove = { item_id: string; quantity_change: number; created_at: string };

function oldVelocity(days: number, moves: OutMove[], items: VItem[]) {
  const unitsOutById = new Map<string, number>();
  const lastOutById = new Map<string, string>();
  for (const m of moves) {
    unitsOutById.set(m.item_id, (unitsOutById.get(m.item_id) ?? 0) + Math.abs(m.quantity_change));
    const p = lastOutById.get(m.item_id);
    if (!p || m.created_at > p) lastOutById.set(m.item_id, m.created_at);
  }
  const rawRows = items.map((r) => {
    const unitsOut = unitsOutById.get(r.id) ?? 0;
    const cost = Number(r.unit_cost) || 0;
    return {
      itemId: r.id,
      sku: r.sku,
      name: r.name,
      warehouseName: r.warehouse?.name ?? null,
      categoryName: r.category?.name ?? null,
      quantityOnHand: Number(r.quantity_on_hand) || 0,
      unitCost: cost,
      unitsOut,
      valueOut: unitsOut * cost,
      lastOutAt: lastOutById.get(r.id) ?? null,
    };
  });
  rawRows.sort((a, b) => b.valueOut - a.valueOut);
  const totalValue = rawRows.reduce((s, r) => s + r.valueOut, 0);
  let running = 0;
  const rows = rawRows.map((r) => {
    let velocityClass: 'A' | 'B' | 'C' | 'D';
    if (r.valueOut === 0) velocityClass = 'D';
    else {
      running += r.valueOut;
      const pct = totalValue > 0 ? running / totalValue : 0;
      if (pct <= 0.8) velocityClass = 'A';
      else if (pct <= 0.95) velocityClass = 'B';
      else velocityClass = 'C';
    }
    return { ...r, velocityClass };
  });
  return {
    rangeDays: days,
    rows,
    summary: {
      A: rows.filter((r) => r.velocityClass === 'A').length,
      B: rows.filter((r) => r.velocityClass === 'B').length,
      C: rows.filter((r) => r.velocityClass === 'C').length,
      D: rows.filter((r) => r.velocityClass === 'D').length,
    },
    totalValueOut: totalValue,
  };
}

function simOutMovements(moves: OutMove[]) {
  const units = new Map<string, number>();
  const last = new Map<string, string>();
  for (const m of moves) {
    units.set(m.item_id, (units.get(m.item_id) ?? 0) + Math.abs(m.quantity_change));
    const p = last.get(m.item_id);
    if (!p || m.created_at > p) last.set(m.item_id, m.created_at);
  }
  return [...units.entries()].map(([item_id, u]) => ({
    item_id,
    units_out: u,
    last_out_at: last.get(item_id) ?? null,
  }));
}

describe('ReportsService.velocityClass (scale parity)', () => {
  const items: VItem[] = [
    { id: 'a', sku: 'A', name: 'A', quantity_on_hand: 5, unit_cost: 100, warehouse: { name: 'WH1' }, category: { name: 'Cat1' } },
    { id: 'b', sku: 'B', name: 'B', quantity_on_hand: 5, unit_cost: 10, warehouse: null, category: null },
    { id: 'c', sku: 'C', name: 'C', quantity_on_hand: 5, unit_cost: 1, warehouse: null, category: null },
    { id: 'd', sku: 'D', name: 'D', quantity_on_hand: 5, unit_cost: 50, warehouse: null, category: null }, // no movement → D
  ];
  const moves: OutMove[] = [
    { item_id: 'a', quantity_change: -4, created_at: '2026-01-05T00:00:00Z' }, // 400
    { item_id: 'a', quantity_change: -1, created_at: '2026-01-09T00:00:00Z' }, // last-out
    { item_id: 'b', quantity_change: -3, created_at: '2026-01-05T00:00:00Z' }, // 30
    { item_id: 'c', quantity_change: -2, created_at: '2026-01-05T00:00:00Z' }, // 2
  ];

  it('RPC out-movement aggregate + streamed items reproduce the pre-0225 classification/totalValueOut', async () => {
    wireRpc({ report_item_out_movements: () => simOutMovements(moves) });
    const stub = makeSupabaseStub({ 'inventory_items.select': { data: items, error: null } });
    const svc = new ReportsService(makeServiceContext(stub.client));
    const result = await svc.velocityClass(90);
    expect(result).toEqual(oldVelocity(90, moves, items));
  });
});

// ───────────────────────────────────────────────────────────────────────────
// deadStock
// ───────────────────────────────────────────────────────────────────────────

type DItem = VItem & { created_at: string };

describe('ReportsService.deadStock (scale parity)', () => {
  const items: DItem[] = [
    { id: 'a', sku: 'A', name: 'A', quantity_on_hand: 3, unit_cost: 100, warehouse: { name: 'WH1' }, category: null, created_at: '2025-01-01T00:00:00Z' },
    { id: 'b', sku: 'B', name: 'B', quantity_on_hand: 10, unit_cost: 5, warehouse: null, category: null, created_at: '2025-06-01T00:00:00Z' }, // moved → not dead
    { id: 'c', sku: 'C', name: 'C', quantity_on_hand: 2, unit_cost: 7, warehouse: null, category: null, created_at: '2025-03-01T00:00:00Z' },
  ];
  // Only item 'b' had an out-movement in the window.
  const outSet = [{ item_id: 'b', units_out: 4, last_out_at: '2026-01-05T00:00:00Z' }];

  it('streamed items + RPC out-movement set → dead items and carrying total match the pre-0225 logic', async () => {
    wireRpc({ report_item_out_movements: () => outSet });
    const stub = makeSupabaseStub({ 'inventory_items.select': { data: items, error: null } });
    const svc = new ReportsService(makeServiceContext(stub.client));
    const result = await svc.deadStock(90);

    // Dead = items NOT in the out-set: a (300) and c (14), sorted by carrying desc.
    expect(result.rows.map((r) => r.itemId)).toEqual(['a', 'c']);
    expect(result.rows.map((r) => r.carryingValue)).toEqual([300, 14]);
    expect(result.itemCount).toBe(2);
    expect(result.totalCarryingValue).toBe(314);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// bundleActivity
// ───────────────────────────────────────────────────────────────────────────

describe('ReportsService.bundleActivity (scale parity)', () => {
  it('two RPC roll-ups compose into the pre-0225 per-bundle rows + totals', async () => {
    wireRpc({
      report_bundle_activity: () => [
        { bundle_id: 'k1', bundle_name: 'Kit One', bundle_sku: 'K1', runs: 3, kits_out: 30, last_run_at: '2026-01-09T00:00:00Z', top_warehouse_name: 'WH1' },
        { bundle_id: 'k2', bundle_name: 'Kit Two', bundle_sku: null, runs: 1, kits_out: 5, last_run_at: '2026-01-02T00:00:00Z', top_warehouse_name: 'WH2' },
      ],
      report_bundle_component_value: () => [
        { bundle_id: 'k1', component_value_out: 250 },
        { bundle_id: 'k2', component_value_out: 40 },
      ],
    });
    const svc = new ReportsService(makeServiceContext(makeSupabaseStub().client));
    const result = await svc.bundleActivity(90);

    expect(result.rows).toEqual([
      { bundleId: 'k1', bundleName: 'Kit One', bundleSku: 'K1', runs: 3, kitsOut: 30, componentValueOut: 250, topWarehouseName: 'WH1', lastRunAt: '2026-01-09T00:00:00Z' },
      { bundleId: 'k2', bundleName: 'Kit Two', bundleSku: null, runs: 1, kitsOut: 5, componentValueOut: 40, topWarehouseName: 'WH2', lastRunAt: '2026-01-02T00:00:00Z' },
    ]);
    expect(result.totalRuns).toBe(4);
    expect(result.totalKits).toBe(35);
    expect(result.totalValueOut).toBe(290);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// inventoryValuation — totals from the views, detail rows stream uncapped
// ───────────────────────────────────────────────────────────────────────────

describe('ReportsService.inventoryValuation (view-sourced totals)', () => {
  const whView = [
    { warehouse_id: 'w1', warehouse_name: 'Main', value: 900_000, units: 40_000, item_count: 30_000 },
    { warehouse_id: null, warehouse_name: null, value: 100_000, units: 10_000, item_count: 12_000 },
  ];
  const catView = [
    { category_id: 'c1', category_name: 'Widgets', value: 1_000_000, units: 50_000, item_count: 42_000 },
  ];

  it('totalValue/totalUnits/itemCount/byWarehouse/byCategory come from the views, independent of the streamed rows', async () => {
    // The streamed detail rows sum to a DIFFERENT (tiny) value — proving the
    // totals are NOT recomputed from the rowset (which is where the old 10k
    // cap silently understated big orgs).
    const detail = [
      { id: 'x', sku: 'X', name: 'X', quantity_on_hand: 1, unit_cost: 2, warehouse: { name: 'Main' }, category: { name: 'Widgets' } },
      { id: 'y', sku: 'Y', name: 'Y', quantity_on_hand: 3, unit_cost: 4, warehouse: null, category: null },
    ];
    const stub = makeSupabaseStub({
      'vw_inventory_valuation_by_warehouse.select': { data: whView, error: null },
      'vw_inventory_valuation_by_category.select': { data: catView, error: null },
      'inventory_items.select': { data: detail, error: null },
    });
    const svc = new ReportsService(makeServiceContext(stub.client));
    const result = await svc.inventoryValuation();

    // Totals from the warehouse view (sum over its buckets).
    expect(result.totalValue).toBe(1_000_000);
    expect(result.totalUnits).toBe(50_000);
    expect(result.itemCount).toBe(42_000);
    expect(result.byWarehouse).toEqual([
      { warehouseId: 'w1', warehouseName: 'Main', value: 900_000, units: 40_000 },
      { warehouseId: null, warehouseName: 'Unassigned', value: 100_000, units: 10_000 },
    ]);
    expect(result.byCategory).toEqual([
      { categoryId: 'c1', categoryName: 'Widgets', value: 1_000_000, units: 50_000 },
    ]);
    // Detail rows are still present (sorted by qty desc) but do NOT drive totals.
    expect(result.rows.map((r) => r.itemId)).toEqual(['y', 'x']);
  });

  it('detail rows stream the COMPLETE set — no 10k hard cap', async () => {
    // A paginating client that yields 10,500 rows across 11 pages. The old
    // path capped at 10,000; the new path must return all 10,500.
    const TOTAL = 10_500;
    const all = Array.from({ length: TOTAL }, (_, i) => ({
      id: `it-${String(i).padStart(6, '0')}`,
      sku: `S${i}`,
      name: `N${i}`,
      quantity_on_hand: 1,
      unit_cost: 1,
      warehouse: null,
      category: null,
    }));

    function builder(resolve: (range: [number, number] | null) => { data: unknown; error: null }) {
      const state: { range: [number, number] | null } = { range: null };
      const p: Record<string, unknown> = new Proxy(
        {},
        {
          get(_t, prop: string) {
            if (prop === 'then') {
              return (res: (v: { data: unknown; error: null }) => void) => res(resolve(state.range));
            }
            if (prop === 'range') {
              return (from: number, to: number) => {
                state.range = [from, to];
                return p;
              };
            }
            return () => p;
          },
        },
      );
      return p;
    }

    const client = {
      from: (table: string) => {
        if (table === 'vw_inventory_valuation_by_warehouse') {
          return builder(() => ({ data: whView, error: null }));
        }
        if (table === 'vw_inventory_valuation_by_category') {
          return builder(() => ({ data: catView, error: null }));
        }
        // inventory_items → paginated slice.
        return builder((range) => {
          if (!range) return { data: [], error: null };
          const [from, to] = range;
          return { data: all.slice(from, to + 1), error: null };
        });
      },
    };

    const svc = new ReportsService(makeServiceContext(client));
    const result = await svc.inventoryValuation();
    expect(result.rows).toHaveLength(TOTAL);
    // Totals still from the view — unaffected by the row count.
    expect(result.totalValue).toBe(1_000_000);
  });
});

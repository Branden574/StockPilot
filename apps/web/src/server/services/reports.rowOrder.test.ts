import { describe, expect, it } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

import { ReportsService } from './reports';

/**
 * Rows that tie on a report's figure come out in one fixed order, whatever
 * order the database hands them back in (2026-09-29).
 *
 * After deploy #293, Demo Co's Stock movements CSV had the same rows as
 * before, but `initial` and `bundle_distribution` (3 movements each) had
 * swapped places: report_movement_type_summary groups with no ORDER BY, the
 * service sorted by count alone, and a tie kept the plan's row order. The
 * same held for report_bundle_activity (grouped, no ORDER BY) and for the
 * vw_inventory_valuation_* views. Each test below serves the same rows in two
 * orders and requires the same report.
 */

const CHARTER_X = 'c4a47e00-0000-4000-8000-00000000000a';

describe('ReportsService.movementSummary: tied movement types', () => {
  const types = [
    { movement_type: 'add', movement_count: 7, total_qty: 70 },
    { movement_type: 'initial', movement_count: 3, total_qty: 90 },
    { movement_type: 'bundle_distribution', movement_count: 3, total_qty: 12 },
    { movement_type: 'adjust', movement_count: 1, total_qty: 1 },
  ];

  async function byTypeFor(rows: typeof types) {
    const stub = makeSupabaseStub({
      'rpc:report_movement_type_summary': { data: rows, error: null },
      'rpc:report_top_movers': { data: [], error: null },
    });
    return (await new ReportsService(makeServiceContext(stub.client)).movementSummary(30)).byType;
  }

  it('the same order whichever way the function returns them: count, then the type', async () => {
    const forward = await byTypeFor(types);
    const reversed = await byTypeFor([...types].reverse());
    expect(reversed).toEqual(forward);
    expect(forward.map((t) => t.movementType)).toEqual([
      'add',
      'bundle_distribution',
      'initial',
      'adjust',
    ]);
  });
});

describe('ReportsService.bundleActivity: tied kits out', () => {
  const row = (bundle_id: string, bundle_name: string, bundle_sku: string | null, kits_out: number) => ({
    bundle_id,
    bundle_name,
    bundle_sku,
    runs: 1,
    kits_out,
    last_run_at: null,
    top_warehouse_name: null,
  });
  const rows = [
    row('k3', 'Alpha kit', 'Z-9', 5),
    row('k1', 'Beta kit', 'A-1', 5),
    row('k9', 'Gamma kit', 'G-2', 5),
    row('k2', 'Gamma kit', 'G-10', 5),
    row('k5', 'Delta kit', 'D-1', 5),
    row('k4', 'Delta kit', 'D-1', 5),
    row('k0', 'Zeta kit', 'Z-1', 40),
  ];

  async function activityFor(served: typeof rows) {
    const stub = makeSupabaseStub({
      'rpc:report_bundle_activity': { data: served, error: null },
      'rpc:report_bundle_component_value': { data: [], error: null },
    });
    return (await new ReportsService(makeServiceContext(stub.client)).bundleActivity(90)).rows;
  }

  it('the same order whichever way the function returns them: kits out, name, SKU, id', async () => {
    const forward = await activityFor(rows);
    const reversed = await activityFor([...rows].reverse());
    expect(reversed).toEqual(forward);
    expect(forward.map((r) => r.bundleId)).toEqual(['k0', 'k3', 'k1', 'k4', 'k5', 'k9', 'k2']);
  });
});

describe('ReportsService.inventoryValuation: tied warehouse and category rollups', () => {
  const whView = [
    { warehouse_id: 'w9', warehouse_name: 'Annex', value: 100, units: 1, item_count: 1 },
    { warehouse_id: 'w2', warehouse_name: 'Main', value: 100, units: 2, item_count: 1 },
    { warehouse_id: 'w0', warehouse_name: 'Zulu', value: 900, units: 3, item_count: 1 },
    { warehouse_id: null, warehouse_name: null, value: 100, units: 4, item_count: 1 },
    { warehouse_id: 'w1', warehouse_name: 'Main', value: 100, units: 5, item_count: 1 },
  ];
  const catView = [
    { category_id: 'c0', category_name: 'Tools', value: 50, units: 1, item_count: 1 },
    { category_id: 'c2', category_name: 'Books', value: 50, units: 1, item_count: 1 },
    { category_id: null, category_name: null, value: 60, units: 1, item_count: 1 },
    { category_id: 'c1', category_name: 'Books', value: 50, units: 1, item_count: 1 },
  ];

  async function valuationFor(wh: typeof whView, cat: typeof catView) {
    const stub = makeSupabaseStub({
      'vw_inventory_valuation_by_warehouse.select': { data: wh, error: null },
      'vw_inventory_valuation_by_category.select': { data: cat, error: null },
      'inventory_items.select': { data: [], error: null },
    });
    return new ReportsService(makeServiceContext(stub.client)).inventoryValuation();
  }

  it('the same rollups whichever way the views return them: value, then name, then id', async () => {
    const forward = await valuationFor(whView, catView);
    const reversed = await valuationFor([...whView].reverse(), [...catView].reverse());
    expect(reversed.byWarehouse).toEqual(forward.byWarehouse);
    expect(reversed.byCategory).toEqual(forward.byCategory);
    expect(forward.byWarehouse.map((w) => w.warehouseId)).toEqual(['w0', 'w9', 'w1', 'w2', null]);
    expect(forward.byCategory.map((c) => c.categoryId)).toEqual([null, 'c1', 'c2', 'c0']);
  });

  it('a charter-scoped valuation lists tied rollups the same way as the whole-org one', async () => {
    const item = (id: string, warehouseId: string, warehouseName: string, categoryId: string, categoryName: string) => ({
      id,
      sku: id.toUpperCase(),
      name: id,
      quantity_on_hand: 1,
      unit_cost: 10,
      warehouse_id: warehouseId,
      category_id: categoryId,
      warehouse: { name: warehouseName },
      category: { name: categoryName },
    });
    // Served in id order (as the paged stream is), which meets Main before
    // Annex and Tools before Books: the rollups used to keep that order.
    const items = [
      item('i1', 'w1', 'Main', 'c9', 'Tools'),
      item('i2', 'w9', 'Annex', 'c1', 'Books'),
    ];
    const stub = makeSupabaseStub({
      'charters.select': { data: [{ id: CHARTER_X }], error: null },
      'inventory_items.select': { data: items, error: null },
    });
    const result = await new ReportsService(makeServiceContext(stub.client)).inventoryValuation({
      charterId: CHARTER_X,
    });
    expect(result.byWarehouse.map((w) => w.warehouseName)).toEqual(['Annex', 'Main']);
    expect(result.byCategory.map((c) => c.categoryName)).toEqual(['Books', 'Tools']);
  });
});

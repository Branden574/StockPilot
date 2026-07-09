import { describe, expect, it } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

import { ReportsService } from './reports';

/**
 * Task 8 (Model B): inventoryValuation() gains an OPTIONAL `charterId` filter.
 *
 * Owner decision (docs/superpowers/specs/2026-07-08-model-b-one-item-per-sku-
 * holdings-design.md §8b): inventory VALUE stays whole (per-org) by DEFAULT.
 * Charter stays a column on `inventory_items` (a "placement" IS the item row
 * in the grouped/non-destructive Model B). The report gets an ADDITIVE
 * "by charter" filter: when a charterId is supplied (and belongs to the
 * caller's org), value/units are summed ONLY over inventory_items rows with
 * that charter_id. When unset, the total is UNCHANGED from today (the
 * vw_inventory_valuation_* views, untruncatable — see reports.
 * scaleAggregates.test.ts).
 */
describe('ReportsService.inventoryValuation — optional charter filter', () => {
  const whView = [
    { warehouse_id: 'w1', warehouse_name: 'Main', value: 1_000, units: 100, item_count: 10 },
  ];
  const catView = [
    { category_id: 'c1', category_name: 'Widgets', value: 1_000, units: 100, item_count: 10 },
  ];
  const wholeOrgDetail = [
    {
      id: 'x',
      sku: 'X',
      name: 'X',
      quantity_on_hand: 40,
      unit_cost: 10,
      warehouse: { name: 'Main' },
      category: { name: 'Widgets' },
    },
    {
      id: 'y',
      sku: 'Y',
      name: 'Y',
      quantity_on_hand: 60,
      unit_cost: 10,
      warehouse: null,
      category: null,
    },
  ];

  it('(a) no charterId → the SAME whole-org total as today, and never queries charters', async () => {
    const stub = makeSupabaseStub({
      'vw_inventory_valuation_by_warehouse.select': { data: whView, error: null },
      'vw_inventory_valuation_by_category.select': { data: catView, error: null },
      'inventory_items.select': { data: wholeOrgDetail, error: null },
    });
    const svc = new ReportsService(makeServiceContext(stub.client));

    const bare = await svc.inventoryValuation();
    const withUndefined = await svc.inventoryValuation({ charterId: undefined });
    const withNull = await svc.inventoryValuation({ charterId: null });

    expect(bare.totalValue).toBe(1_000);
    expect(bare.totalUnits).toBe(100);
    expect(bare.itemCount).toBe(10);
    // Pin: identical output regardless of how "no filter" is spelled.
    expect(withUndefined).toEqual(bare);
    expect(withNull).toEqual(bare);
    // The default path must not even touch the charters table — proves the
    // filter is purely additive, not a hidden always-on join.
    expect(stub.fromCalls).not.toContain('charters');
  });

  it('(b) charterId scoped to the org → value/units summed ONLY over that charter\'s rows', async () => {
    const chartered = [
      {
        id: 'i1',
        sku: 'S1',
        name: 'Item 1',
        quantity_on_hand: 5,
        unit_cost: 10,
        warehouse_id: 'w1',
        category_id: 'c1',
        warehouse: { name: 'WH1' },
        category: { name: 'Widgets' },
      },
      {
        id: 'i2',
        sku: 'S2',
        name: 'Item 2',
        quantity_on_hand: 2,
        unit_cost: 3,
        warehouse_id: null,
        category_id: null,
        warehouse: null,
        category: null,
      },
    ];
    const stub = makeSupabaseStub({
      'charters.select': { data: [{ id: 'charter-x' }], error: null },
      'inventory_items.select': { data: chartered, error: null },
    });
    const svc = new ReportsService(makeServiceContext(stub.client));

    const result = await svc.inventoryValuation({ charterId: 'charter-x' });

    expect(result.totalValue).toBe(56); // 5*10 + 2*3
    expect(result.totalUnits).toBe(7);
    expect(result.itemCount).toBe(2);
    expect(result.byWarehouse).toEqual([
      { warehouseId: 'w1', warehouseName: 'WH1', value: 50, units: 5 },
      { warehouseId: null, warehouseName: 'Unassigned', value: 6, units: 2 },
    ]);
    expect(result.byCategory).toEqual([
      { categoryId: 'c1', categoryName: 'Widgets', value: 50, units: 5 },
      { categoryId: null, categoryName: 'Uncategorized', value: 6, units: 2 },
    ]);
    expect(result.rows.map((r) => r.itemId)).toEqual(['i1', 'i2']);

    // Proves the filter actually reached the query (not a coincidence of
    // the fixture already being pre-filtered).
    const chain = stub.chains.get('inventory_items.select') ?? [];
    const args = stub.chainArgs.get('inventory_items.select') ?? [];
    const eqCalls = chain
      .map((m, i) => (m === 'eq' ? args[i] : null))
      .filter((a): a is unknown[] => a !== null);
    expect(eqCalls).toContainEqual(['charter_id', 'charter-x']);
  });

  it('(c) charterId not in the org (foreign/nonexistent) → empty/zero, not a leak', async () => {
    const stub = makeSupabaseStub({
      'charters.select': { data: [], error: null }, // no row for this org
    });
    const svc = new ReportsService(makeServiceContext(stub.client, { organizationId: 'org-a' }));

    const result = await svc.inventoryValuation({ charterId: 'someone-elses-charter' });

    expect(result).toEqual({
      rows: [],
      totalValue: 0,
      totalUnits: 0,
      itemCount: 0,
      byWarehouse: [],
      byCategory: [],
    });
    // No inventory_items query is even issued once the charter fails to
    // resolve to the caller's org — nothing about a foreign org's stock
    // is ever read.
    expect(stub.fromCalls).not.toContain('inventory_items');
  });
});

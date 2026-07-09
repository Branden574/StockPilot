import { describe, expect, it } from 'vitest';

import {
  buildPreview,
  type PreviewItem,
  type PreviewLineOverride,
} from './stock-impact-preview';

import type { PoImportLineRow } from '@/server/services/po-imports';

const ITEM_A: PreviewItem = { id: 'item-a', sku: 'A1', name: 'Widget A', quantityOnHand: 5 };
const ITEM_B: PreviewItem = { id: 'item-b', sku: 'B1', name: 'Widget B', quantityOnHand: 0 };

function line(
  id: string,
  overrides: Partial<PoImportLineRow> = {},
): PoImportLineRow {
  return {
    id,
    line_number: parseInt(id.replace(/\D/g, ''), 10) || 1,
    description: 'Sample',
    qty_ordered_original: 10,
    uom_original: 'ea',
    line_total: 100,
    item_id: null,
    line_type: 'inventory',
    vendor_item_number: null,
    ...overrides,
  } as unknown as PoImportLineRow;
}

describe('buildPreview', () => {
  it('marks an inventory line with no item_id as unmapped', () => {
    const { rows, summary } = buildPreview([line('1')], {}, [ITEM_A]);
    expect(rows[0]!.status).toBe('unmapped');
    expect(rows[0]!.projectedQty).toBeNull();
    expect(summary.unmappedCount).toBe(1);
    expect(summary.mappedCount).toBe(0);
  });

  it('marks a line with item_id pre-populated as mapped + projects qty', () => {
    const lines = [line('1', { item_id: 'item-a', qty_ordered_original: 10 })];
    const { rows, summary } = buildPreview(lines, {}, [ITEM_A]);
    expect(rows[0]!.status).toBe('mapped');
    expect(rows[0]!.itemId).toBe('item-a');
    expect(rows[0]!.currentQty).toBe(5);
    expect(rows[0]!.projectedQty).toBe(15);
    expect(summary.mappedCount).toBe(1);
  });

  it('overrides win over the line.item_id (override drives mapping)', () => {
    const lines = [line('1', { item_id: 'item-a', qty_ordered_original: 8 })];
    const overrides: Record<string, PreviewLineOverride> = {
      '1': { itemId: 'item-b' },
    };
    const { rows } = buildPreview(lines, overrides, [ITEM_A, ITEM_B]);
    expect(rows[0]!.itemId).toBe('item-b');
    expect(rows[0]!.currentQty).toBe(0);
    expect(rows[0]!.projectedQty).toBe(8);
  });

  it('explicit override of null reverts to unmapped', () => {
    const lines = [line('1', { item_id: 'item-a' })];
    const overrides: Record<string, PreviewLineOverride> = {
      '1': { itemId: null },
    };
    const { rows } = buildPreview(lines, overrides, [ITEM_A]);
    expect(rows[0]!.status).toBe('unmapped');
  });

  it('two lines mapped to the same item stack their projected qty', () => {
    const lines = [
      line('1', { item_id: 'item-a', qty_ordered_original: 7 }),
      line('2', { item_id: 'item-a', qty_ordered_original: 3 }),
    ];
    const { rows } = buildPreview(lines, {}, [ITEM_A]);
    // Both rows should show projected = 5 (current) + 7 + 3 = 15
    expect(rows[0]!.projectedQty).toBe(15);
    expect(rows[1]!.projectedQty).toBe(15);
  });

  it('skipped lines come back as skipped + ignore qty in totals', () => {
    const lines = [
      line('1', { item_id: 'item-a', qty_ordered_original: 5, line_total: 50 }),
      line('2', { qty_ordered_original: 4, line_total: 40 }),
    ];
    const overrides: Record<string, PreviewLineOverride> = {
      '2': { skip: true },
    };
    const { rows, summary } = buildPreview(lines, overrides, [ITEM_A]);
    expect(rows[1]!.status).toBe('skipped');
    expect(summary.skippedCount).toBe(1);
    expect(summary.totalUnits).toBe(5); // skipped row excluded
    expect(summary.totalCost).toBe(50);
  });

  it('non-inventory lines are surfaced separately from skipped', () => {
    const lines = [line('1', { line_type: 'freight', qty_ordered_original: 1, line_total: 12 })];
    const { rows, summary } = buildPreview(lines, {}, []);
    expect(rows[0]!.status).toBe('non-inventory');
    expect(summary.nonInventoryCount).toBe(1);
    // non-inventory excluded from inventory units/cost
    expect(summary.totalUnits).toBe(0);
    expect(summary.totalCost).toBe(0);
  });

  it('unmapped inventory lines still count in totals (cost is real)', () => {
    const lines = [line('1', { qty_ordered_original: 6, line_total: 60 })];
    const { summary } = buildPreview(lines, {}, []);
    expect(summary.unmappedCount).toBe(1);
    expect(summary.totalUnits).toBe(6);
    expect(summary.totalCost).toBe(60);
  });

  // Matching is advisory-only (Tasks 2/3): a line can carry a
  // suggested_item_id while still unresolved (item_id null, no override).
  // The default is CREATE-NEW until a human explicitly accepts the
  // suggestion, so the projection must never borrow the suggested item's
  // real stock — it projects a brand-new instance starting at 0.
  it('an unaccepted suggested line projects from 0 (new item), not the suggested item\'s current qty', () => {
    const lines = [
      line('1', {
        qty_ordered_original: 10,
        suggested_item_id: 'item-a',
      } as Partial<PoImportLineRow>),
    ];
    const { rows, summary } = buildPreview(lines, {}, [ITEM_A]); // ITEM_A has 5 on hand
    expect(rows[0]!.status).toBe('unmapped');
    expect(rows[0]!.itemId).toBeNull();
    expect(rows[0]!.currentQty).toBe(0);
    expect(rows[0]!.projectedQty).toBe(10);
    // Never the suggested item's real numbers (5 → 15).
    expect(rows[0]!.currentQty).not.toBe(5);
    expect(rows[0]!.projectedQty).not.toBe(15);
    // Still counts as unmapped for the approve gate — nothing links until
    // the user explicitly accepts the suggestion.
    expect(summary.unmappedCount).toBe(1);
    expect(summary.mappedCount).toBe(0);
  });

  it('accepting a suggestion (override sets itemId) projects against the real existing item, not 0', () => {
    const lines = [
      line('1', {
        qty_ordered_original: 10,
        suggested_item_id: 'item-a',
      } as Partial<PoImportLineRow>),
    ];
    const overrides: Record<string, PreviewLineOverride> = {
      '1': { itemId: 'item-a' },
    };
    const { rows } = buildPreview(lines, overrides, [ITEM_A]);
    expect(rows[0]!.status).toBe('mapped');
    expect(rows[0]!.currentQty).toBe(5);
    expect(rows[0]!.projectedQty).toBe(15);
  });
});

// Model B: the org's data model allows the same SKU across multiple
// inventory_items rows (one per charter/rack "placement" — see
// lib/inventory/group-by-sku.ts). A line matches/creates ONE placement, but
// that placement can be a small slice of a much bigger SKU total (e.g. the
// matched placement holds 100 while the SKU totals 281 across placements) —
// showing only "100 → 200" reads as wrong to the owner. The preview must
// show BOTH the SKU aggregate (summed across every placement sharing that
// SKU) and the specific placement's own before/after.
describe('buildPreview — SKU aggregate (Model B placements)', () => {
  const PLACEMENT_A: PreviewItem = {
    id: 'placement-a',
    sku: 'SKU-X',
    name: 'Chromebook 511',
    quantityOnHand: 100,
  };
  const PLACEMENT_B: PreviewItem = {
    id: 'placement-b',
    sku: 'SKU-X',
    name: 'Chromebook 511',
    quantityOnHand: 181,
  };
  // What the PAGE computes from the FULL items list (listForMatching) —
  // sum of quantityOnHand over every row sharing the target SKU. 100 + 181.
  const SKU_TOTAL_BY_SKU = new Map<string, number>([['SKU-X', 281]]);

  it('shows the SKU aggregate (281 → 381) AND the specific placement (100 → 200) for a mapped line', () => {
    const lines = [line('1', { item_id: 'placement-a', qty_ordered_original: 100 })];
    const { rows } = buildPreview(lines, {}, [PLACEMENT_A, PLACEMENT_B], SKU_TOTAL_BY_SKU);
    // The specific placement (the matched row) — unchanged single-record math.
    expect(rows[0]!.currentQty).toBe(100);
    expect(rows[0]!.projectedQty).toBe(200);
    // The SKU aggregate — summed across ALL placements sharing the SKU, plus
    // this line's qty. This is the "281 vs 100" fix.
    expect(rows[0]!.skuTotalCurrentQty).toBe(281);
    expect(rows[0]!.skuTotalProjectedQty).toBe(381);
  });

  it('two lines landing on different placements of the same SKU stack in the SKU aggregate (each placement keeps its own math)', () => {
    const lines = [
      line('1', { item_id: 'placement-a', qty_ordered_original: 20 }),
      line('2', { item_id: 'placement-b', qty_ordered_original: 30 }),
    ];
    const { rows } = buildPreview(lines, {}, [PLACEMENT_A, PLACEMENT_B], SKU_TOTAL_BY_SKU);
    expect(rows[0]!.currentQty).toBe(100);
    expect(rows[0]!.projectedQty).toBe(120);
    expect(rows[1]!.currentQty).toBe(181);
    expect(rows[1]!.projectedQty).toBe(211);
    // Both rows report the SAME SKU-level aggregate: 281 baseline + 20 + 30.
    expect(rows[0]!.skuTotalCurrentQty).toBe(281);
    expect(rows[0]!.skuTotalProjectedQty).toBe(331);
    expect(rows[1]!.skuTotalCurrentQty).toBe(281);
    expect(rows[1]!.skuTotalProjectedQty).toBe(331);
  });

  it('a create-new (unmapped, unaccepted-suggestion) line shows placement 0 → qty, and the SKU total rises by the same qty', () => {
    const lines = [
      line('1', {
        qty_ordered_original: 100,
        suggested_item_id: 'placement-a',
      } as Partial<PoImportLineRow>),
    ];
    // Even though the map carries a real total for SKU-X, an unaccepted
    // suggestion must NEVER borrow it (same rule as the existing "unaccepted
    // suggestion projects from 0" test above) — the SKU total starts fresh
    // at 0, same as the placement.
    const { rows } = buildPreview(lines, {}, [PLACEMENT_A, PLACEMENT_B], SKU_TOTAL_BY_SKU);
    expect(rows[0]!.status).toBe('unmapped');
    expect(rows[0]!.currentQty).toBe(0);
    expect(rows[0]!.projectedQty).toBe(100);
    expect(rows[0]!.skuTotalCurrentQty).toBe(0);
    expect(rows[0]!.skuTotalProjectedQty).toBe(100);
  });

  it('omitting skuTotalBySku falls back to the placement qty (backward compatible; no crash)', () => {
    const lines = [line('1', { item_id: 'placement-a', qty_ordered_original: 100 })];
    const { rows } = buildPreview(lines, {}, [PLACEMENT_A, PLACEMENT_B]); // no 4th arg
    expect(rows[0]!.currentQty).toBe(100);
    expect(rows[0]!.skuTotalCurrentQty).toBe(100);
    expect(rows[0]!.skuTotalProjectedQty).toBe(200);
  });

  it('buildPreview is a pure projection: no mutation of its inputs, deterministic for the same inputs', () => {
    const lines = [
      line('1', { item_id: 'placement-a', qty_ordered_original: 100 }),
      line('2', { qty_ordered_original: 5 }),
    ];
    const items = [PLACEMENT_A, PLACEMENT_B];
    const overrides: Record<string, PreviewLineOverride> = {};
    const skuTotalBySku = new Map(SKU_TOTAL_BY_SKU);

    const linesSnapshot = JSON.parse(JSON.stringify(lines));
    const itemsSnapshot = JSON.parse(JSON.stringify(items));
    const overridesSnapshot = JSON.parse(JSON.stringify(overrides));
    const skuTotalSnapshot = new Map(skuTotalBySku);

    const result1 = buildPreview(lines, overrides, items, skuTotalBySku);
    const result2 = buildPreview(lines, overrides, items, skuTotalBySku);

    // No side effects on any input — a pure function reads, never writes.
    expect(lines).toEqual(linesSnapshot);
    expect(items).toEqual(itemsSnapshot);
    expect(overrides).toEqual(overridesSnapshot);
    expect(skuTotalBySku).toEqual(skuTotalSnapshot);
    // Same inputs → same (deep-equal) outputs, every call — no hidden state,
    // no async/timers/network involved.
    expect(result2).toEqual(result1);
  });
});

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
    expect(rows[0].status).toBe('unmapped');
    expect(rows[0].projectedQty).toBeNull();
    expect(summary.unmappedCount).toBe(1);
    expect(summary.mappedCount).toBe(0);
  });

  it('marks a line with item_id pre-populated as mapped + projects qty', () => {
    const lines = [line('1', { item_id: 'item-a', qty_ordered_original: 10 })];
    const { rows, summary } = buildPreview(lines, {}, [ITEM_A]);
    expect(rows[0].status).toBe('mapped');
    expect(rows[0].itemId).toBe('item-a');
    expect(rows[0].currentQty).toBe(5);
    expect(rows[0].projectedQty).toBe(15);
    expect(summary.mappedCount).toBe(1);
  });

  it('overrides win over the line.item_id (override drives mapping)', () => {
    const lines = [line('1', { item_id: 'item-a', qty_ordered_original: 8 })];
    const overrides: Record<string, PreviewLineOverride> = {
      '1': { itemId: 'item-b' },
    };
    const { rows } = buildPreview(lines, overrides, [ITEM_A, ITEM_B]);
    expect(rows[0].itemId).toBe('item-b');
    expect(rows[0].currentQty).toBe(0);
    expect(rows[0].projectedQty).toBe(8);
  });

  it('explicit override of null reverts to unmapped', () => {
    const lines = [line('1', { item_id: 'item-a' })];
    const overrides: Record<string, PreviewLineOverride> = {
      '1': { itemId: null },
    };
    const { rows } = buildPreview(lines, overrides, [ITEM_A]);
    expect(rows[0].status).toBe('unmapped');
  });

  it('two lines mapped to the same item stack their projected qty', () => {
    const lines = [
      line('1', { item_id: 'item-a', qty_ordered_original: 7 }),
      line('2', { item_id: 'item-a', qty_ordered_original: 3 }),
    ];
    const { rows } = buildPreview(lines, {}, [ITEM_A]);
    // Both rows should show projected = 5 (current) + 7 + 3 = 15
    expect(rows[0].projectedQty).toBe(15);
    expect(rows[1].projectedQty).toBe(15);
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
    expect(rows[1].status).toBe('skipped');
    expect(summary.skippedCount).toBe(1);
    expect(summary.totalUnits).toBe(5); // skipped row excluded
    expect(summary.totalCost).toBe(50);
  });

  it('non-inventory lines are surfaced separately from skipped', () => {
    const lines = [line('1', { line_type: 'shipping', qty_ordered_original: 1, line_total: 12 })];
    const { rows, summary } = buildPreview(lines, {}, []);
    expect(rows[0].status).toBe('non-inventory');
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
});

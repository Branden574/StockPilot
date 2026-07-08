import { describe, it, expect } from 'vitest';
import { groupPlacementsBySku, rollupStatus } from './group-by-sku';

const row = (o: Partial<{ id: string; sku: string; name: string; lineQuantity: number }>) => ({
  id: o.id ?? 'i1', sku: o.sku ?? 'SKU-A', name: o.name ?? 'Chromebook',
  charterId: null, placementLabel: null,
  lineQuantity: o.lineQuantity ?? 0,
});

describe('groupPlacementsBySku', () => {
  it('sums placements of one SKU into a single group total, preserving each placement', () => {
    const groups = groupPlacementsBySku([
      row({ id: 'a', sku: 'SP-G69UU-05H', lineQuantity: 75 }),
      row({ id: 'b', sku: 'SP-G69UU-05H', lineQuantity: 100 }),
      row({ id: 'c', sku: 'SP-G69UU-05H', lineQuantity: 106 }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.sku).toBe('SP-G69UU-05H');
    expect(groups[0]!.total).toBe(281);
    expect(groups[0]!.placements).toHaveLength(3);
  });

  it('keeps different SKUs as separate groups, first-seen order', () => {
    const groups = groupPlacementsBySku([
      row({ id: 'a', sku: 'SKU-A', lineQuantity: 5 }),
      row({ id: 'b', sku: 'SKU-B', lineQuantity: 7 }),
      row({ id: 'c', sku: 'SKU-A', lineQuantity: 3 }),
    ]);
    expect(groups.map((g) => g.sku)).toEqual(['SKU-A', 'SKU-B']);
    expect(groups[0]!.total).toBe(8);
  });

  it('treats a null/empty sku as its own ungrouped placement (never merges blank SKUs)', () => {
    const groups = groupPlacementsBySku([
      row({ id: 'a', sku: '', lineQuantity: 1 }),
      row({ id: 'b', sku: '', lineQuantity: 2 }),
    ]);
    expect(groups).toHaveLength(2);
  });
});

describe('rollupStatus', () => {
  // Conservative rollup for the SKU group-header Status column: a group of
  // placements must never read as fully healthy when part of it is
  // discontinued/archived (a per-placement field that can legitimately
  // differ across a SKU's placements). Severity order: discontinued >
  // archived > active.
  it('returns the shared status when every placement agrees (common case, unchanged)', () => {
    expect(rollupStatus(['active', 'active', 'active'])).toBe('active');
  });

  it('returns "discontinued" when mixed with active — never masks a discontinued placement', () => {
    expect(rollupStatus(['active', 'discontinued', 'active'])).toBe('discontinued');
  });

  it('returns "archived" when mixed with active', () => {
    expect(rollupStatus(['active', 'archived'])).toBe('archived');
  });

  it('returns "archived" when every placement is archived', () => {
    expect(rollupStatus(['archived', 'archived'])).toBe('archived');
  });

  it('prefers "discontinued" over "archived" when both are present', () => {
    expect(rollupStatus(['archived', 'discontinued', 'active'])).toBe('discontinued');
  });
});

import { describe, it, expect } from 'vitest';
import { groupPlacementsBySku } from './group-by-sku';

const row = (o: Partial<{ id: string; sku: string; name: string; lineQuantity: number; charterName: string | null }>) => ({
  id: o.id ?? 'i1', sku: o.sku ?? 'SKU-A', name: o.name ?? 'Chromebook',
  charterId: null, charterName: o.charterName ?? null, placementLabel: null,
  lineQuantity: o.lineQuantity ?? 0,
});

describe('groupPlacementsBySku', () => {
  it('sums placements of one SKU into a single group total, preserving each placement', () => {
    const groups = groupPlacementsBySku([
      row({ id: 'a', sku: 'SP-G69UU-05H', lineQuantity: 75, charterName: 'CVW-Manchester' }),
      row({ id: 'b', sku: 'SP-G69UU-05H', lineQuantity: 100, charterName: 'CVLYII-Visalia' }),
      row({ id: 'c', sku: 'SP-G69UU-05H', lineQuantity: 106, charterName: 'CVSII-Madera' }),
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

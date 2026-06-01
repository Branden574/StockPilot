import { describe, expect, it } from 'vitest';

import {
  toBreakdownSlices,
  toMovementBars,
  toValueSeries,
} from './widget-data';

describe('toValueSeries', () => {
  it('labels the final point "Today" and counts back "D-N" for the rest', () => {
    const out = toValueSeries({ inventoryValueSeries: [10, 20, 30] });
    expect(out).toEqual([
      { day: 'D-2', value: 10 },
      { day: 'D-1', value: 20 },
      { day: 'Today', value: 30 },
    ]);
  });

  it('preserves order oldest -> newest', () => {
    const series = [5, 4, 3, 2, 1];
    const out = toValueSeries({ inventoryValueSeries: series });
    expect(out.map((p) => p.value)).toEqual(series);
  });

  it('coerces non-finite values (NaN/Infinity) to 0', () => {
    const out = toValueSeries({
      inventoryValueSeries: [NaN, Infinity, 42],
    });
    expect(out.map((p) => p.value)).toEqual([0, 0, 42]);
  });

  it('handles an empty series', () => {
    expect(toValueSeries({ inventoryValueSeries: [] })).toEqual([]);
  });
});

describe('toBreakdownSlices', () => {
  const report = {
    byCategory: [
      { categoryId: 'c1', categoryName: 'Books', value: 100, units: 10 },
      { categoryId: 'c2', categoryName: 'Supplies', value: 0, units: 0 },
      { categoryId: null, categoryName: 'Uncategorized', value: 25, units: 5 },
    ],
    byWarehouse: [
      { warehouseId: 'w1', warehouseName: 'Main', value: 80, units: 8 },
      { warehouseId: null, warehouseName: 'Unassigned', value: -5, units: 0 },
    ],
  };

  it('maps category slices and keeps the report order', () => {
    const out = toBreakdownSlices(report, 'category');
    expect(out).toEqual([
      { key: 'c1', name: 'Books', value: 100 },
      { key: '__none', name: 'Uncategorized', value: 25 },
    ]);
  });

  it('drops zero and negative-value slices', () => {
    expect(toBreakdownSlices(report, 'category').some((s) => s.name === 'Supplies')).toBe(false);
    expect(toBreakdownSlices(report, 'warehouse').some((s) => s.value <= 0)).toBe(false);
  });

  it('uses the warehouse rollup when dimension is "warehouse"', () => {
    const out = toBreakdownSlices(report, 'warehouse');
    expect(out).toEqual([{ key: 'w1', name: 'Main', value: 80 }]);
  });

  it('falls back to "__none" key for null ids', () => {
    const out = toBreakdownSlices(report, 'category');
    expect(out.find((s) => s.name === 'Uncategorized')?.key).toBe('__none');
  });
});

describe('toMovementBars', () => {
  it('title-cases snake_case types and keeps count + raw type', () => {
    const out = toMovementBars({
      byType: [
        { type: 'receive_po', count: 12, share: 1 },
        { type: 'adjust', count: 4, share: 0.33 },
      ],
    });
    expect(out).toEqual([
      { type: 'receive_po', label: 'Receive Po', count: 12 },
      { type: 'adjust', label: 'Adjust', count: 4 },
    ]);
  });

  it('preserves the descending order it was given', () => {
    const out = toMovementBars({
      byType: [
        { type: 'sale', count: 9, share: 1 },
        { type: 'transfer', count: 3, share: 0.33 },
        { type: 'adjust', count: 1, share: 0.11 },
      ],
    });
    expect(out.map((b) => b.count)).toEqual([9, 3, 1]);
  });

  it('handles an empty byType', () => {
    expect(toMovementBars({ byType: [] })).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';

import {
  countDistinctSkuLines,
  countItemRowsBySku,
  countPlacementRows,
  deriveInstantView,
  instantStateFromPageParams,
  planInstantFirstPage,
  type InstantModeRow,
} from './instant-mode';

// The footer's set-wide counts and the cached default view's page-1 plan.
// The table (instant mode) and the cached loader (at fill time) both call
// these, so the first paint and the settled page print the same numbers.

function row(
  id: string,
  over: Partial<InstantModeRow> & { rank: number },
): InstantModeRow & { rank: number } {
  return {
    id,
    sku: `SKU-${id}`,
    name: `Item ${id}`,
    status: 'active',
    quantity_on_hand: 1,
    reorder_point: 0,
    unit_cost: 1,
    category_id: null,
    primary_location_id: null,
    charter_id: null,
    updated_at: new Date(Date.UTC(2026, 0, 1) - over.rank * 1000).toISOString(),
    ...over,
  };
}

describe('countDistinctSkuLines (COUNT 3)', () => {
  it('counts each raw SKU once and each blank-SKU row on its own', () => {
    expect(
      countDistinctSkuLines([
        { sku: 'A' },
        { sku: 'A' },
        { sku: ' A' }, // a different raw key: the body renders it as its own line
        { sku: '' },
        { sku: '   ' },
        { sku: 'B' },
      ]),
    ).toBe(5);
  });
});

describe('countPlacementRows (COUNT 2)', () => {
  it('one row per holding line, and exactly one for an item with none', () => {
    const lines: Record<string, number> = { a: 2, b: 0, c: 1 };
    expect(
      countPlacementRows(
        [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
        (id) => lines[id] ?? 0,
      ),
    ).toBe(5);
  });
});

describe('countItemRowsBySku', () => {
  it('keys on the raw SKU and skips blank ones', () => {
    expect([
      ...countItemRowsBySku([{ sku: 'A' }, { sku: 'A' }, { sku: ' A' }, { sku: ' ' }]),
    ]).toEqual([
      ['A', 2],
      [' A', 1],
    ]);
  });
});

describe('planInstantFirstPage', () => {
  // 32 singles, with a 3-size run whose first member is 29th and a Model B
  // pair whose second row is last, plus rows the default view excludes.
  const rows = [
    row('pair-1', { rank: 1, sku: 'PAIR' }),
    ...Array.from({ length: 27 }, (_, i) => row(`s${i}`, { rank: 2 + i })),
    row('tee-s', { rank: 29, name: 'Tee - S' }),
    row('tee-m', { rank: 30, name: 'Tee - M' }),
    row('x', { rank: 31 }),
    row('tee-l', { rank: 32, name: 'Tee - L' }),
    row('pair-2', { rank: 33, sku: 'PAIR' }),
    row('archived-tee', { rank: 0, name: 'Tee - XL', status: 'archived' }),
    row('awaiting', { rank: 0, awaiting_first_receipt: true }),
  ];
  const lines: Record<string, number> = { 'pair-1': 2, x: 0 };

  it('is page 1 of the default derivation, with the counts the table prints', () => {
    const { view, firstPage } = planInstantFirstPage(rows, (id) => lines[id] ?? 1, 30);
    const derived = deriveInstantView(rows, instantStateFromPageParams({}), 'items', 30);
    expect(view.pageItems.map((r) => r.id)).toEqual(derived.pageItems.map((r) => r.id));
    // The pair is pulled up whole; the run does not fit after 28 rows, so
    // page 1 closes at 29 and the run opens page 2.
    expect(view.pageItems.map((r) => r.id)).toEqual([
      'pair-1',
      'pair-2',
      ...Array.from({ length: 27 }, (_, i) => `s${i}`),
    ]);
    expect(firstPage).toEqual({
      pageCount: 2,
      pageItemCount: 29,
      distinctSkus: 32, // 33 default rows, PAIR on two of them
      placementRows: 34, // pair-1 has two lines, x has none (1 row)
      skuItemRowCounts: [
        ['PAIR', 2],
        ...Array.from({ length: 27 }, (_, i) => [`SKU-s${i}`, 1] as [string, number]),
      ],
    });
    expect(view.total).toBe(33);
  });

  it('reads only the default view: excluded rows change nothing', () => {
    const withoutExcluded = rows.filter((r) => r.status === 'active' && !r.awaiting_first_receipt);
    const a = planInstantFirstPage(rows, (id) => lines[id] ?? 1, 30);
    const b = planInstantFirstPage(withoutExcluded, (id) => lines[id] ?? 1, 30);
    expect(a.firstPage).toEqual(b.firstPage);
    expect(a.view.pageItems).toEqual(b.view.pageItems);
  });
});

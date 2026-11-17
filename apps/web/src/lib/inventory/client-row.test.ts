import { describe, expect, it } from 'vitest';

import {
  isPackedInventoryRows,
  packInventoryClientRows,
  toInventoryClientRow,
  toInventoryClientRows,
  unpackInventoryClientRows,
  withoutFlatTrends,
} from '@/lib/inventory/client-row';
import {
  deriveInstantView,
  expandInstantPlacementRows,
  instantStateFromPageParams,
  planInstantFirstPage,
  type InstantModeRow,
} from '@/lib/inventory/instant-mode';
import { syntheticListView, type PayloadProfile } from '@/test/inventory-payload-fixture';

// The table derives every view of the Items and Books lists from the rows it
// receives (instant mode). Those rows are now reduced to the columns the table
// reads and sent packed; these tests prove the derivation answers exactly as
// it did over the whole rows: the same rows in the same order on every page,
// the same totals, the same value on hand, for every filter, search and sort.

const CATEGORY = '0d000000-0000-4000-8000-000000000012';
const CHARTER = '0c000000-0000-4000-8000-0000000000c1';
const VIEW_STATES: Array<Record<string, string | string[]>> = [
  {},
  { status: 'archived' },
  { status: 'all' },
  { stock: 'low' },
  { stock: 'out' },
  { q: 'chromebook' },
  { q: 'LTB000000123' }, // barcode
  { q: 'MDL-12' }, // model number
  { q: '9781000000042' }, // a book's SKU and barcode
  { q: 'made-up title number 7' },
  { cat: CATEGORY },
  { charter: CHARTER },
  { charter: 'generic' },
  { charter: ['generic', CHARTER] },
  { rack: '12-D' },
  { rack: '3' },
  { rack: '5-A', stock: 'low' },
  { sort: 'name_asc' },
  { sort: 'name_desc', page: '3' },
  { sort: 'sku_asc' },
  { sort: 'qty_desc' },
  { sort: 'qty_asc', page: '2' },
  { sort: 'created_desc' },
  { sort: 'created_asc' },
  { sort: 'updated_asc', page: '4' },
  { page: '7' },
  { expected: '1' },
  { status: 'archived', auto: '1' },
  { q: 'steel', stock: 'low', sort: 'qty_asc', cat: CATEGORY },
];

/** What the table holds after the trip: reduced, packed, unpacked. */
function received<T extends object>(rows: readonly T[]) {
  return unpackInventoryClientRows(packInventoryClientRows(toInventoryClientRows(rows)));
}

describe('instant mode over the rows the table receives', () => {
  for (const profile of ['seeded', 'items', 'books'] as PayloadProfile[]) {
    const view = profile === 'books' ? 'books' : 'items';
    const whole = syntheticListView(400, profile).items as unknown as InstantModeRow[];
    const sent = received(whole);

    for (const params of VIEW_STATES) {
      it(`${profile}: ${JSON.stringify(params)} derives the same view`, () => {
        const state = instantStateFromPageParams(params);
        const a = deriveInstantView(whole, state, view, 30);
        const b = deriveInstantView(sent, state, view, 30);
        expect(b.total).toBe(a.total);
        expect(b.valueOnHand).toBe(a.valueOnHand);
        expect(b.page).toBe(a.page);
        expect(b.pageCount).toBe(a.pageCount);
        expect(b.pageStartIndex).toBe(a.pageStartIndex);
        expect(b.filteredRows.map((r) => r.id)).toEqual(a.filteredRows.map((r) => r.id));
        // The page's rows are the whole rows' read columns, value for value.
        expect(b.pageItems).toEqual(toInventoryClientRows(a.pageItems));
      });
    }
  }

  it('the views under test are not empty (each filter matches something)', () => {
    const whole = syntheticListView(400, 'items').items as unknown as InstantModeRow[];
    for (const params of [
      { stock: 'low' },
      { q: 'LTB000000123' },
      { q: 'MDL-12' },
      { charter: 'generic' },
      { rack: '12-D' },
    ]) {
      expect(deriveInstantView(whole, instantStateFromPageParams(params), 'items', 30).total).toBe(
        deriveInstantView(received(whole), instantStateFromPageParams(params), 'items', 30).total,
      );
      expect(
        deriveInstantView(whole, instantStateFromPageParams(params), 'items', 30).total,
      ).toBeGreaterThan(0);
    }
    const books = syntheticListView(400, 'books').items as unknown as InstantModeRow[];
    expect(
      deriveInstantView(books, instantStateFromPageParams({ rack: '12-D' }), 'books', 30).total,
    ).toBeGreaterThan(0);
  });

  it('the placement rows and the planned first page are the same', () => {
    const v = syntheticListView(400, 'items');
    const whole = v.items as unknown as InstantModeRow[];
    const sent = received(whole);
    const state = instantStateFromPageParams({ sort: 'name_asc' });
    const a = deriveInstantView(whole, state, 'items', 30);
    const b = deriveInstantView(sent, state, 'items', 30);
    const rowsA = expandInstantPlacementRows(a.pageItems, v.placement);
    const rowsB = expandInstantPlacementRows(b.pageItems, v.placement);
    expect(
      rowsB.map((r) => [r.rowKey, r.line_quantity, r.placement_label, r.placement_kind]),
    ).toEqual(rowsA.map((r) => [r.rowKey, r.line_quantity, r.placement_label, r.placement_kind]));
    const lines = (id: string) => v.placement[id]?.length ?? 0;
    expect(planInstantFirstPage(sent, lines, 30).firstPage).toEqual(
      planInstantFirstPage(whole, lines, 30).firstPage,
    );
  });
});

describe('toInventoryClientRow', () => {
  it('keeps only the rack, crate and grade custom fields', () => {
    const row = {
      id: 'a',
      quantity_on_hand: 1,
      description: 'long text',
      supplier_id: 's',
      created_by: 'u',
      custom_fields: {
        author: 'Someone',
        description: 'A long catalogue description',
        thumbnail_url: 'https://books.example.com/cover',
        rack_number: '1',
        book_rack_number: '2',
        book_rack_row: 'C',
        book_crate_color: 'red',
        book_crate_number: '9',
        book_grade: '4',
      },
    };
    expect(toInventoryClientRow(row)).toEqual({
      id: 'a',
      quantity_on_hand: 1,
      custom_fields: {
        rack_number: '1',
        book_rack_number: '2',
        book_rack_row: 'C',
        book_crate_color: 'red',
        book_crate_number: '9',
        book_grade: '4',
      },
    });
  });

  it('keeps null and empty custom fields as they are', () => {
    expect(toInventoryClientRow({ id: 'a', custom_fields: null })).toEqual({
      id: 'a',
      custom_fields: null,
    });
    expect(toInventoryClientRow({ id: 'a', custom_fields: {} })).toEqual({
      id: 'a',
      custom_fields: {},
    });
  });

  it('keeps elsewhere_quantity when the row has it and adds nothing it lacks', () => {
    const live = toInventoryClientRow({ id: 'a', elsewhere_quantity: 3, charter_id: null });
    expect(live).toEqual({ id: 'a', elsewhere_quantity: 3, charter_id: null });
    expect(Object.keys(toInventoryClientRow({ id: 'a' }))).toEqual(['id']);
  });
});

describe('packInventoryClientRows / unpackInventoryClientRows', () => {
  it('unpacks to rows equal to the packed ones, nulls, zeros, arrays and absent fields included', () => {
    const rows = [
      {
        id: 'a',
        name: 'A',
        charter_id: null,
        quantity_on_hand: 0,
        auto_archived: false,
        placed_racks: ['1-A', '2-B'],
        placed_holdings: [{ name: '1-A', quantity: 2, kind: 'rack' }],
        custom_fields: { rack_number: '1' },
        elsewhere_quantity: 4,
      },
      { id: 'b', name: '$B', charter_id: 'c', quantity_on_hand: -2, auto_archived: true },
    ];
    const packed = packInventoryClientRows(rows);
    expect(isPackedInventoryRows(packed)).toBe(true);
    const back = unpackInventoryClientRows(packed);
    expect(back).toEqual(rows);
    // A field one row lacks stays absent, not undefined-valued.
    expect(Object.keys(back[1]!).sort()).toEqual(Object.keys(rows[1]!).sort());
  });

  it('names each field once', () => {
    const rows = syntheticListView(50, 'items').items;
    const packed = packInventoryClientRows(toInventoryClientRows(rows));
    expect(new Set(packed.fields).size).toBe(packed.fields.length);
    expect(packed.values).toHaveLength(50);
    expect(JSON.stringify(packed).split('"quantity_on_hand"').length - 1).toBe(1);
  });

  it('passes rows that were never packed through unchanged', () => {
    const rows = [{ id: 'a' }];
    expect(unpackInventoryClientRows(rows)).toBe(rows);
  });
});

describe('withoutFlatTrends', () => {
  /** The table's own fallback for a row without a trend (seriesForRow). */
  const fallback = (qty: number) => ({
    qtySeries: new Array<number>(14).fill(qty),
    moveSeries: new Array<number>(14).fill(0),
  });

  it('leaves out exactly the trends the table would draw the same without', () => {
    const rows = [
      { id: 'still', quantity_on_hand: 7 },
      { id: 'moved', quantity_on_hand: 7 },
      { id: 'negative', quantity_on_hand: -3 },
      { id: 'zero', quantity_on_hand: 0 },
    ];
    const moved = {
      qtySeries: [...fallback(7).qtySeries],
      moveSeries: [...fallback(7).moveSeries],
    };
    moved.qtySeries[3] = 5;
    moved.moveSeries[4] = 1;
    const trends = new Map([
      ['still', fallback(7)],
      ['moved', moved],
      ['negative', fallback(-3)],
      ['zero', fallback(0)],
      ['not-a-row', fallback(1)],
    ]);
    const kept = withoutFlatTrends(trends, rows);
    expect([...kept.keys()].sort()).toEqual(['moved', 'negative', 'not-a-row']);
    // What the table draws for a left-out row equals the trend it had.
    for (const r of rows) {
      const drawn = kept.get(r.id) ?? fallback(r.quantity_on_hand);
      expect(drawn).toEqual(trends.get(r.id));
    }
  });

  it('keeps a flat line that sits at another quantity than the row', () => {
    const kept = withoutFlatTrends(new Map([['a', fallback(5)]]), [
      { id: 'a', quantity_on_hand: 6 },
    ]);
    expect(kept.has('a')).toBe(true);
  });
});

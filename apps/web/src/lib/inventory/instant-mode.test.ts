import { describe, expect, it } from 'vitest';

import {
  INSTANT_MODE_MAX_ROWS,
  deriveInstantView,
  expandInstantPlacementRows,
  filterInstantRows,
  instantStateFromPageParams,
  instantStateFromSearchParams,
  isLowStock,
  rowMatchesCharters,
  rowMatchesRack,
  sortInstantRows,
  type InstantModeRow,
  type InstantModeState,
} from './instant-mode';

function row(over: Partial<InstantModeRow> & { id: string }): InstantModeRow {
  return {
    sku: `SKU-${over.id}`,
    barcode: null,
    model_number: null,
    name: `Item ${over.id}`,
    status: 'active',
    quantity_on_hand: 10,
    reorder_point: 0,
    unit_cost: 1,
    category_id: null,
    primary_location_id: null,
    charter_id: null,
    custom_fields: null,
    created_at: '2026-01-01T00:00:00+00:00',
    updated_at: '2026-01-02T00:00:00+00:00',
    ...over,
  };
}

function state(over: Partial<InstantModeState> = {}): InstantModeState {
  return {
    q: '',
    status: 'active',
    stock: null,
    cat: [],
    loc: [],
    charter: [],
    rack: '',
    sort: 'updated_desc',
    page: 1,
    ...over,
  };
}

const CH1 = '11111111-2222-3333-4444-555555555555';
const CH2 = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

describe('constant', () => {
  it('pins INSTANT_MODE_MAX_ROWS (loader cap + page gate both key off it)', () => {
    expect(INSTANT_MODE_MAX_ROWS).toBe(2000);
  });
});

describe('state adapters', () => {
  it('page-params adapter mirrors the pages’ coercions (status/stock exact-match, parseSort fallback, page Math.max(1, Number||1), parseIdList)', () => {
    expect(
      instantStateFromPageParams({
        q: ' lan ',
        status: 'archived',
        stock: 'low',
        page: '3',
        sort: 'name_asc',
        cat: ['c1', ''],
        loc: 'l1',
        charter: ['generic'],
        rack: '38-A',
      }),
    ).toEqual({
      q: ' lan ',
      status: 'archived',
      stock: 'low',
      page: 3,
      sort: 'name_asc',
      cat: ['c1'],
      loc: ['l1'],
      charter: ['generic'],
      rack: '38-A',
    });
    // Garbage coerces exactly like the pages do.
    expect(
      instantStateFromPageParams({ status: 'garbage', stock: 'sideways', page: '0', sort: 'nope' }),
    ).toMatchObject({ status: 'active', stock: null, page: 1, sort: 'updated_desc' });
    expect(instantStateFromPageParams({ page: 'abc' }).page).toBe(1);
  });

  it('searchParams adapter produces the same state as the page adapter for the same URL', () => {
    const sp = new URLSearchParams(
      'q=lan&status=all&stock=out&page=2&sort=qty_desc&cat=c1&cat=c2&loc=l1&charter=generic&rack=38',
    );
    expect(instantStateFromSearchParams(sp)).toEqual(
      instantStateFromPageParams({
        q: 'lan',
        status: 'all',
        stock: 'out',
        page: '2',
        sort: 'qty_desc',
        cat: ['c1', 'c2'],
        loc: 'l1',
        charter: 'generic',
        rack: '38',
      }),
    );
  });
});

describe('status filter (mirrors list(): default active, exact archived/discontinued, all = none)', () => {
  const rows = [
    row({ id: 'a', status: 'active' }),
    row({ id: 'b', status: 'archived' }),
    row({ id: 'c', status: 'discontinued' }),
  ];
  it.each([
    ['active', ['a']],
    ['archived', ['b']],
    ['discontinued', ['c']],
    ['all', ['a', 'b', 'c']],
  ] as const)('status=%s', (status, ids) => {
    expect(filterInstantRows(rows, state({ status }), 'items').map((r) => r.id)).toEqual([...ids]);
  });
});

describe('stock filters (combined server pre-filter + JS post-filter semantics)', () => {
  it('isLowStock: out counts as low even with reorder_point=0; above zero needs a positive reorder line', () => {
    expect(isLowStock(0, 0)).toBe(true); // qty<=0, no reorder line — the case the OR pre-filter exists for
    expect(isLowStock(-1, 5)).toBe(true);
    expect(isLowStock(5, 5)).toBe(true); // at the line
    expect(isLowStock(5, 10)).toBe(true); // under the line
    expect(isLowStock(5, 0)).toBe(false); // in stock, no reorder line
    expect(isLowStock(11, 10)).toBe(false); // above the line
  });

  it('stock=out keeps only qty<=0', () => {
    const rows = [row({ id: 'a', quantity_on_hand: 0 }), row({ id: 'b', quantity_on_hand: 3 })];
    expect(filterInstantRows(rows, state({ stock: 'out' }), 'items').map((r) => r.id)).toEqual(['a']);
  });
});

describe('cat / loc / charter filters', () => {
  it('category + location: IN-set on category_id / primary_location_id (NULL never matches)', () => {
    const rows = [
      row({ id: 'a', category_id: 'c1', primary_location_id: 'l1' }),
      row({ id: 'b', category_id: 'c2', primary_location_id: null }),
      row({ id: 'c', category_id: null, primary_location_id: 'l1' }),
    ];
    expect(filterInstantRows(rows, state({ cat: ['c1', 'c2'] }), 'items').map((r) => r.id)).toEqual(['a', 'b']);
    expect(filterInstantRows(rows, state({ loc: ['l1'] }), 'items').map((r) => r.id)).toEqual(['a', 'c']);
  });

  it('charters: generic → NULL only; uuids → IN; generic+uuids → OR; invalid-only → NO filter (list()’s exact fail-open edge)', () => {
    expect(rowMatchesCharters(null, ['generic'])).toBe(true);
    expect(rowMatchesCharters(CH1, ['generic'])).toBe(false);
    expect(rowMatchesCharters(CH1, [CH1])).toBe(true);
    expect(rowMatchesCharters(CH2, [CH1])).toBe(false);
    expect(rowMatchesCharters(null, [CH1])).toBe(false);
    expect(rowMatchesCharters(null, ['generic', CH1])).toBe(true);
    expect(rowMatchesCharters(CH1, ['generic', CH1])).toBe(true);
    expect(rowMatchesCharters(CH2, ['generic', CH1])).toBe(false);
    // Non-uuid ids are dropped; nothing left → the server applies no
    // filter at all, so neither do we.
    expect(rowMatchesCharters(CH2, ['not-a-uuid'])).toBe(true);
    expect(rowMatchesCharters(null, ['not-a-uuid'])).toBe(true);
  });
});

describe('rack filter (per-view custom_fields keys, list()-identical sanitize/split)', () => {
  it('items view matches rack_number / rack_row; books view the book_* keys', () => {
    const itemCf = { rack_number: '38', rack_row: 'A' };
    const bookCf = { book_rack_number: '38', book_rack_row: 'A' };
    expect(rowMatchesRack(itemCf, '38-A', 'items')).toBe(true);
    expect(rowMatchesRack(itemCf, '38', 'items')).toBe(true); // number alone
    expect(rowMatchesRack(itemCf, '38-B', 'items')).toBe(false);
    expect(rowMatchesRack(itemCf, '39', 'items')).toBe(false);
    expect(rowMatchesRack(bookCf, '38-A', 'books')).toBe(true);
    // Cross-view keys never match (books keys on the items view).
    expect(rowMatchesRack(bookCf, '38-A', 'items')).toBe(false);
  });

  it('PostgREST ->> parity: JSON numbers compare as text', () => {
    expect(rowMatchesRack({ rack_number: 38, rack_row: 'A' }, '38-A', 'items')).toBe(true);
  });

  it('whitespace-only / empty-number racks apply NO filter (list() parity); hostile chars are stripped like the service', () => {
    expect(rowMatchesRack(null, '   ', 'items')).toBe(true);
    expect(rowMatchesRack(null, '-A', 'items')).toBe(true); // empty number segment
    expect(rowMatchesRack({ rack_number: '20' }, '2)0', 'items')).toBe(true); // sanitize → '20'
    expect(rowMatchesRack(null, '38', 'items')).toBe(false); // no custom_fields → NULL ≠ '38'
  });
});

describe('sort (SORT_MAP columns + direction + id tiebreak)', () => {
  const rows = [
    row({ id: 'b', name: 'beta', sku: 'S2', quantity_on_hand: 5, created_at: '2026-01-02T00:00:00+00:00', updated_at: '2026-01-03T00:00:00+00:00' }),
    row({ id: 'a', name: 'Alpha', sku: 'S3', quantity_on_hand: 9, created_at: '2026-01-03T00:00:00+00:00', updated_at: '2026-01-03T00:00:00+00:00' }),
    row({ id: 'c', name: 'gamma', sku: 'S1', quantity_on_hand: 5, created_at: '2026-01-01T00:00:00+00:00', updated_at: '2026-01-01T00:00:00+00:00' }),
  ];
  it.each([
    ['updated_desc', ['a', 'b', 'c']], // tie a/b on updated_at → id asc
    ['updated_asc', ['c', 'a', 'b']],
    ['name_asc', ['a', 'b', 'c']], // case-insensitive-ish locale compare
    ['name_desc', ['c', 'b', 'a']],
    ['sku_asc', ['c', 'b', 'a']],
    ['sku_desc', ['a', 'b', 'c']],
    ['qty_desc', ['a', 'b', 'c']], // tie b/c at 5 → id asc
    ['qty_asc', ['b', 'c', 'a']],
    ['created_desc', ['a', 'b', 'c']],
    ['created_asc', ['c', 'b', 'a']],
  ] as const)('%s', (sort, ids) => {
    expect(sortInstantRows(rows, sort).map((r) => r.id)).toEqual([...ids]);
  });

  it('does not mutate its input', () => {
    const input = [...rows];
    sortInstantRows(input, 'name_asc');
    expect(input.map((r) => r.id)).toEqual(['b', 'a', 'c']);
  });
});

describe('deriveInstantView (filter → totals → sort → paginate)', () => {
  const dataset = Array.from({ length: 65 }, (_, i) =>
    row({
      id: `i${String(i).padStart(3, '0')}`,
      name: i % 2 === 0 ? `Even ${i}` : `Odd ${i}`,
      quantity_on_hand: i,
      unit_cost: 2,
      status: i < 60 ? 'active' : 'archived',
      updated_at: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}+00:00`,
    }),
  );

  it('pages are 30-row windows of the sorted filtered set with an exact total', () => {
    const v = deriveInstantView(dataset, state({ sort: 'qty_asc' }), 'items', 30);
    expect(v.total).toBe(60); // active only
    expect(v.pageCount).toBe(2);
    expect(v.page).toBe(1);
    expect(v.pageItems).toHaveLength(30);
    expect(v.pageItems[0]!.id).toBe('i000');
    const p2 = deriveInstantView(dataset, state({ sort: 'qty_asc', page: 2 }), 'items', 30);
    expect(p2.pageItems).toHaveLength(30);
    expect(p2.pageItems[0]!.quantity_on_hand).toBe(30);
  });

  it('footer totals mirror buildSumPage: sum(qty×cost) over the FULL filtered set with Number(x)||0 coercion', () => {
    const v = deriveInstantView(dataset, state(), 'items', 30);
    // Active rows are qty 0..59 at cost 2 → 2 * (59*60/2).
    expect(v.valueOnHand).toBe(2 * ((59 * 60) / 2));
    // Garbage numerics coerce to 0, same as the server reduce.
    const dirty = [
      row({ id: 'x', quantity_on_hand: Number.NaN, unit_cost: 10 }),
      row({ id: 'y', quantity_on_hand: 3, unit_cost: Number.NaN }),
      row({ id: 'z', quantity_on_hand: 2, unit_cost: 5 }),
    ];
    expect(deriveInstantView(dirty, state(), 'items', 30).valueOnHand).toBe(10);
  });

  it('totals track EVERY active filter, including q (the "(searching…)" replacement is a complete answer)', () => {
    const v = deriveInstantView(dataset, state({ q: 'odd' }), 'items', 30);
    expect(v.total).toBe(30); // odd 1..59 → 30 active rows
    expect(v.valueOnHand).toBe(2 * 30 * 30); // sum of odd numbers 1..59 = 900, ×cost 2
  });

  it('clamps out-of-range pages to the last real page (documented divergence #4)', () => {
    const v = deriveInstantView(dataset, state({ page: 99 }), 'items', 30);
    expect(v.page).toBe(2);
    expect(v.pageItems).toHaveLength(30);
    const empty = deriveInstantView([], state({ page: 99 }), 'items', 30);
    expect(empty.page).toBe(1);
    expect(empty.total).toBe(0);
    expect(empty.pageItems).toEqual([]);
  });

  it('is a pure function: same inputs, same output (realtime refresh reconciliation)', () => {
    const s = state({ q: 'even', sort: 'qty_desc', page: 1 });
    expect(deriveInstantView(dataset, s, 'items', 30)).toEqual(
      deriveInstantView(dataset, s, 'items', 30),
    );
  });
});

describe('expandInstantPlacementRows (client twin of the Items page flatMap)', () => {
  it('one row per holding line with rowKey/line_quantity/label/kind; no holdings → single fallback row', () => {
    const items = [row({ id: 'a', quantity_on_hand: 500 }), row({ id: 'b', quantity_on_hand: 7 })];
    const placement = {
      a: [
        { locationId: 'L1', label: '1-A', kind: 'rack', quantity: 250 },
        { locationId: 'L2', label: 'Staging', kind: 'staging', quantity: 250 },
      ],
    };
    const out = expandInstantPlacementRows(items, placement);
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({
      id: 'a',
      rowKey: 'a:L1',
      line_quantity: 250,
      placement_label: '1-A',
      placement_kind: 'rack',
      quantity_on_hand: 500, // item TOTAL rides along, exactly like the server rows
    });
    expect(out[1]).toMatchObject({ rowKey: 'a:L2', placement_label: 'Staging', placement_kind: 'staging' });
    expect(out[2]).toMatchObject({
      id: 'b',
      rowKey: 'b',
      line_quantity: 7,
      placement_label: null,
      placement_kind: undefined,
    });
  });
});

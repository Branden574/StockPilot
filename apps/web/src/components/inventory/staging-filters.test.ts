import { describe, expect, it } from 'vitest';

import {
  EMPTY_STAGING_FILTERS,
  NO_PO,
  STALE_THRESHOLD_DAYS,
  buildPoOptions,
  filterStagingRows,
  formatStagingCount,
  hasActiveStagingFilters,
  isRecentAge,
  isStaleAge,
  matchesStagingAge,
  matchesStagingPo,
  matchesStagingSearch,
  matchesStagingSource,
  type StagingFilterableRow,
  type StagingFilters,
} from './staging-filters';

// A row shape one field WIDER than the filterable contract, so the "returns
// the original objects" pins can prove nothing is projected away.
interface Row extends StagingFilterableRow {
  itemId: string;
  itemType: string;
  quantity: number;
  bookStorage: { crateLabel: string | null } | null;
}

function row(over: Partial<Row> & { itemId: string }): Row {
  return {
    name: `Item ${over.itemId}`,
    sku: `SKU-${over.itemId}`,
    sourcePoNumber: null,
    receiptNumber: null,
    sourceKind: 'staging',
    ageDays: null,
    receivedAt: null,
    itemType: 'product',
    quantity: 1,
    bookStorage: null,
    ...over,
  };
}

function f(over: Partial<StagingFilters> = {}): StagingFilters {
  return { ...EMPTY_STAGING_FILTERS, ...over };
}

const A = row({
  itemId: 'A',
  name: 'Acer Chromebook',
  sku: 'SP-9U4BK-0EK',
  sourcePoNumber: 'PO-100',
  receiptNumber: 'RCV-000031',
  receivedAt: '2026-08-10T00:00:00Z',
  ageDays: 3,
});
const B = row({
  itemId: 'B',
  name: 'Persepolis',
  sku: 'SP-BOOK-1',
  itemType: 'book',
  sourcePoNumber: 'PO-100',
  receiptNumber: 'RCV-000032',
  receivedAt: '2026-08-01T00:00:00Z',
  ageDays: 14,
  barcode: '9780375714573',
  bookStorage: { crateLabel: 'Blue 4' },
});
const C = row({
  itemId: 'C',
  name: 'Whiteboard markers',
  sku: 'SP-WBM-12',
  sourcePoNumber: 'PO-200',
  receiptNumber: 'RCV-000040',
  receivedAt: '2026-08-12T00:00:00Z',
  ageDays: 7,
  modelNumber: 'EXPO-86001',
});
const D = row({
  itemId: 'D',
  name: 'Loose paperbacks',
  sku: 'SP-LP-9',
  itemType: 'book',
  sourceKind: 'unplaced',
  sourcePoNumber: null,
  receiptNumber: null,
  ageDays: null,
});
const ROWS = [A, B, C, D];
const ids = (rows: readonly Row[]) => rows.map((r) => r.itemId);

describe('matchesStagingSearch', () => {
  it('matches by item name, SKU, PO number, partial PO number and receipt number', () => {
    expect(ids(filterStagingRows(ROWS, f({ query: 'Chromebook' })))).toEqual(['A']);
    expect(ids(filterStagingRows(ROWS, f({ query: 'SP-BOOK-1' })))).toEqual(['B']);
    expect(ids(filterStagingRows(ROWS, f({ query: 'PO-200' })))).toEqual(['C']);
    // "1092" matches "PO-1092": substring, so the prefix need not be typed.
    expect(ids(filterStagingRows(ROWS, f({ query: '100' })))).toEqual(['A', 'B']);
    expect(ids(filterStagingRows(ROWS, f({ query: 'RCV-000040' })))).toEqual(['C']);
  });

  it('is case-insensitive and ignores surrounding whitespace', () => {
    expect(ids(filterStagingRows(ROWS, f({ query: 'chromeBOOK' })))).toEqual(['A']);
    expect(ids(filterStagingRows(ROWS, f({ query: '  po-200  ' })))).toEqual(['C']);
  });

  it('treats an empty or whitespace-only query as "everything"', () => {
    expect(filterStagingRows(ROWS, f({ query: '' }))).toEqual(ROWS);
    expect(filterStagingRows(ROWS, f({ query: '   ' }))).toEqual(ROWS);
  });

  it('also searches the barcode (ISBN) and model number when the row carries them', () => {
    expect(ids(filterStagingRows(ROWS, f({ query: '9780375714573' })))).toEqual(['B']);
    expect(ids(filterStagingRows(ROWS, f({ query: 'expo-86001' })))).toEqual(['C']);
  });

  it('never interprets the query as a regular expression', () => {
    // A regex would match every row (or throw); a substring matches none.
    expect(matchesStagingSearch(A, '.*')).toBe(false);
    expect(matchesStagingSearch(A, 'PO-1(')).toBe(false);
    expect(() => matchesStagingSearch(A, '[')).not.toThrow();
  });

  it('does not match a row on fields it does not have (null PO / receipt)', () => {
    expect(matchesStagingSearch(D, 'PO-')).toBe(false);
    expect(matchesStagingSearch(D, 'null')).toBe(false);
  });
});

describe('matchesStagingPo / PO filter', () => {
  it('filters to exactly the rows on that PO (A,B -> PO-100; C -> PO-200; D -> none)', () => {
    expect(ids(filterStagingRows(ROWS, f({ poNumber: 'PO-100' })))).toEqual(['A', 'B']);
    expect(ids(filterStagingRows(ROWS, f({ poNumber: 'PO-200' })))).toEqual(['C']);
  });

  it('No PO / Unattributed selects rows with a null (or blank) sourcePoNumber', () => {
    expect(ids(filterStagingRows(ROWS, f({ poNumber: NO_PO })))).toEqual(['D']);
    const blank = row({ itemId: 'E', sourcePoNumber: '   ' });
    expect(matchesStagingPo(blank, NO_PO)).toBe(true);
    expect(matchesStagingPo(A, NO_PO)).toBe(false);
  });

  it('compares PO numbers normalised (case + whitespace), and treats null as "all"', () => {
    expect(matchesStagingPo(A, ' po-100 ')).toBe(true);
    expect(matchesStagingPo(A, 'PO-1')).toBe(false); // exact, not prefix
    expect(matchesStagingPo(D, null)).toBe(true);
    expect(matchesStagingPo(A, null)).toBe(true);
  });
});

describe('matchesStagingSource', () => {
  it('splits Staged from Unplaced by sourceKind and passes everything under All', () => {
    expect(ids(filterStagingRows(ROWS, f({ source: 'staging' })))).toEqual(['A', 'B', 'C']);
    expect(ids(filterStagingRows(ROWS, f({ source: 'unplaced' })))).toEqual(['D']);
    expect(matchesStagingSource(D, 'all')).toBe(true);
  });
});

describe('matchesStagingAge — the same 7-day rule as the Stale badge', () => {
  it('pins the shared threshold at 7 days', () => {
    expect(STALE_THRESHOLD_DAYS).toBe(7);
  });

  it('3d and 7d are recent; 8d and 14d are stale (strictly greater than 7)', () => {
    expect(isRecentAge(3)).toBe(true);
    expect(isRecentAge(7)).toBe(true);
    expect(isStaleAge(7)).toBe(false);
    expect(isStaleAge(8)).toBe(true);
    expect(isStaleAge(14)).toBe(true);
    expect(isRecentAge(8)).toBe(false);
  });

  it('filters rows into the two buckets', () => {
    // A=3d, C=7d recent; B=14d stale; D has no age at all.
    expect(ids(filterStagingRows(ROWS, f({ age: 'recent' })))).toEqual(['A', 'C']);
    expect(ids(filterStagingRows(ROWS, f({ age: 'stale' })))).toEqual(['B']);
  });

  it('a null age is in NEITHER bucket and only appears under All', () => {
    expect(matchesStagingAge(D, 'recent')).toBe(false);
    expect(matchesStagingAge(D, 'stale')).toBe(false);
    expect(matchesStagingAge(D, 'all')).toBe(true);
    expect(isRecentAge(null)).toBe(false);
    expect(isStaleAge(null)).toBe(false);
  });
});

describe('filterStagingRows — composition', () => {
  it('ANDs every filter: PO-100 + Stale leaves only Book B', () => {
    // The Books tab is a server filter, so hand in only the book rows.
    const books = ROWS.filter((r) => r.itemType === 'book');
    expect(ids(filterStagingRows(books, f({ poNumber: 'PO-100', age: 'stale' })))).toEqual(['B']);
  });

  it('search + PO combine (search "Chromebook" within PO-100 -> A only; within PO-200 -> none)', () => {
    expect(ids(filterStagingRows(ROWS, f({ query: 'Chromebook', poNumber: 'PO-100' })))).toEqual(['A']);
    expect(filterStagingRows(ROWS, f({ query: 'Chromebook', poNumber: 'PO-200' }))).toEqual([]);
  });

  it('with no filters returns every row, in order', () => {
    expect(filterStagingRows(ROWS, EMPTY_STAGING_FILTERS)).toEqual(ROWS);
  });

  it('returns the ORIGINAL row objects — same references, every field intact', () => {
    const out = filterStagingRows(ROWS, f({ poNumber: 'PO-100', age: 'stale' }));
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(B);
    expect(out[0]!.bookStorage).toEqual({ crateLabel: 'Blue 4' });
    expect(out[0]!.quantity).toBe(1);
    expect(out[0]!.itemType).toBe('book');
  });
});

describe('hasActiveStagingFilters', () => {
  it('is false for the empty set and for a whitespace-only query', () => {
    expect(hasActiveStagingFilters(EMPTY_STAGING_FILTERS)).toBe(false);
    expect(hasActiveStagingFilters(f({ query: '   ' }))).toBe(false);
  });
  it('is true when any one filter is set', () => {
    expect(hasActiveStagingFilters(f({ query: 'x' }))).toBe(true);
    expect(hasActiveStagingFilters(f({ poNumber: NO_PO }))).toBe(true);
    expect(hasActiveStagingFilters(f({ source: 'unplaced' }))).toBe(true);
    expect(hasActiveStagingFilters(f({ age: 'stale' }))).toBe(true);
  });
});

describe('buildPoOptions', () => {
  it('derives one option per PO with per-PO row counts, most recently received first', () => {
    const { options, unattributedCount } = buildPoOptions(ROWS);
    // PO-200 was received 2026-08-12 (newest); PO-100's newest row is 2026-08-10.
    expect(options).toEqual([
      { value: 'PO-200', count: 1, latestReceivedAt: '2026-08-12T00:00:00Z' },
      { value: 'PO-100', count: 2, latestReceivedAt: '2026-08-10T00:00:00Z' },
    ]);
    expect(unattributedCount).toBe(1);
  });

  it('groups differently-cased / padded spellings of the same PO into one option', () => {
    const rows = [
      row({ itemId: '1', sourcePoNumber: 'PO-100', receivedAt: '2026-08-01T00:00:00Z' }),
      row({ itemId: '2', sourcePoNumber: 'po-100 ', receivedAt: '2026-08-05T00:00:00Z' }),
    ];
    const { options } = buildPoOptions(rows);
    expect(options).toEqual([
      { value: 'PO-100', count: 2, latestReceivedAt: '2026-08-05T00:00:00Z' },
    ]);
  });

  it('breaks ties on the same date by PO number, and sorts undated POs last', () => {
    const rows = [
      row({ itemId: '1', sourcePoNumber: 'PO-9', receivedAt: null }),
      row({ itemId: '2', sourcePoNumber: 'PO-30', receivedAt: '2026-08-05T00:00:00Z' }),
      row({ itemId: '3', sourcePoNumber: 'PO-4', receivedAt: '2026-08-05T00:00:00Z' }),
    ];
    expect(buildPoOptions(rows).options.map((o) => o.value)).toEqual(['PO-4', 'PO-30', 'PO-9']);
  });

  it('reports zero unattributed rows and no options for an empty worklist', () => {
    expect(buildPoOptions([])).toEqual({ options: [], unattributedCount: 0 });
  });

  it('counts blank PO numbers as unattributed, not as a PO', () => {
    const rows = [row({ itemId: '1', sourcePoNumber: '  ' }), row({ itemId: '2', sourcePoNumber: null })];
    expect(buildPoOptions(rows)).toEqual({ options: [], unattributedCount: 2 });
  });
});

describe('formatStagingCount', () => {
  it('reads "N items" when nothing is hidden and "V of N items" when something is', () => {
    expect(formatStagingCount(142, 142)).toBe('142 items');
    expect(formatStagingCount(18, 142)).toBe('18 of 142 items');
    expect(formatStagingCount(12, 100)).toBe('12 of 100 items');
    expect(formatStagingCount(0, 100)).toBe('0 of 100 items');
  });
  it('uses the singular for a single-row worklist', () => {
    expect(formatStagingCount(1, 1)).toBe('1 item');
    expect(formatStagingCount(0, 1)).toBe('0 of 1 item');
  });
});

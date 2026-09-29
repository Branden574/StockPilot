import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { ORDER_STATUS_KEYS } from '../customization/order-status';

import {
  BOOK_REPORT_DEFAULT_STATUSES,
  BOOK_REPORT_FILTER_KEYS,
  BOOK_REPORT_RANGES,
  BOOK_REPORT_SELECTABLE_STATUSES,
  BOOK_REPORT_STATUS_GROUP_KEYS,
  BOOK_REPORT_STATUS_GROUPS,
  BOOK_REPORT_COPY_UNITS,
  DEFAULT_BOOK_REPORT_QUERY,
  DEFAULT_BOOK_REPORT_STATUS_GROUPS,
  bookReportCharterEchoMatches,
  bookReportClearedQuery,
  bookReportDrillDownQuery,
  bookReportRangeEchoMatches,
  bookReportFilterArgs,
  bookReportFilterIsSet,
  bookReportOrderLink,
  bookReportWithFilter,
  bookReportWithPage,
  bookReportWithoutFilter,
  isDefaultStatusGroups,
  bookReportQuantityWording,
  bookReportQueryKey,
  bookReportIdentityParts,
  bookReportRowIdentity,
  bookReportStatusLabels,
  formatBookReportIdentityLine,
  formatReportDate,
  formatReportDateRange,
  formatReportDateTime,
  formatReportQuantity,
  formatReportTime,
  parseBookOrderOptionsAnswer,
  parseBookOrderOptionsResponse,
  parseBookOrderOrdersAnswer,
  parseBookOrderOrdersResponse,
  parseBookOrderTotalsAnswer,
  parseBookOrderTotalsResponse,
  parseBookReportQuery,
  resolvedBookReportQuery,
  serializeBookReportQuery,
  statusesForGroups,
  sumReportQuantities,
  validateCustomDate,
  type BookReportQuery,
  type BookReportStatusGroup,
} from './book-order-totals';

// The two status lists as literals. supabase/tests/0379_book_order_totals.test.sql
// holds the same literals (all13, def11), and every migration that defines a
// book_order_* function holds them as c_allowed and c_default: the pins below
// read those files.
const ALL_13 = [
  'pending_approval',
  'approved',
  'pick_slip_generated',
  'picking_in_progress',
  'picking_complete',
  'packing_slip_generated',
  'staged_for_pickup',
  'staged_for_delivery',
  'in_transit',
  'backordered',
  'completed',
  'denied',
  'cancelled',
];
const DEFAULT_11 = ALL_13.filter((s) => s !== 'denied' && s !== 'cancelled');

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const MIGRATIONS = path.join(REPO, 'supabase/migrations');
const PGTAP = path.join(REPO, 'supabase/tests');

/**
 * How many copies of each literal list a migration that defines the report's
 * functions holds. EXACT counts: a new copy (another function, a drifted
 * duplicate) must be added here on purpose (plan 9.1, critic finding 11).
 *   - 0379: c_allowed in the lines helper, totals, drill-down and options;
 *     c_default in the first three; the unit list in totals and drill-down.
 *   - 0382 (…_book_order_totals_charter_dates.sql, whatever its number
 *     becomes): c_allowed also in the charters block (5); the unit list in
 *     the lines helper's counts_as_copies and the drill-down's book CTE (the
 *     totals take counts_as_copies from the lines, one copy-unit source).
 */
const LITERAL_COUNTS: ReadonlyArray<{
  file: RegExp;
  allowed: number;
  defaults: number;
  units: number;
}> = [
  { file: /^0379_book_order_totals\.sql$/, allowed: 4, defaults: 3, units: 2 },
  { file: /^\d{4}_book_order_totals_charter_dates\.sql$/, allowed: 5, defaults: 3, units: 2 },
];

/** SQL without its `--` line comments (a comment is not a copy). */
function sqlCode(text: string): string {
  return text.replace(/--[^\n]*/g, '');
}

function sqlList(body: string): string[] {
  return body
    .split(',')
    .map((x) => x.trim().replace(/^'|'$/g, ''))
    .filter((x) => x.length > 0);
}

/** Every `<name> constant text[] := array[...]` in the file. */
function sqlArrays(code: string, name: string): string[][] {
  const re = new RegExp(`\\b${name}\\s+constant\\s+text\\[\\]\\s*:=\\s*array\\[([^\\]]*)\\]`, 'gi');
  return [...code.matchAll(re)].map((m) => sqlList(m[1]!));
}

/** Every copy-unit list literal: a parenthesised list that starts 'unit'. */
function sqlUnitLists(code: string): string[][] {
  return [...code.matchAll(/\(\s*'unit'\s*,([^)]*)\)/g)].map((m) => ['unit', ...sqlList(m[1]!)]);
}

function count(code: string, literal: string): number {
  return code.split(literal).length - 1;
}

/** Migrations that create a public.book_order_* function. */
function reportMigrations(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .filter((f) =>
      /create\s+(or\s+replace\s+)?function\s+public\.book_order_/i.test(
        sqlCode(readFileSync(path.join(MIGRATIONS, f), 'utf8')),
      ),
    )
    .sort();
}

describe('status groups and the SQL lists', () => {
  it('the groups plus pending_confirmation are exactly ORDER_STATUS_KEYS (a new status fails here until someone places it)', () => {
    const grouped = BOOK_REPORT_STATUS_GROUP_KEYS.flatMap((g) => [
      ...BOOK_REPORT_STATUS_GROUPS[g].statuses,
    ]);
    expect(new Set(grouped).size).toBe(grouped.length);
    expect([...grouped, 'pending_confirmation'].sort()).toEqual([...ORDER_STATUS_KEYS].sort());
  });
  it('selectable = 13, default = 11, in canonical order, equal to the shared literals', () => {
    expect([...BOOK_REPORT_SELECTABLE_STATUSES]).toEqual(ALL_13);
    expect([...BOOK_REPORT_DEFAULT_STATUSES]).toEqual(DEFAULT_11);
    expect(BOOK_REPORT_SELECTABLE_STATUSES).not.toContain('pending_confirmation');
  });
  it('statusesForGroups dedupes and keeps canonical order', () => {
    expect(statusesForGroups(['cancelled', 'awaiting', 'awaiting'])).toEqual([
      'pending_approval',
      'cancelled',
    ]);
  });

  it('every migration that defines the report is pinned, with exact counts', () => {
    const files = reportMigrations();
    expect(files).toContain('0379_book_order_totals.sql');
    for (const f of files) {
      // A migration that (re)defines the report's functions and is not in
      // LITERAL_COUNTS fails here until its lists are pinned on purpose.
      expect(
        LITERAL_COUNTS.some((c) => c.file.test(f)),
        `${f} defines book_order_* functions but its literal lists are not pinned`,
      ).toBe(true);
    }
    // The charter-dates migration, once it exists, is the one that adds the
    // charters block; nothing else may define it.
    for (const f of files) {
      const code = sqlCode(readFileSync(path.join(MIGRATIONS, f), 'utf8'));
      const definesCharters = /function\s+public\.book_order_report_charters\s*\(/i.test(code);
      expect(definesCharters, f).toBe(/_book_order_totals_charter_dates\.sql$/.test(f));
    }
  });

  function pinLiterals(file: string, expected: (typeof LITERAL_COUNTS)[number]): void {
    const code = sqlCode(readFileSync(path.join(MIGRATIONS, file), 'utf8'));
    const allowed = sqlArrays(code, 'c_allowed');
    const defaults = sqlArrays(code, 'c_default');
    const units = sqlUnitLists(code);
    expect(allowed, `${file} c_allowed copies`).toHaveLength(expected.allowed);
    expect(defaults, `${file} c_default copies`).toHaveLength(expected.defaults);
    expect(units, `${file} unit lists`).toHaveLength(expected.units);
    for (const a of allowed) expect(a).toEqual(ALL_13);
    for (const d of defaults) expect(d).toEqual(DEFAULT_11);
    for (const u of units) expect(u).toEqual([...BOOK_REPORT_COPY_UNITS]);
    // No stray copy under another name: every quoted 'pending_approval' and
    // 'pieces' in the code is inside one of the pinned lists.
    expect(count(code, "'pending_approval'"), `${file} stray status lists`).toBe(
      expected.allowed + expected.defaults,
    );
    expect(count(code, "'pieces'"), `${file} stray unit lists`).toBe(expected.units);
  }

  it('0379: every c_allowed (4), c_default (3) and unit list (2) equals the shared lists', () => {
    pinLiterals('0379_book_order_totals.sql', LITERAL_COUNTS[0]!);
  });

  // The SQL step writes this migration side by side with this core step
  // (plan 14), so until it exists this test reports as SKIPPED (visible), and
  // the test above still fails any other migration that defines the report.
  const charterDates = readdirSync(MIGRATIONS).filter((f) => LITERAL_COUNTS[1]!.file.test(f));
  it.skipIf(charterDates.length === 0)(
    'charter dates (0382): every c_allowed (5), c_default (3) and unit list (2) equals the shared lists',
    () => {
      expect(charterDates).toHaveLength(1);
      pinLiterals(charterDates[0]!, LITERAL_COUNTS[1]!);
    },
  );

  it('pgTAP files that name the lists hold the same literals (0379, and 0382 when written)', () => {
    const tests = readdirSync(PGTAP).filter((f) => /book_order_totals/.test(f));
    expect(tests).toContain('0379_book_order_totals.test.sql');
    for (const f of tests) {
      const text = readFileSync(path.join(PGTAP, f), 'utf8');
      const lit = (name: string) => {
        const m = new RegExp(`\\\\set ${name}\\s+'\\\\'\\{([^}]+)\\}\\\\''`).exec(text);
        return m ? m[1]!.split(',') : null;
      };
      const all13 = lit('all13');
      const def11 = lit('def11');
      if (f === '0379_book_order_totals.test.sql') {
        expect(all13).toEqual(ALL_13);
        expect(def11).toEqual(DEFAULT_11);
      }
      if (all13) expect(all13, f).toEqual(ALL_13);
      if (def11) expect(def11, f).toEqual(DEFAULT_11);
    }
  });

  it('the pin helpers find what they should (a drifted copy fails)', () => {
    const good = `c_allowed constant text[] := array['a',\n  'b'];  -- 'pending_approval' in a comment\n in ('unit','units', 'ea')`;
    expect(sqlArrays(sqlCode(good), 'c_allowed')).toEqual([['a', 'b']]);
    expect(sqlUnitLists(good)).toEqual([['unit', 'units', 'ea']]);
    expect(count(sqlCode(good), "'pending_approval'")).toBe(0);
    const twice = `${good}\nC_ALLOWED constant text[] := array['a','c'];`;
    expect(sqlArrays(twice, 'c_allowed')).toEqual([
      ['a', 'b'],
      ['a', 'c'],
    ]);
  });
});

describe('validateCustomDate', () => {
  it('knows leap years', () => {
    expect(validateCustomDate('2024-02-29')).toBe(true);
    expect(validateCustomDate('2026-02-29')).toBe(false);
    expect(validateCustomDate('2000-02-29')).toBe(true);
    expect(validateCustomDate('2100-02-29')).toBe(false);
  });
  it('holds the SQL bounds and the shape', () => {
    expect(validateCustomDate('1999-12-31')).toBe(false);
    expect(validateCustomDate('2000-01-01')).toBe(true);
    expect(validateCustomDate('2100-12-31')).toBe(true);
    expect(validateCustomDate('2101-01-01')).toBe(false);
    expect(validateCustomDate('2026-9-1')).toBe(false);
    expect(validateCustomDate('2026-04-31')).toBe(false);
    expect(validateCustomDate(20260401)).toBe(false);
  });
});

const W = '0f1e2d3c-4b5a-4968-8776-655443322110';
const C = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const CH = '1a2b3c4d-5e6f-4a0b-9c1d-2e3f4a5b6c7d';

describe('parseBookReportQuery / serializeBookReportQuery', () => {
  it('an empty URL is the default query (All time, default statuses, warehouse default)', () => {
    const { query, invalid } = parseBookReportQuery({});
    expect(invalid).toEqual([]);
    expect(query).toEqual(DEFAULT_BOOK_REPORT_QUERY);
    expect(serializeBookReportQuery(query)).toBe('');
  });
  it('round-trips every key in one canonical order (charter first)', () => {
    const qs =
      `charter=${CH}&range=custom&from=2026-01-01&to=2026-03-31&status=awaiting%2Ccancelled&warehouse=` +
      W +
      '&wview=1&category=none&q=The%20Hobbit&sort=title&page=3';
    const { query, invalid } = parseBookReportQuery(new URLSearchParams(qs));
    expect(invalid).toEqual([]);
    expect(query).toMatchObject({
      charter: CH,
      range: 'custom',
      from: '2026-01-01',
      to: '2026-03-31',
      statusGroups: ['awaiting', 'cancelled'],
      warehouse: W,
      warehouseFromView: true,
      category: 'none',
      q: 'The Hobbit',
      sort: 'title',
      page: 3,
    });
    expect(serializeBookReportQuery(query)).toBe(qs);
    // A different key order in, the same string out.
    const shuffled = new URLSearchParams(qs.split('&').reverse().join('&'));
    expect(serializeBookReportQuery(parseBookReportQuery(shuffled).query)).toBe(qs);
  });
  it('names each invalid key and falls back to its default', () => {
    const { query, invalid } = parseBookReportQuery({
      range: 'forever',
      status: 'awaiting,shipped',
      warehouse: 'DC4',
      category: 'fiction',
      q: 'x'.repeat(101),
      sort: 'price',
      page: '0',
    });
    expect(invalid).toEqual(['range', 'status', 'warehouse', 'category', 'q', 'sort', 'page']);
    expect(query).toEqual(DEFAULT_BOOK_REPORT_QUERY);
    const bad = parseBookReportQuery({ charter: 'Marconi' });
    expect(bad.invalid).toEqual(['charter']);
    expect(bad.query.charter).toBe('all');
  });
  it('a custom range needs two real days in order; otherwise it resets to All time', () => {
    expect(
      parseBookReportQuery({ range: 'custom', from: '2026-03-02', to: '2026-03-01' }),
    ).toMatchObject({
      query: { range: 'all', from: null, to: null },
      invalid: ['to'],
    });
    expect(
      parseBookReportQuery({ range: 'custom', from: '2026-02-30', to: '2026-03-01' }).invalid,
    ).toEqual(['from']);
    expect(parseBookReportQuery({ range: 'custom' }).invalid).toEqual(['from', 'to']);
    // from/to without custom are ignored, not errors.
    expect(parseBookReportQuery({ range: '30d', from: 'junk' })).toMatchObject({
      invalid: [],
      query: { from: null },
    });
  });
  it('an empty status list is invalid (at least one group)', () => {
    expect(parseBookReportQuery({ status: '' }).invalid).toEqual(['status']);
    expect(parseBookReportQuery({ status: ',' }).invalid).toEqual(['status']);
  });
  it('wview only labels a uuid warehouse', () => {
    expect(parseBookReportQuery({ warehouse: 'all', wview: '1' }).query.warehouseFromView).toBe(
      false,
    );
    expect(parseBookReportQuery({ wview: '1' }).query.warehouseFromView).toBe(false);
    expect(
      serializeBookReportQuery({
        ...DEFAULT_BOOK_REPORT_QUERY,
        warehouse: 'all',
        warehouseFromView: true,
      }),
    ).toBe('warehouse=all');
  });
  it('category none and a category uuid round-trip; uuids are lower-cased', () => {
    const q = parseBookReportQuery({ category: C.toUpperCase() }).query;
    expect(q.category).toBe(C);
    expect(serializeBookReportQuery(parseBookReportQuery({ category: 'none' }).query)).toBe(
      'category=none',
    );
  });
  it('reads Next-style records with repeated params (first wins)', () => {
    expect(parseBookReportQuery({ sort: ['orders', 'title'] }).query.sort).toBe('orders');
  });
});

describe('the charter key (0382)', () => {
  it('all (or absent), none and a uuid; uuids are lower-cased; anything else is named', () => {
    expect(parseBookReportQuery({}).query.charter).toBe('all');
    expect(parseBookReportQuery({ charter: 'all' })).toMatchObject({
      query: { charter: 'all' },
      invalid: [],
    });
    expect(parseBookReportQuery({ charter: 'none' }).query.charter).toBe('none');
    expect(parseBookReportQuery({ charter: CH.toUpperCase() }).query.charter).toBe(CH);
    for (const bad of ['', 'ALL', 'None', 'Marconi', `${CH}x`, CH.slice(0, 35), '../x']) {
      const r = parseBookReportQuery({ charter: bad });
      expect(r.invalid, bad).toEqual(['charter']);
      expect(r.query.charter).toBe('all');
    }
  });
  it('is written first, and left out for all charters', () => {
    expect(serializeBookReportQuery({ ...DEFAULT_BOOK_REPORT_QUERY, charter: 'all' })).toBe('');
    expect(serializeBookReportQuery({ ...DEFAULT_BOOK_REPORT_QUERY, charter: 'none' })).toBe(
      'charter=none',
    );
    expect(
      serializeBookReportQuery({
        ...DEFAULT_BOOK_REPORT_QUERY,
        charter: CH,
        range: 'month',
        warehouse: 'all',
        page: 2,
      }),
    ).toBe(`charter=${CH}&range=month&warehouse=all&page=2`);
    // Parsing does not depend on the order.
    const late = new URLSearchParams(`warehouse=all&page=2&range=month&charter=${CH}`);
    expect(serializeBookReportQuery(parseBookReportQuery(late).query)).toBe(
      `charter=${CH}&range=month&warehouse=all&page=2`,
    );
  });
  it('reaches the query key, so a remembered answer is per charter', () => {
    const a = bookReportQueryKey({ ...DEFAULT_BOOK_REPORT_QUERY, warehouse: 'all' });
    const b = bookReportQueryKey({ ...DEFAULT_BOOK_REPORT_QUERY, warehouse: 'all', charter: CH });
    const c = bookReportQueryKey({
      ...DEFAULT_BOOK_REPORT_QUERY,
      warehouse: 'all',
      charter: 'none',
    });
    expect(new Set([a, b, c]).size).toBe(3);
  });
  it('bookReportFilterArgs: a uuid is charterId, none is noCharter, all is neither', () => {
    expect(bookReportFilterArgs(DEFAULT_BOOK_REPORT_QUERY)).toMatchObject({
      charterId: null,
      noCharter: false,
    });
    expect(bookReportFilterArgs({ ...DEFAULT_BOOK_REPORT_QUERY, charter: CH })).toMatchObject({
      charterId: CH,
      noCharter: false,
    });
    expect(bookReportFilterArgs({ ...DEFAULT_BOOK_REPORT_QUERY, charter: 'none' })).toMatchObject({
      charterId: null,
      noCharter: true,
    });
    // A hand-built query with junk never reaches SQL as an id.
    expect(
      bookReportFilterArgs({ ...DEFAULT_BOOK_REPORT_QUERY, charter: 'Marconi' }),
    ).toMatchObject({ charterId: null, noCharter: false });
  });
});

describe('date presets and date-only links (0382)', () => {
  it('Today and This week are presets, in the brief order', () => {
    expect([...BOOK_REPORT_RANGES]).toEqual([
      'all',
      'today',
      'week',
      'month',
      '30d',
      '90d',
      'year',
      'custom',
    ]);
    for (const r of ['today', 'week'] as const) {
      const { query, invalid } = parseBookReportQuery({ range: r });
      expect(invalid).toEqual([]);
      expect(query.range).toBe(r);
      expect(serializeBookReportQuery(query)).toBe(`range=${r}`);
    }
  });
  it('from and to with no range are a custom range (the brief example link)', () => {
    const link = new URLSearchParams(`charter=${CH}&from=2026-09-01&to=2026-09-30&page=1`);
    const { query, invalid } = parseBookReportQuery(link);
    expect(invalid).toEqual([]);
    expect(query).toMatchObject({
      charter: CH,
      range: 'custom',
      from: '2026-09-01',
      to: '2026-09-30',
      page: 1,
    });
    // Written back with range=custom, so a phone without date-only links
    // still reads the dates.
    expect(serializeBookReportQuery(query)).toBe(
      `charter=${CH}&range=custom&from=2026-09-01&to=2026-09-30`,
    );
  });
  it('a date-only link with a bad or missing day names it and falls back to All time', () => {
    expect(parseBookReportQuery({ from: '2026-09-01' })).toMatchObject({
      query: { range: 'all', from: null, to: null },
      invalid: ['to'],
    });
    expect(parseBookReportQuery({ to: '2026-09-30' })).toMatchObject({
      query: { range: 'all' },
      invalid: ['from'],
    });
    expect(parseBookReportQuery({ from: '2026-09-31', to: '2026-10-01' }).invalid).toEqual([
      'from',
    ]);
    expect(parseBookReportQuery({ from: '2026-10-02', to: '2026-10-01' })).toMatchObject({
      query: { range: 'all' },
      invalid: ['to'],
    });
    expect(parseBookReportQuery({ from: '1999-12-31', to: '2101-01-01' }).invalid).toEqual([
      'from',
      'to',
    ]);
  });
  it('blank from= / to= imply nothing (a form sent with empty fields)', () => {
    expect(parseBookReportQuery({ from: '', to: '' })).toMatchObject({
      query: { range: 'all' },
      invalid: [],
    });
  });
  it('a named range keeps its own days: the dates are ignored, not named', () => {
    for (const range of ['all', 'today', 'week', 'month', '30d', '90d', 'year']) {
      const r = parseBookReportQuery({ range, from: '2026-09-01', to: 'junk' });
      expect(r.invalid, range).toEqual([]);
      expect(r.query).toMatchObject({ range, from: null, to: null });
    }
    // An invalid range is named and the dates do not turn it into custom.
    expect(
      parseBookReportQuery({ range: 'fortnight', from: '2026-09-01', to: '2026-09-30' }),
    ).toMatchObject({ query: { range: 'all', from: null }, invalid: ['range'] });
  });
  it('dates are written only with range=custom, and range=custom always with them', () => {
    expect(
      serializeBookReportQuery({
        ...DEFAULT_BOOK_REPORT_QUERY,
        range: 'month',
        from: '2026-09-01',
        to: '2026-09-30',
      }),
    ).toBe('range=month');
    expect(
      serializeBookReportQuery({
        ...DEFAULT_BOOK_REPORT_QUERY,
        range: 'custom',
        from: '2026-09-01',
        to: '2026-09-30',
      }),
    ).toBe('range=custom&from=2026-09-01&to=2026-09-30');
  });
  it('round-trips every preset and charter together (property check)', () => {
    let seed = 11;
    const pick = <T>(xs: readonly T[]): T => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return xs[seed % xs.length]!;
    };
    for (let i = 0; i < 400; i++) {
      const range = pick(BOOK_REPORT_RANGES);
      const q: BookReportQuery = {
        ...DEFAULT_BOOK_REPORT_QUERY,
        charter: pick(['all', 'none', CH]),
        range,
        from: range === 'custom' ? '2026-03-08' : null,
        to: range === 'custom' ? pick(['2026-03-08', '2026-11-01']) : null,
        statusGroups: pick([
          [...DEFAULT_BOOK_REPORT_STATUS_GROUPS],
          ['awaiting'] as BookReportStatusGroup[],
          [...BOOK_REPORT_STATUS_GROUP_KEYS],
        ]),
        warehouse: pick(['default', 'all', W]),
        category: pick(['all', 'none', C]),
        q: pick(['', 'Outsiders', 'a&b=c']),
        sort: pick(['copies', 'title', 'orders', 'latest'] as const),
        page: pick([1, 2, 40]),
      };
      q.warehouseFromView = isUuidLike(q.warehouse) && pick([true, false]);
      const s = serializeBookReportQuery(q);
      const back = parseBookReportQuery(new URLSearchParams(s));
      expect(back.invalid).toEqual([]);
      expect(back.query).toEqual(q);
      expect(s.startsWith('charter=')).toBe(q.charter !== 'all');
    }
  });
});

function isUuidLike(v: string): boolean {
  return /^[0-9a-f-]{36}$/.test(v);
}

describe('page-reset rules, chip removal and Clear filters', () => {
  const busy: BookReportQuery = {
    ...DEFAULT_BOOK_REPORT_QUERY,
    charter: CH,
    range: 'custom',
    from: '2026-09-01',
    to: '2026-09-30',
    statusGroups: ['awaiting', 'denied'],
    warehouse: W,
    warehouseFromView: false,
    category: C,
    q: 'Outsiders',
    sort: 'title',
    page: 4,
  };
  it('a filter change (charter, dates, status, search, warehouse, category) starts at page 1', () => {
    const patches: Array<Partial<BookReportQuery>> = [
      { charter: 'none' },
      { range: 'week', from: null, to: null },
      { statusGroups: ['completed'] },
      { q: 'Hobbit' },
      { warehouse: 'all' },
      { category: 'none' },
      { sort: 'orders' },
    ];
    for (const patch of patches) {
      const next = bookReportWithFilter(busy, patch);
      expect(next.page).toBe(1);
      expect(next).toMatchObject(patch);
    }
  });
  it('a page change keeps every filter', () => {
    const next = bookReportWithPage(busy, 2);
    expect(next).toEqual({ ...busy, page: 2 });
    expect(bookReportWithPage(busy, 0).page).toBe(1);
    expect(bookReportWithPage(busy, 2.7).page).toBe(2);
    expect(bookReportWithPage(busy, Number.NaN).page).toBe(1);
    const url = serializeBookReportQuery(next);
    expect(url).toContain(`charter=${CH}`);
    expect(url).toContain('from=2026-09-01&to=2026-09-30');
    expect(url).toContain('q=Outsiders');
    expect(url).toContain('page=2');
  });
  it('never shares the status list with the query it came from', () => {
    const next = bookReportWithFilter(busy, { charter: 'all' });
    next.statusGroups.push('completed');
    expect(busy.statusGroups).toEqual(['awaiting', 'denied']);
  });
  it('removing one filter resets only it, writes every value out, and goes to page 1', () => {
    expect(bookReportWithoutFilter(busy, 'charter')).toEqual({ ...busy, charter: 'all', page: 1 });
    expect(bookReportWithoutFilter(busy, 'dates')).toEqual({
      ...busy,
      range: 'all',
      from: null,
      to: null,
      page: 1,
    });
    expect(bookReportWithoutFilter(busy, 'status')).toEqual({
      ...busy,
      statusGroups: [...DEFAULT_BOOK_REPORT_STATUS_GROUPS],
      page: 1,
    });
    expect(bookReportWithoutFilter(busy, 'warehouse')).toEqual({
      ...busy,
      warehouse: 'default',
      warehouseFromView: false,
      page: 1,
    });
    expect(bookReportWithoutFilter(busy, 'category')).toEqual({
      ...busy,
      category: 'all',
      page: 1,
    });
    expect(bookReportWithoutFilter(busy, 'q')).toEqual({ ...busy, q: '', page: 1 });
  });
  it('Clear filters resets every filter and keeps the sort', () => {
    expect(bookReportClearedQuery(busy)).toEqual({
      ...DEFAULT_BOOK_REPORT_QUERY,
      sort: 'title',
      page: 1,
    });
    expect(serializeBookReportQuery(bookReportClearedQuery(busy))).toBe('sort=title');
    for (const key of BOOK_REPORT_FILTER_KEYS) {
      expect(bookReportFilterIsSet(bookReportClearedQuery(busy), key), key).toBe(false);
    }
  });
  it('knows which filters are set; a view warehouse and all warehouses are not a choice to remove', () => {
    for (const key of BOOK_REPORT_FILTER_KEYS) {
      expect(bookReportFilterIsSet(busy, key), key).toBe(true);
      expect(bookReportFilterIsSet(DEFAULT_BOOK_REPORT_QUERY, key), key).toBe(false);
    }
    expect(bookReportFilterIsSet({ ...busy, warehouseFromView: true }, 'warehouse')).toBe(false);
    expect(bookReportFilterIsSet({ ...busy, warehouse: 'all' }, 'warehouse')).toBe(false);
    expect(bookReportFilterIsSet({ ...busy, q: '   ' }, 'q')).toBe(false);
    expect(
      bookReportFilterIsSet(
        { ...busy, statusGroups: [...DEFAULT_BOOK_REPORT_STATUS_GROUPS].reverse() },
        'status',
      ),
    ).toBe(false);
    expect(isDefaultStatusGroups(['awaiting', 'in_progress', 'backordered'])).toBe(false);
  });
});

describe('resolvedBookReportQuery', () => {
  const groups: BookReportStatusGroup[][] = [
    ['awaiting'],
    ['completed', 'denied'],
    [...BOOK_REPORT_STATUS_GROUP_KEYS],
  ];
  const warehouses: BookReportQuery['warehouse'][] = ['default', 'all', W];
  const resolutions = [
    { id: null, source: 'all' as const },
    { id: W, source: 'view' as const },
    { id: W, source: 'explicit' as const },
  ];
  it('never serializes warehouse=default, and writes wview=1 only for a view-sourced uuid (property check)', () => {
    let seed = 7;
    const pick = <T>(xs: readonly T[]): T => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return xs[seed % xs.length]!;
    };
    for (let i = 0; i < 500; i++) {
      const q: BookReportQuery = {
        ...DEFAULT_BOOK_REPORT_QUERY,
        statusGroups: pick(groups),
        warehouse: pick(warehouses),
        warehouseFromView: pick([true, false]),
        category: pick(['all', 'none', C]),
        q: pick(['', 'hobbit', '0-14-044913-2']),
        sort: pick(['copies', 'title', 'orders', 'latest'] as const),
        page: pick([1, 2, 9]),
      };
      const r = pick(resolutions);
      const s = serializeBookReportQuery(resolvedBookReportQuery(q, r));
      expect(s).toContain('warehouse=');
      expect(s).not.toContain('warehouse=default');
      expect(s.includes('wview=1')).toBe(r.id !== null && r.source === 'view');
      // And it parses back to the same concrete warehouse.
      expect(parseBookReportQuery(new URLSearchParams(s)).query.warehouse).toBe(r.id ?? 'all');
    }
  });
  it('bookReportQueryKey always carries the page', () => {
    expect(bookReportQueryKey({ ...DEFAULT_BOOK_REPORT_QUERY, warehouse: 'all' })).toBe(
      'warehouse=all&page=1',
    );
    expect(bookReportQueryKey({ ...DEFAULT_BOOK_REPORT_QUERY, warehouse: 'all', page: 4 })).toBe(
      'warehouse=all&page=4',
    );
  });
});

describe('bookReportFilterArgs', () => {
  it('maps groups to statuses, category to an id or "no category", and a valid ISBN to keys', () => {
    const a = bookReportFilterArgs({
      ...DEFAULT_BOOK_REPORT_QUERY,
      category: 'none',
      q: ' 0-14-044913-2 ',
    });
    expect(a.statuses).toEqual(DEFAULT_11);
    expect(a).toMatchObject({
      categoryId: null,
      uncategorized: true,
      search: '0-14-044913-2',
      isbnKeys: ['0140449132', '9780140449136'],
    });
    const b = bookReportFilterArgs({
      ...DEFAULT_BOOK_REPORT_QUERY,
      category: C,
      q: 'hobbit',
      range: '30d',
      from: '2026-01-01',
    });
    expect(b).toMatchObject({
      categoryId: C,
      uncategorized: false,
      search: 'hobbit',
      isbnKeys: null,
      from: null,
    });
  });
});

describe('formatting never converts a time zone', () => {
  const tz = process.env.TZ;
  afterEach(() => {
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  });
  it('prints the org-local strings SQL returned identically in any process zone', () => {
    const out = (zone: string) => {
      process.env.TZ = zone;
      return [
        formatReportDate('2026-02-28'),
        formatReportTime('2026-09-28 00:05'),
        formatReportTime('2026-09-28 12:30'),
        formatReportDateTime('2026-09-28 10:42'),
        formatReportDateRange('2026-08-30', '2026-09-28'),
        formatReportDateRange('2025-12-01', '2026-01-05'),
      ];
    };
    const akl = out('Pacific/Auckland');
    const utc = out('UTC');
    const la = out('America/Los_Angeles');
    expect(akl).toEqual(utc);
    expect(la).toEqual(utc);
    expect(utc).toEqual([
      'Feb 28, 2026',
      '12:05 AM',
      '12:30 PM',
      'Sep 28, 2026, 10:42 AM',
      'Aug 30 – Sep 28, 2026',
      'Dec 1, 2025 – Jan 5, 2026',
    ]);
    // What going through Date would have done: the Feb 28 day read back in
    // Auckland is not the same string, which is why the helpers never do it.
    process.env.TZ = 'Pacific/Auckland';
    expect(new Date('2026-02-28T20:00:00-08:00').toDateString()).not.toContain('Feb 28');
  });
});

describe('formatReportQuantity', () => {
  it('groups thousands and keeps up to 4 decimals exactly', () => {
    expect(formatReportQuantity('1234')).toBe('1,234');
    expect(formatReportQuantity('12.3456')).toBe('12.3456');
    expect(formatReportQuantity('1234567.5')).toBe('1,234,567.5');
    expect(formatReportQuantity('0')).toBe('0');
    expect(formatReportQuantity('007')).toBe('7');
    expect(formatReportQuantity('12.34565')).toBe('12.3457');
    expect(formatReportQuantity('9.99995')).toBe('10');
    expect(formatReportQuantity('12.50')).toBe('12.5');
  });
  it('is not the default Intl formatter, which rounds at 3 decimals', () => {
    expect((12.3456).toLocaleString('en-US')).toBe('12.346');
    expect(formatReportQuantity('12.3456')).not.toBe((12.3456).toLocaleString('en-US'));
  });
  it('leaves anything that is not a quantity as it is', () => {
    expect(formatReportQuantity('n/a')).toBe('n/a');
  });
});

describe('sumReportQuantities', () => {
  it('adds exactly, in trim_scale form', () => {
    expect(sumReportQuantities(['30', '4'])).toBe('34');
    expect(sumReportQuantities(['1.5', '2.25', '0.25'])).toBe('4');
    expect(sumReportQuantities(['0.1', '0.2'])).toBe('0.3');
    expect(sumReportQuantities([])).toBe('0');
    expect(sumReportQuantities(['12.3456', '0.0001'])).toBe('12.3457');
    expect(sumReportQuantities(['-2', '1.5'])).toBe('-0.5');
    expect(sumReportQuantities(['99999999999999999999', '1'])).toBe('100000000000000000000');
  });
  it('refuses a value that is not a quantity', () => {
    expect(() => sumReportQuantities(['1e3'])).toThrow();
  });
});

describe('row identity and wording', () => {
  it('labels an identifier ISBN only when its checksum passes', () => {
    expect(
      bookReportRowIdentity({
        sku: 'BK-1',
        identifier: '978-0-14-044913-6',
        warehouseName: 'DC4',
        binLocation: '12-B',
      }),
    ).toEqual({
      skuLabel: 'SKU BK-1',
      identifierLabel: 'ISBN',
      identifier: '978-0-14-044913-6',
      place: 'DC4 · Rack 12-B',
    });
    expect(
      bookReportRowIdentity({
        sku: null,
        identifier: '9780140449137',
        warehouseName: null,
        binLocation: null,
      }),
    ).toEqual({
      skuLabel: null,
      identifierLabel: 'Barcode',
      identifier: '9780140449137',
      place: '',
    });
    expect(
      formatBookReportIdentityLine({
        sku: 'BK-123',
        identifier: '9780140449136',
        warehouseName: 'DC4',
        binLocation: '12-B',
      }),
    ).toBe('SKU BK-123 · ISBN 9780140449136 · DC4 · Rack 12-B');
  });
  it('gives the identity line as pieces that join to exactly the line', () => {
    const rows = [
      { sku: 'BK-1', identifier: '978-0-14-044913-6', warehouseName: 'DC4', binLocation: '12-B' },
      { sku: ' BK-2 ', identifier: null, warehouseName: null, binLocation: ' 7-A ' },
      { sku: null, identifier: '9780140449137', warehouseName: 'Main DC', binLocation: null },
      { sku: null, identifier: null, warehouseName: '  ', binLocation: null },
    ];
    expect(bookReportIdentityParts(rows[0]!)).toEqual([
      { kind: 'sku', text: 'SKU BK-1' },
      { kind: 'identifier', text: 'ISBN 978-0-14-044913-6' },
      { kind: 'warehouse', text: 'DC4' },
      { kind: 'rack', text: 'Rack 12-B' },
    ]);
    expect(bookReportIdentityParts(rows[3]!)).toEqual([]);
    for (const row of rows) {
      expect(
        bookReportIdentityParts(row)
          .map((p) => p.text)
          .join(' · '),
      ).toBe(formatBookReportIdentityLine(row));
    }
    expect(formatBookReportIdentityLine(rows[1]!)).toBe('SKU BK-2 · Rack 7-A');
    expect(formatBookReportIdentityLine(rows[2]!)).toBe('Barcode 9780140449137 · Main DC');
  });
  it('says copies only for single-copy units', () => {
    expect(bookReportQuantityWording({ countsAsCopies: true, unit: 'ea' }).column).toBe(
      'Copies of this book requested',
    );
    expect(bookReportQuantityWording({ countsAsCopies: false, unit: 'pack of 10' })).toEqual({
      countsAsCopies: false,
      column: 'Quantity of this book requested (pack of 10)',
      lead: 'Quantity requested (pack of 10)',
    });
    expect(bookReportQuantityWording({ countsAsCopies: false, unit: '  ' }).lead).toBe(
      'Quantity requested (no unit)',
    );
  });
  it('links an order only when it is openable', () => {
    const id = '11111111-2222-4333-8444-555555555555';
    expect(bookReportOrderLink({ openable: false, orderId: id }, 'web')).toBeNull();
    expect(bookReportOrderLink({ openable: true, orderId: id }, 'web')).toBe(
      `/dashboard/orders/${id}`,
    );
    expect(bookReportOrderLink({ openable: true, orderId: id }, 'phone')).toBe(`/order/${id}`);
    expect(bookReportOrderLink({ openable: true, orderId: '../x' }, 'web')).toBeNull();
  });
  it('carries the way back to the report on the web (return=, encoded once)', () => {
    const id = '11111111-2222-4333-8444-555555555555';
    const back = `/dashboard/reports/book-order-totals?charter=${CH}&range=custom&from=2026-09-01&to=2026-09-30&q=Outsiders&page=2&view=${W}`;
    const href = bookReportOrderLink({ openable: true, orderId: id }, 'web', back);
    expect(href).toBe(`/dashboard/orders/${id}?return=${encodeURIComponent(back)}`);
    // The order page reads it back exactly.
    expect(new URL(href!, 'https://x.test').searchParams.get('return')).toBe(back);
    // Only a same-site path is carried; the phone never needs one.
    for (const bad of [
      '//evil.com/x',
      '/\\evil.com',
      'https://evil.com/dashboard',
      'javascript:alert(1)',
      '',
      null,
      undefined,
    ]) {
      expect(bookReportOrderLink({ openable: true, orderId: id }, 'web', bad), String(bad)).toBe(
        `/dashboard/orders/${id}`,
      );
    }
    expect(bookReportOrderLink({ openable: true, orderId: id }, 'phone', back)).toBe(
      `/order/${id}`,
    );
    expect(bookReportOrderLink({ openable: false, orderId: id }, 'web', back)).toBeNull();
  });
  it("status labels are the organization's own", () => {
    const labels = bookReportStatusLabels({ completed: { label: 'Handed over' } });
    expect(labels.completed).toBe('Handed over');
    expect(labels.pending_approval).toBe('Pending');
    expect(bookReportStatusLabels(null).completed).toBe('Delivered');
  });
});

// ── Answers ────────────────────────────────────────────────────────────────
const row = {
  itemId: 'i1',
  name: 'Book A',
  sku: 'BK-A',
  identifier: '978-0-14-044913-6',
  binLocation: 'R1-A',
  unit: 'unit',
  countsAsCopies: true,
  warehouseId: W,
  warehouseName: 'North',
  itemStatus: 'active',
  deleted: false,
  nowRental: false,
  copies: '30',
  orders: 3,
  lines: 3,
  latestOrderAt: '2026-04-01T06:59:00+00:00',
  latestOrderDate: '2026-03-31',
  fulfilled: '8',
  returned: '2',
};
const totals = {
  v: 1,
  generatedAt: '2026-09-28T17:42:00.1+00:00',
  generatedAtLocal: '2026-09-28 10:42',
  range: {
    key: 'all',
    from: null,
    to: null,
    timeZone: 'America/Los_Angeles',
    timeZoneFallback: false,
  },
  statuses: DEFAULT_11,
  filters: { warehouse: null, category: null, uncategorized: false },
  scope: { restricted: false },
  summary: {
    copies: '34',
    entries: 2,
    orders: 3,
    lines: 4,
    firstOrderAt: '2026-02-10T18:00:00+00:00',
    lastOrderAt: '2026-04-01T06:59:00+00:00',
    firstOrderDate: '2026-02-10',
    lastOrderDate: '2026-03-31',
    unresolved: { entries: 0, quantity: '0' },
  },
  totalCount: 2,
  mode: 'page',
  tooMany: false,
  maxRows: null,
  page: 1,
  pageSize: 25,
  sort: 'copies',
  rows: [row, { ...row, itemId: 'i2', name: 'Book B', copies: '4', orders: 1 }],
};

describe('answer parsers', () => {
  it('parses the totals answer and ignores unknown keys', () => {
    const a = parseBookOrderTotalsAnswer({
      ...totals,
      extra: 1,
      rows: [{ ...row, futureKey: true }],
    });
    expect(a.summary.copies).toBe('34');
    expect(a.rows[0]).toEqual(row);
  });
  it('refuses a wrong shape rather than showing zeros', () => {
    expect(() => parseBookOrderTotalsAnswer({ ...totals, v: 2 })).toThrow(/totals\.v/);
    expect(() => parseBookOrderTotalsAnswer({ ...totals, summary: undefined })).toThrow(
      /totals\.summary/,
    );
    expect(() => parseBookOrderTotalsAnswer({ ...totals, rows: [{ ...row, copies: 30 }] })).toThrow(
      /copies/,
    );
    expect(() =>
      parseBookOrderTotalsAnswer({ ...totals, rows: [{ ...row, copies: '3e1' }] }),
    ).toThrow(/exact quantity/);
    expect(() => parseBookOrderTotalsAnswer({ ...totals, totalCount: 2.5 })).toThrow(/totalCount/);
    expect(() =>
      parseBookOrderTotalsAnswer({ ...totals, generatedAtLocal: '2026-09-28T10:42' }),
    ).toThrow(/generatedAtLocal/);
    expect(() => parseBookOrderTotalsAnswer(null)).toThrow();
  });
  it('the API answer needs the organization and the warehouse resolution', () => {
    expect(() => parseBookOrderTotalsResponse(totals)).toThrow(/organizationId/);
    const r = parseBookOrderTotalsResponse({
      ...totals,
      organizationId: 'org',
      warehouse: { id: W, source: 'view' },
    });
    expect(r.warehouse).toEqual({ id: W, source: 'view' });
    expect(() =>
      parseBookOrderTotalsResponse({
        ...totals,
        organizationId: 'org',
        warehouse: { id: W, source: 'cookie' },
      }),
    ).toThrow(/source/);
  });
  const orderRow = {
    orderId: 'o1',
    orderNumber: 49,
    createdAt: '2026-03-01T07:30:00+00:00',
    orderDate: '2026-02-28',
    status: 'completed',
    warehouseId: W,
    warehouseName: 'North',
    copies: '18',
    fulfilled: '0',
    returned: '0',
    lines: 2,
    lineIds: ['l1', 'l2'],
  };
  const orders = {
    v: 1,
    generatedAt: '2026-09-28T17:42:00+00:00',
    generatedAtLocal: '2026-09-28 10:42',
    found: true,
    book: {
      itemId: 'i1',
      name: 'Book A',
      sku: 'BK-A',
      identifier: null,
      binLocation: null,
      unit: 'unit',
      countsAsCopies: true,
      warehouseId: W,
      warehouseName: 'North',
      itemStatus: 'active',
      deleted: false,
      nowRental: false,
    },
    range: totals.range,
    statuses: DEFAULT_11,
    filters: { warehouse: null },
    totals: { copies: '33', orders: 3, lines: 4, fulfilled: '8', returned: '2' },
    totalCount: 3,
    page: 1,
    pageSize: 25,
  };
  it('parses the drill-down with mine (SQL) or openable (API), never both required', () => {
    const sql = parseBookOrderOrdersAnswer({ ...orders, rows: [{ ...orderRow, mine: true }] });
    expect(sql.rows[0]!.mine).toBe(true);
    const api = parseBookOrderOrdersResponse({
      ...orders,
      organizationId: 'org',
      warehouse: { id: null, source: 'all' },
      rows: [{ ...orderRow, openable: false }],
    });
    expect(api.rows[0]!.openable).toBe(false);
    expect('mine' in api.rows[0]!).toBe(false);
    expect(() =>
      parseBookOrderOrdersResponse({
        ...orders,
        organizationId: 'org',
        warehouse: { id: null, source: 'all' },
        rows: [{ ...orderRow, mine: true }],
      }),
    ).toThrow(/openable/);
  });
  it('a found drill-down must name its book; a not-found one may not', () => {
    expect(() => parseBookOrderOrdersAnswer({ ...orders, book: null, rows: [] })).toThrow(/book/);
    expect(
      parseBookOrderOrdersAnswer({ ...orders, found: false, book: null, rows: [] }).found,
    ).toBe(false);
  });
  it('parses the API options with every status label', () => {
    const labels = bookReportStatusLabels(null);
    const o = parseBookOrderOptionsResponse({
      v: 1,
      organizationId: 'org',
      warehouses: [{ id: W, name: 'North', status: 'archived' }],
      categories: [{ id: C, name: 'Fiction', deleted: true }],
      uncategorized: true,
      statusLabels: labels,
    });
    expect(o.warehouses[0]!.status).toBe('archived');
    const partial = { ...labels } as Record<string, string>;
    delete partial.cancelled;
    expect(() =>
      parseBookOrderOptionsResponse({
        v: 1,
        organizationId: 'org',
        warehouses: [],
        categories: [],
        uncategorized: false,
        statusLabels: partial,
      }),
    ).toThrow(/cancelled/);
  });

  // ── 0382 additions: every new key is optional on the wire and strict when present.
  const charterEcho = { id: CH, name: 'Charter Alder', code: 'CH-A', status: 'active' };
  it('reads the charter echo and noCharter; leaves them out when an older server sends neither', () => {
    const old = parseBookOrderTotalsAnswer(totals);
    expect('charter' in old.filters).toBe(false);
    expect('noCharter' in old.filters).toBe(false);
    expect('byCharter' in old).toBe(false);
    const withCharter = parseBookOrderTotalsAnswer({
      ...totals,
      filters: { ...totals.filters, charter: charterEcho, noCharter: false },
      byCharter: null,
    });
    expect(withCharter.filters).toMatchObject({ charter: charterEcho, noCharter: false });
    expect(withCharter.byCharter).toBeNull();
    const none = parseBookOrderTotalsAnswer({
      ...totals,
      filters: { ...totals.filters, charter: null, noCharter: true },
    });
    expect(none.filters.charter).toBeNull();
    expect(none.filters.noCharter).toBe(true);
    const noCode = parseBookOrderTotalsAnswer({
      ...totals,
      filters: { ...totals.filters, charter: { ...charterEcho, code: null } },
    });
    expect(noCode.filters.charter?.code).toBeNull();
  });
  it('refuses a charter echo, noCharter or byCharter of the wrong type', () => {
    const bad =
      (filters: object, extra: object = {}) =>
      () =>
        parseBookOrderTotalsAnswer({
          ...totals,
          filters: { ...totals.filters, ...filters },
          ...extra,
        });
    expect(bad({ charter: 'Charter Alder' })).toThrow(/filters\.charter/);
    expect(bad({ charter: { ...charterEcho, name: 7 } })).toThrow(/filters\.charter\.name/);
    expect(bad({ charter: { ...charterEcho, status: null } })).toThrow(/filters\.charter\.status/);
    expect(bad({ noCharter: 'yes' })).toThrow(/filters\.noCharter/);
    expect(bad({ noCharter: null })).toThrow(/filters\.noCharter/);
    expect(bad({}, { byCharter: {} })).toThrow(/byCharter/);
    expect(
      bad(
        {},
        { byCharter: [{ id: null, name: null, code: null, status: null, copies: 3, orders: 1 }] },
      ),
    ).toThrow(/byCharter\[0\]\.copies/);
    expect(
      bad(
        {},
        {
          byCharter: [{ id: null, name: null, code: null, status: null, copies: '3', orders: -1 }],
        },
      ),
    ).toThrow(/byCharter\[0\]\.orders/);
  });
  it('reads Books ordered by charter, No charter included (id null)', () => {
    const a = parseBookOrderTotalsAnswer({
      ...totals,
      byCharter: [
        { id: CH, name: 'Charter Alder', code: 'CH-A', status: 'active', copies: '30', orders: 2 },
        { id: null, name: null, code: null, status: null, copies: '4', orders: 1 },
      ],
    });
    expect(a.byCharter).toEqual([
      { id: CH, name: 'Charter Alder', code: 'CH-A', status: 'active', copies: '30', orders: 2 },
      { id: null, name: null, code: null, status: null, copies: '4', orders: 1 },
    ]);
  });
  it('accepts the Today and This week echoes', () => {
    for (const key of ['today', 'week']) {
      const a = parseBookOrderTotalsAnswer({
        ...totals,
        range: { ...totals.range, key, from: '2026-09-27', to: '2026-09-29' },
      });
      expect(a.range.key).toBe(key);
    }
    expect(() =>
      parseBookOrderTotalsAnswer({ ...totals, range: { ...totals.range, key: 'fortnight' } }),
    ).toThrow(/range\.key/);
  });
  it('drill-down rows carry their charter (null for a pickup), strictly, and the echo', () => {
    const r = parseBookOrderOrdersResponse({
      ...orders,
      filters: { warehouse: null, charter: charterEcho, noCharter: false },
      organizationId: 'org',
      warehouse: { id: null, source: 'all' },
      rows: [
        {
          ...orderRow,
          openable: true,
          charterId: CH,
          charterName: 'Charter Alder',
          charterCode: 'CH-A',
        },
        {
          ...orderRow,
          orderId: 'o2',
          openable: true,
          charterId: null,
          charterName: null,
          charterCode: null,
        },
      ],
    });
    expect(r.filters.charter).toEqual(charterEcho);
    expect(r.rows[0]).toMatchObject({
      charterId: CH,
      charterName: 'Charter Alder',
      charterCode: 'CH-A',
    });
    expect(r.rows[1]).toMatchObject({ charterId: null, charterName: null, charterCode: null });
    const old = parseBookOrderOrdersAnswer({ ...orders, rows: [{ ...orderRow, mine: false }] });
    expect('charterId' in old.rows[0]!).toBe(false);
    expect('charter' in old.filters).toBe(false);
    expect(() =>
      parseBookOrderOrdersAnswer({ ...orders, rows: [{ ...orderRow, mine: false, charterId: 5 }] }),
    ).toThrow(/charterId/);
    expect(() =>
      parseBookOrderOrdersAnswer({
        ...orders,
        filters: { warehouse: null, noCharter: 1 },
        rows: [],
      }),
    ).toThrow(/filters\.noCharter/);
  });
  it('options: charters and noCharter, absent meaning [] and false', () => {
    const labels = bookReportStatusLabels(null);
    const base = {
      v: 1,
      organizationId: 'org',
      warehouses: [],
      categories: [],
      uncategorized: false,
      statusLabels: labels,
    };
    const old = parseBookOrderOptionsResponse(base);
    expect(old.charters).toEqual([]);
    expect(old.noCharter).toBe(false);
    const now = parseBookOrderOptionsResponse({
      ...base,
      charters: [charterEcho, { id: C, name: 'Charter Birch', code: null, status: 'archived' }],
      noCharter: true,
    });
    expect(now.charters).toEqual([
      charterEcho,
      { id: C, name: 'Charter Birch', code: null, status: 'archived' },
    ]);
    expect(now.noCharter).toBe(true);
    const sql = parseBookOrderOptionsAnswer({
      v: 1,
      warehouses: [],
      categories: [],
      uncategorized: false,
      orderStatusConfig: null,
      charters: [charterEcho],
      noCharter: false,
    });
    expect(sql.charters).toEqual([charterEcho]);
    expect(() => parseBookOrderOptionsResponse({ ...base, charters: null })).toThrow(/charters/);
    expect(() =>
      parseBookOrderOptionsResponse({ ...base, charters: [{ id: CH, name: 'x' }] }),
    ).toThrow(/charters\[0\]\.status/);
    expect(() => parseBookOrderOptionsResponse({ ...base, noCharter: 'no' })).toThrow(/noCharter/);
  });
  it('nothing existing is loosened: v must be 1 and old keys keep their types', () => {
    expect(() =>
      parseBookOrderTotalsAnswer({
        ...totals,
        v: 2,
        filters: { ...totals.filters, charter: null },
      }),
    ).toThrow(/totals\.v/);
    expect(() =>
      parseBookOrderTotalsAnswer({
        ...totals,
        filters: { ...totals.filters, uncategorized: null },
      }),
    ).toThrow(/uncategorized/);
  });
});

describe('bookReportCharterEchoMatches (the phone and the web drawer refuse a mismatch)', () => {
  const echo = { id: CH, name: 'Charter Alder', code: 'CH-A', status: 'active' };
  const cases: Array<[string, BookReportQuery['charter'], object | null | undefined, boolean]> = [
    ['all, answered for all', 'all', { charter: null, noCharter: false }, true],
    ['all, from a server before 0382 (no keys)', 'all', {}, true],
    ['all, no filters object at all', 'all', undefined, true],
    ['all, but the answer is for a charter', 'all', { charter: echo, noCharter: false }, false],
    ['all, but the answer is No charter', 'all', { charter: null, noCharter: true }, false],
    ['none, answered for none', 'none', { charter: null, noCharter: true }, true],
    ['none, from a server before 0382', 'none', {}, false],
    ['none, answered for all', 'none', { charter: null, noCharter: false }, false],
    ['none, answered with a charter too', 'none', { charter: echo, noCharter: true }, false],
    ['uuid, answered for it', CH, { charter: echo, noCharter: false }, true],
    ['uuid, answered for it (noCharter absent)', CH, { charter: echo }, true],
    ['uuid in upper case', CH.toUpperCase(), { charter: echo, noCharter: false }, true],
    ['uuid, from a server before 0382', CH, {}, false],
    ['uuid, answered for all', CH, { charter: null, noCharter: false }, false],
    [
      'uuid, answered for another charter',
      CH,
      { charter: { ...echo, id: C }, noCharter: false },
      false,
    ],
    ['uuid, answered with noCharter true', CH, { charter: echo, noCharter: true }, false],
    ['junk charter in a hand-built query', 'Marconi', { charter: null, noCharter: false }, false],
  ];
  it.each(cases)('%s', (_name, charter, filters, expected) => {
    expect(bookReportCharterEchoMatches({ charter }, filters as never)).toBe(expected);
  });
});

describe("bookReportDrillDownQuery (a row's orders are read for the days the row was read for)", () => {
  const base: BookReportQuery = {
    ...DEFAULT_BOOK_REPORT_QUERY,
    statusGroups: [...DEFAULT_BOOK_REPORT_STATUS_GROUPS],
    charter: CH,
    warehouse: 'all',
  };
  it.each(['today', 'week', 'month', '30d', '90d', 'year'] as const)(
    'the rolling preset %s becomes the exact days its answer resolved, every other filter kept',
    (range) => {
      const q = { ...base, range, page: 3 };
      const out = bookReportDrillDownQuery(q, { key: range, from: '2026-09-27', to: '2026-09-29' });
      expect(out).toEqual({ ...q, range: 'custom', from: '2026-09-27', to: '2026-09-29' });
      // The input is left alone.
      expect(q.range).toBe(range);
    },
  );
  it('after midnight the drill-down still asks for the day the row was read for', () => {
    // The page read Today on Sep 29; the drill-down opens at 00:01 on Sep 30.
    const q = { ...base, range: 'today' as const };
    const out = bookReportDrillDownQuery(q, { key: 'today', from: '2026-09-29', to: '2026-09-29' });
    expect(serializeBookReportQuery(out)).toContain('range=custom&from=2026-09-29&to=2026-09-29');
  });
  it('All time and a custom range are already exact: unchanged', () => {
    const all = { ...base, range: 'all' as const };
    expect(bookReportDrillDownQuery(all, { key: 'all', from: null, to: null })).toBe(all);
    const custom = { ...base, range: 'custom' as const, from: '2026-09-01', to: '2026-09-30' };
    expect(
      bookReportDrillDownQuery(custom, { key: 'custom', from: '2026-09-01', to: '2026-09-30' }),
    ).toBe(custom);
  });
  it('without an answer for that preset (none yet, another preset, or no days) the query is unchanged', () => {
    const q = { ...base, range: 'month' as const };
    expect(bookReportDrillDownQuery(q, null)).toBe(q);
    expect(bookReportDrillDownQuery(q, { key: 'week', from: '2026-09-27', to: '2026-09-29' })).toBe(
      q,
    );
    expect(bookReportDrillDownQuery(q, { key: 'month', from: null, to: '2026-09-29' })).toBe(q);
    expect(
      bookReportDrillDownQuery(q, { key: 'month', from: '2026-09-30', to: '2026-09-01' }),
    ).toBe(q);
    expect(
      bookReportDrillDownQuery(q, { key: 'month', from: '2026-02-30', to: '2026-09-01' }),
    ).toBe(q);
  });
});

describe('bookReportRangeEchoMatches (the drill-down refuses orders read for other days)', () => {
  const cases: Array<
    [
      string,
      Pick<BookReportQuery, 'range' | 'from' | 'to'>,
      { key: string; from: string | null; to: string | null } | null,
      boolean,
    ]
  > = [
    [
      'all, answered for all',
      { range: 'all', from: null, to: null },
      { key: 'all', from: null, to: null },
      true,
    ],
    [
      'all, answered for a month',
      { range: 'all', from: null, to: null },
      { key: 'month', from: '2026-09-01', to: '2026-09-30' },
      false,
    ],
    [
      'custom, the same days',
      { range: 'custom', from: '2026-09-01', to: '2026-09-30' },
      { key: 'custom', from: '2026-09-01', to: '2026-09-30' },
      true,
    ],
    [
      'custom, another end',
      { range: 'custom', from: '2026-09-01', to: '2026-09-30' },
      { key: 'custom', from: '2026-09-01', to: '2026-09-29' },
      false,
    ],
    [
      'custom, answered as a preset',
      { range: 'custom', from: '2026-09-29', to: '2026-09-29' },
      { key: 'today', from: '2026-09-29', to: '2026-09-29' },
      false,
    ],
    [
      'a preset, answered for it',
      { range: 'week', from: null, to: null },
      { key: 'week', from: '2026-09-27', to: '2026-09-29' },
      true,
    ],
    [
      'a preset, answered for another',
      { range: 'week', from: null, to: null },
      { key: 'today', from: '2026-09-29', to: '2026-09-29' },
      false,
    ],
    ['no range in the answer', { range: 'all', from: null, to: null }, null, false],
  ];
  it.each(cases)('%s', (_name, query, range, expected) => {
    expect(bookReportRangeEchoMatches(query, range as never)).toBe(expected);
  });
});

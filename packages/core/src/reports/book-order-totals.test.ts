import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { ORDER_STATUS_KEYS } from '../customization/order-status';

import {
  BOOK_REPORT_DEFAULT_STATUSES,
  BOOK_REPORT_SELECTABLE_STATUSES,
  BOOK_REPORT_STATUS_GROUP_KEYS,
  BOOK_REPORT_STATUS_GROUPS,
  BOOK_REPORT_COPY_UNITS,
  DEFAULT_BOOK_REPORT_QUERY,
  bookReportFilterArgs,
  bookReportOrderLink,
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
// holds the same literals (all13, def11), and the migration holds them as
// c_allowed and c_default: the last test below reads both files.
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

function sqlArray(text: string, name: string): string[] {
  const m = new RegExp(`${name} constant text\\[\\] := array\\[([^\\]]+)\\]`).exec(text);
  if (!m) throw new Error(`${name} not found`);
  return m[1]!.split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
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
  it('migration 0379 and pgTAP 0379 hold the same two lists (and the same copy units)', () => {
    const mig = readFileSync(
      path.join(REPO, 'supabase/migrations/0379_book_order_totals.sql'),
      'utf8',
    );
    const lines = mig.slice(mig.indexOf('function public.book_order_report_lines'));
    expect(sqlArray(lines, 'c_allowed')).toEqual(ALL_13);
    expect(sqlArray(lines, 'c_default')).toEqual(DEFAULT_11);
    const totals = mig.slice(mig.indexOf('function public.book_order_totals('));
    expect(sqlArray(totals, 'c_allowed')).toEqual(ALL_13);
    expect(sqlArray(totals, 'c_default')).toEqual(DEFAULT_11);
    const test = readFileSync(
      path.join(REPO, 'supabase/tests/0379_book_order_totals.test.sql'),
      'utf8',
    );
    const lit = (name: string) => {
      const m = new RegExp(`\\\\set ${name}\\s+'\\\\'\\{([^}]+)\\}\\\\''`).exec(test);
      if (!m) throw new Error(`${name} not found`);
      return m[1]!.split(',');
    };
    expect(lit('all13')).toEqual(ALL_13);
    expect(lit('def11')).toEqual(DEFAULT_11);
    const units = /\('unit','units','ea','each','copy','copies','pc','pcs','piece','pieces'\)/;
    expect(mig).toMatch(units);
    expect(`('${BOOK_REPORT_COPY_UNITS.join("','")}')`).toMatch(units);
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

describe('parseBookReportQuery / serializeBookReportQuery', () => {
  it('an empty URL is the default query (All time, default statuses, warehouse default)', () => {
    const { query, invalid } = parseBookReportQuery({});
    expect(invalid).toEqual([]);
    expect(query).toEqual(DEFAULT_BOOK_REPORT_QUERY);
    expect(serializeBookReportQuery(query)).toBe('');
  });
  it('round-trips every key in one canonical order', () => {
    const qs =
      'range=custom&from=2026-01-01&to=2026-03-31&status=awaiting%2Ccancelled&warehouse=' +
      W +
      '&wview=1&category=none&q=The%20Hobbit&sort=title&page=3';
    const { query, invalid } = parseBookReportQuery(new URLSearchParams(qs));
    expect(invalid).toEqual([]);
    expect(query).toMatchObject({
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
});

/**
 * WORDING GUARD for Book Order Totals. Every line the report can show is
 * rendered here and searched:
 *   - the recorded-quantity jargon never appears ("the book", "book
 *     quantity", "on the books"; owner rule 2026-09-27: L4L stocks real
 *     books, so "book" means a book);
 *   - rows are never "unique titles", fulfilment is never "delivered", the
 *     generation time is never a "snapshot", and nothing is a percentage;
 *   - every metric carries its one-line definition;
 *   - "How this is counted" carries the plan's limitation sentences.
 */
import { describe, expect, it } from 'vitest';

import { ORDER_STATUS_KEYS } from '../customization/order-status';

import {
  BOOK_REPORT_STATUS_GROUP_KEYS,
  DEFAULT_BOOK_REPORT_QUERY,
  bookReportStatusLabels,
  bookReportWithoutFilter,
  type BookReportQuery,
  type BookReportStatusGroup,
} from './book-order-totals';
import * as copy from './book-order-totals-copy';
import * as calendar from './report-calendar';

const labels = bookReportStatusLabels(null);

const CH_A = '1a2b3c4d-5e6f-4a0b-9c1d-2e3f4a5b6c7d';
const CH_B = '1a2b3c4d-9999-4a0b-9c1d-2e3f4a5b6c7d';
const W1 = '0f1e2d3c-4b5a-4968-8776-655443322110';
const CAT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const ALDER = { id: CH_A, name: 'Charter Alder', code: 'CH-A', status: 'active' };
const TWINS = [
  { id: CH_A, name: 'Alder', code: null, status: 'active' },
  { id: CH_B, name: 'alder', code: null, status: 'active' },
  { id: CAT, name: 'Birch', code: 'BIR', status: 'active' },
];
const SHOWING_ANSWER = {
  range: { key: 'custom' as const, from: '2026-09-01', to: '2026-09-30' },
  summary: { firstOrderDate: '2026-09-03', lastOrderDate: '2026-09-18' },
  filters: {
    warehouse: { id: W1, name: 'DC4', status: 'active' },
    charter: ALDER,
    noCharter: false,
  },
  warehouse: { source: 'view' as const },
};
const BUSY: BookReportQuery = {
  ...DEFAULT_BOOK_REPORT_QUERY,
  charter: CH_A,
  range: 'custom',
  from: '2026-09-01',
  to: '2026-09-30',
  statusGroups: ['awaiting', 'denied'],
  warehouse: W1,
  warehouseFromView: false,
  category: CAT,
  q: 'Outsiders',
  sort: 'title',
  page: 2,
};
const BUSY_ECHOES = {
  range: { key: 'custom' as const, from: '2026-09-01', to: '2026-09-30' },
  summary: { firstOrderDate: '2026-09-03', lastOrderDate: '2026-09-18' },
  filters: {
    warehouse: { id: W1, name: 'North', status: 'archived' },
    category: { id: CAT, name: 'Fiction', deleted: false },
    uncategorized: false,
    charter: ALDER,
    noCharter: false,
  },
};
// Status names are the organization's own labels (the core default for
// completed is "Delivered", a status NAME the Orders page shows). The guard
// judges this report's own words, so it renders status lines with neutral
// labels; the status-line test below shows the default labels pass through.
const guardLabels = bookReportStatusLabels({ completed: { label: 'Completed' } });

function rendered(): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(copy)) {
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) out.push(...value.map(String));
    else if (value && typeof value === 'object') {
      for (const v of Object.values(value)) {
        if (typeof v === 'string') out.push(v);
        else if (v && typeof v === 'object') out.push(...Object.values(v).map(String));
      }
    } else if (typeof value !== 'function') {
      throw new Error(`unexpected export ${key}`);
    }
  }
  const groupSets: BookReportStatusGroup[][] = [
    ['awaiting', 'in_progress', 'backordered', 'completed'],
    [...BOOK_REPORT_STATUS_GROUP_KEYS],
    ['completed', 'denied'],
    ['cancelled'],
  ];
  for (const g of groupSets) out.push(copy.bookReportStatusLine(g, guardLabels));
  out.push(
    copy.copiesRequestedText('642'),
    copy.copiesRequestedText('1'),
    copy.ordersCountText(26),
    copy.entriesCountText(32),
    copy.rowQuantityText({ copies: '12', countsAsCopies: false, unit: 'pack of 10' }),
    copy.unresolvedUnitsNote({ entries: 1, quantity: '12' }, 'pack of 10') ?? '',
    copy.unresolvedUnitsNote({ entries: 3, quantity: '40' }) ?? '',
    copy.bookReportRangeLine(
      { key: 'all', from: null, to: null },
      { firstOrderDate: '2026-05-12', lastOrderDate: '2026-09-25' },
    ),
    copy.bookReportRangeLine({ key: '30d', from: '2026-08-30', to: '2026-09-28' }),
    copy.bookReportRangeLine({ key: 'custom', from: '2026-09-01', to: '2026-09-28' }),
    copy.bookReportZoneLine({ timeZone: 'America/Los_Angeles', timeZoneFallback: true }),
    copy.bookReportInProgressDetail(guardLabels),
    copy.bookReportWarehouseLine({ id: 'w', name: 'DC4', status: 'active' }, 'view'),
    copy.bookReportWarehouseLine({ id: 'w', name: 'North', status: 'archived' }, 'explicit'),
    copy.bookReportWarehouseLine(null, 'all'),
    copy.bookReportCategoryLine({ id: 'c', name: 'Fiction', deleted: true }, false) ?? '',
    copy.bookReportCategoryLine(null, true) ?? '',
    copy.bookReportSearchLine('hobbit') ?? '',
    copy.bookReportGeneratedLine('2026-09-28 10:42'),
    copy.bookReportGrandTotalLine({ copies: '642', orders: 26, unresolved: { entries: 0 } }, 2),
    copy.bookReportGrandTotalLine({ copies: '15', orders: 4, unresolved: { entries: 1 } }, 1),
    copy.bookReportPdfGrandTotalLine({
      copies: '34',
      orders: 3,
      entries: 2,
      unresolved: { entries: 0 },
    }),
    copy.bookReportPdfGrandTotalLine({
      copies: '15',
      orders: 4,
      entries: 4,
      unresolved: { entries: 1 },
    }),
    copy.latestOrderText('2026-09-20'),
    ...copy.bookReportRowBadges({
      itemStatus: 'archived',
      deleted: false,
      nowRental: true,
      countsAsCopies: false,
      unit: 'pack of 10',
    }),
    copy.bookCoverAlt('Book A'),
    copy.bookReportDrawerHeader({ countsAsCopies: true, unit: 'ea' }, { copies: '30', orders: 3 }),
    copy.bookReportDrawerHeader(
      { countsAsCopies: false, unit: 'pack of 10' },
      { copies: '12', orders: 2 },
    ),
    copy.combinedLinesText(2) ?? '',
    copy.fulfilledReturnedLine({ fulfilled: '8', returned: '2' }) ?? '',
    copy.bookReportAsOfNote('2026-09-28 10:42'),
    copy.bookReportTooManyText(21340, 20000),
    copy.bookReportPdfCoverNote({ photos: true, rows: 612, shown: 498, failed: 2, pastCap: 112 }),
    copy.bookReportPdfCoverNote({ photos: false, rows: 612, shown: 0, failed: 0, pastCap: 0 }),
    copy.bookReportOfflineAsOf('2026-09-28 10:42'),
    copy.bookReportTableCaption('copies', 1, 2),
    copy.bookReportViewOrdersLabel('Book A'),
    copy.bookReportViewChangedLine({ id: 'w5', name: 'DC5' }, 'DC4'),
    copy.bookReportViewChangedLine({ id: 'w5', name: null }, 'DC4'),
    copy.bookReportViewChangedLine({ id: null, name: null }, 'DC4'),
    copy.bookReportShowViewLabel({ id: 'w5', name: 'DC5' }),
    copy.bookReportShowViewLabel({ id: 'w5', name: null }),
    copy.bookReportShowViewLabel({ id: null, name: null }),
    // 0382: charter, presets, Showing, chips, by-charter.
    copy.bookReportRangeLine({ key: 'today', from: '2026-09-29', to: '2026-09-29' }),
    copy.bookReportRangeLine({ key: 'week', from: '2026-09-27', to: '2026-09-29' }),
    copy.bookReportRangeLabel({ key: 'month', from: '2026-09-01', to: '2026-09-29' }),
    copy.bookReportRangeLabel({ key: 'all', from: null, to: null }),
    copy.bookReportCharterOptionLabel(ALDER),
    copy.bookReportCharterOptionLabel({ ...ALDER, status: 'archived' }),
    copy.bookReportCharterOptionLabel({ ...ALDER, status: 'inactive', code: null }),
    ...copy.bookReportCharterOptionLabels(TWINS).values(),
    copy.bookReportCharterLine(ALDER, false),
    copy.bookReportCharterLine(null, true),
    copy.bookReportCharterLine(null, false),
    copy.bookReportOrderCharterText({ charterId: null }) ?? '',
    copy.bookReportOrderCharterText({
      charterId: 'c',
      charterName: 'Marconi',
      charterCode: 'MAR-01',
    }) ?? '',
    copy.bookReportByCharterValue('1284', 12),
    copy.bookReportByCharterValue('1', 1, true),
    copy.bookReportByCharterTotalLine({ copies: '642', orders: 26, unresolved: { entries: 0 } }),
    copy.bookReportByCharterTotalLine({ copies: '15', orders: 4, unresolved: { entries: 1 } }),
    copy.bookReportByCharterApplyLabel('Marconi · MAR-01'),
    copy.bookReportShowingStatus(['awaiting', 'denied', 'cancelled']),
    copy.bookReportShowingStatus(['awaiting', 'in_progress', 'backordered', 'completed']),
    ...copy.bookReportShowingParts(SHOWING_ANSWER, ['awaiting']).map((p) => p.text),
    ...copy
      .bookReportActiveFilters(BUSY, BUSY_ECHOES, guardLabels)
      .flatMap((c) => [c.text, c.removeLabel]),
    ...Object.values(calendar.CALENDAR_COPY),
    ...calendar.CALENDAR_WEEKDAYS_LONG,
    ...calendar.CALENDAR_MONTHS_LONG,
    calendar.calendarDayLabel('2026-09-01'),
    calendar.calendarMonthTitle({ y: 2026, m: 9 }),
  );
  return out;
}

describe('Book Order Totals wording', () => {
  const lines = rendered();

  it('renders a real set of lines', () => {
    expect(lines.length).toBeGreaterThan(80);
  });

  it.each([
    ['"the book"', /\bthe book\b/i],
    ['"book quantity"', /\bbook (?:qty|quantity|quantities)\b/i],
    ['"on the books"', /\bon the books\b/i],
    ['"unique titles"', /\bunique titles?\b/i],
    ['"delivered"', /\bdelivered\b/i],
    ['"snapshot"', /\bsnapshot\b/i],
    ['a percentage', /%/],
  ])('never says %s', (_name, re) => {
    expect(lines.filter((l) => re.test(l))).toEqual([]);
  });

  it('every metric has its label and definition', () => {
    for (const m of Object.values(copy.BOOK_REPORT_METRICS)) {
      expect(m.label.length).toBeGreaterThan(5);
      expect(m.definition.endsWith('.')).toBe(true);
    }
    expect(copy.BOOK_REPORT_METRICS.copies).toEqual({
      label: 'Total books ordered',
      definition: 'Copies requested through Orders; not copies purchased or current stock.',
    });
    expect(copy.BOOK_REPORT_METRICS.entries.label).toBe('Distinct book entries');
  });

  it('"How this is counted" carries the limitation sentences', () => {
    const text = copy.BOOK_REPORT_HOW_COUNTED.join(' ');
    for (const sentence of [
      'Order dates, warehouses and charters can be edited after an order is placed; the report uses the saved values.',
      'The Charter filter uses the charter each order was placed for (its delivery site), not the charter that owns a book.',
      'Pickup orders have no charter and appear under No charter',
      "A backorder closed by lowering its quantity shows the lowered quantity; the original is in the order's history.",
      'Bundle distributions and rentals are not Orders and are not counted.',
      "The warehouse filter uses each order's warehouse.",
      'Books turned into rental items keep their order history.',
      "Status is each order's status now",
      'Present-day kit recipes are never expanded.',
      copy.BOOK_REPORT_FULFILLED_NOTE,
    ]) {
      expect(text).toContain(sentence);
    }
  });

  it('the status line says what is left out and, when chosen, what denied and cancelled mean', () => {
    expect(
      copy.bookReportStatusLine(['awaiting', 'in_progress', 'backordered', 'completed'], labels),
    ).toBe(
      'Status: Pending, In progress, Backordered, Delivered. Denied, cancelled and unconfirmed requests are left out.',
    );
    expect(
      copy.bookReportStatusLine(
        [...BOOK_REPORT_STATUS_GROUP_KEYS],
        bookReportStatusLabels({ completed: { label: 'Handed over' } }),
      ),
    ).toBe(
      'Status: Pending, In progress, Backordered, Handed over, Denied, Cancelled. Unconfirmed requests are left out. Includes denied and cancelled requests. Their quantities were asked for, not accepted or fulfilled.',
    );
  });

  it('the grand total and drawer header read as in the plan', () => {
    expect(
      copy.bookReportGrandTotalLine({ copies: '642', orders: 26, unresolved: { entries: 0 } }, 2),
    ).toBe('Grand total for all 2 pages: 642 copies requested in 26 orders.');
    expect(
      copy.bookReportPdfGrandTotalLine({
        copies: '34',
        orders: 3,
        entries: 2,
        unresolved: { entries: 0 },
      }),
    ).toBe('Grand total: 34 copies requested in 3 orders · 2 book entries.');
    expect(
      copy.bookReportDrawerHeader(
        { countsAsCopies: true, unit: 'unit' },
        { copies: '30', orders: 3 },
      ),
    ).toBe('Copies of this book requested: 30 in 3 orders');
    expect(
      copy.bookReportPdfCoverNote({ photos: true, rows: 612, shown: 498, failed: 2, pastCap: 112 }),
    ).toBe(
      'Covers shown for 498 of 612 books. 2 could not be loaded and 112 are past the 500-cover limit; each shows a placeholder. Every row and total is included.',
    );
    expect(
      copy.bookReportRangeLine(
        { key: 'all', from: null, to: null },
        { firstOrderDate: '2026-05-12', lastOrderDate: '2026-09-25' },
      ),
    ).toBe('Orders placed during: All time (May 12, 2026 – Sep 25, 2026)');
    expect(copy.bookReportRangeLine({ key: '30d', from: '2026-08-30', to: '2026-09-28' })).toBe(
      'Orders placed during: Last 30 days (Aug 30 – Sep 28, 2026)',
    );
  });

  it('never ties the copies to an order count that includes other-unit orders', () => {
    // 15 copies came from 3 orders; a 4th order holds only a 'pack of 10'
    // book, so it is an order containing books but holds none of the 15.
    const summary = { copies: '15', orders: 4, entries: 4, unresolved: { entries: 1 } };
    const page = copy.bookReportGrandTotalLine(summary, 1);
    const pages = copy.bookReportGrandTotalLine(summary, 2);
    const pdf = copy.bookReportPdfGrandTotalLine(summary);
    for (const line of [page, pages, pdf]) {
      expect(line).not.toMatch(/copies requested in /);
      expect(line).toContain('Orders containing books: 4.');
    }
    expect(page).toBe('Grand total: 15 copies requested. Orders containing books: 4.');
    expect(pages).toBe(
      'Grand total for all 2 pages: 15 copies requested. Orders containing books: 4.',
    );
    expect(pdf).toBe(
      'Grand total: 15 copies requested. Orders containing books: 4. Distinct book entries: 4.',
    );
  });

  it("a restricted reader is told BOTH limits: the order's warehouse (and charter) and the book's scope", () => {
    // book_order_report_lines joins the ORDER's warehouse under RLS as well as
    // the item (pgTAP K7): an order placed at a warehouse the reader cannot
    // see is left out even for a book in their own warehouse. 0382 E2b: a
    // reader limited to some charters at a warehouse sees only those charters'
    // orders there, and orders with no charter. The book's charter is the
    // OWNING charter, worded so it cannot be read as the Charter filter.
    expect(copy.BOOK_REPORT_RESTRICTED).toBe(
      'You see only orders placed in your warehouses (and, where your access is limited to some charters, orders for those charters and orders with no charter), and only books whose warehouse, owning charter and category you can see.',
    );
    expect(copy.BOOK_REPORT_HOW_COUNTED).toContain(
      "What you can see is decided by each order's warehouse and, where your access is limited to some charters, its charter, and by each book's current warehouse, owning charter and category.",
    );
  });

  it('words every export refusal from its status and reason, never raw text', () => {
    const t = copy.bookReportExportRefusalText;
    expect(t({ status: 429, retryAfterSeconds: 700 })).toBe(
      'Too many exports in the last hour. Try again in 12 minutes.',
    );
    expect(t({ status: 429 })).toMatch(/Wait a few minutes/);
    expect(t({ status: 400, reason: 'too_many_rows', count: 20001, limit: 20000 })).toBe(
      'Too many books for one file (20,001; the limit is 20,000). Narrow the filters.',
    );
    expect(t({ status: 400, message: 'These filters are not valid: sort.' })).toBe(
      'These filters are not valid: sort.',
    );
    expect(t({ status: 400, message: 'invalid_query' })).toBe(copy.BOOK_REPORT_FILTERS_INVALID);
    expect(t({ status: 401 })).toBe('Your session has ended. Sign in again.');
    expect(t({ status: 403, code: 'forbidden' })).toBe(copy.BOOK_REPORT_EXPORT_FORBIDDEN);
    expect(t({ status: 403, code: 'module_disabled' })).toBe(copy.BOOK_REPORT_MODULE_OFF);
    expect(
      t({
        status: 403,
        reason: 'aal2_required',
        message: 'Re-authenticate with MFA before performing this action.',
      }),
    ).toBe('Re-authenticate with MFA before performing this action.');
    expect(t({ status: 503, reason: 'timeout' })).toBe(copy.BOOK_REPORT_TIMEOUT);
    expect(t({ status: 500, message: 'relation "x" does not exist' })).toBe(
      copy.BOOK_REPORT_SERVER_PROBLEM,
    );
  });

  it('the warehouse view notice names the view it moved to, or says it changed', () => {
    expect(copy.bookReportViewChangedLine({ id: 'w5', name: 'DC5' }, 'DC4')).toBe(
      'Your warehouse view is now DC5. This report still shows DC4.',
    );
    expect(copy.bookReportShowViewLabel({ id: 'w5', name: 'DC5' })).toBe('Show DC5');
    expect(copy.bookReportViewChangedLine({ id: 'w5', name: null }, 'DC4')).toBe(
      'Your warehouse view has changed. This report still shows DC4.',
    );
    expect(copy.bookReportViewChangedLine({ id: null, name: null }, 'DC4')).toBe(
      'Your warehouse view is now all warehouses. This report still shows DC4.',
    );
    expect(copy.bookReportShowViewLabel({ id: null, name: 'ignored' })).toBe('Show all warehouses');
    expect(copy.bookReportTableCaption('title', 2, 44)).toBe(
      'Book entries sorted by Title (A–Z). Page 2 of 44.',
    );
  });

  it("labels every status group from the organization's own labels", () => {
    for (const g of BOOK_REPORT_STATUS_GROUP_KEYS) {
      expect(copy.bookReportStatusGroupLabel(g, labels).length).toBeGreaterThan(0);
    }
    expect(Object.keys(labels).sort()).toEqual([...ORDER_STATUS_KEYS].sort());
  });
});

describe('charter words (0382)', () => {
  it('a charter option reads Name · CODE, leaves a blank or repeated code out, and names a status', () => {
    expect(copy.bookReportCharterOptionLabel(ALDER)).toBe('Charter Alder · CH-A');
    expect(copy.bookReportCharterOptionLabel({ ...ALDER, code: null })).toBe('Charter Alder');
    expect(copy.bookReportCharterOptionLabel({ ...ALDER, code: '   ' })).toBe('Charter Alder');
    expect(copy.bookReportCharterOptionLabel({ ...ALDER, code: 'charter alder' })).toBe(
      'Charter Alder',
    );
    expect(copy.bookReportCharterOptionLabel({ ...ALDER, status: 'archived' })).toBe(
      'Charter Alder · CH-A (archived)',
    );
    expect(copy.bookReportCharterOptionLabel({ ...ALDER, status: 'inactive' })).toBe(
      'Charter Alder · CH-A (inactive)',
    );
    expect(copy.bookReportCharterOptionLabel({ name: null })).toBe('Unnamed charter');
  });
  it('labels that would read alike get the start of their id; distinct ones do not', () => {
    const labels = copy.bookReportCharterOptionLabels(TWINS);
    // 'Alder' and 'alder' read alike. Their ids share the first 8
    // characters, so each carries its whole id.
    expect(CH_A.slice(0, 8)).toBe(CH_B.slice(0, 8));
    expect(labels.get(CH_A)).toBe(`Alder (id ${CH_A})`);
    expect(labels.get(CH_B)).toBe(`alder (id ${CH_B})`);
    expect(labels.get(CAT)).toBe('Birch · BIR');
    const distinct = copy.bookReportCharterOptionLabels([
      { id: CH_A, name: 'Alder', code: null, status: 'active' },
      { id: 'b0000000-0000-4000-8000-000000000000', name: 'Alder', code: 'ALD', status: 'active' },
      { id: 'c0000000-0000-4000-8000-000000000000', name: 'Alder', code: null, status: 'archived' },
    ]);
    expect([...distinct.values()]).toEqual(['Alder', 'Alder · ALD', 'Alder (archived)']);
    const pair = copy.bookReportCharterOptionLabels([
      { id: 'd1111111-0000-4000-8000-000000000000', name: 'Elm', code: null, status: 'active' },
      { id: 'd2222222-0000-4000-8000-000000000000', name: 'Elm', code: null, status: 'active' },
    ]);
    expect([...pair.values()]).toEqual(['Elm (id d1111111)', 'Elm (id d2222222)']);
  });
  it('the charter line and value read All charters, the charter, or No charter', () => {
    expect(copy.bookReportCharterLine(null, false)).toBe('Charter: All charters');
    expect(copy.bookReportCharterLine(undefined, undefined)).toBe('Charter: All charters');
    expect(copy.bookReportCharterLine(ALDER, false)).toBe('Charter: Charter Alder · CH-A');
    expect(copy.bookReportCharterLine(null, true)).toBe(
      'Charter: No charter (pickup orders and orders placed without a charter)',
    );
    expect(copy.bookReportCharterLabel(null, true)).toBe('No charter');
    const labels = copy.bookReportCharterOptionLabels(TWINS);
    expect(copy.bookReportCharterLine({ ...ALDER, name: 'Alder', code: null }, false, labels)).toBe(
      `Charter: Alder (id ${CH_A})`,
    );
  });
  it('a drill-down order names its charter, No charter for a pickup, nothing from an older server', () => {
    expect(
      copy.bookReportOrderCharterText({
        charterId: CH_A,
        charterName: 'Marconi',
        charterCode: 'MAR-01',
      }),
    ).toBe('Marconi · MAR-01');
    expect(copy.bookReportOrderCharterText({ charterId: null, charterName: null })).toBe(
      'No charter',
    );
    expect(copy.bookReportOrderCharterText({})).toBeNull();
  });
  it('Today and This week read with their resolved days', () => {
    expect(copy.bookReportRangeLine({ key: 'today', from: '2026-09-29', to: '2026-09-29' })).toBe(
      'Orders placed during: Today (Sep 29, 2026)',
    );
    expect(copy.bookReportRangeLine({ key: 'week', from: '2026-09-27', to: '2026-09-29' })).toBe(
      'Orders placed during: This week (Sep 27 – Sep 29, 2026)',
    );
    expect(copy.bookReportRangeLabel({ key: 'week', from: '2025-12-28', to: '2026-01-02' })).toBe(
      'This week (Dec 28, 2025 – Jan 2, 2026)',
    );
    expect(copy.bookReportRangeLabel({ key: 'custom', from: '2026-09-01', to: '2026-09-30' })).toBe(
      'Sep 1 – Sep 30, 2026',
    );
    expect(copy.bookReportRangeLabel({ key: 'all', from: null, to: null })).toBe('All time');
    expect(copy.BOOK_REPORT_RANGE_LABELS.today).toBe('Today');
    expect(copy.BOOK_REPORT_RANGE_LABELS.week).toBe('This week');
  });
  it('the range line is the lead plus the label, so the two never drift', () => {
    const cases = [
      { key: 'all' as const, from: null, to: null },
      { key: 'month' as const, from: '2026-09-01', to: '2026-09-29' },
      { key: 'custom' as const, from: '2026-09-01', to: '2026-09-30' },
    ];
    const summary = { firstOrderDate: '2026-05-12', lastOrderDate: '2026-09-25' };
    for (const r of cases) {
      expect(copy.bookReportRangeLine(r, summary)).toBe(
        `Orders placed during: ${copy.bookReportRangeLabel(r, summary)}`,
      );
    }
  });
  it('the words the brief and the plan fix', () => {
    expect(copy.BOOK_REPORT_ALL_CHARTERS).toBe('All charters');
    expect(copy.BOOK_REPORT_NO_CHARTER).toBe('No charter');
    expect(copy.BOOK_REPORT_UI.charter).toBe('Charter');
    expect(copy.BOOK_REPORT_UI.dateRange).toBe('Orders placed');
    expect(copy.BOOK_REPORT_UI.clearFilters).toBe('Clear filters');
    expect(copy.BOOK_REPORT_UI.removeFilter('charter')).toBe('Remove charter filter');
    expect(copy.BOOK_REPORT_UI.startDate).toBe('Start date');
    expect(copy.BOOK_REPORT_UI.endDate).toBe('End date');
    expect(copy.BOOK_REPORT_OPTIONS_ERROR).toBe(
      "Couldn't load the charter, warehouse and category lists. Retry",
    );
    expect(copy.BOOK_REPORT_BACK_TO_REPORT).toBe('Back to Book Order Totals');
    expect(copy.BOOK_REPORT_INVALID_CHARTER).toBe('That charter is not one you can see.');
    // One notice for a refused charter, whatever the cause (plan Q8).
    expect(copy.BOOK_REPORT_FILTERS_RESET).toBe(
      'Some filters in this link were not valid and were reset.',
    );
    expect(copy.BOOK_REPORT_DRAWER_TERMS).toEqual({
      book: 'Book',
      charter: 'Charter',
      ordersPlaced: 'Orders placed',
      totalRequested: 'Total requested',
    });
  });
});

describe('Showing (brief 8)', () => {
  it('names the charter, the dates, the warehouse view and the statuses, from the echoes', () => {
    expect(
      copy.bookReportShowingParts(SHOWING_ANSWER, [
        'awaiting',
        'in_progress',
        'backordered',
        'completed',
      ]),
    ).toEqual([
      { key: 'charter', text: 'Charter Alder · CH-A' },
      { key: 'range', text: 'Sep 1 – Sep 30, 2026' },
      { key: 'warehouse', text: 'Warehouse: DC4 (your warehouse view)' },
      { key: 'status', text: 'Eligible orders' },
    ]);
  });
  it('an explicit warehouse is named without the view words; All warehouses adds no line', () => {
    const explicit = copy.bookReportShowingParts(
      { ...SHOWING_ANSWER, warehouse: { source: 'explicit' } },
      ['awaiting'],
    );
    expect(explicit.find((p) => p.key === 'warehouse')?.text).toBe('Warehouse: DC4');
    expect(explicit.find((p) => p.key === 'status')?.text).toBe('1 of 6 statuses');
    const all = copy.bookReportShowingParts(
      {
        range: { key: 'all', from: null, to: null },
        summary: { firstOrderDate: '2026-05-12', lastOrderDate: '2026-09-25' },
        filters: { warehouse: null },
        warehouse: { source: 'all' },
      },
      ['awaiting', 'in_progress', 'backordered', 'completed'],
    );
    expect(all).toEqual([
      { key: 'charter', text: 'All charters' },
      { key: 'range', text: 'All time (May 12, 2026 – Sep 25, 2026)' },
      { key: 'status', text: 'Eligible orders' },
    ]);
  });
  it('No charter, and a warehouse view that holds nothing still names the warehouse (plan D20)', () => {
    const parts = copy.bookReportShowingParts(
      {
        range: { key: 'all', from: null, to: null },
        summary: { firstOrderDate: null, lastOrderDate: null },
        filters: {
          warehouse: { id: W1, name: 'Empty DC', status: 'active' },
          charter: null,
          noCharter: true,
        },
        warehouse: { source: 'view' },
      },
      ['awaiting', 'in_progress', 'backordered', 'completed'],
    );
    expect(parts.map((p) => p.text)).toEqual([
      'No charter',
      'All time',
      'Warehouse: Empty DC (your warehouse view)',
      'Eligible orders',
    ]);
  });
  it('the status part: Eligible orders for the default set in any order, else a count of 6', () => {
    expect(
      copy.bookReportShowingStatus(['completed', 'awaiting', 'backordered', 'in_progress']),
    ).toBe('Eligible orders');
    expect(copy.bookReportShowingStatus([...BOOK_REPORT_STATUS_GROUP_KEYS])).toBe(
      '6 of 6 statuses',
    );
    expect(copy.bookReportShowingStatus(['awaiting', 'denied', 'cancelled'])).toBe(
      '3 of 6 statuses',
    );
    expect(copy.BOOK_REPORT_SHOWING).toBe('Showing');
  });
});

describe('active-filter chips (web and phone render the same list)', () => {
  it('one chip per set filter, in order, with words from the echoes and a remove name', () => {
    const chips = copy.bookReportActiveFilters(BUSY, BUSY_ECHOES, labels);
    expect(chips.map((c) => [c.key, c.text, c.removeLabel])).toEqual([
      ['charter', 'Charter: Charter Alder · CH-A', 'Remove charter filter'],
      ['dates', 'Orders placed: Sep 1 – Sep 30, 2026', 'Remove date filter'],
      ['status', 'Status: Pending, Denied', 'Remove status filter'],
      ['warehouse', 'Warehouse: North (archived)', 'Remove warehouse filter'],
      ['category', 'Category: Fiction', 'Remove category filter'],
      ['q', 'Search: "Outsiders"', 'Remove search filter'],
    ]);
    for (const c of chips) {
      expect(c.cleared).toEqual(bookReportWithoutFilter(BUSY, c.key));
      expect(c.cleared.page).toBe(1);
    }
  });
  it('the default query has no chips; sort is never a chip; a view warehouse is not a chip', () => {
    expect(copy.bookReportActiveFilters(DEFAULT_BOOK_REPORT_QUERY, null, labels)).toEqual([]);
    expect(
      copy.bookReportActiveFilters({ ...DEFAULT_BOOK_REPORT_QUERY, sort: 'title' }, null, labels),
    ).toEqual([]);
    expect(
      copy.bookReportActiveFilters(
        { ...DEFAULT_BOOK_REPORT_QUERY, warehouse: W1, warehouseFromView: true },
        null,
        labels,
      ),
    ).toEqual([]);
    expect(
      copy.bookReportActiveFilters(
        { ...DEFAULT_BOOK_REPORT_QUERY, warehouse: 'all' },
        null,
        labels,
      ),
    ).toEqual([]);
  });
  it('a removal starts from the LATEST requested query when given (plan trap 23)', () => {
    // A charter change to "none" is still loading; the date chip is removed.
    const pending: BookReportQuery = { ...BUSY, charter: 'none', page: 1 };
    const chips = copy.bookReportActiveFilters(BUSY, BUSY_ECHOES, labels, { base: pending });
    const dates = chips.find((c) => c.key === 'dates')!;
    expect(dates.cleared).toMatchObject({
      charter: 'none',
      range: 'all',
      from: null,
      to: null,
      page: 1,
    });
    // Words still describe what is on screen.
    expect(chips.find((c) => c.key === 'charter')!.text).toBe('Charter: Charter Alder · CH-A');
  });
  it('No charter, No category, presets and missing echoes still read plainly', () => {
    const q: BookReportQuery = {
      ...DEFAULT_BOOK_REPORT_QUERY,
      charter: 'none',
      range: 'week',
      category: 'none',
    };
    expect(
      copy
        .bookReportActiveFilters(
          q,
          {
            range: { key: 'week', from: '2026-09-27', to: '2026-09-29' },
            filters: { warehouse: null, charter: null, noCharter: true },
          },
          labels,
        )
        .map((c) => c.text),
    ).toEqual([
      'Charter: No charter',
      'Orders placed: This week (Sep 27 – Sep 29, 2026)',
      'Category: No category',
    ]);
    // No echo (or an echo for something else): plain words, never the raw id.
    const texts = copy
      .bookReportActiveFilters({ ...BUSY, statusGroups: [...BUSY.statusGroups] }, null, labels)
      .map((c) => c.text);
    expect(texts).toEqual([
      'Charter: Chosen charter',
      'Orders placed: Sep 1 – Sep 30, 2026',
      'Status: Pending, Denied',
      'Warehouse: Chosen warehouse',
      'Category: Chosen category',
      'Search: "Outsiders"',
    ]);
    for (const t of texts) expect(t).not.toContain(CH_A);
  });
  it('a tie-broken charter label is used when the lists are at hand', () => {
    const twinsLabels = copy.bookReportCharterOptionLabels(TWINS);
    const chips = copy.bookReportActiveFilters(
      { ...DEFAULT_BOOK_REPORT_QUERY, charter: CH_A },
      { filters: { charter: { id: CH_A, name: 'Alder', code: null, status: 'active' } } },
      labels,
      { charterLabels: twinsLabels },
    );
    expect(chips[0]!.text).toBe(`Charter: ${twinsLabels.get(CH_A)}`);
  });
});

describe('Books ordered by charter', () => {
  it('reads copies in orders, and states them apart when other units exist', () => {
    expect(copy.bookReportByCharterValue('1284', 12)).toBe('1,284 copies in 12 orders');
    expect(copy.bookReportByCharterValue('1', 1)).toBe('1 copy in 1 order');
    expect(copy.bookReportByCharterValue('12', 4, true)).toBe('12 copies · 4 orders');
    expect(
      copy.bookReportByCharterTotalLine({ copies: '642', orders: 26, unresolved: { entries: 0 } }),
    ).toBe('All charters: 642 copies requested in 26 orders.');
    expect(
      copy.bookReportByCharterTotalLine({ copies: '15', orders: 4, unresolved: { entries: 1 } }),
    ).toBe('All charters: 15 copies requested. Orders containing books: 4.');
    expect(copy.bookReportByCharterApplyLabel('Marconi · MAR-01')).toBe(
      'Show only Marconi · MAR-01',
    );
    expect(copy.BOOK_REPORT_BY_CHARTER_TITLE).toBe('Books ordered by charter');
    expect(copy.BOOK_REPORT_BY_CHARTER_UNITS_NOTE).toBe(
      'Copies in single-copy units only, as in Total books ordered.',
    );
  });
});

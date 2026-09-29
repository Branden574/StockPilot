import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  BOOK_COVER_PLACEHOLDER,
  BOOK_COVER_UNAVAILABLE,
  BOOK_REPORT_CSV_MAX_ROWS,
  BOOK_REPORT_EXPORT_COVER_CAP_NOTE,
  BOOK_REPORT_ORDER_LINK_HINT,
  BOOK_REPORT_PDF_MAX_ROWS,
  BOOK_REPORT_UI,
  DEFAULT_BOOK_REPORT_QUERY,
  DEFAULT_BOOK_REPORT_STATUS_GROUPS,
  BOOK_REPORT_BY_CHARTER_UNITS_NOTE,
  BOOK_REPORT_NO_CHARTER_HINT,
  bookReportStatusLabels,
  parseBookOrderOptionsResponse,
  parseBookOrderOrdersResponse,
  parseBookOrderTotalsResponse,
  type BookReportQuery,
  type ModuleId,
  type Permission,
} from '@stockpilot/core';

import {
  BOOK_A,
  BOOK_B,
  ORDER_1,
  W1,
  W2,
  optionsAnswer,
  ordersAnswer,
  orderRow,
  totalsAnswer,
} from './__fixtures__/book-order-totals';
import {
  applyBookReportDraft,
  bookReportChipEchoes,
  bookReportDraftIsValid,
  bookReportDraftProblems,
  bookReportDrillDownHref,
  bookReportExportMode,
  bookReportExportOffer,
  bookReportHasFiltersToClear,
  bookReportIdentifiersLine,
  bookReportOrderRowPresentation,
  bookReportPhoneChips,
  bookReportPlaceLine,
  bookReportQueryFromListParams,
  bookReportQueryFromParams,
  bookReportRowAccessibilityLabel,
  bookReportRowFiguresLine,
  bookReportUnreadableFilter,
  bookReportWithoutUnreadableFilter,
  bookReportWebUrl,
  bookCoverCacheKey,
  bookCoverPlaceholderLabel,
  bookReportByCharterView,
  bookReportCharterChoices,
  bookReportCharterLabelsFor,
  bookReportCharterWarehouseEmpty,
  bookReportCustomRangeQuery,
  bookReportDateTile,
  bookReportDatesSheetStart,
  bookReportListHref,
  bookReportOrdersShowCharter,
  bookReportPresetQuery,
  bookReportShowingView,
  BOOK_REPORT_CHARTER_SEARCH_OVER,
  BOOK_REPORT_DATE_CHOICES,
  clearBookReportFilters,
  copiesMetric,
  filterBookReportCharterChoices,
  isResolvedBookReportQuery,
  resetBookReportDraft,
  resolveBookReportRequest,
  sameBookReportQuery,
  showBookReportEntry,
  toggleStatusGroup,
} from './book-order-totals-view';

function q(over: Partial<BookReportQuery> = {}): BookReportQuery {
  return {
    ...DEFAULT_BOOK_REPORT_QUERY,
    statusGroups: [...DEFAULT_BOOK_REPORT_STATUS_GROUPS],
    ...over,
  };
}

const bothModules = new Set<ModuleId>(['orders', 'books', 'reports'] as ModuleId[]);

describe('the Reports screen entry', () => {
  it('needs the orders AND books modules', () => {
    const perms = new Set<Permission>(['reports:read']);
    expect(showBookReportEntry({ modules: bothModules, perms, role: 'staff' })).toBe(true);
    expect(
      showBookReportEntry({ modules: new Set<ModuleId>(['orders'] as ModuleId[]), perms, role: 'staff' }),
    ).toBe(false);
    expect(
      showBookReportEntry({ modules: new Set<ModuleId>(['books'] as ModuleId[]), perms, role: 'staff' }),
    ).toBe(false);
  });

  it('the loaded effective set decides (a revoked reports:read hides it, a granted one shows it)', () => {
    expect(showBookReportEntry({ modules: bothModules, perms: new Set(), role: 'admin' })).toBe(false);
    expect(
      showBookReportEntry({
        modules: bothModules,
        perms: new Set<Permission>(['reports:read']),
        role: 'viewer',
      }),
    ).toBe(true);
  });

  it("before the set loads, the role's defaults decide; with neither it stays hidden", () => {
    expect(showBookReportEntry({ modules: bothModules, perms: undefined, role: 'manager' })).toBe(true);
    expect(showBookReportEntry({ modules: bothModules, perms: undefined, role: 'viewer' })).toBe(false);
    expect(showBookReportEntry({ modules: bothModules, perms: undefined, role: null })).toBe(false);
  });
});

describe('resolveBookReportRequest', () => {
  it('follows the view: its warehouse with the view label, or all', () => {
    expect(resolveBookReportRequest(q(), W1)).toMatchObject({ warehouse: W1, warehouseFromView: true });
    expect(resolveBookReportRequest(q(), null)).toMatchObject({ warehouse: 'all', warehouseFromView: false });
  });
  it('an explicit choice is sent as it is, never labelled as the view', () => {
    expect(resolveBookReportRequest(q({ warehouse: W2 }), W1)).toMatchObject({
      warehouse: W2,
      warehouseFromView: false,
    });
    expect(resolveBookReportRequest(q({ warehouse: 'all' }), W1)).toMatchObject({ warehouse: 'all' });
  });
  it('always yields a concrete warehouse', () => {
    for (const w of [null, W1]) expect(isResolvedBookReportQuery(resolveBookReportRequest(q(), w))).toBe(true);
    expect(isResolvedBookReportQuery(q())).toBe(false);
  });
});

describe('link parameters', () => {
  it("a web link's warehouse is an explicit choice on the phone (the web view label is dropped)", () => {
    const { query, invalid } = bookReportQueryFromParams({ warehouse: W1, wview: '1', range: '30d' });
    expect(invalid).toEqual([]);
    expect(query).toMatchObject({ warehouse: W1, warehouseFromView: false, range: '30d' });
  });
  it('invalid keys are reset and named', () => {
    const { query, invalid } = bookReportQueryFromParams({ range: 'forever', sort: 'price', page: '0' });
    expect(invalid).toEqual(['range', 'sort', 'page']);
    expect(query).toMatchObject({ range: 'all', sort: 'copies', page: 1 });
  });
  it("the drill-down reads the list's resolved query, keeping the view label", () => {
    expect(bookReportQueryFromListParams({ warehouse: W1, wview: '1' })).toMatchObject({
      warehouse: W1,
      warehouseFromView: true,
    });
  });
  it("the drill-down route carries the list's filters but not its page", () => {
    const href = bookReportDrillDownHref(BOOK_A, q({ warehouse: W1, warehouseFromView: true, page: 9 }));
    expect(href).toBe(`/reports/book-order-totals/${BOOK_A}?warehouse=${W1}&wview=1`);
  });
  it('the web link carries the same filters, the warehouse as an explicit choice', () => {
    expect(
      bookReportWebUrl('https://stockpilotusa.com/', q({ warehouse: W1, warehouseFromView: true, range: 'year' })),
    ).toBe(`https://stockpilotusa.com/dashboard/reports/book-order-totals?range=year&warehouse=${W1}`);
  });
});

describe('the filters sheet', () => {
  // Plan 13.7 step 3: a custom range is refused in CORE copy, the same
  // sentence the web page shows (BOOK_REPORT_UI.customRangeInvalid). The
  // phone once had its own two sentences ("Enter a date as YYYY-MM-DD, from
  // 2000 to 2100." and "The first date must be on or before the last
  // date."), so the two platforms refused the same range in different words.
  it('refuses an impossible date in the web page\'s words, and marks that date', () => {
    expect(bookReportDraftProblems(q({ range: 'custom', from: '2026-02-30', to: '2026-03-01' }))).toEqual({
      dates: BOOK_REPORT_UI.customRangeInvalid,
      fromInvalid: true,
      toInvalid: false,
      status: null,
    });
    expect(bookReportDraftProblems(q({ range: 'custom', from: '2026-03-01', to: '2101-01-01' }))).toMatchObject({
      dates: BOOK_REPORT_UI.customRangeInvalid,
      fromInvalid: false,
      toInvalid: true,
    });
    expect(bookReportDraftProblems(q({ range: 'custom', from: null, to: null }))).toMatchObject({
      dates: BOOK_REPORT_UI.customRangeInvalid,
      fromInvalid: true,
      toInvalid: true,
    });
  });
  it('refuses a range whose first date is after its last in the same words, marking both dates', () => {
    expect(bookReportDraftProblems(q({ range: 'custom', from: '2026-03-02', to: '2026-03-01' }))).toEqual({
      dates: BOOK_REPORT_UI.customRangeInvalid,
      fromInvalid: true,
      toInvalid: true,
      status: null,
    });
  });
  it('a real range, or any preset, has no date problem', () => {
    expect(bookReportDraftProblems(q({ range: 'custom', from: '2026-03-01', to: '2026-03-01' }))).toEqual({
      dates: null,
      fromInvalid: false,
      toInvalid: false,
      status: null,
    });
    expect(bookReportDraftProblems(q({ range: 'month', from: null, to: null })).dates).toBeNull();
    expect(bookReportDraftIsValid(q({ range: 'custom', from: '2026-03-01', to: '2026-03-01' }))).toBe(true);
    expect(bookReportDraftIsValid(q({ range: 'custom', from: null, to: '2026-03-01' }))).toBe(false);
    expect(bookReportDraftIsValid(q({ range: 'custom', from: '2026-03-02', to: '2026-03-01' }))).toBe(false);
  });
  it('needs at least one status, in core\'s words (the web page\'s)', () => {
    expect(bookReportDraftProblems(q({ statusGroups: [] })).status).toBe(BOOK_REPORT_UI.statusNoneChosen);
    expect(bookReportDraftIsValid(q({ statusGroups: [] }))).toBe(false);
  });
  it('Apply goes back to page 1 and drops dates outside a custom range', () => {
    expect(applyBookReportDraft(q({ page: 4, range: '30d', from: '2026-01-01', to: '2026-01-02' }))).toMatchObject({
      page: 1,
      from: null,
      to: null,
    });
  });
  it('Reset returns its own four controls to their defaults (following the view again) and keeps the search', () => {
    const reset = resetBookReportDraft(q({ warehouse: W1, sort: 'title', q: 'hobbit', statusGroups: ['denied'] }));
    expect(reset).toMatchObject({ warehouse: 'default', sort: 'copies', q: 'hobbit', page: 1 });
    expect(reset.statusGroups).toEqual([...DEFAULT_BOOK_REPORT_STATUS_GROUPS]);
  });
  it('Reset leaves the charter and the dates alone: they have their own sheets', () => {
    const reset = resetBookReportDraft(
      q({ charter: W2, range: 'custom', from: '2026-09-01', to: '2026-09-30', category: 'none', page: 3 }),
    );
    expect(reset).toMatchObject({
      charter: W2,
      range: 'custom',
      from: '2026-09-01',
      to: '2026-09-30',
      category: 'all',
      page: 1,
    });
  });
  it('status groups toggle in canonical order', () => {
    expect(toggleStatusGroup(['completed', 'awaiting'], 'denied')).toEqual(['awaiting', 'completed', 'denied']);
    expect(toggleStatusGroup(['awaiting', 'denied'], 'denied')).toEqual(['awaiting']);
  });
});

describe('the chip row (plan 5): Charter, Orders placed, Status, Warehouse, Category, Sort', () => {
  const labels = bookReportStatusLabels(null);
  const CH_A = '0a0a0a0a-0000-4000-8000-00000000000a';
  const chipsFor = (
    query: BookReportQuery,
    answer: Record<string, unknown> | null = null,
    options: Record<string, unknown> | null = null,
    charterLabels: ReadonlyMap<string, string> = new Map(),
  ) => {
    const parsed = answer ? parseBookOrderTotalsResponse(totalsAnswer(answer)) : null;
    const opts = options ? parseBookOrderOptionsResponse(optionsAnswer(options)) : null;
    return bookReportPhoneChips({
      query,
      echoes: bookReportChipEchoes(query, parsed, opts),
      statusLabels: labels,
      charterLabels,
      activeWarehouseId: W1,
      activeWarehouseName: 'DC4',
    });
  };

  it('defaults: six chips, in order, none removable, each opening its own sheet', () => {
    const chips = chipsFor(q());
    expect(chips.map((c) => [c.key, c.text, c.opens, c.remove])).toEqual([
      ['charter', 'Charter: All charters', 'charter', null],
      ['dates', 'Orders placed: All time', 'dates', null],
      ['status', 'Status: Eligible orders', 'filters', null],
      ['warehouse', 'Warehouse: DC4 (your warehouse view)', 'filters', null],
      ['category', 'Category: All categories', 'filters', null],
      ['sort', 'Sort: Most copies', 'filters', null],
    ]);
    expect(chips.map((c) => c.hint)).toEqual([
      'Opens charter choices',
      'Opens date choices',
      'Opens the filters',
      'Opens the filters',
      'Opens the filters',
      'Opens the filters',
    ]);
  });

  it("a chosen filter reads core's chip, with a remove button that resets only it, on page 1", () => {
    const query = q({
      charter: CH_A,
      range: 'custom',
      from: '2026-09-01',
      to: '2026-09-30',
      warehouse: W2,
      category: 'none',
      statusGroups: ['awaiting'],
      sort: 'title',
      page: 4,
    });
    const chips = chipsFor(query, null, null, new Map([[CH_A, 'Charter Alder · CH-A']]));
    expect(chips.map((c) => c.text)).toEqual([
      'Charter: Charter Alder · CH-A',
      'Orders placed: Sep 1 – Sep 30, 2026',
      `Status: ${labels.pending_approval}`,
      'Warehouse: Chosen warehouse',
      'Category: No category',
      'Sort: Title (A–Z)',
    ]);
    const byKey = Object.fromEntries(chips.map((c) => [c.key, c]));
    expect(byKey.charter!.remove).toMatchObject({ key: 'charter', label: 'Remove charter filter' });
    expect(byKey.charter!.remove!.cleared).toMatchObject({ charter: 'all', range: 'custom', page: 1 });
    expect(byKey.dates!.remove!.cleared).toMatchObject({ charter: CH_A, range: 'all', from: null, to: null });
    expect(byKey.warehouse!.remove!.cleared).toMatchObject({ warehouse: 'default', charter: CH_A });
    expect(byKey.sort!.remove).toBeNull();
  });

  it("a chosen warehouse or category is named from the answer, else from the lists (never 'Chosen ...' when either knows it)", () => {
    const query = q({ warehouse: W2, category: BOOK_B });
    // Still loading: the lists name them.
    expect(chipsFor(query, null, {}).map((c) => c.text).slice(3, 5)).toEqual([
      'Warehouse: North (archived)',
      'Category: Fiction (deleted)',
    ]);
    // The answer's echo wins when it is for the same warehouse.
    const answered = chipsFor(query, {
      filters: {
        warehouse: { id: W2, name: 'North Annex', status: 'active' },
        category: { id: BOOK_B, name: 'Fiction', deleted: false },
        uncategorized: false,
      },
    });
    expect(answered.map((c) => c.text).slice(3, 5)).toEqual(['Warehouse: North Annex', 'Category: Fiction']);
  });

  it('a preset reads its resolved days from the answer only when the answer is for that preset', () => {
    const month = q({ range: 'month' });
    const echo = { range: { key: 'month', from: '2026-09-01', to: '2026-09-29', timeZone: 'America/Los_Angeles', timeZoneFallback: false } };
    expect(chipsFor(month, echo)[1]!.text).toBe('Orders placed: This month (Sep 1 – Sep 29, 2026)');
    expect(chipsFor(q({ range: 'week' }), echo)[1]!.text).toBe('Orders placed: This week');
  });

  it('an explicit All warehouses is not a filter to remove; a warehouse-view warehouse is not either', () => {
    expect(chipsFor(q({ warehouse: 'all' }))[3]).toMatchObject({
      text: 'Warehouse: All warehouses you can see',
      remove: null,
    });
    expect(chipsFor(q())[3]!.remove).toBeNull();
  });

  it('Clear filters shows for a charter, dates, status, chosen warehouse, category or search, never for the sort alone', () => {
    expect(bookReportHasFiltersToClear(q())).toBe(false);
    expect(bookReportHasFiltersToClear(q({ sort: 'title' }))).toBe(false);
    expect(bookReportHasFiltersToClear(q({ warehouse: 'all' }))).toBe(false);
    for (const over of [
      { charter: 'none' },
      { range: 'today' as const },
      { statusGroups: ['denied' as const] },
      { warehouse: W1 },
      { category: 'none' },
      { q: 'hobbit' },
    ]) {
      expect(bookReportHasFiltersToClear(q(over))).toBe(true);
    }
  });

  it("Clear filters resets charter, dates, status, warehouse, category and search, keeps the sort, page 1", () => {
    const cleared = clearBookReportFilters(
      q({ charter: 'none', range: 'week', statusGroups: ['denied'], warehouse: W1, category: 'none', q: 'x', sort: 'latest', page: 5 }),
    );
    expect(cleared).toEqual({ ...q(), sort: 'latest' });
  });

  it('two queries are the same answer only when every filter and the page match', () => {
    expect(sameBookReportQuery(q({ charter: W1 }), q({ charter: W1 }))).toBe(true);
    expect(sameBookReportQuery(q(), q({ page: 2 }))).toBe(false);
    expect(sameBookReportQuery(q(), q({ charter: 'none' }))).toBe(false);
    expect(sameBookReportQuery(q({ warehouse: W1 }), q({ warehouse: W1, warehouseFromView: true }))).toBe(false);
  });
});

describe('rows', () => {
  const answer = parseBookOrderTotalsResponse(totalsAnswer());
  const a = answer.rows[0]!;

  it('lines: identifiers, place, and the figures the API returned', () => {
    expect(bookReportIdentifiersLine(a)).toBe('SKU BK-A · ISBN 9780140449136');
    expect(bookReportPlaceLine(a)).toBe('DC4 · Rack 12-B');
    expect(bookReportRowFiguresLine(a)).toBe('30 copies requested · 3 orders · Latest order Sep 20, 2026');
    // A failed checksum is a barcode, never called an ISBN.
    expect(bookReportIdentifiersLine({ ...a, identifier: '9780140449137' })).toBe(
      'SKU BK-A · Barcode 9780140449137',
    );
  });

  it('VoiceOver reads the row in one breath', () => {
    expect(bookReportRowAccessibilityLabel(a)).toBe(
      'Book A. 30 copies requested in 3 orders. Latest order September 20, 2026. SKU BK-A · ISBN 9780140449136. DC4 · Rack 12-B. View orders.',
    );
    expect(
      bookReportRowAccessibilityLabel({ ...a, countsAsCopies: false, unit: 'pack of 10', copies: '12', orders: 2, itemStatus: 'archived' }),
    ).toContain('12 (pack of 10) in 2 orders. ');
    expect(bookReportRowAccessibilityLabel({ ...a, itemStatus: 'archived' })).toContain('Archived.');
  });

  it('the copies metric uses the exact text', () => {
    expect(copiesMetric('1234')).toEqual({ value: '1,234', unit: 'copies requested' });
    expect(copiesMetric('1')).toEqual({ value: '1', unit: 'copy requested' });
  });
});

describe('drill-down rows (plan gap 7): a link only when openable', () => {
  const labels = bookReportStatusLabels(null);
  const answer = parseBookOrderOrdersResponse(ordersAnswer());
  const book = answer.book!;

  it('openable false: no link, role text, the reason as the hint', () => {
    const p = bookReportOrderRowPresentation(answer.rows[0]!, book, labels);
    expect(p.href).toBeNull();
    expect(p.accessibilityRole).toBe('text');
    expect(p.accessibilityHint).toBe(BOOK_REPORT_ORDER_LINK_HINT);
    expect(p.title).toBe('SO-000049');
    expect(p.quantity).toBe('10 copies requested');
    expect(p.combined).toBe('(2 lines)');
    expect(p.details).toBe(`Sep 20, 2026 · DC4 · ${labels.approved}`);
  });

  it("openable true: opens /order/<id> on the phone", () => {
    const row = parseBookOrderOrdersResponse(ordersAnswer({ rows: [{ ...orderRow, openable: true }] })).rows[0]!;
    const p = bookReportOrderRowPresentation(row, book, labels);
    expect(p.href).toBe(`/order/${ORDER_1}`);
    expect(p.accessibilityRole).toBe('button');
  });

  it('another unit is named, never called copies', () => {
    const p = bookReportOrderRowPresentation(answer.rows[0]!, { countsAsCopies: false, unit: 'pack of 10' }, labels);
    expect(p.quantity).toBe('10 (pack of 10)');
  });

  it('with All charters each order names its charter (No charter for a pickup), and says it', () => {
    const CH = '0a0a0a0a-0000-4000-8000-00000000000a';
    const parsed = parseBookOrderOrdersResponse(
      ordersAnswer({
        filters: { warehouse: null, charter: null, noCharter: false },
        rows: [
          { ...orderRow, charterId: CH, charterName: 'Charter Alder', charterCode: 'CH-A' },
          { ...orderRow, orderId: BOOK_B, charterId: null, charterName: null, charterCode: null },
        ],
      }),
    );
    const show = bookReportOrdersShowCharter(parsed.filters);
    expect(show).toBe(true);
    const [a, b] = parsed.rows.map((r) => bookReportOrderRowPresentation(r, book, labels, { showCharter: show }));
    expect(a!.charter).toBe('Charter: Charter Alder · CH-A');
    expect(a!.accessibilityLabel).toContain('Charter: Charter Alder · CH-A.');
    expect(b!.charter).toBe('Charter: No charter');
  });

  it('with one charter chosen (or No charter) the rows do not repeat it; an older server names none', () => {
    const one = parseBookOrderOrdersResponse(
      ordersAnswer({
        filters: { warehouse: null, charter: { id: W1, name: 'Alder', code: null, status: 'active' }, noCharter: false },
        rows: [{ ...orderRow, charterId: W1, charterName: 'Alder', charterCode: null }],
      }),
    );
    expect(bookReportOrdersShowCharter(one.filters)).toBe(false);
    expect(bookReportOrdersShowCharter({ charter: null, noCharter: true })).toBe(false);
    const p = bookReportOrderRowPresentation(one.rows[0]!, book, labels, { showCharter: false });
    expect(p.charter).toBeNull();
    expect(p.accessibilityLabel).not.toContain('Charter');
    // Before 0382: no charter keys at all. All charters, but rows carry no charter.
    expect(bookReportOrdersShowCharter(answer.filters)).toBe(true);
    expect(bookReportOrderRowPresentation(answer.rows[0]!, book, labels, { showCharter: true }).charter).toBeNull();
  });
});

describe('a warehouse or category the reader cannot see (400), as the web page handles it', () => {
  const refusal = (reason: string) =>
    Object.assign(new Error('That warehouse is not one you can see.'), {
      name: 'ApiError',
      status: 400,
      code: 'validation_error',
      details: { reason },
    });
  it('names which filter the server refused', () => {
    expect(bookReportUnreadableFilter(refusal('invalid_charter'))).toBe('charter');
    expect(bookReportUnreadableFilter(refusal('invalid_warehouse'))).toBe('warehouse');
    expect(bookReportUnreadableFilter(refusal('invalid_category'))).toBe('category');
    expect(bookReportUnreadableFilter(refusal('invalid_range'))).toBeNull();
    expect(bookReportUnreadableFilter(Object.assign(new Error('x'), { status: 403 }))).toBeNull();
  });
  it('drops it and reads again: a link warehouse falls back to the view, the view to all, a category to all', () => {
    const base = {
      ...DEFAULT_BOOK_REPORT_QUERY,
      statusGroups: [...DEFAULT_BOOK_REPORT_STATUS_GROUPS],
      page: 3,
    };
    expect(
      bookReportWithoutUnreadableFilter({ ...base, warehouse: W1 }, 'warehouse'),
    ).toMatchObject({
      warehouse: 'default',
      page: 1,
    });
    expect(
      bookReportWithoutUnreadableFilter({ ...base, warehouse: 'default' }, 'warehouse'),
    ).toMatchObject({
      warehouse: 'all',
      page: 1,
    });
    // Nothing left to drop: the refusal is shown, never a loop.
    expect(
      bookReportWithoutUnreadableFilter({ ...base, warehouse: 'all' }, 'warehouse'),
    ).toBeNull();
    expect(bookReportWithoutUnreadableFilter({ ...base, category: W2 }, 'category')).toMatchObject({
      category: 'all',
      page: 1,
    });
    expect(bookReportWithoutUnreadableFilter({ ...base, category: 'all' }, 'category')).toBeNull();
  });
  it('a refused charter falls back to All charters on page 1, keeping every other filter; nothing left: null', () => {
    const base = q({ charter: W2, range: 'custom', from: '2026-09-01', to: '2026-09-30', q: 'x', page: 3 });
    expect(bookReportWithoutUnreadableFilter(base, 'charter')).toEqual({ ...base, charter: 'all', page: 1 });
    expect(bookReportWithoutUnreadableFilter(q({ charter: 'none' }), 'charter')).toMatchObject({ charter: 'all' });
    expect(bookReportWithoutUnreadableFilter(q(), 'charter')).toBeNull();
  });
  it('a link refused on every id resets at most four times, then stops (never a loop)', () => {
    let cur: BookReportQuery | null = q({ charter: W1, warehouse: W2, category: BOOK_B });
    const seen: string[] = [];
    for (const key of ['charter', 'warehouse', 'warehouse', 'category', 'charter', 'warehouse', 'category'] as const) {
      const next: BookReportQuery | null = cur ? bookReportWithoutUnreadableFilter(cur, key) : null;
      if (!next) continue;
      seen.push(key);
      cur = next;
    }
    expect(seen).toEqual(['charter', 'warehouse', 'warehouse', 'category']);
    expect(cur).toMatchObject({ charter: 'all', warehouse: 'all', category: 'all' });
  });
});

describe('the drill-down with no list underneath (a cold link)', () => {
  it("Back opens the list with the drill-down's filters after any reset, never a refused charter", () => {
    const opened = q({ charter: W2, range: 'custom', from: '2026-09-01', to: '2026-09-30', warehouse: W1, warehouseFromView: true, page: 2 });
    const reset = bookReportWithoutUnreadableFilter(opened, 'charter')!;
    expect(bookReportListHref(reset)).toBe(
      `/reports/book-order-totals?range=custom&from=2026-09-01&to=2026-09-30&warehouse=${W1}`,
    );
    expect(bookReportListHref(opened)).toContain(`charter=${W2}`);
    expect(bookReportListHref(q())).toBe('/reports/book-order-totals');
  });
  it("Android's web link carries the charter and the dates (the web page reads them the same way)", () => {
    expect(
      bookReportWebUrl(
        'https://stockpilotusa.com',
        q({ charter: W2, range: 'custom', from: '2026-09-01', to: '2026-09-30', warehouse: W1, warehouseFromView: true }),
      ),
    ).toBe(
      `https://stockpilotusa.com/dashboard/reports/book-order-totals?charter=${W2}&range=custom&from=2026-09-01&to=2026-09-30&warehouse=${W1}`,
    );
  });
  it('the drill-down route carries the charter and the dates (never the list page)', () => {
    expect(bookReportDrillDownHref(BOOK_A, q({ charter: 'none', range: 'today', page: 4 }))).toBe(
      `/reports/book-order-totals/${BOOK_A}?charter=none&range=today`,
    );
  });
});

describe('export (plan 9.5, gaps 11 and 12)', () => {
  it('iOS shares the file; Android (and anything else) is sent to the web', () => {
    expect(bookReportExportMode('ios')).toBe('share');
    expect(bookReportExportMode('android')).toBe('web_only');
    expect(bookReportExportMode('web')).toBe('web_only');
  });

  it('an Android save would NOT need a new binary: the installed expo-file-system carries SAF in JS and native', () => {
    // The web-only Android route departs from the brief and waits only on
    // Android device verification (owner rule 2026-09-23), not on a binary.
    const pkg = path.dirname(require.resolve('expo-file-system/package.json'));
    const dts = readFileSync(path.join(pkg, 'build/legacy/FileSystem.d.ts'), 'utf8');
    const kt = readFileSync(
      path.join(pkg, 'android/src/main/java/expo/modules/filesystem/legacy/FileSystemLegacyModule.kt'),
      'utf8',
    );
    for (const fn of ['requestDirectoryPermissionsAsync', 'createFileAsync']) {
      expect(dts).toContain(fn);
    }
    expect(kt).toContain('requestDirectoryPermissionsAsync');
  });

  it('the cover limit is said BEFORE export when more books match than get covers', () => {
    expect(bookReportExportOffer(612).coverCapNote).toBe(BOOK_REPORT_EXPORT_COVER_CAP_NOTE);
    expect(BOOK_REPORT_EXPORT_COVER_CAP_NOTE).toBe(
      'Covers for the first 500 books; every row and total is included.',
    );
    expect(bookReportExportOffer(32).coverCapNote).toBeNull();
    expect(bookReportExportOffer(500).coverCapNote).toBeNull();
  });

  it('a format above its ceiling is disabled with the counts', () => {
    const atPdf = bookReportExportOffer(BOOK_REPORT_PDF_MAX_ROWS + 1);
    expect(atPdf.choices.find((c) => c.id === 'csv')!.disabledReason).toBeNull();
    expect(atPdf.choices.find((c) => c.id === 'pdf')!.disabledReason).toBe(
      'Too many books for one file (901; the limit is 900). Narrow the filters.',
    );
    expect(atPdf.choices.find((c) => c.id === 'pdf_plain')!.disabledReason).not.toBeNull();
    const atCsv = bookReportExportOffer(BOOK_REPORT_CSV_MAX_ROWS + 1);
    expect(atCsv.choices.every((c) => c.disabledReason !== null)).toBe(true);
    expect(bookReportExportOffer(BOOK_REPORT_PDF_MAX_ROWS).choices.every((c) => c.disabledReason === null)).toBe(true);
  });

  it('offers CSV, PDF with covers and PDF without covers in core words', () => {
    expect(bookReportExportOffer(2).choices.map((c) => [c.label, c.format, c.photos])).toEqual([
      ['CSV (data only, no covers)', 'csv', false],
      ['PDF with covers', 'pdf', true],
      ['PDF without covers', 'pdf', false],
    ]);
  });
});

describe("a cover placeholder's spoken words (simulator walk D1)", () => {
  // The walk heard every book WITHOUT a cover announced as "Cover could not
  // be loaded": the component compared failedUri (null until a load fails)
  // with uri (null for a book with no cover), and null === null read as a
  // failure. "Cover could not be loaded" is for a real failure only.
  it('a book with no cover URL, nothing having failed, is "No cover"', () => {
    expect(bookCoverPlaceholderLabel({ uri: null, failedUri: null, failed: false })).toBe(BOOK_COVER_PLACEHOLDER);
    expect(BOOK_COVER_PLACEHOLDER).toBe('No cover');
  });
  it('a cover whose lookup failed is "Cover could not be loaded"', () => {
    expect(bookCoverPlaceholderLabel({ uri: null, failedUri: null, failed: true })).toBe(BOOK_COVER_UNAVAILABLE);
  });
  it('a URL that failed to load is "Cover could not be loaded"', () => {
    const uri = 'https://example.test/cover.jpg';
    expect(bookCoverPlaceholderLabel({ uri, failedUri: uri, failed: false })).toBe(BOOK_COVER_UNAVAILABLE);
  });
  it('an earlier URL failing does not make a book with no cover read as a failure', () => {
    expect(
      bookCoverPlaceholderLabel({ uri: null, failedUri: 'https://example.test/old.jpg', failed: false }),
    ).toBe(BOOK_COVER_PLACEHOLDER);
  });
});

describe('cover cache keys', () => {
  it('a signed storage URL is keyed without its rotating token', () => {
    expect(
      bookCoverCacheKey('https://x.supabase.co/storage/v1/object/sign/item-images/org/a.jpg?token=abc'),
    ).toBe('https://x.supabase.co/storage/v1/object/sign/item-images/org/a.jpg');
  });
  it('an external cover keeps its query (it IS the picture), so two books never share one', () => {
    const a = 'https://books.google.com/books/content?id=AAA&printsec=frontcover&img=1';
    const b = 'https://books.google.com/books/content?id=BBB&printsec=frontcover&img=1';
    expect(bookCoverCacheKey(a)).toBe(a);
    expect(bookCoverCacheKey(a)).not.toBe(bookCoverCacheKey(b));
  });
});

describe('charter labels and the Charter sheet (plan 5)', () => {
  const A = '0a0a0a0a-0000-4000-8000-00000000000a';
  const B = '0b0b0b0b-0000-4000-8000-00000000000b';
  const C = '0c0c0c0c-0000-4000-8000-00000000000c';
  const options = {
    charters: [
      { id: A, name: 'Alder', code: 'CH-A', status: 'active' },
      { id: B, name: 'Birch', code: null, status: 'active' },
      { id: C, name: 'Birch', code: null, status: 'archived' },
    ],
    noCharter: true,
  };

  it("labels come from core: Name · CODE, a status suffix, and alike names told apart by the id's start", () => {
    const labels = bookReportCharterLabelsFor(options);
    expect(labels.get(A)).toBe('Alder · CH-A');
    expect(labels.get(B)).toBe('Birch');
    expect(labels.get(C)).toBe('Birch (archived)');
    const twins = bookReportCharterLabelsFor({
      charters: [
        { id: A, name: 'Birch', code: null, status: 'active' },
        { id: B, name: 'Birch', code: null, status: 'active' },
      ],
    });
    expect(twins.get(A)).toBe('Birch (id 0a0a0a0a)');
    expect(twins.get(B)).toBe('Birch (id 0b0b0b0b)');
  });

  it('a charter only a by-charter row names (the lists failed) still gets a label', () => {
    const labels = bookReportCharterLabelsFor(null, [
      { id: A, name: 'Alder', code: 'CH-A', status: 'active' },
      { id: null, name: null, code: null, status: null },
    ]);
    expect([...labels.entries()]).toEqual([[A, 'Alder · CH-A']]);
  });

  it('rows: All charters, each charter, No charter last (with its hint) only when offered', () => {
    const labels = bookReportCharterLabelsFor(options);
    const rows = bookReportCharterChoices({ current: 'all', options, labels, echo: null });
    expect(rows.map((r) => [r.value, r.label, r.detail])).toEqual([
      ['all', 'All charters', null],
      [A, 'Alder · CH-A', null],
      [B, 'Birch', null],
      [C, 'Birch (archived)', null],
      ['none', 'No charter', BOOK_REPORT_NO_CHARTER_HINT],
    ]);
    const noPickups = bookReportCharterChoices({ current: 'all', options: { ...options, noCharter: false }, labels, echo: null });
    expect(noPickups.map((r) => r.value)).not.toContain('none');
    // Applied, it is always offered (to be chosen again after trying another).
    const applied = bookReportCharterChoices({ current: 'none', options: { ...options, noCharter: false }, labels, echo: null });
    expect(applied.at(-1)!.value).toBe('none');
  });

  it("an applied charter the lists do not carry is offered by the answer's name; failed lists keep All and the applied one", () => {
    const echo = { id: 'd0d0d0d0-0000-4000-8000-00000000000d', name: 'Dogwood', code: 'CH-D', status: 'active' };
    const failed = bookReportCharterChoices({ current: echo.id, options: null, labels: new Map(), echo });
    expect(failed.map((r) => [r.value, r.label])).toEqual([
      ['all', 'All charters'],
      [echo.id, 'Dogwood · CH-D'],
    ]);
    const unnamed = bookReportCharterChoices({ current: echo.id, options: null, labels: new Map(), echo: null });
    expect(unnamed[1]!.label).toBe('Chosen charter');
  });

  it('a search shows only past 12 rows, matches any part of a label in any case, and keeps the applied row', () => {
    expect(BOOK_REPORT_CHARTER_SEARCH_OVER).toBe(12);
    const labels = bookReportCharterLabelsFor(options);
    const rows = bookReportCharterChoices({ current: A, options, labels, echo: null });
    expect(filterBookReportCharterChoices(rows, 'birch', A).map((r) => r.value)).toEqual([A, B, C]);
    expect(filterBookReportCharterChoices(rows, '  ', A)).toHaveLength(rows.length);
  });
});

describe('Showing (brief 8, plan D20) and the empty state', () => {
  const labels = bookReportStatusLabels(null);
  const CH = '0a0a0a0a-0000-4000-8000-00000000000a';

  it('All charters, the range with its days, then the statuses; no warehouse line for All warehouses', () => {
    const answer = parseBookOrderTotalsResponse(totalsAnswer());
    const v = bookReportShowingView(answer, DEFAULT_BOOK_REPORT_STATUS_GROUPS, new Map());
    expect(v).toEqual({
      eyebrow: 'Showing',
      title: 'All charters',
      lines: ['All time (May 12, 2026 – Sep 20, 2026)', 'Eligible orders'],
      spoken: 'Showing: All charters. All time (May 12, 2026 – Sep 20, 2026). Eligible orders.',
    });
  });

  it("names the phone's warehouse view, and an explicit warehouse, from the answer's echoes", () => {
    const view = parseBookOrderTotalsResponse(
      totalsAnswer({
        filters: { warehouse: { id: W1, name: 'DC4', status: 'active' }, category: null, uncategorized: false },
        warehouse: { id: W1, source: 'view' },
      }),
    );
    expect(bookReportShowingView(view, ['awaiting'], new Map()).lines).toEqual([
      'All time (May 12, 2026 – Sep 20, 2026)',
      'Warehouse: DC4 (your warehouse view)',
      '1 of 6 statuses',
    ]);
    const explicit = parseBookOrderTotalsResponse(
      totalsAnswer({
        filters: { warehouse: { id: W2, name: 'North', status: 'archived' }, category: null, uncategorized: false },
        warehouse: { id: W2, source: 'explicit' },
      }),
    );
    expect(bookReportShowingView(explicit, DEFAULT_BOOK_REPORT_STATUS_GROUPS, new Map()).lines[1]).toBe(
      'Warehouse: North (archived)',
    );
  });

  it("a charter reads its label (the sheet's tie-break included); No charter reads No charter", () => {
    const one = parseBookOrderTotalsResponse(
      totalsAnswer({
        filters: {
          warehouse: null,
          category: null,
          uncategorized: false,
          charter: { id: CH, name: 'Alder', code: 'CH-A', status: 'active' },
          noCharter: false,
        },
        byCharter: null,
      }),
    );
    expect(bookReportShowingView(one, DEFAULT_BOOK_REPORT_STATUS_GROUPS, new Map()).title).toBe('Alder · CH-A');
    expect(bookReportShowingView(one, DEFAULT_BOOK_REPORT_STATUS_GROUPS, new Map([[CH, 'Alder (id 0a0a0a0a)']])).title).toBe(
      'Alder (id 0a0a0a0a)',
    );
    const none = parseBookOrderTotalsResponse(
      totalsAnswer({ filters: { warehouse: null, category: null, uncategorized: false, charter: null, noCharter: true } }),
    );
    expect(bookReportShowingView(none, DEFAULT_BOOK_REPORT_STATUS_GROUPS, new Map()).title).toBe('No charter');
  });

  it("the charter-at-another-warehouse hint: a charter, one warehouse (chosen or the view's), nothing found", () => {
    const base = {
      totalCount: 0,
      filters: {
        warehouse: { id: W1, name: 'DC4', status: 'active' },
        charter: { id: CH, name: 'Alder', code: null, status: 'active' },
        noCharter: false,
      },
    };
    expect(bookReportCharterWarehouseEmpty(base)).toBe(true);
    expect(bookReportCharterWarehouseEmpty({ ...base, totalCount: 1 })).toBe(false);
    expect(bookReportCharterWarehouseEmpty({ ...base, filters: { ...base.filters, warehouse: null } })).toBe(false);
    expect(bookReportCharterWarehouseEmpty({ ...base, filters: { ...base.filters, charter: null, noCharter: true } })).toBe(
      false,
    );
    void labels;
  });
});

describe('"Books ordered by charter" (brief 14)', () => {
  const CH = '0a0a0a0a-0000-4000-8000-00000000000a';
  const answerWith = (byCharter: unknown, unresolvedEntries = 0) =>
    parseBookOrderTotalsResponse(
      totalsAnswer({
        byCharter,
        summary: {
          ...(totalsAnswer().summary as object),
          unresolved: { entries: unresolvedEntries, quantity: unresolvedEntries ? '12' : '0' },
        },
      }),
    );

  it("rows in the server's order (No charter last), the answer's figures, each applying its charter; the total equals the summary", () => {
    const v = bookReportByCharterView(
      answerWith([
        { id: CH, name: 'Alder', code: 'CH-A', status: 'active', copies: '30', orders: 2 },
        { id: null, name: null, code: null, status: null, copies: '4', orders: 1 },
      ]),
      new Map(),
    )!;
    expect(v.rows.map((r) => [r.charter, r.label, r.value, r.accessibilityHint])).toEqual([
      [CH, 'Alder · CH-A', '30 copies in 2 orders', 'Show only Alder · CH-A'],
      ['none', 'No charter', '4 copies in 1 order', 'Show only No charter'],
    ]);
    expect(v.rows[0]!.accessibilityLabel).toBe('Alder · CH-A: 30 copies in 2 orders.');
    expect(v.total).toBe('All charters: 34 copies requested in 3 orders.');
    expect(v.unitsNote).toBeNull();
  });

  it('with books in other units the copies and orders are said apart, with the note', () => {
    const v = bookReportByCharterView(
      answerWith([{ id: CH, name: 'Alder', code: null, status: 'active', copies: '34', orders: 3 }], 1),
      new Map(),
    )!;
    expect(v.rows[0]!.value).toBe('34 copies · 3 orders');
    expect(v.unitsNote).toBe(BOOK_REPORT_BY_CHARTER_UNITS_NOTE);
  });

  it('nothing to show: a charter chosen (null), an older server (absent), or no rows', () => {
    expect(bookReportByCharterView(answerWith(null), new Map())).toBeNull();
    expect(bookReportByCharterView(parseBookOrderTotalsResponse(totalsAnswer()), new Map())).toBeNull();
    expect(bookReportByCharterView(answerWith([]), new Map())).toBeNull();
  });
});

describe('the dates sheet (plan 5, D7)', () => {
  const echoMonth = { key: 'month' as const, from: '2026-09-01', to: '2026-09-29' };

  it("offers the presets in the brief's order, then Custom range", () => {
    expect(BOOK_REPORT_DATE_CHOICES).toEqual(['all', 'today', 'week', 'month', '30d', '90d', 'year', 'custom']);
  });

  it("opens on the applied custom range, else a preset's resolved days from the answer, else the organization's today", () => {
    expect(
      bookReportDatesSheetStart({ query: q({ range: 'custom', from: '2026-08-03', to: '2026-08-09' }), echo: echoMonth, today: '2026-09-29' }),
    ).toEqual({ draft: { start: '2026-08-03', end: '2026-08-09', editing: 'start' }, month: { y: 2026, m: 8 } });
    expect(bookReportDatesSheetStart({ query: q({ range: 'month' }), echo: echoMonth, today: '2026-09-29' })).toEqual({
      draft: { start: '2026-09-01', end: '2026-09-29', editing: 'start' },
      month: { y: 2026, m: 9 },
    });
    // The answer is for another preset (still loading): nothing picked, today's month.
    expect(bookReportDatesSheetStart({ query: q({ range: 'week' }), echo: echoMonth, today: '2026-09-29' })).toEqual({
      draft: { start: null, end: null, editing: 'start' },
      month: { y: 2026, m: 9 },
    });
    // All time has no days: today's month. No answer: no month (the screen picks).
    expect(bookReportDatesSheetStart({ query: q(), echo: { key: 'all', from: null, to: null }, today: '2026-02-10' }).month).toEqual({
      y: 2026,
      m: 2,
    });
    expect(bookReportDatesSheetStart({ query: q(), echo: null, today: null }).month).toBeNull();
  });

  it('a preset applies that range with no dates, on page 1, keeping every other filter', () => {
    const base = q({ charter: W1, range: 'custom', from: '2026-01-01', to: '2026-01-02', q: 'x', page: 3 });
    expect(bookReportPresetQuery(base, 'week')).toEqual({ ...base, range: 'week', from: null, to: null, page: 1 });
  });

  it('Apply needs both ends, real days, the first on or before the last; it sends range=custom on page 1', () => {
    const base = q({ charter: W1, page: 4 });
    expect(bookReportCustomRangeQuery(base, '2026-09-01', '2026-09-30')).toEqual({
      ...base,
      range: 'custom',
      from: '2026-09-01',
      to: '2026-09-30',
      page: 1,
    });
    expect(bookReportCustomRangeQuery(base, '2026-09-01', null)).toBeNull();
    expect(bookReportCustomRangeQuery(base, null, '2026-09-30')).toBeNull();
    expect(bookReportCustomRangeQuery(base, '2026-09-30', '2026-09-01')).toBeNull();
    expect(bookReportCustomRangeQuery(base, '2026-02-30', '2026-03-01')).toBeNull();
    expect(bookReportCustomRangeQuery(base, '2026-09-01', '2026-09-01')).toMatchObject({ from: '2026-09-01', to: '2026-09-01' });
  });

  it("the tiles show the day or core's prompt, and say which date they are", () => {
    expect(bookReportDateTile('start', '2026-09-01')).toEqual({
      title: 'Start date',
      value: 'Sep 1, 2026',
      chosen: true,
      spoken: 'Start date: Tuesday, September 1, 2026',
    });
    expect(bookReportDateTile('end', null)).toEqual({
      title: 'End date',
      value: 'Choose an end date',
      chosen: false,
      spoken: 'End date: Choose an end date',
    });
    expect(bookReportDateTile('end', '2026-09-3')).toMatchObject({ chosen: false });
  });
});

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
  DEFAULT_BOOK_REPORT_QUERY,
  DEFAULT_BOOK_REPORT_STATUS_GROUPS,
  bookReportStatusLabels,
  parseBookOrderOrdersResponse,
  parseBookOrderTotalsResponse,
  type BookReportQuery,
  type ModuleId,
  type Permission,
} from '@stockpilot/core';

import { BOOK_A, ORDER_1, W1, W2, ordersAnswer, orderRow, totalsAnswer } from './__fixtures__/book-order-totals';
import {
  BOOK_REPORT_DATE_FORMAT_PROBLEM,
  BOOK_REPORT_DATE_ORDER_PROBLEM,
  BOOK_REPORT_STATUS_PROBLEM,
  applyBookReportDraft,
  bookReportDateChip,
  bookReportDraftIsValid,
  bookReportDraftProblems,
  bookReportDrillDownHref,
  bookReportExportMode,
  bookReportExportOffer,
  bookReportIdentifiersLine,
  bookReportOrderRowPresentation,
  bookReportPlaceLine,
  bookReportQueryFromListParams,
  bookReportQueryFromParams,
  bookReportRowAccessibilityLabel,
  bookReportRowFiguresLine,
  bookReportStatusChip,
  bookReportUnreadableFilter,
  bookReportWarehouseChip,
  bookReportWithoutUnreadableFilter,
  bookReportWebUrl,
  bookCoverCacheKey,
  bookCoverPlaceholderLabel,
  copiesMetric,
  isResolvedBookReportQuery,
  resetBookReportDraft,
  resolveBookReportRequest,
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
  it('checks a custom range with core rules', () => {
    expect(bookReportDraftProblems(q({ range: 'custom', from: '2026-02-30', to: '2026-03-01' }))).toMatchObject({
      from: BOOK_REPORT_DATE_FORMAT_PROBLEM,
      to: null,
    });
    expect(bookReportDraftProblems(q({ range: 'custom', from: '2026-03-02', to: '2026-03-01' }))).toMatchObject({
      to: BOOK_REPORT_DATE_ORDER_PROBLEM,
    });
    expect(bookReportDraftIsValid(q({ range: 'custom', from: '2026-03-01', to: '2026-03-01' }))).toBe(true);
    expect(bookReportDraftIsValid(q({ range: 'custom', from: null, to: '2026-03-01' }))).toBe(false);
  });
  it('needs at least one status', () => {
    expect(bookReportDraftProblems(q({ statusGroups: [] })).status).toBe(BOOK_REPORT_STATUS_PROBLEM);
  });
  it('Apply goes back to page 1 and drops dates outside a custom range', () => {
    expect(applyBookReportDraft(q({ page: 4, range: '30d', from: '2026-01-01', to: '2026-01-02' }))).toMatchObject({
      page: 1,
      from: null,
      to: null,
    });
  });
  it('Reset returns every default, following the view again, and keeps the search', () => {
    const reset = resetBookReportDraft(q({ warehouse: W1, sort: 'title', q: 'hobbit', statusGroups: ['denied'] }));
    expect(reset).toMatchObject({ warehouse: 'default', sort: 'copies', q: 'hobbit', page: 1 });
    expect(reset.statusGroups).toEqual([...DEFAULT_BOOK_REPORT_STATUS_GROUPS]);
  });
  it('status groups toggle in canonical order', () => {
    expect(toggleStatusGroup(['completed', 'awaiting'], 'denied')).toEqual(['awaiting', 'completed', 'denied']);
    expect(toggleStatusGroup(['awaiting', 'denied'], 'denied')).toEqual(['awaiting']);
  });
  it('chips say what the next request will use', () => {
    expect(bookReportDateChip(q())).toBe('Date: All time');
    expect(bookReportDateChip(q({ range: 'custom', from: '2026-08-30', to: '2026-09-28' }))).toBe(
      'Date: Aug 30 – Sep 28, 2026',
    );
    expect(bookReportStatusChip(DEFAULT_BOOK_REPORT_STATUS_GROUPS)).toBe('Status: default');
    expect(bookReportStatusChip(['awaiting'])).toBe('Status: 1 of 6');
    const base = { activeWarehouseId: W1, activeWarehouseName: 'DC4', warehouses: [] };
    expect(bookReportWarehouseChip({ ...base, query: q() })).toBe('Warehouse: DC4 (your warehouse view)');
    expect(bookReportWarehouseChip({ ...base, activeWarehouseId: null, activeWarehouseName: null, query: q() })).toBe(
      'Warehouse: All warehouses you can see',
    );
    expect(
      bookReportWarehouseChip({
        ...base,
        query: q({ warehouse: W2 }),
        warehouses: [{ id: W2, name: 'North', status: 'archived' }],
      }),
    ).toBe('Warehouse: North (archived)');
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

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_BOOK_REPORT_QUERY,
  bookReportWithFilter,
  bookReportWithPage,
  parseBookReportQuery,
  type BookReportQuery,
} from '@stockpilot/core';

import {
  bookReportDrawerReturnHref,
  bookReportExportHref,
  bookReportOrdersApiUrl,
  bookReportPageHref,
  readBookReportDrawer,
  withBookReportDrawer,
  withBookReportFilter,
  withBookReportPage,
} from './hrefs';

const W1 = '0e000000-0000-4000-8000-0000000000d1';
const ITEM = '0e000000-0000-4000-8000-000000000f01';
const CH = '0e000000-0000-4000-8000-0000000000a1';

const q = (over: Partial<BookReportQuery> = {}): BookReportQuery => ({
  ...DEFAULT_BOOK_REPORT_QUERY,
  statusGroups: [...DEFAULT_BOOK_REPORT_QUERY.statusGroups],
  ...over,
});

describe('Book Order Totals URLs', () => {
  it('a page URL is canonical and round-trips through the parser', () => {
    const query = q({ warehouse: W1, warehouseFromView: true, sort: 'title', q: 'a&b', page: 3 });
    const href = bookReportPageHref(query);
    expect(href).toBe(
      `/dashboard/reports/book-order-totals?warehouse=${W1}&wview=1&q=a%26b&sort=title&page=3`,
    );
    const back = parseBookReportQuery(new URLSearchParams(href.split('?')[1]));
    expect(back.invalid).toEqual([]);
    expect(back.query).toEqual(query);
    expect(bookReportPageHref(q())).toBe('/dashboard/reports/book-order-totals');
  });

  it('a filter change resets the page; a page change keeps every filter', () => {
    const query = q({ warehouse: 'all', category: 'none', page: 4 });
    expect(withBookReportFilter(query, { sort: 'orders' }).page).toBe(1);
    const p2 = withBookReportPage(query, 2);
    expect(p2).toEqual({ ...query, page: 2 });
  });

  it('exports and the drill-down carry the concrete warehouse and never "default"', () => {
    const query = q({ warehouse: W1, warehouseFromView: true, q: 'x', category: 'none', page: 2 });
    const csv = bookReportExportHref(query, 'csv');
    expect(csv).toBe(
      `/api/v1/reports/book-order-totals/export?format=csv&warehouse=${W1}&wview=1&category=none&q=x`,
    );
    expect(csv).not.toContain('page=');
    const drill = bookReportOrdersApiUrl(ITEM, query, 3);
    expect(drill).toBe(
      `/api/v1/reports/book-order-totals/items/${ITEM}/orders?warehouse=${W1}&wview=1&page=3`,
    );
    expect(() => bookReportExportHref(q(), 'pdf')).toThrow(/resolved warehouse/);
    expect(() => bookReportOrdersApiUrl(ITEM, q(), 1)).toThrow(/resolved warehouse/);
  });

  it('reads and writes the drawer keys without touching the report query', () => {
    expect(readBookReportDrawer(new URLSearchParams(`view=${ITEM.toUpperCase()}&vpage=2`))).toEqual({
      itemId: ITEM,
      page: 2,
    });
    expect(readBookReportDrawer(new URLSearchParams('view=nope&vpage=0'))).toEqual({
      itemId: null,
      page: 1,
    });
    const at = { pathname: '/dashboard/reports/book-order-totals', search: '?warehouse=all&sort=title' };
    expect(withBookReportDrawer(at, ITEM, 2)).toBe(
      `/dashboard/reports/book-order-totals?warehouse=all&sort=title&view=${ITEM}&vpage=2`,
    );
    expect(
      withBookReportDrawer({ ...at, search: `?warehouse=all&view=${ITEM}&vpage=2` }, null),
    ).toBe('/dashboard/reports/book-order-totals?warehouse=all');
  });

  it("the page rules ARE core's (one copy, the phone's too; recurring pattern 26)", () => {
    expect(withBookReportFilter).toBe(bookReportWithFilter);
    expect(withBookReportPage).toBe(bookReportWithPage);
  });

  it('a charter change and a date Apply start at page 1; a page change keeps the charter and the dates', () => {
    const query = q({
      charter: CH,
      range: 'custom',
      from: '2026-09-01',
      to: '2026-09-30',
      page: 4,
    });
    expect(withBookReportFilter(query, { charter: 'none' })).toMatchObject({
      charter: 'none',
      page: 1,
    });
    expect(
      withBookReportFilter(query, { range: 'custom', from: '2026-10-01', to: '2026-10-02' }),
    ).toMatchObject({ charter: CH, from: '2026-10-01', page: 1 });
    expect(withBookReportPage(query, 5)).toEqual({ ...query, page: 5 });
    // The page URL never carries the drawer, so any filter push closes it.
    expect(bookReportPageHref(withBookReportFilter(query, { charter: 'all' }))).not.toMatch(
      /view=|vpage=/,
    );
  });

  it('the drill-down keeps the charter and the dates, and still drops search, category and sort', () => {
    const query = q({
      charter: CH,
      range: 'custom',
      from: '2026-09-01',
      to: '2026-09-30',
      warehouse: 'all',
      q: 'Outsiders',
      category: 'none',
      sort: 'title',
      page: 2,
    });
    expect(bookReportOrdersApiUrl(ITEM, query, 1)).toBe(
      `/api/v1/reports/book-order-totals/items/${ITEM}/orders?charter=${CH}&range=custom&from=2026-09-01&to=2026-09-30&warehouse=all&page=1`,
    );
    expect(bookReportOrdersApiUrl(ITEM, q({ charter: 'none', warehouse: 'all' }), 1)).toContain(
      'charter=none',
    );
  });

  it('an export carries the charter and the dates, never the page', () => {
    const query = q({
      charter: CH,
      range: 'custom',
      from: '2026-09-01',
      to: '2026-09-30',
      warehouse: 'all',
      page: 3,
    });
    expect(bookReportExportHref(query, 'csv')).toBe(
      `/api/v1/reports/book-order-totals/export?format=csv&charter=${CH}&range=custom&from=2026-09-01&to=2026-09-30&warehouse=all`,
    );
  });

  it("the drawer's way back is this page (with its page) and the open book, and parses back to the same report", () => {
    const query = q({
      charter: CH,
      range: 'week',
      warehouse: W1,
      warehouseFromView: true,
      q: 'a&b',
      page: 2,
    });
    const back = bookReportDrawerReturnHref(query, ITEM, 3);
    expect(back).toBe(
      `/dashboard/reports/book-order-totals?charter=${CH}&range=week&warehouse=${W1}&wview=1&q=a%26b&page=2&view=${ITEM}&vpage=3`,
    );
    const sp = new URLSearchParams(back.split('?')[1]);
    expect(parseBookReportQuery(sp).query).toEqual(query);
    expect(readBookReportDrawer(sp)).toEqual({ itemId: ITEM, page: 3 });
    // Drawer page 1 is not written; a bare report gets its own '?'.
    expect(bookReportDrawerReturnHref(q(), ITEM, 1)).toBe(
      `/dashboard/reports/book-order-totals?view=${ITEM}`,
    );
  });
});

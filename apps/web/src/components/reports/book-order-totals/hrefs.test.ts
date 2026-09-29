import { describe, expect, it } from 'vitest';

import {
  DEFAULT_BOOK_REPORT_QUERY,
  parseBookReportQuery,
  type BookReportQuery,
} from '@stockpilot/core';

import {
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
});

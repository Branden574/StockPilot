import { isUuid, serializeBookReportQuery, type BookReportQuery } from '@stockpilot/core';

/**
 * BOOK ORDER TOTALS: every URL the web page builds, in one place.
 *
 * The page resolves the warehouse ONCE on the server (the URL's own value,
 * else the person's warehouse view, else all) and hands the client the
 * RESOLVED query. Every link built here (Previous and Next, sorts and
 * filters, the drill-down fetch and both exports) comes from that query, so
 * a row's total, its drill-down and its exported row always use the same
 * concrete warehouse, even if the warehouse view changes while the page is
 * open. The drill-down and export builders refuse an unresolved query.
 */

export const BOOK_REPORT_PATH = '/dashboard/reports/book-order-totals';
export const BOOK_REPORT_API = '/api/v1/reports/book-order-totals';

/** Drawer state in the page URL: the book whose orders are open, and the
 *  drill-down page. Never part of the report query. */
export const BOOK_REPORT_VIEW_KEY = 'view';
export const BOOK_REPORT_VIEW_PAGE_KEY = 'vpage';

function assertResolved(query: BookReportQuery, what: string): void {
  if (query.warehouse !== 'all' && !isUuid(query.warehouse)) {
    throw new Error(`${what} needs a resolved warehouse (all or an id), not ${query.warehouse}`);
  }
}

/** The page URL for a query: canonical, the page only past 1, no drawer. */
export function bookReportPageHref(query: BookReportQuery): string {
  const qs = serializeBookReportQuery(query);
  return qs ? `${BOOK_REPORT_PATH}?${qs}` : BOOK_REPORT_PATH;
}

/** A filter change: the new value and page 1 (a new filter always starts at
 *  the first page). */
export function withBookReportFilter(
  query: BookReportQuery,
  patch: Partial<Omit<BookReportQuery, 'page'>>,
): BookReportQuery {
  return { ...query, ...patch, statusGroups: [...(patch.statusGroups ?? query.statusGroups)], page: 1 };
}

/** The same report on another page. */
export function withBookReportPage(query: BookReportQuery, page: number): BookReportQuery {
  return { ...query, statusGroups: [...query.statusGroups], page: Math.max(1, Math.trunc(page)) };
}

/**
 * An export link: the whole filtered report (never the page), CSV or PDF,
 * with the concrete warehouse. The PDF link carries covers; the no-covers
 * variant adds `photos=0` (PdfDownloadDropdown appends it).
 */
export function bookReportExportHref(query: BookReportQuery, format: 'csv' | 'pdf'): string {
  assertResolved(query, 'An export link');
  const qs = serializeBookReportQuery(query, { includePage: false });
  return `${BOOK_REPORT_API}/export?format=${format}&${qs}`;
}

/**
 * The drill-down's API URL for one book: the range, the statuses and the
 * concrete warehouse, then the drill-down page. Search, category and sort
 * pick BOOKS, not lines, so they are left out: the drill-down of a row is
 * the same whatever search found it, and its total equals the row's.
 */
export function bookReportOrdersApiUrl(
  itemId: string,
  query: BookReportQuery,
  page: number,
): string {
  assertResolved(query, 'The drill-down');
  const qs = serializeBookReportQuery(
    { ...query, q: '', category: 'all', sort: 'copies', page: 1 },
    { includePage: false },
  );
  const p = Math.max(1, Math.trunc(page));
  return `${BOOK_REPORT_API}/items/${encodeURIComponent(itemId)}/orders?${qs}&page=${p}`;
}

/** The drawer's state read from the page URL: an item id (a uuid) and a
 *  1-based page. Anything else is "closed" and page 1. */
export function readBookReportDrawer(params: { get(key: string): string | null }): {
  itemId: string | null;
  page: number;
} {
  const view = params.get(BOOK_REPORT_VIEW_KEY);
  const rawPage = params.get(BOOK_REPORT_VIEW_PAGE_KEY);
  const page = rawPage && /^[1-9]\d{0,5}$/.test(rawPage) ? Number(rawPage) : 1;
  return { itemId: isUuid(view) ? view.toLowerCase() : null, page };
}

/** The current page URL (path and query) with the drawer set or cleared.
 *  Every other key is kept as it is. */
export function withBookReportDrawer(
  current: { pathname: string; search: string },
  itemId: string | null,
  page = 1,
): string {
  const sp = new URLSearchParams(current.search);
  if (itemId) {
    sp.set(BOOK_REPORT_VIEW_KEY, itemId);
    if (page > 1) sp.set(BOOK_REPORT_VIEW_PAGE_KEY, String(page));
    else sp.delete(BOOK_REPORT_VIEW_PAGE_KEY);
  } else {
    sp.delete(BOOK_REPORT_VIEW_KEY);
    sp.delete(BOOK_REPORT_VIEW_PAGE_KEY);
  }
  const qs = sp.toString();
  return qs ? `${current.pathname}?${qs}` : current.pathname;
}

/**
 * The page contract a server-paginated list returns, and the arithmetic and
 * footer text both apps build from it. One implementation so the web table,
 * the mobile list and the API can never disagree about which rows a page
 * holds or what "Showing 26–50 of 137" means.
 *
 * Pages are 1-based. `page` is always the EFFECTIVE page the rows came from:
 * a request past the end is answered with the last real page, never an empty
 * page that claims there is nothing there.
 */

export interface ListPage<T> {
  items: T[];
  /** Effective 1-based page the items are from. */
  page: number;
  pageSize: number;
  /** Rows matching the search and filters across every page. */
  total: number;
  /** At least 1: an empty list is one empty page. */
  totalPages: number;
  hasPrevious: boolean;
  hasNext: boolean;
}

/** Highest page number a request may name. Anything above it is treated as
 *  "the last page" by the server's clamp, so this only bounds the arithmetic. */
export const MAX_PAGE_NUMBER = 1_000_000;

/**
 * A `?page=` value (string, number, array from a repeated param, or nothing)
 * -> a page number in [1, MAX_PAGE_NUMBER]. Anything unreadable is page 1.
 */
export function parsePageParam(raw: unknown): number {
  const first = Array.isArray(raw) ? raw[0] : raw;
  const text = typeof first === 'number' ? String(first) : typeof first === 'string' ? first.trim() : '';
  if (!/^\d+$/.test(text)) return 1;
  // Any run of digits is a page; one too large to be real is the last page
  // (the server clamps it), never page 1.
  const digits = text.replace(/^0+/, '');
  if (digits === '') return 1;
  if (digits.length > String(MAX_PAGE_NUMBER).length) return MAX_PAGE_NUMBER;
  return Math.min(Number(digits), MAX_PAGE_NUMBER);
}

/** Pages needed for `total` rows, at least 1. */
export function totalPagesFor(total: number, pageSize: number): number {
  const size = Math.max(1, Math.trunc(pageSize));
  return Math.max(1, Math.ceil(Math.max(0, Math.trunc(total)) / size));
}

/** Zero-based inclusive row range for a page (Supabase `.range(from, to)`):
 *  page 1 -> 0–24, page 2 -> 25–49 at size 25. */
export function pageRowRange(page: number, pageSize: number): { from: number; to: number } {
  const size = Math.max(1, Math.trunc(pageSize));
  const from = (Math.max(1, Math.trunc(page)) - 1) * size;
  return { from, to: from + size - 1 };
}

/** Builds the contract from the rows and the server's effective page + total. */
export function toListPage<T>(
  items: T[],
  opts: { page: number; pageSize: number; total: number },
): ListPage<T> {
  const pageSize = Math.max(1, Math.trunc(opts.pageSize));
  const total = Math.max(0, Math.trunc(opts.total));
  const totalPages = totalPagesFor(total, pageSize);
  const page = Math.min(Math.max(1, Math.trunc(opts.page)), totalPages);
  return {
    items,
    page,
    pageSize,
    total,
    totalPages,
    hasPrevious: page > 1,
    hasNext: page < totalPages,
  };
}

/**
 * "Showing 26–50 of 137 cycle counts · Page 2 of 6".
 * "Showing 0 cycle counts" when there are none (never "1–0").
 * The range is computed from the rows actually on the page, so a short last
 * page reads "Showing 126–137 of 137".
 */
export function formatListFooter(
  page: Pick<ListPage<unknown>, 'page' | 'pageSize' | 'total' | 'totalPages'> & { itemCount: number },
  noun: { one: string; other: string },
): string {
  const total = Math.max(0, Math.trunc(page.total));
  const count = Math.max(0, Math.trunc(page.itemCount));
  if (total === 0 || count === 0) {
    return `Showing 0 ${noun.other}`;
  }
  const from = (page.page - 1) * page.pageSize + 1;
  const to = from + count - 1;
  const label = total === 1 ? noun.one : noun.other;
  return `Showing ${from.toLocaleString('en-US')}–${to.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} ${label} · Page ${page.page.toLocaleString('en-US')} of ${page.totalPages.toLocaleString('en-US')}`;
}

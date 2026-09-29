import { parseBookReportQuery, serializeBookReportQuery } from '@stockpilot/core';

/**
 * A web link to Book Order Totals, as the phone's own route.
 *
 * /dashboard/reports/book-order-totals?<query> (a What's New CTA, a shared
 * link, a pasted URL, a cold-start deep link) opens the native report at
 * /reports/book-order-totals with ONLY the parameters core's
 * parseBookReportQuery accepts: range, from, to, status, warehouse,
 * category, q, sort and page. Anything else (the web drawer's view and
 * vpage, an unknown key, a malformed value) is dropped, and a malformed
 * value falls back to its default. `wview` is dropped too: it described the
 * WEB's warehouse view, so a warehouse the link names opens as an explicit
 * choice on the phone.
 *
 * Parsed by hand: React Native's URLSearchParams has no working get() (the
 * same reason web-path-rewrite.ts parses the maintenance link by hand).
 */

export const BOOK_REPORT_NATIVE_PATH = '/reports/book-order-totals';

/** A query string ('?a=1&b=2' or 'a=1&b=2') as a record: first value of
 *  each key wins, '+' reads as a space, an undecodable pair is skipped. */
export function queryStringRecord(query: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (query ?? '').replace(/^\?/, '').split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const rawKey = eq < 0 ? pair : pair.slice(0, eq);
    const rawValue = eq < 0 ? '' : pair.slice(eq + 1);
    let key: string;
    let value: string;
    try {
      key = decodeURIComponent(rawKey.replace(/\+/g, ' '));
      value = decodeURIComponent(rawValue.replace(/\+/g, ' '));
    } catch {
      continue;
    }
    if (!key || Object.prototype.hasOwnProperty.call(out, key)) continue;
    out[key] = value;
  }
  return out;
}

/** Set on the phone route when the link carried a filter core refused, so
 *  the screen says "Some filters in this link were not valid" as the web
 *  page does (the refused value itself is dropped before the screen sees
 *  it). */
export const BOOK_REPORT_LINK_RESET_KEY = 'reset';

/** The phone route for a record of link parameters (the cold-start shim
 *  reads them from the router). */
export function bookReportNativePathFromParams(
  params: Record<string, string | string[] | undefined | null>,
): string {
  const { query, invalid } = parseBookReportQuery(params);
  const qs = [
    serializeBookReportQuery({ ...query, warehouseFromView: false }),
    invalid.length > 0 ? `${BOOK_REPORT_LINK_RESET_KEY}=1` : '',
  ]
    .filter(Boolean)
    .join('&');
  return qs ? `${BOOK_REPORT_NATIVE_PATH}?${qs}` : BOOK_REPORT_NATIVE_PATH;
}

/** The phone route for a web link's query string. */
export function bookReportNativePath(query: string | null | undefined): string {
  return bookReportNativePathFromParams(queryStringRecord(query));
}

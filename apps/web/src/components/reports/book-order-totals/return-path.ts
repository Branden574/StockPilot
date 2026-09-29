import { safeReturnPath } from '@/lib/safe-return-path';

import { BOOK_REPORT_PATH } from './hrefs';

/**
 * THE ORDER PAGE'S WAY BACK TO BOOK ORDER TOTALS (plan D17).
 *
 * An order opened from the report's View orders drawer carries
 * `?return=<the report URL>`, and the order page offers "Back to Book Order
 * Totals" to it. `return` is user-controlled (anyone can hand someone a
 * link), so it is accepted only when BOTH hold:
 *
 *   1. the app's own rule, safeReturnPath: it decodes once and refuses
 *      schemes, `//`, a NUL and anything outside /dashboard/;
 *   2. the report's own path, exactly: `/dashboard/reports/book-order-totals`
 *      alone or followed by `?`. A path that merely starts with it
 *      (`...book-order-totals-evil`, `...book-order-totals/x`) is refused.
 *
 * Rule 2 is checked on the decoded value AND on the value as received, and
 * neither may hold a backslash, a control character or `//`.
 *
 * What is rendered is the value AS RECEIVED (Next has already decoded the
 * query string once), never safeReturnPath's output: decoding a second time
 * would turn a searched `a%26b` into `a&b` and send the reader back to a
 * different search. Rule 1 still judges the decoded form, so an encoded
 * escape cannot slip through.
 *
 * Anything refused, missing or repeated (`return` given twice) is null, and
 * the order page keeps its usual "Back to orders".
 */
export function bookReportReturnPath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const decoded = safeReturnPath(raw);
  if (decoded === null || !isReportHref(decoded)) return null;
  const received = raw.trim();
  if (!isReportHref(received)) return null;
  return received;
}

function isReportHref(value: string): boolean {
  if (value !== BOOK_REPORT_PATH && !value.startsWith(`${BOOK_REPORT_PATH}?`)) return false;
  // Control characters (\u0000-\u001f, \u007f) and backslashes are refused.
  if (/[\\\u0000-\u001f\u007f]/.test(value)) return false;
  return !value.includes('//');
}

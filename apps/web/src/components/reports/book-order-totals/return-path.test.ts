// Security invariant: the order page's "Back to Book Order Totals" (plan D17).
// `?return=` is user-controlled, so it is rendered only when it passes the
// app's safeReturnPath AND is exactly the report's own path; every
// open-redirect shape (another origin, a protocol-relative or backslash path,
// a scheme, an encoded escape, a look-alike path, a control character, a
// repeated key) falls back to the ordinary "Back to orders".
import { describe, expect, it } from 'vitest';

import { BOOK_REPORT_PATH } from './hrefs';
import { bookReportReturnPath } from './return-path';

const CH = '0e000000-0000-4000-8000-0000000000a1';
const ITEM = '0e000000-0000-4000-8000-000000000f01';

describe('bookReportReturnPath', () => {
  it.each([
    BOOK_REPORT_PATH,
    `${BOOK_REPORT_PATH}?charter=${CH}&range=custom&from=2026-09-01&to=2026-09-30&q=Outsiders&page=2&view=${ITEM}&vpage=2`,
    `${BOOK_REPORT_PATH}?warehouse=all`,
  ])('accepts the report itself: %s', (value) => {
    expect(bookReportReturnPath(value)).toBe(value);
  });

  it('renders the value as received, never decoded a second time (a searched "a&b" stays one search)', () => {
    // Next has already decoded the query string once: this is what the page
    // reads for a link whose report URL had q=a%26b.
    const value = `${BOOK_REPORT_PATH}?q=a%26b&view=${ITEM}`;
    expect(bookReportReturnPath(value)).toBe(value);
  });

  it('trims surrounding whitespace', () => {
    expect(bookReportReturnPath(`  ${BOOK_REPORT_PATH}?page=2\n`)).toBe(
      `${BOOK_REPORT_PATH}?page=2`,
    );
  });

  it.each([
    ['protocol-relative', '//evil.com'],
    ['protocol-relative to the report path', '//evil.com/dashboard/reports/book-order-totals'],
    ['another origin', 'https://evil.com/dashboard/reports/book-order-totals'],
    ['another origin, http', 'http://evil.com/dashboard/reports/book-order-totals?x=1'],
    ['a look-alike path', '/dashboard/reports/book-order-totals-evil'],
    ['a sub-path', '/dashboard/reports/book-order-totals/x'],
    ['a double slash inside', '/dashboard/reports/book-order-totals//x'],
    ['a double slash in the query', '/dashboard/reports/book-order-totals?next=//evil.com'],
    ['an encoded double slash', '%2F%2Fevil.com'],
    [
      'an encoded double slash in the query',
      '/dashboard/reports/book-order-totals?x=%2F%2Fevil.com',
    ],
    ['an encoded report path', '%2Fdashboard%2Freports%2Fbook-order-totals'],
    ['javascript:', 'javascript:alert(1)'],
    ['JAVASCRIPT: with the report path', 'JAVASCRIPT:/dashboard/reports/book-order-totals'],
    ['data:', 'data:text/html,<script>x</script>'],
    ['a backslash', '/dashboard/reports/book-order-totals?x=\\\\evil.com'],
    ['a leading backslash path', '/\\evil.com/dashboard/reports/book-order-totals'],
    ['a NUL', '/dashboard/reports/book-order-totals?\u0000'],
    ['an encoded CR LF', '/dashboard/reports/book-order-totals?x=%0d%0aSet-Cookie:a'],
    ['a raw tab inside', '/dashboard/reports/book-order-totals?x=\ty'],
    ['a fragment', '/dashboard/reports/book-order-totals#top'],
    ['a valid dashboard path that is not the report', '/dashboard/orders'],
    ['another report', '/dashboard/reports/inventory-valuation'],
    ['outside the dashboard', '/api/v1/reports/book-order-totals'],
    ['a malformed escape', '/dashboard/reports/book-order-totals?q=%E0%A4%A'],
    ['overlong', `/dashboard/reports/book-order-totals?q=${'x'.repeat(2100)}`],
    ['empty', ''],
  ])('refuses %s', (_what, value) => {
    expect(bookReportReturnPath(value)).toBeNull();
  });

  it.each([
    ['missing', undefined],
    ['null', null],
    ['repeated (return given twice)', [BOOK_REPORT_PATH, '//evil.com']],
    ['a number', 7],
  ])('refuses a value that is %s', (_what, value) => {
    expect(bookReportReturnPath(value)).toBeNull();
  });
});

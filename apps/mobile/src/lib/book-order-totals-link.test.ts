import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { W1 } from './__fixtures__/book-order-totals';
import { bookReportNativePath, bookReportNativePathFromParams, queryStringRecord } from './book-order-totals-link';
import { rewriteWebPath } from './web-path-rewrite';

/**
 * Web links to Book Order Totals land on the native report (a What's New
 * CTA, a shared link, a pasted URL, a push), with only the filters core
 * accepts. Before this, /dashboard/reports/* fell through the catch-all to
 * home.
 */

describe('rewriteWebPath: Book Order Totals', () => {
  it('the bare report opens the native report', () => {
    expect(rewriteWebPath('/dashboard/reports/book-order-totals')).toBe('/reports/book-order-totals');
  });

  it('its filters ride along, in canonical order', () => {
    expect(
      rewriteWebPath(`/dashboard/reports/book-order-totals?sort=title&range=30d&warehouse=${W1}&q=the%20hobbit&page=2`),
    ).toBe(`/reports/book-order-totals?range=30d&warehouse=${W1}&q=the%20hobbit&sort=title&page=2`);
  });

  it("unknown parameters, the web drawer's keys and the web's view label are dropped", () => {
    expect(
      rewriteWebPath(`/dashboard/reports/book-order-totals?warehouse=${W1}&wview=1&view=abc&vpage=3&utm=x`),
    ).toBe(`/reports/book-order-totals?warehouse=${W1}`);
  });

  it('a malformed value falls back to its default rather than riding along', () => {
    expect(rewriteWebPath('/dashboard/reports/book-order-totals?range=forever&status=nope&page=-1')).toBe(
      '/reports/book-order-totals',
    );
    expect(rewriteWebPath('/dashboard/reports/book-order-totals?warehouse=%E0%A4%A')).toBe(
      '/reports/book-order-totals',
    );
  });

  it('status groups and a custom range survive', () => {
    expect(
      rewriteWebPath(
        '/dashboard/reports/book-order-totals?range=custom&from=2026-09-01&to=2026-09-28&status=awaiting,denied,cancelled',
      ),
    ).toBe(
      '/reports/book-order-totals?range=custom&from=2026-09-01&to=2026-09-28&status=awaiting%2Cdenied%2Ccancelled',
    );
  });

  it('the Reports hub opens the shared Reports screen', () => {
    expect(rewriteWebPath('/dashboard/reports')).toBe('/reports');
    expect(rewriteWebPath('/dashboard/reports?tab=x')).toBe('/reports');
  });

  it('other report pages have no native twin and still go home (unchanged)', () => {
    expect(rewriteWebPath('/dashboard/reports/stock-movements')).toBe('/');
    expect(rewriteWebPath('/dashboard/reports/book-order-totals/extra')).toBe('/');
  });

  it('existing rules are untouched', () => {
    expect(rewriteWebPath('/dashboard/orders/11111111-1111-4111-8111-111111111111')).toBe(
      '/order/11111111-1111-4111-8111-111111111111',
    );
    expect(rewriteWebPath('/dashboard/some-new-page')).toBe('/');
  });
});

describe('the link helpers', () => {
  it('reads a query string by hand: first value wins, + is a space, bad escapes are skipped', () => {
    expect(queryStringRecord('?q=a+b&q=second&x=%E0%A4%A&=v&flag')).toEqual({ q: 'a b', flag: '' });
  });
  it('the cold-start shim and the rewrite build the same route', () => {
    expect(bookReportNativePathFromParams({ range: 'year', warehouse: 'all', wview: '1' })).toBe(
      bookReportNativePath('range=year&warehouse=all&wview=1'),
    );
  });
});

describe('the cold-start shim is a real route', () => {
  it('app/dashboard/reports/book-order-totals.tsx redirects through the same helper', () => {
    const src = readFileSync(
      path.resolve(__dirname, '../../app/dashboard/reports/book-order-totals.tsx'),
      'utf8',
    );
    expect(src).toContain('<Redirect href={bookReportNativePathFromParams(params) as Href} />');
  });
});

import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { W1 } from './__fixtures__/book-order-totals';
import { bookReportNativePath, bookReportNativePathFromParams, queryStringRecord } from './book-order-totals-link';
import { bookReportQueryFromParams } from './book-order-totals-view';
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

  it('a malformed value falls back to its default rather than riding along, and the screen is told (reset=1)', () => {
    expect(rewriteWebPath('/dashboard/reports/book-order-totals?range=forever&status=nope&page=-1')).toBe(
      '/reports/book-order-totals?reset=1',
    );
    expect(rewriteWebPath('/dashboard/reports/book-order-totals?sort=bogus&warehouse=all')).toBe(
      '/reports/book-order-totals?warehouse=all&reset=1',
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

  it('a charter and date-only dates ride along: the brief\'s link opens that charter and custom range', () => {
    const CH = '0A0A0A0A-0000-4000-8000-00000000000A';
    expect(
      rewriteWebPath(`/dashboard/reports/book-order-totals?charter=${CH}&from=2026-09-01&to=2026-09-30&page=1`),
    ).toBe(`/reports/book-order-totals?charter=${CH.toLowerCase()}&range=custom&from=2026-09-01&to=2026-09-30`);
    expect(rewriteWebPath('/dashboard/reports/book-order-totals?charter=none&range=week')).toBe(
      '/reports/book-order-totals?charter=none&range=week',
    );
    const { query, invalid } = bookReportQueryFromParams(
      queryStringRecord(`charter=${CH}&from=2026-09-01&to=2026-09-30`),
    );
    expect(invalid).toEqual([]);
    expect(query).toMatchObject({ charter: CH.toLowerCase(), range: 'custom', from: '2026-09-01', to: '2026-09-30' });
  });

  it('a malformed charter or date-only range is dropped and the screen is told (reset=1)', () => {
    expect(rewriteWebPath('/dashboard/reports/book-order-totals?charter=marconi&warehouse=all')).toBe(
      '/reports/book-order-totals?warehouse=all&reset=1',
    );
    expect(rewriteWebPath('/dashboard/reports/book-order-totals?from=2026-09-30&to=2026-09-01')).toBe(
      '/reports/book-order-totals?reset=1',
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

describe('a link whose filters were reset says so on the phone, as the web page does', () => {
  it('the rewritten route reads as reset; a clean link does not', () => {
    const reset = bookReportNativePathFromParams({ sort: 'bogus', warehouse: 'all' });
    const params = queryStringRecord(reset.split('?')[1]);
    expect(bookReportQueryFromParams(params).invalid.length).toBeGreaterThan(0);
    expect(bookReportQueryFromParams(params).query.warehouse).toBe('all');
    const clean = bookReportNativePathFromParams({ sort: 'title', warehouse: 'all' });
    expect(clean).not.toContain('reset');
    expect(bookReportQueryFromParams(queryStringRecord(clean.split('?')[1])).invalid).toEqual([]);
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

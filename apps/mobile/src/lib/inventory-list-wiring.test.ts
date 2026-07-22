import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * WIRING PINS for the two grouped list screens. The load functions and the
 * card layouts live inline in the screens, which the vitest config deliberately
 * excludes from compilation (they import native modules at top level), so the
 * pure seams are tested in inventory-paging.ts / inventory-grouping.ts /
 * expected-items.ts and these source-level assertions pin the load-bearing
 * WIRING to them.
 *
 * REWRITTEN for group-aware pagination. The previous version pinned the
 * per-SKU COUNT read (`countPlacementsBySku` / `datasetSpansMoreRows`) that
 * decided which collapsed headers wore a "≥" marker, and before that the page
 * ANCHORING merge. Both are gone: the lists fetch the whole filtered set in
 * one request and paginate over GROUPS, so a family is never split and no
 * marker is needed. Every pin below still corresponds to a way a collapsed
 * header stopped being a faithful summary of the rows it expands to.
 */

const read = (rel: string): string => readFileSync(path.resolve(__dirname, rel), 'utf8');

const books = read('../../app/(drawer)/(tabs)/books.tsx');
const inventory = read('../../app/(drawer)/(tabs)/inventory.tsx');
const screens: Array<[string, string]> = [
  ['books', books],
  ['inventory', inventory],
];

/** The body of the screen's `load` callback — everything a fetch does. */
const loadBody = (src: string): string => {
  const start = src.indexOf('const load = React.useCallback(');
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf('React.useEffect(', start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
};

/** The body of the effect that resets view state on a new result set. */
const resetEffect = (src: string): string => {
  const m = /React\.useEffect\(\(\) => \{\s*setPage\(1\);([\s\S]*?)\}, \[q, filter, activeWarehouseId\]\);/.exec(
    src,
  );
  expect(m).not.toBeNull();
  return m![1]!;
};

/** The body of the page-flip handler. */
const pageFlipBody = (src: string): string => {
  const m = /const onPageChange = React\.useCallback\(\(p: number\) => \{([\s\S]*?)\n  \}, \[\]\);/.exec(
    src,
  );
  expect(m).not.toBeNull();
  return m![1]!;
};

describe('both lists — the thumbnail cache is invalidated by a LOAD, never frozen', () => {
  for (const [name, src] of screens) {
    it(`${name}: a new load drops the resolved-image map`, () => {
      // The per-page `images` cache caches a read of item_images, INCLUDING the
      // null "resolved, no image" entry. Never invalidating it froze the first
      // answer for the life of the screen, so a cover photo added or replaced
      // in the app never appeared again that session — pull-to-refresh stopped
      // re-reading item_images, which the old per-load fetch did every time.
      // `load` is the one funnel for pull-to-refresh AND every query / filter /
      // warehouse change, so clearing there covers both.
      expect(loadBody(src)).toContain('setImages(new Map())');
    });

    it(`${name}: a PAGE FLIP does not, so cross-page caching survives`, () => {
      // The whole point of the cache: flipping between pages must not re-sign
      // every URL. Invalidate on a new LOAD, not on every page flip.
      expect(pageFlipBody(src)).not.toContain('setImages');
    });

    it(`${name}: pull-to-refresh goes through load, so it inherits the invalidation`, () => {
      expect(src).toMatch(/setRefreshing\(true\);\s*\n\s*await (?:void )?load\(/);
    });
  }
});

describe('both lists — a new result set drops stale expansions', () => {
  for (const [name, src] of screens) {
    it(`${name}: clears expanded SKU groups on a query / filter / warehouse change`, () => {
      // books.tsx has always done this; inventory.tsx did not, so the same
      // helper behaved two ways on the two screens the owner compares directly.
      expect(resetEffect(src)).toContain('setExpandedSkuGroups(new Set())');
    });
  }
});

describe('items list — the truncation disclosure compares like with like', () => {
  it('quotes the rows the SERVER returned, not the post-low-filter row count', () => {
    // `items.length` is narrowed by the client-side 'low' pass while the exact
    // count is over the pre-'low' predicate set, so dividing one by the other
    // stated a ratio between two different populations.
    expect(inventory).toContain('const [loadedRowCount, setLoadedRowCount]');
    expect(inventory).toContain('setLoadedRowCount(returned);');
    expect(inventory).toContain(
      '`Showing the first ${loadedRowCount.toLocaleString()} of ${(serverRowCount ?? loadedRowCount).toLocaleString()} items.',
    );
    expect(inventory).not.toContain('`Showing the first ${items.length.toLocaleString()}');
  });

  it('does not let the eyebrow and the paginator quote different totals', () => {
    // The exact server count describes the pre-'low' population; adopting it
    // for the eyebrow under the LOW view put a different total on screen from
    // the one the paginator prints for the very same rows.
    expect(inventory).toContain("truncated && filter.status !== 'low'");
  });
});

describe('both lists — fetch the WHOLE filtered set, then page over GROUPS', () => {
  for (const [name, src] of screens) {
    it(`${name}: one request per filter change, capped at the server's row cap`, () => {
      // Server paging (.range) was the ONLY reason a SKU family could straddle
      // a page boundary, against datasets of 111 / 257 rows.
      expect(src).toContain('.limit(POSTGREST_MAX_ROWS)');
      expect(src).not.toContain('.range(start, end)');
      expect(src).not.toContain('const PAGE_SIZE');
    });

    it(`${name}: groups the whole set FIRST, then slices pages of groups`, () => {
      expect(src).toContain('buildGroupUnits(');
      expect(src).toContain('paginateGroups(units, { page, groupsPerPage: GROUPS_PER_PAGE })');
      // And the rendered grouping runs over the PAGE's rows, which by
      // construction hold every member of every group on that page.
      expect(src).toMatch(/buildGroupedRows<\w+>\(pageRows, \{/);
    });

    it(`${name}: a page flip costs no fetch, so no skeleton is faked`, () => {
      // The row read is keyed on query/filter/warehouse only; `page` slices
      // what is already in memory.
      expect(src).not.toMatch(/setLoading\(true\);\s*\n\s*setPage\(p\)/);
    });

    it(`${name}: the paginator describes what the page ACTUALLY renders`, () => {
      // Pages hold a variable number of rows once groups are kept whole, so
      // `page × pageSize` would over-claim on a short page and under-claim on
      // one that ran long to keep a family together.
      expect(src).toContain('pageCount={pageView.pageCount}');
      expect(src).toContain('rangeStart={pageView.rangeStart}');
      expect(src).toContain('rangeEnd={pageView.rangeEnd}');
      expect(src).toContain('total={pageView.totalRows}');
      expect(src).not.toContain('pageSize={PAGE_SIZE}');
    });

    it(`${name}: detects truncation from the RESPONSE and discloses it`, () => {
      // A guard against a hard-coded ceiling LARGER than db.max_rows can never
      // fire — a previous round shipped one comparing against 2000 while the
      // real cap was 1000.
      expect(src).toContain('readIsComplete({ returned, serverCount: count ?? null');
      expect(src).toContain('limit: POSTGREST_MAX_ROWS');
      expect(src).not.toContain('FAMILY_READ_LIMIT');
      expect(src).not.toContain('SKU_TOTALS_LIMIT');
      // Disclosed above the list, not only on the headers.
      expect(src).toContain('{truncated ? (');
      expect(src).toContain('datasetIsTruncated: truncated,');
    });

    it(`${name}: the superseded page-repair mechanisms are gone`, () => {
      // ANCHORING left pages ragged (a page rendering empty under a paginator
      // that offered it); the per-SKU COUNT read marked headers instead of
      // keeping families whole, which is what the owner rejected.
      for (const dead of [
        'mergeAnchoredFamilies',
        'AnchorableRow',
        'countPlacementsBySku',
        'datasetSpansMoreRows',
        'familyCounts',
        'datasetIsPaged',
        'SKU_COUNT_QUERY_CAP',
      ]) {
        expect(src).not.toContain(dead);
      }
    });

    it(`${name}: keeps the projection lean and the thumbnails page-scoped`, () => {
      // The set read can return up to 1000 rows and a transformed signed URL
      // costs one storage request PER PATH, so signing the whole set would
      // trade a saved page fetch for hundreds of calls.
      expect(src).toContain('signItemImages(paths, THUMB_TRANSFORM)');
      expect(src).toContain('.in(\'item_id\', unresolvedIds)');
    });
  }
});

describe('books list — a header agrees with the rows it expands to', () => {
  it('names the eyebrow count after what it actually counts', () => {
    // The count counts inventory_items ROWS, and under Model B one title is one
    // row per charter/rack — "N BOOKS" claimed a title count the grouped list
    // on screen contradicts.
    expect(books).not.toContain('BOOKS`}</Eyebrow>');
    expect(books).toContain('PLACEMENTS`}</Eyebrow>');
  });

  it('takes the EXPECTED pill from the rows, never from the filter state', () => {
    expect(books).toContain('expected={row.expected}');
    expect(books).not.toContain("expected={filter.status === 'expected'}");
  });

  it('runs the SAME pill ladder on the header as on the rows', () => {
    // A local header ladder that handled lifecycle while the row pill did not
    // put ARCHIVED headers over OUT rows.
    expect(books).not.toContain('function bookGroupPill');
    expect(books).toContain('stockPill({');
    expect(books).toContain('stockPillFor(book)');
  });

  it('reserves the same trailing slot on the header and on the rows', () => {
    // The chevron used to push the header's quantity/pill column ~32px left
    // of the same column on the rows beneath it.
    expect(books).toContain('const TRAILING_SLOT = 22;');
    expect((books.match(/width: TRAILING_SLOT/g) ?? []).length).toBe(2);
  });
});

describe('items list — identical behaviour to books, because the owner compares them', () => {
  it('names the eyebrow count after what it actually counts', () => {
    // It said "SKUS" over a ROW count — under Model B a different, smaller
    // number than the one printed.
    expect(inventory).not.toContain('SKUS`}</Eyebrow>');
    expect(inventory).toContain('ITEMS`}</Eyebrow>');
  });

  it('runs the count read through the SAME predicate builder as the row read', () => {
    // One `scoped` builder owns every predicate, and the location pre-query is
    // resolved once, above it, so the rows and their exact count can never
    // answer different questions.
    expect(inventory).toContain('const scoped = <Q extends string>(');
    expect(inventory).toContain("scoped(ITEM_COLUMNS, { count: 'exact' })");
  });

  it('renders the partial marker on a collapsed header (overflow case only)', () => {
    expect(inventory).toContain('partial={row.partial}');
    expect(inventory).toContain('{partial ? `≥${total}` : total}');
  });

  it('takes the EXPECTED pill from the rows, never from the filter state', () => {
    // View state flips the instant the filter is tapped while the rows lag a
    // 250ms debounce plus a fetch behind it.
    expect(inventory).toContain('expected={row.expected}');
    expect(inventory).not.toContain("expected={filter.status === 'expected'}");
  });

  it('runs the SAME pill ladder on the header as on the rows (and as Books)', () => {
    // A local Items-only ladder is a drift path between the two platforms.
    expect(inventory).not.toContain('function skuHeaderStatus');
    expect(inventory).toContain('stockPill({ expected, lifecycle, quantity: total, reorderPoint })');
    expect(inventory).toContain('stockPillFor(item)');
  });
});

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
      // The set read can return up to 1000 rows. Thumbnails are resolved for
      // the VISIBLE PAGE only: stored thumbnails sign in one batch, but a photo
      // without one still costs a storage request (and a billed transform) PER
      // PATH, so signing the whole set would trade a saved page fetch for
      // hundreds of calls.
      expect(src).not.toContain('THUMB_TRANSFORM'); // the screens never ask for the transform themselves
      // Page-scoped (unresolvedIds, never the whole set), batched through the
      // shared reader, and resolved through resolveListThumbnails, which
      // records nothing when the read or the signing fails.
      expect(src).toMatch(
        /resolveListThumbnails\(\s*unresolvedIds,\s*\(ids\) => readPrimaryPhotos\(supabase, orgId, ids\),\s*signListThumbnails,\s*\)/,
      );
      expect(src).toContain('setImages(round.value)');
      expect(src).not.toContain(".from('item_images')");
    });

    it(`${name}: a failed photo round is logged and records nothing`, () => {
      // It used to ignore the read's error and write null ("no photo") for
      // every id on the page until the next full load.
      const m = /if \(!round\.ok\) \{\s*console\.warn\([^)]*\);\s*return;\s*\}/.exec(src);
      expect(m).not.toBeNull();
      expect(src).not.toMatch(/next\.set\(id, \(p \? urlByPath\.get\(p\.storage_path\) : null\) \?\? null\)/);
    });
  }
});

describe('books list — a header agrees with the rows it expands to', () => {
  it('names the eyebrow count after what it actually counts', () => {
    // The count counts inventory_items ROWS, and under Model B one title is one
    // row per charter/rack — "N BOOKS" claimed a title count the grouped list
    // on screen contradicts.
    expect(books).not.toMatch(/BOOKS`\}\s*<\/Eyebrow>/);
    expect(books).toMatch(/PLACEMENTS`\}\s*<\/Eyebrow>/);
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
    expect(inventory).not.toMatch(/SKUS`\}\s*<\/Eyebrow>/);
    expect(inventory).toMatch(/ITEMS`\}\s*<\/Eyebrow>/);
  });

  it('runs the count read through the SAME predicate builder as the row read', () => {
    // One `scoped` builder owns every predicate (the location filter included),
    // so the rows and their exact count can never answer different questions.
    expect(inventory).toContain('const scoped = <Q extends string>(');
    expect(inventory).toContain("scoped(columns, { count: 'exact' })");
    expect(inventory).toContain('await listRead(ITEM_COLUMNS_AT_LOCATIONS)');
    expect(inventory).toContain('await listRead(ITEM_COLUMNS)');
  });

  it('filters by location through an inner stock-levels embed, never an id list in the URL', () => {
    // The two-step read (item_stock_levels, then `.in('id', placedItemIds)`)
    // put up to 1000 uuids in the list read's URL, which failed past about 215
    // locally, and its first read ignored its error, so a failure became the
    // zero-uuid sentinel and a silent "No items match.".
    const body = loadBody(inventory);
    expect(inventory).toMatch(/item_stock_levels!inner\(location_id\)` as const;/);
    expect(body).toContain(".in('item_stock_levels.location_id', f.locationIds)");
    expect(body).toContain(".gt('item_stock_levels.quantity', 0)");
    expect(body).not.toContain('placedItemIds');
    expect(body).not.toContain('00000000-0000-0000-0000-000000000000');
    expect(body).not.toContain(".from('item_stock_levels')");
    // Only the newest load writes: an older debounced load finishing late
    // cannot put back its rows or its error over a newer answer.
    expect(body).toMatch(/const seq = \(loadSeq\.current \+= 1\);/);
    expect(body).toMatch(/: await listRead\(ITEM_COLUMNS\);\s*if \(seq !== loadSeq\.current\) return;/);
    // One read, so its error takes the visible banner path, with a message
    // that is never empty (an empty one would hide the banner).
    expect(body).toContain('setLoadError(readErrorMessage(error, listStatus))');
    expect(inventory).toMatch(/\{loadError !== null \? \(\s*<Body[^>]*>\s*\{`Could not load items: /);
  });

  it('derives the location-filter columns from ITEM_COLUMNS, so the two cannot drift', () => {
    // It was a hand copy of ITEM_COLUMNS plus the embed: a column added to one
    // and not the other came back undefined, and only while a location filter
    // was on.
    expect(inventory).toMatch(
      /const ITEM_COLUMNS_AT_LOCATIONS = `\$\{ITEM_COLUMNS\},\s*item_stock_levels!inner\(location_id\)` as const;/,
    );
    expect(inventory.match(/product_group:product_groups!group_id \(default_counting_unit\)/g)).toHaveLength(1);
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

describe('books list — a failed read says so, never passes for an empty or current shelf', () => {
  it('reads rack holdings batched through the shared reader, and a failure sets a visible notice', () => {
    // The holdings read put every loaded id (up to 1000) in one `.in()` URL,
    // and its error was only logged: the cards silently fell back to the
    // stored custom_fields rack label, which can be out of date.
    const body = loadBody(books);
    expect(body).toContain('settleIdBatchRead(readRackHoldings(supabase, orgId, ids))');
    expect(body).toMatch(
      /if \(holdingsRead\.ok\) \{\s*setHoldings\(holdingsRead\.value\);\s*\} else \{[\s\S]*?setHoldings\(new Map\(\)\);\s*setHoldingsError\(holdingsRead\.message\);/,
    );
    expect(body).not.toContain(".from('item_stock_levels')");
    expect(books).toContain(
      "Rack locations did not load, so a book's rack label may be out of date. Pull down to try again.",
    );
    expect(books).toMatch(/\{holdingsError \? \(/);
  });

  it('a refused list read shows an error, not "No books match."', () => {
    const body = loadBody(books);
    // Never an empty message: an empty gateway error body would otherwise
    // hide the notice behind a truthiness test.
    expect(body).toMatch(
      /if \(error\) \{\s*console\.warn\('books list', error\);\s*setLoadError\(readErrorMessage\(error, listStatus\)\);/,
    );
    expect(books).toContain('`Could not load books: ${loadError}. Pull to retry.`');
    expect(books).toMatch(/\{loadError !== null \? \(/);
  });

  it('every load starts with its error flags cleared, and only the newest load writes', () => {
    const body = loadBody(books);
    const firstAwait = body.indexOf('await ');
    const clears = body.slice(0, firstAwait);
    expect(clears).toContain('setLoadError(null);');
    expect(clears).toContain('setHoldingsError(null);');
    // Two awaits (the list, the holdings), each followed by the token check.
    expect(body.match(/if \(!isCurrent\(\)\) return;/g)?.length).toBe(2);
  });
});

/**
 * The JSX of the list's `ListEmptyComponent` prop, found by matching its
 * braces (the copy inside has none), with its comments stripped: a comment
 * may quote the copy it explains.
 */
const emptyComponent = (src: string): string => {
  const open = src.indexOf('ListEmptyComponent={');
  expect(open, 'ListEmptyComponent not found').toBeGreaterThan(-1);
  let depth = 0;
  for (let i = open + 'ListEmptyComponent='.length; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1).replace(/\/\*[\s\S]*?\*\//g, '');
    }
  }
  throw new Error('ListEmptyComponent is not closed');
};

describe('both lists — a failed read is never "no results" or a zero count', () => {
  const cases: {
    name: string;
    src: string;
    failed: string;
    noResults: string;
    eyebrow: RegExp;
  }[] = [
    {
      name: 'books',
      src: books,
      failed: 'Books did not load.',
      noResults: 'No books match.',
      eyebrow: /\{loadError !== null\s*\? 'INVENTORY · PLACEMENTS'\s*: `INVENTORY · \$\{datasetRowCount\.toLocaleString\(\)\} PLACEMENTS`\}/,
    },
    {
      name: 'inventory',
      src: inventory,
      failed: 'Items did not load.',
      noResults: 'No items match.',
      eyebrow: /\{loadError !== null\s*\? 'INVENTORY · ITEMS'\s*: `INVENTORY · \$\{datasetRowCount\.toLocaleString\(\)\} ITEMS`\}/,
    },
  ];

  for (const { name, src, failed, noResults, eyebrow } of cases) {
    it(`${name}: the empty state says the read failed, not "${noResults}"`, () => {
      // A failed read leaves no rows, so the list's empty state rendered
      // "${noResults}" right under the failure notice, contradicting it.
      const empty = emptyComponent(src);
      const check = empty.indexOf('loadError !== null ?');
      expect(check, 'the empty state must switch on the failed read').toBeGreaterThan(-1);
      expect(empty.indexOf(failed)).toBeGreaterThan(check);
      expect(empty.indexOf(noResults)).toBeGreaterThan(empty.indexOf(failed));
      expect(empty).toContain('Pull down to try again.');
    });

    it(`${name}: the eyebrow quotes no count for a read that failed`, () => {
      // It said "INVENTORY · 0 …" over a failed load.
      expect(src).toMatch(eyebrow);
    });
  }

  it('inventory: a failed read never shows the tour ghost row either', () => {
    // The ghost stands in for a genuinely empty org; a failed read is not one.
    const empty = emptyComponent(inventory);
    expect(empty.indexOf('loadError !== null ?')).toBeGreaterThan(-1);
    expect(empty.indexOf('loadError !== null ?')).toBeLessThan(empty.indexOf('tourActive &&'));
  });
});

import { describe, expect, it } from 'vitest';

import {
  GROUPS_PER_PAGE,
  POSTGREST_MAX_ROWS,
  paginateGroups,
  readIsComplete,
} from './inventory-paging';

import { buildGroupUnits, buildGroupedRows, type GroupableItem, type GroupedRow } from './inventory-grouping';

/**
 * REWRITTEN TWICE OVER, and both predecessors are named here so neither is
 * re-attempted.
 *
 * 1. The first version of this file covered `mergeAnchoredFamilies` — page
 *    ANCHORING. Those tests passed while the SCREEN went wrong, because they
 *    only ever looked at one page's rows in isolation: the row window, the page
 *    count and "SHOWING x–y OF n" all came from the server range + exact count,
 *    which knew nothing about rows the client dropped, so a later page could
 *    render a handful of cards or none at all under "No books match." while the
 *    paginator still offered it.
 * 2. The second covered `countPlacementsBySku` / `datasetSpansMoreRows` — the
 *    per-GROUP "≥" marker: page a 50-row window, group what the page holds, and
 *    mark a header whose family straddles the boundary. Every figure was
 *    defensible and the owner rejected it anyway, correctly: a title split
 *    across a page boundary — marked header on page 1, lone plain row on page 2
 *    — is exactly the confusion grouping exists to remove. Marking a split is
 *    not the same as not splitting. Those helpers are gone with the mechanism;
 *    what replaced them is asserted below.
 *
 * The guarantee now is structural: the GROUP is the unit of pagination, so a
 * family cannot be split, so nothing needs marking. The tests are written
 * against that property (and against every page size and ordering, because the
 * field bug appeared only under particular sorts).
 */

const item = (o: { id: string; sku: string; qty?: number; name?: string }): GroupableItem => ({
  id: o.id,
  name: o.name ?? o.sku,
  sku: o.sku,
  quantity_on_hand: o.qty ?? 0,
  reorder_point: 0,
  status: 'active',
  charter_id: null,
  primary_location_id: null,
  awaiting_first_receipt: false,
});

const BOOKS = {
  expandedSizeRuns: new Set<string>(),
  expandedSkuGroups: new Set<string>(),
  enableSizeRuns: false,
} as const;

const skuHeaders = (rows: GroupedRow<GroupableItem>[]) =>
  rows.filter((r) => r.kind === 'sku-header') as Extract<
    GroupedRow<GroupableItem>,
    { kind: 'sku-header' }
  >[];

/** The field case: "Into Algebra 1" has 3 placements on 3 different racks, and
 *  the list sorts by updated_at / name / quantity — never by sku — so they land
 *  scattered through the set with nothing adjacent about them. */
const scattered: GroupableItem[] = [
  item({ id: 'x1', sku: 'OTHER-1', qty: 1 }),
  item({ id: 'a', sku: 'ALG1', name: 'Into Algebra 1', qty: 4 }),
  item({ id: 'x2', sku: 'OTHER-2', qty: 1 }),
  item({ id: 'x3', sku: 'OTHER-3', qty: 1 }),
  item({ id: 'x4', sku: 'OTHER-4', qty: 1 }),
  item({ id: 'b', sku: 'ALG1', name: 'Into Algebra 1', qty: 6 }),
  item({ id: 'x5', sku: 'OTHER-5', qty: 1 }),
  item({ id: 'x6', sku: 'OTHER-6', qty: 1 }),
  item({ id: 'c', sku: 'ALG1', name: 'Into Algebra 1', qty: 2 }),
  item({ id: 'x7', sku: 'OTHER-7', qty: 1 }),
];

describe('THE HEADLINE GUARANTEE — a SKU with three placements is one header on one page', () => {
  // Every page size from "one group per page" up to "everything on one page",
  // because the owner's report ("2 on one page and the third isn't grouped")
  // was a boundary landing between siblings, and a boundary can land anywhere.
  for (const groupsPerPage of [1, 2, 3, 4, 5, 8, 50]) {
    it(`holds the whole family on exactly one page at ${groupsPerPage} groups/page`, () => {
      const units = buildGroupUnits(scattered, { enableSizeRuns: false });
      const pageCount = paginateGroups(units, { page: 1, groupsPerPage }).pageCount;

      const pagesWithFamily: number[] = [];
      for (let p = 1; p <= pageCount; p++) {
        const view = paginateGroups(units, { page: p, groupsPerPage });
        const rows = buildGroupedRows(view.pageItems, BOOKS);
        const alg = skuHeaders(rows).filter((h) => h.sku === 'ALG1');
        // No page may show a LONE placement of a multi-placement SKU as a
        // plain row either — that is the "third isn't grouped" half.
        const plainAlgRows = rows.filter((r) => r.kind === 'row' && r.item.sku === 'ALG1');
        if (alg.length === 0) {
          expect(plainAlgRows).toHaveLength(0);
          continue;
        }
        pagesWithFamily.push(p);
        expect(alg).toHaveLength(1);
        expect(alg[0]!.placementCount).toBe(3);
        expect(alg[0]!.total).toBe(12);
        // Complete, so it must NOT wear the partial marker.
        expect(alg[0]!.partial).toBe(false);
      }
      expect(pagesWithFamily).toHaveLength(1);
    });
  }

  it('reveals all three placements under the one chevron', () => {
    const units = buildGroupUnits(scattered, { enableSizeRuns: false });
    const view = paginateGroups(units, { page: 1, groupsPerPage: 50 });
    const rows = buildGroupedRows(view.pageItems, {
      ...BOOKS,
      expandedSkuGroups: new Set(['ALG1']),
    });
    const revealed = rows.filter((r) => r.kind === 'row' && r.item.sku === 'ALG1');
    expect(revealed.map((r) => (r.kind === 'row' ? r.item.id : ''))).toEqual(['a', 'b', 'c']);
  });

  it('holds regardless of SORT — the family clusters wherever its first row ranks', () => {
    // Four orderings standing in for updated_at asc/desc and quantity asc/desc.
    const orderings: GroupableItem[][] = [
      scattered,
      [...scattered].reverse(),
      [...scattered].sort((a, b) => a.quantity_on_hand - b.quantity_on_hand),
      [...scattered].sort((a, b) => b.quantity_on_hand - a.quantity_on_hand),
    ];
    for (const rowsIn of orderings) {
      const units = buildGroupUnits(rowsIn, { enableSizeRuns: false });
      const family = units.filter((u) => u.some((r) => r.sku === 'ALG1'));
      expect(family).toHaveLength(1);
      expect(family[0]).toHaveLength(3);
      for (const groupsPerPage of [1, 2, 3, 7]) {
        const pageCount = paginateGroups(units, { page: 1, groupsPerPage }).pageCount;
        const hit: number[] = [];
        for (let p = 1; p <= pageCount; p++) {
          const view = paginateGroups(units, { page: p, groupsPerPage });
          const n = view.pageItems.filter((r) => r.sku === 'ALG1').length;
          if (n > 0) hit.push(n);
        }
        expect(hit).toEqual([3]);
      }
    }
  });

  it('a SKU with a SINGLE record is still a plain row — no header, no chevron', () => {
    const units = buildGroupUnits(scattered, { enableSizeRuns: false });
    const rows = buildGroupedRows(
      paginateGroups(units, { page: 1, groupsPerPage: 50 }).pageItems,
      BOOKS,
    );
    const solo = rows.find((r) => r.kind === 'row' && r.item.id === 'x1');
    expect(solo).toBeDefined();
    expect(skuHeaders(rows).map((h) => h.sku)).toEqual(['ALG1']);
  });
});

describe('paginateGroups — no row is moved, dropped or duplicated', () => {
  it('every row renders exactly once across the pages', () => {
    const units = buildGroupUnits(scattered, { enableSizeRuns: false });
    for (const groupsPerPage of [1, 2, 3, 4, 50]) {
      const pageCount = paginateGroups(units, { page: 1, groupsPerPage }).pageCount;
      const seen: string[] = [];
      for (let p = 1; p <= pageCount; p++) {
        seen.push(...paginateGroups(units, { page: p, groupsPerPage }).pageItems.map((r) => r.id));
      }
      expect(seen).toHaveLength(scattered.length);
      expect(new Set(seen).size).toBe(scattered.length);
    }
  });

  it('never offers a page it cannot fill', () => {
    // Anchoring's failure mode: a paginator advertising a page that renders
    // empty. Pages come FROM the units here, so an offered page always has at
    // least one group.
    const units = buildGroupUnits(scattered, { enableSizeRuns: false });
    for (const groupsPerPage of [1, 3, 4]) {
      const pageCount = paginateGroups(units, { page: 1, groupsPerPage }).pageCount;
      for (let p = 1; p <= pageCount; p++) {
        const view = paginateGroups(units, { page: p, groupsPerPage });
        expect(view.pageGroups).toBeGreaterThan(0);
        expect(view.pageItems.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('paginateGroups — the footer describes what the page ACTUALLY renders', () => {
  const units = buildGroupUnits(scattered, { enableSizeRuns: false });

  it('reports the row range of the slice, not page × pageSize', () => {
    // Page 1 is 2 groups: a single (1 row) + the 3-placement family = 4 rows.
    const p1 = paginateGroups(units, { page: 1, groupsPerPage: 2 });
    expect(p1.pageItems).toHaveLength(4);
    expect([p1.rangeStart, p1.rangeEnd]).toEqual([1, 4]);
    // A fixed page size would have claimed 1–2 here, understating the page.
    const p2 = paginateGroups(units, { page: 2, groupsPerPage: 2 });
    expect([p2.rangeStart, p2.rangeEnd]).toEqual([5, 4 + p2.pageItems.length]);
  });

  it('ranges are contiguous and cover every row exactly once', () => {
    const groupsPerPage = 3;
    const pageCount = paginateGroups(units, { page: 1, groupsPerPage }).pageCount;
    let expectedStart = 1;
    for (let p = 1; p <= pageCount; p++) {
      const view = paginateGroups(units, { page: p, groupsPerPage });
      expect(view.rangeStart).toBe(expectedStart);
      expect(view.rangeEnd).toBe(expectedStart + view.pageItems.length - 1);
      expectedStart = view.rangeEnd + 1;
    }
    expect(expectedStart - 1).toBe(scattered.length);
  });

  it('counts pages in GROUPS and totals in ROWS', () => {
    const view = paginateGroups(units, { page: 1, groupsPerPage: 3 });
    expect(view.totalGroups).toBe(8); // 7 singles + 1 family
    expect(view.totalRows).toBe(10);
    expect(view.pageCount).toBe(3);
  });

  it('clamps an out-of-range page instead of rendering nothing', () => {
    const view = paginateGroups(units, { page: 99, groupsPerPage: 3 });
    expect(view.page).toBe(3);
    expect(view.pageItems.length).toBeGreaterThan(0);
  });

  it('describes an empty set without inventing a range', () => {
    const view = paginateGroups([], { page: 1 });
    expect(view).toMatchObject({
      page: 1,
      pageCount: 1,
      pageGroups: 0,
      rangeStart: 0,
      rangeEnd: 0,
      totalRows: 0,
      totalGroups: 0,
    });
  });

  it('defaults to GROUPS_PER_PAGE', () => {
    expect(GROUPS_PER_PAGE).toBeGreaterThan(0);
    expect(paginateGroups(units, { page: 1 }).pageCount).toBe(1);
  });
});

describe('readIsComplete — truncation is detected from the RESPONSE, not a constant', () => {
  it('mirrors the server cap in supabase/config.toml', () => {
    // A guard written against a LARGER number can never fire: PostgREST caps
    // every response at [api] max_rows, so a previous round's 2000 ceiling was
    // dead code while the real cap was 1000.
    expect(POSTGREST_MAX_ROWS).toBe(1000);
  });

  it('rejects a read the server capped below the requested limit', () => {
    expect(readIsComplete({ returned: 1000, serverCount: 1200, limit: 2000 })).toBe(false);
  });

  // REWRITTEN, deliberately, because it encoded the defect. It used to assert
  // that a read landing exactly on the cap is truncated even when the exact
  // count proves it whole — `returned >= limit` short-circuited BEFORE the
  // count was consulted. A filtered set of exactly 1000 rows the server
  // returned IN FULL is complete, and calling it truncated stamps the "≥"
  // partial marker (the marker the owner rejected) onto groups that are
  // demonstrably whole. The count is the authority; the limit is the fallback.
  it('accepts a full set that happens to land exactly on the cap', () => {
    expect(readIsComplete({ returned: 1000, serverCount: 1000, limit: 1000 })).toBe(true);
  });

  it('rejects a capped read whose exact count proves rows were left behind', () => {
    expect(readIsComplete({ returned: 1000, serverCount: 1001, limit: 1000 })).toBe(false);
  });

  it('accepts a read that returned every matching row', () => {
    expect(readIsComplete({ returned: 111, serverCount: 111, limit: 1000 })).toBe(true);
  });

  it('accepts a short read when no count came back', () => {
    expect(readIsComplete({ returned: 87, serverCount: null, limit: 1000 })).toBe(true);
  });

  it('falls back to the limit ONLY when no count came back', () => {
    // Conservative by design: with no authority to consult, a read that filled
    // the request is assumed to have been cut.
    expect(readIsComplete({ returned: 1000, serverCount: null, limit: 1000 })).toBe(false);
  });
});

describe('the overflow case — disclosed, never silent', () => {
  it('marks every collapsed header when the rows in hand are a prefix', () => {
    const units = buildGroupUnits(scattered, { enableSizeRuns: false });
    const view = paginateGroups(units, { page: 1, groupsPerPage: 50 });
    const rows = buildGroupedRows(view.pageItems, { ...BOOKS, datasetIsTruncated: true });
    expect(skuHeaders(rows).every((h) => h.partial)).toBe(true);
  });

  it('marks NOTHING in the normal case, where every group is provably whole', () => {
    const units = buildGroupUnits(scattered, { enableSizeRuns: false });
    const view = paginateGroups(units, { page: 1, groupsPerPage: 50 });
    const rows = buildGroupedRows(view.pageItems, BOOKS);
    expect(skuHeaders(rows).some((h) => h.partial)).toBe(false);
  });
});

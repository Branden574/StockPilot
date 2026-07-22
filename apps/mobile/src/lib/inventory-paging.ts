/**
 * GROUP-AWARE pagination for the mobile Items / Books lists.
 *
 * THE RULE: a display group is the unit of pagination, so a group can never be
 * split across pages. Three of this SKU's placements are always on ONE page,
 * under one header, all revealed by one chevron.
 *
 * This is the same concept the web table has shipped for months — `runAwarePages`
 * / `deriveInstantView` in apps/web/src/lib/inventory/instant-mode.ts — and the
 * two platforms deliberately converge on it rather than inventing a second
 * answer. Web packs a fixed ROW budget without cutting a unit; mobile pages a
 * fixed number of UNITS, because a mobile "page" is a scroll of cards and one
 * collapsed group renders as exactly one card. Both hold the whole filtered set
 * in memory first; both slice units, never rows.
 *
 * WHY MOBILE CAN NOW HOLD THE WHOLE SET. The lists used to do 50-row server
 * pagination (`.range()`) against datasets that fit in a single response: the
 * largest production org is 111 books / 257 items, and PostgREST caps a
 * response at `[api] max_rows = 1000` (supabase/config.toml). That server
 * paging was the ONLY reason a family split. One request per filter change
 * replaces it — fewer round trips, and the grouping finally sees every row.
 *
 * TWO SUPERSEDED ROUNDS, so neither is re-attempted:
 *   • PAGE-LOCAL TOTALS WITH A "≥" MARKER. Group whatever the 50-row page
 *     holds and mark a header whose family straddles the window. Every figure
 *     was defensible, but the owner's objection stands: a title split across a
 *     boundary — partial header on page 1, lone plain row on page 2 — is
 *     exactly the confusion grouping exists to remove. Marking a split is not
 *     the same as not splitting.
 *   • ANCHORING. Pull a SKU's off-page siblings forward onto the page its
 *     first row fell on and drop the family from later pages. That gave one
 *     header per SKU but left the PAGES ragged: the row window, page count and
 *     "SHOWING x–y OF n" all came from the server range + exact count, which
 *     knew nothing about rows the client dropped, so a later page could render
 *     a handful of cards — or none, under "No books match." — while the
 *     paginator still offered it.
 * Paginating over groups dissolves both: nothing is marked because nothing is
 * short, and nothing is moved or dropped because the page boundary is drawn
 * where no group crosses it.
 *
 * Pure and platform-free so it is unit-testable without React Native.
 */

/**
 * PostgREST's hard per-response row ceiling — `[api] max_rows` in
 * supabase/config.toml. Asking for more than this returns exactly this many
 * rows, silently, so a guard written against a LARGER number can never fire
 * (a previous round shipped one comparing against 2000 while the real cap was
 * 1000). Truncation is therefore detected from the RESPONSE against the exact
 * count (`readIsComplete`), with this constant as the belt to that count's
 * braces. Keep it equal to the config value.
 */
export const POSTGREST_MAX_ROWS = 1000;

/**
 * Groups per page. The unit is a GROUP, not a row: one collapsed SKU family,
 * one size run, or one standalone item — i.e. exactly one card in the
 * collapsed list — so a page is a predictable amount of scrolling even though
 * its ROW count varies. 50 keeps the feel of the 50-row pages it replaces
 * (both production orgs land inside one or two pages).
 */
export const GROUPS_PER_PAGE = 50;

/**
 * Did a read come back WHOLE, or did the server stop short?
 *
 * A truncated read looks exact while being short — the precise failure this
 * guards. Truncation is read from the RESPONSE (returned rows vs the exact
 * count over the same predicates), never from a hard-coded ceiling that can
 * drift from supabase/config.toml.
 *
 * ORDER MATTERS. The exact count is the AUTHORITY and is consulted FIRST: a
 * filtered set of exactly `limit` rows that the server returned IN FULL is
 * whole, and short-circuiting on `returned >= limit` before looking at the
 * count reported it truncated — which stamps the "≥" partial marker, the one
 * thing the owner rejected, onto demonstrably complete groups. `returned >=
 * limit` survives only as the fallback for when no count came back, where it
 * can only ever be conservative.
 */
export function readIsComplete(input: {
  returned: number;
  serverCount: number | null;
  limit: number;
}): boolean {
  const { returned, serverCount, limit } = input;
  if (serverCount !== null) return returned >= serverCount;
  return returned < limit;
}

/** What one page of groups resolves to, plus the numbers a truthful footer needs. */
export interface GroupPageView<T> {
  /** Requested page clamped to [1, pageCount]. */
  page: number;
  pageCount: number;
  /** The page's ITEMS, in order, with every group whole. */
  pageItems: T[];
  /** Groups on this page (collapsed cards). */
  pageGroups: number;
  /** 1-based index of the first row on this page within the full set; 0 when empty. */
  rangeStart: number;
  /** 1-based index of the last row on this page; 0 when empty. */
  rangeEnd: number;
  /** Rows in the whole filtered set (every page summed). */
  totalRows: number;
  /** Groups in the whole filtered set. */
  totalGroups: number;
}

/**
 * Slice pre-built display units into pages of `groupsPerPage` units.
 *
 * `units` must be the groups in render order, each holding the ITEMS that
 * render under one card (`buildGroupUnits`, lib/inventory-grouping.ts). Because
 * a unit is never cut, `rangeStart`/`rangeEnd` are the row range the page
 * ACTUALLY covers — the mobile twin of `pageStartIndex` on web — and a footer
 * must print those rather than deriving `page × pageSize`, which would
 * over-claim on a short page and under-claim on a page that ran long to keep a
 * family whole.
 *
 * Pure: same input, same output; nothing is mutated, moved or dropped.
 */
export function paginateGroups<T>(
  units: readonly (readonly T[])[],
  opts: { page: number; groupsPerPage?: number },
): GroupPageView<T> {
  const groupsPerPage = Math.max(1, opts.groupsPerPage ?? GROUPS_PER_PAGE);
  const totalGroups = units.length;
  const totalRows = units.reduce((n, u) => n + u.length, 0);
  const pageCount = Math.max(1, Math.ceil(totalGroups / groupsPerPage));
  const page = Math.min(Math.max(1, Math.floor(opts.page) || 1), pageCount);
  const firstUnit = (page - 1) * groupsPerPage;
  const slice = units.slice(firstUnit, firstUnit + groupsPerPage);
  const pageItems = slice.flatMap((u) => [...u]);
  // Rows before this page — the units are contiguous, so the page's rows are a
  // contiguous range of the full set and can be described honestly.
  let rowsBefore = 0;
  for (let i = 0; i < firstUnit && i < totalGroups; i++) rowsBefore += units[i]?.length ?? 0;
  return {
    page,
    pageCount,
    pageItems,
    pageGroups: slice.length,
    rangeStart: pageItems.length === 0 ? 0 : rowsBefore + 1,
    rangeEnd: pageItems.length === 0 ? 0 : rowsBefore + pageItems.length,
    totalRows,
    totalGroups,
  };
}

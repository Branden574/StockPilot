// INSTANT MODE — pure client-side derivation for the Items / Books list
// tables (search / filter / sort / status / stock / pagination over the
// FULL per-view dataset).
//
// WHY THIS MODULE IS PURE AND DIRECTIVE-FREE: the same functions run in
// two places that must agree byte-for-byte —
//   • the SERVER pages (inventory/page.tsx, books/page.tsx) use
//     deriveInstantView to decide the empty-state branches and to seed
//     the table's SSR props for deep links, and
//   • the CLIENT table (inventory-table.tsx) re-runs the identical
//     derivation on every keystroke / filter toggle / page flip.
// Keep it free of 'use client' / 'server-only' and of any import that
// drags in either runtime.
//
// PARITY CONTRACT: every predicate below mirrors InventoryService.list()
// (server/services/inventory.ts) — the authoritative implementation the
// live path runs. When list() changes a filter's semantics, this module
// must change with it (the parity suite in instant-mode.search-parity.
// test.ts pins the search half). Known, ACCEPTED divergences from the
// server, all documented at the relevant function:
//   1. Diacritics — rowMatchesInstantSearch folds diacritics on both
//      sides ("cafe" matches "Café"); Postgres ILIKE does not. The
//      client is a strict SUPERSET of the server here (never misses a
//      row the server would return).
//   2. `_` in a search term — LIKE treats unescaped `_` as a single-
//      char wildcard (the server strips `%*,()` but not `_`); the
//      client matches `_` literally. Substring-complete is the accepted
//      baseline; the FIELD coverage (name/sku/barcode/model_number) is
//      identical.
//   3. String sort collation — Postgres orders name/sku with the DB
//      collation; the client uses localeCompare('en'). Case/accent
//      edge orderings can differ by a row or two; the sort KEY set and
//      direction are identical, with the same `id` tiebreak.
//   4. Out-of-range ?page= — the server returns an empty page; the
//      client clamps to the last real page (matches what the
//      Pagination widget already displays).
//   5. stock=low page fill — the server post-filters a pre-fetched page
//      (pages can come up short); the client filters THEN paginates, so
//      every page is full and consistent with `total`.

/**
 * Per-view row ceiling for instant mode. Orgs whose (view, warehouse)
 * row count — active AND archived — exceeds this stay on today's
 * server-driven path; at or under it, manager+ users get the full
 * dataset client-side. 2000 rows ≈ 2 MB of RSC payload worst-case and
 * sub-millisecond filter/sort passes on commodity hardware — Linear-
 * class feel with headroom above the largest current org (~251 rows).
 */
import { sizeRunStyleKey } from '@stockpilot/core';

export const INSTANT_MODE_MAX_ROWS = 2000;

/** Mirrors InventoryService.list()'s CHARTER_ID_RE (uuid allow-list). */
const CHARTER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The row columns the derivation reads — a structural subset of both
 *  the loader's InventoryListItemRow and the table's Item. */
export interface InstantModeRow {
  id: string;
  sku: string;
  barcode?: string | null;
  model_number?: string | null;
  name: string;
  status: 'active' | 'archived' | 'discontinued';
  quantity_on_hand: number;
  reorder_point: number;
  unit_cost: number;
  category_id: string | null;
  primary_location_id: string | null;
  charter_id: string | null;
  custom_fields?: Record<string, unknown> | null;
  created_at?: string;
  updated_at: string;
  /** True only when the SYSTEM auto-archived this row on zero stock
   *  (migration 0266) — backs the Archived view's "Auto-archived only"
   *  filter chip. Optional so any lighter caller of these pure
   *  functions doesn't have to carry it. */
  auto_archived?: boolean;
  /** True while an item auto-created from an inbound PO has never
   *  received any stock (migration 0277). Mirrors list()'s expected
   *  predicate: hidden from every view unless state.expected is true,
   *  which shows ONLY these rows (the "Expected" chip). Optional —
   *  missing means unflagged, so lighter callers are unaffected. */
  awaiting_first_receipt?: boolean;
}

/** One holding line, structurally identical to the loader's
 *  InventoryPlacementLine (redeclared here so this module never imports
 *  from a 'server-only' file). */
export interface InstantPlacementLine {
  locationId: string;
  label: string;
  kind: string;
  quantity: number;
}

export type InstantModeSort =
  | 'updated_desc'
  | 'updated_asc'
  | 'name_asc'
  | 'name_desc'
  | 'sku_asc'
  | 'sku_desc'
  | 'qty_desc'
  | 'qty_asc'
  | 'created_desc'
  | 'created_asc';

const VALID_SORTS = new Set<InstantModeSort>([
  'updated_desc',
  'updated_asc',
  'name_asc',
  'name_desc',
  'sku_asc',
  'sku_desc',
  'qty_desc',
  'qty_asc',
  'created_desc',
  'created_asc',
]);

/** URL state the derivation consumes — one normalized shape whether it
 *  came from a page's searchParams object or useSearchParams(). */
export interface InstantModeState {
  q: string;
  status: 'active' | 'archived' | 'discontinued' | 'all';
  /** 'low' | 'out' from ?stock=; anything else is no stock filter —
   *  mirrors the pages' `params.stock === 'low'` exact comparison. */
  stock: 'low' | 'out' | null;
  /** ?auto=1 — narrows to auto_archived rows only. Only meaningful
   *  paired with status='archived' (the Archived view's "Auto-archived
   *  only" filter chip); a no-op filter otherwise since active rows
   *  never carry auto_archived=true (cleared on restore). */
  autoArchived: boolean;
  /** ?expected=1 — the "Expected" chip view: ONLY rows awaiting their
   *  first receipt (migration 0277), ACROSS lifecycles (status is
   *  ignored while on — mirrors mobile's listStatusPredicate
   *  lifecycle:null and the pages passing status:'all' to list()).
   *  Off (the default) EXCLUDES those rows from every view — mirrors
   *  list()'s `eq('awaiting_first_receipt', expected === true)`
   *  predicate. */
  expected: boolean;
  cat: string[];
  loc: string[];
  charter: string[];
  rack: string;
  sort: InstantModeSort;
  page: number;
}

function coerceStatus(value: unknown): InstantModeState['status'] {
  // Mirrors the pages' lifecycleStatus coercion (exact string match,
  // arrays/garbage fall back to 'active').
  return value === 'archived' || value === 'discontinued' || value === 'all' || value === 'active'
    ? value
    : 'active';
}

function coerceStock(value: unknown): InstantModeState['stock'] {
  return value === 'low' || value === 'out' ? value : null;
}

/** Mirrors the ArchiveViewToggle-style boolean chips elsewhere: only the
 *  exact '1' string means "on"; anything else (missing, '0', garbage) is
 *  off. Shared by the ?auto= (Auto-archived only) and ?expected=
 *  (Expected) chips. */
function coerceFlagParam(value: unknown): boolean {
  return value === '1';
}
const coerceAutoArchived = coerceFlagParam;

function coerceSort(value: unknown): InstantModeSort {
  // Mirrors the pages' parseSort (unknown values → updated_desc).
  return typeof value === 'string' && VALID_SORTS.has(value as InstantModeSort)
    ? (value as InstantModeSort)
    : 'updated_desc';
}

function coercePage(value: unknown): number {
  // Mirrors the pages' `Math.max(1, Number(params.page) || 1)`.
  return Math.max(1, Number(value) || 1);
}

function parseIdList(value: string | string[] | undefined): string[] {
  // Mirrors the pages' parseIdList.
  if (!value) return [];
  return Array.isArray(value) ? value.filter(Boolean) : [value];
}

/** Assemble state from a page's awaited `searchParams` object (server). */
export function instantStateFromPageParams(params: {
  q?: string;
  status?: string;
  stock?: string;
  auto?: string;
  expected?: string;
  page?: string;
  sort?: string;
  cat?: string | string[];
  loc?: string | string[];
  charter?: string | string[];
  rack?: string;
}): InstantModeState {
  return {
    q: typeof params.q === 'string' ? params.q : '',
    status: coerceStatus(params.status),
    stock: coerceStock(params.stock),
    autoArchived: coerceAutoArchived(params.auto),
    expected: coerceFlagParam(params.expected),
    cat: parseIdList(params.cat),
    loc: parseIdList(params.loc),
    charter: parseIdList(params.charter),
    rack: typeof params.rack === 'string' ? params.rack : '',
    sort: coerceSort(params.sort),
    page: coercePage(params.page),
  };
}

/** Assemble state from useSearchParams() (client). The table overrides
 *  q/cat/loc/charter with its optimistic local values on top of this. */
export function instantStateFromSearchParams(params: {
  get(name: string): string | null;
  getAll(name: string): string[];
}): InstantModeState {
  return {
    q: params.get('q') ?? '',
    status: coerceStatus(params.get('status') ?? undefined),
    stock: coerceStock(params.get('stock') ?? undefined),
    autoArchived: coerceAutoArchived(params.get('auto') ?? undefined),
    expected: coerceFlagParam(params.get('expected') ?? undefined),
    cat: params.getAll('cat').filter(Boolean),
    loc: params.getAll('loc').filter(Boolean),
    charter: params.getAll('charter').filter(Boolean),
    rack: params.get('rack') ?? '',
    sort: coerceSort(params.get('sort') ?? undefined),
    page: coercePage(params.get('page') ?? undefined),
  };
}

/* ---- search ------------------------------------------------------------ */

/**
 * Mirrors InventoryService.list()'s q-term preprocessing VERBATIM:
 * trim → cap at 120 chars → replace `[,()%*]` with spaces (the chars
 * that could escape a PostgREST .or() clause / act as LIKE wildcards).
 * An empty result means "no search filter" — including for terms that
 * collapse to '' (all-stripped input), exactly like the server's
 * `if (term)` guard. NOTE: a whitespace-only RESULT (e.g. q=&quot;%%%&quot; →
 * '   ') is still a live filter on the server (pattern `%   %`), so it
 * is here too.
 */
export function buildInstantSearchTerm(q: string): string {
  return q
    .trim()
    .slice(0, 120)
    .replace(/[,()%*]/g, ' ');
}

/** Case-fold + diacritic-fold (NFKD, strip combining marks). Applied to
 *  BOTH needle and haystack. Divergence #1 in the header: Postgres
 *  ILIKE only case-folds — the client is a superset on accented text. */
export function normalizeInstantSearchText(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/**
 * The client search matcher. FIELD LIST IS AUTHORITATIVE and must equal
 * InventoryService.list()'s q clause exactly:
 *   name.ilike / sku.ilike / barcode.ilike / model_number.ilike
 * (substring on each; NULL columns never match — ILIKE NULL is not
 * true). Multi-word terms match as ONE contiguous substring, same as
 * the server's single `%term%` pattern. Pass the PRE-NORMALIZED term
 * (buildInstantSearchTerm → normalizeInstantSearchText) so the per-row
 * cost is just four .includes calls.
 */
export function rowMatchesInstantSearch(row: InstantModeRow, normalizedTerm: string): boolean {
  if (!normalizedTerm) return true;
  const like = (v: string | null | undefined): boolean =>
    v != null && normalizeInstantSearchText(v).includes(normalizedTerm);
  return like(row.name) || like(row.sku) || like(row.barcode) || like(row.model_number);
}

/* ---- filters ------------------------------------------------------------ */

/** Combined effect of list()'s lowStock OR-pre-filter
 *  (`reorder_point.gt.0,quantity_on_hand.lte.0`) and its JS post-filter
 *  (`qty <= reorder || qty <= 0`): out counts as low even with no
 *  reorder line; qty above 0 needs a positive reorder point. */
export function isLowStock(quantityOnHand: number, reorderPoint: number): boolean {
  return quantityOnHand <= 0 || (reorderPoint > 0 && quantityOnHand <= reorderPoint);
}

/** Mirrors list()'s charter clause, including its fail-open edge: ids
 *  that are neither 'generic' nor valid uuids are DROPPED, and if
 *  nothing survives, NO filter applies (the server applies none). */
export function rowMatchesCharters(charterId: string | null, charterIds: string[]): boolean {
  if (charterIds.length === 0) return true;
  const includesGeneric = charterIds.includes('generic');
  const realIds = charterIds.filter((id) => id !== 'generic' && CHARTER_ID_RE.test(id));
  if (includesGeneric && realIds.length > 0) {
    return charterId === null || realIds.includes(charterId);
  }
  if (includesGeneric) return charterId === null;
  if (realIds.length > 0) return charterId !== null && realIds.includes(charterId);
  return true;
}

/**
 * Mirrors list()'s rack filter for the two per-view key sets (instant
 * mode never sees itemType='all' — the pages fall back to server mode
 * for it): books match custom_fields.book_rack_number/_row, items match
 * the neutral rack_number/rack_row. Same sanitize (strip non-
 * alphanumerics, cap 40), same first-dash split, same "number alone
 * matches just the number" semantics, same "empty number → no filter".
 * PostgREST's `->>` yields text, so values are compared as strings.
 */
export function rowMatchesRack(
  customFields: Record<string, unknown> | null | undefined,
  rack: string,
  view: 'items' | 'books',
): boolean {
  if (!rack || !rack.trim()) return true; // list(): filter only under rack && rack.trim()
  const sanitize = (s: string | undefined): string =>
    (s ?? '').replace(/[^A-Za-z0-9]/g, '').slice(0, 40);
  const [rawNum, rawRow] = rack.trim().split('-', 2);
  const num = sanitize(rawNum);
  const row = sanitize(rawRow);
  if (!num) return true; // list(): no filter when the number segment is empty
  const numKey = view === 'books' ? 'book_rack_number' : 'rack_number';
  const rowKey = view === 'books' ? 'book_rack_row' : 'rack_row';
  const text = (key: string): string | null => {
    const v = customFields?.[key];
    return v === null || v === undefined ? null : String(v);
  };
  if (text(numKey) !== num) return false;
  if (row && text(rowKey) !== row) return false;
  return true;
}

/** Every filter list() applies for the two list pages, in one pass.
 *  (item_type / is_rental / deleted_at are enforced by the dataset
 *  loader itself — the dataset only ever contains the view's rows.) */
export function filterInstantRows<T extends InstantModeRow>(
  rows: readonly T[],
  state: InstantModeState,
  view: 'items' | 'books',
): T[] {
  const term = normalizeInstantSearchText(buildInstantSearchTerm(state.q));
  const cats = state.cat.length > 0 ? new Set(state.cat) : null;
  const locs = state.loc.length > 0 ? new Set(state.loc) : null;
  return rows.filter((r) => {
    // Expected-items visibility (mig 0277) — mirrors list()'s
    // `eq('awaiting_first_receipt', expected === true)`: the default
    // hides rows awaiting their first receipt; ?expected=1 shows ONLY
    // them. A missing flag (lighter callers) means unflagged.
    if (state.expected) {
      if (r.awaiting_first_receipt !== true) return false;
    } else if (r.awaiting_first_receipt === true) {
      return false;
    }
    // status: default/'active' → active only; 'all' → everything;
    // otherwise the exact status. Mirrors list()'s status block — EXCEPT
    // in the Expected view, which spans lifecycles (the pages pass
    // status:'all' to list() when ?expected=1, mirroring mobile's
    // listStatusPredicate lifecycle:null): a flagged row someone
    // manually archived is only reachable there, since the Archived
    // view excludes flagged rows via the default branch above.
    if (!state.expected) {
      if (state.status === 'active') {
        if (r.status !== 'active') return false;
      } else if (state.status !== 'all' && r.status !== state.status) {
        return false;
      }
    }
    if (!rowMatchesInstantSearch(r, term)) return false;
    if (cats && (r.category_id === null || !cats.has(r.category_id))) return false;
    if (locs && (r.primary_location_id === null || !locs.has(r.primary_location_id))) return false;
    if (!rowMatchesCharters(r.charter_id, state.charter)) return false;
    if (!rowMatchesRack(r.custom_fields, state.rack, view)) return false;
    if (state.stock === 'out' && !(r.quantity_on_hand <= 0)) return false;
    if (state.stock === 'low' && !isLowStock(r.quantity_on_hand, r.reorder_point)) return false;
    if (state.autoArchived && r.auto_archived !== true) return false;
    return true;
  });
}

/* ---- sort ---------------------------------------------------------------- */

const SORT_SPEC: Record<
  InstantModeSort,
  { col: 'updated_at' | 'created_at' | 'name' | 'sku' | 'quantity_on_hand'; asc: boolean }
> = {
  updated_desc: { col: 'updated_at', asc: false },
  updated_asc: { col: 'updated_at', asc: true },
  name_asc: { col: 'name', asc: true },
  name_desc: { col: 'name', asc: false },
  sku_asc: { col: 'sku', asc: true },
  sku_desc: { col: 'sku', asc: false },
  qty_desc: { col: 'quantity_on_hand', asc: false },
  qty_asc: { col: 'quantity_on_hand', asc: true },
  created_desc: { col: 'created_at', asc: false },
  created_asc: { col: 'created_at', asc: true },
};

/**
 * Mirrors list()'s ORDER BY: SORT_MAP column + direction, then the
 * stable `id` ascending tiebreak. Timestamps compare as ISO strings
 * (PostgREST emits a lexicographically-ordered format); names/skus use
 * localeCompare('en') — divergence #3 in the header. Returns a NEW
 * array; never mutates the input.
 */
export function sortInstantRows<T extends InstantModeRow>(
  rows: readonly T[],
  sort: InstantModeSort,
): T[] {
  const spec = SORT_SPEC[sort] ?? SORT_SPEC.updated_desc;
  const dir = spec.asc ? 1 : -1;
  const col = spec.col;
  return [...rows].sort((a, b) => {
    let cmp: number;
    if (col === 'quantity_on_hand') {
      cmp = (Number(a.quantity_on_hand) || 0) - (Number(b.quantity_on_hand) || 0);
    } else if (col === 'name' || col === 'sku') {
      cmp = (a[col] ?? '').localeCompare(b[col] ?? '', 'en');
    } else {
      const av = a[col] ?? '';
      const bv = b[col] ?? '';
      cmp = av < bv ? -1 : av > bv ? 1 : 0;
    }
    if (cmp !== 0) return cmp * dir;
    // Stable secondary sort — canonical lowercase uuid text order equals
    // Postgres's uuid byte order.
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/* ---- pagination + footer -------------------------------------------------- */

/** Plain fixed-size chunking (Books, and the non-grouped path). */
function slicePages<T>(sorted: readonly T[], pageSize: number): T[][] {
  const pages: T[][] = [];
  for (let i = 0; i < sorted.length; i += pageSize) pages.push(sorted.slice(i, i + pageSize));
  return pages;
}

/**
 * RUN-AWARE pagination for the Items view. The list collapses BOTH a size run
 * ("Pink Shirt - L / - XL / - 2XL") AND a Model B SKU family (one item row per
 * charter sharing one SKU) into one expandable row; if pagination sliced raw
 * rows at a fixed 30, a group straddling the boundary would render as TWO
 * separate groups on two pages — or worse, a single stranded member renders
 * FLAT with no arrow at all and a partial on-hand (the "Lenovo Chromebooks
 * don't group like the Acers" bug: the family's rows ranked 8/234/240/254
 * under updated-DESC, so no page ever held two of them). So: (1) build units —
 * a SKU family (2+ rows sharing a non-blank SKU) is ONE unit; else a size run
 * (2+ items sharing a base name) is ONE unit; members cluster at the unit's
 * first-seen (best-ranked) position so the user's sort still decides where
 * the family lands; every other item is a singleton unit; (2) pack units into
 * pages of ~pageSize, never splitting a unit. A page may run a few rows over
 * pageSize to keep a unit whole. SKU beats size-run when both apply — under
 * Model B the SKU IS the product identity (mig 0234), while a size run spans
 * DIFFERENT skus that merely share a base name. Pure.
 */
export function runAwarePages<T extends { id: string; name: string; sku?: string | null }>(
  sorted: readonly T[],
  pageSize: number,
): T[][] {
  // Count keys over the whole set so lone members stay singletons.
  const runCounts = new Map<string, number>();
  const skuCounts = new Map<string, number>();
  for (const r of sorted) {
    const k = sizeRunStyleKey(r.name);
    if (k) runCounts.set(k, (runCounts.get(k) ?? 0) + 1);
    const s = (r.sku ?? '').trim();
    if (s) skuCounts.set(s, (skuCounts.get(s) ?? 0) + 1);
  }
  // Unit key per row: SKU family first, then size run, else singleton.
  const unitKeyOf = (r: T): string | null => {
    const s = (r.sku ?? '').trim();
    if (s && (skuCounts.get(s) ?? 0) >= 2) return `sku:${s}`;
    const k = sizeRunStyleKey(r.name);
    if (k && (runCounts.get(k) ?? 0) >= 2) return `run:${k}`;
    return null;
  };
  // Build units, clustering members at the unit's first-seen position.
  const units: T[][] = [];
  const unitOf = new Map<string, number>();
  for (const r of sorted) {
    const key = unitKeyOf(r);
    if (key) {
      let idx = unitOf.get(key);
      if (idx === undefined) {
        idx = units.length;
        unitOf.set(key, idx);
        units.push([]);
      }
      units[idx]!.push(r);
    } else {
      units.push([r]);
    }
  }
  // Pack units into pages without ever cutting a unit.
  const pages: T[][] = [];
  let cur: T[] = [];
  for (const unit of units) {
    if (cur.length > 0 && cur.length + unit.length > pageSize) {
      pages.push(cur);
      cur = [];
    }
    cur.push(...unit);
  }
  if (cur.length > 0) pages.push(cur);
  return pages;
}

export interface InstantViewResult<T> {
  /** Filtered ITEM count (item-level — placement expansion happens after
   *  pagination, exactly like the server pages). Backs "Page X of Y" and
   *  the "{n} SKUs" footer. */
  total: number;
  /** Sum of qty×cost over the FULL filtered set with list()'s exact
   *  coercion — the buildSumPage mirror ("$X on hand" footer). */
  valueOnHand: number;
  /** Requested page clamped to [1, pageCount] (divergence #4). */
  page: number;
  pageCount: number;
  /** The clamped page's item-level rows, filtered + sorted. */
  pageItems: T[];
  /**
   * EVERY row in the FULL filtered set (every active filter applied, NOT
   * clamped to the current page — the same set `total`/`valueOnHand` are
   * computed over). Model B's SKU-group headers (inventory-table.tsx) sum
   * `quantity_on_hand` across this to get a group's TRUE total: a SKU's
   * placements can be MULTIPLE DISTINCT inventory_items rows (one per
   * charter), and the default last-updated sort can split them across
   * pages — summing only `pageItems` would silently show a partial total
   * for a group that straddles a page boundary.
   */
  filteredRows: readonly T[];
}

/**
 * The one-call derivation the table and the pages share: filter → footer
 * totals → sort → paginate. Pure — same (rows, state) in, same result
 * out — so realtime prop refreshes reconcile automatically.
 */
export function deriveInstantView<T extends InstantModeRow>(
  rows: readonly T[],
  state: InstantModeState,
  view: 'items' | 'books',
  pageSize: number,
): InstantViewResult<T> {
  const filtered = filterInstantRows(rows, state, view);
  const total = filtered.length;
  // Identical coercion to list()'s valueOnHand reduce (and the cached
  // loadInventoryValueOnHand): Number(x) || 0 on both factors.
  const valueOnHand = filtered.reduce(
    (acc, r) => acc + (Number(r.quantity_on_hand) || 0) * (Number(r.unit_cost) || 0),
    0,
  );
  const sorted = sortInstantRows(filtered, state.sort);
  // The Items view groups apparel size runs into one expandable row, so it
  // paginates RUN-AWARE (a page never cuts a run — otherwise the same run would
  // render as two separate groups on two pages). Books never group → plain
  // fixed slices. This is client-only; an ACCEPTED divergence from the server's
  // fixed row-slice pagination (documented in the parity block above).
  const pages = view === 'items' ? runAwarePages(sorted, pageSize) : slicePages(sorted, pageSize);
  const pageCount = Math.max(1, pages.length);
  const page = Math.min(Math.max(1, state.page), pageCount);
  const pageItems = pages[page - 1] ?? [];
  return { total, valueOnHand, page, pageCount, pageItems, filteredRows: filtered };
}

/* ---- placement expansion (Items page's one-line-per-rack) ------------------ */

/**
 * Client-side twin of the Items page's placementRows flatMap: expand
 * each item into one row per holding line (rack/crate/staging/unplaced),
 * or a single fallback row when it has no holdings. Field-for-field
 * identical to the server expansion so instant and server modes render
 * the same rows. Books never expand (the Books page passes no
 * placement).
 */
export function expandInstantPlacementRows<T extends { id: string; quantity_on_hand: number }>(
  items: readonly T[],
  placement: Readonly<Record<string, InstantPlacementLine[]>>,
): Array<
  T & {
    rowKey: string;
    line_quantity: number;
    placement_label: string | null;
    placement_kind: string | undefined;
  }
> {
  return items.flatMap((item) => {
    const ps = placement[item.id] ?? [];
    if (ps.length === 0) {
      return [
        {
          ...item,
          rowKey: item.id,
          line_quantity: item.quantity_on_hand,
          placement_label: null as string | null,
          placement_kind: undefined as string | undefined,
        },
      ];
    }
    return ps.map((p) => ({
      ...item,
      rowKey: `${item.id}:${p.locationId}`,
      line_quantity: p.quantity,
      placement_label: p.label as string | null,
      placement_kind: p.kind as string | undefined,
    }));
  });
}

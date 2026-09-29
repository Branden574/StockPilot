/**
 * BOOK ORDER TOTALS — the portable half of the report (migrations 0379 and
 * 0382: 0382 adds the ORDER's charter, order_requests.delivery_charter_id,
 * and the Today and This week presets).
 *
 * SQL is the only calculator: public.book_order_totals, _orders and _options
 * return ONE jsonb value each, and nothing on the web server or the phone
 * adds numbers. This module holds what both apps share around those answers:
 *
 *   - the filter vocabulary (date presets, status groups, sorts, page size,
 *     export ceilings) and the literal status lists pinned to the SQL;
 *   - the query model: URL / query-string parsing with named invalid keys,
 *     one canonical serialization, and the "resolved" query every follow-up
 *     request carries (a concrete warehouse or all, never "default");
 *   - the page-reset rules (a filter change starts at page 1, a page change
 *     keeps every filter) and the query Clear filters and each chip lead to;
 *   - the charter echo check: an answer is shown under a charter only when
 *     it says it is for that charter;
 *   - strict parsers for the three answers (a wrong shape throws; unknown
 *     keys are ignored so the database may be a release ahead);
 *   - formatting that never converts time zones: SQL returns every date a
 *     person reads as an org-local YYYY-MM-DD (or YYYY-MM-DD HH24:MI) string,
 *     and these helpers only rearrange the characters, so Node and Hermes
 *     print the same day SQL cut.
 *
 * Words live in ./book-order-totals-copy.ts.
 */

import { isValidIsbn, isbnSearchKeys } from '../books/isbn';
import {
  ORDER_STATUS_KEYS,
  resolveOrderStatusConfig,
  type OrderStatusConfig,
  type OrderStatusKey,
} from '../customization/order-status';

// ── Vocabulary ──────────────────────────────────────────────────────────────

export const BOOK_ORDER_TOTALS_VERSION = 1;

/** In the brief's order. `today` and `week` (Sunday start) came with 0382;
 *  an older server answers them with 22023 invalid_range, which resets. */
export const BOOK_REPORT_RANGES = [
  'all',
  'today',
  'week',
  'month',
  '30d',
  '90d',
  'year',
  'custom',
] as const;
export type BookReportRange = (typeof BOOK_REPORT_RANGES)[number];

export const BOOK_REPORT_SORTS = ['copies', 'title', 'orders', 'latest'] as const;
export type BookReportSort = (typeof BOOK_REPORT_SORTS)[number];

export const BOOK_REPORT_STATUS_GROUP_KEYS = [
  'awaiting',
  'in_progress',
  'backordered',
  'completed',
  'denied',
  'cancelled',
] as const;
export type BookReportStatusGroup = (typeof BOOK_REPORT_STATUS_GROUP_KEYS)[number];

/** The status filter's groups. `pending_confirmation` (an unconfirmed
 *  public-link form) is in no group: it is never selectable. */
export const BOOK_REPORT_STATUS_GROUPS: Readonly<
  Record<BookReportStatusGroup, { statuses: readonly OrderStatusKey[]; byDefault: boolean }>
> = {
  awaiting: { statuses: ['pending_approval'], byDefault: true },
  in_progress: {
    statuses: [
      'approved',
      'pick_slip_generated',
      'picking_in_progress',
      'picking_complete',
      'packing_slip_generated',
      'staged_for_pickup',
      'staged_for_delivery',
      'in_transit',
    ],
    byDefault: true,
  },
  backordered: { statuses: ['backordered'], byDefault: true },
  completed: { statuses: ['completed'], byDefault: true },
  denied: { statuses: ['denied'], byDefault: false },
  cancelled: { statuses: ['cancelled'], byDefault: false },
};

export const DEFAULT_BOOK_REPORT_STATUS_GROUPS: readonly BookReportStatusGroup[] =
  BOOK_REPORT_STATUS_GROUP_KEYS.filter((g) => BOOK_REPORT_STATUS_GROUPS[g].byDefault);

/** Statuses for groups, deduped, in the canonical ORDER_STATUS_KEYS order
 *  (the order SQL echoes them in). */
export function statusesForGroups(groups: readonly BookReportStatusGroup[]): OrderStatusKey[] {
  const wanted = new Set<string>();
  for (const g of groups) for (const s of BOOK_REPORT_STATUS_GROUPS[g].statuses) wanted.add(s);
  return ORDER_STATUS_KEYS.filter((s) => wanted.has(s));
}

/** Every selectable status (13) and the default set (11), in canonical order.
 *  The same two lists are literals in migration 0379 (c_allowed, c_default)
 *  and in pgTAP 0379 (all13, def11); the core test reads both files. */
export const BOOK_REPORT_SELECTABLE_STATUSES: readonly OrderStatusKey[] = statusesForGroups(
  BOOK_REPORT_STATUS_GROUP_KEYS,
);
export const BOOK_REPORT_DEFAULT_STATUSES: readonly OrderStatusKey[] = statusesForGroups(
  DEFAULT_BOOK_REPORT_STATUS_GROUPS,
);

/** Grouped books per page on the web table and the phone list. */
export const BOOK_REPORT_PAGE_SIZE = 25;
/** Orders per page in the drill-down. */
export const BOOK_REPORT_ORDERS_PAGE_SIZE = 25;
/** Covers resolved per request while browsing (one page). */
export const BOOK_REPORT_COVERS_MAX = 25;
/** Longest search accepted from a person (SQL itself matches at most 200). */
export const BOOK_REPORT_SEARCH_MAX = 100;
/** Export ceilings, checked in SQL before any row is serialized. Each is the
 *  largest row count whose end-to-end export stays within 20 s locally (plan
 *  8.1 and 12: a third of the route's 60 s, for slower function CPUs and the
 *  Vercel-to-Supabase stalls), never raised past what was measured. A file
 *  above its ceiling is refused, never truncated.
 *
 *  Measured 2026-09-28 (production build, local stack, 500 covers):
 *  - CSV: 20,000 rows in 1.3-1.5 s.
 *  - PDF: react-pdf lays out one long page run in time that grows with the
 *    SQUARE of the rows. Without covers 500 rows 4.5 s, 900 13.5 s, 1,000
 *    16.8 s, 2,000 64 s, 3,000 145 s; with 500 covers 800 rows 14.3 s, 900
 *    17.5 s, 1,000 21.4 s. So 900. */
export const BOOK_REPORT_CSV_MAX_ROWS = 20_000;
export const BOOK_REPORT_PDF_MAX_ROWS = 900;
/** Covers embedded in one PDF (one signing call stays under 1,000 paths).
 *  Rows past it print a placeholder; every row and total is still printed. */
export const BOOK_REPORT_PDF_COVER_CAP = 500;

/** A single copy per unit: a quantity in one of these units is copies. The
 *  SQL (0379, and 0382's lines helper and drill-down) holds the same list;
 *  any other unit, blank included, is shown with its unit and left out of the
 *  copy total. */
export const BOOK_REPORT_COPY_UNITS = [
  'unit',
  'units',
  'ea',
  'each',
  'copy',
  'copies',
  'pc',
  'pcs',
  'piece',
  'pieces',
] as const;

// ── Query model ─────────────────────────────────────────────────────────────

/**
 * `charter`: the charter the ORDER was placed for (its delivery site,
 *   order_requests.delivery_charter_id), never the charter that owns a book:
 *   - 'all': every charter the caller may report on, and orders with none;
 *   - 'none': orders placed with no charter (pickups, and a few early
 *     delivery orders saved without one);
 *   - a uuid (lower case): that charter. SQL accepts it only if the caller
 *     may report on it (22023 invalid_charter otherwise); the id in a URL is
 *     never an authority.
 * `warehouse`:
 *   - 'default': the URL carried no warehouse; the web page resolves it ONCE
 *     (the manager's warehouse view, else all). Never sent to an API route.
 *   - 'all': every warehouse the caller can see.
 *   - a uuid: that warehouse (the ORDER's warehouse).
 * `warehouseFromView`: the uuid came from the person's warehouse view. A label
 *   only ("your warehouse view"), never an authority.
 * `category`: 'all', 'none' (books with no category) or a uuid.
 */
export interface BookReportQuery {
  charter: 'all' | 'none' | string;
  range: BookReportRange;
  from: string | null;
  to: string | null;
  statusGroups: BookReportStatusGroup[];
  warehouse: 'default' | 'all' | string;
  warehouseFromView: boolean;
  category: 'all' | 'none' | string;
  q: string;
  sort: BookReportSort;
  page: number;
}

export const DEFAULT_BOOK_REPORT_QUERY: Readonly<BookReportQuery> = Object.freeze({
  charter: 'all',
  range: 'all',
  from: null,
  to: null,
  statusGroups: [...DEFAULT_BOOK_REPORT_STATUS_GROUPS],
  warehouse: 'default',
  warehouseFromView: false,
  category: 'all',
  q: '',
  sort: 'copies',
  page: 1,
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** A real calendar date written YYYY-MM-DD, from 2000-01-01 to 2100-12-31
 *  (the SQL bounds). Pure string arithmetic: no Date, no zone. */
export function validateCustomDate(ymd: unknown): boolean {
  if (typeof ymd !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1]!;
  return d <= days;
}

type QueryInput =
  | URLSearchParams
  | Record<string, string | string[] | undefined | null>
  | ReadonlyMap<string, string>;

function readParam(input: QueryInput, key: string): string | undefined {
  if (input instanceof URLSearchParams) {
    const v = input.get(key);
    return v === null ? undefined : v;
  }
  if (
    typeof (input as ReadonlyMap<string, string>).get === 'function' &&
    !(input instanceof URLSearchParams)
  ) {
    const v = (input as ReadonlyMap<string, string>).get(key);
    return v === undefined ? undefined : v;
  }
  const raw = (input as Record<string, string | string[] | undefined | null>)[key];
  if (raw === undefined || raw === null) return undefined;
  return Array.isArray(raw) ? raw[0] : raw;
}

/**
 * Read a report query from a URL's search parameters (web page, API route)
 * or a plain record (Next's searchParams). Invalid keys fall back to their
 * defaults and are NAMED in `invalid`, so a page can say "Some filters in
 * this link were not valid and were reset." and an API route can answer 400.
 *
 * Keys: charter (all, none or a uuid; absent = all), range, from, to
 * (custom only), status (comma list of group keys), warehouse (all or a uuid;
 * absent = default), wview=1, category (all, none or a uuid), q, sort, page.
 *
 * Dates: `from` and `to` are read only for a custom range. A link that
 * carries `from` or `to` and no `range` at all (the brief's
 * `?charter=..&from=2026-09-01&to=2026-09-30`) is a custom range. A range
 * that is named (`range=month&from=..`) keeps its own days and the dates are
 * ignored, not named invalid. An impossible or reversed pair names the key at
 * fault and falls back to All time.
 */
export function parseBookReportQuery(input: QueryInput): {
  query: BookReportQuery;
  invalid: string[];
} {
  const invalid: string[] = [];
  const query: BookReportQuery = {
    ...DEFAULT_BOOK_REPORT_QUERY,
    statusGroups: [...DEFAULT_BOOK_REPORT_STATUS_GROUPS],
  };

  const charter = readParam(input, 'charter');
  if (charter !== undefined) {
    if (charter === 'all' || charter === 'none') query.charter = charter;
    else if (isUuid(charter)) query.charter = charter.toLowerCase();
    else invalid.push('charter');
  }

  const range = readParam(input, 'range');
  if (range !== undefined) {
    if ((BOOK_REPORT_RANGES as readonly string[]).includes(range))
      query.range = range as BookReportRange;
    else invalid.push('range');
  } else if (readParam(input, 'from') || readParam(input, 'to')) {
    // Date-only link: the dates ARE the range. An empty `from=` / `to=` (a
    // form sent with blank fields) implies nothing.
    query.range = 'custom';
  }
  if (query.range === 'custom') {
    const from = readParam(input, 'from');
    const to = readParam(input, 'to');
    const fromOk = validateCustomDate(from);
    const toOk = validateCustomDate(to);
    if (fromOk && toOk && (from as string) <= (to as string)) {
      query.from = from as string;
      query.to = to as string;
    } else {
      if (!fromOk) invalid.push('from');
      if (!toOk || (fromOk && toOk)) invalid.push('to');
      query.range = 'all';
    }
  }

  const status = readParam(input, 'status');
  if (status !== undefined) {
    const parts = status
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    const known = parts.every((p) =>
      (BOOK_REPORT_STATUS_GROUP_KEYS as readonly string[]).includes(p),
    );
    if (parts.length > 0 && known) {
      const set = new Set(parts);
      query.statusGroups = BOOK_REPORT_STATUS_GROUP_KEYS.filter((g) => set.has(g));
    } else {
      invalid.push('status');
    }
  }

  const warehouse = readParam(input, 'warehouse');
  if (warehouse !== undefined) {
    if (warehouse === 'all') query.warehouse = 'all';
    else if (isUuid(warehouse)) query.warehouse = warehouse.toLowerCase();
    else invalid.push('warehouse');
  }
  query.warehouseFromView = readParam(input, 'wview') === '1' && isUuid(query.warehouse);

  const category = readParam(input, 'category');
  if (category !== undefined) {
    if (category === 'all' || category === 'none') query.category = category;
    else if (isUuid(category)) query.category = category.toLowerCase();
    else invalid.push('category');
  }

  const q = readParam(input, 'q');
  if (q !== undefined) {
    const trimmed = q.trim();
    if (trimmed.length <= BOOK_REPORT_SEARCH_MAX) query.q = trimmed;
    else invalid.push('q');
  }

  const sort = readParam(input, 'sort');
  if (sort !== undefined) {
    if ((BOOK_REPORT_SORTS as readonly string[]).includes(sort))
      query.sort = sort as BookReportSort;
    else invalid.push('sort');
  }

  const page = readParam(input, 'page');
  if (page !== undefined) {
    if (/^[1-9]\d{0,5}$/.test(page)) query.page = Number(page);
    else invalid.push('page');
  }

  return { query, invalid };
}

function sameGroups(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((g, i) => g === b[i]);
}

/** The default status groups, in any order (a draft may hold them unsorted). */
export function isDefaultStatusGroups(groups: readonly BookReportStatusGroup[]): boolean {
  const set = new Set(groups);
  return (
    set.size === DEFAULT_BOOK_REPORT_STATUS_GROUPS.length &&
    DEFAULT_BOOK_REPORT_STATUS_GROUPS.every((g) => set.has(g))
  );
}

/**
 * The canonical query string (no leading '?'), keys in a fixed order and
 * defaults left out: two equal queries always serialize the same way. Hand
 * built (the phone's convention), values percent-encoded. `charter` comes
 * first (the brief's example order; parsing is order-free). `warehouse` is
 * written whenever it is not 'default', so a resolved query always carries
 * its concrete warehouse. Dates are written only with `range=custom`, and
 * `range=custom` always with them, so a phone that predates date-only links
 * still reads the dates.
 */
export function serializeBookReportQuery(
  query: BookReportQuery,
  opts: { includePage?: boolean } = {},
): string {
  const parts: string[] = [];
  const put = (k: string, v: string) => parts.push(`${k}=${encodeURIComponent(v)}`);
  if (query.charter !== 'all') put('charter', query.charter);
  if (query.range !== 'all') put('range', query.range);
  if (query.range === 'custom' && query.from && query.to) {
    put('from', query.from);
    put('to', query.to);
  }
  if (!sameGroups(query.statusGroups, DEFAULT_BOOK_REPORT_STATUS_GROUPS)) {
    put(
      'status',
      BOOK_REPORT_STATUS_GROUP_KEYS.filter((g) => query.statusGroups.includes(g)).join(','),
    );
  }
  if (query.warehouse !== 'default') {
    put('warehouse', query.warehouse);
    if (query.warehouseFromView && isUuid(query.warehouse)) put('wview', '1');
  }
  if (query.category !== 'all') put('category', query.category);
  if (query.q) put('q', query.q);
  if (query.sort !== 'copies') put('sort', query.sort);
  if (opts.includePage !== false && query.page > 1) put('page', String(query.page));
  return parts.join('&');
}

export type BookReportWarehouseSource = 'view' | 'explicit' | 'all';

/** The warehouse the server resolved for a request: a concrete id (or null
 *  for all) and where it came from. */
export interface ResolvedBookReportWarehouse {
  id: string | null;
  source: BookReportWarehouseSource;
}

/**
 * The query every follow-up request is built from (page links, sorts, the
 * drill-down, exports): the warehouse replaced by the concrete id the server
 * used, or 'all'. It never carries 'default', so a row, its drill-down and
 * its export always use the same warehouse even if the person's warehouse
 * view changes meanwhile.
 */
export function resolvedBookReportQuery(
  query: BookReportQuery,
  resolved: ResolvedBookReportWarehouse,
): BookReportQuery {
  return {
    ...query,
    statusGroups: [...query.statusGroups],
    warehouse: resolved.id ?? 'all',
    warehouseFromView: resolved.id !== null && resolved.source === 'view',
  };
}

/** A stable key for remembered answers and fetch dedupe: the canonical
 *  serialization with the page (and warehouse) always written. */
export function bookReportQueryKey(query: BookReportQuery): string {
  const base = serializeBookReportQuery({ ...query, page: 1 }, { includePage: false });
  return `${base}${base ? '&' : ''}page=${query.page}`;
}

// ── Page-reset rules, Clear filters and chip removal ───────────────────────

/** A filter change: the new values and page 1 (a new filter always starts at
 *  the first page; brief 9: charter, dates, search and status all reset the
 *  page). The status list is copied, never shared. */
export function bookReportWithFilter(
  query: BookReportQuery,
  patch: Partial<Omit<BookReportQuery, 'page'>>,
): BookReportQuery {
  return {
    ...query,
    ...patch,
    statusGroups: [...(patch.statusGroups ?? query.statusGroups)],
    page: 1,
  };
}

/** The same report on another page: every filter kept. */
export function bookReportWithPage(query: BookReportQuery, page: number): BookReportQuery {
  const p = Number.isFinite(page) ? Math.max(1, Math.trunc(page)) : 1;
  return { ...query, statusGroups: [...query.statusGroups], page: p };
}

/** The filters a chip stands for (sort is not a filter and has no chip). */
export type BookReportFilterKey = 'charter' | 'dates' | 'status' | 'warehouse' | 'category' | 'q';

export const BOOK_REPORT_FILTER_KEYS: readonly BookReportFilterKey[] = [
  'charter',
  'dates',
  'status',
  'warehouse',
  'category',
  'q',
];

/**
 * The query with ONE filter back at its default, on page 1. Every value is
 * written out (never left to a spread), so removing the dates also clears
 * `from` and `to`, and removing the warehouse also drops the view label.
 * The warehouse goes back to 'default': the person's warehouse view on the
 * web, as when the page opened.
 */
export function bookReportWithoutFilter(
  query: BookReportQuery,
  key: BookReportFilterKey,
): BookReportQuery {
  switch (key) {
    case 'charter':
      return bookReportWithFilter(query, { charter: 'all' });
    case 'dates':
      return bookReportWithFilter(query, { range: 'all', from: null, to: null });
    case 'status':
      return bookReportWithFilter(query, { statusGroups: [...DEFAULT_BOOK_REPORT_STATUS_GROUPS] });
    case 'warehouse':
      return bookReportWithFilter(query, { warehouse: 'default', warehouseFromView: false });
    case 'category':
      return bookReportWithFilter(query, { category: 'all' });
    case 'q':
      return bookReportWithFilter(query, { q: '' });
  }
}

/**
 * Clear filters (plan D14): charter, dates, status, warehouse (back to the
 * warehouse view), category and search go back to their defaults, page 1.
 * Sort is kept: it is not a filter.
 */
export function bookReportClearedQuery(query: BookReportQuery): BookReportQuery {
  return {
    ...DEFAULT_BOOK_REPORT_QUERY,
    statusGroups: [...DEFAULT_BOOK_REPORT_STATUS_GROUPS],
    sort: query.sort,
    page: 1,
  };
}

/**
 * Whether a filter differs from its default, judged on the query alone. The
 * warehouse counts only when it was CHOSEN (a uuid that did not come from the
 * warehouse view): 'all' and a view warehouse are not something to remove.
 */
export function bookReportFilterIsSet(query: BookReportQuery, key: BookReportFilterKey): boolean {
  switch (key) {
    case 'charter':
      return query.charter !== 'all';
    case 'dates':
      return query.range !== 'all';
    case 'status':
      return !isDefaultStatusGroups(query.statusGroups);
    case 'warehouse':
      return isUuid(query.warehouse) && !query.warehouseFromView;
    case 'category':
      return query.category !== 'all';
    case 'q':
      return query.q.trim() !== '';
  }
}

/** The filter half of the query as the database takes it (the web service
 *  adds the organization and the resolved warehouse). `charterId` and
 *  `noCharter` are the ORDER's charter; the service sends p_charter_id and
 *  p_no_charter only when they are used (plan D18). */
export interface BookReportFilterArgs {
  charterId: string | null;
  noCharter: boolean;
  range: BookReportRange;
  from: string | null;
  to: string | null;
  statuses: OrderStatusKey[];
  categoryId: string | null;
  uncategorized: boolean;
  search: string | null;
  isbnKeys: string[] | null;
  sort: BookReportSort;
  page: number;
}

export function bookReportFilterArgs(query: BookReportQuery): BookReportFilterArgs {
  const q = query.q.trim();
  return {
    charterId: isUuid(query.charter) ? query.charter.toLowerCase() : null,
    noCharter: query.charter === 'none',
    range: query.range,
    from: query.range === 'custom' ? query.from : null,
    to: query.range === 'custom' ? query.to : null,
    statuses: statusesForGroups(query.statusGroups),
    categoryId: isUuid(query.category) ? query.category : null,
    uncategorized: query.category === 'none',
    search: q ? q : null,
    isbnKeys: q ? isbnSearchKeys(q) : null,
    sort: query.sort,
    page: query.page,
  };
}

// ── Answers (strict parsers) ────────────────────────────────────────────────

export class BookReportShapeError extends Error {
  constructor(
    public readonly path: string,
    reason: string,
  ) {
    super(`Book Order Totals answer: ${path} ${reason}`);
    this.name = 'BookReportShapeError';
  }
}

type Rec = Record<string, unknown>;
const QTY_RE = /^-?\d+(\.\d+)?$/;
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_DT_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;

function rec(v: unknown, path: string): Rec {
  if (!v || typeof v !== 'object' || Array.isArray(v))
    throw new BookReportShapeError(path, 'is not an object');
  return v as Rec;
}
function arr(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v)) throw new BookReportShapeError(path, 'is not an array');
  return v;
}
function str(v: unknown, path: string): string {
  if (typeof v !== 'string') throw new BookReportShapeError(path, 'is not a string');
  return v;
}
function strOrNull(v: unknown, path: string): string | null {
  if (v === null || v === undefined) return null;
  return str(v, path);
}
function bool(v: unknown, path: string): boolean {
  if (typeof v !== 'boolean') throw new BookReportShapeError(path, 'is not a boolean');
  return v;
}
function int(v: unknown, path: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
    throw new BookReportShapeError(path, 'is not a whole number');
  }
  return v;
}
function intOrNull(v: unknown, path: string): number | null {
  if (v === null || v === undefined) return null;
  return int(v, path);
}
function qty(v: unknown, path: string): string {
  const s = str(v, path);
  if (!QTY_RE.test(s)) throw new BookReportShapeError(path, 'is not an exact quantity');
  return s;
}
function ymdOrNull(v: unknown, path: string): string | null {
  if (v === null || v === undefined) return null;
  const s = str(v, path);
  if (!YMD_RE.test(s)) throw new BookReportShapeError(path, 'is not a YYYY-MM-DD date');
  return s;
}
function instantOrNull(v: unknown, path: string): string | null {
  if (v === null || v === undefined) return null;
  const s = str(v, path);
  if (Number.isNaN(Date.parse(s))) throw new BookReportShapeError(path, 'is not an instant');
  return s;
}
function version(o: Rec, path: string): 1 {
  if (o.v !== BOOK_ORDER_TOTALS_VERSION) throw new BookReportShapeError(`${path}.v`, 'is not 1');
  return 1;
}

export interface BookReportRangeEcho {
  key: BookReportRange;
  from: string | null;
  to: string | null;
  timeZone: string;
  timeZoneFallback: boolean;
}

export interface BookReportWarehouseEcho {
  id: string;
  name: string;
  status: string;
}

export interface BookReportCategoryEcho {
  id: string;
  name: string;
  deleted: boolean;
}

/** The ORDER charter an answer is for (0382). Only id, name, code and status
 *  ever leave the database: never an address or a contact. */
export interface BookReportCharterEcho {
  id: string;
  name: string;
  code: string | null;
  status: string;
}

/**
 * The charter half of an answer's `filters` (0382). Each key is `undefined`
 * when the answer does not carry it at all (a server before 0382), which is
 * different from `charter: null` (all charters, or No charter) and
 * `noCharter: false`.
 */
export interface BookReportCharterFilters {
  charter?: BookReportCharterEcho | null;
  noCharter?: boolean;
}

/** One line of "Books ordered by charter": a charter (id null: No charter),
 *  its copies in single-copy units (exact text, as summary.copies) and its
 *  distinct orders. The rows partition the summary: copies add up to
 *  summary.copies and orders to summary.orders. */
export interface BookReportCharterTotal {
  id: string | null;
  name: string | null;
  code: string | null;
  status: string | null;
  copies: string;
  orders: number;
}

export interface BookReportSummary {
  /** Copies requested on eligible lines in single-copy units (exact text). */
  copies: string;
  /** Distinct book entries (inventory records), every unit. */
  entries: number;
  /** Distinct orders containing an eligible book line. */
  orders: number;
  lines: number;
  firstOrderAt: string | null;
  lastOrderAt: string | null;
  firstOrderDate: string | null;
  lastOrderDate: string | null;
  /** Entries in another unit, and their quantity: left out of `copies`. */
  unresolved: { entries: number; quantity: string };
}

export interface BookReportRow {
  itemId: string;
  name: string;
  sku: string | null;
  identifier: string | null;
  binLocation: string | null;
  unit: string | null;
  countsAsCopies: boolean;
  warehouseId: string | null;
  warehouseName: string | null;
  itemStatus: string;
  deleted: boolean;
  nowRental: boolean;
  copies: string;
  orders: number;
  lines: number;
  latestOrderAt: string | null;
  latestOrderDate: string | null;
  fulfilled: string;
  returned: string;
}

export interface BookOrderTotalsAnswer {
  v: 1;
  generatedAt: string;
  generatedAtLocal: string;
  range: BookReportRangeEcho;
  statuses: string[];
  filters: BookReportCharterFilters & {
    warehouse: BookReportWarehouseEcho | null;
    category: BookReportCategoryEcho | null;
    uncategorized: boolean;
  };
  scope: { restricted: boolean };
  summary: BookReportSummary;
  totalCount: number;
  mode: 'page' | 'all';
  tooMany: boolean;
  maxRows: number | null;
  page: number;
  pageSize: number | null;
  sort: BookReportSort;
  rows: BookReportRow[];
  /** "Books ordered by charter" (0382): present only in page mode with All
   *  charters chosen; null when not computed; `undefined` from a server
   *  before 0382. */
  byCharter?: BookReportCharterTotal[] | null;
}

/** The API answer: the SQL answer plus the organization it is for and where
 *  its warehouse came from. */
export interface BookOrderTotalsResponse extends BookOrderTotalsAnswer {
  organizationId: string;
  warehouse: ResolvedBookReportWarehouse;
}

function parseRangeEcho(v: unknown, path: string): BookReportRangeEcho {
  const o = rec(v, path);
  const key = str(o.key, `${path}.key`);
  if (!(BOOK_REPORT_RANGES as readonly string[]).includes(key)) {
    throw new BookReportShapeError(`${path}.key`, 'is not a range');
  }
  return {
    key: key as BookReportRange,
    from: ymdOrNull(o.from, `${path}.from`),
    to: ymdOrNull(o.to, `${path}.to`),
    timeZone: str(o.timeZone, `${path}.timeZone`),
    timeZoneFallback: bool(o.timeZoneFallback, `${path}.timeZoneFallback`),
  };
}

function parseWarehouseEcho(v: unknown, path: string): BookReportWarehouseEcho | null {
  if (v === null || v === undefined) return null;
  const o = rec(v, path);
  return {
    id: str(o.id, `${path}.id`),
    name: str(o.name, `${path}.name`),
    status: str(o.status, `${path}.status`),
  };
}

function parseCategoryEcho(v: unknown, path: string): BookReportCategoryEcho | null {
  if (v === null || v === undefined) return null;
  const o = rec(v, path);
  return {
    id: str(o.id, `${path}.id`),
    name: str(o.name, `${path}.name`),
    deleted: bool(o.deleted, `${path}.deleted`),
  };
}

function parseCharterEcho(v: unknown, path: string): BookReportCharterEcho | null {
  if (v === null) return null;
  const o = rec(v, path);
  return {
    id: str(o.id, `${path}.id`),
    name: str(o.name, `${path}.name`),
    code: strOrNull(o.code, `${path}.code`),
    status: str(o.status, `${path}.status`),
  };
}

/** The charter keys of `filters`, strictly when present, left out when
 *  absent (an older server), so the echo check can tell the two apart. */
function parseCharterFilters(filters: Rec, path: string): BookReportCharterFilters {
  const out: BookReportCharterFilters = {};
  if (filters.charter !== undefined) {
    out.charter = parseCharterEcho(filters.charter, `${path}.charter`);
  }
  if (filters.noCharter !== undefined) {
    out.noCharter = bool(filters.noCharter, `${path}.noCharter`);
  }
  return out;
}

function parseByCharter(v: unknown, path: string): BookReportCharterTotal[] | null {
  if (v === null) return null;
  return arr(v, path).map((x, i) => {
    const p = `${path}[${i}]`;
    const o = rec(x, p);
    return {
      id: strOrNull(o.id, `${p}.id`),
      name: strOrNull(o.name, `${p}.name`),
      code: strOrNull(o.code, `${p}.code`),
      status: strOrNull(o.status, `${p}.status`),
      copies: qty(o.copies, `${p}.copies`),
      orders: int(o.orders, `${p}.orders`),
    };
  });
}

function parseLocalDateTime(v: unknown, path: string): string {
  const s = str(v, path);
  if (!LOCAL_DT_RE.test(s)) throw new BookReportShapeError(path, 'is not a YYYY-MM-DD HH:MI time');
  return s;
}

function parseStatuses(v: unknown, path: string): string[] {
  return arr(v, path).map((s, i) => str(s, `${path}[${i}]`));
}

function parseRow(v: unknown, path: string): BookReportRow {
  const o = rec(v, path);
  return {
    itemId: str(o.itemId, `${path}.itemId`),
    name: str(o.name, `${path}.name`),
    sku: strOrNull(o.sku, `${path}.sku`),
    identifier: strOrNull(o.identifier, `${path}.identifier`),
    binLocation: strOrNull(o.binLocation, `${path}.binLocation`),
    unit: strOrNull(o.unit, `${path}.unit`),
    countsAsCopies: bool(o.countsAsCopies, `${path}.countsAsCopies`),
    warehouseId: strOrNull(o.warehouseId, `${path}.warehouseId`),
    warehouseName: strOrNull(o.warehouseName, `${path}.warehouseName`),
    itemStatus: str(o.itemStatus, `${path}.itemStatus`),
    deleted: bool(o.deleted, `${path}.deleted`),
    nowRental: bool(o.nowRental, `${path}.nowRental`),
    copies: qty(o.copies, `${path}.copies`),
    orders: int(o.orders, `${path}.orders`),
    lines: int(o.lines, `${path}.lines`),
    latestOrderAt: instantOrNull(o.latestOrderAt, `${path}.latestOrderAt`),
    latestOrderDate: ymdOrNull(o.latestOrderDate, `${path}.latestOrderDate`),
    fulfilled: qty(o.fulfilled, `${path}.fulfilled`),
    returned: qty(o.returned, `${path}.returned`),
  };
}

function parseWarehouseResolution(v: unknown, path: string): ResolvedBookReportWarehouse {
  const o = rec(v, path);
  const source = str(o.source, `${path}.source`);
  if (source !== 'view' && source !== 'explicit' && source !== 'all') {
    throw new BookReportShapeError(`${path}.source`, 'is not view, explicit or all');
  }
  return { id: strOrNull(o.id, `${path}.id`), source };
}

/** Parse book_order_totals' answer (the SQL shape). Throws on a wrong shape. */
export function parseBookOrderTotalsAnswer(raw: unknown): BookOrderTotalsAnswer {
  const o = rec(raw, 'totals');
  version(o, 'totals');
  const filters = rec(o.filters, 'totals.filters');
  const scope = rec(o.scope, 'totals.scope');
  const s = rec(o.summary, 'totals.summary');
  const unresolved = rec(s.unresolved, 'totals.summary.unresolved');
  const mode = str(o.mode, 'totals.mode');
  if (mode !== 'page' && mode !== 'all')
    throw new BookReportShapeError('totals.mode', 'is not page or all');
  const sort = str(o.sort, 'totals.sort');
  if (!(BOOK_REPORT_SORTS as readonly string[]).includes(sort)) {
    throw new BookReportShapeError('totals.sort', 'is not a sort');
  }
  const rows = arr(o.rows, 'totals.rows').map((r, i) => parseRow(r, `totals.rows[${i}]`));
  const answer: BookOrderTotalsAnswer = {
    v: 1,
    generatedAt: str(o.generatedAt, 'totals.generatedAt'),
    generatedAtLocal: parseLocalDateTime(o.generatedAtLocal, 'totals.generatedAtLocal'),
    range: parseRangeEcho(o.range, 'totals.range'),
    statuses: parseStatuses(o.statuses, 'totals.statuses'),
    filters: {
      warehouse: parseWarehouseEcho(filters.warehouse, 'totals.filters.warehouse'),
      category: parseCategoryEcho(filters.category, 'totals.filters.category'),
      uncategorized: bool(filters.uncategorized, 'totals.filters.uncategorized'),
      ...parseCharterFilters(filters, 'totals.filters'),
    },
    scope: { restricted: bool(scope.restricted, 'totals.scope.restricted') },
    summary: {
      copies: qty(s.copies, 'totals.summary.copies'),
      entries: int(s.entries, 'totals.summary.entries'),
      orders: int(s.orders, 'totals.summary.orders'),
      lines: int(s.lines, 'totals.summary.lines'),
      firstOrderAt: instantOrNull(s.firstOrderAt, 'totals.summary.firstOrderAt'),
      lastOrderAt: instantOrNull(s.lastOrderAt, 'totals.summary.lastOrderAt'),
      firstOrderDate: ymdOrNull(s.firstOrderDate, 'totals.summary.firstOrderDate'),
      lastOrderDate: ymdOrNull(s.lastOrderDate, 'totals.summary.lastOrderDate'),
      unresolved: {
        entries: int(unresolved.entries, 'totals.summary.unresolved.entries'),
        quantity: qty(unresolved.quantity, 'totals.summary.unresolved.quantity'),
      },
    },
    totalCount: int(o.totalCount, 'totals.totalCount'),
    mode,
    tooMany: bool(o.tooMany, 'totals.tooMany'),
    maxRows: intOrNull(o.maxRows, 'totals.maxRows'),
    page: int(o.page, 'totals.page'),
    pageSize: intOrNull(o.pageSize, 'totals.pageSize'),
    sort: sort as BookReportSort,
    rows,
  };
  if (o.byCharter !== undefined) answer.byCharter = parseByCharter(o.byCharter, 'totals.byCharter');
  if (answer.page < 1) throw new BookReportShapeError('totals.page', 'is below 1');
  return answer;
}

/** Parse the API answer (the SQL shape plus organizationId and warehouse). */
export function parseBookOrderTotalsResponse(raw: unknown): BookOrderTotalsResponse {
  const o = rec(raw, 'totals');
  const answer = parseBookOrderTotalsAnswer(o);
  return {
    ...answer,
    organizationId: str(o.organizationId, 'totals.organizationId'),
    warehouse: parseWarehouseResolution(o.warehouse, 'totals.warehouse'),
  };
}

export interface BookReportBook {
  itemId: string;
  name: string;
  sku: string | null;
  identifier: string | null;
  binLocation: string | null;
  unit: string | null;
  countsAsCopies: boolean;
  warehouseId: string | null;
  warehouseName: string | null;
  itemStatus: string;
  deleted: boolean;
  nowRental: boolean;
}

export interface BookReportOrderRowBase {
  orderId: string;
  orderNumber: number | null;
  createdAt: string;
  orderDate: string;
  status: string;
  warehouseId: string;
  warehouseName: string | null;
  copies: string;
  fulfilled: string;
  returned: string;
  /** Lines of this book on this order, combined into this row. */
  lines: number;
  /** Their line ids, kept for audit. */
  lineIds: string[];
  /** The order's charter (0382; null for a pickup or an order saved without
   *  one). `undefined` from a server before 0382. */
  charterId?: string | null;
  charterName?: string | null;
  charterCode?: string | null;
}

/** SQL's drill-down row: `mine` says whether the caller placed the order. */
export interface BookReportOrderRow extends BookReportOrderRowBase {
  mine: boolean;
}

/** The API's drill-down row: `openable` says whether the caller may open it
 *  (orders:approve, or their own request). `mine` is not passed on. */
export interface BookReportOrderRowOut extends BookReportOrderRowBase {
  openable: boolean;
}

export interface BookReportOrdersAnswerBase {
  v: 1;
  generatedAt: string;
  generatedAtLocal: string;
  found: boolean;
  book: BookReportBook | null;
  range: BookReportRangeEcho;
  statuses: string[];
  filters: BookReportCharterFilters & { warehouse: BookReportWarehouseEcho | null };
  totals: { copies: string; orders: number; lines: number; fulfilled: string; returned: string };
  totalCount: number;
  page: number;
  pageSize: number;
}

export interface BookOrderOrdersAnswer extends BookReportOrdersAnswerBase {
  rows: BookReportOrderRow[];
}

export interface BookOrderOrdersResponse extends BookReportOrdersAnswerBase {
  organizationId: string;
  warehouse: ResolvedBookReportWarehouse;
  rows: BookReportOrderRowOut[];
}

function parseBook(v: unknown, path: string): BookReportBook | null {
  if (v === null || v === undefined) return null;
  const o = rec(v, path);
  return {
    itemId: str(o.itemId, `${path}.itemId`),
    name: str(o.name, `${path}.name`),
    sku: strOrNull(o.sku, `${path}.sku`),
    identifier: strOrNull(o.identifier, `${path}.identifier`),
    binLocation: strOrNull(o.binLocation, `${path}.binLocation`),
    unit: strOrNull(o.unit, `${path}.unit`),
    countsAsCopies: bool(o.countsAsCopies, `${path}.countsAsCopies`),
    warehouseId: strOrNull(o.warehouseId, `${path}.warehouseId`),
    warehouseName: strOrNull(o.warehouseName, `${path}.warehouseName`),
    itemStatus: str(o.itemStatus, `${path}.itemStatus`),
    deleted: bool(o.deleted, `${path}.deleted`),
    nowRental: bool(o.nowRental, `${path}.nowRental`),
  };
}

function parseOrderRowBase(o: Rec, path: string): BookReportOrderRowBase {
  const orderDate = ymdOrNull(o.orderDate, `${path}.orderDate`);
  if (orderDate === null) throw new BookReportShapeError(`${path}.orderDate`, 'is missing');
  const createdAt = instantOrNull(o.createdAt, `${path}.createdAt`);
  if (createdAt === null) throw new BookReportShapeError(`${path}.createdAt`, 'is missing');
  const charter: Pick<BookReportOrderRowBase, 'charterId' | 'charterName' | 'charterCode'> = {};
  if (o.charterId !== undefined) charter.charterId = strOrNull(o.charterId, `${path}.charterId`);
  if (o.charterName !== undefined) {
    charter.charterName = strOrNull(o.charterName, `${path}.charterName`);
  }
  if (o.charterCode !== undefined) {
    charter.charterCode = strOrNull(o.charterCode, `${path}.charterCode`);
  }
  return {
    orderId: str(o.orderId, `${path}.orderId`),
    orderNumber: intOrNull(o.orderNumber, `${path}.orderNumber`),
    createdAt,
    orderDate,
    status: str(o.status, `${path}.status`),
    warehouseId: str(o.warehouseId, `${path}.warehouseId`),
    warehouseName: strOrNull(o.warehouseName, `${path}.warehouseName`),
    copies: qty(o.copies, `${path}.copies`),
    fulfilled: qty(o.fulfilled, `${path}.fulfilled`),
    returned: qty(o.returned, `${path}.returned`),
    lines: int(o.lines, `${path}.lines`),
    lineIds: arr(o.lineIds, `${path}.lineIds`).map((x, i) => str(x, `${path}.lineIds[${i}]`)),
    ...charter,
  };
}

function parseOrdersBase(o: Rec, path: string): BookReportOrdersAnswerBase {
  version(o, path);
  const t = rec(o.totals, `${path}.totals`);
  const filters = rec(o.filters, `${path}.filters`);
  const found = bool(o.found, `${path}.found`);
  const book = parseBook(o.book, `${path}.book`);
  if (found && !book) throw new BookReportShapeError(`${path}.book`, 'is missing for a found book');
  return {
    v: 1,
    generatedAt: str(o.generatedAt, `${path}.generatedAt`),
    generatedAtLocal: parseLocalDateTime(o.generatedAtLocal, `${path}.generatedAtLocal`),
    found,
    book,
    range: parseRangeEcho(o.range, `${path}.range`),
    statuses: parseStatuses(o.statuses, `${path}.statuses`),
    filters: {
      warehouse: parseWarehouseEcho(filters.warehouse, `${path}.filters.warehouse`),
      ...parseCharterFilters(filters, `${path}.filters`),
    },
    totals: {
      copies: qty(t.copies, `${path}.totals.copies`),
      orders: int(t.orders, `${path}.totals.orders`),
      lines: int(t.lines, `${path}.totals.lines`),
      fulfilled: qty(t.fulfilled, `${path}.totals.fulfilled`),
      returned: qty(t.returned, `${path}.totals.returned`),
    },
    totalCount: int(o.totalCount, `${path}.totalCount`),
    page: int(o.page, `${path}.page`),
    pageSize: int(o.pageSize, `${path}.pageSize`),
  };
}

/** Parse book_order_totals_orders' answer (the SQL shape, rows with `mine`). */
export function parseBookOrderOrdersAnswer(raw: unknown): BookOrderOrdersAnswer {
  const o = rec(raw, 'orders');
  const base = parseOrdersBase(o, 'orders');
  return {
    ...base,
    rows: arr(o.rows, 'orders.rows').map((r, i) => {
      const p = `orders.rows[${i}]`;
      const row = rec(r, p);
      return { ...parseOrderRowBase(row, p), mine: bool(row.mine, `${p}.mine`) };
    }),
  };
}

/** Parse the API's drill-down answer (rows with `openable`, no `mine`). */
export function parseBookOrderOrdersResponse(raw: unknown): BookOrderOrdersResponse {
  const o = rec(raw, 'orders');
  const base = parseOrdersBase(o, 'orders');
  return {
    ...base,
    organizationId: str(o.organizationId, 'orders.organizationId'),
    warehouse: parseWarehouseResolution(o.warehouse, 'orders.warehouse'),
    rows: arr(o.rows, 'orders.rows').map((r, i) => {
      const p = `orders.rows[${i}]`;
      const row = rec(r, p);
      return { ...parseOrderRowBase(row, p), openable: bool(row.openable, `${p}.openable`) };
    }),
  };
}

export interface BookReportOptionWarehouse {
  id: string;
  name: string;
  status: string;
}

export interface BookReportOptionCategory {
  id: string;
  name: string;
  deleted: boolean;
}

/** A charter the caller may report on (0382): active ones first, then by
 *  name. Inactive and archived ones are listed only when they have visible
 *  book orders. */
export interface BookReportOptionCharter {
  id: string;
  name: string;
  code: string | null;
  status: string;
}

export interface BookOrderOptionsAnswer {
  v: 1;
  warehouses: BookReportOptionWarehouse[];
  categories: BookReportOptionCategory[];
  uncategorized: boolean;
  /** Absent from a server before 0382: then []. */
  charters: BookReportOptionCharter[];
  /** Visible book orders with no charter exist. Absent before 0382: false. */
  noCharter: boolean;
  orderStatusConfig: unknown;
}

/** The API's options: the SQL answer with the organization's status labels
 *  resolved (and the raw config left out). */
export interface BookOrderOptionsResponse {
  v: 1;
  organizationId: string;
  warehouses: BookReportOptionWarehouse[];
  categories: BookReportOptionCategory[];
  uncategorized: boolean;
  charters: BookReportOptionCharter[];
  noCharter: boolean;
  statusLabels: Record<OrderStatusKey, string>;
}

function parseOptionLists(o: Rec, path: string) {
  return {
    warehouses: arr(o.warehouses, `${path}.warehouses`).map((w, i) => {
      const p = `${path}.warehouses[${i}]`;
      const x = rec(w, p);
      return {
        id: str(x.id, `${p}.id`),
        name: str(x.name, `${p}.name`),
        status: str(x.status, `${p}.status`),
      };
    }),
    categories: arr(o.categories, `${path}.categories`).map((c, i) => {
      const p = `${path}.categories[${i}]`;
      const x = rec(c, p);
      return {
        id: str(x.id, `${p}.id`),
        name: str(x.name, `${p}.name`),
        deleted: bool(x.deleted, `${p}.deleted`),
      };
    }),
    uncategorized: bool(o.uncategorized, `${path}.uncategorized`),
    charters:
      o.charters === undefined
        ? []
        : arr(o.charters, `${path}.charters`).map((c, i) => {
            const p = `${path}.charters[${i}]`;
            const x = rec(c, p);
            return {
              id: str(x.id, `${p}.id`),
              name: str(x.name, `${p}.name`),
              code: strOrNull(x.code, `${p}.code`),
              status: str(x.status, `${p}.status`),
            };
          }),
    noCharter: o.noCharter === undefined ? false : bool(o.noCharter, `${path}.noCharter`),
  };
}

/** Parse book_order_totals_options' answer (the SQL shape). */
export function parseBookOrderOptionsAnswer(raw: unknown): BookOrderOptionsAnswer {
  const o = rec(raw, 'options');
  version(o, 'options');
  return {
    v: 1,
    ...parseOptionLists(o, 'options'),
    orderStatusConfig: o.orderStatusConfig ?? null,
  };
}

/** Parse the API's options answer. */
export function parseBookOrderOptionsResponse(raw: unknown): BookOrderOptionsResponse {
  const o = rec(raw, 'options');
  version(o, 'options');
  const labels = rec(o.statusLabels, 'options.statusLabels');
  const statusLabels = {} as Record<OrderStatusKey, string>;
  for (const key of ORDER_STATUS_KEYS)
    statusLabels[key] = str(labels[key], `options.statusLabels.${key}`);
  return {
    v: 1,
    organizationId: str(o.organizationId, 'options.organizationId'),
    ...parseOptionLists(o, 'options'),
    statusLabels,
  };
}

/**
 * Whether an answer is for the charter the query asked for (plan 3.2). The
 * phone and the web drawer refuse an answer that fails this, so figures are
 * never shown under a charter they are not for:
 *   - 'all'  needs no charter echo (`charter` null or absent) and `noCharter`
 *     not true;
 *   - 'none' needs `noCharter === true` and no charter echo;
 *   - a uuid needs `charter.id` equal to it (case aside) and `noCharter` not
 *     true.
 * An answer that carries NEITHER key (a server before 0382) is accepted only
 * for 'all': a charter request answered by such a server would be
 * organization-wide figures.
 */
export function bookReportCharterEchoMatches(
  query: Pick<BookReportQuery, 'charter'>,
  filters: BookReportCharterFilters | null | undefined,
): boolean {
  const echo = filters?.charter;
  const noCharter = filters?.noCharter;
  if (query.charter === 'all') return (echo === null || echo === undefined) && noCharter !== true;
  if (query.charter === 'none') return noCharter === true && (echo === null || echo === undefined);
  if (!isUuid(query.charter)) return false;
  return (
    echo !== null &&
    echo !== undefined &&
    echo.id.toLowerCase() === query.charter.toLowerCase() &&
    noCharter !== true
  );
}

/** Every status's label as this organization shows it on the Orders page. */
export function bookReportStatusLabels(orderStatusConfig: unknown): Record<OrderStatusKey, string> {
  const meta = resolveOrderStatusConfig(orderStatusConfig as OrderStatusConfig | null);
  const out = {} as Record<OrderStatusKey, string>;
  for (const key of ORDER_STATUS_KEYS) out[key] = meta[key].label;
  return out;
}

// ── Formatting (no zone conversion anywhere) ────────────────────────────────

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;
const MONTHS_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * An exact quantity string ('1234', '12.3456') for people: thousands
 * grouped, up to 4 decimals (rounded half up at the 5th), trailing zeros
 * dropped. Pure string arithmetic, so a quantity is never rounded at 3
 * decimals the way the default Intl formatter does, and never passes
 * through a float.
 */
export function formatReportQuantity(text: string): string {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!m) return text;
  const sign = m[1] ?? '';
  let intPart = m[2]!.replace(/^0+(?=\d)/, '');
  let frac = m[3] ?? '';
  if (frac.length > 4) {
    const roundUp = Number(frac[4]) >= 5;
    frac = frac.slice(0, 4);
    if (roundUp) {
      const joined = BigInt(intPart + frac) + 1n;
      const s = joined.toString().padStart(intPart.length + 4, '0');
      intPart = s.slice(0, s.length - 4) || '0';
      frac = s.slice(s.length - 4);
    }
  }
  frac = frac.replace(/0+$/, '');
  const isZero = /^0*$/.test(intPart) && frac === '';
  return `${isZero ? '' : sign}${groupThousands(intPart)}${frac ? `.${frac}` : ''}`;
}

/**
 * Exact sum of quantity strings ('1.5' + '2.25' = '3.75'), in the database's
 * trim_scale form (no trailing zeros, '0' for zero). BigInt arithmetic, never
 * a float, so a server-side self-check can compare a sum of rows with the
 * summary SQL computed. Throws on a value that is not a quantity.
 */
export function sumReportQuantities(values: readonly string[]): string {
  const parsed = values.map((v) => {
    const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(v.trim());
    if (!m)
      throw new BookReportShapeError('quantity', `${JSON.stringify(v)} is not an exact quantity`);
    return { neg: m[1] === '-', int: m[2]!, frac: m[3] ?? '' };
  });
  const scale = parsed.reduce((max, p) => Math.max(max, p.frac.length), 0);
  let total = 0n;
  for (const p of parsed) {
    const units = BigInt(p.int + p.frac.padEnd(scale, '0'));
    total += p.neg ? -units : units;
  }
  const neg = total < 0n;
  const digits = (neg ? -total : total).toString().padStart(scale + 1, '0');
  const intPart = digits.slice(0, digits.length - scale) || '0';
  const frac = scale > 0 ? digits.slice(digits.length - scale).replace(/0+$/, '') : '';
  const out = frac ? `${intPart}.${frac}` : intPart;
  return neg && out !== '0' ? `-${out}` : out;
}

/** 'YYYY-MM-DD' (org-local, from SQL) -> 'Sep 20, 2026'. */
export function formatReportDate(ymd: string | null | undefined): string {
  if (!ymd) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return ymd;
  const month = MONTHS[Number(m[2]) - 1];
  if (!month) return ymd;
  return `${month} ${Number(m[3])}, ${m[1]}`;
}

/** 'YYYY-MM-DD' -> 'September 20, 2026' (for spoken labels). */
export function formatReportDateLong(ymd: string | null | undefined): string {
  if (!ymd) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return ymd;
  const month = MONTHS_LONG[Number(m[2]) - 1];
  if (!month) return ymd;
  return `${month} ${Number(m[3])}, ${m[1]}`;
}

/** Two org-local days as a range: 'Aug 30 – Sep 28, 2026' within one year,
 *  'Dec 1, 2025 – Jan 5, 2026' across years, one date when they are equal. */
export function formatReportDateRange(from: string | null, to: string | null): string {
  if (!from || !to) return formatReportDate(from ?? to);
  if (from === to) return formatReportDate(from);
  if (from.slice(0, 4) === to.slice(0, 4)) {
    const a = formatReportDate(from);
    return `${a.slice(0, a.lastIndexOf(','))} – ${formatReportDate(to)}`;
  }
  return `${formatReportDate(from)} – ${formatReportDate(to)}`;
}

/** 'YYYY-MM-DD HH:MI' (org-local, from SQL) -> '10:42 AM'. */
export function formatReportTime(local: string | null | undefined): string {
  if (!local) return '';
  const m = /^\d{4}-\d{2}-\d{2} (\d{2}):(\d{2})$/.exec(local);
  if (!m) return local;
  const h = Number(m[1]);
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${m[2]} ${h < 12 ? 'AM' : 'PM'}`;
}

/** 'YYYY-MM-DD HH:MI' -> 'Sep 28, 2026, 10:42 AM'. */
export function formatReportDateTime(local: string | null | undefined): string {
  if (!local) return '';
  const day = local.slice(0, 10);
  return `${formatReportDate(day)}, ${formatReportTime(local)}`;
}

export type BookReportIdentifierLabel = 'ISBN' | 'Barcode';

export interface BookReportRowIdentity {
  /** 'SKU BK-123', or null when the record has no SKU. */
  skuLabel: string | null;
  /** 'ISBN' when the identifier passes an ISBN checksum, else 'Barcode'. */
  identifierLabel: BookReportIdentifierLabel | null;
  identifier: string | null;
  /** 'DC4 · Rack 12-B', 'DC4', 'Rack 12-B' or ''. */
  place: string;
}

export function bookReportRowIdentity(row: {
  sku: string | null;
  identifier: string | null;
  warehouseName: string | null;
  binLocation: string | null;
}): BookReportRowIdentity {
  const sku = row.sku?.trim() || null;
  const identifier = row.identifier?.trim() || null;
  const bin = row.binLocation?.trim() || null;
  const place = [row.warehouseName?.trim() || null, bin ? `Rack ${bin}` : null]
    .filter(Boolean)
    .join(' · ');
  return {
    skuLabel: sku ? `SKU ${sku}` : null,
    identifierLabel: identifier ? (isValidIsbn(identifier) ? 'ISBN' : 'Barcode') : null,
    identifier,
    place,
  };
}

export interface BookReportIdentityPart {
  /** An SKU, ISBN/Barcode or rack label is one unit and is never broken
   *  across lines; a warehouse name may wrap. */
  kind: 'sku' | 'identifier' | 'warehouse' | 'rack';
  text: string;
}

/** The pieces of the identity line, in order, for a screen that lays each
 *  one out (keeping 'ISBN 978-0-14-044913-6' whole). Joined with ' · ' they
 *  are exactly formatBookReportIdentityLine. */
export function bookReportIdentityParts(row: {
  sku: string | null;
  identifier: string | null;
  warehouseName: string | null;
  binLocation: string | null;
}): BookReportIdentityPart[] {
  const id = bookReportRowIdentity(row);
  const warehouse = row.warehouseName?.trim() || null;
  const bin = row.binLocation?.trim() || null;
  const parts: BookReportIdentityPart[] = [];
  if (id.skuLabel) parts.push({ kind: 'sku', text: id.skuLabel });
  if (id.identifier && id.identifierLabel) {
    parts.push({ kind: 'identifier', text: `${id.identifierLabel} ${id.identifier}` });
  }
  if (warehouse) parts.push({ kind: 'warehouse', text: warehouse });
  if (bin) parts.push({ kind: 'rack', text: `Rack ${bin}` });
  return parts;
}

/** One line: 'SKU BK-123 · ISBN 9780140449136 · DC4 · Rack 12-B'. */
export function formatBookReportIdentityLine(row: {
  sku: string | null;
  identifier: string | null;
  warehouseName: string | null;
  binLocation: string | null;
}): string {
  return bookReportIdentityParts(row)
    .map((part) => part.text)
    .join(' · ');
}

/** The unit as people read it: the stored text trimmed, or 'no unit' for a
 *  blank one (a blank unit is never assumed to be copies). */
export function bookReportUnitLabel(unit: string | null | undefined): string {
  const u = (unit ?? '').trim();
  return u ? u : 'no unit';
}

export interface BookReportQuantityWording {
  countsAsCopies: boolean;
  /** The drill-down column heading. */
  column: string;
  /** The drill-down header's lead: 'Copies of this book requested' or
   *  'Quantity requested (pack of 10)'. */
  lead: string;
}

/** Copies wording only for single-copy units; any other unit is named. */
export function bookReportQuantityWording(row: {
  countsAsCopies: boolean;
  unit: string | null;
}): BookReportQuantityWording {
  if (row.countsAsCopies) {
    return {
      countsAsCopies: true,
      column: 'Copies of this book requested',
      lead: 'Copies of this book requested',
    };
  }
  const unit = bookReportUnitLabel(row.unit);
  return {
    countsAsCopies: false,
    column: `Quantity of this book requested (${unit})`,
    lead: `Quantity requested (${unit})`,
  };
}

/**
 * Where an order number in the drill-down leads, or null for plain text.
 * One rule for web and phone: a link only when `openable` (the caller holds
 * orders:approve, or placed the order). Anyone else sees the number without
 * a link, as the Orders list would show them only their own requests.
 *
 * `returnTo` (web only, plan D17): the report page to come back to, carried
 * as `?return=` so the order page can offer "Back to Book Order Totals". Only
 * a same-site path is carried (one leading slash, never `//` or `/\`); the
 * order page checks it again (safeReturnPath, then the report's own path)
 * before it renders anything from it. The phone's list stays mounted under
 * the order screen, so its link needs no way back.
 */
export function bookReportOrderLink(
  row: { openable: boolean; orderId: string },
  platform: 'web' | 'phone',
  returnTo?: string | null,
): string | null {
  if (!row.openable || !isUuid(row.orderId)) return null;
  if (platform === 'phone') return `/order/${row.orderId}`;
  const href = `/dashboard/orders/${row.orderId}`;
  if (typeof returnTo === 'string' && /^\/(?![/\\])/.test(returnTo)) {
    return `${href}?return=${encodeURIComponent(returnTo)}`;
  }
  return href;
}

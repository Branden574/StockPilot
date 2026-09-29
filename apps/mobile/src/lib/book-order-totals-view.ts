import {
  BOOK_COVER_PLACEHOLDER,
  BOOK_COVER_UNAVAILABLE,
  BOOK_REPORT_ALL_CATEGORIES,
  BOOK_REPORT_ALL_CHARTERS,
  BOOK_REPORT_ALL_WAREHOUSES,
  BOOK_REPORT_BY_CHARTER_UNITS_NOTE,
  BOOK_REPORT_CSV_MAX_ROWS,
  BOOK_REPORT_EXPORT_COVER_CAP_NOTE,
  BOOK_REPORT_EXPORT_CSV,
  BOOK_REPORT_EXPORT_PDF_COVERS,
  BOOK_REPORT_EXPORT_PDF_PLAIN,
  BOOK_REPORT_NO_CHARTER,
  BOOK_REPORT_NO_CHARTER_HINT,
  BOOK_REPORT_ORDER_COLUMNS,
  BOOK_REPORT_ORDER_LINK_HINT,
  BOOK_REPORT_PDF_COVER_CAP,
  BOOK_REPORT_PDF_MAX_ROWS,
  BOOK_REPORT_RANGE_LABELS,
  BOOK_REPORT_SHOWING,
  BOOK_REPORT_SORT_LABELS,
  BOOK_REPORT_STATUS_GROUP_KEYS,
  BOOK_REPORT_UI,
  CALENDAR_COPY,
  DEFAULT_BOOK_REPORT_QUERY,
  DEFAULT_BOOK_REPORT_STATUS_GROUPS,
  ROLES,
  bookReportActiveFilters,
  bookReportByCharterApplyLabel,
  bookReportByCharterTotalLine,
  bookReportByCharterValue,
  bookReportCharterEchoMatches,
  bookReportCharterOptionLabel,
  bookReportCharterOptionLabels,
  bookReportClearedQuery,
  bookReportFilterIsSet,
  bookReportOrderCharterText,
  bookReportOrderLink,
  bookReportRowBadges,
  bookReportRowIdentity,
  bookReportShowingParts,
  bookReportShowingStatus,
  bookReportStatusGroupLabel,
  bookReportTooManyText,
  bookReportWithFilter,
  calendarDayLabel,
  calendarDraftFrom,
  can,
  combinedLinesText,
  formatOrderNumber,
  formatReportDate,
  formatReportDateLong,
  formatReportQuantity,
  isUuid,
  latestOrderText,
  ordersCountText,
  parseBookReportQuery,
  rangeComplete,
  rowQuantityText,
  serializeBookReportQuery,
  validateCustomDate,
  type BookOrderOptionsResponse,
  type BookReportCharterEcho,
  type BookReportCharterFilters,
  type BookReportCharterTotal,
  type BookReportFilterKey,
  type BookReportFilterEchoes,
  type BookReportOrderRowOut,
  type BookReportQuery,
  type BookReportRange,
  type BookReportRangeEcho,
  type BookReportRow,
  type BookReportShowingAnswer,
  type BookReportStatusGroup,
  type BookReportWarehouseEcho,
  type CalendarMonth,
  type CalendarRangeDraft,
  type ModuleId,
  type OrderStatusKey,
  type Permission,
  type Role,
} from '@stockpilot/core';

/**
 * BOOK ORDER TOTALS on the phone: the pure decisions the two screens make
 * (plan section 9), kept out of app/ so they can be unit tested (vitest runs
 * src/** only; screens import native modules at load).
 *
 * Nothing here adds a number. Every total the screens show is a string or a
 * count the API returned (SQL is the only calculator, migrations 0379 and
 * 0382); these
 * helpers choose WHICH query to send, how a row is spoken and what an export
 * offers. The words are core's (book-order-totals-copy.ts) unless a sentence
 * is about the phone itself (a tap, a download, a connection).
 */

// ── Who sees the entry on the Reports screen ────────────────────────────────

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

/**
 * The "Book Order Totals" row on the shared Reports screen (drawer and the
 * optional Reports tab render the same screen, so both show it or neither).
 * It needs the orders AND books modules and reports:read: the effective set
 * once it has loaded (overrides included), before that the role's own
 * defaults, the same fallback the drawer uses. With neither known it stays
 * hidden rather than offering a report the server may refuse. Cosmetic: the
 * routes enforce the same rules.
 */
export function showBookReportEntry(input: {
  modules: ReadonlySet<ModuleId>;
  perms: ReadonlySet<Permission> | undefined;
  role: Role | null;
}): boolean {
  if (!input.modules.has('orders') || !input.modules.has('books')) return false;
  if (input.perms !== undefined) return input.perms.has('reports:read');
  if (input.role !== null) return can({ role: input.role }, 'reports:read');
  return false;
}

// ── The warehouse the report is for ─────────────────────────────────────────

/**
 * The query a request is built from: always a CONCRETE warehouse.
 *
 *   - `warehouse: 'default'` means "follow my warehouse view": the phone's
 *     active warehouse (the drawer header's choice, per organization) with
 *     `wview=1`, or `all` when the view is "All warehouses".
 *   - `'all'` or a uuid is an explicit choice from the filters sheet and is
 *     sent as it is; a later change of the warehouse view does not move it.
 *
 * The drill-down and the export are built from the query of the answer on
 * screen, so a row, its orders and the file always use the same warehouse.
 */
export function resolveBookReportRequest(
  query: BookReportQuery,
  activeWarehouseId: string | null,
): BookReportQuery {
  const base = { ...query, statusGroups: [...query.statusGroups] };
  if (query.warehouse === 'default') {
    return activeWarehouseId && isUuid(activeWarehouseId)
      ? { ...base, warehouse: activeWarehouseId.toLowerCase(), warehouseFromView: true }
      : { ...base, warehouse: 'all', warehouseFromView: false };
  }
  if (query.warehouse === 'all') return { ...base, warehouseFromView: false };
  return { ...base, warehouse: query.warehouse.toLowerCase(), warehouseFromView: false };
}

/**
 * Whether two queries ask for the same answer (every filter, the view label
 * and the page). A screen keeps its current query object when a choice
 * changes nothing, so choosing the applied charter again, or a preset that
 * is already applied, sends no request.
 */
export function sameBookReportQuery(a: BookReportQuery, b: BookReportQuery): boolean {
  return (
    serializeBookReportQuery(a, { includePage: false }) ===
      serializeBookReportQuery(b, { includePage: false }) && a.page === b.page
  );
}

/** True once a query names a concrete warehouse (all, or a uuid). */
export function isResolvedBookReportQuery(query: BookReportQuery): boolean {
  return query.warehouse === 'all' || isUuid(query.warehouse);
}

/**
 * The report's starting filters from a link's parameters (a web link
 * rewritten onto the phone, or a drill-down's own params). Invalid keys are
 * reset to their defaults and named, so the screen can say so. A warehouse a
 * link names is an explicit choice on the phone: `wview` described the web's
 * warehouse view, not this phone's, so it is dropped.
 */
export function bookReportQueryFromParams(
  params: Record<string, string | string[] | undefined | null>,
): { query: BookReportQuery; invalid: string[] } {
  const { query, invalid } = parseBookReportQuery(params);
  // A web link rewritten onto the phone has its refused values dropped
  // already and carries reset=1 instead (book-order-totals-link.ts).
  const raw = params.reset;
  const reset = (Array.isArray(raw) ? raw[0] : raw) === '1';
  return {
    query: { ...query, warehouseFromView: false },
    invalid: reset && invalid.length === 0 ? ['link'] : invalid,
  };
}

/** The filters the server may refuse by id (400): a charter, warehouse or
 *  category the reader cannot see, or that no longer exists. */
export type BookReportUnreadableKey = 'charter' | 'warehouse' | 'category';

/**
 * A 400 naming a charter, warehouse or category filter the reader cannot see
 * (or that no longer exists): which one, else null. A refused charter is one
 * answer whatever the cause (unknown, another organization's, outside the
 * reader's scope), so the phone learns nothing from it and resets it with
 * the same notice as the web page.
 */
export function bookReportUnreadableFilter(e: unknown): BookReportUnreadableKey | null {
  if (!e || typeof e !== 'object') return null;
  const o = e as { status?: unknown; details?: unknown };
  if (o.status !== 400 || !o.details || typeof o.details !== 'object') return null;
  const reason = (o.details as { reason?: unknown }).reason;
  if (reason === 'invalid_charter') return 'charter';
  if (reason === 'invalid_warehouse') return 'warehouse';
  if (reason === 'invalid_category') return 'category';
  return null;
}

/**
 * The query without that filter, as the web page reads such a link: a
 * charter falls back to all charters, a warehouse the link named to the
 * warehouse view, the view's own warehouse to all warehouses, a category to
 * all categories; page 1. Null when there is nothing left to drop (the
 * refusal is then shown, never retried in a loop): with three filters that
 * can be refused, a link resets at most four times.
 */
export function bookReportWithoutUnreadableFilter(
  query: BookReportQuery,
  which: BookReportUnreadableKey,
): BookReportQuery | null {
  const base = { ...query, statusGroups: [...query.statusGroups], page: 1 };
  if (which === 'charter') {
    if (query.charter === 'all') return null;
    return { ...base, charter: 'all' };
  }
  if (which === 'warehouse') {
    if (query.warehouse === 'all') return null;
    return {
      ...base,
      warehouse: query.warehouse === 'default' ? 'all' : 'default',
      warehouseFromView: false,
    };
  }
  if (query.category === 'all') return null;
  return { ...base, category: 'all' };
}

/** The same, for a drill-down opened from the list: its params are the
 *  list's own resolved query, so the view label (wview) is kept. */
export function bookReportQueryFromListParams(
  params: Record<string, string | string[] | undefined | null>,
): BookReportQuery {
  return parseBookReportQuery(params).query;
}

/** The phone route for one book's orders, carrying the list's resolved
 *  filters, the charter and dates included (never its page: the drill-down
 *  has its own). */
export function bookReportDrillDownHref(itemId: string, query: BookReportQuery): string {
  const qs = serializeBookReportQuery({ ...query, page: 1 }, { includePage: false });
  return `/reports/book-order-totals/${itemId}${qs ? `?${qs}` : ''}`;
}

/**
 * Where a drill-down's Back goes when there is no list under it (it was
 * opened from a link, or the app started on it): the list with the SAME
 * filters, after any refused charter, warehouse or category was reset, on
 * page 1. Never the defaults, and never a refused filter. The warehouse
 * goes as an explicit choice, as a link's warehouse always does on the
 * phone.
 */
export function bookReportListHref(query: BookReportQuery): string {
  const qs = serializeBookReportQuery({ ...query, warehouseFromView: false, page: 1 });
  return `/reports/book-order-totals${qs ? `?${qs}` : ''}`;
}

/** The web page for the same filters (Android's "Open this report on the
 *  web"). The warehouse goes as an explicit choice: the phone's view is not
 *  the web's. */
export function bookReportWebUrl(origin: string, query: BookReportQuery): string {
  const qs = serializeBookReportQuery({ ...query, warehouseFromView: false });
  const base = origin.replace(/\/+$/, '');
  return `${base}/dashboard/reports/book-order-totals${qs ? `?${qs}` : ''}`;
}

// ── The chip row ────────────────────────────────────────────────────────────

/** A chip on the phone's row: the filters, then the sort. */
export type BookReportChipKey = 'charter' | 'dates' | 'status' | 'warehouse' | 'category' | 'sort';

/** The sheet a chip's body opens. */
export type BookReportSheetId = 'charter' | 'dates' | 'filters';

export interface BookReportPhoneChip {
  key: BookReportChipKey;
  /** 'Charter: Alder · CH-A', 'Orders placed: This month (Sep 1 – Sep 29, 2026)'. */
  text: string;
  opens: BookReportSheetId;
  /** The chip body's hint: what a double-tap does. */
  hint: string;
  /** The separate remove button, only for a filter that differs from its
   *  default (core's chip: the filter, its words and the query it leads
   *  to). */
  remove: { key: BookReportFilterKey; label: string; cleared: BookReportQuery } | null;
}

const CHIP_HINTS: Readonly<Record<BookReportSheetId, string>> = {
  charter: 'Opens charter choices',
  dates: 'Opens date choices',
  filters: 'Opens the filters',
};

/**
 * The words the chips read from: the answer on screen, and for a charter,
 * warehouse or category the answer does not name yet (a choice still
 * loading, a failed read) the filter lists, so a chip names the choice
 * rather than "Chosen warehouse". Core decides which of these fits the
 * query; nothing here is sent anywhere.
 */
export function bookReportChipEchoes(
  query: BookReportQuery,
  answer: BookReportFilterEchoes | null,
  options: Pick<BookOrderOptionsResponse, 'warehouses' | 'categories'> | null,
): BookReportFilterEchoes {
  const f = answer?.filters ?? null;
  const wantW = isUuid(query.warehouse) ? query.warehouse.toLowerCase() : null;
  const wantC = isUuid(query.category) ? query.category.toLowerCase() : null;
  const echoW =
    f?.warehouse && wantW && f.warehouse.id.toLowerCase() === wantW ? f.warehouse : null;
  const listW = wantW
    ? (options?.warehouses.find((w) => w.id.toLowerCase() === wantW) ?? null)
    : null;
  const echoC = f?.category && wantC && f.category.id.toLowerCase() === wantC ? f.category : null;
  const listC = wantC
    ? (options?.categories.find((c) => c.id.toLowerCase() === wantC) ?? null)
    : null;
  const warehouse: BookReportWarehouseEcho | null =
    echoW ?? (listW ? { id: listW.id, name: listW.name, status: listW.status } : null);
  return {
    range: answer?.range ?? null,
    summary: answer?.summary ?? null,
    filters: {
      ...(f?.charter !== undefined ? { charter: f.charter } : {}),
      ...(f?.noCharter !== undefined ? { noCharter: f.noCharter } : {}),
      warehouse,
      category:
        echoC ?? (listC ? { id: listC.id, name: listC.name, deleted: listC.deleted } : null),
      uncategorized: f?.uncategorized ?? false,
    },
  };
}

/** The warehouse chip when no warehouse was CHOSEN: the one the next request
 *  follows (the warehouse view) or all of them. */
function warehouseChipDefault(
  query: BookReportQuery,
  view: { id: string | null; name: string | null },
): string {
  if (query.warehouse === 'default' && view.id && view.name) {
    return `${BOOK_REPORT_UI.warehouse}: ${view.name} (your warehouse view)`;
  }
  return `${BOOK_REPORT_UI.warehouse}: ${BOOK_REPORT_ALL_WAREHOUSES}`;
}

/**
 * The phone's chip row (plan 5): Charter, Orders placed, Status, Warehouse,
 * Category, then Sort. Each chip body opens ITS sheet (the charter sheet,
 * the dates sheet, or the filters sheet). A filter that differs from its
 * default carries core's chip (bookReportActiveFilters): its words and a
 * remove button leading to the query with only that filter reset, page 1.
 * Sort is not a filter and is never removed; the search has its own box.
 *
 * `query` is what the next request uses (the screen's state), so a choice
 * shows at once; removals start from it too, so a removal made while
 * another change loads keeps that change.
 */
export function bookReportPhoneChips(input: {
  query: BookReportQuery;
  echoes: BookReportFilterEchoes;
  statusLabels: Readonly<Record<OrderStatusKey, string>>;
  charterLabels: ReadonlyMap<string, string>;
  activeWarehouseId: string | null;
  activeWarehouseName: string | null;
}): BookReportPhoneChip[] {
  const { query } = input;
  const active = new Map(
    bookReportActiveFilters(query, input.echoes, input.statusLabels, {
      base: query,
      charterLabels: input.charterLabels,
    }).map((f) => [f.key, f] as const),
  );
  const chip = (
    key: Exclude<BookReportChipKey, 'sort'>,
    opens: BookReportSheetId,
    fallback: string,
  ): BookReportPhoneChip => {
    const f = active.get(key);
    return {
      key,
      text: f?.text ?? fallback,
      opens,
      hint: CHIP_HINTS[opens],
      remove: f ? { key: f.key, label: f.removeLabel, cleared: f.cleared } : null,
    };
  };
  return [
    chip('charter', 'charter', `${BOOK_REPORT_UI.charter}: ${BOOK_REPORT_ALL_CHARTERS}`),
    chip('dates', 'dates', `${BOOK_REPORT_UI.dateRange}: ${BOOK_REPORT_RANGE_LABELS.all}`),
    chip(
      'status',
      'filters',
      `${BOOK_REPORT_UI.status}: ${bookReportShowingStatus(query.statusGroups)}`,
    ),
    chip(
      'warehouse',
      'filters',
      warehouseChipDefault(query, { id: input.activeWarehouseId, name: input.activeWarehouseName }),
    ),
    chip('category', 'filters', `${BOOK_REPORT_UI.category}: ${BOOK_REPORT_ALL_CATEGORIES}`),
    {
      key: 'sort',
      text: `${BOOK_REPORT_UI.sort}: ${BOOK_REPORT_SORT_LABELS[query.sort]}`,
      opens: 'filters',
      hint: CHIP_HINTS.filters,
      remove: null,
    },
  ];
}

/** Whether "Clear filters" has anything to clear: a charter, dates, status,
 *  a chosen warehouse, a category or a search (sort is kept). */
export function bookReportHasFiltersToClear(query: BookReportQuery): boolean {
  return (['charter', 'dates', 'status', 'warehouse', 'category', 'q'] as const).some((k) =>
    bookReportFilterIsSet(query, k),
  );
}

/** Clear filters (plan D14): charter, dates, status, warehouse (back to the
 *  warehouse view), category and search to their defaults, page 1; the sort
 *  is kept. The screen also empties the search box. */
export function clearBookReportFilters(query: BookReportQuery): BookReportQuery {
  return bookReportClearedQuery(query);
}

// ── Charter labels, the Charter sheet and "Showing" ─────────────────────────

/**
 * Labels by charter id for a whole list (the sheet, the chips, the Showing
 * block, the by-charter rows), so a charter reads the same everywhere and
 * two alike charters are told apart by core's id fragment. `extra` names
 * charters the lists do not carry (a by-charter row when the lists failed).
 */
export function bookReportCharterLabelsFor(
  options: Pick<BookOrderOptionsResponse, 'charters'> | null,
  extra: readonly Pick<BookReportCharterTotal, 'id' | 'name' | 'code' | 'status'>[] = [],
): Map<string, string> {
  const list: { id: string; name: string | null; code: string | null; status: string | null }[] = [
    ...(options?.charters ?? []),
  ];
  const seen = new Set(list.map((c) => c.id.toLowerCase()));
  for (const e of extra) {
    if (e.id === null || seen.has(e.id.toLowerCase())) continue;
    seen.add(e.id.toLowerCase());
    list.push({ id: e.id, name: e.name, code: e.code, status: e.status });
  }
  const out = new Map<string, string>();
  for (const [id, label] of bookReportCharterOptionLabels(list)) out.set(id.toLowerCase(), label);
  return out;
}

/** One row of the Charter sheet. */
export interface BookReportCharterChoice {
  /** What choosing it sets: 'all', 'none' or the charter id. */
  value: string;
  label: string;
  detail: string | null;
}

/**
 * The Charter sheet's rows: All charters; each charter the reader may report
 * on (active first, as the server sorts them); an applied charter the lists
 * do not carry, by the on-screen answer's name; No charter last, only when
 * the reader's visible book orders include some with no charter, or it is
 * the applied value. Lists that failed to load leave All charters and the
 * applied choice, still named.
 */
export function bookReportCharterChoices(input: {
  current: string;
  options: Pick<BookOrderOptionsResponse, 'charters' | 'noCharter'> | null;
  labels: ReadonlyMap<string, string>;
  /** The on-screen answer's charter (names an applied id the lists lack). */
  echo: BookReportCharterEcho | null;
}): BookReportCharterChoice[] {
  const out: BookReportCharterChoice[] = [
    { value: 'all', label: BOOK_REPORT_ALL_CHARTERS, detail: null },
  ];
  const listed = input.options?.charters ?? [];
  for (const c of listed) {
    const id = c.id.toLowerCase();
    out.push({
      value: id,
      label: input.labels.get(id) ?? bookReportCharterOptionLabel(c),
      detail: null,
    });
  }
  const current = input.current.toLowerCase();
  if (isUuid(current) && !listed.some((c) => c.id.toLowerCase() === current)) {
    const echo = input.echo && input.echo.id.toLowerCase() === current ? input.echo : null;
    out.push({
      value: current,
      label:
        input.labels.get(current) ?? (echo ? bookReportCharterOptionLabel(echo) : 'Chosen charter'),
      detail: null,
    });
  }
  if (input.options?.noCharter || current === 'none') {
    out.push({ value: 'none', label: BOOK_REPORT_NO_CHARTER, detail: BOOK_REPORT_NO_CHARTER_HINT });
  }
  return out;
}

/** A search field shows above the charter rows only past this many rows. */
export const BOOK_REPORT_CHARTER_SEARCH_OVER = 12;

/** The rows whose label holds the typed text (any case); all of them for
 *  blank text. The applied choice stays in the list whatever is typed. */
export function filterBookReportCharterChoices(
  choices: readonly BookReportCharterChoice[],
  text: string,
  current: string,
): BookReportCharterChoice[] {
  const t = text.trim().toLowerCase();
  if (!t) return [...choices];
  const cur = current.toLowerCase();
  return choices.filter((c) => c.value === cur || c.label.toLowerCase().includes(t));
}

/** The Showing block (brief 8, plan D20) as the phone draws it: the eyebrow,
 *  the charter as the display line, then the range, the warehouse whenever
 *  the report covers one warehouse (the warehouse view included), and the
 *  statuses; all from the answer's echoes. `spoken` is the block as one
 *  VoiceOver element. */
export function bookReportShowingView(
  answer: BookReportShowingAnswer,
  statusGroups: readonly BookReportStatusGroup[],
  charterLabels: ReadonlyMap<string, string>,
): { eyebrow: string; title: string; lines: string[]; spoken: string } {
  const parts = bookReportShowingParts(answer, statusGroups, { charterLabels });
  const title = parts.find((p) => p.key === 'charter')?.text ?? BOOK_REPORT_ALL_CHARTERS;
  const lines = parts.filter((p) => p.key !== 'charter').map((p) => p.text);
  return {
    eyebrow: BOOK_REPORT_SHOWING,
    title,
    lines,
    spoken: `${BOOK_REPORT_SHOWING}: ${[title, ...lines].join('. ')}.`,
  };
}

/** Whether the answer is for one charter at one warehouse and found nothing:
 *  then the empty state adds that the charter's orders may be elsewhere. */
export function bookReportCharterWarehouseEmpty(answer: {
  totalCount: number;
  filters: BookReportCharterFilters & { warehouse: BookReportWarehouseEcho | null };
}): boolean {
  return (
    answer.totalCount === 0 && Boolean(answer.filters.charter) && answer.filters.warehouse !== null
  );
}

// ── "Books ordered by charter" ──────────────────────────────────────────────

export interface BookReportByCharterRowView {
  key: string;
  /** The charter a tap applies: its id, or 'none' for No charter. */
  charter: string;
  label: string;
  /** '1,284 copies in 12 orders'. */
  value: string;
  accessibilityLabel: string;
  /** 'Show only Alder · CH-A'. */
  accessibilityHint: string;
}

/**
 * The disclosure's rows, in the server's order (No charter last), or null
 * when the answer has none to show (a charter chosen, an older server, or
 * nothing matched). `total` is core's closing line, equal to the summary;
 * `unitsNote` says copies count single-copy units only when some books are
 * in another unit. The figures are the answer's; nothing is added here.
 */
export function bookReportByCharterView(
  answer: {
    byCharter?: readonly BookReportCharterTotal[] | null;
    summary: { copies: string; orders: number; unresolved: { entries: number } };
  },
  labels: ReadonlyMap<string, string>,
): { rows: BookReportByCharterRowView[]; total: string; unitsNote: string | null } | null {
  const list = answer.byCharter;
  if (!Array.isArray(list) || list.length === 0) return null;
  const otherUnits = answer.summary.unresolved.entries > 0;
  const rows = list.map((b) => {
    const label =
      b.id === null
        ? BOOK_REPORT_NO_CHARTER
        : (labels.get(b.id.toLowerCase()) ?? bookReportCharterOptionLabel(b));
    const value = bookReportByCharterValue(b.copies, b.orders, otherUnits);
    return {
      key: b.id ?? 'none',
      charter: b.id === null ? 'none' : b.id.toLowerCase(),
      label,
      value,
      accessibilityLabel: `${label}: ${value}.`,
      accessibilityHint: bookReportByCharterApplyLabel(label),
    };
  });
  return {
    rows,
    total: bookReportByCharterTotalLine(answer.summary),
    unitsNote: otherUnits ? BOOK_REPORT_BY_CHARTER_UNITS_NOTE : null,
  };
}

// ── The dates sheet ─────────────────────────────────────────────────────────

/** The presets, in the brief's order, then Custom range. */
export const BOOK_REPORT_DATE_CHOICES: readonly BookReportRange[] = [
  'all',
  'today',
  'week',
  'month',
  '30d',
  '90d',
  'year',
  'custom',
];

/**
 * Where the dates sheet's calendar starts: the applied custom range; else a
 * preset's resolved days from the answer on screen (only when that answer is
 * for the same preset, so This month opens on Sep 1 – Sep 29); else nothing
 * picked, on the month of the organization's today (the answer's generation
 * day, never the device clock). `month` is null only with no answer yet.
 */
export function bookReportDatesSheetStart(input: {
  query: Pick<BookReportQuery, 'range' | 'from' | 'to'>;
  echo: Pick<BookReportRangeEcho, 'key' | 'from' | 'to'> | null;
  today: string | null;
}): { draft: CalendarRangeDraft; month: CalendarMonth | null } {
  const { query, echo, today } = input;
  if (query.range === 'custom' && rangeComplete({ start: query.from, end: query.to })) {
    return calendarDraftFrom({ from: query.from, to: query.to }, today);
  }
  if (echo && echo.key === query.range && query.range !== 'all') {
    return calendarDraftFrom({ from: echo.from, to: echo.to }, today);
  }
  return calendarDraftFrom(null, today);
}

/** A preset tap: that range, no dates, page 1, every other filter kept. */
export function bookReportPresetQuery(
  query: BookReportQuery,
  range: Exclude<BookReportRange, 'custom'>,
): BookReportQuery {
  return bookReportWithFilter(query, { range, from: null, to: null });
}

/** Apply on a custom range: both ends, real days, the first on or before the
 *  last, else null (Apply stays disabled). Page 1. */
export function bookReportCustomRangeQuery(
  query: BookReportQuery,
  start: string | null,
  end: string | null,
): BookReportQuery | null {
  if (!rangeComplete({ start, end })) return null;
  return bookReportWithFilter(query, { range: 'custom', from: start, to: end });
}

/** A date tile of the custom range: 'Sep 1, 2026' or core's prompt ('Choose
 *  an end date'), and what VoiceOver reads ('End date: Wednesday, September
 *  30, 2026'). */
export function bookReportDateTile(
  which: 'start' | 'end',
  ymd: string | null,
): { title: string; value: string; chosen: boolean; spoken: string } {
  const title = which === 'start' ? CALENDAR_COPY.startDate : CALENDAR_COPY.endDate;
  const prompt = which === 'start' ? CALENDAR_COPY.chooseStartDate : CALENDAR_COPY.chooseEndDate;
  if (ymd && validateCustomDate(ymd)) {
    return {
      title,
      value: formatReportDate(ymd),
      chosen: true,
      spoken: `${title}: ${calendarDayLabel(ymd)}`,
    };
  }
  return { title, value: prompt, chosen: false, spoken: `${title}: ${prompt}` };
}

// ── The filters sheet ───────────────────────────────────────────────────────

/** What the filters sheet refuses before Apply. */
export interface BookReportDraftProblems {
  /** The custom range's refusal, said once under both dates, or null. */
  dates: string | null;
  /** The date field(s) the refusal is about (outlined on the sheet). */
  fromInvalid: boolean;
  toInvalid: boolean;
  status: string | null;
}

/**
 * Custom dates are checked by core's calendar rule (the SQL's bounds); a
 * status filter needs at least one group. The refusals are core's sentences,
 * the ones the web page shows (plan 13.7 step 3): one sentence for the range
 * (an impossible date, or the first after the last) and one for status. The
 * field(s) at fault are marked: an impossible date marks that date; the
 * first date after the last marks both.
 */
export function bookReportDraftProblems(draft: BookReportQuery): BookReportDraftProblems {
  const problems: BookReportDraftProblems = {
    dates: null,
    fromInvalid: false,
    toInvalid: false,
    status: null,
  };
  if (draft.range === 'custom') {
    const fromOk = validateCustomDate(draft.from);
    const toOk = validateCustomDate(draft.to);
    const reversed = fromOk && toOk && (draft.from as string) > (draft.to as string);
    problems.fromInvalid = !fromOk || reversed;
    problems.toInvalid = !toOk || reversed;
    if (problems.fromInvalid || problems.toInvalid) {
      problems.dates = BOOK_REPORT_UI.customRangeInvalid;
    }
  }
  if (draft.statusGroups.length === 0) problems.status = BOOK_REPORT_UI.statusNoneChosen;
  return problems;
}

export function bookReportDraftIsValid(draft: BookReportQuery): boolean {
  const p = bookReportDraftProblems(draft);
  return p.dates === null && p.status === null;
}

/**
 * The query Apply sends: back to page 1 (a new filter is a new result), a
 * custom range only with both dates, and the search box's text kept.
 */
export function applyBookReportDraft(draft: BookReportQuery): BookReportQuery {
  const custom = draft.range === 'custom';
  return {
    ...draft,
    statusGroups: BOOK_REPORT_STATUS_GROUP_KEYS.filter((g) => draft.statusGroups.includes(g)),
    from: custom ? draft.from : null,
    to: custom ? draft.to : null,
    page: 1,
  };
}

/** The filters sheet's Reset: its own four controls back to their defaults
 *  (status, warehouse following the view again, category, sort). The
 *  charter and the dates have their own sheets and the search its own box,
 *  so all three are kept; Clear filters is the whole reset. */
export function resetBookReportDraft(current: BookReportQuery): BookReportQuery {
  return {
    ...current,
    statusGroups: [...DEFAULT_BOOK_REPORT_STATUS_GROUPS],
    warehouse: DEFAULT_BOOK_REPORT_QUERY.warehouse,
    warehouseFromView: false,
    category: DEFAULT_BOOK_REPORT_QUERY.category,
    sort: DEFAULT_BOOK_REPORT_QUERY.sort,
    page: 1,
  };
}

export function toggleStatusGroup(
  groups: readonly BookReportStatusGroup[],
  group: BookReportStatusGroup,
): BookReportStatusGroup[] {
  const set = new Set(groups);
  if (set.has(group)) set.delete(group);
  else set.add(group);
  return BOOK_REPORT_STATUS_GROUP_KEYS.filter((g) => set.has(g));
}

/** A status group's label in the organization's words. */
export function statusGroupLabel(
  group: BookReportStatusGroup,
  labels: Readonly<Record<OrderStatusKey, string>>,
): string {
  return bookReportStatusGroupLabel(group, labels);
}

// ── Rows ────────────────────────────────────────────────────────────────────

/** 'SKU BK-123 · ISBN 9780140449136' (the row's second line). */
export function bookReportIdentifiersLine(row: {
  sku: string | null;
  identifier: string | null;
  warehouseName: string | null;
  binLocation: string | null;
}): string {
  const id = bookReportRowIdentity(row);
  return [
    id.skuLabel,
    id.identifier && id.identifierLabel ? `${id.identifierLabel} ${id.identifier}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** 'DC4 · Rack 12-B' (the row's third line). */
export function bookReportPlaceLine(row: {
  sku: string | null;
  identifier: string | null;
  warehouseName: string | null;
  binLocation: string | null;
}): string {
  return bookReportRowIdentity(row).place;
}

/** '30 copies requested · 3 orders · Latest order Sep 20, 2026'. */
export function bookReportRowFiguresLine(row: BookReportRow): string {
  return [rowQuantityText(row), ordersCountText(row.orders), latestOrderText(row.latestOrderDate)]
    .filter(Boolean)
    .join(' · ');
}

/**
 * What VoiceOver reads for one row, in one breath: "Book A. 30 copies
 * requested in 3 orders. Latest order September 20, 2026. Archived. View
 * orders." The numbers are the row's own (the API's), never recomputed.
 */
export function bookReportRowAccessibilityLabel(row: BookReportRow): string {
  const parts: string[] = [`${row.name}.`];
  parts.push(`${rowQuantityText(row)} in ${ordersCountText(row.orders)}.`);
  if (row.latestOrderDate) parts.push(`Latest order ${formatReportDateLong(row.latestOrderDate)}.`);
  const place = bookReportPlaceLine(row);
  const ids = bookReportIdentifiersLine(row);
  if (ids) parts.push(`${ids}.`);
  if (place) parts.push(`${place}.`);
  for (const badge of bookReportRowBadges(row)) parts.push(`${badge}.`);
  parts.push('View orders.');
  return parts.join(' ');
}

/** One drill-down row as the phone shows and speaks it. */
export interface BookReportOrderRowPresentation {
  /** 'SO-000049', or 'Order' when the order has no number yet. */
  title: string;
  /** 'Sep 20, 2026 · DC4 · Approved'. */
  details: string;
  /** 'Charter: Alder · CH-A' or 'Charter: No charter', only with All
   *  charters chosen (one charter would repeat the header on every row). */
  charter: string | null;
  /** '10 copies requested', or '12 (pack of 10)' in another unit. */
  quantity: string;
  /** '(2 lines)' when the order asked for this book on more than one line. */
  combined: string | null;
  /** The phone route, or null: then the row is words, not a button. */
  href: string | null;
  accessibilityRole: 'button' | 'text';
  accessibilityLabel: string;
  accessibilityHint: string;
}

/** Whether a drill-down answer is for All charters, so each order row names
 *  its charter (the web drawer's Charter column rule). */
export function bookReportOrdersShowCharter(filters: BookReportCharterFilters): boolean {
  return bookReportCharterEchoMatches({ charter: 'all' }, filters);
}

/**
 * The drill-down row. A link only when the server says `openable` (the
 * caller holds orders:approve or placed the order: core bookReportOrderLink,
 * the web drawer's rule). Anyone else reads the number as plain text with
 * the reason as its hint, never a button that leads to someone else's order.
 */
export function bookReportOrderRowPresentation(
  row: BookReportOrderRowOut,
  book: { countsAsCopies: boolean; unit: string | null },
  statusLabels: Readonly<Record<OrderStatusKey, string>>,
  opts: { showCharter?: boolean } = {},
): BookReportOrderRowPresentation {
  const title = formatOrderNumber(row.orderNumber) ?? 'Order';
  const status = statusLabels[row.status as OrderStatusKey] ?? row.status;
  const details = [formatReportDate(row.orderDate), row.warehouseName, status]
    .filter(Boolean)
    .join(' · ');
  const charterText = opts.showCharter ? bookReportOrderCharterText(row) : null;
  const charter = charterText ? `${BOOK_REPORT_ORDER_COLUMNS.charter}: ${charterText}` : null;
  const quantity = rowQuantityText({
    copies: row.copies,
    countsAsCopies: book.countsAsCopies,
    unit: book.unit,
  });
  const combined = combinedLinesText(row.lines);
  const href = bookReportOrderLink(row, 'phone');
  const spoken = [
    `${title}.`,
    `${formatReportDateLong(row.orderDate)}.`,
    charter ? `${charter}.` : null,
    row.warehouseName ? `${row.warehouseName}.` : null,
    `${status}.`,
    `${quantity}${combined ? ` ${combined}` : ''}.`,
  ]
    .filter(Boolean)
    .join(' ');
  return {
    title,
    details,
    charter,
    quantity,
    combined,
    href,
    accessibilityRole: href ? 'button' : 'text',
    accessibilityLabel: spoken,
    accessibilityHint: href ? 'Opens the order' : BOOK_REPORT_ORDER_LINK_HINT,
  };
}

// ── Export (plan 9.5) ───────────────────────────────────────────────────────

/**
 * Where a file can go from this phone. iOS shares the downloaded file
 * (React Native's Share passes `url` on iOS only). Android's Share sends
 * `message` only, so a downloaded file could be neither shared nor saved
 * that way, and there is no expo-sharing in this binary: Android offers the
 * web instead for now.
 *
 * THIS DEPARTS FROM THE BRIEF (section 9: "supported share/download
 * behavior, not an external browser-only substitute"). An Android save does
 * NOT need a new binary: expo-file-system 57's legacy API already carries
 * StorageAccessFramework (requestDirectoryPermissionsAsync, createFileAsync,
 * writeAsStringAsync with base64), JS and native, so a "Save to a folder"
 * path ships by OTA. It waits only on Android verification on a device,
 * which the owner has deferred to the Play Store launch (2026-09-23); SAF
 * file naming and MIME handling differ by provider and must be tried there.
 */
export type BookReportExportMode = 'share' | 'web_only';

export function bookReportExportMode(os: string): BookReportExportMode {
  return os === 'ios' ? 'share' : 'web_only';
}

export type BookReportExportChoiceId = 'csv' | 'pdf' | 'pdf_plain';

export interface BookReportExportChoice {
  id: BookReportExportChoiceId;
  label: string;
  format: 'csv' | 'pdf';
  photos: boolean;
  /** Why this format cannot be made for these filters, or null. */
  disabledReason: string | null;
}

export interface BookReportExportOffer {
  choices: BookReportExportChoice[];
  /** Under the two PDF options when more books match than the PDF carries
   *  covers for. Every row and total is still in the file. */
  coverCapNote: string | null;
}

/**
 * The export sheet's options for a result of `totalCount` books. A format
 * above its ceiling (checked again by the server before any byte) is
 * disabled with core's words; nothing is ever silently cut short.
 */
export function bookReportExportOffer(totalCount: number): BookReportExportOffer {
  const csvTooMany =
    totalCount > BOOK_REPORT_CSV_MAX_ROWS
      ? bookReportTooManyText(totalCount, BOOK_REPORT_CSV_MAX_ROWS)
      : null;
  const pdfTooMany =
    totalCount > BOOK_REPORT_PDF_MAX_ROWS
      ? bookReportTooManyText(totalCount, BOOK_REPORT_PDF_MAX_ROWS)
      : null;
  return {
    choices: [
      {
        id: 'csv',
        label: BOOK_REPORT_EXPORT_CSV,
        format: 'csv',
        photos: false,
        disabledReason: csvTooMany,
      },
      {
        id: 'pdf',
        label: BOOK_REPORT_EXPORT_PDF_COVERS,
        format: 'pdf',
        photos: true,
        disabledReason: pdfTooMany,
      },
      {
        id: 'pdf_plain',
        label: BOOK_REPORT_EXPORT_PDF_PLAIN,
        format: 'pdf',
        photos: false,
        disabledReason: pdfTooMany,
      },
    ],
    coverCapNote: totalCount > BOOK_REPORT_PDF_COVER_CAP ? BOOK_REPORT_EXPORT_COVER_CAP_NOTE : null,
  };
}

/** Words the export sheet adds (about the phone, not the report). */
export const BOOK_REPORT_EXPORT_SHEET_TITLE = 'Export Book Order Totals';
export const BOOK_REPORT_EXPORT_SHEET_NOTE =
  'Every book that matches these filters goes in the file, not just this page. The file is read fresh and carries its own generation time.';
export const BOOK_REPORT_EXPORT_OFFLINE = 'Exporting needs a connection.';
export const BOOK_REPORT_EXPORT_PREPARING = 'Preparing the file…';

// ── Small words the phone screens need ──────────────────────────────────────

/** 'Showing 26–50 of 1,100 book entries' uses these nouns. */
export const BOOK_ENTRY_NOUN = { one: 'book entry', other: 'book entries' } as const;
export const ORDER_NOUN = { one: 'order', other: 'orders' } as const;

/** Total books ordered, as a big number and its unit. */
export function copiesMetric(copies: string): { value: string; unit: string } {
  return {
    value: formatReportQuantity(copies),
    unit: copies === '1' ? 'copy requested' : 'copies requested',
  };
}

/**
 * What a cover placeholder says to VoiceOver (simulator walk D1). "Cover
 * could not be loaded" only after a real failure: the lookup failed
 * (`failed`), or THIS URL failed to load (`failedUri === uri`, with a URL).
 * A book with no cover URL is "No cover", whatever an earlier URL did; the
 * component's `failedUri` starts null, and a bare `failedUri === uri` read
 * every book without a cover (null === null) as a failure.
 */
export function bookCoverPlaceholderLabel(state: {
  uri: string | null;
  failedUri: string | null;
  failed: boolean;
}): string {
  const loadFailed = state.uri !== null && state.failedUri === state.uri;
  return state.failed || loadFailed ? BOOK_COVER_UNAVAILABLE : BOOK_COVER_PLACEHOLDER;
}

/**
 * The disk cache key for a cover. A signed storage URL (this project's
 * item-images bucket) drops its query, because the token rotates while the
 * picture does not. Any other URL keeps its query: an allowlisted external
 * cover can differ only there (books.google.com/books/content?id=...), and
 * dropping it would show one book's cover for every other.
 */
export function bookCoverCacheKey(uri: string): string {
  if (/\/storage\/v1\/object\/sign\//.test(uri)) {
    const q = uri.indexOf('?');
    return q >= 0 ? uri.slice(0, q) : uri;
  }
  return uri;
}

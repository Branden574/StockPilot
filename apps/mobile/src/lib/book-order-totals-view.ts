import {
  BOOK_REPORT_ALL_CATEGORIES,
  BOOK_REPORT_ALL_WAREHOUSES,
  BOOK_REPORT_CSV_MAX_ROWS,
  BOOK_REPORT_EXPORT_COVER_CAP_NOTE,
  BOOK_REPORT_EXPORT_CSV,
  BOOK_REPORT_EXPORT_PDF_COVERS,
  BOOK_REPORT_EXPORT_PDF_PLAIN,
  BOOK_REPORT_NO_CATEGORY,
  BOOK_REPORT_ORDER_LINK_HINT,
  BOOK_REPORT_PDF_COVER_CAP,
  BOOK_REPORT_PDF_MAX_ROWS,
  BOOK_REPORT_RANGE_LABELS,
  BOOK_REPORT_SORT_LABELS,
  BOOK_REPORT_STATUS_GROUP_KEYS,
  DEFAULT_BOOK_REPORT_QUERY,
  DEFAULT_BOOK_REPORT_STATUS_GROUPS,
  ROLES,
  bookReportCategoryOptionLabel,
  bookReportOrderLink,
  bookReportRowBadges,
  bookReportRowIdentity,
  bookReportStatusGroupLabel,
  bookReportTooManyText,
  bookReportWarehouseOptionLabel,
  can,
  combinedLinesText,
  formatOrderNumber,
  formatReportDate,
  formatReportDateLong,
  formatReportDateRange,
  formatReportQuantity,
  isUuid,
  latestOrderText,
  ordersCountText,
  parseBookReportQuery,
  rowQuantityText,
  serializeBookReportQuery,
  validateCustomDate,
  type BookReportOptionCategory,
  type BookReportOptionWarehouse,
  type BookReportOrderRowOut,
  type BookReportQuery,
  type BookReportRow,
  type BookReportStatusGroup,
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
 * count the API returned (SQL is the only calculator, migration 0379); these
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
  return { query: { ...query, warehouseFromView: false }, invalid };
}

/** The same, for a drill-down opened from the list: its params are the
 *  list's own resolved query, so the view label (wview) is kept. */
export function bookReportQueryFromListParams(
  params: Record<string, string | string[] | undefined | null>,
): BookReportQuery {
  return parseBookReportQuery(params).query;
}

/** The phone route for one book's orders, carrying the list's resolved
 *  filters (never its page: the drill-down has its own). */
export function bookReportDrillDownHref(itemId: string, query: BookReportQuery): string {
  const qs = serializeBookReportQuery({ ...query, page: 1 }, { includePage: false });
  return `/reports/book-order-totals/${itemId}${qs ? `?${qs}` : ''}`;
}

/** The web page for the same filters (Android's "Open this report on the
 *  web"). The warehouse goes as an explicit choice: the phone's view is not
 *  the web's. */
export function bookReportWebUrl(origin: string, query: BookReportQuery): string {
  const qs = serializeBookReportQuery({ ...query, warehouseFromView: false });
  const base = origin.replace(/\/+$/, '');
  return `${base}/dashboard/reports/book-order-totals${qs ? `?${qs}` : ''}`;
}

// ── Filter chips and the sheet ──────────────────────────────────────────────

export function bookReportDateChip(query: BookReportQuery): string {
  if (query.range === 'custom' && query.from && query.to) {
    return `Date: ${formatReportDateRange(query.from, query.to)}`;
  }
  return `Date: ${BOOK_REPORT_RANGE_LABELS[query.range]}`;
}

export function bookReportStatusChip(groups: readonly BookReportStatusGroup[]): string {
  const same =
    groups.length === DEFAULT_BOOK_REPORT_STATUS_GROUPS.length &&
    DEFAULT_BOOK_REPORT_STATUS_GROUPS.every((g) => groups.includes(g));
  if (same) return 'Status: default';
  return `Status: ${groups.length} of ${BOOK_REPORT_STATUS_GROUP_KEYS.length}`;
}

/** The warehouse chip: what the NEXT request will use. */
export function bookReportWarehouseChip(input: {
  query: BookReportQuery;
  activeWarehouseName: string | null;
  activeWarehouseId: string | null;
  warehouses: readonly BookReportOptionWarehouse[];
  /** The on-screen answer's warehouse, for an id the options do not list. */
  echoName?: string | null;
}): string {
  const { query } = input;
  if (query.warehouse === 'default') {
    return input.activeWarehouseId && input.activeWarehouseName
      ? `Warehouse: ${input.activeWarehouseName} (your warehouse view)`
      : `Warehouse: ${BOOK_REPORT_ALL_WAREHOUSES}`;
  }
  if (query.warehouse === 'all') return `Warehouse: ${BOOK_REPORT_ALL_WAREHOUSES}`;
  const w = input.warehouses.find((x) => x.id === query.warehouse);
  if (w) return `Warehouse: ${bookReportWarehouseOptionLabel(w)}`;
  return `Warehouse: ${input.echoName ?? 'Chosen warehouse'}`;
}

export function bookReportCategoryChip(
  query: BookReportQuery,
  categories: readonly BookReportOptionCategory[],
  echoName?: string | null,
): string {
  if (query.category === 'all') return `Category: ${BOOK_REPORT_ALL_CATEGORIES}`;
  if (query.category === 'none') return `Category: ${BOOK_REPORT_NO_CATEGORY}`;
  const cat = categories.find((x) => x.id === query.category);
  if (cat) return `Category: ${bookReportCategoryOptionLabel(cat)}`;
  return `Category: ${echoName ?? 'Chosen category'}`;
}

export function bookReportSortChip(query: BookReportQuery): string {
  return `Sort: ${BOOK_REPORT_SORT_LABELS[query.sort]}`;
}

/** What the filters sheet refuses before Apply. */
export interface BookReportDraftProblems {
  from: string | null;
  to: string | null;
  status: string | null;
}

export const BOOK_REPORT_DATE_FORMAT_PROBLEM = 'Enter a date as YYYY-MM-DD, from 2000 to 2100.';
export const BOOK_REPORT_DATE_ORDER_PROBLEM = 'The first date must be on or before the last date.';
export const BOOK_REPORT_STATUS_PROBLEM = 'Choose at least one status.';

/** Custom dates are checked by core's calendar rule (the SQL's bounds); a
 *  status filter needs at least one group. */
export function bookReportDraftProblems(draft: BookReportQuery): BookReportDraftProblems {
  const problems: BookReportDraftProblems = { from: null, to: null, status: null };
  if (draft.range === 'custom') {
    const fromOk = validateCustomDate(draft.from);
    const toOk = validateCustomDate(draft.to);
    if (!fromOk) problems.from = BOOK_REPORT_DATE_FORMAT_PROBLEM;
    if (!toOk) problems.to = BOOK_REPORT_DATE_FORMAT_PROBLEM;
    if (fromOk && toOk && (draft.from as string) > (draft.to as string)) {
      problems.to = BOOK_REPORT_DATE_ORDER_PROBLEM;
    }
  }
  if (draft.statusGroups.length === 0) problems.status = BOOK_REPORT_STATUS_PROBLEM;
  return problems;
}

export function bookReportDraftIsValid(draft: BookReportQuery): boolean {
  const p = bookReportDraftProblems(draft);
  return p.from === null && p.to === null && p.status === null;
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

/** Reset: every default, following the warehouse view again; the search box
 *  is its own control and is kept. */
export function resetBookReportDraft(current: BookReportQuery): BookReportQuery {
  return {
    ...DEFAULT_BOOK_REPORT_QUERY,
    statusGroups: [...DEFAULT_BOOK_REPORT_STATUS_GROUPS],
    q: current.q,
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
): BookReportOrderRowPresentation {
  const title = formatOrderNumber(row.orderNumber) ?? 'Order';
  const status = statusLabels[row.status as OrderStatusKey] ?? row.status;
  const details = [formatReportDate(row.orderDate), row.warehouseName, status]
    .filter(Boolean)
    .join(' · ');
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
    row.warehouseName ? `${row.warehouseName}.` : null,
    `${status}.`,
    `${quantity}${combined ? ` ${combined}` : ''}.`,
  ]
    .filter(Boolean)
    .join(' ');
  return {
    title,
    details,
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

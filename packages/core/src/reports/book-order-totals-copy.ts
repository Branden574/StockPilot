/**
 * BOOK ORDER TOTALS — every word the report shows, in one place, so the web
 * page, the phone, the CSV and the PDF read the same.
 *
 * The measure is copies REQUESTED through Orders: never purchased, never
 * stock, never "delivered". Rows are inventory records ("distinct book
 * entries"), never "unique titles". The generation time is when the figures
 * were read, never a snapshot. A failure is never worded as an empty report.
 * Nothing here is a percentage. The recorded-quantity jargon ("the book",
 * "book quantity", "on the books") never appears: the wording guard in
 * ./book-order-totals-copy.test.ts renders every line and searches it.
 */

import type { OrderStatusKey } from '../customization/order-status';

import {
  BOOK_REPORT_PDF_COVER_CAP,
  BOOK_REPORT_STATUS_GROUP_KEYS,
  BOOK_REPORT_STATUS_GROUPS,
  bookReportUnitLabel,
  formatReportDate,
  formatReportDateRange,
  formatReportDateTime,
  formatReportQuantity,
  formatReportTime,
  type BookReportCategoryEcho,
  type BookReportRange,
  type BookReportRangeEcho,
  type BookReportSort,
  type BookReportStatusGroup,
  type BookReportWarehouseEcho,
  type BookReportWarehouseSource,
} from './book-order-totals';

export const BOOK_REPORT_TITLE = 'Book Order Totals';
export const BOOK_REPORT_CARD_DESCRIPTION =
  'Book covers, quantities requested, and the orders behind each total.';

export const BOOK_REPORT_METRICS = {
  copies: {
    label: 'Total books ordered',
    definition: 'Copies requested through Orders; not copies purchased or current stock.',
  },
  entries: {
    label: 'Distinct book entries',
    definition:
      'Each inventory record counts once. Two records with the same title, such as on different racks, count separately.',
  },
  orders: {
    label: 'Orders containing books',
    definition: 'Each order counts once, however many different books it includes.',
  },
} as const;

const n = (value: number) => value.toLocaleString('en-US');

/** '642 copies requested', '1 copy requested'. */
export function copiesRequestedText(copies: string): string {
  return `${formatReportQuantity(copies)} ${copies === '1' ? 'copy' : 'copies'} requested`;
}

/** '3 orders', '1 order'. */
export function ordersCountText(orders: number): string {
  return `${n(orders)} ${orders === 1 ? 'order' : 'orders'}`;
}

/** '32 book entries', '1 book entry'. */
export function entriesCountText(entries: number): string {
  return `${n(entries)} ${entries === 1 ? 'book entry' : 'book entries'}`;
}

/** A row's quantity: '30 copies requested', or '12 (pack of 10)' for a row
 *  in another unit. */
export function rowQuantityText(row: {
  copies: string;
  countsAsCopies: boolean;
  unit: string | null;
}): string {
  if (row.countsAsCopies) return copiesRequestedText(row.copies);
  return `${formatReportQuantity(row.copies)} (${bookReportUnitLabel(row.unit)})`;
}

/** The disclosure under Total books ordered when some entries are in
 *  another unit. `unitIfOne` names the unit when exactly one entry is. */
export function unresolvedUnitsNote(
  unresolved: { entries: number; quantity: string },
  unitIfOne?: string | null,
): string | null {
  if (unresolved.entries <= 0) return null;
  if (unresolved.entries === 1) {
    const unit = unitIfOne === undefined ? null : bookReportUnitLabel(unitIfOne);
    return unit
      ? `Leaves out 1 book entry ordered in another unit (${formatReportQuantity(unresolved.quantity)} ${unit}).`
      : 'Leaves out 1 book entry ordered in another unit; it is listed with its unit.';
  }
  return `Leaves out ${n(unresolved.entries)} book entries ordered in other units; each is listed with its unit.`;
}

export const BOOK_REPORT_RANGE_LABELS: Readonly<Record<BookReportRange, string>> = {
  all: 'All time',
  month: 'This month',
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
  year: 'This year',
  custom: 'Custom range',
};

export const BOOK_REPORT_SORT_LABELS: Readonly<Record<BookReportSort, string>> = {
  copies: 'Most copies',
  title: 'Title (A–Z)',
  orders: 'Most orders',
  latest: 'Latest order',
};

/** 'Orders placed during: All time (May 12, 2026 – Sep 25, 2026)',
 *  'Orders placed during: Last 30 days (Aug 30 – Sep 28, 2026)',
 *  'Orders placed during: Sep 1 – Sep 28, 2026' (custom). Every date is the
 *  org-local string SQL returned. */
export function bookReportRangeLine(
  range: Pick<BookReportRangeEcho, 'key' | 'from' | 'to'>,
  summary?: { firstOrderDate: string | null; lastOrderDate: string | null },
): string {
  if (range.key === 'all') {
    const first = summary?.firstOrderDate ?? null;
    const last = summary?.lastOrderDate ?? null;
    if (first && last) {
      return `Orders placed during: All time (${formatReportDate(first)} – ${formatReportDate(last)})`;
    }
    return 'Orders placed during: All time';
  }
  const dates = formatReportDateRange(range.from, range.to);
  if (range.key === 'custom') return `Orders placed during: ${dates}`;
  return `Orders placed during: ${BOOK_REPORT_RANGE_LABELS[range.key]} (${dates})`;
}

/** 'Times are in America/Los_Angeles.' plus, when the organization's zone
 *  could not be used, why. */
export function bookReportZoneLine(
  range: Pick<BookReportRangeEcho, 'timeZone' | 'timeZoneFallback'>,
): string {
  return range.timeZoneFallback
    ? `Times are in ${range.timeZone} because the organization's time zone setting could not be used.`
    : `Times are in ${range.timeZone}.`;
}

/** The status filter's group label: the organization's own label for a
 *  single-status group (as the Orders page shows it), 'In progress' for the
 *  eight working statuses together. */
export function bookReportStatusGroupLabel(
  group: BookReportStatusGroup,
  statusLabels: Readonly<Record<OrderStatusKey, string>>,
): string {
  if (group === 'in_progress') return 'In progress';
  const status = BOOK_REPORT_STATUS_GROUPS[group].statuses[0]!;
  return statusLabels[status];
}

/** The eight statuses 'In progress' stands for, in the organization's words
 *  (for its tooltip). */
export function bookReportInProgressDetail(
  statusLabels: Readonly<Record<OrderStatusKey, string>>,
): string {
  return `In progress: ${BOOK_REPORT_STATUS_GROUPS.in_progress.statuses.map((s) => statusLabels[s]).join(', ')}.`;
}

/**
 * 'Status: Pending, In progress, Backordered, Handed over. Denied, cancelled
 * and unconfirmed requests are left out.' With denied or cancelled chosen,
 * the line says so and that those quantities were asked for, not accepted.
 */
export function bookReportStatusLine(
  groups: readonly BookReportStatusGroup[],
  statusLabels: Readonly<Record<OrderStatusKey, string>>,
): string {
  const chosen = BOOK_REPORT_STATUS_GROUP_KEYS.filter((g) => groups.includes(g));
  const labels = chosen.map((g) => bookReportStatusGroupLabel(g, statusLabels)).join(', ');
  const denied = chosen.includes('denied');
  const cancelled = chosen.includes('cancelled');
  const leftOut =
    !denied && !cancelled
      ? 'Denied, cancelled and unconfirmed requests are left out.'
      : !denied
        ? 'Denied and unconfirmed requests are left out.'
        : !cancelled
          ? 'Cancelled and unconfirmed requests are left out.'
          : 'Unconfirmed requests are left out.';
  const included =
    denied && cancelled
      ? ' Includes denied and cancelled requests. Their quantities were asked for, not accepted or fulfilled.'
      : denied
        ? ' Includes denied requests. Their quantities were asked for, not accepted or fulfilled.'
        : cancelled
          ? ' Includes cancelled requests. Their quantities were asked for, not accepted or fulfilled.'
          : '';
  return `Status: ${labels}. ${leftOut}${included}`;
}

function warehouseStatusSuffix(status: string | null | undefined): string {
  if (status === 'archived') return ' (archived)';
  if (status === 'inactive') return ' (inactive)';
  return '';
}

/** A warehouse as a filter option: 'North', 'North (archived)'. */
export function bookReportWarehouseOptionLabel(w: { name: string; status: string }): string {
  return `${w.name}${warehouseStatusSuffix(w.status)}`;
}

/** A category as a filter option: 'Fiction', 'Fiction (deleted)'. */
export function bookReportCategoryOptionLabel(c: { name: string; deleted: boolean }): string {
  return `${c.name}${c.deleted ? ' (deleted)' : ''}`;
}

export const BOOK_REPORT_ALL_WAREHOUSES = 'All warehouses you can see';
export const BOOK_REPORT_ALL_CATEGORIES = 'All categories';
export const BOOK_REPORT_NO_CATEGORY = 'No category';

/** 'Warehouse: All warehouses you can see', 'Warehouse: DC4',
 *  'Warehouse: DC4 (your warehouse view)', 'Warehouse: North (archived)'. */
export function bookReportWarehouseLine(
  warehouse: BookReportWarehouseEcho | null,
  source: BookReportWarehouseSource,
): string {
  if (!warehouse) return `Warehouse: ${BOOK_REPORT_ALL_WAREHOUSES}`;
  const view = source === 'view' ? ' (your warehouse view)' : '';
  return `Warehouse: ${warehouse.name}${warehouseStatusSuffix(warehouse.status)}${view}`;
}

/** 'Category: Fiction', 'Category: Fiction (deleted)', 'Category: No
 *  category', or null when every category is shown. */
export function bookReportCategoryLine(
  category: BookReportCategoryEcho | null,
  uncategorized: boolean,
): string | null {
  if (uncategorized) return `Category: ${BOOK_REPORT_NO_CATEGORY}`;
  if (!category) return null;
  return `Category: ${bookReportCategoryOptionLabel(category)}`;
}

/** 'Search: "Hobbit"', or null. */
export function bookReportSearchLine(q: string | null | undefined): string | null {
  const s = (q ?? '').trim();
  return s ? `Search: "${s}"` : null;
}

/** 'Generated Sep 28, 2026, 10:42 AM. Orders can change after this time.' */
export function bookReportGeneratedLine(generatedAtLocal: string): string {
  return `Generated ${formatReportDateTime(generatedAtLocal)}. Orders can change after this time.`;
}

export const BOOK_REPORT_AS_SAVED =
  "Quantities are each order's saved lines as of generation, including later edits to those orders.";
export const BOOK_REPORT_RESTRICTED =
  'You see orders only for books in your warehouses, charters and categories.';

type BookReportGrandTotalSummary = {
  copies: string;
  orders: number;
  unresolved: { entries: number };
};

/** 'Grand total for all 2 pages: 642 copies requested in 26 orders.'
 *  The order count covers every order containing books, other units
 *  included, while the copy total leaves other units out. So when any row is
 *  in another unit the two figures are stated apart, never as "N copies in
 *  M orders": 'Grand total: 15 copies requested. Orders containing books: 4.' */
export function bookReportGrandTotalLine(
  summary: BookReportGrandTotalSummary,
  totalPages: number,
): string {
  const lead = totalPages > 1 ? `Grand total for all ${n(totalPages)} pages` : 'Grand total';
  if (summary.unresolved.entries > 0) {
    return `${lead}: ${copiesRequestedText(summary.copies)}. ${BOOK_REPORT_METRICS.orders.label}: ${n(summary.orders)}.`;
  }
  return `${lead}: ${copiesRequestedText(summary.copies)} in ${ordersCountText(summary.orders)}.`;
}

/** The PDF's closing line, with the entry count:
 *  'Grand total: 34 copies requested in 3 orders · 2 book entries.', or with
 *  other units present 'Grand total: 15 copies requested. Orders containing
 *  books: 4. Distinct book entries: 4.' */
export function bookReportPdfGrandTotalLine(
  summary: BookReportGrandTotalSummary & { entries: number },
): string {
  if (summary.unresolved.entries > 0) {
    return `${bookReportGrandTotalLine(summary, 1)} ${BOOK_REPORT_METRICS.entries.label}: ${n(summary.entries)}.`;
  }
  return `Grand total: ${copiesRequestedText(summary.copies)} in ${ordersCountText(summary.orders)} · ${entriesCountText(summary.entries)}.`;
}

/** 'Latest order Sep 20, 2026'. */
export function latestOrderText(latestOrderDate: string | null): string {
  return latestOrderDate ? `Latest order ${formatReportDate(latestOrderDate)}` : '';
}

export const BOOK_REPORT_VIEW_ORDERS = 'View orders';

/** Badges a row carries, in reading order. */
export function bookReportRowBadges(row: {
  itemStatus: string;
  deleted: boolean;
  nowRental: boolean;
  countsAsCopies: boolean;
  unit: string | null;
}): string[] {
  const out: string[] = [];
  if (row.deleted) out.push('Deleted item');
  else if (row.itemStatus === 'archived') out.push('Archived');
  else if (row.itemStatus === 'discontinued') out.push('Discontinued');
  if (row.nowRental) out.push('Now a rental item');
  if (!row.countsAsCopies) out.push(`Other unit: ${bookReportUnitLabel(row.unit)}`);
  return out;
}

export function bookCoverAlt(title: string): string {
  return `Cover of ${title}`;
}
export const BOOK_COVER_PLACEHOLDER = 'No cover';

/** The drill-down header: 'Copies of this book requested: 30 in 3 orders',
 *  or 'Quantity requested (pack of 10): 12 in 2 orders'. Always the book's
 *  FULL totals, never the visible page. */
export function bookReportDrawerHeader(
  book: { countsAsCopies: boolean; unit: string | null },
  totals: { copies: string; orders: number },
): string {
  const lead = book.countsAsCopies
    ? 'Copies of this book requested'
    : `Quantity requested (${bookReportUnitLabel(book.unit)})`;
  return `${lead}: ${formatReportQuantity(totals.copies)} in ${ordersCountText(totals.orders)}`;
}

export const BOOK_REPORT_ORDER_COLUMNS = {
  orderNumber: 'Order #',
  orderDate: 'Order date',
  warehouse: 'Warehouse',
  status: 'Status',
} as const;

export const BOOK_REPORT_ORDER_LINK_HINT = "Opening other people's orders needs approval access.";

/** '(2 lines)' for an order that asked for this book on more than one line. */
export function combinedLinesText(lines: number): string | null {
  return lines > 1 ? `(${n(lines)} lines)` : null;
}

/** 'Recorded as fulfilled: 8 · Returned: 2', or null when both are zero. */
export function fulfilledReturnedLine(totals: {
  fulfilled: string;
  returned: string;
}): string | null {
  const f = Number(totals.fulfilled) !== 0;
  const r = Number(totals.returned) !== 0;
  if (!f && !r) return null;
  return [
    f ? `Recorded as fulfilled: ${formatReportQuantity(totals.fulfilled)}` : null,
    r ? `Returned: ${formatReportQuantity(totals.returned)}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** 'As of 10:42 AM. An order opens as it is now, so its lines may differ if
 *  it changed after this time.' */
export function bookReportAsOfNote(generatedAtLocal: string): string {
  return `As of ${formatReportTime(generatedAtLocal)}. An order opens as it is now, so its lines may differ if it changed after this time.`;
}

export const BOOK_REPORT_NOT_IN_SCOPE = "This book isn't in your report scope.";

export const BOOK_REPORT_FULFILLED_NOTE =
  'Recorded as fulfilled: units the order recorded as handed over. Since July 9, 2026 this is recorded at a signed hand-over; earlier orders recorded it when picking finished. It is not proof of delivery and is never subtracted.';

export const BOOK_REPORT_EMPTY = 'No book orders match these filters.';
export const BOOK_REPORT_EMPTY_DEFAULT_STATUS =
  'Denied and cancelled requests are left out. Include them from Status.';
export const BOOK_REPORT_EMPTY_SEARCH = 'Search looks at title, SKU and ISBN.';

export const BOOK_REPORT_LOAD_ERROR = "Couldn't load Book Order Totals. Try again.";
export const BOOK_REPORT_ORDERS_LOAD_ERROR = "Couldn't load these orders. Try again.";
export const BOOK_REPORT_TIMEOUT = 'The report took too long. Narrow the filters and try again.';
export const BOOK_REPORT_FILTERS_RESET = 'Some filters in this link were not valid and were reset.';
export const BOOK_REPORT_OPTIONS_ERROR = "Couldn't load the warehouse and category lists. Retry";
export const BOOK_REPORT_FORBIDDEN = "You don't have access to reports.";
export const BOOK_REPORT_MODULE_OFF = 'Book Order Totals needs the Orders and Books modules.';

export const BOOK_REPORT_EXPORT_CSV = 'CSV (data only, no covers)';
export const BOOK_REPORT_EXPORT_PDF_COVERS = 'PDF with covers';
export const BOOK_REPORT_EXPORT_PDF_PLAIN = 'PDF without covers';
export const BOOK_REPORT_EXPORT_COVER_CAP_NOTE = `Covers for the first ${BOOK_REPORT_PDF_COVER_CAP} books; every row and total is included.`;
export const BOOK_REPORT_EXPORT_ANDROID = 'Export from the web on Android for now.';
export const BOOK_REPORT_OPEN_ON_WEB = 'Open this report on the web';

/** 'Too many books for one file (21,340; the limit is 20,000). Narrow the filters.' */
export function bookReportTooManyText(count: number, limit: number): string {
  return `Too many books for one file (${n(count)}; the limit is ${n(limit)}). Narrow the filters.`;
}

export const BOOK_REPORT_MFA_ENROLL =
  'Set up two-step verification to open this report. Your organization requires it for admins.';
export const BOOK_REPORT_MFA_VERIFY = 'Verify with your authenticator app to open this report.';

/** 'How this is counted': the definition, the defaults and every
 *  historical-data limit, in short form (plan section 14). */
export const BOOK_REPORT_HOW_COUNTED: readonly string[] = [
  'Each total adds the copies requested on order lines for books (items of type book), once per line. Lines for other items on the same order are not counted.',
  "An order counts in the date range by the date it was placed, in the organization's time zone. A range runs through the whole last day.",
  'By default every order awaiting approval, in progress, backordered or completed counts. Denied and cancelled requests are left out unless you include them, and unconfirmed public-link requests never count.',
  'Fulfilled and returned quantities are separate facts and are never subtracted from the copies requested.',
  "Status is each order's status now, not its status at an earlier date.",
  BOOK_REPORT_AS_SAVED +
    " Removed lines are gone and do not count; the original request is only in the order's history.",
  'Whether an item is a book is its type now. An item retyped since it was ordered moves in or out of the report with all its history.',
  "What you can see is decided by each book's current warehouse, charter and category.",
  "Units are each item's unit now. Only single copies are added to Total books ordered; anything in another unit is listed with its unit and left out of that total.",
  'Records that share a title or ISBN count separately, told apart by their SKU, warehouse and rack.',
  'Archived and deleted books keep their order history.',
  'Books added through a kit count as the lines the kit added. Present-day kit recipes are never expanded.',
  'Order dates and warehouses can be edited after an order is placed; the report uses the saved values.',
  "A backorder closed by lowering its quantity shows the lowered quantity; the original is in the order's history.",
  'Bundle distributions and rentals are not Orders and are not counted.',
  "The warehouse filter uses each order's warehouse.",
  'Books turned into rental items keep their order history.',
  'Public-link orders are dated when their form was submitted, not when they were confirmed.',
  '"All time" means since your organization began placing orders in StockPilot. Demand from before that is not in the system.',
  BOOK_REPORT_FULFILLED_NOTE,
  'The generated time is when the figures were read. Orders can change afterwards, and an export is read fresh and carries its own time.',
];

/** The PDF's cover disclosure: 'Covers shown for 498 of 612 books. 2 could
 *  not be loaded and 112 are past the 500-cover limit; each shows a
 *  placeholder. Every row and total is included.' */
export function bookReportPdfCoverNote(input: {
  photos: boolean;
  rows: number;
  shown: number;
  failed: number;
  pastCap: number;
}): string {
  if (!input.photos) return 'Exported without covers.';
  const books = `${n(input.rows)} ${input.rows === 1 ? 'book' : 'books'}`;
  const lead = `Covers shown for ${n(input.shown)} of ${books}.`;
  const missing = input.rows - input.shown;
  if (missing <= 0) return lead;
  const reasons: string[] = [];
  if (input.failed > 0) reasons.push(`${n(input.failed)} could not be loaded`);
  if (input.pastCap > 0)
    reasons.push(
      `${n(input.pastCap)} ${input.pastCap === 1 ? 'is' : 'are'} past the ${n(BOOK_REPORT_PDF_COVER_CAP)}-cover limit`,
    );
  const noCover = missing - input.failed - input.pastCap;
  if (noCover > 0) reasons.push(`${n(noCover)} ${noCover === 1 ? 'has' : 'have'} no cover`);
  return `${lead} ${reasons.join(', ').replace(/, ([^,]*)$/, ' and $1')}; each shows a placeholder. Every row and total is included.`;
}

export const BOOK_REPORT_OFFLINE_NEEDS_CONNECTION = 'Book Order Totals needs a connection.';

/** "You're offline. Showing this report as of 10:42 AM for these filters." */
export function bookReportOfflineAsOf(generatedAtLocal: string): string {
  return `You're offline. Showing this report as of ${formatReportTime(generatedAtLocal)} for these filters.`;
}

export const BOOK_REPORT_KPI_LOAD_ERROR = "Couldn't load these figures. Pull to refresh.";

// ── Controls, table and notices (added with the web page) ───────────────────

/** Labels of the report's controls, table and pager, shared by the web page
 *  and the phone so both name each control the same way. */
export const BOOK_REPORT_UI = {
  filters: 'Filters',
  dateRange: 'Orders placed',
  from: 'From',
  to: 'To',
  apply: 'Apply',
  customRangeInvalid:
    'Choose two real dates between 2000 and 2100, the first on or before the second.',
  status: 'Status',
  statusReset: 'Reset to default',
  statusNoneChosen: 'Choose at least one status.',
  warehouse: 'Warehouse',
  category: 'Category',
  sort: 'Sort',
  search: 'Search books',
  searchPlaceholder: 'Title, SKU or ISBN',
  searching: 'Searching Book Order Totals',
  clearSearch: 'Clear search',
  listsLoading: 'Loading the list',
  retry: 'Retry',
  refresh: 'Refresh',
  columnCover: 'Cover',
  columnBook: 'Book',
  columnCopies: 'Copies requested',
  columnQuantity: 'Quantity requested',
  columnOrders: 'Orders',
  columnLatest: 'Latest order',
  columnActions: 'Actions',
  previous: 'Previous',
  next: 'Next',
  pagesNav: 'Book Order Totals pages',
  ordersPagesNav: 'Order pages',
  summaryRegion: 'Totals for every book that matches these filters',
  scopeRegion: 'What these totals cover',
  howCounted: 'How this is counted',
  close: 'Close',
  noOrderNumber: 'No order number',
  loadingOrders: 'Loading orders',
  tryAgain: 'Try again',
  mfaEnrollAction: 'Set up two-step verification',
  mfaVerifyAction: 'Verify now',
} as const;

/** The quantity column's header: 'Copies requested' while every row is in
 *  single copies, else 'Quantity requested' (a pack quantity is not copies;
 *  each other-unit cell names its unit). */
export function bookReportQuantityColumnLabel(anyOtherUnit: boolean): string {
  return anyOtherUnit ? BOOK_REPORT_UI.columnQuantity : BOOK_REPORT_UI.columnCopies;
}

/** The pager's nouns: 'Showing 1–25 of 32 book entries · Page 1 of 2'. */
export const BOOK_REPORT_LIST_NOUN = { one: 'book entry', other: 'book entries' } as const;
/** The drill-down pager's nouns. */
export const BOOK_REPORT_ORDERS_NOUN = { one: 'order', other: 'orders' } as const;

/** The table's caption for screen readers: 'Book entries sorted by Most
 *  copies. Page 1 of 2.' */
export function bookReportTableCaption(
  sort: BookReportSort,
  page: number,
  totalPages: number,
): string {
  return `Book entries sorted by ${BOOK_REPORT_SORT_LABELS[sort]}. Page ${n(page)} of ${n(totalPages)}.`;
}

/** The row action's spoken name: 'View orders for Book A'. */
export function bookReportViewOrdersLabel(title: string): string {
  return `${BOOK_REPORT_VIEW_ORDERS} for ${title}`;
}

/**
 * The notice when a report reached through the person's warehouse view is
 * still showing the warehouse it was opened with, but the view has changed
 * since: 'Your warehouse view is now DC5. This report still shows DC4.'
 * `now.id` null means the view now covers every warehouse; a known id whose
 * name is not at hand is worded without it.
 */
export function bookReportViewChangedLine(
  now: { id: string | null; name: string | null },
  shownName: string,
): string {
  const lead =
    now.id === null
      ? 'Your warehouse view is now all warehouses.'
      : now.name
        ? `Your warehouse view is now ${now.name}.`
        : 'Your warehouse view has changed.';
  return `${lead} This report still shows ${shownName}.`;
}

/** The notice's link: 'Show DC5', 'Show all warehouses' or 'Show your
 *  warehouse view'. */
export function bookReportShowViewLabel(now: { id: string | null; name: string | null }): string {
  if (now.id === null) return 'Show all warehouses';
  return now.name ? `Show ${now.name}` : 'Show your warehouse view';
}

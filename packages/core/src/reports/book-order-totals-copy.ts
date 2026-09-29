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
import { VERIFICATION_SESSION_ENDED_COPY } from '../warehouse/verification';

import {
  BOOK_REPORT_FILTER_KEYS,
  BOOK_REPORT_PDF_COVER_CAP,
  BOOK_REPORT_STATUS_GROUP_KEYS,
  BOOK_REPORT_STATUS_GROUPS,
  bookReportFilterIsSet,
  bookReportUnitLabel,
  bookReportWithoutFilter,
  formatReportDate,
  formatReportDateRange,
  formatReportDateTime,
  formatReportQuantity,
  formatReportTime,
  isDefaultStatusGroups,
  type BookReportCategoryEcho,
  type BookReportCharterEcho,
  type BookReportCharterFilters,
  type BookReportFilterKey,
  type BookReportQuery,
  type BookReportRange,
  type BookReportRangeEcho,
  type BookReportSort,
  type BookReportStatusGroup,
  type BookReportWarehouseEcho,
  type BookReportWarehouseSource,
} from './book-order-totals';
import { CALENDAR_COPY } from './report-calendar';

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
  today: 'Today',
  week: 'This week',
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

/** The range as a label, without a lead: 'All time (May 12, 2026 – Sep 25,
 *  2026)', 'Today (Sep 29, 2026)', 'This week (Sep 27 – Sep 29, 2026)',
 *  'Sep 1 – Sep 30, 2026' (custom). Every date is the org-local string SQL
 *  returned (the resolved days of a preset), never the device's clock. Used
 *  by the Showing block and the chips. */
export function bookReportRangeLabel(
  range: Pick<BookReportRangeEcho, 'key' | 'from' | 'to'>,
  summary?: { firstOrderDate: string | null; lastOrderDate: string | null } | null,
): string {
  if (range.key === 'all') {
    const first = summary?.firstOrderDate ?? null;
    const last = summary?.lastOrderDate ?? null;
    if (first && last) {
      return `${BOOK_REPORT_RANGE_LABELS.all} (${formatReportDate(first)} – ${formatReportDate(last)})`;
    }
    return BOOK_REPORT_RANGE_LABELS.all;
  }
  const dates = formatReportDateRange(range.from, range.to);
  if (range.key === 'custom') return dates || BOOK_REPORT_RANGE_LABELS.custom;
  return dates
    ? `${BOOK_REPORT_RANGE_LABELS[range.key]} (${dates})`
    : BOOK_REPORT_RANGE_LABELS[range.key];
}

/** 'Orders placed during: All time (May 12, 2026 – Sep 25, 2026)',
 *  'Orders placed during: Last 30 days (Aug 30 – Sep 28, 2026)',
 *  'Orders placed during: Sep 1 – Sep 28, 2026' (custom). Every date is the
 *  org-local string SQL returned. */
export function bookReportRangeLine(
  range: Pick<BookReportRangeEcho, 'key' | 'from' | 'to'>,
  summary?: { firstOrderDate: string | null; lastOrderDate: string | null } | null,
): string {
  return `Orders placed during: ${bookReportRangeLabel(range, summary)}`;
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

// ── The ORDER's charter (0382) ──────────────────────────────────────────────

export const BOOK_REPORT_ALL_CHARTERS = 'All charters';
export const BOOK_REPORT_NO_CHARTER = 'No charter';
/** Under "No charter" in the Charter select and sheet. */
export const BOOK_REPORT_NO_CHARTER_HINT = 'Pickup orders and orders placed without a charter.';
/** Under the Charter select: which charter this is. */
export const BOOK_REPORT_CHARTER_HINT = 'The charter each order was placed for.';
/** The one refusal for a charter id the caller may not use, whatever the
 *  cause (unknown, another organization's, outside their scope; plan D3). */
export const BOOK_REPORT_INVALID_CHARTER = 'That charter is not one you can see.';

/** Shown for a charter chosen with one warehouse in effect (chosen or from
 *  the warehouse view) when nothing matched. */
export const BOOK_REPORT_EMPTY_CHARTER_WAREHOUSE =
  "This charter's orders may be at another warehouse. Choose All warehouses you can see to include them.";

/** The order page's way back to the report it was opened from (plan D17). */
export const BOOK_REPORT_BACK_TO_REPORT = 'Back to Book Order Totals';

/** A charter as a filter option: 'Marconi · MAR-01', 'Marconi' (no code, or
 *  a code that only repeats the name), 'Marconi · MAR-01 (archived)'. */
export function bookReportCharterOptionLabel(c: {
  name: string | null;
  code?: string | null;
  status?: string | null;
}): string {
  const name = (c.name ?? '').trim() || 'Unnamed charter';
  const code = (c.code ?? '').trim();
  const withCode = code && code.toLowerCase() !== name.toLowerCase() ? `${name} · ${code}` : name;
  return `${withCode}${warehouseStatusSuffix(c.status)}`;
}

/**
 * Labels for a whole list of charters, by id (the web select, the phone
 * sheet, the by-charter list). Labels that would read the same (the same
 * name with no code; codes are unique within an organization) each get the
 * start of their id: 'Alder (id 1a2b3c4d)', so two choices never look alike.
 */
export function bookReportCharterOptionLabels(
  charters: readonly {
    id: string;
    name: string | null;
    code?: string | null;
    status?: string | null;
  }[],
): Map<string, string> {
  const base = charters.map((c) => ({ id: c.id, label: bookReportCharterOptionLabel(c) }));
  const byLabel = new Map<string, string[]>();
  for (const b of base) {
    const k = b.label.toLowerCase();
    const ids = byLabel.get(k) ?? [];
    if (!ids.includes(b.id)) ids.push(b.id);
    byLabel.set(k, ids);
  }
  const out = new Map<string, string>();
  for (const b of base) {
    const ids = byLabel.get(b.label.toLowerCase())!;
    if (ids.length < 2) {
      out.set(b.id, b.label);
      continue;
    }
    // The first 8 characters, or the whole id if two of them share those.
    const short = b.id.slice(0, 8);
    const clash = ids.some((other) => other !== b.id && other.slice(0, 8) === short);
    out.set(b.id, `${b.label} (id ${clash ? b.id : short})`);
  }
  return out;
}

/** The charter an answer is for, as a value: 'All charters', 'Marconi ·
 *  MAR-01' or 'No charter'. `labels` (from bookReportCharterOptionLabels)
 *  wins when it names the charter, so a tie-broken label reads the same
 *  everywhere. */
export function bookReportCharterLabel(
  echo: BookReportCharterEcho | null | undefined,
  noCharter: boolean | null | undefined,
  labels?: ReadonlyMap<string, string> | null,
): string {
  if (echo) return labels?.get(echo.id) ?? bookReportCharterOptionLabel(echo);
  if (noCharter === true) return BOOK_REPORT_NO_CHARTER;
  return BOOK_REPORT_ALL_CHARTERS;
}

/** The scope line: 'Charter: All charters', 'Charter: Marconi · MAR-01',
 *  'Charter: No charter (pickup orders and orders placed without a
 *  charter)'. */
export function bookReportCharterLine(
  echo: BookReportCharterEcho | null | undefined,
  noCharter: boolean | null | undefined,
  labels?: ReadonlyMap<string, string> | null,
): string {
  if (!echo && noCharter === true) {
    return `Charter: ${BOOK_REPORT_NO_CHARTER} (pickup orders and orders placed without a charter)`;
  }
  return `Charter: ${bookReportCharterLabel(echo, noCharter, labels)}`;
}

/** A drill-down order's charter: 'Marconi · MAR-01', 'No charter', or null
 *  when the answer does not carry it (a server before 0382). */
export function bookReportOrderCharterText(row: {
  charterId?: string | null;
  charterName?: string | null;
  charterCode?: string | null;
}): string | null {
  if (row.charterId === undefined) return null;
  if (row.charterId === null) return BOOK_REPORT_NO_CHARTER;
  return bookReportCharterOptionLabel({ name: row.charterName ?? null, code: row.charterCode });
}

// ── "Books ordered by charter" (page only, All charters) ───────────────────

export const BOOK_REPORT_BY_CHARTER_TITLE = 'Books ordered by charter';
/** Under the list when some books are in another unit. */
export const BOOK_REPORT_BY_CHARTER_UNITS_NOTE =
  'Copies in single-copy units only, as in Total books ordered.';

/** A charter's figures: '1,284 copies in 12 orders', '1 copy in 1 order'.
 *  With books in other units in the report, the orders include some that
 *  hold none of the copies, so the two are stated apart: '12 copies · 4
 *  orders'. */
export function bookReportByCharterValue(
  copies: string,
  orders: number,
  otherUnits = false,
): string {
  const c = `${formatReportQuantity(copies)} ${copies === '1' ? 'copy' : 'copies'}`;
  return otherUnits ? `${c} · ${ordersCountText(orders)}` : `${c} in ${ordersCountText(orders)}`;
}

/** The list's last line, equal to the summary: 'All charters: 642 copies
 *  requested in 26 orders.', or with other units 'All charters: 15 copies
 *  requested. Orders containing books: 4.' */
export function bookReportByCharterTotalLine(summary: {
  copies: string;
  orders: number;
  unresolved: { entries: number };
}): string {
  if (summary.unresolved.entries > 0) {
    return `${BOOK_REPORT_ALL_CHARTERS}: ${copiesRequestedText(summary.copies)}. ${BOOK_REPORT_METRICS.orders.label}: ${n(summary.orders)}.`;
  }
  return `${BOOK_REPORT_ALL_CHARTERS}: ${copiesRequestedText(summary.copies)} in ${ordersCountText(summary.orders)}.`;
}

/** A by-charter row's action name: 'Show only Marconi · MAR-01'. */
export function bookReportByCharterApplyLabel(label: string): string {
  return `Show only ${label}`;
}

/** 'Generated Sep 28, 2026, 10:42 AM. Orders can change after this time.' */
export function bookReportGeneratedLine(generatedAtLocal: string): string {
  return `Generated ${formatReportDateTime(generatedAtLocal)}. Orders can change after this time.`;
}

export const BOOK_REPORT_AS_SAVED =
  "Quantities are each order's saved lines as of generation, including later edits to those orders.";
/** "charter" here is the book-OWNING charter and, for readers limited to
 *  some charters, the ORDER's charter (0382 E2b); worded so neither can be
 *  read as the Charter filter. */
export const BOOK_REPORT_RESTRICTED =
  'You see only orders placed in your warehouses (and, where your access is limited to some charters, orders for those charters and orders with no charter), and only books whose warehouse, owning charter and category you can see.';

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
/** A cover exists (or could not be looked up) but did not load: never called
 *  "No cover". */
export const BOOK_COVER_UNAVAILABLE = 'Cover could not be loaded';

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
  /** Shown only with All charters chosen (one charter would repeat it). */
  charter: 'Charter',
  warehouse: 'Warehouse',
  status: 'Status',
} as const;

/** The drill-down header's terms (brief 13): Book, Charter, Orders placed,
 *  Total requested. */
export const BOOK_REPORT_DRAWER_TERMS = {
  book: 'Book',
  charter: 'Charter',
  ordersPlaced: 'Orders placed',
  totalRequested: 'Total requested',
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
export const BOOK_REPORT_OPTIONS_ERROR =
  "Couldn't load the charter, warehouse and category lists. Retry";
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

export const BOOK_REPORT_EXPORT_FORBIDDEN = "You don't have access to export reports.";
export const BOOK_REPORT_SERVER_PROBLEM = 'The server had a problem. Try again in a moment.';
export const BOOK_REPORT_FILTERS_INVALID =
  'These filters could not be used. Reset the filters and try again.';
export const BOOK_REPORT_EXPORT_CONNECTION =
  'The file could not be downloaded. Check the connection and try again.';
export const BOOK_REPORT_EXPORT_PREPARING = 'Preparing the file';

/** 'Too many exports in the last hour. Try again in 12 minutes.' (the
 *  shared export budget, from the route's Retry-After seconds). */
export function bookReportExportRetryText(retryAfterSeconds: number | null): string {
  if (retryAfterSeconds === null || !Number.isFinite(retryAfterSeconds) || retryAfterSeconds <= 0) {
    return 'Too many exports in the last hour. Wait a few minutes and try again.';
  }
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  return `Too many exports in the last hour. Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`;
}

/**
 * Why the export route refused a file, in words, keyed on the HTTP status and
 * the route's own code and details.reason (never on raw text, except a 400's
 * or an MFA refusal's own sentence, which the server writes for people).
 */
export function bookReportExportRefusalText(r: {
  status: number;
  code?: string | null;
  reason?: string | null;
  count?: number | null;
  limit?: number | null;
  message?: string | null;
  retryAfterSeconds?: number | null;
}): string {
  const sentence = r.message && /\s/.test(r.message) ? r.message : null;
  if (r.status === 400) {
    if (
      r.reason === 'too_many_rows' &&
      typeof r.count === 'number' &&
      typeof r.limit === 'number'
    ) {
      return bookReportTooManyText(r.count, r.limit);
    }
    return sentence ?? BOOK_REPORT_FILTERS_INVALID;
  }
  if (r.status === 401) return VERIFICATION_SESSION_ENDED_COPY;
  if (r.status === 403) {
    if (r.reason === 'aal2_required' || r.reason === 'mfa_required') {
      return sentence ?? BOOK_REPORT_EXPORT_FORBIDDEN;
    }
    if (r.code === 'module_disabled') return BOOK_REPORT_MODULE_OFF;
    return BOOK_REPORT_EXPORT_FORBIDDEN;
  }
  if (r.status === 429) return bookReportExportRetryText(r.retryAfterSeconds ?? null);
  if (r.status === 503 && r.reason === 'timeout') return BOOK_REPORT_TIMEOUT;
  return BOOK_REPORT_SERVER_PROBLEM;
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
  "What you can see is decided by each order's warehouse and, where your access is limited to some charters, its charter, and by each book's current warehouse, owning charter and category.",
  "Units are each item's unit now. Only single copies are added to Total books ordered; anything in another unit is listed with its unit and left out of that total.",
  'Records that share a title or ISBN count separately, told apart by their SKU, warehouse and rack.',
  'Archived and deleted books keep their order history.',
  'Books added through a kit count as the lines the kit added. Present-day kit recipes are never expanded.',
  'Order dates, warehouses and charters can be edited after an order is placed; the report uses the saved values.',
  "A backorder closed by lowering its quantity shows the lowered quantity; the original is in the order's history.",
  'Bundle distributions and rentals are not Orders and are not counted.',
  "The warehouse filter uses each order's warehouse.",
  "The Charter filter uses the charter each order was placed for (its delivery site), not the charter that owns a book. Pickup orders have no charter and appear under No charter, as do a few early delivery orders saved without one, so a charter's total counts only orders placed for delivery to it.",
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
  charter: 'Charter',
  dateRange: 'Orders placed',
  from: 'From',
  to: 'To',
  startDate: CALENDAR_COPY.startDate,
  endDate: CALENDAR_COPY.endDate,
  apply: 'Apply',
  cancel: 'Cancel',
  clearFilters: 'Clear filters',
  typeDates: 'Type dates instead',
  /** A chip's remove button: 'Remove charter filter'. */
  removeFilter: (noun: string) => `Remove ${noun} filter`,
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

// ── "Showing" and the filter chips (web and phone render the same lists) ────

export const BOOK_REPORT_SHOWING = 'Showing';

/** The Showing block's status part: 'Eligible orders' for the default
 *  statuses, else '3 of 6 statuses'. The full sentence is bookReportStatusLine. */
export function bookReportShowingStatus(groups: readonly BookReportStatusGroup[]): string {
  if (isDefaultStatusGroups(groups)) return 'Eligible orders';
  const chosen = BOOK_REPORT_STATUS_GROUP_KEYS.filter((g) => groups.includes(g)).length;
  return `${n(chosen)} of ${n(BOOK_REPORT_STATUS_GROUP_KEYS.length)} statuses`;
}

export type BookReportShowingKey = 'charter' | 'range' | 'warehouse' | 'status';

export interface BookReportShowingPart {
  key: BookReportShowingKey;
  text: string;
}

/** What the Showing block reads from: an answer's echoes (never the URL). */
export interface BookReportShowingAnswer {
  range: Pick<BookReportRangeEcho, 'key' | 'from' | 'to'>;
  summary?: { firstOrderDate: string | null; lastOrderDate: string | null } | null;
  filters: BookReportCharterFilters & { warehouse: BookReportWarehouseEcho | null };
  /** Where the warehouse came from (the API answer); without it a named
   *  warehouse reads as chosen. */
  warehouse?: { source: BookReportWarehouseSource } | null;
}

/**
 * The Showing block (brief 8), in order: the charter ('All charters',
 * 'Marconi · MAR-01', 'No charter'), the range ('This month (Sep 1 – Sep 29,
 * 2026)'), the warehouse WHENEVER the report covers one warehouse, the
 * warehouse view included ('Warehouse: DC4 (your warehouse view)'; plan
 * D20), then the status part. Built from the answer's echoes, so it always
 * describes the figures under it.
 */
export function bookReportShowingParts(
  answer: BookReportShowingAnswer,
  statusGroups: readonly BookReportStatusGroup[],
  opts: { charterLabels?: ReadonlyMap<string, string> | null } = {},
): BookReportShowingPart[] {
  const parts: BookReportShowingPart[] = [
    {
      key: 'charter',
      text: bookReportCharterLabel(
        answer.filters.charter,
        answer.filters.noCharter,
        opts.charterLabels,
      ),
    },
    { key: 'range', text: bookReportRangeLabel(answer.range, answer.summary) },
  ];
  if (answer.filters.warehouse) {
    parts.push({
      key: 'warehouse',
      text: bookReportWarehouseLine(
        answer.filters.warehouse,
        answer.warehouse?.source === 'view' ? 'view' : 'explicit',
      ),
    });
  }
  parts.push({ key: 'status', text: bookReportShowingStatus(statusGroups) });
  return parts;
}

/** The nouns of the chips' remove buttons ('Remove date filter'). */
const FILTER_NOUNS: Readonly<Record<BookReportFilterKey, string>> = {
  charter: 'charter',
  dates: 'date',
  status: 'status',
  warehouse: 'warehouse',
  category: 'category',
  q: 'search',
};

export interface BookReportActiveFilter {
  key: BookReportFilterKey;
  /** 'Charter: Marconi · MAR-01', 'Orders placed: Sep 1 – Sep 30, 2026'. */
  text: string;
  /** The remove button's name: 'Remove charter filter'. */
  removeLabel: string;
  /** The query with only this filter back at its default, on page 1. */
  cleared: BookReportQuery;
}

/** The echoes the chips' words come from: a totals answer fits. */
export interface BookReportFilterEchoes {
  range?: Pick<BookReportRangeEcho, 'key' | 'from' | 'to'> | null;
  summary?: { firstOrderDate: string | null; lastOrderDate: string | null } | null;
  filters?:
    | (BookReportCharterFilters & {
        warehouse?: BookReportWarehouseEcho | null;
        category?: BookReportCategoryEcho | null;
        uncategorized?: boolean;
      })
    | null;
}

function chipDates(query: BookReportQuery, echoes: BookReportFilterEchoes | null): string {
  const r = echoes?.range;
  const echoFits =
    r &&
    r.key === query.range &&
    (query.range !== 'custom' || (r.from === query.from && r.to === query.to));
  if (echoFits) return bookReportRangeLabel(r, echoes?.summary);
  if (query.range === 'custom' && query.from && query.to) {
    return formatReportDateRange(query.from, query.to);
  }
  return BOOK_REPORT_RANGE_LABELS[query.range];
}

function chipText(
  key: BookReportFilterKey,
  query: BookReportQuery,
  echoes: BookReportFilterEchoes | null,
  statusLabels: Readonly<Record<OrderStatusKey, string>>,
  charterLabels: ReadonlyMap<string, string> | null | undefined,
): string {
  const f = echoes?.filters ?? null;
  switch (key) {
    case 'charter': {
      if (query.charter === 'none') return `${BOOK_REPORT_UI.charter}: ${BOOK_REPORT_NO_CHARTER}`;
      const id = query.charter.toLowerCase();
      const echo = f?.charter && f.charter.id.toLowerCase() === id ? f.charter : null;
      const label =
        charterLabels?.get(id) ?? (echo ? bookReportCharterOptionLabel(echo) : 'Chosen charter');
      return `${BOOK_REPORT_UI.charter}: ${label}`;
    }
    case 'dates':
      return `${BOOK_REPORT_UI.dateRange}: ${chipDates(query, echoes)}`;
    case 'status': {
      const chosen = BOOK_REPORT_STATUS_GROUP_KEYS.filter((g) => query.statusGroups.includes(g));
      return `${BOOK_REPORT_UI.status}: ${chosen.map((g) => bookReportStatusGroupLabel(g, statusLabels)).join(', ')}`;
    }
    case 'warehouse': {
      const w = f?.warehouse;
      if (w && w.id.toLowerCase() === query.warehouse.toLowerCase()) {
        return bookReportWarehouseLine(w, 'explicit');
      }
      return `${BOOK_REPORT_UI.warehouse}: Chosen warehouse`;
    }
    case 'category': {
      if (query.category === 'none')
        return `${BOOK_REPORT_UI.category}: ${BOOK_REPORT_NO_CATEGORY}`;
      const c = f?.category;
      if (c && c.id.toLowerCase() === query.category.toLowerCase()) {
        return `${BOOK_REPORT_UI.category}: ${bookReportCategoryOptionLabel(c)}`;
      }
      return `${BOOK_REPORT_UI.category}: Chosen category`;
    }
    case 'q':
      return bookReportSearchLine(query.q) ?? '';
  }
}

/**
 * The active-filter chips (brief 8), one per filter that differs from its
 * default, in the order charter, dates, status, warehouse, category, search.
 * A warehouse is a chip only when it was chosen: a warehouse-view warehouse
 * is part of the Showing block, and Clear filters goes back to it. Sort is
 * not a filter and has no chip.
 *
 * `query` is the query the answer on screen was read for: it decides which
 * chips exist, and the words come from `echoes` (the answer), falling back
 * to plain words only when an echo is missing. `opts.base` is the query a
 * removal starts from: on the web the LATEST requested query (plan trap
 * 23), so removing the dates while a charter change is still loading keeps
 * the new charter. It defaults to `query`.
 */
export function bookReportActiveFilters(
  query: BookReportQuery,
  echoes: BookReportFilterEchoes | null,
  statusLabels: Readonly<Record<OrderStatusKey, string>>,
  opts: {
    base?: BookReportQuery | null;
    charterLabels?: ReadonlyMap<string, string> | null;
  } = {},
): BookReportActiveFilter[] {
  const base = opts.base ?? query;
  return BOOK_REPORT_FILTER_KEYS.filter((key) => bookReportFilterIsSet(query, key)).map((key) => ({
    key,
    text: chipText(key, query, echoes, statusLabels, opts.charterLabels),
    removeLabel: BOOK_REPORT_UI.removeFilter(FILTER_NOUNS[key]),
    cleared: bookReportWithoutFilter(base, key),
  }));
}

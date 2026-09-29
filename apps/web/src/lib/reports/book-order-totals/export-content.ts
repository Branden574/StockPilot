import { csvMetaLine, csvRow, sanitizeCsvText } from '@/lib/csv';

import {
  BOOK_REPORT_AS_SAVED,
  BOOK_REPORT_METRICS,
  BOOK_REPORT_RESTRICTED,
  BOOK_REPORT_TITLE,
  bookReportCategoryLine,
  bookReportRangeLine,
  bookReportRowIdentity,
  bookReportSearchLine,
  bookReportStatusLine,
  bookReportWarehouseLine,
  bookReportZoneLine,
  copiesRequestedText,
  unresolvedUnitsNote,
  type BookOrderTotalsResponse,
  type BookReportRow,
  type BookReportStatusGroup,
  type OrderStatusKey,
} from '@stockpilot/core';

/**
 * What a Book Order Totals file says about itself, shared by the CSV and the
 * PDF so both describe the same scope in the same words. Every value comes
 * from the ONE export-mode answer (its own generation time, never the
 * on-screen answer's) plus the status groups asked for and the
 * organization's own status labels.
 */
export interface BookReportExportInput {
  answer: BookOrderTotalsResponse;
  statusGroups: readonly BookReportStatusGroup[];
  statusLabels: Readonly<Record<OrderStatusKey, string>>;
  q: string;
}

/** The scope lines, in reading order (range, status, warehouse, category,
 *  search, generated, zone, restricted). */
export function bookReportScopeLines(input: BookReportExportInput): string[] {
  const { answer } = input;
  // Every person-supplied value (warehouse and category names, the search,
  // the organization's status labels) is flattened to one line and capped
  // before it is composed, so neither the CSV nor the PDF can be broken by a
  // control character in a name.
  const clean = (v: string) => sanitizeCsvText(v);
  const labels = Object.fromEntries(
    Object.entries(input.statusLabels).map(([k, v]) => [k, clean(v)]),
  ) as Record<OrderStatusKey, string>;
  const warehouse = answer.filters.warehouse
    ? { ...answer.filters.warehouse, name: clean(answer.filters.warehouse.name) }
    : null;
  const category = answer.filters.category
    ? { ...answer.filters.category, name: clean(answer.filters.category.name) }
    : null;
  const lines = [
    bookReportRangeLine(answer.range, answer.summary),
    bookReportStatusLine(input.statusGroups, labels),
    bookReportWarehouseLine(warehouse, answer.warehouse.source),
    bookReportCategoryLine(category, answer.filters.uncategorized) ?? 'Category: All categories',
    bookReportSearchLine(clean(input.q)) ?? 'Search: none',
    `Generated: ${answer.generatedAtLocal} ${clean(answer.range.timeZone)}`,
  ];
  if (answer.range.timeZoneFallback) lines.push(bookReportZoneLine(answer.range));
  if (answer.scope.restricted) lines.push(BOOK_REPORT_RESTRICTED);
  return lines;
}

/** The one unit a single other-unit entry is in, for the disclosure. */
export function singleOtherUnit(rows: readonly BookReportRow[]): string | null | undefined {
  const other = rows.filter((r) => !r.countsAsCopies);
  return other.length === 1 ? other[0]!.unit : undefined;
}

/** The summary lines (the three metrics, and the other-unit disclosure). */
export function bookReportSummaryLines(input: BookReportExportInput): string[] {
  const s = input.answer.summary;
  const lines = [
    `${BOOK_REPORT_METRICS.copies.label}: ${copiesRequestedText(s.copies)} (not purchased, not in stock)`,
    `${BOOK_REPORT_METRICS.entries.label}: ${s.entries}`,
    `${BOOK_REPORT_METRICS.orders.label}: ${s.orders}`,
  ];
  const note = unresolvedUnitsNote(s.unresolved, singleOtherUnit(input.answer.rows));
  if (note) lines.push(`Not counted as copies: ${note}`);
  return lines;
}

/** The quantity columns are named for a quantity, not for copies: a row in
 *  another unit (a pack) is not copies. */
export const BOOK_REPORT_CSV_UNITS_NOTE =
  'Quantities are copies only where counts_as_copies is yes; other rows are in the unit shown.';

export const BOOK_REPORT_CSV_COLUMNS = [
  'item_id',
  'title',
  'sku',
  'sku_label',
  'identifier_type',
  'identifier',
  'identifier_label',
  'item_warehouse',
  'rack_or_bin',
  'unit',
  'counts_as_copies',
  'quantity_requested',
  'orders',
  'latest_order_date',
  'latest_order_at',
  'quantity_recorded_fulfilled',
  'quantity_returned',
  'item_status',
  'now_rental',
] as const;

/** Rows per yielded chunk of the streamed CSV. */
export const BOOK_REPORT_CSV_CHUNK_ROWS = 500;

function csvRecord(row: BookReportRow): Record<string, string> {
  const id = bookReportRowIdentity(row);
  return {
    item_id: row.itemId,
    title: row.name,
    sku: row.sku ?? '',
    // Letter-led copies of the two identifier columns: a spreadsheet keeps
    // them as text, where it may turn 9780140449136 into 9.78014E+12 and drop
    // the leading zero of 0140449132 in the raw columns.
    sku_label: id.skuLabel ?? '',
    identifier_type: id.identifierLabel ?? '',
    identifier: id.identifier ?? '',
    identifier_label:
      id.identifier && id.identifierLabel ? `${id.identifierLabel} ${id.identifier}` : '',
    item_warehouse: row.warehouseName ?? '',
    rack_or_bin: row.binLocation ?? '',
    unit: row.unit ?? '',
    counts_as_copies: row.countsAsCopies ? 'yes' : 'no',
    // Exact text from SQL: never reformatted, never rounded.
    quantity_requested: row.copies,
    orders: String(row.orders),
    latest_order_date: row.latestOrderDate ?? '',
    latest_order_at: row.latestOrderAt ?? '',
    quantity_recorded_fulfilled: row.fulfilled,
    quantity_returned: row.returned,
    item_status: row.deleted ? 'deleted' : row.itemStatus,
    now_rental: row.nowRental ? 'yes' : 'no',
  };
}

/**
 * The CSV, as chunks: first the metadata block (one quoted cell per line,
 * sanitized), an empty line and the header, then the rows 500 at a time in
 * the answer's sort order. Data only: no cover and no URL of any kind.
 */
export function* bookReportCsvChunks(input: BookReportExportInput): Generator<string> {
  const meta = [
    csvMetaLine(BOOK_REPORT_TITLE),
    ...bookReportScopeLines(input).map((line) => csvMetaLine(line)),
    ...bookReportSummaryLines(input).map((line) => csvMetaLine(line)),
    csvMetaLine(BOOK_REPORT_AS_SAVED),
    csvMetaLine(
      'Recorded as fulfilled and returned quantities are shown separately and never subtracted.',
    ),
    csvMetaLine(BOOK_REPORT_CSV_UNITS_NOTE),
    csvMetaLine(
      'sku and identifier are exact. A spreadsheet may turn long or zero-led numbers in those two columns into numbers when it opens the file; sku_label and identifier_label repeat them as text.',
    ),
  ];
  yield `${meta.join('\n')}\n\n${BOOK_REPORT_CSV_COLUMNS.join(',')}\n`;
  const rows = input.answer.rows;
  for (let i = 0; i < rows.length; i += BOOK_REPORT_CSV_CHUNK_ROWS) {
    const chunk = rows.slice(i, i + BOOK_REPORT_CSV_CHUNK_ROWS);
    yield `${chunk.map((r) => csvRow(BOOK_REPORT_CSV_COLUMNS, csvRecord(r))).join('\n')}\n`;
  }
}

/**
 * The CSV as a web stream: one chunk is encoded per pull, so the body is
 * streamed (no Content-Length, no 4.5 MB buffered-body limit) and a 20,000-row
 * file is never held as one string.
 */
export function bookReportCsvStream(input: BookReportExportInput): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const chunks = bookReportCsvChunks(input);
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = chunks.next();
      if (next.done) controller.close();
      else controller.enqueue(encoder.encode(next.value));
    },
  });
}

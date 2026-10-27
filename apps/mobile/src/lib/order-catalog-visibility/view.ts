import {
  ORDER_ITEMS_NO_ACCESS_COPY,
  ORDER_ITEMS_STATE_EXPECTED_COPY,
  ORDER_ITEMS_OFFLINE_COPY,
  ORDER_ITEMS_STATE_HIDDEN_COPY,
  ORDER_ITEMS_STATE_SHOWN_COPY,
  orderCatalogManageQueryString,
  orderItemsEmptyCopy,
  orderItemsHiddenSinceCopy,
  orderItemsSavedCopy,
  parseOrderCatalogManageQuery,
  type OrderCatalogManageListAnswer,
  type OrderCatalogManageQuery,
  type OrderCatalogManageRow,
  type OrderCatalogVisibilityWriteAnswer,
} from '@stockpilot/core';

import type { ManageFailure } from './api';
import type { SelectedRecord } from './selection';

/**
 * MANAGE ORDER ITEMS ON THE PHONE: WHAT THE SCREEN SHOWS (ordering visibility,
 * 0413; design 8.2, 8.6). Every decision the screen (app/order/manage-items
 * .tsx, which vitest cannot load) makes about its rows, its pages and its
 * states, pure and tested here; the screen is pinned to these by
 * manage-items-wiring.test.ts.
 */

const SEP = ' · ';

// ── One row ─────────────────────────────────────────────────────────────────

/** The state pill: Shown in Orders (ok) or Hidden from Orders (warn). */
export function manageRowStatePill(row: Pick<OrderCatalogManageRow, 'visible'>): { label: string; status: 'ok' | 'warn' } {
  return row.visible
    ? { label: ORDER_ITEMS_STATE_SHOWN_COPY, status: 'ok' }
    : { label: ORDER_ITEMS_STATE_HIDDEN_COPY, status: 'warn' };
}

/** The phone's date words ("Oct 26, 2026"), on the phone's own calendar. */
export function manageDateLabel(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** "Hidden since <date>" for a hidden record whose date reads, else null. */
export function manageRowHiddenSince(
  row: Pick<OrderCatalogManageRow, 'visible' | 'hiddenSince'>,
  format: (d: Date) => string = manageDateLabel,
): string | null {
  if (row.visible || !row.hiddenSince) return null;
  const d = new Date(row.hiddenSince);
  if (Number.isNaN(d.getTime())) return null;
  return orderItemsHiddenSinceCopy(format(d));
}

/** Under the name: the family (when it is not the name itself) and the size,
 *  or a book's author (books have no edition field). Null for neither. */
export function manageRowDetail(row: Pick<OrderCatalogManageRow, 'name' | 'familyName' | 'sizeOrEdition'>): string | null {
  const parts: string[] = [];
  const family = row.familyName?.trim() ?? '';
  if (family !== '' && family.toLowerCase() !== row.name.trim().toLowerCase()) parts.push(family);
  const size = row.sizeOrEdition?.trim() ?? '';
  if (size !== '') parts.push(size);
  return parts.length > 0 ? parts.join(SEP) : null;
}

/** The identifier line: the SKU, then the barcode or ISBN when it differs. */
export function manageRowIdentifier(row: Pick<OrderCatalogManageRow, 'sku' | 'identifier'>): string {
  const sku = row.sku.trim();
  const id = row.identifier?.trim() ?? '';
  return [sku, id !== sku ? id : ''].filter((p) => p !== '').join(SEP);
}

/** What VoiceOver says for a row's checkbox: the record, then its state, so
 *  rows with one name can be told apart (the size, the identifier). */
export function manageRowSpokenLabel(
  row: OrderCatalogManageRow,
  format: (d: Date) => string = manageDateLabel,
): string {
  const parts = [row.name.trim() === '' ? manageRowIdentifier(row) : row.name.trim()];
  const detail = manageRowDetail(row);
  if (detail) parts.push(detail);
  const identifier = manageRowIdentifier(row);
  if (identifier && identifier !== parts[0]) parts.push(identifier);
  if (row.warehouseName) parts.push(row.warehouseName);
  parts.push(manageRowStatePill(row).label);
  if (row.expected) parts.push(ORDER_ITEMS_STATE_EXPECTED_COPY);
  const since = manageRowHiddenSince(row, format);
  if (since) parts.push(since);
  return parts.filter((p) => p !== '').join(', ');
}

/** The record as the selection keeps it (the review sheet's line). */
export function recordFromRow(row: OrderCatalogManageRow): SelectedRecord {
  const identifier = manageRowIdentifier(row);
  return { id: row.id.toLowerCase(), name: row.name, identifier: identifier === '' ? null : identifier, visible: row.visible };
}

// ── Pages ───────────────────────────────────────────────────────────────────

/** The pager's figures, from what the page actually holds. */
export function managePaging(answer: Pick<OrderCatalogManageListAnswer, 'page' | 'pageSize' | 'total' | 'rows'>): {
  pageCount: number;
  rangeStart: number;
  rangeEnd: number;
  total: number;
} {
  const pageCount = Math.max(1, Math.ceil(answer.total / Math.max(1, answer.pageSize)));
  if (answer.rows.length === 0) return { pageCount, rangeStart: 0, rangeEnd: 0, total: answer.total };
  const rangeStart = (answer.page - 1) * answer.pageSize + 1;
  return { pageCount, rangeStart, rangeEnd: rangeStart + answer.rows.length - 1, total: answer.total };
}

/** A page past the end (records hidden or removed since it was asked for):
 *  the last page to read instead, else null. */
export function pageBeyondEnd(answer: Pick<OrderCatalogManageListAnswer, 'page' | 'pageSize' | 'total' | 'rows'>): number | null {
  if (answer.rows.length > 0 || answer.page <= 1 || answer.total === 0) return null;
  return Math.max(1, Math.ceil(answer.total / Math.max(1, answer.pageSize)));
}

/** The page checkbox: the current page's rows only. */
export function pageSelectState(rows: readonly Pick<OrderCatalogManageRow, 'id'>[], selected: ReadonlySet<string>): boolean | 'mixed' {
  if (rows.length === 0) return false;
  const n = rows.filter((r) => selected.has(r.id.toLowerCase())).length;
  if (n === 0) return false;
  return n === rows.length ? true : 'mixed';
}

/** How many of the filter sheet's filters are set (type, warehouse, category). */
export function manageActiveFilterCount(query: OrderCatalogManageQuery): number {
  return (query.type !== 'all' ? 1 : 0) + (query.warehouseId ? 1 : 0) + (query.categoryId ? 1 : 0);
}

/** One answer's identity: the scope it was read for and its exact query. */
export function manageAnswerKey(scopeKey: string, query: OrderCatalogManageQuery): string {
  return `${scopeKey}?${orderCatalogManageQueryString(query)}`;
}

// ── After a write ───────────────────────────────────────────────────────────

/** Rows the answer names take its state. A record newly hidden has no date
 *  until the list is read again (the date is the server's, never the phone's). */
export function rowsAfterWrite(
  rows: readonly OrderCatalogManageRow[],
  answer: OrderCatalogVisibilityWriteAnswer,
): OrderCatalogManageRow[] {
  const named = new Set([...answer.changed, ...answer.unchanged].map((id) => id.toLowerCase()));
  return rows.map((r) => {
    if (!named.has(r.id.toLowerCase())) return r;
    const keepDate = !answer.visible && !r.visible;
    return { ...r, visible: answer.visible, hiddenSince: keepDate ? r.hiddenSince : null };
  });
}

/** Whether the outcome offers "Try again", which resends the SAME body and
 *  operationId: only where trying again can help by itself (another change
 *  held the rows, the rate limit, or no answer at all). A step-up needs a new
 *  sign-in first, and everything else needs a new look at the records. */
export function offerRetry(failure: ManageFailure): boolean {
  return failure.retrySame && (failure.reason === 'busy' || failure.reason === 'rate_limited' || failure.reason === 'no_answer');
}

/** The saved words: exactly what changed and what already was. */
export function savedOutcome(answer: OrderCatalogVisibilityWriteAnswer): string {
  return orderItemsSavedCopy({ visible: answer.visible, changed: answer.changed.length, unchanged: answer.unchanged.length });
}

// ── The list's state ────────────────────────────────────────────────────────

/** The last read of one key: its answer (kept over a failed re-read) and its
 *  last failure. */
export interface StoredList {
  key: string;
  answer: OrderCatalogManageListAnswer | null;
  failure: ManageFailure | null;
}

export type ManageListView =
  | { kind: 'loading' }
  /** Nothing to show: say why (never an empty list for a failed read). */
  | { kind: 'failed'; message: string }
  /** The capability or the feature is not there (no rows ever read). */
  | { kind: 'refused'; message: string }
  | { kind: 'empty'; message: string }
  /** Rows, with a note when a later read failed or the phone is offline. */
  | { kind: 'rows'; answer: OrderCatalogManageListAnswer; note: string | null };

/** What the list area shows for `key`. */
export function manageListView(
  stored: StoredList | null,
  key: string,
  offline: boolean,
  query: OrderCatalogManageQuery = parseOrderCatalogManageQuery({}),
): ManageListView {
  if (!stored || stored.key !== key) return offline ? { kind: 'failed', message: ORDER_ITEMS_OFFLINE_COPY } : { kind: 'loading' };
  const { answer, failure } = stored;
  if (!answer) {
    if (failure?.final) {
      return { kind: 'refused', message: failure.reason === 'forbidden' ? ORDER_ITEMS_NO_ACCESS_COPY : failure.message };
    }
    if (failure) return { kind: 'failed', message: failure.message };
    return offline ? { kind: 'failed', message: ORDER_ITEMS_OFFLINE_COPY } : { kind: 'loading' };
  }
  if (answer.total === 0 && answer.rows.length === 0) {
    return { kind: 'empty', message: orderItemsEmptyCopy({ visibility: query.visibility, hasQuery: query.q.trim() !== '' }) };
  }
  const note = offline ? ORDER_ITEMS_OFFLINE_COPY : failure && failure.message !== '' ? failure.message : null;
  return { kind: 'rows', answer, note };
}

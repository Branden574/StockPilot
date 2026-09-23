/**
 * The stock check behind "Approve partial" and "Resume fulfillment" on the
 * order screen.
 *
 * A pending order offers Approve partial only when a strict approve would fall
 * short; a backordered order offers Resume only when some still-owed item has
 * available stock. Available is on hand minus open reservations, both read for
 * the order's items. These reads FEED A DECISION.
 *
 * THE BUG THIS REPLACES. The screen read both with an unbatched `.in('id', …)`
 * and never read either `error`. A failed on-hand read counted every item as 0
 * on hand, so a fully stocked pending order looked short ("Approve partial")
 * and a backorder hid Resume behind a false "Resume unlocks when owed items are
 * back in stock.". A failed reservations read counted 0 reserved, which
 * overstated availability: the screen offered a strict Approve or a Resume the
 * server then refused.
 *
 * NOW: a failed read, or an item whose on-hand row did not come back (the
 * viewer cannot read it: inventory_items visibility is limited by warehouse,
 * charter and category, while every member can see every order), is a
 * `failed` check, never a check with zeros in it. The gates then disable
 * Approve partial / Resume and say why.
 *
 * Pure: the screen passes `supabase` in. Do not import ./supabase here.
 */

import { settleIdBatchRead, type IdReadClient } from './id-batches';
import { readOnHand, readOpenReservations, sumReservedByItem } from './id-reads';

/** The order-line fields the check reads. */
export interface StockCheckLine {
  item_id: string | null;
  quantity_requested: number | string | null;
  quantity_fulfilled: number | string | null;
}

/** The only statuses whose actions depend on stock. */
export function needsStockCheck(status: string | null | undefined): boolean {
  return status === 'pending_approval' || status === 'backordered';
}

/**
 * The two stock flags, judged on PER-ITEM demand (duplicate-item lines are
 * summed first), mirroring the web page loader. Moved verbatim from the order
 * screen. Only called with complete maps: loadOrderStockCheck fails the check
 * before an item can fall through to the `?? 0` below.
 */
export function computeOrderStockFlags(
  status: string,
  lines: readonly StockCheckLine[],
  onHandById: ReadonlyMap<string, number>,
  reservedById: ReadonlyMap<string, number>,
): { isShortStock: boolean; hasFulfillableStock: boolean } {
  let isShortStock = false;
  let hasFulfillableStock = false;
  const demandByItem = new Map<string, { requested: number; owed: number }>();
  for (const l of lines) {
    if (!l.item_id) continue;
    const entry = demandByItem.get(l.item_id) ?? { requested: 0, owed: 0 };
    entry.requested += Number(l.quantity_requested) || 0;
    entry.owed += Math.max(
      0,
      (Number(l.quantity_requested) || 0) - (Number(l.quantity_fulfilled) || 0),
    );
    demandByItem.set(l.item_id, entry);
  }
  for (const [itemId, d] of demandByItem) {
    const available = Math.max(0, (onHandById.get(itemId) ?? 0) - (reservedById.get(itemId) ?? 0));
    if (status === 'pending_approval' && d.requested > available) isShortStock = true;
    if (status === 'backordered' && d.owed > 0 && available > 0) hasFulfillableStock = true;
  }
  return { isShortStock, hasFulfillableStock };
}

export type OrderStockCheck =
  /** Not a stock-dependent status, or no line points at an item. */
  | { state: 'not_needed' }
  | { state: 'ok'; isShortStock: boolean; hasFulfillableStock: boolean }
  /**
   * `read`: a read failed (retrying can help).
   * `hidden_items`: an item on the order did not come back from the on-hand
   * read, so its stock is unknown to this viewer (retrying will not help).
   */
  | { state: 'failed'; reason: 'read' | 'hidden_items'; message: string };

/**
 * Read on hand and open reservations for the order's items (batched, both at
 * once) and compute the flags. Any failure is `failed`, never zeros.
 */
export async function loadOrderStockCheck(
  client: IdReadClient,
  orgId: string,
  status: string | null | undefined,
  lines: readonly StockCheckLine[],
): Promise<OrderStockCheck> {
  if (!status || !needsStockCheck(status)) return { state: 'not_needed' };
  const itemIds = [...new Set(lines.map((l) => l.item_id).filter((x): x is string => Boolean(x)))];
  if (itemIds.length === 0) return { state: 'not_needed' };
  const [onHand, reservations] = await Promise.all([
    settleIdBatchRead(readOnHand(client, orgId, itemIds)),
    settleIdBatchRead(readOpenReservations(client, orgId, itemIds)),
  ]);
  if (!onHand.ok) return { state: 'failed', reason: 'read', message: onHand.message };
  if (!reservations.ok) return { state: 'failed', reason: 'read', message: reservations.message };
  const missing = itemIds.filter((itemId) => !onHand.value.has(itemId));
  if (missing.length > 0) {
    return {
      state: 'failed',
      reason: 'hidden_items',
      message: `${missing.length} item${missing.length === 1 ? '' : 's'} on this order did not load.`,
    };
  }
  return {
    state: 'ok',
    ...computeOrderStockFlags(status, lines, onHand.value, sumReservedByItem(reservations.value)),
  };
}

/** What the order screen renders for the stock-dependent actions. */
export interface OrderStockGates {
  /** pending_approval only. Plain Approve is never gated here: it never
   *  depended on this read, and the server's strict approve refuses a short
   *  order with its own clear message. */
  approvePartial: 'hidden' | 'enabled' | 'disabled';
  /** backordered only. `waiting` keeps the existing "Resume unlocks…" line. */
  resume: 'enabled' | 'disabled' | 'waiting';
  /** Why an action is disabled, shown under the actions. */
  notice: string | null;
  /** Whether a "Try again" can help (a read failed, not a hidden item). */
  canRetry: boolean;
}

const HIDDEN_ITEMS_PREFIX =
  'Some items on this order are not visible to you, so stock could not be checked.';

export function orderStockGates(status: string, check: OrderStockCheck): OrderStockGates {
  const failedRead = check.state === 'failed' && check.reason === 'read';
  const notice = (action: string): string =>
    failedRead
      ? `Could not check stock for this order. ${action} is unavailable until it loads.`
      : `${HIDDEN_ITEMS_PREFIX} ${action} is unavailable.`;
  if (status === 'pending_approval') {
    if (check.state === 'failed') {
      return {
        approvePartial: 'disabled',
        resume: 'waiting',
        notice: notice('Approve partial'),
        canRetry: failedRead,
      };
    }
    return {
      approvePartial: check.state === 'ok' && check.isShortStock ? 'enabled' : 'hidden',
      resume: 'waiting',
      notice: null,
      canRetry: false,
    };
  }
  if (status === 'backordered') {
    if (check.state === 'failed') {
      return {
        approvePartial: 'hidden',
        resume: 'disabled',
        notice: notice('Resume fulfillment'),
        canRetry: failedRead,
      };
    }
    return {
      approvePartial: 'hidden',
      resume: check.state === 'ok' && check.hasFulfillableStock ? 'enabled' : 'waiting',
      notice: null,
      canRetry: false,
    };
  }
  return { approvePartial: 'hidden', resume: 'waiting', notice: null, canRetry: false };
}

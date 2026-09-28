/**
 * The stock-dependent actions on an order: "Approve partial" (pending) and
 * "Resume fulfillment" (backordered), and the note under Approve.
 *
 * MOVED FROM THE PHONE (apps/mobile/src/lib/order-stock-check.ts) so the web
 * order page and the phone order screen gate the same way from the same
 * check. The check itself now comes from readiness (`readinessStockFlags`,
 * readiness.ts), which reads the facts the frozen RPCs decide on, instead of
 * two separate on-hand and reservation reads per platform.
 *
 * A failed check is never a check with zeros in it: a failed read, an item the
 * viewer cannot read, or an order past the line cap DISABLES the action and
 * says why. (Before: a failed on-hand read counted every item as 0 on hand, so
 * a fully stocked order offered "Approve partial"; a failed reservations read
 * counted 0 reserved and offered a Resume the server then refused.)
 */

import type { OrderStockCheck } from './readiness';

/** What the order screen renders for the stock-dependent actions. */
export interface OrderStockGates {
  /** pending_approval only. Plain Approve is never gated here: the server's
   *  strict approve refuses a short order with its own clear message (and
   *  `approveShortNotice` says so beforehand). */
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

const LINES_CAPPED_PREFIX =
  'This order has more than 200 lines, so stock is not checked here.';

const ITEM_MOVED_PREFIX =
  'An item on this order now belongs to another warehouse, so this will be refused. Remove that line first.';

export function orderStockGates(status: string, check: OrderStockCheck): OrderStockGates {
  const failedRead = check.state === 'failed' && check.reason === 'read';
  const notice = (action: string): string => {
    if (check.state === 'failed' && check.reason === 'lines_capped') {
      return `${LINES_CAPPED_PREFIX} ${action} is unavailable.`;
    }
    return failedRead
      ? `Could not check stock for this order. ${action} is unavailable until it loads.`
      : `${HIDDEN_ITEMS_PREFIX} ${action} is unavailable.`;
  };
  if (status === 'pending_approval') {
    if (check.state === 'failed') {
      return {
        approvePartial: 'disabled',
        resume: 'waiting',
        notice: notice('Approve partial'),
        canRetry: failedRead,
      };
    }
    if (check.state === 'ok' && check.itemMoved) {
      // approve_partial raises item_warehouse_mismatch for the whole order.
      return {
        approvePartial: 'disabled',
        resume: 'waiting',
        notice: `${ITEM_MOVED_PREFIX} Approve partial is unavailable.`,
        canRetry: false,
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
    if (check.state === 'ok' && check.itemMoved) {
      // resume_fulfillment raises item_warehouse_mismatch too.
      return {
        approvePartial: 'hidden',
        resume: 'disabled',
        notice: `${ITEM_MOVED_PREFIX} Resume fulfillment is unavailable.`,
        canRetry: false,
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

/**
 * The note under Approve on a pending order a strict Approve would refuse:
 * "2 lines are short, so Approve will be refused. Use Approve partial or change
 * the lines." Null otherwise (including a failed check: the gates' own notice
 * speaks then).
 */
export function approveShortNotice(check: OrderStockCheck): string | null {
  if (check.state !== 'ok' || !check.isShortStock) return null;
  const n = Math.max(1, check.shortLineCount ?? 1);
  return `${n} ${n === 1 ? 'line is' : 'lines are'} short, so Approve will be refused. Use Approve partial or change the lines.`;
}

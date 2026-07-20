import type { StockStatus } from '@/components/filter-sheet';

/**
 * Expected-items visibility (mig 0277, plan 2026-07-20).
 *
 * Items auto-created from expected/inbound POs carry
 * `inventory_items.awaiting_first_receipt = true` until the FIRST stock
 * arrival (a DB trigger clears the flag the moment quantity_on_hand rises —
 * app code never writes it). Until then they are phantoms: showing them as
 * "Out of stock" on the default lists reads as "it got delivered", so the
 * default Items/Books queries exclude them and a dedicated "Expected" option
 * in the filter sheet surfaces them on purpose (web-parity with the Items
 * page's Expected view chip).
 *
 * Both list screens derive their server-side predicate from
 * `listStatusPredicate` and their row pill from `stockPillFor` so the two
 * stay in lockstep and the rules are unit-testable.
 */

export interface ListStatusPredicate {
  /** Value for `.eq('awaiting_first_receipt', …)` — false on every default
   *  view (phantoms hidden), true when the Expected filter is active. */
  awaitingFirstReceipt: boolean;
  /** Value for `.eq('status', …)`, or null to skip lifecycle filtering.
   *  The Expected view spans lifecycles so a flagged item someone manually
   *  archived is still reachable there (it is excluded from the Archived
   *  view by the awaiting_first_receipt = false predicate). */
  lifecycle: 'active' | 'archived' | null;
}

/** Maps the filter sheet's STOCK selection to the list query's
 *  lifecycle + expected-flag predicate. */
export function listStatusPredicate(status: StockStatus): ListStatusPredicate {
  if (status === 'expected') {
    return { awaitingFirstReceipt: true, lifecycle: null };
  }
  return {
    awaitingFirstReceipt: false,
    lifecycle: status === 'archived' ? 'archived' : 'active',
  };
}

export interface StockPillInput {
  quantity_on_hand: number;
  reorder_point: number;
  awaiting_first_receipt: boolean;
}

export interface StockPill {
  status: 'ok' | 'warn' | 'crit';
  label: 'OK' | 'LOW' | 'OUT' | 'EXPECTED';
}

/**
 * Row pill for the Items/Books lists. An awaiting-first-receipt item is NOT
 * out of stock — nothing was ever received — so EXPECTED replaces the OUT
 * pill (the flag wins over stock math; the DB trigger guarantees the flag is
 * false the moment any stock arrives, so the precedence is only ever visible
 * on zero-quantity phantoms). Otherwise identical to the pre-existing
 * OUT / LOW / OK derivation.
 */
export function stockPillFor(item: StockPillInput): StockPill {
  if (item.awaiting_first_receipt) return { status: 'warn', label: 'EXPECTED' };
  if (item.quantity_on_hand <= 0) return { status: 'crit', label: 'OUT' };
  if (item.reorder_point > 0 && item.quantity_on_hand <= item.reorder_point) {
    return { status: 'warn', label: 'LOW' };
  }
  return { status: 'ok', label: 'OK' };
}

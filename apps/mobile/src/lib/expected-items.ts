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

/** Item lifecycle, worst-last (the collapsed header rolls up to the worst). */
export type LifecycleStatus = 'active' | 'archived' | 'discontinued';

export interface StockPillInput {
  quantity_on_hand: number;
  reorder_point: number;
  awaiting_first_receipt: boolean;
  /**
   * Lifecycle (active / archived / discontinued). OPTIONAL only because a few
   * call sites predate it; supply it wherever the row can be non-active. A
   * collapsed SKU-group header shows ARCHIVED / DISC, so a row that omitted
   * this read OUT under a header reading ARCHIVED — header and children
   * disagreeing about the same stock.
   */
  status?: string | null;
}

export interface StockPill {
  status: 'ok' | 'warn' | 'crit' | 'default';
  label: 'OK' | 'LOW' | 'OUT' | 'EXPECTED' | 'ARCHIVED' | 'DISC';
}

/**
 * THE ONE precedence ladder for a stock pill, shared by a collapsed SKU-group
 * header and by every row that header expands to. Both surfaces call it with
 * their own figures — the header with the group's rolled-up lifecycle and
 * summed quantity, a row with its own — so the two can only ever differ where
 * the underlying numbers differ, never because they ran different rules.
 *
 *   1. EXPECTED (mig 0277): nothing was ever received, so "Out of stock"
 *      would read as "it got delivered".
 *   2. Lifecycle: an archived / discontinued record is not a stock level.
 *   3. Stock math: OUT / LOW / OK.
 */
export function stockPill(input: {
  expected: boolean;
  lifecycle: LifecycleStatus;
  quantity: number;
  reorderPoint: number;
}): StockPill {
  if (input.expected) return { status: 'warn', label: 'EXPECTED' };
  if (input.lifecycle === 'archived') return { status: 'default', label: 'ARCHIVED' };
  if (input.lifecycle === 'discontinued') return { status: 'crit', label: 'DISC' };
  if (input.quantity <= 0) return { status: 'crit', label: 'OUT' };
  if (input.reorderPoint > 0 && input.quantity <= input.reorderPoint) {
    return { status: 'warn', label: 'LOW' };
  }
  return { status: 'ok', label: 'OK' };
}

/** Coerce a free-form status column to the lifecycle union. */
export function toLifecycle(status: string | null | undefined): LifecycleStatus {
  return status === 'archived' || status === 'discontinued' ? status : 'active';
}

/** Row adapter for the shared ladder — the Items/Books list card pill. */
export function stockPillFor(item: StockPillInput): StockPill {
  return stockPill({
    expected: item.awaiting_first_receipt,
    lifecycle: toLifecycle(item.status),
    quantity: item.quantity_on_hand,
    reorderPoint: item.reorder_point,
  });
}

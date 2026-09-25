import {
  ELSEWHERE_UNAVAILABLE_NOTE,
  formatElsewhereNote,
  holdingsElsewhereTotal,
  type ItemElsewhere,
} from '@stockpilot/core';

/**
 * Pure, side-effect-free helpers for working with per-location stock holdings.
 *
 * This file intentionally has NO server-only or 'use client' directive so that
 * both the server-only InventoryService AND client-side dialogs can import from
 * here without hitting the Next.js server/client boundary.
 */

/**
 * Filters a holdings list to only the locations that are valid transfer sources:
 *  - quantity must be > 0 (nothing to transfer from an empty location)
 *  - kind must not be 'staging' or 'unplaced' (those are managed by the
 *    staging workflow, not the manual transfer dialog)
 */
export function transferableHoldings<T extends { kind: string | null; quantity: number }>(
  holdings: T[],
): T[] {
  return holdings.filter((h) => h.quantity > 0 && h.kind !== 'staging' && h.kind !== 'unplaced');
}

// ═══════════════════════════════════════════════════════════════════════════
// STOCK IN WAREHOUSES THE VIEWER CANNOT SEE (0371)
// ═══════════════════════════════════════════════════════════════════════════
//
// Staff and viewers read holdings only in their own warehouses (plus locations
// with no warehouse). What the rest of an item's stock is comes from
// item_holdings_elsewhere as totals (InventoryService.hiddenHoldingsFor). These
// helpers live HERE, in a module with no directive, because both server
// components (the Items page builds its rows, the item page its summary) and
// client components (the table, the dialogs) use them: a plain value exported
// from a 'use client' file becomes a client reference on the server (pattern
// #8).

/**
 * The placement-row kind for an item's stock in warehouses the viewer cannot
 * see. The Items page adds one such row per item (from `elsewhere_quantity`);
 * the table renders it as a count, never as a rack.
 */
export const ELSEWHERE_PLACEMENT_KIND = 'elsewhere';

/** The label of that row's RACK cell. */
export const ELSEWHERE_PLACEMENT_LABEL = 'In other warehouses';

/**
 * "+12 in other warehouses" for an item whose stock partly sits in warehouses
 * the viewer cannot see, or null. For cells that describe the whole item (the
 * Books rack cell, an un-expanded Items rack cell).
 */
export function elsewhereSuffix(item: { elsewhere_quantity?: number }): string | null {
  const n = item.elsewhere_quantity ?? 0;
  return n > 0 ? `+${formatElsewhereNote(n)}` : null;
}

/**
 * The item page's "where is the on-hand" line, decided in one place.
 *
 * `stagedAll` / `unplacedAll` are InventoryService.get()'s staged_quantity and
 * unplaced_quantity, which ALREADY include the hidden buckets (folded before
 * derivePlacement). The line splits them back out so each term is what the
 * viewer can see, and the hidden total is its own term:
 *
 *   X placed + Y awaiting put-away + Z in other warehouses = on hand
 *
 * where X + Y + Z = on hand. Returns:
 *   • 'none'        nothing to explain (all stock placed, none elsewhere);
 *   • 'unavailable' the hidden read failed: the page must say so and must NOT
 *                   print a sum that may be missing a part;
 *   • 'line'        the terms. `awaiting` and `elsewhere` are omitted from the
 *                   rendered sentence when 0; `placed` always shows.
 */
export type PlacementSummary =
  | { kind: 'none' }
  | { kind: 'unavailable'; note: string }
  | { kind: 'line'; placed: number; awaiting: number; elsewhere: number; onHand: number };

export function placementSummary(input: {
  onHand: number;
  stagedAll: number;
  unplacedAll: number;
  elsewhere: ItemElsewhere | null | undefined;
}): PlacementSummary {
  const onHand = Number(input.onHand) || 0;
  const el = input.elsewhere;
  if (el?.status === 'unavailable') return { kind: 'unavailable', note: ELSEWHERE_UNAVAILABLE_NOTE };
  const hidden = el?.status === 'some' ? el : null;
  const awaiting = Math.max(
    0,
    (Number(input.stagedAll) || 0) +
      (Number(input.unplacedAll) || 0) -
      (hidden?.staged ?? 0) -
      (hidden?.unplaced ?? 0),
  );
  const elsewhere = holdingsElsewhereTotal(hidden);
  if (awaiting <= 0 && elsewhere <= 0) return { kind: 'none' };
  return {
    kind: 'line',
    placed: Math.max(0, onHand - awaiting - elsewhere),
    awaiting,
    elsewhere,
    onHand,
  };
}

/**
 * Transfer/move DESTINATIONS a scoped member may pick (owner decision Q4,
 * 0371): locations with no warehouse, and locations in a warehouse they can
 * write. `writableWarehouseIds` null means unrestricted (managers and above,
 * and members with every warehouse). UI only: transfer_stock still refuses
 * any other destination (0365).
 */
export function isWritableDestination(
  location: { warehouse_id: string | null },
  writableWarehouseIds: readonly string[] | null | undefined,
): boolean {
  if (!writableWarehouseIds) return true;
  return location.warehouse_id === null || writableWarehouseIds.includes(location.warehouse_id);
}

import {
  formatPlacementLabel,
  resolvePlacement,
  type RackHoldingLike,
} from '@stockpilot/core';

/**
 * Compose the LOCATION cell for a cycle-count sheet row — the label a counter
 * uses to physically walk to the stock.
 *
 * THE PRECEDENCE IS NOT HERE. It lives in `resolvePlacement`
 * (packages/core/src/inventory/placement-resolution.ts), which every
 * picker-facing surface in the repo now shares — this file used to hold the
 * only CORRECT copy of it while eleven siblings held stale ones, which is
 * exactly the drift the extraction ends. This function is now just the
 * cycle-count sheet's RENDER: one cell, one line.
 */
export function countSheetLocationLabel(row: {
  item_type: string | null;
  custom_fields: Record<string, unknown> | null;
  bin_location: string | null;
  primaryLocationName: string | null;
  /** Rack/crate holdings for this item (item_stock_levels), when the
   *  caller batch-fetched them. Omit/empty, or a single RACK holding, =
   *  use the label. Carry `kind` (fetchRackHoldingsByItem does) or the
   *  crate rule cannot fire — see resolvePlacement. */
  rackHoldings?: RackHoldingLike[];
}): string | null {
  return formatPlacementLabel(
    resolvePlacement({
      itemType: row.item_type,
      customFields: row.custom_fields,
      binLocation: row.bin_location,
      siteName: row.primaryLocationName,
      holdings: row.rackHoldings,
    }),
  );
}

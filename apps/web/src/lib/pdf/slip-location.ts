import { formatPlacementLabel, resolvePlacement, type RackHoldingLike } from '@stockpilot/core';

import type { OrderRequestLineWithItem } from '@/server/services/order-requests';

/**
 * The LOCATION column for BOTH order slips — the pick slip and the warehouse
 * packing slip.
 *
 * ═══ WHY THIS FILE EXISTS ═══
 *
 * There were two of these, byte-for-byte identical, and the packing slip's copy
 * said so in its own doc comment: "Mirrors `locationFor` in lib/pdf/pick-slip.tsx
 * — kept as a separate copy (not a shared import) because the two files already
 * diverge in their other location-column concerns and neither depends on the
 * other."
 *
 * That reasoning is what a shared MODULE answers and a copied FUNCTION does not.
 * The two renderers diverging elsewhere is an argument against sharing their
 * TABLE code; it was never an argument for duplicating the one predicate that
 * decides where a picker walks. Both copies then shipped the same 0335 stale-rack
 * bug, and the two fix waves before this one each repaired the copy they were
 * pointed at and left the sibling wrong.
 *
 * So: one module, imported by both. The two slips still own their own tables,
 * their own styles, and their own columns — they just no longer own their own
 * opinion about geography. The precedence itself is one level deeper still, in
 * `resolvePlacement` (packages/core), shared with the cycle-count sheet, the
 * native screens, and every other picker-facing surface.
 *
 * ═══ THE TWO LINES ═══
 *
 * The column renders `primary` above `secondary`. `secondary` exists for exactly
 * one case — a book's crate SUMMARY sitting under its rack ("Rack 39-B" /
 * "Crate Red 5"), which says which box on the shelf. Every other resolution is
 * one line.
 *
 * Exported for direct unit testing: @react-pdf's rendered output is not
 * text-extractable in this suite (the render tests only assert buffer size and
 * the %PDF magic header), so this decision is covered by calling it directly.
 */
export function locationFor(
  line: OrderRequestLineWithItem,
  rackHoldingsByItemId?: Map<string, RackHoldingLike[]>,
): {
  primary: string | null;
  secondary: string | null;
} {
  const item = line.item;
  if (!item) return { primary: null, secondary: null };

  const res = resolvePlacement({
    itemType: item.item_type,
    customFields: (item.custom_fields ?? {}) as Record<string, unknown>,
    // NO bin_location: OrderRequestsService.detail's `item:inventory_items`
    // embed does not select it. Not an oversight to fix here — adding a column
    // to that embed changes every consumer of the detail payload, and the
    // holdings above already carry the crate by name for the case that matters.
    holdings: rackHoldingsByItemId?.get(item.id),
  });

  switch (res.source) {
    case 'holdings':
      // formatPlacementLabel IS formatRackHoldings for this branch — going
      // through it rather than re-spelling the join keeps the breakdown
      // byte-identical to the cycle-count sheet and the native scan sheet.
      return { primary: formatPlacementLabel(res), secondary: null };
    case 'structured':
      return {
        primary: res.rackLabel ? `Rack ${res.rackLabel}` : null,
        secondary: res.crateLabel ? `Crate ${res.crateLabel}` : null,
      };
    // 'bin' and 'site' are unreachable from this input shape (neither is
    // selected above) but are handled rather than defaulted, so that adding
    // either to the embed later renders instead of silently blanking.
    case 'bin':
      return { primary: res.binLocation, secondary: null };
    case 'site':
      return { primary: res.siteName, secondary: null };
    case 'none':
      return { primary: null, secondary: null };
  }
}

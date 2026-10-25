import type { PlacedHoldingLike } from '@stockpilot/core';

/**
 * The `other_holdings` field of an Items or Books list row: the item's placed
 * holdings that are not on a rack or crate (a Site, an area, a NULL-kind shelf
 * or bin), with kind AND type, sorted by name. Core resolvePlacement reads them
 * as `otherHoldings`, so a book whose stock all sits on the Site is named by
 * the Site rather than the rack its keys still name (B37).
 *
 * NO FIELD when there are none, which is most rows: the cached default view
 * (loaders/inventory-list.ts) holds every row of a view in one size-bounded
 * cache entry, and an empty array on each of them would be paid for by all.
 * InventoryService.list and that loader build the field through this one
 * function, so the live and cached rows keep the same shape.
 */
export function otherHoldingsField(
  byLocation: ReadonlyMap<string, PlacedHoldingLike> | undefined,
): { other_holdings?: PlacedHoldingLike[] } {
  if (!byLocation || byLocation.size === 0) return {};
  return {
    other_holdings: [...byLocation.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

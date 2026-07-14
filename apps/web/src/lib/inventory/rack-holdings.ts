/**
 * A "split" item is stock split across >1 distinct rack/crate HOLDING —
 * by location_id, mirroring the server's rackHoldingsByItem grouping in
 * InventoryService.placeItemsOntoRackByName (the gate that decides
 * whether bulk Set rack may physically move an item's stock). This
 * reads `rackHoldingsCount`, NOT a name-deduped list like
 * `placed_racks.length`: an item whose stock sits on a rack named "1-A"
 * in Warehouse A AND a same-named "1-A" in Warehouse B collapses to one
 * entry in a name-deduped list — a false negative the Unit B review
 * caught, since the server still (correctly) refuses to move that item.
 *
 * Kept in its own tiny module (no React/Next dependencies) so both the
 * inventory table's derivation and its unit tests can import it cheaply.
 */
export interface RackHoldingsItem {
  rackHoldingsCount?: number;
}

export function isSplitRackItem(item: RackHoldingsItem): boolean {
  return (item.rackHoldingsCount ?? 0) > 1;
}

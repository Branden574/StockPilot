import { formatRackHoldings, type RackHoldingLike } from '@stockpilot/core';

import { readBookStorage, readItemRack } from '@/lib/book-storage';

/**
 * Compose the LOCATION cell for a cycle-count sheet row — the label a counter
 * uses to physically walk to the stock.
 *
 * Priority:
 *   0. the rack/crate HOLDINGS breakdown ("2-C ×20 · 5-A ×5"), but ONLY when
 *      the item's stock is split across >1 holding — a single free-text
 *      label is misleading at that point (it names one rack while stock
 *      sits on several, and can also go stale). A single holding (or no
 *      holdings data at all) falls through to the label exactly as before.
 *   1. structured rack/crate from custom_fields — books: "Rack 39-B · Crate
 *      Red 5" (crate optional), items: "Rack 38-A"
 *   2. the free-text bin_location
 *   3. the primary location (site) name, e.g. "DC4"
 *
 * The site name alone (the old behavior) told the counter nothing about WHERE
 * in the warehouse to look — every row just said "DC4".
 */
export function countSheetLocationLabel(row: {
  item_type: string | null;
  custom_fields: Record<string, unknown> | null;
  bin_location: string | null;
  primaryLocationName: string | null;
  /** Rack/crate holdings for this item (item_stock_levels), when the
   *  caller batch-fetched them. Omit/empty/single-holding = use the label. */
  rackHoldings?: RackHoldingLike[];
}): string | null {
  if (row.rackHoldings && row.rackHoldings.length > 1) {
    const breakdown = formatRackHoldings(row.rackHoldings);
    if (breakdown) return breakdown;
  }

  const cf = row.custom_fields ?? {};
  let structured: string | null = null;
  if (row.item_type === 'book') {
    const info = readBookStorage(cf);
    structured =
      [
        info.rackLabel ? `Rack ${info.rackLabel}` : null,
        info.crateLabel ? `Crate ${info.crateLabel}` : null,
      ]
        .filter(Boolean)
        .join(' · ') || null;
  } else {
    const info = readItemRack(cf);
    structured = info.rackLabel ? `Rack ${info.rackLabel}` : null;
  }
  return structured || row.bin_location || row.primaryLocationName || null;
}

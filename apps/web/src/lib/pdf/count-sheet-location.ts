import { formatRackHoldings, type RackHoldingLike } from '@stockpilot/core';

import { readBookStorage, readItemRack } from '@/lib/book-storage';

/**
 * Compose the LOCATION cell for a cycle-count sheet row — the label a counter
 * uses to physically walk to the stock.
 *
 * Priority:
 *   0. the rack/crate HOLDINGS breakdown ("2-C ×20 · 5-A ×5") when the
 *      holdings are known to contradict a single label, which is either of:
 *        a. stock split across >1 holding — one label names one rack while
 *           the stock sits on several, and can also go stale;
 *        b. every known holding is a CRATE. A crate that states no rack
 *           position deliberately leaves the item's rack keys ALONE (a
 *           partial put-away leaves the rest of the stock on a rack the
 *           operator never mentioned), so those keys can still name rack
 *           38-A for stock that has entirely moved into "Blue Shelf" — and
 *           this function preferring them would walk the counter to the
 *           wrong aisle. The holding names the crate, including its rack
 *           when it has one ("Gray #BIN on rack 43-B"), so nothing is lost.
 *      A single RACK holding, or no holdings data at all, falls through to
 *      the label exactly as before.
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
   *  caller batch-fetched them. Omit/empty, or a single RACK holding, =
   *  use the label. Carry `kind` (fetchRackHoldingsByItem does) or the
   *  crate rule below cannot fire. */
  rackHoldings?: RackHoldingLike[];
}): string | null {
  const holdings = row.rackHoldings ?? [];
  // A crate holding outranks the item's rack keys. Those keys are a SUMMARY
  // that the put-away into a position-less crate leaves untouched on purpose,
  // so they survive describing a rack the stock has left; the holding is
  // item_stock_levels, i.e. where the stock physically is. `kind` is optional,
  // so a caller that carries no kinds keeps the old precedence rather than
  // getting a guess.
  const crateOnly = holdings.length > 0 && holdings.every((h) => h.kind === 'crate');
  if (holdings.length > 1 || crateOnly) {
    const breakdown = formatRackHoldings(holdings);
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

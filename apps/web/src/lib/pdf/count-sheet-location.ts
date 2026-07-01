import { readBookStorage, readItemRack } from '@/lib/book-storage';

/**
 * Compose the LOCATION cell for a cycle-count sheet row — the label a counter
 * uses to physically walk to the stock.
 *
 * Priority:
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
}): string | null {
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

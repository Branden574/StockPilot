// The public catalog as /r/<token> caches it and ships it (B32, integrator
// decision 3). Shared by the server loader (server/services/public-catalog.ts)
// and the storefront in the browser, so neither imports the other: no
// 'server-only' module reaches the client bundle, and the encoding below
// cannot drift between the side that writes a row and the side that reads it.
//
// WHY COMPACT. The page's catalog is one entry in Next's data cache
// (unstable_cache), and Next does not store an entry past 2 MB: it logs a
// warning and every later view rebuilds the catalog from the database. The
// entry therefore holds only what the page needs to list and search an item,
// as a tuple per item, with category labels stored once. The heavy fields (the
// blur placeholder, the public description, a long cover URL, the signed
// photo) come after first paint, a page at a time, from
// /api/v1/public/catalog-thumbnails.

import { PUBLIC_LOW_STOCK_THRESHOLD } from './public-logic';
import type { PublicAvailability, PublicAvailabilityDisplay, PublicCatalogItem } from './types';

/**
 * The most items one link's page lists for one warehouse. Past it the list is
 * cut, logged, and the page says so (`cut`).
 *
 * Not the internal storefront's CATALOG_ROW_CEILING (10,000): the page's
 * catalog is one entry in Next's data cache, which does not store an entry
 * over 2 MB (it warns, and every view then reads the catalog from the
 * database again). At 2,000 items with every field at its maximum length the
 * entry stays under 1.5 MB by Next's own measure
 * (server/services/public-catalog.caps.test.ts). It replaced a silent cut at
 * the first 500 items by name, past which an item was neither shown nor
 * searchable on the public page.
 */
export const PUBLIC_CATALOG_ROW_CEILING = 2_000;

/**
 * One listed item:
 *   [id, name, category, stock, max per request, cover]
 * - name: the public display name, else the internal name;
 * - category: an index into `categories`, -1 for none;
 * - stock: what the link's display mode shows (stockForRow);
 * - max per request: the entry's cap, else the link's default, else null;
 * - cover: an external cover URL short enough to ship with the page (the
 *   photo route sends the rest), else null.
 */
export type PublicCatalogRow = [
  id: string,
  name: string,
  category: number,
  stock: number | null,
  maxQty: number | null,
  cover: string | null,
];

/** A category a row points at: [id, label]. */
export type PublicCatalogCategory = [id: string, label: string];

export interface PublicCatalogIndex {
  /**
   * The link's availability display mode when the rows were built: what each
   * row's `stock` means. It travels with the rows, so a page never reads them
   * in another mode (the link's own row is cached apart from this entry).
   */
  mode: PublicAvailabilityDisplay;
  categories: PublicCatalogCategory[];
  /** The listed items, by name. */
  rows: PublicCatalogRow[];
  /** True when the link offers more items than the page lists
   *  (PUBLIC_CATALOG_ROW_CEILING): the page says the list stops there. */
  cut: boolean;
}

export const EMPTY_PUBLIC_CATALOG: PublicCatalogIndex = {
  mode: 'none',
  categories: [],
  rows: [],
  cut: false,
};

/** Bucket levels by the number a row stores for them. */
const BUCKET_LEVELS = ['out_of_stock', 'low_stock', 'in_stock'] as const;

/**
 * The stock a row stores for the link's display mode, from the item's net
 * available units (on hand less open reservations):
 * - 'exact': the net count, to 4 decimals (the column's scale), so a float
 *   remainder never lengthens the cached value;
 * - 'bucket': 0 out, 1 low, 2 in, against the fixed public threshold (the
 *   real count never ships for a bucket link);
 * - 'none': null (no stock signal at all).
 */
export function stockForRow(mode: PublicAvailabilityDisplay, net: number): number | null {
  if (mode === 'exact') return Math.round(Math.max(0, net) * 10_000) / 10_000;
  if (mode === 'bucket') return net <= 0 ? 0 : net <= PUBLIC_LOW_STOCK_THRESHOLD ? 1 : 2;
  return null;
}

/** The availability a row's stock shows, read back for the display mode. */
export function availabilityOfRow(
  mode: PublicAvailabilityDisplay,
  stock: number | null,
): PublicAvailability {
  if (mode === 'exact') return { kind: 'exact', count: stock ?? 0 };
  if (mode === 'bucket')
    return { kind: 'bucket', level: BUCKET_LEVELS[stock ?? 0] ?? 'out_of_stock' };
  return { kind: 'none' };
}

/**
 * The page's items from the compact catalog, in its order (by name), each
 * row's stock read in the catalog's own mode. The lazy fields start empty: no
 * description or blur yet, and the cover only when the row carries one. The
 * storefront fills them in as the photo pages arrive.
 */
export function expandPublicCatalog(index: PublicCatalogIndex): PublicCatalogItem[] {
  const { mode } = index;
  return index.rows.map(([id, name, category, stock, maxQty, cover]) => {
    const cat = category >= 0 ? index.categories[category] : undefined;
    return {
      id,
      displayName: name,
      publicDescription: null,
      categoryId: cat?.[0] ?? null,
      // '' when the label could not be read: no label, as before.
      categoryLabel: cat?.[1] || null,
      imageUrl: cover,
      lqip: null,
      availability: availabilityOfRow(mode, stock),
      maxQty,
    };
  });
}

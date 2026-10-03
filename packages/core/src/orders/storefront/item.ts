// The storefront's item and site shapes, shared by the web New order page and
// the phone. Moved from apps/web/src/components/orders/v2/types.ts (phone
// ordering PO-1); the web module re-exports them unchanged.
//
// ═══ NO COST HERE ═══
//
// `StorefrontItem` is the part of an orderable row that the storefront's
// logic and both surfaces read. It has no `price`: the web's `CatalogItem`
// (which falls back to unit cost for `price`) stays in apps/web as a SUPERSET
// of this type, so anything typed with the narrowed shape can never carry
// cost, and the phone's catalog answer is built to this shape without it.

/** An orderable catalog row as the storefront's shared logic reads it. */
export interface StorefrontItem {
  id: string;
  sku: string;
  name: string;
  quantityOnHand: number;
  reservedQuantity: number;
  categoryId: string | null;
  categoryName: string | null;
  /** Charter the item belongs to (null = generic stock that any
   *  charter the warehouse services can pull from). Displayed on the
   *  catalog tile so requesters can see which charter the item is
   *  earmarked for before adding to cart. */
  charterId: string | null;
  charterName: string | null;
  charterCode: string | null;
  rackLabel: string | null;
  reorderPoint: number;
}

export interface AisleSummary {
  /** null = synthetic "Uncategorized" bucket */
  id: string | null;
  name: string;
  itemCount: number;
}

/**
 * `charters.address` is a jsonb blob, not a typed column set. Every key is
 * optional and any of them can be null or an empty string in prod.
 *
 * The regional key is **`region`**, NOT `state`. Reading `state` returns
 * undefined for every row in the database.
 */
export interface CharterAddress {
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  region?: string | null;
  postalCode?: string | null;
  country?: string | null;
}

/**
 * A delivery site as the storefront sees it. The UI calls a charter a "site".
 * `address` is present for 12 of 16 prod charters; null for the rest, and the
 * renderer must print NOTHING rather than an empty labelled block when it is.
 */
export interface StorefrontCharter {
  id: string;
  name: string;
  code: string | null;
  address: CharterAddress | null;
}

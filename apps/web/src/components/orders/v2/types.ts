// Shared types for the orders/new v2 picker.
//
// The storefront's shared shapes (aisles, sites and the cart) moved, unchanged,
// to @stockpilot/core (orders/storefront/item.ts and cart.ts) for phone
// ordering PO-1 and are re-exported below under the same names. CatalogItem
// stays here: it is the web's row, a superset of core's StorefrontItem, and it
// carries `price`, which core's shape deliberately does not.

export interface CatalogItem {
  id: string;
  sku: string;
  name: string;
  warehouseId: string;
  quantityOnHand: number;
  reservedQuantity: number;
  itemType: string | null;
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
  imageUrl: string | null;
  /**
   * Tiny base64 WebP blur (16x16, ≤2KB) from item_images.lqip. Renders
   * instantly as a backdrop while imageUrl resolves client-side, so
   * cards never flash a stark placeholder for items that DO have a
   * photo. null = no item_images row, fall back to letter glyph.
   */
  lqip: string | null;
  /** retail_price preferred, else unit_cost, else null. */
  price: number | null;
  reorderPoint: number;
}

export type {
  AisleSummary,
  CartAction,
  CartKitShares,
  CartLineState,
  CartState,
  CharterAddress,
  StorefrontCharter,
} from '@stockpilot/core';

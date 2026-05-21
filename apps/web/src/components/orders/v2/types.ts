// Shared types for the orders/new v2 picker.

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

export interface AisleSummary {
  /** null = synthetic "Uncategorized" bucket */
  id: string | null;
  name: string;
  itemCount: number;
}

export interface CartLineState {
  itemId: string;
  quantity: number;
}

export interface CartState {
  warehouseId: string;
  charterId: string | null;
  fulfillmentType: 'pickup' | 'delivery';
  onBehalfOf: { name: string; email: string } | null;
  notes: string;
  lines: CartLineState[];
}

export type CartAction =
  | { type: 'hydrate'; state: CartState }
  | { type: 'add'; itemId: string; quantity?: number }
  | { type: 'inc'; itemId: string }
  | { type: 'dec'; itemId: string }
  /** Set exact qty for a line. Quantity <= 0 removes the line entirely
   *  so the same action handles "type 0 to clear" + "type 5 to set". */
  | { type: 'set-qty'; itemId: string; quantity: number }
  | { type: 'remove'; itemId: string }
  | { type: 'clear' }
  | {
      type: 'set-setup';
      patch: Partial<Pick<CartState, 'charterId' | 'fulfillmentType' | 'onBehalfOf'>>;
    }
  | { type: 'set-notes'; value: string }
  | { type: 'set-warehouse'; warehouseId: string };

// ── Which item types a purchase order can order ────────────────────────────
// ONE definition, shared by the PO create page, the PO edit page, the
// recurring-template page and the client-side item picker, so the three
// server reads and the search request can never drift apart (a picker whose
// server search spans a type the SSR list does not would show a row that
// vanishes on reload — and vice versa, the exact class of bug that hid books
// from the picker in the first place).
//
// Why product + book and nothing else:
//   - `inventory_items.item_type` (mig 0020) allows product | book | asset |
//     consumable, but no org in production holds a single asset or consumable
//     row, and neither type has ANY purchasable precedent in the codebase.
//   - Books demonstrably ARE purchasable: po-imports-lines.ts carries a
//     dedicated book/ISBN branch that resolves an imported PO line to an
//     existing book by its ISBN.
// Rentals (circulating assets) stay out for free: InventoryService.list
// excludes `is_rental` unless a caller opts in, and no PO surface does.

export const PURCHASE_ORDER_ITEM_TYPES = ['product', 'book'] as const;

export type PurchaseOrderItemType = (typeof PURCHASE_ORDER_ITEM_TYPES)[number];

/**
 * A fresh mutable copy for `InventoryService.list({ itemTypes })`, whose
 * filter type is a plain array. Returning a new array each call keeps the
 * exported constant impossible to mutate through a caller.
 */
export function purchaseOrderItemTypes(): PurchaseOrderItemType[] {
  return [...PURCHASE_ORDER_ITEM_TYPES];
}

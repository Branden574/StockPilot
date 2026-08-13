/**
 * Order-line totals.
 *
 * MOVED HERE 2026-08-13 from `apps/web/.../storefront/storefront-logic.ts`.
 * The delivery-request builder moved to core and needs these two numbers; so
 * do six web UI call sites (the cart rail, the cart sheet, the storefront
 * header, the overlays, and both public-v2 surfaces), which keep importing it
 * from `storefront-logic` through a re-export.
 *
 * It is here rather than duplicated in the core builder ON PURPOSE. Recurring
 * pattern #26: a fix applied to ONE copy of a duplicated function is not a
 * fix. `lineCount`/`unitCount` are printed in the email body's ITEMS heading
 * AND on the cart badge the requester checks before submitting; if those two
 * ever disagreed, the recipient and the requester would be reading different
 * orders. One function makes that class of drift impossible rather than
 * merely unlikely.
 */

/** The minimum a line has to be for these totals: an id and a quantity. */
export interface OrderLineQuantity {
  itemId: string;
  quantity: number;
}

export interface CartTotals {
  lineCount: number;
  unitCount: number;
}

export function cartTotals(lines: readonly OrderLineQuantity[]): CartTotals {
  return {
    lineCount: lines.length,
    unitCount: lines.reduce((sum, l) => sum + l.quantity, 0),
  };
}

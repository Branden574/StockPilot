import {
  CART_ALL_STOCK_IN_CART_COPY,
  CART_CHECK_OUT_COPY,
  availabilityLabel,
  availableOf,
  cartCountsCopy,
  formatOrderNumber,
  kitAvailability,
  kitsAvailableCopy,
  statusOf,
  storefrontInCartCopy,
  type KitOffer,
  type OrderSummary,
  type StorefrontItem,
} from '@stockpilot/core';

/**
 * WHAT VOICEOVER SAYS IN THE STOREFRONT (phone ordering PO-4). Every row is
 * ONE element with its name, availability and quantity in the cart; every
 * stepper button names its item; what changed is announced (iOS gives a Text
 * no live region, so the screens call announceForAccessibility with these).
 * The visible words are core's; these join them into one spoken label. Pure.
 */

/** "Planner, SKU PL-1, 134 available, earmarked for North Campus, 2 in your cart". */
export function itemRowLabel(item: StorefrontItem, inCart: number, earmark: string | null): string {
  const parts = [item.name];
  if (item.sku) parts.push(`SKU ${item.sku}`);
  parts.push(availabilityLabel(statusOf(item), availableOf(item), 'long'));
  if (earmark) parts.push(`earmarked for ${earmark}`);
  if (inCart > 0) parts.push(storefrontInCartCopy(inCart));
  return parts.join(', ');
}

/** The row's hint: what a tap does. */
export const ITEM_ROW_HINT = 'Opens the item details.';

export function addItemLabel(name: string): string {
  return `Add ${name} to your cart`;
}
export function increaseLabel(name: string): string {
  return `One more ${name}`;
}
export function decreaseLabel(name: string, quantity: number): string {
  return quantity <= 1 ? `Remove ${name} from your cart` : `One fewer ${name}`;
}
/** The count between the stepper buttons: tapping it opens the quantity sheet. */
export function quantityButtonLabel(name: string, quantity: number): string {
  return `${name}: ${storefrontInCartCopy(quantity)}. Change the quantity`;
}
/** Why + is dimmed when everything available is in the cart. */
export function increaseBlockedHint(atMax: boolean): string | undefined {
  return atMax ? CART_ALL_STOCK_IN_CART_COPY : undefined;
}

export function kitRowLabel(kit: KitOffer, itemMap: ReadonlyMap<string, StorefrontItem>, inCart: number): string {
  const parts = [kit.name, kitsAvailableCopy(kitAvailability(kit, itemMap).kits)];
  if (inCart > 0) parts.push(`${inCart} in your cart`);
  return parts.join(', ');
}
export function addKitLabel(name: string): string {
  return `Add one ${name} kit to your cart`;
}
export function increaseKitLabel(name: string): string {
  return `One more ${name} kit`;
}
export function decreaseKitLabel(name: string, kits: number): string {
  return kits <= 1 ? `Take the ${name} kit out of your cart` : `One fewer ${name} kit`;
}

/** The cart bar: "Cart, 3 items · 12 units. Check out". */
export function cartBarLabel(lines: number, units: number): string {
  return `Cart, ${cartCountsCopy(lines, units)}. ${CART_CHECK_OUT_COPY}`;
}

// ── Announcements ───────────────────────────────────────────────────────────

export function addedAnnouncement(name: string, inCart: number): string {
  return `Added ${name}. ${storefrontInCartCopy(inCart)}.`;
}
export function quantityAnnouncement(name: string, inCart: number): string {
  return inCart > 0 ? `${name}: ${storefrontInCartCopy(inCart)}.` : `Removed ${name} from your cart.`;
}
export function kitAnnouncement(name: string, kits: number): string {
  return kits > 0 ? `${name}: ${kits} ${kits === 1 ? 'kit' : 'kits'} in your cart.` : `Took the ${name} kit out of your cart.`;
}
export function submittedAnnouncement(order: Pick<OrderSummary, 'orderNumber' | 'orderLabel'>): string {
  const label = order.orderLabel ?? formatOrderNumber(order.orderNumber);
  return label ? `Order request submitted: ${label}.` : 'Order request submitted.';
}

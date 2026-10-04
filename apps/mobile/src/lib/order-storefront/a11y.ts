import {
  CART_ALL_STOCK_IN_CART_COPY,
  CART_CHECK_OUT_COPY,
  FREQUENTLY_ORDERED_TITLE_COPY,
  ORDER_ADD_WHILE_LOCKED_COPY,
  STOREFRONT_CART_LOCKED_COPY,
  STOREFRONT_LINE_NOT_ORDERABLE_COPY,
  availabilityLabel,
  availableOf,
  cartCountsCopy,
  formatOrderNumber,
  frequentlyOrderedTagCopy,
  kitAvailability,
  kitsAvailableCopy,
  statusOf,
  storefrontInCartCopy,
  type CartState,
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
 * The words rules core's phone-copy.test.ts keeps are applied to every
 * sentence here too (a11y.test.ts, desk check F7.6).
 */

/** "Planner, SKU PL-1, 134 available, Frequently ordered #1 · in 12 orders,
 *  earmarked for North Campus, 2 in your cart": everything the row shows,
 *  the rank and the can't-be-ordered mark included (desk check F7.2), so
 *  VoiceOver hears why Add is dimmed. */
export function itemRowLabel(
  item: StorefrontItem,
  inCart: number,
  earmark: string | null,
  extra: { rank?: { place: number; orders: number }; notOrderable?: boolean } = {},
): string {
  const parts = [item.name];
  if (item.sku) parts.push(`SKU ${item.sku}`);
  parts.push(availabilityLabel(statusOf(item), availableOf(item), 'long'));
  if (extra.rank) parts.push(`${FREQUENTLY_ORDERED_TITLE_COPY} ${frequentlyOrderedTagCopy(extra.rank.place, extra.rank.orders)}`);
  if (earmark) parts.push(`earmarked for ${earmark}`);
  if (inCart > 0) parts.push(storefrontInCartCopy(inCart));
  if (extra.notOrderable) parts.push(STOREFRONT_LINE_NOT_ORDERABLE_COPY);
  return parts.join(', ');
}

/** Why Add (an item, a kit) is dimmed, as its hint (desk check F7.1): the
 *  lock first, in core's add-while-locked words, then a line that can't be
 *  ordered. Out of stock is in the row's label already. */
export function addBlockedHint(input: { locked: boolean; notOrderable: boolean }): string | undefined {
  if (input.locked) return ORDER_ADD_WHILE_LOCKED_COPY;
  if (input.notOrderable) return STOREFRONT_LINE_NOT_ORDERABLE_COPY;
  return undefined;
}

/** Why a stepper, Remove or Clear all is dimmed: the lock's words. */
export function changeLockedHint(locked: boolean): string | undefined {
  return locked ? STOREFRONT_CART_LOCKED_COPY : undefined;
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
/** After a stepper or Remove changed a line: what the line is now, read from
 *  the snapshot after the change (desk check F7.4). An item the catalog
 *  shown does not name is never spoken as its id. */
export function lineChangeAnnouncement(
  snap: { itemMap: ReadonlyMap<string, StorefrontItem>; cart: CartState | null },
  itemId: string,
): string | null {
  if (!snap.cart) return null;
  const quantity = snap.cart.lines.find((l) => l.itemId === itemId)?.quantity ?? 0;
  const name = snap.itemMap.get(itemId)?.name;
  if (name) return quantityAnnouncement(name, quantity);
  return quantity === 0 ? 'Removed this item from your cart.' : null;
}
export function submittedAnnouncement(order: Pick<OrderSummary, 'orderNumber' | 'orderLabel'>): string {
  const label = order.orderLabel ?? formatOrderNumber(order.orderNumber);
  return label ? `Order request submitted: ${label}.` : 'Order request submitted.';
}

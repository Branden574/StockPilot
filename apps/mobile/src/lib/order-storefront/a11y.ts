import {
  CART_ALL_STOCK_IN_CART_COPY,
  CART_CHECK_OUT_COPY,
  CHECKOUT_NOTES_FULL_COPY,
  ORDER_UNCONFIRMED_TITLE_COPY,
  FREQUENTLY_ORDERED_TITLE_COPY,
  ORDER_ADD_WHILE_LOCKED_COPY,
  STOREFRONT_CART_LOCKED_COPY,
  STOREFRONT_LINE_NOT_ORDERABLE_COPY,
  availabilityLabel,
  availableOf,
  cartCountsCopy,
  checkoutNotesCounterSpokenCopy,
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

import { NOTES_COUNTER_FROM } from './checkout';

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
/** The kit's name with "kit" after it, unless the name already ends in the
 *  word (a kit named "New Hire Kit" is never read "New Hire Kit kit"). */
function kitNamed(name: string): string {
  return /\bkit$/i.test(name.trim()) ? name : `${name} kit`;
}
export function addKitLabel(name: string): string {
  return `Add one ${kitNamed(name)} to your cart`;
}
export function increaseKitLabel(name: string): string {
  return `One more ${kitNamed(name)}`;
}
export function decreaseKitLabel(name: string, kits: number): string {
  return kits <= 1 ? `Take the ${kitNamed(name)} out of your cart` : `One fewer ${kitNamed(name)}`;
}
/** Why Add kit is dimmed: the lock's words, or (the web's title) every kit
 *  the stock allows is already held by the cart's own lines. A kit out of
 *  stock says so in its row. */
export function kitAddBlockedHint(input: { locked: boolean; out: boolean; full: boolean }): string | undefined {
  if (input.locked) return addBlockedHint({ locked: true, notOrderable: false });
  if (!input.out && input.full) return increaseBlockedHint(true);
  return undefined;
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
  return kits > 0 ? `${name}: ${kits} ${kits === 1 ? 'kit' : 'kits'} in your cart.` : `Took the ${kitNamed(name)} out of your cart.`;
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

// ── Said where the person is, once (PO-4 review) ────────────────────────────

/** A screen's own news (the success screen's order number) is spoken this
 *  long after it appears, queued behind what VoiceOver says for the new
 *  screen: said in the same moment as the screen change, it is cut off. */
export const SCREEN_ANNOUNCE_DELAY_MS = 700;

/**
 * The unconfirmed panel's sentence, for every mounted panel at once (home,
 * browse and checkout stay stacked): spoken only by the panel on the screen
 * in focus, and a sentence once across them all, so moving between screens
 * with the same lock says nothing new. When the panel goes (the lock ends) a
 * later lock is news again. One announcer for the app run (the panel's
 * module keeps it).
 */
export function createPanelAnnouncer() {
  let lastSpoken: string | null = null;
  return {
    next(message: string | null, focused: boolean): string | null {
      if (message === null) {
        lastSpoken = null;
        return null;
      }
      if (!focused || message === lastSpoken) return null;
      lastSpoken = message;
      return `${ORDER_UNCONFIRMED_TITLE_COPY}. ${message}`;
    },
  };
}

/** What a change to Manager notes says: the counter, in words, when it first
 *  shows (1,800 characters) and when the note reaches its limit, where the
 *  field stops taking characters; nothing on any other keystroke. */
export function notesCounterAnnouncement(before: number, after: number, max: number): string | null {
  if (after <= before) return null;
  if (after >= max) return `${checkoutNotesCounterSpokenCopy(after, max)}. ${CHECKOUT_NOTES_FULL_COPY}`;
  if (before < NOTES_COUNTER_FROM && after >= NOTES_COUNTER_FROM) return checkoutNotesCounterSpokenCopy(after, max);
  return null;
}

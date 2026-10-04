// The phone storefront's own words (phone ordering PO-4, plan section 6): the
// sentences only the iPhone and iPad storefront shows. Everything the web
// storefront also says lives in ./copy.ts (and the submission words in
// ../place-order.ts); the phone imports those names and adds only these.
//
// ═══ IMPORTING THIS MODULE RUNS NOTHING ═══
//
// Core's index re-exports this file and Metro does not tree-shake, so the
// phone evaluates its top level at start-up: declarations and literals only
// (phone-copy.test.ts fails on a call at the top level).
//
// ═══ THE WORDS RULES ═══
//
// No uuid, no snake_case token, never "book" for a quantity (say "stock on
// record"), never "sent" for an email draft, never "try again" for an
// outcome that is not known, and no emojis (phone-copy.test.ts).

// ── Home and browsing ───────────────────────────────────────────────────────

export const STOREFRONT_BROWSE_CATEGORIES_COPY = 'Browse by category';
export const STOREFRONT_ALL_ITEMS_COPY = 'All items';
/** A home section's link to its whole list: "See all 12". */
export function storefrontSeeAllCopy(count: number): string {
  return `See all ${count}`;
}
/** A category row's count: "1 item" / "24 items". */
export function storefrontItemCountCopy(count: number): string {
  return `${count} ${count === 1 ? 'item' : 'items'}`;
}
export const STOREFRONT_SORT_AND_FILTER_COPY = 'Sort & filter';
export const STOREFRONT_SORT_LABEL_COPY = 'Sort';
export const STOREFRONT_AVAILABILITY_LABEL_COPY = 'Availability';
/** The active-filter chips' way out. */
export const STOREFRONT_CLEAR_FILTERS_COPY = 'Clear all';
export const STOREFRONT_SHOW_RESULTS_COPY = 'Show items';
export const STOREFRONT_ADD_COPY = 'Add';
export const STOREFRONT_SEARCH_LABEL_COPY = 'Search items';
/** When the catalog shown was read: "Updated 9:41 AM". */
export function storefrontUpdatedAtCopy(time: string): string {
  return `Updated ${time}`;
}
export const STOREFRONT_OFFLINE_COPY =
  "You're offline. These are the items as they were last loaded. Your cart is kept on this phone.";
export const STOREFRONT_CATALOG_LOAD_FAILED_COPY =
  "The items couldn't be loaded. Pull down to load them again.";
export const STOREFRONT_NOTHING_ORDERABLE_COPY =
  'Nothing can be ordered from this warehouse right now.';
export const STOREFRONT_TRUNCATED_COPY =
  'This warehouse has more items than the app can list. Search on the web for the rest.';
export const STOREFRONT_NO_WAREHOUSES_COPY =
  "You don't have a warehouse you can order from. Ask an admin for access.";
/** The Ship from row while the cart's order request is not confirmed. */
export const STOREFRONT_SHIP_FROM_LOCKED_COPY =
  "This cart has an order request that isn't confirmed yet. Check and finish it, or choose Don't send it, before changing the warehouse.";
/** Any change to a locked cart (a line, the setup, the notes). */
export const STOREFRONT_CART_LOCKED_COPY =
  "This cart is locked until its order request is confirmed. Check and finish it, or choose Don't send it.";
export const STOREFRONT_CHOOSE_WAREHOUSE_COPY = 'Choose a warehouse';

// ── One item ────────────────────────────────────────────────────────────────

export const STOREFRONT_QUANTITY_TITLE_COPY = 'Quantity';
/** The quantity field's hint: what the most is. */
export function storefrontQuantityHintCopy(available: number): string {
  return `Up to ${available}. Enter 0 to remove it from your cart.`;
}
export const STOREFRONT_QUANTITY_SAVE_COPY = 'Set quantity';
export const STOREFRONT_CANCEL_COPY = 'Cancel';
export const STOREFRONT_CLOSE_COPY = 'Close';
export const STOREFRONT_DONE_COPY = 'Done';
export const STOREFRONT_DETAILS_COPY = 'Details';
export const STOREFRONT_SKU_LABEL_COPY = 'SKU';
export const STOREFRONT_BIN_LABEL_COPY = 'Bin';
export const STOREFRONT_AVAILABLE_LABEL_COPY = 'Available';
export const STOREFRONT_STATUS_LABEL_COPY = 'Status';
export const STOREFRONT_EARMARK_LABEL_COPY = 'Earmarked for';
export const STOREFRONT_IN_CART_LABEL_COPY = 'In your cart';
/** "2 in your cart". */
export function storefrontInCartCopy(quantity: number): string {
  return `${quantity} in your cart`;
}
export const STOREFRONT_REMOVE_COPY = 'Remove';
/** A line the server or the fresh catalog says can't be ordered from here. */
export const STOREFRONT_LINE_NOT_ORDERABLE_COPY = "Can't be ordered from here anymore. Remove it.";
/** A cart line's title while the catalog that names its item is loading or
 *  could not be read: nothing is claimed about it yet. */
export const STOREFRONT_LINE_DETAILS_PENDING_COPY = "This item's details aren't loaded yet.";
/** A cart line's title once a catalog answer leaves its item out (its mark,
 *  STOREFRONT_LINE_NOT_ORDERABLE_COPY, says what to do). */
export const STOREFRONT_LINE_NOT_LISTED_COPY = 'An item no longer listed here';

// ── Kits ────────────────────────────────────────────────────────────────────

export const KIT_EACH_KIT_HOLDS_COPY = 'Each kit holds';
/** "2 × Backpack". */
export function kitComponentLineCopy(perKit: number, name: string): string {
  return `${perKit} × ${name}`;
}
/** "3 kits in your cart". */
export function kitsInCartCopy(kits: number): string {
  return `${kits} ${kits === 1 ? 'kit' : 'kits'} in your cart`;
}

// ── Checkout ────────────────────────────────────────────────────────────────

export const CHECKOUT_PICKUP_COPY = 'Pickup';
export const CHECKOUT_DELIVERY_COPY = 'Delivery';
export const CHECKOUT_NOT_SET_COPY = 'Not set';
export const CHECKOUT_CHANGE_COPY = 'Change';
export const CHECKOUT_RECENT_COPY = 'Recent';
export const CHECKOUT_REQUESTER_SEARCH_COPY = 'Search by name or email';
export const CHECKOUT_REQUESTERS_FAILED_COPY =
  "Recent requesters couldn't be loaded. You can still enter someone new.";
export const CHECKOUT_REQUESTERS_NONE_COPY = 'Nobody yet. Enter someone new.';
export const CHECKOUT_NAME_LABEL_COPY = 'Name';
export const CHECKOUT_EMAIL_LABEL_COPY = 'Email';
export const CHECKOUT_USE_PERSON_COPY = 'Order for them';
export const CHECKOUT_NEEDED_BY_CLEAR_COPY = 'Clear';
export const CHECKOUT_NEEDED_BY_ZONE_UNREADABLE_COPY =
  "Your organization's time zone couldn't be read, so a needed-by date can't be chosen here. You can still place the order.";
/** The organization's zone is one this phone's engine does not know. */
export function checkoutNeededByZoneUnknownCopy(zone: string): string {
  return `This phone can't show times in ${zone}, so a needed-by date can't be chosen here. You can still place the order.`;
}
/** A cart for someone else, kept by someone who can no longer order on
 *  behalf (the effective orders:approve, slice D): why Submit can't be
 *  pressed, and the line under For. It starts with place-order.ts's
 *  ORDER_ON_BEHALF_NOT_PERMITTED_COPY (the server's refusal). */
export const SUBMIT_ON_BEHALF_NOT_PERMITTED_COPY =
  'Only someone who can approve orders can order for someone else. Tap For to order it for yourself instead.';
/** The For row's hint then: what a tap does. */
export const STOREFRONT_FOR_SET_MYSELF_HINT_COPY = 'Orders it for yourself instead.';
/** Said when that tap has set it. */
export const STOREFRONT_FOR_NOW_MYSELF_COPY = 'This order request is now for you.';
/** Manager notes' counter, shown from 1,800 characters: "1,850 / 2,000". */
export function checkoutNotesCounterCopy(length: number, max: number): string {
  return `${groupThousands(length)} / ${groupThousands(max)}`;
}
/** Shown once, on checkout, when stock moved under the cart since its lines
 *  were added (quantities above available are kept, as on the web, and the
 *  approval checks stock). */
export function checkoutStockChangedCopy(
  changes: ReadonlyArray<{ name: string; available: number; quantity: number }>,
): string {
  const parts = changes.map(
    (c) => `${c.name} now has ${c.available} available, and you have ${c.quantity}`,
  );
  return `Stock changed since you added: ${parts.join('; ')}.`;
}
/** A cart restored on this phone, checked against the items as they are now.
 *  Nothing is dropped: lines that can't be ordered are marked, and lines
 *  above what's available keep their quantity with the warning. */
export function restoredCartChangedCopy(counts: {
  notOrderable: number;
  overAvailable: number;
}): string | null {
  const parts: string[] = [];
  if (counts.notOrderable > 0) {
    parts.push(
      `${counts.notOrderable} ${counts.notOrderable === 1 ? "item can't" : "items can't"} be ordered from here anymore`,
    );
  }
  if (counts.overAvailable > 0) {
    parts.push(
      `${counts.overAvailable} ${counts.overAvailable === 1 ? 'line asks' : 'lines ask'} for more than is available now`,
    );
  }
  if (parts.length === 0) return null;
  return `Since this cart was saved, ${parts.join(', and ')}. They are marked below.`;
}

// ── Success ─────────────────────────────────────────────────────────────────

export function successEmailButtonCopy(fulfillmentType: 'pickup' | 'delivery'): string {
  return fulfillmentType === 'pickup' ? 'Email pickup request' : 'Email delivery request';
}
export const SUCCESS_EMAIL_PREVIEW_COPY = 'Preview';
export const SUCCESS_EMAIL_HIDE_PREVIEW_COPY = 'Hide preview';
export const SUCCESS_EMAIL_OPENED_COPY = 'Email draft opened';
export const SUCCESS_EMAIL_SUBJECT_LABEL_COPY = 'Subject';
export const SUCCESS_EMAIL_COPY_DETAILS_COPY = 'Copy details';

// ── The Orders list ─────────────────────────────────────────────────────────

export const ORDERS_LIST_LOAD_FAILED_TITLE_COPY = "Orders couldn't be loaded.";
export const ORDERS_LIST_LOAD_FAILED_BODY_COPY = 'Check your connection, then load them again.';
export const ORDERS_LIST_RETRY_COPY = 'Load again';
export const ORDERS_LIST_UNCONFIRMED_COPY =
  "An order request you sent isn't confirmed yet. Open it to Check and finish, or choose Don't send it.";
export const ORDERS_LIST_OPEN_UNCONFIRMED_COPY = 'Open it';

// ── Signing out with an order request that isn't confirmed ─────────────────

/** The sign-out prompt's line: "1 order request was sent but not confirmed." */
export function signOutUnconfirmedOrdersCopy(count: number): string {
  return `${count} ${count === 1 ? 'order request was' : 'order requests were'} sent but not confirmed.`;
}
export const SIGN_OUT_UNCONFIRMED_TITLE_COPY = 'Sign out?';
export const SIGN_OUT_UNCONFIRMED_HOLD_COPY =
  'If you sign out, its cart is cleared from this phone. Sign back in here to find out whether it was placed.';
export const SIGN_OUT_STAY_COPY = 'Stay signed in';
export const SIGN_OUT_WITHDRAW_COPY = "Don't send it and sign out";
export const SIGN_OUT_COPY = 'Sign out';
/** "Don't send it" could not reach the server for every request: those are
 *  kept to check at the next sign-in, like Sign out. */
export const SIGN_OUT_WITHDRAW_UNANSWERED_COPY =
  "It couldn't be checked just now. Sign back in here to find out whether it was placed.";
/** At the next sign-in on this phone. */
export function signInHeldPlacedCopy(orderLabel: string | null): string {
  return orderLabel
    ? `Your order request ${orderLabel} was placed.`
    : 'Your order request was placed.';
}
export const SIGN_IN_HELD_UNCONFIRMED_TITLE_COPY = 'Your order request is not confirmed';
export const SIGN_IN_HELD_UNCONFIRMED_COPY =
  "An order request you sent before signing out still isn't confirmed. Choose Don't send it to stop it if it hasn't been placed yet, or see your orders.";
export const SIGN_IN_HELD_NOT_NOW_COPY = 'Not now';
/** "Don't send it" at sign-in: the answer was withdrawn (or refused), so
 *  nothing was placed. (Its cart went at the sign-out.) */
export const SIGN_IN_HELD_WITHDRAWN_COPY = 'Your order request was not sent.';
/** "Don't send it" at sign-in with no answer: asked again later. */
export const SIGN_IN_HELD_WITHDRAW_UNANSWERED_COPY =
  "It couldn't be checked just now. You'll be asked again the next time you open the app.";
/** A held order request that can no longer be checked from this phone (the
 *  account left its organization, or it was sent more than 30 days ago):
 *  its marker is dropped, once, with this. */
export const SIGN_IN_HELD_DROPPED_COPY =
  'An order request you sent before signing out can no longer be checked from this phone. See your orders to find out whether it was placed.';

// ── Helpers (called inside the functions above only) ───────────────────────

function groupThousands(n: number): string {
  const whole = Math.max(0, Math.trunc(n));
  return String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

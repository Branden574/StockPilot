// The New order storefront's words, in one place for the web and the phone
// (phone ordering plan, section 6).
//
// ═══ TODAY'S WORDS, NOT YET THE CORRECTED ONES ═══
//
// PO-1 copies the words the web storefront shows today, unchanged, so the
// later slices can switch both surfaces to one source. Nothing renders these
// yet: the web components still hold their own literals, and the phone has no
// storefront until PO-4. PO-2 changes the words that are wrong today (the
// Frequently ordered subtitle, the sort labels, "Submit Order Request" on a
// button that only opens the review, the success sentence that promises an
// email to the wrong person on an on-behalf order, the pick-up promise) and
// moves the web onto this module in the same change.
//
// copy.test.ts checks that every sentence here still appears in the web
// storefront's source, so this file cannot drift from what the web shows
// before PO-2 switches it over.
//
// The sort labels and the availability words are not repeated here: they are
// SORT_OPTIONS, AVAILABILITY_LABELS and availabilityLabel in ./logic.ts. The
// words for submitting and its refusals live with the submission rules in
// ../place-order.ts.

// ── Page ─────────────────────────────────────────────────────────────────────

export const STOREFRONT_TITLE_COPY = 'Place an Order';
export const STOREFRONT_SEARCH_PLACEHOLDER_COPY = 'Search products, SKU, category…';

/** The empty search result: "Nothing matches “polo”" or, with no words typed,
 *  "Nothing matches those filters". */
export function storefrontNothingMatchesCopy(query: string): string {
  return `Nothing matches${query ? ` “${query}”` : ' those filters'}`;
}
export const STOREFRONT_NOTHING_MATCHES_HINT_COPY =
  'Try a different name, SKU or category — or clear your filters.';
export const STOREFRONT_CLEAR_SEARCH_AND_FILTERS_COPY = 'Clear search & filters';

// ── Frequently ordered ───────────────────────────────────────────────────────

export const FREQUENTLY_ORDERED_TITLE_COPY = 'Frequently ordered';
export const FREQUENTLY_ORDERED_SUBTITLE_COPY = 'Based on your last 30 days';
/** The rank tag on a Frequently ordered card: "#1 · 12×/mo". */
export function frequentlyOrderedTagCopy(rank: number, count: number): string {
  return `#${rank} · ${count}×/mo`;
}

// ── Setup ────────────────────────────────────────────────────────────────────

export const STOREFRONT_WAREHOUSE_LABEL_COPY = 'Warehouse';
export const STOREFRONT_SHIP_FROM_COPY = 'Ship from';
export const STOREFRONT_REQUESTING_FOR_COPY = 'Requesting for';
export const STOREFRONT_ON_BEHALF_COPY = 'On behalf of someone else';
export const STOREFRONT_ON_BEHALF_NAME_PLACEHOLDER_COPY = 'Their name';
export const STOREFRONT_ON_BEHALF_EMAIL_PLACEHOLDER_COPY = 'their.email@example.com';
export const STOREFRONT_FULFILLMENT_LABEL_COPY = 'Fulfillment';
export const STOREFRONT_PICK_UP_AT_COPY = 'Pick up at';
/** Fixed text today, not computed from anything (owner question O2). */
export const STOREFRONT_PICKUP_READY_HINT_COPY = 'Ready within 1 business day of approval';
export const STOREFRONT_DELIVER_TO_COPY = 'Deliver to';
export const STOREFRONT_CHOOSE_SITE_COPY = 'Choose a site…';
export const STOREFRONT_DELIVERY_SITE_COPY = 'Delivery site';
export const STOREFRONT_NO_DELIVERY_SITES_COPY = 'No delivery sites for this warehouse.';

// ── Cart ─────────────────────────────────────────────────────────────────────

export const CART_TITLE_COPY = 'Order Cart';
export const CART_EMPTY_TITLE_COPY = 'Your cart is empty';
export const CART_EMPTY_BODY_COPY =
  'Browse the catalog and add items — they queue here until you submit.';
export const CART_SUGGESTIONS_LABEL_COPY = 'Start with your usuals';
export const CART_LINE_ITEMS_LABEL_COPY = 'Line items';
export const CART_TOTAL_UNITS_LABEL_COPY = 'Total units';
export const CART_MANAGER_NOTES_LABEL_COPY = 'Manager notes';
export const CART_OPTIONAL_COPY = 'Optional';
export const CART_MANAGER_NOTES_PLACEHOLDER_COPY =
  'Anything the approving manager should know — deadlines, event, room number…';
export const CART_NEEDED_BY_LABEL_COPY = 'Needed by';
export const CART_NEEDED_BY_HINT_COPY = 'Approval adds this to the team Schedule with reminders.';
/** The cart button. It opens the review; the review's button submits. */
export const CART_SUBMIT_BUTTON_COPY = 'Submit Order Request';
export const CART_SUBMIT_FINE_PRINT_COPY =
  'A manager will review and approve before stock is reserved.';

/** A line holding everything available. */
export function cartLineAtMaxCopy(available: number): string {
  return `All ${available} available are in your cart`;
}
/** A line holding more than is available (a restored draft, or stock that
 *  moved since it was added). */
export function cartLineOverCopy(available: number): string {
  return `Only ${available} in stock — reduce quantity`;
}
/** The + control's hint when everything available is already in the cart. */
export const CART_ALL_STOCK_IN_CART_COPY = 'All available stock is in your cart';

// ── Kits ─────────────────────────────────────────────────────────────────────

export const KITS_TITLE_COPY = 'Kits';
export const KITS_ROW_SUB_COPY = 'Add every item of a kit to your cart in one step';
/** "1 kit available" / "60 kits available". */
export function kitsAvailableCopy(kits: number): string {
  return `${kits} ${kits === 1 ? 'kit' : 'kits'} available`;
}
export const KIT_ADD_COPY = 'Add kit';
export const KIT_DETAILS_COPY = 'Details';
/** "Limited by Backpack (60)". */
export function kitLimitedByCopy(name: string, available: number): string {
  return `Limited by ${name} (${available})`;
}
/** An all-or-nothing kit change that did not fit. */
export function kitNotEnoughCopy(name: string): string {
  return `Not enough ${name} for that many kits. Nothing was added.`;
}
export const KIT_LINES_NOTE_COPY =
  'Each item goes into your cart as its own line, which you can change or remove.';
export const KITS_LOAD_FAILED_COPY =
  'Kits could not be loaded. You can still add their items one by one, or reload the page to try again.';

// ── Review and submit ────────────────────────────────────────────────────────

export const REVIEW_TITLE_COPY = 'Review order request';
export const REVIEW_SUBTITLE_COPY = 'Check the details — your manager sees exactly this.';
export const REVIEW_KEEP_BROWSING_COPY = 'Keep browsing';
export const REVIEW_CONFIRM_COPY = 'Confirm & submit';

/** What the page says today, before sending, when the cart cannot be sent. */
export const SUBMIT_NO_LINES_COPY = 'Add at least one item to your cart before submitting.';
export const SUBMIT_NO_SITE_COPY = 'Select a delivery site in the setup bar above.';
export const SUBMIT_ON_BEHALF_INCOMPLETE_COPY = "Complete the requester's name and email above.";

// ── Success ──────────────────────────────────────────────────────────────────

export const SUCCESS_TITLE_COPY = 'Order request submitted';
/** Today's success sentence. PO-2 replaces it: on an on-behalf order the
 *  email goes to the other person, not the one reading this. */
export function successNotifiedCopy(method: 'pickup' | 'delivery'): string {
  return `Your manager has been notified. You'll get an email when it's approved and stock is reserved for ${method === 'pickup' ? 'pickup' : 'delivery'}.`;
}
export const SUCCESS_VIEW_ORDER_COPY = 'View order';
export const SUCCESS_DONE_COPY = 'Done';

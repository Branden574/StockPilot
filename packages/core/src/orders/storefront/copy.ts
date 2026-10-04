// The New order storefront's words, in one place for the web and the phone
// (phone ordering plan, section 6).
//
// ═══ ONE SOURCE, BOTH SURFACES ═══
//
// PO-1 copied the web's words here unchanged. PO-2 corrects the ones that were
// wrong and moves the web storefront onto this module: the web components
// import these names and hold none of these sentences as literals
// (copy.test.ts checks both). The phone storefront (PO-4) imports the same
// names. The corrections, each for a reason:
//   - "Based on your last 30 days" said the Frequently ordered strip was
//     personal; the RPC counts every member's orders at the warehouse.
//   - "Submit Order Request" sat on a button that only opened the review.
//   - "You'll get an email…" was wrong on an on-behalf order (the email goes
//     to the person it is for), 64% of L4L's orders.
//   - "Ready within 1 business day of approval" was a promise nothing
//     computed (owner decision O2: the plain will-call sentence until the
//     owner confirms it).
//   - "A manager will review" is not who approves since security slice D
//     (the effective orders:approve permission decides).
//
// The sort labels and the availability words are not repeated here: they are
// SORT_OPTIONS, AVAILABILITY_LABELS and availabilityLabel in ./logic.ts. The
// words for submitting, the unconfirmed panel and every refusal live with the
// submission rules in ../place-order.ts.

// ── Page ─────────────────────────────────────────────────────────────────────

export const STOREFRONT_TITLE_COPY = 'Place an order';
export const STOREFRONT_SEARCH_PLACEHOLDER_COPY = 'Search by name, SKU or category';

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
/** The strip counts every member's orders at this warehouse, not yours. */
export const FREQUENTLY_ORDERED_SUBTITLE_COPY = 'Ordered most here in the last 30 days';
/** The rank tag on a Frequently ordered card: "#1 · in 12 orders". */
export function frequentlyOrderedTagCopy(rank: number, count: number): string {
  return `#${rank} · in ${count} ${count === 1 ? 'order' : 'orders'}`;
}

// ── Setup ────────────────────────────────────────────────────────────────────

export const STOREFRONT_SHIP_FROM_COPY = 'Ship from';
export const STOREFRONT_FOR_COPY = 'For';
export const STOREFRONT_MYSELF_COPY = 'Myself';
export const STOREFRONT_SOMEONE_NEW_COPY = 'Someone new';
export const STOREFRONT_ON_BEHALF_NAME_PLACEHOLDER_COPY = 'Their name';
export const STOREFRONT_ON_BEHALF_EMAIL_PLACEHOLDER_COPY = 'their.email@example.com';
export const STOREFRONT_PICKUP_OR_DELIVERY_COPY = 'Pickup or delivery';
export const STOREFRONT_PICK_UP_AT_COPY = 'Pick up at';
/** "DC4 will-call desk". */
export function storefrontWillCallDeskCopy(warehouseName: string): string {
  return `${warehouseName} will-call desk`;
}
/** Under Pick up at. Fixed words, no promised time (owner decision O2). */
export function storefrontPickupHintCopy(warehouseName: string): string {
  const name = warehouseName.trim();
  return name ? `Collect it at the ${name} will-call desk once it's ready.` : "Collect it at the will-call desk once it's ready.";
}
export const STOREFRONT_DELIVER_TO_COPY = 'Deliver to';
export const STOREFRONT_CHOOSE_SITE_COPY = 'Choose a site';
export const STOREFRONT_DELIVERY_SITE_COPY = 'Delivery site';
export const STOREFRONT_NO_DELIVERY_SITES_COPY = 'No delivery sites for this warehouse.';
/** The phone's site list when its read failed (the web's sites arrive with
 *  the page). */
export const STOREFRONT_SITES_LOAD_FAILED_COPY = 'Delivery sites could not be loaded.';

// ── Cart ─────────────────────────────────────────────────────────────────────

export const CART_TITLE_COPY = 'Cart';
/** "3 items · 12 units". */
export function cartCountsCopy(lines: number, units: number): string {
  return `${lines} ${lines === 1 ? 'item' : 'items'} · ${units} ${units === 1 ? 'unit' : 'units'}`;
}
export const CART_EMPTY_TITLE_COPY = 'Your cart is empty';
export const CART_EMPTY_BODY_COPY = 'Add items and they wait here until you submit.';
export const CART_SUGGESTIONS_LABEL_COPY = 'Start with your usuals';
export const CART_CLEAR_ALL_COPY = 'Clear all';
export const CART_CLEAR_CONFIRM_COPY = 'Clear the cart?';
export const CART_CLEAR_COPY = 'Clear';
export const CART_KEEP_COPY = 'Keep';
export const CART_LINE_ITEMS_LABEL_COPY = 'Line items';
export const CART_TOTAL_UNITS_LABEL_COPY = 'Total units';
export const CART_MANAGER_NOTES_LABEL_COPY = 'Manager notes';
export const CART_OPTIONAL_COPY = 'Optional';
export const CART_MANAGER_NOTES_PLACEHOLDER_COPY =
  'Anything the approving manager should know — deadlines, event, room number…';
export const CART_NEEDED_BY_LABEL_COPY = 'Needed by';
export const CART_NEEDED_BY_HINT_COPY = 'Approval adds this to the team Schedule with reminders.';
/** The web cart's button. It opens the review; the review's button submits. */
export const CART_REVIEW_BUTTON_COPY = 'Review order';
/** The phone cart's button (its checkout is also the review). */
export const CART_CHECK_OUT_COPY = 'Check out';
/** Who decides is the effective orders:approve permission (security slice D),
 *  not a manager by role. */
export const CART_SUBMIT_FINE_PRINT_COPY =
  'Someone who approves orders will review it before stock is reserved.';

/** A line holding everything available. */
export function cartLineAtMaxCopy(available: number): string {
  return `All ${available} available are in your cart`;
}
/** A line holding more than is available (a restored draft, or stock that
 *  moved since it was added). */
export function cartLineOverCopy(available: number): string {
  return `Only ${available} available. Reduce the quantity.`;
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
/** The kits read failed: the items still work, and how to retry on each
 *  surface. */
export function kitsLoadFailedCopy(surface: 'web' | 'phone'): string {
  return `Kits could not be loaded. You can still add their items one by one. ${
    surface === 'web' ? 'Reload the page to try again.' : 'Pull down to try again.'
  }`;
}

// ── Review and submit ────────────────────────────────────────────────────────

export const REVIEW_TITLE_COPY = 'Review order request';
export const REVIEW_SUBTITLE_COPY =
  'Check the details — the person who approves it sees exactly this.';
export const REVIEW_KEEP_BROWSING_COPY = 'Keep browsing';
export const REVIEW_SUBMIT_COPY = 'Submit order request';

/** Why the order cannot be sent yet (said before anything is sent). */
export const SUBMIT_NO_LINES_COPY = 'Add an item.';
export const SUBMIT_NO_SITE_COPY = 'Choose a delivery site.';
export const SUBMIT_ON_BEHALF_INCOMPLETE_COPY = 'Enter their name and email.';
export const SUBMIT_REMOVE_UNORDERABLE_COPY = "Remove the items that can't be ordered.";

// ── Success ──────────────────────────────────────────────────────────────────

export const SUCCESS_TITLE_COPY = 'Order request submitted';
/** Under the reference line: who hears about it. On an on-behalf order the
 *  emails go to the person it is for, not the one reading this. */
export function successSentForApprovalCopy(
  requestedFor: { self: true } | { self: false; name: string; email: string },
): string {
  return requestedFor.self
    ? "Sent for approval. You'll be notified in the app when it's approved."
    : `Sent for approval. Emails about it go to ${requestedFor.name} at ${requestedFor.email}.`;
}
export const SUCCESS_REVIEW_AND_APPROVE_COPY = 'Review and approve';
export const SUCCESS_VIEW_ORDER_COPY = 'View order';
export const SUCCESS_PLACE_ANOTHER_COPY = 'Place another order';
export const SUCCESS_DONE_COPY = 'Done';

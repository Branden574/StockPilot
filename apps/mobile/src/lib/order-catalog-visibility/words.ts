/**
 * MANAGE ORDER ITEMS ON THE PHONE: THE WORDS (ordering visibility, 0413;
 * design 8.6). Every sentence the web page also says comes from core
 * (packages/core/src/orders/catalog-visibility.ts), so the two surfaces say
 * them identically; this file re-exports them for the screen.
 *
 * The few below exist only on the phone: short control labels where a phone
 * row has no room for the web's words (the accessible names still carry the
 * full words, core orderItemsRowActionLabel), the sheets' own buttons, and two
 * sentences the web server says from its own module (sign-in and the rate
 * limit), repeated here word for word because the phone cannot import the
 * web. The words rules hold here too: "Shown in Orders" and "Hidden from
 * Orders", never "available" for this state and never "public"; no ids, no
 * codes, no emojis.
 */

import type { OrderCatalogVisibilityFilter } from '@stockpilot/core';

export {
  ORDER_ITEMS_AAL2_REQUIRED_COPY,
  ORDER_ITEMS_BUSY_COPY,
  ORDER_ITEMS_CLEAR_SELECTION_COPY,
  ORDER_ITEMS_FEATURE_DISABLED_COPY,
  ORDER_ITEMS_FORBIDDEN_COPY,
  ORDER_ITEMS_HIDE_ACTION_COPY,
  ORDER_ITEMS_HIDE_CONFIRM_BODY_COPY,
  ORDER_ITEMS_HIDE_SELECTED_COPY,
  ORDER_ITEMS_INTERNAL_COPY,
  ORDER_ITEMS_INVALID_COPY,
  ORDER_ITEMS_ITEMS_UNAVAILABLE_COPY,
  ORDER_ITEMS_KITS_NOTE_COPY,
  ORDER_ITEMS_LOAD_FAILED_COPY,
  ORDER_ITEMS_MANAGE_BUTTON_COPY,
  ORDER_ITEMS_MANAGE_SUBLINE_COPY,
  ORDER_ITEMS_MFA_REQUIRED_COPY,
  ORDER_ITEMS_MODULE_DISABLED_COPY,
  ORDER_ITEMS_NO_ACCESS_COPY,
  ORDER_ITEMS_OFFLINE_COPY,
  ORDER_ITEMS_REVIEW_SELECTION_COPY,
  ORDER_ITEMS_SEARCH_PLACEHOLDER_COPY,
  ORDER_ITEMS_SELECTION_CAP_COPY,
  ORDER_ITEMS_SELECT_FAMILY_COPY,
  ORDER_ITEMS_SHOW_ACTION_COPY,
  ORDER_ITEMS_SHOW_CONFIRM_BODY_COPY,
  ORDER_ITEMS_SHOW_SELECTED_COPY,
  ORDER_ITEMS_STATE_EXPECTED_COPY,
  ORDER_ITEMS_STATE_HIDDEN_COPY,
  ORDER_ITEMS_STATE_SHOWN_COPY,
  ORDER_ITEMS_TYPE_FILTER_LABELS,
  ORDER_PHONE_AAL2_COPY,
  orderItemsEmptyCopy,
  orderItemsHiddenSinceCopy,
  orderItemsHideConfirmTitle,
  orderItemsRefusalCopy,
  orderItemsRowActionLabel,
  orderItemsSavedCopy,
  orderItemsSelectedCopy,
  orderItemsShowConfirmTitle,
} from '@stockpilot/core';

/** A row's visible action label (its accessible name is core
 *  orderItemsRowActionLabel, which names the record). */
export const ORDER_ITEMS_PHONE_HIDE_COPY = 'Hide';
export const ORDER_ITEMS_PHONE_SHOW_COPY = 'Show';

/** The segmented filter's short labels; the group is named for VoiceOver. */
export const ORDER_ITEMS_PHONE_VISIBILITY_LABELS: Readonly<Record<OrderCatalogVisibilityFilter, string>> = {
  all: 'All',
  shown: 'Shown',
  hidden: 'Hidden',
};
export const ORDER_ITEMS_PHONE_VISIBILITY_GROUP_COPY = 'Ordering visibility';

export const ORDER_ITEMS_PHONE_SEARCH_LABEL_COPY = 'Search order items';
export const ORDER_ITEMS_PHONE_FILTERS_COPY = 'Filters';
export const ORDER_ITEMS_PHONE_TYPE_COPY = 'Type';
export const ORDER_ITEMS_PHONE_WAREHOUSE_COPY = 'Warehouse';
export const ORDER_ITEMS_PHONE_CATEGORY_COPY = 'Category';
export const ORDER_ITEMS_PHONE_ALL_WAREHOUSES_COPY = 'All warehouses';
export const ORDER_ITEMS_PHONE_ALL_CATEGORIES_COPY = 'All categories';
export const ORDER_ITEMS_PHONE_CLEAR_FILTERS_COPY = 'Clear filters';
export const ORDER_ITEMS_PHONE_DONE_COPY = 'Done';
export const ORDER_ITEMS_PHONE_BACK_COPY = 'Back';
export const ORDER_ITEMS_PHONE_CANCEL_COPY = 'Cancel';
export const ORDER_ITEMS_PHONE_TRY_AGAIN_COPY = 'Try again';
export const ORDER_ITEMS_PHONE_RELOAD_COPY = 'Reload';

/** The filter button's spoken name, with how many filters are set. */
export function orderItemsFiltersLabel(active: number): string {
  return active > 0 ? `${ORDER_ITEMS_PHONE_FILTERS_COPY}, ${active} active` : ORDER_ITEMS_PHONE_FILTERS_COPY;
}

/** The page's select-all (the current page's rows only, design 8.2). */
export const ORDER_ITEMS_PHONE_SELECT_PAGE_COPY = 'Select this page';
export const ORDER_ITEMS_PHONE_CLEAR_PAGE_COPY = 'Clear this page';

/** A record's checkbox: its name, so VoiceOver can tell rows apart. */
export function orderItemsSelectLabel(name: string): string {
  const n = name.trim();
  return n === '' ? 'Select' : `Select ${n}`;
}

/** The review sheet's per-record remove button. */
export function orderItemsRemoveFromSelectionLabel(name: string): string {
  const n = name.trim();
  return n === '' ? 'Remove from the selection' : `Remove ${n} from the selection`;
}
export const ORDER_ITEMS_PHONE_REMOVE_COPY = 'Remove';
export const ORDER_ITEMS_PHONE_REVIEW_EMPTY_COPY = 'Nothing is selected.';

/** "Select family" on a row: names the family for VoiceOver. */
export function orderItemsSelectFamilyLabel(familyName: string | null): string {
  const n = (familyName ?? '').trim();
  return n === '' ? 'Select family' : `Select the ${n} family`;
}

/** The family sheet's button: exactly the records ticked in it. */
export function orderItemsFamilyAddCopy(count: number): string {
  if (count === 0) return 'Add to selection';
  return `Add ${count.toLocaleString('en-US')} to selection`;
}
export const ORDER_ITEMS_PHONE_FAMILY_LOAD_FAILED_COPY = "Couldn't load this family. Try again.";
export const ORDER_ITEMS_PHONE_FAMILY_EMPTY_COPY = 'No records of this family can be managed here.';
export const ORDER_ITEMS_PHONE_FAMILY_TRUNCATED_COPY =
  'This family has more records than are listed here. Only the records listed can be added.';

/** The web server's sign-in sentence for these routes, word for word. */
export const ORDER_ITEMS_PHONE_SIGN_IN_COPY = 'Sign in again to manage order items.';
/** The web server's rate-limit sentence for these routes, word for word. */
export const ORDER_ITEMS_PHONE_RATE_LIMITED_COPY = 'Too many changes in a minute. Wait a moment, then try again.';

/** "Showing 26-50 of 1,240" (the web page's footer words). */
export function orderItemsRangeCopy(start: number, end: number, total: number): string {
  const n = (v: number) => v.toLocaleString('en-US');
  return `Showing ${n(start)}-${n(end)} of ${n(total)}`;
}

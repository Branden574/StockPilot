/**
 * WHAT BELONGS ON AN INVENTORY TAB — one definition, both platforms.
 *
 * WHY THIS EXISTS. Web and mobile each wrote their own predicate for the Items
 * and Books tabs, and they drifted:
 *
 *   | axis        | web (server/loaders/inventory-list.ts) | mobile (inventory.tsx) |
 *   | item type   | `item_type = 'product'`                | `item_type <> 'book'`  |
 *   | rentals     | `is_rental = false`                    | (no filter)            |
 *
 * Measured against production on 2026-09-22, one customer organization: two
 * items — a rental table and a rental audiometer — were listed on mobile's
 * Items tab and absent from web's. Nothing was wrong with either record. The
 * two clients simply disagreed about what an "item" is.
 *
 * The rule below is the WEB's, because it is the narrower and intentional one:
 * rentals are a separate inventory class with their own screens, and the Items
 * tab is products. Mobile adopting it removes the two-item discrepancy and, more
 * to the point, means a new `item_type` (an asset, a consumable) cannot appear
 * on one platform and not the other ever again.
 *
 * NOT AN ACCESS RULE. Nothing here decides what a user is allowed to see —
 * organization, warehouse assignment and category restrictions are enforced by
 * row level security and by the service layer, and this module never widens
 * them. It only says which of the rows a caller may already read belong on
 * which tab.
 */

/** The tabs that list inventory. Books live apart from everything else. */
export type InventoryListView = 'items' | 'books';

/**
 * The column predicates for a view's DEFAULT list, as plain data so each client
 * can hand them to its own query builder.
 *
 * `status` and `awaitingFirstReceipt` are deliberately absent: the default view
 * shows active, not-yet-received-excluded rows, but both clients also offer an
 * Expected chip and an archived filter that move those axes per request.
 * `defaultLifecycleFilters` below carries them for callers that want the whole
 * default view in one place.
 */
export interface InventoryViewPredicate {
  /** Exact `item_type` this view lists. */
  itemType: 'product' | 'book';
  /** Rentals are their own class and never appear on these tabs. */
  isRental: false;
}

export function inventoryViewPredicate(view: InventoryListView): InventoryViewPredicate {
  return { itemType: view === 'books' ? 'book' : 'product', isRental: false };
}

/** The rest of the DEFAULT view: active lifecycle, and no unreceived phantoms. */
export interface InventoryDefaultLifecycle {
  /** Migration 0277: rows flagged until their first receipt arrive hidden. */
  awaitingFirstReceipt: false;
  status: 'active';
  deletedAtIsNull: true;
}

export const inventoryDefaultLifecycle: InventoryDefaultLifecycle = {
  awaitingFirstReceipt: false,
  status: 'active',
  deletedAtIsNull: true,
};

/**
 * Does a row belong on `view`, ignoring lifecycle?
 *
 * For clients that have rows in hand (mobile's instant list, the web's instant
 * dataset) rather than a query to constrain.
 */
export function belongsToInventoryView(
  row: { item_type?: string | null; is_rental?: boolean | null },
  view: InventoryListView,
): boolean {
  const want = inventoryViewPredicate(view);
  return row.item_type === want.itemType && row.is_rental !== true;
}

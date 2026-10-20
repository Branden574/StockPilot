// Which list addresses narrow the list. The Items, Books and Rentals items
// pages pick their empty state with it (pure, directive-free: see
// instant-mode.ts).

import { buildInstantSearchTerm, instantStateFromPageParams } from './instant-mode';

/** A list page's address, as its awaited `searchParams` hand it over. */
export type ListFilterParams = Parameters<typeof instantStateFromPageParams>[0];

/**
 * Whether the address narrows the list: a search, a Category, Location or
 * Charter filter, a rack, a stock view (Low + critical, Out of stock), the
 * Expected or Auto-archived only chip, or the Discontinued view. Active (the
 * default) and All are the list itself, and the Archived view is a list of
 * its own with its own empty state. Each part is read as the derivation and
 * InventoryService.list() read it (instant-mode.ts), so an all-whitespace
 * search or rack, an unknown stock value or ?expected=0 narrows nothing here
 * either, and a sort or a page number never does.
 *
 * Grouping walk 2026-10-20 (W4 no-match): a filter that left nothing showed
 * "No items match your filters." with its filters only in instant mode right
 * after the tick. After a reload or from a pasted address, and always for
 * staff, viewers and Rentals items (server mode), the page answered "No items
 * yet" ("No books yet", "No rental items yet") with its add actions and no
 * filter bar, so the filter could be neither seen nor undone. With a filter
 * active the pages now render the table, whose no-match state keeps the
 * filter bar, the active chips and "Clear all filters" in every mode; the
 * "No ... yet" state is for a list with nothing in it and no filter at all.
 */
export function listFilterActive(params: ListFilterParams): boolean {
  const s = instantStateFromPageParams(params);
  return (
    buildInstantSearchTerm(s.q) !== '' ||
    s.cat.length > 0 ||
    s.loc.length > 0 ||
    s.charter.length > 0 ||
    s.rack.trim() !== '' ||
    s.stock !== null ||
    s.expected ||
    s.autoArchived ||
    s.status === 'discontinued'
  );
}

/** The Items list's item types, by their labels elsewhere in the app (the public item page, the bundle picker). */
const ITEM_TYPE_LABELS = { asset: 'Asset', consumable: 'Consumable', book: 'Book' } as const;

/**
 * The Items list's ?type= when it narrows the list: Asset, Consumable or Book
 * lists that type instead of the default products; product, all (every type,
 * where the dashboard's low-stock links go) and anything else do not. Returns
 * the type's label, or null. Review of batch D (2026-10-20): a saved view keeps
 * and re-applies ?type=, and with no record of that type the page said "No
 * items yet" and offered to add a first item, with no filter bar and nothing
 * on screen naming the type. Only the Items page reads it (Books and Rentals
 * items fix their own types).
 */
export function itemsTypeNarrowing(type: string | null | undefined): string | null {
  return type === 'asset' || type === 'consumable' || type === 'book'
    ? ITEM_TYPE_LABELS[type]
    : null;
}

/**
 * Whether the "Nothing here in <warehouse>" hint can answer this address, so
 * the page asks for its count at all. The count (countMatchesInOtherWarehouses)
 * applies the search alone, to the active, received records of the list's own
 * type in the other warehouses. So the hint fits the Active view (or All, where
 * those records show too) with nothing but a search: with a Category, a stock
 * view, Expected, a rack, Auto-archived only or an Items type it would count
 * records that narrowing leaves out, and on the Archived or Discontinued view it
 * would count active records the view does not list.
 *
 * Review of batch D (2026-10-20): every empty view with a warehouse filter
 * waited for that count on the render path, though the page then threw it away
 * whenever another narrowing was on; and an Archived view with nothing archived
 * in the warehouse said "N items match in your other warehouses" for the active
 * ones, instead of "No archived items".
 */
export function otherWarehouseHintApplies(
  params: ListFilterParams & { type?: string },
  view: 'items' | 'books',
): boolean {
  const { status } = instantStateFromPageParams(params);
  if (status !== 'active' && status !== 'all') return false;
  if (listFilterActive({ ...params, q: undefined })) return false;
  return view !== 'items' || itemsTypeNarrowing(params.type) === null;
}

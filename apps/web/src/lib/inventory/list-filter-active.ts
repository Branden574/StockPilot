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

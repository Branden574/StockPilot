// What the Items, Books and Rentals items tables say when one narrowing
// leaves them empty: the pages' own messages, kept word for word (pure,
// directive-free: see instant-mode.ts).

import { buildInstantSearchTerm, type InstantModeState } from './instant-mode';

/** The list whose words to use: the table's Items, Books or Rentals items. */
export type ListEmptyKind = 'items' | 'books' | 'rentals';

export interface ListEmptyMessage {
  title: string;
  description: string;
  /** The way back: always to the list itself, as before. */
  cta: { label: string; href: string };
}

const LIST_PATH: Record<ListEmptyKind, string> = {
  items: '/dashboard/inventory',
  books: '/dashboard/books',
  rentals: '/dashboard/rentals/items',
};

type Narrowing = 'q' | 'stock' | 'expected' | 'cat' | 'loc' | 'charter' | 'rack' | 'auto';

/**
 * What narrows the list, read as the derivation and the list read it
 * (listFilterActive's rule). Rentals items apply a search, a stock view, a
 * Category and a Location only. The lifecycle view (Active, All, Archived,
 * Discontinued) is the list itself here: each message showed on any of them.
 */
function narrowings(kind: ListEmptyKind, s: InstantModeState): Narrowing[] {
  const on: Narrowing[] = [];
  if (buildInstantSearchTerm(s.q) !== '') on.push('q');
  if (s.stock !== null) on.push('stock');
  if (s.cat.length > 0) on.push('cat');
  if (s.loc.length > 0) on.push('loc');
  if (kind === 'rentals') return on;
  if (s.expected) on.push('expected');
  if (s.charter.length > 0) on.push('charter');
  if (s.rack.trim() !== '') on.push('rack');
  if (s.autoArchived) on.push('auto');
  return on;
}

/**
 * The message a list's empty area shows when its one narrowing left nothing,
 * or null for the table's general line, "No items match your filters.".
 *
 * Grouping walk review 2026-10-20 (integrator decision 1): the Items, Books and
 * Rentals items pages used to answer a search, a stock view or the Expected chip
 * that left nothing with a page-level message and no filter bar. Since batch D
 * the table answers every filtered empty view, with the bar, the active chips
 * and "Clear all filters" on screen, and these are its words for those views,
 * exactly as the pages wrote them:
 *
 * - Items: "No expected items", "No low-stock items", "Nothing is out of
 *   stock", "No items match your search".
 * - Books: "No expected books", "No low-stock books", "No out-of-stock books"
 *   (Books never had a search message: a search shows the general line).
 * - Rentals items: "No rental items match your search".
 *
 * Each shows when its narrowing is the only one on; with two or more, the
 * general line (the pages' messages then named only one of them). `state.q` is
 * the box's search; the description quotes it trimmed, at most 40 characters.
 */
export function listEmptyMessage(
  kind: ListEmptyKind,
  state: InstantModeState,
): ListEmptyMessage | null {
  const on = narrowings(kind, state);
  if (on.length !== 1) return null;
  const only = on[0];
  const href = LIST_PATH[kind];
  const searched = state.q.trim().slice(0, 40);

  if (kind === 'rentals') {
    if (only !== 'q') return null;
    return {
      title: 'No rental items match your search',
      description: `Nothing matched "${searched}". Try a different name or SKU.`,
      cta: { label: 'Clear search', href },
    };
  }

  if (kind === 'books') {
    if (only === 'expected') {
      return {
        title: 'No expected books',
        description:
          'Books created from purchase orders appear here until their first stock is received.',
        cta: { label: 'Back to all books', href },
      };
    }
    if (only === 'stock' && state.stock === 'low') {
      return {
        title: 'No low-stock books',
        description:
          'No books are at or below their reorder point right now. Clear the filter to see all books.',
        cta: { label: 'Show all books', href },
      };
    }
    if (only === 'stock' && state.stock === 'out') {
      return {
        title: 'No out-of-stock books',
        description: 'Nothing is at zero quantity right now. Clear the filter to see all books.',
        cta: { label: 'Show all books', href },
      };
    }
    return null;
  }

  if (only === 'expected') {
    return {
      title: 'No expected items',
      description:
        'Items created from purchase orders appear here until their first stock is received.',
      cta: { label: 'Back to all items', href },
    };
  }
  if (only === 'stock' && state.stock === 'low') {
    return {
      title: 'No low-stock items',
      description: 'Nothing is at or below its reorder point right now. Nice.',
      cta: { label: 'Show all items', href },
    };
  }
  if (only === 'stock' && state.stock === 'out') {
    return {
      title: 'Nothing is out of stock',
      description: 'No active items have a quantity of zero. Clear the filter to see all items.',
      cta: { label: 'Show all items', href },
    };
  }
  if (only === 'q') {
    return {
      title: 'No items match your search',
      description: `Nothing matched "${searched}". Try a different SKU, name, or barcode.`,
      cta: { label: 'Clear search', href },
    };
  }
  return null;
}

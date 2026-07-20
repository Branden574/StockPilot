import { listStatusPredicate } from './expected-items';
import type { CountPick } from './use-count-selection';

/**
 * Pure helpers for the embedded cycle-count item picker on
 * app/cycle-count/new.tsx (mobile twin of web's CountItemPicker,
 * commit 7b738cdc). Kept free of React/react-native imports so the
 * query plan, the word-AND search groups, and the row→pick mapping are
 * unit-testable exactly like expected-items.ts / po-import-approve.ts.
 *
 * The picker reads `inventory_items` through the SAME default-visibility
 * predicates as the Items/Books tabs' default views — active lifecycle,
 * not deleted, not awaiting first receipt (mig 0277 phantoms: you cannot
 * count stock that never arrived) — derived from `listStatusPredicate`
 * so the screens can never drift apart.
 */

export const COUNT_PICKER_PAGE_SIZE = 50;

export type CountPickerTab = 'product' | 'book';

/** The columns the picker renders (subset of the tabs' selects). */
export interface CountPickerRow {
  id: string;
  name: string;
  sku: string;
  item_type: string;
  quantity_on_hand: number;
}

/**
 * Declarative plan for one picker page. new.tsx applies this to the
 * Supabase builder verbatim; keeping it as data means the predicate set
 * is asserted in tests without mocking PostgREST.
 */
export interface CountPickerPlan {
  /** Books tab lists books only (`eq`); Inventory lists everything BUT
   *  books (`neq`) — the exact split the two list tabs use. */
  itemType: { op: 'eq' | 'neq'; value: 'book' };
  /** `.eq('awaiting_first_receipt', …)` — always false here (default view). */
  awaitingFirstReceipt: boolean;
  /** `.eq('status', …)` — always 'active' here (you count live stock;
   *  archived items are unreachable, same as the tabs' default views). */
  lifecycle: 'active' | 'archived' | null;
  /** One PostgREST `.or()` group per query word; PostgREST ANDs the
   *  groups, giving the tabs' word-AND search across name/sku/barcode. */
  orGroups: string[];
  /** `.range(from, to)` for 50-per-page load-more paging. */
  range: { from: number; to: number };
}

/**
 * Word-AND search groups — the exact pattern the Items tab builds inline:
 * every word of the query must match SOMEWHERE across name / sku /
 * barcode, so "purple shirt" finds "L4L Purple T-Shirt". Values are
 * double-quoted so PostgREST-reserved chars (, ( ) . — common in titles,
 * model numbers and pasted ISBNs) stay literal.
 */
export function searchWordGroups(query: string): string[] {
  return query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => {
      const term = word.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      return `name.ilike."%${term}%",sku.ilike."%${term}%",barcode.ilike."%${term}%"`;
    });
}

/** Build the query plan for one page of the picker list. */
export function countPickerPlan(
  tab: CountPickerTab,
  query: string,
  offset: number,
): CountPickerPlan {
  // Derive visibility from the SAME predicate function the Items/Books
  // tabs use for their default ('all') view — phantoms stay hidden and
  // only active items are countable, by construction.
  const pred = listStatusPredicate('all');
  return {
    itemType: { op: tab === 'book' ? 'eq' : 'neq', value: 'book' },
    awaitingFirstReceipt: pred.awaitingFirstReceipt,
    lifecycle: pred.lifecycle,
    orGroups: searchWordGroups(query),
    range: { from: offset, to: offset + COUNT_PICKER_PAGE_SIZE - 1 },
  };
}

/**
 * Store payload for a checked row. Trusts the ROW's own item_type — not
 * the active tab — so a book surfacing outside the Books tab still
 * groups under BOOKS on the review list (web-parity: the web picker's
 * toggle does the same).
 */
export function pickFromRow(
  row: Pick<CountPickerRow, 'id' | 'sku' | 'name' | 'item_type'>,
): CountPick {
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    itemType: row.item_type === 'book' ? 'book' : 'product',
  };
}

/**
 * Append a page to the loaded rows, de-duping by id — concurrent
 * inserts/renames can shift offset pages between requests (same
 * rationale as SerialsCard's loadMore).
 */
export function mergeRows<T extends { id: string }>(prev: T[], next: T[]): T[] {
  const seen = new Set(prev.map((r) => r.id));
  return [...prev, ...next.filter((r) => !seen.has(r.id))];
}

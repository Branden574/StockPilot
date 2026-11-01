/**
 * The purchase orders list's search, as one rule: a purchase order matches
 * when its PO number or its supplier's name contains what was typed, in any
 * case, taken literally ("%" and "_" are just characters). A purchase order
 * with no supplier, or one the list does not name (archived), reads "—".
 *
 * The instant list (800 purchase orders or fewer) searches in the browser with
 * this; the server-paged list searches in the database (purchase_orders_page,
 * the same rule as ILIKE with %, _ and \ escaped), except the Overdue view,
 * whose rows are read whole and searched and paged here (small fixes slice 8).
 *
 * Plain module (no 'use client'): the server page and the client table use it.
 */

export interface SearchablePo {
  po_number: string;
  supplier_id: string | null;
}

/** True when `po` matches `query` (trimmed; an empty query matches all). */
export function poMatchesSearch(
  po: SearchablePo,
  query: string,
  supplierName: (id: string | null) => string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return (
    po.po_number.toLowerCase().includes(needle) ||
    supplierName(po.supplier_id).toLowerCase().includes(needle)
  );
}

/**
 * One page (1-based) of the rows that match `query`, and how many match in
 * all. A page past the end is empty, with the true total, so the list can
 * say where the matches are.
 */
export function searchedPage<T extends SearchablePo>(
  rows: readonly T[],
  opts: {
    query: string;
    page: number;
    perPage: number;
    supplierName: (id: string | null) => string;
  },
): { rows: T[]; total: number } {
  const matching = rows.filter((po) => poMatchesSearch(po, opts.query, opts.supplierName));
  const perPage = Math.max(1, Math.floor(opts.perPage));
  const page = Math.max(1, Math.floor(opts.page));
  return { rows: matching.slice((page - 1) * perPage, page * perPage), total: matching.length };
}

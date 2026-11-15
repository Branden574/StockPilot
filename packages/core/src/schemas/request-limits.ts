/**
 * Upper bounds for the lists and keyed objects that requests carry.
 *
 * zod answers a list longer than its .max() with one issue and validates none
 * of its elements (patches/zod@3.25.76.patch), so every list in a request
 * schema has a bound (apps/web/src/test/zod-array-bounds.guard.test.ts).
 * Each bound is at least ten times the most the product's own screens,
 * imports and phone app send for that field: a bound is there to stop a
 * request no screen makes, never to limit real work.
 */

/** "50,000" for a message (no Intl: the phone builds these at start-up). */
export function formatLimit(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Ids picked from one of an organization's own lists: categories, charters,
 * sites, members. Those lists stop at 10,000 rows (LOOKUP_ROW_CEILING,
 * apps/web/src/server/services/lib/lookup-ceiling.ts), and the Warehouses and
 * Team saves refuse to act past it.
 */
export const MAX_PICKED_IDS = 100_000;

/**
 * Lines of one purchase order request: create and edit, a receipt, a recurring
 * template, a PO import's approval and its per-line answers. The largest
 * purchase order a bounded code path drafts is one planning run's 5,000 items
 * (PLANNING_MAX_ITEMS, apps/web/src/server/services/planning.ts). A scanned PO
 * keeps at most 500 lines (MAX_SCAN_LINES, apps/web/src/lib/po-scan/extract.ts),
 * a shortfall PO 200 (SHORTFALL_PO_MAX_LINES), and a PO import's review reads
 * at most 1,000 lines (PostgREST max_rows, supabase/config.toml).
 */
export const MAX_PO_LINES = 50_000;

/**
 * Serial numbers or lots on one received line, and lots picked for one order
 * line. The receive form asks for one serial per accepted unit and lets the
 * receiver add lot rows, with no limit of its own; adding serials to an item
 * takes at most 500 at a time (MAX_SERIALS_PER_ADD,
 * apps/web/src/server/services/serials.ts). Twenty times that.
 */
export const MAX_UNITS_PER_LINE = 10_000;

/**
 * A list of choices from a fixed set (an enum): a screen offers each choice
 * once, so ten times the size of the set.
 */
export function maxChoices(choices: readonly unknown[]): number {
  return choices.length * 10;
}

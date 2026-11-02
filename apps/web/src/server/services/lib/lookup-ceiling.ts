import 'server-only';

import { reportError } from '@/lib/error-reporter';

/**
 * The most rows one B47 lookup read returns.
 *
 * B47 reads the organization-wide category, tag, charter and supplier lists,
 * the warehouse charter links and each warehouse's delivery sites page by
 * page (fetchAllRows), past PostgREST's 1000-row max_rows. Before B47 each of
 * them was one read, so PostgREST bounded it at 1000 rows. Paging removes
 * that bound, so every one of these reads passes `{ cap: LOOKUP_ROW_CEILING }`
 * and stops here: ten pages of 1000, the bound the order catalog already has
 * (CATALOG_ROW_CEILING in server/loaders/orders-new-catalog.ts).
 *
 * At the ceiling:
 * - the read reports it once (reportLookupCeiling), so it is never silent;
 * - a list for display answers its first LOOKUP_ROW_CEILING rows, in the
 *   read's own stable order;
 * - a save that would act on the list refuses in plain words instead of
 *   acting on part of it (the Admin > Warehouses save, Team's member Charters
 *   save), or leaves the decision to the server (the item and Books edit
 *   forms keep a record's charter when its warehouse changes).
 *
 * Revisit under the 500+ users performance brief if an organization nears it.
 */
export const LOOKUP_ROW_CEILING = 10_000;

/** Whose list reached the ceiling: an organization's or one warehouse's. */
export type LookupCeilingScope = { organizationId: string } | { warehouseId: string };

/**
 * Reports, once per read, that a lookup reached LOOKUP_ROW_CEILING, so rows
 * past it are not in the list. Level warning, as reportDegradedRead: the page
 * still answers. Names the lookup and the organization or warehouse id only,
 * never a row's name.
 *
 * The caller compares the rows it read with LOOKUP_ROW_CEILING itself (a test
 * lowers the ceiling through a getter on this module, which only callers that
 * import the binding see).
 */
export function reportLookupCeiling(lookup: string, scope: LookupCeilingScope): void {
  void reportError(new Error('A lookup reached its row ceiling; rows past it are not listed'), {
    tag: `lookup_ceiling.${lookup}`,
    level: 'warning',
    organizationId: 'organizationId' in scope ? scope.organizationId : null,
    extra: { lookup, ...scope },
  });
}

/**
 * Every row of one filtered PostgREST query, paged past the 1000-row
 * `[api] max_rows` cap that silently truncates any single `.select()` (even
 * one with `.limit(5000)`). The phone twin of the web's fetchAllRows
 * (apps/web/src/server/services/lib/paginate.ts), loop for loop.
 *
 * WHICH PAGER. id-batches.ts `fetchAllPages` is for a read that must come back
 * whole: past 20 pages it REFUSES the read. This one stops at a CEILING the
 * caller names and returns the rows up to it, for a list the web also cuts at
 * a ceiling (the New rental picker mirrors the web's CATALOG_ROW_CEILING). The
 * caller compares the length with its ceiling and says so when it is reached;
 * a ceiling is never a silent cut.
 *
 * Pass a `buildPage(from, to)` that builds the query for one window: the
 * filters, a stable order ending on `id`, and `.range(from, to)`. Without the
 * `id` tiebreak the same row can land on two pages or none. The loop stops at
 * a short page (fewer rows than asked) or at `cap`.
 *
 * THROWS on any failed page: IdBatchReadError for a page answered with
 * `{ error }` (its message never empty), and a rejected request as it came.
 * Never the rows read before the failure: a first page standing in for the
 * whole list is the bug this exists to prevent.
 *
 * Pure and platform-free: no React Native import, no Supabase client, so it is
 * unit-testable under vitest. Do not import ./supabase or ./image-cache here.
 */

import { IdBatchReadError, readErrorMessage, type PageBuilder } from './id-batches';
import { POSTGREST_MAX_ROWS } from './inventory-paging';

/** Rows per page: the server's cap, so a full page comes back in full. */
export const PAGE_SIZE = POSTGREST_MAX_ROWS;

export async function fetchAllRows<Row>(
  buildPage: PageBuilder<Row>,
  opts: { cap?: number } = {},
): Promise<Row[]> {
  const cap = opts.cap;
  const rows: Row[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const to = cap !== undefined ? Math.min(from + PAGE_SIZE, cap) - 1 : from + PAGE_SIZE - 1;
    if (cap !== undefined && to < from) break;
    const res = await buildPage(from, to);
    // readErrorMessage, not error.message: a gateway 502 with an empty body
    // has an empty message, and the screen would show a failure with no cause.
    if (res.error) {
      throw new IdBatchReadError(
        readErrorMessage(res.error, res.status, res.statusText),
        res.status ?? null,
      );
    }
    const page = res.data ?? [];
    for (const r of page) rows.push(r);
    if (page.length < to - from + 1) break;
    if (cap !== undefined && rows.length >= cap) break;
  }
  return rows;
}

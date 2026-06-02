import 'server-only';

import { ServiceError } from '../context';

/** PostgREST clamps every response to `[api] max_rows` (1000;
 *  supabase/config.toml). Keep page size at the cap so each page returns in
 *  full. */
export const PAGE_SIZE = 1000;

/** Minimal shape of a Supabase PostgREST query awaited to `{ data, error }`. */
type PageResult<Row> = { data: Row[] | null; error: { message: string } | null };

/**
 * Fetch the COMPLETE rowset for a filtered PostgREST query, working around the
 * `[api] max_rows = 1000` cap that silently truncates any single `.select()`
 * (even one with `.limit(5000)`).
 *
 * Pass a `buildPage(from, to)` that constructs the query for one 1000-row
 * window — apply your `.from/.select/.eq/...` filters and finish with a stable
 * `.order('id')` and `.range(from, to)`. The helper loops, accumulating rows,
 * and stops when the DB returns a short page (fewer than PAGE_SIZE rows) or the
 * optional `cap` is reached. Mirrors the canonical loop in forecasting.ts
 * `getBulkItemVelocities` and order-requests.ts `exportRows`.
 *
 * The stable `.order('id')` is REQUIRED: without a deterministic sort the same
 * row can land on two pages (or none), corrupting the accumulated set.
 */
export async function fetchAllRows<Row>(
  buildPage: (from: number, to: number) => PromiseLike<PageResult<Row>>,
  opts: { cap?: number } = {},
): Promise<Row[]> {
  const cap = opts.cap;
  const rows: Row[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const to = cap !== undefined ? Math.min(from + PAGE_SIZE, cap) - 1 : from + PAGE_SIZE - 1;
    if (cap !== undefined && to < from) break;
    const { data, error } = await buildPage(from, to);
    if (error) throw new ServiceError('internal_error', error.message);
    const page = (data ?? []) as Row[];
    for (const r of page) rows.push(r);
    if (page.length < to - from + 1) break;
    if (cap !== undefined && rows.length >= cap) break;
  }
  return rows;
}

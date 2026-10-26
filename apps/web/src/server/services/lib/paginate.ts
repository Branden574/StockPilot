import 'server-only';

import { IN_FILTER_DEFAULT_CONCURRENCY, mapWithConcurrency } from '@/lib/supabase/in-filter';

import { ServiceError } from '../context';
import { postgrestErrorText } from './postgrest-error';

/** PostgREST clamps every response to `[api] max_rows` (1000;
 *  supabase/config.toml). Keep page size at the cap so each page returns in
 *  full. */
export const PAGE_SIZE = 1000;

/** Minimal shape of a Supabase PostgREST query awaited to `{ data, error }`.
 *  `status` is optional because a hand-built stub may leave it out; the real
 *  response always carries it. */
type PageResult<Row> = {
  data: Row[] | null;
  error: { message: string } | null;
  status?: number;
  statusText?: string;
};

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
    const res = await buildPage(from, to);
    const { data, error } = res;
    // postgrestErrorText, not error.message: a gateway 502 with an empty body
    // has an empty message, which left internalDetail undefined and the log
    // with no cause at all.
    if (error) throw new ServiceError('internal_error', postgrestErrorText(error, res));
    const page = (data ?? []) as Row[];
    for (const r of page) rows.push(r);
    if (page.length < to - from + 1) break;
    if (cap !== undefined && rows.length >= cap) break;
  }
  return rows;
}

/** A page that may carry PostgREST's count of the whole filtered set. */
type CountedPageResult<Row> = PageResult<Row> & { count?: number | null };

/**
 * fetchAllRows, with every page after the first one sent AT ONCE (at most
 * `concurrency` in flight), for a read whose size grows with the organization.
 *
 * fetchAllRows sends page N+1 only once page N has answered, so a read of N
 * thousand rows costs N round trips one after another. On a request with a
 * deadline (the phone's snapshot pull gives up after 20 s) each of them adds
 * a whole round trip: at 1.5 s per call, 10,000 rows took 16.5 s on their own.
 *
 * The first page asks PostgREST for the exact size of the filtered set
 * (`buildPage(0, 999, true)` must select with `{ count: 'exact' }`); the pages
 * that count says remain go out together. Rows added after the count, or a
 * page that answered without one, are read on, one page at a time, exactly as
 * fetchAllRows does until a short page. The same pages, the same filters and
 * the same order: only the waiting changes. Rows edited between two page
 * reads can move between pages, as they could before.
 *
 * Throws the same ServiceError('internal_error') as fetchAllRows on the first
 * page that fails.
 */
export async function fetchAllRowsConcurrently<Row>(
  buildPage: (from: number, to: number, withCount: boolean) => PromiseLike<CountedPageResult<Row>>,
  opts: { concurrency?: number } = {},
): Promise<Row[]> {
  const read = async (from: number, withCount: boolean): Promise<CountedPageResult<Row>> => {
    const res = await buildPage(from, from + PAGE_SIZE - 1, withCount);
    if (res.error) throw new ServiceError('internal_error', postgrestErrorText(res.error, res));
    return res;
  };

  const first = await read(0, true);
  const rows: Row[] = [...((first.data ?? []) as Row[])];
  if (rows.length < PAGE_SIZE) return rows;

  const total =
    typeof first.count === 'number' && Number.isFinite(first.count) ? first.count : null;
  const starts: number[] = [];
  if (total !== null) for (let from = PAGE_SIZE; from < total; from += PAGE_SIZE) starts.push(from);
  const pages = await mapWithConcurrency(
    starts,
    opts.concurrency ?? IN_FILTER_DEFAULT_CONCURRENCY,
    async (from) => ((await read(from, false)).data ?? []) as Row[],
  );
  for (const page of pages) for (const r of page) rows.push(r);

  // Past the counted pages: one at a time until a short page.
  let last: Row[] = pages.length > 0 ? pages[pages.length - 1]! : ((first.data ?? []) as Row[]);
  for (let from = PAGE_SIZE * (starts.length + 1); last.length >= PAGE_SIZE; from += PAGE_SIZE) {
    last = ((await read(from, false)).data ?? []) as Row[];
    for (const r of last) rows.push(r);
  }
  return rows;
}

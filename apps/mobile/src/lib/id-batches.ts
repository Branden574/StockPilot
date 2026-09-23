/**
 * Batching for PostgREST `.in(column, values)` reads on the phone.
 *
 * WHY THIS EXISTS. supabase-js (postgrest-js 2.105) puts every `.in()` value
 * into the request URL: it quotes a value holding `,`, `(` or `)`, joins them
 * with `,` and appends the list through `url.searchParams`, which percent-
 * encodes it. A uuid then costs about 39 characters with its encoded `%2C`
 * separator. Two limits bite on the length of that URL:
 *
 *   - Local (developers, the lab): the gateway refuses a request line past
 *     about 8 KB, about 215 uuids.
 *   - Production: PostgREST echoes the whole path back in a response header,
 *     and a response whose headers pass about 16 KB fails (measured on the web
 *     at about 395 uuids; React Native's own limit is not measured, and the
 *     edge's URL limit is also about 16 KB).
 *
 * Where a screen ignored `{ error }`, that failure became a silent wrong
 * answer: reserved stock shown as available, an order that looked short, a
 * member list that looked empty. The web fixed the same class in
 * apps/web/src/server/services/lib/fetch-by-ids.ts; this is its mobile twin,
 * with the same budget (100 values and 4,000 encoded characters per batch).
 *
 * THE RULE. A `.in()` whose values are not a short constant list goes through
 * `fetchAllRowsByIds`, which batches the values, pages each batch past the
 * 1000-row `max_rows` cap, runs a few batches at once, and THROWS on any failed
 * page. It never returns a partial set. The static guard in
 * in-filter-sites.guard.test.ts recognises a batched builder by its parameter
 * name, so name it `batch`.
 *
 * Pure and platform-free: no React Native import, no Supabase client, so it is
 * unit-testable under vitest. Do not import ./supabase or ./image-cache here.
 */

import { POSTGREST_MAX_ROWS } from './inventory-paging';

/** Values per `.in()` batch. Same as web. */
export const IN_FILTER_MAX_VALUES = 100;

/** Encoded characters per `.in()` batch. 100 uuids encode to 3,897 (values
 *  plus separators), which leaves more than 4 KB of the 8 KB local limit for
 *  the path, the select, the other filters and order/range. */
export const IN_FILTER_MAX_ENCODED_CHARS = 4_000;

/** Batches in flight at once. 1000 ids is 10 batches, so two waves. */
export const IN_FILTER_DEFAULT_CONCURRENCY = 6;

/** Pages read per batch before the read is REFUSED. 20 pages of 1000 rows is
 *  far past anything a phone screen shows; hitting it fails closed rather than
 *  returning a short set. */
export const MAX_PAGES_PER_BATCH = 20;

/** The characters `%2C` adds between two values. */
const SEPARATOR_CHARS = 3;

/** postgrest-js wraps a string value in double quotes when it contains one of
 *  these (`PostgrestReservedCharsRegexp`, postgrest-js index.mjs). */
const RESERVED = /[,()]/;

/**
 * Encoded length postgrest-js adds to the URL for ONE value, without the
 * separator.
 *
 * postgrest-js serializes through URLSearchParams (form encoding). This
 * mirrors that WITHOUT depending on the React Native URL polyfill:
 * encodeURIComponent leaves `! ' ( ) ~` bare where form encoding escapes them
 * (3 characters each), and writes a space as `%20` where form encoding writes
 * `+`. Everything else is identical. The test cross-checks it against Node's
 * real URLSearchParams.
 */
export function encodedInValueLength(value: string | number): number {
  const raw = typeof value === 'string' && RESERVED.test(value) ? `"${value}"` : String(value);
  try {
    return encodeURIComponent(raw).replace(/%20/g, '+').replace(/[!'()~]/g, '%XX').length;
  } catch {
    // A lone surrogate makes encodeURIComponent throw; URLSearchParams writes
    // U+FFFD (9 encoded characters) for it. Count every unit at that cost.
    return raw.length * 9;
  }
}

/**
 * Split `values` into batches for `.in()`.
 *
 * Drops null and undefined, dedupes keeping first-seen order, then packs
 * greedily so each batch holds at most `maxValues` values AND the sum of
 * `encodedInValueLength(v) + 3` stays within `maxEncodedChars`. A single value
 * longer than the whole budget goes in a batch of its own: never split and
 * never dropped. Returns [] for an empty list.
 */
export function chunkInFilterValues<V extends string | number>(
  values: readonly (V | null | undefined)[],
  opts: { maxValues?: number; maxEncodedChars?: number } = {},
): V[][] {
  const maxValues = Math.max(1, Math.floor(opts.maxValues ?? IN_FILTER_MAX_VALUES));
  const maxChars = opts.maxEncodedChars ?? IN_FILTER_MAX_ENCODED_CHARS;
  const batches: V[][] = [];
  const seen = new Set<V>();
  let current: V[] = [];
  let currentChars = 0;
  for (const value of values) {
    if (value === null || value === undefined) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    const cost = encodedInValueLength(value) + SEPARATOR_CHARS;
    if (current.length > 0 && (current.length >= maxValues || currentChars + cost > maxChars)) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(value);
    currentChars += cost;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * Run `fn` over `items` with at most `limit` calls in flight. Results come
 * back in input order.
 *
 * After the first rejection no new item starts, the calls already in flight
 * are awaited (so none becomes an unhandled rejection), and then the FIRST
 * error is rethrown.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  if (items.length === 0) return results;
  const width = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  let next = 0;
  let failed = false;
  let firstError: unknown;
  async function worker(): Promise<void> {
    while (!failed && next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = await fn(items[index] as T, index);
      } catch (err) {
        if (!failed) {
          failed = true;
          firstError = err;
        }
      }
    }
  }
  await Promise.all(Array.from({ length: width }, () => worker()));
  if (failed) throw firstError;
  return results;
}

/** One awaited PostgREST page: `{ data, error }` plus the HTTP status. */
export interface PageResult<Row> {
  data: Row[] | null;
  error: { message: string } | null;
  status?: number;
  statusText?: string;
}

/** Builds and runs the query for rows `from`..`to` of one batch. */
export type PageBuilder<Row> = (from: number, to: number) => PromiseLike<PageResult<Row>>;

/** A batched read that did not come back whole. Never caught into "empty". */
export class IdBatchReadError extends Error {
  override readonly name = 'IdBatchReadError';
  readonly status: number | null;
  constructor(message: string, status: number | null) {
    super(message);
    this.status = status;
  }
}

export interface IdBatchOpts {
  maxValues?: number;
  maxEncodedChars?: number;
  concurrency?: number;
  /** Rows per page. Capped at POSTGREST_MAX_ROWS: a larger page would make a
   *  full 1000-row server page look short, which is silent truncation. */
  pageSize?: number;
}

function errorText(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  const s = String(err);
  return s && s !== '[object Object]' ? s : 'The request failed.';
}

/**
 * Every row of ONE query, paged past the 1000-row cap: one batch of an id
 * list, or a whole list read with no id filter. The builder's query must end
 * in a stable order (ending on `id`) and `.range(from, to)`. Throws
 * IdBatchReadError on a failed page, a rejected request, or a query still
 * full after MAX_PAGES_PER_BATCH pages; never returns a short set.
 */
export async function fetchAllPages<Row>(
  builder: PageBuilder<Row>,
  pageSize: number = POSTGREST_MAX_ROWS,
): Promise<Row[]> {
  // Capped at the server's row cap: a larger page would make a full server
  // page look short, which is silent truncation.
  pageSize = Math.min(POSTGREST_MAX_ROWS, Math.max(1, Math.floor(pageSize)));
  const rows: Row[] = [];
  for (let page = 0; page < MAX_PAGES_PER_BATCH; page += 1) {
    const from = page * pageSize;
    const to = from + pageSize - 1;
    let res: PageResult<Row>;
    try {
      res = await builder(from, to);
    } catch (err) {
      throw new IdBatchReadError(errorText(err), null);
    }
    if (res.error) {
      // An empty 502 body has an empty message; say what came back instead.
      const message =
        res.error.message ||
        `HTTP ${res.status ?? '?'} ${res.statusText ?? ''}`.trim();
      throw new IdBatchReadError(message, res.status ?? null);
    }
    const window = res.data ?? [];
    for (const r of window) rows.push(r);
    // A short page is the end of the set: the only reliable signal, since no
    // total is asked for.
    if (window.length < pageSize) return rows;
  }
  throw new IdBatchReadError('Too many rows to load on the phone.', null);
}

/**
 * Every row matching an id list.
 *
 * `buildPage(batch)` must return a page builder whose query ends in a stable
 * `.order(..., 'id')` and `.range(from, to)`; without a total order the same
 * row can land on two pages or none. Empty input makes NO request.
 *
 * Throws IdBatchReadError on the first failed page, a rejected request, or a
 * batch still full after MAX_PAGES_PER_BATCH pages. It never returns a
 * partial set: a caller whose read feeds a decision lets it propagate (or
 * settles it into a visible failure); a cosmetic read may degrade, but must
 * not remember the failure as "nothing".
 *
 * Rows come back grouped by batch, in batch order, and in query order within
 * a batch. Values are deduped, so every row for one value sits in ONE batch:
 * a per-value "first row wins" pick (an item's primary photo) is unchanged.
 */
export async function fetchAllRowsByIds<Row, V extends string | number = string>(
  values: readonly (V | null | undefined)[],
  buildPage: (batch: V[]) => PageBuilder<Row>,
  opts: IdBatchOpts = {},
): Promise<Row[]> {
  const batches = chunkInFilterValues(values, opts);
  if (batches.length === 0) return [];
  // fetchAllPages caps this at POSTGREST_MAX_ROWS (the one place it is capped).
  const pageSize = opts.pageSize ?? POSTGREST_MAX_ROWS;
  const perBatch = await mapWithConcurrency(
    batches,
    opts.concurrency ?? IN_FILTER_DEFAULT_CONCURRENCY,
    async (batch) => {
      let builder: PageBuilder<Row>;
      try {
        builder = buildPage(batch);
      } catch (err) {
        throw new IdBatchReadError(errorText(err), null);
      }
      return fetchAllPages(builder, pageSize);
    },
  );
  const rows: Row[] = [];
  for (const batchRows of perBatch) for (const row of batchRows) rows.push(row);
  return rows;
}

/** A settled batched read: the value, or the reason it did not load. */
export type IdBatchOutcome<T> = { ok: true; value: T } | { ok: false; message: string };

/**
 * Settle a throwing batched read into an outcome a screen can branch on
 * without a try/catch. A failure is an outcome of its own, never an empty
 * value.
 */
export async function settleIdBatchRead<T>(p: Promise<T>): Promise<IdBatchOutcome<T>> {
  try {
    return { ok: true, value: await p };
  } catch (err) {
    return { ok: false, message: errorText(err) };
  }
}

/**
 * Structural slice of the Supabase client the id-list readers need. `from`
 * returns `unknown` ON PURPOSE, the technique cycle-count-lines-fetch.ts uses:
 * spelling the real PostgREST builder makes TS instantiate its select-string
 * parser against embedded selects and blow the recursion limit (TS2589). The
 * chain is re-narrowed to IdReadTable inside id-reads.ts, and the tests drive
 * it with a fake that records every call.
 */
export interface IdReadClient {
  from(table: string): unknown;
}

/** The PostgREST filter chain the readers use, typed only as far as needed. */
export interface IdReadChain {
  eq(column: string, value: unknown): IdReadChain;
  in(column: string, values: readonly unknown[]): IdReadChain;
  is(column: string, value: null): IdReadChain;
  not(column: string, operator: string, value: unknown): IdReadChain;
  gt(column: string, value: number): IdReadChain;
  order(column: string, opts?: { ascending?: boolean }): IdReadChain;
  range(from: number, to: number): PromiseLike<PageResult<unknown>>;
}

/** `client.from(table)`, re-narrowed. */
export interface IdReadTable {
  select(columns: string): IdReadChain;
}

/** Narrow a structural client's table to the chain the readers use. */
export function idReadTable(client: IdReadClient, table: string): IdReadTable {
  return client.from(table) as IdReadTable;
}

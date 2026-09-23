import 'server-only';

import {
  chunkInFilterValues,
  IN_FILTER_DEFAULT_CONCURRENCY,
  mapWithConcurrency,
} from '@/lib/supabase/in-filter';

import { ServiceError } from '../context';
import { fetchAllRows } from './paginate';

/**
 * Id-list reads and writes that stay under the request-URL limits.
 *
 * Every `.in(column, values)` rides in the URL. Past about 215 uuids the local
 * gateway answers 414, and past about 395 production fails with a bare
 * "TypeError: fetch failed" (the echoed `Content-Location` header overflows
 * undici's 16 KB limit), after postgrest-js has retried the GET three times
 * with 1 s, 2 s and 4 s sleeps. Where a caller ignored `error`, that became a
 * silent wrong answer. See `@/lib/supabase/in-filter` for the numbers.
 *
 * The rule: a `.in()` whose values are not a short constant list goes through
 * one of these helpers, which batch the values (100 per batch, and a character
 * budget for long strings). The static guard in
 * `@/lib/supabase/in-filter-sites.guard.test.ts` recognises a helper callback
 * by its parameter name, so name it `batch`.
 */

type PageResult<Row> = { data: Row[] | null; error: { message: string } | null };

export type BatchOpts = {
  maxValues?: number;
  maxEncodedChars?: number;
  concurrency?: number;
};

/**
 * Read every row matching an id list.
 *
 * Batches `values`, pages EACH batch past PostgREST's 1000-row `max_rows` cap
 * through `fetchAllRows` (so `buildPage(batch)` must return a page builder that
 * ends with a stable `.order(...)` including `'id'` and `.range(from, to)`), and
 * runs at most `concurrency` batches at once. Empty input returns [] without a
 * request.
 *
 * Rows come back grouped by batch, in batch order, and in the query's own order
 * within a batch. Values are deduped, so every row for one value lives in ONE
 * batch: a per-value "first row wins" pick (an item's primary image, its newest
 * receipt) is unchanged. A caller that needs one global order sorts afterwards.
 *
 * Throws the `ServiceError('internal_error')` from `fetchAllRows` unchanged on
 * the first failed page: its public message is generic and the raw PostgREST
 * text is in `.internalDetail`. A caller whose read feeds a decision lets it
 * propagate; a cosmetic read catches it and reports it.
 */
export async function fetchAllRowsByIds<Row, V extends string | number = string>(
  values: readonly (V | null | undefined)[],
  buildPage: (batch: V[]) => (from: number, to: number) => PromiseLike<PageResult<Row>>,
  opts: BatchOpts = {},
): Promise<Row[]> {
  const batches = chunkInFilterValues(values, opts);
  if (batches.length === 0) return [];
  const perBatch = await mapWithConcurrency(
    batches,
    opts.concurrency ?? IN_FILTER_DEFAULT_CONCURRENCY,
    (batch) => fetchAllRows<Row>(buildPage(batch)),
  );
  const rows: Row[] = [];
  for (const batchRows of perBatch) for (const row of batchRows) rows.push(row);
  return rows;
}

/**
 * Per-batch arbitrary work (a top-k `.limit()` per batch, a count, a read that
 * is already bounded per value), at most `concurrency` batches at once, results
 * in batch order. `run` decides what an error means; a throw stops new batches
 * and is rethrown after the ones in flight settle.
 */
export async function mapIdBatches<V extends string | number, R>(
  values: readonly (V | null | undefined)[],
  run: (batch: V[]) => Promise<R>,
  opts: BatchOpts = {},
): Promise<R[]> {
  const batches = chunkInFilterValues(values, opts);
  return mapWithConcurrency(batches, opts.concurrency ?? IN_FILTER_DEFAULT_CONCURRENCY, (batch) =>
    run(batch),
  );
}

export interface IdBatchWriteResult<V, Row> {
  /** Rows returned by the batches that succeeded (when the write used `.select()`). */
  rows: Row[];
  /** Values whose batch succeeded. */
  written: V[];
  /** Values of the failed batch and, with `stopOnError`, of every later batch. */
  notWritten: V[];
  /** Raw text of the first failure, for server logs only. */
  error: string | null;
}

/**
 * Apply one write to an id list in batches, ONE BATCH AT A TIME.
 *
 * Every write in this class sets a column to a constant (or deletes) on a set
 * of ids, filtered by org and usually by a race guard, so each row's write is
 * independent of the others and a batch is correct on its own. Sequential so a
 * stop on error leaves a clean "first N batches written" prefix.
 *
 * Never throws on a failed batch (a PostgREST error or a rejected request):
 * the result says what was written and what was not, and the caller decides.
 * A caller whose `written` is not empty must still do the follow-up work for
 * that part (cache invalidation, audit) before it reports the failure.
 */
export async function writeInIdBatches<V extends string | number, Row = never>(
  values: readonly (V | null | undefined)[],
  run: (batch: V[]) => PromiseLike<{ data?: Row[] | null; error: { message: string } | null }>,
  opts: { maxValues?: number; maxEncodedChars?: number; stopOnError?: boolean } = {},
): Promise<IdBatchWriteResult<V, Row>> {
  const stopOnError = opts.stopOnError ?? true;
  const batches = chunkInFilterValues(values, opts);
  const result: IdBatchWriteResult<V, Row> = { rows: [], written: [], notWritten: [], error: null };
  for (let i = 0; i < batches.length; i += 1) {
    const batch = batches[i] as V[];
    let failure: string | null = null;
    try {
      const { data, error } = await run(batch);
      if (error) failure = error.message;
      else if (data) for (const row of data) result.rows.push(row);
    } catch (err) {
      failure = rawErrorText(err);
    }
    if (failure === null) {
      for (const v of batch) result.written.push(v);
      continue;
    }
    if (result.error === null) result.error = failure;
    for (const v of batch) result.notWritten.push(v);
    if (stopOnError) {
      for (const rest of batches.slice(i + 1)) for (const v of rest) result.notWritten.push(v);
      break;
    }
  }
  return result;
}

/** The raw text behind an error, for server logs: a ServiceError's
 *  `internalDetail` (the PostgREST text its public message hides), else the
 *  Error's message, else the value itself. */
export function rawErrorText(err: unknown): string {
  if (err instanceof ServiceError && err.internalDetail) return err.internalDetail;
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Adapt a throwing batched read to the `{ data, error }` shape that
 *  `Promise.all` / settle call sites already consume. */
export async function settleAsDataError<Row>(p: Promise<Row[]>): Promise<PageResult<Row>> {
  try {
    return { data: await p, error: null };
  } catch (err) {
    return { data: null, error: { message: rawErrorText(err) } };
  }
}

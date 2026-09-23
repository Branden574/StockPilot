/**
 * Batching for PostgREST `.in(column, values)` filters.
 *
 * supabase-js puts every `.in()` value into the request URL. Two limits bite
 * on the length of that URL, and both are about CHARACTERS, not a count:
 *
 *   - Production: PostgREST echoes the whole request path back in its
 *     `Content-Location` response header, and Node's fetch (undici) refuses a
 *     response header block over 16 KB (UND_ERR_HEADERS_OVERFLOW). supabase-js
 *     reports that as a bare "TypeError: fetch failed". A read-only probe on
 *     2026-09-22 answered at 300 uuids and failed at 400.
 *   - Local (developers, CI, the lab): the Kong gateway answers 414 "URI too
 *     long" past about 8 KB of request line, about 215 uuids.
 *
 * A uuid costs about 39 characters once its `,` separator is encoded as `%2C`,
 * but a 128-character serial number or a long variant key costs far more, so a
 * batch is bounded by BOTH a value count and an encoded-character budget.
 *
 * No `server-only` import: the PO form batches its own API calls with the
 * same constant.
 */

/** Values per `.in()` batch. 100 is the size already proven on the hot paths
 *  (inventory list, storefront reservations, rack holdings, the cycle-count
 *  PDF), so converting a site to this module keeps its request count. */
export const IN_FILTER_MAX_VALUES = 100;

/** Encoded characters per `.in()` batch. 100 uuids encode to 3,914. The
 *  widest select used on an id-list read (`list()`) encodes to 456, so 4,000
 *  leaves more than 3.5 KB of the 8 KB local limit for the path, the select,
 *  other filters and order/range, and is about a quarter of production's. */
export const IN_FILTER_MAX_ENCODED_CHARS = 4_000;

/** Batches in flight at once. Keeps today's hot paths in one wave (500
 *  storefront ids = 5 batches), matches a browser's per-origin connection cap,
 *  and stops an unbounded list from firing 100+ requests at PostgREST. */
export const IN_FILTER_DEFAULT_CONCURRENCY = 6;

/** The characters `%2C` adds between two values. */
const SEPARATOR_CHARS = 3;

/** postgrest-js wraps a string value in double quotes when it contains one of
 *  these (`PostgrestReservedCharsRegexp`, postgrest-js index.mjs). */
const RESERVED = /[,()]/;

/**
 * Encoded length postgrest-js adds to the URL for ONE value, without the
 * separator. Mirrors its `in()`: quote the value when it contains `,`, `(` or
 * `)`, then serialize with URLSearchParams (`url.searchParams.append`), which is
 * what percent-encodes it.
 */
export function encodedInValueLength(value: string | number): number {
  const raw = typeof value === 'string' && RESERVED.test(value) ? `"${value}"` : String(value);
  // `=` is the only character URLSearchParams adds for an empty key.
  return new URLSearchParams([['', raw]]).toString().length - 1;
}

/**
 * Split `values` into batches for `.in()`.
 *
 * Drops null and undefined, dedupes keeping first-seen order (postgrest-js
 * dedupes too, so a duplicate would only waste budget), then packs greedily so
 * each batch holds at most `maxValues` values AND the sum of
 * `encodedInValueLength(v) + 3` stays within `maxEncodedChars`. A single value
 * longer than the whole budget goes in a batch of its own: it is never split
 * and never dropped, so the caller still gets an honest answer or an honest
 * error for it. Returns [] for an empty list.
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
 * After the first rejection no new item starts, but the calls already in
 * flight are awaited (so none of them becomes an unhandled rejection), and then
 * the FIRST error is rethrown. A caller that needs every batch to succeed gets
 * one failure, not a half-filled answer.
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

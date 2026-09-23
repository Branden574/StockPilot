/**
 * A fetch wrapper for Supabase clients that stops a PostgREST request whose
 * URL is too long to succeed.
 *
 * WHY. PostgREST echoes the request path in its `Content-Location` response
 * header, and Node's fetch (undici) refuses a response header block over
 * 16,384 bytes. supabase-js reports that as a bare "TypeError: fetch failed",
 * and postgrest-js first RETRIES the failed GET three times, sleeping 1 s, 2 s
 * and 4 s: about 7 s added to the page before it fails. Supabase's own edge
 * logs still show 200 for these requests, so nothing there reveals them. A
 * 414 response is not retried, so answering 414 up front turns a 7 s stall
 * into an immediate, named error. Locally the Kong gateway already answers 414
 * past about 8 KB, which is why the lab never showed the stall.
 *
 * The fix for a long id list is `fetchAllRowsByIds` / `writeInIdBatches`
 * (server/services/lib/fetch-by-ids.ts); this guard is the net under them.
 *
 * Isomorphic on purpose (no `server-only`): the browser client uses it too.
 * It never throws, because postgrest-js would retry a thrown fetch, and it
 * never logs query values (an `ilike` term is user input): only the table
 * path, the length and the parameter names.
 */

import { reportError } from '@/lib/error-reporter';

/** Warn above this many characters of path plus query string. */
export const URL_WARN_CHARS = 6_000;
/** Development, tests and the lab: refuse above this, matching the local
 *  gateway's own ~8 KB limit, so a long list fails the same way everywhere. */
export const URL_BLOCK_CHARS_DEV = 8_000;
/** Production: refuse above this. The measured production failure is about
 *  395 uuids, about 15.4 KB of path with a short select, and undici's 16 KB
 *  limit covers the WHOLE response header block (Content-Location plus every
 *  other header), so the block sits below the failure point rather than at
 *  16,384, leaving room for the other headers. */
export const URL_BLOCK_CHARS_PROD = 14_500;

const REST_PATH = '/rest/v1/';

/** Report each (method, table, length bucket) once per process so a hot page
 *  cannot flood the error channel. Bounded so it cannot grow forever. */
const reported = new Set<string>();
const REPORTED_MAX = 500;

function firstTime(key: string): boolean {
  if (reported.has(key)) return false;
  if (reported.size >= REPORTED_MAX) reported.clear();
  reported.add(key);
  return true;
}

/** Test hook: forget which keys were reported. */
export function resetUrlLengthGuardForTests(): void {
  reported.clear();
}

function isProduction(): boolean {
  return typeof process !== 'undefined' && process.env.NODE_ENV === 'production';
}

function describeRequest(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): { url: URL; method: string } | null {
  try {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw);
    const method = (
      init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')
    ).toUpperCase();
    return { url, method };
  } catch {
    return null;
  }
}

function tooLongResponse(table: string, length: number, limit: number): Response {
  const message =
    `Request URL for ${table} is ${length} characters, over the ${limit}-character limit. ` +
    'Route this id list through fetchAllRowsByIds or writeInIdBatches.';
  return new Response(
    JSON.stringify({
      code: 'URL_TOO_LONG',
      message,
      details: null,
      hint: 'Batch the .in() values (server/services/lib/fetch-by-ids.ts).',
    }),
    { status: 414, headers: { 'content-type': 'application/json' } },
  );
}

/**
 * Drop-in `fetch` for `createClient(..., { global: { fetch } })`. Only looks
 * at PostgREST requests (a path containing `/rest/v1/`); everything else
 * passes straight through.
 */
export function guardedSupabaseFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  let blocked: Response | null = null;
  try {
    const req = describeRequest(input, init);
    if (req && req.url.pathname.includes(REST_PATH)) {
      const { url, method } = req;
      // What Content-Location echoes: the path plus the query string.
      const length = url.pathname.length + url.search.length;
      if (length > URL_WARN_CHARS) {
        const table = url.pathname;
        const key = `${method} ${table} ${Math.floor(length / 1000)}`;
        if (isProduction()) {
          const block = length > URL_BLOCK_CHARS_PROD;
          if (firstTime(key)) {
            const params = [...new Set(url.searchParams.keys())].join(',');
            void reportError(new Error('Supabase request URL near the limit'), {
              tag: 'supabase.url_length',
              level: block ? 'error' : 'warning',
              extra: { method, table, length, params, blocked: block },
            });
          }
          if (block) blocked = tooLongResponse(table, length, URL_BLOCK_CHARS_PROD);
        } else if (length > URL_BLOCK_CHARS_DEV) {
          if (firstTime(key)) {
            console.warn(
              `[supabase.url_length] refused ${method} ${table}: ${length} characters ` +
                `(limit ${URL_BLOCK_CHARS_DEV}). Batch the id list with fetchAllRowsByIds.`,
            );
          }
          blocked = tooLongResponse(table, length, URL_BLOCK_CHARS_DEV);
        } else if (firstTime(key)) {
          console.warn(
            `[supabase.url_length] ${method} ${table} is ${length} characters, near the ` +
              `${URL_BLOCK_CHARS_DEV}-character local limit. Batch the id list with fetchAllRowsByIds.`,
          );
        }
      }
    }
  } catch {
    // Measuring must never break a request; fall through to the real fetch.
    blocked = null;
  }
  if (blocked) return Promise.resolve(blocked);
  return fetch(input, init);
}

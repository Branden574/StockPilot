import { createClient } from '@supabase/supabase-js';

/**
 * PostgREST answers a reader must refuse, shared by every reader's tests
 * (docket S19 and S27), so each test drives the same shapes and the shapes
 * are the library's, not a guess.
 *
 * postgrest-js (2.116.0, the version the app runs) resolves an empty body
 * with `data: null` and `error: null`: a 2xx keeps its status, and a 404 with
 * an empty body is rewritten to 204. A reader that writes `data ?? []` reads
 * either one as "no rows": no overrides, no members, no mapping. A JSON object
 * where a list belongs is the third shape. Each is a failed read like any
 * other. (A 404 carrying `[]` arrives as an ordinary empty list with status
 * 200, which no check can tell from "no rows".)
 */
export const NOT_A_LIST = [
  ['an empty 2xx body', { data: null, error: null, status: 200 }],
  ['an empty 404 body (status rewritten to 204)', { data: null, error: null, status: 204 }],
  ['a JSON object', { data: { id: 'not-a-list' }, error: null, status: 200 }],
] as const;

/** A JSON response, as PostgREST sends one. */
export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** One request the real client made: its method and URL. */
export interface ClientRequest {
  method: string;
  url: URL;
  /** The request body as sent (a JSON string for writes), or null. */
  body: string | null;
}

/**
 * A real supabase-js client (its own postgrest-js) whose fetch is local:
 * `answer` sees every request and returns the response, so no request leaves
 * the test. Use it to show what the library itself makes of an answer.
 */
export function realSupabaseClient(
  answer: (request: ClientRequest) => Response | Promise<Response>,
) {
  return createClient('https://supabase.example.test', 'test-anon-key', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const method = (
          init?.method ?? (input instanceof Request ? input.method : 'GET')
        ).toUpperCase();
        const body = typeof init?.body === 'string' ? init.body : null;
        return answer({ method, url, body });
      },
    },
  });
}

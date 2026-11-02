import 'server-only';

/**
 * The one list check for a read whose answer decides something: who is told,
 * what a digest shows, whether a document is posted (docket S27).
 *
 * postgrest-js resolves an empty body with `data: null` and `error: null`: a
 * 2xx keeps its status, and a 404 with an empty body is rewritten to 204. A
 * reader that writes `data ?? []` reads either one as "no rows": no overrides
 * (a revoke the organization made stops applying), no members, no mapping.
 * Only a list is an answer.
 *
 * `listRows` checks the list only. It does not look at `res.error`: each
 * reader keeps its own error branch, and its report, ahead of it. A paginated
 * read asks `fetchAllRows` for the same check with `requireList`.
 */

/**
 * A read that answered with no error and no list. The message names the table
 * and the status, never the answer itself, so it is safe to log, to report and
 * to store (S16), and it is searchable: "answered no list".
 */
export class ListReadError extends Error {
  constructor(
    public readonly table: string,
    /** The HTTP status postgrest-js answered with, or null when it gave none. */
    public readonly status: number | null,
  ) {
    super(`${table} answered no list (status ${status ?? 'none'})`);
    this.name = 'ListReadError';
  }
}

/** The rows of `res` when its `data` is a list; otherwise throws a ListReadError. */
export function listRows<Row>(
  table: string,
  res: { data?: unknown; status?: number | null },
): Row[] {
  if (Array.isArray(res.data)) return res.data as Row[];
  throw new ListReadError(table, typeof res.status === 'number' ? res.status : null);
}

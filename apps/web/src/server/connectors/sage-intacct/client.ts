import 'server-only';

import type { ConnectorSecrets } from '@stockpilot/core';

/** Single API host — Intacct sandboxes are separate COMPANIES, not hosts. */
const BASE_URL = 'https://api.intacct.com/ia/api/v1';

/**
 * How long the connector's Intacct calls may take before they are stopped
 * (docket B81). A call that got no answer used to hold the drain-outbox cron
 * until the platform ended it, and a run ended mid-create left the export
 * pending for a blind re-send. The import builds its client without one: its
 * pages are up to 2,000 records.
 */
export const INTACCT_REQUEST_TIMEOUT_MS = 15_000;

/**
 * The sentence an Intacct create that may have arrived stops with (docket
 * B81). Intacct REST v1 has no requestid, so StockPilot cannot send such a
 * create again without risking a second document: an admin checks Intacct
 * before Replay. It goes first in every message that carries it, because
 * Failed exports shows one line of the error on the web and two on the phone.
 */
export const INTACCT_MAY_HAVE_POSTED =
  'This export may have reached Sage Intacct. Check Intacct for it before you press Replay, or it may be posted twice.';

/**
 * A failed request's cause codes that mean no request byte left StockPilot:
 * the host lookup failed, or the connect did (refused, or timed out before
 * the connection opened). Loopback probe, Node 22 and undici 6, 2026-11-01.
 */
const INTACCT_NEVER_SENT_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/**
 * Whether `cause` (a failed fetch's cause) shows the request was never sent.
 * An AggregateError (node's connect to a host with several addresses) is
 * checked first, because it carries its first inner error's code itself:
 * only when every inner error failed before sending. Otherwise a code above,
 * or a failed `connect` syscall: a connect that failed wrote no request byte,
 * while a reset after the request was written carries syscall 'read'. Any
 * other shape, a timeout included, may have reached Intacct.
 */
function failedBeforeSending(cause: unknown): boolean {
  if (cause instanceof AggregateError) {
    return cause.errors.length > 0 && cause.errors.every((inner) => failedBeforeSending(inner));
  }
  if (!cause || typeof cause !== 'object') return false;
  const { code, syscall } = cause as { code?: unknown; syscall?: unknown };
  return (typeof code === 'string' && INTACCT_NEVER_SENT_CODES.has(code)) || syscall === 'connect';
}

/** fetch rejects with TypeError('fetch failed', { cause }) when no HTTP answer came. */
function neverSent(err: unknown): boolean {
  return err instanceof TypeError && failedBeforeSending(err.cause);
}

/** What failed, for the message: the cause's code, else its name, else the error's. */
function failureName(err: unknown): string {
  const cause = err instanceof Error ? (err.cause as { code?: unknown; name?: unknown }) : null;
  if (cause && typeof cause.code === 'string') return cause.code;
  if (cause && typeof cause.name === 'string') return cause.name;
  return err instanceof Error ? err.name : 'unknown';
}

/**
 * Error thrown by IntacctClient on a non-OK response. Carries `status` so the
 * connector can decide retryability (401/429/5xx). The message includes the
 * status + a body snippet but NEVER the Bearer token. `mayHavePosted` marks a
 * create answered with a 5xx other than 503: Intacct may have committed it
 * before the error, so its message starts with INTACCT_MAY_HAVE_POSTED.
 */
export class IntacctApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly mayHavePosted = false,
  ) {
    super(message);
    this.name = 'IntacctApiError';
  }
}

/**
 * No Intacct HTTP answer to judge: fetch threw (a failed lookup or connect, a
 * dropped connection, the timeout), or a 2xx body could not be read (docket
 * B81). `retryable` says whether the call may be made again: a read always
 * may; a create only when it provably never left StockPilot. A create that may
 * have arrived carries INTACCT_MAY_HAVE_POSTED first. Keeps fetch's error as
 * its cause; the message never carries the Bearer token.
 */
export class IntacctNoAnswerError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
    cause: unknown,
  ) {
    super(message, { cause });
    this.name = 'IntacctNoAnswerError';
  }
}

/** One page of Intacct query-service results. */
export interface IntacctQueryPage {
  records: Record<string, unknown>[];
  /** Cursor for the next page (`start`), or null when exhausted. */
  nextStart: number | null;
}

/**
 * Thin fetch wrapper for the Sage Intacct REST API v1.
 *
 * - `Authorization: Bearer <accessToken>` injected from `secrets`.
 * - JSON in/out. Object writes go through POST /objects/<path> (lines are
 *   owned objects — always written through the header document, never
 *   directly).
 * - Reads use the query service (POST /services/core/query) which hard-caps
 *   4,000 records per response; `queryPage` exposes start/next pagination.
 * - Concurrency stays effectively serial here (one call at a time per drain /
 *   pull run) — Intacct Tier 1 allows only 6 concurrent requests per app.
 *
 * Token REFRESH is handled by the drainer / pull-runner (via
 * `connector.refreshAuth`) — this client only carries the current access token
 * and surfaces a 401 (retryable) so the next run refreshes.
 *
 * ⚠ PENDING SANDBOX VERIFICATION: endpoint paths/body field names follow the
 * published REST v1 reference; verify against the sandbox company once the
 * developer license exists.
 *
 * SECRET INVARIANT: the access token is only ever set as the Bearer header and
 * is never logged or placed in a thrown error.
 */
export class IntacctClient {
  constructor(
    private readonly secrets: ConnectorSecrets,
    /** `requestTimeoutMs`: stop each call after this long (the connector's
     *  INTACCT_REQUEST_TIMEOUT_MS). Absent: no timeout (the import). */
    private readonly opts: { requestTimeoutMs?: number } = {},
  ) {}

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.secrets.accessToken}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };
  }

  private static async errorDetail(res: Response): Promise<string> {
    try {
      return (await res.text()).slice(0, 500);
    } catch {
      return '';
    }
  }

  /**
   * One call. `kind` says whether repeating it is safe: a 'read' always is
   * (the vendor lookup is a POST to the query service, so the HTTP method
   * cannot decide it); a 'create' is not, unless it provably never left.
   */
  private async request(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    kind: 'read' | 'create',
  ): Promise<Record<string, unknown>> {
    const clean = path.startsWith('/') ? path : `/${path}`;
    const { requestTimeoutMs } = this.opts;
    let res: Response;
    try {
      res = await fetch(`${BASE_URL}${clean}`, {
        method,
        headers: this.headers(),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        ...(requestTimeoutMs !== undefined
          ? { signal: AbortSignal.timeout(requestTimeoutMs) }
          : {}),
      });
    } catch (err) {
      const what = `Intacct ${method} ${clean} got no answer (${failureName(err)})`;
      if (kind === 'read' || neverSent(err)) throw new IntacctNoAnswerError(what, true, err);
      throw new IntacctNoAnswerError(`${INTACCT_MAY_HAVE_POSTED} ${what}`, false, err);
    }
    if (!res.ok) {
      const detail = await IntacctClient.errorDetail(res);
      const message = `Intacct ${method} ${clean} failed (status ${res.status}): ${detail}`;
      // A 503 says the service did not take the request; any other 5xx can
      // follow a create Intacct committed (docket B81).
      const mayHavePosted = kind === 'create' && res.status >= 500 && res.status !== 503;
      throw new IntacctApiError(
        mayHavePosted ? `${INTACCT_MAY_HAVE_POSTED} ${message}` : message,
        res.status,
        mayHavePosted,
      );
    }
    try {
      return (await res.json()) as Record<string, unknown>;
    } catch (err) {
      // The answer was a 2xx: a create happened, whatever its body says.
      const what = `Intacct ${method} ${clean} answered ${res.status} with a body that could not be read (${failureName(err)})`;
      if (kind === 'read') throw new IntacctNoAnswerError(what, true, err);
      throw new IntacctNoAnswerError(`${INTACCT_MAY_HAVE_POSTED} ${what}`, false, err);
    }
  }

  /** POST a create against an object path (e.g. `/objects/purchasing/document`). */
  async post(path: string, body: unknown): Promise<Record<string, unknown>> {
    return this.request('POST', path, body, 'create');
  }

  /** GET a single resource. */
  async get(path: string): Promise<Record<string, unknown>> {
    return this.request('GET', path, undefined, 'read');
  }

  /**
   * Run one page of the query service. `object` is the REST object path
   * (e.g. 'inventory-control/item'), `fields` the selected field keys.
   * Intacct caps size at 4,000; we default lower to keep payloads modest.
   */
  async queryPage(opts: {
    object: string;
    fields: string[];
    filters?: unknown[];
    start?: number;
    size?: number;
  }): Promise<IntacctQueryPage> {
    const size = Math.min(opts.size ?? 1000, 4000);
    const body: Record<string, unknown> = {
      object: opts.object,
      fields: opts.fields,
      size,
      ...(opts.start ? { start: opts.start } : {}),
      ...(opts.filters && opts.filters.length > 0 ? { filters: opts.filters } : {}),
    };
    const res = await this.request('POST', '/services/core/query', body, 'read');

    // Documented envelope: `ia::result` holds the records; pagination metadata
    // sits alongside (totalCount / start / numRemaining naming per docs).
    // Tolerate both bare-array and enveloped shapes defensively.
    const result = (res['ia::result'] ?? res.result ?? res.records ?? []) as unknown;
    const records = Array.isArray(result) ? (result as Record<string, unknown>[]) : [];

    const meta = (res['ia::meta'] ?? res.meta ?? {}) as Record<string, unknown>;
    const numRemaining = Number(meta.numRemaining ?? 0) || 0;
    const start = Number(meta.start ?? opts.start ?? 1) || 1;
    // GUARD: when records parse empty, nextStart would equal start and any
    // `while (start !== null)` caller would re-issue the identical request
    // forever (an envelope-shape drift, e.g. meta parses but records don't, is
    // exactly the pre-sandbox failure mode). An empty page ALWAYS terminates.
    const nextStart = numRemaining > 0 && records.length > 0 ? start + records.length : null;

    return { records, nextStart };
  }
}

import 'server-only';

import type { ConnectorSecrets } from '@stockpilot/core';

/** Single API host — Intacct sandboxes are separate COMPANIES, not hosts. */
const BASE_URL = 'https://api.intacct.com/ia/api/v1';

/**
 * Error thrown by IntacctClient on a non-OK response. Carries `status` so the
 * connector can decide retryability (401/429/5xx). The message includes the
 * status + a body snippet but NEVER the Bearer token.
 */
export class IntacctApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'IntacctApiError';
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
  constructor(private readonly secrets: ConnectorSecrets) {}

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

  private async request(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<Record<string, unknown>> {
    const clean = path.startsWith('/') ? path : `/${path}`;
    const res = await fetch(`${BASE_URL}${clean}`, {
      method,
      headers: this.headers(),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      const detail = await IntacctClient.errorDetail(res);
      throw new IntacctApiError(
        `Intacct ${method} ${clean} failed (status ${res.status}): ${detail}`,
        res.status,
      );
    }
    return (await res.json()) as Record<string, unknown>;
  }

  /** POST a create against an object path (e.g. `/objects/purchasing/document`). */
  async post(path: string, body: unknown): Promise<Record<string, unknown>> {
    return this.request('POST', path, body);
  }

  /** GET a single resource. */
  async get(path: string): Promise<Record<string, unknown>> {
    return this.request('GET', path);
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
    const res = await this.request('POST', '/services/core/query', body);

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

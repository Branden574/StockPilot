import 'server-only';

import type { ConnectorSecrets } from '@stockpilot/core';

/** Intuit Accounting API minor version pinned across all calls. */
const MINOR_VERSION = '75';

const BASE_URLS = {
  sandbox: 'https://sandbox-quickbooks.api.intuit.com',
  production: 'https://quickbooks.api.intuit.com',
} as const;

export type QboEnv = keyof typeof BASE_URLS;

/**
 * Error thrown by QboClient on a non-OK response. Carries `status` so the
 * connector can decide retryability (401/429/5xx) and `intuitTid` for support
 * correlation. The message includes the status + intuit_tid but NEVER the
 * Bearer token.
 */
export class QboApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly intuitTid: string | null,
  ) {
    super(message);
    this.name = 'QboApiError';
  }
}

/**
 * Thin fetch wrapper for the QuickBooks Online Accounting API. One-way export
 * only: the connector uses this to CREATE entities (Bill, JournalEntry) and to
 * QUERY existing ones (Vendor lookup) — it never pulls QBO data back into
 * StockPilot.
 *
 * - Base URL selected by `env` (sandbox vs production).
 * - `Authorization: Bearer <accessToken>` injected from `secrets`.
 * - `?minorversion=75` pinned on every call.
 * - `Accept`/`Content-Type: application/json`.
 *
 * Token REFRESH is handled by the drainer (it calls `connector.refreshAuth`
 * before dispatch when secrets are near expiry) — this client only carries the
 * current access token and surfaces a 401 (retryable) so the next drain run
 * refreshes. SECRET INVARIANT: the access token is only ever set as the Bearer
 * header and is never logged or placed in a thrown error.
 */
export class QboClient {
  private readonly baseUrl: string;

  constructor(
    private readonly realmId: string,
    private readonly secrets: ConnectorSecrets,
    env: QboEnv,
  ) {
    this.baseUrl = BASE_URLS[env] ?? BASE_URLS.sandbox;
  }

  private companyUrl(path: string, params: Record<string, string>): string {
    const clean = path.startsWith('/') ? path : `/${path}`;
    const url = new URL(`${this.baseUrl}/v3/company/${this.realmId}${clean}`);
    url.searchParams.set('minorversion', MINOR_VERSION);
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
    return url.toString();
  }

  private authHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.secrets.accessToken}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };
  }

  /**
   * Read and discard the response body for an error, returning a short,
   * token-free snippet for the surfaced message. Intuit Fault bodies carry only
   * the request echo + error text, never the access token.
   */
  private static async errorDetail(res: Response): Promise<string> {
    try {
      const text = await res.text();
      return text.slice(0, 500);
    } catch {
      return '';
    }
  }

  /**
   * POST a create. `requestId` is sent as the Intuit `requestid` query param for
   * idempotency — replays of the same id never create a duplicate entity.
   */
  async post(path: string, body: unknown, requestId: string): Promise<Record<string, unknown>> {
    const url = this.companyUrl(path, { requestid: requestId });
    const res = await fetch(url, {
      method: 'POST',
      headers: this.authHeaders(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const tid = res.headers.get('intuit_tid');
      const detail = await QboClient.errorDetail(res);
      throw new QboApiError(
        `QBO POST ${path} failed (status ${res.status}, intuit_tid=${tid ?? 'unknown'}): ${detail}`,
        res.status,
        tid,
      );
    }
    return (await res.json()) as Record<string, unknown>;
  }

  /** Run a QBO SQL-ish query (e.g. `select * from Vendor where ...`). */
  async query(selectStmt: string): Promise<Record<string, unknown>> {
    const url = this.companyUrl('/query', { query: selectStmt });
    const res = await fetch(url, {
      method: 'GET',
      headers: this.authHeaders(),
    });
    if (!res.ok) {
      const tid = res.headers.get('intuit_tid');
      const detail = await QboClient.errorDetail(res);
      throw new QboApiError(
        `QBO query failed (status ${res.status}, intuit_tid=${tid ?? 'unknown'}): ${detail}`,
        res.status,
        tid,
      );
    }
    return (await res.json()) as Record<string, unknown>;
  }
}

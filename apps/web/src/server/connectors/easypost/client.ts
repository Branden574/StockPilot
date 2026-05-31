import 'server-only';

/** EasyPost REST API v2 base. */
const BASE_URL = 'https://api.easypost.com/v2';

/**
 * Error thrown by EasyPostClient on a non-OK response. Carries `status` so the
 * service can decide retryability (401 = bad key, 422 = bad request, 5xx =
 * transient). SECRET INVARIANT: the message NEVER contains the API key — only
 * the status + a short, key-free body snippet.
 */
export class EasyPostApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'EasyPostApiError';
  }
}

/**
 * Thin fetch wrapper for the EasyPost Shipping API (v2). One-way: we PUSH label
 * requests (create + buy a Shipment) and later receive tracking via the webhook
 * — we never pull EasyPost data back into StockPilot inventory.
 *
 * Auth is HTTP Basic with the API key as the username and an empty password:
 * `Authorization: Basic base64(apiKey + ':')`. The key is only ever set in that
 * header and is NEVER logged or placed in a thrown error.
 */
export class EasyPostClient {
  private readonly authHeader: string;

  constructor(apiKey: string) {
    // Basic auth: username = apiKey, password = empty. Buffer is the canonical
    // base64 encoder in the Node runtime these server entrypoints run on.
    this.authHeader = `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      Authorization: this.authHeader,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...extra,
    };
  }

  /**
   * Read and discard the response body for an error, returning a short snippet
   * for the surfaced message. EasyPost error bodies carry only the error
   * code/message, never the API key.
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
   * Cheap authenticated GET used to validate an API key at connect time. The
   * `/api_keys` endpoint requires a valid key and returns 401 for a bad one, so
   * a 2xx confirms the key works without creating any billable object.
   */
  async validateKey(): Promise<void> {
    const res = await fetch(`${BASE_URL}/api_keys`, {
      method: 'GET',
      headers: this.headers(),
    });
    if (!res.ok) {
      const detail = await EasyPostClient.errorDetail(res);
      throw new EasyPostApiError(
        `EasyPost key validation failed (status ${res.status}): ${detail}`,
        res.status,
      );
    }
  }

  /**
   * Create a Shipment (rate-shop). `body` is the EasyPost Shipment create
   * payload: `{ shipment: { to_address, from_address, parcel } }`. Returns the
   * parsed Shipment object (carries `id` + `rates[]`).
   */
  async createShipment(body: unknown): Promise<Record<string, unknown>> {
    const res = await fetch(`${BASE_URL}/shipments`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await EasyPostClient.errorDetail(res);
      throw new EasyPostApiError(
        `EasyPost createShipment failed (status ${res.status}): ${detail}`,
        res.status,
      );
    }
    return (await res.json()) as Record<string, unknown>;
  }

  /**
   * Buy the selected rate on an existing Shipment, generating a postage label.
   * Returns the updated Shipment object (carries `postage_label`,
   * `tracking_code`, `selected_rate`).
   *
   * IDEMPOTENCY: pass a stable `idempotencyKey` (the caller uses our
   * carrier_shipments row id) so a retried buy on the SAME shipment after a
   * network timeout/5xx — where EasyPost may have already completed the purchase
   * server-side — does NOT double-charge. EasyPost dedupes a retry that carries
   * the same `Idempotency-Key` and replays the original response instead of
   * buying again. Omit it (legacy callers) and the buy is non-idempotent.
   */
  async buyShipment(
    shipmentId: string,
    rateId: string,
    idempotencyKey?: string,
  ): Promise<Record<string, unknown>> {
    const res = await fetch(`${BASE_URL}/shipments/${encodeURIComponent(shipmentId)}/buy`, {
      method: 'POST',
      headers: this.headers(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined),
      body: JSON.stringify({ rate: { id: rateId } }),
    });
    if (!res.ok) {
      const detail = await EasyPostClient.errorDetail(res);
      throw new EasyPostApiError(
        `EasyPost buyShipment failed (status ${res.status}): ${detail}`,
        res.status,
      );
    }
    return (await res.json()) as Record<string, unknown>;
  }

  /**
   * Retrieve a Shipment by id (GET, non-billable). Used to RECONCILE an
   * ambiguous buy after a timeout/5xx: if the returned shipment already carries
   * a `postage_label`, the purchase actually completed at EasyPost and the
   * caller can finalize the local row instead of re-buying (which would risk a
   * double charge). Returns the parsed Shipment object.
   */
  async retrieveShipment(shipmentId: string): Promise<Record<string, unknown>> {
    const res = await fetch(`${BASE_URL}/shipments/${encodeURIComponent(shipmentId)}`, {
      method: 'GET',
      headers: this.headers(),
    });
    if (!res.ok) {
      const detail = await EasyPostClient.errorDetail(res);
      throw new EasyPostApiError(
        `EasyPost retrieveShipment failed (status ${res.status}): ${detail}`,
        res.status,
      );
    }
    return (await res.json()) as Record<string, unknown>;
  }
}

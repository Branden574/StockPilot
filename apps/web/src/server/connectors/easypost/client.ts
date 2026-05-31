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

  private headers(): Record<string, string> {
    return {
      Authorization: this.authHeader,
      Accept: 'application/json',
      'Content-Type': 'application/json',
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
   */
  async buyShipment(shipmentId: string, rateId: string): Promise<Record<string, unknown>> {
    const res = await fetch(`${BASE_URL}/shipments/${encodeURIComponent(shipmentId)}/buy`, {
      method: 'POST',
      headers: this.headers(),
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
}

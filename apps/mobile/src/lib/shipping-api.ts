import { api } from './api';

/**
 * Typed wrapper over the mobile `api()` client for read-only carrier shipping.
 *
 * Mobile is READ-ONLY: there is no rates/label/buy surface here by design (the
 * web `ShippingService` owns every billable EasyPost call gated by
 * `shipping:manage`). This wrapper only fetches the current shipment so the
 * order screen can show tracking.
 *
 * SECRET INVARIANT: the GET shape never includes the EasyPost API key, the
 * webhook secret, or any Vault handle — only carrier/tracking/status/url fields.
 */

export type CarrierShipmentStatus =
  | 'draft'
  | 'purchased'
  | 'in_transit'
  | 'delivered'
  | 'returned'
  | 'failure'
  | 'cancelled';

/** A `carrier_shipments` row as the web GET endpoint hands it back. */
export interface OrderShipment {
  id: string;
  carrier: string | null;
  service: string | null;
  tracking_code: string | null;
  tracking_status: string | null;
  tracking_url: string | null;
  label_url: string | null;
  status: CarrierShipmentStatus;
}

interface ShipmentResponse {
  shipment: OrderShipment | null;
}

/**
 * GET /api/v1/orders/<id>/shipping — the most-recent carrier shipment for an
 * order, or null when none exists. The read is member-level + module-gated on
 * the server.
 *
 * Soft-gate: any failure (403 module-off / lacking access, 404, network) is
 * swallowed and surfaced as `null` so the caller can hide the shipping section
 * silently rather than rendering an error on a screen where shipping may simply
 * be disabled for the org.
 */
export async function getOrderShipment(
  orderId: string,
  signal?: AbortSignal,
): Promise<OrderShipment | null> {
  try {
    const { shipment } = await api<ShipmentResponse>(
      `/api/v1/orders/${orderId}/shipping`,
      { signal },
    );
    return shipment ?? null;
  } catch {
    return null;
  }
}

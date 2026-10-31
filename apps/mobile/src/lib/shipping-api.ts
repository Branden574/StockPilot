import { api } from './api';
import { readPersistedEnabledModules } from './enabled-modules';

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
 * Whether the order screen asks for the shipment, given the organization's
 * enabled modules as the last sync saved them (null before the first sync).
 *
 * The read is module-gated on the server, so an organization without Shipping
 * answered every order view with a 403 (docket B10): it is not asked. Before
 * the first sync says which modules are on, it is asked as before, and the
 * server stays the gate either way. Shipping is off by default for every pack
 * (core MODULE_REGISTRY), so the app's default module set cannot stand in for
 * an unknown one here.
 */
export function shipmentReadWanted(modules: ReadonlySet<string> | null): boolean {
  return modules === null || modules.has('shipping');
}

/**
 * GET /api/v1/orders/<id>/shipping — the most-recent carrier shipment for an
 * order, or null when none exists. The read is member-level + module-gated on
 * the server, and is not sent at all for an organization whose Shipping module
 * is off (shipmentReadWanted).
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
  // A module set that cannot be read is treated as not known yet: tracking is
  // asked for rather than hidden on a storage fault.
  const modules = await readPersistedEnabledModules().catch(() => null);
  if (!shipmentReadWanted(modules)) return null;
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

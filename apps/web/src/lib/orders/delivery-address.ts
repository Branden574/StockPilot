/**
 * Shared validation for the delivery-address requirement on orders.
 *
 * Both the public POST route (`/api/v1/public/order-requests`) and
 * the internal create flow (`/dashboard/orders/new` server action +
 * `OrderRequestsService.create`) gate "delivery fulfillment requires
 * a real address" — keeping the rule in one module so client-side and
 * server-side checks can never silently drift.
 *
 * The shape mirrors the `delivery_address` jsonb column on
 * `order_requests` (migration 0109). All optional fields are
 * `string | null | undefined` so the same helper handles the form
 * (sends `null`) and the action (sends `undefined`) without coercion.
 */

export interface DeliveryAddressInput {
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  region?: string | null;
  postal?: string | null;
  instructions?: string | null;
}

/**
 * Returns true when the address has the minimum information we need
 * for a delivery: a non-empty street line + city. Other fields stay
 * optional so we don't reject international or PO-box-style entries.
 */
export function isDeliveryAddressComplete(
  addr: DeliveryAddressInput | null | undefined,
): boolean {
  if (!addr) return false;
  return Boolean(addr.line1 && addr.line1.trim() && addr.city && addr.city.trim());
}

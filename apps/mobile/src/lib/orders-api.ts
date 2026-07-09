import { api } from './api';

/**
 * Typed wrapper over the mobile `api()` client for ADVANCING an order through
 * the fulfillment pipeline — the mobile parity for the web ManagerActionsPanel.
 *
 * Every action POSTs to /api/v1/orders/<id>/transition, which dispatches to the
 * OrderRequestsService method. Each method self-gates module + permission +
 * status server-side, so a member without the right role gets a 403 (no client
 * trust). The screen just shows the contextual buttons and reloads after.
 */

export interface OrderDriver {
  id: string;
  name: string;
  email: string;
}

export type OrderAction =
  | { action: 'approve'; internalNotes?: string }
  | { action: 'deny'; reason: string }
  | { action: 'generate_pick_slip' }
  | { action: 'complete_picking' }
  | { action: 'generate_packing_slips' }
  | { action: 'stage'; target: 'staged_for_pickup' | 'staged_for_delivery' }
  | { action: 'assign_delivery'; deliveryUserId: string }
  | { action: 'mark_in_transit' }
  | { action: 'cancel'; reason?: string };

/** Advance an order. Throws (with the server's message) on a non-2xx. */
export async function transitionOrder(orderId: string, body: OrderAction): Promise<void> {
  await api(`/api/v1/orders/${orderId}/transition`, { method: 'POST', body });
}

/** Candidate drivers for the assign-delivery step. Requires orders:assign_delivery. */
export async function listOrderDrivers(orderId: string): Promise<OrderDriver[]> {
  const { drivers } = await api<{ drivers: OrderDriver[] }>(
    `/api/v1/orders/${orderId}/drivers`,
  );
  return drivers;
}

/** One order line as returned by GET /api/v1/orders/<id>, for digital picking. */
export interface OrderDetailLine {
  id: string;
  quantity_requested: number;
  quantity_picked: number | null;
  quantity_fulfilled: number | null;
  notes: string | null;
  item: {
    id: string;
    name: string;
    sku: string | null;
  } | null;
}

export interface OrderDetail {
  order: { id: string; status: string; [k: string]: unknown };
  lines: OrderDetailLine[];
  warehouseName: string | null;
  requesterName: string | null;
  requesterEmail: string | null;
}

/** Fetch an order's header + per-line items so the app can pick line-by-line. */
export async function getOrderDetail(orderId: string): Promise<OrderDetail> {
  return api<OrderDetail>(`/api/v1/orders/${orderId}`);
}

/**
 * Record a per-line picked quantity (native parity for the web DigitalPick card).
 * Does NOT decrement stock — that happens at complete_picking. The server caps
 * qty at the line's requested amount (over_pick → thrown with the server msg).
 */
export async function recordPickedLine(
  orderId: string,
  lineId: string,
  quantity: number,
): Promise<void> {
  await api(`/api/v1/orders/${orderId}/pick-line`, {
    method: 'POST',
    body: { lineId, quantity },
  });
}

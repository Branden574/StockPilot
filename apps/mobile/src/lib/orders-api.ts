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

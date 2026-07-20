import { api } from './api';
import type { CreateReturnBody } from './order-returns';

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
  // Paper signature at hand-over (manager+ or assigned driver): completes the
  // order (or backorders the remainder) recording signature_method='physical'.
  | { action: 'confirm_physical_signature'; signerName: string }
  // Approve a knowingly-short order (manager+): reserve what's available, the
  // rest backorders at hand-over.
  | { action: 'approve_partial' }
  | { action: 'deny'; reason: string }
  | { action: 'generate_pick_slip' }
  // Picking claim/lock (owner decisions, enforced server-side): a staffer must
  // claim before picking; a manager may assign/reassign; the picker or a manager
  // may release. The server returns 409 (already claimed) / 403 (forbidden).
  | { action: 'claim_picking' }
  | { action: 'assign_picking'; pickerUserId: string }
  | { action: 'release_picking' }
  | { action: 'complete_picking' }
  | { action: 'generate_packing_slips' }
  | { action: 'stage'; target: 'staged_for_pickup' | 'staged_for_delivery' }
  | { action: 'assign_delivery'; deliveryUserId: string }
  | { action: 'mark_in_transit' }
  // Backorder exits from `backordered` (manager+): resume the still-owed
  // remainder, or close as delivered-partial keeping what shipped.
  | { action: 'resume_fulfillment' }
  | { action: 'close_partial' }
  | { action: 'cancel'; reason?: string };

/** Advance an order. Throws (with the server's message) on a non-2xx. */
export async function transitionOrder(orderId: string, body: OrderAction): Promise<void> {
  await api(`/api/v1/orders/${orderId}/transition`, { method: 'POST', body });
}

/**
 * Picking claim/lock wrappers (native parity for the web ManagerActionsPanel).
 * Each POSTs the matching transition action; the server self-gates role/status
 * and throws the server message on conflict (409) or forbidden (403).
 */
/** Staff self-claim of an unassigned order in the picking phase. */
export async function claimPicking(orderId: string): Promise<void> {
  await transitionOrder(orderId, { action: 'claim_picking' });
}

/** Release the current claim (self-release by the picker, or a manager override). */
export async function releasePicking(orderId: string): Promise<void> {
  await transitionOrder(orderId, { action: 'release_picking' });
}

/** Manager assign/reassign of the picker to a specific org member. */
export async function assignPicking(orderId: string, pickerUserId: string): Promise<void> {
  await transitionOrder(orderId, { action: 'assign_picking', pickerUserId });
}

/**
 * Staff "Create return" on a completed/delivered order (mobile parity for the
 * web CreateReturnDialog → createReturnFromOrderAction). The server reuses
 * RMAService.createFromOrder verbatim: returns module + returns:manage gates,
 * durable per-line budget, status gate — a 4xx throws with the server message.
 * The created return lands in the web approval queue (no inventory movement
 * until approve → receive → close).
 */
export async function createOrderReturn(
  orderId: string,
  body: CreateReturnBody,
): Promise<{ id: string }> {
  const res = await api<{ ok: true; return: { id: string } }>(
    `/api/v1/orders/${orderId}/returns`,
    { method: 'POST', body },
  );
  return { id: res.return.id };
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
    /** Item-ownership charter — which site this stock is earmarked for.
     *  Populated by OrderRequestsService.get() (charter_name/charter_code). */
    charter_name?: string | null;
    charter_code?: string | null;
  } | null;
}

export interface OrderDetail {
  order: {
    id: string;
    status: string;
    /** The locked-in picker (null when unclaimed). Drives the picker chip. */
    assigned_picker_id: string | null;
    /** When the current picker claimed/was assigned (added in mig 0237). */
    picking_claimed_at?: string | null;
    [k: string]: unknown;
  };
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

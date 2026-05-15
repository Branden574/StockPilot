/**
 * Single source of truth for the order_requests status state machine.
 * The Postgres trigger `_validate_order_request_status_transition`
 * (migration 0109+) mirrors this exactly — any change here MUST be
 * reflected in the next migration's trigger body, or the DB will
 * reject a transition the TS layer accepts (or vice versa).
 */

export type OrderStatus =
  | 'pending_confirmation'
  | 'pending_approval'
  | 'approved'
  | 'pick_slip_generated'
  | 'picking_in_progress'
  | 'picking_complete'
  | 'packing_slip_generated'
  | 'staged_for_pickup'
  | 'staged_for_delivery'
  | 'in_transit'
  | 'signature_requested'
  | 'completed'
  | 'denied'
  | 'cancelled';

export type FulfillmentType = 'pickup' | 'delivery';

/**
 * Legal `from → to` transitions. Terminal states (`completed`,
 * `denied`, `cancelled`) have empty arrays — once entered, no path
 * out. Cancellation is permitted from every non-terminal status.
 */
export const ALLOWED_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  pending_confirmation: ['pending_approval', 'cancelled'],
  pending_approval: ['approved', 'denied', 'cancelled'],
  approved: ['pick_slip_generated', 'cancelled'],
  pick_slip_generated: ['picking_in_progress', 'picking_complete', 'cancelled'],
  picking_in_progress: ['picking_complete', 'cancelled'],
  picking_complete: ['packing_slip_generated', 'cancelled'],
  packing_slip_generated: ['staged_for_pickup', 'staged_for_delivery', 'cancelled'],
  staged_for_pickup: ['signature_requested', 'completed', 'cancelled'],
  staged_for_delivery: ['in_transit', 'cancelled'],
  in_transit: ['signature_requested', 'completed', 'cancelled'],
  signature_requested: ['completed', 'cancelled'],
  denied: [],
  cancelled: [],
  completed: [],
};

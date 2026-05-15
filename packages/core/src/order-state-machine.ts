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

export interface OrderTransitionContext {
  fulfillmentType: FulfillmentType;
  /**
   * Whether `assigned_delivery_user_id` is non-null on the row.
   * Required by the `staged_for_delivery → in_transit` rule.
   */
  hasAssignedDelivery: boolean;
}

export class OrderTransitionError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'illegal_transition'
      | 'no_op'
      | 'fulfillment_type_mismatch'
      | 'assigned_delivery_required',
    public readonly from: OrderStatus,
    public readonly to: OrderStatus,
  ) {
    super(message);
    this.name = 'OrderTransitionError';
  }
}

/**
 * Throws `OrderTransitionError` when the proposed transition is not
 * legal. Returns silently when it is. The action layer wraps this
 * around every status mutation; the DB trigger applies the same
 * rules a second time as defense-in-depth.
 */
export function assertTransition(
  from: OrderStatus,
  to: OrderStatus,
  ctx: OrderTransitionContext,
): void {
  if (from === to) {
    throw new OrderTransitionError(
      `Same-status transition (${from}) — likely a no_op or race.`,
      'no_op',
      from,
      to,
    );
  }
  if (!ALLOWED_TRANSITIONS[from]?.includes(to)) {
    throw new OrderTransitionError(
      `Cannot move order from ${from} to ${to}.`,
      'illegal_transition',
      from,
      to,
    );
  }
  if (to === 'staged_for_delivery' && ctx.fulfillmentType !== 'delivery') {
    throw new OrderTransitionError(
      `staged_for_delivery requires fulfillment_type='delivery' (got '${ctx.fulfillmentType}').`,
      'fulfillment_type_mismatch',
      from,
      to,
    );
  }
  if (to === 'staged_for_pickup' && ctx.fulfillmentType !== 'pickup') {
    throw new OrderTransitionError(
      `staged_for_pickup requires fulfillment_type='pickup' (got '${ctx.fulfillmentType}').`,
      'fulfillment_type_mismatch',
      from,
      to,
    );
  }
  if (to === 'in_transit' && !ctx.hasAssignedDelivery) {
    throw new OrderTransitionError(
      `in_transit requires assigned_delivery_user_id to be set first.`,
      'assigned_delivery_required',
      from,
      to,
    );
  }
}

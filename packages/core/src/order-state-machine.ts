/**
 * Single source of truth for the order_requests status state machine.
 * The Postgres trigger `_validate_order_request_status_transition`
 * (migration 0109+) mirrors this exactly — any change here MUST be
 * reflected in the next migration's trigger body, or the DB will
 * reject a transition the TS layer accepts (or vice versa).
 */

import type { Role } from './constants/roles';

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
  staged_for_pickup: ['completed', 'cancelled'],
  staged_for_delivery: ['in_transit', 'cancelled'],
  in_transit: ['completed', 'cancelled'],
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
 * Asserts that `from → to` is a legal transition and that the
 * fulfillment-type + assigned-delivery preconditions are satisfied.
 *
 * RBAC IS OUT OF SCOPE FOR THIS FUNCTION. The transition guard is
 * a *correctness* check on the order's own state; role-based
 * authorization (who is allowed to drive an order from approved to
 * pick_slip_generated, for example) belongs in the action layer
 * (`apps/web/src/server/actions/orders/*`) via the existing
 * `assertPermission(ctx, 'orders:...')` pattern. Action authors
 * MUST call BOTH:
 *   1. `assertPermission(ctx, ...)` — RBAC gate
 *   2. `assertTransition(from, to, ctx)` — state-machine gate
 *
 * Throws `OrderTransitionError` when the proposed transition is not
 * legal. Returns silently when it is. The Postgres trigger
 * `_validate_order_request_status_transition` mirrors these checks
 * as defense-in-depth.
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

export type OrderAction =
  | 'approve'
  | 'deny'
  | 'cancel'
  | 'generate_pick_slip'
  | 'reassign_picker'
  | 'open_digital_pick'
  | 'print_pick_slip'
  | 'mark_picking_complete'
  | 'generate_packing_slips'
  | 'print_customer_slip'
  | 'print_warehouse_slip'
  | 'mark_staged_pickup'
  | 'mark_staged_delivery'
  | 'assign_delivery'
  | 'mark_in_transit'
  | 'collect_signature'
  | 'view_signature'
  | 'view_denial_reason'
  | 'view_final_packing_slip';

export interface AvailableActionsInput {
  status: OrderStatus;
  fulfillmentType: FulfillmentType;
  hasAssignedDelivery: boolean;
  viewerRole: Role;
  viewerUserId: string;
  assignedPickerId: string | null;
  assignedDeliveryUserId: string | null;
}

const MANAGER_OR_ABOVE: Role[] = ['owner', 'admin', 'manager'];

/**
 * Compute the list of UI actions available for the given order +
 * viewer combination. This is the single source of truth that the
 * order-detail page reads; never branch on status anywhere else.
 */
export function availableOrderActions(input: AvailableActionsInput): OrderAction[] {
  const isManagerOrAbove = MANAGER_OR_ABOVE.includes(input.viewerRole);
  const isAssignedDriver =
    input.assignedDeliveryUserId !== null &&
    input.assignedDeliveryUserId === input.viewerUserId;

  const actions: OrderAction[] = [];

  switch (input.status) {
    case 'pending_confirmation':
      if (isManagerOrAbove) actions.push('cancel');
      break;
    case 'pending_approval':
      actions.push('approve', 'deny');
      if (isManagerOrAbove) actions.push('cancel');
      break;
    case 'approved':
      actions.push('generate_pick_slip');
      if (isManagerOrAbove) actions.push('reassign_picker', 'cancel');
      break;
    case 'pick_slip_generated':
    case 'picking_in_progress':
      actions.push('open_digital_pick', 'print_pick_slip', 'mark_picking_complete');
      if (isManagerOrAbove) actions.push('reassign_picker', 'cancel');
      break;
    case 'picking_complete':
      actions.push('generate_packing_slips');
      if (isManagerOrAbove) actions.push('cancel');
      break;
    case 'packing_slip_generated':
      actions.push('print_customer_slip', 'print_warehouse_slip');
      if (input.fulfillmentType === 'pickup') actions.push('mark_staged_pickup');
      else actions.push('mark_staged_delivery');
      if (isManagerOrAbove) actions.push('cancel');
      break;
    case 'staged_for_pickup':
      actions.push('collect_signature', 'print_warehouse_slip');
      if (isManagerOrAbove) actions.push('cancel');
      break;
    case 'staged_for_delivery':
      if (isManagerOrAbove) actions.push('assign_delivery');
      if (input.hasAssignedDelivery && (isAssignedDriver || isManagerOrAbove)) {
        actions.push('mark_in_transit');
      }
      if (isManagerOrAbove) actions.push('cancel');
      break;
    case 'in_transit':
      actions.push('collect_signature');
      if (isManagerOrAbove) actions.push('cancel');
      break;
    case 'completed':
      actions.push('view_signature', 'view_final_packing_slip');
      break;
    case 'denied':
      actions.push('view_denial_reason');
      break;
    case 'cancelled':
      break;
  }

  return actions;
}

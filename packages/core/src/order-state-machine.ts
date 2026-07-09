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
  // Non-terminal "rest" state for partial fulfillment / backorder: the order
  // shipped everything it could but still owes units. Reached at hand-over when
  // owed > 0 (instead of `completed`); exits via resume (fulfill the rest),
  // close-partial (done, keep what shipped), or cancel. See the
  // 2026-07-09 partial-fulfillment spec.
  | 'backordered'
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
  // Hand-over (signature) forks on owed qty: → completed if fully fulfilled,
  // → backordered if units are still owed.
  staged_for_pickup: ['completed', 'backordered', 'cancelled'],
  staged_for_delivery: ['in_transit', 'cancelled'],
  in_transit: ['completed', 'backordered', 'cancelled'],
  // Backorder exits: resume (regenerate a pick slip for the remaining qty),
  // close-partial (end at completed, keep what shipped), or cancel.
  backordered: ['pick_slip_generated', 'completed', 'cancelled'],
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
  // Approve an order that's SHORT on stock: reserve what's available now and
  // backorder the rest (partial-fulfillment entry point at approval).
  | 'approve_partial'
  // From `backordered`: fulfill the remaining owed qty (regenerates a pick slip).
  | 'resume_fulfillment'
  // From `backordered`: end the order keeping what shipped ("delivered N of M").
  | 'close_partial'
  | 'deny'
  | 'cancel'
  | 'generate_pick_slip'
  | 'claim_picking'
  | 'reassign_picker'
  | 'release_picking'
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
  /**
   * Whether this viewer can actually perform pick mutations on THIS order —
   * i.e. they hold the pick permission (items:update, or are manager+) AND have
   * write access to the order's warehouse. The caller computes it (the state
   * machine has no permission/warehouse knowledge). When false, the picking
   * phase offers only view/print, never Claim/Pick/Complete/Release — so the UI
   * never advertises an action the backend (which checks both) would reject.
   * Optional + defaults to true so existing callers/tests that don't gate on it
   * keep their prior behavior. Picking callers MUST pass it.
   */
  viewerCanPick?: boolean;
  /**
   * Whether the order is SHORT on stock (requested > available). Drives the
   * `approve_partial` action at `pending_approval` — offered only when a full
   * approve would fail. The caller computes it (the state machine has no stock
   * knowledge). Optional; defaults to false (no partial-approve offered).
   */
  isShortStock?: boolean;
  /**
   * Whether there is fulfillable stock for at least one still-owed line. Drives
   * `resume_fulfillment` at `backordered` — offered only when there's something
   * to pick. Optional; defaults to false (resume hidden until restocked).
   */
  hasFulfillableStock?: boolean;
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
      // Short on stock → also offer "Approve partial" (ship what's available,
      // backorder the rest). Full "approve" stays and still enforces the
      // must-have-stock rule server-side.
      if (input.isShortStock) actions.push('approve_partial');
      if (isManagerOrAbove) actions.push('cancel');
      break;
    case 'approved':
      actions.push('generate_pick_slip');
      if (isManagerOrAbove) actions.push('cancel');
      break;
    case 'pick_slip_generated':
    case 'picking_in_progress': {
      // Picking claim/lock (owner decisions: admin = manager+; a non-admin MUST
      // claim before picking; a picker may self-release).
      const isUnassigned = input.assignedPickerId === null;
      const isAssignedPicker =
        input.assignedPickerId !== null && input.assignedPickerId === input.viewerUserId;
      // Anyone with order access can view/print the pick slip.
      actions.push('print_pick_slip');
      // A viewer who can't actually pick this order (no pick permission, or no
      // write access to its warehouse) gets view/print only — never a Claim/
      // Pick/Complete/Release button the backend would reject. `viewerCanPick`
      // defaults to true so non-picking callers are unaffected.
      if (input.viewerCanPick === false) break;
      if (isManagerOrAbove) {
        // Full control: pick directly (override), assign/reassign, complete.
        actions.push('open_digital_pick', 'mark_picking_complete', 'reassign_picker', 'cancel');
        if (!isUnassigned) actions.push('release_picking');
      } else if (isAssignedPicker) {
        // The claimant: pick + complete + hand back their own claim.
        actions.push('open_digital_pick', 'mark_picking_complete', 'release_picking');
      } else if (isUnassigned) {
        // Unclaimed: a staffer can claim it (claim-before-pick).
        actions.push('claim_picking');
      }
      // else: assigned to someone else + non-admin → view/print only.
      break;
    }
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
    case 'backordered':
      // Rest state after a partial hand-over. Manager+ can resume (only when
      // there's stock to pick), close it out keeping what shipped, or cancel.
      if (isManagerOrAbove) {
        if (input.hasFulfillableStock) actions.push('resume_fulfillment');
        actions.push('close_partial', 'cancel');
      }
      // Anyone with order access can review what already shipped.
      actions.push('view_signature', 'view_final_packing_slip');
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

export type PickingStatus = 'unassigned' | 'assigned' | 'in_progress' | 'completed';

/**
 * Derived picking status for display. The source of truth is the order status +
 * assigned_picker_id (NOT a stored column, to avoid drift). Null when the order
 * has not yet reached the picking phase.
 */
export function derivePickingStatus(
  status: OrderStatus,
  assignedPickerId: string | null,
): PickingStatus | null {
  switch (status) {
    case 'pick_slip_generated':
      return assignedPickerId ? 'assigned' : 'unassigned';
    case 'picking_in_progress':
      return assignedPickerId ? 'in_progress' : 'unassigned';
    case 'picking_complete':
    case 'packing_slip_generated':
    case 'staged_for_pickup':
    case 'staged_for_delivery':
    case 'in_transit':
    case 'backordered':
    case 'completed':
      return 'completed';
    default:
      return null;
  }
}

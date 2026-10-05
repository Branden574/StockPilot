/**
 * Who is offered Cancel on an order, on the web order page and the phone order
 * screen (L85, L93). The rule is the service's (OrderRequestsService.cancel):
 *   - nobody without orders:request: the service asserts it before any rule,
 *     for approvers too (desk check F3);
 *   - someone who approves orders (orders:approve) may cancel any open order;
 *   - the person who placed it may cancel it only while it waits for approval.
 *     Once approved, stock may be held or picked for it, so an approver must
 *     cancel it.
 * A closed order (completed, denied, cancelled) offers no Cancel.
 *
 * The service also asks an approver below manager rank for write access to
 * the order's warehouse, as for Approve and Deny (small fixes slice 2 review);
 * this offer does not know the viewer's warehouses, so an approver outside the
 * order's warehouse is offered Cancel, like Approve, and refused in the one
 * sentence (core ORDER_WAREHOUSE_WRITE_REFUSED_COPY). Withholding every
 * approver action on such an order, on the web and the phone together, is
 * security slice E's.
 *
 * 'approver' and 'requester' are which offer it is (the phone words them
 * differently); null offers nothing.
 */

const CLOSED_STATUSES: ReadonlySet<string> = new Set(['completed', 'denied', 'cancelled']);

export type OrderCancelOffer = 'approver' | 'requester' | null;

export function orderCancelOffer(input: {
  status: string;
  /** The viewer's effective orders:approve. */
  canApprove: boolean;
  /** The viewer placed this order. */
  isOwnRequest: boolean;
  /** The viewer's effective orders:request, which every cancel needs. */
  canRequest: boolean;
}): OrderCancelOffer {
  if (!input.canRequest) return null;
  if (CLOSED_STATUSES.has(input.status)) return null;
  if (input.canApprove) return 'approver';
  if (input.isOwnRequest && input.status === 'pending_approval') return 'requester';
  return null;
}

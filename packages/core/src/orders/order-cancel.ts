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

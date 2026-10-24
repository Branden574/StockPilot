/**
 * Who is offered Cancel on an order, on the web order page and the phone order
 * screen (L85, L93). The rule is the service's (OrderRequestsService.cancel)
 * and, since security slice E (migration 0405), cancel_order_request's own:
 *   - nobody without orders:request: the service asserts it before any rule,
 *     for approvers too (desk check F3);
 *   - someone who approves orders (orders:approve) may cancel any open order
 *     in a warehouse they may write to (the service's requireWarehouseAccess
 *     'write', the function's user_can_access_warehouse 'write'): every
 *     warehouse for an owner, admin or manager, an assigned one for staff,
 *     none for a viewer;
 *   - the person who placed it may cancel it only while it waits for approval,
 *     wherever it is. Once approved, stock may be held or picked for it, so an
 *     approver must cancel it. An approver outside the order's warehouse who
 *     placed it keeps that requester's cancel.
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
  /**
   * The viewer may write to the ORDER's warehouse, as the service asks it
   * (assertWarehouseAccess 'write'): true for an owner, admin or manager by
   * role, for anyone else only with the order's warehouse among their
   * writable ones, never for a viewer. Only an approver's cancel asks it. Each
   * surface decides it from its own read of the viewer's warehouses (the web
   * page's approverWarehouseAccess, the phone's readDestinationWarehouseScope).
   */
  canWriteOrderWarehouse: boolean;
  /** The viewer placed this order. */
  isOwnRequest: boolean;
  /** The viewer's effective orders:request, which every cancel needs. */
  canRequest: boolean;
}): OrderCancelOffer {
  if (!input.canRequest) return null;
  if (CLOSED_STATUSES.has(input.status)) return null;
  if (input.canApprove && input.canWriteOrderWarehouse) return 'approver';
  if (input.isOwnRequest && input.status === 'pending_approval') return 'requester';
  return null;
}

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
 * 'approver' and 'requester' are which offer it is, and orderCancelWords
 * words each (the web and the phone take the same words); null offers nothing.
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

/**
 * The words of each Cancel (B51, owner decision a.22): the button, the
 * confirm and the web's toast, for the web order page and the phone order
 * screen alike, so the two cannot drift. They were the phone's alone, and the
 * web showed the requester's words to everyone.
 *
 * An approver's confirm tells of delivered items by WHAT WAS DELIVERED (any
 * line's quantity_fulfilled above zero), not by status: cancel_order_request
 * never puts delivered items back in stock, at any status
 * (0395_order_stock_guards.sql; pgTAP 0290 D and E). A backorder resumed into
 * picking has delivered items too, and a backordered order may have nothing
 * handed over (one-click pick stages what is there, possibly nothing). The
 * requester cancels only an order waiting for approval, which has delivered
 * nothing.
 */
export interface OrderCancelWords {
  /** The button. */
  label: string;
  /** The confirm's title. */
  title: string;
  /** What happens (the phone adds its reason prompt after it). */
  body: string;
  confirmLabel: string;
  keepLabel: string;
  /** The web's success toast (the phone reloads the order instead). */
  done: string;
  /** The verb phrase for a cancel that got no answer ("We couldn't ..."). */
  failedWhat: string;
}

const APPROVER_RELEASED =
  'The order is marked cancelled and the stock held for it is released. Anything already picked goes back into stock.';
const DELIVERED_NOT_RESTOCKED = 'Already-delivered items are NOT restocked.';
const ON_THE_RECORD = 'The order stays on the record.';

export function orderCancelWords(
  offer: 'approver' | 'requester',
  facts: { status: string; anythingDelivered: boolean },
): OrderCancelWords {
  if (offer === 'requester') {
    return {
      label: 'Cancel request',
      title: 'Cancel this order request?',
      body: 'The request is marked cancelled and any stock reservations attached to it are released back to available stock. The request stays on the record for the audit trail.',
      confirmLabel: 'Cancel request',
      keepLabel: 'Keep request',
      done: 'Order request cancelled.',
      failedWhat: 'cancel the request',
    };
  }
  let body: string;
  if (!facts.anythingDelivered) {
    body = `${APPROVER_RELEASED} ${ON_THE_RECORD}`;
  } else if (facts.status === 'backordered') {
    body =
      'The order is voided. Already-delivered items are NOT restocked; the hold on the remaining items is released.';
  } else {
    body = `${APPROVER_RELEASED} ${DELIVERED_NOT_RESTOCKED} ${ON_THE_RECORD}`;
  }
  return {
    label: 'Cancel order',
    title: 'Cancel this order?',
    body,
    confirmLabel: 'Cancel order',
    keepLabel: 'Keep order',
    done: 'Order cancelled.',
    failedWhat: 'cancel the order',
  };
}

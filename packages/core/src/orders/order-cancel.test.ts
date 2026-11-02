import { describe, expect, it } from 'vitest';

import { orderCancelOffer, orderCancelWords } from './order-cancel';

/**
 * L85 / L93: who is offered Cancel on an order, on the web and the phone.
 * The service's rule (svc.cancel): someone who approves orders may cancel any
 * open order; the person who placed it, only while it waits for approval.
 */

const OPEN = [
  'pending_confirmation',
  'pending_approval',
  'approved',
  'pick_slip_generated',
  'picking_in_progress',
  'picking_complete',
  'packing_slip_generated',
  'staged_for_pickup',
  'staged_for_delivery',
  'in_transit',
  'backordered',
];
const CLOSED = ['completed', 'denied', 'cancelled'];

describe('orderCancelOffer', () => {
  it('offers an approver Cancel at every open status, and never on a closed order', () => {
    for (const status of OPEN) {
      expect(orderCancelOffer({ status, canApprove: true, isOwnRequest: false, canRequest: true })).toBe('approver');
      expect(orderCancelOffer({ status, canApprove: true, isOwnRequest: true, canRequest: true })).toBe('approver');
    }
    for (const status of CLOSED) {
      expect(orderCancelOffer({ status, canApprove: true, isOwnRequest: true, canRequest: true })).toBeNull();
    }
  });

  it('offers the requester Cancel request only while their order waits for approval', () => {
    expect(
      orderCancelOffer({ status: 'pending_approval', canApprove: false, isOwnRequest: true, canRequest: true }),
    ).toBe('requester');
    for (const status of [...OPEN, ...CLOSED].filter((s) => s !== 'pending_approval')) {
      expect(orderCancelOffer({ status, canApprove: false, isOwnRequest: true, canRequest: true })).toBeNull();
    }
  });

  // Desk check F3: svc.cancel asserts orders:request before any rule, for
  // approvers too, so someone whose orders:request was revoked is refused
  // every cancel. They are offered none.
  it('offers nothing without orders:request, to an approver or the requester', () => {
    for (const status of [...OPEN, ...CLOSED]) {
      for (const isOwnRequest of [true, false]) {
        expect(orderCancelOffer({ status, canApprove: true, isOwnRequest, canRequest: false })).toBeNull();
        expect(orderCancelOffer({ status, canApprove: false, isOwnRequest, canRequest: false })).toBeNull();
      }
    }
  });

  it('offers nothing to someone who neither approves nor placed the order', () => {
    for (const status of [...OPEN, ...CLOSED]) {
      expect(orderCancelOffer({ status, canApprove: false, isOwnRequest: false, canRequest: true })).toBeNull();
    }
  });
});

/**
 * B51 (owner decision a.22): the web's Cancel used the requester's words for
 * every kind of cancel, and the per-kind words lived only in the phone helper,
 * which told of delivered items by STATUS (backordered) rather than by what
 * was delivered. cancel_order_request never restocks delivered items at any
 * status (0395_order_stock_guards.sql; pgTAP 0290 D and E), so a backorder
 * resumed into picking had delivered items and no sentence, and a backordered
 * order with nothing handed over had the sentence and no items. One set of
 * words now, for the web and the phone.
 */
const REQUESTER_BODY =
  'The request is marked cancelled and any stock reservations attached to it are released back to available stock. The request stays on the record for the audit trail.';
const APPROVER_BODY =
  'The order is marked cancelled and the stock held for it is released. Anything already picked goes back into stock. The order stays on the record.';
const VOIDED_BODY =
  'The order is voided. Already-delivered items are NOT restocked; the hold on the remaining items is released.';
const DELIVERED = 'Already-delivered items are NOT restocked';

describe('orderCancelWords', () => {
  it('the requester: the words the web and the phone have shown, whatever was delivered', () => {
    for (const anythingDelivered of [false, true]) {
      expect(orderCancelWords('requester', { status: 'pending_approval', anythingDelivered })).toEqual({
        label: 'Cancel request',
        title: 'Cancel this order request?',
        body: REQUESTER_BODY,
        confirmLabel: 'Cancel request',
        keepLabel: 'Keep request',
        done: 'Order request cancelled.',
        failedWhat: 'cancel the request',
      });
    }
  });

  it('an approver with nothing delivered: the default body at every open status, a backordered order too', () => {
    for (const status of OPEN) {
      const w = orderCancelWords('approver', { status, anythingDelivered: false });
      expect(w, status).toEqual({
        label: 'Cancel order',
        title: 'Cancel this order?',
        body: APPROVER_BODY,
        confirmLabel: 'Cancel order',
        keepLabel: 'Keep order',
        done: 'Order cancelled.',
        failedWhat: 'cancel the order',
      });
      expect(w.body, status).not.toContain(DELIVERED);
    }
  });

  it('an approver on a backordered order with items delivered: the phone\'s voided body, exactly', () => {
    expect(orderCancelWords('approver', { status: 'backordered', anythingDelivered: true }).body).toBe(VOIDED_BODY);
  });

  it('an approver on a resumed backorder (items delivered, any other open status): the delivered sentence before the record', () => {
    for (const status of [
      'pick_slip_generated',
      'picking_in_progress',
      'picking_complete',
      'packing_slip_generated',
      'staged_for_pickup',
      'staged_for_delivery',
      'in_transit',
    ]) {
      expect(orderCancelWords('approver', { status, anythingDelivered: true }).body, status).toBe(
        'The order is marked cancelled and the stock held for it is released. Anything already picked goes back into stock. Already-delivered items are NOT restocked. The order stays on the record.',
      );
    }
  });

  // Mutation caught: the sentence decided by status again (the phone's old
  // rule), either way round.
  it('says delivered items are not restocked exactly when something was delivered, and never to the requester', () => {
    for (const status of OPEN) {
      for (const anythingDelivered of [false, true]) {
        expect(orderCancelWords('approver', { status, anythingDelivered }).body.includes(DELIVERED), `${status} ${anythingDelivered}`).toBe(
          anythingDelivered,
        );
        expect(orderCancelWords('requester', { status, anythingDelivered }).body).not.toContain(DELIVERED);
      }
    }
  });

  it('the toast and the failure phrase follow the kind', () => {
    const facts = { status: 'pending_approval', anythingDelivered: false };
    expect(orderCancelWords('approver', facts).done).toBe('Order cancelled.');
    expect(orderCancelWords('approver', facts).failedWhat).toBe('cancel the order');
    expect(orderCancelWords('requester', facts).done).toBe('Order request cancelled.');
    expect(orderCancelWords('requester', facts).failedWhat).toBe('cancel the request');
  });
});

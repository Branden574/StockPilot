import { describe, expect, it } from 'vitest';

import { orderCancelOffer } from './order-cancel';

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

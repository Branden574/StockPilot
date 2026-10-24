import { describe, expect, it } from 'vitest';

import { orderCancelOffer } from './order-cancel';

/**
 * L85 / L93: who is offered Cancel on an order, on the web and the phone.
 * The service's rule (svc.cancel): someone who approves orders may cancel any
 * open order in a warehouse they may write to (security slice E, 0405: the
 * database asks it too); the person who placed it, only while it waits for
 * approval, wherever it is.
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

/** Everything granted, in the order's warehouse: each test takes one away. */
const ALL = { canApprove: true, canWriteOrderWarehouse: true, isOwnRequest: false, canRequest: true };

describe('orderCancelOffer', () => {
  it('offers an approver Cancel at every open status, and never on a closed order', () => {
    for (const status of OPEN) {
      expect(orderCancelOffer({ ...ALL, status })).toBe('approver');
      expect(orderCancelOffer({ ...ALL, status, isOwnRequest: true })).toBe('approver');
    }
    for (const status of CLOSED) {
      expect(orderCancelOffer({ ...ALL, status, isOwnRequest: true })).toBeNull();
    }
  });

  it('offers the requester Cancel request only while their order waits for approval', () => {
    const requester = { ...ALL, canApprove: false, isOwnRequest: true };
    expect(orderCancelOffer({ ...requester, status: 'pending_approval' })).toBe('requester');
    for (const status of [...OPEN, ...CLOSED].filter((s) => s !== 'pending_approval')) {
      expect(orderCancelOffer({ ...requester, status })).toBeNull();
    }
  });

  // Security slice E (0405): an approver's cancel asks write access to the
  // order's warehouse, in the service and in cancel_order_request itself.
  // Mutation caught: the warehouse input ignored (an approver outside the
  // warehouse offered Cancel order, refused after the tap).
  it("offers an approver outside the order's warehouse nothing on someone else's order", () => {
    for (const status of [...OPEN, ...CLOSED]) {
      expect(orderCancelOffer({ ...ALL, status, canWriteOrderWarehouse: false })).toBeNull();
    }
  });

  // Mutation caught: the warehouse input applied to the requester's own
  // pending cancel too (the service and the function ask it no warehouse).
  it("an approver outside the order's warehouse who placed it keeps the requester's cancel, while it waits for approval only", () => {
    const outside = { ...ALL, canWriteOrderWarehouse: false, isOwnRequest: true };
    expect(orderCancelOffer({ ...outside, status: 'pending_approval' })).toBe('requester');
    for (const status of [...OPEN, ...CLOSED].filter((s) => s !== 'pending_approval')) {
      expect(orderCancelOffer({ ...outside, status })).toBeNull();
    }
  });

  it('the warehouse input changes nothing for someone who does not approve orders', () => {
    for (const status of [...OPEN, ...CLOSED]) {
      for (const isOwnRequest of [true, false]) {
        const base = { ...ALL, status, canApprove: false, isOwnRequest };
        expect(orderCancelOffer({ ...base, canWriteOrderWarehouse: true })).toBe(
          orderCancelOffer({ ...base, canWriteOrderWarehouse: false }),
        );
      }
    }
  });

  // Desk check F3: svc.cancel asserts orders:request before any rule, for
  // approvers too, so someone whose orders:request was revoked is refused
  // every cancel. They are offered none.
  it('offers nothing without orders:request, to an approver or the requester', () => {
    for (const status of [...OPEN, ...CLOSED]) {
      for (const isOwnRequest of [true, false]) {
        expect(orderCancelOffer({ ...ALL, status, isOwnRequest, canRequest: false })).toBeNull();
        expect(
          orderCancelOffer({ ...ALL, status, isOwnRequest, canApprove: false, canRequest: false }),
        ).toBeNull();
      }
    }
  });

  it('offers nothing to someone who neither approves nor placed the order', () => {
    for (const status of [...OPEN, ...CLOSED]) {
      expect(orderCancelOffer({ ...ALL, status, canApprove: false })).toBeNull();
    }
  });
});

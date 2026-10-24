import { describe, expect, it } from 'vitest';

import type { OrderRequestStatus } from '@/server/services/order-requests';

import { actionsPanelOffersReads, DOWNSTREAM_PACKING_STATUSES } from './actions-panel-reads';

/**
 * Security slice E review (0405): the order page shows an approver outside
 * the order's warehouse the actions panel only where it carries a read
 * (Print pick slip at picking complete; from the packing slips on Print
 * customer slip and View signature), never where it would be an empty card
 * or a step they would be refused. Every status of the order union is named
 * here, so a new status is decided on purpose.
 */

const EVERY_STATUS: Record<OrderRequestStatus, boolean> = {
  pending_confirmation: false,
  pending_approval: false,
  approved: false,
  // The picking phase is every member's panel already (claim-before-pick).
  pick_slip_generated: false,
  picking_in_progress: false,
  picking_complete: true,
  packing_slip_generated: true,
  staged_for_pickup: true,
  staged_for_delivery: true,
  // Out for delivery the panel prints nothing (Collect signature is a step).
  in_transit: false,
  backordered: false,
  completed: true,
  denied: false,
  cancelled: false,
};

describe('actionsPanelOffersReads', () => {
  it.each(Object.entries(EVERY_STATUS) as Array<[OrderRequestStatus, boolean]>)(
    '%s: %s',
    (status, offers) => {
      expect(actionsPanelOffersReads(status)).toBe(offers);
    },
  );

  it("the panel's packing-slip prints are the same list (one list for the page's gate and the panel's buttons)", () => {
    expect([...DOWNSTREAM_PACKING_STATUSES]).toEqual([
      'packing_slip_generated',
      'staged_for_pickup',
      'staged_for_delivery',
      'completed',
    ]);
  });
});

import { describe, expect, it } from 'vitest';

import {
  ALLOWED_TRANSITIONS,
  assertTransition,
  availableOrderActions,
  derivePickingStatus,
  OrderTransitionError,
  type OrderStatus,
} from './order-state-machine';

describe('ALLOWED_TRANSITIONS', () => {
  it('covers every OrderStatus value as a key', () => {
    const statuses: OrderStatus[] = [
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
      'completed',
      'denied',
      'cancelled',
    ];
    for (const s of statuses) {
      expect(ALLOWED_TRANSITIONS).toHaveProperty(s);
    }
  });

  it('terminal states have no outgoing transitions', () => {
    expect(ALLOWED_TRANSITIONS.denied).toEqual([]);
    expect(ALLOWED_TRANSITIONS.cancelled).toEqual([]);
    expect(ALLOWED_TRANSITIONS.completed).toEqual([]);
  });

  it('approval branches to pick_slip_generated or cancelled', () => {
    expect(ALLOWED_TRANSITIONS.approved).toEqual(
      expect.arrayContaining(['pick_slip_generated', 'cancelled']),
    );
  });

  it('pending_approval can branch to approved, denied, or cancelled', () => {
    expect(ALLOWED_TRANSITIONS.pending_approval).toEqual(
      expect.arrayContaining(['approved', 'denied', 'cancelled']),
    );
  });

  it('packing_slip_generated can branch to either staging type', () => {
    expect(ALLOWED_TRANSITIONS.packing_slip_generated).toEqual(
      expect.arrayContaining(['staged_for_pickup', 'staged_for_delivery']),
    );
  });

  it('staged_for_delivery must go through in_transit before completion', () => {
    expect(ALLOWED_TRANSITIONS.staged_for_delivery).toContain('in_transit');
    expect(ALLOWED_TRANSITIONS.staged_for_delivery).not.toContain('completed');
  });

  it('staged_for_pickup can go straight to completed (no transit step)', () => {
    expect(ALLOWED_TRANSITIONS.staged_for_pickup).toContain('completed');
    expect(ALLOWED_TRANSITIONS.staged_for_pickup).not.toContain('in_transit');
  });
});

describe('assertTransition', () => {
  const baseCtx = {
    fulfillmentType: 'delivery' as const,
    hasAssignedDelivery: false,
  };

  it('accepts a legal transition', () => {
    expect(() =>
      assertTransition('pending_approval', 'approved', baseCtx),
    ).not.toThrow();
  });

  it('rejects an illegal transition', () => {
    expect(() =>
      assertTransition('completed', 'pending_approval', baseCtx),
    ).toThrow(OrderTransitionError);
  });

  it('rejects same-status transitions as no-ops (throws with code=no_op)', () => {
    expect(() =>
      assertTransition('approved', 'approved', baseCtx),
    ).toThrow(/no_op/);
  });

  it('rejects staged_for_delivery on a pickup order', () => {
    expect(() =>
      assertTransition('packing_slip_generated', 'staged_for_delivery', {
        ...baseCtx,
        fulfillmentType: 'pickup',
      }),
    ).toThrow(/fulfillment_type/);
  });

  it('rejects staged_for_pickup on a delivery order', () => {
    expect(() =>
      assertTransition('packing_slip_generated', 'staged_for_pickup', {
        ...baseCtx,
        fulfillmentType: 'delivery',
      }),
    ).toThrow(/fulfillment_type/);
  });

  it('rejects in_transit when no delivery user is assigned', () => {
    expect(() =>
      assertTransition('staged_for_delivery', 'in_transit', {
        ...baseCtx,
        hasAssignedDelivery: false,
      }),
    ).toThrow(/assigned_delivery/);
  });

  it('accepts in_transit when delivery is assigned', () => {
    expect(() =>
      assertTransition('staged_for_delivery', 'in_transit', {
        ...baseCtx,
        hasAssignedDelivery: true,
      }),
    ).not.toThrow();
  });
});

describe('availableOrderActions', () => {
  const base = {
    status: 'approved' as const,
    fulfillmentType: 'delivery' as const,
    hasAssignedDelivery: false,
    viewerRole: 'manager' as const,
    viewerUserId: 'u-mgr',
    assignedPickerId: null as string | null,
    assignedDeliveryUserId: null as string | null,
  };

  it('returns generate_pick_slip on approved orders', () => {
    expect(availableOrderActions(base)).toContain('generate_pick_slip');
  });

  it('returns approve+deny on pending_approval', () => {
    const actions = availableOrderActions({ ...base, status: 'pending_approval' });
    expect(actions).toContain('approve');
    expect(actions).toContain('deny');
  });

  it('returns assign_delivery on staged_for_delivery for manager+', () => {
    const actions = availableOrderActions({
      ...base,
      status: 'staged_for_delivery',
    });
    expect(actions).toContain('assign_delivery');
  });

  it('does NOT return assign_delivery for staff role', () => {
    const actions = availableOrderActions({
      ...base,
      status: 'staged_for_delivery',
      viewerRole: 'staff',
    });
    expect(actions).not.toContain('assign_delivery');
  });

  it('returns mark_in_transit only when delivery is assigned', () => {
    const without = availableOrderActions({
      ...base,
      status: 'staged_for_delivery',
      hasAssignedDelivery: false,
    });
    const withAssigned = availableOrderActions({
      ...base,
      status: 'staged_for_delivery',
      hasAssignedDelivery: true,
      assignedDeliveryUserId: 'u-driver',
      viewerUserId: 'u-driver',
      viewerRole: 'staff',
    });
    expect(without).not.toContain('mark_in_transit');
    expect(withAssigned).toContain('mark_in_transit');
  });

  it('terminal states return only view-only actions', () => {
    const actions = availableOrderActions({ ...base, status: 'completed' });
    expect(actions).not.toContain('generate_pick_slip');
    expect(actions).toContain('view_signature');
  });

  it('denied state offers only view_denial_reason', () => {
    expect(availableOrderActions({ ...base, status: 'denied' })).toEqual([
      'view_denial_reason',
    ]);
  });

  // ── Picking claim / lock (owner: admin=manager+, must-claim-before-pick,
  //    self-release) ──────────────────────────────────────────────────────────
  describe('picking claim/lock', () => {
    const picking = { ...base, status: 'pick_slip_generated' as const, viewerRole: 'staff' as const };

    it('UNCLAIMED + staff: can Claim, but cannot pick or complete yet', () => {
      const a = availableOrderActions({ ...picking, assignedPickerId: null, viewerUserId: 'u-staff' });
      expect(a).toContain('claim_picking');
      expect(a).toContain('print_pick_slip');
      expect(a).not.toContain('open_digital_pick');
      expect(a).not.toContain('mark_picking_complete');
      expect(a).not.toContain('release_picking');
    });

    it('ASSIGNED TO ME + staff: can pick, complete, and self-release; cannot re-claim', () => {
      const a = availableOrderActions({ ...picking, assignedPickerId: 'u-staff', viewerUserId: 'u-staff' });
      expect(a).toContain('open_digital_pick');
      expect(a).toContain('mark_picking_complete');
      expect(a).toContain('release_picking');
      expect(a).not.toContain('claim_picking');
      expect(a).not.toContain('reassign_picker'); // staff can't reassign
    });

    it('ASSIGNED TO SOMEONE ELSE + staff: view/print only — no claim, no pick', () => {
      const a = availableOrderActions({ ...picking, assignedPickerId: 'u-other', viewerUserId: 'u-staff' });
      expect(a).toEqual(['print_pick_slip']);
    });

    it('viewerCanPick=false (no pick permission or out-of-warehouse): view/print only, no Claim', () => {
      // A viewer role, or a warehouse-scoped staffer viewing an out-of-scope
      // order — the backend would reject the pick, so the UI must not offer it.
      const staff = availableOrderActions({
        ...picking,
        assignedPickerId: null,
        viewerUserId: 'u-staff',
        viewerCanPick: false,
      });
      expect(staff).toEqual(['print_pick_slip']);
      // Even a manager passed viewerCanPick=false (out-of-scope) is gated.
      const mgr = availableOrderActions({
        ...picking,
        viewerRole: 'manager',
        assignedPickerId: null,
        viewerUserId: 'u-mgr',
        viewerCanPick: false,
      });
      expect(mgr).toEqual(['print_pick_slip']);
    });

    it('viewerCanPick=true (default) preserves the normal claim/pick actions', () => {
      const a = availableOrderActions({
        ...picking,
        assignedPickerId: null,
        viewerUserId: 'u-staff',
        viewerCanPick: true,
      });
      expect(a).toContain('claim_picking');
    });

    it('UNCLAIMED + manager: can pick directly + reassign; no release (nothing to release)', () => {
      const a = availableOrderActions({
        ...picking,
        viewerRole: 'manager',
        assignedPickerId: null,
        viewerUserId: 'u-mgr',
      });
      expect(a).toContain('open_digital_pick');
      expect(a).toContain('mark_picking_complete');
      expect(a).toContain('reassign_picker');
      expect(a).not.toContain('release_picking');
      expect(a).not.toContain('claim_picking');
    });

    it('ASSIGNED TO SOMEONE ELSE + manager: full override incl. release + reassign', () => {
      const a = availableOrderActions({
        ...picking,
        viewerRole: 'manager',
        assignedPickerId: 'u-other',
        viewerUserId: 'u-mgr',
      });
      expect(a).toContain('open_digital_pick');
      expect(a).toContain('mark_picking_complete');
      expect(a).toContain('reassign_picker');
      expect(a).toContain('release_picking');
    });
  });

  describe('derivePickingStatus', () => {
    it('maps status + assignment to the display status', () => {
      expect(derivePickingStatus('approved', null)).toBeNull();
      expect(derivePickingStatus('pick_slip_generated', null)).toBe('unassigned');
      expect(derivePickingStatus('pick_slip_generated', 'u-1')).toBe('assigned');
      expect(derivePickingStatus('picking_in_progress', 'u-1')).toBe('in_progress');
      expect(derivePickingStatus('picking_in_progress', null)).toBe('unassigned');
      expect(derivePickingStatus('picking_complete', 'u-1')).toBe('completed');
      expect(derivePickingStatus('completed', 'u-1')).toBe('completed');
    });
  });

  describe('backorder (partial fulfillment)', () => {
    const base = {
      fulfillmentType: 'delivery' as const,
      hasAssignedDelivery: false,
      viewerUserId: 'u-1',
      assignedPickerId: null,
      assignedDeliveryUserId: null,
    };

    it('adds the hand-over fork to backordered from staged_for_pickup + in_transit', () => {
      expect(ALLOWED_TRANSITIONS.staged_for_pickup).toContain('backordered');
      expect(ALLOWED_TRANSITIONS.in_transit).toContain('backordered');
    });

    it('backordered is non-terminal with exactly the three spec exits', () => {
      expect(ALLOWED_TRANSITIONS.backordered).toEqual([
        'pick_slip_generated',
        'completed',
        'cancelled',
      ]);
    });

    it('offers approve_partial at pending_approval ONLY when short on stock', () => {
      const short = availableOrderActions({
        ...base,
        status: 'pending_approval',
        viewerRole: 'manager',
        isShortStock: true,
      });
      expect(short).toContain('approve');
      expect(short).toContain('approve_partial');
      const enough = availableOrderActions({
        ...base,
        status: 'pending_approval',
        viewerRole: 'manager',
      });
      expect(enough).not.toContain('approve_partial');
    });

    it('backordered: manager gets resume (only with stock) + close_partial + cancel', () => {
      const withStock = availableOrderActions({
        ...base,
        status: 'backordered',
        viewerRole: 'manager',
        hasFulfillableStock: true,
      });
      expect(withStock).toContain('resume_fulfillment');
      expect(withStock).toContain('close_partial');
      expect(withStock).toContain('cancel');

      const noStock = availableOrderActions({
        ...base,
        status: 'backordered',
        viewerRole: 'manager',
        hasFulfillableStock: false,
      });
      expect(noStock).not.toContain('resume_fulfillment');
      expect(noStock).toContain('close_partial');
    });

    it('backordered: a non-manager sees only view actions', () => {
      const staff = availableOrderActions({
        ...base,
        status: 'backordered',
        viewerRole: 'staff',
        hasFulfillableStock: true,
      });
      expect(staff).not.toContain('resume_fulfillment');
      expect(staff).not.toContain('close_partial');
      expect(staff).not.toContain('cancel');
      expect(staff).toContain('view_signature');
    });

    it('assertTransition allows the fork in and the resume out', () => {
      expect(() =>
        assertTransition('in_transit', 'backordered', {
          fulfillmentType: 'delivery',
          hasAssignedDelivery: true,
        }),
      ).not.toThrow();
      expect(() =>
        assertTransition('backordered', 'pick_slip_generated', {
          fulfillmentType: 'delivery',
          hasAssignedDelivery: false,
        }),
      ).not.toThrow();
    });

    it('derivePickingStatus treats backordered as completed picking', () => {
      expect(derivePickingStatus('backordered', 'u-1')).toBe('completed');
    });
  });
});

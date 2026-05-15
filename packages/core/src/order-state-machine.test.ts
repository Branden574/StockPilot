import { describe, expect, it } from 'vitest';

import {
  ALLOWED_TRANSITIONS,
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
      'signature_requested',
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
    expect(ALLOWED_TRANSITIONS.staged_for_pickup).toEqual(
      expect.arrayContaining(['signature_requested', 'completed']),
    );
  });
});

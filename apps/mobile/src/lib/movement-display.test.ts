import { describe, expect, it } from 'vitest';

import { movementAmount, movementNotesForDisplay, movementReasonLabel } from './movement-display';

describe('movementAmount', () => {
  it('NEW transfer row: shows moved_quantity neutrally (never the 0 delta)', () => {
    expect(
      movementAmount({ movement_type: 'transfer', quantity_change: 0, moved_quantity: 250 }),
    ).toEqual({ kind: 'moved', text: '250' });
  });

  it('OLD transfer row (pre-0231, moved_quantity null): shows NO number, never "0"', () => {
    expect(
      movementAmount({ movement_type: 'transfer', quantity_change: 0, moved_quantity: null }),
    ).toEqual({ kind: 'none' });
  });

  it('positive non-transfer delta keeps the signed +N rendering', () => {
    expect(
      movementAmount({ movement_type: 'add', quantity_change: 5, moved_quantity: null }),
    ).toEqual({ kind: 'delta', text: '+5', sign: 1 });
  });

  it('negative non-transfer delta keeps the signed -N rendering', () => {
    expect(
      movementAmount({ movement_type: 'remove', quantity_change: -3, moved_quantity: null }),
    ).toEqual({ kind: 'delta', text: '-3', sign: -1 });
  });

  it('zero non-transfer delta (e.g. cycle_count no-op) still renders 0', () => {
    expect(
      movementAmount({ movement_type: 'cycle_count', quantity_change: 0, moved_quantity: null }),
    ).toEqual({ kind: 'delta', text: '0', sign: 0 });
  });
});

describe('movementReasonLabel', () => {
  it("OLD receipt row: maps the internal 'receipt_line' reason to 'PO receipt'", () => {
    expect(movementReasonLabel('receipt_line')).toBe('PO receipt');
  });

  it("NEW receipt row: passes the 'PO {number}' reason through verbatim", () => {
    expect(movementReasonLabel('PO PO-2026-014')).toBe('PO PO-2026-014');
  });

  it('passes ordinary reasons and null through unchanged', () => {
    expect(movementReasonLabel('Damaged in transit')).toBe('Damaged in transit');
    expect(movementReasonLabel(null)).toBeNull();
  });
});

describe('movementNotesForDisplay', () => {
  it("OLD receipt row: masks the internal receipt uuid stashed in notes", () => {
    expect(movementNotesForDisplay('receipt_line', 'a1b2c3d4-...')).toBeNull();
  });

  it('ordinary reasons pass notes through verbatim', () => {
    expect(movementNotesForDisplay('PO PO-2026-014', 'Handled with care')).toBe(
      'Handled with care',
    );
    expect(movementNotesForDisplay('Damaged in transit', null)).toBeNull();
    expect(movementNotesForDisplay(null, 'Free-text note')).toBe('Free-text note');
  });
});

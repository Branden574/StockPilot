import { describe, expect, it } from 'vitest';

import { ALLOWED_TRANSITIONS, type OrderStatus } from '../order-state-machine';

import {
  describeRaiseAfterPicking,
  describeUnpickedShortfall,
  isPickingSettled,
  lineUnpickedUnits,
  PICKING_SETTLED_STATUSES,
  projectedLineShortfall,
  unpickedShortfall,
  type ShortfallLine,
} from './pick-shortfall';

function line(over: Partial<ShortfallLine> = {}): ShortfallLine {
  return { quantityRequested: 40, quantityFulfilled: 0, quantityPicked: 40, ...over };
}

describe('lineUnpickedUnits', () => {
  it('counts nothing picked yet as the whole request', () => {
    expect(lineUnpickedUnits({ quantityRequested: 40, quantityFulfilled: 0, quantityPicked: 0 })).toBe(40);
  });

  it('counts a fully picked line as nothing left to pull', () => {
    expect(lineUnpickedUnits(line())).toBe(0);
  });

  it('counts a partially picked line as the remainder', () => {
    expect(lineUnpickedUnits({ quantityRequested: 42, quantityFulfilled: 0, quantityPicked: 40 })).toBe(2);
  });

  it('clamps an OVER-picked line at zero rather than going negative', () => {
    expect(lineUnpickedUnits({ quantityRequested: 40, quantityFulfilled: 0, quantityPicked: 45 })).toBe(0);
  });

  it('treats nulls as zero', () => {
    expect(lineUnpickedUnits({ quantityRequested: 5, quantityFulfilled: null, quantityPicked: null })).toBe(5);
    expect(lineUnpickedUnits({ quantityRequested: null, quantityFulfilled: null, quantityPicked: undefined })).toBe(0);
  });

  it('subtracts handed-over units as well as staged ones (the resumed backorder)', () => {
    // SO-000061 after the first signature: 40 of 42 handed over, 2 still to pull.
    expect(lineUnpickedUnits({ quantityRequested: 42, quantityFulfilled: 40, quantityPicked: 0 })).toBe(2);
  });
});

describe('PICKING_SETTLED_STATUSES', () => {
  it('starts at picking_complete and never earlier', () => {
    for (const s of [
      'pending_confirmation',
      'pending_approval',
      'approved',
      'pick_slip_generated',
      'picking_in_progress',
    ] satisfies OrderStatus[]) {
      expect(isPickingSettled(s)).toBe(false);
    }
  });

  it('covers every open status from picking_complete onward', () => {
    for (const s of [
      'picking_complete',
      'packing_slip_generated',
      'staged_for_pickup',
      'staged_for_delivery',
      'in_transit',
    ] satisfies OrderStatus[]) {
      expect(isPickingSettled(s)).toBe(true);
    }
  });

  // REWRITTEN, not weakened. The first version asserted `backordered` belonged
  // here. Review showed that makes the notice fire on EVERY backordered order,
  // because at that status the unpicked shortfall equals what the order already
  // owes — restating, inside the "Backordered — awaiting stock" banner, the one
  // number that banner exists to show. Being owed stock is the definition of
  // backordered, not an anomaly.
  it('EXCLUDES backordered, where the shortfall is just what the order owes', () => {
    expect(isPickingSettled('backordered')).toBe(false);
    expect(
      describeUnpickedShortfall(
        [{ quantityRequested: 42, quantityFulfilled: 40, quantityPicked: 0 }],
        'backordered',
      ),
    ).toBeNull();
  });

  it('excludes exactly the terminal statuses of the state machine', () => {
    const terminal = (Object.keys(ALLOWED_TRANSITIONS) as OrderStatus[]).filter(
      (s) => ALLOWED_TRANSITIONS[s].length === 0,
    );
    expect(terminal.sort()).toEqual(['cancelled', 'completed', 'denied']);
    for (const s of terminal) expect(isPickingSettled(s)).toBe(false);
  });

  it('names only statuses the state machine actually has', () => {
    for (const s of PICKING_SETTLED_STATUSES) {
      expect(Object.keys(ALLOWED_TRANSITIONS)).toContain(s);
    }
  });

  it('stays silent on an unknown or missing status', () => {
    expect(isPickingSettled(null)).toBe(false);
    expect(isPickingSettled(undefined)).toBe(false);
    expect(isPickingSettled('not_a_status')).toBe(false);
  });
});

describe('unpickedShortfall', () => {
  it('sums the un-picked remainder across lines once picking is settled', () => {
    const short = unpickedShortfall(
      [
        { quantityRequested: 42, quantityFulfilled: 0, quantityPicked: 40 },
        { quantityRequested: 10, quantityFulfilled: 0, quantityPicked: 7 },
      ],
      'packing_slip_generated',
    );
    expect(short).toBe(5);
  });

  it('is zero on a healthy, fully picked order', () => {
    expect(unpickedShortfall([line()], 'packing_slip_generated')).toBe(0);
  });

  it('stays silent before picking is finished even when units are outstanding', () => {
    const lines = [{ quantityRequested: 42, quantityFulfilled: 0, quantityPicked: 0 }];
    expect(unpickedShortfall(lines, 'approved')).toBe(0);
    expect(unpickedShortfall(lines, 'picking_in_progress')).toBe(0);
  });

  it('stays silent once the order has closed', () => {
    const lines = [{ quantityRequested: 42, quantityFulfilled: 40, quantityPicked: 0 }];
    expect(unpickedShortfall(lines, 'completed')).toBe(0);
    expect(unpickedShortfall(lines, 'cancelled')).toBe(0);
  });
});

describe('describeRaiseAfterPicking', () => {
  it('warns on the SO-000061 raise, naming the real number', () => {
    expect(
      describeRaiseAfterPicking({
        line: line(),
        nextRequested: 42,
        status: 'packing_slip_generated',
      }),
    ).toBe('Picking is already complete. Adding 2 more will leave this order short until they are picked.');
  });

  it('names both numbers when the line was ALREADY short before the raise', () => {
    expect(
      describeRaiseAfterPicking({
        line: { quantityRequested: 42, quantityFulfilled: 0, quantityPicked: 40 },
        nextRequested: 45,
        status: 'picking_complete',
      }),
    ).toBe('Picking is already complete. Adding 3 more leaves this order short by 5 units until they are picked.');
  });

  it('says nothing when the raise happens BEFORE picking finished', () => {
    expect(
      describeRaiseAfterPicking({
        line: { quantityRequested: 40, quantityFulfilled: 0, quantityPicked: 0 },
        nextRequested: 42,
        status: 'approved',
      }),
    ).toBeNull();
  });

  it('says nothing when the quantity is LOWERED', () => {
    expect(
      describeRaiseAfterPicking({ line: line(), nextRequested: 30, status: 'picking_complete' }),
    ).toBeNull();
  });

  it('says nothing when the quantity is unchanged', () => {
    expect(
      describeRaiseAfterPicking({ line: line(), nextRequested: 40, status: 'picking_complete' }),
    ).toBeNull();
  });

  it('says nothing when an over-pick already covers the raise', () => {
    expect(
      describeRaiseAfterPicking({
        line: { quantityRequested: 40, quantityFulfilled: 0, quantityPicked: 45 },
        nextRequested: 44,
        status: 'picking_complete',
      }),
    ).toBeNull();
  });

  it('uses the singular for a single unit', () => {
    expect(
      describeRaiseAfterPicking({
        line: { quantityRequested: 42, quantityFulfilled: 0, quantityPicked: 40 },
        nextRequested: 43,
        status: 'picking_complete',
      }),
    ).toBe('Picking is already complete. Adding 1 more leaves this order short by 3 units until they are picked.');
  });
});

describe('projectedLineShortfall', () => {
  it('projects the shortfall a proposed quantity would create', () => {
    expect(projectedLineShortfall(line(), 42, 'picking_complete')).toBe(2);
  });

  it('projects zero before picking is settled', () => {
    expect(projectedLineShortfall(line(), 42, 'pick_slip_generated')).toBe(0);
  });
});

describe('describeUnpickedShortfall', () => {
  it('names the count and what to do', () => {
    expect(
      describeUnpickedShortfall(
        [{ quantityRequested: 42, quantityFulfilled: 0, quantityPicked: 40 }],
        'packing_slip_generated',
      ),
    ).toBe(
      '2 units on this order have not been picked, and will be reported as owed when it is handed over.',
    );
  });

  it('uses the singular for one unit', () => {
    expect(
      describeUnpickedShortfall(
        [{ quantityRequested: 41, quantityFulfilled: 0, quantityPicked: 40 }],
        'staged_for_pickup',
      ),
    ).toBe(
      '1 unit on this order has not been picked, and will be reported as owed when it is handed over.',
    );
  });

  it('is null on a healthy order', () => {
    expect(describeUnpickedShortfall([line()], 'staged_for_pickup')).toBeNull();
  });
});

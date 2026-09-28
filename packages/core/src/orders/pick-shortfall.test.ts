import { describe, expect, it } from 'vitest';

import { ALLOWED_TRANSITIONS, type OrderStatus } from '../order-state-machine';

import {
  describeDepartureRisk,
  describeFinalShortLines,
  describeRaiseAfterPicking,
  describeUnpickedShortfall,
  isPickingSettled,
  lineOwedUnits,
  lineUnpickedUnits,
  PICKING_SETTLED_STATUSES,
  projectedLineShortfall,
  unpickedShortfall,
  UNPICKED_SHORTFALL_TITLE,
  type DepartureAction,
  type DepartureLine,
  type ShortfallLine,
} from './pick-shortfall';
import { SHORT_LINE_FINAL_NOTE } from './short-line-actions';

function line(over: Partial<ShortfallLine> = {}): ShortfallLine {
  return { quantityRequested: 40, quantityFulfilled: 0, quantityPicked: 40, ...over };
}

describe('lineOwedUnits', () => {
  it('is requested minus handed over', () => {
    expect(lineOwedUnits({ quantityRequested: 6, quantityFulfilled: 2 })).toBe(4);
  });

  it('does not subtract picked units: staged is still owed', () => {
    expect(lineOwedUnits({ ...line(), quantityRequested: 40, quantityFulfilled: 0 })).toBe(40);
  });

  it('floors an over-fulfilled line at zero, so it never eats a sibling line\'s share', () => {
    expect(lineOwedUnits({ quantityRequested: 5, quantityFulfilled: 7 })).toBe(0);
  });

  it('treats nulls and garbage as zero', () => {
    expect(lineOwedUnits({ quantityRequested: 5, quantityFulfilled: null })).toBe(5);
    expect(lineOwedUnits({ quantityRequested: undefined, quantityFulfilled: 3 })).toBe(0);
    expect(lineOwedUnits({ quantityRequested: Number.NaN, quantityFulfilled: 0 })).toBe(0);
  });
});

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

describe('describeDepartureRisk (the confirm before an order leaves, F2-2)', () => {
  // SO-000100 (2026-09-22): the pen line was zeroed by one-click completion,
  // and the order was in transit two minutes later with no prompt.
  const so100: DepartureLine[] = [
    { lineId: 'pens', itemName: 'L4L - Pen Black & Rose Gold', quantityRequested: 60, quantityFulfilled: 0, quantityPicked: 0 },
    { lineId: 'nb1', itemName: 'Notebook', quantityRequested: 30, quantityFulfilled: 0, quantityPicked: 30 },
    { lineId: 'nb2', itemName: 'Notebook', quantityRequested: 30, quantityFulfilled: 0, quantityPicked: 30 },
  ];

  it('SO-000100 before "Mark in transit": names the short line and what happens (the plan\'s words)', () => {
    const r = describeDepartureRisk({ lines: so100, status: 'staged_for_delivery', action: 'in_transit' });
    expect(r).toEqual({
      title: UNPICKED_SHORTFALL_TITLE,
      message:
        "1 line is short: 0 of 60 L4L - Pen Black & Rose Gold. Once the order is out for delivery its lines can't be changed, and these units will be owed at hand-over.",
      lines: [{ lineId: 'pens', itemName: 'L4L - Pen Black & Rose Gold', picked: 0, owed: 60, unpicked: 60 }],
      unpickedUnits: 60,
      confirmLabel: 'Send it anyway',
      cancelLabel: 'Fix the order',
    });
  });

  it('is null at a shortfall of 0 (every line picked), for every action', () => {
    const picked = so100.map((l) => ({ ...l, quantityPicked: l.quantityRequested }));
    for (const action of ['stage', 'in_transit', 'signature'] as DepartureAction[]) {
      expect(describeDepartureRisk({ lines: picked, status: 'staged_for_delivery', action })).toBeNull();
    }
    expect(describeDepartureRisk({ lines: [], status: 'staged_for_delivery', action: 'in_transit' })).toBeNull();
  });

  it('speaks exactly where the standing notice does (built on describeUnpickedShortfall)', () => {
    const statuses = Object.keys(ALLOWED_TRANSITIONS) as OrderStatus[];
    for (const status of statuses) {
      for (const action of ['stage', 'in_transit', 'signature'] as DepartureAction[]) {
        const risk = describeDepartureRisk({ lines: so100, status, action });
        expect(risk === null, `${status} ${action}`).toBe(describeUnpickedShortfall(so100, status) === null);
      }
    }
  });

  it('owed counts what was handed over; picked is the current batch', () => {
    const r = describeDepartureRisk({
      lines: [{ lineId: 'a', itemName: 'Maus I', quantityRequested: 10, quantityFulfilled: 4, quantityPicked: 3 }],
      status: 'packing_slip_generated',
      action: 'stage',
    });
    expect(r?.message).toBe(
      '1 line is short: 3 of 6 Maus I. If it leaves like this, these units will be owed at hand-over. Its lines can still be changed until it is out for delivery.',
    );
    expect(r?.unpickedUnits).toBe(3);
    expect(r?.confirmLabel).toBe('Stage it anyway');
    expect(r?.cancelLabel).toBe('Fix the order');
  });

  it('a signature before the order is out: the signature hands it over', () => {
    const r = describeDepartureRisk({ lines: so100, status: 'staged_for_pickup', action: 'signature' });
    expect(r?.message).toBe(
      '1 line is short: 0 of 60 L4L - Pen Black & Rose Gold. The signature hands the order over, and these units will be owed.',
    );
    expect(r?.confirmLabel).toBe('Record signature anyway');
    expect(r?.cancelLabel).toBe('Fix the order');
  });

  it('a signature out for delivery: the lines are final, so it offers Go back, never Fix the order', () => {
    const r = describeDepartureRisk({ lines: so100, status: 'in_transit', action: 'signature' });
    expect(r?.message).toBe(
      "1 line is short: 0 of 60 L4L - Pen Black & Rose Gold. Its lines can't be changed now, so these units will be owed at hand-over. Close partial ends the order afterwards if they will not be sent.",
    );
    expect(r?.confirmLabel).toBe('Record signature anyway');
    expect(r?.cancelLabel).toBe('Go back');
  });

  it('several lines: listed in order, the rest counted past five, quantities grouped', () => {
    const lines: DepartureLine[] = Array.from({ length: 7 }, (_, i) => ({
      lineId: `l${i}`,
      itemName: `Item ${i + 1}`,
      quantityRequested: 16693,
      quantityFulfilled: 0,
      quantityPicked: i,
    }));
    const r = describeDepartureRisk({ lines, status: 'staged_for_delivery', action: 'in_transit' });
    expect(r?.message.startsWith(
      '7 lines are short: 0 of 16,693 Item 1; 1 of 16,693 Item 2; 2 of 16,693 Item 3; 3 of 16,693 Item 4; 4 of 16,693 Item 5; and 2 more lines.',
    )).toBe(true);
    expect(r?.lines).toHaveLength(7);
    const six = lines.slice(0, 6);
    expect(describeDepartureRisk({ lines: six, status: 'staged_for_delivery', action: 'in_transit' })?.message).toContain(
      '; and 1 more line.',
    );
  });

  it('a line with no name is "An item", never blank', () => {
    const r = describeDepartureRisk({
      lines: [{ quantityRequested: 2, quantityFulfilled: 0, quantityPicked: 1, itemName: '  ' }],
      status: 'picking_complete',
      action: 'stage',
    });
    expect(r?.message.startsWith('1 line is short: 1 of 2 An item.')).toBe(true);
    expect(r?.lines[0]?.lineId).toBeNull();
  });

  it('honest words: no "book", no percentage, nothing guaranteed', () => {
    const all: string[] = [];
    for (const status of ['picking_complete', 'staged_for_pickup', 'staged_for_delivery', 'in_transit']) {
      for (const action of ['stage', 'in_transit', 'signature'] as DepartureAction[]) {
        const r = describeDepartureRisk({ lines: so100, status, action });
        if (r) all.push(r.title, r.message, r.confirmLabel, r.cancelLabel);
      }
    }
    expect(all.length).toBeGreaterThan(20);
    expect(all.filter((w) => /\bbooks?\b|%|guarantee|verified|email/i.test(w))).toEqual([]);
  });
});

describe('describeFinalShortLines (the order card once it is out for delivery, F2-2 walk F1)', () => {
  // Walk F1 (2026-09-28): the phone's order card showed the LINE's note,
  // "The order is out for delivery, so this line can't be changed. ...", where
  // no line is named and the rows cannot be tapped, so "this line" pointed at
  // nothing. The card's sentence names the short lines, in the departure
  // confirm's words; the line's own note (the web row) stays as it is.
  const so8: DepartureLine[] = [
    { lineId: 'nb', itemName: 'Phone Variant Notebook', quantityRequested: 5, quantityFulfilled: 0, quantityPicked: 5 },
    { lineId: 'pen', itemName: 'Phone Variant Pen', quantityRequested: 5, quantityFulfilled: 0, quantityPicked: 0 },
  ];
  const TAIL = 'The units not picked will be owed at hand-over; Close partial ends the order afterwards if they will not be sent.';

  it('names the short line, never "this line"', () => {
    expect(describeFinalShortLines(so8, 'in_transit')).toBe(
      "The order is out for delivery, so its lines can't be changed. 1 line is short: 0 of 5 Phone Variant Pen. " + TAIL,
    );
  });

  it('names every short line, in order, the rest counted past five (the departure confirm\'s list)', () => {
    const two: DepartureLine[] = [
      { lineId: 'a', itemName: 'L4L - Pen Black & Rose Gold', quantityRequested: 60, quantityFulfilled: 0, quantityPicked: 0 },
      { lineId: 'b', itemName: 'Notebook', quantityRequested: 30, quantityFulfilled: 0, quantityPicked: 30 },
      { lineId: 'c', itemName: 'Maus I', quantityRequested: 10, quantityFulfilled: 4, quantityPicked: 3 },
    ];
    expect(describeFinalShortLines(two, 'in_transit')).toBe(
      "The order is out for delivery, so its lines can't be changed. 2 lines are short: 0 of 60 L4L - Pen Black & Rose Gold; 3 of 6 Maus I. " +
        TAIL,
    );
    const seven: DepartureLine[] = Array.from({ length: 7 }, (_, i) => ({
      lineId: `l${i}`,
      itemName: `Item ${i + 1}`,
      quantityRequested: 16693,
      quantityFulfilled: 0,
      quantityPicked: i,
    }));
    expect(describeFinalShortLines(seven, 'in_transit')).toBe(
      "The order is out for delivery, so its lines can't be changed. 7 lines are short: 0 of 16,693 Item 1; 1 of 16,693 Item 2; " +
        '2 of 16,693 Item 3; 3 of 16,693 Item 4; 4 of 16,693 Item 5; and 2 more lines. ' +
        TAIL,
    );
    // The same list the departure confirm names at the same moment.
    const confirm = describeDepartureRisk({ lines: seven, status: 'in_transit', action: 'signature' })!;
    expect(describeFinalShortLines(seven, 'in_transit')).toContain(confirm.message.split(" Its lines can't")[0]!);
  });

  it('a line with no name is "An item", never blank', () => {
    expect(
      describeFinalShortLines([{ quantityRequested: 2, quantityFulfilled: 0, quantityPicked: 1, itemName: ' ' }], 'in_transit'),
    ).toContain('1 line is short: 1 of 2 An item. ');
  });

  it('ends with the line note\'s own words, so the card and the web row say the same thing', () => {
    const tailOfLineNote = SHORT_LINE_FINAL_NOTE.slice(SHORT_LINE_FINAL_NOTE.indexOf('The units not picked'));
    expect(tailOfLineNote).toBe(TAIL);
    expect(describeFinalShortLines(so8, 'in_transit')!.endsWith(` ${tailOfLineNote}`)).toBe(true);
  });

  it('only out for delivery (the lines are final), and only when a line is not fully picked', () => {
    const statuses = Object.keys(ALLOWED_TRANSITIONS) as OrderStatus[];
    for (const status of statuses) {
      expect(describeFinalShortLines(so8, status) === null, status).toBe(status !== 'in_transit');
    }
    expect(describeFinalShortLines(so8, null)).toBeNull();
    const picked = so8.map((l) => ({ ...l, quantityPicked: l.quantityRequested }));
    expect(describeFinalShortLines(picked, 'in_transit')).toBeNull();
    expect(describeFinalShortLines([], 'in_transit')).toBeNull();
  });

  it('honest words: no "book", no percentage, nothing guaranteed, and never "this line"', () => {
    const s = describeFinalShortLines(so8, 'in_transit')!;
    expect(s).not.toMatch(/\bbooks?\b|%|guarantee|verified/i);
    expect(s).not.toMatch(/this line/);
  });
});

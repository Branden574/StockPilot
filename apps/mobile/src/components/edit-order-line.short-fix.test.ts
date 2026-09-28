/**
 * F2-2 (decision D18) on the phone: a short line is fixed on the line, in the
 * line sheet, with core's one-tap fixes. What must hold:
 *   • before picking, a short line offers "Lower to N" (N = what stock covers)
 *     and "Remove line", from its readiness, and only for the full panel;
 *   • after picking, a line not fully picked offers "Lower to what was picked
 *     (N)" and "Remove from order", from the line alone;
 *   • Remove only when nothing was handed over or picked and the line is not
 *     the only one (the service's floors);
 *   • out for delivery the lines are final: a note, never a button;
 *   • a lower the lines route would refuse (a fractional quantity) is not
 *     offered.
 */
import {
  assessOrderReadiness,
  orderReadinessPhase,
  SHORT_LINE_FINAL_NOTE,
  SHORT_LINE_ONLY_LINE_NOTE,
  type OrderReadinessFacts,
  type ReadinessLineAssessment,
} from '@stockpilot/core';
import { describe, expect, it } from 'vitest';

import {
  orderLineShortFix,
  orderShortLinesFinalNote,
  type EditableOrderLine,
} from './edit-order-line';

const WH = 'wh';

function line(over: Partial<EditableOrderLine> = {}): EditableOrderLine {
  return {
    orderRequestLineId: 'l1',
    itemId: 'pens',
    name: 'L4L - Pen Black & Rose Gold',
    requested: 60,
    fulfilled: 0,
    picked: 0,
    returned: 0,
    ...over,
  };
}

/** The line's readiness before picking, with `onHand` on a rack. */
function readinessLine(
  onHand: number,
  over: { requested?: number; fulfilled?: number } = {},
): ReadinessLineAssessment {
  const status = 'picking_in_progress';
  const facts: OrderReadinessFacts = {
    v: 1,
    observedAt: '2026-09-22T18:46:30Z',
    phase: orderReadinessPhase(status),
    linesCapped: false,
    order: {
      id: 'o',
      orderNumber: 100,
      status,
      warehouseId: WH,
      neededBy: null,
      fulfillmentType: 'delivery',
    },
    lines: [
      {
        lineId: 'l1',
        itemId: 'pens',
        requested: over.requested ?? 60,
        fulfilled: over.fulfilled ?? 0,
        picked: null,
        createdAt: '2026-09-21T23:05:00Z',
      },
    ],
    items: [
      {
        itemId: 'pens',
        visible: true,
        name: 'L4L - Pen Black & Rose Gold',
        sku: null,
        supplierId: null,
        itemWarehouseId: WH,
        deleted: false,
        archived: false,
        isBundle: false,
        onHand,
        heldOwn: onHand,
        heldOtherOrders: 0,
        heldRentals: 0,
        here: { rack: onHand, site: 0, unplaced: 0, staging: 0 },
        elsewhere: { pickable: 0, staging: 0 },
        stagingSources: [],
        stagingHiddenQty: 0,
        pendingOthers: null,
        committedOtherShortfall: 0,
        inbound: null,
        drafts: null,
      },
    ],
  };
  const a = assessOrderReadiness(facts, { now: new Date('2026-09-22T18:47:00Z') });
  if (a.phase !== 'to_pick') throw new Error('to_pick expected');
  return a.lines[0]!;
}

describe('orderLineShortFix: before picking (from the line’s readiness)', () => {
  it('SO-000100: the pens written off to 0 offer Remove line only (nothing to lower to)', () => {
    expect(
      orderLineShortFix({
        status: 'picking_in_progress',
        line: line(),
        position: 2,
        totalLines: 2,
        readinessLine: readinessLine(0),
      }),
    ).toEqual({
      label: 'Short',
      actions: [{ kind: 'remove', label: 'Remove line' }],
      note: null,
      replacesRemove: true,
    });
  });

  it('with 40 on the shelf: Lower to 40, and Remove line', () => {
    const fix = orderLineShortFix({
      status: 'picking_in_progress',
      line: line(),
      position: 1,
      totalLines: 2,
      readinessLine: readinessLine(40),
    });
    expect(fix?.actions).toEqual([
      { kind: 'lower', quantity: 40, label: 'Lower to 40' },
      { kind: 'remove', label: 'Remove line' },
    ]);
  });

  it('the only line cannot be removed: core’s note says so, and replaces the sheet’s own refusal', () => {
    const fix = orderLineShortFix({
      status: 'picking_in_progress',
      line: line(),
      position: 1,
      totalLines: 1,
      readinessLine: readinessLine(40),
    });
    expect(fix).toEqual({
      label: 'Short',
      actions: [{ kind: 'lower', quantity: 40, label: 'Lower to 40' }],
      note: SHORT_LINE_ONLY_LINE_NOTE,
      replacesRemove: true,
    });
  });

  // Mutation caught: offering fixes from a check that was not made (a
  // requester's view: the covered number is a staff figure, decision D12).
  it('no readiness for the line (not read, failed, or not the full panel): nothing offered', () => {
    expect(
      orderLineShortFix({
        status: 'picking_in_progress',
        line: line(),
        position: 1,
        totalLines: 2,
        readinessLine: null,
      }),
    ).toBeNull();
    // Another line's readiness is never used for this one.
    expect(
      orderLineShortFix({
        status: 'picking_in_progress',
        line: line({ orderRequestLineId: 'l9' }),
        position: 1,
        totalLines: 2,
        readinessLine: readinessLine(0),
      }),
    ).toBeNull();
  });

  it('a line that is not short offers nothing', () => {
    expect(
      orderLineShortFix({
        status: 'picking_in_progress',
        line: line(),
        position: 1,
        totalLines: 2,
        readinessLine: readinessLine(60),
      }),
    ).toBeNull();
  });

  it('a lower to a fractional quantity is not offered (the route takes whole numbers)', () => {
    const fix = orderLineShortFix({
      status: 'picking_in_progress',
      line: line(),
      position: 1,
      totalLines: 2,
      readinessLine: readinessLine(40.5),
    });
    expect(fix?.actions).toEqual([{ kind: 'remove', label: 'Remove line' }]);
  });
});

describe('orderLineShortFix: after picking (from the line alone)', () => {
  it('nothing picked: Remove from order (and no lower below 1)', () => {
    expect(
      orderLineShortFix({
        status: 'packing_slip_generated',
        line: line(),
        position: 2,
        totalLines: 2,
        readinessLine: null,
      }),
    ).toEqual({
      label: 'Not fully picked',
      actions: [{ kind: 'remove', label: 'Remove from order' }],
      note: null,
      replacesRemove: true,
    });
  });

  // Mutation caught: offering Remove on a line with units picked (removeLine
  // refuses it: those units are staged).
  it('some picked: Lower to what was picked, never Remove', () => {
    const fix = orderLineShortFix({
      status: 'staged_for_delivery',
      line: line({ picked: 45 }),
      position: 1,
      totalLines: 2,
      readinessLine: null,
    });
    expect(fix).toEqual({
      label: 'Not fully picked',
      actions: [{ kind: 'lower', quantity: 45, label: 'Lower to what was picked (45)' }],
      note: null,
      replacesRemove: false,
    });
  });

  it('what was handed over counts as picked', () => {
    const fix = orderLineShortFix({
      status: 'staged_for_pickup',
      line: line({ fulfilled: 10, picked: 20 }),
      position: 1,
      totalLines: 3,
      readinessLine: null,
    });
    expect(fix?.actions).toEqual([
      { kind: 'lower', quantity: 30, label: 'Lower to what was picked (30)' },
    ]);
  });

  it('a fully picked line offers nothing', () => {
    expect(
      orderLineShortFix({
        status: 'staged_for_pickup',
        line: line({ picked: 60 }),
        position: 1,
        totalLines: 2,
        readinessLine: null,
      }),
    ).toBeNull();
  });

  it('out for delivery the line is final: a note, never a button', () => {
    expect(
      orderLineShortFix({
        status: 'in_transit',
        line: line({ picked: 45 }),
        position: 1,
        totalLines: 2,
        readinessLine: null,
      }),
    ).toEqual({
      label: 'Not fully picked',
      actions: [],
      note: SHORT_LINE_FINAL_NOTE,
      replacesRemove: false,
    });
  });

  it('a closed order, or a line with no id, offers nothing', () => {
    for (const status of ['completed', 'cancelled', 'pending_confirmation']) {
      expect(
        orderLineShortFix({
          status,
          line: line(),
          position: 1,
          totalLines: 2,
          readinessLine: null,
        }),
      ).toBeNull();
    }
    expect(
      orderLineShortFix({
        status: 'staged_for_pickup',
        line: line({ orderRequestLineId: null }),
        position: 1,
        totalLines: 2,
        readinessLine: null,
      }),
    ).toBeNull();
  });
});

describe('orderShortLinesFinalNote: the order card once it is out for delivery', () => {
  it('says the lines are final when a line is not fully picked', () => {
    expect(
      orderShortLinesFinalNote(
        [
          line({ orderRequestLineId: 'a', picked: 60 }),
          line({ orderRequestLineId: 'b', picked: 45 }),
        ],
        'in_transit',
      ),
    ).toBe(SHORT_LINE_FINAL_NOTE);
    expect(SHORT_LINE_FINAL_NOTE).toMatch(/can't be changed/);
    expect(SHORT_LINE_FINAL_NOTE).toMatch(/Close partial/);
  });

  it('says nothing when everything is picked, or the lines can still be fixed', () => {
    expect(orderShortLinesFinalNote([line({ picked: 60 })], 'in_transit')).toBeNull();
    expect(orderShortLinesFinalNote([line()], 'staged_for_delivery')).toBeNull();
    expect(orderShortLinesFinalNote([line()], 'picking_in_progress')).toBeNull();
    expect(orderShortLinesFinalNote([], 'in_transit')).toBeNull();
  });
});

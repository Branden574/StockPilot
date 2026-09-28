import { describe, expect, it } from 'vitest';

import { describeCompletionConfirm } from './readiness-copy';
import {
  assessOrderReadiness,
  orderReadinessPhase,
  projectCompletePicking,
  type OrderReadinessAssessment,
  type OrderReadinessFacts,
  type PickedLineAssessment,
  type ReadinessInboundFacts,
  type ReadinessItemFacts,
  type ReadinessLineAssessment,
  type ReadinessVisibleItemFacts,
} from './readiness';
import { SHORT_LINE_FINAL_NOTE, SHORT_LINE_ONLY_LINE_NOTE, shortLineActions } from './short-line-actions';

const NOW = '2026-09-28T17:42:00.000Z';

function item(itemId: string, over: Partial<ReadinessVisibleItemFacts> = {}): ReadinessVisibleItemFacts {
  const here = { rack: 0, site: 0, unplaced: 0, staging: 0, ...over.here };
  const elsewhere = { pickable: 0, staging: 0, ...over.elsewhere };
  return {
    itemId,
    visible: true,
    name: `Item ${itemId}`,
    sku: null,
    supplierId: null,
    itemWarehouseId: 'wh',
    deleted: false,
    archived: false,
    isBundle: false,
    heldOwn: 0,
    heldOtherOrders: 0,
    heldRentals: 0,
    stagingSources: [],
    stagingHiddenQty: 0,
    pendingOthers: null,
    committedOtherShortfall: 0,
    inbound: null,
    drafts: null,
    ...over,
    here,
    elsewhere,
    onHand: over.onHand ?? here.rack + here.site + here.unplaced + here.staging + elsewhere.pickable + elsewhere.staging,
  };
}

function assess(
  status: string,
  lines: Array<{ item: string; requested: number; fulfilled?: number; picked?: number | null }>,
  items: ReadinessItemFacts[],
): OrderReadinessAssessment {
  const facts: OrderReadinessFacts = {
    v: 1,
    observedAt: NOW,
    phase: orderReadinessPhase(status),
    linesCapped: false,
    order: { id: 'o', orderNumber: 100, status, warehouseId: 'wh', neededBy: null, fulfillmentType: 'delivery' },
    lines: lines.map((l, i) => ({
      lineId: `l${i + 1}`,
      itemId: l.item,
      requested: l.requested,
      fulfilled: l.fulfilled ?? 0,
      picked: l.picked ?? null,
      createdAt: new Date(Date.UTC(2026, 8, 1, 0, 0, i)).toISOString(),
    })),
    items: phaseReadsItems(status) ? items : [],
  };
  return assessOrderReadiness(facts, { now: NOW });
}

function phaseReadsItems(status: string): boolean {
  return orderReadinessPhase(status) === 'to_pick';
}

function toPickLine(a: OrderReadinessAssessment, i = 0): ReadinessLineAssessment {
  if (a.phase !== 'to_pick') throw new Error('to_pick expected');
  return a.lines[i]!;
}

function pickedLine(a: OrderReadinessAssessment, i = 0): PickedLineAssessment {
  if (a.phase !== 'picked') throw new Error('picked expected');
  return a.lines[i]!;
}

describe('short-line actions, to pick (F2-2, D18)', () => {
  it('a short line offers "Lower to N" (N = what stock covers now) and "Remove line"', () => {
    // 10 asked; 4 on a rack and 2 in Staging cover 6; 4 are short.
    const a = assess('approved', [{ item: 'a', requested: 10 }, { item: 'b', requested: 1 }], [
      item('a', { heldOwn: 6, here: { rack: 4, site: 0, unplaced: 0, staging: 2 } }),
      item('b', { heldOwn: 1, here: { rack: 1, site: 0, unplaced: 0, staging: 0 } }),
    ]);
    const line = toPickLine(a);
    expect(line.state).toBe('short');
    expect(shortLineActions({ phase: 'to_pick', line, isOnlyLine: false })).toEqual({
      actions: [
        { kind: 'lower', quantity: 6, label: 'Lower to 6' },
        { kind: 'remove', label: 'Remove line' },
      ],
      note: null,
    });
  });

  it('nothing covered: Remove only (a line is never lowered to 0)', () => {
    const a = assess('approved', [{ item: 'pen', requested: 60 }, { item: 'b', requested: 1 }], [
      item('pen', { onHand: 0 }),
      item('b', { heldOwn: 1, here: { rack: 1, site: 0, unplaced: 0, staging: 0 } }),
    ]);
    expect(shortLineActions({ phase: 'to_pick', line: toPickLine(a), isOnlyLine: false })).toEqual({
      actions: [{ kind: 'remove', label: 'Remove line' }],
      note: null,
    });
  });

  it('the only line is never removed, and says why', () => {
    const a = assess('approved', [{ item: 'pen', requested: 60 }], [item('pen', { onHand: 0 })]);
    expect(shortLineActions({ phase: 'to_pick', line: toPickLine(a), isOnlyLine: true })).toEqual({
      actions: [],
      note: SHORT_LINE_ONLY_LINE_NOTE,
    });
  });

  it('a resumed line counts what was handed over: Lower to handed over + covered, and never Remove', () => {
    // 10 asked, 4 handed over, 6 owed; 2 on a rack: lower to 6 (4 + 2).
    const a = assess('pick_slip_generated', [{ item: 'a', requested: 10, fulfilled: 4 }, { item: 'b', requested: 1 }], [
      item('a', { heldOwn: 2, here: { rack: 2, site: 0, unplaced: 0, staging: 0 } }),
      item('b', { heldOwn: 1, here: { rack: 1, site: 0, unplaced: 0, staging: 0 } }),
    ]);
    expect(shortLineActions({ phase: 'to_pick', line: toPickLine(a), isOnlyLine: false })).toEqual({
      actions: [{ kind: 'lower', quantity: 6, label: 'Lower to 6' }],
      note: null,
    });
  });

  it('a line already partly picked is never lowered below the pick, nor removed', () => {
    const a = assess('picking_in_progress', [{ item: 'a', requested: 10, picked: 5 }, { item: 'b', requested: 1, picked: 1 }], [
      item('a', { heldOwn: 3, here: { rack: 3, site: 0, unplaced: 0, staging: 0 } }),
      item('b', { heldOwn: 1, here: { rack: 1, site: 0, unplaced: 0, staging: 0 } }),
    ]);
    const line = toPickLine(a);
    expect(line.state).toBe('short');
    expect(shortLineActions({ phase: 'to_pick', line, isOnlyLine: false })).toEqual({ actions: [], note: null });
  });

  it('ready, put-away, hidden and handed-over lines offer nothing (none is short now)', () => {
    const a = assess('approved', [
      { item: 'ready', requested: 1 },
      { item: 'staged', requested: 2 },
      { item: 'hidden', requested: 1 },
      { item: 'done', requested: 2, fulfilled: 2 },
    ], [
      item('ready', { heldOwn: 1, here: { rack: 1, site: 0, unplaced: 0, staging: 0 } }),
      item('staged', { heldOwn: 2, here: { rack: 0, site: 0, unplaced: 0, staging: 2 } }),
      { itemId: 'hidden', visible: false },
      item('done', { here: { rack: 1, site: 0, unplaced: 0, staging: 0 } }),
    ]);
    if (a.phase !== 'to_pick') throw new Error('to_pick expected');
    expect(a.lines.map((l) => l.state)).toEqual(['ready', 'needs_put_away', 'unknown', 'handed_over']);
    for (const line of a.lines) {
      expect(shortLineActions({ phase: 'to_pick', line, isOnlyLine: false })).toEqual({ actions: [], note: null });
    }
  });

  it('a deleted item: Remove, as its sentence says', () => {
    const a = assess('approved', [{ item: 'gone', requested: 3 }, { item: 'b', requested: 1 }], [
      item('gone', { deleted: true, here: { rack: 3, site: 0, unplaced: 0, staging: 0 } }),
      item('b', { heldOwn: 1, here: { rack: 1, site: 0, unplaced: 0, staging: 0 } }),
    ]);
    expect(shortLineActions({ phase: 'to_pick', line: toPickLine(a), isOnlyLine: false })).toEqual({
      actions: [{ kind: 'remove', label: 'Remove line' }],
      note: null,
    });
  });
});

describe('short-line actions, picked (F2-2, D18)', () => {
  it('SO-000100: the zeroed pen line offers "Remove from order" only', () => {
    const a = assess('picking_complete', [
      { item: 'nb', requested: 30, picked: 30 },
      { item: 'pen', requested: 60, picked: 0 },
    ], []);
    expect(shortLineActions({ phase: 'picked', status: 'picking_complete', line: pickedLine(a, 1), isOnlyLine: false })).toEqual({
      actions: [{ kind: 'remove', label: 'Remove from order' }],
      note: null,
    });
    expect(shortLineActions({ phase: 'picked', status: 'picking_complete', line: pickedLine(a, 0), isOnlyLine: false })).toEqual({
      actions: [],
      note: null,
    });
  });

  it('a part-picked line offers "Lower to what was picked (N)", never Remove', () => {
    const a = assess('staged_for_delivery', [{ item: 'a', requested: 10, picked: 6 }, { item: 'b', requested: 1, picked: 1 }], []);
    expect(shortLineActions({ phase: 'picked', status: 'staged_for_delivery', line: pickedLine(a), isOnlyLine: false })).toEqual({
      actions: [{ kind: 'lower', quantity: 6, label: 'Lower to what was picked (6)' }],
      note: null,
    });
  });

  it('after a hand-over, N counts what was handed over too', () => {
    const a = assess('packing_slip_generated', [{ item: 'a', requested: 10, fulfilled: 4, picked: 3 }, { item: 'b', requested: 1, picked: 1 }], []);
    expect(shortLineActions({ phase: 'picked', status: 'packing_slip_generated', line: pickedLine(a), isOnlyLine: false })).toEqual({
      actions: [{ kind: 'lower', quantity: 7, label: 'Lower to what was picked (7)' }],
      note: null,
    });
  });

  it('Remove is offered only when picked + fulfilled = 0 and the line is not the last one', () => {
    const cases: Array<[string, { requested: number; fulfilled: number; picked: number | null }, boolean, boolean]> = [
      ['nothing picked or handed over, other lines', { requested: 5, fulfilled: 0, picked: 0 }, false, true],
      ['never picked (null), other lines', { requested: 5, fulfilled: 0, picked: null }, false, true],
      ['nothing picked, the only line', { requested: 5, fulfilled: 0, picked: 0 }, true, false],
      ['1 picked', { requested: 5, fulfilled: 0, picked: 1 }, false, false],
      ['1 handed over', { requested: 5, fulfilled: 1, picked: 0 }, false, false],
    ];
    for (const [name, l, isOnlyLine, removable] of cases) {
      const a = assess('picking_complete', [{ item: 'a', ...l }, ...(isOnlyLine ? [] : [{ item: 'b', requested: 1, picked: 1 }])], []);
      const r = shortLineActions({ phase: 'picked', status: 'picking_complete', line: pickedLine(a), isOnlyLine });
      expect(r.actions.some((x) => x.kind === 'remove'), name).toBe(removable);
      if (isOnlyLine && l.fulfilled + (l.picked ?? 0) === 0) expect(r.note, name).toBe(SHORT_LINE_ONLY_LINE_NOTE);
    }
  });

  it('out for delivery the lines are final: no action, and the note says what happens', () => {
    const a = assess('in_transit', [{ item: 'pen', requested: 60, picked: 0 }, { item: 'nb', requested: 30, picked: 30 }], []);
    expect(shortLineActions({ phase: 'picked', status: 'in_transit', line: pickedLine(a), isOnlyLine: false })).toEqual({
      actions: [],
      note: SHORT_LINE_FINAL_NOTE,
    });
  });

  it('honest words', () => {
    expect([SHORT_LINE_FINAL_NOTE, SHORT_LINE_ONLY_LINE_NOTE].filter((w) => /\bbooks?\b|%|guarantee/i.test(w))).toEqual([]);
  });

  // Walk F1 (2026-09-28): the phone's order card gets its own sentence, naming
  // the short lines (describeFinalShortLines). The line's note, which the web
  // shows on the row itself, keeps its words.
  it("the line's own note is unchanged: it sits on the row, where 'this line' has a line", () => {
    expect(SHORT_LINE_FINAL_NOTE).toBe(
      "The order is out for delivery, so this line can't be changed. The units not picked will be owed at hand-over; Close partial ends the order afterwards if they will not be sent.",
    );
  });
});

describe('short-line actions: a lower is always to a whole number (integration fix)', () => {
  // The line edits take whole numbers only (the web action's and the lines
  // route's quantity is .int()), so a lower to 40.5 would be refused with
  // "Invalid input". The phone already dropped such a lower on its own; the
  // web offered it. Core decides for both now.
  it('to pick: stock covering 40.5 of 60 offers Remove only, no "Lower to 40.5"', () => {
    const a = assess('approved', [{ item: 'a', requested: 60 }, { item: 'b', requested: 1 }], [
      item('a', { heldOwn: 40.5, here: { rack: 40.5, site: 0, unplaced: 0, staging: 0 } }),
      item('b', { heldOwn: 1, here: { rack: 1, site: 0, unplaced: 0, staging: 0 } }),
    ]);
    const line = toPickLine(a);
    expect(line.state).toBe('short');
    expect(shortLineActions({ phase: 'to_pick', line, isOnlyLine: false })).toEqual({
      actions: [{ kind: 'remove', label: 'Remove line' }],
      note: null,
    });
  });

  it('picked: 2.5 picked of 10 offers no "Lower to what was picked (2.5)"', () => {
    const a = assess('packing_slip_generated', [{ item: 'a', requested: 10, picked: 2.5 }, { item: 'b', requested: 1, picked: 1 }], []);
    expect(shortLineActions({ phase: 'picked', status: 'packing_slip_generated', line: pickedLine(a), isOnlyLine: false })).toEqual({
      actions: [],
      note: null,
    });
  });
});

// ── Every line the completion confirm names short offers its fix ─────────────
// Review 2026-09-28: the one-click confirm ("Not everything will be picked.
// L4L - Pen: 0 of 60 ... or you can remove it from the order first") also
// names a line waiting on a PO, or one whose records disagree, and "Review
// short lines" focuses it, yet only state 'short' offered Lower or Remove.
// A line is short now when stock does not cover what it owes (units.awaiting
// + units.short > 0), whatever its worst state; that is exactly when the
// one-click pick takes less than it owes.

function inbound(remaining: number): ReadinessInboundFacts {
  return {
    rows: [{ poId: 'po-1', poNumber: 'PO-2026-0042', status: 'ordered', expectedAt: '2026-10-03T16:00:00Z', remaining }],
    hiddenRemaining: 0,
    truncated: false,
    truncatedRemaining: 0,
  };
}

const B_READY = item('b', { heldOwn: 1, here: { rack: 1, site: 0, unplaced: 0, staging: 0 } });

describe('short-line actions: every line the completion confirm names short has its fix', () => {
  it('a line waiting on a PO with nothing on the shelf: the confirm names it, and it offers Remove line', () => {
    const a = assess('pick_slip_generated', [{ item: 'pen', requested: 60 }, { item: 'b', requested: 1 }], [
      item('pen', { onHand: 0, inbound: inbound(60) }),
      B_READY,
    ]);
    const line = toPickLine(a);
    expect(line.state).toBe('awaiting_po');
    const confirm = describeCompletionConfirm(projectCompletePicking(a), false);
    expect(confirm?.paragraphs[0]).toContain('Item pen: 0 of 60');
    expect(confirm?.focusLineId).toBe('l1');
    expect(shortLineActions({ phase: 'to_pick', line, isOnlyLine: false })).toEqual({
      actions: [{ kind: 'remove', label: 'Remove line' }],
      note: null,
    });
    // The only line: no Remove, and the note says why (never a bare line).
    expect(shortLineActions({ phase: 'to_pick', line, isOnlyLine: true })).toEqual({
      actions: [],
      note: SHORT_LINE_ONLY_LINE_NOTE,
    });
  });

  it('a line waiting on a PO for part of it: Lower to what stock covers now, and Remove line', () => {
    const a = assess('approved', [{ item: 'pen', requested: 60 }, { item: 'b', requested: 1 }], [
      item('pen', { heldOwn: 20, here: { rack: 20, site: 0, unplaced: 0, staging: 0 }, inbound: inbound(40) }),
      B_READY,
    ]);
    const line = toPickLine(a);
    expect(line.state).toBe('awaiting_po');
    expect(shortLineActions({ phase: 'to_pick', line, isOnlyLine: false })).toEqual({
      actions: [
        { kind: 'lower', quantity: 20, label: 'Lower to 20' },
        { kind: 'remove', label: 'Remove line' },
      ],
      note: null,
    });
  });

  it("a line whose records disagree and is short now: its fixes too (the confirm names it)", () => {
    // On record 30, the locations hold 10: "Can't confirm". 20 of it is
    // held for another order, so 10 of 40 are covered and a PO brings 30.
    const a = assess('pick_slip_generated', [{ item: 'a', requested: 40 }, { item: 'b', requested: 1 }], [
      item('a', {
        onHand: 30,
        heldOtherOrders: 20,
        here: { rack: 10, site: 0, unplaced: 0, staging: 0 },
        inbound: inbound(30),
      }),
      B_READY,
    ]);
    const line = toPickLine(a);
    expect(line.state).toBe('unknown');
    expect(line.reasons).toContain('records_disagree');
    const confirm = describeCompletionConfirm(projectCompletePicking(a), false);
    expect(confirm?.focusLineId).toBe('l1');
    expect(shortLineActions({ phase: 'to_pick', line, isOnlyLine: false })).toEqual({
      actions: [
        { kind: 'lower', quantity: 10, label: 'Lower to 10' },
        { kind: 'remove', label: 'Remove line' },
      ],
      note: null,
    });
  });

  it('property: over many stock situations, the confirm\'s focus line and every line it names short offer a fix or say why not', () => {
    let checked = 0;
    for (const onHand of [0, 5, 12, 60]) {
      for (const staging of [0, 4]) {
        for (const others of [0, 3, 50]) {
          for (const po of [0, 10, 60]) {
            for (const disagree of [0, 7]) {
              for (const isOnlyLine of [false, true]) {
                const rack = Math.max(0, onHand - staging - disagree);
                const lines = isOnlyLine ? [{ item: 'x', requested: 40 }] : [{ item: 'x', requested: 40 }, { item: 'b', requested: 1 }];
                const a = assess('pick_slip_generated', lines, [
                  item('x', {
                    onHand,
                    heldOtherOrders: others,
                    heldOwn: Math.max(0, Math.min(40, onHand - others)),
                    here: { rack, site: 0, unplaced: 0, staging: Math.min(staging, onHand) },
                    inbound: po > 0 ? inbound(po) : null,
                  }),
                  ...(isOnlyLine ? [] : [B_READY]),
                ]);
                if (a.phase !== 'to_pick') throw new Error('to_pick expected');
                const projection = projectCompletePicking(a)!;
                const confirm = describeCompletionConfirm(projection, false);
                const named = new Set(projection.shortLines.map((l) => l.lineId));
                if (confirm?.focusLineId && projection.shortLines.length > 0) named.add(confirm.focusLineId);
                for (const lineId of named) {
                  const line = a.lines.find((l) => l.lineId === lineId)!;
                  const fixes = shortLineActions({ phase: 'to_pick', line, isOnlyLine });
                  const situation = JSON.stringify({ onHand, staging, others, po, disagree, isOnlyLine, state: line.state });
                  expect(fixes.actions.length > 0 || fixes.note !== null, situation).toBe(true);
                  checked += 1;
                }
              }
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(50);
  });
});

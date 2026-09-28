import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
  COMPLETION_CONFIRM_LABEL,
  COMPLETION_CONFIRM_TITLE,
  COMPLETION_REVIEW_LABEL,
  describeCompletionConfirm,
  describeCompletionProjection,
  describeShortPickLines,
  describeReadinessForRequester,
  digitalPickCompletionConfirm,
  describeReadinessHold,
  describeReadinessLine,
  describeReadinessRollup,
  describeReadinessWhy,
  formatReadinessQty,
  INSUFFICIENT_PLACED_STOCK_COPY,
  neededBySignalCopy,
  READINESS_NEEDS_CONNECTION_COPY,
  readinessCheckedAtCopy,
  readinessLineAccessibilityLabel,
  READINESS_FORBIDDEN_COPY,
  READINESS_MODULE_OFF_COPY,
  READINESS_ORDER_NOT_FOUND_COPY,
  readinessFailureDetail,
  readinessOfflineCopy,
  readinessSummaryForRequester,
  REQUESTER_CHECK_FAILED_COPY,
} from './readiness-copy';
import {
  assessOrderReadiness,
  orderReadinessPhase,
  PICKED_LINE_STATES,
  projectCompletePicking,
  READINESS_ORDER_CHANGED_COPY,
  READINESS_STATES,
  type OrderReadinessAssessment,
  type OrderReadinessFacts,
  type ReadinessItemFacts,
  type ReadinessVisibleItemFacts,
} from './readiness';
import { approveShortNotice, orderStockGates } from './order-stock-gates';

const TZ = 'America/Los_Angeles';
const NOW = '2026-09-28T17:42:00.000Z'; // 10:42 AM in Los Angeles

function item(itemId: string, over: Partial<ReadinessVisibleItemFacts> = {}): ReadinessVisibleItemFacts {
  const here = { rack: 0, site: 0, unplaced: 0, staging: 0, ...over.here };
  const elsewhere = { pickable: 0, staging: 0, ...over.elsewhere };
  return {
    itemId,
    visible: true,
    name: over.name ?? `Item ${itemId}`,
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
    pendingOthers: { orders: 0, units: 0 },
    committedOtherShortfall: 0,
    inbound: { rows: [], hiddenRemaining: 0, truncated: false, truncatedRemaining: 0 },
    drafts: { rows: [], hiddenRemaining: 0, truncated: false, truncatedRemaining: 0 },
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
  neededBy: string | null = null,
  linesCapped = false,
): OrderReadinessAssessment {
  const facts: OrderReadinessFacts = {
    v: 1,
    observedAt: NOW,
    phase: orderReadinessPhase(status),
    linesCapped,
    order: { id: 'o', orderNumber: 100, status, warehouseId: 'wh', neededBy, fulfillmentType: 'delivery', timeZone: TZ },
    lines: lines.map((l, i) => ({
      lineId: `l${i + 1}`,
      itemId: l.item,
      requested: l.requested,
      fulfilled: l.fulfilled ?? 0,
      picked: l.picked ?? null,
      createdAt: new Date(Date.UTC(2026, 8, 1, 0, 0, i)).toISOString(),
    })),
    items,
  };
  return assessOrderReadiness(facts, { now: NOW });
}

function only(a: OrderReadinessAssessment) {
  if (a.phase !== 'to_pick') throw new Error('to_pick expected');
  const line = a.lines[0]!;
  return { line, item: a.items.find((i) => i.itemId === line.itemId) ?? null, a };
}

const po = (poNumber: string, expectedAt: string | null, remaining: number) => ({
  poId: poNumber,
  poNumber,
  status: 'ordered',
  expectedAt,
  remaining,
});

const inbound = (rows: ReturnType<typeof po>[], hiddenRemaining = 0, truncatedRemaining = 0) => ({
  rows,
  hiddenRemaining,
  truncated: truncatedRemaining > 0,
  truncatedRemaining,
});

/** One sentence per scenario the plan's copy table names. */
function lineSentence(
  lines: Array<{ item: string; requested: number; fulfilled?: number }>,
  items: ReadinessItemFacts[],
  status = 'pending_approval',
): string {
  const { line, item: it } = only(assess(status, lines, items));
  return describeReadinessLine(line, it, { timeZone: TZ });
}

describe('line sentences (F2 plan section 6)', () => {
  it('ready', () => {
    expect(lineSentence([{ item: 'a', requested: 10 }], [item('a', { here: { rack: 10, site: 0, unplaced: 0, staging: 0 } })])).toBe(
      '10 on the shelf for this order.',
    );
    expect(lineSentence([{ item: 'a', requested: 20 }], [item('a', { here: { rack: 8, site: 0, unplaced: 12, staging: 0 } })])).toBe(
      '20 on the shelf for this order. Includes 12 with no rack recorded.',
    );
  });

  it('needs put-away', () => {
    expect(lineSentence([{ item: 'a', requested: 10 }], [item('a', { here: { rack: 6, site: 0, unplaced: 0, staging: 4 } })])).toBe(
      '6 on the shelf. 4 more are in Staging and must be put away before picking can take them.',
    );
    expect(lineSentence([{ item: 'a', requested: 1 }], [item('a', { here: { rack: 0, site: 0, unplaced: 0, staging: 4 } })])).toBe(
      '1 is in Staging and must be put away before picking can take it.',
    );
  });

  it("a PO's expected date is the calendar day typed (stored as midnight UTC), never the day before in the org's zone", () => {
    // The PO form saves <input type="date"> 2026-10-03 as 2026-10-03T00:00:00Z,
    // which is Oct 2, 5 PM in Los Angeles.
    expect(lineSentence([{ item: 'a', requested: 4 }], [item('a', { inbound: inbound([po('PO-2026-0042', '2026-10-03T00:00:00Z', 12)]) })])).toBe(
      '4 short now. PO-2026-0042 expects 12 on Oct 3 (an expected date, not a promise).',
    );
    const { item: it } = only(
      assess('pending_approval', [{ item: 'a', requested: 4 }], [item('a', { inbound: inbound([po('PO-2026-0042', '2026-10-03T00:00:00Z', 12)]) })]),
    );
    expect(describeReadinessWhy(it!, { timeZone: TZ }).parts).toContain(
      'On order PO-2026-0042: 12 expected Oct 3 (an expected date, not a promise)',
    );
  });

  it('waiting on a PO: a date is expected, never promised', () => {
    expect(lineSentence([{ item: 'a', requested: 4 }], [item('a', { inbound: inbound([po('PO-2026-0042', '2026-10-03T16:00:00Z', 12)]) })])).toBe(
      '4 short now. PO-2026-0042 expects 12 on Oct 3 (an expected date, not a promise).',
    );
    expect(lineSentence([{ item: 'a', requested: 4 }], [item('a', { inbound: inbound([po('PO-2026-0042', null, 12)]) })])).toBe(
      '4 short now. PO-2026-0042 has 12 on order, with no expected date on the PO.',
    );
    expect(lineSentence([{ item: 'a', requested: 4 }], [item('a', { inbound: inbound([], 12) })])).toBe(
      "4 short now. 4 are on a PO you can't open.",
    );
    expect(lineSentence([{ item: 'a', requested: 4 }], [item('a', { inbound: inbound([], 0, 9) })])).toBe(
      '4 short now. 4 are on a PO not listed here, so no expected date is shown.',
    );
    expect(
      lineSentence(
        [{ item: 'a', requested: 8 }],
        [item('a', { here: { rack: 2, site: 0, unplaced: 0, staging: 0 }, inbound: inbound([po('PO-1', '2026-10-03T16:00:00Z', 3), po('PO-2', '2026-10-09T16:00:00Z', 9)]) })],
      ),
    ).toBe('2 on the shelf. 6 short now. PO-1 expects 3 on Oct 3 (an expected date, not a promise). 3 more are on another PO.');
    expect(
      lineSentence(
        [{ item: 'a', requested: 30 }],
        [item('a', { inbound: inbound([po('PO-1', '2026-10-03T16:00:00Z', 10), po('PO-2', null, 5)], 4, 3) })],
      ),
    ).toBe(
      "30 short now. PO-1 expects 10 on Oct 3 (an expected date, not a promise). 12 more are on other POs, 4 of them on POs you can't open. 8 of them are not on order.",
    );
  });

  it('short', () => {
    expect(lineSentence([{ item: 'a', requested: 4 }], [item('a')])).toBe('4 short. Nothing is on order.');
    expect(
      lineSentence(
        [{ item: 'a', requested: 4 }],
        [item('a', { drafts: { rows: [{ poId: 'd', poNumber: 'PO-2026-0043', remaining: 4 }], hiddenRemaining: 0, truncated: false, truncatedRemaining: 0 } })],
      ),
    ).toBe('4 short. Draft PO-2026-0043 covers 4 but has not been ordered.');
    expect(
      lineSentence([{ item: 'a', requested: 9 }], [item('a', { here: { rack: 2, site: 0, unplaced: 0, staging: 0 }, inbound: inbound([po('PO-1', '2026-10-03T16:00:00Z', 3)]) })]),
    ).toBe('2 on the shelf. 7 short now. PO-1 expects 3 on Oct 3 (an expected date, not a promise). 4 of them are not on order.');
    // The purchase_orders module off: nothing is claimed about POs at all.
    expect(lineSentence([{ item: 'a', requested: 4 }], [item('a', { inbound: null, drafts: null })])).toBe('4 short.');
    expect(lineSentence([{ item: 'a', requested: 4 }], [item('a', { deleted: true })])).toBe('This item was deleted. Remove the line.');
    expect(lineSentence([{ item: 'a', requested: 4 }], [item('a', { itemWarehouseId: 'wh-2' })])).toBe(
      'This item now belongs to another warehouse. Approval will refuse it.',
    );
  });

  it("what is on order but already needed by other orders is never \"nothing on order\"", () => {
    const taken = { inbound: inbound([po('PO-0042', '2026-10-03T00:00:00Z', 5)]), committedOtherShortfall: 5 };
    expect(lineSentence([{ item: 'a', requested: 4 }], [item('a', taken)])).toBe(
      '4 short. What is on order is already needed by other orders.',
    );
    // Part of it: the rest of the PO covers 2 of the 4.
    expect(
      lineSentence([{ item: 'a', requested: 4 }], [item('a', { ...taken, committedOtherShortfall: 3 })]),
    ).toBe(
      '4 short now. PO-0042 expects 5 on Oct 3 (an expected date, not a promise). 2 of them are not covered: the rest of what is on order is already needed by other orders.',
    );
    // A draft still says so, after the taken PO.
    expect(
      lineSentence(
        [{ item: 'a', requested: 4 }],
        [item('a', { ...taken, drafts: { rows: [{ poId: 'd', poNumber: 'PO-D', remaining: 4 }], hiddenRemaining: 0, truncated: false, truncatedRemaining: 0 } })],
      ),
    ).toBe('4 short. What is on order is already needed by other orders. Draft PO-D covers 4 but has not been ordered.');
    // Nothing at all on order is still "Nothing is on order."
    expect(lineSentence([{ item: 'a', requested: 4 }], [item('a', { committedOtherShortfall: 5 })])).toBe(
      '4 short. Nothing is on order.',
    );
    // Two lines of one item: the first takes the PO, the second says where it went.
    const two = assess('pending_approval', [{ item: 'a', requested: 5 }, { item: 'a', requested: 4 }], [
      item('a', { inbound: inbound([po('PO-0042', '2026-10-03T00:00:00Z', 5)]) }),
    ]);
    if (two.phase !== 'to_pick') throw new Error('to_pick expected');
    expect(describeReadinessLine(two.lines[1]!, two.items[0]!, { timeZone: TZ })).toBe(
      "4 short. What is on order is already needed by this item's other lines on this order.",
    );
  });

  it("can't confirm", () => {
    expect(lineSentence([{ item: 'a', requested: 4 }], [{ itemId: 'a', visible: false }])).toBe(
      "This item isn't visible to you, so its stock can't be checked.",
    );
    expect(lineSentence([{ item: 'a', requested: 4 }], [item('a', { onHand: 10, here: { rack: 7, site: 0, unplaced: 0, staging: 0 } })])).toBe(
      '4 on the shelf. On record: 10, but its locations account for 7. A count will settle it.',
    );
    expect(lineSentence([{ item: 'a', requested: 3 }], [item('a', { elsewhere: { pickable: 3, staging: 0 } })])).toBe(
      '3 are in another warehouse and are not counted here.',
    );
  });

  it('a line that owes nothing', () => {
    expect(lineSentence([{ item: 'a', requested: 4, fulfilled: 4 }], [item('a')], 'backordered')).toBe(
      'Nothing left to pick: all of this line was handed over.',
    );
    const { line } = only(assess('backordered', [{ item: 'a', requested: 4, fulfilled: 4 }], [item('a')]));
    expect(readinessLineAccessibilityLabel(line)).toBe('Line 1, Handed over, nothing left to pick');
    // An item the reader cannot see says the same: what is owed is on the line itself.
    expect(lineSentence([{ item: 'h', requested: 4, fulfilled: 4 }], [{ itemId: 'h', visible: false }], 'backordered')).toBe(
      'Nothing left to pick: all of this line was handed over.',
    );
  });

  it('short with a draft covering part of it', () => {
    expect(
      lineSentence(
        [{ item: 'a', requested: 9 }],
        [
          item('a', {
            inbound: inbound([po('PO-1', '2026-10-03T16:00:00Z', 4)]),
            drafts: { rows: [{ poId: 'd', poNumber: 'PO-D', remaining: 3 }], hiddenRemaining: 0, truncated: false, truncatedRemaining: 0 },
          }),
        ],
      ),
    ).toBe(
      '9 short now. PO-1 expects 4 on Oct 3 (an expected date, not a promise). 5 of them are not on order. Draft PO-D covers 3 but has not been ordered.',
    );
  });

  it('screen-reader labels name the line, its state and the number', () => {
    const { line } = only(assess('pending_approval', [{ item: 'a', requested: 4 }], [item('a', { here: { rack: 0, site: 0, unplaced: 0, staging: 4 } })]));
    expect(readinessLineAccessibilityLabel({ ...line, position: 2 })).toBe('Line 2, Needs put-away, 4 in Staging');
  });
});

describe('holds, why, needed-by, roll-up, requester, completion, offline', () => {
  it('holds', () => {
    expect(describeReadinessHold({ state: 'held', held: 10, of: 10 })).toBe('Held for this order');
    expect(describeReadinessHold({ state: 'partly_held', held: 20, of: 40 })).toBe('Held 20 of 40');
    expect(describeReadinessHold({ state: 'not_held', held: 0, of: 5 })).toBe('Not held: another order could take this stock.');
    expect(describeReadinessHold(null)).toBeNull();
  });

  it('why', () => {
    const { item: it } = only(
      assess('approved', [{ item: 'a', requested: 10 }], [
        item('a', {
          heldOwn: 10,
          heldOtherOrders: 7,
          heldRentals: 1,
          here: { rack: 16, site: 0, unplaced: 0, staging: 4 },
          pendingOthers: { orders: 2, units: 12 },
        }),
      ]),
    );
    expect(describeReadinessWhy(it!, { timeZone: TZ }).text).toBe(
      'On record 20 · Held for other orders 8, including 1 for rentals · Held for this order 10 · In Staging 4 · 2 other orders waiting for approval also ask for this item (12); stock is held by whichever is approved first',
    );
    const po2 = only(
      assess('pending_approval', [{ item: 'b', requested: 30 }], [
        item('b', {
          here: { rack: 0, site: 2, unplaced: 1, staging: 0 },
          elsewhere: { pickable: 3, staging: 0 },
          inbound: inbound([po('PO-9', '2026-10-03T16:00:00Z', 12), po('PO-10', null, 2)], 5, 4),
          drafts: { rows: [{ poId: 'd', poNumber: 'PO-D', remaining: 6 }], hiddenRemaining: 0, truncated: false, truncatedRemaining: 0 },
          isBundle: true,
        }),
      ]),
    );
    expect(describeReadinessWhy(po2.item!, { timeZone: TZ }).parts).toEqual([
      'On record 6',
      'No rack recorded 3',
      'In other warehouses 3, not counted here',
      'On order PO-9: 12 expected Oct 3 (an expected date, not a promise)',
      'On order PO-10: 2, no expected date',
      'On other POs 4',
      "On POs you can't open 5",
      'On draft PO-D 6 (not ordered)',
      "A kit: its stock is the kit's own",
    ]);
    const hidden = only(assess('pending_approval', [{ item: 'h', requested: 1 }], [{ itemId: 'h', visible: false }]));
    expect(describeReadinessWhy(hidden.item!).parts).toEqual(["This item isn't visible to you, so its stock can't be checked."]);
  });

  // F2-1 production walk (2026-09-28): an item on four draft POs of 25 each
  // said "On draft PO-1785135627464 100", the FIRST draft's number beside the
  // TOTAL of all four, so that PO read as holding 100. A draft's number is
  // named only when it is the only draft; otherwise the drafts are counted.
  describe('an item on several draft POs', () => {
    const draft = (poNumber: string, remaining: number) => ({ poId: poNumber, poNumber, remaining });
    const drafts = (rows: ReturnType<typeof draft>[], hiddenRemaining = 0, truncatedRemaining = 0) => ({
      rows,
      hiddenRemaining,
      truncated: truncatedRemaining > 0,
      truncatedRemaining,
    });
    const FOUR = drafts([draft('PO-1785135627464', 25), draft('PO-B', 25), draft('PO-C', 25), draft('PO-D', 25)]);
    const why = (d: ReturnType<typeof drafts>) =>
      describeReadinessWhy(only(assess('pending_approval', [{ item: 'a', requested: 100 }], [item('a', { drafts: d })])).item!, {
        timeZone: TZ,
      });

    it("the Why counts them beside their total, never one draft's number", () => {
      expect(why(FOUR).parts).toEqual(['On record 0', 'On 4 draft POs 100 (not ordered)']);
      expect(why(FOUR).text).not.toContain('PO-1785135627464');
      // One draft is still named, with its own quantity.
      expect(why(drafts([draft('PO-D', 6)])).parts).toContain('On draft PO-D 6 (not ordered)');
      // Past the facts' row cap (0377 lists 10): more than 10.
      const eleven = drafts(
        Array.from({ length: 10 }, (_, i) => draft(`PO-${i + 1}`, 10)),
        0,
        30,
      );
      expect(why(eleven).parts).toContain('On more than 10 draft POs 130 (not ordered)');
      // Drafts the reader can't open are a quantity only, as on-order POs are.
      expect(why(drafts([draft('PO-D', 20)], 5)).parts).toEqual([
        'On record 0',
        'On draft PO-D 20 (not ordered)',
        "On draft POs you can't open 5 (not ordered)",
      ]);
      expect(why(drafts([], 5)).parts).toEqual(['On record 0', "On draft POs you can't open 5 (not ordered)"]);
    });

    it('the line sentence says how many drafts cover the shortfall', () => {
      expect(lineSentence([{ item: 'a', requested: 60 }], [item('a', { drafts: FOUR })])).toBe(
        '60 short. 4 draft POs cover 60 but have not been ordered.',
      );
      expect(lineSentence([{ item: 'a', requested: 60 }], [item('a', { drafts: FOUR })])).not.toContain('PO-1785135627464');
      // One draft: named, as before.
      expect(lineSentence([{ item: 'a', requested: 4 }], [item('a', { drafts: drafts([draft('PO-D', 25)]) })])).toBe(
        '4 short. Draft PO-D covers 4 but has not been ordered.',
      );
      // A draft the reader can't open: how many there are is not known.
      expect(lineSentence([{ item: 'a', requested: 30 }], [item('a', { drafts: drafts([draft('PO-D', 20)], 5) })])).toBe(
        '30 short. Draft POs cover 25 but have not been ordered.',
      );
      expect(
        lineSentence([{ item: 'a', requested: 200 }], [item('a', { drafts: drafts(Array.from({ length: 10 }, (_, i) => draft(`PO-${i + 1}`, 10)), 0, 30) })]),
      ).toBe('200 short. More than 10 draft POs cover 130 but have not been ordered.');
    });
  });

  it('needed-by', () => {
    expect(neededBySignalCopy('past_due', '2026-09-20T19:00:00Z', { timeZone: TZ })).toBe('Past its needed-by date (Sep 20)');
    expect(neededBySignalCopy('at_risk', '2026-10-20T19:00:00Z')).toBe('May miss its needed-by date');
    expect(neededBySignalCopy(null, null)).toBeNull();
  });

  it('roll-up: green only when all ready; worst first; checked at', () => {
    const ready = assess('approved', Array.from({ length: 5 }, () => ({ item: 'a', requested: 1 })), [
      item('a', { heldOwn: 5, here: { rack: 5, site: 0, unplaced: 0, staging: 0 } }),
    ]);
    expect(describeReadinessRollup({ state: 'ok', assessment: ready }, { timeZone: TZ })).toEqual({
      headline: 'Ready to pick (5 of 5 lines)',
      tone: 'success',
      icon: 'check',
      details: [],
      neededBy: null,
      checkedAt: 'Checked at 10:42 AM. Stock can change after this.',
      detail: null,
    });
    const mixed = assess(
      'pending_approval',
      [
        { item: 'a', requested: 1 },
        { item: 'b', requested: 5 },
        { item: 'c', requested: 5 },
        { item: 'd', requested: 1 },
      ],
      [
        item('a', { here: { rack: 1, site: 0, unplaced: 0, staging: 0 } }),
        item('b', { here: { rack: 0, site: 0, unplaced: 0, staging: 5 } }),
        item('c', { here: { rack: 0, site: 0, unplaced: 0, staging: 5 } }),
        item('d'),
      ],
      '2026-10-20T19:00:00Z',
    );
    expect(describeReadinessRollup({ state: 'ok', assessment: mixed }, { timeZone: TZ })).toMatchObject({
      headline: '1 line short',
      tone: 'danger',
      details: ['2 lines need put-away', '1 of 4 lines ready to pick'],
      neededBy: 'May miss its needed-by date',
    });
    expect(describeReadinessRollup({ state: 'failed', message: 'x' })).toMatchObject({
      headline: "Couldn't check readiness. Try again.",
      checkedAt: null,
      detail: null,
    });
    // A failure with a reason of its own names it, the same words on both platforms.
    expect(describeReadinessRollup({ state: 'failed', message: READINESS_ORDER_CHANGED_COPY })).toMatchObject({
      headline: "Couldn't check readiness. Try again.",
      detail: 'The order changed while it was being checked. Check again.',
    });
    const capped = assess('pending_approval', [], [], null, true);
    expect(describeReadinessRollup({ state: 'ok', assessment: capped })!.headline).toBe(
      "This order has more than 200 lines, so readiness isn't checked.",
    );
    expect(describeReadinessRollup({ state: 'ok', assessment: assess('completed', [], []) })).toBeNull();
    const picked = assess('in_transit', [{ item: 'a', requested: 60, picked: 0 }, { item: 'b', requested: 1, picked: 1 }], []);
    expect(describeReadinessRollup({ state: 'ok', assessment: picked })).toMatchObject({
      headline: '1 line not fully picked',
      details: ['1 of 2 lines picked'],
    });
  });

  it('roll-up: handed-over lines are counted apart, never as ready to pick', () => {
    const backordered = assess(
      'backordered',
      [
        { item: 'a', requested: 2, fulfilled: 2 },
        { item: 'b', requested: 3, fulfilled: 3 },
        { item: 'c', requested: 4, fulfilled: 1 },
      ],
      [item('a'), item('b'), item('c')],
    );
    expect(describeReadinessRollup({ state: 'ok', assessment: backordered }, { timeZone: TZ })).toMatchObject({
      headline: '1 line short',
      details: ['0 of 1 line ready to pick', '2 lines handed over'],
    });
    const green = assess(
      'backordered',
      [
        { item: 'a', requested: 2, fulfilled: 2 },
        { item: 'c', requested: 4, fulfilled: 1 },
      ],
      [item('a'), item('c', { here: { rack: 3, site: 0, unplaced: 0, staging: 0 } })],
    );
    expect(describeReadinessRollup({ state: 'ok', assessment: green }, { timeZone: TZ })).toMatchObject({
      headline: 'Ready to pick (1 of 1 line)',
      tone: 'success',
      details: ['1 line handed over'],
    });
    const allHanded = assess('backordered', [{ item: 'a', requested: 2, fulfilled: 2 }], [item('a')]);
    expect(describeReadinessRollup({ state: 'ok', assessment: allHanded }, { timeZone: TZ })).toMatchObject({
      headline: 'Nothing left to pick: every line was handed over.',
      tone: 'neutral',
      details: [],
    });
    expect(readinessSummaryForRequester({ state: 'ok', assessment: allHanded })).toBeNull();
  });

  it('failure details: only the reasons both platforms can give, in core words', () => {
    expect(READINESS_ORDER_NOT_FOUND_COPY).toBe('Order not found.');
    expect(READINESS_FORBIDDEN_COPY).toBe('You are not allowed to check readiness for this order.');
    expect(READINESS_MODULE_OFF_COPY).toBe('Orders are turned off for this organization.');
    for (const m of [READINESS_ORDER_NOT_FOUND_COPY, READINESS_FORBIDDEN_COPY, READINESS_MODULE_OFF_COPY, READINESS_ORDER_CHANGED_COPY]) {
      expect(readinessFailureDetail({ state: 'failed', message: m })).toBe(m);
    }
    // An internal fault, no answer or an unreadable answer: the headline alone.
    for (const m of ['An internal error occurred. Please try again.', 'Could not check readiness.', 'x']) {
      expect(readinessFailureDetail({ state: 'failed', message: m })).toBeNull();
    }
    const fine = assess('approved', [{ item: 'a', requested: 1 }], [item('a', { here: { rack: 1, site: 0, unplaced: 0, staging: 0 } })]);
    expect(readinessFailureDetail({ state: 'ok', assessment: fine })).toBeNull();
  });

  it('requester: one sentence, no numbers', () => {
    const r = (a: OrderReadinessAssessment) => readinessSummaryForRequester({ state: 'ok', assessment: a });
    expect(r(assess('approved', [{ item: 'a', requested: 1 }], [item('a', { here: { rack: 0, site: 0, unplaced: 0, staging: 1 } })]))).toBe(
      'All items are in stock.',
    );
    expect(r(assess('approved', [{ item: 'a', requested: 1 }], [item('a')]))).toBe('Some items are waiting on stock.');
    expect(r(assess('approved', [{ item: 'a', requested: 1 }], [{ itemId: 'a', visible: false }]))).toBe(
      "We're checking stock for some items.",
    );
    // A failed check says it failed, never that stock is being checked.
    expect(readinessSummaryForRequester({ state: 'failed', message: 'x' })).toBe("Stock couldn't be checked just now.");
    expect(REQUESTER_CHECK_FAILED_COPY).toBe("Stock couldn't be checked just now.");
    expect(r(assess('in_transit', [{ item: 'a', requested: 1, picked: 1 }], []))).toBeNull();
  });

  it("requester view: the same layout on both platforms (the sentence, when it was checked, and its tone)", () => {
    const inStock = assess('approved', [{ item: 'a', requested: 1 }], [item('a', { here: { rack: 1, site: 0, unplaced: 0, staging: 0 } })]);
    expect(describeReadinessForRequester({ state: 'ok', assessment: inStock }, { timeZone: TZ })).toEqual({
      sentence: 'All items are in stock.',
      tone: 'success',
      icon: 'check',
      checkedAt: 'Checked at 10:42 AM. Stock can change after this.',
      failed: false,
    });
    const waiting = assess('approved', [{ item: 'a', requested: 1 }], [item('a')]);
    expect(describeReadinessForRequester({ state: 'ok', assessment: waiting }, { timeZone: TZ })).toMatchObject({
      sentence: 'Some items are waiting on stock.',
      tone: 'warning',
      icon: 'clock',
    });
    expect(describeReadinessForRequester({ state: 'failed', message: 'x' }, { timeZone: TZ })).toEqual({
      sentence: "Stock couldn't be checked just now.",
      tone: 'neutral',
      icon: 'help',
      checkedAt: null,
      failed: true,
    });
    expect(describeReadinessForRequester({ state: 'ok', assessment: assess('in_transit', [], []) })).toBeNull();
  });

  it('completion confirm', () => {
    const a = assess('pick_slip_generated', [{ item: 'pen', requested: 60 }, { item: 'maus', requested: 10 }], [
      item('pen', { name: 'L4L - Pen Black & Rose Gold', heldOwn: 60 }),
      item('maus', { name: 'Maus I', heldOwn: 10, here: { rack: 6, site: 0, unplaced: 0, staging: 4 } }),
    ]);
    expect(describeCompletionProjection(projectCompletePicking(a), false)).toEqual([
      'Not everything will be picked. L4L - Pen Black & Rose Gold: 0 of 60. It will be owed at hand-over, or you can remove it from the order first.',
      "Picking can't finish until 4 of Maus I in Staging are put away.",
    ]);
    expect(describeCompletionProjection(null, true)).toEqual(["Stock couldn't be checked. Picking may come up short."]);
    // On record 10, a rack of 7 and nothing in Staging: never "in Staging".
    const disagree = assess('pick_slip_generated', [{ item: 'pen', requested: 10 }], [
      item('pen', { name: 'Review pens', heldOwn: 10, onHand: 10, here: { rack: 7, site: 0, unplaced: 0, staging: 0 } }),
    ]);
    expect(describeCompletionProjection(projectCompletePicking(disagree), false)).toEqual([
      "Picking can't finish: 3 of Review pens are on record, but no location holds them. A count will settle it.",
    ]);
    const both = assess('pick_slip_generated', [{ item: 'pen', requested: 10 }], [
      item('pen', { name: 'Review pens', heldOwn: 10, onHand: 10, here: { rack: 6, site: 0, unplaced: 0, staging: 1 } }),
    ]);
    expect(describeCompletionProjection(projectCompletePicking(both), false)).toEqual([
      "Picking can't finish until 1 of Review pens in Staging is put away.",
      "Picking can't finish: 3 of Review pens are on record, but no location holds them. A count will settle it.",
    ]);
    const fine = assess('pick_slip_generated', [{ item: 'a', requested: 1 }], [item('a', { heldOwn: 1, here: { rack: 1, site: 0, unplaced: 0, staging: 0 } })]);
    expect(describeCompletionProjection(projectCompletePicking(fine), false)).toBeNull();
  });

  it('completion confirm (F2-2): the SO-000100 button', () => {
    // SO-000100: the pens were written off to 0 after approval; one-click
    // completion took 0 of 60 with no prompt.
    const so100 = assess('pick_slip_generated', [
      { item: 'nb', requested: 30 },
      { item: 'pen', requested: 60 },
      { item: 'nb', requested: 30 },
    ], [
      item('nb', { name: 'Notebook', heldOwn: 60, here: { rack: 60, site: 0, unplaced: 0, staging: 0 } }),
      item('pen', { name: 'L4L - Pen Black & Rose Gold', heldOwn: 60, onHand: 0 }),
    ]);
    expect(describeCompletionConfirm(projectCompletePicking(so100), false)).toEqual({
      title: 'Before you complete picking',
      paragraphs: [
        'Not everything will be picked. L4L - Pen Black & Rose Gold: 0 of 60. It will be owed at hand-over, or you can remove it from the order first.',
      ],
      reviewLabel: 'Review short lines',
      confirmLabel: 'Complete picking',
      focusLineId: 'l2',
    });
    // A pick that would fail (Staging) and nothing short: focus its line.
    const staging = assess('pick_slip_generated', [{ item: 'a', requested: 1 }, { item: 'maus', requested: 10 }], [
      item('a', { heldOwn: 1, here: { rack: 1, site: 0, unplaced: 0, staging: 0 } }),
      item('maus', { name: 'Maus I', heldOwn: 10, here: { rack: 6, site: 0, unplaced: 0, staging: 4 } }),
    ]);
    const c = describeCompletionConfirm(projectCompletePicking(staging), false);
    expect(c?.paragraphs).toEqual(["Picking can't finish until 4 of Maus I in Staging are put away."]);
    expect(c?.focusLineId).toBe('l2');
    // The check failed: the confirm is never skipped, and focuses nothing.
    expect(describeCompletionConfirm(null, true)).toEqual({
      title: 'Before you complete picking',
      paragraphs: ["Stock couldn't be checked. Picking may come up short."],
      reviewLabel: 'Review short lines',
      confirmLabel: 'Complete picking',
      focusLineId: null,
    });
    expect(describeCompletionConfirm(projectCompletePicking(so100), true)?.paragraphs).toEqual([
      "Stock couldn't be checked. Picking may come up short.",
    ]);
    // Nothing short, nothing failing, everything checked: no confirm.
    const fine = assess('pick_slip_generated', [{ item: 'a', requested: 1 }], [
      item('a', { heldOwn: 1, here: { rack: 1, site: 0, unplaced: 0, staging: 0 } }),
    ]);
    expect(describeCompletionConfirm(projectCompletePicking(fine), false)).toBeNull();
    // An item that cannot be checked: said, never skipped.
    const hidden = assess('pick_slip_generated', [{ item: 'h', requested: 1 }], [{ itemId: 'h', visible: false }]);
    expect(describeCompletionConfirm(projectCompletePicking(hidden), false)?.paragraphs).toEqual([
      "Stock couldn't be checked for 1 item. Picking may come up short.",
    ]);
  });

  it('the digital pick says the same sentence from what the picker entered', () => {
    expect(describeShortPickLines([{ itemName: 'Pens', batch: 60, owed: 60 }])).toBeNull();
    expect(describeShortPickLines([])).toBeNull();
    expect(describeShortPickLines([{ itemName: 'L4L - Pen Black & Rose Gold', batch: 0, owed: 60 }])).toBe(
      'Not everything will be picked. L4L - Pen Black & Rose Gold: 0 of 60. It will be owed at hand-over, or you can remove it from the order first.',
    );
    expect(
      describeShortPickLines([
        { itemName: 'Pens', batch: 2, owed: 60 },
        { itemName: 'Maus I', batch: 10, owed: 10 },
        { itemName: null, batch: null, owed: 1 },
      ]),
    ).toBe(
      'Not everything will be picked. Pens: 2 of 60; An item: 0 of 1. They will be owed at hand-over, or you can remove them from the order first.',
    );
  });

  it('the digital pick confirm (F2-2): the projection of what the picker entered, never skipped', () => {
    const lines = [
      { id: 'l1', itemName: 'Notebook', owed: 60, picking: 60 },
      { id: 'l2', itemName: 'L4L - Pen Black & Rose Gold', owed: 60, picking: 0 },
    ];
    const so100 = assess('picking_in_progress', [
      { item: 'nb', requested: 60 },
      { item: 'pen', requested: 60 },
    ], [
      item('nb', { name: 'Notebook', heldOwn: 60, here: { rack: 60, site: 0, unplaced: 0, staging: 0 } }),
      item('pen', { name: 'L4L - Pen Black & Rose Gold', heldOwn: 60, here: { rack: 60, site: 0, unplaced: 0, staging: 0 } }),
    ]);
    const ok = { state: 'ok' as const, assessment: so100 };
    // What was ENTERED decides the batch (the pens are on the rack, but the
    // picker entered 0).
    expect(digitalPickCompletionConfirm(lines, ok)).toEqual({
      title: 'Before you complete picking',
      paragraphs: [
        'Not everything will be picked. L4L - Pen Black & Rose Gold: 0 of 60. It will be owed at hand-over, or you can remove it from the order first.',
      ],
      reviewLabel: 'Review short lines',
      confirmLabel: 'Complete picking',
      focusLineId: 'l2',
    });
    // Everything entered and on the shelf: nothing to confirm.
    const full = lines.map((l) => ({ ...l, picking: 60 }));
    expect(digitalPickCompletionConfirm(full, ok)).toBeNull();
    // Entered in full, but 4 of the pens are in Staging: the pick would fail.
    const staged = assess('picking_in_progress', [{ item: 'pen', requested: 10 }], [
      item('pen', { name: 'Maus I', heldOwn: 10, here: { rack: 6, site: 0, unplaced: 0, staging: 4 } }),
    ]);
    expect(
      digitalPickCompletionConfirm([{ id: 'l1', itemName: 'Maus I', owed: 10, picking: 10 }], {
        state: 'ok',
        assessment: staged,
      })?.paragraphs,
    ).toEqual(["Picking can't finish until 4 of Maus I in Staging are put away."]);
    // Not read, failed, or read for other lines: what was entered is named,
    // and the check that could not be made is said. Never skipped.
    for (const readiness of [null, { state: 'failed' as const, message: 'x' }]) {
      expect(digitalPickCompletionConfirm(full, readiness)).toMatchObject({
        paragraphs: ["Stock couldn't be checked. Picking may come up short."],
        focusLineId: null,
      });
      expect(digitalPickCompletionConfirm(lines, readiness)).toMatchObject({
        paragraphs: [
          'Not everything will be picked. L4L - Pen Black & Rose Gold: 0 of 60. It will be owed at hand-over, or you can remove it from the order first.',
          "Stock couldn't be checked. Picking may come up short.",
        ],
        focusLineId: 'l2',
      });
    }
    const otherLines = [...lines, { id: 'l3', itemName: 'Added since', owed: 1, picking: 1 }];
    expect(digitalPickCompletionConfirm(otherLines, ok)?.paragraphs.at(-1)).toBe(
      "Stock couldn't be checked. Picking may come up short.",
    );
    // Line ids are matched whatever their case (Postgres and JS differ).
    expect(
      digitalPickCompletionConfirm(
        lines.map((l) => ({ ...l, id: l.id.toUpperCase() })),
        ok,
      )?.paragraphs,
    ).toHaveLength(1);
  });

  it('offline and the pick error', () => {
    expect(readinessOfflineCopy('2026-09-28T21:14:00Z', { timeZone: TZ })).toBe(
      "You're offline. This is how the order looked at 2:14 PM.",
    );
    expect(READINESS_NEEDS_CONNECTION_COPY).toBe('Needs a connection.');
    expect(readinessCheckedAtCopy('2026-09-28T21:14:00Z', { timeZone: TZ })).toBe(
      'Checked at 2:14 PM. Stock can change after this.',
    );
    // Both causes of insufficient_placed_stock, never a claim about Staging
    // the error cannot know (it is raised with nothing in Staging too).
    expect(INSUFFICIENT_PLACED_STOCK_COPY).toBe(
      "Picking takes stock from racks, crates, Sites and Unplaced, never from Staging, and they hold less of this item than the pick needs. Put away any of it that is in Staging, or count the item if its locations don't match its stock on record, then try again.",
    );
    expect(INSUFFICIENT_PLACED_STOCK_COPY).not.toMatch(/still in Staging/);
  });

  it('quantities read as people write them', () => {
    expect(formatReadinessQty(16693)).toBe('16,693');
    expect(formatReadinessQty(2.5)).toBe('2.5');
    expect(formatReadinessQty(Number.NaN)).toBe('0');
  });
});

// ── Honesty rules over EVERY sentence readiness can compose ────────────────

function everything(): string[] {
  const out: string[] = [];
  const scenarios: Array<[string, Array<{ item: string; requested: number; fulfilled?: number; picked?: number | null }>, ReadinessItemFacts[], string | null]> = [
    ['pending_approval', [{ item: 'a', requested: 10 }], [item('a', { here: { rack: 4, site: 2, unplaced: 1, staging: 2 } })], '2026-09-20T00:00:00Z'],
    ['approved', [{ item: 'a', requested: 10 }, { item: 'a', requested: 5 }], [item('a', { heldOwn: 8, heldOtherOrders: 2, heldRentals: 1, here: { rack: 20, site: 0, unplaced: 0, staging: 0 } })], null],
    ['pending_approval', [{ item: 'a', requested: 30 }], [item('a', { inbound: inbound([po('PO-1', '2026-10-03T16:00:00Z', 10), po('PO-2', null, 5)], 4, 3), drafts: { rows: [{ poId: 'd', poNumber: 'PO-D', remaining: 2 }], hiddenRemaining: 1, truncated: false, truncatedRemaining: 0 }, pendingOthers: { orders: 1, units: 3 } })], '2026-10-01T00:00:00Z'],
    ['pending_approval', [{ item: 'h', requested: 1 }, { item: 'd', requested: 1 }, { item: 'm', requested: 1 }], [{ itemId: 'h', visible: false }, item('d', { deleted: true }), item('m', { itemWarehouseId: 'x' })], null],
    ['pending_approval', [{ item: 'a', requested: 3 }], [item('a', { onHand: 9, here: { rack: 1, site: 0, unplaced: 0, staging: 0 }, elsewhere: { pickable: 2, staging: 1 }, isBundle: true })], null],
    ['backordered', [{ item: 'a', requested: 3, fulfilled: 3 }, { item: 'a', requested: 4, fulfilled: 1 }], [item('a', { inbound: null, drafts: null })], null],
    ['pick_slip_generated', [{ item: 'a', requested: 9 }, { item: 'h', requested: 1 }], [item('a', { heldOwn: 9, here: { rack: 2, site: 0, unplaced: 0, staging: 5 } }), { itemId: 'h', visible: false }], null],
    ['in_transit', [{ item: 'a', requested: 9, picked: 2 }], [], '2026-09-20T00:00:00Z'],
    ['pending_approval', [], [], null],
    ['pending_approval', [{ item: 'a', requested: 4 }, { item: 'a', requested: 4 }], [item('a', { inbound: inbound([po('PO-3', '2026-10-03T00:00:00Z', 5)]), committedOtherShortfall: 3 })], null],
    ['pick_slip_generated', [{ item: 'a', requested: 10 }], [item('a', { heldOwn: 10, onHand: 10, here: { rack: 6, site: 0, unplaced: 0, staging: 1 } })], null],
    ['backordered', [{ item: 'a', requested: 2, fulfilled: 2 }], [item('a')], null],
  ];
  for (const [status, lines, items, neededBy] of scenarios) {
    const a = assess(status, lines, items, neededBy);
    const r = describeReadinessRollup({ state: 'ok', assessment: a }, { timeZone: TZ });
    if (r) out.push(r.headline, ...r.details, ...(r.neededBy ? [r.neededBy] : []), ...(r.checkedAt ? [r.checkedAt] : []));
    const req = readinessSummaryForRequester({ state: 'ok', assessment: a });
    if (req) out.push(req);
    if (a.phase === 'to_pick') {
      for (const l of a.lines) {
        const it = a.items.find((i) => i.itemId === l.itemId) ?? null;
        out.push(describeReadinessLine(l, it, { timeZone: TZ }), readinessLineAccessibilityLabel(l));
        const h = describeReadinessHold(l.hold);
        if (h) out.push(h);
      }
      for (const it of a.items) out.push(...describeReadinessWhy(it, { timeZone: TZ }).parts);
      out.push(...(describeCompletionProjection(projectCompletePicking(a), false) ?? []));
    }
  }
  out.push(...(describeCompletionProjection(null, true) ?? []));
  out.push(COMPLETION_CONFIRM_TITLE, COMPLETION_REVIEW_LABEL, COMPLETION_CONFIRM_LABEL);
  out.push(
    describeShortPickLines([{ itemName: 'Pens', batch: 0, owed: 60 }])!,
    describeShortPickLines([{ itemName: 'Pens', batch: 2, owed: 60 }, { itemName: null, batch: null, owed: 1 }])!,
  );
  out.push(describeReadinessRollup({ state: 'failed', message: 'x' })!.headline);
  for (const m of [READINESS_ORDER_NOT_FOUND_COPY, READINESS_FORBIDDEN_COPY, READINESS_MODULE_OFF_COPY, READINESS_ORDER_CHANGED_COPY]) {
    out.push(describeReadinessRollup({ state: 'failed', message: m })!.detail!);
  }
  out.push(readinessSummaryForRequester({ state: 'failed', message: 'x' })!);
  out.push(readinessOfflineCopy(NOW, { timeZone: TZ }), READINESS_NEEDS_CONNECTION_COPY, INSUFFICIENT_PLACED_STOCK_COPY);
  for (const s of Object.values(READINESS_STATES)) out.push(s.label);
  for (const s of Object.values(PICKED_LINE_STATES)) out.push(s.label);
  for (const reason of ['read', 'hidden_items', 'lines_capped'] as const) {
    for (const status of ['pending_approval', 'backordered']) {
      const g = orderStockGates(status, { state: 'failed', reason, message: 'x' });
      if (g.notice) out.push(g.notice);
    }
  }
  const moved = orderStockGates('pending_approval', { state: 'ok', isShortStock: true, hasFulfillableStock: false, itemMoved: true });
  if (moved.notice) out.push(moved.notice);
  out.push(approveShortNotice({ state: 'ok', isShortStock: true, hasFulfillableStock: false, shortLineCount: 3 })!);
  out.push(approveShortNotice({ state: 'ok', isShortStock: true, hasFulfillableStock: false, itemMoved: true, shortLineCount: 1 })!);
  return out;
}

describe('honest words', () => {
  const lines = everything();

  it('covers the copy (not vacuous)', () => {
    expect(lines.length).toBeGreaterThan(60);
  });

  it('never "book" for a quantity, never a percentage', () => {
    expect(lines.filter((l) => /\bbooks?\b/i.test(l))).toEqual([]);
    expect(lines.filter((l) => l.includes('%'))).toEqual([]);
  });

  it('never "verified", "guaranteed", "will arrive", and never says an email was sent', () => {
    expect(lines.filter((l) => /verif|guarantee|will arrive|email/i.test(l))).toEqual([]);
  });

  it('"Ready" only for the ready state and the all-ready roll-up', () => {
    const allowed = new Set([READINESS_STATES.ready.label]);
    const offenders = lines.filter(
      (l) => /\bready\b/i.test(l) && !allowed.has(l) && !/^Ready to pick \(\d+ of \d+ lines?\)$/.test(l)
        && !/^\d+ of \d+ lines? ready to pick$/.test(l) && !/^Line \d+, Ready to pick, /.test(l),
    );
    expect(offenders).toEqual([]);
  });

  it('a PO date is always "expected", always with "not a promise"', () => {
    const dated = lines.filter((l) => /\bexpect(s|ed)?\b[^.]*\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d/.test(l));
    expect(dated.length).toBeGreaterThan(1);
    expect(dated.filter((l) => !l.includes('(an expected date, not a promise)'))).toEqual([]);
    // No date without "expected" either: "arrives Oct 3" would be a promise.
    expect(lines.filter((l) => /\b(arriv|deliver)\w*\b[^.]*\b(Oct|Nov) \d/i.test(l))).toEqual([]);
  });
});

// ── The source: no jargon can come back in a string literal ────────────────

describe('readiness source literals', () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const files = [
    'readiness.ts',
    'readiness-copy.ts',
    'order-stock-gates.ts',
    'order-hold.ts',
    'short-line-actions.ts',
    'pick-shortfall.ts',
  ];

  function literals(file: string): string[] {
    const source = ts.createSourceFile(file, readFileSync(path.join(HERE, file), 'utf8'), ts.ScriptTarget.Latest, true);
    const out: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node)) return;
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) out.push(node.text);
      else if (ts.isTemplateExpression(node)) {
        out.push(node.head.text + node.templateSpans.map((s) => '${…}' + s.literal.text).join(''));
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return out;
  }

  it.each(files)('%s says no "book", no "%", no "guarantee"', (file) => {
    const found = literals(file).filter((t) => /\bbooks?\b|%|guarantee|verified/i.test(t));
    expect(found).toEqual([]);
  });
});

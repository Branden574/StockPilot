import { describe, expect, it } from 'vitest';

import {
  describePartialPreview,
  describePartialResult,
  PARTIAL_ACTION_TITLE,
  PARTIAL_CLOSE_LABEL,
  PARTIAL_COMMIT_UNANSWERED_COPY,
  PARTIAL_PREVIEW_HIDDEN_ITEMS_COPY,
  PARTIAL_PREVIEW_ITEM_MOVED_COPY,
  PARTIAL_PREVIEW_LINES_CAPPED_COPY,
  PARTIAL_PREVIEW_NO_LINES_COPY,
  PARTIAL_PREVIEW_NOTE,
  PARTIAL_PREVIEW_NOTHING_TO_HOLD_COPY,
  PARTIAL_PREVIEW_READ_FAILED_COPY,
  previewPartialFulfilment,
  type PartialAction,
  type PartialPreview,
} from './partial-fulfilment';
import {
  assessOrderReadiness,
  orderReadinessPhase,
  type OrderReadinessFacts,
  type OrderReadinessResult,
  type ReadinessItemFacts,
  type ReadinessVisibleItemFacts,
} from './readiness';

// ── Builders (the shapes order_readiness_facts returns) ─────────────────────

const WH = 'wh-home';
const NOW = '2026-09-28T12:00:00.000Z';
const ORDER = '0f0f0f0f-0000-4000-8000-000000000001';

function item(itemId: string, over: Partial<ReadinessVisibleItemFacts> = {}): ReadinessVisibleItemFacts {
  const here = { rack: 0, site: 0, unplaced: 0, staging: 0, ...over.here };
  const elsewhere = { pickable: 0, staging: 0, ...over.elsewhere };
  const onHand =
    over.onHand ?? here.rack + here.site + here.unplaced + here.staging + elsewhere.pickable + elsewhere.staging;
  return {
    itemId,
    visible: true,
    name: `Item ${itemId}`,
    sku: `SKU-${itemId}`,
    supplierId: null,
    itemWarehouseId: WH,
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
    onHand,
  };
}

interface LineSpec {
  id: string;
  item: string;
  requested: number;
  fulfilled?: number;
}

function result(opts: {
  status: string;
  lines: LineSpec[];
  items: ReadinessItemFacts[];
  linesCapped?: boolean;
  orderId?: string;
}): OrderReadinessResult {
  const facts: OrderReadinessFacts = {
    v: 1,
    observedAt: NOW,
    phase: orderReadinessPhase(opts.status),
    linesCapped: opts.linesCapped ?? false,
    order: {
      id: opts.orderId ?? ORDER,
      orderNumber: 123,
      status: opts.status,
      warehouseId: WH,
      neededBy: null,
      fulfillmentType: 'pickup',
      timeZone: 'America/Los_Angeles',
    },
    lines: opts.linesCapped
      ? []
      : opts.lines.map((l, i) => ({
          lineId: l.id,
          itemId: l.item,
          requested: l.requested,
          fulfilled: l.fulfilled ?? 0,
          picked: null,
          createdAt: new Date(Date.UTC(2026, 8, 1, 10, 0, i)).toISOString(),
        })),
    items: opts.linesCapped ? [] : opts.items,
  };
  return { state: 'ok', assessment: assessOrderReadiness(facts, { now: NOW }) };
}

const onRack = (n: number) => ({ rack: n, site: 0, unplaced: 0, staging: 0 });

function okPreview(p: PartialPreview): Extract<PartialPreview, { state: 'ok' }> {
  if (p.state !== 'ok') throw new Error(`expected a preview, got ${p.reason}: ${p.message}`);
  return p;
}

// ── The frozen RPCs, restated line by line (the twin the preview must equal) ─

/**
 * approve_partial (0365) and resume_fulfillment (0348), as they run: lines in
 * item order, each holding least(asked, greatest(0, on_hand - every active
 * hold)), with the holds re-read after every insert. Returns what each ITEM
 * ends up holding (how duplicate lines split it is not defined, and not
 * compared).
 */
function rpcHolds(
  action: PartialAction,
  lines: LineSpec[],
  stock: Record<string, { onHand: number; holds: number }>,
): Map<string, number> {
  const holds = new Map(Object.entries(stock).map(([k, v]) => [k, v.holds]));
  const out = new Map<string, number>();
  for (const l of [...lines].sort((x, y) => (x.item < y.item ? -1 : x.item > y.item ? 1 : 0))) {
    const asked = action === 'approve_partial' ? l.requested : Math.max(0, l.requested - (l.fulfilled ?? 0));
    if (asked <= 0) continue;
    const free = Math.max(0, stock[l.item]!.onHand - holds.get(l.item)!);
    const hold = Math.min(asked, free);
    if (hold > 0) {
      holds.set(l.item, holds.get(l.item)! + hold);
      out.set(l.item, (out.get(l.item) ?? 0) + hold);
    }
  }
  return out;
}

// ── The preview ─────────────────────────────────────────────────────────────

describe('previewPartialFulfilment: approve partial', () => {
  it('holds min(asked, on hand less every active hold) per item: other orders\' and rental holds count', () => {
    const r = result({
      status: 'pending_approval',
      lines: [
        { id: 'L1', item: 'A', requested: 30 },
        { id: 'L2', item: 'B', requested: 10 },
      ],
      items: [
        item('A', { here: onRack(36), heldOtherOrders: 4, heldRentals: 2 }),
        item('B', { here: onRack(20) }),
      ],
    });
    const p = okPreview(previewPartialFulfilment(r, 'approve_partial'));
    expect(p.items.map((i) => [i.itemId, i.asked, i.willHold, i.backorder])).toEqual([
      ['A', 30, 30, 0],
      ['B', 10, 10, 0],
    ]);
    const tight = okPreview(
      previewPartialFulfilment(
        result({
          status: 'pending_approval',
          lines: [{ id: 'L1', item: 'A', requested: 40 }],
          items: [item('A', { here: onRack(36), heldOtherOrders: 4, heldRentals: 2 })],
        }),
        'approve_partial',
      ),
    );
    expect([tight.asked, tight.willHold, tight.backorder]).toEqual([40, 30, 10]);
  });

  it('combines duplicate lines per item and never splits them per line', () => {
    // 25 + 15 of A against 36 free: approve_partial holds 36 over the two
    // lines, split in no defined way. The preview says 36 of 40 for A.
    const r = result({
      status: 'pending_approval',
      lines: [
        { id: 'L1', item: 'A', requested: 25 },
        { id: 'L2', item: 'B', requested: 4 },
        { id: 'L3', item: 'A', requested: 15 },
      ],
      items: [item('A', { name: 'Maus I', here: onRack(36) }), item('B', { name: 'Pens', here: onRack(0) })],
    });
    const p = okPreview(previewPartialFulfilment(r, 'approve_partial'));
    expect(p.items).toEqual([
      { itemId: 'A', itemName: 'Maus I', itemSku: 'SKU-A', lineCount: 2, asked: 40, willHold: 36, backorder: 4, deleted: false },
      { itemId: 'B', itemName: 'Pens', itemSku: 'SKU-B', lineCount: 1, asked: 4, willHold: 0, backorder: 4, deleted: false },
    ]);
    expect([p.asked, p.willHold, p.backorder]).toEqual([44, 36, 8]);
    // No line is named anywhere in the preview.
    expect(JSON.stringify(p)).not.toMatch(/"L[123]"/);
    const copy = describePartialPreview(p)!;
    expect(copy.items.map((i) => [i.label, i.detail])).toEqual([
      ['Maus I (2 lines)', 'Holds 36 of 40'],
      ['Pens', 'Holds 0 of 4'],
    ]);
  });

  it('equals the frozen RPC line loop on 200 generated orders (duplicates, other holds, rentals)', () => {
    // mulberry32: a seeded generator whose low bits are not correlated.
    let seed = 20260928;
    const rnd = (n: number) => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
    };
    let compared = 0;
    let duplicates = 0;
    for (let c = 0; c < 200; c += 1) {
      const action: PartialAction = c % 2 === 0 ? 'approve_partial' : 'resume';
      const itemIds = ['A', 'B', 'C'].slice(0, 1 + rnd(3));
      const stock: Record<string, { onHand: number; holds: number }> = {};
      const items = itemIds.map((id) => {
        const rack = rnd(12);
        const other = rnd(6);
        const rental = rnd(3);
        stock[id] = { onHand: rack, holds: other + rental };
        return item(id, { here: onRack(rack), heldOtherOrders: other, heldRentals: rental });
      });
      const lines: LineSpec[] = Array.from({ length: 1 + rnd(4) }, (_, i) => {
        const requested = 1 + rnd(9);
        return {
          id: `L${i}`,
          item: itemIds[rnd(itemIds.length)]!,
          requested,
          fulfilled: action === 'resume' ? rnd(requested + 1) : 0,
        };
      });
      const r = result({ status: action === 'approve_partial' ? 'pending_approval' : 'backordered', lines, items });
      const want = rpcHolds(action, lines, stock);
      const p = previewPartialFulfilment(r, action);
      const total = [...want.values()].reduce((s, x) => s + x, 0);
      if (action === 'resume' && total === 0) {
        // resume_fulfillment raises no_fulfillable_stock.
        expect(p.state === 'unavailable' ? p.reason : p.state, `case ${c}`).toMatch(/nothing_to_hold|no_lines/);
        continue;
      }
      if (p.state !== 'ok') {
        expect(p.reason, `case ${c}`).toBe('no_lines');
        expect(total).toBe(0);
        continue;
      }
      for (const i of p.items) {
        expect(i.willHold, `case ${c} item ${i.itemId}`).toBe(want.get(i.itemId) ?? 0);
        compared += 1;
        if (i.lineCount > 1) duplicates += 1;
      }
      expect(p.willHold, `case ${c}`).toBe(total);
    }
    // Not vacuous: most cases compare, and duplicate-item lines are among them.
    expect(compared).toBeGreaterThan(100);
    expect(duplicates).toBeGreaterThan(20);
  }, 30_000);

  it('previews a deleted item as the RPC holds it (approve_partial does not skip it), flagged', () => {
    const r = result({
      status: 'pending_approval',
      lines: [{ id: 'L1', item: 'A', requested: 5 }],
      items: [item('A', { deleted: true, here: onRack(3) })],
    });
    const p = okPreview(previewPartialFulfilment(r, 'approve_partial'));
    expect(p.items[0]).toMatchObject({ willHold: 3, deleted: true });
  });
});

describe('previewPartialFulfilment: resume', () => {
  it('holds min(owed, free) per item; handed-over lines are left out', () => {
    const r = result({
      status: 'backordered',
      lines: [
        { id: 'L1', item: 'A', requested: 10, fulfilled: 6 },
        { id: 'L2', item: 'A', requested: 5, fulfilled: 5 },
        { id: 'L3', item: 'B', requested: 2, fulfilled: 2 },
      ],
      items: [item('A', { here: onRack(3) }), item('B', { here: onRack(9) })],
    });
    const p = okPreview(previewPartialFulfilment(r, 'resume'));
    expect(p.items).toEqual([
      { itemId: 'A', itemName: 'Item A', itemSku: 'SKU-A', lineCount: 1, asked: 4, willHold: 3, backorder: 1, deleted: false },
    ]);
    expect(describePartialPreview(p)!.summary).toBe(
      "Resume what's available: holds 3 of 4 units now. The other 1 ships when it arrives.",
    );
  });

  it('nothing free: resume_fulfillment would refuse, so the preview says so', () => {
    const r = result({
      status: 'backordered',
      lines: [{ id: 'L1', item: 'A', requested: 4 }],
      items: [item('A', { here: onRack(2), heldOtherOrders: 2 })],
    });
    expect(previewPartialFulfilment(r, 'resume')).toEqual({
      state: 'unavailable',
      action: 'resume',
      reason: 'nothing_to_hold',
      message: PARTIAL_PREVIEW_NOTHING_TO_HOLD_COPY,
    });
  });
});

describe('previewPartialFulfilment: never a guess', () => {
  const pending = (items: ReadinessItemFacts[], lines: LineSpec[] = [{ id: 'L1', item: 'A', requested: 5 }]) =>
    result({ status: 'pending_approval', lines, items });

  it.each<[string, OrderReadinessResult | null, PartialAction, string, string]>([
    ['a failed read', { state: 'failed', message: 'x' }, 'approve_partial', 'read_failed', PARTIAL_PREVIEW_READ_FAILED_COPY],
    ['no read', null, 'resume', 'read_failed', PARTIAL_PREVIEW_READ_FAILED_COPY],
    ['approve partial on an approved order', result({ status: 'approved', lines: [{ id: 'L1', item: 'A', requested: 5 }], items: [item('A')] }), 'approve_partial', 'wrong_status', 'This order is no longer waiting for approval.'],
    ['resume on a pending order', pending([item('A')]), 'resume', 'wrong_status', 'Only a backordered order can be resumed.'],
    ['past the line cap', result({ status: 'pending_approval', lines: [], items: [], linesCapped: true }), 'approve_partial', 'lines_capped', PARTIAL_PREVIEW_LINES_CAPPED_COPY],
    ['an item the reader cannot see', pending([{ itemId: 'A', visible: false }]), 'approve_partial', 'hidden_items', PARTIAL_PREVIEW_HIDDEN_ITEMS_COPY],
    ['an item that moved warehouse', pending([item('A', { itemWarehouseId: 'wh-other', here: onRack(5) })]), 'approve_partial', 'item_moved', PARTIAL_PREVIEW_ITEM_MOVED_COPY],
    ['no lines', pending([], []), 'approve_partial', 'no_lines', PARTIAL_PREVIEW_NO_LINES_COPY],
  ])('%s is unavailable, with the reason in words', (_label, r, action, reason, message) => {
    expect(previewPartialFulfilment(r, action)).toEqual({ state: 'unavailable', action, reason, message });
  });
});

// ── The preview, in words ───────────────────────────────────────────────────

describe('describePartialPreview', () => {
  const preview = (requested: number, onHand: number) =>
    okPreview(
      previewPartialFulfilment(
        result({ status: 'pending_approval', lines: [{ id: 'L1', item: 'A', requested }], items: [item('A', { here: onRack(onHand) })] }),
        'approve_partial',
      ),
    );

  it('"Approve what\'s available: holds 36 of 40 units now. The other 4 ship when they arrive."', () => {
    const copy = describePartialPreview(preview(40, 36))!;
    expect(copy.summary).toBe("Approve what's available: holds 36 of 40 units now. The other 4 ship when they arrive.");
    expect(copy.note).toBe(PARTIAL_PREVIEW_NOTE);
    expect(copy.note).toBe("Picking takes what's on the shelf; the rest ships when it arrives.");
    expect([copy.title, copy.confirmLabel, copy.cancelLabel]).toEqual(['Approve partial', 'Approve partial', 'Cancel']);
    expect(copy.items[0]!.accessibilityLabel).toBe('Item A, holds 36 of 40, 4 to ship when they arrive');
  });

  it('one left over, nothing held, everything held', () => {
    expect(describePartialPreview(preview(40, 39))!.summary).toBe(
      "Approve what's available: holds 39 of 40 units now. The other 1 ships when it arrives.",
    );
    expect(describePartialPreview(preview(40, 0))!.summary).toBe(
      "Approve what's available: holds 0 of 40 units now. All 40 ship when they arrive.",
    );
    expect(describePartialPreview(preview(1, 5))!.summary).toBe("Approve what's available: holds 1 of 1 unit now.");
  });

  it('is null for an unavailable preview (its message is the words)', () => {
    expect(describePartialPreview(previewPartialFulfilment(null, 'resume'))).toBeNull();
  });

  it("each action's name is one word set, the preview's title and confirm alike (web and phone read it here)", () => {
    expect(PARTIAL_ACTION_TITLE).toEqual({ approve_partial: 'Approve partial', resume: 'Resume fulfillment' });
    const resumeCopy = describePartialPreview(
      okPreview(
        previewPartialFulfilment(
          result({
            status: 'backordered',
            lines: [{ id: 'L1', item: 'A', requested: 10 }],
            items: [item('A', { here: onRack(4) })],
          }),
          'resume',
        ),
      ),
    )!;
    expect([resumeCopy.title, resumeCopy.confirmLabel]).toEqual([PARTIAL_ACTION_TITLE.resume, PARTIAL_ACTION_TITLE.resume]);
    const approveCopy = describePartialPreview(preview(40, 36))!;
    expect([approveCopy.title, approveCopy.confirmLabel]).toEqual([
      PARTIAL_ACTION_TITLE.approve_partial,
      PARTIAL_ACTION_TITLE.approve_partial,
    ]);
    expect(PARTIAL_CLOSE_LABEL).toBe('Close');
    expect(PARTIAL_COMMIT_UNANSWERED_COPY).toBe("The request didn't finish. Check the order before trying again.");
  });
});

// ── The result, from the re-read ────────────────────────────────────────────

describe('describePartialResult: computed from the re-read, never from the preview', () => {
  const lines = [
    { id: 'L1', item: 'A', requested: 25 },
    { id: 'L2', item: 'A', requested: 15 },
  ];
  const before = result({ status: 'pending_approval', lines, items: [item('A', { here: onRack(36) })] });
  const preview = okPreview(previewPartialFulfilment(before, 'approve_partial'));
  const after = (heldOwn: number, over: Partial<ReadinessVisibleItemFacts> = {}) =>
    result({ status: 'approved', lines, items: [item('A', { here: onRack(36), heldOwn, ...over })] });

  it('the preview said 36 of 40', () => {
    expect([preview.willHold, preview.asked]).toEqual([36, 40]);
  });

  it('"Approved. Holding 36 of 40 units." when the commit held what was shown', () => {
    expect(describePartialResult({ action: 'approve_partial', preview, reread: after(36) })).toEqual({
      tone: 'success',
      text: 'Approved. Holding 36 of 40 units.',
      held: 36,
      asked: 40,
      difference: 0,
    });
  });

  it('another session held 2 in between: "Holding 34 of 40 units, 2 fewer than shown" (mutation: echo the preview)', () => {
    const r = describePartialResult({ action: 'approve_partial', preview, reread: after(34, { heldOtherOrders: 2 }) });
    expect(r.text).toBe(
      'Approved. Holding 34 of 40 units, 2 fewer than shown because stock changed after you looked.',
    );
    expect(r).toMatchObject({ tone: 'warning', held: 34, asked: 40, difference: 2 });
    // Echoing the preview would say 36: the number comes from heldOwn.
    expect(r.text).not.toContain('Holding 36');
  });

  it('stock arrived in between: it says more, from the re-read', () => {
    expect(describePartialResult({ action: 'approve_partial', preview, reread: after(38, { here: onRack(38) }) }).text).toBe(
      'Approved. Holding 38 of 40 units, 2 more than shown because stock changed after you looked.',
    );
  });

  it('the total asked comes from the re-read too (a line changed in between)', () => {
    const reread = result({
      status: 'approved',
      lines: [...lines, { id: 'L3', item: 'B', requested: 5 }],
      items: [item('A', { here: onRack(36), heldOwn: 36 }), item('B', { heldOwn: 0 })],
    });
    expect(describePartialResult({ action: 'approve_partial', preview, reread }).text).toBe(
      'Approved. Holding 36 of 45 units.',
    );
  });

  it('the same total but a different split between items says so', () => {
    const twoItems = result({
      status: 'pending_approval',
      lines: [
        { id: 'L1', item: 'A', requested: 10 },
        { id: 'L2', item: 'B', requested: 10 },
      ],
      items: [item('A', { here: onRack(5) }), item('B', { here: onRack(5) })],
    });
    const p = okPreview(previewPartialFulfilment(twoItems, 'approve_partial'));
    const reread = result({
      status: 'approved',
      lines: [
        { id: 'L1', item: 'A', requested: 10 },
        { id: 'L2', item: 'B', requested: 10 },
      ],
      items: [item('A', { here: onRack(7), heldOwn: 7 }), item('B', { here: onRack(3), heldOwn: 3 })],
    });
    expect(describePartialResult({ action: 'approve_partial', preview: p, reread }).text).toBe(
      'Approved. Holding 10 of 20 units. Stock changed after you looked, so some items hold a different amount than shown.',
    );
  });

  it('resume: "Resumed. A new pick slip is ready. Holding 3 of 4 units, 1 fewer than shown"', () => {
    const rLines = [{ id: 'L1', item: 'A', requested: 10, fulfilled: 6 }];
    const p = okPreview(
      previewPartialFulfilment(result({ status: 'backordered', lines: rLines, items: [item('A', { here: onRack(4) })] }), 'resume'),
    );
    expect(p.willHold).toBe(4);
    const reread = result({ status: 'pick_slip_generated', lines: rLines, items: [item('A', { here: onRack(4), heldOwn: 3, heldOtherOrders: 1 })] });
    expect(describePartialResult({ action: 'resume', preview: p, reread }).text).toBe(
      'Resumed. A new pick slip is ready. Holding 3 of 4 units, 1 fewer than shown because stock changed after you looked.',
    );
  });

  it('without a preview it still states what the re-read holds, and compares nothing', () => {
    expect(describePartialResult({ action: 'approve_partial', preview: null, reread: after(34) })).toEqual({
      tone: 'success',
      text: 'Approved. Holding 34 of 40 units.',
      held: 34,
      asked: 40,
      difference: null,
    });
  });

  it.each<[string, OrderReadinessResult | null]>([
    ['a failed re-read', { state: 'failed', message: 'x' }],
    ['no re-read', null],
    ['an order that has moved past its holds', result({ status: 'picking_complete', lines, items: [] })],
    ['an order that was cancelled', result({ status: 'cancelled', lines, items: [] })],
    ['another order', result({ status: 'approved', lines, items: [item('A', { heldOwn: 36 })], orderId: '0f0f0f0f-0000-4000-8000-000000000002' })],
    ['an item the reader cannot see', result({ status: 'approved', lines, items: [{ itemId: 'A', visible: false }] })],
    ['a capped order', result({ status: 'approved', lines: [], items: [], linesCapped: true })],
  ])('%s claims no number: the commit went through, what is held is not known', (_label, reread) => {
    const r = describePartialResult({ action: 'approve_partial', preview, reread });
    expect(r).toEqual({
      tone: 'neutral',
      text: "Approved. What is held now couldn't be checked. Check again on the order.",
      held: null,
      asked: null,
      difference: null,
    });
    expect(r.text).not.toMatch(/\d/);
  });
});

describe('honest words (partial fulfilment)', () => {
  const lines = [{ id: 'L1', item: 'A', requested: 40 }];
  const pending = result({ status: 'pending_approval', lines, items: [item('A', { here: onRack(36) })] });
  const p = okPreview(previewPartialFulfilment(pending, 'approve_partial'));
  const copy = describePartialPreview(p)!;
  const all = [
    copy.title,
    copy.summary,
    copy.note,
    copy.confirmLabel,
    ...copy.items.flatMap((i) => [i.label, i.detail, i.accessibilityLabel]),
    PARTIAL_PREVIEW_READ_FAILED_COPY,
    PARTIAL_PREVIEW_LINES_CAPPED_COPY,
    PARTIAL_PREVIEW_HIDDEN_ITEMS_COPY,
    PARTIAL_PREVIEW_ITEM_MOVED_COPY,
    PARTIAL_PREVIEW_NO_LINES_COPY,
    PARTIAL_PREVIEW_NOTHING_TO_HOLD_COPY,
    PARTIAL_COMMIT_UNANSWERED_COPY,
    ...Object.values(PARTIAL_ACTION_TITLE),
    describePartialResult({ action: 'approve_partial', preview: p, reread: result({ status: 'approved', lines, items: [item('A', { here: onRack(36), heldOwn: 34 })] }) }).text,
    describePartialResult({ action: 'resume', preview: null, reread: null }).text,
  ];

  it('never "book" for a quantity, never a percentage, never "verified", "guaranteed" or "will arrive"', () => {
    expect(all.filter((s) => /\bbooks?\b|%|verif|guarantee|will arrive/i.test(s))).toEqual([]);
  });
});

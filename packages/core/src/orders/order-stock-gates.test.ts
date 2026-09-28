import { describe, expect, it } from 'vitest';

import { approveShortNotice, orderStockGates } from './order-stock-gates';
import { describeReadinessRollup } from './readiness-copy';
import {
  assessOrderReadiness,
  orderReadinessPhase,
  readinessStockFlags,
  type OrderReadinessFacts,
  type OrderStockCheck,
  type ReadinessVisibleItemFacts,
} from './readiness';

// ── The gates (ported from apps/mobile/src/lib/order-stock-check.test.ts) ──
// Every expectation below is the phone's, unchanged: moving the gates into
// core must not change what Approve partial and Resume do.

describe('orderStockGates', () => {
  const ok = (isShortStock: boolean, hasFulfillableStock: boolean): OrderStockCheck => ({
    state: 'ok',
    isShortStock,
    hasFulfillableStock,
  });
  const failedRead: OrderStockCheck = { state: 'failed', reason: 'read', message: 'x' };
  const hidden: OrderStockCheck = { state: 'failed', reason: 'hidden_items', message: 'x' };

  it('pending: Approve partial only when short, no notice', () => {
    expect(orderStockGates('pending_approval', ok(true, false))).toMatchObject({
      approvePartial: 'enabled',
      notice: null,
    });
    expect(orderStockGates('pending_approval', ok(false, false))).toMatchObject({
      approvePartial: 'hidden',
      notice: null,
    });
    expect(orderStockGates('pending_approval', { state: 'not_needed' })).toMatchObject({
      approvePartial: 'hidden',
      notice: null,
    });
  });

  it('pending, check failed: Approve partial disabled, with a retryable notice', () => {
    expect(orderStockGates('pending_approval', failedRead)).toEqual({
      approvePartial: 'disabled',
      resume: 'waiting',
      notice: 'Could not check stock for this order. Approve partial is unavailable until it loads.',
      canRetry: true,
    });
  });

  it('backordered: Resume when fulfillable, else the waiting line', () => {
    expect(orderStockGates('backordered', ok(false, true))).toMatchObject({
      resume: 'enabled',
      notice: null,
    });
    expect(orderStockGates('backordered', ok(false, false))).toMatchObject({
      resume: 'waiting',
      notice: null,
    });
  });

  it('backordered, check failed: Resume disabled (never the false "unlocks when back in stock")', () => {
    expect(orderStockGates('backordered', failedRead)).toEqual({
      approvePartial: 'hidden',
      resume: 'disabled',
      notice: 'Could not check stock for this order. Resume fulfillment is unavailable until it loads.',
      canRetry: true,
    });
  });

  it('a hidden item disables the action and says why, without a retry that cannot help', () => {
    expect(orderStockGates('pending_approval', hidden)).toEqual({
      approvePartial: 'disabled',
      resume: 'waiting',
      notice:
        'Some items on this order are not visible to you, so stock could not be checked. Approve partial is unavailable.',
      canRetry: false,
    });
    expect(orderStockGates('backordered', hidden)).toMatchObject({
      resume: 'disabled',
      canRetry: false,
    });
  });

  // ── New with readiness ──

  it('an order past the line cap disables the action (never zeros), with no retry', () => {
    const capped: OrderStockCheck = { state: 'failed', reason: 'lines_capped', message: 'x' };
    expect(orderStockGates('pending_approval', capped)).toEqual({
      approvePartial: 'disabled',
      resume: 'waiting',
      notice: 'This order has more than 200 lines, so stock is not checked here. Approve partial is unavailable.',
      canRetry: false,
    });
    expect(orderStockGates('backordered', capped)).toMatchObject({ resume: 'disabled', canRetry: false });
  });

  it('a moved item disables Approve partial and Resume: both RPCs refuse it', () => {
    const moved: OrderStockCheck = { state: 'ok', isShortStock: true, hasFulfillableStock: true, itemMoved: true };
    expect(orderStockGates('pending_approval', moved)).toEqual({
      approvePartial: 'disabled',
      resume: 'waiting',
      notice:
        'An item on this order now belongs to another warehouse, so this will be refused. Remove that line first. Approve partial is unavailable.',
      canRetry: false,
    });
    expect(orderStockGates('backordered', moved)).toMatchObject({ resume: 'disabled', canRetry: false });
  });

  it('other statuses offer neither', () => {
    expect(orderStockGates('approved', ok(true, true))).toEqual({
      approvePartial: 'hidden',
      resume: 'waiting',
      notice: null,
      canRetry: false,
    });
  });
});

describe('approveShortNotice', () => {
  it('names how many lines a strict Approve refuses', () => {
    expect(approveShortNotice({ state: 'ok', isShortStock: true, hasFulfillableStock: false, shortLineCount: 2 })).toBe(
      '2 lines ask for more than is available now, so Approve will be refused. Use Approve partial or change the lines.',
    );
    expect(approveShortNotice({ state: 'ok', isShortStock: true, hasFulfillableStock: false, shortLineCount: 1 })).toBe(
      '1 line asks for more than is available now, so Approve will be refused. Use Approve partial or change the lines.',
    );
  });

  it('never suggests Approve partial while an item that moved warehouse keeps it off', () => {
    const check = { state: 'ok' as const, isShortStock: true, hasFulfillableStock: false, itemMoved: true, shortLineCount: 2 };
    expect(orderStockGates('pending_approval', check).approvePartial).toBe('disabled');
    expect(approveShortNotice(check)).toBe(
      '2 lines ask for more than is available now, so Approve will be refused. Change the lines.',
    );
  });

  it('never calls its lines "short": the strip counts short lines by readiness, the note counts what Approve refuses', () => {
    // One order: line 1 is short now, line 2 waits on a PO (both refused by a
    // strict Approve), line 3 needs put-away (not refused).
    const a = assessOrderReadiness(
      {
        v: 1,
        observedAt: '2026-09-28T17:42:00.000Z',
        phase: 'to_pick',
        linesCapped: false,
        order: { id: 'o', orderNumber: 1, status: 'pending_approval', warehouseId: 'wh', neededBy: null, fulfillmentType: 'pickup', timeZone: 'UTC' },
        lines: ['a', 'b', 'c'].map((itemId, i) => ({
          lineId: `l${i + 1}`,
          itemId,
          requested: 4,
          fulfilled: 0,
          picked: null,
          createdAt: new Date(Date.UTC(2026, 8, 1, 0, 0, i)).toISOString(),
        })),
        items: [
          stockItem('a', {}),
          stockItem('b', { inbound: { rows: [{ poId: 'p', poNumber: 'PO-1', status: 'ordered', expectedAt: null, remaining: 9 }], hiddenRemaining: 0, truncated: false, truncatedRemaining: 0 } }),
          stockItem('c', { here: { rack: 0, site: 0, unplaced: 0, staging: 4 } }),
        ],
      },
      { now: '2026-09-28T17:42:00.000Z' },
    );
    const result = { state: 'ok' as const, assessment: a };
    expect(describeReadinessRollup(result)!.headline).toBe('1 line short');
    const note = approveShortNotice(readinessStockFlags(result));
    expect(note).toBe('2 lines ask for more than is available now, so Approve will be refused. Use Approve partial or change the lines.');
    expect(note).not.toMatch(/short/);
  });

  it('says nothing when Approve would pass or the check failed', () => {
    expect(approveShortNotice({ state: 'ok', isShortStock: false, hasFulfillableStock: false })).toBeNull();
    expect(approveShortNotice({ state: 'failed', reason: 'read', message: 'x' })).toBeNull();
    expect(approveShortNotice({ state: 'not_needed' })).toBeNull();
  });
});

// ── readinessStockFlags equals both old copies ───────────────────────────────
//
// The two copies readiness replaces, VERBATIM in arithmetic: the web order
// page's inline Tier-2 check (dashboard/orders/[id]/page.tsx) and the phone's
// computeOrderStockFlags (apps/mobile/src/lib/order-stock-check.ts). Both:
// per item, requested (pending) and owed (backordered) summed over its lines,
// available = max(0, on hand - every active hold).

interface OldLine {
  item_id: string | null;
  quantity_requested: number;
  quantity_fulfilled: number;
}

/** apps/web/src/app/(dashboard)/dashboard/orders/[id]/page.tsx, the needsStockCheck slot. */
function oldWebInlineFlags(
  status: string,
  lines: OldLine[],
  onHandById: Map<string, number>,
  reservedByItem: Map<string, number>,
) {
  const demandByItem = new Map<string, { requested: number; owed: number; onHand: number }>();
  for (const l of lines) {
    const itemId = l.item_id;
    if (!itemId) continue;
    const entry = demandByItem.get(itemId) ?? {
      requested: 0,
      owed: 0,
      onHand: Number(onHandById.get(itemId) ?? 0),
    };
    entry.requested += Number(l.quantity_requested) || 0;
    entry.owed += Math.max(0, (Number(l.quantity_requested) || 0) - (Number(l.quantity_fulfilled) || 0));
    demandByItem.set(itemId, entry);
  }
  let isShortStock = false;
  let hasFulfillableStock = false;
  for (const [itemId, d] of demandByItem) {
    const available = Math.max(0, d.onHand - (reservedByItem.get(itemId) ?? 0));
    if (status === 'pending_approval' && d.requested > available) isShortStock = true;
    if (status === 'backordered' && d.owed > 0 && available > 0) hasFulfillableStock = true;
  }
  return { isShortStock, hasFulfillableStock };
}

/** apps/mobile/src/lib/order-stock-check.ts computeOrderStockFlags. */
function oldComputeOrderStockFlags(
  status: string,
  lines: readonly OldLine[],
  onHandById: ReadonlyMap<string, number>,
  reservedById: ReadonlyMap<string, number>,
) {
  let isShortStock = false;
  let hasFulfillableStock = false;
  const demandByItem = new Map<string, { requested: number; owed: number }>();
  for (const l of lines) {
    if (!l.item_id) continue;
    const entry = demandByItem.get(l.item_id) ?? { requested: 0, owed: 0 };
    entry.requested += Number(l.quantity_requested) || 0;
    entry.owed += Math.max(0, (Number(l.quantity_requested) || 0) - (Number(l.quantity_fulfilled) || 0));
    demandByItem.set(l.item_id, entry);
  }
  for (const [itemId, d] of demandByItem) {
    const available = Math.max(0, (onHandById.get(itemId) ?? 0) - (reservedById.get(itemId) ?? 0));
    if (status === 'pending_approval' && d.requested > available) isShortStock = true;
    if (status === 'backordered' && d.owed > 0 && available > 0) hasFulfillableStock = true;
  }
  return { isShortStock, hasFulfillableStock };
}

interface Scenario {
  status: 'pending_approval' | 'backordered';
  lines: Array<{ item: string; requested: number; fulfilled: number }>;
  items: Record<string, { onHand: number; own: number; other: number; rental: number }>;
}

function readinessFlagsFor(s: Scenario) {
  const items: ReadinessVisibleItemFacts[] = Object.entries(s.items).map(([id, x]) => ({
    itemId: id,
    visible: true,
    name: id,
    sku: null,
    supplierId: null,
    itemWarehouseId: 'wh',
    deleted: false,
    archived: false,
    isBundle: false,
    onHand: x.onHand,
    heldOwn: x.own,
    heldOtherOrders: x.other,
    heldRentals: x.rental,
    here: { rack: x.onHand, site: 0, unplaced: 0, staging: 0 },
    elsewhere: { pickable: 0, staging: 0 },
    stagingSources: [],
    stagingHiddenQty: 0,
    pendingOthers: null,
    committedOtherShortfall: 0,
    inbound: null,
    drafts: null,
  }));
  const facts: OrderReadinessFacts = {
    v: 1,
    observedAt: '2026-09-28T00:00:00Z',
    phase: orderReadinessPhase(s.status),
    linesCapped: false,
    order: { id: 'o', orderNumber: 1, status: s.status, warehouseId: 'wh', neededBy: null, fulfillmentType: 'pickup' },
    lines: s.lines.map((l, i) => ({
      lineId: `l${i}`,
      itemId: l.item,
      requested: l.requested,
      fulfilled: l.fulfilled,
      picked: null,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    })),
    items,
  };
  const flags = readinessStockFlags({ state: 'ok', assessment: assessOrderReadiness(facts, { now: '2026-09-28T00:00:00Z' }) });
  if (flags.state !== 'ok') throw new Error(`unexpected ${flags.state}`);
  return { isShortStock: flags.isShortStock, hasFulfillableStock: flags.hasFulfillableStock };
}

function oldInputs(s: Scenario) {
  const lines: OldLine[] = s.lines.map((l) => ({
    item_id: l.item,
    quantity_requested: l.requested,
    quantity_fulfilled: l.fulfilled,
  }));
  const onHand = new Map(Object.entries(s.items).map(([id, x]) => [id, x.onHand]));
  const reserved = new Map(Object.entries(s.items).map(([id, x]) => [id, x.own + x.other + x.rental]));
  return { lines, onHand, reserved };
}

/** A small deterministic PRNG (mulberry32), so the table is the same every run. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generated(count: number, seed: number): Scenario[] {
  const rnd = prng(seed);
  const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
  const out: Scenario[] = [];
  for (let i = 0; i < count; i += 1) {
    const status = rnd() < 0.5 ? 'pending_approval' : 'backordered';
    const itemCount = int(1, 3);
    const ids = Array.from({ length: itemCount }, (_, j) => `i${j}`);
    const items = Object.fromEntries(
      ids.map((id) => {
        const onHand = int(0, 15);
        // An order's own holds exist only after approval: at these two
        // statuses the real data has none, but the old copies subtracted
        // every hold, so the table includes some to prove the same.
        return [id, { onHand, own: rnd() < 0.15 ? int(0, 4) : 0, other: int(0, 6), rental: int(0, 3) }];
      }),
    );
    const lines = Array.from({ length: int(1, 5) }, () => {
      const requested = int(1, 10);
      return {
        item: ids[int(0, itemCount - 1)]!,
        requested,
        fulfilled: status === 'backordered' ? int(0, requested + 1) : 0,
      };
    });
    out.push({ status, lines, items });
  }
  return out;
}

describe('readinessStockFlags equals both old stock checks', () => {
  const fixtures: Array<[string, Scenario]> = [
    ['duplicate-item lines summed before judging (3 + 3 against 5)', {
      status: 'pending_approval',
      lines: [{ item: 'a', requested: 3, fulfilled: 0 }, { item: 'a', requested: 3, fulfilled: 0 }],
      items: { a: { onHand: 5, own: 0, other: 0, rental: 0 } },
    }],
    ['available is on hand minus reserved (4 of 10 with 6 held)', {
      status: 'pending_approval',
      lines: [{ item: 'a', requested: 4, fulfilled: 0 }],
      items: { a: { onHand: 10, own: 0, other: 6, rental: 0 } },
    }],
    ['5 of 10 with 6 held is short', {
      status: 'pending_approval',
      lines: [{ item: 'a', requested: 5, fulfilled: 0 }],
      items: { a: { onHand: 10, own: 0, other: 4, rental: 2 } },
    }],
    ['a backorder with nothing owed is not fulfillable', {
      status: 'backordered',
      lines: [{ item: 'a', requested: 5, fulfilled: 5 }, { item: 'b', requested: 4, fulfilled: 1 }],
      items: { a: { onHand: 9, own: 0, other: 0, rental: 0 }, b: { onHand: 0, own: 0, other: 0, rental: 0 } },
    }],
    ['a backorder with an owed item in stock is fulfillable', {
      status: 'backordered',
      lines: [{ item: 'a', requested: 5, fulfilled: 5 }, { item: 'b', requested: 4, fulfilled: 1 }],
      items: { a: { onHand: 0, own: 0, other: 0, rental: 0 }, b: { onHand: 1, own: 0, other: 0, rental: 0 } },
    }],
  ];

  it.each(fixtures)('%s', (_name, s) => {
    const { lines, onHand, reserved } = oldInputs(s);
    const want = oldComputeOrderStockFlags(s.status, lines, onHand, reserved);
    expect(oldWebInlineFlags(s.status, lines, onHand, reserved)).toEqual(want);
    expect(readinessFlagsFor(s)).toEqual(want);
  });

  it('agree on a 200-case generated table', { timeout: 30_000 }, () => {
    const table = generated(200, 20260928);
    let short = 0;
    let fulfillable = 0;
    for (const [i, s] of table.entries()) {
      const { lines, onHand, reserved } = oldInputs(s);
      const want = oldComputeOrderStockFlags(s.status, lines, onHand, reserved);
      expect(oldWebInlineFlags(s.status, lines, onHand, reserved), `case ${i}`).toEqual(want);
      expect(readinessFlagsFor(s), `case ${i}`).toEqual(want);
      if (want.isShortStock) short += 1;
      if (want.hasFulfillableStock) fulfillable += 1;
    }
    // Not vacuous: both flags are exercised both ways.
    expect(short).toBeGreaterThanOrEqual(10);
    expect(fulfillable).toBeGreaterThanOrEqual(10);
    expect(table.filter((s) => s.status === 'pending_approval').length - short).toBeGreaterThanOrEqual(10);
    expect(table.filter((s) => s.status === 'backordered').length - fulfillable).toBeGreaterThanOrEqual(5);
  });
});

function stockItem(itemId: string, over: Partial<ReadinessVisibleItemFacts>): ReadinessVisibleItemFacts {
  const here = { rack: 0, site: 0, unplaced: 0, staging: 0, ...over.here };
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
    onHand: here.rack + here.site + here.unplaced + here.staging,
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
    elsewhere: { pickable: 0, staging: 0 },
  };
}

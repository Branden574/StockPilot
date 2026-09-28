import { describe, expect, it } from 'vitest';

import { ALLOWED_TRANSITIONS, type OrderStatus } from '../order-state-machine';

import {
  assessOrderReadiness,
  orderReadinessPhase,
  parseOrderReadinessFacts,
  projectCompletePicking,
  READINESS_ORDER_CHANGED_COPY,
  READINESS_STATES,
  readinessAnswersOrder,
  readinessAudience,
  reconcileReadiness,
  ReadinessFactsShapeError,
  readinessStockFlags,
  type OrderReadinessAssessment,
  type OrderReadinessFacts,
  type ReadinessItemFacts,
  type ReadinessLineAssessment,
  type ReadinessVisibleItemFacts,
} from './readiness';

// ── Builders ────────────────────────────────────────────────────────────────

const WH = 'wh-home';
const NOW = '2026-09-28T12:00:00.000Z';

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
    stagingSources: here.staging > 0 ? [{ locationId: 'stg', quantity: here.staging }] : [],
    stagingHiddenQty: 0,
    pendingOthers: { orders: 0, units: 0 },
    committedOtherShortfall: 0,
    inbound: { rows: [], hiddenRemaining: 0, truncated: false, truncatedRemaining: 0 },
    drafts: { rows: [], hiddenRemaining: 0, truncated: false, truncatedRemaining: 0 },
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
  picked?: number | null;
  createdAt?: string;
}

function facts(opts: {
  status?: OrderStatus | string;
  lines: LineSpec[];
  items: ReadinessItemFacts[];
  neededBy?: string | null;
  linesCapped?: boolean;
  timeZone?: string | null;
}): OrderReadinessFacts {
  const status = opts.status ?? 'pending_approval';
  return {
    v: 1,
    observedAt: NOW,
    phase: orderReadinessPhase(status),
    linesCapped: opts.linesCapped ?? false,
    order: {
      id: 'order-1',
      orderNumber: 123,
      status,
      warehouseId: WH,
      neededBy: opts.neededBy ?? null,
      fulfillmentType: 'pickup',
      timeZone: opts.timeZone === undefined ? 'America/Los_Angeles' : opts.timeZone,
    },
    lines: opts.lines.map((l, i) => ({
      lineId: l.id,
      itemId: l.item,
      requested: l.requested,
      fulfilled: l.fulfilled ?? 0,
      picked: l.picked ?? null,
      createdAt: l.createdAt ?? new Date(Date.UTC(2026, 8, 1, 10, 0, i)).toISOString(),
    })),
    items: opts.items,
  };
}

function toPick(f: OrderReadinessFacts, now: string = NOW) {
  const a = assessOrderReadiness(f, { now });
  if (a.phase !== 'to_pick') throw new Error(`expected to_pick, got ${a.phase}`);
  return a;
}

function lineOf(a: Extract<OrderReadinessAssessment, { phase: 'to_pick' }>, id: string): ReadinessLineAssessment {
  const l = a.lines.find((x) => x.lineId === id);
  if (!l) throw new Error(`no line ${id}`);
  return l;
}

const ok = (assessment: OrderReadinessAssessment) => ({ state: 'ok' as const, assessment });

// ── Phases ──────────────────────────────────────────────────────────────────

describe("orderReadinessPhase (twin of order_readiness_facts' CASE)", () => {
  it('maps every status of the state machine', () => {
    const phases = Object.fromEntries(
      (Object.keys(ALLOWED_TRANSITIONS) as OrderStatus[]).map((s) => [s, orderReadinessPhase(s)]),
    );
    expect(phases).toEqual({
      pending_confirmation: 'closed',
      pending_approval: 'to_pick',
      approved: 'to_pick',
      pick_slip_generated: 'to_pick',
      picking_in_progress: 'to_pick',
      picking_complete: 'picked',
      packing_slip_generated: 'picked',
      staged_for_pickup: 'picked',
      staged_for_delivery: 'picked',
      in_transit: 'picked',
      backordered: 'to_pick',
      completed: 'closed',
      denied: 'closed',
      cancelled: 'closed',
    });
  });

  it('an unknown or legacy status is closed', () => {
    expect(orderReadinessPhase('delivered')).toBe('closed');
    expect(orderReadinessPhase(null)).toBe('closed');
  });
});

// ── Every state and reason ──────────────────────────────────────────────────

describe('line states', () => {
  it('ready: on the shelf here, net of other orders\' holds', () => {
    const a = toPick(
      facts({
        lines: [{ id: 'l1', item: 'a', requested: 10 }],
        items: [item('a', { here: { rack: 12, site: 0, unplaced: 0, staging: 0 }, heldOtherOrders: 2 })],
      }),
    );
    const l = lineOf(a, 'l1');
    expect(l.state).toBe('ready');
    expect(l.reasons).toEqual([]);
    expect(l.units).toMatchObject({ ready: 10, noRack: 0, putAway: 0, gap: 0, awaiting: 0, short: 0 });
    expect(a.rollup.ready).toBe(true);
  });

  it('ready with no_rack_recorded when Unplaced or a Site serves it (racks are taken first)', () => {
    const a = toPick(
      facts({
        lines: [
          { id: 'l1', item: 'a', requested: 4 },
          { id: 'l2', item: 'a', requested: 5 },
        ],
        items: [item('a', { here: { rack: 4, site: 3, unplaced: 2, staging: 0 } })],
      }),
    );
    expect(lineOf(a, 'l1')).toMatchObject({ state: 'ready', notes: [], units: { ready: 4, noRack: 0 } });
    expect(lineOf(a, 'l2')).toMatchObject({
      state: 'ready',
      notes: ['no_rack_recorded'],
      units: { ready: 5, noRack: 5 },
    });
  });

  it('needs_put_away (in_staging): Staging is never picked, Unplaced is', () => {
    const a = toPick(
      facts({
        lines: [{ id: 'l1', item: 'b', requested: 25 }],
        items: [item('b', { here: { rack: 10, site: 0, unplaced: 0, staging: 30 } })],
      }),
    );
    expect(lineOf(a, 'l1')).toMatchObject({
      state: 'needs_put_away',
      reasons: ['in_staging'],
      units: { ready: 10, putAway: 15, short: 0 },
    });
    // Mutation guard: Unplaced treated as put-away would read needs_put_away.
    const u = toPick(
      facts({
        lines: [{ id: 'l1', item: 'b', requested: 25 }],
        items: [item('b', { here: { rack: 10, site: 0, unplaced: 15, staging: 0 } })],
      }),
    );
    expect(lineOf(u, 'l1').state).toBe('ready');
  });

  it('awaiting_po (on_order) with the PO\'s expected date', () => {
    const a = toPick(
      facts({
        lines: [{ id: 'l1', item: 'c', requested: 10 }],
        items: [
          item('c', {
            inbound: {
              rows: [{ poId: 'po-1', poNumber: 'PO-2026-0042', status: 'ordered', expectedAt: '2026-10-03T16:00:00Z', remaining: 50 }],
              hiddenRemaining: 0,
              truncated: false,
              truncatedRemaining: 0,
            },
          }),
        ],
      }),
    );
    const l = lineOf(a, 'l1');
    expect(l).toMatchObject({
      state: 'awaiting_po',
      reasons: ['on_order'],
      notes: [],
      expectedAt: '2026-10-03T16:00:00Z',
      units: { awaiting: 10, short: 0 },
    });
    expect(l.poShares).toEqual([
      { kind: 'po', poId: 'po-1', poNumber: 'PO-2026-0042', expectedAt: '2026-10-03T16:00:00Z', poRemaining: 50, units: 10 },
    ]);
  });

  it('short (insufficient) when nothing covers it; the walk seed\'s six items read as the plan says', () => {
    // Seed org "Readiness QA" (F2 plan F2-1 local web walk).
    const a = toPick(
      facts({
        lines: [
          { id: 'A', item: 'A', requested: 20 },
          { id: 'B', item: 'B', requested: 25 },
          { id: 'C', item: 'C', requested: 10 },
          { id: 'D', item: 'D', requested: 5 },
          { id: 'E', item: 'E', requested: 1 },
          { id: 'F', item: 'F', requested: 3 },
        ],
        items: [
          item('A', { here: { rack: 40, site: 0, unplaced: 0, staging: 0 } }),
          item('B', { here: { rack: 10, site: 0, unplaced: 0, staging: 30 } }),
          item('C', {
            inbound: {
              rows: [{ poId: 'po-c', poNumber: 'PO-C', status: 'ordered', expectedAt: '2026-10-09T00:00:00Z', remaining: 50 }],
              hiddenRemaining: 0,
              truncated: false,
              truncatedRemaining: 0,
            },
          }),
          item('D'),
          item('E', { here: { rack: 7, site: 0, unplaced: 0, staging: 0 }, heldOtherOrders: 7 }),
          item('F', { here: { rack: 0, site: 3, unplaced: 0, staging: 0 } }),
        ],
      }),
    );
    const summary = a.lines.map((l) => [l.lineId, l.state, l.units]);
    expect(summary).toEqual([
      ['A', 'ready', { ready: 20, noRack: 0, putAway: 0, gap: 0, awaiting: 0, short: 0 }],
      ['B', 'needs_put_away', { ready: 10, noRack: 0, putAway: 15, gap: 0, awaiting: 0, short: 0 }],
      ['C', 'awaiting_po', { ready: 0, noRack: 0, putAway: 0, gap: 0, awaiting: 10, short: 0 }],
      ['D', 'short', { ready: 0, noRack: 0, putAway: 0, gap: 0, awaiting: 0, short: 5 }],
      ['E', 'short', { ready: 0, noRack: 0, putAway: 0, gap: 0, awaiting: 0, short: 1 }],
      ['F', 'ready', { ready: 3, noRack: 3, putAway: 0, gap: 0, awaiting: 0, short: 0 }],
    ]);
    expect(lineOf(a, 'D').reasons).toEqual(['insufficient']);
    expect(lineOf(a, 'F').notes).toEqual(['no_rack_recorded']);
  });

  it('short item_deleted and item_moved: nothing here serves them, all of it is short', () => {
    const a = toPick(
      facts({
        lines: [
          { id: 'l1', item: 'del', requested: 3 },
          { id: 'l2', item: 'mov', requested: 2 },
        ],
        items: [
          item('del', { deleted: true, here: { rack: 9, site: 0, unplaced: 0, staging: 0 } }),
          item('mov', { itemWarehouseId: 'wh-other', elsewhere: { pickable: 9, staging: 0 } }),
        ],
      }),
    );
    expect(lineOf(a, 'l1')).toMatchObject({ state: 'short', reasons: ['item_deleted'], units: { short: 3 } });
    expect(lineOf(a, 'l2')).toMatchObject({ state: 'short', reasons: ['item_moved'], units: { short: 2 } });
    expect(a.items.map((i) => [i.itemId, i.blocked, i.quantities?.draftable])).toEqual([
      ['del', 'item_deleted', 0],
      ['mov', 'item_moved', 0],
    ]);
  });

  it('a kit is short like any item but never drafted (kit_stock)', () => {
    const a = toPick(
      facts({
        lines: [{ id: 'l1', item: 'k', requested: 3 }],
        items: [item('k', { isBundle: true, here: { rack: 2, site: 0, unplaced: 0, staging: 0 } })],
      }),
    );
    expect(lineOf(a, 'l1')).toMatchObject({ state: 'short', notes: ['kit_stock'], units: { ready: 2, short: 1 } });
    expect(a.items[0]!.quantities!.draftable).toBe(0);
  });

  it('unknown not_visible: a hidden item carries no numbers and is never zero', () => {
    const a = toPick(
      facts({
        lines: [{ id: 'l1', item: 'h', requested: 3 }],
        items: [{ itemId: 'h', visible: false }],
      }),
    );
    expect(lineOf(a, 'l1')).toMatchObject({ state: 'unknown', reasons: ['not_visible'], units: null, hold: null });
    expect(a.items[0]).toEqual({ itemId: 'h', visible: false, facts: null, blocked: null, quantities: null });
    expect(a.rollup.ready).toBe(false);
  });

  it('unknown records_disagree: on record is not what the locations hold, always', () => {
    const a = toPick(
      facts({
        lines: [{ id: 'l1', item: 'a', requested: 3 }],
        items: [item('a', { onHand: 8, here: { rack: 5, site: 0, unplaced: 0, staging: 0 } })],
      }),
    );
    expect(lineOf(a, 'l1')).toMatchObject({ state: 'unknown', reasons: ['records_disagree'], units: { ready: 3 } });
    expect(a.items[0]!.quantities).toMatchObject({ recordsDisagree: true, locationsTotal: 5 });
    expect(a.rollup.ready).toBe(false);
  });

  it('unknown held_elsewhere: covered on record only by another warehouse\'s stock', () => {
    const a = toPick(
      facts({
        lines: [{ id: 'l1', item: 'a', requested: 5 }],
        items: [item('a', { here: { rack: 2, site: 0, unplaced: 0, staging: 0 }, elsewhere: { pickable: 3, staging: 0 } })],
      }),
    );
    expect(lineOf(a, 'l1')).toMatchObject({
      state: 'unknown',
      reasons: ['held_elsewhere'],
      units: { ready: 2, gap: 3 },
    });
    expect(a.rollup.ready).toBe(false);
  });

  it('the worst state wins: short > unknown > awaiting > put-away > ready (handed over touches nothing)', () => {
    expect(
      Object.entries(READINESS_STATES)
        .sort((x, y) => y[1].precedence - x[1].precedence)
        .map(([s]) => s),
    ).toEqual(['short', 'unknown', 'awaiting_po', 'needs_put_away', 'ready', 'handed_over']);
    const a = toPick(
      facts({
        lines: [{ id: 'l1', item: 'a', requested: 20 }],
        items: [
          item('a', {
            here: { rack: 5, site: 0, unplaced: 0, staging: 5 },
            inbound: {
              rows: [{ poId: 'p', poNumber: 'PO-1', status: 'ordered', expectedAt: '2026-10-01T00:00:00Z', remaining: 4 }],
              hiddenRemaining: 0,
              truncated: false,
              truncatedRemaining: 0,
            },
          }),
        ],
      }),
    );
    expect(lineOf(a, 'l1')).toMatchObject({
      state: 'short',
      reasons: ['insufficient', 'on_order', 'in_staging'],
      units: { ready: 5, putAway: 5, awaiting: 4, short: 6 },
    });
  });

  it('a line that owes nothing is handed over (never "Ready to pick"), with nothing_owed', () => {
    const a = toPick(
      facts({
        status: 'backordered',
        lines: [
          { id: 'l1', item: 'a', requested: 5, fulfilled: 5 },
          { id: 'l2', item: 'a', requested: 4, fulfilled: 1 },
        ],
        items: [item('a', { onHand: 0 })],
      }),
    );
    expect(lineOf(a, 'l1')).toMatchObject({ state: 'handed_over', reasons: [], notes: ['nothing_owed'], owed: 0 });
    expect(lineOf(a, 'l2')).toMatchObject({ state: 'short', owed: 3 });
    expect(READINESS_STATES.handed_over).toMatchObject({ label: 'Handed over', tone: 'neutral' });
  });

  it('a handed-over line of an item the reader cannot see is handed over too (its owed is on the line itself)', () => {
    const a = toPick(
      facts({
        status: 'backordered',
        lines: [{ id: 'l1', item: 'h', requested: 5, fulfilled: 5 }],
        items: [{ itemId: 'h', visible: false }],
      }),
    );
    expect(lineOf(a, 'l1')).toMatchObject({ state: 'handed_over', reasons: [], notes: ['nothing_owed'], units: null });
  });
});

// ── Allocation rules ────────────────────────────────────────────────────────

describe('allocation', () => {
  it('duplicate-item lines allocate each unit once, in (createdAt, lineId) order', () => {
    const a = toPick(
      facts({
        lines: [
          { id: 'l2', item: 'a', requested: 3, createdAt: '2026-09-01T10:00:00Z' },
          { id: 'l1', item: 'a', requested: 3, createdAt: '2026-09-01T10:00:00Z' },
          { id: 'l0', item: 'a', requested: 3, createdAt: '2026-09-01T10:00:05Z' },
        ],
        items: [item('a', { here: { rack: 5, site: 0, unplaced: 0, staging: 0 } })],
      }),
    );
    // Mutation: allocating each line against the full supply reads all three ready.
    expect(a.lines.map((l) => [l.lineId, l.position, l.state, l.units?.ready, l.units?.short])).toEqual([
      ['l1', 1, 'ready', 3, 0],
      ['l2', 2, 'short', 2, 1],
      ['l0', 3, 'short', 0, 3],
    ]);
  });

  it('the own hold is supply: approved with every unit held reads ready, never short', () => {
    const a = toPick(
      facts({
        status: 'approved',
        lines: [{ id: 'l1', item: 'a', requested: 10 }],
        items: [item('a', { heldOwn: 10, here: { rack: 10, site: 0, unplaced: 0, staging: 0 } })],
      }),
    );
    // Mutation: subtracting heldOwn from availability reads 10 short.
    expect(lineOf(a, 'l1')).toMatchObject({ state: 'ready', units: { ready: 10, short: 0 } });
    expect(a.items[0]!.quantities).toMatchObject({ available: 10, approveAvailable: 0 });
  });

  it('other orders\' holds come off the racks first, so what is left for this order on Unplaced is "no rack recorded"', () => {
    const a = toPick(
      facts({
        lines: [{ id: 'l1', item: 'a', requested: 7 }],
        items: [item('a', { heldOtherOrders: 3, here: { rack: 5, site: 0, unplaced: 5, staging: 0 } })],
      }),
    );
    // Ready 7 of the 10 on the shelf (3 held elsewhere): 2 from the racks, 5 from Unplaced.
    expect(lineOf(a, 'l1')).toMatchObject({ state: 'ready', notes: ['no_rack_recorded'], units: { ready: 7, noRack: 5 } });
  });

  it('other orders\' holds (rentals included) are charged to shelf stock first', () => {
    const a = toPick(
      facts({
        status: 'pick_slip_generated',
        lines: [{ id: 'l1', item: 'a', requested: 10 }],
        items: [
          item('a', {
            heldOwn: 10,
            heldOtherOrders: 3,
            heldRentals: 2,
            here: { rack: 10, site: 0, unplaced: 0, staging: 5 },
          }),
        ],
      }),
    );
    expect(lineOf(a, 'l1')).toMatchObject({ state: 'needs_put_away', units: { ready: 5, putAway: 5 } });
  });

  it('inbound nets against other committed orders\' shortfall, which takes the earliest POs', () => {
    const a = toPick(
      facts({
        lines: [{ id: 'l1', item: 'a', requested: 8 }],
        items: [
          item('a', {
            committedOtherShortfall: 6,
            inbound: {
              rows: [
                { poId: 'late', poNumber: 'PO-LATE', status: 'ordered', expectedAt: '2026-10-20T00:00:00Z', remaining: 4 },
                { poId: 'early', poNumber: 'PO-EARLY', status: 'ordered', expectedAt: '2026-10-02T00:00:00Z', remaining: 6 },
              ],
              hiddenRemaining: 0,
              truncated: false,
              truncatedRemaining: 0,
            },
          }),
        ],
      }),
    );
    const l = lineOf(a, 'l1');
    // 10 inbound - 6 committed elsewhere = 4 awaited; the rest is short.
    expect(l).toMatchObject({ state: 'short', units: { awaiting: 4, short: 4 } });
    // The other orders took the earliest PO; this line's units come from the later one.
    expect(l.poShares.map((s) => [s.poNumber, s.units])).toEqual([['PO-LATE', 4]]);
    expect(l.expectedAt).toBe('2026-10-20T00:00:00Z');
  });

  it('earliest expected date first, no date last; the line\'s date is the latest it relies on', () => {
    const a = toPick(
      facts({
        lines: [
          { id: 'l1', item: 'a', requested: 5 },
          { id: 'l2', item: 'a', requested: 5 },
        ],
        items: [
          item('a', {
            inbound: {
              rows: [
                { poId: 'n', poNumber: 'PO-N', status: 'partially_received', expectedAt: null, remaining: 5 },
                { poId: 'b', poNumber: 'PO-B', status: 'ordered', expectedAt: '2026-10-09T00:00:00Z', remaining: 3 },
                { poId: 'a', poNumber: 'PO-A', status: 'ordered', expectedAt: '2026-10-03T00:00:00Z', remaining: 3 },
              ],
              hiddenRemaining: 0,
              truncated: false,
              truncatedRemaining: 0,
            },
          }),
        ],
      }),
    );
    expect(lineOf(a, 'l1')).toMatchObject({ expectedAt: '2026-10-09T00:00:00Z', notes: [] });
    expect(lineOf(a, 'l1').poShares.map((s) => [s.poNumber, s.units])).toEqual([
      ['PO-A', 3],
      ['PO-B', 2],
    ]);
    expect(lineOf(a, 'l2')).toMatchObject({ expectedAt: null, notes: ['no_expected_date'] });
    expect(lineOf(a, 'l2').poShares.map((s) => [s.poNumber, s.units])).toEqual([
      ['PO-B', 1],
      ['PO-N', 4],
    ]);
  });

  it('units on unlisted or hidden POs have no expected date; hidden ones are flagged', () => {
    const a = toPick(
      facts({
        lines: [{ id: 'l1', item: 'a', requested: 6 }],
        items: [
          item('a', {
            inbound: { rows: [], hiddenRemaining: 4, truncated: true, truncatedRemaining: 2 },
          }),
        ],
      }),
    );
    const l = lineOf(a, 'l1');
    expect(l).toMatchObject({ state: 'awaiting_po', expectedAt: null, notes: ['no_expected_date', 'on_hidden_po'] });
    expect(l.poShares.map((s) => [s.kind, s.units])).toEqual([
      ['unlisted', 2],
      ['hidden', 4],
    ]);
  });

  it('drafts are never supply, but they reduce what may be drafted again', () => {
    const a = toPick(
      facts({
        lines: [{ id: 'l1', item: 'a', requested: 10 }],
        items: [
          item('a', {
            committedOtherShortfall: 1,
            inbound: {
              rows: [{ poId: 'o', poNumber: 'PO-O', status: 'ordered', expectedAt: '2026-10-03T00:00:00Z', remaining: 3 }],
              hiddenRemaining: 0,
              truncated: false,
              truncatedRemaining: 0,
            },
            drafts: {
              rows: [{ poId: 'd', poNumber: 'PO-D', remaining: 4 }],
              hiddenRemaining: 0,
              truncated: false,
              truncatedRemaining: 0,
            },
          }),
        ],
      }),
    );
    const l = lineOf(a, 'l1');
    expect(l).toMatchObject({ state: 'short', units: { awaiting: 2, short: 8 }, notes: ['on_draft_po'] });
    // draftable = 10 short - max(0, 3 inbound + 4 draft - 1 committed) = 4.
    expect(a.items[0]!.quantities).toMatchObject({ inboundRemaining: 3, draftRemaining: 4, draftable: 4 });
  });

  it('the purchase_orders module off: nothing is awaited and nothing is draftable (unknown, not "none")', () => {
    const a = toPick(
      facts({
        lines: [{ id: 'l1', item: 'a', requested: 4 }],
        items: [item('a', { inbound: null, drafts: null })],
      }),
    );
    expect(lineOf(a, 'l1')).toMatchObject({ state: 'short', units: { awaiting: 0, short: 4 }, notes: [] });
    expect(a.items[0]!.quantities!.draftable).toBe(0);
  });

  it('pending_others is noted on short lines (approvers only get the number)', () => {
    const a = toPick(
      facts({
        lines: [{ id: 'l1', item: 'a', requested: 4 }],
        items: [item('a', { pendingOthers: { orders: 2, units: 12 } })],
      }),
    );
    expect(lineOf(a, 'l1').notes).toEqual(['pending_others']);
  });

  it('quantities stay on the numeric(14,4) grid', () => {
    const a = toPick(
      facts({
        lines: [
          { id: 'l1', item: 'a', requested: 0.1 },
          { id: 'l2', item: 'a', requested: 0.2 },
        ],
        items: [item('a', { here: { rack: 0.3, site: 0, unplaced: 0, staging: 0 } })],
      }),
    );
    expect(a.items[0]!.quantities!.demand).toBe(0.3);
    expect(a.lines.map((l) => l.state)).toEqual(['ready', 'ready']);
  });
});

// ── Holds ───────────────────────────────────────────────────────────────────

describe('hold annotation', () => {
  it('allocates the own hold to lines in order: held, partly held, not held', () => {
    const a = toPick(
      facts({
        status: 'approved',
        lines: [
          { id: 'l1', item: 'a', requested: 20 },
          { id: 'l2', item: 'a', requested: 40 },
          { id: 'l3', item: 'a', requested: 5 },
        ],
        items: [item('a', { heldOwn: 40, here: { rack: 100, site: 0, unplaced: 0, staging: 0 } })],
      }),
    );
    expect(a.holdAnnotated).toBe(true);
    expect(a.lines.map((l) => l.hold)).toEqual([
      { state: 'held', held: 20, of: 20 },
      { state: 'partly_held', held: 20, of: 40 },
      { state: 'not_held', held: 0, of: 5 },
    ]);
  });

  it('only at hold statuses', () => {
    for (const status of ['pending_approval', 'backordered'] as const) {
      const a = toPick(
        facts({
          status,
          lines: [{ id: 'l1', item: 'a', requested: 2 }],
          items: [item('a', { here: { rack: 5, site: 0, unplaced: 0, staging: 0 } })],
        }),
      );
      expect(a.holdAnnotated).toBe(false);
      expect(a.lines[0]!.hold).toBeNull();
    }
  });
});

// ── Roll-up ─────────────────────────────────────────────────────────────────

describe('roll-up', () => {
  const readyItem = item('a', { here: { rack: 10, site: 0, unplaced: 0, staging: 0 } });

  it('green only when every line is ready and every fact readable', () => {
    const a = toPick(facts({ lines: [{ id: 'l1', item: 'a', requested: 5 }], items: [readyItem] }));
    expect(a.rollup).toMatchObject({ ready: true, lineCount: 1, capped: false, neededBySignal: null });
    expect(a.rollup.counts).toEqual({ ready: 1, needs_put_away: 0, awaiting_po: 0, short: 0, unknown: 0, handed_over: 0 });
  });

  it('never green with anything unknown: hidden, records disagree, held elsewhere, capped', () => {
    const cases: OrderReadinessFacts[] = [
      facts({ lines: [{ id: 'l1', item: 'h', requested: 1 }], items: [{ itemId: 'h', visible: false }] }),
      facts({ lines: [{ id: 'l1', item: 'a', requested: 1 }], items: [item('a', { onHand: 20, here: { rack: 10, site: 0, unplaced: 0, staging: 0 } })] }),
      facts({ lines: [{ id: 'l1', item: 'a', requested: 1 }], items: [item('a', { elsewhere: { pickable: 5, staging: 0 } })] }),
      facts({ lines: [], items: [], linesCapped: true }),
    ];
    for (const f of cases) expect(toPick(f).rollup.ready).toBe(false);
    expect(toPick(cases[3]!).rollup).toMatchObject({ capped: true, lineCount: 0 });
  });

  it('handed-over lines are neither ready nor owed: the count and the green are over the lines still owed', () => {
    const short = toPick(
      facts({
        status: 'backordered',
        lines: [
          { id: 'l1', item: 'a', requested: 2, fulfilled: 2 },
          { id: 'l2', item: 'b', requested: 3, fulfilled: 3 },
          { id: 'l3', item: 'c', requested: 4, fulfilled: 1 },
        ],
        items: [item('a'), item('b'), item('c')],
      }),
    );
    expect(short.rollup).toMatchObject({ ready: false, lineCount: 3, owedLineCount: 1 });
    expect(short.rollup.counts).toEqual({ ready: 0, needs_put_away: 0, awaiting_po: 0, short: 1, unknown: 0, handed_over: 2 });
    const green = toPick(
      facts({
        status: 'backordered',
        lines: [
          { id: 'l1', item: 'a', requested: 2, fulfilled: 2 },
          { id: 'l2', item: 'c', requested: 4, fulfilled: 1 },
        ],
        items: [item('a'), item('c', { here: { rack: 3, site: 0, unplaced: 0, staging: 0 } })],
      }),
    );
    expect(green.rollup).toMatchObject({ ready: true, lineCount: 2, owedLineCount: 1 });
    const allHanded = toPick(
      facts({ status: 'backordered', lines: [{ id: 'l1', item: 'a', requested: 2, fulfilled: 2 }], items: [item('a')] }),
    );
    expect(allHanded.rollup).toMatchObject({ ready: false, lineCount: 1, owedLineCount: 0 });
  });

  it('an order with no lines is not green', () => {
    expect(toPick(facts({ lines: [], items: [] })).rollup.ready).toBe(false);
  });

  it('past_due when the needed-by has passed, at to_pick and picked', () => {
    const f = facts({ lines: [{ id: 'l1', item: 'a', requested: 5 }], items: [readyItem], neededBy: '2026-09-20T17:00:00Z' });
    expect(toPick(f).rollup.neededBySignal).toBe('past_due');
    const picked = assessOrderReadiness(
      { ...f, phase: 'picked', order: { ...f.order, status: 'staged_for_pickup' }, items: [] },
      { now: NOW },
    );
    expect(picked.phase === 'picked' && picked.rollup.neededBySignal).toBe('past_due');
  });

  it('at_risk for a short or unknown line, or an awaited line with no date or a date after the needed-by', () => {
    const neededBy = '2026-10-05T17:00:00Z';
    const po = (expectedAt: string | null) =>
      item('c', {
        inbound: {
          rows: [{ poId: 'p', poNumber: 'PO-1', status: 'ordered', expectedAt, remaining: 10 }],
          hiddenRemaining: 0,
          truncated: false,
          truncatedRemaining: 0,
        },
      });
    const signal = (items: ReadinessItemFacts[], it = 'c') =>
      toPick(facts({ lines: [{ id: 'l1', item: it, requested: 2 }], items, neededBy })).rollup.neededBySignal;
    expect(signal([po('2026-10-03T00:00:00Z')])).toBeNull();
    const late = toPick(facts({ lines: [{ id: 'l1', item: 'c', requested: 2 }], items: [po('2026-10-09T00:00:00Z')], neededBy }));
    expect(late.lines[0]!.notes).toEqual(['expected_after_needed_by']);
    expect(late.rollup.neededBySignal).toBe('at_risk');
    expect(signal([po(null)])).toBe('at_risk');
    expect(signal([item('c')])).toBe('at_risk');
    expect(signal([{ itemId: 'c', visible: false }])).toBe('at_risk');
    expect(signal([readyItem], 'a')).toBeNull();
  });

  it("a PO's expected date is a calendar date (midnight UTC of the day typed), compared by day with the needed-by in the org's zone", () => {
    // Needed by Oct 9, 5:30 PM in Los Angeles (00:30 UTC on Oct 10).
    const neededBy = '2026-10-10T00:30:00Z';
    const po = (expectedAt: string) =>
      item('c', {
        inbound: {
          rows: [{ poId: 'p', poNumber: 'PO-1', status: 'ordered', expectedAt, remaining: 10 }],
          hiddenRemaining: 0,
          truncated: false,
          truncatedRemaining: 0,
        },
      });
    const run = (expectedAt: string, timeZone: string | null = 'America/Los_Angeles') =>
      toPick(facts({ lines: [{ id: 'l1', item: 'c', requested: 2 }], items: [po(expectedAt)], neededBy, timeZone }));
    // Expected Oct 10, needed Oct 9: after the needed-by, at risk (the instant
    // 00:00 UTC is before 00:30 UTC, which hid it).
    const late = run('2026-10-10T00:00:00Z');
    expect(late.lines[0]!.notes).toEqual(['expected_after_needed_by']);
    expect(late.rollup.neededBySignal).toBe('at_risk');
    // Expected Oct 9, the needed-by day: not after it.
    const sameDay = run('2026-10-09T00:00:00Z');
    expect(sameDay.lines[0]!.notes).toEqual([]);
    expect(sameDay.rollup.neededBySignal).toBeNull();
    // The zone comes from the facts: in UTC the needed-by is Oct 10, so an Oct 10 PO is on the day.
    expect(run('2026-10-10T00:00:00Z', 'UTC').lines[0]!.notes).toEqual([]);
    // No zone in the facts (an older database): the documented default zone (Los Angeles).
    expect(run('2026-10-10T00:00:00Z', null).lines[0]!.notes).toEqual(['expected_after_needed_by']);
  });

  it('no needed-by: no signal at all, never an "on track" claim', () => {
    expect(toPick(facts({ lines: [{ id: 'l1', item: 'c', requested: 2 }], items: [item('c')] })).rollup.neededBySignal).toBeNull();
  });
});

// ── Picked and closed phases ────────────────────────────────────────────────

describe('picked and closed phases (lines only)', () => {
  it('picked_complete and short_picked from the lines alone', () => {
    const f = facts({
      status: 'staged_for_delivery',
      lines: [
        { id: 'l1', item: 'a', requested: 60, picked: 0 },
        { id: 'l2', item: 'b', requested: 30, picked: 30 },
        { id: 'l3', item: 'c', requested: 5, fulfilled: 2, picked: 3 },
      ],
      items: [],
    });
    const a = assessOrderReadiness(f, { now: NOW });
    expect(a.phase).toBe('picked');
    if (a.phase !== 'picked') return;
    expect(a.lines.map((l) => [l.lineId, l.state, l.unpicked])).toEqual([
      ['l1', 'short_picked', 60],
      ['l2', 'picked_complete', 0],
      ['l3', 'picked_complete', 0],
    ]);
    expect(a.rollup.counts).toEqual({ picked_complete: 2, short_picked: 1 });
  });

  it('closed shows nothing', () => {
    const a = assessOrderReadiness(facts({ status: 'completed', lines: [], items: [] }), { now: NOW });
    expect(a).toEqual({ phase: 'closed', observedAt: NOW, order: expect.objectContaining({ status: 'completed' }) });
  });
});

// ── Parser ──────────────────────────────────────────────────────────────────

describe('parseOrderReadinessFacts', () => {
  const good = () =>
    JSON.parse(
      JSON.stringify(
        facts({
          status: 'approved',
          lines: [{ id: 'l1', item: 'a', requested: 2 }],
          items: [item('a', { here: { rack: 5, site: 0, unplaced: 0, staging: 0 } })],
        }),
      ),
    ) as Record<string, unknown>;

  it('accepts the SQL shape and ignores unknown keys (the database may be a release ahead)', () => {
    const raw = good();
    raw.futureKey = { anything: true };
    (raw.items as Array<Record<string, unknown>>)[0]!.futureItemKey = 7;
    (raw.order as Record<string, unknown>).futureOrderKey = 'x';
    const parsed = parseOrderReadinessFacts(raw);
    expect(parsed.items[0]).not.toHaveProperty('futureItemKey');
    expect(parsed).not.toHaveProperty('futureKey');
    expect(parsed.lines[0]).toMatchObject({ lineId: 'l1', requested: 2, picked: null });
  });

  it("reads the org's zone from the order, and an older answer without it as none", () => {
    const f = facts({ lines: [], items: [], timeZone: 'America/Chicago' });
    expect(parseOrderReadinessFacts(JSON.parse(JSON.stringify(f))).order.timeZone).toBe('America/Chicago');
    const older = JSON.parse(JSON.stringify(f)) as { order: Record<string, unknown> };
    delete older.order.timeZone;
    expect(parseOrderReadinessFacts(older).order.timeZone).toBeNull();
    expect(() => parseOrderReadinessFacts({ ...older, order: { ...older.order, timeZone: 7 } })).toThrow(ReadinessFactsShapeError);
  });

  it('accepts an older answer without the truncation keys', () => {
    const raw = good();
    const it0 = (raw.items as Array<Record<string, Record<string, unknown>>>)[0]!;
    delete it0.inbound!.truncated;
    delete it0.inbound!.truncatedRemaining;
    const parsed = parseOrderReadinessFacts(raw);
    const f = parsed.items[0] as ReadinessVisibleItemFacts;
    expect(f.inbound).toMatchObject({ truncated: false, truncatedRemaining: 0 });
  });

  it('a hidden item needs nothing but its id', () => {
    const raw = good();
    raw.items = [{ itemId: 'a', visible: false }];
    expect(parseOrderReadinessFacts(raw).items).toEqual([{ itemId: 'a', visible: false }]);
  });

  const broken: Array<[string, (raw: Record<string, unknown>) => unknown]> = [
    ['not an object', () => 'facts'],
    ['null', () => null],
    ['another version', (r) => ({ ...r, v: 2 })],
    ['no order', (r) => ({ ...r, order: undefined })],
    ['a phase that disagrees with the status', (r) => ({ ...r, phase: 'picked' })],
    ['an unknown phase', (r) => ({ ...r, phase: 'ready' })],
    ['linesCapped missing', (r) => ({ ...r, linesCapped: undefined })],
    ['a quantity as a string', (r) => ({ ...r, lines: [{ ...(r.lines as object[])[0], requested: '2' }] })],
    ['a negative quantity', (r) => ({ ...r, lines: [{ ...(r.lines as object[])[0], requested: -1 }] })],
    ['a bad date', (r) => ({ ...r, observedAt: 'yesterday' })],
    ['a line whose item has no facts', (r) => ({ ...r, items: [] })],
    ['visible item missing its holds', (r) => ({ ...r, items: [{ ...(r.items as object[])[0], heldOwn: undefined }] })],
    ['visible item missing inbound', (r) => {
      const it = { ...(r.items as Array<Record<string, unknown>>)[0] };
      delete it.inbound;
      return { ...r, items: [it] };
    }],
    ['a NaN on hand', (r) => ({ ...r, items: [{ ...(r.items as object[])[0], onHand: Number.NaN }] })],
    ['items not an array', (r) => ({ ...r, items: {} })],
  ];
  it.each(broken)('throws on %s', (_name, mutate) => {
    expect(() => parseOrderReadinessFacts(mutate(good()))).toThrow(ReadinessFactsShapeError);
  });

  it('a capped answer needs no items', () => {
    const raw = { ...good(), linesCapped: true, lines: [], items: [] };
    expect(parseOrderReadinessFacts(raw).linesCapped).toBe(true);
  });
});

// ── Stock flags ─────────────────────────────────────────────────────────────

describe('readinessStockFlags', () => {
  const flags = (f: OrderReadinessFacts) => readinessStockFlags(ok(assessOrderReadiness(f, { now: NOW })));

  it('not needed outside pending_approval and backordered', () => {
    for (const status of ['approved', 'pick_slip_generated', 'staged_for_pickup', 'completed']) {
      expect(flags(facts({ status, lines: [], items: [] }))).toEqual({ state: 'not_needed' });
    }
  });

  it('a failed read is failed, never flags with zeros', () => {
    expect(readinessStockFlags({ state: 'failed', message: 'timeout' })).toEqual({
      state: 'failed',
      reason: 'read',
      message: 'timeout',
    });
  });

  it('a hidden item or a capped order is failed', () => {
    expect(
      flags(facts({ lines: [{ id: 'l1', item: 'h', requested: 1 }], items: [{ itemId: 'h', visible: false }] })),
    ).toEqual({ state: 'failed', reason: 'hidden_items', message: '1 item on this order did not load.' });
    expect(flags(facts({ lines: [], items: [], linesCapped: true }))).toMatchObject({
      state: 'failed',
      reason: 'lines_capped',
    });
  });

  it('pending: short exactly when approve would refuse (requested vs on hand less every hold)', () => {
    const f = (requested: number) =>
      facts({
        lines: [
          { id: 'l1', item: 'a', requested },
          { id: 'l2', item: 'b', requested: 1 },
        ],
        items: [
          item('a', { heldOtherOrders: 3, heldRentals: 2, here: { rack: 10, site: 0, unplaced: 0, staging: 0 } }),
          item('b', { here: { rack: 1, site: 0, unplaced: 0, staging: 0 } }),
        ],
      });
    expect(flags(f(5))).toEqual({ state: 'ok', isShortStock: false, hasFulfillableStock: false, itemMoved: false, shortLineCount: 0 });
    expect(flags(f(6))).toEqual({ state: 'ok', isShortStock: true, hasFulfillableStock: false, itemMoved: false, shortLineCount: 1 });
  });

  it('pending: shortLineCount counts LINES (two lines of one refused item are two), not items', () => {
    const f = facts({
      lines: [
        { id: 'l1', item: 'a', requested: 3 },
        { id: 'l2', item: 'a', requested: 3 },
        { id: 'l3', item: 'b', requested: 1 },
      ],
      items: [
        item('a', { here: { rack: 5, site: 0, unplaced: 0, staging: 0 } }),
        item('b', { here: { rack: 1, site: 0, unplaced: 0, staging: 0 } }),
      ],
    });
    expect(flags(f)).toMatchObject({ state: 'ok', isShortStock: true, shortLineCount: 2 });
  });

  it('backordered: fulfillable when an owed item has anything free', () => {
    const f = (onHand: number) =>
      facts({
        status: 'backordered',
        lines: [{ id: 'l1', item: 'a', requested: 6, fulfilled: 2 }],
        items: [item('a', { heldOtherOrders: 2, here: { rack: onHand, site: 0, unplaced: 0, staging: 0 } })],
      });
    expect(flags(f(3))).toMatchObject({ state: 'ok', hasFulfillableStock: true });
    expect(flags(f(2))).toMatchObject({ state: 'ok', hasFulfillableStock: false });
  });

  it('flags a moved item (approve_partial and resume refuse the order)', () => {
    expect(
      flags(
        facts({
          lines: [{ id: 'l1', item: 'm', requested: 1 }],
          items: [item('m', { itemWarehouseId: 'wh-other', elsewhere: { pickable: 5, staging: 0 } })],
        }),
      ),
    ).toMatchObject({ state: 'ok', itemMoved: true });
  });
});

// ── Completion projection ───────────────────────────────────────────────────

describe('projectCompletePicking (the complete_picking twin)', () => {
  const project = (f: OrderReadinessFacts) => projectCompletePicking(assessOrderReadiness(f, { now: NOW }));

  it('one-click: min(owed, on hand less other holds) per line; short lines listed', () => {
    const p = project(
      facts({
        status: 'pick_slip_generated',
        lines: [
          { id: 'pens', item: 'pens', requested: 60 },
          { id: 'nb', item: 'nb', requested: 30 },
        ],
        items: [
          item('pens', { heldOwn: 60 }),
          item('nb', { heldOwn: 30, here: { rack: 30, site: 0, unplaced: 0, staging: 0 } }),
        ],
      }),
    );
    expect(p).toMatchObject({ applicable: true, oneClick: true, willFail: false, unknownItemIds: [] });
    expect(p!.lines.map((l) => [l.lineId, l.batch])).toEqual([
      ['pens', 0],
      ['nb', 30],
    ]);
    expect(p!.shortLines.map((l) => [l.itemName, l.batch, l.owed])).toEqual([['Item pens', 0, 60]]);
  });

  it('explicit picks: min(picked, owed), an unpicked line takes 0', () => {
    const p = project(
      facts({
        status: 'picking_in_progress',
        lines: [
          { id: 'l1', item: 'a', requested: 6, picked: 4 },
          { id: 'l2', item: 'b', requested: 2 },
        ],
        items: [
          item('a', { heldOwn: 6, here: { rack: 10, site: 0, unplaced: 0, staging: 0 } }),
          item('b', { heldOwn: 2, here: { rack: 2, site: 0, unplaced: 0, staging: 0 } }),
        ],
      }),
    );
    expect(p!.oneClick).toBe(false);
    expect(p!.lines.map((l) => l.batch)).toEqual([4, 0]);
  });

  it('fails when the batch needs Staging stock (insufficient_placed_stock), and says how much to put away', () => {
    const p = project(
      facts({
        status: 'pick_slip_generated',
        lines: [{ id: 'l1', item: 'a', requested: 10 }],
        items: [item('a', { heldOwn: 10, here: { rack: 6, site: 0, unplaced: 0, staging: 4 } })],
      }),
    );
    expect(p).toMatchObject({
      willFail: true,
      failingItems: [{ itemId: 'a', reason: 'insufficient_placed_stock', needPutAway: 4, unaccounted: 0 }],
    });
  });

  it('fails the same way when on record is more than the locations hold, and never blames Staging it does not have', () => {
    // 10 on record, a rack of 7, nothing in Staging, the order holds 10: the
    // one-click batch is 10 and the draw finds 7 (insufficient_placed_stock).
    const disagree = project(
      facts({
        status: 'pick_slip_generated',
        lines: [{ id: 'l1', item: 'a', requested: 10 }],
        items: [item('a', { heldOwn: 10, onHand: 10, here: { rack: 7, site: 0, unplaced: 0, staging: 0 } })],
      }),
    );
    expect(disagree).toMatchObject({
      willFail: true,
      failingItems: [{ itemId: 'a', reason: 'insufficient_placed_stock', needPutAway: 0, unaccounted: 3 }],
    });
    // Both at once: 2 in Staging would help, 3 more are on record but nowhere.
    const both = project(
      facts({
        status: 'pick_slip_generated',
        lines: [{ id: 'l1', item: 'a', requested: 10 }],
        items: [item('a', { heldOwn: 10, onHand: 10, here: { rack: 5, site: 0, unplaced: 0, staging: 2 } })],
      }),
    );
    expect(both!.failingItems).toEqual([
      { itemId: 'a', itemName: 'Item a', reason: 'insufficient_placed_stock', needPutAway: 2, unaccounted: 3 },
    ]);
  });

  it('an explicit pick above what is owed takes only what is owed', () => {
    const p = project(
      facts({
        status: 'picking_in_progress',
        lines: [{ id: 'l1', item: 'a', requested: 6, picked: 9 }],
        items: [item('a', { heldOwn: 6, here: { rack: 10, site: 0, unplaced: 0, staging: 0 } })],
      }),
    );
    expect(p!.lines.map((l) => l.batch)).toEqual([6]);
    expect(p!.shortLines).toEqual([]);
  });

  it('draws other warehouses\' pickable stock like the RPC (no failure), while readiness says held elsewhere', () => {
    const f = facts({
      status: 'pick_slip_generated',
      lines: [{ id: 'l1', item: 'a', requested: 5 }],
      items: [item('a', { heldOwn: 5, elsewhere: { pickable: 5, staging: 0 } })],
    });
    expect(project(f)).toMatchObject({ willFail: false });
    expect(toPick(f).lines[0]!.reasons).toEqual(['held_elsewhere']);
  });

  it('an explicit pick above on hand fails as insufficient_stock', () => {
    const p = project(
      facts({
        status: 'picking_in_progress',
        lines: [{ id: 'l1', item: 'a', requested: 9, picked: 9 }],
        items: [item('a', { here: { rack: 5, site: 0, unplaced: 0, staging: 0 } })],
      }),
    );
    expect(p!.failingItems).toEqual([
      { itemId: 'a', itemName: 'Item a', reason: 'insufficient_stock', needPutAway: 0, unaccounted: 0 },
    ]);
  });

  it('a hidden item cannot be projected in one click, and is reported, never guessed', () => {
    const p = project(
      facts({
        status: 'pick_slip_generated',
        lines: [{ id: 'l1', item: 'h', requested: 5 }],
        items: [{ itemId: 'h', visible: false }],
      }),
    );
    expect(p).toMatchObject({ unknownItemIds: ['h'], shortLines: [], willFail: false });
    expect(p!.lines[0]!.batch).toBeNull();
  });

  it('duplicate lines share the available stock (conservative; the RPC is excluded from parity here)', () => {
    const p = project(
      facts({
        status: 'pick_slip_generated',
        lines: [
          { id: 'l1', item: 'a', requested: 3 },
          { id: 'l2', item: 'a', requested: 3 },
        ],
        items: [item('a', { heldOwn: 5, here: { rack: 5, site: 0, unplaced: 0, staging: 0 } })],
      }),
    );
    expect(p!.lines.map((l) => l.batch)).toEqual([3, 2]);
  });

  it('not applicable before the pick slip; null outside to_pick', () => {
    const f = facts({
      status: 'approved',
      lines: [{ id: 'l1', item: 'a', requested: 1 }],
      items: [item('a', { heldOwn: 1, here: { rack: 1, site: 0, unplaced: 0, staging: 0 } })],
    });
    expect(project(f)!.applicable).toBe(false);
    expect(project(facts({ status: 'in_transit', lines: [], items: [] }))).toBeNull();
    expect(project(facts({ status: 'pick_slip_generated', lines: [], items: [], linesCapped: true }))).toMatchObject({
      capped: true,
      willFail: false,
    });
  });
});

// ── Audience ────────────────────────────────────────────────────────────────

describe('readinessAudience', () => {
  const base = { canApproveOrders: false, canUpdateItems: false, canManagePurchaseOrders: false, isOwnRequest: false };
  it('full panel for approvers, pickers and buyers; one sentence for the requester; nothing otherwise', () => {
    expect(readinessAudience({ ...base, canApproveOrders: true })).toBe('full');
    expect(readinessAudience({ ...base, canUpdateItems: true })).toBe('full');
    expect(readinessAudience({ ...base, canManagePurchaseOrders: true })).toBe('full');
    expect(readinessAudience({ ...base, isOwnRequest: true })).toBe('requester');
    expect(readinessAudience({ ...base, isOwnRequest: true, canUpdateItems: true })).toBe('full');
    expect(readinessAudience(base)).toBe('none');
  });
});

// ── Reconcile (the facts must describe the order on screen) ────────────────

describe('reconcileReadiness', () => {
  const f = facts({
    status: 'pending_approval',
    lines: [
      { id: 'l1', item: 'a', requested: 1 },
      { id: 'l2', item: 'a', requested: 1 },
    ],
    items: [item('a', { here: { rack: 5, site: 0, unplaced: 0, staging: 0 } })],
  });
  const result = ok(assessOrderReadiness(f, { now: NOW }));

  it('the same status and the same lines (in any order): the answer stands', () => {
    expect(reconcileReadiness(result, { status: 'pending_approval', lineIds: ['l2', 'l1'] })).toBe(result);
  });

  it('another status, or another set of lines: failed ("the order changed"), never a mix of two orders', () => {
    const changed = { state: 'failed', message: READINESS_ORDER_CHANGED_COPY };
    expect(reconcileReadiness(result, { status: 'approved', lineIds: ['l1', 'l2'] })).toEqual(changed);
    expect(reconcileReadiness(result, { status: 'pending_approval', lineIds: ['l1'] })).toEqual(changed);
    expect(reconcileReadiness(result, { status: 'pending_approval', lineIds: ['l1', 'l2', 'l3'] })).toEqual(changed);
    expect(reconcileReadiness(result, { status: 'pending_approval', lineIds: ['l1', 'lx'] })).toEqual(changed);
    expect(READINESS_ORDER_CHANGED_COPY).toBe('The order changed while it was being checked. Check again.');
  });

  it('a failed read stays failed; a capped or closed answer is judged on its status alone', () => {
    const failed = { state: 'failed' as const, message: 'x' };
    expect(reconcileReadiness(failed, { status: 'approved', lineIds: [] })).toBe(failed);
    const capped = ok(assessOrderReadiness(facts({ lines: [], items: [], linesCapped: true }), { now: NOW }));
    expect(reconcileReadiness(capped, { status: 'pending_approval', lineIds: ['l1'] })).toBe(capped);
  });

  it('readinessAnswersOrder: an answer is about this order whatever the case of either id', () => {
    const f = facts({ lines: [], items: [] });
    const withId = (id: string) => ({ ...f, order: { ...f.order, id } });
    expect(readinessAnswersOrder(withId('0a0f2100-0000-4000-8000-00000000abcd'), '0A0F2100-0000-4000-8000-00000000ABCD')).toBe(true);
    expect(readinessAnswersOrder(withId('0A0F2100-0000-4000-8000-00000000ABCD'), '0a0f2100-0000-4000-8000-00000000abcd')).toBe(true);
    expect(readinessAnswersOrder(withId('0a0f2100-0000-4000-8000-00000000abcd'), '0a0f2100-0000-4000-8000-00000000abce')).toBe(false);
  });

  it('line ids compare as uuids (the database answers in lower case)', () => {
    const upper = facts({ lines: [{ id: 'aa-l1', item: 'a', requested: 1 }], items: [item('a')] });
    const r = ok(assessOrderReadiness(upper, { now: NOW }));
    expect(reconcileReadiness(r, { status: 'pending_approval', lineIds: ['AA-L1'] })).toBe(r);
  });
});

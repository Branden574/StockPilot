import { afterEach, describe, expect, it, vi } from 'vitest';

import { availableReturnActions } from '@stockpilot/core';

import { buildExchangeView, exchangeItemIds, type RawExchangeLine, type ReplacementRow } from './returns-exchange-workbench';

/**
 * The workbench's exchange half (returns RX-2): the REPLACEMENT column, the
 * rail, the replacement's class and short state, the release, and the facts
 * the actions table needs. Pure assembly from what the reads answered.
 */

const ITEM = (name: string, variant: string | null) => ({
  name,
  sku: null,
  variant,
  deleted: false,
  imageUrl: null,
  thumbUrl: null,
});

const items: Record<string, ReturnType<typeof ITEM>> = {
  m: ITEM('Walk New Hire Shirt', 'Size M'),
  l: ITEM('Walk New Hire Shirt', 'Size L'),
  navy: ITEM('Navy Shirt', 'Size L'),
};

const line = (over: Partial<RawExchangeLine> = {}): RawExchangeLine => ({
  id: 'x1',
  return_line_id: 'rl1',
  status: 'requested',
  requested_item_id: 'l',
  requested_quantity: 1,
  request_note: null,
  requested_by_kind: 'staff',
  approved_item_id: null,
  approved_quantity: null,
  replacement_order_request_id: null,
  revision: 0,
  created_at: '2026-10-05T10:00:00Z',
  ...over,
});

const repl = (over: Partial<ReplacementRow> = {}): ReplacementRow => ({
  id: 'o-new',
  order_number: 104,
  status: 'approved',
  fulfillment_type: 'pickup',
  warehouse_id: 'wh',
  completed_at: null,
  created_at: '2026-10-05T10:05:00Z',
  ...over,
});

function view(input: Partial<Parameters<typeof buildExchangeView>[0]> = {}) {
  return buildExchangeView({
    returnStatus: 'approved',
    rawLines: [],
    overview: null,
    replacements: [],
    detail: null,
    itemOf: (id) => (id ? (items[id] ?? null) : null),
    freeOf: (id) => (id === 'l' ? 14 : id === 'navy' ? 0 : null),
    decisions: [],
    ...input,
  });
}

afterEach(() => vi.unstubAllEnvs());

describe('buildExchangeView', () => {
  it('a plain return: kind return, status none, no rail, nothing approved', () => {
    const v = view();
    expect(v).toMatchObject({ kind: 'return', status: 'none', lines: [], replacement: null, rail: [], hasApprovedExchange: false });
  });

  it('a requested exchange: the requested item with its free stock; the rail starts at Requested', () => {
    const v = view({
      returnStatus: 'requested',
      rawLines: [line()],
      overview: { kind: 'exchange', exchange_status: 'requested', replacement_order_id: null, released_early: false, counter: false },
    });
    expect(v.kind).toBe('exchange');
    expect(v.lines[0]).toMatchObject({ status: 'requested', requestedItem: items.l, requestedFree: 14, approvedItem: null, changedByWarehouse: false });
    expect(v.rail[0]).toMatchObject({ label: 'Requested', state: 'current' });
    expect(v.statusLabel).toBe('Exchange requested');
  });

  it('approved and waiting: the live replacement with its lines, holds and the take line; the class is undrawn', () => {
    const v = view({
      rawLines: [line({ status: 'approved', approved_item_id: 'l', approved_quantity: 1, replacement_order_request_id: 'o-new', revision: 1 })],
      overview: { kind: 'exchange', exchange_status: 'waiting_for_return', replacement_order_id: 'o-new', released_early: false, counter: false },
      replacements: [repl()],
      detail: {
        lines: [{ id: 'ol1', item_id: 'l', quantity_requested: 1, quantity_fulfilled: 0 }],
        heldByItem: new Map([['l', 1]]),
        racksByItem: new Map([['l', [{ name: '12-B', quantity: 3 }, { name: '9-A', quantity: 1 }]]]),
      },
    });
    expect(v.replacement).toMatchObject({ orderId: 'o-new', orderNumber: 104, live: true, class: 'undrawn', owed: 1, held: 1, short: false });
    expect(v.replacement!.lines[0]!.take).toBe('Take Walk New Hire Shirt, L ×1 from 12-B (3 on hand)');
    expect(v.hasApprovedExchange).toBe(true);
    expect(v.rail.map((s) => `${s.label}:${s.state}`)).toEqual([
      'Requested:done',
      'Reserved:done',
      'Waiting for return:current',
      'Picking:upcoming',
      'Ready for pickup:upcoming',
      'Handed over:upcoming',
    ]);
    expect(
      availableReturnActions({
        status: 'approved',
        exchangeStatus: v.status,
        hasExchange: true,
        replacementClass: v.replacement!.class,
        hasApprovedExchange: v.hasApprovedExchange,
        viewerCanManageReturns: true,
        viewerCanApproveOrders: true,
      }).secondary,
    ).toContain('release_early');
  });

  it('a substitution shows "Changed by the warehouse"; a backordered replacement is short', () => {
    const v = view({
      rawLines: [line({ status: 'approved', approved_item_id: 'navy', approved_quantity: 1, replacement_order_request_id: 'o-new' })],
      overview: { kind: 'exchange', exchange_status: 'unavailable', replacement_order_id: 'o-new', released_early: false, counter: false },
      replacements: [repl()],
      detail: { lines: [{ id: 'ol1', item_id: 'navy', quantity_requested: 1, quantity_fulfilled: 0 }], heldByItem: new Map(), racksByItem: new Map() },
    });
    expect(v.lines[0]).toMatchObject({ changedByWarehouse: true, approvedItem: items.navy, approvedFree: 0 });
    expect(v.replacement).toMatchObject({ short: true, held: 0, owed: 1 });
    expect(v.replacement!.lines[0]!.take).toBe('Take Navy Shirt, L ×1');
    expect(v.rail[1]).toMatchObject({ label: 'Not in stock', state: 'current' });
  });

  it('released early: the decision naming the live order gives who and why', () => {
    const v = view({
      rawLines: [line({ status: 'approved', approved_item_id: 'l', approved_quantity: 1, replacement_order_request_id: 'o-new' })],
      overview: { kind: 'exchange', exchange_status: 'ready_to_pick', replacement_order_id: 'o-new', released_early: true, counter: false },
      replacements: [repl()],
      decisions: [
        { kind: 'released_early', reason: 'Old order', actorName: 'X', createdAt: 't0', orderRequestId: 'o-old' },
        { kind: 'released_early', reason: 'Customer is completing an in-person exchange today.', actorName: 'Dana', createdAt: 't1', orderRequestId: 'o-new' },
      ],
    });
    expect(v.releasedEarly).toBe(true);
    expect(v.release).toEqual({ byName: 'Dana', reason: 'Customer is completing an in-person exchange today.', at: 't1' });
    expect(v.rail[2]).toMatchObject({ label: 'Released early', state: 'done' });
  });

  it('a cancelled replacement is history: shown, not live, class none; earlier ones listed', () => {
    const v = view({
      rawLines: [line({ status: 'cancelled', approved_item_id: 'l', approved_quantity: 1, replacement_order_request_id: 'o-new' })],
      overview: { kind: 'exchange', exchange_status: 'replacement_cancelled', replacement_order_id: 'o-new', released_early: false, counter: false },
      replacements: [repl({ status: 'cancelled' }), repl({ id: 'o-old', order_number: 101, status: 'cancelled', created_at: '2026-10-04T00:00:00Z' })],
    });
    expect(v.replacement).toMatchObject({ orderId: 'o-new', live: false, class: 'none', short: false });
    expect(v.history).toEqual([{ orderId: 'o-old', orderNumber: 101, status: 'cancelled' }]);
    expect(v.hasApprovedExchange).toBe(true);
  });

  it('a picked replacement is drawn; one handed over in part is handed_over', () => {
    const drawn = view({
      rawLines: [line({ status: 'approved', approved_item_id: 'l', approved_quantity: 1, replacement_order_request_id: 'o-new' })],
      replacements: [repl({ status: 'staged_for_pickup' })],
      detail: { lines: [{ id: 'ol1', item_id: 'l', quantity_requested: 1, quantity_fulfilled: 0 }], heldByItem: new Map(), racksByItem: new Map() },
    });
    expect(drawn.replacement?.class).toBe('drawn');
    expect(drawn.replacement!.lines[0]!.take).toBeNull();
    const partly = view({
      rawLines: [line({ status: 'approved', approved_item_id: 'l', approved_quantity: 2, replacement_order_request_id: 'o-new' })],
      replacements: [repl({ status: 'backordered' })],
      detail: { lines: [{ id: 'ol1', item_id: 'l', quantity_requested: 2, quantity_fulfilled: 1 }], heldByItem: new Map(), racksByItem: new Map() },
    });
    expect(partly.replacement?.class).toBe('handed_over');
  });

  // Desk check F2: resumed into picking after a part hand-over, it stays
  // handed over, so the workbench offers neither Change nor Cancel replacement.
  it('a backorder resumed into picking after a part hand-over is still handed_over: no change or cancel offered', () => {
    const resumed = view({
      rawLines: [line({ status: 'approved', approved_item_id: 'l', approved_quantity: 2, replacement_order_request_id: 'o-new' })],
      replacements: [repl({ status: 'pick_slip_generated' })],
      overview: { kind: 'exchange', exchange_status: 'in_progress', replacement_order_id: 'o-new', released_early: true, counter: false },
      detail: { lines: [{ id: 'ol1', item_id: 'l', quantity_requested: 2, quantity_fulfilled: 1 }], heldByItem: new Map([['l', 1]]), racksByItem: new Map() },
    });
    expect(resumed.replacement?.class).toBe('handed_over');
    const actions = availableReturnActions({
      status: 'approved',
      exchangeStatus: resumed.status,
      hasExchange: true,
      replacementClass: resumed.replacement!.class,
      hasApprovedExchange: resumed.hasApprovedExchange,
      viewerCanManageReturns: true,
      viewerCanApproveOrders: true,
    });
    expect([actions.primary, ...actions.secondary]).not.toContain('cancel_replacement');
    expect([actions.primary, ...actions.secondary]).not.toContain('change_replacement');
  });

  it('the kill switch reaches the workbench (no "Add a replacement" while off)', () => {
    expect(view().createEnabled).toBe(true);
    vi.stubEnv('RETURNS_EXCHANGE_CREATE', 'off');
    expect(view().createEnabled).toBe(false);
  });

  it('exchangeItemIds: requested and approved items, once each', () => {
    expect(
      exchangeItemIds([line(), line({ id: 'x2', requested_item_id: null, request_note: 'L please', approved_item_id: 'navy' }), line({ id: 'x3' })]).sort(),
    ).toEqual(['l', 'navy']);
  });
});

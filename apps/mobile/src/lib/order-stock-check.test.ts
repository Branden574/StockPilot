import { describe, expect, it } from 'vitest';

import {
  fakePostgrest,
  filterValue,
  inValues,
  uuid,
  type RecordedCall,
} from './__fixtures__/fake-postgrest';
import { IN_FILTER_MAX_VALUES, type PageResult } from './id-batches';
import {
  computeOrderStockFlags,
  loadOrderStockCheck,
  orderStockGates,
  type OrderStockCheck,
  type StockCheckLine,
} from './order-stock-check';

const ORG = 'org-1';

const line = (item_id: string | null, requested: number, fulfilled = 0): StockCheckLine => ({
  item_id,
  quantity_requested: requested,
  quantity_fulfilled: fulfilled,
});

/** A server holding on-hand and open reservations per item. */
function stockServer(opts: {
  onHand: Record<string, number>;
  reserved?: Record<string, number>;
  fail?: 'inventory_items' | 'stock_reservations';
}) {
  return fakePostgrest((call: RecordedCall): PageResult<unknown> => {
    if (opts.fail === call.table) {
      return { data: null, error: { message: 'URI too long' }, status: 414 };
    }
    const ids = (inValues(call, call.table === 'inventory_items' ? 'id' : 'item_id') ?? []) as string[];
    const rows =
      call.table === 'inventory_items'
        ? ids
            .filter((id) => id in opts.onHand)
            .map((id) => ({ id, quantity_on_hand: opts.onHand[id] }))
        : ids
            .filter((id) => (opts.reserved ?? {})[id] !== undefined)
            .map((id) => ({ id: `r-${id}`, item_id: id, quantity: opts.reserved![id] }));
    return { data: rows.slice(call.from, call.to + 1), error: null, status: 200 };
  });
}

describe('computeOrderStockFlags (moved verbatim from the order screen)', () => {
  it('sums duplicate-item lines before judging a pending order short', () => {
    // 3 + 3 requested against 5 available: short only once the lines are summed.
    const flags = computeOrderStockFlags(
      'pending_approval',
      [line('a', 3), line('a', 3)],
      new Map([['a', 5]]),
      new Map(),
    );
    expect(flags).toEqual({ isShortStock: true, hasFulfillableStock: false });
  });

  it('available is on hand minus reserved, floored at 0', () => {
    const onHand = new Map([['a', 10]]);
    expect(
      computeOrderStockFlags('pending_approval', [line('a', 4)], onHand, new Map([['a', 6]])),
    ).toEqual({ isShortStock: false, hasFulfillableStock: false });
    expect(
      computeOrderStockFlags('pending_approval', [line('a', 5)], onHand, new Map([['a', 6]])),
    ).toEqual({ isShortStock: true, hasFulfillableStock: false });
  });

  it('a backorder is fulfillable when an item still owed (requested minus fulfilled) has stock', () => {
    const lines = [line('a', 5, 5), line('b', 4, 1)];
    expect(
      computeOrderStockFlags('backordered', lines, new Map([['a', 9], ['b', 0]]), new Map()),
    ).toEqual({ isShortStock: false, hasFulfillableStock: false });
    expect(
      computeOrderStockFlags('backordered', lines, new Map([['a', 0], ['b', 1]]), new Map()),
    ).toEqual({ isShortStock: false, hasFulfillableStock: true });
  });

  it('ignores lines with no item', () => {
    expect(
      computeOrderStockFlags('pending_approval', [line(null, 99)], new Map(), new Map()),
    ).toEqual({ isShortStock: false, hasFulfillableStock: false });
  });
});

describe('loadOrderStockCheck', () => {
  it('is not needed outside pending_approval and backordered, and makes no request', async () => {
    const client = stockServer({ onHand: {} });
    for (const status of ['approved', 'picking_in_progress', 'completed', null]) {
      expect(await loadOrderStockCheck(client, ORG, status, [line('a', 1)])).toEqual({
        state: 'not_needed',
      });
    }
    expect(await loadOrderStockCheck(client, ORG, 'pending_approval', [line(null, 1)])).toEqual({
      state: 'not_needed',
    });
    expect(client.calls).toHaveLength(0);
  });

  it('computes the flags from both reads when both succeed', async () => {
    const client = stockServer({ onHand: { a: 10, b: 2 }, reserved: { a: 8 } });
    expect(
      await loadOrderStockCheck(client, ORG, 'pending_approval', [line('a', 1), line('b', 2)]),
    ).toEqual({ state: 'ok', isShortStock: false, hasFulfillableStock: false });
    expect(
      await loadOrderStockCheck(client, ORG, 'pending_approval', [line('a', 3), line('b', 2)]),
    ).toEqual({ state: 'ok', isShortStock: true, hasFulfillableStock: false });
  });

  it('a failed ON-HAND read is a failed check, never an order that looks short', async () => {
    // Before: on hand counted as 0, so this fully stocked order offered
    // "Approve partial".
    const client = stockServer({ onHand: { a: 10 }, fail: 'inventory_items' });
    expect(await loadOrderStockCheck(client, ORG, 'pending_approval', [line('a', 1)])).toEqual({
      state: 'failed',
      reason: 'read',
      message: 'URI too long',
    });
  });

  it('a failed RESERVATIONS read is a failed check, never "nothing reserved"', async () => {
    // Before: reserved counted as 0, so availability was overstated and a
    // backorder offered a Resume the server then refused.
    const client = stockServer({ onHand: { a: 5 }, fail: 'stock_reservations' });
    expect(await loadOrderStockCheck(client, ORG, 'backordered', [line('a', 3, 1)])).toEqual({
      state: 'failed',
      reason: 'read',
      message: 'URI too long',
    });
  });

  it('an item whose on-hand row did not come back fails the check (it is not 0 on hand)', async () => {
    // inventory_items RLS hides items outside the viewer's warehouses,
    // charters and categories; the order itself is visible to every member.
    const client = stockServer({ onHand: { a: 10 } });
    const check = await loadOrderStockCheck(client, ORG, 'backordered', [
      line('a', 3, 1),
      line('hidden', 2),
    ]);
    expect(check).toEqual({
      state: 'failed',
      reason: 'hidden_items',
      message: '1 item on this order did not load.',
    });
  });

  it('150 items make 2 on-hand calls and 2 reservation calls, org-scoped', async () => {
    const itemIds = Array.from({ length: 150 }, (_, i) => uuid(i));
    const client = stockServer({ onHand: Object.fromEntries(itemIds.map((i) => [i, 1])) });
    const check = await loadOrderStockCheck(
      client,
      ORG,
      'pending_approval',
      itemIds.map((i) => line(i, 1)),
    );
    expect(check).toEqual({ state: 'ok', isShortStock: false, hasFulfillableStock: false });
    const byTable = (t: string) => client.calls.filter((c) => c.table === t);
    expect(byTable('inventory_items')).toHaveLength(2);
    expect(byTable('stock_reservations')).toHaveLength(2);
    for (const c of client.calls) {
      expect(filterValue(c, 'eq', 'organization_id')).toBe(ORG);
      const vals = inValues(c, c.table === 'inventory_items' ? 'id' : 'item_id');
      expect(vals!.length).toBeLessThanOrEqual(IN_FILTER_MAX_VALUES);
    }
  });
});

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
      notice:
        'Could not check stock for this order. Approve partial is unavailable until it loads.',
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
      notice:
        'Could not check stock for this order. Resume fulfillment is unavailable until it loads.',
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
});

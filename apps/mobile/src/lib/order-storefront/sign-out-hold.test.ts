import { describe, expect, it, vi } from 'vitest';

import { initialCartState, type OrderCallResult, type PendingOrderSubmission } from '@stockpilot/core';

import { accountScopedStorageKeys } from '../account-eviction';
import {
  ORDER_HOLD_PREFIX,
  checkHeldSubmissions,
  createSignOutOrderSubmissions,
  holdCheckFrom,
  holdFor,
  mergeHolds,
  orderHoldKey,
  parseHolds,
  serializeHolds,
  withdrawHeldSubmission,
  type HoldStore,
} from './sign-out-hold';
import { orderDraftKey, serializeOrderDraft } from './store';

const ORG = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const WH = '33333333-3333-4333-8333-333333333333';
const ITEM = '44444444-4444-4444-8444-444444444444';
const KEY = '55555555-5555-4555-8555-555555555555';

const PENDING: PendingOrderSubmission = {
  key: KEY,
  state: 'possibly_sent',
  sends: 2,
  firstSentAt: '2026-10-04T12:00:00.000Z',
  body: {
    idempotencyKey: KEY,
    placerUserId: USER,
    warehouseId: WH,
    fulfillmentType: 'delivery',
    deliveryCharterId: '66666666-6666-4666-8666-666666666666',
    onBehalfOf: { name: 'Maria Lopez', email: 'maria@example.org' },
    notes: 'Room 12, call Sam',
    neededByLocal: '2026-10-05T10:00',
    lines: [
      { itemId: ITEM, quantity: 3 },
      { itemId: '44444444-4444-4444-8444-444444444445', quantity: 2 },
    ],
  },
};

describe('the hold marker (plan 3.6)', () => {
  it('holds ids, a time and two counts only: no name, email, note or item id', () => {
    const hold = holdFor({ orgId: ORG, warehouseId: WH, pending: PENDING });
    expect(hold).toEqual({ orgId: ORG, warehouseId: WH, key: KEY, sentAt: '2026-10-04T12:00:00.000Z', lineCount: 2, unitCount: 5 });
    const raw = serializeHolds([hold])!;
    for (const secret of ['Maria', 'maria@example.org', 'Room 12', ITEM, 'call Sam', '66666666']) {
      expect(raw).not.toContain(secret);
    }
  });

  it('lives OUTSIDE the account-scoped prefix, so a sign-out keeps it', () => {
    expect(orderHoldKey(USER)).toBe(`${ORDER_HOLD_PREFIX}${USER}`);
    expect(accountScopedStorageKeys([orderHoldKey(USER)])).toEqual([]);
  });

  it('round-trips, drops anything that is not exactly a marker, and never keeps an extra field', () => {
    const hold = holdFor({ orgId: ORG, warehouseId: WH, pending: PENDING });
    expect(parseHolds(serializeHolds([hold]))).toEqual([hold]);
    const smuggled = JSON.stringify({ v: 1, holds: [{ ...hold, notes: 'secret' }, { key: 'nope' }, 'x'] });
    expect(parseHolds(smuggled)).toEqual([hold]);
    expect(parseHolds('garbage')).toEqual([]);
    expect(parseHolds(null)).toEqual([]);
    expect(serializeHolds([])).toBeNull();
  });

  it('one marker per organization and key', () => {
    const hold = holdFor({ orgId: ORG, warehouseId: WH, pending: PENDING });
    expect(mergeHolds([hold], [hold])).toEqual([hold]);
  });
});

describe('checking a held key at the next sign-in (a read, never a send)', () => {
  const order = {
    id: 'o1',
    orderNumber: 123,
    orderLabel: 'SO-000123',
    status: 'pending_approval',
    warehouseId: WH,
    fulfillmentType: 'pickup',
    deliveryCharterId: null,
    neededBy: null,
    lineCount: 1,
    unitCount: 1,
    createdAt: 'x',
    requestedFor: { self: true },
  };

  it('placed names its order', () => {
    expect(holdCheckFrom({ ok: true, status: 200, body: { organizationId: ORG, outcome: 'placed', order } }, ORG)).toEqual({
      outcome: 'placed',
      label: 'SO-000123',
    });
  });

  it('refused or withdrawn clears it', () => {
    expect(holdCheckFrom({ ok: true, status: 200, body: { organizationId: ORG, outcome: 'withdrawn' } }, ORG)).toEqual({ outcome: 'settled' });
    expect(
      holdCheckFrom({ ok: true, status: 200, body: { organizationId: ORG, outcome: 'refused', refusal: { reason: 'permission', detail: null } } }, ORG),
    ).toEqual({ outcome: 'settled' });
  });

  it('none, no answer, a refused read, or another organization’s answer keeps it', () => {
    expect(holdCheckFrom({ ok: true, status: 200, body: { organizationId: ORG, outcome: 'none' } }, ORG)).toEqual({ outcome: 'unknown' });
    expect(holdCheckFrom({ ok: false, error: new Error('offline') }, ORG)).toEqual({ outcome: 'unknown' });
    expect(holdCheckFrom({ ok: false, error: { status: 401, code: 'unauthenticated', details: {} } }, ORG)).toEqual({ outcome: 'unknown' });
    expect(
      holdCheckFrom({ ok: true, status: 200, body: { organizationId: '99999999-9999-4999-8999-999999999999', outcome: 'placed', order } }, ORG),
    ).toEqual({ outcome: 'unknown' });
  });
});

// ── The sign-out's and the next sign-in's halves ────────────────────────────

function memory(): HoldStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: async (k) => data.get(k) ?? null,
    setItem: async (k, v) => {
      data.set(k, v);
    },
    removeItem: async (k) => {
      data.delete(k);
    },
    getAllKeys: async () => [...data.keys()],
    multiGet: async (keys) => keys.map((k) => [k, data.get(k) ?? null] as const),
  };
}

const ORDER = {
  id: 'o1',
  orderNumber: 123,
  orderLabel: 'SO-000123',
  status: 'pending_approval',
  warehouseId: WH,
  fulfillmentType: 'pickup',
  deliveryCharterId: null,
  neededBy: null,
  lineCount: 1,
  unitCount: 1,
  createdAt: 'x',
  requestedFor: { self: true },
};
const answer = (body: unknown): OrderCallResult => ({ ok: true, status: 200, body });

function withPendingDraft() {
  const store = memory();
  const scope = { userId: USER, orgId: ORG, warehouseId: WH };
  store.data.set(
    orderDraftKey(scope),
    serializeOrderDraft(scope, { cart: initialCartState({ warehouseId: WH, fulfillmentType: 'pickup' }), submission: PENDING }, new Date()),
  );
  return store;
}

describe('the sign-out’s order-request steps', () => {
  it('counts this account’s unsettled sends on the device; a status read that settles one stops counting it', async () => {
    const store = withPendingDraft();
    const calls = { status: vi.fn(async () => answer({ organizationId: ORG, outcome: 'withdrawn' })), withdraw: vi.fn() };
    const s = createSignOutOrderSubmissions({ userId: USER, store, calls, say: vi.fn() });
    expect(await s.count()).toBe(1);
    await s.settle();
    expect(calls.status).toHaveBeenCalledWith({ orgId: ORG, userId: USER }, KEY);
    expect(calls.withdraw).not.toHaveBeenCalled();
    expect(await s.count()).toBe(0);
  });

  it('status none keeps it counted; Sign out writes ONE marker outside the account’s keys', async () => {
    const store = withPendingDraft();
    const calls = { status: vi.fn(async () => answer({ organizationId: ORG, outcome: 'none' })), withdraw: vi.fn() };
    const s = createSignOutOrderSubmissions({ userId: USER, store, calls, say: vi.fn() });
    await s.settle();
    expect(await s.count()).toBe(1);
    await s.hold();
    await s.hold();
    expect(parseHolds(store.data.get(orderHoldKey(USER)) ?? null)).toEqual([holdFor({ orgId: ORG, warehouseId: WH, pending: PENDING })]);
  });

  it('Don’t send it: withdraws; an order already placed is reported in core’s words', async () => {
    const store = withPendingDraft();
    const say = vi.fn(async () => undefined);
    const calls = { status: vi.fn(), withdraw: vi.fn(async () => answer({ organizationId: ORG, outcome: 'placed', order: ORDER })) };
    const s = createSignOutOrderSubmissions({ userId: USER, store, calls, say });
    const r = await s.withdraw();
    expect(calls.withdraw).toHaveBeenCalledWith({ orgId: ORG, userId: USER }, KEY);
    expect(r).toEqual({ placed: ['SO-000123'] });
    expect(await s.count()).toBe(0);
    await s.report({ placed: r.placed, unanswered: 0 });
    expect(say).toHaveBeenCalledWith('It had already been placed: SO-000123.');
  });

  it('a withdraw with no answer stays counted, and the report says it will be checked at sign-in', async () => {
    const store = withPendingDraft();
    const say = vi.fn(async () => undefined);
    const calls = { status: vi.fn(), withdraw: vi.fn(async (): Promise<OrderCallResult> => ({ ok: false, error: new Error('offline') })) };
    const s = createSignOutOrderSubmissions({ userId: USER, store, calls, say });
    expect(await s.withdraw()).toEqual({ placed: [] });
    expect(await s.count()).toBe(1);
    await s.report({ placed: [], unanswered: 1 });
    expect(say).toHaveBeenCalledWith(
      "It couldn't be checked just now. Sign back in here to find out whether it was placed.",
    );
  });

  it('nothing to say, nothing said', async () => {
    const say = vi.fn(async () => undefined);
    const s = createSignOutOrderSubmissions({ userId: USER, store: memory(), calls: { status: vi.fn(), withdraw: vi.fn() }, say });
    await s.report({ placed: [], unanswered: 0 });
    expect(say).not.toHaveBeenCalled();
  });
});

describe('the next sign-in', () => {
  function held() {
    const store = memory();
    store.data.set(orderHoldKey(USER), serializeHolds([holdFor({ orgId: ORG, warehouseId: WH, pending: PENDING })])!);
    return store;
  }

  it('placed: said, and the marker cleared', async () => {
    const store = held();
    const calls = { status: vi.fn(async () => answer({ organizationId: ORG, outcome: 'placed', order: ORDER })), withdraw: vi.fn() };
    expect(await checkHeldSubmissions({ userId: USER, store, calls })).toEqual({ placed: ['SO-000123'], unknown: [] });
    expect(store.data.has(orderHoldKey(USER))).toBe(false);
    expect(calls.withdraw).not.toHaveBeenCalled();
  });

  it('withdrawn or refused: cleared without a word', async () => {
    const store = held();
    const calls = { status: vi.fn(async () => answer({ organizationId: ORG, outcome: 'withdrawn' })), withdraw: vi.fn() };
    expect(await checkHeldSubmissions({ userId: USER, store, calls })).toEqual({ placed: [], unknown: [] });
    expect(store.data.has(orderHoldKey(USER))).toBe(false);
  });

  it('still none: kept, and offered; Don’t send it settles it', async () => {
    const store = held();
    const calls = {
      status: vi.fn(async () => answer({ organizationId: ORG, outcome: 'none' })),
      withdraw: vi.fn(async () => answer({ organizationId: ORG, outcome: 'withdrawn' })),
    };
    const r = await checkHeldSubmissions({ userId: USER, store, calls });
    expect(r.unknown).toHaveLength(1);
    expect(store.data.has(orderHoldKey(USER))).toBe(true);
    expect(await withdrawHeldSubmission({ userId: USER, store, calls }, r.unknown[0]!)).toEqual({ outcome: 'settled' });
    expect(store.data.has(orderHoldKey(USER))).toBe(false);
  });

  it('another account’s marker is never read', async () => {
    const store = held();
    const calls = { status: vi.fn(), withdraw: vi.fn() };
    expect(await checkHeldSubmissions({ userId: '77777777-7777-4777-8777-777777777777', store, calls })).toEqual({ placed: [], unknown: [] });
    expect(calls.status).not.toHaveBeenCalled();
  });

  it('a key still live in this device’s drafts is left to the storefront', async () => {
    const store = withPendingDraft();
    store.data.set(orderHoldKey(USER), serializeHolds([holdFor({ orgId: ORG, warehouseId: WH, pending: PENDING })])!);
    const calls = { status: vi.fn(), withdraw: vi.fn() };
    expect(await checkHeldSubmissions({ userId: USER, store, calls })).toEqual({ placed: [], unknown: [] });
    expect(calls.status).not.toHaveBeenCalled();
    expect(store.data.has(orderHoldKey(USER))).toBe(true);
  });
});

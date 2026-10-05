import { describe, expect, it, vi } from 'vitest';

import {
  SIGN_IN_HELD_DROPPED_COPY,
  SIGN_IN_HELD_WITHDRAWN_COPY,
  SIGN_IN_HELD_WITHDRAW_UNANSWERED_COPY,
  initialCartState,
  type OrderCallResult,
  type PendingOrderSubmission,
} from '@stockpilot/core';

import { accountScopedStorageKeys } from '../account-eviction';
import {
  ORDER_HOLD_PREFIX,
  checkHeldSubmissions,
  createSignOutOrderSubmissions,
  heldWithdrawSentence,
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
    expect(await checkHeldSubmissions({ userId: USER, store, calls })).toEqual({ placed: ['SO-000123'], unknown: [], dropped: 0 });
    expect(store.data.has(orderHoldKey(USER))).toBe(false);
    expect(calls.withdraw).not.toHaveBeenCalled();
  });

  it('withdrawn or refused: cleared without a word', async () => {
    const store = held();
    const calls = { status: vi.fn(async () => answer({ organizationId: ORG, outcome: 'withdrawn' })), withdraw: vi.fn() };
    expect(await checkHeldSubmissions({ userId: USER, store, calls })).toEqual({ placed: [], unknown: [], dropped: 0 });
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
    expect(await checkHeldSubmissions({ userId: '77777777-7777-4777-8777-777777777777', store, calls })).toEqual({ placed: [], unknown: [], dropped: 0 });
    expect(calls.status).not.toHaveBeenCalled();
  });

  it('a key still live in this device’s drafts is left to the storefront', async () => {
    const store = withPendingDraft();
    store.data.set(orderHoldKey(USER), serializeHolds([holdFor({ orgId: ORG, warehouseId: WH, pending: PENDING })])!);
    const calls = { status: vi.fn(), withdraw: vi.fn() };
    expect(await checkHeldSubmissions({ userId: USER, store, calls })).toEqual({ placed: [], unknown: [], dropped: 0 });
    expect(calls.status).not.toHaveBeenCalled();
    expect(store.data.has(orderHoldKey(USER))).toBe(true);
  });
});

describe('the sign-in and sign-out edges (desk check F5)', () => {
  const notMember = (): OrderCallResult => ({
    ok: false,
    error: { status: 403, code: 'forbidden', details: { reason: 'not_member', organizationId: ORG } },
  });
  function held(sentAt = PENDING.firstSentAt) {
    const store = memory();
    store.data.set(orderHoldKey(USER), serializeHolds([{ ...holdFor({ orgId: ORG, warehouseId: WH, pending: PENDING }), sentAt }])!);
    return store;
  }

  it('F5.1 a status read at sign-out that finds it placed is said before the session ends', async () => {
    const store = withPendingDraft();
    const say = vi.fn(async () => undefined);
    const calls = { status: vi.fn(async () => answer({ organizationId: ORG, outcome: 'placed', order: ORDER })), withdraw: vi.fn() };
    const s = createSignOutOrderSubmissions({ userId: USER, store, calls, say });
    expect(await s.settle()).toEqual({ placed: ['SO-000123'] });
    await s.reportPlaced(['SO-000123']);
    expect(say).toHaveBeenCalledWith('Your order request SO-000123 was placed.');
    await s.reportPlaced([]);
    expect(say).toHaveBeenCalledTimes(1);
  });

  it('F5.2 Don’t send it at sign-in says what happened, and no answer says it will be asked again', () => {
    expect(heldWithdrawSentence({ outcome: 'settled' })).toBe(SIGN_IN_HELD_WITHDRAWN_COPY);
    expect(heldWithdrawSentence({ outcome: 'placed', label: 'SO-000123' })).toBe('It had already been placed: SO-000123.');
    expect(heldWithdrawSentence({ outcome: 'unknown' })).toBe(SIGN_IN_HELD_WITHDRAW_UNANSWERED_COPY);
    expect(heldWithdrawSentence({ outcome: 'gone' })).toBe(SIGN_IN_HELD_DROPPED_COPY);
  });

  it('F5.3 a refusal that names membership drops the marker, once, with a sentence', async () => {
    expect(holdCheckFrom(notMember(), ORG)).toEqual({ outcome: 'gone' });
    const store = held();
    const calls = { status: vi.fn(async () => notMember()), withdraw: vi.fn() };
    expect(await checkHeldSubmissions({ userId: USER, store, calls })).toEqual({ placed: [], unknown: [], dropped: 1 });
    expect(store.data.has(orderHoldKey(USER))).toBe(false);
  });

  it('F5.3 an organization missing from the account’s memberships drops it without a call; an unread list never does', async () => {
    const store = held();
    const calls = { status: vi.fn(async () => answer({ organizationId: ORG, outcome: 'none' })), withdraw: vi.fn() };
    expect(await checkHeldSubmissions({ userId: USER, store, calls, memberOrgIds: async () => [] })).toMatchObject({ unknown: [{ key: KEY }], dropped: 0 });
    expect(await checkHeldSubmissions({ userId: USER, store, calls, memberOrgIds: async () => null })).toMatchObject({ dropped: 0 });
    expect(await checkHeldSubmissions({ userId: USER, store, calls, memberOrgIds: async () => Promise.reject(new Error('offline')) })).toMatchObject({ dropped: 0 });
    expect(await checkHeldSubmissions({ userId: USER, store, calls, memberOrgIds: async () => [ORG] })).toMatchObject({ dropped: 0 });
    calls.status.mockClear();
    expect(await checkHeldSubmissions({ userId: USER, store, calls, memberOrgIds: async () => ['99999999-9999-4999-8999-999999999999'] })).toEqual({
      placed: [],
      unknown: [],
      dropped: 1,
    });
    expect(calls.status).not.toHaveBeenCalled();
    expect(store.data.has(orderHoldKey(USER))).toBe(false);
  });

  it('F5.3 still unknown after 30 days: dropped with the sentence; before that, kept', async () => {
    const now = Date.parse('2026-10-04T12:00:00.000Z');
    const calls = { status: vi.fn(async () => answer({ organizationId: ORG, outcome: 'none' })), withdraw: vi.fn() };
    const fresh = held('2026-09-10T12:00:00.000Z');
    expect(await checkHeldSubmissions({ userId: USER, store: fresh, calls, now: () => now })).toMatchObject({ dropped: 0, unknown: [{ key: KEY }] });
    const old = held('2026-09-03T11:00:00.000Z');
    expect(await checkHeldSubmissions({ userId: USER, store: old, calls, now: () => now })).toEqual({ placed: [], unknown: [], dropped: 1 });
    expect(old.data.has(orderHoldKey(USER))).toBe(false);
    // A placed answer is still said, however old.
    const placedOld = held('2026-08-01T00:00:00.000Z');
    calls.status.mockResolvedValueOnce(answer({ organizationId: ORG, outcome: 'placed', order: ORDER }));
    expect(await checkHeldSubmissions({ userId: USER, store: placedOld, calls, now: () => now })).toEqual({ placed: ['SO-000123'], unknown: [], dropped: 0 });
  });

  it('F5.3 Don’t send it answered with a membership refusal clears the marker', async () => {
    const store = held();
    const calls = { status: vi.fn(), withdraw: vi.fn(async () => notMember()) };
    const hold = parseHolds(store.data.get(orderHoldKey(USER)) ?? null)[0]!;
    expect(await withdrawHeldSubmission({ userId: USER, store, calls }, hold)).toEqual({ outcome: 'gone' });
    expect(store.data.has(orderHoldKey(USER))).toBe(false);
  });
});

// PO-4 review (probe P3): the sign-in check read the marker once, ran its
// reads (up to 20 s each), then wrote back what it had read less what it
// settled. A sign-out that held a new key in the meantime lost that key: the
// check removed the whole marker, and the next sign-in said nothing about it.
describe('the marker is changed by a fresh read, never by an old one (PO-4 review, probe P3)', () => {
  const K_OLD = KEY;
  const K_NEW = '55555555-5555-4555-8555-555555555556';
  const WH2 = '33333333-3333-4333-8333-333333333334';
  const pendingNew: PendingOrderSubmission = { ...PENDING, key: K_NEW, body: { ...PENDING.body, idempotencyKey: K_NEW, warehouseId: WH2 } };

  it('a key held by a sign-out while the check’s status read is out is kept; only the key the check settled goes', async () => {
    const store = memory();
    store.data.set(orderHoldKey(USER), serializeHolds([holdFor({ orgId: ORG, warehouseId: WH, pending: PENDING })])!);
    const draft = { userId: USER, orgId: ORG, warehouseId: WH2 };
    store.data.set(
      orderDraftKey(draft),
      serializeOrderDraft(draft, { cart: initialCartState({ warehouseId: WH2, fulfillmentType: 'pickup' }), submission: pendingNew }, new Date()),
    );
    let release: (r: OrderCallResult) => void = () => undefined;
    const calls = {
      status: vi.fn((_s: unknown, key: string) =>
        key === K_OLD ? new Promise<OrderCallResult>((r) => (release = r)) : Promise.resolve(answer({ organizationId: ORG, outcome: 'none' })),
      ),
      withdraw: vi.fn(),
    };
    const checking = checkHeldSubmissions({ userId: USER, store, calls });
    await vi.waitFor(() => expect(calls.status).toHaveBeenCalledWith({ orgId: ORG, userId: USER }, K_OLD));
    // A sign-out now: K_NEW is held, and the account's drafts go.
    const signOut = createSignOutOrderSubmissions({ userId: USER, store, calls: { status: vi.fn(), withdraw: vi.fn() }, say: vi.fn() });
    await signOut.hold();
    store.data.delete(orderDraftKey(draft));
    expect(parseHolds(store.data.get(orderHoldKey(USER)) ?? null).map((h) => h.key)).toEqual([K_OLD, K_NEW]);
    release(answer({ organizationId: ORG, outcome: 'placed', order: ORDER }));
    expect(await checking).toEqual({ placed: ['SO-000123'], unknown: [], dropped: 0 });
    expect(parseHolds(store.data.get(orderHoldKey(USER)) ?? null).map((h) => h.key)).toEqual([K_NEW]);
  });

  it('a check that settles nothing writes nothing', async () => {
    const store = memory();
    const raw = serializeHolds([holdFor({ orgId: ORG, warehouseId: WH, pending: PENDING })])!;
    store.data.set(orderHoldKey(USER), raw);
    const setItem = vi.spyOn(store, 'setItem');
    const removeItem = vi.spyOn(store, 'removeItem');
    const calls = { status: vi.fn(async () => answer({ organizationId: ORG, outcome: 'none' })), withdraw: vi.fn() };
    await checkHeldSubmissions({ userId: USER, store, calls });
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
    expect(store.data.get(orderHoldKey(USER))).toBe(raw);
  });

  it('Don’t send it at sign-in removes only its own key from what the marker holds then', async () => {
    const store = memory();
    store.data.set(orderHoldKey(USER), serializeHolds([holdFor({ orgId: ORG, warehouseId: WH, pending: PENDING })])!);
    let release: (r: OrderCallResult) => void = () => undefined;
    const calls = { status: vi.fn(), withdraw: vi.fn(() => new Promise<OrderCallResult>((r) => (release = r))) };
    const hold = parseHolds(store.data.get(orderHoldKey(USER)) ?? null)[0]!;
    const withdrawing = withdrawHeldSubmission({ userId: USER, store, calls }, hold);
    await vi.waitFor(() => expect(calls.withdraw).toHaveBeenCalled());
    store.data.set(
      orderHoldKey(USER),
      serializeHolds([hold, holdFor({ orgId: ORG, warehouseId: WH2, pending: pendingNew })])!,
    );
    release(answer({ organizationId: ORG, outcome: 'withdrawn' }));
    expect(await withdrawing).toEqual({ outcome: 'settled' });
    expect(parseHolds(store.data.get(orderHoldKey(USER)) ?? null).map((h) => h.key)).toEqual([K_NEW]);
  });
});

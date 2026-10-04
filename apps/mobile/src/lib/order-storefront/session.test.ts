import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ORDER_ADD_WHILE_LOCKED_COPY,
  ORDER_WITHDRAWN_COPY,
  ORDER_NEEDS_CONNECTION_COPY,
  ORDER_PHONE_TURNED_OFF_COPY,
  STOREFRONT_CART_LOCKED_COPY,
  STOREFRONT_SHIP_FROM_LOCKED_COPY,
  SUBMIT_ON_BEHALF_NOT_PERMITTED_COPY,
  SUBMIT_REMOVE_UNORDERABLE_COPY,
  initialCartState,
  type OrderCallResult,
  type OrderCatalogAnswer,
  type OrderStorefrontAnswer,
  type PendingOrderSubmission,
} from '@stockpilot/core';

import { OrderAnswerForAnotherOrganization, type OrderStorefrontApi } from './api';
import { storefrontOutcome } from './outcome';
import { createStorefrontSession, type SessionStore, type StorefrontSession } from './session';
import {
  orderCatalogKey,
  orderDraftKey,
  orderPrefsKey,
  parseStoredOrderDraft,
  serializeCatalog,
  serializeOrderDraft,
} from './store';

const ORG = '11111111-1111-4111-8111-111111111111';
const ORG2 = '99999999-9999-4999-8999-999999999999';
const USER = '22222222-2222-4222-8222-222222222222';
const WH = '33333333-3333-4333-8333-333333333333';
const WH2 = '33333333-3333-4333-8333-333333333334';
const A = '44444444-4444-4444-8444-444444444444';
const B = '44444444-4444-4444-8444-444444444445';
const KEY = '55555555-5555-4555-8555-555555555555';
const ORDER = '66666666-6666-4666-8666-666666666666';

function storefrontAnswer(orgId = ORG): OrderStorefrontAnswer {
  return {
    organizationId: orgId,
    enabled: true,
    serverNow: '2026-10-04T12:00:00.000Z',
    warehouses: [
      { id: WH, name: 'DC4' },
      { id: WH2, name: 'East' },
    ],
    viewer: { userId: USER, role: 'staff', name: 'Pat', email: 'pat@x.org', canOrderOnBehalf: false, canApproveOrders: false },
    kitsEnabled: false,
    orgTimezone: 'America/Los_Angeles',
    deliveryRecipients: null,
    recentRequesters: null,
  };
}

function catalogAnswer(warehouseId = WH, available = 10, orgId = ORG): OrderCatalogAnswer {
  return {
    organizationId: orgId,
    warehouseId,
    generatedAt: '2026-10-04T12:00:00.000Z',
    staleAfterSeconds: 60,
    rowCeiling: 10000,
    truncated: false,
    items: [
      { id: A, sku: 'PL', name: 'Planner', categoryId: null, charterId: null, rackLabel: null, quantityOnHand: available, reservedQuantity: 0, reorderPoint: 0 },
    ],
    aisles: [{ id: null, name: 'Uncategorized', itemCount: 1 }],
    charters: {},
    sites: { status: 'ok', sites: [] },
    kits: { status: 'ok', kits: [] },
    frequentlyOrdered: { status: 'ok', items: [] },
  };
}

const SUMMARY = {
  id: ORDER,
  orderNumber: 123,
  orderLabel: 'SO-000123',
  status: 'pending_approval',
  warehouseId: WH,
  fulfillmentType: 'pickup',
  deliveryCharterId: null,
  neededBy: null,
  lineCount: 1,
  unitCount: 2,
  createdAt: '2026-10-04T12:00:00.000Z',
  requestedFor: { self: true },
};

function memoryStore(): SessionStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    async getItem(k) {
      return data.get(k) ?? null;
    },
    async setItem(k, v) {
      data.set(k, v);
    },
    async removeItem(k) {
      data.delete(k);
    },
    async getAllKeys() {
      return [...data.keys()];
    },
    async multiGet(keys) {
      return keys.map((k) => [k, data.get(k) ?? null] as const);
    },
  };
}

let store: ReturnType<typeof memoryStore>;
let api: { [K in keyof OrderStorefrontApi]: ReturnType<typeof vi.fn> };
let epoch = 1;
let now = Date.parse('2026-10-04T12:00:00.000Z');
let session: StorefrontSession;
// Each writer's waiting save, by its handle (a writer clears only its own).
const timers = new Map<number, () => void>();
let timerSeq = 0;

function makeSession() {
  return createStorefrontSession({
    api: api as unknown as OrderStorefrontApi,
    store,
    epoch: () => epoch,
    now: () => now,
    mintKey: () => KEY,
    setTimer: (fn) => {
      timerSeq += 1;
      timers.set(timerSeq, fn);
      return timerSeq;
    },
    clearTimer: (handle) => {
      timers.delete(handle as number);
    },
  });
}

async function flushSaves() {
  for (const [id, fn] of [...timers]) {
    timers.delete(id);
    fn();
  }
  await new Promise((r) => setTimeout(r, 0));
}

const scope = { userId: USER, orgId: ORG, activeWarehouseId: null };
const snap = () => session.getSnapshot();
const draftKey = orderDraftKey({ userId: USER, orgId: ORG, warehouseId: WH });

beforeEach(() => {
  store = memoryStore();
  epoch = 1;
  now = Date.parse('2026-10-04T12:00:00.000Z');
  timers.clear();
  api = {
    storefront: vi.fn(async () => storefrontAnswer()),
    catalog: vi.fn(async (_s, wh: string) => catalogAnswer(wh)),
    photos: vi.fn(async (_s, wh: string) => ({ organizationId: ORG, warehouseId: wh, photos: {}, signedAt: new Date(now).toISOString(), expiresAt: new Date(now + 30 * 864e5).toISOString() })),
    place: vi.fn(async (): Promise<OrderCallResult> => ({ ok: true, status: 201, body: { organizationId: ORG, result: { replay: false, order: SUMMARY } } })),
    status: vi.fn(async (): Promise<OrderCallResult> => ({ ok: true, status: 200, body: { organizationId: ORG, outcome: 'none' } })),
    withdraw: vi.fn(async (): Promise<OrderCallResult> => ({ ok: true, status: 200, body: { organizationId: ORG, outcome: 'withdrawn' } })),
  };
  session = makeSession();
});

describe('opening the storefront', () => {
  it('reads the storefront once, picks Ship from, shows the device’s catalog at once and then reads it fresh', async () => {
    store.data.set(orderCatalogKey({ userId: USER, orgId: ORG, warehouseId: WH }), serializeCatalog(catalogAnswer(WH, 3), now - 120_000));
    const seen: { fromDevice: boolean; status: string }[] = [];
    session.subscribe(() => seen.push({ fromDevice: snap().catalog.fromDevice, status: snap().catalog.status }));
    await session.open(scope);
    expect(api.storefront).toHaveBeenCalledWith({ userId: USER, orgId: ORG });
    expect(snap().warehouseId).toBe(WH);
    expect(seen.some((s) => s.fromDevice && s.status === 'ready')).toBe(true);
    expect(snap().catalog).toMatchObject({ status: 'ready', fromDevice: false, readAt: now });
    expect(snap().items[0]).toMatchObject({ id: A, quantityOnHand: 10 });
    expect(store.data.get(orderPrefsKey({ userId: USER, orgId: ORG }))).toBe(JSON.stringify({ lastWarehouseId: WH }));
  });

  it('the kill switch: off, in core’s words, and nothing is read for a warehouse', async () => {
    api.storefront.mockResolvedValueOnce({ organizationId: ORG, enabled: false, message: ORDER_PHONE_TURNED_OFF_COPY, serverNow: 'x' });
    await session.open(scope);
    expect(snap().setup).toEqual({ status: 'off', message: ORDER_PHONE_TURNED_OFF_COPY });
    expect(api.catalog).not.toHaveBeenCalled();
  });

  it('an old server (404 not ours) reads as off; a refusal as refused; no answer as failed', async () => {
    api.storefront.mockRejectedValueOnce({ status: 404 });
    await session.open(scope);
    expect(snap().setup.status).toBe('off');
    session.close();
    api.storefront.mockRejectedValueOnce({ status: 403, code: 'forbidden', details: { reason: 'permission' } });
    await session.open(scope);
    expect(snap().setup.status).toBe('refused');
    session.close();
    api.storefront.mockRejectedValueOnce(new Error('Network request failed'));
    await session.open(scope);
    expect(snap().setup.status).toBe('failed');
  });

  it('the last warehouse used for ordering wins over the first by name', async () => {
    store.data.set(orderPrefsKey({ userId: USER, orgId: ORG }), JSON.stringify({ lastWarehouseId: WH2 }));
    await session.open(scope);
    expect(snap().warehouseId).toBe(WH2);
  });
});

describe('the cart (one per warehouse, saved on the device)', () => {
  it('a change is saved 250 ms later, under this account’s key', async () => {
    await session.open(scope);
    expect(session.dispatch({ type: 'add', itemId: A, quantity: 2 })).toBeNull();
    expect(store.data.has(draftKey)).toBe(false);
    await flushSaves();
    expect(parseStoredOrderDraft(store.data.get(draftKey)!, { userId: USER, orgId: ORG, warehouseId: WH })?.cart.lines).toEqual([
      { itemId: A, quantity: 2 },
    ]);
  });

  it('each warehouse keeps its own cart', async () => {
    await session.open(scope);
    session.dispatch({ type: 'add', itemId: A, quantity: 2 });
    await flushSaves();
    await session.selectWarehouse(WH2);
    expect(snap().cart?.lines).toEqual([]);
    await session.selectWarehouse(WH);
    expect(snap().cart?.lines).toEqual([{ itemId: A, quantity: 2 }]);
  });

  it('a save still waiting when the account ends is never written', async () => {
    await session.open(scope);
    session.dispatch({ type: 'add', itemId: A, quantity: 2 });
    epoch = 2;
    await flushSaves();
    expect(store.data.has(draftKey)).toBe(false);
  });

  it('a restored cart is checked against the fresh catalog: one sentence, nothing dropped', async () => {
    const cart = { ...initialCartState({ warehouseId: WH, fulfillmentType: 'pickup' as const }), lines: [{ itemId: A, quantity: 50 }, { itemId: B, quantity: 1 }] };
    store.data.set(draftKey, serializeOrderDraft({ userId: USER, orgId: ORG, warehouseId: WH }, { cart, submission: null }, new Date()));
    await session.open(scope);
    expect(snap().cart?.lines).toEqual(cart.lines);
    expect([...snap().notOrderable]).toEqual([B]);
    expect(snap().notice).toMatch(/^Since this cart was saved, 1 item can't be ordered from here anymore, and 1 line asks for more/);
    expect(session.submitBlockedBy(false)).toBe(SUBMIT_REMOVE_UNORDERABLE_COPY);
    session.dispatch({ type: 'remove', itemId: B });
    expect(snap().notOrderable.size).toBe(0);
    expect(snap().notice).toBeNull();
    expect(session.submitBlockedBy(false)).toBeNull();
  });
});

describe('submitting', () => {
  it('needs a connection (nothing about an order is queued offline)', async () => {
    await session.open(scope);
    session.dispatch({ type: 'add', itemId: A, quantity: 2 });
    expect(session.submitBlockedBy(true)).toBe(ORDER_NEEDS_CONNECTION_COPY);
    await session.submit(true);
    expect(api.place).not.toHaveBeenCalled();
  });

  it('the pending send is under the draft key BEFORE the request leaves; placed clears the cart and the record', async () => {
    await session.open(scope);
    session.dispatch({ type: 'add', itemId: A, quantity: 2 });
    let atSend: string | undefined;
    api.place.mockImplementationOnce(async (s, body, onSend: () => void) => {
      atSend = store.data.get(draftKey);
      onSend();
      expect(s).toEqual({ userId: USER, orgId: ORG });
      expect(body).toMatchObject({ idempotencyKey: KEY, placerUserId: USER, warehouseId: WH, lines: [{ itemId: A, quantity: 2 }] });
      return { ok: true, status: 201, body: { organizationId: ORG, result: { replay: false, order: SUMMARY } } };
    });
    await session.submit(false);
    const stored = parseStoredOrderDraft(atSend!, { userId: USER, orgId: ORG, warehouseId: WH });
    expect(stored?.submission).toMatchObject({ key: KEY, sends: 1 });
    expect(snap().submission.state.phase).toBe('placed');
    expect(snap().placed).toMatchObject({ order: { orderLabel: 'SO-000123' }, body: { idempotencyKey: KEY } });
    expect(snap().cart?.lines).toEqual([]);
    expect(store.data.has(draftKey)).toBe(false);
    session.finishPlaced();
    expect(snap().placed).toBeNull();
    expect(snap().submission.state.phase).toBe('open');
  });

  it('a lost answer locks the cart: every change, Clear and the warehouse switch are refused in core’s words', async () => {
    await session.open(scope);
    session.dispatch({ type: 'add', itemId: A, quantity: 2 });
    api.place.mockResolvedValueOnce({ ok: false, error: new Error('Request timed out.') });
    await session.submit(false);
    expect(snap().locked).toBe(true);
    expect(session.dispatch({ type: 'add', itemId: A })).toBe(ORDER_ADD_WHILE_LOCKED_COPY);
    expect(session.dispatch({ type: 'clear' })).toBe(STOREFRONT_CART_LOCKED_COPY);
    expect(session.dispatch({ type: 'set-notes', value: 'x' })).toBe(STOREFRONT_CART_LOCKED_COPY);
    expect(await session.selectWarehouse(WH2)).toBe(STOREFRONT_SHIP_FROM_LOCKED_COPY);
    expect(snap().warehouseId).toBe(WH);
    expect(snap().cart?.lines).toEqual([{ itemId: A, quantity: 2 }]);
    expect(snap().lockedWarehouseIds).toEqual([WH]);
  });

  it('a refused item is marked from the cart until its line is removed', async () => {
    await session.open(scope);
    session.dispatch({ type: 'add', itemId: A, quantity: 2 });
    api.place.mockResolvedValueOnce({
      ok: false,
      error: { status: 400, code: 'validation_error', details: { reason: 'item_not_orderable', settled: true, items: { [A]: 'archived' }, organizationId: ORG } },
    });
    await session.submit(false);
    expect(snap().submission.state.phase).toBe('refused');
    expect([...snap().notOrderable]).toEqual([A]);
    session.dispatch({ type: 'remove', itemId: A });
    expect(snap().notOrderable.size).toBe(0);
    expect(snap().submission.state.phase).toBe('open');
  });
});

describe('a relaunch with a send not settled', () => {
  const pending: PendingOrderSubmission = {
    key: KEY,
    state: 'possibly_sent',
    sends: 1,
    firstSentAt: '2026-10-04T11:00:00.000Z',
    body: {
      idempotencyKey: KEY,
      placerUserId: USER,
      warehouseId: WH,
      fulfillmentType: 'pickup',
      deliveryCharterId: null,
      onBehalfOf: null,
      notes: null,
      neededByLocal: null,
      lines: [{ itemId: A, quantity: 4 }],
    },
  };

  it('opens on that warehouse, locked, showing what was sent; its status is read on its own and it is never resent', async () => {
    store.data.set(orderPrefsKey({ userId: USER, orgId: ORG }), JSON.stringify({ lastWarehouseId: WH2 }));
    const edited = { ...initialCartState({ warehouseId: WH, fulfillmentType: 'pickup' as const }), lines: [{ itemId: A, quantity: 99 }] };
    store.data.set(draftKey, serializeOrderDraft({ userId: USER, orgId: ORG, warehouseId: WH }, { cart: edited, submission: pending }, new Date()));
    await session.open(scope);
    expect(snap().warehouseId).toBe(WH);
    expect(snap().locked).toBe(true);
    expect(snap().cart?.lines).toEqual([{ itemId: A, quantity: 4 }]);
    await vi.waitFor(() => expect(api.status).toHaveBeenCalledWith({ userId: USER, orgId: ORG }, KEY));
    expect(api.place).not.toHaveBeenCalled();
    expect(api.withdraw).not.toHaveBeenCalled();
    expect(snap().submission.state.phase).toBe('unconfirmed');
    expect(snap().notice).toBeNull();
  });

  it('focus reads the status again; a placed answer shows the success screen', async () => {
    store.data.set(draftKey, serializeOrderDraft({ userId: USER, orgId: ORG, warehouseId: WH }, { cart: initialCartState({ warehouseId: WH, fulfillmentType: 'pickup' }), submission: pending }, new Date()));
    await session.open(scope);
    await vi.waitFor(() => expect(api.status).toHaveBeenCalledTimes(1));
    api.status.mockResolvedValueOnce({ ok: true, status: 200, body: { organizationId: ORG, outcome: 'placed', order: SUMMARY } });
    await session.focus();
    await vi.waitFor(() => expect(snap().submission.state.phase).toBe('placed'));
    expect(snap().placed?.body).toEqual(pending.body);
  });

  it('with the kill switch on, the locked send is still restored and settles (create and settle stay up); nothing else is read', async () => {
    api.storefront.mockResolvedValueOnce({ organizationId: ORG, enabled: false, message: ORDER_PHONE_TURNED_OFF_COPY, serverNow: 'x' });
    store.data.set(draftKey, serializeOrderDraft({ userId: USER, orgId: ORG, warehouseId: WH }, { cart: initialCartState({ warehouseId: WH, fulfillmentType: 'pickup' }), submission: pending }, new Date()));
    api.status.mockResolvedValueOnce({ ok: true, status: 200, body: { organizationId: ORG, outcome: 'placed', order: SUMMARY } });
    await session.open(scope);
    expect(snap().setup.status).toBe('off');
    expect(snap().warehouseId).toBe(WH);
    await vi.waitFor(() => expect(snap().submission.state.phase).toBe('placed'));
    expect(api.catalog).not.toHaveBeenCalled();
    expect(api.photos).not.toHaveBeenCalled();
    expect(api.place).not.toHaveBeenCalled();
  });

  it('Don’t send it settles it, and the cart unlocks', async () => {
    store.data.set(draftKey, serializeOrderDraft({ userId: USER, orgId: ORG, warehouseId: WH }, { cart: initialCartState({ warehouseId: WH, fulfillmentType: 'pickup' }), submission: pending }, new Date()));
    await session.open(scope);
    await vi.waitFor(() => expect(snap().submission.busy).toBe(false));
    await session.dontSend();
    expect(api.withdraw).toHaveBeenCalledWith({ userId: USER, orgId: ORG }, KEY);
    expect(snap().submission.state.phase).toBe('withdrawn');
    expect(snap().locked).toBe(false);
  });
});

describe('a workspace switch', () => {
  it('starts over: nothing of the old organization shows, and its late answers are dropped', async () => {
    let release: (v: OrderCatalogAnswer) => void = () => undefined;
    api.catalog.mockImplementationOnce(() => new Promise<OrderCatalogAnswer>((r) => (release = r)));
    const first = session.open(scope);
    await vi.waitFor(() => expect(api.catalog).toHaveBeenCalledTimes(1));
    api.storefront.mockResolvedValueOnce(storefrontAnswer(ORG2));
    api.catalog.mockImplementation(async (_s, wh: string) => catalogAnswer(wh, 1, ORG2));
    await session.open({ userId: USER, orgId: ORG2, activeWarehouseId: null });
    release(catalogAnswer(WH, 777));
    await first;
    expect(snap().scope).toEqual({ userId: USER, orgId: ORG2 });
    expect(snap().items[0]?.quantityOnHand).toBe(1);
  });

  it('an answer for another organization is dropped without a word', async () => {
    api.catalog.mockRejectedValueOnce(new OrderAnswerForAnotherOrganization());
    await session.open(scope);
    expect(snap().catalog.message).toBeNull();
  });
});

describe('checkout', () => {
  it('reads the catalog again and says, once, what stock moved under the cart', async () => {
    await session.open(scope);
    session.dispatch({ type: 'add', itemId: A, quantity: 9 });
    api.catalog.mockResolvedValueOnce(catalogAnswer(WH, 8));
    await session.openCheckout();
    expect(snap().notice).toBe('Stock changed since you added: Planner now has 8 available, and you have 9.');
    expect(session.submitBlockedBy(false)).toBeNull();
  });

  it('the catalog is read again on focus only once it is stale (never on a timer)', async () => {
    await session.open(scope);
    expect(api.catalog).toHaveBeenCalledTimes(1);
    now += 30_000;
    await session.focus();
    expect(api.catalog).toHaveBeenCalledTimes(1);
    now += 31_000;
    await session.focus();
    expect(api.catalog).toHaveBeenCalledTimes(2);
  });
});

describe('quantities, kits and the server’s clock', () => {
  const KIT = { bundleId: 'b1', name: 'Starter', sku: null, components: [{ anchorItemId: A, itemIds: [A], perKit: 4 }] };

  it('a typed quantity is clamped to what is available; 0 removes the line', async () => {
    await session.open(scope);
    session.setQuantity(A, 99);
    expect(snap().cart?.lines).toEqual([{ itemId: A, quantity: 10 }]);
    session.setQuantity(A, 0);
    expect(snap().cart?.lines).toEqual([]);
  });

  it('a kit is all or nothing, in core’s words when it does not fit', async () => {
    api.catalog.mockImplementation(async (_s, wh: string) => ({ ...catalogAnswer(wh, 10), kits: { status: 'ok', kits: [KIT] } }));
    await session.open(scope);
    expect(session.changeKit('b1', 2)).toBeNull();
    expect(snap().cart?.lines).toEqual([{ itemId: A, quantity: 8 }]);
    expect(snap().cart?.kits).toEqual({ b1: { [A]: 8 } });
    expect(session.changeKit('b1', 3)).toBe('Not enough Planner for that many kits. Nothing was added.');
    expect(snap().cart?.lines).toEqual([{ itemId: A, quantity: 8 }]);
    expect(session.changeKit('b1', 0)).toBeNull();
    expect(snap().cart?.lines).toEqual([]);
  });

  it('the needed-by picker’s now is the server’s clock', async () => {
    api.storefront.mockResolvedValueOnce({ ...storefrontAnswer(), serverNow: new Date(now + 90_000).toISOString() });
    await session.open(scope);
    expect(snap().serverSkewMs).toBe(90_000);
  });
});

describe('an answer that lands after a workspace switch (desk check F1)', () => {
  const WHB = '77777777-7777-4777-8777-777777777777';
  const BITEM = '88888888-8888-4888-8888-888888888888';
  const scopeB = { userId: USER, orgId: ORG2, activeWarehouseId: null };
  const keyA = orderDraftKey({ userId: USER, orgId: ORG, warehouseId: WH });
  const keyB = orderDraftKey({ userId: USER, orgId: ORG2, warehouseId: WHB });
  const readA = () => parseStoredOrderDraft(store.data.get(keyA) ?? null, { userId: USER, orgId: ORG, warehouseId: WH });
  const readB = () => parseStoredOrderDraft(store.data.get(keyB) ?? null, { userId: USER, orgId: ORG2, warehouseId: WHB });
  let release: (r: OrderCallResult) => void = () => undefined;

  beforeEach(() => {
    api.storefront.mockImplementation(async (s: { orgId: string }) =>
      s.orgId === ORG2
        ? {
            ...storefrontAnswer(ORG2),
            warehouses: [{ id: WHB, name: 'B' }],
            viewer: { ...(storefrontAnswer() as Extract<OrderStorefrontAnswer, { enabled: true }>).viewer, canOrderOnBehalf: true, canApproveOrders: true },
          }
        : storefrontAnswer(),
    );
    api.catalog.mockImplementation(async (s: { orgId: string }, wh: string) =>
      s.orgId === ORG2
        ? { ...catalogAnswer(wh, 10, ORG2), items: [{ ...catalogAnswer().items[0]!, id: BITEM, name: 'Binder' }] }
        : catalogAnswer(wh),
    );
    api.place.mockImplementationOnce(() => new Promise<OrderCallResult>((r) => (release = r)));
  });

  /** Org A sends (held), the person switches to org B and builds a cart
   *  there for someone else; then org A's answer arrives. */
  async function sendInAThenSwitchToB(answer: OrderCallResult) {
    await session.open(scope);
    session.dispatch({ type: 'add', itemId: A, quantity: 2 });
    const sending = session.submit(false);
    await vi.waitFor(() => expect(snap().submission.state.phase).toBe('sending'));
    await session.open(scopeB);
    await vi.waitFor(() => expect(snap().cart).not.toBeNull());
    session.dispatch({ type: 'add', itemId: BITEM, quantity: 5 });
    session.dispatch({ type: 'set-setup', patch: { onBehalfOf: { name: 'Bee Person', email: 'bee@orgb.example' } } });
    release(answer);
    await sending;
    await flushSaves();
  }

  it('a final refusal never writes org B’s cart into org A’s draft; org A’s record stays its own and settles by its key', async () => {
    await sendInAThenSwitchToB({
      ok: false,
      error: { status: 403, code: 'forbidden', details: { reason: 'permission', organizationId: ORG } },
    });
    expect(readA()?.cart.lines).toEqual([{ itemId: A, quantity: 2 }]);
    expect(readA()?.cart.onBehalfOf).toBeNull();
    expect(readA()?.submission?.key).toBe(KEY);
    expect(readB()?.cart.lines).toEqual([{ itemId: BITEM, quantity: 5 }]);
    expect(readB()?.cart.onBehalfOf?.email).toBe('bee@orgb.example');
    // Back in org A: its own cart, locked by its own key, read on its own.
    api.status.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: { organizationId: ORG, outcome: 'refused', refusal: { reason: 'permission', settled: true } },
    });
    await session.open(scope);
    await vi.waitFor(() => expect(snap().submission.state.phase).toBe('refused'));
    expect(snap().cart?.lines).toEqual([{ itemId: A, quantity: 2 }]);
    expect(snap().cart?.onBehalfOf).toBeNull();
    expect(api.place).toHaveBeenCalledTimes(1);
  });

  it('a lost answer leaves org A’s record as it was sent (its cart, its live key)', async () => {
    await sendInAThenSwitchToB({ ok: false, error: new Error('Request timed out.') });
    expect(readA()?.cart.lines).toEqual([{ itemId: A, quantity: 2 }]);
    expect(readA()?.submission?.key).toBe(KEY);
    expect(readB()?.submission).toBeNull();
  });

  it('a placed answer keeps org A’s record, so going back shows the success screen for it', async () => {
    await sendInAThenSwitchToB({ ok: true, status: 201, body: { organizationId: ORG, result: { replay: false, order: SUMMARY } } });
    expect(readA()?.submission?.key).toBe(KEY);
    api.status.mockResolvedValueOnce({ ok: true, status: 200, body: { organizationId: ORG, outcome: 'placed', order: SUMMARY } });
    await session.open(scope);
    await vi.waitFor(() => expect(snap().submission.state.phase).toBe('placed'));
    expect(snap().placed?.order.orderLabel).toBe('SO-000123');
    expect(snap().placed?.body?.lines).toEqual([{ itemId: A, quantity: 2 }]);
    expect(store.data.has(keyA)).toBe(false);
  });

  it('a send already settled by the next storefront is never locked again by the old send’s late answer', async () => {
    await session.open(scope);
    session.dispatch({ type: 'add', itemId: A, quantity: 2 });
    const sending = session.submit(false);
    await vi.waitFor(() => expect(snap().submission.state.phase).toBe('sending'));
    await session.open(scopeB);
    api.status.mockResolvedValueOnce({ ok: true, status: 200, body: { organizationId: ORG, outcome: 'placed', order: SUMMARY } });
    await session.open(scope);
    await vi.waitFor(() => expect(snap().submission.state.phase).toBe('placed'));
    expect(store.data.has(keyA)).toBe(false);
    release({ ok: false, error: new Error('Request timed out.') });
    await sending;
    await flushSaves();
    expect(store.data.has(keyA)).toBe(false);
    expect(snap().locked).toBe(false);
  });

  it('a workspace switch inside the 250 ms save: each organization’s key keeps its own cart', async () => {
    await session.open(scope);
    session.dispatch({ type: 'add', itemId: A, quantity: 2 });
    await session.open(scopeB);
    await vi.waitFor(() => expect(snap().cart).not.toBeNull());
    session.dispatch({ type: 'add', itemId: BITEM, quantity: 5 });
    await flushSaves();
    expect(readA()?.cart.lines).toEqual([{ itemId: A, quantity: 2 }]);
    expect(readB()?.cart.lines).toEqual([{ itemId: BITEM, quantity: 5 }]);
  });

  it('a warehouse switch inside the 250 ms save: each warehouse’s key keeps its own cart', async () => {
    const keyA2 = orderDraftKey({ userId: USER, orgId: ORG, warehouseId: WH2 });
    await session.open(scope);
    session.dispatch({ type: 'add', itemId: A, quantity: 3 });
    await session.selectWarehouse(WH2);
    session.dispatch({ type: 'add', itemId: A, quantity: 1 });
    await flushSaves();
    expect(readA()?.cart.lines).toEqual([{ itemId: A, quantity: 3 }]);
    expect(parseStoredOrderDraft(store.data.get(keyA2) ?? null, { userId: USER, orgId: ORG, warehouseId: WH2 })?.cart.lines).toEqual([
      { itemId: A, quantity: 1 },
    ]);
  });
});

describe('a restored cart for someone else (desk check F2, slice D: on behalf follows the effective orders:approve)', () => {
  const forBee = {
    ...initialCartState({ warehouseId: WH, fulfillmentType: 'pickup' as const }),
    lines: [{ itemId: A, quantity: 2 }],
    onBehalfOf: { name: 'Bee Person', email: 'bee@x.org' },
  };

  it('is re-checked against the storefront answer shown: Submit says why and sends nothing until it is for Myself', async () => {
    store.data.set(draftKey, serializeOrderDraft({ userId: USER, orgId: ORG, warehouseId: WH }, { cart: forBee, submission: null }, new Date()));
    await session.open(scope);
    expect(snap().cart?.onBehalfOf).toEqual(forBee.onBehalfOf);
    expect(session.submitBlockedBy(false)).toBe(SUBMIT_ON_BEHALF_NOT_PERMITTED_COPY);
    await session.submit(false);
    expect(api.place).not.toHaveBeenCalled();
    session.dispatch({ type: 'set-setup', patch: { onBehalfOf: null } });
    expect(session.submitBlockedBy(false)).toBeNull();
  });

  it('someone who holds orders:approve in the answer may send it as it is', async () => {
    api.storefront.mockResolvedValueOnce({
      ...storefrontAnswer(),
      viewer: { ...(storefrontAnswer() as Extract<OrderStorefrontAnswer, { enabled: true }>).viewer, canOrderOnBehalf: true },
    });
    store.data.set(draftKey, serializeOrderDraft({ userId: USER, orgId: ORG, warehouseId: WH }, { cart: forBee, submission: null }, new Date()));
    await session.open(scope);
    expect(session.submitBlockedBy(false)).toBeNull();
    await session.submit(false);
    expect(api.place.mock.calls[0]?.[1]).toMatchObject({ onBehalfOf: { name: 'Bee Person', email: 'bee@x.org' } });
  });

  it('an approve permission revoked since the last read blocks Submit after a refresh', async () => {
    api.storefront.mockResolvedValueOnce({
      ...storefrontAnswer(),
      viewer: { ...(storefrontAnswer() as Extract<OrderStorefrontAnswer, { enabled: true }>).viewer, canOrderOnBehalf: true },
    });
    await session.open(scope);
    session.dispatch({ type: 'add', itemId: A, quantity: 1 });
    session.dispatch({ type: 'set-setup', patch: { onBehalfOf: { name: 'Bee Person', email: 'bee@x.org' } } });
    expect(session.submitBlockedBy(false)).toBeNull();
    await session.refresh();
    expect(session.submitBlockedBy(false)).toBe(SUBMIT_ON_BEHALF_NOT_PERMITTED_COPY);
  });
});

describe('a final outcome reached away from checkout is said where it lands (desk check F3)', () => {
  const pendingA: PendingOrderSubmission = {
    key: KEY,
    state: 'possibly_sent',
    sends: 1,
    firstSentAt: '2026-10-04T11:00:00.000Z',
    body: { idempotencyKey: KEY, placerUserId: USER, warehouseId: WH, fulfillmentType: 'pickup', deliveryCharterId: null, onBehalfOf: null, notes: null, neededByLocal: null, lines: [{ itemId: A, quantity: 4 }] },
  };
  const ctx = { itemName: () => 'Planner', warehouseName: 'DC4' };
  const restoreLocked = () =>
    store.data.set(draftKey, serializeOrderDraft({ userId: USER, orgId: ORG, warehouseId: WH }, { cart: initialCartState({ warehouseId: WH, fulfillmentType: 'pickup' }), submission: pendingA }, new Date()));

  it('Don’t send it from home: "It was not sent. Your cart is unlocked."', async () => {
    restoreLocked();
    await session.open(scope);
    await vi.waitFor(() => expect(snap().submission.busy).toBe(false));
    await session.dontSend();
    expect(storefrontOutcome(snap(), ctx)?.text).toBe(ORDER_WITHDRAWN_COPY);
  });

  it('a status read on open that settles refused says why', async () => {
    restoreLocked();
    api.status.mockResolvedValueOnce({ ok: true, status: 200, body: { organizationId: ORG, outcome: 'refused', refusal: { reason: 'permission', settled: true } } });
    await session.open(scope);
    await vi.waitFor(() => expect(snap().submission.state.phase).toBe('refused'));
    expect(storefrontOutcome(snap(), ctx)?.text).toBe("Your account can't place orders. Ask an admin.");
  });

  it('with the kill switch on, Don’t send it still says it was not sent', async () => {
    api.storefront.mockResolvedValueOnce({ organizationId: ORG, enabled: false, message: ORDER_PHONE_TURNED_OFF_COPY, serverNow: 'x' });
    restoreLocked();
    await session.open(scope);
    await vi.waitFor(() => expect(snap().submission.state.phase).toBe('unconfirmed'));
    await vi.waitFor(() => expect(snap().submission.busy).toBe(false));
    await session.dontSend();
    expect(snap().setup.status).toBe('off');
    expect(storefrontOutcome(snap(), ctx)?.text).toBe(ORDER_WITHDRAWN_COPY);
  });
});

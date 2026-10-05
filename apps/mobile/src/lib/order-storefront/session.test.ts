import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  NEEDED_BY_IN_PAST_COPY,
  ORDER_ADD_WHILE_LOCKED_COPY,
  ORDER_PERMISSION_COPY,
  ORDER_WITHDRAWN_COPY,
  ORDER_NEEDS_CONNECTION_COPY,
  ORDER_PHONE_TURNED_OFF_COPY,
  STOREFRONT_CART_LOCKED_COPY,
  STOREFRONT_LINE_NOT_ORDERABLE_COPY,
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
import { checkoutStage } from './checkout';
import { storefrontOutcome } from './outcome';
import { STOREFRONT_ANSWER_STALE_MS, createStorefrontSession, type SessionStore, type StorefrontSession } from './session';
import { showUnconfirmedPanel } from './submit';
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

function makeSession(extra: { storefrontStaleMs?: number } = {}) {
  return createStorefrontSession({
    ...extra,
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

describe('lock words go with the lock; outcome text goes once read (desk check F4)', () => {
  const lostAnswer = async () => {
    await session.open(scope);
    session.dispatch({ type: 'add', itemId: A, quantity: 1 });
    api.place.mockResolvedValueOnce({ ok: false, error: new Error('Request timed out.') });
    await session.submit(false);
    expect(snap().locked).toBe(true);
  };

  it('after Don’t send it, the Ship from sentence is gone (the desk check’s repro)', async () => {
    await lostAnswer();
    expect(await session.selectWarehouse(WH2)).toBe(STOREFRONT_SHIP_FROM_LOCKED_COPY);
    await session.dontSend();
    expect(snap().locked).toBe(false);
    expect(snap().refusal).toBeNull();
    expect(storefrontOutcome(snap(), { itemName: () => null, warehouseName: null })?.text).toBe(ORDER_WITHDRAWN_COPY);
  });

  it('after a status read finds it placed, the add-while-locked sentence is gone', async () => {
    await lostAnswer();
    expect(session.dispatch({ type: 'add', itemId: A })).toBe(ORDER_ADD_WHILE_LOCKED_COPY);
    api.status.mockResolvedValueOnce({ ok: true, status: 200, body: { organizationId: ORG, outcome: 'placed', order: SUMMARY } });
    await session.focus();
    await vi.waitFor(() => expect(snap().submission.state.phase).toBe('placed'));
    expect(snap().refusal).toBeNull();
  });

  it('after a status read finds it refused, the cart-locked sentence is gone', async () => {
    await lostAnswer();
    expect(session.dispatch({ type: 'clear' })).toBe(STOREFRONT_CART_LOCKED_COPY);
    api.status.mockResolvedValueOnce({ ok: true, status: 200, body: { organizationId: ORG, outcome: 'refused', refusal: { reason: 'permission', settled: true } } });
    await session.focus();
    await vi.waitFor(() => expect(snap().submission.state.phase).toBe('refused'));
    expect(snap().refusal).toBeNull();
  });

  it('a device error goes with the next change to the cart', async () => {
    await session.open(scope);
    session.dispatch({ type: 'add', itemId: A, quantity: 1 });
    const setItem = store.setItem;
    store.setItem = async (k, v) => {
      if (k === draftKey) throw new Error('disk full');
      return setItem(k, v);
    };
    await session.submit(false);
    expect(api.place).not.toHaveBeenCalled();
    expect(snap().submission.deviceError).not.toBeNull();
    store.setItem = setItem;
    session.dispatch({ type: 'inc', itemId: A });
    expect(snap().submission.deviceError).toBeNull();
    expect(storefrontOutcome(snap(), { itemName: () => null, warehouseName: null })).toBeNull();
  });

  it('read: dismissing clears a refused or withdrawn outcome and a refusal, never a placed order or a lock', async () => {
    await lostAnswer();
    expect(await session.selectWarehouse(WH2)).toBe(STOREFRONT_SHIP_FROM_LOCKED_COPY);
    session.dismissOutcome();
    expect(snap().refusal).toBeNull();
    expect(snap().locked).toBe(true);
    await session.dontSend();
    session.dismissOutcome();
    expect(storefrontOutcome(snap(), { itemName: () => null, warehouseName: null })).toBeNull();
  });
});

describe('a keystroke never re-renders every row (desk check F8.1)', () => {
  it('a publish that changes no mark keeps the same notOrderable set and the same photos object', async () => {
    await session.open(scope);
    session.dispatch({ type: 'add', itemId: A, quantity: 1 });
    const before = snap();
    session.dispatch({ type: 'set-notes', value: 'a' });
    const after = snap();
    expect(after).not.toBe(before);
    expect(after.notOrderable).toBe(before.notOrderable);
    expect(after.photos).toBe(before.photos);
  });

  it('with no photo map, photos is one frozen empty object', async () => {
    api.photos.mockRejectedValue(new Error('offline'));
    await session.open(scope);
    const first = snap().photos;
    session.dispatch({ type: 'add', itemId: A, quantity: 1 });
    expect(snap().photos).toBe(first);
    expect(Object.keys(first)).toEqual([]);
    expect(Object.isFrozen(first)).toBe(true);
  });

  it('a change to the marks is a new set (the rows must redraw then)', async () => {
    const cart = { ...initialCartState({ warehouseId: WH, fulfillmentType: 'pickup' as const }), lines: [{ itemId: A, quantity: 1 }, { itemId: B, quantity: 1 }] };
    store.data.set(draftKey, serializeOrderDraft({ userId: USER, orgId: ORG, warehouseId: WH }, { cart, submission: null }, new Date()));
    await session.open(scope);
    const marked = snap().notOrderable;
    expect([...marked]).toEqual([B]);
    session.dispatch({ type: 'remove', itemId: B });
    expect(snap().notOrderable).not.toBe(marked);
    expect(snap().notOrderable.size).toBe(0);
  });
});

describe('a photo that fails reads the map again at most once in 5 minutes per warehouse (desk check F8.2)', () => {
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it('every later error inside the 5 minutes reads nothing; after them, one read again', async () => {
    await session.open(scope);
    const opened = api.photos.mock.calls.length;
    session.photoFailed();
    await tick();
    expect(api.photos.mock.calls.length).toBe(opened + 1);
    // The fresh map came back; another image still fails.
    session.photoFailed();
    await tick();
    session.photoFailed();
    await tick();
    expect(api.photos.mock.calls.length).toBe(opened + 1);
    now += 5 * 60_000;
    session.photoFailed();
    await tick();
    expect(api.photos.mock.calls.length).toBe(opened + 2);
  });

  it('another warehouse has its own allowance', async () => {
    await session.open(scope);
    session.photoFailed();
    await tick();
    await session.selectWarehouse(WH2);
    const atSwitch = api.photos.mock.calls.length;
    session.photoFailed();
    await tick();
    expect(api.photos.mock.calls.length).toBe(atSwitch + 1);
  });
});

describe('a restored cart is checked against the fresh catalog, not the device’s copy (desk check F9)', () => {
  const restore = (lines: { itemId: string; quantity: number }[]) => {
    const cart = { ...initialCartState({ warehouseId: WH, fulfillmentType: 'pickup' as const }), lines };
    store.data.set(draftKey, serializeOrderDraft({ userId: USER, orgId: ORG, warehouseId: WH }, { cart, submission: null }, new Date()));
  };
  const withB = (): OrderCatalogAnswer => {
    const a = catalogAnswer(WH);
    return { ...a, items: [...a.items, { ...a.items[0]!, id: B, sku: 'MG', name: 'Mug' }] };
  };

  it('an item the device’s old copy lacks but the fresh catalog lists is not marked, and Submit is not blocked', async () => {
    // The device's copy (read earlier) has no Mug; the fresh read lists it.
    store.data.set(orderCatalogKey({ userId: USER, orgId: ORG, warehouseId: WH }), serializeCatalog(catalogAnswer(WH), now - 3_600_000));
    api.catalog.mockImplementation(async () => withB());
    restore([{ itemId: A, quantity: 1 }, { itemId: B, quantity: 1 }]);
    await session.open(scope);
    expect(snap().catalog.fromDevice).toBe(false);
    expect(snap().notOrderable.size).toBe(0);
    expect(snap().notice).toBeNull();
    expect(session.submitBlockedBy(false)).toBeNull();
  });

  it('the device’s copy alone (the fresh read failed) says nothing about what changed; its marks still stand', async () => {
    store.data.set(orderCatalogKey({ userId: USER, orgId: ORG, warehouseId: WH }), serializeCatalog(catalogAnswer(WH), now - 3_600_000));
    api.catalog.mockRejectedValue(new Error('offline'));
    restore([{ itemId: A, quantity: 1 }, { itemId: B, quantity: 1 }]);
    await session.open(scope);
    expect(snap().catalog.fromDevice).toBe(true);
    expect(snap().notice).toBeNull();
    expect([...snap().notOrderable]).toEqual([B]);
  });

  it('an item the fresh catalog no longer lists is marked and said once', async () => {
    store.data.set(orderCatalogKey({ userId: USER, orgId: ORG, warehouseId: WH }), serializeCatalog(withB(), now - 3_600_000));
    restore([{ itemId: A, quantity: 1 }, { itemId: B, quantity: 1 }]);
    await session.open(scope);
    expect([...snap().notOrderable]).toEqual([B]);
    expect(snap().notice).toMatch(/^Since this cart was saved, 1 item can't be ordered from here anymore/);
  });
});

describe('the success screen is shown once per placed order (desk check F10)', () => {
  it('placed starts not shown; the success screen marks it shown; Done clears it and the next one starts over', async () => {
    await session.open(scope);
    session.dispatch({ type: 'add', itemId: A, quantity: 2 });
    await session.submit(false);
    expect(snap().placed).toMatchObject({ order: { id: ORDER }, shown: false });
    session.placedShown();
    expect(snap().placed?.shown).toBe(true);
    // Left by View order and on, then the storefront opened again: the same
    // session still holds it, shown, so the storefront clears it.
    await session.open(scope);
    expect(snap().placed?.shown).toBe(true);
    session.finishPlaced();
    expect(snap().placed).toBeNull();
    session.dispatch({ type: 'add', itemId: A, quantity: 1 });
    await session.submit(false);
    expect(snap().placed?.shown).toBe(false);
  });

  it('marking with nothing placed does nothing', async () => {
    await session.open(scope);
    const before = snap();
    session.placedShown();
    expect(snap()).toBe(before);
  });
});

describe('a restored needed-by already past is refused before Submit (desk check F11)', () => {
  it('on the server’s clock, in the organization’s zone', async () => {
    // 04:00 in Los Angeles is 11:00Z, before the server's 12:00Z.
    const cart = { ...initialCartState({ warehouseId: WH, fulfillmentType: 'pickup' as const }), lines: [{ itemId: A, quantity: 1 }], neededBy: '2026-10-04T04:00' };
    store.data.set(draftKey, serializeOrderDraft({ userId: USER, orgId: ORG, warehouseId: WH }, { cart, submission: null }, new Date()));
    await session.open(scope);
    expect(session.submitBlockedBy(false)).toBe(NEEDED_BY_IN_PAST_COPY);
    await session.submit(false);
    expect(api.place).not.toHaveBeenCalled();
    session.dispatch({ type: 'set-needed-by', value: '2026-10-05T09:00' });
    expect(session.submitBlockedBy(false)).toBeNull();
  });

  it('the phone’s own clock is not the judge: a phone running an hour slow still refuses it', async () => {
    // The server says 12:00Z; this phone thinks it is 10:30Z.
    now = Date.parse('2026-10-04T10:30:00.000Z');
    const cart = { ...initialCartState({ warehouseId: WH, fulfillmentType: 'pickup' as const }), lines: [{ itemId: A, quantity: 1 }], neededBy: '2026-10-04T04:00' };
    store.data.set(draftKey, serializeOrderDraft({ userId: USER, orgId: ORG, warehouseId: WH }, { cart, submission: null }, new Date()));
    await session.open(scope);
    expect(session.submitBlockedBy(false)).toBe(NEEDED_BY_IN_PAST_COPY);
  });
});

describe('a live key the session could not read is never overwritten (desk check F1, compare-and-set)', () => {
  const K1 = '55555555-5555-4555-8555-555555555556';
  const pendingK1: PendingOrderSubmission = {
    key: K1,
    state: 'possibly_sent',
    sends: 1,
    firstSentAt: '2026-10-04T11:00:00.000Z',
    body: { idempotencyKey: K1, placerUserId: USER, warehouseId: WH, fulfillmentType: 'pickup', deliveryCharterId: null, onBehalfOf: null, notes: null, neededByLocal: null, lines: [{ itemId: A, quantity: 4 }] },
  };
  const slotKey = () => parseStoredOrderDraft(store.data.get(draftKey)!, { userId: USER, orgId: ORG, warehouseId: WH })?.submission?.key;

  beforeEach(() => {
    const cart = { ...initialCartState({ warehouseId: WH, fulfillmentType: 'pickup' as const }), lines: [{ itemId: A, quantity: 4 }] };
    store.data.set(draftKey, serializeOrderDraft({ userId: USER, orgId: ORG, warehouseId: WH }, { cart, submission: pendingK1 }, new Date()));
    // The first read of this draft fails (a storage error): the storefront
    // opens with an empty cart and no lock, not knowing K1 is there.
    const read = store.getItem.bind(store);
    let failed = false;
    store.getItem = async (k: string) => {
      if (k === draftKey && !failed) {
        failed = true;
        throw new Error('storage read failed');
      }
      return read(k);
    };
  });

  it('a cart change saved later leaves K1’s record (its cart, its key) in place', async () => {
    await session.open(scope);
    expect(snap().locked).toBe(false);
    session.dispatch({ type: 'add', itemId: A, quantity: 1 });
    await flushSaves();
    expect(slotKey()).toBe(K1);
  });

  it('Submit cannot put a new key over K1: nothing is sent and K1’s record stays', async () => {
    await session.open(scope);
    session.dispatch({ type: 'add', itemId: A, quantity: 1 });
    await session.submit(false);
    expect(api.place).not.toHaveBeenCalled();
    expect(slotKey()).toBe(K1);
  });
});

describe('the storefront answer is read again before Submit (re-check: approve revoked while the app stays open)', () => {
  const approver = (): OrderStorefrontAnswer => ({
    ...(storefrontAnswer() as Extract<OrderStorefrontAnswer, { enabled: true }>),
    viewer: { ...(storefrontAnswer() as Extract<OrderStorefrontAnswer, { enabled: true }>).viewer, canOrderOnBehalf: true, canApproveOrders: true },
  });
  const bee = { name: 'Bee Person', email: 'bee@x.org' };

  /** An approver opens the storefront and builds a cart for someone else;
   *  from then on the server answers that they may not (approve revoked). */
  async function openAsApproverThenRevoke() {
    api.storefront.mockResolvedValueOnce(approver());
    await session.open(scope);
    session.dispatch({ type: 'add', itemId: A, quantity: 1 });
    session.dispatch({ type: 'set-setup', patch: { onBehalfOf: bee } });
    expect(session.submitBlockedBy(false)).toBeNull();
    expect(api.storefront).toHaveBeenCalledTimes(1);
  }

  it('the staleness defaults to 60 s', () => {
    expect(STOREFRONT_ANSWER_STALE_MS).toBe(60_000);
  });

  it('checkout opening reads the answer again (however fresh), so a revoke blocks Submit before it is pressed', async () => {
    await openAsApproverThenRevoke();
    now += 1_000;
    await session.openCheckout();
    expect(api.storefront).toHaveBeenCalledTimes(2);
    expect(session.submitBlockedBy(false)).toBe(SUBMIT_ON_BEHALF_NOT_PERMITTED_COPY);
    await session.submit(false);
    expect(api.place).not.toHaveBeenCalled();
    // The cart and its warehouse are kept: only the answer changed.
    expect(snap().warehouseId).toBe(WH);
    expect(snap().cart?.lines).toEqual([{ itemId: A, quantity: 1 }]);
    expect(snap().cart?.onBehalfOf).toEqual(bee);
  });

  it('a focus reads it again only once it is older than the staleness', async () => {
    await openAsApproverThenRevoke();
    now += 30_000;
    await session.focus();
    expect(api.storefront).toHaveBeenCalledTimes(1);
    expect(session.submitBlockedBy(false)).toBeNull();
    now += 31_000;
    await session.focus();
    expect(api.storefront).toHaveBeenCalledTimes(2);
    expect(session.submitBlockedBy(false)).toBe(SUBMIT_ON_BEHALF_NOT_PERMITTED_COPY);
  });

  it('a screen opening again for the same organization counts as a focus (read again once stale, not on every mount)', async () => {
    await openAsApproverThenRevoke();
    await session.open(scope);
    expect(api.storefront).toHaveBeenCalledTimes(1);
    now += STOREFRONT_ANSWER_STALE_MS + 1;
    await session.open(scope);
    expect(api.storefront).toHaveBeenCalledTimes(2);
    expect(session.submitBlockedBy(false)).toBe(SUBMIT_ON_BEHALF_NOT_PERMITTED_COPY);
  });

  it('the staleness is configurable', async () => {
    session = makeSession({ storefrontStaleMs: 10_000 });
    await openAsApproverThenRevoke();
    now += 11_000;
    await session.focus();
    expect(api.storefront).toHaveBeenCalledTimes(2);
    expect(session.submitBlockedBy(false)).toBe(SUBMIT_ON_BEHALF_NOT_PERMITTED_COPY);
  });

  it('a read that fails keeps the answer shown, and the next focus tries again', async () => {
    await openAsApproverThenRevoke();
    now += STOREFRONT_ANSWER_STALE_MS + 1;
    api.storefront.mockRejectedValueOnce(new Error('Network request failed'));
    await session.focus();
    expect(snap().setup.status).toBe('ready');
    expect(api.storefront).toHaveBeenCalledTimes(2);
    await session.focus();
    expect(api.storefront).toHaveBeenCalledTimes(3);
    expect(session.submitBlockedBy(false)).toBe(SUBMIT_ON_BEHALF_NOT_PERMITTED_COPY);
  });

  it('a final refusal for the on-behalf rule reads the answer again: no second key is spent on the same refusal', async () => {
    await openAsApproverThenRevoke();
    api.place.mockResolvedValueOnce({
      ok: false,
      error: { status: 403, code: 'forbidden', details: { reason: 'on_behalf_not_permitted', settled: true, organizationId: ORG } },
    });
    await session.submit(false);
    expect(snap().submission.state.phase).toBe('refused');
    await vi.waitFor(() => expect(api.storefront).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(session.submitBlockedBy(false)).toBe(SUBMIT_ON_BEHALF_NOT_PERMITTED_COPY));
    await session.submit(false);
    expect(api.place).toHaveBeenCalledTimes(1);
  });

  it('a refusal for another reason (an item no longer orderable) does not read the answer again', async () => {
    await openAsApproverThenRevoke();
    api.place.mockResolvedValueOnce({
      ok: false,
      error: { status: 400, code: 'validation_error', details: { reason: 'item_not_orderable', settled: true, items: { [A]: 'archived' }, organizationId: ORG } },
    });
    await session.submit(false);
    expect(snap().submission.state.phase).toBe('refused');
    await new Promise((r) => setTimeout(r, 0));
    expect(api.storefront).toHaveBeenCalledTimes(1);
  });
});

describe('signing out and back in as the same account starts over (simulator walk D4)', () => {
  it('a sign-out ends the epoch: the next open reads everything again, the cart cleared at sign-out stays cleared, and Submit can send', async () => {
    await session.open(scope);
    session.dispatch({ type: 'add', itemId: A, quantity: 2 });
    await flushSaves();
    expect(store.data.get(draftKey)).toBeDefined();
    // Sign-out with no storefront screen mounted (nothing calls close()):
    // the epoch ends and the account's storage is cleared.
    epoch += 1;
    store.data.clear();
    // The same account signs back in and opens the storefront.
    await session.open(scope);
    expect(api.storefront).toHaveBeenCalledTimes(2);
    expect(snap().cart?.lines).toEqual([]);
    session.dispatch({ type: 'add', itemId: A, quantity: 1 });
    await session.submit(false);
    expect(snap().submission.deviceError).toBeNull();
    expect(api.place).toHaveBeenCalledTimes(1);
    expect(snap().submission.state.phase).toBe('placed');
  });

  it('the same epoch keeps the open storefront (a screen mounting again reads nothing new)', async () => {
    await session.open(scope);
    session.dispatch({ type: 'add', itemId: A, quantity: 2 });
    await session.open(scope);
    expect(api.storefront).toHaveBeenCalledTimes(1);
    expect(snap().cart?.lines).toEqual([{ itemId: A, quantity: 2 }]);
  });
});

// PO-4 review (MEDIUM, both lenses): R1 reads the storefront answer again on
// checkout open and straight after a final refusal for permission or the
// module, and the storefront route refuses then too, so the answer leaves
// 'ready'. Checkout must still say how the send ended and offer the panel:
// the session keeps both (this block), and checkout draws them instead of a
// spinner (checkoutStage, pinned in order-storefront-wiring.test.ts).
describe('checkout when the answer read again is no longer ready (PO-4 review)', () => {
  it('Submit refused for permission, then the answer is refused: the refusal and the cart are still there to say', async () => {
    await session.open(scope);
    session.dispatch({ type: 'add', itemId: A, quantity: 2 });
    api.place.mockResolvedValueOnce({
      ok: false,
      error: { status: 403, code: 'forbidden', details: { reason: 'permission', settled: true, organizationId: ORG } },
    });
    api.storefront.mockRejectedValueOnce({ status: 403, code: 'forbidden', details: { reason: 'permission' } });
    await session.submit(false);
    await vi.waitFor(() => expect(snap().setup.status).toBe('refused'));
    expect(api.storefront).toHaveBeenCalledTimes(2);
    expect(snap().submission.state.phase).toBe('refused');
    expect(storefrontOutcome(snap(), { itemName: () => 'Planner', warehouseName: null })?.text).toBe(ORDER_PERMISSION_COPY);
    expect(snap().cart?.lines).toEqual([{ itemId: A, quantity: 2 }]);
    expect(checkoutStage(snap())).toBe('unavailable');
  });

  it('a lost answer, then the kill switch while checkout opens: the cart stays locked and the panel is offered', async () => {
    await session.open(scope);
    session.dispatch({ type: 'add', itemId: A, quantity: 2 });
    api.place.mockResolvedValueOnce({ ok: false, error: new Error('Request timed out.') });
    await session.submit(false);
    expect(snap().locked).toBe(true);
    api.storefront.mockResolvedValueOnce({ organizationId: ORG, enabled: false, message: ORDER_PHONE_TURNED_OFF_COPY, serverNow: 'x' });
    await session.openCheckout();
    expect(snap().setup).toEqual({ status: 'off', message: ORDER_PHONE_TURNED_OFF_COPY });
    expect(snap().locked).toBe(true);
    expect(showUnconfirmedPanel(snap().submission.state)).toBe(true);
    expect(snap().cart?.lines).toEqual([{ itemId: A, quantity: 2 }]);
    expect(checkoutStage(snap())).toBe('unavailable');
  });
});

// PO-4 review: the success screen took its warehouse name, the approve gate
// and the email's routing from the answer shown at the time it drew, so a
// read that came back turned off or refused (on return from Outlook) changed
// a screen describing an order already placed.
describe('the success screen keeps what was true when the order was placed (PO-4 review)', () => {
  const approverWithRouting = (): OrderStorefrontAnswer => ({
    ...(storefrontAnswer() as Extract<OrderStorefrontAnswer, { enabled: true }>),
    viewer: { ...(storefrontAnswer() as Extract<OrderStorefrontAnswer, { enabled: true }>).viewer, canOrderOnBehalf: true, canApproveOrders: true },
    deliveryRecipients: { to: 'intake@example.org', cc: 'copy@example.org', toName: null, ccName: null },
  });

  it('placed takes the answer and the catalog as they are; an answer read later as refused changes none of it', async () => {
    api.storefront.mockResolvedValueOnce(approverWithRouting());
    await session.open(scope);
    session.dispatch({ type: 'add', itemId: A, quantity: 2 });
    await session.submit(false);
    expect(snap().placed?.context).toMatchObject({
      warehouseName: 'DC4',
      canApproveOrders: true,
      recipients: { to: 'intake@example.org' },
      viewer: { name: 'Pat', email: 'pat@x.org' },
      orgTimezone: 'America/Los_Angeles',
    });
    expect(snap().placed?.context?.items.get(A)).toEqual({ name: 'Planner', sku: 'PL' });
    const taken = snap().placed?.context;
    // Back from Outlook a minute later: the answer is read again and refused.
    now += STOREFRONT_ANSWER_STALE_MS + 1;
    api.storefront.mockRejectedValueOnce({ status: 403, code: 'forbidden', details: { reason: 'permission' } });
    await session.focus();
    expect(snap().setup.status).toBe('refused');
    expect(snap().placed?.context).toBe(taken);
  });

  it('placed with no answer to take it from (the kill switch’s settle): no context, the screen fills it from the next answer', async () => {
    api.storefront.mockResolvedValueOnce({ organizationId: ORG, enabled: false, message: ORDER_PHONE_TURNED_OFF_COPY, serverNow: 'x' });
    const pending: PendingOrderSubmission = {
      key: KEY,
      state: 'possibly_sent',
      sends: 1,
      firstSentAt: '2026-10-04T11:00:00.000Z',
      body: { idempotencyKey: KEY, placerUserId: USER, warehouseId: WH, fulfillmentType: 'pickup', deliveryCharterId: null, onBehalfOf: null, notes: null, neededByLocal: null, lines: [{ itemId: A, quantity: 4 }] },
    };
    store.data.set(draftKey, serializeOrderDraft({ userId: USER, orgId: ORG, warehouseId: WH }, { cart: initialCartState({ warehouseId: WH, fulfillmentType: 'pickup' }), submission: pending }, new Date()));
    api.status.mockResolvedValueOnce({ ok: true, status: 200, body: { organizationId: ORG, outcome: 'placed', order: SUMMARY } });
    await session.open(scope);
    await vi.waitFor(() => expect(snap().submission.state.phase).toBe('placed'));
    expect(snap().placed?.context).toBeNull();
  });
});

// PO-4 review (probe P1): a stepper tap during the write-ahead (the state
// still open) was applied, and the unconfirmed record then held the edited
// cart beside the body that was sent: the locked cart showed 3, the request
// said 2, and a relaunch showed 2.
describe('the locked cart shows exactly what was sent (PO-4 review, the write-ahead window)', () => {
  it('a change made while the write-ahead is written is refused; the cart, the record and Check and finish all hold what was sent', async () => {
    await session.open(scope);
    session.dispatch({ type: 'add', itemId: A, quantity: 2 });
    const setItem = store.setItem.bind(store);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    let held = false;
    store.setItem = async (k, v) => {
      if (k === draftKey && !held) {
        held = true;
        await gate;
      }
      return setItem(k, v);
    };
    api.place.mockResolvedValueOnce({ ok: false, error: new Error('Request timed out.') });
    const sending = session.submit(false);
    await vi.waitFor(() => expect(held).toBe(true));
    expect(snap().submission.state.phase).toBe('open');
    expect(session.dispatch({ type: 'inc', itemId: A })).toBe(STOREFRONT_CART_LOCKED_COPY);
    expect(session.dispatch({ type: 'add', itemId: A })).toBe(ORDER_ADD_WHILE_LOCKED_COPY);
    expect(snap().cart?.lines).toEqual([{ itemId: A, quantity: 2 }]);
    release();
    await sending;
    expect(snap().locked).toBe(true);
    expect(snap().cart?.lines).toEqual([{ itemId: A, quantity: 2 }]);
    const record = parseStoredOrderDraft(store.data.get(draftKey)!, { userId: USER, orgId: ORG, warehouseId: WH });
    expect(record?.cart.lines).toEqual([{ itemId: A, quantity: 2 }]);
    expect(record?.submission?.body.lines).toEqual([{ itemId: A, quantity: 2 }]);
    api.place.mockResolvedValueOnce({ ok: false, error: new Error('Request timed out.') });
    await session.checkAndFinish();
    expect(api.place.mock.calls[1]?.[1]).toMatchObject({ idempotencyKey: KEY, lines: [{ itemId: A, quantity: 2 }] });
  });

  it('a locked record’s cart is the body that was sent (as a relaunch restores it), never the cart as typed', async () => {
    await session.open(scope);
    session.dispatch({ type: 'add', itemId: A, quantity: 2 });
    session.dispatch({ type: 'set-notes', value: '  Room 12  ' });
    api.place.mockResolvedValueOnce({ ok: false, error: new Error('Request timed out.') });
    await session.submit(false);
    expect(snap().locked).toBe(true);
    const record = parseStoredOrderDraft(store.data.get(draftKey)!, { userId: USER, orgId: ORG, warehouseId: WH });
    expect(record?.submission?.body.notes).toBe('Room 12');
    expect(record?.cart.notes).toBe('Room 12');
  });
});

// PO-4 review (probe P6, walk shot M18-iphone-back-to-A-refusal-settled.png):
// the session's scope changes only when a storefront screen mounts. An answer
// that lands after the person left the storefront, while its engine is still
// the one shown, settles the record (cart kept, no key); the next workspace
// switch then dropped how it ended, and back in that organization the cart
// was simply unlocked, with no sentence and no item marked.
describe('how a send ended, if no screen showed it, survives a workspace switch (PO-4 review)', () => {
  const WHB = '77777777-7777-4777-8777-777777777777';
  const scopeB = { userId: USER, orgId: ORG2, activeWarehouseId: null };

  beforeEach(() => {
    api.storefront.mockImplementation(async (s: { orgId: string }) =>
      s.orgId === ORG2 ? { ...storefrontAnswer(ORG2), warehouses: [{ id: WHB, name: 'B' }] } : storefrontAnswer(),
    );
    api.catalog.mockImplementation(async (s: { orgId: string }, wh: string) => catalogAnswer(wh, 10, s.orgId));
  });

  /** A sends; the answer lands while A is still the scope (no screen
   *  mounted); then the person opens B's storefront, then A's again. */
  async function answeredThenSwitchAndBack(answer: OrderCallResult) {
    await session.open(scope);
    session.dispatch({ type: 'add', itemId: A, quantity: 2 });
    api.place.mockResolvedValueOnce(answer);
    await session.submit(false);
    await session.open(scopeB);
    await vi.waitFor(() => expect(snap().cart).not.toBeNull());
    expect(snap().submission.state.phase).toBe('open');
    await session.open(scope);
    await vi.waitFor(() => expect(snap().cart).not.toBeNull());
  }

  it('a refusal: back in A it is said, its items are marked and Submit says why', async () => {
    await answeredThenSwitchAndBack({
      ok: false,
      error: { status: 400, code: 'validation_error', details: { reason: 'item_not_orderable', settled: true, items: { [A]: 'archived' }, organizationId: ORG } },
    });
    expect(snap().submission.state.phase).toBe('refused');
    expect(storefrontOutcome(snap(), { itemName: () => 'Planner', warehouseName: 'DC4' })?.text).toMatch(/Planner/);
    expect(snap().cart?.lines).toEqual([{ itemId: A, quantity: 2 }]);
    expect([...snap().notOrderable]).toEqual([A]);
    expect(session.submitBlockedBy(false)).toBe(SUBMIT_REMOVE_UNORDERABLE_COPY);
    expect(api.place).toHaveBeenCalledTimes(1);
  });

  it('withdrawn: back in A, "It was not sent. Your cart is unlocked."', async () => {
    await session.open(scope);
    session.dispatch({ type: 'add', itemId: A, quantity: 2 });
    api.place.mockResolvedValueOnce({ ok: false, error: new Error('Request timed out.') });
    await session.submit(false);
    await vi.waitFor(() => expect(snap().submission.busy).toBe(false));
    await session.dontSend();
    expect(snap().submission.state.phase).toBe('withdrawn');
    await session.open(scopeB);
    await vi.waitFor(() => expect(snap().cart).not.toBeNull());
    await session.open(scope);
    await vi.waitFor(() => expect(snap().cart).not.toBeNull());
    expect(storefrontOutcome(snap(), { itemName: () => null, warehouseName: null })?.text).toBe(ORDER_WITHDRAWN_COPY);
    expect(snap().locked).toBe(false);
  });

  it('placed: back in A the success screen is offered for it, once', async () => {
    await answeredThenSwitchAndBack({ ok: true, status: 201, body: { organizationId: ORG, result: { replay: false, order: SUMMARY } } });
    expect(snap().placed).toMatchObject({ order: { orderLabel: 'SO-000123' }, shown: false, body: { lines: [{ itemId: A, quantity: 2 }] } });
    expect(snap().placed?.context?.warehouseName).toBe('DC4');
    expect(snap().cart?.lines).toEqual([]);
  });

  it('once a screen has shown it (and the person moved on), it does not come back', async () => {
    await answeredThenSwitchAndBack({
      ok: false,
      error: { status: 403, code: 'forbidden', details: { reason: 'warehouse_not_available', settled: true, organizationId: ORG } },
    });
    expect(snap().submission.state.phase).toBe('refused');
    session.dismissOutcome();
    await session.open(scopeB);
    await vi.waitFor(() => expect(snap().cart).not.toBeNull());
    await session.open(scope);
    await vi.waitFor(() => expect(snap().cart).not.toBeNull());
    expect(snap().submission.state.phase).toBe('open');
  });

  it('another account never sees it, and it is not kept past the account', async () => {
    const OTHER = '22222222-2222-4222-8222-222222222299';
    await session.open(scope);
    session.dispatch({ type: 'add', itemId: A, quantity: 2 });
    api.place.mockResolvedValueOnce({
      ok: false,
      error: { status: 403, code: 'forbidden', details: { reason: 'warehouse_not_available', settled: true, organizationId: ORG } },
    });
    await session.submit(false);
    await session.open({ userId: OTHER, orgId: ORG, activeWarehouseId: null });
    await vi.waitFor(() => expect(snap().cart).not.toBeNull());
    expect(snap().submission.state.phase).toBe('open');
    await session.open(scope);
    await vi.waitFor(() => expect(snap().cart).not.toBeNull());
    expect(snap().submission.state.phase).toBe('open');
  });
});

// PO-4 review: a refused line now says why (core orderItemRefusalCopy), so
// the snapshot keeps each refused item's reason for its line.
describe('a refused item keeps its reason for its line (PO-4 review)', () => {
  it('until the line is removed; an unrelated change keeps the same map (the rows’ memo)', async () => {
    await session.open(scope);
    session.dispatch({ type: 'add', itemId: A, quantity: 2 });
    api.place.mockResolvedValueOnce({
      ok: false,
      error: { status: 400, code: 'validation_error', details: { reason: 'item_not_orderable', settled: true, items: { [A]: 'rental' }, organizationId: ORG } },
    });
    await session.submit(false);
    expect(snap().refusals.get(A)).toBe('rental');
    const before = snap().refusals;
    session.dispatch({ type: 'set-notes', value: 'x' });
    expect(snap().refusals).toBe(before);
    session.dispatch({ type: 'remove', itemId: A });
    expect(snap().refusals.size).toBe(0);
  });
});

// Simulator walk D9: the refused item's catalog row kept + (and its count
// opened the quantity sheet), so a line the server refused could be raised.
describe('a line marked as not orderable can be lowered or removed, never raised (simulator walk D9)', () => {
  it('refuses +, Add and a higher quantity in core’s words; - and a lower quantity still work', async () => {
    await session.open(scope);
    session.dispatch({ type: 'add', itemId: A, quantity: 2 });
    api.place.mockResolvedValueOnce({
      ok: false,
      error: { status: 400, code: 'validation_error', details: { reason: 'item_not_orderable', settled: true, items: { [A]: 'rental' }, organizationId: ORG } },
    });
    await session.submit(false);
    expect(session.dispatch({ type: 'inc', itemId: A })).toBe(STOREFRONT_LINE_NOT_ORDERABLE_COPY);
    expect(session.dispatch({ type: 'add', itemId: A })).toBe(STOREFRONT_LINE_NOT_ORDERABLE_COPY);
    expect(session.setQuantity(A, 5)).toBe(STOREFRONT_LINE_NOT_ORDERABLE_COPY);
    expect(snap().cart?.lines).toEqual([{ itemId: A, quantity: 2 }]);
    expect(snap().refusal).toBe(STOREFRONT_LINE_NOT_ORDERABLE_COPY);
    expect(session.dispatch({ type: 'dec', itemId: A })).toBeNull();
    expect(snap().cart?.lines).toEqual([{ itemId: A, quantity: 1 }]);
    expect([...snap().notOrderable]).toEqual([A]);
    expect(session.setQuantity(A, 0)).toBeNull();
    expect(snap().cart?.lines).toEqual([]);
  });
});

// PO-4 review: openCheckout reads the catalog and the answer together, and
// until the answer lands Submit judged a cart for someone else by the answer
// read before. A quick tap or a slow network could still send a cart the
// server then refuses as on_behalf_not_permitted, final, spending the key.
describe('a cart for someone else waits for the answer being read before Submit (PO-4 review)', () => {
  const approver = (): OrderStorefrontAnswer => ({
    ...(storefrontAnswer() as Extract<OrderStorefrontAnswer, { enabled: true }>),
    viewer: { ...(storefrontAnswer() as Extract<OrderStorefrontAnswer, { enabled: true }>).viewer, canOrderOnBehalf: true, canApproveOrders: true },
  });

  it('while the answer is out nothing is sent; once it lands the cart is judged by it', async () => {
    api.storefront.mockResolvedValueOnce(approver());
    await session.open(scope);
    session.dispatch({ type: 'add', itemId: A, quantity: 1 });
    session.dispatch({ type: 'set-setup', patch: { onBehalfOf: { name: 'Bee Person', email: 'bee@x.org' } } });
    let release: (a: OrderStorefrontAnswer) => void = () => undefined;
    api.storefront.mockImplementationOnce(() => new Promise<OrderStorefrontAnswer>((r) => (release = r)));
    const opening = session.openCheckout();
    await vi.waitFor(() => expect(snap().checkingAnswer).toBe(true));
    await session.submit(false);
    expect(api.place).not.toHaveBeenCalled();
    release(storefrontAnswer());
    await opening;
    expect(snap().checkingAnswer).toBe(false);
    expect(session.submitBlockedBy(false)).toBe(SUBMIT_ON_BEHALF_NOT_PERMITTED_COPY);
  });

  it('a cart for Myself does not wait', async () => {
    await session.open(scope);
    session.dispatch({ type: 'add', itemId: A, quantity: 1 });
    api.storefront.mockImplementationOnce(() => new Promise<OrderStorefrontAnswer>(() => undefined));
    void session.openCheckout();
    await vi.waitFor(() => expect(snap().checkingAnswer).toBe(true));
    await session.submit(false);
    expect(api.place).toHaveBeenCalledTimes(1);
  });

  it('a read that fails ends the wait (the answer shown stays, and is the one judged)', async () => {
    api.storefront.mockResolvedValueOnce(approver());
    await session.open(scope);
    session.dispatch({ type: 'add', itemId: A, quantity: 1 });
    session.dispatch({ type: 'set-setup', patch: { onBehalfOf: { name: 'Bee Person', email: 'bee@x.org' } } });
    api.storefront.mockRejectedValueOnce(new Error('Network request failed'));
    await session.openCheckout();
    expect(snap().checkingAnswer).toBe(false);
    await session.submit(false);
    expect(api.place).toHaveBeenCalledTimes(1);
  });
});

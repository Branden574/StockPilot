import { describe, expect, it, vi } from 'vitest';

import { initialCartState, type CartState, type PendingOrderSubmission } from '@stockpilot/core';

import { accountScopedStorageKeys } from '../account-eviction';
import {
  cartFromPendingBody,
  createDraftWriter,
  isEmptyDraft,
  orderCatalogKey,
  orderDraftKey,
  orderPhotosKey,
  orderPrefsKey,
  parseOrderPrefs,
  parseStoredCatalog,
  parseStoredOrderDraft,
  parseStoredPhotos,
  readStoredCart,
  restoredDraft,
  serializeCatalog,
  serializeOrderDraft,
  serializePhotos,
  unsettledSubmissions,
  type KeyValueStore,
} from './store';

const USER = '22222222-2222-4222-8222-222222222222';
const OTHER_USER = '77777777-7777-4777-8777-777777777777';
const ORG = '11111111-1111-4111-8111-111111111111';
const WH = '33333333-3333-4333-8333-333333333333';
const ITEM = '44444444-4444-4444-8444-444444444444';
const KEY = '55555555-5555-4555-8555-555555555555';
const SCOPE = { userId: USER, orgId: ORG, warehouseId: WH };

const CART: CartState = {
  ...initialCartState({ warehouseId: WH, fulfillmentType: 'pickup' }),
  lines: [{ itemId: ITEM, quantity: 3 }],
  notes: 'Room 12',
};

const PENDING: PendingOrderSubmission = {
  key: KEY,
  state: 'possibly_sent',
  sends: 1,
  firstSentAt: '2026-10-04T12:00:00.000Z',
  body: {
    idempotencyKey: KEY,
    placerUserId: USER,
    warehouseId: WH,
    fulfillmentType: 'pickup',
    deliveryCharterId: null,
    onBehalfOf: null,
    notes: 'Room 12',
    neededByLocal: '2026-10-05T10:00',
    lines: [{ itemId: ITEM, quantity: 3 }],
  },
};

function memoryStore() {
  const data = new Map<string, string>();
  const log: string[] = [];
  const store: KeyValueStore & { data: Map<string, string>; log: string[]; fail: boolean } = {
    data,
    log,
    fail: false,
    async getItem(k) {
      return data.get(k) ?? null;
    },
    async setItem(k, v) {
      if (store.fail) throw new Error('disk full');
      log.push(`set ${k}`);
      data.set(k, v);
    },
    async removeItem(k) {
      log.push(`remove ${k}`);
      data.delete(k);
    },
  };
  return store;
}

describe('the keys (plan 3.6)', () => {
  it('every key is account-scoped (under workspace.), names the account and the organization, and is removed by a sign-out', () => {
    const keys = [orderDraftKey(SCOPE), orderCatalogKey(SCOPE), orderPhotosKey(SCOPE), orderPrefsKey(SCOPE)];
    expect(keys).toEqual([
      `workspace.orderDraft.v1.${USER}.${ORG}.${WH}`,
      `workspace.orderCatalog.v1.${USER}.${ORG}.${WH}`,
      `workspace.orderPhotos.v1.${USER}.${ORG}.${WH}`,
      `workspace.orderPrefs.v1.${USER}.${ORG}`,
    ]);
    expect(accountScopedStorageKeys(keys)).toEqual(keys);
  });
});

describe('the draft record', () => {
  it('round-trips the cart and the pending send', () => {
    const raw = serializeOrderDraft(SCOPE, { cart: CART, submission: PENDING }, new Date('2026-10-04T12:00:00Z'));
    expect(parseStoredOrderDraft(raw, SCOPE)).toEqual({ cart: CART, submission: PENDING });
  });

  it('is never read for another account, organization or warehouse', () => {
    const raw = serializeOrderDraft(SCOPE, { cart: CART, submission: PENDING }, new Date());
    expect(parseStoredOrderDraft(raw, { ...SCOPE, userId: OTHER_USER })).toBeNull();
    expect(parseStoredOrderDraft(raw, { ...SCOPE, orgId: OTHER_USER })).toBeNull();
    expect(parseStoredOrderDraft(raw, { ...SCOPE, warehouseId: OTHER_USER })).toBeNull();
  });

  it('a pending send another placer wrote is never kept (core parsePendingOrderSubmission)', () => {
    const theirs = { ...PENDING, body: { ...PENDING.body, placerUserId: OTHER_USER } };
    const raw = serializeOrderDraft(SCOPE, { cart: CART, submission: theirs }, new Date());
    expect(parseStoredOrderDraft(raw, SCOPE)?.submission).toBeNull();
  });

  it('a cart it cannot read never costs the pending send', () => {
    const raw = JSON.stringify({ v: 1, ...SCOPE, cart: 'garbage', submission: PENDING, savedAt: 'x' });
    const draft = parseStoredOrderDraft(raw, SCOPE)!;
    expect(draft.submission).toEqual(PENDING);
    expect(draft.cart.lines).toEqual([]);
  });

  it('a stored cart is read line by line: anything that is not a whole positive line is not one', () => {
    const cart = readStoredCart(
      {
        lines: [
          { itemId: ITEM, quantity: 2 },
          { itemId: 'x', quantity: 1.5 },
          { itemId: 'y', quantity: 0 },
          { itemId: ITEM, quantity: 9 },
          'z',
        ],
        fulfillmentType: 'pickup',
        charterId: 'site-on-a-pickup',
        neededBy: 'tomorrow',
        kits: { b1: { [ITEM]: 5 } },
      },
      WH,
    );
    expect(cart.lines).toEqual([{ itemId: ITEM, quantity: 2 }]);
    expect(cart.charterId).toBeNull();
    expect(cart.neededBy).toBe('');
    expect(cart.kits).toEqual({ b1: { [ITEM]: 2 } });
  });

  it('a restored pending send shows exactly the body it sent, never a cart edited since', () => {
    const edited = { ...CART, lines: [{ itemId: ITEM, quantity: 99 }] };
    const r = restoredDraft({ cart: edited, submission: PENDING }, WH);
    expect(r.cart).toEqual(cartFromPendingBody(PENDING.body as never, WH));
    expect(r.cart.lines).toEqual([{ itemId: ITEM, quantity: 3 }]);
    expect(r.cart.neededBy).toBe('2026-10-05T10:00');
  });

  it('an empty draft is removed rather than kept', () => {
    expect(isEmptyDraft({ cart: initialCartState({ warehouseId: WH, fulfillmentType: 'pickup' }), submission: null })).toBe(true);
    expect(isEmptyDraft({ cart: CART, submission: null })).toBe(false);
    expect(isEmptyDraft({ cart: initialCartState({ warehouseId: WH, fulfillmentType: 'pickup' }), submission: PENDING })).toBe(false);
  });

  it('finds the unsettled sends of this account (and only this account) in an organization', () => {
    const mine = serializeOrderDraft(SCOPE, { cart: CART, submission: PENDING }, new Date());
    const settled = serializeOrderDraft({ ...SCOPE, warehouseId: ITEM }, { cart: CART, submission: null }, new Date());
    const theirs = serializeOrderDraft({ ...SCOPE, userId: OTHER_USER }, { cart: CART, submission: PENDING }, new Date());
    const found = unsettledSubmissions(
      [
        [orderDraftKey(SCOPE), mine],
        [orderDraftKey({ ...SCOPE, warehouseId: ITEM }), settled],
        [orderDraftKey({ ...SCOPE, userId: OTHER_USER }), theirs],
        ['workspace.activeOrgId', ORG],
      ],
      USER,
      ORG,
    );
    expect(found).toEqual([{ orgId: ORG, warehouseId: WH, pending: PENDING }]);
    expect(unsettledSubmissions([[orderDraftKey(SCOPE), mine]], USER, OTHER_USER)).toEqual([]);
    expect(unsettledSubmissions([[orderDraftKey(SCOPE), mine]], USER, null)).toHaveLength(1);
  });
});

describe('the writer (a cleared draft stays cleared; the epoch at write time)', () => {
  function timers() {
    let fn: (() => void) | null = null;
    return {
      setTimer: (f: () => void) => {
        fn = f;
        return 1;
      },
      clearTimer: () => {
        fn = null;
      },
      fire: () => {
        const f = fn;
        fn = null;
        f?.();
      },
      waiting: () => fn !== null,
    };
  }

  it('debounces a save and writes what the state is AT WRITE TIME', async () => {
    const store = memoryStore();
    const t = timers();
    const w = createDraftWriter({ store, key: 'k', epoch: () => 1, ...t });
    let value = 'first';
    w.schedule(() => value);
    value = 'latest';
    expect(store.log).toEqual([]);
    t.fire();
    await vi.waitFor(() => expect(store.data.get('k')).toBe('latest'));
  });

  it('a save still waiting when the cart is reset is cancelled, never flushed', async () => {
    const store = memoryStore();
    const t = timers();
    const w = createDraftWriter({ store, key: 'k', epoch: () => 1, ...t });
    w.schedule(() => 'old cart');
    w.cancel();
    expect(t.waiting()).toBe(false);
    t.fire();
    await Promise.resolve();
    expect(store.log).toEqual([]);
  });

  it('a save for an account that has ended is dropped', async () => {
    const store = memoryStore();
    const t = timers();
    let epoch = 1;
    const w = createDraftWriter({ store, key: 'k', epoch: () => epoch, ...t });
    w.schedule(() => 'cart');
    epoch = 2;
    t.fire();
    await new Promise((r) => setTimeout(r, 0));
    expect(store.log).toEqual([]);
  });

  it('the write-ahead is refused for an account that has ended (so nothing is sent)', async () => {
    const store = memoryStore();
    let epoch = 1;
    const w = createDraftWriter({ store, key: 'k', epoch: () => epoch });
    epoch = 2;
    await expect(w.writeNow(() => 'pending')).rejects.toThrow(/account changed/);
    expect(store.log).toEqual([]);
  });

  it('the write-ahead rejects when the device refuses it, and cancels a waiting save first', async () => {
    const store = memoryStore();
    const t = timers();
    const w = createDraftWriter({ store, key: 'k', epoch: () => 1, ...t });
    w.schedule(() => 'stale');
    store.fail = true;
    await expect(w.writeNow(() => 'pending')).rejects.toThrow('disk full');
    expect(t.waiting()).toBe(false);
  });

  it('writes run in order: a save started before a write-ahead never lands after it', async () => {
    const store = memoryStore();
    let release: (() => void) | null = null;
    const slow: KeyValueStore = {
      ...store,
      async setItem(k, v) {
        if (v === 'first') await new Promise<void>((r) => (release = r));
        await store.setItem(k, v);
      },
    };
    const t = timers();
    const w = createDraftWriter({ store: slow, key: 'k', epoch: () => 1, ...t });
    w.schedule(() => 'first');
    t.fire();
    await vi.waitFor(() => expect(release).not.toBeNull());
    const ahead = w.writeNow(() => 'pending');
    release!();
    await ahead;
    expect(store.log).toEqual(['set k', 'set k']);
    expect(store.data.get('k')).toBe('pending');
  });

  it('null removes the key', async () => {
    const store = memoryStore();
    store.data.set('k', 'x');
    const w = createDraftWriter({ store, key: 'k', epoch: () => 1 });
    await w.writeNow(() => null);
    expect(store.data.has('k')).toBe(false);
  });
});

describe('the catalog, the photos and the preferences kept on the device', () => {
  const answer = {
    organizationId: ORG,
    warehouseId: WH,
    generatedAt: '2026-10-04T12:00:00.000Z',
    staleAfterSeconds: 60,
    rowCeiling: 10000,
    truncated: false,
    items: [
      {
        id: ITEM,
        sku: 'PL-1',
        name: 'Planner',
        categoryId: null,
        charterId: null,
        rackLabel: null,
        quantityOnHand: 10,
        reservedQuantity: 2,
        reorderPoint: 0,
      },
    ],
    aisles: [{ id: null, name: 'Uncategorized', itemCount: 1 }],
    charters: {},
    sites: { status: 'ok' as const, sites: [] },
    kits: { status: 'ok' as const, kits: [] },
    frequentlyOrdered: { status: 'error' as const },
  };

  it('a catalog is read back for this account’s organization and warehouse only', () => {
    const raw = serializeCatalog(answer, 1000);
    expect(parseStoredCatalog(raw, SCOPE)).toEqual({ answer, readAt: 1000 });
    expect(parseStoredCatalog(raw, { ...SCOPE, warehouseId: ITEM })).toBeNull();
    expect(parseStoredCatalog('{"v":1,"readAt":1,"answer":{}}', SCOPE)).toBeNull();
  });

  it('photos too', () => {
    const photos = {
      organizationId: ORG,
      warehouseId: WH,
      photos: { [ITEM]: 'https://x.test/p.jpg' },
      signedAt: '2026-10-04T12:00:00.000Z',
      expiresAt: '2026-11-03T12:00:00.000Z',
    };
    expect(parseStoredPhotos(serializePhotos(photos), SCOPE)).toEqual(photos);
    expect(parseStoredPhotos(serializePhotos({ ...photos, organizationId: OTHER_USER }), SCOPE)).toBeNull();
  });

  it('preferences read safely', () => {
    expect(parseOrderPrefs(null)).toEqual({ lastWarehouseId: null });
    expect(parseOrderPrefs('{"lastWarehouseId":"w"}')).toEqual({ lastWarehouseId: 'w' });
    expect(parseOrderPrefs('nope')).toEqual({ lastWarehouseId: null });
  });
});

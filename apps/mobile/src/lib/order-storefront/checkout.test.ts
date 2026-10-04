import { describe, expect, it } from 'vitest';

import {
  CHECKOUT_NEEDED_BY_ZONE_UNREADABLE_COPY,
  CHECKOUT_NOT_SET_COPY,
  ORDER_NEEDS_CONNECTION_COPY,
  SUBMIT_NO_LINES_COPY,
  SUBMIT_NO_SITE_COPY,
  SUBMIT_ON_BEHALF_INCOMPLETE_COPY,
  SUBMIT_ON_BEHALF_NOT_PERMITTED_COPY,
  SUBMIT_REMOVE_UNORDERABLE_COPY,
  STOREFRONT_CART_LOCKED_COPY,
  STOREFRONT_FOR_SET_MYSELF_HINT_COPY,
  checkoutNeededByZoneUnknownCopy,
  initialCartState,
  parseOrderCreateRequest,
  type CartState,
  type KitOffer,
  type StorefrontItem,
} from '@stockpilot/core';

import {
  buildOrderCreateBody,
  cartLineNote,
  checkoutTotals,
  neededByRowValue,
  recheckRestoredCart,
  refusedItemIds,
  showNotesCounter,
  stockChangedNotice,
  storefrontNeededByZone,
  forRowView,
  submitBlockedBy,
  wallClockIso,
} from './checkout';

const USER = '22222222-2222-4222-8222-222222222222';
const WH = '33333333-3333-4333-8333-333333333333';
const A = '44444444-4444-4444-8444-444444444444';
const B = '44444444-4444-4444-8444-444444444445';
const SITE = '66666666-6666-4666-8666-666666666666';
const KEY = '55555555-5555-4555-8555-555555555555';
const BUNDLE = '77777777-7777-4777-8777-777777777777';

function item(id: string, name: string, onHand: number, reserved = 0): StorefrontItem {
  return {
    id,
    sku: `SKU-${name}`,
    name,
    quantityOnHand: onHand,
    reservedQuantity: reserved,
    categoryId: null,
    categoryName: null,
    charterId: null,
    charterName: null,
    charterCode: null,
    rackLabel: null,
    reorderPoint: 0,
  };
}

const base = (patch: Partial<CartState> = {}): CartState => ({
  ...initialCartState({ warehouseId: WH, fulfillmentType: 'pickup' }),
  lines: [{ itemId: A, quantity: 2 }],
  ...patch,
});

describe('the body Submit sends (core’s create body, as the web builds it)', () => {
  it('a pickup for myself: notes trimmed, the wall clock as typed, no site', () => {
    const body = buildOrderCreateBody({
      cart: base({ notes: '  Room 12  ', neededBy: '2026-10-05T10:00' }),
      userId: USER,
      key: KEY,
      kits: [],
    });
    expect(body).toEqual({
      idempotencyKey: KEY,
      placerUserId: USER,
      warehouseId: WH,
      fulfillmentType: 'pickup',
      deliveryCharterId: null,
      onBehalfOf: null,
      notes: 'Room 12',
      neededByLocal: '2026-10-05T10:00',
      lines: [{ itemId: A, quantity: 2 }],
    });
    expect(parseOrderCreateRequest(body).ok).toBe(true);
  });

  it('a delivery on behalf: the site, the trimmed name and email; core’s schema reads it', () => {
    const body = buildOrderCreateBody({
      cart: base({ fulfillmentType: 'delivery', charterId: SITE, onBehalfOf: { name: ' Maria ', email: ' maria@example.org ' } }),
      userId: USER,
      key: KEY,
      kits: [],
    });
    expect(body).toMatchObject({ deliveryCharterId: SITE, onBehalfOf: { name: 'Maria', email: 'maria@example.org' } });
    expect(parseOrderCreateRequest(body).ok).toBe(true);
  });

  it('a pickup never carries a site (the schema refuses one)', () => {
    const body = buildOrderCreateBody({ cart: base({ charterId: SITE }), userId: USER, key: KEY, kits: [] });
    expect(body.deliveryCharterId).toBeNull();
  });

  it('kits go in for the audit note only, as far as the cart holds them', () => {
    const kit: KitOffer = { bundleId: BUNDLE, name: 'Starter', sku: null, components: [{ anchorItemId: A, itemIds: [A], perKit: 1 }] };
    const body = buildOrderCreateBody({ cart: base({ kits: { [BUNDLE]: { [A]: 2 } } }), userId: USER, key: KEY, kits: [kit] });
    expect(body.kits).toEqual([{ bundleId: BUNDLE, count: 2 }]);
    expect(parseOrderCreateRequest(body).ok).toBe(true);
    expect(buildOrderCreateBody({ cart: base(), userId: USER, key: KEY, kits: [kit] })).not.toHaveProperty('kits');
  });
});

describe('why Submit cannot be pressed (core’s words, in this order)', () => {
  const ok = { offline: false, unorderable: new Set<string>(), siteKnown: true, canOrderOnBehalf: true };
  it.each([
    ['offline', { cart: base(), ...ok, offline: true }, ORDER_NEEDS_CONNECTION_COPY],
    ['no lines', { cart: base({ lines: [] }), ...ok }, SUBMIT_NO_LINES_COPY],
    ['delivery, no site', { cart: base({ fulfillmentType: 'delivery' }), ...ok }, SUBMIT_NO_SITE_COPY],
    ['delivery, a site no longer listed', { cart: base({ fulfillmentType: 'delivery', charterId: SITE }), ...ok, siteKnown: false }, SUBMIT_NO_SITE_COPY],
    ['on behalf, without the approve permission (slice D)', { cart: base({ onBehalfOf: { name: 'Bee', email: 'bee@x.org' } }), ...ok, canOrderOnBehalf: false }, SUBMIT_ON_BEHALF_NOT_PERMITTED_COPY],
    ['for myself, without the approve permission', { cart: base(), ...ok, canOrderOnBehalf: false }, null],
    ['on behalf, no email', { cart: base({ onBehalfOf: { name: 'M', email: ' ' } }), ...ok }, SUBMIT_ON_BEHALF_INCOMPLETE_COPY],
    ['a line that can’t be ordered', { cart: base(), ...ok, unorderable: new Set([A]) }, SUBMIT_REMOVE_UNORDERABLE_COPY],
    ['ready', { cart: base(), ...ok }, null],
  ])('%s', (_l, input, expected) => {
    expect(submitBlockedBy(input)).toBe(expected);
  });

  it('more than available does NOT block (approval is the stock check, as on the web)', () => {
    expect(submitBlockedBy({ cart: base({ lines: [{ itemId: A, quantity: 999 }] }), offline: false, unorderable: new Set(), siteKnown: true, canOrderOnBehalf: false })).toBeNull();
  });
});

describe('what a cart line says', () => {
  it('over available: kept, with the web’s warning', () => {
    expect(cartLineNote(10, item(A, 'Planner', 8), false)).toEqual({ kind: 'over', message: 'Only 8 available. Reduce the quantity.' });
  });
  it('all available in the cart', () => {
    expect(cartLineNote(8, item(A, 'Planner', 8), false)).toEqual({ kind: 'at_max', message: 'All 8 available are in your cart' });
  });
  it('not in the catalog, or refused by the server: can’t be ordered', () => {
    expect(cartLineNote(1, undefined, false)).toEqual({ kind: 'not_orderable' });
    expect(cartLineNote(1, item(A, 'Planner', 8), true)).toEqual({ kind: 'not_orderable' });
  });
  it('nothing to say', () => {
    expect(cartLineNote(1, item(A, 'Planner', 8), false)).toBeNull();
  });
  it('the refused items come from the refusal’s details', () => {
    expect([...refusedItemIds({ items: { [A]: 'archived' } } as never)]).toEqual([A]);
    expect(refusedItemIds(null).size).toBe(0);
  });
  it('totals', () => {
    expect(checkoutTotals(base({ lines: [{ itemId: A, quantity: 2 }, { itemId: B, quantity: 5 }] }))).toEqual({ lines: 2, units: 7 });
  });
});

describe('a restored cart, checked against the catalog as it is now', () => {
  const catalog = new Map([[A, item(A, 'Planner', 3)]]);

  it('nothing is dropped: the unorderable line is marked, the over line kept, one sentence', () => {
    const r = recheckRestoredCart(base({ lines: [{ itemId: A, quantity: 5 }, { itemId: B, quantity: 1 }] }), catalog);
    expect(r.cart.lines).toEqual([{ itemId: A, quantity: 5 }, { itemId: B, quantity: 1 }]);
    expect([...r.notOrderable]).toEqual([B]);
    expect(r.notice).toBe(
      "Since this cart was saved, 1 item can't be ordered from here anymore, and 1 line asks for more than is available now. They are marked below.",
    );
  });

  it('kit records are refitted to the lines', () => {
    const r = recheckRestoredCart(base({ lines: [{ itemId: A, quantity: 1 }], kits: { [BUNDLE]: { [A]: 4 } } }), catalog);
    expect(r.cart.kits).toEqual({ [BUNDLE]: { [A]: 1 } });
    expect(r.notice).toBeNull();
  });
});

describe('the stock notice at checkout', () => {
  it('names each line whose available went down below its quantity', () => {
    const before = new Map([[A, item(A, 'Planner', 20)], [B, item(B, 'Mug', 5)]]);
    const after = new Map([[A, item(A, 'Planner', 8)], [B, item(B, 'Mug', 4)]]);
    const cart = base({ lines: [{ itemId: A, quantity: 10 }, { itemId: B, quantity: 2 }] });
    expect(stockChangedNotice(cart, before, after)).toBe(
      'Stock changed since you added: Planner now has 8 available, and you have 10.',
    );
  });
  it('says nothing when nothing moved that way', () => {
    const m = new Map([[A, item(A, 'Planner', 8)]]);
    expect(stockChangedNotice(base({ lines: [{ itemId: A, quantity: 10 }] }), m, m)).toBeNull();
  });
});

describe('the needed-by', () => {
  it('the row: core’s label for the wall clock in the organization’s zone, or Not set', () => {
    expect(neededByRowValue('', 'America/Los_Angeles')).toBe(CHECKOUT_NOT_SET_COPY);
    const label = neededByRowValue('2026-10-05T10:00', 'America/Los_Angeles', Date.parse('2026-10-04T12:00:00Z'));
    expect(label).toMatch(/Oct 5/);
    expect(label).toMatch(/10:00/);
  });

  it('the picker is offered only in a zone the server reads and this phone knows', () => {
    expect(storefrontNeededByZone('America/Los_Angeles')).toEqual({ ok: true, zone: 'America/Los_Angeles' });
    expect(storefrontNeededByZone(null)).toEqual({ ok: false, message: CHECKOUT_NEEDED_BY_ZONE_UNREADABLE_COPY });
    expect(storefrontNeededByZone('Mars/Base')).toEqual({ ok: false, message: checkoutNeededByZoneUnknownCopy('Mars/Base') });
  });

  it('the notes counter shows from 1,800 characters', () => {
    expect(showNotesCounter('x'.repeat(1799))).toBe(false);
    expect(showNotesCounter('x'.repeat(1800))).toBe(true);
  });
});

describe('the picker’s opening value', () => {
  it('a wall clock’s instant in the organization’s zone', () => {
    expect(wallClockIso('2026-10-05T10:00', 'America/Los_Angeles')).toBe('2026-10-05T17:00:00.000Z');
    expect(wallClockIso('', 'America/Los_Angeles')).toBeNull();
    expect(wallClockIso('nope', 'America/Los_Angeles')).toBeNull();
  });
});

describe('checkout’s For row (desk check F2)', () => {
  const bee = { name: 'Bee', email: 'bee@x.org' };
  it('someone who may order on behalf chooses from the sheet', () => {
    expect(forRowView({ canOrderOnBehalf: true, onBehalfOf: null })).toEqual({ shown: true, detail: null, hint: undefined, tap: 'choose' });
    expect(forRowView({ canOrderOnBehalf: true, onBehalfOf: bee, lockHint: STOREFRONT_CART_LOCKED_COPY }).hint).toBe(STOREFRONT_CART_LOCKED_COPY);
  });
  it('hidden for someone who may not, with nothing kept for someone else', () => {
    expect(forRowView({ canOrderOnBehalf: false, onBehalfOf: null }).shown).toBe(false);
  });
  it('a kept cart for someone else, held by someone who may not: says so visibly, and a tap sets Myself', () => {
    expect(forRowView({ canOrderOnBehalf: false, onBehalfOf: bee })).toEqual({
      shown: true,
      detail: SUBMIT_ON_BEHALF_NOT_PERMITTED_COPY,
      hint: STOREFRONT_FOR_SET_MYSELF_HINT_COPY,
      tap: 'set-myself',
    });
  });
});

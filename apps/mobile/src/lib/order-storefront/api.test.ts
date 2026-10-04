import { describe, expect, it, vi } from 'vitest';

import {
  ORDER_MODULE_DISABLED_COPY,
  ORDER_PERMISSION_COPY,
  ORDER_PHONE_AAL2_COPY,
  ORDER_PHONE_TURNED_OFF_COPY,
  ORDER_PHONE_UNAVAILABLE_COPY,
  ORDER_STOREFRONT_LOAD_FAILED_COPY,
  ORDER_STOREFRONT_RATE_LIMITED_COPY,
  ORDER_STOREFRONT_SIGN_IN_COPY,
  ORDER_WAREHOUSE_NOT_AVAILABLE_COPY,
  type OrderCreateRequestInput,
} from '@stockpilot/core';

import {
  OrderAnswerForAnotherOrganization,
  OrderStorefrontShapeError,
  createOrderStorefrontApi,
  parseCatalogAnswer,
  parsePhotosAnswer,
  parseStorefrontAnswer,
  storefrontReadFailure,
  type OrderApiOptions,
} from './api';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER = '99999999-9999-4999-8999-999999999999';
const USER = '22222222-2222-4222-8222-222222222222';
const WH = '33333333-3333-4333-8333-333333333333';
const ITEM = '44444444-4444-4444-8444-444444444444';
const KEY = '55555555-5555-4555-8555-555555555555';
const SCOPE = { orgId: ORG, userId: USER };

const STOREFRONT = {
  organizationId: ORG,
  enabled: true,
  serverNow: '2026-10-04T12:00:00.000Z',
  warehouses: [{ id: WH, name: 'DC4' }],
  viewer: { userId: USER, role: 'manager', name: 'Pat', email: 'pat@example.org', canOrderOnBehalf: true, canApproveOrders: true },
  kitsEnabled: true,
  orgTimezone: 'America/Los_Angeles',
  deliveryRecipients: { to: 'intake@example.org', cc: 'copy@example.org', toName: null, ccName: 'Copy' },
  recentRequesters: {
    status: 'ok',
    people: [{ name: 'Maria', email: 'maria@example.org', lastOrderedAt: 'x', orders: 3, lastFulfillment: 'delivery', lastSiteId: 's1' }],
  },
  later: 'ignored',
};

const CATALOG = {
  organizationId: ORG,
  warehouseId: WH,
  generatedAt: '2026-10-04T12:00:00.000Z',
  staleAfterSeconds: 60,
  rowCeiling: 10000,
  truncated: false,
  items: [
    { id: ITEM, sku: 'PL-1', name: 'Planner', categoryId: 'c1', charterId: 'ch1', rackLabel: '1-A', quantityOnHand: 10, reservedQuantity: 2, reorderPoint: 3 },
  ],
  aisles: [{ id: 'c1', name: 'Paper', itemCount: 1 }],
  charters: { ch1: { name: 'North Campus', code: 'NC' } },
  sites: { status: 'ok', sites: [{ id: 's1', name: 'North', code: 'N', address: { line1: '1 Main', city: 'Town' } }] },
  kits: { status: 'ok', kits: [{ bundleId: 'b1', name: 'Starter', sku: 'KIT-1', components: [{ anchorItemId: ITEM, itemIds: [ITEM], perKit: 2 }] }] },
  frequentlyOrdered: { status: 'ok', items: [{ itemId: ITEM, orders: 4 }] },
};

describe('reading the storefront answer', () => {
  it('reads the documented shape and ignores extra keys', () => {
    const a = parseStorefrontAnswer(STOREFRONT);
    expect(a).toMatchObject({ enabled: true, viewer: { canOrderOnBehalf: true, canApproveOrders: true } });
    if (!a.enabled) throw new Error('enabled');
    expect(a.recentRequesters).toEqual({ status: 'ok', people: [STOREFRONT.recentRequesters.people[0]] });
    expect(a.deliveryRecipients).toEqual({ to: 'intake@example.org', cc: 'copy@example.org', toName: null, ccName: 'Copy' });
  });

  it('the kill switch reads as off, with the server’s words (core’s when it sends none)', () => {
    expect(parseStorefrontAnswer({ organizationId: ORG, enabled: false, message: 'Off now.', serverNow: 'x' })).toMatchObject({ enabled: false, message: 'Off now.' });
    expect(parseStorefrontAnswer({ organizationId: ORG, enabled: false, serverNow: 'x' })).toMatchObject({ message: ORDER_PHONE_TURNED_OFF_COPY });
  });

  it('a recent-requester list it cannot read is a failed part, never "nobody"; null stays null', () => {
    expect(parseStorefrontAnswer({ ...STOREFRONT, recentRequesters: 'x' })).toMatchObject({ recentRequesters: { status: 'error' } });
    expect(parseStorefrontAnswer({ ...STOREFRONT, recentRequesters: null })).toMatchObject({ recentRequesters: null });
  });

  it('routing it cannot read hides the email (fail closed)', () => {
    expect(parseStorefrontAnswer({ ...STOREFRONT, deliveryRecipients: { to: 'a@b.co' } })).toMatchObject({ deliveryRecipients: null });
  });

  it.each([
    ['no organization', { ...STOREFRONT, organizationId: undefined }],
    ['no viewer', { ...STOREFRONT, viewer: null }],
    ['a role it does not know', { ...STOREFRONT, viewer: { ...STOREFRONT.viewer, role: 'god' } }],
    ['warehouses not a list', { ...STOREFRONT, warehouses: {} }],
    ['enabled missing', { ...STOREFRONT, enabled: undefined }],
  ])('refuses a missing required field: %s', (_l, raw) => {
    expect(() => parseStorefrontAnswer(raw)).toThrow(OrderStorefrontShapeError);
  });
});

describe('reading the catalog answer', () => {
  it('reads every row, with no price ever carried', () => {
    const c = parseCatalogAnswer({ ...CATALOG, items: [{ ...CATALOG.items[0], price: 9.99, unitCost: 3 }] });
    expect(c.items[0]).toEqual(CATALOG.items[0]);
    expect(Object.keys(c.items[0]!)).not.toContain('price');
    expect(c.kits).toEqual(CATALOG.kits);
    expect(c.sites).toEqual({ status: 'ok', sites: [{ id: 's1', name: 'North', code: 'N', address: { line1: '1 Main', city: 'Town' } }] });
  });

  it('a row it cannot read throws: hiding it would be a silent cap', () => {
    expect(() => parseCatalogAnswer({ ...CATALOG, items: [{ id: ITEM }] })).toThrow(OrderStorefrontShapeError);
  });

  it('an optional part it cannot read is a failed part', () => {
    const c = parseCatalogAnswer({ ...CATALOG, sites: { status: 'ok', sites: [1] }, kits: { status: 'ok', kits: [{ bundleId: 'b' }] }, frequentlyOrdered: null });
    expect(c.sites).toEqual({ status: 'error' });
    expect(c.kits).toEqual({ status: 'error' });
    expect(c.frequentlyOrdered).toEqual({ status: 'error' });
  });

  it('photos keep only http(s) URLs', () => {
    const p = parsePhotosAnswer({ organizationId: ORG, warehouseId: WH, photos: { a: 'https://x/a.jpg', b: 'javascript:alert(1)', c: 3 }, signedAt: 's', expiresAt: 'e' });
    expect(p.photos).toEqual({ a: 'https://x/a.jpg' });
  });
});

describe('the six calls', () => {
  function harness(reply: unknown) {
    const seen: [string, OrderApiOptions][] = [];
    const call = vi.fn(async (path: string, opts: OrderApiOptions) => {
      seen.push([path, opts]);
      if (reply instanceof Error) throw reply;
      return reply;
    });
    return { api: createOrderStorefrontApi(call), seen };
  }

  it('every call names the organization and the account (orgId, asUserId)', async () => {
    const h = harness({});
    const body = { idempotencyKey: KEY } as unknown as OrderCreateRequestInput;
    const onSend = () => undefined;
    await h.api.storefront(SCOPE).catch(() => undefined);
    await h.api.catalog(SCOPE, WH).catch(() => undefined);
    await h.api.photos(SCOPE, WH).catch(() => undefined);
    await h.api.place(SCOPE, body, onSend);
    await h.api.status(SCOPE, KEY);
    await h.api.withdraw(SCOPE, KEY);
    expect(h.seen.map(([p, o]) => [p, o.method ?? 'GET'])).toEqual([
      ['/api/v1/orders/storefront', 'GET'],
      [`/api/v1/orders/catalog?warehouseId=${WH}`, 'GET'],
      [`/api/v1/orders/catalog/photos?warehouseId=${WH}`, 'GET'],
      ['/api/v1/orders', 'POST'],
      [`/api/v1/orders/submissions/${KEY}?placerUserId=${USER}`, 'GET'],
      [`/api/v1/orders/submissions/${KEY}/withdraw`, 'POST'],
    ]);
    for (const [, o] of h.seen) {
      expect(o.orgId).toBe(ORG);
      expect(o.asUserId).toBe(USER);
    }
    expect(h.seen[3]![1]).toMatchObject({ body, onSend });
    expect(h.seen[5]![1].body).toEqual({ placerUserId: USER });
  });

  it('an answer for another organization is dropped', async () => {
    await expect(harness({ ...STOREFRONT, organizationId: OTHER }).api.storefront(SCOPE)).rejects.toBeInstanceOf(
      OrderAnswerForAnotherOrganization,
    );
    await expect(harness({ ...CATALOG, organizationId: OTHER }).api.catalog(SCOPE, WH)).rejects.toBeInstanceOf(
      OrderAnswerForAnotherOrganization,
    );
    await expect(
      harness({ organizationId: OTHER, warehouseId: WH, photos: {}, signedAt: 's', expiresAt: 'e' }).api.photos(SCOPE, WH),
    ).rejects.toBeInstanceOf(OrderAnswerForAnotherOrganization);
  });

  it('a catalog for another warehouse is not this one', async () => {
    await expect(harness({ ...CATALOG, warehouseId: OTHER }).api.catalog(SCOPE, WH)).rejects.toBeInstanceOf(
      OrderStorefrontShapeError,
    );
  });

  it('the submission calls never throw: a thrown error is the call result', async () => {
    const err = new Error('offline');
    const h = harness(err);
    await expect(h.api.place(SCOPE, {} as OrderCreateRequestInput, () => undefined)).resolves.toEqual({ ok: false, error: err });
    await expect(h.api.status(SCOPE, KEY)).resolves.toEqual({ ok: false, error: err });
    await expect(h.api.withdraw(SCOPE, KEY)).resolves.toEqual({ ok: false, error: err });
    const ok = harness({ organizationId: ORG, outcome: 'none' });
    await expect(ok.api.status(SCOPE, KEY)).resolves.toEqual({ ok: true, status: 200, body: { organizationId: ORG, outcome: 'none' } });
  });
});

describe('what a failed read says (status and details.reason only)', () => {
  const err = (status: number, details?: Record<string, unknown>, code = 'x') => ({ status, code, details });

  it.each([
    [err(401, { reason: 'unauthenticated' }), 'refused', ORDER_STOREFRONT_SIGN_IN_COPY],
    [err(429, { reason: 'rate_limited' }), 'failed', ORDER_STOREFRONT_RATE_LIMITED_COPY],
    [err(503, { reason: 'turned_off' }), 'turned_off', ORDER_PHONE_TURNED_OFF_COPY],
    [{ status: 404 }, 'unavailable', ORDER_PHONE_UNAVAILABLE_COPY],
    [err(404, { reason: 'warehouse_not_available' }), 'refused', ORDER_WAREHOUSE_NOT_AVAILABLE_COPY],
    [err(403, { reason: 'module_disabled' }), 'refused', ORDER_MODULE_DISABLED_COPY],
    [err(403, { reason: 'aal2_required' }), 'refused', ORDER_PHONE_AAL2_COPY],
    [err(403, { reason: 'permission' }), 'refused', ORDER_PERMISSION_COPY],
    [err(500, { reason: 'failed' }), 'failed', ORDER_STOREFRONT_LOAD_FAILED_COPY],
    [new Error('Network request failed'), 'failed', ORDER_STOREFRONT_LOAD_FAILED_COPY],
  ])('%j', (e, kind, message) => {
    expect(storefrontReadFailure(e)).toEqual({ kind, message });
  });

  it('an answer for another organization says nothing', () => {
    expect(storefrontReadFailure(new OrderAnswerForAnotherOrganization())).toEqual({ kind: 'other_organization' });
  });
});

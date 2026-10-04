import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ORDER_MFA_REQUIRED_COPY,
  ORDER_MODULE_DISABLED_COPY,
  ORDER_PERMISSION_COPY,
  ORDER_PHONE_AAL2_COPY,
  ORDER_PHONE_TURNED_OFF_COPY,
  ORDER_WAREHOUSE_NOT_AVAILABLE_COPY,
  DEFAULT_MODULE_IDS,
  type ModuleId,
  type Role,
} from '@stockpilot/core';

import type { CatalogItem } from '@/components/orders/v2/types';
import { makeServiceContext, makeSupabaseStub, servedLikePostgrest } from '@/test/supabase-mock';

const { loadCatalogItemsMock, chartersMock, kitsMock, frequentMock, photoMapMock } = vi.hoisted(
  () => ({
    loadCatalogItemsMock: vi.fn(),
    chartersMock: vi.fn(),
    kitsMock: vi.fn(),
    frequentMock: vi.fn(),
    photoMapMock: vi.fn(),
  }),
);

vi.mock('server-only', () => ({}));
vi.mock('@/server/loaders/orders-new-catalog', () => ({
  CATALOG_ROW_CEILING: 10_000,
  loadCatalogItems: loadCatalogItemsMock,
  loadChartersForWarehouse: chartersMock,
}));
vi.mock('@/server/loaders/orders-kits', () => ({ loadOrderKits: kitsMock }));
vi.mock('@/server/loaders/orders-frequently-ordered', () => ({ readFrequentlyOrdered: frequentMock }));
vi.mock('@/server/loaders/orders-phone-catalog', () => ({ loadPhoneThumbMapCached: photoMapMock }));

import { buildPhoneAisles, OrderStorefrontService } from './order-storefront';

/**
 * The phone storefront's reads (phone ordering PO-3, plan 3.1 and 3.8) over
 * stubbed loaders and a stubbed caller client: the gates before any read, the
 * kill switch, the warehouse perimeter before any shared (admin-client) read,
 * the trimmed item (no price), the 2.5 s deadline on each optional part,
 * recent requesters only for an approver, and the photo map filtered to the
 * caller's own catalog.
 */

const ORG = '00000000-0000-4000-8000-00000000000a';
const USER = '00000000-0000-4000-8000-0000000000aa';
const WH = '00000000-0000-4000-8000-0000000000b1';
const WH_HIDDEN = '00000000-0000-4000-8000-0000000000b2';
const WH_ARCHIVED = '00000000-0000-4000-8000-0000000000b3';
const WH_FOREIGN = '00000000-0000-4000-8000-0000000000b9';
const CAT_X = '00000000-0000-4000-8000-0000000000d1';
const CAT_Y = '00000000-0000-4000-8000-0000000000d2';
const CHARTER = '00000000-0000-4000-8000-0000000000c1';

/** What warehouses_select lets this caller read: WH_HIDDEN is filtered out by
 *  row level security for them, so it is simply not served. */
const WAREHOUSE_ROWS = [
  { id: WH, name: 'DC4', organization_id: ORG, status: 'active' },
  { id: WH_ARCHIVED, name: 'Old DC', organization_id: ORG, status: 'archived' },
];

function item(id: string, over: Partial<CatalogItem> = {}): CatalogItem {
  return {
    id,
    sku: `SKU-${id}`,
    name: `Item ${id}`,
    warehouseId: WH,
    quantityOnHand: 10,
    reservedQuantity: 2,
    itemType: 'product',
    categoryId: CAT_X,
    categoryName: 'Supplies',
    charterId: null,
    charterName: null,
    charterCode: null,
    rackLabel: '16-B',
    imageUrl: null,
    lqip: null,
    price: 123.45,
    reorderPoint: 3,
    ...over,
  };
}

const CATALOG: CatalogItem[] = [
  item('i1'),
  item('i2', { categoryId: CAT_Y, categoryName: 'Apparel', charterId: CHARTER, charterName: 'North', charterCode: 'N' }),
  item('i3', { categoryId: null, categoryName: null, price: 9.99 }),
];

function ctxFor(
  over: {
    role?: Role;
    permissions?: string[];
    modules?: ModuleId[];
    mfaRequired?: boolean;
    mfaSatisfied?: boolean;
    mfaEnrolled?: boolean;
    results?: Record<string, unknown>;
  } = {},
) {
  const stub = makeSupabaseStub({
    'warehouses.select': servedLikePostgrest(WAREHOUSE_ROWS),
    'user_profiles.select': { data: { full_name: 'Pat Viewer', email: 'pat@example.org' }, error: null },
    'organizations.select': {
      data: {
        timezone: 'America/Los_Angeles',
        email_routing: {
          delivery_request: { to: 'intake@example.org', cc: 'copy@example.org', toName: 'Intake' },
        },
      },
      error: null,
    },
    'rpc:order_recent_requesters': {
      data: [
        {
          name: 'Maria Lopez',
          email: 'maria@example.org',
          lastOrderedAt: '2026-10-01T10:00:00+00:00',
          orders: 3,
          lastFulfillment: 'delivery',
          lastSiteId: CHARTER,
        },
      ],
      error: null,
    },
    ...(over.results as Record<string, never>),
  });
  const ctx = {
    ...makeServiceContext(stub.client, {
      organizationId: ORG,
      userId: USER,
      role: over.role ?? 'viewer',
      ...(over.permissions ? { permissions: new Set(over.permissions) } : {}),
      enabledModules: new Set(over.modules ?? DEFAULT_MODULE_IDS),
      mfaRequired: over.mfaRequired ?? false,
      mfaSatisfied: over.mfaSatisfied ?? true,
    }),
    mfaEnrolled: over.mfaEnrolled ?? false,
  };
  return { stub, service: new OrderStorefrontService(ctx as never), ctx };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  loadCatalogItemsMock.mockResolvedValue(CATALOG);
  chartersMock.mockResolvedValue([
    { id: CHARTER, name: 'North', code: 'N', address: { line1: '1 Main St', city: 'Fresno' } },
  ]);
  kitsMock.mockResolvedValue({ status: 'ok', kits: [] });
  frequentMock.mockResolvedValue({
    status: 'ok',
    entries: [{ itemId: 'i2', count: 7, fallbackImageUrl: null }],
  });
  photoMapMock.mockResolvedValue({
    signedAt: '2026-10-04T10:00:00.000Z',
    photos: { i1: 'https://signed/i1', i3: 'https://signed/i3', 'not-mine': 'https://signed/x' },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('the gates come first, in core words, before anything is read', () => {
  const cases: Array<[string, Parameters<typeof ctxFor>[0], string, string, string]> = [
    ['the Orders module off', { modules: ['inventory'] }, 'module_disabled', 'module_disabled', ORDER_MODULE_DISABLED_COPY],
    ['an enrolled factor not used this session', { mfaRequired: true, mfaSatisfied: false, mfaEnrolled: true }, 'forbidden', 'aal2_required', ORDER_PHONE_AAL2_COPY],
    ['a policy that requires a factor not set up', { mfaRequired: true, mfaSatisfied: false }, 'forbidden', 'mfa_required', ORDER_MFA_REQUIRED_COPY],
    ['orders:request revoked', { permissions: ['inventory:read'] }, 'forbidden', 'permission', ORDER_PERMISSION_COPY],
  ];

  it.each(cases)('%s', async (_label, over, code, reason, message) => {
    for (const call of ['storefront', 'catalog', 'photos'] as const) {
      const { stub, service } = ctxFor(over);
      const run = call === 'storefront' ? service.storefront() : service[call](WH);
      await expect(run).rejects.toMatchObject({ code, message, details: { reason } });
      expect(stub.fromCalls).toEqual([]);
      expect(stub.rpcCalls).toEqual([]);
    }
    expect(loadCatalogItemsMock).not.toHaveBeenCalled();
    expect(chartersMock).not.toHaveBeenCalled();
    expect(photoMapMock).not.toHaveBeenCalled();
  });
});

describe('the kill switch (ORDERS_PHONE_STOREFRONT=off) covers the three reads', () => {
  it.each(['off', 'OFF', ' off '])('storefront answers enabled false and reads nothing (%j)', async (value) => {
    vi.stubEnv('ORDERS_PHONE_STOREFRONT', value);
    const { stub, service } = ctxFor();
    const out = await service.storefront();
    expect(out).toEqual({
      organizationId: ORG,
      enabled: false,
      message: ORDER_PHONE_TURNED_OFF_COPY,
      serverNow: expect.any(String),
    });
    expect(stub.fromCalls).toEqual([]);
    expect(stub.rpcCalls).toEqual([]);
  });

  it('catalog and photos are refused with the turned_off reason, before the perimeter', async () => {
    vi.stubEnv('ORDERS_PHONE_STOREFRONT', 'off');
    for (const call of ['catalog', 'photos'] as const) {
      const { stub, service } = ctxFor();
      await expect(service[call](WH)).rejects.toMatchObject({
        message: ORDER_PHONE_TURNED_OFF_COPY,
        details: { reason: 'turned_off' },
      });
      expect(stub.fromCalls).toEqual([]);
    }
    expect(loadCatalogItemsMock).not.toHaveBeenCalled();
  });

  it.each(['', 'on', 'true', 'disabled'])('any other value (%j) leaves them on', async (value) => {
    vi.stubEnv('ORDERS_PHONE_STOREFRONT', value);
    const { service } = ctxFor();
    await expect(service.storefront()).resolves.toMatchObject({ enabled: true });
  });

  it('the gates still come first while it is off', async () => {
    vi.stubEnv('ORDERS_PHONE_STOREFRONT', 'off');
    const { service } = ctxFor({ permissions: [] });
    await expect(service.storefront()).rejects.toMatchObject({ details: { reason: 'permission' } });
  });
});

describe('GET storefront', () => {
  it("answers the caller's own warehouses, profile, zone and routing, read with their client", async () => {
    const { stub, service } = ctxFor({ role: 'viewer' });
    const out = await service.storefront();
    expect(out).toEqual({
      organizationId: ORG,
      enabled: true,
      serverNow: expect.any(String),
      warehouses: [{ id: WH, name: 'DC4' }],
      viewer: {
        userId: USER,
        role: 'viewer',
        name: 'Pat Viewer',
        email: 'pat@example.org',
        canOrderOnBehalf: false,
        canApproveOrders: false,
      },
      kitsEnabled: true,
      orgTimezone: 'America/Los_Angeles',
      deliveryRecipients: {
        to: 'intake@example.org',
        cc: 'copy@example.org',
        toName: 'Intake',
        ccName: null,
      },
      recentRequesters: null,
    });
    expect(Date.parse((out as { serverNow: string }).serverNow)).not.toBeNaN();
    expect(stub.fromCalls.sort()).toEqual(['organizations', 'user_profiles', 'warehouses']);
    // Below an approver nothing about other people is read.
    expect(stub.rpcCalls).toEqual([]);
    const wh = stub.chainArgsAll.get('warehouses.select')![0]!;
    const methods = stub.chainsAll.get('warehouses.select')![0]!;
    expect(methods.map((m, i) => [m, wh[i]])).toEqual(
      expect.arrayContaining([
        ['eq', ['organization_id', ORG]],
        ['neq', ['status', 'archived']],
      ]),
    );
  });

  it('a manager orders on behalf and approves, and gets the recent requesters', async () => {
    const { stub, service } = ctxFor({ role: 'manager' });
    const out = await service.storefront();
    expect(out).toMatchObject({
      viewer: { canOrderOnBehalf: true, canApproveOrders: true },
      recentRequesters: {
        status: 'ok',
        people: [
          {
            name: 'Maria Lopez',
            email: 'maria@example.org',
            lastOrderedAt: '2026-10-01T10:00:00+00:00',
            orders: 3,
            lastFulfillment: 'delivery',
            lastSiteId: CHARTER,
          },
        ],
      },
    });
    expect(stub.rpcCalls).toEqual([{ name: 'order_recent_requesters', args: { p_org: ORG } }]);
  });

  it('on behalf follows orders:approve, not the role (security slice D)', async () => {
    const staffApprover = await ctxFor({
      role: 'staff',
      permissions: ['orders:request', 'orders:approve'],
    }).service.storefront();
    expect(staffApprover).toMatchObject({
      viewer: { canOrderOnBehalf: true, canApproveOrders: true },
      recentRequesters: { status: 'ok' },
    });
    const revokedManager = ctxFor({ role: 'manager', permissions: ['orders:request'] });
    await expect(revokedManager.service.storefront()).resolves.toMatchObject({
      viewer: { canOrderOnBehalf: false, canApproveOrders: false },
      recentRequesters: null,
    });
    expect(revokedManager.stub.rpcCalls).toEqual([]);
    // A viewer granted orders:approve may order on behalf (the insert policy
    // asks the permission) but never sees Review and approve.
    await expect(
      ctxFor({ role: 'viewer', permissions: ['orders:request', 'orders:approve'] }).service.storefront(),
    ).resolves.toMatchObject({ viewer: { canOrderOnBehalf: true, canApproveOrders: false } });
  });

  it('recent requesters that fail to read answer error, and the storefront still answers', async () => {
    const { service } = ctxFor({
      role: 'manager',
      results: { 'rpc:order_recent_requesters': { data: null, error: { message: 'x', code: '57014' } } },
    });
    await expect(service.storefront()).resolves.toMatchObject({
      enabled: true,
      recentRequesters: { status: 'error' },
    });
  });

  it('recent requesters still running at 2.5 s answer error; the storefront does not wait', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { stub, service } = ctxFor({ role: 'manager' });
    stub.client.rpc = vi.fn(() => new Promise(() => {}));
    const answer = service.storefront();
    await vi.advanceTimersByTimeAsync(2_499);
    let settled = false;
    void answer.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(answer).resolves.toMatchObject({ recentRequesters: { status: 'error' } });
  });

  it('kitsEnabled follows the context modules; an unreadable zone is null; no routing hides the email', async () => {
    const { service } = ctxFor({
      modules: (DEFAULT_MODULE_IDS as readonly ModuleId[]).filter((m) => m !== 'bundles'),
      results: { 'organizations.select': { data: null, error: { message: 'x', code: '57014' } } },
    });
    await expect(service.storefront()).resolves.toMatchObject({
      kitsEnabled: false,
      orgTimezone: null,
      deliveryRecipients: null,
    });
  });

  it('a failed warehouse read is a fault, never "no warehouses"', async () => {
    const { service } = ctxFor({
      results: { 'warehouses.select': { data: null, error: { message: 'boom', code: '57014' } } },
    });
    await expect(service.storefront()).rejects.toMatchObject({
      code: 'internal_error',
      details: { reason: 'failed' },
    });
  });
});

describe('the warehouse perimeter (catalog and photos)', () => {
  it.each([
    ['another organization', WH_FOREIGN],
    ['one row level security hides', WH_HIDDEN],
    ['an archived one', WH_ARCHIVED],
    ['not an id', 'dc4'],
  ])('%s: warehouse_not_available before any shared read', async (_label, id) => {
    for (const call of ['catalog', 'photos'] as const) {
      const { service } = ctxFor({ role: 'owner' });
      await expect(service[call](id)).rejects.toMatchObject({
        code: 'not_found',
        message: ORDER_WAREHOUSE_NOT_AVAILABLE_COPY,
        details: { reason: 'warehouse_not_available' },
      });
    }
    expect(loadCatalogItemsMock).not.toHaveBeenCalled();
    expect(chartersMock).not.toHaveBeenCalled();
    expect(kitsMock).not.toHaveBeenCalled();
    expect(frequentMock).not.toHaveBeenCalled();
    expect(photoMapMock).not.toHaveBeenCalled();
  });

  it('no warehouse id is a validation refusal', async () => {
    const { service } = ctxFor();
    await expect(service.catalog(null)).rejects.toMatchObject({
      code: 'validation_error',
      details: { reason: 'invalid', field: 'warehouseId' },
    });
  });
});

describe('GET catalog', () => {
  it("the caller's own catalog, trimmed: no price, no photo, names in aisles and charters", async () => {
    const { ctx, service } = ctxFor({ role: 'viewer' });
    const out = await service.catalog(WH);
    expect(loadCatalogItemsMock).toHaveBeenCalledWith(ctx, WH, ctx.supabase);
    expect(out).toEqual({
      organizationId: ORG,
      warehouseId: WH,
      generatedAt: expect.any(String),
      staleAfterSeconds: 60,
      rowCeiling: 10_000,
      truncated: false,
      items: [
        { id: 'i1', sku: 'SKU-i1', name: 'Item i1', categoryId: CAT_X, charterId: null, rackLabel: '16-B', quantityOnHand: 10, reservedQuantity: 2, reorderPoint: 3 },
        { id: 'i2', sku: 'SKU-i2', name: 'Item i2', categoryId: CAT_Y, charterId: CHARTER, rackLabel: '16-B', quantityOnHand: 10, reservedQuantity: 2, reorderPoint: 3 },
        { id: 'i3', sku: 'SKU-i3', name: 'Item i3', categoryId: null, charterId: null, rackLabel: '16-B', quantityOnHand: 10, reservedQuantity: 2, reorderPoint: 3 },
      ],
      aisles: [
        { id: CAT_Y, name: 'Apparel', itemCount: 1 },
        { id: CAT_X, name: 'Supplies', itemCount: 1 },
        { id: null, name: 'Uncategorized', itemCount: 1 },
      ],
      charters: { [CHARTER]: { name: 'North', code: 'N' } },
      sites: {
        status: 'ok',
        sites: [{ id: CHARTER, name: 'North', code: 'N', address: { line1: '1 Main St', city: 'Fresno' } }],
      },
      kits: { status: 'ok', kits: [] },
      frequentlyOrdered: { status: 'ok', items: [{ itemId: 'i2', orders: 7 }] },
    });
    const text = JSON.stringify(out);
    expect(text).not.toMatch(/price|unit_?cost|lqip|imageUrl/i);
    expect(text).not.toContain('123.45');
    expect(text).not.toContain('9.99');
  });

  it('truncated at the 10,000-row ceiling', async () => {
    loadCatalogItemsMock.mockResolvedValue(Array.from({ length: 10_000 }, (_, i) => item(`i${i}`)));
    const out = await ctxFor().service.catalog(WH);
    expect(out.truncated).toBe(true);
    expect(out.items).toHaveLength(10_000);
  });

  it("kits and Frequently ordered read with the caller's modules and client, matched to their catalog", async () => {
    const { ctx, service } = ctxFor({ role: 'staff' });
    await service.catalog(WH);
    expect(kitsMock).toHaveBeenCalledWith(ORG, WH, expect.any(Promise), {
      modules: ctx.enabledModules,
      client: ctx.supabase,
    });
    await expect(kitsMock.mock.calls[0]![2]).resolves.toEqual({ items: CATALOG });
    expect(frequentMock).toHaveBeenCalledWith(WH, expect.any(Promise), {
      client: ctx.supabase,
      imageFallback: false,
    });
    expect(chartersMock).toHaveBeenCalledWith(WH);
  });

  it.each([
    ['sites', () => chartersMock.mockReturnValue(new Promise(() => {}))],
    ['kits', () => kitsMock.mockReturnValue(new Promise(() => {}))],
    ['frequentlyOrdered', () => frequentMock.mockReturnValue(new Promise(() => {}))],
  ] as const)('%s still running 2.5 s after the catalog arrived answers error; the catalog answers', async (part, hang) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    hang();
    let releaseCatalog: (v: CatalogItem[]) => void = () => {};
    loadCatalogItemsMock.mockReturnValue(new Promise((r) => (releaseCatalog = r)));
    const answer = ctxFor().service.catalog(WH);
    // The clock only starts once the catalog is in: a slow catalog does not
    // eat the parts' time.
    await vi.advanceTimersByTimeAsync(5_000);
    releaseCatalog(CATALOG);
    await vi.advanceTimersByTimeAsync(2_499);
    let settled = false;
    void answer.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const out = await answer;
    expect(out[part]).toEqual({ status: 'error' });
    expect(out.items).toHaveLength(3);
    for (const other of ['sites', 'kits', 'frequentlyOrdered'] as const) {
      if (other !== part) expect(out[other]).toMatchObject({ status: 'ok' });
    }
  });

  it('a failed part answers error at once; a failed catalog is a fault', async () => {
    chartersMock.mockRejectedValue(new Error('charters read failed'));
    frequentMock.mockResolvedValue({ status: 'error' });
    kitsMock.mockResolvedValue({ status: 'error' });
    const out = await ctxFor().service.catalog(WH);
    expect(out.sites).toEqual({ status: 'error' });
    expect(out.kits).toEqual({ status: 'error' });
    expect(out.frequentlyOrdered).toEqual({ status: 'error' });

    loadCatalogItemsMock.mockRejectedValue(new Error('[orders-new] catalog items read failed: x'));
    await expect(ctxFor().service.catalog(WH)).rejects.toThrow(/catalog items read failed/);
  });
});

describe('GET catalog/photos', () => {
  it("only the caller's catalog ids leave the server; valid 30 days from signing", async () => {
    const { ctx, service } = ctxFor();
    const out = await service.photos(WH);
    expect(photoMapMock).toHaveBeenCalledWith(ORG, WH);
    expect(loadCatalogItemsMock).toHaveBeenCalledWith(ctx, WH, ctx.supabase);
    expect(out).toEqual({
      organizationId: ORG,
      warehouseId: WH,
      photos: { i1: 'https://signed/i1', i3: 'https://signed/i3' },
      signedAt: '2026-10-04T10:00:00.000Z',
      expiresAt: '2026-11-03T10:00:00.000Z',
    });
  });

  it('a map that could not be built is a fault', async () => {
    photoMapMock.mockRejectedValue(new Error('[orders-phone] photo sign failed'));
    await expect(ctxFor().service.photos(WH)).rejects.toThrow(/photo sign failed/);
  });
});

describe('buildPhoneAisles', () => {
  it('named aisles A to Z by name, Uncategorized last, counts per category', () => {
    expect(
      buildPhoneAisles([
        { categoryId: 'b', categoryName: 'Bravo' },
        { categoryId: null, categoryName: null },
        { categoryId: 'a', categoryName: 'alpha' },
        { categoryId: 'b', categoryName: 'Bravo' },
        { categoryId: 'c', categoryName: null },
      ]),
    ).toEqual([
      { id: 'a', name: 'alpha', itemCount: 1 },
      { id: 'b', name: 'Bravo', itemCount: 2 },
      { id: 'c', name: 'c', itemCount: 1 },
      { id: null, name: 'Uncategorized', itemCount: 1 },
    ]);
  });
});

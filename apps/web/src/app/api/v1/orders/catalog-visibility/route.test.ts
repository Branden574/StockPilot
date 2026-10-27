import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import {
  DEFAULT_MODULE_IDS,
  ORDER_ITEMS_AAL2_REQUIRED_COPY,
  ORDER_ITEMS_FEATURE_DISABLED_COPY,
  ORDER_ITEMS_FORBIDDEN_COPY,
  ORDER_ITEMS_INTERNAL_COPY,
  ORDER_ITEMS_INVALID_COPY,
  ORDER_ITEMS_ITEMS_UNAVAILABLE_COPY,
  ORDER_ITEMS_LOAD_FAILED_COPY,
  type ModuleId,
} from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

/**
 * GET and POST /api/v1/orders/catalog-visibility and GET .../family/[groupId]
 * (ordering visibility, 0413; design 4.3): the HTTP answers over the real
 * OrderCatalogVisibilityService and a stubbed caller client. Every answer is
 * private, no-store and names the organization; refusals carry core's words and
 * the reason a screen switches on; a fault never carries the database's text.
 */

const { revalidateTag, afterCallbacks } = vi.hoisted(() => ({
  revalidateTag: vi.fn(),
  afterCallbacks: [] as Array<() => unknown>,
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('next/cache', () => ({ revalidateTag, unstable_cache: vi.fn((fn: unknown) => fn) }));
vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>();
  return { ...actual, after: (cb: () => unknown) => afterCallbacks.push(cb) };
});
vi.mock('@/server/services/public-catalog', () => ({ expireOrgPublicCatalogs: vi.fn(async () => 0) }));
vi.mock('@/server/services/item-images', () => ({
  ItemImagesService: class {
    primaryImagesWithThumbsForItems = vi.fn(async () => new Map());
  },
}));

import { GET as FAMILY } from './family/[groupId]/route';
import { GET, POST } from './route';

const ORG = '0a0a0a0a-0000-4000-8000-000000000001';
const WH = '0b0b0b0b-0000-4000-8000-000000000001';
const OP = '0c0c0c0c-0000-4000-8000-000000000001';
const FAMILY_ID = '0d0d0d0d-0000-4000-8000-000000000001';
const ITEM = '0e0e0e0e-0000-4000-8000-000000000001';
const ITEM_2 = '0e0e0e0e-0000-4000-8000-000000000002';
const MANAGE = 'orders:manage_catalog_visibility';

function context(
  results: Parameters<typeof makeSupabaseStub>[0] = {},
  over: {
    permissions?: string[];
    modules?: ModuleId[];
    mfaRequired?: boolean;
    mfaSatisfied?: boolean;
    mfaEnrolled?: boolean;
  } = {},
) {
  const stub = makeSupabaseStub(results);
  const ctx = {
    ...makeServiceContext(stub.client, {
      organizationId: ORG,
      userId: 'user-1',
      role: 'manager',
      permissions: new Set(over.permissions ?? ['orders:request', MANAGE]),
      enabledModules: new Set(over.modules ?? DEFAULT_MODULE_IDS),
      mfaRequired: over.mfaRequired ?? false,
      mfaSatisfied: over.mfaSatisfied ?? true,
    }),
    mfaEnrolled: over.mfaEnrolled ?? false,
  };
  vi.mocked(withApiContext).mockResolvedValue(ctx as never);
  return { stub, ctx };
}

const listReq = (qs = '') => new NextRequest(`http://localhost/api/v1/orders/catalog-visibility${qs}`);
const postReq = (body: unknown) =>
  new NextRequest('http://localhost/api/v1/orders/catalog-visibility', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
const familyReq = (id: string) =>
  [
    new NextRequest(`http://localhost/api/v1/orders/catalog-visibility/family/${id}`),
    { params: Promise.resolve({ groupId: id }) },
  ] as const;

async function json(res: Response) {
  return (await res.json()) as Record<string, any>;
}

const listRow = {
  id: ITEM,
  name: 'Example tee',
  sku: 'TEE-M',
  barcode: null,
  item_type: 'product',
  variant_size: 'M',
  warehouse_id: WH,
  category_id: null,
  group_id: FAMILY_ID,
  order_catalog_visible: false,
  order_catalog_visibility_changed_at: '2026-10-26T12:00:00.000Z',
  awaiting_first_receipt: false,
  author: null,
  cover: null,
  warehouse: { name: 'Main' },
  category: null,
  family: { name: 'Example tee' },
};

beforeEach(() => {
  vi.clearAllMocks();
  afterCallbacks.length = 0;
  vi.stubEnv('ORDER_ITEMS_MANAGE_ORGS', '*');
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true, count: 1, resetAt: Date.now() + 60_000 } as never);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.unstubAllEnvs());

describe('GET /api/v1/orders/catalog-visibility', () => {
  it('401 without a session, private and no-store', async () => {
    vi.mocked(withApiContext).mockResolvedValue(null as never);
    const res = await GET(listReq());
    expect(res.status).toBe(401);
    expect(await json(res)).toMatchObject({ error: 'unauthenticated', details: { reason: 'unauthenticated' } });
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });

  it('200: one page, the query read by core, the organization named', async () => {
    const { stub } = context({
      'inventory_items.select': { data: [listRow], error: null, count: 26 } as never,
    });
    const res = await GET(listReq('?visibility=hidden&page=2&type=nonsense'));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const body = await json(res);
    expect(body).toMatchObject({
      organizationId: ORG,
      viewer: { canManage: true },
      page: 2,
      pageSize: 25,
      total: 26,
      rows: [
        {
          id: ITEM,
          itemType: 'item',
          sizeOrEdition: 'M',
          familyId: FAMILY_ID,
          visible: false,
          hiddenSince: '2026-10-26T12:00:00.000Z',
        },
      ],
    });
    const methods = stub.chainsAll.get('inventory_items.select')![0]!;
    const args = stub.chainArgsAll.get('inventory_items.select')![0]!;
    const chain = methods.map((m, i) => [m, args[i]]);
    expect(chain).toContainEqual(['eq', ['order_catalog_visible', false]]);
    expect(chain).toContainEqual(['range', [25, 49]]);
    // A malformed type falls back to all: no type filter.
    expect(chain.find(([m, a]) => m === 'eq' && (a as unknown[])[0] === 'item_type')).toBeUndefined();
    expect(checkRateLimit).toHaveBeenCalledWith('order-catalog-manage:user-1', 120, 60_000);
  });

  it('429 past the read limit, nothing read', async () => {
    const { stub } = context();
    vi.mocked(checkRateLimit).mockResolvedValue({ allowed: false, count: 121, resetAt: Date.now() + 20_000 } as never);
    const res = await GET(listReq());
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThanOrEqual(19);
    expect(await json(res)).toMatchObject({
      organizationId: ORG,
      error: 'rate_limited',
      details: { reason: 'rate_limited', organizationId: ORG },
    });
    expect(stub.fromCalls).toEqual([]);
  });

  it.each([
    ['the switch off', { env: '' }, 403, 'forbidden', 'feature_disabled', ORDER_ITEMS_FEATURE_DISABLED_COPY],
    ['no capability', { permissions: ['orders:request'] }, 403, 'forbidden', 'forbidden', ORDER_ITEMS_FORBIDDEN_COPY],
    ['an AAL1 session that must step up', { mfaRequired: true, mfaSatisfied: false, mfaEnrolled: true }, 403, 'forbidden', 'aal2_required', ORDER_ITEMS_AAL2_REQUIRED_COPY],
    ['the Orders module off', { modules: ['inventory'] as ModuleId[] }, 403, 'module_disabled', 'module_disabled', undefined],
  ])('%s: %s %s', async (_label, over, status, error, reason, message) => {
    if ('env' in over) vi.stubEnv('ORDER_ITEMS_MANAGE_ORGS', over.env as string);
    const { stub } = context({}, over as never);
    const res = await GET(listReq());
    expect(res.status).toBe(status);
    const body = await json(res);
    expect(body).toMatchObject({ organizationId: ORG, error, details: { reason, organizationId: ORG } });
    if (message) expect(body.message).toBe(message);
    expect(stub.fromCalls).toEqual([]);
  });

  it("500 in core's words when the read fails, reported with the cause and never answered with it", async () => {
    context({ 'inventory_items.select': { data: null, error: { message: 'relation secret', code: 'XX000' } } });
    const res = await GET(listReq());
    expect(res.status).toBe(500);
    const body = await json(res);
    expect(body).toEqual({
      organizationId: ORG,
      error: 'internal_error',
      message: ORDER_ITEMS_LOAD_FAILED_COPY,
      details: { reason: 'failed', organizationId: ORG },
    });
    expect(JSON.stringify(body)).not.toContain('relation secret');
    expect(reportError).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/v1/orders/catalog-visibility', () => {
  it('200: hides as the caller with surface app, expires the catalog tag with expire 0', async () => {
    const { stub } = context({
      'rpc:set_order_catalog_visibility': {
        data: { organizationId: ORG, operationId: OP, visible: false, changed: [ITEM], unchanged: [ITEM_2] },
        error: null,
      },
    });
    const res = await POST(postReq({ itemIds: [ITEM, ITEM_2], visible: false, operationId: OP }));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(await json(res)).toEqual({
      organizationId: ORG,
      operationId: OP,
      visible: false,
      changed: [ITEM],
      unchanged: [ITEM_2],
    });
    expect(stub.rpcCalls).toEqual([
      {
        name: 'set_order_catalog_visibility',
        args: {
          p_organization_id: ORG,
          p_item_ids: [ITEM, ITEM_2],
          p_visible: false,
          p_operation_id: OP,
          p_surface: 'app',
        },
      },
    ]);
    expect(revalidateTag.mock.calls).toEqual([[`orders-new-v2-catalog:${ORG}`, { expire: 0 }]]);
    // No warming from a write (the no-request-path-prewarm guard).
    expect(afterCallbacks).toHaveLength(0);
  });

  it('400 for a body that is not JSON, nothing sent', async () => {
    const { stub } = context();
    const res = await POST(postReq('{not json'));
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({
      organizationId: ORG,
      error: 'validation_error',
      message: ORDER_ITEMS_INVALID_COPY,
      details: { reason: 'invalid', field: 'body' },
    });
    expect(stub.rpcCalls).toEqual([]);
  });

  it('400 for 501 ids', async () => {
    const { stub } = context();
    const ids = Array.from({ length: 501 }, (_, i) => `0e0e0e0e-0000-4000-8000-${String(i).padStart(12, '0')}`);
    const res = await POST(postReq({ itemIds: ids, visible: false, operationId: OP }));
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ details: { reason: 'invalid', field: 'itemIds' } });
    expect(stub.rpcCalls).toEqual([]);
  });

  it('409 items_unavailable with only the caller\'s own ids', async () => {
    context({
      'rpc:set_order_catalog_visibility': {
        data: null,
        error: {
          code: 'P0002',
          hint: 'order_catalog_items_unavailable',
          message: 'x',
          details: JSON.stringify([ITEM_2]),
        },
      },
    });
    const res = await POST(postReq({ itemIds: [ITEM, ITEM_2], visible: false, operationId: OP }));
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({
      organizationId: ORG,
      error: 'conflict',
      message: ORDER_ITEMS_ITEMS_UNAVAILABLE_COPY,
      details: { reason: 'items_unavailable', itemIds: [ITEM_2], organizationId: ORG },
    });
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it('409 busy, retryable with the same operation id', async () => {
    context({
      'rpc:set_order_catalog_visibility': { data: null, error: { code: '55P03', message: 'lock timeout' } },
    });
    const res = await POST(postReq({ itemIds: [ITEM], visible: true, operationId: OP }));
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({ details: { reason: 'busy', retryable: true, operationId: OP } });
  });

  it('403 forbidden when the database refuses the capability (a deny that landed after the gate)', async () => {
    context({
      'rpc:set_order_catalog_visibility': {
        data: null,
        error: { code: '42501', hint: 'order_catalog_forbidden', message: 'You do not have access to manage order items.' },
      },
    });
    const res = await POST(postReq({ itemIds: [ITEM], visible: false, operationId: OP }));
    expect(res.status).toBe(403);
    expect(await json(res)).toMatchObject({ message: ORDER_ITEMS_FORBIDDEN_COPY, details: { reason: 'forbidden' } });
  });

  it('429 past the write limit, with retry-after', async () => {
    const { stub } = context();
    vi.mocked(checkRateLimit).mockResolvedValue({ allowed: false, count: 61, resetAt: Date.now() + 10_000 } as never);
    const res = await POST(postReq({ itemIds: [ITEM], visible: false, operationId: OP }));
    expect(checkRateLimit).toHaveBeenCalledWith('order-catalog-visibility:user-1', 60, 60_000);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThanOrEqual(9);
    expect(await json(res)).toMatchObject({ error: 'rate_limited', details: { reason: 'rate_limited', retryable: true } });
    expect(stub.rpcCalls).toEqual([]);
  });

  it("500 in core's words for anything else", async () => {
    context({
      'rpc:set_order_catalog_visibility': { data: null, error: { code: 'XX000', message: 'relation secret' } },
    });
    const res = await POST(postReq({ itemIds: [ITEM], visible: false, operationId: OP }));
    expect(res.status).toBe(500);
    const body = await json(res);
    expect(body).toMatchObject({ message: ORDER_ITEMS_INTERNAL_COPY, details: { reason: 'failed' } });
    expect(JSON.stringify(body)).not.toContain('relation secret');
  });
});

describe('GET /api/v1/orders/catalog-visibility/family/[groupId]', () => {
  it('200: the family records the caller can read', async () => {
    const { stub } = context({ 'inventory_items.select': { data: [listRow], error: null } });
    const res = await FAMILY(...familyReq(FAMILY_ID));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(await json(res)).toMatchObject({
      organizationId: ORG,
      familyId: FAMILY_ID,
      familyName: 'Example tee',
      truncated: false,
      rows: [{ id: ITEM }],
    });
    const methods = stub.chainsAll.get('inventory_items.select')![0]!;
    const args = stub.chainArgsAll.get('inventory_items.select')![0]!;
    expect(methods.map((m, i) => [m, args[i]])).toContainEqual(['eq', ['group_id', FAMILY_ID]]);
  });

  it('400 for an id that is not a uuid', async () => {
    const { stub } = context();
    const res = await FAMILY(...familyReq('nope'));
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ details: { reason: 'invalid', field: 'groupId' } });
    expect(stub.fromCalls).toEqual([]);
  });

  it('403 when the switch is off', async () => {
    vi.stubEnv('ORDER_ITEMS_MANAGE_ORGS', '');
    context();
    const res = await FAMILY(...familyReq(FAMILY_ID));
    expect(res.status).toBe(403);
    expect(await json(res)).toMatchObject({ details: { reason: 'feature_disabled' } });
  });
});

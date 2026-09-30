import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import {
  SHORTFALL_PO_BUSY_COPY,
  SHORTFALL_PO_CHANGED_COPY,
  SHORTFALL_PO_FAILED_COPY,
  SHORTFALL_PO_FORBIDDEN_COPY,
  SHORTFALL_PO_INVALID_COPY,
  SHORTFALL_PO_ITEM_NOT_DRAFTABLE_COPY,
  SHORTFALL_PO_NOT_FOUND_COPY,
  SHORTFALL_PO_PURCHASE_ORDERS_OFF_COPY,
  type ModuleId,
  type Role,
} from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { makeServiceContext, makeSupabaseStub, type QueryResult } from '@/test/supabase-mock';

/**
 * POST /api/v1/orders/[id]/shortfall-po (F2-5): the phone's (Bearer) and the
 * web's (cookie) way to draft purchase orders for what an order is short.
 * Driven through the REAL service over a stubbed client, so every refusal of
 * draft_order_shortfall_pos (0385) is followed from the Postgres error to the
 * HTTP answer: status, code, core's sentence and `details` (the reason a
 * screen switches on; the current maxima after shortfall_changed). The web
 * action answers the same request with the same call and the same result.
 */

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('@/lib/auth/warehouse', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/auth/warehouse')>();
  return { ...real, assertWarehouseAccess: vi.fn(async () => {}) };
});
vi.mock('@/server/services/audit', () => ({
  audit: vi.fn(async () => {}),
  auditMany: vi.fn(async (p: unknown[]) => ({ written: p.length, lost: 0 })),
}));
vi.mock('@/server/services/integration-events', () => ({ dispatchEvent: vi.fn(async () => {}) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock('@/server/services/context', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/server/services/context')>();
  return { ...real, withContext: vi.fn(async () => holder.ctx) };
});

const holder: { ctx: unknown } = { ctx: null };

import { draftShortfallPosAction } from '@/server/actions/order-readiness';

import { POST } from './route';

const ORDER = '0f000000-0000-4000-8000-000000000009';
const ITEM = '0f000000-0000-4000-8000-0000000000a1';
const ANSWER = {
  orderId: ORDER,
  orderNumber: 9,
  replay: false,
  created: [
    {
      purchaseOrderId: 'po-1',
      poNumber: 'PO-2026-0017',
      supplierId: null,
      lineCount: 1,
      units: 180,
      lines: [{ itemId: ITEM, quantity: 180 }],
    },
  ],
};

function setup(opts: { rpc?: QueryResult; role?: Role; modules?: ModuleId[] } = {}) {
  const stub = makeSupabaseStub({
    'order_requests.select': { data: { id: ORDER, warehouse_id: 'wh-1', order_number: 9 }, error: null },
    'rpc:draft_order_shortfall_pos': opts.rpc ?? { data: ANSWER, error: null },
  });
  const ctx = makeServiceContext(stub.client, {
    role: opts.role ?? 'manager',
    userId: 'buyer-1',
    enabledModules: new Set<ModuleId>(opts.modules ?? ['orders', 'purchase_orders']),
  });
  holder.ctx = ctx;
  vi.mocked(withApiContext).mockResolvedValue(ctx as never);
  return stub;
}

function req(body: unknown, opts: { id?: string; auth?: 'bearer' | 'cookie' } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if ((opts.auth ?? 'bearer') === 'bearer') headers.authorization = 'Bearer t';
  else headers.cookie = 'sb-access-token=t';
  return new NextRequest(`http://localhost/api/v1/orders/${opts.id ?? ORDER}/shortfall-po`, {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers,
  });
}
const params = (id = ORDER) => Promise.resolve({ id });
const BODY = { lines: [{ itemId: ITEM, quantity: 180 }], idempotencyKey: 'k-1' };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true, resetAt: 0 } as never);
});

describe('POST /api/v1/orders/[id]/shortfall-po', () => {
  it('200 with the result: the drafts created, from the function', async () => {
    const stub = setup();
    const res = await POST(req(BODY), { params: params() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: ANSWER });
    expect(stub.rpcCalls).toEqual([
      {
        name: 'draft_order_shortfall_pos',
        args: { p_order_id: ORDER, p_lines: [{ item_id: ITEM, quantity: 180 }], p_idempotency_key: 'k-1' },
      },
    ]);
  });

  it('cookie and Bearer: the same request is resolved by withApiContext either way and answers the same', async () => {
    const bearer = setup();
    const a = await POST(req(BODY, { auth: 'bearer' }), { params: params() });
    const cookie = setup();
    const b = await POST(req(BODY, { auth: 'cookie' }), { params: params() });
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(await a.json()).toEqual(await b.json());
    expect(bearer.rpcCalls).toEqual(cookie.rpcCalls);
    // withApiContext gets the request itself: a Bearer token is read from it,
    // and without one the cookie session is (the test runtime drops the
    // Cookie header from a Request, so the cookie case shows as no Bearer).
    const seen = vi.mocked(withApiContext).mock.calls.map(
      ([r]) => (r as NextRequest).headers.get('authorization') ?? 'no bearer: the cookie session',
    );
    expect(seen).toEqual(['Bearer t', 'no bearer: the cookie session']);
  });

  it('the web action sends the same call and answers the same result', async () => {
    const phone = setup();
    const viaRoute = (await (await POST(req(BODY), { params: params() })).json()) as { result: unknown };
    const web = setup();
    const viaAction = await draftShortfallPosAction({ orderId: ORDER, ...BODY });
    expect(viaAction).toEqual({ ok: true, data: viaRoute.result });
    expect(web.rpcCalls).toEqual(phone.rpcCalls);
  });

  it('401 without a session or token', async () => {
    setup();
    vi.mocked(withApiContext).mockResolvedValueOnce(null);
    expect((await POST(req(BODY), { params: params() })).status).toBe(401);
  });

  it('429 when rate limited, before anything is read', async () => {
    const stub = setup();
    vi.mocked(checkRateLimit).mockResolvedValueOnce({ allowed: false, resetAt: Date.now() + 1000 } as never);
    expect((await POST(req(BODY), { params: params() })).status).toBe(429);
    expect(stub.fromCalls).toEqual([]);
    expect(stub.rpcCalls).toEqual([]);
  });

  it('400 for a bad order id or body, before anything is read', async () => {
    const stub = setup();
    expect((await POST(req(BODY, { id: 'nope' }), { params: params('nope') })).status).toBe(400);
    for (const bad of [
      'not json',
      {},
      { ...BODY, lines: [] },
      { ...BODY, lines: [{ itemId: 'x', quantity: 1 }] },
      { ...BODY, lines: [{ itemId: ITEM, quantity: 0 }] },
      { ...BODY, lines: [{ itemId: ITEM, quantity: '5' }] },
      { ...BODY, idempotencyKey: '' },
      { ...BODY, idempotencyKey: 'k'.repeat(201) },
      { lines: BODY.lines },
    ]) {
      const res = await POST(req(bad), { params: params() });
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(await res.json()).toEqual({
        error: 'validation_error',
        message: SHORTFALL_PO_INVALID_COPY,
        details: { reason: 'invalid' },
      });
    }
    expect(stub.rpcCalls).toEqual([]);
  });

  const CASES: Array<[string, NonNullable<QueryResult['error']>, number, string, string, Record<string, unknown>]> = [
    ['not found', { message: 'order_request_not_found', code: 'P0002' }, 404, 'not_found', SHORTFALL_PO_NOT_FOUND_COPY, { reason: 'not_found' }],
    ['module off', { message: 'module_disabled', code: 'P0001', hint: 'module_disabled', details: 'purchase_orders' }, 403, 'module_disabled', SHORTFALL_PO_PURCHASE_ORDERS_OFF_COPY, { reason: 'module_disabled', module: 'purchase_orders' }],
    ['not a manager', { message: 'forbidden', code: '42501', hint: 'manager_required' }, 403, 'forbidden', SHORTFALL_PO_FORBIDDEN_COPY, { reason: 'forbidden' }],
    [
      'the numbers moved',
      { message: 'shortfall_changed', code: 'P0001', hint: 'shortfall_changed', details: `{"${ITEM}": 40}` },
      409,
      'conflict',
      SHORTFALL_PO_CHANGED_COPY,
      { reason: 'shortfall_changed', current: { [ITEM]: 40 } },
    ],
    ['a kit', { message: 'item_not_draftable', code: 'P0001', hint: 'item_not_draftable', details: `{"${ITEM}": "kit_stock"}` }, 400, 'validation_error', SHORTFALL_PO_ITEM_NOT_DRAFTABLE_COPY, { reason: 'item_not_draftable', items: { [ITEM]: 'kit_stock' } }],
    ['busy', { message: 'canceling statement due to lock timeout', code: '55P03' }, 409, 'conflict', SHORTFALL_PO_BUSY_COPY, { reason: 'busy', retryable: true }],
    ['anything else', { message: 'permission denied for function draft_order_shortfall_pos', code: '42501' }, 500, 'internal_error', SHORTFALL_PO_FAILED_COPY, { reason: 'failed' }],
  ];

  it.each(CASES)('maps %s', async (_label, error, status, code, message, details) => {
    setup({ rpc: { data: null, error } });
    const res = await POST(req(BODY), { params: params() });
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: code, message, details });
  });

  it('the web action answers every refusal the same way (code, words, details)', async () => {
    for (const [, error, , code, message, details] of CASES) {
      setup({ rpc: { data: null, error } });
      expect(await draftShortfallPosAction({ orderId: ORDER, ...BODY })).toEqual({
        ok: false,
        error: { code, message, details },
      });
    }
  });

  it("a throw that is not a ServiceError is a 500 in core's words, reported", async () => {
    setup();
    vi.mocked(withApiContext).mockResolvedValueOnce({
      ...(holder.ctx as object),
      supabase: {
        from: () => {
          throw new Error('socket hang up');
        },
      },
    } as never);
    const res = await POST(req(BODY), { params: params() });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal_error', message: SHORTFALL_PO_FAILED_COPY, details: { reason: 'failed' } });
    expect(reportError).toHaveBeenCalled();
  });

  it('staff are refused before the function, in core words', async () => {
    const stub = setup({ role: 'staff' });
    const res = await POST(req(BODY), { params: params() });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden', message: SHORTFALL_PO_FORBIDDEN_COPY, details: { reason: 'forbidden' } });
    expect(stub.rpcCalls).toEqual([]);
  });

  it('the action refuses a malformed request before any read, in core words', async () => {
    const stub = setup();
    expect(await draftShortfallPosAction({ orderId: ORDER, lines: [], idempotencyKey: 'k' })).toEqual({
      ok: false,
      error: { code: 'validation_error', message: SHORTFALL_PO_INVALID_COPY, details: { reason: 'invalid' } },
    });
    expect(stub.fromCalls).toEqual([]);
  });
});

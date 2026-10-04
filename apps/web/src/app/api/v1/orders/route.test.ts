import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import {
  classifyOrderSubmitResult,
  ORDER_BUSY_COPY,
  ORDER_FAULT_COPY,
  ORDER_MODULE_DISABLED_COPY,
  ORDER_PERMISSION_COPY,
  ORDER_PLACER_MISMATCH_COPY,
  ORDER_SIGN_IN_COPY,
  ORDER_WAREHOUSE_NOT_AVAILABLE_COPY,
  ORDER_WITHDRAWN_COPY,
  orderCreateRefusalCopy,
  type ModuleId,
  type Role,
} from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { makeServiceContext, makeSupabaseStub, type QueryResult } from '@/test/supabase-mock';

/**
 * POST /api/v1/orders (phone ordering PO-2): the phone's (Bearer) and the
 * web's (cookie) way to place an order, over the REAL service and a stubbed
 * client, so every answer of place_order_request (0391) is followed from the
 * database to the HTTP answer: status, code, core's words, `details` (the
 * reason and `settled` a screen switches on), `no-store` and the
 * organization echo. The web action sends the same call.
 */

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('@/server/services/audit', () => ({ audit: vi.fn(async () => {}) }));
vi.mock('@/server/services/integration-events', () => ({ dispatchEvent: vi.fn(async () => {}) }));
vi.mock('next/cache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/cache')>()),
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));
vi.mock('@/server/services/context', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/server/services/context')>();
  return { ...real, withContext: vi.fn(async () => holder.ctx) };
});

const holder: { ctx: unknown } = { ctx: null };

import { createOrderRequestAction } from '@/server/actions/order-requests';
import { OrderRequestsService } from '@/server/services/order-requests';

import { POST } from './route';

const ORG = 'org-test';
const USER = 'eeeeeeee-0000-4000-8000-0000000000aa';
const WH = 'aaaaaaaa-0000-4000-8000-000000000001';
const ITEM = 'bbbbbbbb-0000-4000-8000-00000000000a';
const KEY = 'eeeeeeee-0000-4000-8000-000000000001';
const SUMMARY = {
  id: 'ffffffff-0000-4000-8000-000000000001',
  order_number: 123,
  status: 'pending_approval',
  warehouse_id: WH,
  fulfillment_type: 'pickup',
  delivery_charter_id: null,
  needed_by: null,
  created_at: '2026-10-04T10:00:00+00:00',
  requester_user_id: USER,
  requester_name: null,
  requester_email: null,
  line_count: 1,
  unit_count: 2,
};
const ORDER = {
  id: SUMMARY.id,
  orderNumber: 123,
  orderLabel: 'SO-000123',
  status: 'pending_approval',
  warehouseId: WH,
  fulfillmentType: 'pickup',
  deliveryCharterId: null,
  neededBy: null,
  lineCount: 1,
  unitCount: 2,
  createdAt: '2026-10-04T10:00:00+00:00',
  requestedFor: { self: true },
};
const BODY = {
  idempotencyKey: KEY,
  placerUserId: USER,
  warehouseId: WH,
  fulfillmentType: 'pickup',
  deliveryCharterId: null,
  onBehalfOf: null,
  notes: null,
  neededByLocal: null,
  lines: [{ itemId: ITEM, quantity: 2 }],
};

function setup(
  rpc: QueryResult = { data: { outcome: 'placed', replay: false, order: SUMMARY }, error: null },
  opts: { role?: Role; modules?: ModuleId[]; permissions?: string[] } = {},
) {
  const stub = makeSupabaseStub({
    'organizations.select': { data: { timezone: 'America/Los_Angeles' }, error: null },
    'rpc:place_order_request': rpc,
  });
  const ctx = makeServiceContext(stub.client, {
    role: opts.role ?? 'staff',
    userId: USER,
    enabledModules: new Set<ModuleId>(opts.modules ?? ['orders']),
    ...(opts.permissions ? { permissions: new Set(opts.permissions) } : {}),
  });
  holder.ctx = ctx;
  vi.mocked(withApiContext).mockResolvedValue(ctx as never);
  return stub;
}

function req(body: unknown, auth: 'bearer' | 'cookie' = 'bearer') {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (auth === 'bearer') headers.authorization = 'Bearer t';
  return new NextRequest('http://localhost/api/v1/orders', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true, resetAt: 0 } as never);
  vi.spyOn(
    OrderRequestsService.prototype as unknown as { notifyEmail: () => Promise<void> },
    'notifyEmail',
  ).mockResolvedValue(undefined);
});

describe('POST /api/v1/orders', () => {
  it('201 with the order placed now, no-store, the organization echoed; surface app', async () => {
    const stub = setup();
    const res = await POST(req(BODY));
    expect(res.status).toBe(201);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const json = await res.json();
    expect(json).toEqual({ organizationId: ORG, result: { replay: false, order: ORDER } });
    expect((stub.rpcCalls[0]?.args as { p_request: { surface: string } }).p_request.surface).toBe(
      'app',
    );
    // Core's classifier reads it as placed (the phone runs exactly this).
    expect(
      classifyOrderSubmitResult({ ok: true, status: 201, body: json }, { sends: 1 }),
    ).toMatchObject({
      final: true,
      outcome: 'placed',
      replay: false,
    });
  });

  it('200 with replay true when the key had placed it already', async () => {
    setup({ data: { outcome: 'placed', replay: true, order: SUMMARY }, error: null });
    const res = await POST(req(BODY));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      organizationId: ORG,
      result: { replay: true, order: ORDER },
    });
  });

  it('Bearer and cookie answer the same, and the web action sends the same call', async () => {
    const bearer = setup();
    const a = await (await POST(req(BODY, 'bearer'))).json();
    const cookie = setup();
    const b = await (await POST(req(BODY, 'cookie'))).json();
    expect(a).toEqual(b);
    expect(bearer.rpcCalls).toEqual(cookie.rpcCalls);
    const web = setup();
    const viaAction = await createOrderRequestAction(BODY as never);
    expect(viaAction).toEqual({ ok: true, data: a });
    const surfaces = [bearer, web].map(
      (s) => (s.rpcCalls[0]?.args as { p_request: { surface: string } }).p_request.surface,
    );
    expect(surfaces).toEqual(['app', 'web']);
  });

  it('401 JSON without a session or token (the route exists: not a 404)', async () => {
    setup();
    vi.mocked(withApiContext).mockResolvedValueOnce(null);
    const res = await POST(req(BODY));
    expect(res.status).toBe(401);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(await res.json()).toEqual({
      error: 'unauthenticated',
      message: ORDER_SIGN_IN_COPY,
      details: { reason: 'unauthenticated' },
    });
  });

  it('429 with retry-after when rate limited (order-create:<user>, 20 a minute), before anything is read', async () => {
    const stub = setup();
    vi.mocked(checkRateLimit).mockResolvedValueOnce({
      allowed: false,
      resetAt: Date.now() + 5000,
    } as never);
    const res = await POST(req(BODY));
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(vi.mocked(checkRateLimit)).toHaveBeenCalledWith(`order-create:${USER}`, 20, 60_000);
    expect(stub.rpcCalls).toEqual([]);
  });

  it("400 for a body core refuses, in core's words with the reason, before anything is read", async () => {
    const stub = setup();
    const cases: Array<[unknown, Record<string, unknown>]> = [
      ['not json', { reason: 'invalid', field: 'body' }],
      [
        {
          ...BODY,
          lines: Array.from({ length: 101 }, (_, i) => ({
            itemId: ITEM.replace(/a$/, (i % 10).toString()),
            quantity: 1,
          })),
        },
        { reason: 'too_many_lines' },
      ],
      [{ ...BODY, lines: [{ itemId: ITEM, quantity: 1.5 }] }, { reason: 'quantity_not_whole' }],
      [
        { ...BODY, price: 1 },
        { reason: 'invalid', field: 'price' },
      ],
      [
        { ...BODY, idempotencyKey: 'k-1' },
        { reason: 'invalid', field: 'idempotencyKey' },
      ],
    ];
    for (const [bad, details] of cases) {
      const res = await POST(req(bad));
      expect(res.status, JSON.stringify(details)).toBe(400);
      const json = (await res.json()) as { details: unknown; organizationId: string };
      expect(json.details).toEqual(details);
      expect(json.organizationId).toBe(ORG);
    }
    expect(stub.rpcCalls).toEqual([]);
  });

  const CASES: Array<[string, QueryResult, number, string, string, Record<string, unknown>]> = [
    [
      'placer_mismatch (step 1)',
      { data: null, error: { message: 'placer_mismatch', code: '42501', hint: 'placer_mismatch' } },
      403,
      'forbidden',
      ORDER_PLACER_MISMATCH_COPY,
      { reason: 'placer_mismatch' },
    ],
    [
      'a shape the database refuses',
      {
        data: null,
        error: { message: 'order_invalid', code: '22023', hint: 'order_invalid', details: 'total' },
      },
      400,
      'validation_error',
      orderCreateRefusalCopy('too_many_units'),
      { reason: 'too_many_units' },
    ],
    [
      'busy',
      { data: null, error: { message: 'canceling statement due to lock timeout', code: '55P03' } },
      409,
      'conflict',
      ORDER_BUSY_COPY,
      { reason: 'busy', retryable: true },
    ],
    [
      'recorded: module off',
      {
        data: {
          outcome: 'refused',
          replay: false,
          refusal: { reason: 'module_disabled', detail: null },
        },
        error: null,
      },
      403,
      'module_disabled',
      ORDER_MODULE_DISABLED_COPY,
      { reason: 'module_disabled', settled: true, replay: false },
    ],
    [
      'recorded: warehouse',
      {
        data: {
          outcome: 'refused',
          replay: true,
          refusal: { reason: 'warehouse_not_available', detail: null },
        },
        error: null,
      },
      404,
      'not_found',
      ORDER_WAREHOUSE_NOT_AVAILABLE_COPY,
      { reason: 'warehouse_not_available', settled: true, replay: true },
    ],
    [
      'withdrawn',
      { data: { outcome: 'withdrawn' }, error: null },
      409,
      'conflict',
      ORDER_WITHDRAWN_COPY,
      { reason: 'submission_withdrawn', settled: true },
    ],
    [
      'anything else',
      {
        data: null,
        error: { message: 'permission denied for function place_order_request', code: '42501' },
      },
      500,
      'internal_error',
      ORDER_FAULT_COPY,
      { reason: 'failed' },
    ],
  ];
  it.each(CASES)('%s', async (_label, rpc, status, error, message, details) => {
    setup(rpc);
    const res = await POST(req(BODY));
    expect(res.status).toBe(status);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(await res.json()).toEqual({ organizationId: ORG, error, message, details });
  });

  it('the service gates answer 403 with their reasons (module, permission), nothing called', async () => {
    const off = setup(undefined, { modules: [] });
    let res = await POST(req(BODY));
    expect([res.status, (await res.json()).details]).toEqual([403, { reason: 'module_disabled' }]);
    expect(off.rpcCalls).toEqual([]);
    const noPerm = setup(undefined, { permissions: ['inventory:read'] });
    res = await POST(req(BODY));
    const json = await res.json();
    expect([res.status, json.message, json.details]).toEqual([
      403,
      ORDER_PERMISSION_COPY,
      { reason: 'permission' },
    ]);
    expect(noPerm.rpcCalls).toEqual([]);
  });

  it('a fault is reported under its tag, with no body content in the report', async () => {
    setup({ data: null, error: { message: 'fetch failed' } });
    await POST(req({ ...BODY, notes: 'Room 12 for Maria Lopez' }));
    expect(reportError).toHaveBeenCalledTimes(1);
    const [err, ctx] = vi.mocked(reportError).mock.calls[0] ?? [];
    expect(ctx).toEqual({ tag: 'api.v1.orders.create', organizationId: ORG });
    expect(String((err as Error).message)).not.toContain('Maria');
  });
});

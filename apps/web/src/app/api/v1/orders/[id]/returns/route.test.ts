import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { checkRateLimit } from '@/lib/rate-limit';
import { ServiceError } from '@/server/services/context';
import { RMAService } from '@/server/services/returns';
import { makeSupabaseStub } from '@/test/supabase-mock';

import { POST } from './route';

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn() }));
// The route must reuse the service (never re-implement createFromOrder) —
// mock the class and assert construction + method args, mirroring the
// po-imports approve suite.
vi.mock('@/server/services/returns', () => ({ RMAService: { forApiContext: vi.fn() } }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));

const ORDER_ID = '11111111-1111-1111-1111-111111111111';
const LINE_ID = '22222222-2222-2222-2222-222222222222';

function buildCtx() {
  const stub = makeSupabaseStub({});
  return {
    organizationId: 'org-1',
    userId: 'u-1',
    role: 'manager' as const,
    supabase: stub.client as never,
    mfaRequired: false,
    mfaSatisfied: true,
    enabledModules: new Set<ModuleId>(['returns' as ModuleId]),
  };
}

function buildRequest(body?: unknown, id = ORDER_ID) {
  return new Request(`https://test.local/api/v1/orders/${id}/returns`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }) as unknown as Parameters<typeof POST>[0];
}

function buildParams(id = ORDER_ID) {
  return { params: Promise.resolve({ id }) };
}

function mockService(methods: Record<string, unknown>) {
  vi.mocked(RMAService.forApiContext).mockReturnValueOnce(
    methods as unknown as ReturnType<typeof RMAService.forApiContext>,
  );
}

const goodBody = {
  reasonCode: 'damaged',
  notes: 'Box crushed in transit',
  lines: [{ orderRequestLineId: LINE_ID, quantity: 2, disposition: 'restock' }],
};

describe('POST /api/v1/orders/[id]/returns', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: true,
      count: 1,
      resetAt: Date.now() + 60_000,
    });
  });

  it('returns 401 without an auth context and never touches the service', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(null);
    const res = await POST(buildRequest(goodBody), buildParams());
    expect(res.status).toBe(401);
    expect(RMAService.forApiContext).not.toHaveBeenCalled();
  });

  it('returns 429 when rate-limited (30/min per user)', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    vi.mocked(checkRateLimit).mockResolvedValueOnce({
      allowed: false,
      count: 31,
      resetAt: Date.now() + 30_000,
    });

    const res = await POST(buildRequest(goodBody), buildParams());

    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBeTruthy();
    expect(checkRateLimit).toHaveBeenCalledWith('orders:returns:u-1', 30, 60_000);
    expect(RMAService.forApiContext).not.toHaveBeenCalled();
  });

  it('returns 400 for a non-uuid order id', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    const res = await POST(buildRequest(goodBody, 'not-a-uuid'), buildParams('not-a-uuid'));
    expect(res.status).toBe(400);
    expect(RMAService.forApiContext).not.toHaveBeenCalled();
  });

  it('returns 400 for a non-JSON body', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    const req = new Request(`https://test.local/api/v1/orders/${ORDER_ID}/returns`, {
      method: 'POST',
      body: 'not json',
    }) as unknown as Parameters<typeof POST>[0];
    const res = await POST(req, buildParams());
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('validation_error');
    expect(RMAService.forApiContext).not.toHaveBeenCalled();
  });

  it('returns 400 when lines is empty (same zod as the web action)', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    const res = await POST(buildRequest({ lines: [] }), buildParams());
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('validation_error');
    expect(RMAService.forApiContext).not.toHaveBeenCalled();
  });

  it('returns 400 for a non-positive quantity / bad disposition', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    const res = await POST(
      buildRequest({
        lines: [{ orderRequestLineId: LINE_ID, quantity: 0, disposition: 'restock' }],
      }),
      buildParams(),
    );
    expect(res.status).toBe(400);

    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    const res2 = await POST(
      buildRequest({
        lines: [{ orderRequestLineId: LINE_ID, quantity: 1, disposition: 'shred' }],
      }),
      buildParams(),
    );
    expect(res2.status).toBe(400);
    expect(RMAService.forApiContext).not.toHaveBeenCalled();
  });

  it('returns 400 for a fractional quantity (whole units only)', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    const res = await POST(
      buildRequest({
        lines: [{ orderRequestLineId: LINE_ID, quantity: 2.5, disposition: 'restock' }],
      }),
      buildParams(),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('validation_error');
    expect(RMAService.forApiContext).not.toHaveBeenCalled();
  });

  it('maps a service forbidden (missing returns:manage) to 403', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    mockService({
      createFromOrder: vi.fn(async () => {
        throw new ServiceError('forbidden', 'Missing permission: returns:manage');
      }),
    });

    const res = await POST(buildRequest(goodBody), buildParams());
    expect(res.status).toBe(403);
  });

  it('maps a service module_disabled (returns module off) to 403', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    mockService({
      createFromOrder: vi.fn(async () => {
        throw new ServiceError(
          'module_disabled',
          'Module not enabled for this organization: returns',
        );
      }),
    });

    const res = await POST(buildRequest(goodBody), buildParams());
    expect(res.status).toBe(403);
  });

  it('maps a service not_found (foreign-org / unknown order) to 404', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    mockService({
      createFromOrder: vi.fn(async () => {
        throw new ServiceError('not_found', 'Order not found.');
      }),
    });

    const res = await POST(buildRequest(goodBody), buildParams());
    expect(res.status).toBe(404);
  });

  it('maps a service over-budget validation_error to 400 with the message', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    mockService({
      createFromOrder: vi.fn(async () => {
        throw new ServiceError(
          'validation_error',
          'Cannot return 5; only 2 of 4 fulfilled remain returnable for this line.',
        );
      }),
    });

    const res = await POST(buildRequest(goodBody), buildParams());
    expect(res.status).toBe(400);
    expect((await res.json()).message).toMatch(/remain returnable/);
  });

  it('creates via the service with path id + body and returns { ok, return, replay }', async () => {
    const ctx = buildCtx();
    vi.mocked(withApiContext).mockResolvedValueOnce(ctx);
    const created = {
      id: 'ret-1',
      return_number: 'RMA-1',
      status: 'requested',
      lines: [{ id: 'rl-1' }],
      replay: false,
    };
    const createFromOrder = vi.fn(async (..._args: unknown[]) => created);
    mockService({ createFromOrder });

    const res = await POST(buildRequest(goodBody), buildParams());

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(await res.json()).toEqual({ ok: true, return: created, replay: false });
    expect(RMAService.forApiContext).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-1', userId: 'u-1' }),
    );
    expect(createFromOrder).toHaveBeenCalledWith(
      ORDER_ID,
      {
        reasonCode: 'damaged',
        notes: 'Box crushed in transit',
        lines: [{ orderRequestLineId: LINE_ID, quantity: 2, disposition: 'restock' }],
      },
      // An old body without a key: the service mints one per request (A-4).
      { idempotencyKey: null },
    );
  });

  it('passes the idempotency key and the item-is-here switch through', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    const createFromOrder = vi.fn(async (..._args: unknown[]) => ({ id: 'ret-2', lines: [], replay: true }));
    mockService({ createFromOrder });
    const key = '33333333-3333-4333-8333-333333333333';
    const res = await POST(buildRequest({ ...goodBody, idempotencyKey: key, itemIsHere: true }), buildParams());
    expect(res.status).toBe(200);
    expect((await res.json()).replay).toBe(true);
    const [, body, opts] = createFromOrder.mock.calls[0]!;
    expect(body).toMatchObject({ itemIsHere: true, idempotencyKey: key });
    expect(opts).toEqual({ idempotencyKey: key });
  });

  it('reads a numeric-string quantity from an older phone as a number', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    const createFromOrder = vi.fn(async (..._args: unknown[]) => ({ id: 'ret-3', lines: [], replay: false }));
    mockService({ createFromOrder });
    const res = await POST(
      buildRequest({ lines: [{ orderRequestLineId: LINE_ID, quantity: '2', disposition: 'scrap' }] }),
      buildParams(),
    );
    expect(res.status).toBe(200);
    expect((createFromOrder.mock.calls[0]![1] as { lines: Array<{ quantity: unknown }> }).lines[0]!.quantity).toBe(2);
  });

  it('a refusal keeps its database reason; an internal error never carries raw text', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    mockService({
      createFromOrder: vi.fn(async () => {
        throw new ServiceError('conflict', 'This request was already sent with different details. Reload and try again.', {
          reason: 'idempotency_conflict',
        });
      }),
    });
    const res = await POST(buildRequest(goodBody), buildParams());
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'conflict', details: { reason: 'idempotency_conflict' } });

    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    mockService({
      createFromOrder: vi.fn(async () => {
        throw new ServiceError('internal_error', 'relation "returns" does not exist');
      }),
    });
    const res2 = await POST(buildRequest(goodBody), buildParams());
    expect(res2.status).toBe(500);
    const body2 = await res2.json();
    expect(JSON.stringify(body2)).not.toMatch(/relation/);
    expect(body2.details).toEqual({ reason: 'failed' });
  });
});

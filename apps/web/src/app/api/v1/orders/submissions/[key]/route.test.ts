import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import {
  classifyOrderSettleResult,
  ORDER_BUSY_COPY,
  ORDER_FAULT_COPY,
  ORDER_PLACER_MISMATCH_UNCONFIRMED_COPY,
  ORDER_RATE_LIMITED_COPY,
  ORDER_SIGN_IN_COPY,
  type ModuleId,
} from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { checkRateLimit } from '@/lib/rate-limit';
import { makeServiceContext, makeSupabaseStub, type QueryResult } from '@/test/supabase-mock';

/**
 * GET /api/v1/orders/submissions/{key} and POST .../withdraw (phone ordering
 * PO-2): settling your own submission key. Membership only: both work with the
 * Orders module off and orders:request revoked (a person whose access was
 * removed can still find out what happened, and withdraw). Every answer is
 * no-store and names the organization; core's settle classifier reads them.
 */

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));

import { GET } from './route';
import { POST as WITHDRAW } from './withdraw/route';

const ORG = 'org-test';
const USER = 'eeeeeeee-0000-4000-8000-0000000000aa';
const KEY = 'eeeeeeee-0000-4000-8000-000000000001';
const SUMMARY = {
  id: 'ffffffff-0000-4000-8000-000000000001',
  order_number: 123,
  status: 'pending_approval',
  warehouse_id: 'aaaaaaaa-0000-4000-8000-000000000001',
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

function setup(
  results: Record<string, QueryResult>,
  opts: { modules?: ModuleId[]; permissions?: string[] } = {},
) {
  const stub = makeSupabaseStub(results);
  const ctx = makeServiceContext(stub.client, {
    role: 'staff',
    userId: USER,
    enabledModules: new Set<ModuleId>(opts.modules ?? ['orders']),
    ...(opts.permissions ? { permissions: new Set(opts.permissions) } : {}),
  });
  vi.mocked(withApiContext).mockResolvedValue(ctx as never);
  return stub;
}

const get = (key = KEY, query = '') =>
  GET(
    new NextRequest(`http://localhost/api/v1/orders/submissions/${key}${query}`, {
      headers: { authorization: 'Bearer t' },
    }),
    {
      params: Promise.resolve({ key }),
    },
  );
const withdraw = (key = KEY, body?: string) =>
  WITHDRAW(
    new NextRequest(`http://localhost/api/v1/orders/submissions/${key}/withdraw`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer t',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body } : {}),
    }),
    { params: Promise.resolve({ key }) },
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true, resetAt: 0 } as never);
});

describe('GET /api/v1/orders/submissions/{key}', () => {
  it.each([
    ['none', { outcome: 'none' }, { organizationId: ORG, outcome: 'none' }],
    ['withdrawn', { outcome: 'withdrawn' }, { organizationId: ORG, outcome: 'withdrawn' }],
    [
      'refused',
      { outcome: 'refused', refusal: { reason: 'site_not_available', detail: 'inactive' } },
      {
        organizationId: ORG,
        outcome: 'refused',
        refusal: { reason: 'site_not_available', detail: 'inactive' },
      },
    ],
  ])('answers %s, no-store', async (_label, data, expected) => {
    const stub = setup({ 'rpc:order_submission_status': { data, error: null } });
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(await res.json()).toEqual(expected);
    expect(stub.rpcCalls).toEqual([
      { name: 'order_submission_status', args: { p_org: ORG, p_key: KEY } },
    ]);
  });

  it('answers placed with the order summary; core reads it as final (placed, replay)', async () => {
    setup({
      'rpc:order_submission_status': { data: { outcome: 'placed', order: SUMMARY }, error: null },
    });
    const json = await (await get()).json();
    expect(json).toMatchObject({
      organizationId: ORG,
      outcome: 'placed',
      order: { id: SUMMARY.id, orderLabel: 'SO-000123' },
    });
    expect(classifyOrderSettleResult({ ok: true, status: 200, body: json })).toMatchObject({
      final: true,
      outcome: 'placed',
    });
  });

  it('none is NOT final for core: a status read never unlocks a cart', async () => {
    setup({ 'rpc:order_submission_status': { data: { outcome: 'none' }, error: null } });
    const json = await (await get()).json();
    expect(classifyOrderSettleResult({ ok: true, status: 200, body: json })).toMatchObject({
      final: false,
    });
  });

  it('works with the Orders module off and orders:request revoked (membership only)', async () => {
    const stub = setup(
      { 'rpc:order_submission_status': { data: { outcome: 'none' }, error: null } },
      { modules: [], permissions: [] },
    );
    expect((await get()).status).toBe(200);
    expect(stub.rpcCalls).toHaveLength(1);
  });

  it('401 without a session; 429 rate limited (order-submission:<user>, 60 a minute); 400 for a key that is not a uuid', async () => {
    const stub = setup({});
    vi.mocked(withApiContext).mockResolvedValueOnce(null);
    expect((await get()).status).toBe(401);
    vi.mocked(checkRateLimit).mockResolvedValueOnce({
      allowed: false,
      resetAt: Date.now() + 1000,
    } as never);
    expect((await get()).status).toBe(429);
    expect(vi.mocked(checkRateLimit)).toHaveBeenLastCalledWith(
      `order-submission:${USER}`,
      60,
      60_000,
    );
    const bad = await get('shortfall-1');
    expect(bad.status).toBe(400);
    expect((await bad.json()).details).toEqual({
      reason: 'invalid',
      field: 'idempotencyKey',
      organizationId: ORG,
    });
    expect(stub.rpcCalls).toEqual([]);
  });

  it("a non-member is 403 in sign-in words; a fault is core's sentence with reason 'failed'", async () => {
    setup({
      'rpc:order_submission_status': {
        data: null,
        error: { message: 'not_member', code: '42501', hint: 'not_member' },
      },
    });
    let res = await get();
    expect([res.status, await res.json()]).toEqual([
      403,
      {
        organizationId: ORG,
        error: 'forbidden',
        message: ORDER_SIGN_IN_COPY,
        details: { reason: 'not_member', organizationId: ORG },
      },
    ]);
    setup({ 'rpc:order_submission_status': { data: null, error: { message: 'fetch failed' } } });
    res = await get();
    expect([res.status, await res.json()]).toEqual([
      500,
      {
        organizationId: ORG,
        error: 'internal_error',
        message: ORDER_FAULT_COPY,
        details: { reason: 'failed', organizationId: ORG },
      },
    ]);
  });
});

describe('POST /api/v1/orders/submissions/{key}/withdraw', () => {
  it('records withdrawn as the app and answers it (final for core)', async () => {
    const stub = setup({
      'rpc:withdraw_order_submission': { data: { outcome: 'withdrawn' }, error: null },
    });
    const res = await withdraw();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const json = await res.json();
    expect(json).toEqual({ organizationId: ORG, outcome: 'withdrawn' });
    expect(stub.rpcCalls).toEqual([
      { name: 'withdraw_order_submission', args: { p_org: ORG, p_key: KEY, p_surface: 'app' } },
    ]);
    expect(classifyOrderSettleResult({ ok: true, status: 200, body: json })).toEqual({
      final: true,
      outcome: 'withdrawn',
    });
  });

  it('answers the order a key had already placed', async () => {
    setup({
      'rpc:withdraw_order_submission': { data: { outcome: 'placed', order: SUMMARY }, error: null },
    });
    expect(await (await withdraw()).json()).toMatchObject({
      outcome: 'placed',
      order: { id: SUMMARY.id },
    });
  });

  it('works with the Orders module off and orders:request revoked', async () => {
    setup(
      { 'rpc:withdraw_order_submission': { data: { outcome: 'withdrawn' }, error: null } },
      { modules: [], permissions: [] },
    );
    expect((await withdraw()).status).toBe(200);
  });

  it('409 busy (retryable) while a placement under the key still runs: not final', async () => {
    setup({
      'rpc:withdraw_order_submission': {
        data: null,
        error: { message: 'lock timeout', code: '55P03' },
      },
    });
    const res = await withdraw();
    const json = await res.json();
    expect([res.status, json]).toEqual([
      409,
      {
        organizationId: ORG,
        error: 'conflict',
        message: ORDER_BUSY_COPY,
        details: { reason: 'busy', retryable: true, organizationId: ORG },
      },
    ]);
    expect(
      classifyOrderSettleResult({
        ok: false,
        error: { status: 409, code: json.error, details: json.details },
      }),
    ).toMatchObject({ final: false, why: 'busy' });
  });

  it('400 for a key that is not a uuid, before anything is called', async () => {
    const stub = setup({});
    expect((await withdraw('nope')).status).toBe(400);
    expect(stub.rpcCalls).toEqual([]);
  });
});

describe('the account a settle call was sent for (review round 1)', () => {
  const OTHER = 'eeeeeeee-0000-4000-8000-0000000000bb';
  const answers = {
    'rpc:order_submission_status': { data: { outcome: 'withdrawn' }, error: null },
    'rpc:withdraw_order_submission': { data: { outcome: 'withdrawn' }, error: null },
  };

  it('GET with another account as placerUserId is 403 placer_mismatch, never settled, nothing called', async () => {
    const stub = setup(answers);
    const res = await get(KEY, `?placerUserId=${OTHER}`);
    const json = await res.json();
    expect([res.status, json.error, json.message, json.details]).toEqual([
      403,
      'forbidden',
      ORDER_PLACER_MISMATCH_UNCONFIRMED_COPY,
      { reason: 'placer_mismatch', organizationId: ORG },
    ]);
    expect(stub.rpcCalls).toEqual([]);
    expect(
      classifyOrderSettleResult({ ok: false, error: { status: 403, code: json.error, details: json.details } }),
    ).toMatchObject({ final: false, reason: 'placer_mismatch' });
  });

  it('POST withdraw with another account as placerUserId is 403 placer_mismatch, nothing called', async () => {
    const stub = setup(answers);
    const res = await withdraw(KEY, JSON.stringify({ placerUserId: OTHER }));
    expect([res.status, (await res.json()).details]).toEqual([
      403,
      { reason: 'placer_mismatch', organizationId: ORG },
    ]);
    expect(stub.rpcCalls).toEqual([]);
  });

  it('a placerUserId that is not a uuid, or a body that is not JSON, is 400 before anything is called', async () => {
    const stub = setup(answers);
    let res = await get(KEY, '?placerUserId=nope');
    expect([res.status, (await res.json()).details]).toEqual([
      400,
      { reason: 'invalid', field: 'placerUserId', organizationId: ORG },
    ]);
    res = await withdraw(KEY, JSON.stringify({ placerUserId: 'nope' }));
    expect([res.status, (await res.json()).details]).toEqual([
      400,
      { reason: 'invalid', field: 'placerUserId', organizationId: ORG },
    ]);
    res = await withdraw(KEY, 'not json');
    expect([res.status, (await res.json()).details]).toEqual([
      400,
      { reason: 'invalid', field: 'body', organizationId: ORG },
    ]);
    expect(stub.rpcCalls).toEqual([]);
  });

  it('the signed-in account (any case), or none named, is answered as before', async () => {
    const stub = setup(answers);
    expect((await get(KEY, `?placerUserId=${USER.toUpperCase()}`)).status).toBe(200);
    expect((await withdraw(KEY, JSON.stringify({ placerUserId: USER }))).status).toBe(200);
    expect((await withdraw(KEY, '')).status).toBe(200);
    expect((await withdraw(KEY)).status).toBe(200);
    expect(stub.rpcCalls).toHaveLength(4);
  });

  it("429 says core's words and names the organization", async () => {
    setup(answers);
    vi.mocked(checkRateLimit).mockResolvedValueOnce({ allowed: false, resetAt: Date.now() + 1000 } as never);
    const json = await (await get()).json();
    expect(json.message).toBe(ORDER_RATE_LIMITED_COPY);
    expect(json.details).toEqual({ reason: 'rate_limited', organizationId: ORG });
  });
});

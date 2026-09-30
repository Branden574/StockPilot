import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import {
  NEEDED_BY_BUSY_COPY,
  NEEDED_BY_CLOSED_COPY,
  NEEDED_BY_FAILED_COPY,
  NEEDED_BY_IN_PAST_COPY,
  NEEDED_BY_MODULE_OFF_COPY,
  NEEDED_BY_NO_WAREHOUSE_ACCESS_COPY,
  NEEDED_BY_NOT_APPROVER_COPY,
  NEEDED_BY_NOT_FOUND_COPY,
  NEEDED_BY_REASON_REQUIRED_COPY,
  NEEDED_BY_SIGN_IN_COPY,
  neededByChangedCopy,
  neededByInvalidTimeCopy,
  type ModuleId,
  type Role,
} from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { makeServiceContext, makeSupabaseStub, type QueryResult } from '@/test/supabase-mock';

/**
 * POST /api/v1/orders/[id]/needed-by (F2-4): the phone's (Bearer) and the
 * web's (cookie) way to change an order's needed-by. Driven through the REAL
 * service over a stubbed client, so every refusal of revise_order_needed_by
 * (0383) is followed from the Postgres error to the HTTP answer: status, code,
 * core's sentence and `details` (the reason a screen switches on; the current
 * value for a stale edit).
 */

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('@/lib/auth/warehouse', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/auth/warehouse')>();
  return {
    ...real,
    assertWarehouseAccess: vi.fn(async () => {}),
    getWarehouseAccess: vi.fn(async () => ({ readableIds: [], writableIds: [], hasAllAccess: true, primaryWarehouseId: null })),
  };
});
vi.mock('@/server/services/audit', () => ({ audit: vi.fn(async () => {}) }));
vi.mock('@/server/services/notifications', () => ({ createNotification: vi.fn(async () => 'n') }));
vi.mock('@/server/services/integration-events', () => ({ dispatchEvent: vi.fn(async () => {}) }));
vi.mock('@/lib/realtime/broadcast', () => ({ broadcastOrderChanged: vi.fn(async () => {}) }));
vi.mock('@/lib/email/order-requests', () => ({ sendOrderRequestEmail: vi.fn(async () => {}) }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => holder.admin }));
// The web action's side of the same-instant test.
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock('@/server/loaders/inventory-list', () => ({
  revalidateInventoryListForCurrentOrg: vi.fn(async () => undefined),
  revalidateInventoryListForOrg: vi.fn(async () => undefined),
}));
vi.mock('@/server/services/context', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/server/services/context')>();
  return { ...real, withContext: vi.fn(async () => holder.ctx) };
});

const holder: { admin: unknown; ctx: unknown } = { admin: null, ctx: null };

import { reviseOrderNeededByAction } from '@/server/actions/order-requests';

import { POST } from './route';

const ORDER = '0f000000-0000-4000-8000-000000000016';
const SEEN = '2026-10-01T21:00:00+00:00';
const LA = 'America/Los_Angeles';

function setup(
  opts: { rpc?: QueryResult; role?: Role; modules?: ModuleId[]; timezone?: string } = {},
) {
  const stub = makeSupabaseStub({
    'order_requests.select': {
      data: {
        id: ORDER,
        organization_id: 'org-test',
        warehouse_id: 'wh-1',
        status: 'approved',
        needed_by: SEEN,
        order_number: 16,
        fulfillment_type: 'pickup',
        requester_name: null,
        assigned_delivery_user_id: null,
      },
      error: null,
    },
    'organizations.select': { data: { timezone: opts.timezone ?? LA }, error: null },
    'rpc:revise_order_needed_by': opts.rpc ?? {
      data: {
        changed: true,
        previous: SEEN,
        neededBy: '2026-10-03T21:00:00+00:00',
        eventId: 'ev-1',
        eventUpdated: true,
        status: 'approved',
      },
      error: null,
    },
  });
  holder.admin = makeSupabaseStub().client;
  const ctx = makeServiceContext(stub.client, {
    role: opts.role ?? 'manager',
    userId: 'approver-1',
    enabledModules: new Set<ModuleId>(opts.modules ?? ['orders']),
  });
  holder.ctx = ctx;
  vi.mocked(withApiContext).mockResolvedValue(ctx as never);
  return stub;
}

function req(body: unknown, id = ORDER) {
  return new NextRequest(`http://localhost/api/v1/orders/${id}/needed-by`, {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'content-type': 'application/json', authorization: 'Bearer t' },
  });
}
const params = (id = ORDER) => Promise.resolve({ id });
const BODY = { neededByLocal: '2026-10-03T14:00', expectedNeededBy: SEEN, reason: 'The school moved the day' };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true, resetAt: 0 } as never);
});

describe('POST /api/v1/orders/[id]/needed-by', () => {
  it('200 with the revision: the instant converted in the org zone, and what happened to the Schedule entry', async () => {
    const stub = setup();
    const res = await POST(req(BODY), { params: params() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      revision: {
        changed: true,
        previous: '2026-10-01T21:00:00.000Z',
        neededBy: '2026-10-03T21:00:00.000Z',
        eventId: 'ev-1',
        eventUpdated: true,
        status: 'approved',
        schedule: 'moved',
        timeZone: LA,
      },
    });
    expect(stub.rpcCalls[0]?.args).toMatchObject({ p_id: ORDER, p_needed_by: '2026-10-03T21:00:00.000Z', p_expected_needed_by: SEEN });
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
  });

  it('400 for a bad order id or body, before anything is read', async () => {
    const stub = setup();
    expect((await POST(req(BODY, 'nope'), { params: params('nope') })).status).toBe(400);
    for (const bad of [
      'not json',
      { ...BODY, neededByLocal: '' },
      { ...BODY, expectedNeededBy: 'yesterday' },
      { neededByLocal: BODY.neededByLocal, reason: 'r' },
      { ...BODY, reason: 7 },
    ]) {
      const res = await POST(req(bad), { params: params() });
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    expect(stub.rpcCalls).toEqual([]);
  });

  const HINTS: Array<[string, QueryResult['error'], number, string, string, Record<string, unknown>]> = [
    ['unauthenticated', { message: 'unauthenticated', code: '42501' }, 401, 'unauthenticated', NEEDED_BY_SIGN_IN_COPY, { reason: 'forbidden' }],
    ['not found', { message: 'order_request_not_found', code: 'P0002' }, 404, 'not_found', NEEDED_BY_NOT_FOUND_COPY, { reason: 'not_found' }],
    ['module off', { message: 'module_disabled', code: 'P0001', hint: 'module_disabled' }, 403, 'module_disabled', NEEDED_BY_MODULE_OFF_COPY, { reason: 'module_disabled' }],
    ['not an approver', { message: 'forbidden', code: '42501', hint: 'orders_approve' }, 403, 'forbidden', NEEDED_BY_NOT_APPROVER_COPY, { reason: 'forbidden' }],
    ['no warehouse write', { message: 'forbidden', code: '42501', hint: 'warehouse_write' }, 403, 'forbidden', NEEDED_BY_NO_WAREHOUSE_ACCESS_COPY, { reason: 'forbidden' }],
    ['closed', { message: 'order_closed', code: 'P0001', hint: 'order_closed', details: 'completed' }, 409, 'conflict', NEEDED_BY_CLOSED_COPY, { reason: 'order_closed', status: 'completed' }],
    ['in the past', { message: 'needed_by_in_past', code: '22023', hint: 'needed_by_in_past' }, 400, 'validation_error', NEEDED_BY_IN_PAST_COPY, { reason: 'needed_by_in_past' }],
    ['null', { message: 'needed_by_required', code: '22023', hint: 'needed_by_required' }, 400, 'validation_error', neededByInvalidTimeCopy(LA), { reason: 'invalid_time' }],
    ['reason', { message: 'reason_required', code: '22023', hint: 'reason_required' }, 400, 'validation_error', NEEDED_BY_REASON_REQUIRED_COPY, { reason: 'reason_required' }],
    [
      'stale',
      { message: 'needed_by_changed', code: 'P0001', hint: 'needed_by_changed', details: '2026-10-05T21:00:00+00:00' },
      409,
      'conflict',
      neededByChangedCopy('2026-10-05T21:00:00.000Z', LA),
      { reason: 'needed_by_changed', current: '2026-10-05T21:00:00.000Z' },
    ],
    ['lock timeout', { message: 'canceling statement due to lock timeout', code: '55P03' }, 409, 'conflict', NEEDED_BY_BUSY_COPY, { reason: 'busy', retryable: true }],
    ['statement timeout', { message: 'canceling statement due to statement timeout', code: '57014' }, 409, 'conflict', NEEDED_BY_BUSY_COPY, { reason: 'busy', retryable: true }],
    ['anything else', { message: 'permission denied for function revise_order_needed_by', code: '42501' }, 500, 'internal_error', NEEDED_BY_FAILED_COPY, { reason: 'failed' }],
  ];

  it.each(HINTS)('maps %s', async (_label, error, status, code, message, details) => {
    setup({ rpc: { data: null, error } });
    const res = await POST(req(BODY), { params: params() });
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: code, message, details });
  });

  it('a throw that is not a ServiceError is a 500 in core\'s words, reported', async () => {
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
    expect(await res.json()).toEqual({ error: 'internal_error', message: NEEDED_BY_FAILED_COPY, details: { reason: 'failed' } });
    expect(reportError).toHaveBeenCalled();
  });

  it('a staff member without orders:approve is refused before the function', async () => {
    const stub = setup({ role: 'staff' });
    const res = await POST(req(BODY), { params: params() });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'forbidden', message: NEEDED_BY_NOT_APPROVER_COPY });
    expect(stub.rpcCalls).toEqual([]);
  });
});

describe('the phone and the web send the same instant for the same wall clock', () => {
  it.each([
    ['America/Los_Angeles', '2026-11-01T14:00', '2026-11-01T22:00:00.000Z'],
    ['America/Los_Angeles', '2026-10-31T14:00', '2026-10-31T21:00:00.000Z'],
    ['America/New_York', '2027-01-15T13:00', '2027-01-15T18:00:00.000Z'],
  ])('%s %s', async (timezone, local, instant) => {
    const phone = setup({ timezone });
    await POST(req({ ...BODY, neededByLocal: local }), { params: params() });
    const web = setup({ timezone });
    const res = await reviseOrderNeededByAction({ id: ORDER, ...BODY, neededByLocal: local });
    expect(res.ok).toBe(true);
    const sent = [phone, web].map((s) => (s.rpcCalls[0]?.args as { p_needed_by: string }).p_needed_by);
    expect(sent).toEqual([instant, instant]);
  });
});

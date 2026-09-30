import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_MODULE_IDS, type ModuleId } from '@stockpilot/core';

import { makeSupabaseStub } from '@/test/supabase-mock';

/**
 * POST /api/v1/exceptions/[id]/confirm-count (count differences R2, 0386)
 * runs the REAL ExceptionOccurrencesService over a stubbed client, so every
 * status below is the service's own answer through the exceptions routes' one
 * error shape. withApiContext is the one cookie-or-Bearer resolver.
 */

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn() }));
const limiter = vi.hoisted(() => ({ allowed: true, calls: [] as unknown[][] }));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async (...args: unknown[]) => {
    limiter.calls.push(args);
    return { allowed: limiter.allowed, count: 1, resetAt: Date.now() + 5_000 };
  }),
}));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }));
vi.mock('@/lib/auth/warehouse', () => {
  class ForbiddenError extends Error {}
  return {
    ForbiddenError,
    getWarehouseAccess: vi.fn(async () => ({ hasAllAccess: false, readableIds: ['wh-a'], writableIds: ['wh-a'] })),
    assertWarehouseAccess: vi.fn(async (wh: string, op: string, ctx: { role: string }) => {
      if (op === 'write' && ctx.role === 'viewer') throw new ForbiddenError('viewer');
      if (wh !== 'wh-a') throw new ForbiddenError('no write');
    }),
  };
});

import { withApiContext } from '@/lib/auth/api-context';
import { audit } from '@/server/services/audit';

import { POST as CONFIRM } from './[id]/confirm-count/route';

const OCC = '11111111-1111-4111-8111-111111111111';
const CC = '22222222-2222-4222-8222-222222222222';

const SYNC_ROW = {
  tracking_started_at: '2026-09-24T15:00:00Z',
  last_evaluated_at: '2026-09-29T18:00:00Z',
  last_synced_at: '2026-09-29T18:00:02Z',
  complete_rules: ['count_variance'],
  failed_rules: [],
  truncated_rules: [],
};

function cvRow(o: Record<string, unknown> = {}) {
  return {
    id: OCC,
    occurrence_number: 59,
    rule: 'count_variance',
    item_id: 'item-1',
    location_id: null,
    warehouse_id: 'wh-a',
    facts: { itemName: 'Umbrella', cycleCountId: CC, countNumber: 35, expected: 100, counted: 2, variance: -98 },
    condition_since: null,
    first_seen_at: '2026-09-29T17:01:00Z',
    last_seen_at: '2026-09-29T18:00:00Z',
    acknowledged_at: null,
    acknowledged_by: null,
    recount_cycle_count_id: null,
    resolved_at: null,
    resolved_reason: null,
    previous_occurrence_id: null,
    recurrence_index: 0,
    item: { name: 'Umbrella', sku: 'U1', warehouse_id: 'wh-a' },
    location: null,
    recount: null,
    acknowledger: null,
    ...o,
  };
}

function ctxWith(
  opts: {
    rpc?: { data: unknown; error: { message: string; code?: string; hint?: string } | null };
    row?: unknown;
    role?: 'owner' | 'manager' | 'staff' | 'viewer';
    permissions?: string[];
  } = {},
) {
  const stub = makeSupabaseStub({
    'exception_occurrences.select.maybeSingle': { data: opts.row === undefined ? cvRow() : opts.row, error: null },
    'exception_sync_state.select.maybeSingle': { data: SYNC_ROW, error: null },
    'rpc:exception_confirm_count': opts.rpc ?? {
      data: { occurrenceId: OCC, replay: false, confirmedAs: 'counter' },
      error: null,
    },
  });
  const ctx = {
    organizationId: 'org-1',
    userId: 'u-1',
    role: opts.role ?? 'staff',
    ...(opts.permissions ? { permissions: new Set(opts.permissions) } : {}),
    supabase: stub.client as never,
    mfaRequired: false,
    mfaSatisfied: true,
    enabledModules: new Set<ModuleId>(DEFAULT_MODULE_IDS),
  };
  vi.mocked(withApiContext).mockResolvedValueOnce(ctx as never);
  return stub;
}

const bearer = (url: string, init: RequestInit = {}) =>
  new Request(url, { ...init, headers: { authorization: 'Bearer token-1', ...(init.headers ?? {}) } }) as never;
const cookie = (url: string, init: RequestInit = {}) =>
  new Request(url, { ...init, headers: { cookie: 'sb-x-auth-token=abc', ...(init.headers ?? {}) } }) as never;
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (make: typeof bearer, body: unknown, id = OCC) =>
  make(`https://t.local/api/v1/exceptions/${id}/confirm-count`, {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
const BODY = { cycleCountId: CC, countedQuantity: 2, note: 'counted twice' };

beforeEach(() => {
  vi.clearAllMocks();
  limiter.allowed = true;
  limiter.calls = [];
});

describe('POST /api/v1/exceptions/[id]/confirm-count', () => {
  it('confirms (cookie or Bearer): 200 with the occurrence and replay, the request handed to withApiContext', async () => {
    for (const make of [bearer, cookie]) {
      const stub = ctxWith();
      const request = post(make, BODY);
      const res = await CONFIRM(request, params(OCC));
      expect(res.status).toBe(200);
      expect(vi.mocked(withApiContext).mock.lastCall?.[0]).toBe(request);
      const body = await res.json();
      expect(body.replay).toBe(false);
      expect(body.occurrence).toMatchObject({ id: OCC, reference: 'EX-000059', rule: 'count_variance' });
      expect(stub.rpcCalls).toEqual([
        {
          name: 'exception_confirm_count',
          args: { p_id: OCC, p_cycle_count_id: CC, p_counted_quantity: 2, p_note: 'counted twice' },
        },
      ]);
    }
  });

  it('a resend answered as a replay is 200 with replay true and no second audit row', async () => {
    ctxWith({ rpc: { data: { occurrenceId: OCC, replay: true, confirmedAs: 'counter' }, error: null } });
    const res = await CONFIRM(post(bearer, BODY), params(OCC));
    expect(res.status).toBe(200);
    expect((await res.json()).replay).toBe(true);
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  });

  it('the act bucket: exceptions-act:<user>, 60 a minute; a 429 carries a sentence and Retry-After', async () => {
    ctxWith();
    await CONFIRM(post(bearer, BODY), params(OCC));
    expect(limiter.calls[0]).toEqual(['exceptions-act:u-1', 60, 60_000]);

    ctxWith();
    limiter.allowed = false;
    const res = await CONFIRM(post(bearer, BODY), params(OCC));
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toMatch(/^\d+$/);
    expect(await res.json()).toMatchObject({ error: 'rate_limited', message: 'Too many requests. Wait a moment and try again.' });
  });

  it('401 without a session, before the limiter', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(null);
    const res = await CONFIRM(post(bearer, BODY), params(OCC));
    expect(res.status).toBe(401);
    expect(limiter.calls).toEqual([]);
  });

  it('400 for a malformed id, a body without the count or a finite number, and a body that is not JSON; no RPC', async () => {
    const bad: Array<[unknown, string]> = [
      [BODY, 'not-a-uuid'],
      [{ countedQuantity: 2 }, OCC],
      [{ cycleCountId: 'nope', countedQuantity: 2 }, OCC],
      [{ cycleCountId: CC, countedQuantity: '2' }, OCC],
      [{ cycleCountId: CC }, OCC],
      [{ cycleCountId: CC, countedQuantity: 2, note: 'x'.repeat(4001) }, OCC],
      ['{not json', OCC],
    ];
    for (const [body, id] of bad) {
      const stub = ctxWith();
      const res = await CONFIRM(post(bearer, body, id), params(id));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('validation_error');
      expect(stub.rpcCalls).toEqual([]);
    }
  });

  it('403 with reason not_counter or not_permitted from the RPC; 403 for a viewer before it', async () => {
    for (const hint of ['not_counter', 'not_permitted']) {
      ctxWith({ rpc: { data: null, error: { message: hint, code: '42501', hint } } });
      const res = await CONFIRM(post(bearer, BODY), params(OCC));
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: 'forbidden', details: { reason: hint } });
    }
    const stub = ctxWith({ role: 'viewer' });
    const res = await CONFIRM(post(bearer, BODY), params(OCC));
    expect(res.status).toBe(403);
    expect(stub.rpcCalls).toEqual([]);
  });

  it('404 when the row is not visible (the app gate) or the RPC says so', async () => {
    const hidden = ctxWith({ row: null });
    expect((await CONFIRM(post(bearer, BODY), params(OCC))).status).toBe(404);
    expect(hidden.rpcCalls).toEqual([]);
    ctxWith({ rpc: { data: null, error: { message: 'occurrence_not_found', code: 'P0002', hint: 'occurrence_not_found' } } });
    expect((await CONFIRM(post(bearer, BODY), params(OCC))).status).toBe(404);
  });

  it('409 with every reason the phone and the dialog word', async () => {
    const answers: Array<[{ message: string; code: string; hint?: string }, string]> = [
      ...['occurrence_resolved', 'count_changed', 'recount_in_progress', 'count_in_progress', 'not_countable', 'stock_moved', 'already_confirmed', 'not_confirmable'].map(
        (h): [{ message: string; code: string; hint?: string }, string] => [{ message: h, code: 'P0001', hint: h }, h],
      ),
      [{ message: 'canceling statement due to lock timeout', code: '55P03' }, 'busy'],
      [{ message: 'permission denied for function exception_confirm_count', code: '42501' }, 'unavailable'],
      [{ message: 'a later refusal', code: 'P0001', hint: 'a_later_reason' }, 'unknown'],
      [{ message: 'duplicate key', code: '23505' }, 'already_confirmed'],
    ];
    for (const [error, reason] of answers) {
      ctxWith({ rpc: { data: null, error } });
      const res = await CONFIRM(post(bearer, BODY), params(OCC));
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body).toMatchObject({ error: 'conflict', details: { reason } });
      expect(typeof body.message).toBe('string');
    }
  });

  it('an internal error is a 500 that never carries details or database text', async () => {
    ctxWith({ rpc: { data: null, error: { message: 'relation "secret_table" does not exist', code: '42P01' } } });
    const res = await CONFIRM(post(bearer, BODY), params(OCC));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('internal_error');
    expect(body.details).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('secret_table');
  });
});

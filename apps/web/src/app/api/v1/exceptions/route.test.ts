import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { makeSupabaseStub } from '@/test/supabase-mock';

/**
 * The /api/v1/exceptions routes (F1-1) run the REAL ExceptionOccurrencesService
 * over a stubbed client, so the status codes below are the service's own
 * refusals (403 without items:read, 404 when not visible, 409 when resolved),
 * not a re-implementation in the test. withApiContext is the one
 * cookie-or-Bearer resolver; each route must hand it the request.
 */

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, resetAt: Date.now() + 60_000 })),
}));
const createAdminClient = vi.hoisted(() => vi.fn());
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient }));
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
import { scheduleExceptionSync } from '@/server/services/lib/exception-sync-schedule';

import { POST as ACT } from './[id]/act/route';
import { GET as DETAIL } from './[id]/route';
import { POST as CHECK_NOW } from './check-now/route';
import { GET as LIST } from './route';

const OCC = '11111111-1111-4111-8111-111111111111';
const scheduled = vi.mocked(scheduleExceptionSync);

const SYNC_ROW = {
  tracking_started_at: '2026-09-24T15:00:00Z',
  last_evaluated_at: '2026-09-24T18:00:00Z',
  last_synced_at: '2026-09-24T18:00:02Z',
  complete_rules: ['over_reserved'],
  failed_rules: [],
  truncated_rules: [],
};

function occRow(o: Record<string, unknown> = {}) {
  return {
    id: OCC,
    occurrence_number: 42,
    rule: 'over_reserved',
    item_id: 'item-1',
    location_id: null,
    warehouse_id: 'wh-a',
    facts: { itemName: 'Atlas', sku: 'A1', promised: 14, onHand: 10 },
    condition_since: null,
    first_seen_at: '2026-09-24T15:00:00Z',
    last_seen_at: '2026-09-24T18:00:00Z',
    acknowledged_at: null,
    acknowledged_by: null,
    recount_cycle_count_id: null,
    resolved_at: null,
    resolved_reason: null,
    previous_occurrence_id: null,
    recurrence_index: 0,
    item: { name: 'Atlas', sku: 'A1' },
    location: null,
    recount: null,
    acknowledger: null,
    ...o,
  };
}

function ctxWith(
  results: Parameters<typeof makeSupabaseStub>[0],
  opts: { role?: 'owner' | 'manager' | 'staff' | 'viewer'; permissions?: string[] } = {},
) {
  const stub = makeSupabaseStub(results);
  const ctx = {
    organizationId: 'org-1',
    userId: 'u-1',
    role: opts.role ?? 'staff',
    ...(opts.permissions ? { permissions: new Set(opts.permissions) } : {}),
    supabase: stub.client as never,
    mfaRequired: false,
    mfaSatisfied: true,
    enabledModules: new Set<ModuleId>(),
  };
  vi.mocked(withApiContext).mockResolvedValueOnce(ctx as never);
  return stub;
}

const bearer = (url: string, init: RequestInit = {}) =>
  new Request(url, { ...init, headers: { authorization: 'Bearer token-1', ...(init.headers ?? {}) } }) as never;
const cookie = (url: string, init: RequestInit = {}) =>
  new Request(url, { ...init, headers: { cookie: 'sb-x-auth-token=abc', ...(init.headers ?? {}) } }) as never;
const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/v1/exceptions', () => {
  it('401 without a session and never reads', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(null);
    const res = await LIST(bearer('https://t.local/api/v1/exceptions'));
    expect(res.status).toBe(401);
  });

  it('serves a Bearer caller and a cookie caller alike, handing the request to withApiContext', async () => {
    for (const make of [bearer, cookie]) {
      ctxWith({
        'exception_occurrences.select': { data: [occRow()], error: null },
        'exception_sync_state.select.maybeSingle': { data: SYNC_ROW, error: null },
      });
      const request = make('https://t.local/api/v1/exceptions');
      const res = await LIST(request);
      expect(res.status).toBe(200);
      expect(vi.mocked(withApiContext).mock.lastCall?.[0]).toBe(request);
      expect(res.headers.get('cache-control')).toBe('private, no-store');
      const body = await res.json();
      expect(body).toMatchObject({ organizationId: 'org-1', status: 'open', truncated: false });
      expect(body.occurrences[0]).toMatchObject({ id: OCC, reference: 'EX-000042', rule: 'over_reserved' });
      expect(body.syncState.lastSyncedAt).toBe(SYNC_ROW.last_synced_at);
    }
  });

  // Mutation caught: syncing (or scheduling a sync) on a list read. Owner
  // decision F1 Q9: reads never sync, and never touch the service role.
  it('NEVER syncs: no service-role client, no schedule, no RPC', async () => {
    const stub = ctxWith({
      'exception_occurrences.select': { data: [], error: null },
      'exception_sync_state.select.maybeSingle': { data: null, error: null },
    });
    const res = await LIST(bearer('https://t.local/api/v1/exceptions'));
    expect(res.status).toBe(200);
    expect(createAdminClient).not.toHaveBeenCalled();
    expect(scheduled).not.toHaveBeenCalled();
    expect(stub.rpcCalls).toEqual([]);
    // Before the first check: syncState null, which the client must render as
    // "not checked yet", never as all clear.
    expect((await res.json()).syncState).toBeNull();
  });

  it('status=resolved reads the Resolved list', async () => {
    ctxWith({
      'exception_occurrences.select': { data: [], error: null },
      'exception_sync_state.select.maybeSingle': { data: SYNC_ROW, error: null },
    });
    const res = await LIST(bearer('https://t.local/api/v1/exceptions?status=resolved'));
    expect((await res.json()).status).toBe('resolved');
  });

  it('403 without items:read', async () => {
    ctxWith({}, { permissions: ['stock:adjust'] });
    const res = await LIST(bearer('https://t.local/api/v1/exceptions'));
    expect(res.status).toBe(403);
  });

  it('a failed read is a 500 with no list, never an empty 200', async () => {
    ctxWith({
      'exception_occurrences.select': { data: null, error: { message: 'relation does not exist' } },
      'exception_sync_state.select.maybeSingle': { data: SYNC_ROW, error: null },
    });
    const res = await LIST(bearer('https://t.local/api/v1/exceptions'));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.occurrences).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('relation does not exist');
  });
});

describe('GET /api/v1/exceptions/[id]', () => {
  const detailResults = (row: unknown) => ({
    'exception_occurrences.select.maybeSingle': { data: row, error: null },
    'exception_occurrences.select': { data: [{ id: OCC, occurrence_number: 42, first_seen_at: '2026-09-24T15:00:00Z', resolved_at: null, resolved_reason: null, recurrence_index: 0 }], error: null },
    'exception_occurrence_events.select': {
      data: [{ id: 'e1', kind: 'raised', actor_user_id: null, cycle_count_id: null, evidence_id: null, maintenance_request_id: null, note: null, created_at: '2026-09-24T15:00:00Z', actor: null, cycle_count: null }],
      error: null,
    },
    'exception_sync_state.select.maybeSingle': { data: SYNC_ROW, error: null },
  });

  it('returns the occurrence, timeline and history (cookie or Bearer)', async () => {
    for (const make of [bearer, cookie]) {
      ctxWith(detailResults(occRow()));
      const res = await DETAIL(make(`https://t.local/api/v1/exceptions/${OCC}`), params(OCC));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.occurrence.id).toBe(OCC);
      expect(body.timeline).toEqual([expect.objectContaining({ kind: 'raised', actor: null })]);
      expect(body.history).toEqual([expect.objectContaining({ id: OCC, isCurrent: true })]);
    }
  });

  it('404 when the occurrence is not visible to the caller', async () => {
    ctxWith(detailResults(null));
    const res = await DETAIL(bearer(`https://t.local/api/v1/exceptions/${OCC}`), params(OCC));
    expect(res.status).toBe(404);
  });

  it('403 without items:read', async () => {
    ctxWith(detailResults(occRow()), { permissions: [] });
    const res = await DETAIL(bearer(`https://t.local/api/v1/exceptions/${OCC}`), params(OCC));
    expect(res.status).toBe(403);
  });

  it('400 for a malformed id, before any read', async () => {
    const stub = ctxWith({});
    const res = await DETAIL(bearer('https://t.local/api/v1/exceptions/nope'), params('nope'));
    expect(res.status).toBe(400);
    expect(stub.fromCalls).toEqual([]);
  });

  it('never syncs', async () => {
    ctxWith(detailResults(occRow()));
    await DETAIL(bearer(`https://t.local/api/v1/exceptions/${OCC}`), params(OCC));
    expect(createAdminClient).not.toHaveBeenCalled();
    expect(scheduled).not.toHaveBeenCalled();
  });
});

describe('POST /api/v1/exceptions/[id]/act', () => {
  const post = (make: typeof bearer, body: unknown) =>
    make(`https://t.local/api/v1/exceptions/${OCC}/act`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    });
  const actResults = (opts: { row?: unknown; rpcError?: { message: string; code: string; hint?: string } } = {}) => ({
    'exception_occurrences.select.maybeSingle': { data: opts.row === undefined ? occRow() : opts.row, error: null },
    'exception_sync_state.select.maybeSingle': { data: SYNC_ROW, error: null },
    'rpc:exception_occurrence_act': opts.rpcError ? { data: null, error: opts.rpcError } : { data: occRow(), error: null },
  });

  it('acknowledges with a note (cookie or Bearer) and returns the occurrence', async () => {
    for (const make of [bearer, cookie]) {
      const stub = ctxWith(actResults());
      const res = await ACT(post(make, { action: 'acknowledge', note: 'checking rack', clientEventId: 'ev-1' }), params(OCC));
      expect(res.status).toBe(200);
      expect((await res.json()).occurrence.id).toBe(OCC);
      expect(stub.rpcCalls[0]).toEqual({
        name: 'exception_occurrence_act',
        args: { p_id: OCC, p_action: 'acknowledge', p_note: 'checking rack', p_client_event_id: 'ev-1' },
      });
    }
  });

  it('409 with reason occurrence_resolved when the occurrence is already resolved', async () => {
    ctxWith(actResults({ rpcError: { message: 'occurrence_resolved', code: 'P0001', hint: 'occurrence_resolved' } }));
    const res = await ACT(post(bearer, { action: 'note', note: 'late note' }), params(OCC));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'conflict', details: { reason: 'occurrence_resolved' } });
  });

  it('404 when the occurrence is not visible to the caller', async () => {
    const stub = ctxWith(actResults({ row: null }));
    const res = await ACT(post(bearer, { action: 'acknowledge' }), params(OCC));
    expect(res.status).toBe(404);
    expect(stub.rpcCalls).toEqual([]);
  });

  it('403 for a viewer (reads only), without calling the RPC', async () => {
    const stub = ctxWith(actResults(), { role: 'viewer' });
    const res = await ACT(post(bearer, { action: 'acknowledge' }), params(OCC));
    expect(res.status).toBe(403);
    expect(stub.rpcCalls).toEqual([]);
  });

  it('403 without items:read', async () => {
    ctxWith(actResults(), { permissions: ['stock:adjust'] });
    const res = await ACT(post(bearer, { action: 'acknowledge' }), params(OCC));
    expect(res.status).toBe(403);
  });

  it('403 when the RPC refuses (charter or warehouse write the app gate cannot see)', async () => {
    ctxWith(actResults({ rpcError: { message: 'forbidden', code: '42501' } }));
    const res = await ACT(post(bearer, { action: 'acknowledge' }), params(OCC));
    expect(res.status).toBe(403);
  });

  it('400 for an action that is not acknowledge or note — nobody resolves', async () => {
    const stub = ctxWith(actResults());
    const res = await ACT(post(bearer, { action: 'resolve' }), params(OCC));
    expect(res.status).toBe(400);
    expect(stub.rpcCalls).toEqual([]);
  });

  it('400 with reason note_required for an empty note', async () => {
    ctxWith(actResults());
    const res = await ACT(post(bearer, { action: 'note', note: '   ' }), params(OCC));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ details: { reason: 'note_required' } });
  });

  it('400 for a body that is not JSON', async () => {
    ctxWith(actResults());
    const res = await ACT(
      bearer(`https://t.local/api/v1/exceptions/${OCC}/act`, { method: 'POST', body: 'not json' }),
      params(OCC),
    );
    expect(res.status).toBe(400);
  });
});

describe('POST /api/v1/exceptions/check-now', () => {
  const post = (make: typeof bearer) => make('https://t.local/api/v1/exceptions/check-now', { method: 'POST' });

  it('202 at once for a manager: the sync is scheduled after the response, not run', async () => {
    ctxWith(
      { 'exception_sync_state.select.maybeSingle': { data: { ...SYNC_ROW, last_synced_at: new Date(Date.now() - 600_000).toISOString() }, error: null } },
      { role: 'manager' },
    );
    const res = await CHECK_NOW(post(cookie));
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ scheduled: true, retryAfterSeconds: 0 });
    expect(scheduled).toHaveBeenCalledWith('org-1', 'check_now');
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it('202 with scheduled false within a minute of the last check', async () => {
    ctxWith(
      { 'exception_sync_state.select.maybeSingle': { data: { ...SYNC_ROW, last_synced_at: new Date(Date.now() - 10_000).toISOString() }, error: null } },
      { role: 'manager' },
    );
    const res = await CHECK_NOW(post(bearer));
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ scheduled: false });
    expect(scheduled).not.toHaveBeenCalled();
  });

  it('403 for staff', async () => {
    ctxWith({ 'exception_sync_state.select.maybeSingle': { data: null, error: null } }, { role: 'staff' });
    const res = await CHECK_NOW(post(bearer));
    expect(res.status).toBe(403);
    expect(scheduled).not.toHaveBeenCalled();
  });
});

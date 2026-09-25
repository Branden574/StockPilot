import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

const reportError = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/lib/error-reporter', () => ({ reportError }));

const adminHolder = vi.hoisted(() => ({ client: null as unknown, throws: false }));
const createAdminClient = vi.hoisted(() =>
  vi.fn(() => {
    if (adminHolder.throws) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not configured');
    return adminHolder.client;
  }),
);
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient }));

// The per-org Check now claim: an in-memory stand-in for the
// rate_limit_buckets RPC (1 per window per key), or a limiter that fails.
const limiter = vi.hoisted(() => ({
  counts: new Map<string, number>(),
  fails: false,
  keys: [] as Array<{ key: string; limit: number; windowMs: number; mode: string | undefined }>,
}));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async (key: string, limit: number, windowMs: number, mode?: 'open' | 'closed') => {
    limiter.keys.push({ key, limit, windowMs, mode });
    const resetAt = Date.now() + windowMs;
    // The real helper in 'closed' mode answers "not allowed" when its RPC fails.
    if (limiter.fails) return { allowed: mode !== 'closed', count: limit, resetAt };
    const n = (limiter.counts.get(key) ?? 0) + 1;
    limiter.counts.set(key, n);
    return { allowed: n <= limit, count: n, resetAt };
  }),
}));

const access = vi.hoisted(() => ({
  value: { hasAllAccess: false, readableIds: ['wh-a'], writableIds: ['wh-a'] } as {
    hasAllAccess: boolean;
    readableIds: string[];
    writableIds: string[];
  },
}));
vi.mock('@/lib/auth/warehouse', () => {
  class ForbiddenError extends Error {
    readonly code = 'forbidden' as const;
  }
  return {
    ForbiddenError,
    getWarehouseAccess: vi.fn(async () => access.value),
    assertWarehouseAccess: vi.fn(async (wh: string, op: string, ctx: { role: string }) => {
      if (op === 'write' && ctx.role === 'viewer') throw new ForbiddenError('viewer');
      if (!access.value.hasAllAccess && !access.value.writableIds.includes(wh)) {
        throw new ForbiddenError('no write');
      }
    }),
  };
});

import {
  EXCEPTION_SYNC_THROTTLE_MS,
  ExceptionOccurrencesService,
} from './exception-occurrences';
import { scheduleExceptionSync } from './lib/exception-sync-schedule';

const ORG = 'org-1';
const OCC = '11111111-1111-4111-8111-111111111111';
const scheduled = vi.mocked(scheduleExceptionSync);

const SYNC_ROW = {
  tracking_started_at: '2026-09-24T15:00:00Z',
  last_evaluated_at: '2026-09-24T18:00:00Z',
  last_synced_at: '2026-09-24T18:00:02Z',
  complete_rules: ['over_reserved', 'label_mismatch', 'count_variance'],
  failed_rules: ['stale_staging'],
  truncated_rules: [],
};

function occRow(o: Record<string, unknown> = {}) {
  return {
    id: OCC,
    occurrence_number: 42,
    rule: 'label_mismatch',
    item_id: 'item-1',
    location_id: null,
    warehouse_id: 'wh-a',
    facts: { itemName: 'Atlas', sku: 'A1', label: '40-C', stockOn: ['39-C'] },
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
    item: { name: 'Atlas (live)', sku: 'A1' },
    location: null,
    recount: null,
    acknowledger: null,
    ...o,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  limiter.counts.clear();
  limiter.fails = false;
  limiter.keys = [];
  adminHolder.throws = false;
  adminHolder.client = null;
  access.value = { hasAllAccess: false, readableIds: ['wh-a'], writableIds: ['wh-a'] };
});

// ═══════════════════════════════════════════════════════════════════════════
// syncOrg
// ═══════════════════════════════════════════════════════════════════════════

describe('syncOrg — throttle, force, and never throwing', () => {
  function adminStub(opts: {
    lastSyncedAt?: string | null;
    stateError?: boolean;
    rpc?: { data: unknown; error: { message: string; code?: string; hint?: string } | null };
    actor?: boolean;
    membersError?: boolean;
  }) {
    const stub = makeSupabaseStub({
      'exception_sync_state.select.maybeSingle': opts.stateError
        ? { data: null, error: { message: 'state read failed' } }
        : {
            data: opts.lastSyncedAt ? { last_synced_at: opts.lastSyncedAt } : null,
            error: null,
          },
      'organization_members.select': opts.membersError
        ? { data: null, error: { message: 'members read timed out' } }
        : {
            data: opts.actor === false ? [] : [{ user_id: 'u-owner', role: 'owner' }],
            error: null,
          },
      'organization_modules.select': { data: [], error: null },
      'item_stock_levels.select': {
        data: [
          {
            id: 'isl-1',
            quantity: 3,
            positive_since: new Date(Date.now() - 10 * 86_400_000).toISOString(),
            item_id: 'item-9',
            location_id: 'loc-9',
            inventory_items: { name: 'Globe', sku: 'G1', bin_location: null },
            locations: { id: 'loc-9', name: 'Staging', kind: 'staging', warehouse_id: 'wh-a', deleted_at: null },
          },
        ],
        error: null,
      },
      'stock_reservations.select': { data: [], error: null },
      'rpc:exceptions_sync': opts.rpc ?? {
        data: { skipped: false, raised: 1, seen: 0, resolved: 0, recountsClosed: 0, dropped: 0 },
        error: null,
      },
    });
    adminHolder.client = stub.client;
    return stub;
  }

  const secondsAgo = (s: number) => new Date(Date.now() - s * 1000).toISOString();

  it('unforced, within a minute of the last sync: does nothing at all', async () => {
    const stub = adminStub({ lastSyncedAt: secondsAgo(30) });
    const out = await ExceptionOccurrencesService.syncOrg(ORG, { reason: 'cron' });
    expect(out.status).toBe('throttled');
    expect(stub.rpcCalls).toEqual([]);
    expect(stub.fromCalls).not.toContain('item_stock_levels');
  });

  it('unforced, a minute or more after the last sync: evaluates and applies', async () => {
    const stub = adminStub({ lastSyncedAt: secondsAgo(EXCEPTION_SYNC_THROTTLE_MS / 1000 + 1) });
    const out = await ExceptionOccurrencesService.syncOrg(ORG, { reason: 'cron' });
    expect(out).toEqual({
      status: 'applied',
      raised: 1,
      seen: 0,
      resolved: 0,
      recountsClosed: 0,
      dropped: 0,
      factsOmitted: 0,
    });
    // The evaluator's count read (_latest_count_lines), then the apply.
    expect(stub.rpcCalls.map((c) => c.name)).toEqual(['_latest_count_lines', 'exceptions_sync']);
  });

  it('unforced, never synced: runs', async () => {
    const stub = adminStub({ lastSyncedAt: null });
    await ExceptionOccurrencesService.syncOrg(ORG, { reason: 'cron' });
    expect(stub.rpcCalls.filter((c) => c.name === 'exceptions_sync')).toHaveLength(1);
  });

  it('forced: runs even seconds after the last sync, without reading the throttle', async () => {
    const stub = adminStub({ lastSyncedAt: secondsAgo(2) });
    const out = await ExceptionOccurrencesService.syncOrg(ORG, { force: true, reason: 'cycle_count.post' });
    expect(out.status).toBe('applied');
    expect(stub.fromCalls).not.toContain('exception_sync_state');
  });

  it('sends the whole evaluation to exceptions_sync, as the system, for this org only', async () => {
    const stub = adminStub({});
    await ExceptionOccurrencesService.syncOrg(ORG, { force: true, reason: 'check_now' });
    const args = stub.rpcCalls.find((c) => c.name === 'exceptions_sync')!.args as Record<string, unknown>;
    expect(args.p_org).toBe(ORG);
    expect(typeof args.p_evaluated_at).toBe('string');
    expect(args.p_complete_rules).toEqual([
      'orphaned_stock',
      'over_reserved',
      'stale_staging',
      'long_unplaced',
      'label_mismatch',
      'count_variance',
    ]);
    expect(args.p_failed_rules).toEqual([]);
    expect(args.p_truncated_rules).toEqual([]);
    expect(args.p_present).toEqual([
      expect.objectContaining({ rule: 'stale_staging', itemId: 'item-9', locationId: 'loc-9' }),
    ]);
    expect(args.p_hold).toEqual([]);
  });

  it('an RPC error is swallowed, reported as exceptions.sync_failed, and returned as failed', async () => {
    adminStub({ rpc: { data: null, error: { message: 'boom', code: 'P0001', hint: 'exceptions_sync_bad_payload' } } });
    const out = await ExceptionOccurrencesService.syncOrg(ORG, { force: true, reason: 'cron' });
    expect(out).toEqual({ status: 'failed' });
    expect(reportError).toHaveBeenCalledTimes(1);
    const [, ctx] = reportError.mock.calls[0] as unknown as [unknown, { tag: string; organizationId: string; extra: Record<string, unknown> }];
    expect(ctx.tag).toBe('exceptions.sync_failed');
    expect(ctx.organizationId).toBe(ORG);
    expect(ctx.extra).toMatchObject({ reason: 'cron', force: true });
  });

  it('a missing service-role key is reported, never thrown', async () => {
    adminHolder.throws = true;
    await expect(
      ExceptionOccurrencesService.syncOrg(ORG, { force: true, reason: 'cycle_count.cancel' }),
    ).resolves.toEqual({ status: 'failed' });
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it('a failed throttle read is reported, never thrown, and applies nothing', async () => {
    const stub = adminStub({ stateError: true });
    await expect(ExceptionOccurrencesService.syncOrg(ORG, { reason: 'cron' })).resolves.toEqual({
      status: 'failed',
    });
    expect(stub.rpcCalls).toEqual([]);
  });

  it('a lock held past lock_timeout (55P03) is "busy": the next run applies; not an error', async () => {
    adminStub({ rpc: { data: null, error: { message: 'lock timeout', code: '55P03' } } });
    const out = await ExceptionOccurrencesService.syncOrg(ORG, { force: true, reason: 'cron' });
    expect(out).toEqual({ status: 'busy' });
    expect(reportError).not.toHaveBeenCalled();
  });

  it('an evaluation older than the last applied one comes back as stale', async () => {
    adminStub({ rpc: { data: { skipped: true, lastEvaluatedAt: '2026-09-24T18:00:00Z' }, error: null } });
    const out = await ExceptionOccurrencesService.syncOrg(ORG, { force: true, reason: 'cron' });
    expect(out).toEqual({ status: 'stale' });
  });

  it('an org with no accepted owner or admin is skipped without a sync, and says so', async () => {
    const stub = adminStub({ actor: false });
    const out = await ExceptionOccurrencesService.syncOrg(ORG, { force: true, reason: 'cron' });
    expect(out).toEqual({ status: 'no_system_actor' });
    expect(stub.rpcCalls).toEqual([]);
    // Reported (a warning), not silent.
    const [, ctx] = reportError.mock.calls[0] as unknown as [unknown, { tag: string; level: string }];
    expect(ctx).toMatchObject({ tag: 'exceptions.sync_no_actor', level: 'warning' });
  });

  it('a FAILED members read is a reported failure, never "no system actor"', async () => {
    // The shared buildSystemContext ignores its read errors, so a transient
    // failure used to drop a post-count sync with no report at all.
    const stub = adminStub({ membersError: true });
    const out = await ExceptionOccurrencesService.syncOrg(ORG, { force: true, reason: 'cycle_count.post' });
    expect(out).toEqual({ status: 'failed' });
    expect(stub.rpcCalls).toEqual([]);
    const tags = reportError.mock.calls.map((c) => (c as unknown as [unknown, { tag: string }])[1].tag);
    expect(tags).toEqual(['exceptions.sync_failed']);
  });

  it('facts too large to store are applied empty, counted, and reported as a warning', async () => {
    adminStub({
      rpc: {
        data: { skipped: false, raised: 2, seen: 0, resolved: 0, recountsClosed: 0, dropped: 0, factsOmitted: 1 },
        error: null,
      },
    });
    const out = await ExceptionOccurrencesService.syncOrg(ORG, { force: true, reason: 'cron' });
    expect(out).toMatchObject({ status: 'applied', raised: 2, factsOmitted: 1 });
    const [, ctx] = reportError.mock.calls[0] as unknown as [unknown, { tag: string; level: string }];
    expect(ctx).toMatchObject({ tag: 'exceptions.facts_omitted', level: 'warning' });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Reads: through the person's own client, never syncing
// ═══════════════════════════════════════════════════════════════════════════

function userSvc(
  results: Parameters<typeof makeSupabaseStub>[0],
  role: 'owner' | 'admin' | 'manager' | 'staff' | 'viewer' = 'staff',
  permissions?: ReadonlySet<string>,
) {
  const stub = makeSupabaseStub(results);
  const ctx = makeServiceContext(stub.client, { organizationId: ORG, role, ...(permissions ? { permissions } : {}) });
  return { svc: new ExceptionOccurrencesService(ctx as never), stub };
}

describe('list', () => {
  it('reads occurrences and sync state through the caller’s client, and never syncs', async () => {
    const { svc, stub } = userSvc({
      'exception_occurrences.select': { data: [occRow()], error: null },
      'exception_sync_state.select.maybeSingle': { data: SYNC_ROW, error: null },
    });
    const res = await svc.list();
    expect(createAdminClient).not.toHaveBeenCalled();
    expect(scheduled).not.toHaveBeenCalled();
    expect(stub.rpcCalls).toEqual([]);
    expect(res.status).toBe('open');
    expect(res.truncated).toBe(false);
    expect(res.occurrences).toHaveLength(1);
    const o = res.occurrences[0]!;
    expect(o).toMatchObject({
      id: OCC,
      number: 42,
      reference: 'EX-000042',
      rule: 'label_mismatch',
      item: { name: 'Atlas (live)', sku: 'A1' },
      presentWhenTrackingBegan: true,
      canAct: true,
    });
    // Only this build's rules; the order is the display order.
    expect(res.syncState).toEqual({
      trackingStartedAt: SYNC_ROW.tracking_started_at,
      lastEvaluatedAt: SYNC_ROW.last_evaluated_at,
      lastSyncedAt: SYNC_ROW.last_synced_at,
      completeRules: ['over_reserved', 'label_mismatch', 'count_variance'],
      failedRules: ['stale_staging'],
      truncatedRules: [],
      unrecognizedUncheckedRules: 0,
    });
    expect(res.unrecognized).toBe(0);
    // Every read is scoped to the caller's org as well as RLS.
    const chain = stub.chainsAll.get('exception_occurrences.select')![0]!;
    const args = stub.chainArgsAll.get('exception_occurrences.select')![0]!;
    expect(args[chain.indexOf('eq')]).toEqual(['organization_id', ORG]);
    expect(args[chain.indexOf('is')]).toEqual(['resolved_at', null]);
  });

  it('the Resolved list reads the last 30 days only', async () => {
    const { svc, stub } = userSvc({
      'exception_occurrences.select': { data: [], error: null },
      'exception_sync_state.select.maybeSingle': { data: SYNC_ROW, error: null },
    });
    await svc.list({ status: 'resolved' });
    const chain = stub.chains.get('exception_occurrences.select')!;
    const args = stub.chainArgs.get('exception_occurrences.select')!;
    const [col, since] = args[chain.indexOf('gte')] as [string, string];
    expect(col).toBe('resolved_at');
    const days = (Date.now() - Date.parse(since)) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
  });

  it('before the first sync, syncState is null (the first check has not run)', async () => {
    const { svc } = userSvc({
      'exception_occurrences.select': { data: [], error: null },
      'exception_sync_state.select.maybeSingle': { data: null, error: null },
    });
    const res = await svc.list();
    expect(res.syncState).toBeNull();
    expect(res.occurrences).toEqual([]);
  });

  it('a failed read THROWS — it is never an empty list', async () => {
    const { svc } = userSvc({
      'exception_occurrences.select': { data: null, error: { message: 'timeout' } },
      'exception_sync_state.select.maybeSingle': { data: SYNC_ROW, error: null },
    });
    await expect(svc.list()).rejects.toMatchObject({ code: 'internal_error' });
  });

  it('a failed sync-state read throws too', async () => {
    const { svc } = userSvc({
      'exception_occurrences.select': { data: [], error: null },
      'exception_sync_state.select.maybeSingle': { data: null, error: { message: 'timeout' } },
    });
    await expect(svc.list()).rejects.toMatchObject({ code: 'internal_error' });
  });

  it('refuses a caller without items:read', async () => {
    const { svc, stub } = userSvc({}, 'staff', new Set(['stock:adjust']));
    await expect(svc.list()).rejects.toMatchObject({ code: 'forbidden' });
    expect(stub.fromCalls).toEqual([]);
  });

  it('a row with a rule this build does not know is left out, COUNTED and reported', async () => {
    // Counted so no surface shows the all-clear state while it is open (a
    // phone on an older bundle, or the web after a rollback, once F1-2 writes
    // count_variance rows, as it did before F1-2). Mutation caught: dropping
    // the rows uncounted.
    const { svc } = userSvc({
      'exception_occurrences.select': {
        data: [occRow(), occRow({ id: 'x', rule: 'a_future_rule' }), occRow({ id: 'y', rule: 'a_future_rule' })],
        error: null,
      },
      'exception_sync_state.select.maybeSingle': { data: SYNC_ROW, error: null },
    });
    const res = await svc.list();
    expect(res.occurrences.map((o) => o.id)).toEqual([OCC]);
    expect(res.unrecognized).toBe(2);
    const tags = reportError.mock.calls.map((c) => (c as unknown as [unknown, { tag: string }])[1].tag);
    expect(tags).toEqual(['exceptions.unknown_rule']);
  });

  it('a failed or truncated rule this build does not know counts as unchecked', async () => {
    const { svc } = userSvc({
      'exception_occurrences.select': { data: [], error: null },
      'exception_sync_state.select.maybeSingle': {
        data: { ...SYNC_ROW, failed_rules: ['a_future_rule', 'stale_staging'], truncated_rules: ['a_future_rule', 'x_rule'] },
        error: null,
      },
    });
    const res = await svc.list();
    expect(res.syncState).toMatchObject({ failedRules: ['stale_staging'], unrecognizedUncheckedRules: 2 });
  });

  it('carries the org time zone, read through the caller\'s client, with the shared fallback', async () => {
    const withZone = userSvc({
      'exception_occurrences.select': { data: [], error: null },
      'exception_sync_state.select.maybeSingle': { data: SYNC_ROW, error: null },
      'organizations.select.maybeSingle': { data: { timezone: 'America/New_York' }, error: null },
    });
    expect((await withZone.svc.list()).timeZone).toBe('America/New_York');
    expect(createAdminClient).not.toHaveBeenCalled();
    const failed = userSvc({
      'exception_occurrences.select': { data: [], error: null },
      'exception_sync_state.select.maybeSingle': { data: SYNC_ROW, error: null },
      'organizations.select.maybeSingle': { data: null, error: { message: 'timeout' } },
    });
    // Formatting only: a failed read never fails the list.
    expect((await failed.svc.list()).timeZone).toBe('America/Los_Angeles');
  });

  it('canAct mirrors the RPC gate: stock:adjust and write access, or a manager when there is no warehouse', async () => {
    const rows = [
      occRow({ id: 'a', warehouse_id: 'wh-a' }),
      occRow({ id: 'b', warehouse_id: 'wh-b' }),
      occRow({ id: 'c', warehouse_id: null }),
      occRow({ id: 'd', warehouse_id: 'wh-a', resolved_at: '2026-09-24T18:00:00Z', resolved_reason: 'cleared' }),
    ];
    const results = {
      'exception_occurrences.select': { data: rows, error: null },
      'exception_sync_state.select.maybeSingle': { data: SYNC_ROW, error: null },
    };
    const canAct = async (role: 'staff' | 'manager' | 'viewer') =>
      Object.fromEntries((await userSvc(results, role).svc.list()).occurrences.map((o) => [o.id, o.canAct]));

    expect(await canAct('staff')).toEqual({ a: true, b: false, c: false, d: false });
    access.value = { hasAllAccess: true, readableIds: [], writableIds: [] };
    expect(await canAct('manager')).toEqual({ a: true, b: true, c: true, d: false });
    expect(await canAct('viewer')).toEqual({ a: false, b: false, c: false, d: false });
  });

  it('only managers may check now', async () => {
    const results = {
      'exception_occurrences.select': { data: [], error: null },
      'exception_sync_state.select.maybeSingle': { data: SYNC_ROW, error: null },
    };
    expect((await userSvc(results, 'staff').svc.list()).canCheckNow).toBe(false);
    expect((await userSvc(results, 'manager').svc.list()).canCheckNow).toBe(true);
  });
});

describe('get', () => {
  it('not visible (or not found) is not_found, and nothing else is read into the answer', async () => {
    const { svc } = userSvc({
      'exception_occurrences.select.maybeSingle': { data: null, error: null },
      'exception_occurrence_events.select': { data: [], error: null },
      'exception_sync_state.select.maybeSingle': { data: SYNC_ROW, error: null },
    });
    await expect(svc.get(OCC)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('a malformed id is not_found without a query', async () => {
    const { svc, stub } = userSvc({});
    await expect(svc.get('not-a-uuid')).rejects.toMatchObject({ code: 'not_found' });
    expect(stub.fromCalls).toEqual([]);
  });

  it('returns the occurrence, its timeline oldest first, and the recurrence chain by identity', async () => {
    const { svc, stub } = userSvc({
      'exception_occurrences.select.maybeSingle': {
        data: occRow({ recurrence_index: 1, previous_occurrence_id: 'prev-1', acknowledged_at: '2026-09-24T18:05:00Z', acknowledged_by: 'u-1', acknowledger: { full_name: 'Dana Ruiz', email: 'd@x' } }),
        error: null,
      },
      'exception_occurrence_events.select': {
        data: [
          { id: 'e1', kind: 'raised', actor_user_id: null, cycle_count_id: null, evidence_id: null, maintenance_request_id: null, note: null, created_at: '2026-09-24T15:00:00Z', actor: null, cycle_count: null },
          { id: 'e2', kind: 'acknowledged', actor_user_id: 'u-1', cycle_count_id: null, evidence_id: null, maintenance_request_id: null, note: 'checking rack', created_at: '2026-09-24T18:05:00Z', actor: { full_name: 'Dana Ruiz', email: 'd@x' }, cycle_count: null },
          { id: 'e3', kind: 'note', actor_user_id: null, cycle_count_id: null, evidence_id: null, maintenance_request_id: null, note: 'from a deleted account', created_at: '2026-09-24T18:06:00Z', actor: null, cycle_count: null },
          { id: 'e4', kind: 'note', actor_user_id: 'u-gone', cycle_count_id: null, evidence_id: null, maintenance_request_id: null, note: 'left the org', created_at: '2026-09-24T18:07:00Z', actor: null, cycle_count: null },
        ],
        error: null,
      },
      'exception_occurrences.select': {
        data: [
          { id: OCC, occurrence_number: 42, first_seen_at: '2026-09-24T15:00:00Z', resolved_at: null, resolved_reason: null, recurrence_index: 1 },
          { id: 'prev-1', occurrence_number: 7, first_seen_at: '2026-09-01T15:00:00Z', resolved_at: '2026-09-10T15:00:00Z', resolved_reason: 'cleared', recurrence_index: 0 },
        ],
        error: null,
      },
      'exception_sync_state.select.maybeSingle': { data: SYNC_ROW, error: null },
    });
    const d = await svc.get(OCC);

    expect(d.occurrence.acknowledgedBy).toEqual({ id: 'u-1', label: 'Dana Ruiz' });
    expect(d.timeline.map((e) => [e.kind, e.actor?.label ?? 'system', e.note])).toEqual([
      ['raised', 'system', null],
      ['acknowledged', 'Dana Ruiz', 'checking rack'],
      ['note', 'Former member', 'from a deleted account'],
      ['note', 'Former member', 'left the org'],
    ]);
    expect(d.history).toEqual([
      expect.objectContaining({ id: OCC, reference: 'EX-000042', isCurrent: true }),
      expect.objectContaining({ id: 'prev-1', reference: 'EX-000007', resolvedReason: 'cleared', isCurrent: false }),
    ]);
    expect(d.historyTruncated).toBe(false);

    // The chain is read by identity; an item-level rule has NO location, and
    // `location_id = null` would match nothing, so it must be `is null`.
    const hChain = stub.chainsAll.get('exception_occurrences.select')!.at(-1)!;
    const hArgs = stub.chainArgsAll.get('exception_occurrences.select')!.at(-1)!;
    const eqs = hChain.flatMap((m, i) => (m === 'eq' ? [hArgs[i]] : []));
    expect(eqs).toEqual([
      ['organization_id', ORG],
      ['rule', 'label_mismatch'],
      ['item_id', 'item-1'],
    ]);
    expect(hArgs[hChain.indexOf('is')]).toEqual(['location_id', null]);
  });
});

describe('act', () => {
  function actSvc(
    opts: {
      row?: Record<string, unknown> | null;
      rpcError?: { message: string; code: string; hint?: string };
      role?: 'staff' | 'manager' | 'viewer';
    } = {},
  ) {
    return userSvc(
      {
        'exception_occurrences.select.maybeSingle': {
          data: opts.row === undefined ? occRow() : opts.row,
          error: null,
        },
        'exception_sync_state.select.maybeSingle': { data: SYNC_ROW, error: null },
        'rpc:exception_occurrence_act': opts.rpcError
          ? { data: null, error: opts.rpcError }
          : { data: occRow({ acknowledged_at: '2026-09-24T18:05:00Z' }), error: null },
      },
      opts.role ?? 'staff',
    );
  }

  it('acknowledges through the RPC with the trimmed note and client id, and returns the row', async () => {
    const { svc, stub } = actSvc();
    const o = await svc.act(OCC, { action: 'acknowledge', note: '  checking rack  ', clientEventId: ' ev-1 ' });
    expect(stub.rpcCalls).toEqual([
      {
        name: 'exception_occurrence_act',
        args: { p_id: OCC, p_action: 'acknowledge', p_note: 'checking rack', p_client_event_id: 'ev-1' },
      },
    ]);
    expect(o.id).toBe(OCC);
  });

  it('refuses a bad action, a missing note and an over-long note before the RPC', async () => {
    const { svc, stub } = actSvc();
    await expect(svc.act(OCC, { action: 'resolve' as never })).rejects.toMatchObject({ code: 'validation_error' });
    await expect(svc.act(OCC, { action: 'note', note: '   ' })).rejects.toMatchObject({
      code: 'validation_error',
      details: { reason: 'note_required' },
    });
    await expect(svc.act(OCC, { action: 'note', note: 'x'.repeat(1001) })).rejects.toMatchObject({
      details: { reason: 'note_too_long' },
    });
    expect(stub.rpcCalls).toEqual([]);
  });

  it('an occurrence the caller cannot see is not_found, without calling the RPC', async () => {
    const { svc, stub } = actSvc({ row: null });
    await expect(svc.act(OCC, { action: 'acknowledge' })).rejects.toMatchObject({ code: 'not_found' });
    expect(stub.rpcCalls).toEqual([]);
  });

  it('a viewer is refused (no stock:adjust) without calling the RPC', async () => {
    const { svc, stub } = actSvc({ role: 'viewer' });
    await expect(svc.act(OCC, { action: 'acknowledge' })).rejects.toMatchObject({ code: 'forbidden' });
    expect(stub.rpcCalls).toEqual([]);
  });

  it('staff without write access to the warehouse are refused (pattern #4: gate matches the RPC)', async () => {
    const { svc, stub } = actSvc({ row: occRow({ warehouse_id: 'wh-b' }) });
    await expect(svc.act(OCC, { action: 'acknowledge' })).rejects.toMatchObject({ code: 'forbidden' });
    expect(stub.rpcCalls).toEqual([]);
  });

  it('with no warehouse stamp, only a manager may act', async () => {
    const staff = actSvc({ row: occRow({ warehouse_id: null }) });
    await expect(staff.svc.act(OCC, { action: 'acknowledge' })).rejects.toMatchObject({ code: 'forbidden' });
    const manager = actSvc({ row: occRow({ warehouse_id: null }), role: 'manager' });
    await expect(manager.svc.act(OCC, { action: 'acknowledge' })).resolves.toMatchObject({ id: OCC });
  });

  it('maps the RPC refusals by SQLSTATE and hint', async () => {
    const cases: Array<[{ message: string; code: string; hint?: string }, string, string | undefined]> = [
      [{ message: 'occurrence_resolved', code: 'P0001', hint: 'occurrence_resolved' }, 'conflict', 'occurrence_resolved'],
      [{ message: 'client_event_id_conflict', code: 'P0001', hint: 'client_event_id_conflict' }, 'conflict', 'client_event_id_conflict'],
      [{ message: 'forbidden', code: '42501' }, 'forbidden', undefined],
      [{ message: 'occurrence_not_found', code: 'P0002' }, 'not_found', undefined],
      [{ message: 'note_required', code: '22023', hint: 'note_required' }, 'validation_error', 'note_required'],
      [{ message: 'canceling statement due to statement timeout', code: '57014' }, 'internal_error', undefined],
    ];
    for (const [rpcError, code, reason] of cases) {
      const { svc } = actSvc({ rpcError });
      const err = await svc.act(OCC, { action: 'acknowledge' }).catch((e: unknown) => e);
      expect(err).toMatchObject({ code });
      if (reason) expect(err).toMatchObject({ details: { reason } });
    }
  });
});

describe('requestCheck ("Check now")', () => {
  it('a manager schedules a forced sync after the response and gets an answer at once', async () => {
    const { svc } = userSvc(
      { 'exception_sync_state.select.maybeSingle': { data: { ...SYNC_ROW, last_synced_at: new Date(Date.now() - 5 * 60_000).toISOString() }, error: null } },
      'manager',
    );
    const res = await svc.requestCheck();
    expect(res.scheduled).toBe(true);
    expect(res.reason).toBeNull();
    expect(res.retryAfterSeconds).toBe(0);
    // Unforced: a sync that lands in between makes the task a no-op.
    expect(scheduled).toHaveBeenCalledWith(ORG, 'check_now', { force: false });
    // The claim is per ORG and fails closed.
    expect(limiter.keys).toEqual([
      { key: `exceptions-check-now:org:${ORG}`, limit: 1, windowMs: 60_000, mode: 'closed' },
    ]);
    // Scheduled, not run: nothing touched the service-role client here.
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it('within a minute of the last sync nothing is scheduled, and it says when to try again', async () => {
    const { svc } = userSvc(
      { 'exception_sync_state.select.maybeSingle': { data: { ...SYNC_ROW, last_synced_at: new Date(Date.now() - 20_000).toISOString() }, error: null } },
      'manager',
    );
    const res = await svc.requestCheck();
    expect(res.scheduled).toBe(false);
    expect(res.reason).toBe('recently_checked');
    expect(res.retryAfterSeconds).toBeGreaterThanOrEqual(39);
    expect(res.retryAfterSeconds).toBeLessThanOrEqual(41);
    expect(scheduled).not.toHaveBeenCalled();
  });

  it('two requests before the first check lands schedule exactly ONE sync', async () => {
    // "Checked at" only moves when a sync commits, so it cannot stop a second
    // click made while the first check runs. Mutation caught: no claim.
    const stale = { ...SYNC_ROW, last_synced_at: new Date(Date.now() - 10 * 60_000).toISOString() };
    const a = userSvc({ 'exception_sync_state.select.maybeSingle': { data: stale, error: null } }, 'manager');
    const b = userSvc({ 'exception_sync_state.select.maybeSingle': { data: stale, error: null } }, 'admin');
    const results = [await a.svc.requestCheck(), await b.svc.requestCheck(), await a.svc.requestCheck()];
    expect(results.map((r) => r.scheduled)).toEqual([true, false, false]);
    expect(results[1]).toMatchObject({ reason: 'already_requested' });
    expect(results[1]!.retryAfterSeconds).toBeGreaterThan(0);
    expect(scheduled).toHaveBeenCalledTimes(1);
  });

  it('a limiter that cannot answer starts no check (fails closed)', async () => {
    limiter.fails = true;
    const { svc } = userSvc({ 'exception_sync_state.select.maybeSingle': { data: null, error: null } }, 'manager');
    const res = await svc.requestCheck();
    expect(res).toMatchObject({ scheduled: false, reason: 'already_requested' });
    expect(scheduled).not.toHaveBeenCalled();
  });

  it('before the first sync, a manager can schedule one', async () => {
    const { svc } = userSvc({ 'exception_sync_state.select.maybeSingle': { data: null, error: null } }, 'manager');
    expect((await svc.requestCheck()).scheduled).toBe(true);
  });

  it('staff are refused', async () => {
    const { svc } = userSvc({ 'exception_sync_state.select.maybeSingle': { data: null, error: null } }, 'staff');
    await expect(svc.requestCheck()).rejects.toMatchObject({ code: 'forbidden' });
    expect(scheduled).not.toHaveBeenCalled();
  });
});

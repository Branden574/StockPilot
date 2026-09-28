import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Security invariant (F1-5): "Escalate to maintenance" saves ONE maintenance
 * request through MaintenanceRequestsService.create(), linked to the
 * occurrence, with the item and location taken from the occurrence ON THE
 * SERVER. The real service runs over stubbed clients; every RPC answer below
 * is one exception_escalation_claim / _finish really gives (0376).
 */

vi.mock('server-only', () => ({}));
const reportError = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/lib/error-reporter', () => ({ reportError }));
vi.mock('@/server/services/audit', () => ({ audit: vi.fn(async () => undefined) }));
const limiter = vi.hoisted(() => ({ allowed: true }));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: limiter.allowed, count: 1, resetAt: Date.now() + 60_000 })),
}));
const notify = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@/server/services/maintenance-notify', () => ({ notifyMaintenanceEvent: notify }));
vi.mock('@/server/services/maintenance-share-links', () => ({
  MaintenanceShareLinksService: class {},
  maintenanceShareLinksEnabled: vi.fn(async () => false),
}));
vi.mock('@/server/email/maintenance-resolved', () => ({ maybeSendMaintenanceResolvedEmail: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn(() => ({})) }));

import { DEFAULT_MODULE_IDS, type ModuleId } from '@stockpilot/core';

import { makeServiceContext, makeSupabaseStub, servedLikePostgrest, type MockCall, type QueryResult } from '@/test/supabase-mock';

import { ServiceError } from './context';
import { escalateBlock, ExceptionEscalationService } from './exception-escalation';

const ORG = 'org-test';
const OCC = '11111111-1111-4111-8111-111111111111';
const ITEM = '22222222-2222-4222-8222-222222222222';
const LOC = '33333333-3333-4333-8333-333333333333';
const REQ = '44444444-4444-4444-8444-444444444444';
const OTHER_REQ = '55555555-5555-4555-8555-555555555555';
const CLIENT_ITEM = '66666666-6666-4666-8666-666666666666';
const CLIENT_LOC = '77777777-7777-4777-8777-777777777777';

const WITH_MAINTENANCE = new Set<ModuleId>([...DEFAULT_MODULE_IDS, 'maintenance_requests']);

const BODY = {
  subject: 'Inventory issue: Chromebook charger (CB-65)',
  description: 'Sitting in Staging: 12 units in Staging for at least 9 days. Location: Staging. Ref EX-000042.',
  priority: 'normal',
  category: 'Inventory or equipment',
};

type RpcResult = QueryResult | ((call: MockCall) => QueryResult);

interface Setup {
  occurrence?: Record<string, unknown> | null;
  /** The occurrence as re-read after a failed finish (the lost-answer check). */
  occurrenceAfter?: Record<string, unknown> | null | 'error';
  claim?: RpcResult;
  /** finish's answer; an array answers the Nth send with its Nth entry (the
   *  last one repeats). */
  finish?: RpcResult | QueryResult[];
  release?: QueryResult;
  /** The insert's answer (create()). */
  insert?: QueryResult;
  /** The cancel's guarded update (cancel()). */
  cancelUpdate?: QueryResult;
  /** user_profiles as read for the claim's holder (and create()'s snapshot). */
  profile?: QueryResult;
  enabledModules?: Set<ModuleId>;
  permissions?: ReadonlySet<string>;
  role?: 'owner' | 'admin' | 'manager' | 'staff' | 'viewer';
}

function occRow(o: Record<string, unknown> = {}) {
  return {
    id: OCC,
    item_id: ITEM,
    location_id: LOC,
    resolved_at: null,
    maintenance_request_id: null,
    escalation_number: null,
    escalation_request_created_at: null,
    ...o,
  };
}

function build(s: Setup = {}) {
  let occurrenceReads = 0;
  let finishSends = 0;
  const stub = makeSupabaseStub({
    'exception_occurrences.select.maybeSingle': () => {
      occurrenceReads += 1;
      if (occurrenceReads > 1 && s.occurrenceAfter !== undefined) {
        if (s.occurrenceAfter === 'error') return { data: null, error: { message: 'read failed' } };
        return { data: s.occurrenceAfter, error: null };
      }
      return { data: s.occurrence === undefined ? occRow() : s.occurrence, error: null };
    },
    'rpc:exception_escalation_claim': s.claim ?? { data: { state: 'claimed', claimedAt: '2026-09-27T12:00:00Z' }, error: null },
    'rpc:exception_escalation_finish': (call: MockCall) => {
      const args = call.args[0]?.[0] as { p_request_id: string | null };
      if (args.p_request_id === null) return s.release ?? { data: { state: 'released' }, error: null };
      finishSends += 1;
      const f = s.finish ?? { data: { state: 'linked', id: REQ, number: 14, createdAt: '2026-09-27T12:00:01Z' }, error: null };
      if (Array.isArray(f)) return f[Math.min(finishSends - 1, f.length - 1)]!;
      return typeof f === 'function' ? f(call) : f;
    },
    // create(): the profile snapshot, the org checks on the related ids, the insert.
    'user_profiles.select': s.profile ?? { data: { full_name: 'Pat Lee', email: 'pat@example.test' }, error: null },
    'inventory_items.select': servedLikePostgrest([
      { id: ITEM, organization_id: ORG },
      { id: CLIENT_ITEM, organization_id: ORG },
    ]),
    'locations.select': servedLikePostgrest([
      { id: LOC, organization_id: ORG },
      { id: CLIENT_LOC, organization_id: ORG },
    ]),
    'maintenance_requests.insert.single': s.insert ?? {
      data: { id: REQ, request_number: 14, created_at: '2026-09-27T12:00:01Z' },
      error: null,
    },
    // cancel(): get() then the guarded update.
    'maintenance_requests.select.maybeSingle': {
      data: {
        id: REQ,
        request_number: 14,
        created_at: '2026-09-27T12:00:01Z',
        updated_at: '2026-09-27T12:00:01Z',
        subject: BODY.subject,
        description: BODY.description,
        status: 'saved',
        priority: 'normal',
        category: null,
        requester_user_id: 'user-test',
        requester_name_snapshot: 'Pat Lee',
        archived_at: null,
        cancelled_at: null,
        resolved_at: null,
        outlook_draft_open_count: 0,
        charters: null,
        maintenance_request_attachments: [{ count: 0 }],
      },
      error: null,
    },
    'maintenance_requests.update.maybeSingle': s.cancelUpdate ?? { data: { id: REQ }, error: null },
  });
  const ctx = makeServiceContext(stub.client, {
    role: s.role ?? 'staff',
    enabledModules: s.enabledModules ?? WITH_MAINTENANCE,
    ...(s.permissions ? { permissions: s.permissions } : {}),
  });
  // No pauses between finish's resends in tests.
  return { stub, ctx, svc: new ExceptionEscalationService(ctx, { finishBackoffMs: [0, 0] }) };
}

async function refusal(p: Promise<unknown>): Promise<ServiceError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ServiceError) return e;
    throw e;
  }
  throw new Error('expected a refusal');
}

const rpcNames = (stub: ReturnType<typeof build>['stub']) => stub.rpcCalls.map((c) => c.name);
const releases = (stub: ReturnType<typeof build>['stub']) =>
  stub.rpcCalls.filter(
    (c) => c.name === 'exception_escalation_finish' && (c.args as { p_request_id: unknown }).p_request_id === null,
  ).length;
const inserts = (stub: ReturnType<typeof build>['stub']) => stub.chainsAll.get('maintenance_requests.insert') ?? [];
const finishes = (stub: ReturnType<typeof build>['stub']) =>
  stub.rpcCalls.filter(
    (c) => c.name === 'exception_escalation_finish' && (c.args as { p_request_id: unknown }).p_request_id !== null,
  ).length;
const LINKED = { data: { state: 'linked', id: REQ, number: 14, createdAt: '2026-09-27T12:00:01Z' }, error: null };
const LOST = { data: null, error: { message: 'TypeError: fetch failed', code: '' } };
const BUSY = { data: null, error: { code: '55P03', message: 'canceling statement due to lock timeout' } };
const cancelled = (stub: ReturnType<typeof build>['stub']) =>
  (stub.chainArgsAll.get('maintenance_requests.update') ?? []).filter(
    (args) => (args[0]?.[0] as { status?: string } | undefined)?.status === 'cancelled',
  ).length;

beforeEach(() => {
  reportError.mockClear();
  notify.mockClear();
  limiter.allowed = true;
});

describe('the floors, before anything is read or claimed', () => {
  it('module off: module_disabled, and nothing is read, claimed or created', async () => {
    const { stub, svc } = build({ enabledModules: new Set<ModuleId>(DEFAULT_MODULE_IDS) });
    const e = await refusal(svc.escalate(OCC, BODY));
    expect(e.code).toBe('module_disabled');
    expect(stub.rpcCalls).toEqual([]);
    expect(stub.fromCalls).toEqual([]);
  });

  it('without maintenance_requests:submit: forbidden, nothing claimed', async () => {
    const { stub, svc } = build({ permissions: new Set(['items:read', 'stock:adjust']) });
    const e = await refusal(svc.escalate(OCC, BODY));
    expect(e.code).toBe('forbidden');
    expect(stub.rpcCalls).toEqual([]);
  });

  it('without items:read: forbidden, nothing claimed', async () => {
    const { stub, svc } = build({ permissions: new Set(['maintenance_requests:submit']) });
    const e = await refusal(svc.escalate(OCC, BODY));
    expect(e.code).toBe('forbidden');
    expect(stub.rpcCalls).toEqual([]);
  });

  it('a viewer holds submit by default and may escalate (module + submit, the plan\'s gate)', async () => {
    const { svc } = build({ role: 'viewer' });
    await expect(svc.escalate(OCC, BODY)).resolves.toMatchObject({ id: REQ });
  });

  it('escalateBlock names the same floors as a reason, for the occurrence read', () => {
    expect(escalateBlock(build({ enabledModules: new Set<ModuleId>(DEFAULT_MODULE_IDS) }).ctx)).toBe('module_disabled');
    expect(escalateBlock(build({ permissions: new Set(['items:read']) }).ctx)).toBe('not_permitted');
    expect(escalateBlock(build().ctx)).toBeNull();
  });

  it('a bad id is not found; a body that is not an object, or a subject the form refuses, is a validation error before any claim', async () => {
    const a = build();
    expect((await refusal(a.svc.escalate('nope', BODY))).code).toBe('not_found');
    const b = build();
    expect((await refusal(b.svc.escalate(OCC, 'subject'))).code).toBe('validation_error');
    const c = build();
    const e = await refusal(c.svc.escalate(OCC, { ...BODY, subject: 'abc' }));
    expect(e.code).toBe('validation_error');
    expect(e.message).toMatch(/at least 5 characters/);
    expect(c.stub.rpcCalls).toEqual([]);
    expect(inserts(c.stub)).toEqual([]);
  });
});

describe('the occurrence and the claim', () => {
  it('an occurrence the caller cannot see is not found, and nothing is claimed', async () => {
    const { stub, svc } = build({ occurrence: null });
    expect((await refusal(svc.escalate(OCC, BODY))).code).toBe('not_found');
    expect(stub.rpcCalls).toEqual([]);
    // The read is org-filtered (the admin client is never used here, but the
    // filter is the rule for every read).
    expect(stub.chainArgs.get('exception_occurrences.select')).toContainEqual(['organization_id', ORG]);
  });

  it('a resolved occurrence is refused before the claim', async () => {
    const { stub, svc } = build({ occurrence: occRow({ resolved_at: '2026-09-27T10:00:00Z' }) });
    const e = await refusal(svc.escalate(OCC, BODY));
    expect(e.code).toBe('conflict');
    expect(e.details?.reason).toBe('occurrence_resolved');
    expect(stub.rpcCalls).toEqual([]);
  });

  it('DUPLICATE: already linked to a request that is not cancelled -> 409 with its id, number and handle; nothing created', async () => {
    const { stub, svc } = build({
      claim: { data: { state: 'linked', id: OTHER_REQ, number: 9, createdAt: '2026-01-03T00:00:00Z' }, error: null },
    });
    const e = await refusal(svc.escalate(OCC, BODY));
    expect(e.code).toBe('conflict');
    expect(e.details).toEqual({
      reason: 'already_escalated',
      requestId: OTHER_REQ,
      requestNumber: 9,
      reference: 'MR-2026-000009',
    });
    expect(e.message).toBe('This exception is already escalated to MR-2026-000009. Opening that request.');
    expect(inserts(stub)).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
    expect(rpcNames(stub)).toEqual(['exception_escalation_claim']);
  });

  it('someone is escalating right now: 409 escalation_in_progress (retryable), nothing created', async () => {
    const { stub, svc } = build({
      claim: { data: null, error: { code: 'P0001', message: 'escalation_in_progress', hint: 'escalation_in_progress' } },
    });
    const e = await refusal(svc.escalate(OCC, BODY));
    expect(e.code).toBe('conflict');
    expect(e.details).toEqual({ reason: 'escalation_in_progress', retryable: true });
    expect(inserts(stub)).toEqual([]);
  });

  const HOLDER = '88888888-8888-4888-8888-888888888888';
  const inProgress = (detail: string) => ({
    data: null,
    error: { code: 'P0001', message: 'escalation_in_progress', hint: 'escalation_in_progress', details: detail },
  });

  it('HOLDER NAMED: the refusal names who is escalating (the claim\'s DETAIL), read under the reader\'s RLS', async () => {
    const { stub, svc } = build({
      claim: inProgress(HOLDER),
      profile: { data: { full_name: 'Sam Ortiz', email: 'sam@example.test' }, error: null },
    });
    const e = await refusal(svc.escalate(OCC, BODY));
    expect(e.message).toBe('Sam Ortiz is escalating this exception right now. Try again in a minute.');
    expect(e.details).toEqual({
      reason: 'escalation_in_progress',
      retryable: true,
      holder: { self: false, label: 'Sam Ortiz' },
    });
    expect(stub.chainArgs.get('user_profiles.select')).toContainEqual(['id', HOLDER]);
    expect(inserts(stub)).toEqual([]);
  });

  it('HOLDER IS ME: another tab or device of this person; no profile read', async () => {
    const { stub, svc } = build({ claim: inProgress('user-test') });
    // The stub context's user id is 'user-test' (not a uuid): a non-uuid
    // detail names nobody, so pin the self case with the real shape below.
    expect((await refusal(svc.escalate(OCC, BODY))).details).toEqual({ reason: 'escalation_in_progress', retryable: true });
    expect(stub.fromCalls).not.toContain('user_profiles');

    const me = build({ claim: inProgress(HOLDER) });
    (me.ctx as { userId: string }).userId = HOLDER.toUpperCase();
    const e = await refusal(me.svc.escalate(OCC, BODY));
    expect(e.message).toBe(
      'You are already escalating this exception, in another tab or on another device. Try again in a minute.',
    );
    expect(e.details).toEqual({ reason: 'escalation_in_progress', retryable: true, holder: { self: true } });
    expect(me.stub.fromCalls).not.toContain('user_profiles');
  });

  it('a holder whose profile cannot be read is named as nobody (a failed read is reported, never guessed)', async () => {
    const { svc } = build({ claim: inProgress(HOLDER), profile: { data: null, error: { message: 'boom' } } });
    const e = await refusal(svc.escalate(OCC, BODY));
    expect(e.message).toBe('This exception is being escalated right now. Try again in a minute.');
    expect(e.details).toEqual({ reason: 'escalation_in_progress', retryable: true, holder: { self: false, label: null } });
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tag: 'exceptions.escalate_holder_read' }),
    );
  });

  it('this person is escalating ANOTHER exception: 409 escalation_in_progress_elsewhere (retryable), nothing created', async () => {
    const { stub, svc } = build({
      claim: {
        data: null,
        error: { code: 'P0001', message: 'x', hint: 'escalation_in_progress_elsewhere' },
      },
    });
    const e = await refusal(svc.escalate(OCC, BODY));
    expect(e.code).toBe('conflict');
    expect(e.message).toBe('You are escalating another exception right now. Try again in a minute.');
    expect(e.details).toEqual({ reason: 'escalation_in_progress_elsewhere', retryable: true });
    expect(inserts(stub)).toEqual([]);
  });

  it('the database\'s gate answers are mapped by SQLSTATE and hint', async () => {
    const cases: Array<[Record<string, string>, string, unknown]> = [
      [{ code: '42501', hint: 'module_disabled' }, 'module_disabled', 'module_disabled'],
      [{ code: '42501', hint: 'not_permitted' }, 'forbidden', 'not_permitted'],
      [{ code: 'P0002' }, 'not_found', undefined],
      [{ code: 'P0001', hint: 'occurrence_resolved' }, 'conflict', 'occurrence_resolved'],
      [{ code: '55P03' }, 'conflict', 'busy'],
    ];
    for (const [err, code, reason] of cases) {
      const { svc } = build({ claim: { data: null, error: { message: 'x', ...err } } });
      const e = await refusal(svc.escalate(OCC, BODY));
      expect(e.code).toBe(code);
      expect(e.details?.reason).toBe(reason);
    }
  });
});

describe('the request', () => {
  it('CLIENT IDS IGNORED: the request names the occurrence\'s item and location, whatever the body sent', async () => {
    const { stub, svc } = build();
    const res = await svc.escalate(OCC, {
      ...BODY,
      relatedItemId: CLIENT_ITEM,
      relatedLocationId: CLIENT_LOC,
      itemId: CLIENT_ITEM,
      locationId: CLIENT_LOC,
      warehouseId: CLIENT_LOC,
      charterId: CLIENT_LOC,
    });
    expect(res).toEqual({ id: REQ, requestNumber: 14, reference: 'MR-2026-000014', createdAt: '2026-09-27T12:00:01Z' });
    const insert = stub.chainArgsAll.get('maintenance_requests.insert')?.[0]?.[0]?.[0] as Record<string, unknown>;
    expect(insert.related_item_id).toBe(ITEM);
    expect(insert.related_location_id).toBe(LOC);
    expect(insert.warehouse_id).toBeNull();
    expect(insert.charter_id).toBeNull();
    expect(insert.requester_user_id).toBe('user-test');
    expect(insert.subject).toBe(BODY.subject);
  });

  it('an item-level occurrence (no location) saves a request with no location', async () => {
    const { stub, svc } = build({ occurrence: occRow({ location_id: null }) });
    await svc.escalate(OCC, { ...BODY, relatedLocationId: CLIENT_LOC });
    const insert = stub.chainArgsAll.get('maintenance_requests.insert')?.[0]?.[0]?.[0] as Record<string, unknown>;
    expect(insert.related_location_id).toBeNull();
  });

  it('the order: claim, create, finish with the created request; exactly one request; the create path notifies exactly as the form does', async () => {
    const { stub, svc } = build();
    await svc.escalate(OCC, BODY);
    expect(rpcNames(stub)).toEqual(['exception_escalation_claim', 'exception_escalation_finish']);
    expect(stub.rpcCalls[1]?.args).toEqual({ p_id: OCC, p_request_id: REQ });
    expect(inserts(stub)).toHaveLength(1);
    // create()'s own new_request notification, once, and no other kind.
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ event: 'new_request', requestId: REQ }));
  });

  it('never acknowledges or resolves: no act RPC, and no write to the occurrence from the app', async () => {
    const { stub, svc } = build();
    await svc.escalate(OCC, BODY);
    expect(rpcNames(stub)).not.toContain('exception_occurrence_act');
    expect(stub.chainsAll.get('exception_occurrences.update')).toBeUndefined();
  });
});

describe('when something fails after the claim', () => {
  it('create refused (the maintenance rate limit): the claim is released, nothing to cancel, the refusal stands', async () => {
    limiter.allowed = false;
    const { stub, svc } = build();
    const e = await refusal(svc.escalate(OCC, BODY));
    expect(e.code).toBe('conflict');
    expect(e.message).toMatch(/Too many maintenance requests/);
    expect(releases(stub)).toBe(1);
    expect(inserts(stub)).toEqual([]);
    expect(cancelled(stub)).toBe(0);
  });

  it('create\'s insert refused by the database (a SQLSTATE): nothing was saved, so the claim is released', async () => {
    const { stub, svc } = build({ insert: { data: null, error: { code: '42501', message: 'rls' } } });
    expect((await refusal(svc.escalate(OCC, BODY))).code).toBe('internal_error');
    expect(releases(stub)).toBe(1);
    expect(finishes(stub)).toBe(0);
  });

  it('CREATE\'S ANSWER LOST (no SQLSTATE): the request may exist, so the claim is KEPT (a retry cannot save a second one), reported, nothing cancelled', async () => {
    const { stub, svc } = build({ insert: LOST });
    const e = await refusal(svc.escalate(OCC, BODY));
    expect(e.code).toBe('internal_error');
    expect(releases(stub)).toBe(0);
    expect(finishes(stub)).toBe(0);
    expect(cancelled(stub)).toBe(0);
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tag: 'exceptions.escalate_unconfirmed', extra: expect.objectContaining({ stage: 'create' }) }),
    );
  });

  it('finish refused and the request cancelled: release, cancel as its requester, and the message says it was cancelled', async () => {
    const { stub, svc } = build({
      finish: { data: null, error: { code: 'P0001', message: 'escalation_not_claimed', hint: 'escalation_not_claimed' } },
    });
    const e = await refusal(svc.escalate(OCC, BODY));
    expect(e.code).toBe('conflict');
    expect(e.details).toEqual({
      reason: 'escalation_not_claimed',
      savedRequest: { id: REQ, reference: 'MR-2026-000014', cancelled: true },
    });
    expect(e.message).toBe(
      'The exception changed while it was being escalated. Reload and try again. The request saved for it (MR-2026-000014) was cancelled.',
    );
    expect(releases(stub)).toBe(1);
    expect(cancelled(stub)).toBe(1);
    // A definite refusal is final: sent once, never re-read.
    expect(finishes(stub)).toBe(1);
    // The guarded cancel: only an open request is cancelled.
    const update = (stub.chainArgsAll.get('maintenance_requests.update') ?? [])[0] ?? [];
    expect(update).toContainEqual(['id', REQ]);
    expect(update).toContainEqual(['cancelled_at', null]);
  });

  it('MODULE OFF MEANWHILE: finish refuses, and the cancel is refused too (the update policy needs the module): reported as an orphan, and the message says it could NOT be cancelled', async () => {
    const { svc } = build({
      finish: { data: null, error: { code: '42501', message: 'escalation_not_allowed', hint: 'module_disabled' } },
      // maintenance_requests_update WITH CHECK module_enabled (0314): the
      // real answer to the requester's cancel once the module is off.
      cancelUpdate: { data: null, error: { code: '42501', message: 'new row violates row-level security policy for table "maintenance_requests"' } },
    });
    const e = await refusal(svc.escalate(OCC, BODY));
    expect(e.code).toBe('module_disabled');
    expect(e.details).toEqual({
      reason: 'module_disabled',
      savedRequest: { id: REQ, reference: 'MR-2026-000014', cancelled: false },
    });
    expect(e.message).toBe(
      'Maintenance requests are not turned on for this organization. The request saved for it (MR-2026-000014) is not linked to this exception and could not be cancelled. Check your maintenance requests.',
    );
    expect(reportError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tag: 'exceptions.escalate_orphan_request', extra: { occurrenceId: OCC, requestId: REQ } }),
    );
  });

  it('a cancel that throws is never claimed as cancelled', async () => {
    const { svc } = build({
      finish: { data: null, error: { code: 'P0001', message: 'x', hint: 'request_not_eligible' } },
      cancelUpdate: { data: null, error: { message: 'fetch failed' } },
    });
    const e = await refusal(svc.escalate(OCC, BODY));
    expect(e.message).not.toMatch(/was cancelled/);
    expect(e.message).toMatch(/could not be cancelled/);
    expect(e.details?.savedRequest).toEqual({ id: REQ, reference: 'MR-2026-000014', cancelled: false });
  });

  it('BUSY ONCE: finish answers 55P03 and then links: sent again, a success; nothing released or cancelled', async () => {
    const { stub, svc } = build({ finish: [BUSY, LINKED] });
    await expect(svc.escalate(OCC, BODY)).resolves.toMatchObject({ id: REQ, reference: 'MR-2026-000014' });
    expect(finishes(stub)).toBe(2);
    expect(releases(stub)).toBe(0);
    expect(cancelled(stub)).toBe(0);
  });

  it('BUSY EVERY TIME: after the resends, busy (retryable): released, the request cancelled, and the message says so', async () => {
    const { stub, svc } = build({ finish: [BUSY] });
    const e = await refusal(svc.escalate(OCC, BODY));
    expect(finishes(stub)).toBe(3);
    expect(e.code).toBe('conflict');
    expect(e.details).toEqual({
      reason: 'busy',
      retryable: true,
      savedRequest: { id: REQ, reference: 'MR-2026-000014', cancelled: true },
    });
    expect(e.message).toBe(
      'This exception is busy. Try again in a moment. The request saved for it (MR-2026-000014) was cancelled.',
    );
    expect(releases(stub)).toBe(1);
    expect(cancelled(stub)).toBe(1);
  });

  it('A LOST ANSWER, RESENT: the resend answers linked (the replay of a link that landed): a success, never cancelled or released', async () => {
    const { stub, svc } = build({ finish: [LOST, LINKED] });
    await expect(svc.escalate(OCC, BODY)).resolves.toMatchObject({ id: REQ });
    expect(finishes(stub)).toBe(2);
    expect(cancelled(stub)).toBe(0);
    expect(releases(stub)).toBe(0);
  });

  it('REVERSE RACE: an answer lost while its link was still being written, then a lock wait: never released or cancelled (the link may land); reported as unconfirmed', async () => {
    // The first send is still holding the row (its answer lost); the resends
    // wait past lock_timeout. The re-read sees no link YET.
    const { stub, svc } = build({ finish: [LOST, BUSY, BUSY], occurrenceAfter: occRow() });
    const e = await refusal(svc.escalate(OCC, BODY));
    expect(e.code).toBe('internal_error');
    expect(releases(stub)).toBe(0);
    expect(cancelled(stub)).toBe(0);
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tag: 'exceptions.escalate_unconfirmed', extra: expect.objectContaining({ stage: 'finish' }) }),
    );
  });

  it('a lost answer, then a definite refusal: the resend saw the row without the link, so it is final: release and cancel', async () => {
    const { stub, svc } = build({
      finish: [LOST, { data: null, error: { code: 'P0001', message: 'x', hint: 'occurrence_resolved' } }],
    });
    const e = await refusal(svc.escalate(OCC, BODY));
    expect(e.details?.reason).toBe('occurrence_resolved');
    expect(e.details?.savedRequest).toEqual({ id: REQ, reference: 'MR-2026-000014', cancelled: true });
    expect(releases(stub)).toBe(1);
    expect(cancelled(stub)).toBe(1);
  });

  it('EVERY ANSWER LOST, but the occurrence links the request: success, never cancelled', async () => {
    const { stub, svc } = build({
      finish: [LOST],
      occurrenceAfter: occRow({ maintenance_request_id: REQ, escalation_number: 14 }),
    });
    await expect(svc.escalate(OCC, BODY)).resolves.toMatchObject({ id: REQ, reference: 'MR-2026-000014' });
    expect(finishes(stub)).toBe(3);
    expect(cancelled(stub)).toBe(0);
    expect(releases(stub)).toBe(0);
  });

  it('UNKNOWN: every answer lost and the re-read failed too: the request is left as saved (it may be linked), the claim kept, reported', async () => {
    const { stub, svc } = build({ finish: [LOST], occurrenceAfter: 'error' });
    expect((await refusal(svc.escalate(OCC, BODY))).code).toBe('internal_error');
    expect(cancelled(stub)).toBe(0);
    expect(releases(stub)).toBe(0);
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tag: 'exceptions.escalate_unconfirmed' }),
    );
  });

  it('a release that fails is reported and never hides the real refusal', async () => {
    limiter.allowed = false;
    const { svc } = build({ release: { data: null, error: { message: 'down' } } });
    const e = await refusal(svc.escalate(OCC, BODY));
    expect(e.message).toMatch(/Too many maintenance requests/);
    expect(reportError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tag: 'exceptions.escalate_release_failed' }),
    );
  });

  it('a refusal this build does not name, after the request was saved: said as "could not be linked" with what became of the request, and reported', async () => {
    const { stub, svc } = build({ finish: { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } } });
    const e = await refusal(svc.escalate(OCC, BODY));
    expect(e.code).toBe('conflict');
    expect(e.message).toBe(
      'The request could not be linked to this exception. The request saved for it (MR-2026-000014) was cancelled.',
    );
    expect(e.details).toEqual({
      reason: 'not_linked',
      savedRequest: { id: REQ, reference: 'MR-2026-000014', cancelled: true },
    });
    expect(cancelled(stub)).toBe(1);
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tag: 'exceptions.escalate_finish_failed' }),
    );
  });

  it('finish answers linked to a DIFFERENT request than the one created: not a success; the created one is cancelled', async () => {
    const { stub, svc } = build({
      finish: { data: { state: 'linked', id: OTHER_REQ, number: 9, createdAt: '2026-01-03T00:00:00Z' }, error: null },
      occurrenceAfter: occRow({ maintenance_request_id: OTHER_REQ, escalation_number: 9 }),
    });
    await refusal(svc.escalate(OCC, BODY));
    expect(cancelled(stub)).toBe(1);
  });
});

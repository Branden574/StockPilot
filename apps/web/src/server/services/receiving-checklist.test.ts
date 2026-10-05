import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  makeServiceContext,
  makeSupabaseStub,
  servedLikePostgrest,
  type MockCall,
  type QueryResult,
} from '@/test/supabase-mock';

import {
  CASE_TABLE_STEPS,
  RECEIVE_POST_MANAGER_ONLY_COPY,
  RECEIVING_CHECKLIST_COPY,
  ROLE_PERMISSIONS,
  type ModuleId,
  type PostReceiptInput,
} from '@stockpilot/core';

const reportError = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/lib/error-reporter', () => ({ reportError }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }));

import { audit } from './audit';
import { ServiceError } from './context';
import { ReceivingService } from './receiving';
import { mapChecklistError, ReceivingChecklistService } from './receiving-checklist';

/**
 * ReceivingChecklistService (F4-1): the gate order before every write
 * (module, permission with the MFA step-up, core receivingGate, then the RPC),
 * every refusal mapped by SQLSTATE and hint, one audit row per write that
 * changed something, reads that never throw into the PO page and never read a
 * failure as "none", and ReceivingService.postReceipt's manager floor.
 */

const auditMock = vi.mocked(audit);
const ORG = 'org-test';
const RUN = '11111111-1111-4111-8111-111111111111';
const RCPT = '22222222-2222-4222-8222-222222222222';
const PO = '33333333-3333-4333-8333-333333333333';
const VER = '44444444-4444-4444-8444-444444444444';
const WH = '55555555-5555-4555-8555-555555555555';
const MODULES = new Set<ModuleId>(['receiving', 'purchase_orders', 'procedures'] as ModuleId[]);

const STORED_STEPS = CASE_TABLE_STEPS.map((s) => ({ ...s }));

function ctxFor(
  client: unknown,
  o: {
    role?: 'owner' | 'admin' | 'manager' | 'staff' | 'viewer';
    permissions?: string[];
    modules?: ModuleId[];
    mfa?: boolean;
  } = {},
) {
  const role = o.role ?? 'manager';
  return makeServiceContext(client, {
    organizationId: ORG,
    role,
    permissions: new Set(o.permissions ?? [...ROLE_PERMISSIONS[role]]),
    enabledModules: o.modules ? new Set(o.modules) : MODULES,
    mfaRequired: o.mfa ?? false,
    mfaSatisfied: !(o.mfa ?? false),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── mapChecklistError: every arm (pattern #28) ─────────────────────────────
describe('mapChecklistError', () => {
  const m = (code: string, hint?: string, details?: string) =>
    mapChecklistError(
      { code, message: 'db text', hint: hint ?? null, details: details ?? null },
      STORED_STEPS,
    );

  it.each([
    ['42501', 'not_authenticated', 'unauthenticated', undefined],
    ['42501', 'not_recorder', 'forbidden', 'not_recorder'],
    ['42501', 'not_publisher', 'forbidden', 'not_publisher'],
    ['42501', 'not_member', 'forbidden', 'not_member'],
    ['42501', undefined, 'forbidden', 'not_member'],
    ['P0001', 'module_disabled', 'module_disabled', 'module_disabled'],
    ['P0001', 'checklist_changed', 'conflict', 'checklist_changed'],
    ['P0001', 'no_checklist', 'conflict', 'no_checklist'],
    ['P0001', 'receipt_not_checkable', 'conflict', 'receipt_not_checkable'],
    ['P0001', 'checklist_run_changed', 'conflict', 'checklist_run_changed'],
    ['P0001', 'checklist_run_completed', 'conflict', 'checklist_run_completed'],
    ['P0001', 'something_new', 'conflict', 'unknown'],
    ['55P03', undefined, 'conflict', 'busy'],
    ['57014', undefined, 'conflict', 'busy'],
  ])('%s %s -> %s (%s)', (code, hint, expectedCode, reason) => {
    const e = m(code, hint);
    expect(e.code).toBe(expectedCode);
    if (reason) expect((e.details as { reason?: string }).reason).toBe(reason);
    expect(e.message).not.toContain('db text');
  });

  it('the conflicts say what the plan says', () => {
    expect(m('P0001', 'checklist_run_changed').message).toBe(RECEIVING_CHECKLIST_COPY.runChanged);
    expect(m('P0001', 'no_checklist').message).toBe(RECEIVING_CHECKLIST_COPY.noChecklist);
    expect(m('P0001', 'receipt_not_checkable').message).toBe(
      RECEIVING_CHECKLIST_COPY.receiptNotCheckable,
    );
    expect(m('P0001', 'checklist_changed').message).toBe(RECEIVING_CHECKLIST_COPY.publishChanged);
    expect((m('55P03').details as { retryable?: boolean }).retryable).toBe(true);
  });

  it('P0002 is not found, worded by its hint', () => {
    expect(m('P0002', 'receipt_not_found')).toMatchObject({
      code: 'not_found',
      message: RECEIVING_CHECKLIST_COPY.receiptNotFound,
    });
    expect(m('P0002', 'checklist_run_not_found')).toMatchObject({
      code: 'not_found',
      message: RECEIVING_CHECKLIST_COPY.runNotFound,
    });
  });

  it('checklist_invalid names the step or key from our own allow-list', () => {
    const e = m(
      '22023',
      'checklist_invalid',
      '{"step": 3, "field": "steps", "reason": "label_too_long"}',
    );
    expect(e.code).toBe('validation_error');
    expect(e.message).toBe('Step 3: the label can be up to 120 characters.');
    expect(e.details).toEqual({
      reason: 'checklist_invalid',
      invalid: 'label_too_long',
      field: 'steps',
      step: 3,
    });
    const k = m(
      '22023',
      'checklist_invalid',
      '{"key": "s3", "field": "results", "reason": "count_out_of_range"}',
    );
    expect(k.message).toBe('Number of boxes received: enter a number from 0 to 1,000,000.');
    expect(k.details).toMatchObject({ key: 's3', invalid: 'count_out_of_range' });
    const junk = m('22023', 'checklist_invalid', '<p>not json</p>');
    expect(junk).toMatchObject({
      code: 'validation_error',
      message: 'That checklist is not valid.',
    });
  });

  it("checklist_incomplete carries the keys of the run's own steps and names them", () => {
    const e = m(
      '22023',
      'checklist_incomplete',
      '{"missing": ["s1", "s9"], "failedWithoutNote": ["s2"], "photoStepsWithoutPhoto": []}',
    );
    expect(e.code).toBe('validation_error');
    expect(e.details).toEqual({
      reason: 'checklist_incomplete',
      missing: ['s1'],
      failedWithoutNote: ['s2'],
      photoStepsWithoutPhoto: [],
    });
    expect(e.message).toContain(
      'Answer every required step before completing: Packing slip matches this purchase order.',
    );
    expect(e.message).toContain('Add a note to each failed check: Boxes arrived undamaged.');
  });

  it('anything else is an internal error whose text stays on the server', () => {
    const e = m('23505');
    expect(e.code).toBe('internal_error');
    expect(e.message).not.toContain('db text');
    expect(e.internalDetail).toBe('db text');
  });
});

// ── The gates, in order, before every write ────────────────────────────────
describe('gate order', () => {
  const version = {
    id: VER,
    organization_id: ORG,
    version_number: 2,
    title: 'Delivery checks',
    steps: STORED_STEPS,
    procedure_id: null,
    published_at: new Date().toISOString(),
    published_by: 'user-test',
    retired_at: null,
    retired_by: null,
  };
  const stub = () =>
    makeSupabaseStub({
      'rpc:checklist_publish': { data: { version, created: true }, error: null },
      'rpc:checklist_retire': {
        data: { ...version, retired_at: new Date().toISOString() },
        error: null,
      },
      'rpc:receiving_check_start': {
        data: { runId: RUN, created: true, versionNumber: 2 },
        error: null,
      },
      'user_profiles.select': { data: [], error: null },
    });
  const publish = (svc: ReceivingChecklistService) =>
    svc.publish({ title: 'T', steps: [], expectedCurrentId: null, clientPublishId: RUN });

  it('the module comes first: receiving off refuses before any permission or RPC', async () => {
    const s = stub();
    const svc = new ReceivingChecklistService(
      ctxFor(s.client, { role: 'staff', modules: ['purchase_orders'] as ModuleId[] }),
    );
    await expect(publish(svc)).rejects.toMatchObject({ code: 'module_disabled' });
    await expect(svc.start(RCPT)).rejects.toMatchObject({ code: 'module_disabled' });
    expect(s.rpcCalls).toHaveLength(0);
  });

  it('then the permission, with the MFA step-up', async () => {
    const s = stub();
    const mfa = new ReceivingChecklistService(ctxFor(s.client, { mfa: true }));
    await expect(publish(mfa)).rejects.toMatchObject({
      code: 'forbidden',
      details: { reason: expect.stringMatching(/mfa|aal2/) },
    });
    const noManage = new ReceivingChecklistService(
      ctxFor(s.client, { permissions: ['purchase_orders:read', 'stock:adjust'] }),
    );
    await expect(publish(noManage)).rejects.toMatchObject({
      code: 'forbidden',
      message: 'Missing permission: purchase_orders:manage',
    });
    const noAdjust = new ReceivingChecklistService(
      ctxFor(s.client, { permissions: ['purchase_orders:read'] }),
    );
    await expect(noAdjust.start(RCPT)).rejects.toMatchObject({
      code: 'forbidden',
      message: 'Missing permission: stock:adjust',
    });
    expect(s.rpcCalls).toHaveLength(0);
  });

  // Mutation caught: the service gating on the permission alone. Staff hold
  // stock:adjust and a viewer can be granted purchase_orders:manage.
  it('then core receivingGate: below manager is refused even with the permission', async () => {
    const s = stub();
    const staff = new ReceivingChecklistService(ctxFor(s.client, { role: 'staff' }));
    await expect(staff.start(RCPT)).rejects.toMatchObject({
      code: 'forbidden',
      details: { reason: 'not_recorder' },
    });
    await expect(
      staff.saveRun({
        runId: RUN,
        results: {},
        expectedRevision: 0,
        saveId: RCPT,
        complete: false,
      }),
    ).rejects.toMatchObject({ details: { reason: 'not_recorder' } });
    const viewerManager = new ReceivingChecklistService(
      ctxFor(s.client, {
        role: 'viewer',
        permissions: ['purchase_orders:read', 'purchase_orders:manage'],
      }),
    );
    await expect(publish(viewerManager)).rejects.toMatchObject({
      code: 'forbidden',
      details: { reason: 'not_publisher' },
    });
    await expect(viewerManager.retire({ versionId: VER })).rejects.toMatchObject({
      details: { reason: 'not_publisher' },
    });
    expect(s.rpcCalls).toHaveLength(0);
  });

  it('then the RPC, with the organization and the arguments it names', async () => {
    const s = stub();
    const svc = new ReceivingChecklistService(ctxFor(s.client));
    await svc.publish({
      title: 'Delivery checks',
      steps: [{ kind: 'check', label: 'Slip' }],
      procedureId: null,
      expectedCurrentId: VER,
      clientPublishId: RUN,
    });
    expect(s.rpcCalls[0]).toEqual({
      name: 'checklist_publish',
      args: {
        p_org: ORG,
        p_binding: 'receiving',
        p_title: 'Delivery checks',
        p_steps: [{ kind: 'check', label: 'Slip' }],
        p_procedure_id: null,
        p_expected_current: VER,
        p_client_publish_id: RUN,
      },
    });
    await svc.start(RCPT);
    expect(s.rpcCalls[1]).toEqual({ name: 'receiving_check_start', args: { p_receipt_id: RCPT } });
  });
});

// ── One audit row per write that changed something ─────────────────────────
describe('audit', () => {
  const now = () => new Date().toISOString();
  const old = '2026-01-01T00:00:00Z';
  const versionAt = (publishedAt: string) => ({
    id: VER,
    organization_id: ORG,
    version_number: 3,
    title: 'Delivery checks',
    steps: STORED_STEPS,
    procedure_id: null,
    published_at: publishedAt,
    published_by: 'user-test',
    retired_at: null,
    retired_by: null,
  });
  const runAt = (completedAt: string | null) => ({
    id: RUN,
    organization_id: ORG,
    version_id: VER,
    receipt_id: RCPT,
    purchase_order_id: PO,
    warehouse_id: WH,
    status: completedAt ? 'completed' : 'in_progress',
    results: { s1: { value: 'fail', note: 'crushed' } },
    note: null,
    revision: 2,
    started_at: old,
    started_by: 'user-test',
    updated_at: now(),
    completed_at: completedAt,
    completed_by: completedAt ? 'user-test' : null,
  });

  // Desk check F9 (mutation caught: the old two-clock test). Whether a call
  // made the version is the database's answer: a real publish stamped by a
  // database clock well behind the web server is still audited, and a replay
  // answered at once is not.
  it('a publish is audited once; a replay of an earlier publish is not, whatever the clocks say', async () => {
    const fresh = makeSupabaseStub({
      'rpc:checklist_publish': { data: { version: versionAt(old), created: true }, error: null },
    });
    await new ReceivingChecklistService(ctxFor(fresh.client)).publish({
      title: 'T',
      steps: [],
      expectedCurrentId: null,
      clientPublishId: RUN,
    });
    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock.mock.calls[0]?.[0]).toMatchObject({
      event: 'receiving_checklist.published',
      entityType: 'checklist_version',
      entityId: VER,
      after: { versionNumber: 3, stepCount: 4 },
    });
    auditMock.mockClear();
    const replay = makeSupabaseStub({
      'rpc:checklist_publish': { data: { version: versionAt(now()), created: false }, error: null },
    });
    await new ReceivingChecklistService(ctxFor(replay.client)).publish({
      title: 'T',
      steps: [],
      expectedCurrentId: null,
      clientPublishId: RUN,
    });
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('a turn-off is audited', async () => {
    const s = makeSupabaseStub({
      'rpc:checklist_retire': { data: { ...versionAt(old), retired_at: now() }, error: null },
    });
    await new ReceivingChecklistService(ctxFor(s.client)).retire({ versionId: VER });
    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock.mock.calls[0]?.[0]).toMatchObject({
      event: 'receiving_checklist.retired',
      entityId: VER,
    });
  });

  it('a start is audited only when it made the run', async () => {
    const made = makeSupabaseStub({
      'rpc:receiving_check_start': {
        data: { runId: RUN, created: true, versionNumber: 3 },
        error: null,
      },
    });
    await new ReceivingChecklistService(ctxFor(made.client)).start(RCPT);
    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock.mock.calls[0]?.[0]).toMatchObject({
      event: 'receiving_check.started',
      entityId: RUN,
      after: { receiptId: RCPT },
    });
    auditMock.mockClear();
    const existing = makeSupabaseStub({
      'rpc:receiving_check_start': {
        data: { runId: RUN, created: false, versionNumber: 3 },
        error: null,
      },
    });
    const res = await new ReceivingChecklistService(ctxFor(existing.client)).start(RCPT);
    expect(res).toEqual({ runId: RUN, created: false, versionNumber: 3 });
    expect(auditMock).not.toHaveBeenCalled();
  });

  // Desk check F9: the same for a completion (saved, never a clock).
  it('a completion is audited with its failed checks; progress and a replayed completion are not, whatever the clocks say', async () => {
    const steps = {
      'checklist_runs.select': { data: [{ version_id: VER }], error: null },
      'checklist_versions.select': { data: [{ steps: STORED_STEPS }], error: null },
    };
    const done = makeSupabaseStub({
      'rpc:checklist_run_save': { data: { run: runAt(old), saved: true }, error: null },
      ...steps,
    });
    await new ReceivingChecklistService(ctxFor(done.client)).saveRun({
      runId: RUN,
      results: {},
      expectedRevision: 1,
      saveId: RCPT,
      complete: true,
    });
    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock.mock.calls[0]?.[0]).toMatchObject({
      event: 'receiving_check.completed',
      entityId: RUN,
      after: { failedChecks: 1 },
    });
    auditMock.mockClear();
    const progress = makeSupabaseStub({
      'rpc:checklist_run_save': { data: { run: runAt(null), saved: true }, error: null },
    });
    await new ReceivingChecklistService(ctxFor(progress.client)).saveRun({
      runId: RUN,
      results: {},
      expectedRevision: 1,
      saveId: RCPT,
      complete: false,
    });
    const replay = makeSupabaseStub({
      'rpc:checklist_run_save': { data: { run: runAt(now()), saved: false }, error: null },
      ...steps,
    });
    await new ReceivingChecklistService(ctxFor(replay.client)).saveRun({
      runId: RUN,
      results: {},
      expectedRevision: 1,
      saveId: RCPT,
      complete: true,
    });
    expect(auditMock).not.toHaveBeenCalled();
  });
});

describe('an answer without its row', () => {
  // The functions always answer the row; anything else is never read as a
  // write that happened (no audit row, no view built on nothing).
  it('publish and save answers missing the row are internal errors, with no audit row', async () => {
    const s = makeSupabaseStub({
      'rpc:checklist_publish': { data: { created: true }, error: null },
      'rpc:checklist_run_save': { data: { saved: true }, error: null },
    });
    const svc = new ReceivingChecklistService(ctxFor(s.client));
    await expect(
      svc.publish({ title: 'T', steps: [], expectedCurrentId: null, clientPublishId: RUN }),
    ).rejects.toMatchObject({ code: 'internal_error' });
    await expect(
      svc.saveRun({ runId: RUN, results: {}, expectedRevision: 0, saveId: RCPT, complete: true }),
    ).rejects.toMatchObject({ code: 'internal_error' });
    expect(auditMock).not.toHaveBeenCalled();
  });
});

describe('saveRun refusals', () => {
  it("an incomplete refusal is worded with the run's own step labels", async () => {
    const s = makeSupabaseStub({
      'rpc:checklist_run_save': {
        data: null,
        error: {
          code: '22023',
          message: 'checklist_incomplete',
          hint: 'checklist_incomplete',
          details: '{"missing": ["s1"], "failedWithoutNote": [], "photoStepsWithoutPhoto": []}',
        },
      },
      'checklist_runs.select': { data: [{ version_id: VER }], error: null },
      'checklist_versions.select': { data: [{ steps: STORED_STEPS }], error: null },
    });
    const err = await new ReceivingChecklistService(ctxFor(s.client))
      .saveRun({ runId: RUN, results: {}, expectedRevision: 1, saveId: RCPT, complete: true })
      .catch((e: unknown) => e as ServiceError);
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).message).toBe(
      'Answer every required step before completing: Packing slip matches this purchase order.',
    );
    expect((err as ServiceError).details).toMatchObject({
      reason: 'checklist_incomplete',
      missing: ['s1'],
    });
  });

  it('a completed run names who completed it', async () => {
    const s = makeSupabaseStub({
      'rpc:checklist_run_save': {
        data: null,
        error: {
          code: 'P0001',
          message: 'checklist_run_completed',
          hint: 'checklist_run_completed',
        },
      },
      'checklist_runs.select': {
        data: [{ completed_by: 'u-pat', deleted_users: null }],
        error: null,
      },
      'user_profiles.select': {
        data: [{ id: 'u-pat', full_name: 'Pat Lee', email: 'pat@test.local' }],
        error: null,
      },
    });
    await expect(
      new ReceivingChecklistService(ctxFor(s.client)).saveRun({
        runId: RUN,
        results: {},
        expectedRevision: 1,
        saveId: RCPT,
        complete: false,
      }),
    ).rejects.toMatchObject({
      code: 'conflict',
      message: RECEIVING_CHECKLIST_COPY.runCompletedBy('Pat Lee'),
      details: { reason: 'checklist_run_completed' },
    });
  });
});

// ── Reads ──────────────────────────────────────────────────────────────────
describe('forPurchaseOrder never throws, and a failure is never "none"', () => {
  const versions = [
    {
      id: VER,
      version_number: 1,
      title: 'T',
      steps: STORED_STEPS,
      published_at: '2026-10-01T00:00:00Z',
      retired_at: null,
    },
  ];
  const runs = [
    {
      id: RUN,
      organization_id: ORG,
      version_id: VER,
      receipt_id: RCPT,
      purchase_order_id: PO,
      warehouse_id: WH,
      status: 'in_progress',
      results: { s1: { value: 'pass' } },
      note: null,
      revision: 1,
      started_at: '2026-10-02T00:00:00Z',
      started_by: 'u-1',
      updated_at: '2026-10-02T00:00:00Z',
      completed_at: null,
      completed_by: null,
      deleted_users: null,
    },
  ];

  it('answers the versions and the runs, with names', async () => {
    const s = makeSupabaseStub({
      'checklist_versions.select': { data: versions, error: null },
      'checklist_runs.select': servedLikePostgrest(runs),
      'user_profiles.select': {
        data: [{ id: 'u-1', full_name: 'Pat Lee', email: null }],
        error: null,
      },
    });
    const res = await new ReceivingChecklistService(ctxFor(s.client)).forPurchaseOrder(PO);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.versions).toEqual([
      {
        id: VER,
        versionNumber: 1,
        title: 'T',
        steps: STORED_STEPS,
        publishedAt: '2026-10-01T00:00:00Z',
        retiredAt: null,
      },
    ]);
    expect(res.runs[0]).toMatchObject({
      id: RUN,
      receiptId: RCPT,
      status: 'in_progress',
      startedByName: 'Pat Lee',
      results: { s1: { value: 'pass' } },
    });
  });

  it.each([
    [
      'the versions read fails',
      {
        'checklist_versions.select': { data: null, error: { message: 'x' } },
        'checklist_runs.select': { data: runs, error: null },
      },
    ],
    [
      'the runs read fails',
      {
        'checklist_versions.select': { data: versions, error: null },
        'checklist_runs.select': { data: null, error: { message: 'x' } },
      },
    ],
  ])('%s: ok false, reported', async (_l, results) => {
    const s = makeSupabaseStub(results as Record<string, QueryResult>);
    await expect(
      new ReceivingChecklistService(ctxFor(s.client)).forPurchaseOrder(PO),
    ).resolves.toEqual({ ok: false });
    expect(reportError).toHaveBeenCalled();
  });

  it('a thrown read is caught too', async () => {
    const client = {
      from: () => {
        throw new Error('boom');
      },
    };
    await expect(
      new ReceivingChecklistService(ctxFor(client)).forPurchaseOrder(PO),
    ).resolves.toEqual({ ok: false });
  });

  it('a failed name lookup still answers, with "—" for the names', async () => {
    const s = makeSupabaseStub({
      'checklist_versions.select': { data: versions, error: null },
      'checklist_runs.select': { data: runs, error: null },
      'user_profiles.select': { data: null, error: { message: 'names down' } },
    });
    const res = await new ReceivingChecklistService(ctxFor(s.client)).forPurchaseOrder(PO);
    expect(res.ok && res.runs[0]?.startedByName).toBe('—');
  });

  it('a starter who deleted their account reads "Deleted user"', async () => {
    const s = makeSupabaseStub({
      'checklist_versions.select': { data: versions, error: null },
      'checklist_runs.select': {
        data: [
          { ...runs[0], started_by: null, deleted_users: { started_by: '2026-10-03T00:00:00Z' } },
        ],
        error: null,
      },
    });
    const res = await new ReceivingChecklistService(ctxFor(s.client)).forPurchaseOrder(PO);
    expect(res.ok && res.runs[0]?.startedByName).toBe('Deleted user');
  });
});

describe('getRun', () => {
  const run = {
    id: RUN,
    organization_id: ORG,
    version_id: VER,
    receipt_id: RCPT,
    purchase_order_id: PO,
    warehouse_id: WH,
    status: 'in_progress',
    results: {},
    note: null,
    revision: 0,
    started_at: '2026-10-02T00:00:00Z',
    started_by: 'u-1',
    updated_at: '2026-10-02T00:00:00Z',
    completed_at: null,
    completed_by: null,
    deleted_users: null,
  };
  const version = {
    id: VER,
    organization_id: ORG,
    version_number: 1,
    title: 'T',
    steps: STORED_STEPS,
    procedure_id: null,
    published_at: '2026-10-01T00:00:00Z',
    published_by: 'u-1',
    retired_at: null,
    retired_by: null,
  };
  type Served = Record<string, QueryResult | ((call: MockCall) => QueryResult)>;
  const base = (over: Served = {}) =>
    makeSupabaseStub({
      'checklist_runs.select': { data: [run], error: null },
      'checklist_versions.select': { data: [version], error: null },
      'receipts.select': (call) =>
        call.methods.includes('limit')
          ? { data: [], error: null }
          : {
              data: [
                {
                  id: RCPT,
                  receipt_number: 'R-1',
                  status: 'posted',
                  received_at: '2026-10-01T12:00:00Z',
                },
              ],
              error: null,
            },
      'purchase_orders.select': {
        data: [{ id: PO, po_number: 'PO-1', supplier_id: null, charter_id: null }],
        error: null,
      },
      'warehouses.select': { data: [{ name: 'Main' }], error: null },
      'receipt_lines.select': servedLikePostgrest([
        { id: 'l1', receipt_id: RCPT, item_id: 'i1', qty_received_base: 2, qty_accepted_base: 2 },
        { id: 'l2', receipt_id: RCPT, item_id: 'i2', qty_received_base: 3, qty_accepted_base: 3 },
      ]),
      'inventory_items.select': servedLikePostgrest([
        { id: 'i1', name: 'Shirt', sku: 'S1', charter_id: null },
        { id: 'i2', name: 'Cap', sku: 'C1', charter_id: null },
      ]),
      'purchase_order_items.select': servedLikePostgrest([
        { id: 'p1', purchase_order_id: PO, quantity_ordered: 10, quantity_received: 2 },
        { id: 'p2', purchase_order_id: PO, quantity_ordered: 3, quantity_received: 3 },
      ]),
      'user_profiles.select': {
        data: [{ id: 'u-1', full_name: 'Pat Lee', email: null }],
        error: null,
      },
      'organizations.select': { data: [{ timezone: 'America/New_York' }], error: null },
      ...over,
    });

  it('builds the run, the receipt and "About this delivery"', async () => {
    const view = await new ReceivingChecklistService(ctxFor(base().client)).getRun(RUN);
    expect(view.about).toEqual({
      unitsReceived: 5,
      lineCount: 2,
      warehouseName: 'Main',
      stockOwner: { kind: 'ok', value: [] },
      billTo: { kind: 'ok', value: null },
      stillToCome: { kind: 'ok', value: 1 },
    });
    expect(view.run.startedByName).toBe('Pat Lee');
    expect(view.timeZone).toBe('America/New_York');
    expect(view.canRecord).toBe(true);
    expect(view.receipt.reversedAt).toBeNull();
  });

  // pattern #28 / refresh c11: a short item read has no error, so "none set"
  // may never come from an empty or partial answer.
  it('fewer items than lines reads "didn\'t load", never "none set"', async () => {
    const s = base({
      'inventory_items.select': servedLikePostgrest([
        { id: 'i1', name: 'Shirt', sku: 'S1', charter_id: null },
      ]),
    });
    const view = await new ReceivingChecklistService(ctxFor(s.client)).getRun(RUN);
    expect(view.about.stockOwner).toEqual({ kind: 'unavailable' });
  });

  it.each([
    [
      'the items read fails',
      { 'inventory_items.select': { data: null, error: { message: 'x' } } },
      'stockOwner',
    ],
    [
      'the still-to-come read fails',
      { 'purchase_order_items.select': { data: null, error: { message: 'x' } } },
      'stillToCome',
    ],
  ])('%s: unavailable', async (_l, over, field) => {
    const view = await new ReceivingChecklistService(ctxFor(base(over as Served).client)).getRun(
      RUN,
    );
    expect(view.about[field as 'stockOwner' | 'stillToCome']).toEqual({ kind: 'unavailable' });
  });

  it('a charter read that fails is "didn\'t load", for the stock owner and the bill-to', async () => {
    const s = base({
      'inventory_items.select': servedLikePostgrest([
        { id: 'i1', name: 'Shirt', sku: 'S1', charter_id: 'ch1' },
        { id: 'i2', name: 'Cap', sku: 'C1', charter_id: null },
      ]),
      'purchase_orders.select': {
        data: [{ id: PO, po_number: 'PO-1', supplier_id: null, charter_id: 'ch2' }],
        error: null,
      },
      'charters.select': { data: null, error: { message: 'x' } },
    });
    const view = await new ReceivingChecklistService(ctxFor(s.client)).getRun(RUN);
    expect(view.about.stockOwner).toEqual({ kind: 'unavailable' });
    expect(view.about.billTo).toEqual({ kind: 'unavailable' });
  });

  it('names the stock owner and the bill-to separately', async () => {
    const s = base({
      'inventory_items.select': servedLikePostgrest([
        { id: 'i1', name: 'Shirt', sku: 'S1', charter_id: 'ch1' },
        { id: 'i2', name: 'Cap', sku: 'C1', charter_id: 'ch1' },
      ]),
      'purchase_orders.select': {
        data: [{ id: PO, po_number: 'PO-1', supplier_id: null, charter_id: 'ch2' }],
        error: null,
      },
      'charters.select': servedLikePostgrest([
        { id: 'ch1', name: 'North Charter' },
        { id: 'ch2', name: 'South Charter' },
      ]),
    });
    const view = await new ReceivingChecklistService(ctxFor(s.client)).getRun(RUN);
    expect(view.about.stockOwner).toEqual({ kind: 'ok', value: ['North Charter'] });
    expect(view.about.billTo).toEqual({ kind: 'ok', value: 'South Charter' });
  });

  it('a run the caller cannot see, and a run read that fails, are not found and internal', async () => {
    const hidden = base({ 'checklist_runs.select': { data: [], error: null } });
    await expect(
      new ReceivingChecklistService(ctxFor(hidden.client)).getRun(RUN),
    ).rejects.toMatchObject({ code: 'not_found' });
    const broken = base({ 'checklist_runs.select': { data: null, error: { message: 'x' } } });
    await expect(
      new ReceivingChecklistService(ctxFor(broken.client)).getRun(RUN),
    ).rejects.toMatchObject({ code: 'internal_error' });
    const noPo = base({ 'purchase_orders.select': { data: [], error: null } });
    await expect(
      new ReceivingChecklistService(ctxFor(noPo.client)).getRun(RUN),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('a viewer reads it, and may not record it', async () => {
    const view = await new ReceivingChecklistService(
      ctxFor(base().client, { role: 'viewer' }),
    ).getRun(RUN);
    expect(view.canRecord).toBe(false);
  });
});

// ── ReceivingService.postReceipt: the manager floor ─────────────────────────
describe('ReceivingService.postReceipt refuses below manager', () => {
  const input: PostReceiptInput = {
    purchaseOrderId: PO,
    warehouseId: WH,
    idempotencyKey: '66666666-6666-4666-8666-666666666666',
    lines: [
      {
        poLineId: '77777777-7777-4777-8777-777777777777',
        qtyReceived: 1,
        qtyAccepted: 1,
        qtyRejected: 0,
      },
    ],
  };

  // Mutation caught: gating the post on stock:adjust only (staff hold it).
  it('staff with stock:adjust get the manager sentence and the RPC is never called', async () => {
    const s = makeSupabaseStub({ 'rpc:post_receipt_v2': { data: { id: RCPT }, error: null } });
    const svc = new ReceivingService(ctxFor(s.client, { role: 'staff' }));
    await expect(svc.postReceipt(input)).rejects.toMatchObject({
      code: 'forbidden',
      message: RECEIVE_POST_MANAGER_ONLY_COPY,
      details: { reason: 'manager_posts' },
    });
    expect(s.rpcCalls).toHaveLength(0);
  });

  it('a manager without stock:adjust is refused by the permission, as before', async () => {
    const s = makeSupabaseStub();
    const svc = new ReceivingService(ctxFor(s.client, { permissions: ['purchase_orders:read'] }));
    await expect(svc.postReceipt(input)).rejects.toMatchObject({
      code: 'forbidden',
      message: 'Missing permission: stock:adjust',
    });
    expect(s.rpcCalls).toHaveLength(0);
  });
});

// release() + forceReassign() service wrappers over the 0282 RPCs.
// Verifies reason enforcement, RPC errcode → ServiceError mapping, and audit.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { reportError } from '@/lib/error-reporter';
import {
  makeServiceContext,
  makeSupabaseStub,
  servedLikePostgrest,
  type QueryResult,
} from '@/test/supabase-mock';

vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));

vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: vi.fn(async () => ({
    readableIds: ['wh-a'],
    writableIds: ['wh-a'],
    hasAllAccess: true,
    primaryWarehouseId: 'wh-a',
  })),
  assertWarehouseAccess: vi.fn(),
  forcedWarehouseId: vi.fn(async () => null),
  ForbiddenError: class ForbiddenError extends Error {
    readonly code = 'forbidden' as const;
  },
}));

vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    userId: 'user-test',
    organizationId: 'org-test',
    role: 'admin',
  })),
}));

// audit() is globally no-op'd in setup.ts; keep it silent here too.
import { audit } from './audit';
import { CycleCountsService } from './cycle-counts';

beforeEach(() => vi.clearAllMocks());

// A supabase stub whose .rpc(name) resolves to the given result.
function rpcStub(result: { data: unknown; error: { message: string } | null }) {
  const stub = makeSupabaseStub({});
  // makeSupabaseStub's client exposes .rpc; override it for this test.
  (stub.client as unknown as { rpc: unknown }).rpc = vi.fn(async () => result);
  return stub;
}

describe('CycleCountsService.release', () => {
  it('rejects a blank reason before hitting the RPC', async () => {
    const stub = rpcStub({ data: null, error: null });
    const svc = new CycleCountsService(makeServiceContext(stub.client, { role: 'staff', userId: 'me' }));
    await expect(svc.release('cc-1', '   ')).rejects.toMatchObject({
      code: 'validation_error',
      details: { reason: 'release_reason_required' },
    });
    expect((stub.client as unknown as { rpc: ReturnType<typeof vi.fn> }).rpc).not.toHaveBeenCalled();
  });

  it('releases with a reason (RPC ok)', async () => {
    const stub = rpcStub({ data: { id: 'cc-1', assigned_to: null }, error: null });
    const svc = new CycleCountsService(makeServiceContext(stub.client, { role: 'staff', userId: 'me' }));
    const row = await svc.release('cc-1', 'shift ending');
    expect(row).toMatchObject({ id: 'cc-1', assigned_to: null });
    expect((stub.client as unknown as { rpc: ReturnType<typeof vi.fn> }).rpc).toHaveBeenCalledWith(
      'release_cycle_count',
      { p_count_id: 'cc-1', p_reason: 'shift ending' },
    );
  });

  it('maps the RPC forbidden errcode to a forbidden ServiceError', async () => {
    const stub = rpcStub({ data: null, error: { message: 'forbidden' } });
    const svc = new CycleCountsService(makeServiceContext(stub.client, { role: 'staff', userId: 'me' }));
    await expect(svc.release('cc-1', 'shift ending')).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('maps invalid_status_transition to conflict', async () => {
    const stub = rpcStub({ data: null, error: { message: 'invalid_status_transition' } });
    const svc = new CycleCountsService(makeServiceContext(stub.client, { role: 'manager', userId: 'mgr' }));
    await expect(svc.release('cc-1', 'shift ending')).rejects.toMatchObject({ code: 'conflict' });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// A REFUSED RELEASE OF A COUNT THAT IS ALREADY RELEASED (docket S42b).
//
// release_cycle_count refuses a non-manager on a count with no assignee (S42's
// migration). That is also what an assignee meets when their release already
// went through: the phone stopped waiting for the answer (or the connection
// dropped) and they tap Release count again, or a manager released the count
// while their screen was open. The generic sentence, "Only the assigned
// employee or a manager can release this count.", tells the person who was
// the assignee that only the assignee may release. So after a 'forbidden',
// the service reads the count with the caller's own client, in the active
// organization: in progress with no assignee answers 'This count was already
// released.' (conflict), with no write and no second audit row. Row level
// security decides what the read sees; someone it shows nothing (outside the
// count's organization) keeps the generic refusal, and so does every other
// case. The stub serves the caller's view of cycle_counts and applies the
// read's own filters (servedLikePostgrest).
// ═══════════════════════════════════════════════════════════════════════════

describe('CycleCountsService.release after the database refused it (S42b)', () => {
  const ORG = 'org-test';
  const COUNT = 'cc-1';
  const ALREADY_RELEASED = 'This count was already released.';
  const GENERIC = 'Only the assigned employee or a manager can release this count.';
  const REFUSED: QueryResult = { data: null, error: { message: 'forbidden', code: '42501' } };

  type CountRow = {
    id: string;
    organization_id: string;
    status: 'in_progress' | 'completed' | 'canceled';
    assigned_to: string | null;
  };
  const count = (over: Partial<CountRow> = {}): CountRow => ({
    id: COUNT,
    organization_id: ORG,
    status: 'in_progress',
    assigned_to: null,
    ...over,
  });

  /** A staff member holding stock:adjust, the app's floor for a release. */
  function asStaff(stub: ReturnType<typeof makeSupabaseStub>, userId = 'me') {
    return new CycleCountsService(makeServiceContext(stub.client, { role: 'staff', userId }));
  }
  const tableOps = (stub: ReturnType<typeof makeSupabaseStub>) => [...stub.chainsAll.keys()];

  it("the assignee's second Release after their first went through (its answer lost) says the count was already released, and writes no second audit row", async () => {
    // The database as S42 leaves it, for a non-manager: the assignee's own
    // release goes through and clears the assignment; the same call again
    // finds no assignee and is refused.
    let row = count({ assigned_to: 'me' });
    const stub = makeSupabaseStub({
      'rpc:release_cycle_count': () => {
        if (row.assigned_to !== 'me') return REFUSED;
        row = { ...row, assigned_to: null };
        return { data: row, error: null };
      },
      'cycle_counts.select': servedLikePostgrest(() => [row]),
    });
    const svc = asStaff(stub);

    await expect(svc.release(COUNT, 'Shift ending')).resolves.toMatchObject({ assigned_to: null });
    expect(audit).toHaveBeenCalledTimes(1);

    await expect(svc.release(COUNT, 'Shift ending')).rejects.toMatchObject({
      code: 'conflict',
      message: ALREADY_RELEASED,
    });
    expect(audit).toHaveBeenCalledTimes(1);
    expect(stub.rpcCalls.map((c) => c.name)).toEqual([
      'release_cycle_count',
      'release_cycle_count',
    ]);
    // One read, through the caller's own client, keyed by the count and the
    // active organization; nothing written.
    expect(tableOps(stub)).toEqual(['cycle_counts.select']);
    expect(stub.chainsAll.get('cycle_counts.select')).toEqual([['select', 'eq', 'eq']]);
    expect(stub.chainArgsAll.get('cycle_counts.select')?.[0]).toEqual([
      ['status, assigned_to'],
      ['organization_id', ORG],
      ['id', COUNT],
    ]);
  });

  it('the assignee whose count a manager released while their screen was open is told it was already released', async () => {
    const stub = makeSupabaseStub({
      'rpc:release_cycle_count': REFUSED,
      'cycle_counts.select': servedLikePostgrest([count({ assigned_to: null })]),
    });
    await expect(asStaff(stub).release(COUNT, 'Shift ending')).rejects.toMatchObject({
      code: 'conflict',
      message: ALREADY_RELEASED,
    });
    expect(audit).not.toHaveBeenCalled();
    expect(tableOps(stub)).toEqual(['cycle_counts.select']);
  });

  it('a member who can read the count but was never its assignee keeps the generic refusal', async () => {
    const stub = makeSupabaseStub({
      'rpc:release_cycle_count': REFUSED,
      'cycle_counts.select': servedLikePostgrest([count({ assigned_to: 'someone-else' })]),
    });
    await expect(asStaff(stub).release(COUNT, 'Shift ending')).rejects.toMatchObject({
      code: 'forbidden',
      message: GENERIC,
    });
    expect(audit).not.toHaveBeenCalled();
  });

  it("someone outside the count's organization reads nothing (row level security) and keeps the generic refusal", async () => {
    const stub = makeSupabaseStub({
      'rpc:release_cycle_count': REFUSED,
      'cycle_counts.select': servedLikePostgrest([]),
    });
    await expect(asStaff(stub, 'outsider').release(COUNT, 'Shift ending')).rejects.toMatchObject({
      code: 'forbidden',
      message: GENERIC,
    });
    expect(audit).not.toHaveBeenCalled();
  });

  it('a count of another organization the caller belongs to is not read from the active one: the generic refusal', async () => {
    const stub = makeSupabaseStub({
      'rpc:release_cycle_count': REFUSED,
      'cycle_counts.select': servedLikePostgrest([count({ organization_id: 'org-other' })]),
    });
    await expect(asStaff(stub).release(COUNT, 'Shift ending')).rejects.toMatchObject({
      code: 'forbidden',
      message: GENERIC,
    });
  });

  it("a closed count keeps its own sentence, and the refusal's read is not made", async () => {
    const stub = makeSupabaseStub({
      'rpc:release_cycle_count': {
        data: null,
        error: { message: 'invalid_status_transition', code: 'P0001', details: 'completed' },
      },
      'cycle_counts.select': servedLikePostgrest([count({ status: 'completed' })]),
    });
    await expect(asStaff(stub).release(COUNT, 'Shift ending')).rejects.toMatchObject({
      code: 'conflict',
      message: "This cycle count is closed — it can't be released.",
    });
    expect(stub.fromCalls).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it('a count closed between the refusal and the read keeps the generic refusal', async () => {
    const stub = makeSupabaseStub({
      'rpc:release_cycle_count': REFUSED,
      'cycle_counts.select': servedLikePostgrest([
        count({ status: 'completed', assigned_to: null }),
      ]),
    });
    await expect(asStaff(stub).release(COUNT, 'Shift ending')).rejects.toMatchObject({
      code: 'forbidden',
      message: GENERIC,
    });
  });

  it('a read that fails keeps the generic refusal and is reported, never thrown as its own error', async () => {
    const stub = makeSupabaseStub({
      'rpc:release_cycle_count': REFUSED,
      'cycle_counts.select': {
        data: null,
        error: { message: 'canceling statement due to statement timeout', code: '57014' },
      },
    });
    await expect(asStaff(stub).release(COUNT, 'Shift ending')).rejects.toMatchObject({
      code: 'forbidden',
      message: GENERIC,
    });
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(vi.mocked(reportError).mock.calls[0]?.[1]).toMatchObject({
      tag: 'cycle_counts.release.refusal_read',
      level: 'warning',
      extra: { cycleCountId: COUNT, code: '57014' },
    });
    expect(audit).not.toHaveBeenCalled();
  });

  it('any other refusal is answered as before, with no read', async () => {
    const stub = makeSupabaseStub({
      'rpc:release_cycle_count': {
        data: null,
        error: { message: 'cycle_count_not_found', code: 'P0002' },
      },
      'cycle_counts.select': servedLikePostgrest([count()]),
    });
    await expect(asStaff(stub).release(COUNT, 'Shift ending')).rejects.toMatchObject({
      code: 'not_found',
      message: 'Cycle count not found.',
    });
    expect(stub.fromCalls).toEqual([]);
  });
});

describe('CycleCountsService.forceReassign', () => {
  it('rejects a blank reason before hitting the RPC', async () => {
    const stub = rpcStub({ data: null, error: null });
    const svc = new CycleCountsService(makeServiceContext(stub.client, { role: 'manager', userId: 'mgr' }));
    await expect(svc.forceReassign('cc-1', 'user-b', '  ')).rejects.toMatchObject({
      code: 'validation_error',
      details: { reason: 'reassign_reason_required' },
    });
    expect((stub.client as unknown as { rpc: ReturnType<typeof vi.fn> }).rpc).not.toHaveBeenCalled();
  });

  it('force-reassigns with a reason (RPC ok)', async () => {
    const stub = rpcStub({ data: { id: 'cc-1', assigned_to: 'user-b' }, error: null });
    const svc = new CycleCountsService(makeServiceContext(stub.client, { role: 'manager', userId: 'mgr' }));
    const row = await svc.forceReassign('cc-1', 'user-b', 'staff A went home');
    expect(row).toMatchObject({ id: 'cc-1', assigned_to: 'user-b' });
    expect((stub.client as unknown as { rpc: ReturnType<typeof vi.fn> }).rpc).toHaveBeenCalledWith(
      'force_reassign_cycle_count',
      { p_count_id: 'cc-1', p_user_id: 'user-b', p_reason: 'staff A went home' },
    );
  });

  it('maps forbidden (non-manager) to a forbidden ServiceError', async () => {
    const stub = rpcStub({ data: null, error: { message: 'forbidden' } });
    const svc = new CycleCountsService(makeServiceContext(stub.client, { role: 'staff', userId: 'me' }));
    await expect(svc.forceReassign('cc-1', 'user-b', 'reason')).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('maps invalid_assignee to validation_error', async () => {
    const stub = rpcStub({ data: null, error: { message: 'invalid_assignee' } });
    const svc = new CycleCountsService(makeServiceContext(stub.client, { role: 'manager', userId: 'mgr' }));
    await expect(svc.forceReassign('cc-1', 'ghost', 'reason')).rejects.toMatchObject({ code: 'validation_error' });
  });
});

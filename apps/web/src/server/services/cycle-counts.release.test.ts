// release() + forceReassign() service wrappers over the 0282 RPCs.
// Verifies reason enforcement, RPC errcode → ServiceError mapping, and audit.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { reportError } from '@/lib/error-reporter';
import {
  callArgs,
  makeServiceContext,
  makeSupabaseStub,
  servedLikePostgrest,
  type QueryResult,
} from '@/test/supabase-mock';

vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));

// The service client release() asks, past row level security, whether the
// caller is the assignee of a count their own read does not show (S48).
const adminState = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  throws: false,
  fails: false,
  stub: null as unknown,
}));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(() => {
    if (adminState.throws) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not configured');
    return (adminState.stub as { client: unknown }).client;
  }),
}));

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
import { createAdminClient } from '@/lib/supabase/admin';

import { audit } from './audit';
import { CycleCountsService } from './cycle-counts';

beforeEach(() => {
  vi.clearAllMocks();
  adminState.rows = [];
  adminState.throws = false;
  adminState.fails = false;
  adminState.stub = makeSupabaseStub({
    'cycle_counts.select': (call) =>
      adminState.fails
        ? { data: null, error: { message: 'connection reset', code: '08006' } }
        : servedLikePostgrest(() => adminState.rows)(call),
  });
});

// A supabase stub whose .rpc(name) resolves to the given result. The count
// is read in the organization before the RPC (S39) and is found.
function rpcStub(result: { data: unknown; error: { message: string } | null }) {
  const stub = makeSupabaseStub({ 'cycle_counts.select': { data: { id: 'cc-1' }, error: null } });
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
// released.' (conflict), with no write and no second audit row. Every other
// refused case keeps the generic refusal. The stub serves the caller's view of
// cycle_counts and applies the read's own filters (servedLikePostgrest).
//
// Before the function, release() reads the count in the active organization
// (S39, its id only): a miss is 'Cycle count not found.' with no function call,
// so someone row level security shows nothing (outside the count's
// organization), or a page of another organization the caller belongs to,
// never reaches the function or the refusal's read.
// ═══════════════════════════════════════════════════════════════════════════

describe('CycleCountsService.release after the database refused it (S42b)', () => {
  const ORG = 'org-test';
  const COUNT = 'cc-1';
  const ALREADY_RELEASED = 'This count was already released.';
  const GENERIC = 'Only the assigned employee or a manager can release this count.';
  const NOT_FOUND = 'Cycle count not found.';
  const REFUSED: QueryResult = { data: null, error: { message: 'forbidden', code: '42501' } };
  /** The read in the active organization before the function (S39). */
  const IN_ORG_READ = [['id'], ['organization_id', ORG], ['id', COUNT]];
  /** The refusal's read (S42b). */
  const REFUSAL_READ = [['status, assigned_to'], ['organization_id', ORG], ['id', COUNT]];

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
    // Reads only, through the caller's own client, each keyed by the count
    // and the active organization; nothing written. Each release reads the
    // count in the organization first (S39); the refused one then makes the
    // refusal's one read.
    expect(tableOps(stub)).toEqual(['cycle_counts.select']);
    expect(stub.chainsAll.get('cycle_counts.select')).toEqual([
      ['select', 'eq', 'eq'],
      ['select', 'eq', 'eq'],
      ['select', 'eq', 'eq'],
    ]);
    expect(stub.chainArgsAll.get('cycle_counts.select')).toEqual([
      IN_ORG_READ,
      IN_ORG_READ,
      REFUSAL_READ,
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

  it("someone outside the count's organization reads nothing (row level security): not found, before the function", async () => {
    const stub = makeSupabaseStub({
      'rpc:release_cycle_count': REFUSED,
      'cycle_counts.select': servedLikePostgrest([]),
    });
    await expect(asStaff(stub, 'outsider').release(COUNT, 'Shift ending')).rejects.toMatchObject({
      code: 'not_found',
      message: NOT_FOUND,
    });
    expect(stub.rpcCalls).toHaveLength(0);
    expect(stub.chainArgsAll.get('cycle_counts.select')).toEqual([IN_ORG_READ]);
    expect(audit).not.toHaveBeenCalled();
  });

  it('a count of another organization the caller belongs to is not found from the active one, before the function', async () => {
    const stub = makeSupabaseStub({
      'rpc:release_cycle_count': REFUSED,
      'cycle_counts.select': servedLikePostgrest([count({ organization_id: 'org-other' })]),
    });
    await expect(asStaff(stub).release(COUNT, 'Shift ending')).rejects.toMatchObject({
      code: 'not_found',
      message: NOT_FOUND,
    });
    expect(stub.rpcCalls).toHaveLength(0);
    expect(audit).not.toHaveBeenCalled();
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
    // Only the read in the organization before the function.
    expect(stub.chainArgsAll.get('cycle_counts.select')).toEqual([IN_ORG_READ]);
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
      // The read in the organization finds the count; the refusal's read fails.
      'cycle_counts.select': (call) =>
        callArgs(call, 'select')?.[0] === 'status, assigned_to'
          ? {
              data: null,
              error: { message: 'canceling statement due to statement timeout', code: '57014' },
            }
          : servedLikePostgrest([count()])(call),
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

  it("any other refusal is answered as before, with no refusal's read", async () => {
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
    expect(stub.rpcCalls).toHaveLength(1);
    expect(stub.chainArgsAll.get('cycle_counts.select')).toEqual([IN_ORG_READ]);
  });
});

describe('CycleCountsService.release of a count the caller cannot read (S48)', () => {
  const ORG = 'org-test';
  const COUNT = 'cc-1';
  const NOT_FOUND = 'Cycle count not found.';
  const IN_ORG_READ = [['id'], ['organization_id', ORG], ['id', COUNT]];
  const count = (over: Record<string, unknown> = {}) => ({
    id: COUNT,
    organization_id: ORG,
    status: 'in_progress',
    assigned_to: null as string | null,
    ...over,
  });
  /** The member's own read finds nothing: the count is of a warehouse she
   *  does not have. The function lets its assignee release it. */
  function unreadableStub() {
    return makeSupabaseStub({
      // The database as S48 leaves it: the function lets the assignee release.
      'rpc:release_cycle_count': () =>
        adminState.rows.some((r) => r.assigned_to === 'me' && r.organization_id === ORG)
          ? { data: count(), error: null }
          : { data: null, error: { message: 'forbidden', code: '42501' } },
      'cycle_counts.select': servedLikePostgrest([]),
    });
  }
  const asStaff = (stub: ReturnType<typeof makeSupabaseStub>, userId = 'me') =>
    new CycleCountsService(makeServiceContext(stub.client, { role: 'staff', userId }));
  const adminStub = () => adminState.stub as ReturnType<typeof makeSupabaseStub>;

  it('the assignee releases her count of a warehouse she does not have: the function runs as her, and the release is audited', async () => {
    adminState.rows = [count({ assigned_to: 'me' })];
    const stub = unreadableStub();
    await expect(asStaff(stub).release(COUNT, 'Shift ending')).resolves.toMatchObject({
      id: COUNT,
    });
    expect(stub.rpcCalls.map((c) => c.name)).toEqual(['release_cycle_count']);
    expect(stub.chainArgsAll.get('cycle_counts.select')).toEqual([IN_ORG_READ]);
    // The service client asks one thing: this count, in the active
    // organization, assigned to the caller.
    expect(adminStub().chainArgsAll.get('cycle_counts.select')).toEqual([
      [['id'], ['organization_id', ORG], ['id', COUNT], ['assigned_to', 'me']],
    ]);
    expect(audit).toHaveBeenCalledTimes(1);
  });

  it('a member of the same organization who is not its assignee: not found, before the function', async () => {
    adminState.rows = [count({ assigned_to: 'someone-else' })];
    const stub = unreadableStub();
    await expect(asStaff(stub).release(COUNT, 'Shift ending')).rejects.toMatchObject({
      code: 'not_found',
      message: NOT_FOUND,
    });
    expect(stub.rpcCalls).toHaveLength(0);
    expect(audit).not.toHaveBeenCalled();
  });

  it('a count of another organization, even one assigned to the caller there: not found from the active one, before the function', async () => {
    adminState.rows = [count({ organization_id: 'org-other', assigned_to: 'me' })];
    const stub = unreadableStub();
    await expect(asStaff(stub).release(COUNT, 'Shift ending')).rejects.toMatchObject({
      code: 'not_found',
      message: NOT_FOUND,
    });
    expect(stub.rpcCalls).toHaveLength(0);
    expect(audit).not.toHaveBeenCalled();
  });

  it('without the service client nothing passes: internal_error, before the function', async () => {
    adminState.rows = [count({ assigned_to: 'me' })];
    adminState.throws = true;
    const stub = unreadableStub();
    await expect(asStaff(stub).release(COUNT, 'Shift ending')).rejects.toMatchObject({
      code: 'internal_error',
    });
    expect(stub.rpcCalls).toHaveLength(0);
    expect(audit).not.toHaveBeenCalled();
  });

  it('a failed service read passes nothing: internal_error, before the function', async () => {
    adminState.rows = [count({ assigned_to: 'me' })];
    adminState.fails = true;
    const stub = unreadableStub();
    await expect(asStaff(stub).release(COUNT, 'Shift ending')).rejects.toMatchObject({
      code: 'internal_error',
    });
    expect(stub.rpcCalls).toHaveLength(0);
  });

  it('a count the caller reads goes to the function without the service client', async () => {
    const stub = makeSupabaseStub({
      'rpc:release_cycle_count': { data: count(), error: null },
      'cycle_counts.select': servedLikePostgrest([count({ assigned_to: 'me' })]),
    });
    await expect(asStaff(stub).release(COUNT, 'Shift ending')).resolves.toMatchObject({
      id: COUNT,
    });
    expect(vi.mocked(createAdminClient)).not.toHaveBeenCalled();
  });
});

// ── What the S42 migration and its pgTAP suite say the app answers ────────────
// The S42 migration's header and its suite's U3 and U4 labels were written
// before S42b. They said the app answers a refused release of a count with no
// assignee (a stale screen after a manager released it, and the retry after a
// lost answer) with the generic sentence, which S42b replaced in the same
// change. Both files stay in the repository, so the sentences they quote are
// taken here from release() itself: the two answers the cases above pin. The
// header says what the app answers in one place, its ERRORS note, so no other
// paragraph can drift from it. Each file is found by its suffix, so the number
// the migration takes in ship order changes nothing here.
describe('the S42 migration and its pgTAP suite quote what release() answers (S42b)', () => {
  const REPO_ROOT = path.resolve(__dirname, '../../../../..');
  const filesNamed = (dir: string, name: RegExp): string[] =>
    readdirSync(path.join(REPO_ROOT, dir)).filter((f) => name.test(f));
  const MIGRATION = filesNamed(
    'supabase/migrations',
    /^\d{4}_release_cycle_count_assignee_check\.sql$/,
  );
  const SUITE = filesNamed(
    'supabase/tests',
    /^\d{4}_release_cycle_count_assignee_check\.test\.sql$/,
  );
  const read = (dir: string, files: string[]): string =>
    files.length === 1 ? readFileSync(path.join(REPO_ROOT, dir, files[0]!), 'utf8') : '';
  const migration = read('supabase/migrations', MIGRATION);
  const suite = read('supabase/tests', SUITE);
  const flat = (s: string): string => s.replace(/\s+/g, ' ').trim();

  /** The header's paragraphs: its `--` lines before the first statement, split at the empty ones. */
  const paragraphs = (() => {
    const lines = migration.split('\n');
    const end = lines.findIndex((l) => l.trim() !== '' && !l.startsWith('--'));
    return lines
      .slice(0, end)
      .map((l) => l.replace(/^--\s?/, ''))
      .join('\n')
      .split(/\n\s*\n/)
      .map(flat)
      .filter((p) => p !== '');
  })();

  /** A pgTAP description: the SQL string that opens with `<id>: `, its '' unescaped. */
  const label = (id: string): string => {
    const m = suite.match(new RegExp(`'(${id}: (?:[^']|'')*)'`));
    return m ? flat(m[1]!.replace(/''/g, "'")) : '';
  };

  /** What release() answers when the database refused it and the caller's own read shows `row`. */
  async function answer(row: { status: string; assigned_to: string | null }) {
    const stub = makeSupabaseStub({
      'rpc:release_cycle_count': { data: null, error: { message: 'forbidden', code: '42501' } },
      'cycle_counts.select': servedLikePostgrest([
        { id: 'cc-1', organization_id: 'org-test', ...row },
      ]),
    });
    const svc = new CycleCountsService(
      makeServiceContext(stub.client, { role: 'staff', userId: 'me' }),
    );
    return svc.release('cc-1', 'Shift ending').then(
      () => ({ code: 'released', message: '' }),
      (e: { code: string; message: string }) => ({ code: e.code, message: e.message }),
    );
  }
  let alreadyReleased = '';
  let generic = '';
  beforeAll(async () => {
    const released = await answer({ status: 'in_progress', assigned_to: null });
    const other = await answer({ status: 'in_progress', assigned_to: 'someone-else' });
    expect([released.code, other.code]).toEqual(['conflict', 'forbidden']);
    alreadyReleased = released.message;
    generic = other.message;
  });

  it('finds exactly one migration and one suite by their suffix', () => {
    expect(MIGRATION).toHaveLength(1);
    expect(SUITE).toHaveLength(1);
  });

  it("the header's ERRORS note names both answers, and no other paragraph quotes either", () => {
    expect(alreadyReleased).not.toBe('');
    expect(generic).not.toBe('');
    const errors = paragraphs.filter((p) => p.startsWith('ERRORS:'));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(alreadyReleased);
    expect(errors[0]).toContain(generic);
    const others = paragraphs.filter((p) => !p.startsWith('ERRORS:')).join(' ');
    expect(others).not.toContain(alreadyReleased);
    expect(others).not.toContain(generic);
  });

  it.each(['U3', 'U4'])(
    "the suite's %s label (a refusal on a count with no assignee) quotes the conflict answer, never the generic sentence",
    (id) => {
      const text = label(id);
      expect(text.startsWith(`${id}: `)).toBe(true);
      expect(text).toContain(alreadyReleased);
      expect(text).not.toContain(generic);
    },
  );
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

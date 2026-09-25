import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_MODULE_IDS, RECOUNT_MANAGER_ONLY_COPY, type ModuleId } from '@stockpilot/core';

import { makeServiceContext, makeSupabaseStub, servedLikePostgrest } from '@/test/supabase-mock';

/**
 * ExceptionRecountService (F1-2): the order of checks (the SAME shared
 * preflight CycleCountsService.start runs), assign after start, one audit
 * row, and how start_targeted_recount's refusals reach a person.
 */

const reportError = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/lib/error-reporter', () => ({ reportError }));

vi.mock('@/lib/auth/warehouse', () => {
  class ForbiddenError extends Error {
    readonly code = 'forbidden' as const;
  }
  return {
    ForbiddenError,
    getWarehouseAccess: vi.fn(async () => ({
      readableIds: ['wh-a', 'wh-b'],
      writableIds: ['wh-a', 'wh-b'],
      hasAllAccess: true,
      primaryWarehouseId: 'wh-a',
    })),
    assertWarehouseAccess: vi.fn(async () => undefined),
    forcedWarehouseId: vi.fn(async () => null),
  };
});

// The shared preflight, wrapped so the tests can see WHICH helper ran and in
// what order, for both ways of starting a count. The real bodies still run.
vi.mock('./lib/count-start-preflight', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/count-start-preflight')>();
  return {
    ...actual,
    assertCountStartFloors: vi.fn(actual.assertCountStartFloors),
    assertAcceptedMember: vi.fn(actual.assertAcceptedMember),
    gateCountItems: vi.fn(actual.gateCountItems),
  };
});

import { assertWarehouseAccess, ForbiddenError } from '@/lib/auth/warehouse';

import { audit } from './audit';
import { ServiceError } from './context';
import { CycleCountsService, NO_COUNTABLE_PICKS_COPY } from './cycle-counts';
import { ExceptionRecountService, mapRecountError } from './exception-recount';
import { assertAcceptedMember, assertCountStartFloors, gateCountItems } from './lib/count-start-preflight';

const ORG = 'org-test';
const OCC_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OCC_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ITEM_1 = '11111111-1111-4111-8111-111111111111';
const ITEM_2 = '22222222-2222-4222-8222-222222222222';
const ITEM_3 = '33333333-3333-4333-8333-333333333333';
const STAFF_USER = '99999999-9999-4999-8999-999999999999';
const CC = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function item(id: string, o: Record<string, unknown> = {}) {
  return {
    id,
    organization_id: ORG,
    name: `Item ${id.slice(0, 1)}`,
    warehouse_id: 'wh-a',
    deleted_at: null,
    status: 'active',
    is_rental: false,
    is_bundle: false,
    ...o,
  };
}

function occ(id: string, itemId: string, o: Record<string, unknown> = {}) {
  return { id, organization_id: ORG, item_id: itemId, rule: 'count_variance', resolved_at: null, ...o };
}

function rpcResult(o: Record<string, unknown> = {}) {
  return {
    cycleCountId: CC,
    countNumber: 31,
    lineCount: 1,
    created: true,
    replay: false,
    linked: [OCC_A],
    linkedExisting: [],
    skipped: [],
    ...o,
  };
}

function setup(
  opts: {
    role?: 'owner' | 'admin' | 'manager' | 'staff' | 'viewer';
    permissions?: string[];
    enabledModules?: Set<ModuleId>;
    occurrences?: Array<Record<string, unknown>>;
    items?: Array<Record<string, unknown>>;
    rpc?: { data: unknown; error: unknown } | ((call: unknown) => { data: unknown; error: unknown });
    member?: boolean;
    assignRpc?: { data: unknown; error: unknown };
    header?: Record<string, unknown> | null;
    profiles?: Array<Record<string, unknown>>;
  } = {},
) {
  const stub = makeSupabaseStub({
    'organization_members.select': { data: opts.member === false ? null : { id: 'm-1' }, error: null },
    'exception_occurrences.select': servedLikePostgrest(opts.occurrences ?? [occ(OCC_A, ITEM_1)]),
    'inventory_items.select': servedLikePostgrest(opts.items ?? [item(ITEM_1), item(ITEM_2), item(ITEM_3)]),
    'rpc:start_targeted_recount': (opts.rpc ?? { data: rpcResult(), error: null }) as never,
    'cycle_counts.select': {
      data: opts.header === undefined ? { status: 'in_progress', assigned_to: null, assignment_version: 0 } : opts.header,
      error: null,
    },
    'cycle_counts.update': { data: { id: CC }, error: null },
    'rpc:assign_cycle_count': (opts.assignRpc ?? { data: { id: CC, assigned_to: STAFF_USER }, error: null }) as never,
    'user_profiles.select': servedLikePostgrest(opts.profiles ?? []),
  });
  const ctx = makeServiceContext(stub.client, {
    role: opts.role ?? 'manager',
    ...(opts.permissions ? { permissions: new Set(opts.permissions) } : {}),
    ...(opts.enabledModules ? { enabledModules: opts.enabledModules } : {}),
  });
  return { stub, svc: new ExceptionRecountService(ctx as never), ctx };
}

const rpcArgs = (stub: ReturnType<typeof makeSupabaseStub>, name: string) =>
  stub.rpcCalls.find((c) => c.name === name)?.args as Record<string, unknown> | undefined;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ExceptionRecountService.start — who may, checked before anything is written', () => {
  it('refuses when the cycle_counts module is off, before any read', async () => {
    const modules = new Set<ModuleId>(DEFAULT_MODULE_IDS.filter((m) => m !== 'cycle_counts'));
    const { svc, stub } = setup({ enabledModules: modules });
    await expect(svc.start({ occurrenceIds: [OCC_A] })).rejects.toMatchObject({ code: 'module_disabled' });
    expect(stub.fromCalls).toEqual([]);
    expect(stub.rpcCalls).toEqual([]);
  });

  it('refuses staff (who hold stock:adjust) and a manager without cycle_counts:assign', async () => {
    for (const s of [
      setup({ role: 'staff' }),
      setup({ role: 'staff', permissions: ['stock:adjust', 'cycle_counts:assign', 'items:read'] }),
      setup({ role: 'manager', permissions: ['stock:adjust', 'items:read'] }),
    ]) {
      await expect(s.svc.start({ occurrenceIds: [OCC_A] })).rejects.toMatchObject({ code: 'forbidden' });
      expect(s.stub.rpcCalls).toEqual([]);
      expect(s.stub.fromCalls).toEqual([]);
    }
  });

  it('refuses an assignee who is not an accepted member before starting anything', async () => {
    const { svc, stub } = setup({ member: false });
    await expect(svc.start({ occurrenceIds: [OCC_A], assignedTo: STAFF_USER })).rejects.toMatchObject({
      code: 'validation_error',
    });
    expect(stub.rpcCalls).toEqual([]);
  });

  it('an exception the caller cannot see is not found, and nothing starts', async () => {
    const { svc, stub } = setup({ occurrences: [occ(OCC_A, ITEM_1)] });
    await expect(svc.start({ occurrenceIds: [OCC_A, OCC_B] })).rejects.toMatchObject({
      code: 'not_found',
      details: { reason: 'occurrence_not_found' },
    });
    expect(stub.rpcCalls).toEqual([]);
  });

  it('a warehouse the caller cannot write to is forbidden (a ServiceError the routes answer)', async () => {
    vi.mocked(assertWarehouseAccess).mockRejectedValueOnce(new ForbiddenError('no write'));
    const { svc, stub } = setup();
    const err = await svc.start({ occurrenceIds: [OCC_A] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect(err).toMatchObject({ code: 'forbidden' });
    expect(stub.rpcCalls).toEqual([]);
  });

  it('validates the request: nothing selected, too many, bad ids, an over-long key', async () => {
    const { svc } = setup();
    await expect(svc.start({})).rejects.toMatchObject({ details: { reason: 'recount_nothing_selected' } });
    const many = Array.from({ length: 201 }, (_, i) => `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`);
    await expect(svc.start({ itemIds: many })).rejects.toMatchObject({ details: { reason: 'recount_too_many_items' } });
    await expect(svc.start({ itemIds: ['nope'] })).rejects.toMatchObject({ code: 'validation_error' });
    await expect(svc.start({ itemIds: [ITEM_1], idempotencyKey: 'k'.repeat(201) })).rejects.toMatchObject({
      details: { reason: 'idempotency_key_too_long' },
    });
  });
});

describe('ExceptionRecountService.start — the same preflight as CycleCountsService.start', () => {
  /** The order the shared helpers and the creating RPC ran in. */
  function sequence(stub: ReturnType<typeof makeSupabaseStub>, rpcName: string): string[] {
    const marks: Array<[number, string]> = [
      ...vi.mocked(assertCountStartFloors).mock.invocationCallOrder.map((n) => [n, 'floors'] as [number, string]),
      ...vi.mocked(assertAcceptedMember).mock.invocationCallOrder.map((n) => [n, 'assignee'] as [number, string]),
      ...vi.mocked(gateCountItems).mock.invocationCallOrder.map((n) => [n, 'warehouse gate'] as [number, string]),
    ];
    const rpc = vi.mocked(stub.client.rpc as (n: string) => unknown);
    rpc.mock.calls.forEach((c, i) => {
      if (c[0] === rpcName) marks.push([rpc.mock.invocationCallOrder[i]!, 'create']);
    });
    return marks.sort((a, b) => a[0] - b[0]).map((m) => m[1]);
  }

  // Mutation caught: a recount with its own copy of the checks (or skipping
  // one) instead of the helpers start() uses (pattern #26).
  it('runs floors, assignee, warehouse gate, then creates — the helpers start() uses, in its order', async () => {
    const cc = makeSupabaseStub({
      'organization_members.select': { data: { id: 'm-1' }, error: null },
      'inventory_items.select': servedLikePostgrest([item(ITEM_1)]),
      'rpc:start_cycle_count': { data: [{ cycle_count_id: CC, line_count: 1 }], error: null },
      'cycle_counts.select': { data: { status: 'in_progress', assigned_to: null, assignment_version: 0 }, error: null },
      'rpc:assign_cycle_count': { data: { id: CC, assigned_to: STAFF_USER }, error: null },
    });
    await new CycleCountsService(makeServiceContext(cc.client, { role: 'manager' }) as never).start({
      scope: 'selection',
      warehouseId: null,
      itemIds: [ITEM_1],
      assignedTo: STAFF_USER,
    });
    const startOrder = sequence(cc, 'start_cycle_count');

    vi.clearAllMocks();
    const { svc, stub } = setup();
    await svc.start({ occurrenceIds: [OCC_A], assignedTo: STAFF_USER });
    const recountOrder = sequence(stub, 'start_targeted_recount');

    // Both assign after the count exists, which calls assertAcceptedMember once
    // more (CycleCountsService.assign), so the trailing 'assignee' is expected.
    expect(startOrder).toEqual(['floors', 'assignee', 'warehouse gate', 'create', 'assignee']);
    expect(recountOrder).toEqual(startOrder);
  });

  it('gates only the items a recount would count: open, recountable exceptions plus explicit items', async () => {
    const { svc } = setup({
      occurrences: [
        occ(OCC_A, ITEM_1),
        occ(OCC_B, ITEM_2, { rule: 'stale_staging' }),
        occ('cccccccc-0000-4000-8000-000000000000', ITEM_3, { resolved_at: '2026-09-01T00:00:00Z' }),
      ],
    });
    await svc.start({ occurrenceIds: [OCC_A, OCC_B, 'cccccccc-0000-4000-8000-000000000000'], itemIds: [ITEM_3] });
    const gated = vi.mocked(gateCountItems).mock.calls[0]![1];
    expect([...gated].sort()).toEqual([ITEM_1, ITEM_3].sort());
  });
});

describe('ExceptionRecountService.start — the recount itself', () => {
  it('calls start_targeted_recount once for the org, with de-duplicated ids and neutral notes', async () => {
    const { svc, stub } = setup();
    const res = await svc.start({
      occurrenceIds: [OCC_A, OCC_A.toUpperCase()],
      itemIds: [],
      idempotencyKey: '  tap-1  ',
    });
    expect(rpcArgs(stub, 'start_targeted_recount')).toEqual({
      p_org: ORG,
      p_occurrence_ids: [OCC_A],
      p_item_ids: null,
      p_notes: 'Recount: Item 1',
      p_idempotency_key: 'tap-1',
    });
    expect(res).toMatchObject({
      cycleCountId: CC,
      countNumber: 31,
      reference: 'CC-000031',
      created: true,
      replay: false,
      linked: [OCC_A],
      notes: 'Recount: Item 1',
      assignedTo: null,
      assignmentFailed: false,
    });
  });

  it('several items read "Recount: N items", never why', async () => {
    const { svc, stub } = setup({ rpc: { data: rpcResult({ lineCount: 3 }), error: null } });
    await svc.start({ itemIds: [ITEM_1, ITEM_2, ITEM_3] });
    expect(rpcArgs(stub, 'start_targeted_recount')!.p_notes).toBe('Recount: 3 items');
  });

  it('assigns AFTER the count exists, through CycleCountsService.assign (which notifies)', async () => {
    const assign = vi.spyOn(CycleCountsService.prototype, 'assign');
    const { svc, stub } = setup();
    const res = await svc.start({ occurrenceIds: [OCC_A], assignedTo: STAFF_USER });
    expect(assign).toHaveBeenCalledWith(CC, STAFF_USER, null);
    const rpc = vi.mocked(stub.client.rpc as (n: string) => unknown);
    const startAt = rpc.mock.invocationCallOrder[rpc.mock.calls.findIndex((c) => c[0] === 'start_targeted_recount')]!;
    expect(assign.mock.invocationCallOrder[0]!).toBeGreaterThan(startAt);
    expect(res.assignedTo).toBe(STAFF_USER);
    assign.mockRestore();
  });

  // Mutation caught: letting the assign failure fail the whole request (the
  // count exists; a 500 would invite a second count) or swallowing it silently.
  it('an assign that fails keeps the count, says it is unassigned, and is reported', async () => {
    const { svc } = setup({ assignRpc: { data: null, error: { message: 'boom' } } });
    const res = await svc.start({ occurrenceIds: [OCC_A], assignedTo: STAFF_USER });
    expect(res).toMatchObject({ cycleCountId: CC, created: true, assignedTo: null, assignmentFailed: true });
    const tags = reportError.mock.calls.map((c) => (c as unknown as [unknown, { tag: string }])[1].tag);
    expect(tags).toContain('exceptions.recount.assign_failed');
  });

  it('assigns nothing when no count was made (every item already being counted, or skipped)', async () => {
    const assign = vi.spyOn(CycleCountsService.prototype, 'assign');
    const { svc } = setup({
      rpc: {
        data: rpcResult({
          cycleCountId: null,
          countNumber: null,
          lineCount: 0,
          created: false,
          linked: [],
          linkedExisting: [
            {
              cycleCountId: CC,
              countNumber: 7,
              assignedTo: STAFF_USER,
              startedAt: '2026-09-20T10:00:00Z',
              itemIds: [ITEM_1],
              occurrenceIds: [OCC_A],
            },
          ],
        }),
        error: null,
      },
      profiles: [{ id: STAFF_USER, full_name: 'Dana Diaz', email: 'd@x.test' }],
    });
    const res = await svc.start({ occurrenceIds: [OCC_A], assignedTo: STAFF_USER });
    expect(assign).not.toHaveBeenCalled();
    // No count was made, so there are no notes to report.
    expect(res.notes).toBeNull();
    expect(res.linkedExisting).toEqual([
      {
        cycleCountId: CC,
        countNumber: 7,
        reference: 'CC-000007',
        assignedTo: { id: STAFF_USER, label: 'Dana Diaz' },
        startedAt: '2026-09-20T10:00:00Z',
        itemIds: [ITEM_1],
        occurrenceIds: [OCC_A],
      },
    ]);
    assign.mockRestore();
  });

  it('skipped items come back with their names and reasons', async () => {
    const { svc } = setup({
      rpc: {
        data: rpcResult({
          cycleCountId: null,
          countNumber: null,
          lineCount: 0,
          created: false,
          linked: [],
          skipped: [{ occurrenceId: null, itemId: ITEM_2, reason: 'not_countable' }],
        }),
        error: null,
      },
    });
    const res = await svc.start({ itemIds: [ITEM_2] });
    expect(res.skipped).toEqual([
      { occurrenceId: null, occurrenceReference: null, itemId: ITEM_2, itemName: 'Item 2', reason: 'not_countable' },
    ]);
  });

  // Review finding (F1-2): an exception skipped as resolved read
  // "Skipped: <item>: Already resolved" next to "Started CC-..." for the same
  // item. The skip now carries the exception's EX number, so the result is
  // worded as the exception. Mutation caught: drop the reference.
  it('a skipped exception carries its EX number (the result names the exception, not the item)', async () => {
    const { svc, stub } = setup({
      occurrences: [occ(OCC_A, ITEM_1, { resolved_at: '2026-09-25T10:00:00Z', occurrence_number: 12 })],
      rpc: {
        data: rpcResult({
          lineCount: 1,
          linked: [],
          skipped: [{ occurrenceId: OCC_A, itemId: ITEM_1, reason: 'resolved' }],
        }),
        error: null,
      },
    });
    const res = await svc.start({ occurrenceIds: [OCC_A], itemIds: [ITEM_1] });
    expect(res.skipped).toEqual([
      { occurrenceId: OCC_A, occurrenceReference: 'EX-000012', itemId: ITEM_1, itemName: 'Item 1', reason: 'resolved' },
    ]);
    const select = stub.chainArgsAll.get('exception_occurrences.select')?.[0]?.[0]?.[0];
    expect(String(select)).toContain('occurrence_number');
  });

  it('writes ONE audit row with the id arrays (not one per item)', async () => {
    const { svc } = setup({ rpc: { data: rpcResult({ lineCount: 2, linked: [OCC_A] }), error: null } });
    await svc.start({ occurrenceIds: [OCC_A], itemIds: [ITEM_2] });
    expect(vi.mocked(audit)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(audit).mock.calls[0]![0]).toMatchObject({
      event: 'exception.recount_started',
      entityType: 'cycle_count',
      entityId: CC,
      after: {
        occurrenceIds: [OCC_A],
        itemIds: [ITEM_2],
        cycleCountId: CC,
        linked: [OCC_A],
        linkedExisting: [],
        skipped: [],
      },
    });
  });

  it('a replay (the same key again) returns the first count, audits nothing and does not re-point it', async () => {
    const assign = vi.spyOn(CycleCountsService.prototype, 'assign');
    const { svc } = setup({
      rpc: {
        data: rpcResult({ lineCount: null, created: false, replay: true, linked: [] }),
        error: null,
      },
      header: { status: 'in_progress', assigned_to: 'someone-else', assignment_version: 1 },
    });
    const res = await svc.start({ occurrenceIds: [OCC_A], assignedTo: STAFF_USER, idempotencyKey: 'tap-1' });
    expect(res).toMatchObject({ cycleCountId: CC, replay: true, created: false, assignedTo: 'someone-else' });
    expect(assign).not.toHaveBeenCalled();
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
    assign.mockRestore();
  });

  it('a replay of a first attempt whose assign failed assigns the still-unassigned count', async () => {
    const { svc } = setup({
      rpc: { data: rpcResult({ lineCount: null, created: false, replay: true, linked: [] }), error: null },
      header: { status: 'in_progress', assigned_to: null, assignment_version: 0 },
    });
    const res = await svc.start({ occurrenceIds: [OCC_A], assignedTo: STAFF_USER, idempotencyKey: 'tap-1' });
    expect(res.assignedTo).toBe(STAFF_USER);
  });

  it('corrects the notes before notifying when some items were already being counted elsewhere', async () => {
    const { svc, stub } = setup({
      rpc: {
        data: rpcResult({
          lineCount: 1,
          linkedExisting: [
            {
              cycleCountId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
              countNumber: 5,
              assignedTo: null,
              startedAt: null,
              itemIds: [ITEM_2],
              occurrenceIds: [],
            },
          ],
        }),
        error: null,
      },
    });
    const res = await svc.start({ itemIds: [ITEM_1, ITEM_2] });
    expect(rpcArgs(stub, 'start_targeted_recount')!.p_notes).toBe('Recount: 2 items');
    expect(stub.chainArgs.get('cycle_counts.update')![0]).toEqual([{ notes: 'Recount: Item 1' }]);
    expect(res.notes).toBe('Recount: Item 1');
  });

  it('an answer it cannot trust is an internal error, never "nothing started"', async () => {
    const { svc } = setup({ rpc: { data: { hello: 'world' }, error: null } });
    await expect(svc.start({ occurrenceIds: [OCC_A] })).rejects.toMatchObject({ code: 'internal_error' });
  });
});

describe('mapRecountError — by SQLSTATE and hint', () => {
  const cases: Array<[Record<string, string | null>, Record<string, unknown>]> = [
    [{ code: '42501', message: 'forbidden' }, { code: 'forbidden', message: RECOUNT_MANAGER_ONLY_COPY }],
    [{ code: '42501', message: 'not_authenticated' }, { code: 'unauthenticated' }],
    [{ code: 'P0002', message: 'occurrence_not_found' }, { code: 'not_found', details: { reason: 'occurrence_not_found' } }],
    [{ code: 'P0002', message: 'item_not_found' }, { code: 'not_found', details: { reason: 'item_not_found' } }],
    [
      { code: '22023', message: 'recount_too_many_items', hint: 'recount_too_many_items' },
      { code: 'validation_error', details: { reason: 'recount_too_many_items' } },
    ],
    [
      { code: 'P0001', message: 'idempotency_conflict', hint: 'idempotency_conflict' },
      { code: 'conflict', details: { reason: 'idempotency_conflict' } },
    ],
    [
      { code: 'P0001', message: 'recount_already_linked', hint: 'recount_already_linked' },
      { code: 'conflict', details: { reason: 'recount_already_linked' } },
    ],
    [
      { code: 'P0001', message: 'recount_items_changed: 1 of 2 items could be counted', hint: 'recount_items_changed' },
      { code: 'conflict', details: { reason: 'recount_items_changed', retryable: true } },
    ],
    [
      { code: 'P0001', message: 'cycle_count_no_items', hint: null },
      { code: 'validation_error', message: NO_COUNTABLE_PICKS_COPY },
    ],
    [{ code: '55P03', message: 'canceling statement due to lock timeout' }, { code: 'conflict', details: { reason: 'recount_busy', retryable: true } }],
    [{ code: '57014', message: 'canceling statement due to statement timeout' }, { code: 'conflict', details: { retryable: true } }],
    [{ code: 'P0001', message: 'targeted_recount_internal: x', hint: 'targeted_recount_internal' }, { code: 'internal_error' }],
    [{ code: 'XX000', message: 'weird' }, { code: 'internal_error' }],
  ];
  it.each(cases)('%o', (error, expected) => {
    expect(mapRecountError(error)).toMatchObject(expected);
  });

  it('an unknown refusal word never picks up an inherited property as its copy', () => {
    expect(mapRecountError({ code: 'P0002', message: 'constructor' })).toMatchObject({
      code: 'not_found',
      message: 'Not found. Refresh and try again.',
      details: { reason: 'not_found' },
    });
    expect(mapRecountError({ code: '22023', message: 'x', hint: 'toString' })).toMatchObject({
      details: { reason: 'invalid_argument' },
    });
  });

  it('never echoes database text in an internal error', () => {
    expect(mapRecountError({ code: 'XX000', message: 'relation secret_table' }).message).not.toMatch(/secret_table/);
  });

  it('a SKU-like message does not stand in for a hint (pattern #28)', () => {
    // A P0001 without a known hint whose message merely contains a code word.
    expect(mapRecountError({ code: 'P0001', message: 'idempotency_conflict', hint: null })).toMatchObject({
      code: 'internal_error',
    });
  });
});

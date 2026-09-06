// assign() must go through the 0282 `assign_cycle_count` RPC so the
// assignment bookkeeping the migration promises actually happens
// (assignment_claimed_at / assignment_claimed_by / assignment_version — the
// documented "optimistic-lock token so a stale mobile screen cannot act on a
// since-reassigned count"). Before SP-108 the service wrote assigned_to with a
// direct UPDATE, so every web assign left that bookkeeping stale while
// release/force_reassign (which DO use the RPCs) bumped it.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

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

import { CycleCountsService } from './cycle-counts';

beforeEach(() => vi.clearAllMocks());

function stub(overrides: Record<string, unknown> = {}) {
  return makeSupabaseStub({
    'cycle_counts.select': {
      data: { status: 'in_progress', assigned_to: null, assignment_version: 3 },
      error: null,
    },
    'organization_members.select': { data: { id: 'm1' }, error: null },
    'rpc:assign_cycle_count': {
      data: { id: 'cc-1', assigned_to: 'user-2' },
      error: null,
    },
    'cycle_counts.update': { data: { id: 'cc-1', assigned_to: null }, error: null },
    ...(overrides as Record<string, never>),
  });
}

describe('CycleCountsService.assign — 0282 RPC', () => {
  it('assigns through assign_cycle_count (not a bare UPDATE)', async () => {
    const s = stub();
    const svc = new CycleCountsService(makeServiceContext(s.client, { role: 'manager' }));

    const row = await svc.assign('cc-1', 'user-2');

    expect(s.rpcCalls).toContainEqual({
      name: 'assign_cycle_count',
      args: { p_count_id: 'cc-1', p_user_id: 'user-2' },
    });
    // No direct write — the RPC owns the assignment bookkeeping.
    expect(s.chainArgs.get('cycle_counts.update')).toBeUndefined();
    expect(row).toMatchObject({ id: 'cc-1', assigned_to: 'user-2' });
  });

  it('maps invalid_assignee to validation_error', async () => {
    const s = stub({
      'rpc:assign_cycle_count': { data: null, error: { message: 'invalid_assignee' } },
    });
    const svc = new CycleCountsService(makeServiceContext(s.client, { role: 'manager' }));
    await expect(svc.assign('cc-1', 'user-2')).rejects.toMatchObject({
      code: 'validation_error',
    });
  });

  it('maps forbidden (warehouse write / role) to forbidden', async () => {
    const s = stub({
      'rpc:assign_cycle_count': { data: null, error: { message: 'forbidden' } },
    });
    const svc = new CycleCountsService(makeServiceContext(s.client, { role: 'manager' }));
    await expect(svc.assign('cc-1', 'user-2')).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('still refuses a stale expectedAssignee before touching the RPC', async () => {
    const s = stub();
    const svc = new CycleCountsService(makeServiceContext(s.client, { role: 'manager' }));
    // Header says unassigned; the caller thought "user-9" held it.
    await expect(svc.assign('cc-1', 'user-2', 'user-9')).rejects.toMatchObject({
      code: 'validation_error',
    });
    expect(s.rpcCalls.find((c) => c.name === 'assign_cycle_count')).toBeUndefined();
  });

  it('unassign (null) stays a direct update and clears the 0282 bookkeeping', async () => {
    const s = stub();
    const svc = new CycleCountsService(makeServiceContext(s.client, { role: 'manager' }));

    await svc.assign('cc-1', null);

    expect(s.rpcCalls.find((c) => c.name === 'assign_cycle_count')).toBeUndefined();
    const updateArgs = s.chainArgs.get('cycle_counts.update');
    expect(updateArgs?.[0]?.[0]).toMatchObject({
      assigned_to: null,
      assignment_claimed_at: null,
      assignment_claimed_by: null,
      // Version bumped off the row we just read, so a stale client that
      // cached version 3 can tell something changed.
      assignment_version: 4,
    });
  });
});

// Service-layer assignee lock (defense-in-depth over the 0282 RLS).
// recordCount / clearCount must reject a non-assignee staffer with a clean
// `forbidden` (reason `assigned_to_another_user`) BEFORE the DB write, while
// allowing the assignee, an unassigned count, and a manager override.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_MODULE_IDS, type ModuleId } from '@stockpilot/core';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

// Full warehouse access — isolate the assignee check from warehouse scoping.
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

// cycle_counts.select serves BOTH assertSessionAccess (reads warehouse_id) and
// assertAssignee (reads assigned_to), so the stub row carries both.
function stubFor(assignedTo: string | null) {
  return makeSupabaseStub({
    'cycle_counts.select': {
      data: { warehouse_id: 'wh-a', assigned_to: assignedTo },
      error: null,
    },
    'cycle_count_lines.update': { data: { id: 'line-1' }, error: null },
  });
}

const recordInput = { cycleCountId: 'cc-1', lineId: 'line-1', countedQuantity: 5 };
const clearInput = { cycleCountId: 'cc-1', lineId: 'line-1' };

describe('CycleCountsService.recordCount — assignee lock', () => {
  it('blocks a non-assignee staffer (forbidden, assigned_to_another_user)', async () => {
    const stub = stubFor('another-user');
    const svc = new CycleCountsService(
      makeServiceContext(stub.client, { role: 'staff', userId: 'me' }),
    );
    await expect(svc.recordCount(recordInput)).rejects.toMatchObject({
      code: 'forbidden',
      details: { reason: 'assigned_to_another_user' },
    });
    // The DB write never fired.
    expect(stub.chainArgs.get('cycle_count_lines.update')).toBeUndefined();
  });

  it('allows the assigned staffer to record their line', async () => {
    const stub = stubFor('me');
    const svc = new CycleCountsService(
      makeServiceContext(stub.client, { role: 'staff', userId: 'me' }),
    );
    await expect(svc.recordCount(recordInput)).resolves.toBeUndefined();
  });

  it('allows an unassigned count (parity with the RLS assigned_to IS NULL predicate)', async () => {
    const stub = stubFor(null);
    const svc = new CycleCountsService(
      makeServiceContext(stub.client, { role: 'staff', userId: 'me' }),
    );
    await expect(svc.recordCount(recordInput)).resolves.toBeUndefined();
  });

  it('allows a manager to override-record on another user\'s assigned count', async () => {
    const stub = stubFor('another-user');
    const svc = new CycleCountsService(
      makeServiceContext(stub.client, { role: 'manager', userId: 'mgr' }),
    );
    await expect(svc.recordCount(recordInput)).resolves.toBeUndefined();
  });
});

describe('CycleCountsService.clearCount — assignee lock', () => {
  it('blocks a non-assignee staffer from clearing a line', async () => {
    const stub = stubFor('another-user');
    const svc = new CycleCountsService(
      makeServiceContext(stub.client, { role: 'staff', userId: 'me' }),
    );
    await expect(svc.clearCount(clearInput)).rejects.toMatchObject({
      code: 'forbidden',
      details: { reason: 'assigned_to_another_user' },
    });
  });

  it('allows the assigned staffer to clear their line', async () => {
    const stub = stubFor('me');
    const svc = new CycleCountsService(
      makeServiceContext(stub.client, { role: 'staff', userId: 'me' }),
    );
    await expect(svc.clearCount(clearInput)).resolves.toBeUndefined();
  });
});

// AI Shelf Scan pre-flight gate: getLineSetForAiScan must enforce the same
// assignee lock + open-status BEFORE the route spends a paid vision call.
describe('CycleCountsService.getLineSetForAiScan — pre-flight authorization', () => {
  const aiModules = new Set<ModuleId>([...DEFAULT_MODULE_IDS, 'ai_shelf_scan']);

  function aiStub(assignedTo: string | null, status = 'in_progress') {
    return makeSupabaseStub({
      'cycle_counts.select': {
        data: { warehouse_id: 'wh-a', assigned_to: assignedTo, status },
        error: null,
      },
    });
  }

  it('blocks a non-assignee staffer before any vision work', async () => {
    const stub = aiStub('another-user');
    const svc = new CycleCountsService(
      makeServiceContext(stub.client, { role: 'staff', userId: 'me', enabledModules: aiModules }),
    );
    await expect(svc.getLineSetForAiScan('cc-1')).rejects.toMatchObject({
      code: 'forbidden',
      details: { reason: 'assigned_to_another_user' },
    });
  });

  it('blocks a closed count (conflict) before any vision work', async () => {
    const stub = aiStub('me', 'completed');
    const svc = new CycleCountsService(
      makeServiceContext(stub.client, { role: 'staff', userId: 'me', enabledModules: aiModules }),
    );
    await expect(svc.getLineSetForAiScan('cc-1')).rejects.toMatchObject({ code: 'conflict' });
  });
});

// release() + forceReassign() service wrappers over the 0282 RPCs.
// Verifies reason enforcement, RPC errcode → ServiceError mapping, and audit.
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

// audit() is globally no-op'd in setup.ts; keep it silent here too.
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

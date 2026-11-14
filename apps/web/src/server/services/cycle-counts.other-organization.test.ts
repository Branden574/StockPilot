// Security invariant (S39, listed in scripts/security-test.sh): a write named by
// a row id never runs on a row of another organization.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub, servedLikePostgrest } from '@/test/supabase-mock';

vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => {
    throw new Error('the service must use the context it was given');
  }),
}));

// The service client release() asks, past row level security, whether the
// caller is the assignee of a count their own read does not show (S48). The
// count is B's and assigned to the person in both organizations.
vi.mock('@/lib/supabase/admin', async () => {
  const mock = await import('@/test/supabase-mock');
  return {
    createAdminClient: vi.fn(
      () =>
        mock.makeSupabaseStub({
          'cycle_counts.select': mock.servedLikePostgrest([
            {
              id: 'cc-b-1',
              organization_id: 'org-B',
              status: 'in_progress',
              assigned_to: 'u-in-both',
            },
          ]),
        }).client,
    ),
  };
});

import { audit } from './audit';
import { CycleCountsService } from './cycle-counts';

/**
 * S39: a cycle count of organization B, released or reassigned from a phone
 * screen left open after the person switched to organization A.
 * release_cycle_count and force_reassign_cycle_count decide on the COUNT's own
 * organization, so the release ran in B and its audit row (with the typed
 * reason and the new assignee) landed in A. The count is now read in A first;
 * a miss refuses before the function.
 */

const COUNT_ID = 'cc-b-1';
const COUNT_ROWS = [{ id: COUNT_ID, organization_id: 'org-B', status: 'in_progress' }];

function stubFor() {
  return makeSupabaseStub({
    'cycle_counts.select': servedLikePostgrest(COUNT_ROWS),
    'rpc:release_cycle_count': { data: { id: COUNT_ID, assigned_to: null }, error: null },
    'rpc:force_reassign_cycle_count': {
      data: { id: COUNT_ID, assigned_to: 'u-other' },
      error: null,
    },
  });
}

function svc(stub: ReturnType<typeof makeSupabaseStub>, org: string, role: 'manager' | 'staff') {
  return new CycleCountsService(
    makeServiceContext(stub.client, { organizationId: org, userId: 'u-in-both', role }),
  );
}

function expectReadInA(stub: ReturnType<typeof makeSupabaseStub>) {
  expect(stub.chainArgsAll.get('cycle_counts.select')?.[0]).toEqual(
    expect.arrayContaining([
      ['organization_id', 'org-A'],
      ['id', COUNT_ID],
    ]),
  );
}

beforeEach(() => vi.clearAllMocks());

describe('release: a count of another organization is not found', () => {
  it('the assignee working in A releasing a count that is not in A (the service read asks in A too)', async () => {
    const stub = stubFor();

    await expect(
      svc(stub, 'org-A', 'staff').release(COUNT_ID, 'shift ending'),
    ).rejects.toMatchObject({
      code: 'not_found',
      message: 'Cycle count not found.',
    });

    expectReadInA(stub);
    expect(stub.rpcCalls).toHaveLength(0);
    expect(audit).not.toHaveBeenCalled();
  });

  it('still asks for the reason first, before any read', async () => {
    const stub = stubFor();

    await expect(svc(stub, 'org-A', 'staff').release(COUNT_ID, '  ')).rejects.toMatchObject({
      code: 'validation_error',
    });

    expect(stub.fromCalls).toHaveLength(0);
    expect(stub.rpcCalls).toHaveLength(0);
  });

  it('working in B, the release runs once and is recorded in B', async () => {
    const stub = stubFor();

    await svc(stub, 'org-B', 'staff').release(COUNT_ID, 'shift ending');

    expect(stub.rpcCalls).toEqual([
      { name: 'release_cycle_count', args: { p_count_id: COUNT_ID, p_reason: 'shift ending' } },
    ]);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'cycle_count.released', entityId: COUNT_ID }),
      expect.objectContaining({ organizationId: 'org-B' }),
    );
  });
});

describe('forceReassign: a count of another organization is not found', () => {
  it('a manager of A reassigning a count that is not in A', async () => {
    const stub = stubFor();

    await expect(
      svc(stub, 'org-A', 'manager').forceReassign(COUNT_ID, 'u-other', 'out sick'),
    ).rejects.toMatchObject({ code: 'not_found', message: 'Cycle count not found.' });

    expectReadInA(stub);
    expect(stub.rpcCalls).toHaveLength(0);
    expect(audit).not.toHaveBeenCalled();
  });

  it('working in B, the reassignment runs once and is recorded in B', async () => {
    const stub = stubFor();

    await svc(stub, 'org-B', 'manager').forceReassign(COUNT_ID, 'u-other', 'out sick');

    expect(stub.rpcCalls.map((c) => c.name)).toEqual(['force_reassign_cycle_count']);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'cycle_count.force_reassigned', entityId: COUNT_ID }),
      expect.objectContaining({ organizationId: 'org-B' }),
    );
  });
});

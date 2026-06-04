// apps/web/src/server/services/team.multi-charter.test.ts
//
// Data-layer coverage for multi-charter user assignment:
//   (a) TeamService.invite stores `charter_ids` from `charterIds`
//       (and the back-compat single `charter_id`).
//   (b) TeamService.setMemberCharterAssignments reconciles an existing
//       member's per-warehouse charter rows: inserts the missing target
//       charters and deletes the ones no longer in the target set.
//
// Both methods run against the user-scoped (ctx) client, so they unit-test
// cleanly with makeSupabaseStub. acceptInvite uses the admin client and is
// intentionally out of scope here.
//
// setup.ts globally mocks `@/server/services/audit` (no-op) and calls
// vi.restoreAllMocks() after each test, so mocks are re-armed per test.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

import { TeamService } from './team';

// First positional arg of the first recorded call for a (table, op) chain.
function firstInsertPayload<T = Record<string, unknown>>(
  args: unknown[][] | undefined,
): T {
  const call = args?.[0];
  const payload = call?.[0];
  return payload as T;
}

// Keep invite() from touching the network — sendEmail is dry-run safe but
// mocking it removes console noise and any env coupling.
vi.mock('@/lib/email/resend', () => ({
  sendEmail: vi.fn(async () => ({ ok: true, id: 'test' })),
}));
vi.mock('@/lib/email/templates', () => ({
  inviteEmailHtml: vi.fn(() => '<p>html</p>'),
  inviteEmailText: vi.fn(() => 'text'),
}));

describe('TeamService.invite — multi-charter', () => {
  beforeEach(() => vi.clearAllMocks());

  it('stores charter_ids from charterIds and the first as charter_id', async () => {
    const charterA = '11111111-1111-1111-1111-111111111111';
    const charterB = '22222222-2222-2222-2222-222222222222';
    const stub = makeSupabaseStub({
      // No existing profile / membership / invite → invite proceeds.
      'user_profiles.select': { data: null, error: null },
      'organization_members.select': { data: null, error: null },
      'organization_invites.select': { data: null, error: null },
      'organization_invites.insert': {
        data: [{ id: 'invite-1', token: 'tok' }],
        error: null,
      },
    });
    const svc = new TeamService(makeServiceContext(stub.client, { role: 'admin' }));

    await svc.invite({
      email: 'New.User@Example.com',
      role: 'staff',
      organizationName: 'Acme',
      inviterName: 'Boss',
      charterIds: [charterA, charterB],
      warehouseId: '33333333-3333-3333-3333-333333333333',
    });

    const insertArgs = stub.chainArgs.get('organization_invites.insert');
    expect(insertArgs).toBeTruthy();
    const row = firstInsertPayload(insertArgs);
    expect(row.charter_ids).toEqual([charterA, charterB]);
    expect(row.charter_id).toBe(charterA);
    expect(row.email).toBe('new.user@example.com');
  });

  it('falls back to single charterId when charterIds is absent', async () => {
    const charter = '11111111-1111-1111-1111-111111111111';
    const stub = makeSupabaseStub({
      'user_profiles.select': { data: null, error: null },
      'organization_members.select': { data: null, error: null },
      'organization_invites.select': { data: null, error: null },
      'organization_invites.insert': {
        data: [{ id: 'invite-1', token: 'tok' }],
        error: null,
      },
    });
    const svc = new TeamService(makeServiceContext(stub.client, { role: 'admin' }));

    await svc.invite({
      email: 'x@example.com',
      role: 'manager',
      organizationName: 'Acme',
      inviterName: 'Boss',
      charterId: charter,
    });

    const row = firstInsertPayload(
      stub.chainArgs.get('organization_invites.insert'),
    );
    expect(row.charter_ids).toEqual([charter]);
    expect(row.charter_id).toBe(charter);
  });

  it('stores null charter_ids/charter_id when no charters given', async () => {
    const stub = makeSupabaseStub({
      'user_profiles.select': { data: null, error: null },
      'organization_members.select': { data: null, error: null },
      'organization_invites.select': { data: null, error: null },
      'organization_invites.insert': {
        data: [{ id: 'invite-1', token: 'tok' }],
        error: null,
      },
    });
    const svc = new TeamService(makeServiceContext(stub.client, { role: 'admin' }));

    await svc.invite({
      email: 'mgr@example.com',
      role: 'manager',
      organizationName: 'Acme',
      inviterName: 'Boss',
    });

    const row = firstInsertPayload(
      stub.chainArgs.get('organization_invites.insert'),
    );
    expect(row.charter_ids).toBeNull();
    expect(row.charter_id).toBeNull();
  });

  it('forbids non-admins (manager lacks members:invite)', async () => {
    const stub = makeSupabaseStub({});
    const svc = new TeamService(makeServiceContext(stub.client, { role: 'manager' }));
    await expect(
      svc.invite({
        email: 'x@example.com',
        role: 'staff',
        organizationName: 'Acme',
        inviterName: 'Boss',
        warehouseId: '33333333-3333-3333-3333-333333333333',
      }),
    ).rejects.toThrow(/permission/i);
  });
});

describe('TeamService.setMemberCharterAssignments — reconcile', () => {
  beforeEach(() => vi.clearAllMocks());

  const userId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const warehouseId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const charterKeep = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
  const charterDrop = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
  const charterAdd = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

  it('deletes extra charters and inserts missing ones', async () => {
    // Existing rows: keep + drop. Target: keep + add → drop charterDrop,
    // insert charterAdd, charterKeep untouched.
    const existing = [
      { id: 'row-keep', charter_id: charterKeep, is_primary: true },
      { id: 'row-drop', charter_id: charterDrop, is_primary: false },
    ];
    const stub = makeSupabaseStub({
      'organization_members.select': {
        data: [{ user_id: userId }],
        error: null,
      },
      'warehouses.select': { data: [{ id: warehouseId }], error: null },
      'user_warehouse_assignments.select': { data: existing, error: null },
    });
    const svc = new TeamService(makeServiceContext(stub.client, { role: 'admin' }));

    await svc.setMemberCharterAssignments({
      userId,
      warehouseId,
      charterIds: [charterKeep, charterAdd],
    });

    // A delete fired against user_warehouse_assignments.
    const deleteChains = stub.chainsAll.get('user_warehouse_assignments.delete');
    expect(deleteChains).toBeTruthy();
    // The delete scoped to the dropped row id via .in('id', [...]).
    const deleteArgs = stub.chainArgs.get('user_warehouse_assignments.delete');
    const inCall = (deleteArgs as unknown[][]).find((a) => a[0] === 'id');
    expect(inCall?.[1]).toEqual(['row-drop']);

    // An insert fired for the missing charter only.
    const insertArgs = stub.chainArgs.get('user_warehouse_assignments.insert');
    expect(insertArgs).toBeTruthy();
    const insertedRows = firstInsertPayload<Array<Record<string, unknown>>>(insertArgs);
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0]).toMatchObject({
      user_id: userId,
      warehouse_id: warehouseId,
      charter_id: charterAdd,
      organization_id: 'org-test',
    });
  });

  it('empty charterIds collapses to a single all-charters (null) row', async () => {
    // Existing: a specific charter row. Target empty → delete it, insert
    // one null-charter row.
    const existing = [
      { id: 'row-specific', charter_id: charterKeep, is_primary: true },
    ];
    const stub = makeSupabaseStub({
      'organization_members.select': { data: [{ user_id: userId }], error: null },
      'warehouses.select': { data: [{ id: warehouseId }], error: null },
      'user_warehouse_assignments.select': { data: existing, error: null },
    });
    const svc = new TeamService(makeServiceContext(stub.client, { role: 'admin' }));

    await svc.setMemberCharterAssignments({ userId, warehouseId, charterIds: [] });

    const deleteArgs = stub.chainArgs.get('user_warehouse_assignments.delete');
    const inCall = (deleteArgs as unknown[][] | undefined)?.find((a) => a[0] === 'id');
    expect(inCall?.[1]).toEqual(['row-specific']);

    const insertedRows = firstInsertPayload<Array<Record<string, unknown>>>(
      stub.chainArgs.get('user_warehouse_assignments.insert'),
    );
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0]?.charter_id).toBeNull();
  });

  it('no-op when existing rows already match the target set', async () => {
    const existing = [
      { id: 'row-keep', charter_id: charterKeep, is_primary: true },
    ];
    const stub = makeSupabaseStub({
      'organization_members.select': { data: [{ user_id: userId }], error: null },
      'warehouses.select': { data: [{ id: warehouseId }], error: null },
      'user_warehouse_assignments.select': { data: existing, error: null },
    });
    const svc = new TeamService(makeServiceContext(stub.client, { role: 'admin' }));

    await svc.setMemberCharterAssignments({
      userId,
      warehouseId,
      charterIds: [charterKeep],
    });

    // Neither a delete nor an insert should fire — the sets match.
    expect(stub.chainsAll.get('user_warehouse_assignments.delete')).toBeUndefined();
    expect(stub.chainsAll.get('user_warehouse_assignments.insert')).toBeUndefined();
  });

  it('throws validation_error when warehouseId is empty', async () => {
    const stub = makeSupabaseStub({});
    const svc = new TeamService(makeServiceContext(stub.client, { role: 'admin' }));
    await expect(
      svc.setMemberCharterAssignments({ userId, warehouseId: '', charterIds: [] }),
    ).rejects.toThrow(/warehouse is required/i);
  });

  it('forbids non-admins (manager lacks members:invite)', async () => {
    const stub = makeSupabaseStub({});
    const svc = new TeamService(makeServiceContext(stub.client, { role: 'manager' }));
    await expect(
      svc.setMemberCharterAssignments({ userId, warehouseId, charterIds: [] }),
    ).rejects.toThrow(/permission/i);
  });
});

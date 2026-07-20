// apps/web/src/server/services/team.warehouse-access.test.ts
//
// Data-layer coverage for "All warehouses" access (mig 0280):
//   (a) TeamService.invite — staff/viewer must get EITHER a warehouse OR
//       allWarehouses; all-warehouse invites store all_warehouses=true with
//       warehouse_id/charter scoping nulled.
//   (b) acceptInviteWithToken — an all-warehouse invite sets the member flag
//       and inserts one null-charter assignment row per current warehouse
//       (first row primary); a single-warehouse invite still creates exactly
//       one row and does NOT set the flag.
//   (c) TeamService.setMemberWarehouseAccess — All: flag on + rows inserted
//       only for uncovered warehouses; One: flag off + other-warehouse rows
//       deleted + target row ensured with is_primary.
//
// invite/setMemberWarehouseAccess run against the user-scoped (ctx) client;
// acceptInviteWithToken runs on the admin client, which is mocked here via
// `@/lib/supabase/admin` so the whole accept path is unit-testable.
//
// setup.ts globally mocks `@/server/services/audit` (no-op) and calls
// vi.restoreAllMocks() after each test, so mocks are re-armed per test.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

import { acceptInviteWithToken, TeamService } from './team';

import { createAdminClient } from '@/lib/supabase/admin';

// First positional arg of the first recorded call for a (table, op) chain.
function firstInsertPayload<T = Record<string, unknown>>(
  args: unknown[][] | undefined,
): T {
  const call = args?.[0];
  const payload = call?.[0];
  return payload as T;
}

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(),
}));

// Keep invite() from touching the network.
vi.mock('@/lib/email/resend', () => ({
  sendEmail: vi.fn(async () => ({ ok: true, id: 'test' })),
}));
vi.mock('@/lib/email/templates', () => ({
  inviteEmailHtml: vi.fn(() => '<p>html</p>'),
  inviteEmailText: vi.fn(() => 'text'),
}));

const wh1 = '11111111-1111-1111-1111-111111111111';
const wh2 = '22222222-2222-2222-2222-222222222222';
const wh3 = '33333333-3333-3333-3333-333333333333';
const charterA = '44444444-4444-4444-4444-444444444444';
const userId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

describe('TeamService.invite — all-warehouse access', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects staff invites with neither a warehouse nor allWarehouses', async () => {
    const stub = makeSupabaseStub({});
    const svc = new TeamService(makeServiceContext(stub.client, { role: 'admin' }));
    await expect(
      svc.invite({
        email: 'x@example.com',
        role: 'staff',
        organizationName: 'Acme',
        inviterName: 'Boss',
      }),
    ).rejects.toThrow(/warehouse/i);
  });

  it('accepts a viewer invite with allWarehouses and no warehouse', async () => {
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
      email: 'auditor@example.com',
      role: 'viewer',
      organizationName: 'Acme',
      inviterName: 'Boss',
      allWarehouses: true,
    });

    const row = firstInsertPayload(stub.chainArgs.get('organization_invites.insert'));
    expect(row.all_warehouses).toBe(true);
    expect(row.warehouse_id).toBeNull();
  });

  it('all-warehouse invites null out warehouse and charter scoping', async () => {
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
      email: 'staffer@example.com',
      role: 'staff',
      organizationName: 'Acme',
      inviterName: 'Boss',
      allWarehouses: true,
      // Stale UI state must not leak through: charters are warehouse-scoped.
      warehouseId: wh1,
      charterIds: [charterA],
    });

    const row = firstInsertPayload(stub.chainArgs.get('organization_invites.insert'));
    expect(row.all_warehouses).toBe(true);
    expect(row.warehouse_id).toBeNull();
    expect(row.charter_ids).toBeNull();
    expect(row.charter_id).toBeNull();
  });
});

describe('acceptInviteWithToken — all-warehouse invites', () => {
  beforeEach(() => vi.clearAllMocks());

  const futureIso = () => new Date(Date.now() + 86_400_000).toISOString();

  function inviteRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'invite-1',
      organization_id: 'org-1',
      email: 'new@example.com',
      role: 'viewer',
      expires_at: futureIso(),
      accepted_at: null,
      warehouse_id: null,
      charter_id: null,
      charter_ids: null,
      all_warehouses: false,
      invited_by: 'inviter-1',
      ...overrides,
    };
  }

  it('sets the member flag and creates one row per current warehouse (first primary)', async () => {
    const stub = makeSupabaseStub({
      'organization_invites.select': {
        data: [inviteRow({ all_warehouses: true })],
        error: null,
      },
      // Serves both the email match and the default-org check (already set →
      // no update fires).
      'user_profiles.select': {
        data: [{ email: 'new@example.com', default_organization_id: 'org-1' }],
        error: null,
      },
      'warehouses.select': {
        data: [{ id: wh1 }, { id: wh2 }, { id: wh3 }],
        error: null,
      },
      // No pre-existing assignment rows.
      'user_warehouse_assignments.select': { data: null, error: null },
    });
    vi.mocked(createAdminClient).mockReturnValue(stub.client);

    await acceptInviteWithToken('tok', userId);

    // Membership upsert carries the flag.
    const member = firstInsertPayload(stub.chainArgs.get('organization_members.insert'));
    expect(member.all_warehouses).toBe(true);

    // One assignment insert per warehouse; null charter; only the first primary.
    const inserts = stub.chainArgsAll.get('user_warehouse_assignments.insert') ?? [];
    const payloads = inserts.map(
      (args) => args[0]?.[0] as Record<string, unknown>,
    );
    expect(payloads).toHaveLength(3);
    expect(payloads.map((p) => p.warehouse_id)).toEqual([wh1, wh2, wh3]);
    expect(payloads.every((p) => p.charter_id === null)).toBe(true);
    expect(payloads.map((p) => p.is_primary)).toEqual([true, false, false]);
    expect(payloads.every((p) => p.organization_id === 'org-1')).toBe(true);
  });

  it('single-warehouse invites keep today\'s behavior: one row, no flag', async () => {
    const stub = makeSupabaseStub({
      'organization_invites.select': {
        data: [inviteRow({ warehouse_id: wh1 })],
        error: null,
      },
      'user_profiles.select': {
        data: [{ email: 'new@example.com', default_organization_id: 'org-1' }],
        error: null,
      },
      'user_warehouse_assignments.select': { data: null, error: null },
    });
    vi.mocked(createAdminClient).mockReturnValue(stub.client);

    await acceptInviteWithToken('tok', userId);

    const member = firstInsertPayload(stub.chainArgs.get('organization_members.insert'));
    expect(member.all_warehouses).toBeUndefined();

    const inserts = stub.chainArgsAll.get('user_warehouse_assignments.insert') ?? [];
    expect(inserts).toHaveLength(1);
    const payload = inserts[0]?.[0]?.[0] as Record<string, unknown>;
    expect(payload).toMatchObject({ warehouse_id: wh1, is_primary: true });
  });
});

describe('TeamService.setMemberWarehouseAccess — reconcile', () => {
  beforeEach(() => vi.clearAllMocks());

  it('All: flips the flag on and inserts rows only for uncovered warehouses', async () => {
    const stub = makeSupabaseStub({
      'organization_members.select': {
        data: [{ id: 'm1', user_id: userId, all_warehouses: false }],
        error: null,
      },
      'organization_members.update': { data: [{ id: 'm1' }], error: null },
      'warehouses.select': { data: [{ id: wh1 }, { id: wh2 }], error: null },
      // Already covers wh1 (charter-scoped, primary) — must be left alone.
      'user_warehouse_assignments.select': {
        data: [{ id: 'r1', warehouse_id: wh1, is_primary: true }],
        error: null,
      },
    });
    const svc = new TeamService(makeServiceContext(stub.client, { role: 'admin' }));

    await svc.setMemberWarehouseAccess({ userId, allWarehouses: true });

    const flagUpdate = firstInsertPayload(
      stub.chainArgs.get('organization_members.update'),
    );
    expect(flagUpdate).toEqual({ all_warehouses: true });

    // Only wh2 inserted; existing primary respected (new row non-primary);
    // nothing deleted.
    const insertedRows = firstInsertPayload<Array<Record<string, unknown>>>(
      stub.chainArgs.get('user_warehouse_assignments.insert'),
    );
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0]).toMatchObject({
      user_id: userId,
      warehouse_id: wh2,
      charter_id: null,
      is_primary: false,
      organization_id: 'org-test',
    });
    expect(stub.chainsAll.get('user_warehouse_assignments.delete')).toBeUndefined();
  });

  it('One: flips the flag off, deletes other warehouses, ensures the target row', async () => {
    const stub = makeSupabaseStub({
      'organization_members.select': {
        data: [{ id: 'm1', user_id: userId, all_warehouses: true }],
        error: null,
      },
      'organization_members.update': { data: [{ id: 'm1' }], error: null },
      'warehouses.select': { data: [{ id: wh1 }], error: null },
      // No surviving rows at the target → a fresh primary row is inserted.
      'user_warehouse_assignments.select': { data: [], error: null },
    });
    const svc = new TeamService(makeServiceContext(stub.client, { role: 'admin' }));

    await svc.setMemberWarehouseAccess({
      userId,
      allWarehouses: false,
      warehouseId: wh1,
    });

    const flagUpdate = firstInsertPayload(
      stub.chainArgs.get('organization_members.update'),
    );
    expect(flagUpdate).toEqual({ all_warehouses: false });

    // Delete scoped to every OTHER warehouse via .neq('warehouse_id', wh1).
    const deleteArgs = stub.chainArgs.get('user_warehouse_assignments.delete');
    const neqCall = (deleteArgs as unknown[][]).find((a) => a[0] === 'warehouse_id');
    expect(neqCall?.[1]).toBe(wh1);
    const deleteChain = stub.chains.get('user_warehouse_assignments.delete');
    expect(deleteChain).toContain('neq');

    // Target row inserted as the new primary, null charter.
    const inserted = firstInsertPayload(
      stub.chainArgs.get('user_warehouse_assignments.insert'),
    );
    expect(inserted).toMatchObject({
      user_id: userId,
      warehouse_id: wh1,
      charter_id: null,
      is_primary: true,
      organization_id: 'org-test',
    });
  });

  it('throws validation_error when neither all nor a warehouse is given', async () => {
    const stub = makeSupabaseStub({});
    const svc = new TeamService(makeServiceContext(stub.client, { role: 'admin' }));
    await expect(
      svc.setMemberWarehouseAccess({ userId, allWarehouses: false }),
    ).rejects.toThrow(/warehouse/i);
  });

  it('forbids non-admins (manager lacks members:invite)', async () => {
    const stub = makeSupabaseStub({});
    const svc = new TeamService(makeServiceContext(stub.client, { role: 'manager' }));
    await expect(
      svc.setMemberWarehouseAccess({ userId, allWarehouses: true }),
    ).rejects.toThrow(/permission/i);
  });
});

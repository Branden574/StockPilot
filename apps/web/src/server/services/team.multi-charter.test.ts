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

const { ceiling, reportError } = vi.hoisted(() => ({
  // The shared LOOKUP_ROW_CEILING, lowered by the ceiling tests.
  ceiling: { value: 10_000 },
  reportError: vi.fn(async (..._args: unknown[]) => {}),
}));
vi.mock('@/lib/error-reporter', () => ({ reportError }));
// A getter, so a test can lower the ceiling: the service reads the binding on
// every call.
vi.mock('@/server/services/lib/lookup-ceiling', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/services/lib/lookup-ceiling')>()),
  get LOOKUP_ROW_CEILING() {
    return ceiling.value;
  },
}));

import { makeServiceContext, makeSupabaseStub, type MockCall } from '@/test/supabase-mock';

import { sendEmail } from '@/lib/email/resend';

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
// The invite email now renders through the pure es invites family
// (@/lib/email/es/families/invites) — no mock needed; sendEmail above
// keeps the send itself offline.

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

    // Wire-level: the invite email rides the es invitations family —
    // registry hello@ sender, registry subject.
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const emailArg = vi.mocked(sendEmail).mock.calls[0]![0] as {
      to: string | string[];
      subject: string;
      from?: string;
    };
    expect(emailArg.to).toBe('new.user@example.com');
    expect(emailArg.from).toBe('StockPilot <hello@stockpilotusa.com>');
    expect(emailArg.subject).toBe('You’re invited to join Acme on StockPilot');
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
  beforeEach(() => {
    vi.clearAllMocks();
    ceiling.value = 10_000;
  });

  // A save that removes a member's charter first counts the organization's
  // active charters and warehouse charter links (B47 decisions round): both
  // lists the dialog is built from. Under the ceiling here.
  const UNDER_THE_CEILING = {
    'charters.select': { data: null, error: null, count: 3 },
    'warehouse_charters.select': { data: null, error: null, count: 4 },
  };

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
      ...UNDER_THE_CEILING,
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
      ...UNDER_THE_CEILING,
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

/**
 * Team's member Charters dialog is built from ChartersService.list (active
 * charters) and WarehouseChartersService.listPairs (every link), and both stop
 * at LOOKUP_ROW_CEILING (B47 decisions round, 2026-11-01). With either cut, a
 * member's charter the dialog cannot show drops out of its selection, so a
 * save that changed nothing would remove it, or turn a member whose only
 * charters it cannot show into "all charters". So at the ceiling a save that
 * removes a member's charter refuses, before any write.
 */
describe('TeamService.setMemberCharterAssignments at LOOKUP_ROW_CEILING', () => {
  const userId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const warehouseId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const shown = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
  const notShown = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
  const added = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

  beforeEach(() => {
    vi.clearAllMocks();
    ceiling.value = 5;
  });

  function stubWith(
    existing: Array<{ id: string; charter_id: string | null; is_primary: boolean }>,
    counts: { charters: number | Error; links: number | Error },
  ) {
    const writes: MockCall[] = [];
    const counted = (n: number | Error) =>
      n instanceof Error
        ? { data: null, error: { message: n.message } }
        : { data: null, error: null, count: n };
    const stub = makeSupabaseStub({
      'organization_members.select': { data: [{ user_id: userId }], error: null },
      'warehouses.select': { data: [{ id: warehouseId }], error: null },
      'user_warehouse_assignments.select': { data: existing, error: null },
      'user_warehouse_assignments.delete': (call) => {
        writes.push(call);
        return { data: null, error: null };
      },
      'user_warehouse_assignments.insert': (call) => {
        writes.push(call);
        return { data: null, error: null };
      },
      'charters.select': counted(counts.charters),
      'warehouse_charters.select': counted(counts.links),
    });
    return {
      stub,
      writes,
      svc: new TeamService(makeServiceContext(stub.client, { role: 'admin' })),
    };
  }

  const AT_CEILING =
    "This organization has 5 or more charters or warehouse charter links, more than this page can list, so a member's charters cannot be removed here. Nothing was changed.";

  it.each([
    ['the active charters', { charters: 5, links: 2 }],
    ['the warehouse charter links', { charters: 2, links: 5 }],
  ])(
    'a save that drops a charter refuses while %s reach the ceiling, and writes nothing',
    async (_label, counts) => {
      const { svc, writes, stub } = stubWith(
        [
          { id: 'row-shown', charter_id: shown, is_primary: true },
          { id: 'row-not-shown', charter_id: notShown, is_primary: false },
        ],
        counts,
      );

      // What the dialog sends when it could not show notShown.
      await expect(
        svc.setMemberCharterAssignments({ userId, warehouseId, charterIds: [shown] }),
      ).rejects.toMatchObject({ code: 'conflict', message: AT_CEILING });
      expect(writes).toEqual([]);
      // The counts are the dialog's two lists: the organization's active
      // charters, and every link of the organization.
      expect(stub.chainArgs.get('charters.select')).toEqual([
        ['id', { count: 'exact', head: true }],
        ['organization_id', 'org-test'],
        ['status', 'active'],
      ]);
      expect(stub.chainArgs.get('warehouse_charters.select')).toEqual([
        ['charter_id', { count: 'exact', head: true }],
        ['organization_id', 'org-test'],
      ]);
    },
  );

  it('a member whose only charter the dialog could not show is not turned into "all charters"', async () => {
    const { svc, writes } = stubWith(
      [{ id: 'row-not-shown', charter_id: notShown, is_primary: true }],
      { charters: 5, links: 5 },
    );

    await expect(
      svc.setMemberCharterAssignments({ userId, warehouseId, charterIds: [] }),
    ).rejects.toMatchObject({ code: 'conflict', message: AT_CEILING });
    expect(writes).toEqual([]);
  });

  it('a count that fails refuses in plain words and reports the cause', async () => {
    const { svc, writes } = stubWith(
      [
        { id: 'row-shown', charter_id: shown, is_primary: true },
        { id: 'row-not-shown', charter_id: notShown, is_primary: false },
      ],
      { charters: 2, links: new Error('statement timeout') },
    );

    await expect(
      svc.setMemberCharterAssignments({ userId, warehouseId, charterIds: [shown] }),
    ).rejects.toMatchObject({
      code: 'conflict',
      message: "Could not check this organization's charters, so nothing was changed. Try again.",
    });
    expect(writes).toEqual([]);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0]?.[1]).toMatchObject({
      tag: 'team.member_charters.save_check',
      extra: { warehouseId, check: 'links' },
    });
  });

  it('adding a charter goes ahead at the ceiling, with no count', async () => {
    const { svc, writes, stub } = stubWith(
      [{ id: 'row-shown', charter_id: shown, is_primary: true }],
      { charters: 5, links: 5 },
    );

    await svc.setMemberCharterAssignments({ userId, warehouseId, charterIds: [shown, added] });

    expect(writes.map((w) => w.op)).toEqual(['insert']);
    expect(stub.chainsAll.get('charters.select')).toBeUndefined();
  });

  it('narrowing "all charters" to one goes ahead at the ceiling: the dialog hid nothing it had', async () => {
    const { svc, writes } = stubWith([{ id: 'row-all', charter_id: null, is_primary: true }], {
      charters: 5,
      links: 5,
    });

    await svc.setMemberCharterAssignments({ userId, warehouseId, charterIds: [added] });

    expect(writes.map((w) => w.op)).toEqual(['delete', 'insert']);
  });

  it('under the ceiling a save that drops a charter goes ahead', async () => {
    const { svc, writes } = stubWith(
      [
        { id: 'row-shown', charter_id: shown, is_primary: true },
        { id: 'row-not-shown', charter_id: notShown, is_primary: false },
      ],
      { charters: 4, links: 4 },
    );

    await svc.setMemberCharterAssignments({ userId, warehouseId, charterIds: [shown] });

    expect(writes.map((w) => w.op)).toEqual(['delete']);
  });
});

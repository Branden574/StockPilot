import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub } from '@/test/supabase-mock';

/**
 * resolveMaintenanceAudience/notifyMaintenanceEvent are the FIRST readers of
 * effectivePermissions across a WHOLE org's membership + Task 16's
 * notifyAudience map + the 4 pref columns this task adds. Mocks mirror
 * notifications.test.ts's own shape (adminHolder indirection so each test
 * swaps in a fresh canned client) rather than inventing a new pattern.
 *
 * createNotification (./notifications) is deliberately NOT mocked — it runs
 * for REAL against the same admin-client stub, so "calls createNotification
 * once per recipient with the right insert shape" is proven by recording the
 * actual `notifications.insert` calls, not by asserting a mock was invoked
 * with args this test also constructed (anti-tautology).
 */

vi.mock('@/lib/error-reporter', () => ({
  reportError: vi.fn(),
}));

const adminHolder = { client: null as unknown };
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => adminHolder.client,
}));

// Binding constraint 1 — push delivery is the 0028 AFTER-INSERT trigger on
// the notifications table; this module must NEVER call the direct push
// helper. Mocking it and asserting zero calls is the spy proof.
const { notifyUserMock } = vi.hoisted(() => ({ notifyUserMock: vi.fn() }));
vi.mock('@/server/services/push', () => ({
  notifyUser: notifyUserMock,
}));

import { reportError } from '@/lib/error-reporter';

import { notifyMaintenanceEvent, resolveMaintenanceAudience } from './maintenance-notify';

const ORG = 'org-1';

interface Member {
  user_id: string;
  role: 'owner' | 'admin' | 'manager' | 'staff' | 'viewer';
}
interface RoleOverride {
  role: string;
  permission: string;
  granted: boolean;
}
interface UserOverride {
  user_id: string;
  permission: string;
  granted: boolean;
}

/** Builds a fresh admin-client stub wired with every table this module's
 *  audience resolution + createNotification's own gate touch. Only the
 *  pieces a given test cares about need non-default values — everything
 *  else defaults to "nobody muted, nobody disabled". */
function buildAdmin(opts: {
  members?: Member[];
  roleOverrides?: RoleOverride[];
  userOverrides?: UserOverride[];
  notifyAudience?: Record<string, 'all' | 'urgent_only' | 'none'>;
  moduleError?: { message: string } | null;
  membersError?: { message: string } | null;
  prefRows?: Array<Record<string, unknown>>;
  disabledUserIds?: string[];
}) {
  const stub = makeSupabaseStub({
    'organization_members.select': opts.membersError
      ? { data: null, error: opts.membersError }
      : { data: opts.members ?? [], error: null },
    'role_permission_overrides.select': { data: opts.roleOverrides ?? [], error: null },
    'user_permission_overrides.select': { data: opts.userOverrides ?? [], error: null },
    'organization_modules.select': opts.moduleError
      ? { data: null, error: opts.moduleError }
      : { data: { settings: { notifyAudience: opts.notifyAudience ?? {} } }, error: null },
    'notification_preferences.select': { data: opts.prefRows ?? [], error: null },
    // createNotification's own disabled-account gate — every recipient
    // shares this canned response (the mock doesn't filter by id), so a
    // test that needs a SPECIFIC user disabled uses disabledUserIds only
    // for documentation; createNotification's real per-row check happens
    // against whatever this key returns for every .eq('id', userId) call.
    'user_profiles.select': { data: { disabled_at: null }, error: null },
    'notifications.insert': { data: { id: 'notif-x' }, error: null },
  });
  adminHolder.client = stub.client;
  return stub;
}

beforeEach(() => {
  vi.clearAllMocks();
  adminHolder.client = null;
});

describe('resolveMaintenanceAudience — permission resolution (never _notify_recipients)', () => {
  it('permission test 10 (the Andrew case): a VIEWER granted read_all via user_permission_overrides IS included; a staff member with no grants is NOT', async () => {
    buildAdmin({
      members: [
        { user_id: 'andrew', role: 'viewer' },
        { user_id: 'staff-1', role: 'staff' },
      ],
      userOverrides: [{ user_id: 'andrew', permission: 'maintenance_requests:read_all', granted: true }],
      notifyAudience: { andrew: 'all', 'staff-1': 'all' },
    });

    const result = await resolveMaintenanceAudience({
      organizationId: ORG,
      event: 'new_request',
      actorUserId: 'someone-else',
    });

    expect(result).toEqual(['andrew']);
  });

  it('excludes the actor from their own new_request fan-out even though they are otherwise fully eligible', async () => {
    buildAdmin({
      members: [{ user_id: 'admin-1', role: 'admin' }],
      notifyAudience: { 'admin-1': 'all' },
    });

    const result = await resolveMaintenanceAudience({
      organizationId: ORG,
      event: 'new_request',
      actorUserId: 'admin-1',
    });

    expect(result).toEqual([]);
  });

  it("notifyAudience map: 'none' is dropped; 'urgent_only' is dropped for new_request but kept for urgent_request; 'all' is kept for both", async () => {
    buildAdmin({
      members: [
        { user_id: 'u-none', role: 'admin' },
        { user_id: 'u-urgent', role: 'admin' },
        { user_id: 'u-all', role: 'admin' },
      ],
      notifyAudience: { 'u-none': 'none', 'u-urgent': 'urgent_only', 'u-all': 'all' },
    });

    const newRequest = await resolveMaintenanceAudience({
      organizationId: ORG,
      event: 'new_request',
      actorUserId: 'someone-else',
    });
    expect(newRequest).toEqual(['u-all']);

    const urgentRequest = await resolveMaintenanceAudience({
      organizationId: ORG,
      event: 'urgent_request',
      actorUserId: 'someone-else',
    });
    expect(urgentRequest).toEqual(['u-urgent', 'u-all']);
  });

  it('a member absent from the notifyAudience map entirely is treated as None — being authorized to view all requests is not itself an opt-in to being pinged', async () => {
    buildAdmin({
      members: [{ user_id: 'admin-unconfigured', role: 'admin' }],
      notifyAudience: {}, // never configured by the God Admin
    });

    const result = await resolveMaintenanceAudience({
      organizationId: ORG,
      event: 'new_request',
      actorUserId: 'someone-else',
    });

    expect(result).toEqual([]);
  });

  it('pref gate is fail-OPEN: a missing notification_preferences row still notifies', async () => {
    buildAdmin({
      members: [{ user_id: 'admin-1', role: 'admin' }],
      notifyAudience: { 'admin-1': 'all' },
      prefRows: [], // no row at all for admin-1
    });

    const result = await resolveMaintenanceAudience({
      organizationId: ORG,
      event: 'new_request',
      actorUserId: 'someone-else',
    });

    expect(result).toEqual(['admin-1']);
  });

  it('pref gate mutes ONLY on an explicit false on the exact event column', async () => {
    buildAdmin({
      members: [
        { user_id: 'admin-muted', role: 'admin' },
        { user_id: 'admin-not-muted', role: 'admin' },
      ],
      notifyAudience: { 'admin-muted': 'all', 'admin-not-muted': 'all' },
      prefRows: [
        { user_id: 'admin-muted', push_maintenance_new_request: false },
        { user_id: 'admin-not-muted', push_maintenance_new_request: true },
      ],
    });

    const result = await resolveMaintenanceAudience({
      organizationId: ORG,
      event: 'new_request',
      actorUserId: 'someone-else',
    });

    expect(result).toEqual(['admin-not-muted']);
  });

  it('a role-level override can also grant read_all/manage (not only per-user overrides)', async () => {
    buildAdmin({
      members: [{ user_id: 'viewer-1', role: 'viewer' }],
      roleOverrides: [{ role: 'viewer', permission: 'maintenance_requests:manage', granted: true }],
      notifyAudience: { 'viewer-1': 'all' },
    });

    const result = await resolveMaintenanceAudience({
      organizationId: ORG,
      event: 'new_request',
      actorUserId: 'someone-else',
    });

    expect(result).toEqual(['viewer-1']);
  });

  it('never crashes and NEVER silently reports a false "zero recipients" success on a resolution failure — logs via reportError and returns []', async () => {
    buildAdmin({
      members: [{ user_id: 'admin-1', role: 'admin' }],
      membersError: { message: 'connection reset' },
    });

    const result = await resolveMaintenanceAudience({
      organizationId: ORG,
      event: 'new_request',
      actorUserId: 'someone-else',
    });

    expect(result).toEqual([]);
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tag: 'maintenance_notify.resolve_audience' }),
    );
  });

  it('query-shape pin: role/user override reads are scoped to this organization and narrowed to the two maintenance permissions', async () => {
    const stub = buildAdmin({
      members: [{ user_id: 'admin-1', role: 'admin' }],
      notifyAudience: { 'admin-1': 'all' },
    });

    await resolveMaintenanceAudience({ organizationId: ORG, event: 'new_request', actorUserId: 'x' });

    const roleArgs = stub.chainArgs.get('role_permission_overrides.select')!;
    expect(roleArgs).toContainEqual(['organization_id', ORG]);
    expect(roleArgs).toContainEqual(['permission', ['maintenance_requests:read_all', 'maintenance_requests:manage']]);

    const userArgs = stub.chainArgs.get('user_permission_overrides.select')!;
    expect(userArgs).toContainEqual(['organization_id', ORG]);
    expect(userArgs).toContainEqual(['permission', ['maintenance_requests:read_all', 'maintenance_requests:manage']]);

    const memberArgs = stub.chainArgs.get('organization_members.select')!;
    expect(memberArgs).toContainEqual(['organization_id', ORG]);
  });
});

describe('notifyMaintenanceEvent — insert shape, link, and NO push call', () => {
  it('calls createNotification exactly once per resolved recipient, with the exact /dashboard/maintenance/{id} link the Task 18 mobile rewrite rules translate, and never touches push directly', async () => {
    const stub = buildAdmin({
      members: [
        { user_id: 'admin-1', role: 'admin' },
        { user_id: 'admin-2', role: 'admin' },
      ],
      notifyAudience: { 'admin-1': 'all', 'admin-2': 'all' },
    });

    await notifyMaintenanceEvent({
      organizationId: ORG,
      event: 'new_request',
      requestId: 'req-42',
      requestHandle: 'MR-2026-000042',
      subject: 'AC not working',
      actorUserId: 'someone-else',
    });

    const inserts = (stub.chainArgsAll.get('notifications.insert') ?? []).map(
      (callArgs) => callArgs[0]![0] as Record<string, unknown>,
    );
    expect(inserts).toHaveLength(2);
    for (const payload of inserts) {
      expect(payload.link).toBe('/dashboard/maintenance/req-42');
      expect(payload.organization_id).toBe(ORG);
      expect(payload.type).toBe('maintenance_request');
      expect(payload.body).toBe('AC not working');
      expect((payload.metadata as Record<string, unknown>).request_id).toBe('req-42');
      expect((payload.metadata as Record<string, unknown>).event).toBe('new_request');
    }
    const recipientIds = inserts.map((p) => p.user_id).sort();
    expect(recipientIds).toEqual(['admin-1', 'admin-2']);

    // Binding constraint 1 — the spy proof: push is dispatched by the 0028
    // trigger on the insert above, never by a direct call from this module.
    expect(notifyUserMock).not.toHaveBeenCalled();
  });

  it('titles use accurate language: "New maintenance request MR-…" for new_request and "Urgent maintenance request MR-…" for urgent_request', async () => {
    const stub = buildAdmin({
      members: [{ user_id: 'admin-1', role: 'admin' }],
      notifyAudience: { 'admin-1': 'all' },
    });

    await notifyMaintenanceEvent({
      organizationId: ORG,
      event: 'new_request',
      requestId: 'req-1',
      requestHandle: 'MR-2026-000001',
      subject: 'Leaky faucet',
      actorUserId: 'someone-else',
    });
    let insert = stub.chainArgsAll.get('notifications.insert')![0]![0]![0] as Record<string, unknown>;
    expect(insert.title).toBe('New maintenance request MR-2026-000001');

    await notifyMaintenanceEvent({
      organizationId: ORG,
      event: 'urgent_request',
      requestId: 'req-2',
      requestHandle: 'MR-2026-000002',
      subject: 'Gas smell in Room 4',
      actorUserId: 'someone-else',
    });
    insert = stub.chainArgsAll.get('notifications.insert')![1]![0]![0] as Record<string, unknown>;
    expect(insert.title).toBe('Urgent maintenance request MR-2026-000002');
  });

  it('an empty resolved audience never calls createNotification at all', async () => {
    const stub = buildAdmin({
      members: [{ user_id: 'admin-1', role: 'admin' }],
      notifyAudience: {}, // unconfigured -> None
    });

    await notifyMaintenanceEvent({
      organizationId: ORG,
      event: 'new_request',
      requestId: 'req-3',
      requestHandle: 'MR-2026-000003',
      subject: 'x',
      actorUserId: 'someone-else',
    });

    expect(stub.chainsAll.has('notifications.insert')).toBe(false);
    expect(notifyUserMock).not.toHaveBeenCalled();
  });

  it("'assigned' targets a single user, gated by push_maintenance_assigned — fail-open on a missing row", async () => {
    const stub = buildAdmin({ prefRows: [] });

    await notifyMaintenanceEvent({
      organizationId: ORG,
      event: 'assigned',
      requestId: 'req-4',
      requestHandle: 'MR-2026-000004',
      subject: 'Broken chair',
      actorUserId: 'manager-1',
      targetUserId: 'owner-1',
    });

    const inserts = (stub.chainArgsAll.get('notifications.insert') ?? []).map(
      (callArgs) => callArgs[0]![0] as Record<string, unknown>,
    );
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.user_id).toBe('owner-1');
    expect(inserts[0]!.link).toBe('/dashboard/maintenance/req-4');
  });

  it("'assigned' mutes on an explicit push_maintenance_assigned: false", async () => {
    const stub = buildAdmin({
      prefRows: [{ user_id: 'owner-1', push_maintenance_assigned: false }],
    });

    await notifyMaintenanceEvent({
      organizationId: ORG,
      event: 'assigned',
      requestId: 'req-5',
      requestHandle: 'MR-2026-000005',
      subject: 'x',
      actorUserId: 'manager-1',
      targetUserId: 'owner-1',
    });

    expect(stub.chainsAll.has('notifications.insert')).toBe(false);
  });

  it("'photo_rejected' has no pref column to mute — it always reaches the uploader (a direct failure notice about their own action, not a broadcast)", async () => {
    const stub = buildAdmin({
      // Even a row that mutes every OTHER maintenance pref must not touch
      // photo_rejected — there is no push_maintenance_photo_rejected column.
      prefRows: [
        {
          user_id: 'uploader-1',
          push_maintenance_new_request: false,
          push_maintenance_urgent_request: false,
          push_maintenance_assigned: false,
          push_maintenance_draft_reminder: false,
        },
      ],
    });

    await notifyMaintenanceEvent({
      organizationId: ORG,
      event: 'photo_rejected',
      requestId: 'req-6',
      requestHandle: 'MR-2026-000006',
      subject: 'Break room chair',
      actorUserId: 'uploader-1',
      targetUserId: 'uploader-1',
    });

    const inserts = (stub.chainArgsAll.get('notifications.insert') ?? []).map(
      (callArgs) => callArgs[0]![0] as Record<string, unknown>,
    );
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.user_id).toBe('uploader-1');
    expect(inserts[0]!.title).toBe('A photo on MR-2026-000006 could not be saved');
  });

  it("'resolved' targets a single user, gated by push_maintenance_resolved — fail-open on a missing row (Maintenance Resolved, Task 4)", async () => {
    const stub = buildAdmin({ prefRows: [] });

    await notifyMaintenanceEvent({
      organizationId: ORG,
      event: 'resolved',
      requestId: 'req-10',
      requestHandle: 'MR-2026-000010',
      subject: 'Broken chair',
      actorUserId: 'manager-1',
      targetUserId: 'requester-1',
    });

    const inserts = (stub.chainArgsAll.get('notifications.insert') ?? []).map(
      (callArgs) => callArgs[0]![0] as Record<string, unknown>,
    );
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.user_id).toBe('requester-1');
    expect(inserts[0]!.link).toBe('/dashboard/maintenance/req-10');
  });

  it("'resolved' mutes on an explicit push_maintenance_resolved: false — LITERAL column-name pin (EVENT_PREF_KEY.resolved)", async () => {
    const stub = buildAdmin({
      prefRows: [{ user_id: 'requester-1', push_maintenance_resolved: false }],
    });

    await notifyMaintenanceEvent({
      organizationId: ORG,
      event: 'resolved',
      requestId: 'req-11',
      requestHandle: 'MR-2026-000011',
      subject: 'x',
      actorUserId: 'manager-1',
      targetUserId: 'requester-1',
    });

    expect(stub.chainsAll.has('notifications.insert')).toBe(false);
  });

  it("'resolved' is UNAFFECTED by every OTHER maintenance pref being false — proves the column read is push_maintenance_resolved specifically, not an aliased/shared key", async () => {
    const stub = buildAdmin({
      prefRows: [
        {
          user_id: 'requester-1',
          push_maintenance_new_request: false,
          push_maintenance_urgent_request: false,
          push_maintenance_assigned: false,
          push_maintenance_draft_reminder: false,
        },
      ],
    });

    await notifyMaintenanceEvent({
      organizationId: ORG,
      event: 'resolved',
      requestId: 'req-12',
      requestHandle: 'MR-2026-000012',
      subject: 'x',
      actorUserId: 'manager-1',
      targetUserId: 'requester-1',
    });

    const inserts = (stub.chainArgsAll.get('notifications.insert') ?? []).map(
      (callArgs) => callArgs[0]![0] as Record<string, unknown>,
    );
    expect(inserts).toHaveLength(1);
  });

  it('title literal: "Maintenance request MR-2026-000123 marked resolved"', async () => {
    const stub = buildAdmin({});
    await notifyMaintenanceEvent({
      organizationId: ORG,
      event: 'resolved',
      requestId: 'req-13',
      requestHandle: 'MR-2026-000123',
      subject: 'x',
      actorUserId: 'manager-1',
      targetUserId: 'requester-1',
    });
    const insert = stub.chainArgsAll.get('notifications.insert')![0]![0]![0] as Record<string, unknown>;
    expect(insert.title).toBe('Maintenance request MR-2026-000123 marked resolved');
  });

  it('never throws even when the admin client itself is unusable — resolves and reports, does not reject', async () => {
    adminHolder.client = undefined; // createAdminClient() returning something with no .from at all

    await expect(
      notifyMaintenanceEvent({
        organizationId: ORG,
        event: 'new_request',
        requestId: 'req-7',
        requestHandle: 'MR-2026-000007',
        subject: 'x',
        actorUserId: 'someone-else',
      }),
    ).resolves.toBeUndefined();
  });
});

describe('§20 sweep — no false-confirmation language anywhere in this module\'s source', () => {
  it('never claims a send/ticket/notify confirmation this phase cannot make (master brief §20)', () => {
    const here = fileURLToPath(import.meta.url);
    const src = readFileSync(path.join(path.dirname(here), 'maintenance-notify.ts'), 'utf8');

    expect(/\bsent\b/i.test(src)).toBe(false);
    expect(/ticket created/i.test(src)).toBe(false);
    expect(/notified dc4/i.test(src)).toBe(false);
    expect(/andrew notified/i.test(src)).toBe(false);
    expect(/ticket assigned/i.test(src)).toBe(false);
    expect(/email sent/i.test(src)).toBe(false);
    // Maintenance Resolved (GC 4) — this surface's own new forbidden
    // phrases, swept the same way: never claim a Zendesk-side outcome this
    // module cannot observe. T4-M5 mutation target: a titleFor rewrite that
    // slips one of these in must fail this sweep.
    expect(/ticket closed/i.test(src)).toBe(false);
    expect(/ticket resolved/i.test(src)).toBe(false);
    expect(/zendesk/i.test(src)).toBe(false);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { reportError } from '@/lib/error-reporter';
import { makeSupabaseStub, servedLikePostgrest } from '@/test/supabase-mock';

/**
 * createNotification is the ONE insert path for every push + in-app
 * notification in the product (see the doc comment on the function) — the
 * AFTER-INSERT trigger from 0028_push_dispatch.sql fans out to the
 * recipient's push tokens on every row it writes, and it runs as
 * service-role, so it never consulted RLS or `disabled_at` on its own.
 *
 * A user disabled for suspected compromise (account-disable program,
 * migs 0308-0311) kept getting lock-screen push banners carrying PO
 * numbers, low-stock SKUs and deep links, because nothing at this single
 * choke point checked whether the recipient was disabled before inserting.
 *
 * Fixed HERE rather than at each of the ~10 call sites (purchase-orders,
 * order-requests, auto-archive, the daily-briefing/recurring-pos/
 * auto-reorder/schedule-reminders crons, …) because this is the one
 * canonical insert path they all funnel through — one predicate here closes
 * the gap for every current and future caller.
 */

vi.mock('@/lib/error-reporter', () => ({
  reportError: vi.fn(),
}));

const adminHolder = { client: null as unknown };
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => adminHolder.client,
}));

import { createNotification } from './notifications';

beforeEach(() => {
  vi.clearAllMocks();
});

const ACCEPTED_AT = '2026-01-05T00:00:00Z';

/** organization_members as createNotification reads it, answered by the
 *  query's own filters (servedLikePostgrest), so a filter the code leaves out
 *  fails a test instead of being ignored by the stub. Defaults: org-1,
 *  accepted, not an Act-as seat. */
function memberships(
  rows: Array<{
    user_id: string;
    organization_id?: string;
    accepted_at?: string | null;
    impersonation_expires_at?: string | null;
  }>,
) {
  return servedLikePostgrest(
    rows.map((r) => ({
      organization_id: 'org-1',
      accepted_at: ACCEPTED_AT,
      impersonation_expires_at: null,
      ...r,
    })),
  );
}

function baseArgs(userId: string) {
  return {
    organizationId: 'org-1',
    userId,
    type: 'purchase_order.updated',
    title: 'Purchase order updated',
    body: 'PO 1042 was edited (3 item(s)).',
    link: '/dashboard/purchase-orders/po-1',
  };
}

describe('createNotification — disabled accounts', () => {
  it('never inserts a notification row for a disabled recipient', async () => {
    const stub = makeSupabaseStub({
      'user_profiles.select': { data: [{ disabled_at: '2026-07-30T00:00:00Z' }], error: null },
      'organization_members.select': memberships([{ user_id: 'user-disabled' }]),
    });
    adminHolder.client = stub.client;

    const id = await createNotification(baseArgs('user-disabled'));

    expect(id).toBeNull();
    // The real teeth of this test: the insert (and therefore the 0028
    // AFTER-INSERT push trigger) must never fire for a disabled recipient.
    expect(stub.chains.has('notifications.insert')).toBe(false);
  });

  it('still inserts for an active recipient in the same batch', async () => {
    const stub = makeSupabaseStub({
      'user_profiles.select': { data: [{ disabled_at: null }], error: null },
      'organization_members.select': memberships([{ user_id: 'user-active' }]),
      'notifications.insert': { data: { id: 'notif-1' }, error: null },
    });
    adminHolder.client = stub.client;

    const id = await createNotification(baseArgs('user-active'));

    expect(id).toBe('notif-1');
    expect(stub.chains.has('notifications.insert')).toBe(true);
  });

  it('fails CLOSED: a disabled_at read that errors writes nothing (so pushes nothing), and is reported once', async () => {
    // Docket S36 (integrator decision 2026-11-01): an unreadable profile never
    // counts as "not disabled". Best-effort delivery makes a notice dropped on
    // a read error acceptable; a push carrying the organization's data to an
    // account disabled for suspected compromise is not.
    const stub = makeSupabaseStub({
      'user_profiles.select': { data: null, error: { message: 'boom' } },
      'organization_members.select': memberships([{ user_id: 'user-unknown' }]),
      'notifications.insert': { data: { id: 'notif-2' }, error: null },
    });
    adminHolder.client = stub.client;

    const id = await createNotification(baseArgs('user-unknown'));

    expect(id).toBeNull();
    expect(stub.chains.has('notifications.insert')).toBe(false);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(vi.mocked(reportError).mock.calls[0]![1]).toEqual({
      tag: 'notifications.create_disabled_check',
      extra: { userId: 'user-unknown' },
    });
  });
});

/**
 * Docket S36 (review of #440): the database's own notices go only to a
 * current member of the organization (0422, _notify_is_current_member), and
 * the app's notices, all written through this function (the partial hand-over
 * and backorder-shipped notices, the line edits on a pending order and the
 * return events, each addressed to the order's stored requester id), follow
 * the same rule for every caller: an accepted membership of the notice's
 * organization that is not an Act-as seat, read with the account-disable
 * check above through one shared helper (server/lib/current-member.ts), both
 * failing closed.
 */
describe('createNotification — current members of the organization only (docket S36)', () => {
  it('writes nothing for someone removed from the organization, or who left it', async () => {
    const stub = makeSupabaseStub({
      'user_profiles.select': { data: [{ disabled_at: null }], error: null },
      // The organization still has other members; this person is not one.
      'organization_members.select': memberships([{ user_id: 'someone-else' }]),
      'notifications.insert': { data: { id: 'notif-3' }, error: null },
    });
    adminHolder.client = stub.client;

    const id = await createNotification(baseArgs('user-removed'));

    expect(id).toBeNull();
    // No row, so no 0028 push and nothing for the REST API to hand back.
    expect(stub.chains.has('notifications.insert')).toBe(false);
    // Not an error: a former member is an expected recipient to drop.
    expect(reportError).not.toHaveBeenCalled();
  });

  it('writes nothing for a support Act-as seat, or for an invite that was never accepted', async () => {
    for (const row of [
      { user_id: 'user-seat', impersonation_expires_at: '2026-11-01T12:45:00Z' },
      { user_id: 'user-invite', accepted_at: null },
    ]) {
      const stub = makeSupabaseStub({
        'user_profiles.select': { data: [{ disabled_at: null }], error: null },
        'organization_members.select': memberships([row]),
        'notifications.insert': { data: { id: 'notif-4' }, error: null },
      });
      adminHolder.client = stub.client;

      expect(await createNotification(baseArgs(row.user_id))).toBeNull();
      expect(stub.chains.has('notifications.insert')).toBe(false);
    }
  });

  it("a membership of another organization does not count for this organization's notice", async () => {
    const stub = makeSupabaseStub({
      'user_profiles.select': { data: [{ disabled_at: null }], error: null },
      'organization_members.select': memberships([
        { user_id: 'user-elsewhere', organization_id: 'org-2' },
      ]),
      'notifications.insert': { data: { id: 'notif-5' }, error: null },
    });
    adminHolder.client = stub.client;

    expect(await createNotification(baseArgs('user-elsewhere'))).toBeNull();
    expect(stub.chains.has('notifications.insert')).toBe(false);
  });

  it('a membership read that fails writes nothing, and is reported (it never counts as a membership)', async () => {
    const stub = makeSupabaseStub({
      'user_profiles.select': { data: [{ disabled_at: null }], error: null },
      'organization_members.select': {
        data: null,
        error: { message: 'canceling statement due to statement timeout', code: '57014' },
      },
      'notifications.insert': { data: { id: 'notif-6' }, error: null },
    });
    adminHolder.client = stub.client;

    expect(await createNotification(baseArgs('user-unreadable'))).toBeNull();
    expect(stub.chains.has('notifications.insert')).toBe(false);
    const reports = vi
      .mocked(reportError)
      .mock.calls.filter(([, c]) => c?.tag === 'notifications.create_member_check');
    expect(reports).toHaveLength(1);
    expect(reports[0]![1]).toMatchObject({
      extra: { organizationId: 'org-1', userId: 'user-unreadable' },
    });
  });

  it('a current member of any role is written to, once', async () => {
    const stub = makeSupabaseStub({
      'user_profiles.select': { data: [{ disabled_at: null }], error: null },
      'organization_members.select': memberships([
        { user_id: 'user-staff' },
        { user_id: 'user-seat', impersonation_expires_at: '2026-11-01T12:45:00Z' },
      ]),
      'notifications.insert': { data: { id: 'notif-7' }, error: null },
    });
    adminHolder.client = stub.client;

    expect(await createNotification(baseArgs('user-staff'))).toBe('notif-7');
    expect(stub.chainArgsAll.get('notifications.insert')).toHaveLength(1);
    expect(stub.chainArgs.get('notifications.insert')?.[0]?.[0]).toMatchObject({
      organization_id: 'org-1',
      user_id: 'user-staff',
    });
  });
});

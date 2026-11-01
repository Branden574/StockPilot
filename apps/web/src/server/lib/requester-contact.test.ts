import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub, servedLikePostgrest } from '@/test/supabase-mock';

const reportErrorMock = vi.hoisted(() => vi.fn(async (_err: unknown, _ctx: unknown) => {}));
vi.mock('@/lib/error-reporter', () => ({ reportError: reportErrorMock }));

import { requesterEmailOptedOut, resolveRequesterContact } from './requester-contact';

/**
 * The one requester resolver both hand-over paths use (the sign route and the
 * paper path, L94). A member's own order keeps no address on the row
 * (SP-020), so their address is their profile; a requester who deleted their
 * account is never emailed (A3).
 */

const PROFILE = { email: 'reggie@example.org', full_name: 'Reggie Requester' };
const ORG = 'org-1';
const REPORT = { tag: 'orders.test.requester_member_check', orderId: 'ord-1' };

/** organization_members as the current-member read sees it, answered by its
 *  own filters: the requester an accepted, non-seat member of ORG unless told
 *  otherwise. */
function members(
  rows: Array<{
    user_id: string;
    organization_id?: string;
    impersonation_expires_at?: string | null;
  }>,
) {
  return servedLikePostgrest(
    rows.map((r) => ({
      organization_id: ORG,
      accepted_at: '2026-01-05T00:00:00Z',
      impersonation_expires_at: null,
      ...r,
    })),
  );
}

beforeEach(() => vi.clearAllMocks());

describe('resolveRequesterContact', () => {
  it("a member's own order: their profile address and name", async () => {
    const admin = makeSupabaseStub({
      'user_profiles.select.maybeSingle': { data: PROFILE, error: null },
      'organization_members.select.maybeSingle': members([{ user_id: 'user-req' }]),
    });
    await expect(
      resolveRequesterContact(
        admin.client,
        {
          organization_id: ORG,
          requester_user_id: 'user-req',
          requester_name: null,
          requester_email: null,
          requester_deleted_at: null,
        },
        REPORT,
      ),
    ).resolves.toEqual({
      email: 'reggie@example.org',
      name: 'Reggie Requester',
      withheldEmail: null,
    });
  });

  it('an on-behalf-of order: the address it recorded, with no profile or membership read', async () => {
    const admin = makeSupabaseStub({ 'user_profiles.select.maybeSingle': { data: PROFILE, error: null } });
    await expect(
      resolveRequesterContact(
        admin.client,
        {
          organization_id: ORG,
          requester_user_id: null,
          requester_name: 'Guest',
          requester_email: 'guest@example.org',
        },
        REPORT,
      ),
    ).resolves.toEqual({ email: 'guest@example.org', name: 'Guest', withheldEmail: null });
    expect(admin.fromCalls).not.toContain('user_profiles');
    expect(admin.fromCalls).not.toContain('organization_members');
  });

  it('A3: a requester who deleted their account gets no address, even one the order kept', async () => {
    const admin = makeSupabaseStub({ 'user_profiles.select.maybeSingle': { data: PROFILE, error: null } });
    await expect(
      resolveRequesterContact(
        admin.client,
        {
          organization_id: ORG,
          requester_user_id: null,
          requester_name: 'Kept',
          requester_email: 'kept@example.org',
          requester_deleted_at: '2026-10-04T12:00:00.000Z',
        },
        REPORT,
      ),
    ).resolves.toEqual({ email: null, name: null, withheldEmail: null });
    expect(admin.fromCalls).toEqual([]);
  });

  it('a profile read that throws: no address (the in-app notice still goes)', async () => {
    const admin = makeSupabaseStub();
    admin.client.from = () => {
      throw new Error('network');
    };
    await expect(
      resolveRequesterContact(
        admin.client,
        {
          organization_id: ORG,
          requester_user_id: 'user-req',
          requester_name: 'Col',
          requester_email: null,
        },
        REPORT,
      ),
    ).resolves.toEqual({ email: null, name: 'Col', withheldEmail: null });
  });
});

/**
 * Docket S36 (integrator decision 2026-11-01, with its precision): an address
 * taken from a member's OWN profile (the order kept none: requester_email
 * NULL, requester_user_id set) is used only while they are a current member of
 * the order's organization: an accepted membership, not an Act-as seat, on an
 * account that is not disabled (0422's _notify_is_current_member). An address
 * the order recorded for an outside person is sent as before, whoever placed
 * the order. Before, a member removed from the organization, or who left it,
 * kept getting the hand-over emails about their old orders at their own
 * address (order-handover-notify.ts :139, :210, :282, and the sign route's
 * completion receipt), while 0422 and createNotification stopped every notice
 * and push to them.
 */
describe("resolveRequesterContact: a member's own address follows the current-member rule (S36)", () => {
  const OWN_ORDER = {
    organization_id: ORG,
    requester_user_id: 'user-req',
    requester_name: null,
    requester_email: null,
    requester_deleted_at: null,
  };

  it('a requester removed from the organization, or who left it: no address; the withheld one is named for the caller', async () => {
    const admin = makeSupabaseStub({
      'user_profiles.select.maybeSingle': { data: PROFILE, error: null },
      // The organization still has members; the requester is not one.
      'organization_members.select.maybeSingle': members([{ user_id: 'someone-else' }]),
    });
    await expect(resolveRequesterContact(admin.client, OWN_ORDER, REPORT)).resolves.toEqual({
      email: null,
      name: 'Reggie Requester',
      withheldEmail: 'reggie@example.org',
    });
    // An expected recipient to drop, not an error.
    expect(reportErrorMock).not.toHaveBeenCalled();
  });

  it("a membership of another organization does not count for this order's emails", async () => {
    const admin = makeSupabaseStub({
      'user_profiles.select.maybeSingle': { data: PROFILE, error: null },
      'organization_members.select.maybeSingle': members([
        { user_id: 'user-req', organization_id: 'org-2' },
      ]),
    });
    await expect(resolveRequesterContact(admin.client, OWN_ORDER, REPORT)).resolves.toMatchObject({
      email: null,
      withheldEmail: 'reggie@example.org',
    });
  });

  it("a support Act-as seat's or a disabled account's own address is withheld too", async () => {
    const seat = makeSupabaseStub({
      'user_profiles.select.maybeSingle': { data: PROFILE, error: null },
      'organization_members.select.maybeSingle': members([
        { user_id: 'user-req', impersonation_expires_at: '2026-11-01T12:45:00Z' },
      ]),
    });
    const disabled = makeSupabaseStub({
      'user_profiles.select.maybeSingle': {
        data: { ...PROFILE, disabled_at: '2026-10-01T00:00:00Z' },
        error: null,
      },
      'organization_members.select.maybeSingle': members([{ user_id: 'user-req' }]),
    });
    for (const admin of [seat, disabled]) {
      await expect(resolveRequesterContact(admin.client, OWN_ORDER, REPORT)).resolves.toMatchObject(
        {
          email: null,
          withheldEmail: 'reggie@example.org',
        },
      );
    }
  });

  it('a membership read that fails: no address (fail closed), reported once under the caller tag', async () => {
    const admin = makeSupabaseStub({
      'user_profiles.select.maybeSingle': { data: PROFILE, error: null },
      'organization_members.select.maybeSingle': {
        data: null,
        error: { message: 'connection reset' },
      },
    });
    await expect(resolveRequesterContact(admin.client, OWN_ORDER, REPORT)).resolves.toEqual({
      email: null,
      name: 'Reggie Requester',
      withheldEmail: 'reggie@example.org',
    });
    expect(reportErrorMock).toHaveBeenCalledTimes(1);
    expect(reportErrorMock.mock.calls[0]![1]).toEqual(
      expect.objectContaining({
        tag: 'orders.test.requester_member_check',
        extra: expect.objectContaining({
          orderId: 'ord-1',
          organizationId: ORG,
          userId: 'user-req',
        }),
      }),
    );
  });

  it('an address the order recorded is sent as before whoever placed it: a portal order carries its buyer, never a member', async () => {
    // portal.ts writes requester_user_id = the buyer's sign-in and
    // requester_email = the buyer's address on every portal order. The buyer
    // is a customer, not a member, and their address is the order's own.
    const admin = makeSupabaseStub({
      'user_profiles.select.maybeSingle': { data: PROFILE, error: null },
      'organization_members.select.maybeSingle': members([]),
    });
    await expect(
      resolveRequesterContact(
        admin.client,
        {
          organization_id: ORG,
          requester_user_id: 'portal-buyer',
          requester_name: 'Buyer Example',
          requester_email: 'buyer@example.com',
          requester_deleted_at: null,
        },
        REPORT,
      ),
    ).resolves.toEqual({ email: 'buyer@example.com', name: 'Buyer Example', withheldEmail: null });
    expect(admin.fromCalls).not.toContain('organization_members');
  });
});

describe('requesterEmailOptedOut', () => {
  const report = { tag: 'orders.test.pref_read', orderId: 'ord-1' };

  it('an external requester cannot opt out (no read)', async () => {
    const admin = makeSupabaseStub();
    await expect(requesterEmailOptedOut(admin.client, null, report)).resolves.toBe(false);
    expect(admin.fromCalls).toEqual([]);
  });

  it("reads the member's preference: muted, on, or no row (on by default)", async () => {
    const muted = makeSupabaseStub({
      'notification_preferences.select.maybeSingle': { data: { email_order_completed: false }, error: null },
    });
    const on = makeSupabaseStub({
      'notification_preferences.select.maybeSingle': { data: { email_order_completed: true }, error: null },
    });
    const none = makeSupabaseStub({ 'notification_preferences.select.maybeSingle': { data: null, error: null } });
    await expect(requesterEmailOptedOut(muted.client, 'user-req', report)).resolves.toBe(true);
    await expect(requesterEmailOptedOut(on.client, 'user-req', report)).resolves.toBe(false);
    await expect(requesterEmailOptedOut(none.client, 'user-req', report)).resolves.toBe(false);
    expect(reportErrorMock).not.toHaveBeenCalled();
  });

  it('a failed read counts as opted out and is reported under the caller tag', async () => {
    const admin = makeSupabaseStub({
      'notification_preferences.select.maybeSingle': { data: null, error: { message: 'boom' } },
    });
    await expect(requesterEmailOptedOut(admin.client, 'user-req', report)).resolves.toBe(true);
    expect(reportErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'boom' }),
      expect.objectContaining({ tag: 'orders.test.pref_read', extra: { orderId: 'ord-1' } }),
    );
  });
});

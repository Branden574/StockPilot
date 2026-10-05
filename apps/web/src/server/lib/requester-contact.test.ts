import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub } from '@/test/supabase-mock';

const reportErrorMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/lib/error-reporter', () => ({ reportError: reportErrorMock }));

import { requesterEmailOptedOut, resolveRequesterContact } from './requester-contact';

/**
 * The one requester resolver both hand-over paths use (the sign route and the
 * paper path, L94). A member's own order keeps no address on the row
 * (SP-020), so their address is their profile; a requester who deleted their
 * account is never emailed (A3).
 */

const PROFILE = { email: 'reggie@example.org', full_name: 'Reggie Requester' };

beforeEach(() => vi.clearAllMocks());

describe('resolveRequesterContact', () => {
  it("a member's own order: their profile address and name", async () => {
    const admin = makeSupabaseStub({ 'user_profiles.select.maybeSingle': { data: PROFILE, error: null } });
    await expect(
      resolveRequesterContact(admin.client, {
        requester_user_id: 'user-req',
        requester_name: null,
        requester_email: null,
        requester_deleted_at: null,
      }),
    ).resolves.toEqual({ email: 'reggie@example.org', name: 'Reggie Requester' });
  });

  it('an on-behalf-of order: the address it recorded, with no profile read', async () => {
    const admin = makeSupabaseStub({ 'user_profiles.select.maybeSingle': { data: PROFILE, error: null } });
    await expect(
      resolveRequesterContact(admin.client, {
        requester_user_id: null,
        requester_name: 'Guest',
        requester_email: 'guest@example.org',
      }),
    ).resolves.toEqual({ email: 'guest@example.org', name: 'Guest' });
    expect(admin.fromCalls).not.toContain('user_profiles');
  });

  it('A3: a requester who deleted their account gets no address, even one the order kept', async () => {
    const admin = makeSupabaseStub({ 'user_profiles.select.maybeSingle': { data: PROFILE, error: null } });
    await expect(
      resolveRequesterContact(admin.client, {
        requester_user_id: null,
        requester_name: 'Kept',
        requester_email: 'kept@example.org',
        requester_deleted_at: '2026-10-04T12:00:00.000Z',
      }),
    ).resolves.toEqual({ email: null, name: null });
    expect(admin.fromCalls).toEqual([]);
  });

  it('a profile read that throws: no address (the in-app notice still goes)', async () => {
    const admin = makeSupabaseStub();
    admin.client.from = () => {
      throw new Error('network');
    };
    await expect(
      resolveRequesterContact(admin.client, {
        requester_user_id: 'user-req',
        requester_name: 'Col',
        requester_email: null,
      }),
    ).resolves.toEqual({ email: null, name: 'Col' });
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

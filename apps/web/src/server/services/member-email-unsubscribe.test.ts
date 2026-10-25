import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub, type SupabaseStub } from '@/test/supabase-mock';

/**
 * What a verified one-click link does (B15). The link has already proved who
 * it names (lib/email/member-unsubscribe.ts); this decides whether that still
 * stands and what changes:
 *   - only a real member of the organization the link names: accepted, not a
 *     platform admin's act-as grant. A removed member's link changes nothing;
 *   - the switch the signed-in Notifications page shows, written by the same
 *     function the page's own action uses, for that member's row only;
 *   - idempotent: a second use writes and audits nothing;
 *   - a failed read or write throws, so the page answers 500 and a mail
 *     provider retries its one-click POST instead of counting it done.
 */

// insertAuditRowReported is a vi.fn (src/test/setup.ts). The row is handed to
// it synchronously and written after the response, so the call is the row.
const adminHolder = { client: null as unknown };
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => adminHolder.client }));

import { insertAuditRowReported } from './audit';
import { unsubscribeMemberEmail } from './member-email-unsubscribe';

const MEMBER = '00000000-0000-4000-8000-0000000000a1';
const ORG = '00000000-0000-4000-8000-00000000c0c0';
const META = { ip: '203.0.113.7', userAgent: 'Mail provider' };
const DIGEST = { userId: MEMBER, organizationId: ORG, kind: 'weekly_digest' as const };
const REMINDERS = { userId: MEMBER, organizationId: ORG, kind: 'schedule_reminders' as const };

function stubWith(results: Parameters<typeof makeSupabaseStub>[0]): SupabaseStub {
  const stub = makeSupabaseStub({
    'organization_members.select': { data: [{ user_id: MEMBER }], error: null },
    ...results,
  });
  adminHolder.client = stub.client;
  return stub;
}

const auditRows = () => vi.mocked(insertAuditRowReported).mock.calls.map((call) => call[0]);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('unsubscribeMemberEmail: the weekly digest', () => {
  it("turns off the member's digest switch with the settings page's own write, and audits it", async () => {
    const stub = stubWith({
      'user_profiles.select': { data: [{ email_digest_optin: true }], error: null },
    });

    await expect(unsubscribeMemberEmail(stub.client, DIGEST, META)).resolves.toBe('unsubscribed');

    expect(stub.chains.get('user_profiles.update')).toEqual(['update', 'eq']);
    expect(stub.chainArgs.get('user_profiles.update')).toEqual([
      [{ email_digest_optin: false }],
      ['id', MEMBER],
    ]);
    expect(auditRows()).toEqual([
      {
        organization_id: ORG,
        user_id: MEMBER,
        event: 'notification_preference.updated',
        ip: META.ip,
        user_agent: META.userAgent,
        metadata: {
          entity_type: 'user',
          entity_id: MEMBER,
          warehouse_id: null,
          before: { email_digest_optin: true },
          after: { email_digest_optin: false },
          reason: null,
          changed_keys: ['email_digest_optin'],
          surface: 'email_unsubscribe_link',
          email_kind: 'weekly_digest',
        },
      },
    ]);
  });

  it('is idempotent: a digest already off is left alone, with no write and no audit row', async () => {
    const stub = stubWith({
      'user_profiles.select': { data: [{ email_digest_optin: false }], error: null },
    });
    await expect(unsubscribeMemberEmail(stub.client, DIGEST, META)).resolves.toBe(
      'already_unsubscribed',
    );
    expect(stub.chains.get('user_profiles.update')).toBeUndefined();
    expect(auditRows()).toEqual([]);
  });

  it('a deleted account changes nothing', async () => {
    const stub = stubWith({
      'organization_members.select': { data: [], error: null },
      'user_profiles.select': { data: [], error: null },
    });
    await expect(unsubscribeMemberEmail(stub.client, DIGEST, META)).resolves.toBe('not_member');
    expect(stub.fromCalls).toEqual(['organization_members']);
  });
});

describe('unsubscribeMemberEmail: schedule reminder emails', () => {
  it('turns off the email switch only (push reminders stay on), upserting on user_id as the settings page does', async () => {
    const stub = stubWith({
      'notification_preferences.select': {
        data: [{ email_schedule_reminders: true }],
        error: null,
      },
    });

    await expect(unsubscribeMemberEmail(stub.client, REMINDERS, META)).resolves.toBe(
      'unsubscribed',
    );

    expect(stub.chainArgs.get('notification_preferences.insert')).toEqual([
      [{ user_id: MEMBER, email_schedule_reminders: false }, { onConflict: 'user_id' }],
    ]);
    expect(auditRows()).toEqual([
      expect.objectContaining({
        organization_id: ORG,
        user_id: MEMBER,
        event: 'notification_preference.updated',
        metadata: expect.objectContaining({
          before: { email_schedule_reminders: true },
          after: { email_schedule_reminders: false },
          changed_keys: ['email_schedule_reminders'],
          email_kind: 'schedule_reminders',
        }),
      }),
    ]);
  });

  it('a member with no preferences row yet gets one with the email switch off (every column defaults on)', async () => {
    const stub = stubWith({ 'notification_preferences.select': { data: [], error: null } });
    await expect(unsubscribeMemberEmail(stub.client, REMINDERS, META)).resolves.toBe(
      'unsubscribed',
    );
    expect(stub.chainArgs.get('notification_preferences.insert')?.[0]).toEqual([
      { user_id: MEMBER, email_schedule_reminders: false },
      { onConflict: 'user_id' },
    ]);
    expect(auditRows()[0]).toMatchObject({
      metadata: { before: { email_schedule_reminders: true } },
    });
  });

  it('is idempotent: reminder emails already off are left alone, with no write and no audit row', async () => {
    const stub = stubWith({
      'notification_preferences.select': {
        data: [{ email_schedule_reminders: false }],
        error: null,
      },
    });
    await expect(unsubscribeMemberEmail(stub.client, REMINDERS, META)).resolves.toBe(
      'already_unsubscribed',
    );
    expect(stub.chainArgs.get('notification_preferences.insert')).toBeUndefined();
    expect(auditRows()).toEqual([]);
  });
});

describe('unsubscribeMemberEmail: only a real member of the organization the link names', () => {
  it.each([DIGEST, REMINDERS])(
    'a removed member ($kind) changes nothing: no preference is read or written',
    async (claim) => {
      const stub = stubWith({ 'organization_members.select': { data: [], error: null } });
      await expect(unsubscribeMemberEmail(stub.client, claim, META)).resolves.toBe('not_member');
      expect(stub.fromCalls).toEqual(['organization_members']);
    },
  );

  it("reads the membership in the link's organization, for the link's member, accepted and not an act-as grant", async () => {
    const stub = stubWith({
      'user_profiles.select': { data: [{ email_digest_optin: true }], error: null },
    });
    await unsubscribeMemberEmail(stub.client, DIGEST, META);
    expect(stub.chains.get('organization_members.select')).toEqual([
      'select',
      'eq',
      'eq',
      'not',
      'is',
    ]);
    expect(stub.chainArgs.get('organization_members.select')).toEqual([
      ['user_id'],
      ['organization_id', ORG],
      ['user_id', MEMBER],
      ['accepted_at', 'is', null],
      ['impersonation_expires_at', null],
    ]);
    // Every later read and write names the same member, never another row.
    expect(stub.chainArgs.get('user_profiles.select')).toEqual([
      ['email_digest_optin'],
      ['id', MEMBER],
    ]);
  });

  it('a failed membership read throws and changes nothing (the page answers 500)', async () => {
    const stub = stubWith({
      'organization_members.select': { data: null, error: { message: 'boom' } },
    });
    await expect(unsubscribeMemberEmail(stub.client, DIGEST, META)).rejects.toThrow();
    expect(stub.fromCalls).toEqual(['organization_members']);
  });

  it('a failed write throws and writes no audit row', async () => {
    const stub = stubWith({
      'user_profiles.select': { data: [{ email_digest_optin: true }], error: null },
      'user_profiles.update': { data: null, error: { message: 'boom' } },
    });
    await expect(unsubscribeMemberEmail(stub.client, DIGEST, META)).rejects.toThrow();
    expect(auditRows()).toEqual([]);
  });

  it('a failed preference read throws and writes nothing', async () => {
    const stub = stubWith({
      'notification_preferences.select': { data: null, error: { message: 'boom' } },
    });
    await expect(unsubscribeMemberEmail(stub.client, REMINDERS, META)).rejects.toThrow();
    expect(stub.chainArgs.get('notification_preferences.insert')).toBeUndefined();
  });
});

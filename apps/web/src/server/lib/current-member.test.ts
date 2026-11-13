import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub, servedLikePostgrest, type QueryResult } from '@/test/supabase-mock';

const reportErrorMock = vi.hoisted(() => vi.fn(async (_err: unknown, _ctx: unknown) => {}));
vi.mock('@/lib/error-reporter', () => ({ reportError: reportErrorMock }));

import { ownAddressVerdict, readCurrentMember } from './current-member';

/**
 * Docket S36: the one current-member rule the app applies before it tells a
 * person anything about an organization's records (in-app notices, pushes, and
 * emails to a member's own address). It is the rule of 0422's
 * _notify_is_current_member: an accepted membership of the organization that
 * is not a support Act-as seat, on an account that is not disabled. Both reads
 * are answered by their own filters (servedLikePostgrest), so a filter the
 * helper leaves out fails a test instead of being ignored by the stub.
 */

const ORG = 'org-1';
const ACCEPTED_AT = '2026-01-05T00:00:00Z';
const READ_ERROR = { message: 'canceling statement due to statement timeout', code: '57014' };

interface MemberRow {
  user_id: string;
  organization_id?: string;
  accepted_at?: string | null;
  impersonation_expires_at?: string | null;
}

function world(opts: {
  members?: MemberRow[];
  disabled?: string[];
  membershipRead?: QueryResult;
  profileRead?: QueryResult;
}) {
  const members = (opts.members ?? []).map((r) => ({
    organization_id: ORG,
    accepted_at: ACCEPTED_AT,
    impersonation_expires_at: null,
    ...r,
  }));
  const profiles = [
    'user-1',
    'user-2',
    'user-seat',
    'user-invite',
    'user-elsewhere',
    'user-off',
  ].map((id) => ({
    id,
    disabled_at: (opts.disabled ?? []).includes(id) ? '2026-10-01T00:00:00Z' : null,
  }));
  return makeSupabaseStub({
    'organization_members.select': opts.membershipRead ?? servedLikePostgrest(members),
    'user_profiles.select': opts.profileRead ?? servedLikePostgrest(profiles),
  });
}

beforeEach(() => vi.clearAllMocks());

describe('readCurrentMember', () => {
  it('an accepted member of the organization, not a seat, not disabled: current', async () => {
    const stub = world({ members: [{ user_id: 'user-1' }] });
    await expect(readCurrentMember(stub.client, ORG, 'user-1')).resolves.toEqual({
      readable: true,
      current: true,
    });
  });

  it('someone removed from the organization, or who left it (other members remain): not current', async () => {
    const stub = world({ members: [{ user_id: 'user-2' }] });
    await expect(readCurrentMember(stub.client, ORG, 'user-1')).resolves.toEqual({
      readable: true,
      current: false,
    });
  });

  it('a support Act-as seat, or an invite never accepted: not current', async () => {
    const stub = world({
      members: [
        { user_id: 'user-seat', impersonation_expires_at: '2026-11-01T12:45:00Z' },
        { user_id: 'user-invite', accepted_at: null },
      ],
    });
    await expect(readCurrentMember(stub.client, ORG, 'user-seat')).resolves.toEqual({
      readable: true,
      current: false,
    });
    await expect(readCurrentMember(stub.client, ORG, 'user-invite')).resolves.toEqual({
      readable: true,
      current: false,
    });
  });

  it("a membership of another organization does not count for this organization's records", async () => {
    const stub = world({ members: [{ user_id: 'user-elsewhere', organization_id: 'org-2' }] });
    await expect(readCurrentMember(stub.client, ORG, 'user-elsewhere')).resolves.toEqual({
      readable: true,
      current: false,
    });
  });

  it('a disabled account is not current, even with an accepted membership', async () => {
    const stub = world({ members: [{ user_id: 'user-off' }], disabled: ['user-off'] });
    await expect(readCurrentMember(stub.client, ORG, 'user-off')).resolves.toEqual({
      readable: true,
      current: false,
    });
  });

  it('a membership read that fails is unreadable, never a membership', async () => {
    const stub = world({ membershipRead: { data: null, error: READ_ERROR } });
    await expect(readCurrentMember(stub.client, ORG, 'user-1')).resolves.toEqual({
      readable: false,
      failures: [
        { read: 'membership', error: expect.objectContaining({ message: READ_ERROR.message }) },
      ],
    });
  });

  it('a membership read that answers no list (an empty body) is unreadable, never "not a member"', async () => {
    const stub = world({ membershipRead: { data: null, error: null } });
    await expect(readCurrentMember(stub.client, ORG, 'user-1')).resolves.toEqual({
      readable: false,
      failures: [{ read: 'membership', error: expect.objectContaining({ name: 'ListReadError' }) }],
    });
  });

  it('a profile read that answers no list (an empty body) is unreadable, never "not disabled"', async () => {
    const stub = world({
      members: [{ user_id: 'user-1' }],
      profileRead: { data: null, error: null },
    });
    await expect(readCurrentMember(stub.client, ORG, 'user-1')).resolves.toEqual({
      readable: false,
      failures: [{ read: 'profile', error: expect.objectContaining({ name: 'ListReadError' }) }],
    });
  });

  it('a profile read that fails is unreadable, never "not disabled"', async () => {
    const stub = world({
      members: [{ user_id: 'user-1' }],
      profileRead: { data: null, error: READ_ERROR },
    });
    await expect(readCurrentMember(stub.client, ORG, 'user-1')).resolves.toEqual({
      readable: false,
      failures: [
        { read: 'profile', error: expect.objectContaining({ message: READ_ERROR.message }) },
      ],
    });
  });
});

describe("ownAddressVerdict (an email to a member's own address)", () => {
  const report = { tag: 'orders.test.requester_member_check', extra: { orderId: 'ord-1' } };

  it('no person (an account deleted since): not current, with no read and no report', async () => {
    const stub = world({ members: [{ user_id: 'user-1' }] });
    await expect(
      ownAddressVerdict(stub.client, { organizationId: ORG, userId: null }, report),
    ).resolves.toBe('not_current');
    expect(stub.fromCalls).toEqual([]);
    expect(reportErrorMock).not.toHaveBeenCalled();
  });

  it('a current member: current; a former member: not current; neither is reported', async () => {
    const stub = world({ members: [{ user_id: 'user-1' }] });
    await expect(
      ownAddressVerdict(stub.client, { organizationId: ORG, userId: 'user-1' }, report),
    ).resolves.toBe('current');
    await expect(
      ownAddressVerdict(stub.client, { organizationId: ORG, userId: 'user-2' }, report),
    ).resolves.toBe('not_current');
    expect(reportErrorMock).not.toHaveBeenCalled();
  });

  it('a read that fails: unreadable, reported once under the caller tag', async () => {
    const stub = world({
      members: [{ user_id: 'user-1' }],
      profileRead: { data: null, error: READ_ERROR },
    });
    await expect(
      ownAddressVerdict(stub.client, { organizationId: ORG, userId: 'user-1' }, report),
    ).resolves.toBe('unreadable');
    expect(reportErrorMock).toHaveBeenCalledTimes(1);
    expect(reportErrorMock.mock.calls[0]![1]).toEqual({
      tag: 'orders.test.requester_member_check',
      level: 'warning',
      extra: { orderId: 'ord-1', organizationId: ORG, userId: 'user-1' },
    });
  });

  it('a profile read that answers no list: unreadable, reported once, never "current"', async () => {
    const stub = world({
      members: [{ user_id: 'user-1' }],
      profileRead: { data: null, error: null },
    });
    await expect(
      ownAddressVerdict(stub.client, { organizationId: ORG, userId: 'user-1' }, report),
    ).resolves.toBe('unreadable');
    expect(reportErrorMock).toHaveBeenCalledTimes(1);
    expect(reportErrorMock.mock.calls[0]![0]).toMatchObject({
      message: expect.stringContaining('profile read: user_profiles answered no list'),
    });
  });

  it('a read that throws: unreadable, reported once', async () => {
    const stub = makeSupabaseStub();
    stub.client.from = () => {
      throw new Error('network');
    };
    await expect(
      ownAddressVerdict(stub.client, { organizationId: ORG, userId: 'user-1' }, report),
    ).resolves.toBe('unreadable');
    expect(reportErrorMock).toHaveBeenCalledTimes(1);
    expect(reportErrorMock.mock.calls[0]![0]).toMatchObject({ message: 'network' });
  });
});

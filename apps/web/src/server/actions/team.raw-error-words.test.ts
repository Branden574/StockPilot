import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * TEAM ACTIONS NEVER ANSWER THE DATABASE'S OR THE SIGN-IN SERVICE'S TEXT (S31).
 *
 * A Server Action's result reaches the browser as it is. The member reset,
 * the ownership transfer and the invite sign-up answered Postgres or GoTrue
 * text (several reads use the service-role client, where row-level security
 * does not apply), the transfer function's own RAISE text, and, without the
 * service-role key, the setting's name. None of it was reported. Now the
 * transfer's refusals say the action's own sentences, a failure it did not
 * expect says the fixed sentence with the text in the report, and the missing
 * key says the feature is not set up.
 *
 * Not here: the invite sign-up's password rule and the createUser refusal
 * (docket D3a takes both with its own tests).
 */

const h = vi.hoisted(() => ({
  adminClient: null as unknown,
  keyMissing: false,
  ctx: null as unknown,
}));

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(() => {
    if (h.keyMissing) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not configured');
    return h.adminClient;
  }),
}));
const signInWithPassword = vi.fn(async (_creds: unknown) => ({ data: {}, error: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { signInWithPassword } })),
}));
vi.mock('@/lib/auth/session', () => ({
  requireSession: vi.fn(async () => ({
    userId: 'owner-user',
    email: 'owner@example.test',
    fullName: null,
    avatarUrl: null,
    defaultOrganizationId: null,
  })),
}));
vi.mock('@/lib/auth/mfa-factors', () => ({
  readMfaFactorList: vi.fn(async () => ({ all: [] })),
  factorsOf: vi.fn(() => []),
}));
vi.mock('@/server/services/team', () => ({
  TeamService: { forCurrentUser: vi.fn() },
  acceptInviteWithToken: vi.fn(async () => ({ organizationId: 'org-1' })),
}));
vi.mock('@/server/services/context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/services/context')>()),
  withContext: vi.fn(async () => h.ctx),
  assertPermission: vi.fn(),
  assertCurrentAal2: vi.fn(async () => {}),
}));
vi.mock('@/server/services/audit', () => ({ audit: vi.fn(async () => {}) }));
vi.mock('@/lib/auth/password-reset-email', () => ({
  sendPasswordResetEmail: vi.fn(async () => true),
}));
vi.mock('@/lib/auth/verify-password', () => ({
  verifyPasswordSideChannel: vi.fn(async () => ({ ok: true })),
}));
vi.mock('@/lib/auth/platform-admin', () => ({ isPlatformAdmin: vi.fn(() => false) }));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, remaining: 4, resetAt: Date.now() + 1 })),
}));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { reportError } from '@/lib/error-reporter';
import { makeSupabaseStub, type QueryResult } from '@/test/supabase-mock';

import {
  acceptInviteWithSignupAction,
  sendMemberPasswordResetAction,
  transferOwnershipAction,
} from './team';

const UNEXPECTED = { code: 'internal_error', message: 'Something went wrong. Please try again.' };
const TARGET_MEMBER_ID = 'bbbbbbbb-2222-4222-8222-222222222222';
const TARGET_USER_ID = '33333333-3333-4333-8333-333333333333';
const MEMBER_USER_ID = '55555555-5555-4555-8555-555555555555';
const TOKEN = 'invite-token-member-01';

/** The single report's error text and context. */
function reported(): { text: string; context: unknown } {
  expect(reportError).toHaveBeenCalledTimes(1);
  const [error, context] = vi.mocked(reportError).mock.calls[0]!;
  return { text: (error as Error).message, context };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.keyMissing = false;
});

describe('sendMemberPasswordResetAction: a failed read (S31)', () => {
  function withReads(member: QueryResult, profile: QueryResult) {
    const stub = makeSupabaseStub({
      'organization_members.select': member,
      'user_profiles.select': profile,
    });
    h.ctx = { organizationId: 'org-1', userId: 'admin-user', role: 'admin', supabase: stub.client };
  }

  it('a failed membership read answers the fixed sentence, the text only in the report', async () => {
    withReads(
      { data: null, error: { message: 'permission denied for table organization_members' } },
      { data: null, error: null },
    );
    const res = await sendMemberPasswordResetAction(MEMBER_USER_ID);
    expect(res).toEqual({ ok: false, error: UNEXPECTED });
    const r = reported();
    expect(r.text).toContain('organization_members');
    expect(r.context).toEqual({ tag: 'actions.team.send_member_password_reset' });
  });

  it('a failed profile read answers the fixed sentence', async () => {
    withReads(
      { data: { user_id: MEMBER_USER_ID, accepted_at: '2026-10-01T00:00:00Z' }, error: null },
      { data: null, error: { message: 'column user_profiles.email does not exist' } },
    );
    const res = await sendMemberPasswordResetAction(MEMBER_USER_ID);
    expect(res).toEqual({ ok: false, error: UNEXPECTED });
    expect(reported().text).toContain('user_profiles.email');
  });
});

describe('transferOwnershipAction: the transfer function says our own words (S31)', () => {
  function withTransfer(rpcError: QueryResult['error'], targetRead?: QueryResult) {
    const stub = makeSupabaseStub({
      'organization_members.select': targetRead ?? {
        data: {
          id: TARGET_MEMBER_ID,
          user_id: TARGET_USER_ID,
          role: 'staff',
          accepted_at: '2026-10-01T00:00:00Z',
        },
        error: null,
      },
      'rpc:transfer_org_ownership': { data: null, error: rpcError },
    });
    h.adminClient = stub.client;
    h.ctx = { organizationId: 'org-1', userId: 'owner-user', role: 'owner', supabase: {} };
  }
  const INPUT = { targetMemberId: TARGET_MEMBER_ID, password: 'the-owner-password' };

  it.each([
    {
      raised: { code: '42501', message: 'caller is not the current owner' },
      answer: { code: 'forbidden', message: 'Only the current owner can transfer ownership.' },
    },
    {
      raised: { code: '22023', message: 'cannot transfer ownership to yourself' },
      answer: { code: 'validation_error', message: 'You cannot transfer ownership to yourself.' },
    },
    {
      raised: {
        code: '22023',
        message: 'target user is not an active member of this organization',
      },
      answer: { code: 'not_found', message: 'Target member not found in this organization.' },
    },
    {
      raised: { code: '22023', message: 'target is already the owner' },
      answer: { code: 'validation_error', message: 'That member is already the owner.' },
    },
  ])(
    'a raced refusal "$raised.message" answers the action\'s own sentence, unreported',
    async ({ raised, answer }) => {
      withTransfer(raised);
      const res = await transferOwnershipAction(INPUT);
      expect(res).toEqual({ ok: false, error: answer });
      expect(reportError).not.toHaveBeenCalled();
    },
  );

  it('any other transfer failure answers the fixed sentence and is reported', async () => {
    withTransfer({
      code: '23505',
      message: 'duplicate key value violates unique constraint "one_owner_per_org"',
    });
    const res = await transferOwnershipAction(INPUT);
    expect(res).toEqual({ ok: false, error: UNEXPECTED });
    expect(JSON.stringify(res)).not.toContain('one_owner_per_org');
    const r = reported();
    expect(r.text).toContain('one_owner_per_org');
    expect(r.context).toEqual({ tag: 'actions.team.transfer_ownership', organizationId: 'org-1' });
  });

  it('our sentence with another code is not ours: the fixed sentence', async () => {
    withTransfer({ code: 'P0001', message: 'target is already the owner' });
    const res = await transferOwnershipAction(INPUT);
    expect(res).toEqual({ ok: false, error: UNEXPECTED });
  });

  it('a failed target read answers the fixed sentence and is reported', async () => {
    withTransfer(null, {
      data: null,
      error: { message: 'relation "organization_members" does not exist' },
    });
    const res = await transferOwnershipAction(INPUT);
    expect(res).toEqual({ ok: false, error: UNEXPECTED });
    expect(reported().text).toContain('relation');
  });
});

describe('acceptInviteWithSignupAction: failures say plain words (S31)', () => {
  const IN_A_WEEK = () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const OPEN_INVITE = {
    id: 'invite-1',
    organization_id: 'org-1',
    email: 'new.member@example.test',
    accepted_at: null,
    expires_at: IN_A_WEEK(),
  };
  const INPUT = { token: TOKEN, password: 'Chosen-Passw0rd' };

  function withInvite(invite: QueryResult, exists: QueryResult = { data: false, error: null }) {
    const stub = makeSupabaseStub({
      'organization_invites.select': invite,
      'rpc:auth_user_exists_by_email': exists,
      'user_profiles.upsert': { data: null, error: null },
    });
    stub.client.auth.admin = {
      createUser: vi.fn(async (attrs: { email: string }) => ({
        data: { user: { id: 'new-user', email: attrs.email } },
        error: null,
      })),
    };
    h.adminClient = stub.client;
  }

  it('without the service-role key: not set up yet, never the setting, reported as a warning', async () => {
    h.keyMissing = true;
    const res = await acceptInviteWithSignupAction(INPUT);
    expect(res).toEqual({
      ok: false,
      error: { code: 'internal_error', message: 'This feature is not set up yet.' },
    });
    expect(JSON.stringify(res)).not.toMatch(/SUPABASE|Vercel|env/);
    expect(reported().context).toEqual({ tag: 'actions.team.invite_signup', level: 'warning' });
  });

  it('a failed invite read answers the fixed sentence and is reported', async () => {
    withInvite({
      data: null,
      error: { message: 'permission denied for table organization_invites' },
    });
    const res = await acceptInviteWithSignupAction(INPUT);
    expect(res).toEqual({ ok: false, error: UNEXPECTED });
    const r = reported();
    expect(r.text).toContain('organization_invites');
    expect(r.context).toEqual({ tag: 'actions.team.invite_signup' });
  });

  it('a failed existing-account check answers the fixed sentence and is reported', async () => {
    withInvite(
      { data: OPEN_INVITE, error: null },
      {
        data: null,
        error: { message: 'function public.auth_user_exists_by_email(text) does not exist' },
      },
    );
    const res = await acceptInviteWithSignupAction(INPUT);
    expect(res).toEqual({ ok: false, error: UNEXPECTED });
    const r = reported();
    expect(r.text).toContain('auth_user_exists_by_email');
    expect(r.context).toEqual({ tag: 'actions.team.invite_signup', organizationId: 'org-1' });
  });

  it('a failed sign-in after the account is made answers the fixed sentence and is reported', async () => {
    withInvite({ data: OPEN_INVITE, error: null });
    signInWithPassword.mockResolvedValueOnce({
      data: {},
      error: { name: 'AuthApiError', status: 500, message: 'Database error querying schema' },
    });
    const res = await acceptInviteWithSignupAction(INPUT);
    expect(res).toEqual({ ok: false, error: UNEXPECTED });
    const r = reported();
    expect(r.text).toBe('Database error querying schema');
    expect(r.context).toEqual({ tag: 'actions.team.invite_signup', organizationId: 'org-1' });
  });
});

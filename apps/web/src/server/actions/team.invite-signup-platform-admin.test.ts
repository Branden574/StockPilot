import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Security invariant: a team invite never creates the account of a platform
 * admin (docket S20, security review).
 *
 * The platform-admin allowlist (STOCKPILOT_PLATFORM_ADMIN_EMAILS) gives the
 * Platform console, and since S20 the right to create workspaces, to whoever
 * holds an account with that VERIFIED sign-in email. acceptInviteWithSignupAction
 * creates the invite's address as a CONFIRMED account, with a password the
 * token holder chooses. The token is not proof of the mailbox:
 * TeamService.invite returns it to the inviter, and the Team page lists it
 * under Pending invites with a Copy link button. So an admin of any workspace
 * could invite an allowlisted address that had no account yet, accept the
 * invite with a password of their own, enroll an authenticator (enrollment
 * needs only a session) and pass checkPlatformAdmin({ requireStepUp: true }).
 *
 * The action now refuses to create an account for an allowlisted address. Its
 * answer is the existing-account answer, word for word, so the token holder
 * cannot tell an allowlisted address from one that already has an account.
 * Only a NEW account is refused: an existing account still accepts an invite
 * through acceptInviteAction.
 *
 * The check under test is the REAL isPlatformAdmin (recurring pattern 23)
 * over a per-test allowlist. The service-role client, the cookie client, the
 * invite acceptance and the error reporter are stand-ins.
 */

const h = vi.hoisted(() => ({
  /** The workspace whose invite is accepted. */
  inviteOrg: '44444444-4444-4444-8444-444444444444',
  /** STOCKPILOT_PLATFORM_ADMIN_EMAILS for this test. */
  allowlist: '',
  /** Rows of organization_invites. */
  invites: [] as Array<Record<string, unknown>>,
  /** Addresses that already have an account (auth_user_exists_by_email). */
  accounts: new Set<string>(),
  /** The service-role client the action receives. */
  adminClient: null as unknown,
}));

vi.mock('@/lib/env', () => ({
  env: {
    NEXT_PUBLIC_APP_URL: 'https://app.example.com',
    get STOCKPILOT_PLATFORM_ADMIN_EMAILS() {
      return h.allowlist;
    },
  },
}));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(() => h.adminClient),
}));
const signInWithPassword = vi.fn(async (_creds: unknown) => ({ data: {}, error: null }));
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { signInWithPassword } })),
}));
vi.mock('@/lib/auth/session', () => ({
  requireSession: vi.fn(async () => ({
    userId: 'existing-admin-user',
    email: 'platform-admin@example.com',
    fullName: null,
    avatarUrl: null,
    defaultOrganizationId: null,
  })),
}));
vi.mock('@/server/services/team', () => ({
  TeamService: { forCurrentUser: vi.fn() },
  acceptInviteWithToken: vi.fn(async () => ({ organizationId: h.inviteOrg })),
}));
vi.mock('@/server/services/context', () => {
  class ServiceError extends Error {
    constructor(
      public code: string,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    ServiceError,
    withContext: vi.fn(),
    assertPermission: vi.fn(),
    assertCurrentAal2: vi.fn(),
  };
});
vi.mock('@/server/services/audit', () => ({ audit: vi.fn(async () => {}) }));
vi.mock('@/lib/auth/password-reset-email', () => ({ sendPasswordResetEmail: vi.fn() }));
vi.mock('@/lib/auth/verify-password', () => ({ verifyPasswordSideChannel: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { reportError } from '@/lib/error-reporter';
import { acceptInviteWithToken } from '@/server/services/team';
import { makeSupabaseStub, servedLikePostgrest, type SupabaseStub } from '@/test/supabase-mock';

import { acceptInviteAction, acceptInviteWithSignupAction } from './team';

const INVITE_ORG = h.inviteOrg;
const ADMIN_EMAIL = 'platform-admin@example.com';
const PASSWORD = 'chosen-by-the-token-holder';
// Invite tokens are 22 characters (16 random bytes, base64url); acceptInviteSchema needs 20 or more.
const TOKEN_MEMBER = 'invite-token-member-01';
const TOKEN_EXISTING = 'invite-token-exists-01';
const TOKEN_ADMIN = 'invite-token-admin-001';
const IN_A_WEEK = () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

let stub: SupabaseStub;
let createUser: ReturnType<typeof vi.fn>;

/** An invite for `email` whose token is `token`, open and not accepted. */
function invite(token: string, email: string) {
  h.invites.push({
    id: `invite-${h.invites.length + 1}`,
    organization_id: INVITE_ORG,
    email,
    accepted_at: null,
    expires_at: IN_A_WEEK(),
    token,
  });
}

/** Whether the action wrote anything that makes or signs in an account. */
function expectNoAccount() {
  expect(createUser).not.toHaveBeenCalled();
  expect(stub.fromCalls).not.toContain('user_profiles');
  expect(signInWithPassword).not.toHaveBeenCalled();
  expect(acceptInviteWithToken).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  h.allowlist = ADMIN_EMAIL;
  h.invites = [];
  h.accounts = new Set();
  stub = makeSupabaseStub({
    'organization_invites.select': servedLikePostgrest(() => h.invites),
    'rpc:auth_user_exists_by_email': (call) => ({
      data: h.accounts.has((call.args[0]![0] as { p_email: string }).p_email),
      error: null,
    }),
  });
  createUser = vi.fn(async (attrs: { email: string }) => ({
    data: { user: { id: 'new-user', email: attrs.email } },
    error: null,
  }));
  stub.client.auth.admin = { createUser };
  h.adminClient = stub.client;
});

describe('acceptInviteWithSignupAction never creates the account of a platform admin', () => {
  it('creates the account for an address that is not on the allowlist (control)', async () => {
    invite(TOKEN_MEMBER, 'new.member@example.com');

    const res = await acceptInviteWithSignupAction({ token: TOKEN_MEMBER, password: PASSWORD });

    expect(res).toEqual({ ok: true, data: { organizationId: INVITE_ORG } });
    expect(createUser).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'new.member@example.com',
        password: PASSWORD,
        email_confirm: true,
      }),
    );
    expect(acceptInviteWithToken).toHaveBeenCalledWith(TOKEN_MEMBER, 'new-user');
    expect(reportError).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'the only address on the allowlist', allowlist: ADMIN_EMAIL, stored: ADMIN_EMAIL },
    {
      label: 'one of several addresses on the allowlist',
      allowlist: `first-admin@example.com,${ADMIN_EMAIL}`,
      stored: ADMIN_EMAIL,
    },
    {
      label: 'an invite row that kept capital letters',
      allowlist: ADMIN_EMAIL,
      stored: 'Platform-Admin@Example.com',
    },
  ])(
    'refuses an allowlisted address with no account ($label), with the existing-account answer word for word',
    async ({ allowlist, stored }) => {
      h.allowlist = allowlist;
      // What the token holder sees for an address that already has an account.
      h.accounts.add('existing.person@example.com');
      invite(TOKEN_EXISTING, 'existing.person@example.com');
      const existingAnswer = await acceptInviteWithSignupAction({
        token: TOKEN_EXISTING,
        password: PASSWORD,
      });
      expect(existingAnswer.ok).toBe(false);
      expect(createUser).not.toHaveBeenCalled();

      invite(TOKEN_ADMIN, stored);
      const res = await acceptInviteWithSignupAction({ token: TOKEN_ADMIN, password: PASSWORD });

      expect(res).toEqual(existingAnswer);
      expectNoAccount();
    },
  );

  it('reports the refusal for the operator, naming the workspace and never the address', async () => {
    invite(TOKEN_ADMIN, ADMIN_EMAIL);

    await acceptInviteWithSignupAction({ token: TOKEN_ADMIN, password: PASSWORD });

    expect(reportError).toHaveBeenCalledTimes(1);
    const [, context] = vi.mocked(reportError).mock.calls[0]!;
    expect(context).toEqual({
      tag: 'team.invite_signup.platform_admin_address',
      level: 'warning',
      organizationId: INVITE_ORG,
    });
    expect(JSON.stringify(vi.mocked(reportError).mock.calls[0])).not.toContain('example.com');
  });

  it('answers an allowlisted address that already has an account as before, and creates nothing', async () => {
    h.accounts.add(ADMIN_EMAIL);
    invite(TOKEN_ADMIN, ADMIN_EMAIL);

    const res = await acceptInviteWithSignupAction({ token: TOKEN_ADMIN, password: PASSWORD });

    expect(res).toMatchObject({ ok: false, error: { code: 'conflict' } });
    expectNoAccount();
  });

  it('still lets an existing account accept an invite while signed in (acceptInviteAction)', async () => {
    invite(TOKEN_ADMIN, ADMIN_EMAIL);

    const res = await acceptInviteAction({ token: TOKEN_ADMIN });

    expect(res).toEqual({ ok: true, data: { organizationId: INVITE_ORG } });
    expect(acceptInviteWithToken).toHaveBeenCalledWith(TOKEN_ADMIN, 'existing-admin-user');
    expect(createUser).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Docket S74 (web). The invitation email names the organization the
 * invitation is created in: the one withContext() resolved from the inviter's
 * accepted memberships, never the profile's default organization read on its
 * own (a preference the person sets, not proof of membership).
 *
 * The context, the cookie client, the session and TeamService are stand-ins.
 * The stand-in organizations table answers any id it holds, so the tests pin
 * which organization the action asks for, not what row level security shows.
 */

const ORG_CONTEXT = '66666666-6666-4666-8666-666666666666';
const ORG_DEFAULT = '77777777-7777-4777-8777-777777777777';

const h = vi.hoisted(() => ({
  /** organizations rows the cookie client can read, by id. */
  names: {} as Record<string, string>,
  /** Every organizations id the action asked for. */
  orgReads: [] as string[],
  invite: null as null | ((params: Record<string, unknown>) => Promise<{ acceptUrl: string }>),
  ctxOrg: '',
  sessionDefault: null as string | null,
}));

function fakeClient() {
  return {
    from: (table: string) => ({
      select: () => ({
        eq: (_col: string, id: string) => ({
          maybeSingle: async () => {
            if (table !== 'organizations') return { data: null, error: null };
            h.orgReads.push(id);
            return { data: h.names[id] ? { name: h.names[id] } : null, error: null };
          },
        }),
      }),
    }),
  };
}

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(async () => fakeClient()) }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn(() => fakeClient()) }));
vi.mock('@/lib/auth/session', () => ({
  requireSession: vi.fn(async () => ({
    userId: 'inviter-user',
    email: 'inviter@example.com',
    fullName: 'Casey Inviter',
    avatarUrl: null,
    defaultOrganizationId: h.sessionDefault,
  })),
}));
vi.mock('@/server/services/team', () => {
  class TeamService {
    constructor(public readonly ctx: unknown) {}
    static forCurrentUser = vi.fn(async () => new TeamService({ organizationId: h.ctxOrg }));
    invite(params: Record<string, unknown>) {
      return h.invite!(params);
    }
  }
  return { TeamService, acceptInviteWithToken: vi.fn() };
});
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
    withContext: vi.fn(async () => ({
      organizationId: h.ctxOrg,
      userId: 'inviter-user',
      role: 'admin',
      supabase: fakeClient(),
    })),
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

import { inviteMemberAction } from './team';

const invite = vi.fn(async (_params: Record<string, unknown>) => ({ acceptUrl: 'https://app.example.com/i/x' }));

beforeEach(() => {
  vi.clearAllMocks();
  h.invite = invite;
  h.orgReads = [];
  h.ctxOrg = ORG_CONTEXT;
  h.names = { [ORG_CONTEXT]: 'Harbor Supply', [ORG_DEFAULT]: 'Ridge Depot' };
});

describe('inviteMemberAction names the organization the invitation is created in', () => {
  it('a default organization other than the resolved one: the email names the resolved organization', async () => {
    h.sessionDefault = ORG_DEFAULT;
    const res = await inviteMemberAction({ email: 'new.person@example.com', role: 'staff' });
    expect(res.ok).toBe(true);
    expect(invite).toHaveBeenCalledTimes(1);
    expect(invite.mock.calls[0]![0]).toMatchObject({ organizationName: 'Harbor Supply' });
    expect(h.orgReads).toEqual([ORG_CONTEXT]);
  });

  it('no default organization: the email still names the resolved organization', async () => {
    h.sessionDefault = null;
    await inviteMemberAction({ email: 'new.person@example.com', role: 'staff' });
    expect(invite.mock.calls[0]![0]).toMatchObject({ organizationName: 'Harbor Supply' });
    expect(h.orgReads).toEqual([ORG_CONTEXT]);
  });

  it('the default is the resolved organization: unchanged answer', async () => {
    h.sessionDefault = ORG_CONTEXT;
    await inviteMemberAction({ email: 'new.person@example.com', role: 'staff' });
    expect(invite.mock.calls[0]![0]).toMatchObject({
      organizationName: 'Harbor Supply',
      inviterName: 'Casey Inviter',
      inviterEmail: 'inviter@example.com',
    });
  });
});

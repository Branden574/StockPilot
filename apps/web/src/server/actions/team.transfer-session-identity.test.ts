import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * transferOwnershipAction re-confirms the owner's password, and keys its rate
 * limit, on the account the context resolved. The session is loaded a second
 * time for the email; an answer about any other account is refused before
 * the rate limit, the password check or the transfer. The session loaders
 * (lib/auth/session.ts) do not produce that state; the stand-in session below
 * is the only way to reach the check.
 *
 * Stand-ins: the context, the session, the factor list, the password check,
 * the rate limit and the admin client. team.transfer-refresh-swap.test.ts runs
 * the real session loaders.
 */

const ORG = 'aaaaaaaa-1111-4111-8111-111111111111';
const OWNER = '11111111-1111-4111-8111-111111111111';
const TARGET_USER = '33333333-3333-4333-8333-333333333333';
const TARGET_MEMBER_ID = 'bbbbbbbb-2222-4222-8222-222222222222';
/** A third account, neither the owner nor the member ownership moves to. */
const UNRELATED_ACCOUNT = '77777777-7777-4777-8777-777777777777';

const h = vi.hoisted(() => ({
  /** The account requireSession() answers with. */
  session: null as null | Record<string, unknown>,
  rpc: [] as Array<{ fn: string; args: unknown }>,
}));

vi.mock('@/lib/env', () => ({ env: { NEXT_PUBLIC_APP_URL: 'https://app.example.com' } }));
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(async () => ({})) }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => {
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.eq = () => chain;
    chain.maybeSingle = async () => ({
      data: {
        id: TARGET_MEMBER_ID,
        user_id: TARGET_USER,
        role: 'staff',
        accepted_at: '2026-10-01T00:00:00.000Z',
      },
      error: null,
    });
    return {
      from: () => chain,
      rpc: async (fn: string, args: unknown) => {
        h.rpc.push({ fn, args });
        return { data: null, error: null };
      },
    };
  },
}));
vi.mock('@/lib/auth/session', () => ({ requireSession: vi.fn(async () => h.session) }));
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
      organizationId: ORG,
      userId: OWNER,
      role: 'owner',
      supabase: {},
    })),
    assertPermission: vi.fn(),
    assertRoleUnchanged: vi.fn(),
    assertCurrentAal2: vi.fn(),
  };
});
vi.mock('@/lib/auth/mfa-factors', () => ({
  readMfaFactorList: vi.fn(async () => []),
  factorsOf: vi.fn(() => []),
}));
const verifyPasswordSideChannel = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
vi.mock('@/lib/auth/verify-password', () => ({ verifyPasswordSideChannel }));
const checkRateLimit = vi.hoisted(() =>
  vi.fn(async () => ({ allowed: true, remaining: 4, resetAt: Date.now() + 1 })),
);
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit }));
vi.mock('@/server/services/audit', () => ({
  audit: vi.fn(async () => {}),
  insertAuditRowReported: vi.fn(async () => true),
}));
vi.mock('@/server/services/integration-events', () => ({ dispatchEvent: vi.fn(async () => {}) }));
vi.mock('@/server/services/platform/sessions', () => ({ revokeAllSessionsForUser: vi.fn() }));
vi.mock('@/lib/email/resend', () => ({ sendEmail: vi.fn(async () => ({ ok: true })) }));
vi.mock('@/lib/auth/password-reset-email', () => ({ sendPasswordResetEmail: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { transferOwnershipAction } from './team';

// A dull value under a neutral name (src/test/secret-shaped-fixtures.guard.test.ts).
const TYPED_VALUE = 'test-only-input';
const INPUT = { targetMemberId: TARGET_MEMBER_ID, password: TYPED_VALUE };

const OWNER_SESSION = {
  userId: OWNER,
  email: 'owner@example.com',
  fullName: 'Morgan Owner',
  avatarUrl: null,
  defaultOrganizationId: ORG,
};

beforeEach(() => {
  vi.clearAllMocks();
  h.rpc = [];
  h.session = { ...OWNER_SESSION };
});

describe("transferOwnershipAction checks the password of the context's own account", () => {
  it("control: the session answers with the owner: the owner's email is checked and ownership moves", async () => {
    const res = await transferOwnershipAction(INPUT);
    expect(res).toEqual({ ok: true, data: { newOwnerUserId: TARGET_USER } });
    expect(verifyPasswordSideChannel).toHaveBeenCalledWith('owner@example.com', TYPED_VALUE);
    expect(h.rpc).toHaveLength(1);
  });

  it('a stand-in session naming a different account is refused before the rate limit, the password check and the transfer', async () => {
    h.session = {
      userId: UNRELATED_ACCOUNT,
      email: 'unrelated.account@example.com',
      fullName: 'Jordan Example',
      avatarUrl: null,
      defaultOrganizationId: ORG,
    };
    const res = await transferOwnershipAction(INPUT);
    expect(res).toEqual({
      ok: false,
      error: {
        code: 'unauthenticated',
        message: 'Sign in again, then try again.',
        details: { reason: 'session_changed' },
      },
    });
    expect(checkRateLimit).not.toHaveBeenCalled();
    expect(verifyPasswordSideChannel).not.toHaveBeenCalled();
    expect(h.rpc).toEqual([]);
  });
});

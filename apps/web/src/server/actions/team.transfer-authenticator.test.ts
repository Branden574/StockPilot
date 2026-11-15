import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * transferOwnershipAction gives the authenticator answer (mfaGateError, the
 * answer assertPermission gives) when the organization's policy requires an
 * authenticator and the session has not satisfied it, before the rate limit,
 * the password check and the transfer. An owner whose session satisfies it
 * transfers.
 *
 * Stand-ins: the context's withContext (the rest of the context module is the
 * real one), the session, the factor list, the password check, the rate limit
 * and the admin client.
 */

const ORG = 'aaaaaaaa-1111-4111-8111-111111111111';
const OWNER = '11111111-1111-4111-8111-111111111111';
const TARGET_USER = '33333333-3333-4333-8333-333333333333';
const TARGET_MEMBER_ID = 'bbbbbbbb-2222-4222-8222-222222222222';

const h = vi.hoisted(() => ({
  rpc: [] as Array<{ fn: string; args: unknown }>,
  adminReads: 0,
  mfa: { mfaRequired: false, mfaSatisfied: true, mfaEnrolled: false },
  factors: [] as Array<{ id: string; status: string }>,
}));

vi.mock('@/lib/env', () => ({ env: { NEXT_PUBLIC_APP_URL: 'https://app.example.com' } }));
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(async () => ({})) }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => {
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.eq = () => chain;
    chain.maybeSingle = async () => {
      h.adminReads += 1;
      return {
        data: {
          id: TARGET_MEMBER_ID,
          user_id: TARGET_USER,
          role: 'staff',
          accepted_at: '2026-10-01T00:00:00.000Z',
        },
        error: null,
      };
    };
    return {
      from: () => chain,
      rpc: async (fn: string, args: unknown) => {
        h.rpc.push({ fn, args });
        return { data: null, error: null };
      },
    };
  },
}));
vi.mock('@/lib/auth/session', () => ({
  requireSession: vi.fn(async () => ({
    userId: OWNER,
    email: 'owner@example.com',
    fullName: 'Morgan Owner',
    avatarUrl: null,
    defaultOrganizationId: ORG,
  })),
}));
vi.mock('@/server/services/context', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/server/services/context')>();
  return {
    ...real,
    withContext: vi.fn(async () => ({
      organizationId: ORG,
      userId: OWNER,
      role: 'owner',
      supabase: {},
      enabledModules: new Set(),
      ...h.mfa,
    })),
    assertCurrentAal2: vi.fn(async () => {}),
  };
});
vi.mock('@/lib/auth/mfa-factors', () => ({
  readMfaFactorList: vi.fn(async () => h.factors),
  factorsOf: vi.fn(() => h.factors),
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

const INPUT = { targetMemberId: TARGET_MEMBER_ID, password: 'test-only-input' };

beforeEach(() => {
  vi.clearAllMocks();
  h.rpc = [];
  h.adminReads = 0;
  h.factors = [];
  h.mfa = { mfaRequired: false, mfaSatisfied: true, mfaEnrolled: false };
});

describe('transferOwnershipAction gives the authenticator answer first', () => {
  it('an owner with no authenticator under a policy that requires one: mfa_required, nothing checked or moved', async () => {
    h.mfa = { mfaRequired: true, mfaSatisfied: false, mfaEnrolled: false };
    const res = await transferOwnershipAction(INPUT);
    expect(res).toMatchObject({
      ok: false,
      error: { code: 'forbidden', details: { reason: 'mfa_required' } },
    });
    expect(checkRateLimit).not.toHaveBeenCalled();
    expect(verifyPasswordSideChannel).not.toHaveBeenCalled();
    expect(h.adminReads).toBe(0);
    expect(h.rpc).toEqual([]);
  });

  it('an owner whose session satisfies the policy: ownership moves', async () => {
    h.mfa = { mfaRequired: true, mfaSatisfied: true, mfaEnrolled: true };
    h.factors = [{ id: 'factor-1', status: 'verified' }];
    const res = await transferOwnershipAction(INPUT);
    expect(res).toEqual({ ok: true, data: { newOwnerUserId: TARGET_USER } });
    expect(h.rpc.map((c) => c.fn)).toEqual(['transfer_org_ownership']);
  });

  it('an organization with no requirement: ownership moves', async () => {
    const res = await transferOwnershipAction(INPUT);
    expect(res).toEqual({ ok: true, data: { newOwnerUserId: TARGET_USER } });
  });
});

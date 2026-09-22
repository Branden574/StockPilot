import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Removing a TOTP factor is refused when the organization's policy requires
 * MFA for this member. The policy read used to ignore its `error` (postgrest
 * resolves a failed request, it does not throw) and treat zero rows as
 * 'optional', so a timeout or a hidden row PERMITTED the unenroll under a
 * policy that forbids it. Both now refuse.
 */

vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), updateTag: vi.fn() }));

const role = { current: 'admin' as 'admin' | 'staff' };
vi.mock('@/lib/auth/session', () => ({
  requireSession: vi.fn(async () => ({
    userId: 'user-1',
    email: 'u@e.com',
    fullName: null,
    avatarUrl: null,
    defaultOrganizationId: 'org-1',
  })),
  requireOrgContext: vi.fn(async () => ({
    userId: 'user-1',
    organizationId: 'org-1',
    role: role.current,
  })),
}));

vi.mock('@/server/services/context', () => ({
  withContext: vi.fn(async () => ({})),
  // The AAL2 step-up passes: these cases are about the POLICY check after it.
  assertCurrentAal2: vi.fn(async () => {}),
  ServiceError: class extends Error {
    constructor(
      public code: string,
      message: string,
    ) {
      super(message);
    }
  },
}));

vi.mock('@/server/services/audit', () => ({ audit: vi.fn(async () => {}) }));
vi.mock('@/server/services/integration-events', () => ({ dispatchEvent: vi.fn(async () => {}) }));
vi.mock('@/lib/auth/verify-password', () => ({
  verifyPasswordSideChannel: vi.fn(async () => ({ ok: true })),
}));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, count: 1, resetAt: Date.now() + 1000 })),
}));

const orgRead = {
  current: { data: { mfa_policy: 'optional' }, error: null } as {
    data: { mfa_policy: string } | null;
    error: { code: string; message: string } | null;
  },
};
const unenroll = vi.fn(async () => ({ data: null, error: null }));

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => {
    const q = {
      select: () => q,
      eq: () => q,
      maybeSingle: async () => orgRead.current,
    };
    return { from: () => q, auth: { mfa: { unenroll } } };
  }),
}));

import { unenrollFactorAction } from './mfa';

const FACTOR = '11111111-2222-3333-4444-555555555555';

describe('unenrollFactorAction — the organization policy check', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    role.current = 'admin';
    orgRead.current = { data: { mfa_policy: 'optional' }, error: null };
  });

  it('removes the factor under an optional policy', async () => {
    const res = await unenrollFactorAction({ factorId: FACTOR });
    expect(res.ok).toBe(true);
    expect(unenroll).toHaveBeenCalledOnce();
  });

  it('refuses under a policy that requires MFA for this role', async () => {
    orgRead.current = { data: { mfa_policy: 'admins_required' }, error: null };
    const res = await unenrollFactorAction({ factorId: FACTOR });
    expect(res.ok).toBe(false);
    expect(unenroll).not.toHaveBeenCalled();
  });

  it('refuses when the policy read FAILS, instead of reading it as optional', async () => {
    orgRead.current = { data: null, error: { code: '57014', message: 'statement timeout' } };
    const res = await unenrollFactorAction({ factorId: FACTOR });
    expect(res.ok).toBe(false);
    expect(unenroll).not.toHaveBeenCalled();
  });

  it('refuses when the row is HIDDEN, even for a role an admins-only policy would exempt', async () => {
    role.current = 'staff';
    orgRead.current = { data: null, error: null };
    const res = await unenrollFactorAction({ factorId: FACTOR });
    expect(res.ok).toBe(false);
    expect(unenroll).not.toHaveBeenCalled();
  });
});

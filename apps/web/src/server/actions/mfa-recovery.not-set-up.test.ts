import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub } from '@/test/supabase-mock';
import { verifiedSessionAuth } from '@/test/verified-session-stub';

/**
 * A RECOVERY CODE ON A SERVER WITHOUT THE SERVICE-ROLE KEY (S31).
 *
 * consumeMfaRecoveryCodeAction answered the setting's name ("Server is
 * missing SUPABASE_SERVICE_ROLE_KEY ...") when the admin client could not be
 * made. Its result reaches the browser as it is: the person now reads "This
 * feature is not set up yet." and the report names the setting.
 *
 * The code is never spent on such a server: the consume gate's limiter runs
 * in closed mode and reaches its database through the same admin client
 * (lib/rate-limit.ts), so without the key it refuses before the code is
 * checked. The first case pins that, which is why the admin client is not
 * made earlier.
 */

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/headers', () => ({ headers: vi.fn(async () => new Headers()) }));
vi.mock('@/lib/auth/session', () => ({
  requireSession: vi.fn(async () => ({
    userId: 'user-1',
    email: 'u@example.test',
    fullName: null,
    avatarUrl: null,
    defaultOrganizationId: 'org-1',
  })),
}));
vi.mock('@/lib/auth/verify-password', () => ({
  verifyPasswordSideChannel: vi.fn(async () => ({ ok: true })),
}));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));

const h = vi.hoisted(() => ({
  stub: null as ReturnType<typeof import('@/test/supabase-mock').makeSupabaseStub> | null,
  /** createAdminClient calls that succeed before it throws (the key is missing). */
  adminCallsBeforeMissing: 0,
  adminCalls: 0,
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () =>
    Object.assign(h.stub!.client, {
      auth: Object.assign(
        h.stub!.client.auth,
        verifiedSessionAuth(() => ({ sub: 'user-1', aal: 'aal1' })),
      ),
    }),
  ),
}));
vi.mock('@/lib/supabase/access-token-client', () => ({
  createAccessTokenClient: vi.fn(() => h.stub!.client),
}));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(() => {
    h.adminCalls += 1;
    if (h.adminCalls > h.adminCallsBeforeMissing) {
      throw new Error('SUPABASE_SERVICE_ROLE_KEY is not configured');
    }
    return h.stub!.client;
  }),
}));

import { reportError } from '@/lib/error-reporter';

import { consumeMfaRecoveryCodeAction } from './mfa-recovery';

const PW = 'correct horse battery staple';

beforeEach(() => {
  vi.clearAllMocks();
  h.adminCalls = 0;
  h.stub = makeSupabaseStub({
    'rpc:increment_rate_limit': {
      data: [{ allowed: true, count: 1, reset_at: null }],
      error: null,
    },
    'rpc:consume_mfa_recovery_code': { data: true, error: null },
  });
});

describe('consumeMfaRecoveryCodeAction without the service-role key (S31)', () => {
  it('never spends the code: the closed limiter refuses first', async () => {
    h.adminCallsBeforeMissing = 0;
    const res = await consumeMfaRecoveryCodeAction({ code: 'good-code', password: PW });
    expect(res.ok).toBe(false);
    expect(h.stub!.rpcCalls.map((c) => c.name)).not.toContain('consume_mfa_recovery_code');
  });

  it('says the feature is not set up, never the setting, and reports it as a warning', async () => {
    // The limiter's own clients work (one per bucket the press counts in: the
    // account at this address, its password checks and its code checks); the
    // one for removing factors does not.
    h.adminCallsBeforeMissing = 3;
    const res = await consumeMfaRecoveryCodeAction({ code: 'good-code', password: PW });
    expect(res).toEqual({
      ok: false,
      error: { code: 'internal_error', message: 'This feature is not set up yet.' },
    });
    expect(JSON.stringify(res)).not.toMatch(/SUPABASE|KEY/);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(vi.mocked(reportError).mock.calls[0]![1]).toEqual({
      tag: 'actions.mfa_recovery.consume',
      level: 'warning',
    });
  });
});

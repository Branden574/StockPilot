import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub, type MockCall } from '@/test/supabase-mock';
import { verifiedSessionAuth } from '@/test/verified-session-stub';

/**
 * consumeMfaRecoveryCodeAction's security event (part 1 of the security
 * tools): a recovery code the database refused, for an account past its
 * password, is wrong_recovery_code in the account's organization (looked up
 * after the response, server/security/account-events.ts). A press the
 * recovery limiter refused (any of its three buckets, over its count) is
 * recovery_code_checks_paused in the same organization; a limiter that could
 * not count is not an event. A code that worked, a wrong password and a call
 * that failed record nothing.
 *
 * Addresses are from the documentation ranges (RFC 5737).
 */

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn() }));

const request = vi.hoisted(() => ({ headers: new Headers({ 'x-real-ip': '198.51.100.4' }) }));
vi.mock('next/headers', () => ({ headers: vi.fn(async () => request.headers) }));
vi.mock('@/lib/auth/session', () => ({
  requireSession: vi.fn(async () => ({
    userId: 'user-1',
    email: 'u@example.com',
    fullName: null,
    avatarUrl: null,
    defaultOrganizationId: 'org-1',
  })),
}));
vi.mock('@/lib/auth/verify-password', () => ({
  verifyPasswordSideChannel: vi.fn(async () => ({ ok: true })),
}));

const stubHolder: { stub: ReturnType<typeof makeSupabaseStub> | null } = { stub: null };

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () =>
    Object.assign(stubHolder.stub!.client, {
      auth: Object.assign(
        stubHolder.stub!.client.auth,
        verifiedSessionAuth(() => ({ sub: 'user-1', aal: 'aal1' })),
      ),
    }),
  ),
}));
vi.mock('@/lib/supabase/access-token-client', () => ({
  createAccessTokenClient: vi.fn(() => stubHolder.stub!.client),
}));
// 0475 is not live in this file's world: the recovery code's new function
// does not exist yet, so today's path runs (test/passkey-records.ts;
// mfa-recovery.passkeys.test.ts covers the function).
vi.mock('@/lib/supabase/admin', async () => {
  const { beforePasskeyRecords } = await import('@/test/passkey-records');
  return { createAdminClient: vi.fn(() => beforePasskeyRecords(stubHolder.stub!.client)) };
});
vi.mock('@/server/services/auth-audit', () => ({
  emitAuthAudit: vi.fn(async () => {}),
  resolveDefaultOrgAndRole: vi.fn(async () => ({ organizationId: 'org-1', role: 'admin' })),
}));
vi.mock('@/server/security/account-events', () => ({ recordAccountCodeBlocked: vi.fn() }));

import { verifyPasswordSideChannel } from '@/lib/auth/verify-password';
import { recordAccountCodeBlocked } from '@/server/security/account-events';

import { consumeMfaRecoveryCodeAction } from './mfa-recovery';

const PW = 'correct horse battery staple';
const LIMITER_OK = {
  'rpc:increment_rate_limit': { data: [{ allowed: true, count: 1, reset_at: null }], error: null },
} as const;

const recorded = () => vi.mocked(recordAccountCodeBlocked).mock.calls;

beforeEach(() => {
  stubHolder.stub = null;
});

describe('consumeMfaRecoveryCodeAction records a refused recovery code', () => {
  it('a code the database refused: wrong_recovery_code, for the account, with the request headers', async () => {
    stubHolder.stub = makeSupabaseStub({
      ...LIMITER_OK,
      'rpc:consume_mfa_recovery_code': { data: false, error: null },
    });
    const result = await consumeMfaRecoveryCodeAction({ code: 'bad-code', password: PW });
    expect(result).toMatchObject({ ok: false, error: { code: 'validation_error' } });
    expect(recorded()).toEqual([['wrong_recovery_code', 'user-1', request.headers]]);
  });

  it('a code that worked records nothing', async () => {
    stubHolder.stub = makeSupabaseStub({
      ...LIMITER_OK,
      'rpc:consume_mfa_recovery_code': { data: true, error: null },
    });
    stubHolder.stub.client.auth.admin = {
      mfa: {
        listFactors: vi.fn(async () => ({ data: { factors: [] }, error: null })),
        deleteFactor: vi.fn(),
      },
    };
    expect(await consumeMfaRecoveryCodeAction({ code: 'good-code', password: PW })).toMatchObject({
      ok: true,
    });
    expect(recorded()).toEqual([]);
  });

  it('a wrong password, or a call that failed, records nothing', async () => {
    vi.mocked(verifyPasswordSideChannel).mockResolvedValueOnce({
      ok: false,
      reason: 'invalid_password',
      message: 'Incorrect password.',
    } as Awaited<ReturnType<typeof verifyPasswordSideChannel>>);
    stubHolder.stub = makeSupabaseStub({
      ...LIMITER_OK,
      'rpc:consume_mfa_recovery_code': { data: false, error: null },
    });
    await consumeMfaRecoveryCodeAction({ code: 'bad-code', password: 'not-the-account-value' });

    stubHolder.stub = makeSupabaseStub({
      ...LIMITER_OK,
      'rpc:consume_mfa_recovery_code': { data: null, error: { message: 'down' } },
    });
    await consumeMfaRecoveryCodeAction({ code: 'whatever', password: PW });
    expect(recorded()).toEqual([]);
  });
});

describe('consumeMfaRecoveryCodeAction records a press its limiter refused', () => {
  /** The limiter answers every bucket but the one whose key starts with `prefix`. */
  const limiterRefusing = (prefix: string, answer: 'over the count' | 'could not count') => ({
    'rpc:increment_rate_limit': (call: MockCall) => {
      const key = String((call.args[0]?.[0] as { p_key?: unknown } | undefined)?.p_key ?? '');
      if (!key.startsWith(prefix)) return { data: [{ allowed: true, count: 1, reset_at: null }], error: null };
      return answer === 'over the count'
        ? { data: [{ allowed: false, count: 6, reset_at: null }], error: null }
        : { data: null, error: { message: 'down' } };
    },
    'rpc:consume_mfa_recovery_code': { data: false, error: null },
  });

  it.each([
    ['the account at this address', 'mfa-recovery:user-1:198.51.100.4'],
    ['the account’s password checks', 'mfa-recovery-password:user-1'],
    ['the account’s code checks', 'mfa-recovery-code:user-1'],
  ])('%s, over its count: recovery_code_checks_paused, for the account, with the request headers', async (_what, prefix) => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    stubHolder.stub = makeSupabaseStub(limiterRefusing(prefix, 'over the count'));
    const result = await consumeMfaRecoveryCodeAction({ code: 'any-code', password: PW });
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'validation_error',
        message: 'Too many recovery-code attempts. Wait a few minutes and try again.',
      },
    });
    expect(recorded()).toEqual([['recovery_code_checks_paused', 'user-1', request.headers]]);
    // The code was never checked.
    expect(stubHolder.stub.rpcCalls.map((c) => c.name)).not.toContain('consume_mfa_recovery_code');
  });

  it.each([
    ['the account at this address', 'mfa-recovery:user-1:198.51.100.4'],
    ['the account’s password checks', 'mfa-recovery-password:user-1'],
    ['the account’s code checks', 'mfa-recovery-code:user-1'],
  ])('%s, when the limiter could not count: still refused, nothing recorded', async (_what, prefix) => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    stubHolder.stub = makeSupabaseStub(limiterRefusing(prefix, 'could not count'));
    const result = await consumeMfaRecoveryCodeAction({ code: 'any-code', password: PW });
    expect(result).toMatchObject({ ok: false, error: { code: 'validation_error' } });
    expect(recorded()).toEqual([]);
    expect(stubHolder.stub.rpcCalls.map((c) => c.name)).not.toContain('consume_mfa_recovery_code');
  });
});

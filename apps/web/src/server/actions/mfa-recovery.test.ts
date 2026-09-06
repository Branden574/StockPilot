import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub } from '@/test/supabase-mock';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

vi.mock('@/lib/auth/session', () => ({
  requireSession: vi.fn(async () => ({
    userId: 'user-1',
    email: 'u@e.com',
    fullName: null,
    avatarUrl: null,
    defaultOrganizationId: 'org-1',
  })),
}));

// Password re-confirm is MANDATORY on consume — mock the verifier (default: ok).
vi.mock('@/lib/auth/verify-password', () => ({
  verifyPasswordSideChannel: vi.fn(async () => ({ ok: true })),
}));

const stubHolder: { stub: ReturnType<typeof makeSupabaseStub> | null } = {
  stub: null,
};

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => stubHolder.stub!.client),
}));

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(() => stubHolder.stub!.client),
}));

import { revalidatePath } from 'next/cache';

import { verifyPasswordSideChannel } from '@/lib/auth/verify-password';

import { consumeMfaRecoveryCodeAction } from './mfa-recovery';

const PW = 'correct horse battery staple';

/**
 * The consume gate runs in `'closed'` mode, so it treats a limiter that
 * returns nothing as a denial. supabase-mock's default for an un-stubbed RPC
 * is `{ data: null }` — every case that expects to get PAST the gate has to
 * stub the bucket increment explicitly. (Before SP-100 the gate was open-mode
 * and silently swallowed that null, which is exactly what hid the bug.)
 */
const LIMITER_OK = {
  'rpc:increment_rate_limit': {
    data: [{ allowed: true, count: 1, reset_at: null }],
    error: null,
  },
} as const;

function attachAdminMfa(
  stub: ReturnType<typeof makeSupabaseStub>,
  factors: Array<{ id: string; factor_type: string }>,
  deleteImpl?: (
    args: { userId: string; id: string },
  ) => Promise<{ data: unknown; error: { message: string } | null }>,
) {
  const listFactors = vi.fn(async () => ({
    data: { factors },
    error: null,
  }));
  const deleteFactor = vi.fn(
    deleteImpl ?? (async () => ({ data: null, error: null })),
  );
  stub.client.auth.admin = {
    mfa: { listFactors, deleteFactor },
  };
  return { listFactors, deleteFactor };
}

describe('consumeMfaRecoveryCodeAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubHolder.stub = null;
  });

  it('rejects when no password is provided (mandatory re-confirm)', async () => {
    stubHolder.stub = makeSupabaseStub({
      ...LIMITER_OK,
      'rpc:consume_mfa_recovery_code': { data: true, error: null },
    });
    const { deleteFactor } = attachAdminMfa(stubHolder.stub, [
      { id: 'f1', factor_type: 'totp' },
    ]);
    const result = await consumeMfaRecoveryCodeAction({ code: 'good-code' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('forbidden');
    // The factor-stripping must NEVER run without a verified password.
    expect(deleteFactor).not.toHaveBeenCalled();
  });

  it('rejects when the password is wrong', async () => {
    vi.mocked(verifyPasswordSideChannel).mockResolvedValueOnce({
      ok: false,
      reason: 'invalid_password',
      message: 'Incorrect password.',
    } as Awaited<ReturnType<typeof verifyPasswordSideChannel>>);
    stubHolder.stub = makeSupabaseStub({
      ...LIMITER_OK,
      'rpc:consume_mfa_recovery_code': { data: true, error: null },
    });
    const { deleteFactor } = attachAdminMfa(stubHolder.stub, [
      { id: 'f1', factor_type: 'totp' },
    ]);
    const result = await consumeMfaRecoveryCodeAction({ code: 'good-code', password: 'wrong' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('forbidden');
    expect(deleteFactor).not.toHaveBeenCalled();
  });

  it('returns validation_error when the recovery code is invalid', async () => {
    stubHolder.stub = makeSupabaseStub({
      ...LIMITER_OK,
      'rpc:consume_mfa_recovery_code': { data: false, error: null },
    });
    const result = await consumeMfaRecoveryCodeAction({ code: 'bad-code', password: PW });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('validation_error');
  });

  it('returns internal_error when the rpc itself errors', async () => {
    stubHolder.stub = makeSupabaseStub({
      ...LIMITER_OK,
      'rpc:consume_mfa_recovery_code': {
        data: null,
        error: { message: 'sql blew up' },
      },
    });
    const result = await consumeMfaRecoveryCodeAction({ code: 'whatever', password: PW });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('internal_error');
  });

  it('deletes every TOTP factor and returns the unenrolled count', async () => {
    stubHolder.stub = makeSupabaseStub({
      ...LIMITER_OK,
      'rpc:consume_mfa_recovery_code': { data: true, error: null },
    });
    const { deleteFactor } = attachAdminMfa(stubHolder.stub, [
      { id: 'f1', factor_type: 'totp' },
      { id: 'f2', factor_type: 'totp' },
      // a non-totp factor must be skipped, never deleted
      { id: 'f3', factor_type: 'phone' },
    ]);

    const result = await consumeMfaRecoveryCodeAction({ code: 'good-code', password: PW });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.unenrolled).toBe(2);
    expect(deleteFactor).toHaveBeenCalledTimes(2);
    expect(deleteFactor).toHaveBeenCalledWith({ userId: 'user-1', id: 'f1' });
    expect(deleteFactor).toHaveBeenCalledWith({ userId: 'user-1', id: 'f2' });
    expect(revalidatePath).toHaveBeenCalledWith('/dashboard', 'layout');
  });

  it('does not count factors whose delete returns an error', async () => {
    stubHolder.stub = makeSupabaseStub({
      ...LIMITER_OK,
      'rpc:consume_mfa_recovery_code': { data: true, error: null },
    });
    const calls: Array<{ id: string }> = [];
    attachAdminMfa(
      stubHolder.stub,
      [
        { id: 'f1', factor_type: 'totp' },
        { id: 'f2', factor_type: 'totp' },
      ],
      async ({ id }) => {
        calls.push({ id });
        if (id === 'f2') return { data: null, error: { message: 'denied' } };
        return { data: null, error: null };
      },
    );

    const result = await consumeMfaRecoveryCodeAction({ code: 'good', password: PW });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.unenrolled).toBe(1);
    expect(calls).toHaveLength(2);
  });

  /**
   * SP-100 — the consume gate must fail CLOSED.
   *
   * `checkRateLimit` defaults to `mode: 'open'`: on an RPC error (the
   * rate_limit_buckets table missing, or the service-role key dying the way it
   * did on 2026-07-21 — checkRateLimit talks through createAdminClient) it
   * returns `allowed: true`. This action's limiter is the ONLY brute-force
   * ceiling on its password check (verify-password.ts leaves throttling to the
   * caller), so an open failure mode silently drops the layer that stops a
   * stolen AAL1 cookie from hammering recovery codes. Every sibling auth front
   * door — generate above, mfa.ts enroll-verify, auth.ts sign-in/pwchange,
   * email-change request/resend — already passes 'closed'.
   */
  it('refuses when the rate limiter is unavailable (closed mode)', async () => {
    stubHolder.stub = makeSupabaseStub({
      'rpc:increment_rate_limit': { data: null, error: { message: 'limiter down' } },
      'rpc:consume_mfa_recovery_code': { data: true, error: null },
    });
    const { deleteFactor } = attachAdminMfa(stubHolder.stub, [
      { id: 'f1', factor_type: 'totp' },
    ]);

    const result = await consumeMfaRecoveryCodeAction({ code: 'good-code', password: PW });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('validation_error');
    // Nothing past the gate may run: no password attempt to time, no code
    // burned, no factor stripped.
    expect(verifyPasswordSideChannel).not.toHaveBeenCalled();
    expect(
      stubHolder.stub.rpcCalls.some((c) => c.name === 'consume_mfa_recovery_code'),
    ).toBe(false);
    expect(deleteFactor).not.toHaveBeenCalled();
  });

  it('keys the consume gate on the user with a 5-per-15-minutes budget', async () => {
    stubHolder.stub = makeSupabaseStub({
      ...LIMITER_OK,
      'rpc:consume_mfa_recovery_code': { data: true, error: null },
    });
    attachAdminMfa(stubHolder.stub, [{ id: 'f1', factor_type: 'totp' }]);

    await consumeMfaRecoveryCodeAction({ code: 'good-code', password: PW });

    expect(stubHolder.stub.rpcCalls[0]).toEqual({
      name: 'increment_rate_limit',
      args: { p_key: 'mfa-recovery:user-1', p_limit: 5, p_window_ms: 15 * 60_000 },
    });
  });
});

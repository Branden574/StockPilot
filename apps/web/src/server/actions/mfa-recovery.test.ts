import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub } from '@/test/supabase-mock';
import { verifiedSessionAuth, type StubbedCookieSession } from '@/test/verified-session-stub';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

/** The request's headers: the client address the address bucket is keyed on. */
const request = vi.hoisted(() => ({ headers: new Headers() }));
vi.mock('next/headers', () => ({ headers: vi.fn(async () => request.headers) }));

vi.mock('@/lib/auth/session', () => ({
  requireSession: vi.fn(async () => ({
    userId: 'user-1',
    email: 'u@example.test',
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

/**
 * The cookie session as the held read sees it (S50a): the verified token's
 * subject and level. The code is spent with that token, on the access-token
 * client, which this file hands the same stub so the RPC answers below apply.
 */
const cookie: { session: StubbedCookieSession } = { session: { sub: 'user-1', aal: 'aal1' } };

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () =>
    Object.assign(stubHolder.stub!.client, {
      auth: Object.assign(
        stubHolder.stub!.client.auth,
        verifiedSessionAuth(() => cookie.session),
      ),
    }),
  ),
}));

vi.mock('@/lib/supabase/access-token-client', () => ({
  createAccessTokenClient: vi.fn((_token: string) => stubHolder.stub!.client),
}));

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(() => stubHolder.stub!.client),
}));

vi.mock('@/server/services/auth-audit', () => ({
  emitAuthAudit: vi.fn(async () => {}),
  resolveDefaultOrgAndRole: vi.fn(async () => ({ organizationId: 'org-1', role: 'admin' })),
}));

import { revalidatePath } from 'next/cache';

import { verifyPasswordSideChannel } from '@/lib/auth/verify-password';
import { createAccessTokenClient } from '@/lib/supabase/access-token-client';
import { emitAuthAudit } from '@/server/services/auth-audit';

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
    cookie.session = { sub: 'user-1', aal: 'aal1' };
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

  // S78: the first gate is the account at this client address (a session of
  // the account at one address cannot spend the person's bucket at another);
  // with no address header the address is 'unknown' (lib/client-ip). The
  // buckets of the account at every address are pinned in the block below.
  it('keys the consume gate on the user and the client address with a 5-per-15-minutes budget', async () => {
    request.headers = new Headers();
    stubHolder.stub = makeSupabaseStub({
      ...LIMITER_OK,
      'rpc:consume_mfa_recovery_code': { data: true, error: null },
    });
    attachAdminMfa(stubHolder.stub, [{ id: 'f1', factor_type: 'totp' }]);

    await consumeMfaRecoveryCodeAction({ code: 'good-code', password: PW });

    expect(stubHolder.stub.rpcCalls[0]).toEqual({
      name: 'increment_rate_limit',
      args: { p_key: 'mfa-recovery:user-1:unknown', p_limit: 5, p_window_ms: 15 * 60_000 },
    });
  });

  /**
   * S50a: the code is checked as the account requireSession() validated, and
   * only as that account. The RPC runs with that account's verified access
   * token on a client that never loads or renews a session, after the password
   * check; anything else is refused before a code is spent.
   */
  it('spends the code with the verified token of the validated account, after the password check', async () => {
    stubHolder.stub = makeSupabaseStub({
      ...LIMITER_OK,
      'rpc:consume_mfa_recovery_code': { data: true, error: null },
    });
    attachAdminMfa(stubHolder.stub, [{ id: 'f1', factor_type: 'totp' }]);
    const result = await consumeMfaRecoveryCodeAction({ code: 'good-code', password: PW });
    expect(result.ok).toBe(true);
    expect(createAccessTokenClient).toHaveBeenCalledTimes(1);
    const [token] = vi.mocked(createAccessTokenClient).mock.calls[0]!;
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'),
    );
    expect(payload.sub).toBe('user-1');
    expect(vi.mocked(createAccessTokenClient).mock.invocationCallOrder[0]).toBeGreaterThan(
      vi.mocked(verifyPasswordSideChannel).mock.invocationCallOrder[0]!,
    );
  });

  it('refuses before spending, and removes nothing, when the verified session is not the validated account', async () => {
    cookie.session = { sub: 'user-2', aal: 'aal2' };
    stubHolder.stub = makeSupabaseStub({
      ...LIMITER_OK,
      'rpc:consume_mfa_recovery_code': { data: true, error: null },
    });
    const { listFactors, deleteFactor } = attachAdminMfa(stubHolder.stub, [
      { id: 'f1', factor_type: 'totp' },
    ]);
    const result = await consumeMfaRecoveryCodeAction({ code: 'good-code', password: PW });
    expect(result).toEqual({
      ok: false,
      error: {
        code: 'unauthenticated',
        message: 'Sign in again, then try again.',
        details: { reason: 'session_changed' },
      },
    });
    expect(createAccessTokenClient).not.toHaveBeenCalled();
    expect(stubHolder.stub.rpcCalls.some((c) => c.name === 'consume_mfa_recovery_code')).toBe(
      false,
    );
    expect(listFactors).not.toHaveBeenCalled();
    expect(deleteFactor).not.toHaveBeenCalled();
  });

  it('refuses the same way when there is no verified session', async () => {
    cookie.session = { sub: 'user-1', aal: 'aal1', read: 'error' };
    stubHolder.stub = makeSupabaseStub({
      ...LIMITER_OK,
      'rpc:consume_mfa_recovery_code': { data: true, error: null },
    });
    const { deleteFactor } = attachAdminMfa(stubHolder.stub, [{ id: 'f1', factor_type: 'totp' }]);
    const result = await consumeMfaRecoveryCodeAction({ code: 'good-code', password: PW });
    expect(result).toMatchObject({ ok: false, error: { code: 'unauthenticated' } });
    expect(stubHolder.stub.rpcCalls.some((c) => c.name === 'consume_mfa_recovery_code')).toBe(
      false,
    );
    expect(deleteFactor).not.toHaveBeenCalled();
  });
});

/**
 * The recovery code's limits (S78). One person at one place, and the account
 * at every address:
 *   - every press, before anything else, in the bucket of the account at this
 *     client address (5 per 15 minutes): a session holder at one address
 *     cannot spend the bucket of the real person at another;
 *   - every press that carries a password, before the password is checked,
 *     in the account's password bucket (15 per 15 minutes at every address):
 *     one address alone never fills it;
 *   - every press whose password checked out, before the code is checked, in
 *     the account's code bucket (5 per 15 minutes at every address).
 * All closed: a limiter that cannot answer refuses. The password check is
 * never reached without the first two.
 */
describe('consumeMfaRecoveryCodeAction — limits by address and by account', () => {
  const HERE = '198.51.100.8';
  const ELSEWHERE = '203.0.113.9';
  const PAUSED = 'Too many recovery-code attempts. Wait a few minutes and try again.';

  /** The limiter's answers by bucket: refused when `refuse(key)`. */
  function limiter(refuse: (key: string) => boolean = () => false) {
    return (call: { args: unknown[][] }) => {
      const key = (call.args[0]?.[0] as { p_key: string }).p_key;
      return refuse(key)
        ? { data: [{ allowed: false, count: 5, reset_at: null }], error: null }
        : { data: [{ allowed: true, count: 1, reset_at: null }], error: null };
    };
  }

  function limiterCalls() {
    return stubHolder
      .stub!.rpcCalls.filter((c) => c.name === 'increment_rate_limit')
      .map((c) => c.args as { p_key: string; p_limit: number; p_window_ms: number });
  }

  function codeChecked() {
    return stubHolder.stub!.rpcCalls.some((c) => c.name === 'consume_mfa_recovery_code');
  }

  beforeEach(() => {
    vi.clearAllMocks();
    cookie.session = { sub: 'user-1', aal: 'aal1' };
    request.headers = new Headers({ 'x-real-ip': HERE });
  });

  it('a press is counted first for the account at this address, 5 per 15 minutes, before the password check', async () => {
    stubHolder.stub = makeSupabaseStub({
      'rpc:increment_rate_limit': limiter(),
      'rpc:consume_mfa_recovery_code': { data: false, error: null },
    });

    await consumeMfaRecoveryCodeAction({ code: 'bad-code', password: PW });

    expect(limiterCalls()[0]).toEqual({
      p_key: `mfa-recovery:user-1:${HERE}`,
      p_limit: 5,
      p_window_ms: 15 * 60_000,
    });
  });

  it('a spent bucket at one address does not refuse the account at another address', async () => {
    stubHolder.stub = makeSupabaseStub({
      'rpc:increment_rate_limit': limiter((key) => key.endsWith(`:${ELSEWHERE}`)),
      'rpc:consume_mfa_recovery_code': { data: true, error: null },
    });
    const { deleteFactor } = attachAdminMfa(stubHolder.stub, [{ id: 'f1', factor_type: 'totp' }]);

    request.headers = new Headers({ 'x-real-ip': ELSEWHERE });
    const there = await consumeMfaRecoveryCodeAction({ code: 'good-code', password: PW });
    expect(there).toEqual({ ok: false, error: { code: 'validation_error', message: PAUSED } });
    expect(verifyPasswordSideChannel).not.toHaveBeenCalled();
    expect(codeChecked()).toBe(false);

    request.headers = new Headers({ 'x-real-ip': HERE });
    const here = await consumeMfaRecoveryCodeAction({ code: 'good-code', password: PW });
    expect(here).toEqual({ ok: true, data: { unenrolled: 1 } });
    expect(deleteFactor).toHaveBeenCalledTimes(1);
  });

  it('a press with no password spends no bucket of the account at every address', async () => {
    stubHolder.stub = makeSupabaseStub({ 'rpc:increment_rate_limit': limiter() });

    const res = await consumeMfaRecoveryCodeAction({ code: 'good-code' });

    expect(res).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    expect(limiterCalls().map((c) => c.p_key)).toEqual([`mfa-recovery:user-1:${HERE}`]);
  });

  it('a press with a password counts once in the account’s password bucket, 15 per 15 minutes, before the password check', async () => {
    stubHolder.stub = makeSupabaseStub({
      'rpc:increment_rate_limit': limiter(),
      'rpc:consume_mfa_recovery_code': { data: false, error: null },
    });

    await consumeMfaRecoveryCodeAction({ code: 'bad-code', password: PW });

    const password = limiterCalls().filter((c) => c.p_key === 'mfa-recovery-password:user-1');
    expect(password).toEqual([
      { p_key: 'mfa-recovery-password:user-1', p_limit: 15, p_window_ms: 15 * 60_000 },
    ]);
    // Counted before the password is checked: the limiter is the stub's
    // rpc, so its call order is the client's.
    const rpcOrder = stubHolder.stub.client.rpc.mock.invocationCallOrder as number[];
    const passwordIndex = stubHolder.stub.rpcCalls.findIndex(
      (c) => (c.args as { p_key?: string }).p_key === 'mfa-recovery-password:user-1',
    );
    expect(rpcOrder[passwordIndex]!).toBeLessThan(
      vi.mocked(verifyPasswordSideChannel).mock.invocationCallOrder[0]!,
    );
  });

  it('when the account’s password bucket is spent, no password is checked at any address', async () => {
    stubHolder.stub = makeSupabaseStub({
      'rpc:increment_rate_limit': limiter((key) => key.startsWith('mfa-recovery-password:')),
      'rpc:consume_mfa_recovery_code': { data: true, error: null },
    });

    const res = await consumeMfaRecoveryCodeAction({ code: 'good-code', password: PW });

    expect(res).toEqual({ ok: false, error: { code: 'validation_error', message: PAUSED } });
    expect(verifyPasswordSideChannel).not.toHaveBeenCalled();
    expect(codeChecked()).toBe(false);
  });

  it('a wrong password spends nothing of the account’s code bucket', async () => {
    vi.mocked(verifyPasswordSideChannel).mockResolvedValueOnce({
      ok: false,
      reason: 'invalid_password',
      message: 'Incorrect password.',
    } as Awaited<ReturnType<typeof verifyPasswordSideChannel>>);
    stubHolder.stub = makeSupabaseStub({ 'rpc:increment_rate_limit': limiter() });

    await consumeMfaRecoveryCodeAction({ code: 'good-code', password: 'wrong' });

    expect(limiterCalls().some((c) => c.p_key.startsWith('mfa-recovery-code:'))).toBe(false);
  });

  it('a press whose password checked out counts once in the account’s code bucket, 5 per 15 minutes, before the code is checked', async () => {
    stubHolder.stub = makeSupabaseStub({
      'rpc:increment_rate_limit': limiter(),
      'rpc:consume_mfa_recovery_code': { data: false, error: null },
    });

    await consumeMfaRecoveryCodeAction({ code: 'bad-code', password: PW });

    expect(limiterCalls().filter((c) => c.p_key === 'mfa-recovery-code:user-1')).toEqual([
      { p_key: 'mfa-recovery-code:user-1', p_limit: 5, p_window_ms: 15 * 60_000 },
    ]);
    const names = stubHolder.stub.rpcCalls.map((c) =>
      c.name === 'increment_rate_limit' ? (c.args as { p_key: string }).p_key : c.name,
    );
    expect(names.indexOf('mfa-recovery-code:user-1')).toBeLessThan(
      names.indexOf('consume_mfa_recovery_code'),
    );
  });

  it.each([
    ['spent', { data: [{ allowed: false, count: 5, reset_at: null }], error: null }],
    ['unable to answer (closed)', { data: null, error: { message: 'limiter down' } }],
  ])('when the account’s code bucket is %s, no code is checked and nothing is removed', async (_label, answer) => {
    stubHolder.stub = makeSupabaseStub({
      'rpc:increment_rate_limit': (call: { args: unknown[][] }) =>
        (call.args[0]?.[0] as { p_key: string }).p_key.startsWith('mfa-recovery-code:')
          ? answer
          : { data: [{ allowed: true, count: 1, reset_at: null }], error: null },
      'rpc:consume_mfa_recovery_code': { data: true, error: null },
    });
    const { deleteFactor } = attachAdminMfa(stubHolder.stub, [{ id: 'f1', factor_type: 'totp' }]);

    const res = await consumeMfaRecoveryCodeAction({ code: 'good-code', password: PW });

    expect(res).toEqual({ ok: false, error: { code: 'validation_error', message: PAUSED } });
    expect(codeChecked()).toBe(false);
    expect(deleteFactor).not.toHaveBeenCalled();
  });

  it('a password bucket that cannot answer refuses before the password check (closed)', async () => {
    stubHolder.stub = makeSupabaseStub({
      'rpc:increment_rate_limit': (call: { args: unknown[][] }) =>
        (call.args[0]?.[0] as { p_key: string }).p_key.startsWith('mfa-recovery-password:')
          ? { data: null, error: { message: 'limiter down' } }
          : { data: [{ allowed: true, count: 1, reset_at: null }], error: null },
    });

    const res = await consumeMfaRecoveryCodeAction({ code: 'good-code', password: PW });

    expect(res).toEqual({ ok: false, error: { code: 'validation_error', message: PAUSED } });
    expect(verifyPasswordSideChannel).not.toHaveBeenCalled();
  });
});

/**
 * The three recovery-code events audit.ts declares are written: a refused
 * code (no organization, like a refused authenticator code), a used code that
 * removed the authenticators, and new codes. Never the codes themselves.
 */
describe('consumeMfaRecoveryCodeAction — audit rows', () => {
  const SUBMITTED = 'abcd-efgh-ijkl';

  beforeEach(() => {
    vi.clearAllMocks();
    stubHolder.stub = null;
    // The held read's verified session names the validated account again: a
    // test above leaves it naming another account, or unreadable, and the
    // action then refuses before the code is checked and writes no row.
    cookie.session = { sub: 'user-1', aal: 'aal1' };
  });

  it('a refused recovery code writes mfa.recovery.failed with no organization, never the code', async () => {
    stubHolder.stub = makeSupabaseStub({
      ...LIMITER_OK,
      'rpc:consume_mfa_recovery_code': { data: false, error: null },
    });

    const result = await consumeMfaRecoveryCodeAction({ code: SUBMITTED, password: PW });

    expect(result.ok).toBe(false);
    expect(emitAuthAudit).toHaveBeenCalledTimes(1);
    expect(emitAuthAudit).toHaveBeenCalledWith({
      event: 'mfa.recovery.failed',
      userId: 'user-1',
      organizationId: null,
    });
    expect(JSON.stringify(vi.mocked(emitAuthAudit).mock.calls)).not.toContain(SUBMITTED);
  });

  it('a used recovery code writes mfa.recovery.consumed with the default organization and the count removed', async () => {
    stubHolder.stub = makeSupabaseStub({
      ...LIMITER_OK,
      'rpc:consume_mfa_recovery_code': { data: true, error: null },
    });
    attachAdminMfa(stubHolder.stub, [
      { id: 'f1', factor_type: 'totp' },
      { id: 'f2', factor_type: 'totp' },
    ]);

    const result = await consumeMfaRecoveryCodeAction({ code: SUBMITTED, password: PW });

    expect(result.ok).toBe(true);
    expect(emitAuthAudit).toHaveBeenCalledTimes(1);
    expect(emitAuthAudit).toHaveBeenCalledWith({
      event: 'mfa.recovery.consumed',
      userId: 'user-1',
      organizationId: 'org-1',
      extra: { unenrolled: 2 },
    });
    expect(JSON.stringify(vi.mocked(emitAuthAudit).mock.calls)).not.toContain(SUBMITTED);
  });

  it('writes no row when the code was never checked', async () => {
    vi.mocked(verifyPasswordSideChannel).mockResolvedValueOnce({
      ok: false,
      reason: 'invalid_password',
      message: 'Incorrect password.',
    } as Awaited<ReturnType<typeof verifyPasswordSideChannel>>);
    stubHolder.stub = makeSupabaseStub({
      ...LIMITER_OK,
      'rpc:consume_mfa_recovery_code': { data: false, error: null },
    });

    await consumeMfaRecoveryCodeAction({ code: SUBMITTED, password: PW });

    expect(emitAuthAudit).not.toHaveBeenCalled();
  });
});

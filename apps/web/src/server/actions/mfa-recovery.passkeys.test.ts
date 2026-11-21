import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub } from '@/test/supabase-mock';
import { PASSKEY_RECOVERY_NOT_YET } from '@/test/passkey-records';
import { verifiedSessionAuth } from '@/test/verified-session-stub';

/**
 * Security invariant: a recovery code removes every sign-in method of the
 * account, passkeys included, and is spent once (plan 2.6 G, review U3).
 *
 * consumeMfaRecoveryCodeAction, after the password and the held account:
 *   1. ONE call with the service role,
 *      consume_recovery_code_with_passkeys(account, code) (0475): it spends the
 *      code and, only when the code was the account's and unspent, marks every
 *      passkey removed and deletes the bridge record, in one transaction. Never
 *      through the member's token, and the member's own consume is not called;
 *      a code it did not accept gets today's refusal;
 *   2. the factor loop removes every TOTP factor, the bridge among them, and
 *      the audit row says how many passkeys went.
 * Before 0475 is live the function does not exist (PostgREST PGRST202,
 * Postgres 42883, each naming it): today's path runs unchanged. Any other
 * failure: today's path spends the code, the factors are still removed, the
 * passkey removal is tried once more (passkey_remove_all), and one report at
 * error level says whether passkey records may be left.
 */

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('next/headers', () => ({ headers: vi.fn(async () => new Headers()) }));
vi.mock('@/server/security/account-events', () => ({ recordAccountCodeBlocked: vi.fn() }));
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
vi.mock('@/server/services/auth-audit', () => ({
  emitAuthAudit: vi.fn(async () => {}),
  resolveDefaultOrgAndRole: vi.fn(async () => ({ organizationId: 'org-1', role: 'admin' })),
}));

type Stub = ReturnType<typeof makeSupabaseStub>;
const h = vi.hoisted(() => ({
  /** The service-role client: the limiter, the new function, the factor loop. */
  admin: null as unknown as { client: unknown },
  /** The client that acts as the member's verified token. */
  member: null as unknown as { client: unknown },
  cookie: null as unknown as { client: { auth: Record<string, unknown> } },
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () =>
    Object.assign(h.cookie.client, {
      auth: Object.assign(
        h.cookie.client.auth,
        verifiedSessionAuth(() => ({ sub: 'user-1', aal: 'aal1' })),
      ),
    }),
  ),
}));
vi.mock('@/lib/supabase/access-token-client', () => ({
  createAccessTokenClient: vi.fn(() => h.member.client),
}));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn(() => h.admin.client) }));

import { reportError } from '@/lib/error-reporter';
import { createAccessTokenClient } from '@/lib/supabase/access-token-client';
import { emitAuthAudit } from '@/server/services/auth-audit';

import { consumeMfaRecoveryCodeAction } from './mfa-recovery';

const PW = 'correct horse battery staple';
const CODE = 'ABCD-EFGH-IJKL-MNOP';
const LIMITER_OK = {
  'rpc:increment_rate_limit': { data: [{ allowed: true, count: 1, reset_at: null }], error: null },
} as const;
const BRIDGE_ID = '0b0b0b0b-0000-4000-8000-000000000001';
const FACTORS = [
  { id: 'app-1', factor_type: 'totp' },
  { id: BRIDGE_ID, factor_type: 'totp' },
];

function adminWith(results: Record<string, unknown>): Stub {
  const stub = makeSupabaseStub({ ...LIMITER_OK, ...results } as Parameters<
    typeof makeSupabaseStub
  >[0]);
  const deleteFactor = vi.fn(async () => ({ data: null, error: null }));
  const listFactors = vi.fn(async () => ({ data: { factors: FACTORS }, error: null }));
  stub.client.auth.admin = { mfa: { listFactors, deleteFactor } };
  h.admin = stub;
  return stub;
}
function memberWith(results: Record<string, unknown>): Stub {
  const stub = makeSupabaseStub(results as Parameters<typeof makeSupabaseStub>[0]);
  h.member = stub;
  return stub;
}
function deleteFactorOf(stub: Stub) {
  return (stub.client.auth.admin as { mfa: { deleteFactor: ReturnType<typeof vi.fn> } }).mfa
    .deleteFactor;
}
function rpcNames(stub: Stub) {
  return stub.rpcCalls.map((c) => c.name).filter((n) => n !== 'increment_rate_limit');
}
function consumedAudit() {
  return vi
    .mocked(emitAuthAudit)
    .mock.calls.find((c) => c[0].event === 'mfa.recovery.consumed')?.[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  h.cookie = makeSupabaseStub({}) as unknown as typeof h.cookie;
  memberWith({ 'rpc:consume_mfa_recovery_code': { data: true, error: null } });
});

describe('the recovery code with passkey records (0475 live)', () => {
  it('spends the code and removes the passkeys in ONE service-role call, then removes every factor', async () => {
    const admin = adminWith({
      'rpc:consume_recovery_code_with_passkeys': {
        data: [{ consumed: true, passkeys_removed: 2, bridge_factor_id: BRIDGE_ID }],
        error: null,
      },
    });

    const res = await consumeMfaRecoveryCodeAction({ code: CODE, password: PW });

    expect(res).toEqual({ ok: true, data: { unenrolled: 2 } });
    expect(rpcNames(admin)).toEqual(['consume_recovery_code_with_passkeys']);
    expect(
      admin.rpcCalls.find((c) => c.name === 'consume_recovery_code_with_passkeys')!.args,
    ).toEqual({
      p_user_id: 'user-1',
      p_code: CODE,
    });
    // Never through the member's token, and the member's own consume is not called.
    expect(createAccessTokenClient).not.toHaveBeenCalled();
    expect(h.member && rpcNames(h.member as Stub)).toEqual([]);
    expect(deleteFactorOf(admin).mock.calls.map((c) => (c[0] as { id: string }).id)).toEqual([
      'app-1',
      BRIDGE_ID,
    ]);
    expect(consumedAudit()).toEqual({
      event: 'mfa.recovery.consumed',
      userId: 'user-1',
      organizationId: 'org-1',
      extra: { unenrolled: 2, passkeys_removed: 2 },
    });
    expect(reportError).not.toHaveBeenCalled();
  });

  it('a code the function did not accept gets the refusal of today, and nothing is removed', async () => {
    const admin = adminWith({
      'rpc:consume_recovery_code_with_passkeys': {
        data: [{ consumed: false, passkeys_removed: 0, bridge_factor_id: null }],
        error: null,
      },
    });

    const res = await consumeMfaRecoveryCodeAction({ code: CODE, password: PW });

    expect(res).toEqual({
      ok: false,
      error: {
        code: 'validation_error',
        message: 'That recovery code is invalid or already used.',
      },
    });
    expect(deleteFactorOf(admin)).not.toHaveBeenCalled();
    expect(createAccessTokenClient).not.toHaveBeenCalled();
    expect(vi.mocked(emitAuthAudit).mock.calls.map((c) => c[0].event)).toEqual([
      'mfa.recovery.failed',
    ]);
    expect(rpcNames(admin)).toEqual(['consume_recovery_code_with_passkeys']);
  });
});

describe('before 0475 is live: the function does not exist', () => {
  it.each([
    ['PGRST202', PASSKEY_RECOVERY_NOT_YET['rpc:consume_recovery_code_with_passkeys'].error.message],
    ['42883', 'function public.consume_recovery_code_with_passkeys(uuid, text) does not exist'],
  ])('%s: today’s path runs unchanged, as the member, with no report', async (code, message) => {
    const admin = adminWith({
      'rpc:consume_recovery_code_with_passkeys': { data: null, error: { code, message } },
    });

    const res = await consumeMfaRecoveryCodeAction({ code: CODE, password: PW });

    expect(res).toEqual({ ok: true, data: { unenrolled: 2 } });
    expect(createAccessTokenClient).toHaveBeenCalledTimes(1);
    expect((h.member as Stub).rpcCalls).toEqual([
      { name: 'consume_mfa_recovery_code', args: { p_code: CODE } },
    ]);
    expect(rpcNames(admin)).toEqual(['consume_recovery_code_with_passkeys']);
    expect(deleteFactorOf(admin)).toHaveBeenCalledTimes(2);
    expect(consumedAudit()!.extra).toEqual({ unenrolled: 2 });
    expect(reportError).not.toHaveBeenCalled();
  });

  it('a refused code on that path gets the refusal of today', async () => {
    const admin = adminWith(PASSKEY_RECOVERY_NOT_YET);
    memberWith({ 'rpc:consume_mfa_recovery_code': { data: false, error: null } });

    const res = await consumeMfaRecoveryCodeAction({ code: CODE, password: PW });

    expect(res).toEqual({
      ok: false,
      error: {
        code: 'validation_error',
        message: 'That recovery code is invalid or already used.',
      },
    });
    expect(deleteFactorOf(admin)).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });
});

describe('any other failure of the new call', () => {
  const failures: Array<[string, unknown]> = [
    ['a database error', { data: null, error: { code: '57014', message: 'canceling statement' } }],
    [
      'a missing-function code that names another function',
      {
        data: null,
        error: { code: 'PGRST202', message: 'Could not find the function public.other(x)' },
      },
    ],
    ['an answer with no row', { data: [], error: null }],
    ['an answer that is not rows', { data: null, error: null }],
  ];

  it.each(failures)(
    '%s: today’s path spends the code, every factor goes, the passkey removal is tried again, one error report',
    async (_name, answer) => {
      const admin = adminWith({
        'rpc:consume_recovery_code_with_passkeys': answer,
        'rpc:passkey_remove_all': {
          data: [{ removed: 1, bridge_factor_id: BRIDGE_ID }],
          error: null,
        },
      });

      const res = await consumeMfaRecoveryCodeAction({ code: CODE, password: PW });

      expect(res).toEqual({ ok: true, data: { unenrolled: 2 } });
      expect((h.member as Stub).rpcCalls.map((c) => c.name)).toEqual(['consume_mfa_recovery_code']);
      expect(deleteFactorOf(admin)).toHaveBeenCalledTimes(2);
      expect(rpcNames(admin)).toEqual([
        'consume_recovery_code_with_passkeys',
        'passkey_remove_all',
      ]);
      expect(admin.rpcCalls.find((c) => c.name === 'passkey_remove_all')!.args).toEqual({
        p_user_id: 'user-1',
        p_reason: 'recovery_code',
      });
      expect(consumedAudit()!.extra).toEqual({ unenrolled: 2, passkeys_removed: 1 });
      expect(reportError).toHaveBeenCalledTimes(1);
      const [reported, context] = vi.mocked(reportError).mock.calls[0]!;
      expect(context).toMatchObject({
        tag: 'actions.mfa_recovery.passkey_removal',
        level: 'error',
        extra: { records_left: false },
      });
      const text = JSON.stringify([String(reported), context]);
      expect(text).not.toContain(CODE);
      expect(text).not.toContain(BRIDGE_ID);
    },
  );

  it('when the second removal fails too, the factors are still removed and the report says records may be left', async () => {
    const admin = adminWith({
      'rpc:consume_recovery_code_with_passkeys': {
        data: null,
        error: { code: '57014', message: 'x' },
      },
      'rpc:passkey_remove_all': { data: null, error: { code: '57014', message: 'x' } },
    });

    const res = await consumeMfaRecoveryCodeAction({ code: CODE, password: PW });

    expect(res).toEqual({ ok: true, data: { unenrolled: 2 } });
    expect(deleteFactorOf(admin)).toHaveBeenCalledTimes(2);
    expect(consumedAudit()!.extra).toEqual({ unenrolled: 2 });
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(vi.mocked(reportError).mock.calls[0]![1]).toMatchObject({
      tag: 'actions.mfa_recovery.passkey_removal',
      level: 'error',
      extra: { records_left: 'unknown' },
    });
  });

  it('when today’s path refuses the code, nothing is removed, and the failure is still reported', async () => {
    const admin = adminWith({
      'rpc:consume_recovery_code_with_passkeys': {
        data: null,
        error: { code: '57014', message: 'x' },
      },
    });
    memberWith({ 'rpc:consume_mfa_recovery_code': { data: false, error: null } });

    const res = await consumeMfaRecoveryCodeAction({ code: CODE, password: PW });

    expect(res.ok).toBe(false);
    expect(deleteFactorOf(admin)).not.toHaveBeenCalled();
    expect(rpcNames(admin)).toEqual(['consume_recovery_code_with_passkeys']);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(vi.mocked(reportError).mock.calls[0]![1]).toMatchObject({
      tag: 'actions.mfa_recovery.passkey_removal',
      level: 'error',
    });
  });
});

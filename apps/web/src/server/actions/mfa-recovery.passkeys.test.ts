import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub } from '@/test/supabase-mock';
import { PASSKEY_RECOVERY_NOT_YET } from '@/test/passkey-records';
import { liveSessionAuth, verifiedSessionAuth } from '@/test/verified-session-stub';

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
 * Postgres 42883, each naming it): today's path runs unchanged; when a factor
 * it removes carries the bridge's reserved name, that is reported at error
 * level, once per hour (review 2-3 finding 3). Any other failure: today's
 * path spends the code, the factors are still removed, the passkey removal is
 * tried once more (passkey_remove_all), and one report at error level, with a
 * hash of the account id, says whether passkey records may be left (finding
 * 7). When today's path then refuses the code, the combined call may have
 * spent it before its answer was lost: "try again", with no refused-code
 * record (finding 12).
 *
 * The answer never says a passkey was removed when its records are not KNOWN
 * to be removed (the review of the last deltas, finding 3): when a factor the
 * code removed carries the bridge's reserved name and the function is missing,
 * or the combined call and the second removal both failed, the answer and the
 * email say a passkey may be left (`methodsLeft: 'passkey'`), never
 * `passkeysRemoved`. An account with no such factor is answered as before.
 *
 * ORDER (review 2-3 finding 1): the service-role call takes the account as a
 * parameter, so it runs only after the three closed limits, the password
 * check and the held-session check. A press stopped by any of them makes no
 * service-role passkey call at all.
 */

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
// Stage 5 (answers Q6 and Q7 of the passkey plan): a used code also ends the
// account's other sessions as the held token and emails the account
// (mfa-recovery.other-sessions.test.ts covers both). Here Auth's sign-out
// answers, so nothing reaches a network, and no email is sent.
vi.mock('@/server/security/passkey-auth', () => ({
  signOutAs: vi.fn(async () => ({ ok: true, status: 204, code: null, body: null })),
}));
vi.mock('@/server/security/recovery-code-email', () => ({ sendRecoveryCodeUsedEmail: vi.fn() }));
vi.mock('@/server/services/sessions', () => ({
  listMySessionIds: vi.fn(async () => []),
  broadcastEndedSessions: vi.fn(async () => undefined),
}));
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
  /** Whose session the cookie's verified token names. */
  sessionSub: 'user-1',
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () =>
    Object.assign(h.cookie.client, {
      auth: Object.assign(
        h.cookie.client.auth,
        verifiedSessionAuth(() => ({ sub: h.sessionSub, aal: 'aal1' })),
        liveSessionAuth(),
      ),
    }),
  ),
}));
vi.mock('@/lib/supabase/access-token-client', () => ({
  createAccessTokenClient: vi.fn(() => h.member.client),
}));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn(() => h.admin.client) }));

import { createHash } from 'node:crypto';

import { verifyPasswordSideChannel } from '@/lib/auth/verify-password';
import { reportError } from '@/lib/error-reporter';
import { createAccessTokenClient } from '@/lib/supabase/access-token-client';
import { recordAccountCodeBlocked } from '@/server/security/account-events';
import { sendRecoveryCodeUsedEmail } from '@/server/security/recovery-code-email';
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
/** The same factors as Auth names them: the bridge carries the reserved name. */
const NAMED_FACTORS = [
  { id: 'app-1', factor_type: 'totp', friendly_name: 'Phone' },
  { id: BRIDGE_ID, factor_type: 'totp', friendly_name: 'sp-passkey-bridge-a1b2c3' },
];
/** The house hash of the account id in a report (lib/auth/login-device.ts). */
const USER_HASH = createHash('sha256').update('user-1').digest('hex').slice(0, 16);
const LIMIT_REFUSED = { data: [{ allowed: false, count: 6, reset_at: null }], error: null };
/** The service-role calls that act on a code or on the passkey records. */
const PASSKEY_CALLS = ['consume_recovery_code_with_passkeys', 'passkey_remove_all'];

function adminWith(results: Record<string, unknown>, factors: unknown[] = FACTORS): Stub {
  const stub = makeSupabaseStub({ ...LIMITER_OK, ...results } as Parameters<
    typeof makeSupabaseStub
  >[0]);
  const deleteFactor = vi.fn(async () => ({ data: null, error: null }));
  const listFactors = vi.fn(async () => ({ data: { factors }, error: null }));
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
/** A limiter answer that refuses the bucket whose key starts with `prefix`, and allows the rest. */
function refusingBucket(prefix: string) {
  return {
    'rpc:increment_rate_limit': (call: { args: unknown[][] }) =>
      String((call.args[0]?.[0] as { p_key?: unknown } | undefined)?.p_key).startsWith(prefix)
        ? LIMIT_REFUSED
        : LIMITER_OK['rpc:increment_rate_limit'],
  };
}
/** The records-missing reports (lib/auth/passkey-bridge.ts reportPasskeyRecordsMissing). */
function recordsMissingReports() {
  return vi.mocked(reportError).mock.calls.filter((c) => c[1].tag === 'passkeys.records_missing');
}
function consumedAudit() {
  return vi
    .mocked(emitAuthAudit)
    .mock.calls.find((c) => c[0].event === 'mfa.recovery.consumed')?.[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  h.sessionSub = 'user-1';
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

    // Stage 5 (the review's finding 1): the answer also says the passkeys went; the
    // count of apps is pinned with factors as Auth names them
    // (mfa-recovery.other-sessions.test.ts).
    expect(res).toMatchObject({ ok: true, data: { unenrolled: 2, passkeysRemoved: true } });
    expect(rpcNames(admin)).toEqual(['consume_recovery_code_with_passkeys']);
    expect(
      admin.rpcCalls.find((c) => c.name === 'consume_recovery_code_with_passkeys')!.args,
    ).toEqual({
      p_user_id: 'user-1',
      p_code: CODE,
    });
    // Never through the member's token: the member's own consume is not
    // called. (Since stage 5 the held token's client lists and ends the other
    // sessions after the factors: mfa-recovery.other-sessions.test.ts.)
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
    // A refused code is a security event of the account's organization.
    expect(recordAccountCodeBlocked).toHaveBeenCalledTimes(1);
    expect(vi.mocked(recordAccountCodeBlocked).mock.calls[0]!.slice(0, 2)).toEqual([
      'wrong_recovery_code',
      'user-1',
    ]);
  });
});

describe('the service-role call stays behind the limits, the password and the held session', () => {
  const PASSKEYS_ANSWER = {
    'rpc:consume_recovery_code_with_passkeys': {
      data: [{ consumed: true, passkeys_removed: 1, bridge_factor_id: BRIDGE_ID }],
      error: null,
    },
  };
  function noPasskeyCall(admin: Stub) {
    expect(rpcNames(admin).filter((n) => PASSKEY_CALLS.includes(n))).toEqual([]);
    expect(deleteFactorOf(admin)).not.toHaveBeenCalled();
    expect(createAccessTokenClient).not.toHaveBeenCalled();
  }

  it('no password: no service-role passkey call', async () => {
    const admin = adminWith(PASSKEYS_ANSWER);
    const res = await consumeMfaRecoveryCodeAction({ code: CODE });
    expect(res.ok).toBe(false);
    noPasskeyCall(admin);
  });

  it('a wrong password: no service-role passkey call', async () => {
    const admin = adminWith(PASSKEYS_ANSWER);
    vi.mocked(verifyPasswordSideChannel).mockResolvedValueOnce({
      ok: false,
      reason: 'invalid_password',
      message: 'That password is incorrect.',
    } as never);
    const res = await consumeMfaRecoveryCodeAction({ code: CODE, password: 'not it' });
    expect(res).toEqual({
      ok: false,
      error: { code: 'forbidden', message: 'That password is incorrect.' },
    });
    noPasskeyCall(admin);
  });

  it.each([
    ['the account at this address', 'mfa-recovery:user-1:'],
    ['the password checks of the account', 'mfa-recovery-password:user-1'],
    ['the code checks of the account', 'mfa-recovery-code:user-1'],
  ])('the limit of %s refuses: no service-role passkey call', async (_name, prefix) => {
    const admin = adminWith({ ...PASSKEYS_ANSWER, ...refusingBucket(prefix) });
    const res = await consumeMfaRecoveryCodeAction({ code: CODE, password: PW });
    expect(res.ok).toBe(false);
    expect(
      admin.rpcCalls.some(
        (c) =>
          c.name === 'increment_rate_limit' &&
          String((c.args as { p_key: string }).p_key).startsWith(prefix),
      ),
    ).toBe(true);
    noPasskeyCall(admin);
  });

  it('a session that no longer verifies as the account: no service-role passkey call', async () => {
    const admin = adminWith(PASSKEYS_ANSWER);
    h.sessionSub = 'user-2';
    const res = await consumeMfaRecoveryCodeAction({ code: CODE, password: PW });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('unauthenticated');
    noPasskeyCall(admin);
  });

  it('with every check passed, the call is made once, for the validated account', async () => {
    const admin = adminWith(PASSKEYS_ANSWER);
    await consumeMfaRecoveryCodeAction({ code: CODE, password: PW });
    expect(
      admin.rpcCalls.filter((c) => c.name === 'consume_recovery_code_with_passkeys'),
    ).toEqual([
      { name: 'consume_recovery_code_with_passkeys', args: { p_user_id: 'user-1', p_code: CODE } },
    ]);
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

  it('a factor it removes carries the reserved name: one error report, once per hour for this account, with the account hash only', async () => {
    const admin = adminWith(PASSKEY_RECOVERY_NOT_YET, NAMED_FACTORS);

    const res = await consumeMfaRecoveryCodeAction({ code: CODE, password: PW });

    // The function is missing, so the passkey records were not removed: the
    // answer says a passkey may be left, never that the passkeys were removed.
    expect(res).toEqual({
      ok: true,
      data: { unenrolled: 2, appsRemoved: 1, methodsLeft: 'passkey' },
    });
    expect(deleteFactorOf(admin)).toHaveBeenCalledTimes(2);
    expect(
      admin.rpcCalls.some(
        (c) =>
          c.name === 'increment_rate_limit' &&
          (c.args as { p_key: string }).p_key === 'passkeys-records-missing-report:function:user-1',
      ),
    ).toBe(true);
    const reports = recordsMissingReports();
    expect(reports).toHaveLength(1);
    expect(reports[0]![1]).toEqual({
      tag: 'passkeys.records_missing',
      level: 'error',
      userIdHash: USER_HASH,
      extra: { missing: 'function', site: 'recovery_code' },
    });
    expect(JSON.stringify(reports)).not.toMatch(/user-1|0b0b0b0b|ABCD/);
  });

  it('the same, a second time in the hour: not reported again', async () => {
    adminWith(
      {
        ...PASSKEY_RECOVERY_NOT_YET,
        ...refusingBucket('passkeys-records-missing-report:'),
      },
      NAMED_FACTORS,
    );
    const res = await consumeMfaRecoveryCodeAction({ code: CODE, password: PW });
    expect(res).toEqual({
      ok: true,
      data: { unenrolled: 2, appsRemoved: 1, methodsLeft: 'passkey' },
    });
    expect(recordsMissingReports()).toEqual([]);
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

      // Stage 5 (the review's finding 1): the answer also says the passkeys went; the
      // count of apps is pinned with factors as Auth names them
      // (mfa-recovery.other-sessions.test.ts).
      expect(res).toMatchObject({ ok: true, data: { unenrolled: 2, passkeysRemoved: true } });
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
      expect(context).toEqual({
        tag: 'actions.mfa_recovery.passkey_removal',
        level: 'error',
        userIdHash: USER_HASH,
        extra: { failure: expect.any(String), records_left: false },
      });
      const text = JSON.stringify([String(reported), context]);
      expect(text).not.toContain(CODE);
      expect(text).not.toContain(BRIDGE_ID);
      expect(text).not.toContain('user-1');
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

  it('when the second removal fails too and a removed factor carries the reserved name: a passkey may be left, never "removed", in the answer and the email', async () => {
    const admin = adminWith(
      {
        'rpc:consume_recovery_code_with_passkeys': {
          data: null,
          error: { code: '57014', message: 'x' },
        },
        'rpc:passkey_remove_all': { data: null, error: { code: '57014', message: 'x' } },
      },
      NAMED_FACTORS,
    );

    const res = await consumeMfaRecoveryCodeAction({ code: CODE, password: PW });

    // Both factors went at Auth; the passkey records are not known removed.
    expect(res).toEqual({
      ok: true,
      data: { unenrolled: 2, appsRemoved: 1, methodsLeft: 'passkey' },
    });
    expect(res.ok && 'passkeysRemoved' in res.data).toBe(false);
    expect(deleteFactorOf(admin)).toHaveBeenCalledTimes(2);
    expect(rpcNames(admin)).toEqual(['consume_recovery_code_with_passkeys', 'passkey_remove_all']);
    expect(sendRecoveryCodeUsedEmail).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendRecoveryCodeUsedEmail).mock.calls[0]![2]).toEqual({
      passkeys: true,
      othersSignedOut: true,
      methodsLeft: 'passkey',
    });
    expect(consumedAudit()!.extra).toEqual({ unenrolled: 2 });
    const reports = vi.mocked(reportError).mock.calls.map((c) => [c[1].tag, c[1].extra]);
    expect(reports).toEqual([
      ['actions.mfa_recovery.passkey_removal', { failure: '57014', records_left: 'unknown' }],
      ['actions.mfa_recovery.methods_left', { methods_left: 'passkey', failed: 0 }],
    ]);
    const text = JSON.stringify(vi.mocked(reportError).mock.calls.map((c) => [String(c[0]), c[1]]));
    for (const secret of [CODE, BRIDGE_ID, 'user-1', 'sp-passkey-bridge']) {
      expect(text).not.toContain(secret);
    }
  });

  it('when the second removal answers, the passkeys are known removed: said so, as before', async () => {
    adminWith(
      {
        'rpc:consume_recovery_code_with_passkeys': {
          data: null,
          error: { code: '57014', message: 'x' },
        },
        'rpc:passkey_remove_all': {
          data: [{ removed: 1, bridge_factor_id: BRIDGE_ID }],
          error: null,
        },
      },
      NAMED_FACTORS,
    );
    const res = await consumeMfaRecoveryCodeAction({ code: CODE, password: PW });
    expect(res).toEqual({
      ok: true,
      data: { unenrolled: 2, passkeysRemoved: true, appsRemoved: 1 },
    });
    expect(vi.mocked(sendRecoveryCodeUsedEmail).mock.calls[0]![2]).toEqual({
      passkeys: true,
      othersSignedOut: true,
    });
  });

  it('when today’s path then refuses the code (the answer may have been lost): try again, no refused-code record, still reported', async () => {
    const admin = adminWith({
      'rpc:consume_recovery_code_with_passkeys': {
        data: null,
        error: { code: '57014', message: 'x' },
      },
    });
    memberWith({ 'rpc:consume_mfa_recovery_code': { data: false, error: null } });

    const res = await consumeMfaRecoveryCodeAction({ code: CODE, password: PW });

    // The combined call may have spent the code before its answer was lost:
    // the code is not called wrong.
    expect(res).toEqual({
      ok: false,
      error: {
        code: 'internal_error',
        message: 'Could not check your recovery code just now. Try again.',
      },
    });
    expect(deleteFactorOf(admin)).not.toHaveBeenCalled();
    expect(rpcNames(admin)).toEqual(['consume_recovery_code_with_passkeys']);
    expect(recordAccountCodeBlocked).not.toHaveBeenCalled();
    expect(vi.mocked(emitAuthAudit).mock.calls.map((c) => c[0].event)).toEqual([]);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(vi.mocked(reportError).mock.calls[0]![1]).toEqual({
      tag: 'actions.mfa_recovery.passkey_removal',
      level: 'error',
      userIdHash: USER_HASH,
      extra: { failure: '57014', records_left: 'unknown' },
    });
  });
});

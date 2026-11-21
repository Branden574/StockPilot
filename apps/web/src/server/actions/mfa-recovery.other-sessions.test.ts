import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub } from '@/test/supabase-mock';
import { PASSKEY_RECOVERY_NOT_YET } from '@/test/passkey-records';

/**
 * Stage 5, the answers to Q6 and Q7: what a USED recovery code changes, for
 * every account, with or without a passkey (plan 2.6 G step 4, section 4).
 *
 * After the code is spent and every TOTP factor removed (as before):
 *   1. every OTHER session of the account ends: a sign-out of scope `others`
 *      as the verified token the action holds (never `global`, never `local`):
 *      the session that used the code STAYS signed in, and the person sets up
 *      a new method next. When Auth's sign-out fails, the database ends the
 *      other sessions instead (revoke_my_other_sessions, as the member, with
 *      THIS session's id kept), and only with a session id (null would end
 *      this one too). The devices hear which sessions ended (never the one
 *      that stays). A sign-out that could not be confirmed is reported;
 *   2. the account is emailed through the security family: "Your StockPilot
 *      sign-in methods were removed", with "If this was not you, reset your
 *      password now";
 *   3. the answer flags other sessions that could not be ended
 *      (`otherSessionsLeft`), so the form says so.
 * NOTHING ELSE changes for an account with no passkey: the same refusals,
 * the same factor removal, the same audit row, the same answer when every
 * other session ended; and a refused code ends nothing and sends nothing.
 */

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('next/headers', () => ({ headers: vi.fn(async () => new Headers()) }));
vi.mock('@/server/security/account-events', () => ({ recordAccountCodeBlocked: vi.fn() }));
vi.mock('@/lib/auth/session', () => ({
  requireSession: vi.fn(async () => ({
    userId: 'user-1',
    email: 'member@example.test',
    fullName: null,
    avatarUrl: null,
    defaultOrganizationId: 'org-1',
  })),
}));
vi.mock('@/lib/auth/verify-password', () => ({
  verifyPasswordSideChannel: vi.fn(async () => ({ ok: true })),
}));
vi.mock('@/server/services/auth-audit', () => ({
  emitAuthAudit: vi.fn(async () => true),
  resolveDefaultOrgAndRole: vi.fn(async () => ({ organizationId: 'org-1', role: 'admin' })),
}));
// The Auth call as the member's token (a plain fetch in the real module).
vi.mock('@/server/security/passkey-auth', () => ({ signOutAs: vi.fn() }));
vi.mock('@/server/services/sessions', () => ({
  listMySessionIds: vi.fn(),
  broadcastEndedSessions: vi.fn(async () => undefined),
}));
// The email is rendered for real and handed to the transport after the response.
vi.mock('@/lib/email/resend', () => ({
  sendEmail: vi.fn(async () => ({ ok: true, id: 'sample' })),
}));
vi.mock('@/server/services/lib/defer', () => ({
  defer: (fn: () => Promise<unknown>) => void fn(),
  keepAlive: () => undefined,
}));

type Stub = ReturnType<typeof makeSupabaseStub>;
const h = vi.hoisted(() => ({
  admin: null as unknown as { client: unknown },
  member: null as unknown as { client: unknown },
  /** The cookie client: its sign-out must never be called. */
  cookieSignOut: null as unknown as (...args: unknown[]) => Promise<{ error: null }>,
  /** The verified token's session id (null: a token without one). */
  sessionId: 'sess-this' as string | null,
}));

const seg = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
/** The cookie session's token: account user-1, this session, aal1 (the code page). */
const tokenNow = () =>
  `${seg({ alg: 'none', typ: 'JWT' })}.${seg({
    sub: 'user-1',
    aal: 'aal1',
    ...(h.sessionId ? { session_id: h.sessionId } : {}),
  })}.`;

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: {
      getSession: async () => ({ data: { session: { access_token: tokenNow() } }, error: null }),
      getClaims: async (token: string) => ({
        data: {
          claims: JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')),
          header: {},
          signature: null,
        },
        error: null,
      }),
      signOut: (...args: unknown[]) => h.cookieSignOut(...args),
    },
  })),
}));
vi.mock('@/lib/supabase/access-token-client', () => ({
  createAccessTokenClient: vi.fn(() => h.member.client),
}));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn(() => h.admin.client) }));

import { verifyPasswordSideChannel } from '@/lib/auth/verify-password';
import { sendEmail } from '@/lib/email/resend';
import { reportError } from '@/lib/error-reporter';
import { createAccessTokenClient } from '@/lib/supabase/access-token-client';
import { signOutAs } from '@/server/security/passkey-auth';
import { emitAuthAudit } from '@/server/services/auth-audit';
import { broadcastEndedSessions, listMySessionIds } from '@/server/services/sessions';

import { consumeMfaRecoveryCodeAction } from './mfa-recovery';

const PW = 'sample-password-not-real';
const CODE = 'ABCD-EFGH-IJKL-MNOP';
const LIMITER_OK = {
  'rpc:increment_rate_limit': { data: [{ allowed: true, count: 1, reset_at: null }], error: null },
} as const;
const APP = { id: 'app-1', factor_type: 'totp', friendly_name: 'Phone' };
const BRIDGE = { id: 'bridge-1', factor_type: 'totp', friendly_name: 'sp-passkey-bridge-a1b2c3' };
/** The account's sessions as list_my_sessions names them: this one and two devices. */
const LISTED = ['sess-this', 'sess-phone', 'sess-laptop'];
const SIGNED_OUT = { ok: true, status: 204, code: null, body: null };
const NOT_SIGNED_OUT = { ok: false, status: 0, code: 'request_failed', body: null };

const DONE = { ok: true, data: { unenrolled: 1 } };
const SUBJECT = 'Your StockPilot sign-in methods were removed';

function adminWith(results: Record<string, unknown>, factors: unknown[] = [APP]): Stub {
  const stub = makeSupabaseStub({ ...LIMITER_OK, ...results } as Parameters<
    typeof makeSupabaseStub
  >[0]);
  const deleteFactor = vi.fn(async () => ({ data: null, error: null }));
  const listFactors = vi.fn(async () => ({ data: { factors }, error: null }));
  stub.client.auth.admin = { mfa: { listFactors, deleteFactor } };
  h.admin = stub;
  return stub;
}
function memberWith(results: Record<string, unknown> = {}): Stub {
  const stub = makeSupabaseStub({
    'rpc:consume_mfa_recovery_code': { data: true, error: null },
    'rpc:revoke_my_other_sessions': { data: null, error: null },
    ...results,
  } as Parameters<typeof makeSupabaseStub>[0]);
  h.member = stub;
  return stub;
}
/** Before 0475: today's consume as the member. */
const beforeRecords = () => adminWith(PASSKEY_RECOVERY_NOT_YET);
/** 0475 live, an account with no passkey: the one call answers, nothing of passkeys removed. */
const recordsNoPasskey = () =>
  adminWith({
    'rpc:consume_recovery_code_with_passkeys': {
      data: [{ consumed: true, passkeys_removed: 0, bridge_factor_id: null }],
      error: null,
    },
  });
const memberRpcs = () => (h.member as Stub).rpcCalls.map((c) => c.name);
const deleteFactorOf = (stub: Stub) =>
  (stub.client.auth.admin as { mfa: { deleteFactor: ReturnType<typeof vi.fn> } }).mfa.deleteFactor;
function sent() {
  return vi.mocked(sendEmail).mock.calls.map(
    (c) =>
      c[0] as {
        to: string;
        subject: string;
        text: string;
        html: string;
        from?: string;
      },
  );
}
function sessionReports() {
  return vi
    .mocked(reportError)
    .mock.calls.filter((c) => c[1]?.tag === 'actions.mfa_recovery.other_sessions_not_ended');
}

beforeEach(() => {
  vi.clearAllMocks();
  h.sessionId = 'sess-this';
  h.cookieSignOut = vi.fn(async () => ({ error: null }));
  memberWith();
  vi.mocked(signOutAs).mockResolvedValue(SIGNED_OUT);
  vi.mocked(listMySessionIds).mockResolvedValue([...LISTED]);
});

describe.each([
  ['before 0475 (today’s consume)', beforeRecords],
  ['with 0475 live, no passkey', recordsNoPasskey],
])('an account with no passkey, %s: what a used code changes', (_when, admin) => {
  it('the OTHER sessions end, as this session’s own token, after the factors are removed; this session stays', async () => {
    const a = admin();
    const res = await consumeMfaRecoveryCodeAction({ code: CODE, password: PW });

    expect(res).toEqual(DONE);
    // Scope `others`, with the token the action verified as this account.
    expect(vi.mocked(signOutAs).mock.calls).toHaveLength(1);
    const [token, scope] = vi.mocked(signOutAs).mock.calls[0]!;
    expect(scope).toBe('others');
    expect(
      JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')),
    ).toMatchObject({ sub: 'user-1', session_id: 'sess-this' });
    // After the code is spent and the factors removed.
    expect(vi.mocked(signOutAs).mock.invocationCallOrder[0]).toBeGreaterThan(
      deleteFactorOf(a).mock.invocationCallOrder.at(-1)!,
    );
    // This session is never signed out: no cookie sign-out, no database
    // revoke when Auth's sign-out answered.
    expect(h.cookieSignOut).not.toHaveBeenCalled();
    expect(memberRpcs()).not.toContain('revoke_my_other_sessions');
  });

  it('the devices hear which sessions ended, listed before the sign-out, never the one that stays', async () => {
    admin();
    await consumeMfaRecoveryCodeAction({ code: CODE, password: PW });
    expect(vi.mocked(listMySessionIds).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(signOutAs).mock.invocationCallOrder[0]!,
    );
    // Listed as the member (the held token's client), never the cookie session.
    expect(vi.mocked(listMySessionIds).mock.calls[0]![0]).toBe((h.member as Stub).client);
    expect(broadcastEndedSessions).toHaveBeenCalledWith('user-1', LISTED, 'sess-this');
  });

  it('one email, through the security family, says the methods were removed and the other devices signed out; it names no passkey', async () => {
    admin();
    await consumeMfaRecoveryCodeAction({ code: CODE, password: PW });
    const mails = sent();
    expect(mails).toHaveLength(1);
    const mail = mails[0]!;
    expect(mail.to).toBe('member@example.test');
    expect(mail.subject).toBe(SUBJECT);
    expect(mail.from).toBe('StockPilot Security <security@stockpilotusa.com>');
    expect(mail.text).toContain('a recovery code was used on your StockPilot account on ');
    expect(mail.text).toContain(
      'Every authenticator app was removed, and your other devices were signed out.',
    );
    expect(mail.text).toContain('If this was not you, reset your password now');
    expect(`${mail.text}\n${mail.html}`).not.toMatch(/passkey/i);
  });

  it('nothing else changes: the same factor removal, the same audit row, no report', async () => {
    const a = admin();
    await consumeMfaRecoveryCodeAction({ code: CODE, password: PW });
    expect(deleteFactorOf(a).mock.calls.map((c) => (c[0] as { id: string }).id)).toEqual(['app-1']);
    const rows = vi.mocked(emitAuthAudit).mock.calls.map((c) => c[0]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.event).toBe('mfa.recovery.consumed');
    expect(rows[0]!.organizationId).toBe('org-1');
    // The row as stage 2 wrote it: the count, and passkeys_removed only when
    // 0475 answered (0 for an account with no passkey).
    expect(Object.keys(rows[0]!.extra ?? {}).sort()).toEqual(
      admin === beforeRecords ? ['unenrolled'] : ['passkeys_removed', 'unenrolled'],
    );
    expect(reportError).not.toHaveBeenCalled();
  });
});

describe('when Auth’s sign-out of the other sessions fails', () => {
  beforeEach(() => {
    vi.mocked(signOutAs).mockResolvedValue(NOT_SIGNED_OUT);
  });

  it('the database ends them instead, as the member, keeping THIS session; the devices hear; one warning', async () => {
    beforeRecords();
    const res = await consumeMfaRecoveryCodeAction({ code: CODE, password: PW });

    expect(res).toEqual(DONE);
    expect(
      (h.member as Stub).rpcCalls.filter((c) => c.name === 'revoke_my_other_sessions'),
    ).toEqual([{ name: 'revoke_my_other_sessions', args: { p_keep_session_id: 'sess-this' } }]);
    expect(h.cookieSignOut).not.toHaveBeenCalled();
    expect(broadcastEndedSessions).toHaveBeenCalledWith('user-1', LISTED, 'sess-this');
    const reports = sessionReports();
    expect(reports).toHaveLength(1);
    expect(reports[0]![1]).toMatchObject({
      level: 'warning',
      extra: { code: 'request_failed', status: 0, database_revoke: 'ok' },
    });
    expect(sent()[0]!.text).toContain('your other devices were signed out');
  });

  it('the database revoke fails too: the answer says so, nothing is broadcast, an error report, and the email says the devices were NOT signed out', async () => {
    beforeRecords();
    memberWith({ 'rpc:revoke_my_other_sessions': { data: null, error: { message: 'timeout' } } });
    const res = await consumeMfaRecoveryCodeAction({ code: CODE, password: PW });

    expect(res).toEqual({ ok: true, data: { unenrolled: 1, otherSessionsLeft: true } });
    expect(broadcastEndedSessions).not.toHaveBeenCalled();
    expect(sessionReports().map((r) => r[1])).toEqual([
      expect.objectContaining({
        level: 'error',
        extra: expect.objectContaining({ database_revoke: 'failed' }),
      }),
    ]);
    const text = sent()[0]!.text;
    expect(text).toContain('Every authenticator app was removed.');
    expect(text).toContain('We could not sign out your other devices.');
    expect(text).not.toContain('your other devices were signed out');
  });

  it('a token with no session id: never the database revoke (null would end this session too)', async () => {
    beforeRecords();
    h.sessionId = null;
    const res = await consumeMfaRecoveryCodeAction({ code: CODE, password: PW });

    expect(res).toEqual({ ok: true, data: { unenrolled: 1, otherSessionsLeft: true } });
    expect(memberRpcs()).not.toContain('revoke_my_other_sessions');
    expect(broadcastEndedSessions).not.toHaveBeenCalled();
    expect(sessionReports()[0]![1]).toMatchObject({
      level: 'error',
      extra: { database_revoke: 'no_session_id' },
    });
  });

  it('the report carries a hash of the account, never the id, the token or the code', async () => {
    beforeRecords();
    await consumeMfaRecoveryCodeAction({ code: CODE, password: PW });
    const report = JSON.stringify(sessionReports());
    expect(report).toContain('userIdHash');
    expect(report).not.toContain('user-1');
    expect(report).not.toContain(CODE);
    expect(report).not.toContain('sess-this');
  });
});

describe('a refused or stopped press ends nothing and sends nothing', () => {
  function nothingEnded() {
    expect(signOutAs).not.toHaveBeenCalled();
    expect(listMySessionIds).not.toHaveBeenCalled();
    expect(broadcastEndedSessions).not.toHaveBeenCalled();
    expect(memberRpcs()).not.toContain('revoke_my_other_sessions');
    expect(h.cookieSignOut).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  }

  it('no password', async () => {
    beforeRecords();
    await consumeMfaRecoveryCodeAction({ code: CODE });
    nothingEnded();
  });

  it('a wrong password', async () => {
    beforeRecords();
    vi.mocked(verifyPasswordSideChannel).mockResolvedValueOnce({
      ok: false,
      reason: 'invalid_password',
      message: 'That password is incorrect.',
    } as never);
    await consumeMfaRecoveryCodeAction({ code: CODE, password: 'not it' });
    nothingEnded();
  });

  it('a code that is not the account’s (today’s consume)', async () => {
    beforeRecords();
    memberWith({ 'rpc:consume_mfa_recovery_code': { data: false, error: null } });
    const res = await consumeMfaRecoveryCodeAction({ code: CODE, password: PW });
    expect(res.ok).toBe(false);
    nothingEnded();
  });

  it('a code the 0475 function did not accept', async () => {
    adminWith({
      'rpc:consume_recovery_code_with_passkeys': {
        data: [{ consumed: false, passkeys_removed: 0, bridge_factor_id: null }],
        error: null,
      },
    });
    const res = await consumeMfaRecoveryCodeAction({ code: CODE, password: PW });
    expect(res.ok).toBe(false);
    nothingEnded();
  });

  it('the combined call failed and today’s consume refused ("try again")', async () => {
    adminWith({
      'rpc:consume_recovery_code_with_passkeys': {
        data: null,
        error: { code: '57014', message: 'x' },
      },
    });
    memberWith({ 'rpc:consume_mfa_recovery_code': { data: false, error: null } });
    const res = await consumeMfaRecoveryCodeAction({ code: CODE, password: PW });
    expect(res).toEqual({
      ok: false,
      error: {
        code: 'internal_error',
        message: 'Could not check your recovery code just now. Try again.',
      },
    });
    nothingEnded();
  });

  it('a limit refuses', async () => {
    adminWith({
      ...PASSKEY_RECOVERY_NOT_YET,
      'rpc:increment_rate_limit': {
        data: [{ allowed: false, count: 6, reset_at: null }],
        error: null,
      },
    });
    await consumeMfaRecoveryCodeAction({ code: CODE, password: PW });
    nothingEnded();
  });
});

describe('the member client is made once, after the password check', () => {
  it('today’s consume and the session list share one client of the held token', async () => {
    beforeRecords();
    await consumeMfaRecoveryCodeAction({ code: CODE, password: PW });
    expect(createAccessTokenClient).toHaveBeenCalledTimes(1);
    expect(memberRpcs()).toEqual(['consume_mfa_recovery_code']);
  });
});

describe('an account with passkeys (0475 live)', () => {
  it('the email names the passkeys too', async () => {
    adminWith(
      {
        'rpc:consume_recovery_code_with_passkeys': {
          data: [{ consumed: true, passkeys_removed: 2, bridge_factor_id: BRIDGE.id }],
          error: null,
        },
      },
      [APP, BRIDGE],
    );
    const res = await consumeMfaRecoveryCodeAction({ code: CODE, password: PW });
    expect(res).toEqual({ ok: true, data: { unenrolled: 2 } });
    expect(sent()[0]!.text).toContain(
      'Every authenticator app and passkey was removed, and your other devices were signed out.',
    );
  });

  it('before the records answer, a removed factor carrying the reserved name still counts as a passkey for the words', async () => {
    adminWith(PASSKEY_RECOVERY_NOT_YET, [APP, BRIDGE]);
    await consumeMfaRecoveryCodeAction({ code: CODE, password: PW });
    expect(sent()[0]!.text).toContain('Every authenticator app and passkey was removed');
  });
});

describe('the email never changes the answer', () => {
  it('a send that fails is reported and the code is still used', async () => {
    beforeRecords();
    vi.mocked(sendEmail).mockResolvedValueOnce({ ok: false, error: 'sample failure' } as never);
    const res = await consumeMfaRecoveryCodeAction({ code: CODE, password: PW });
    expect(res).toEqual(DONE);
    expect(
      vi
        .mocked(reportError)
        .mock.calls.filter((c) => c[1]?.tag === 'actions.mfa_recovery.email_failed'),
    ).toHaveLength(1);
  });
});

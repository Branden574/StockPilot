import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PASSKEY_RECOVERY_NOT_YET } from '@/test/passkey-records';
import { makeSupabaseStub } from '@/test/supabase-mock';

/**
 * The rule (the second lab walk, RS5 20): a recovery code is spent only by a
 * session that Auth still holds.
 *
 * The action verifies the cookie session's token LOCALLY (getClaims), and
 * PostgREST accepts a token until it expires. So a session already ended at
 * Auth (signed out, revoked from another device, ended by another used code)
 * still carried a token that passed, and the lab walk spent a code with it
 * (the password given): the factors went, the other sessions ended, a mail
 * was sent. Before any code is checked the action now asks Auth itself, with
 * the held token (GET /user, which Auth answers only while the session
 * exists):
 *   - Auth answers with this account: the code is checked as before;
 *   - Auth refuses the token (session_not_found, which auth-js names
 *     AuthSessionMissingError; a 401 or 403), or answers another account:
 *     "Sign in again, then try again.", and nothing is spent, removed, ended,
 *     audited or mailed;
 *   - Auth's answer cannot be had (not reached, a 5xx, a throw): closed,
 *     "Could not check your recovery code just now. Try again.", nothing
 *     spent.
 * The question is asked once, only for a press that got past the three
 * limiters and the password: a refused press costs no Auth round trip.
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
vi.mock('@/server/security/passkey-auth', () => ({
  signOutAs: vi.fn(async () => ({ ok: true, status: 204, code: null, body: null })),
}));
vi.mock('@/server/services/sessions', () => ({
  listMySessionIds: vi.fn(async () => ['sess-this', 'sess-phone']),
  broadcastEndedSessions: vi.fn(async () => undefined),
}));
vi.mock('@/server/security/recovery-code-email', () => ({ sendRecoveryCodeUsedEmail: vi.fn() }));

type Stub = ReturnType<typeof makeSupabaseStub>;
type UserAnswer = { data: { user: { id: string; email?: string | null } | null }; error: unknown };
const h = vi.hoisted(() => ({
  admin: null as unknown as { client: unknown },
  member: null as unknown as { client: unknown },
  /** Auth's answer to GET /user with the held token (a function of the token). */
  atAuth: null as unknown as (token: string) => Promise<UserAnswer>,
  /** The tokens Auth was asked about. */
  asked: [] as string[],
}));

const seg = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
const payloadOf = (token: string) =>
  JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;
/** The cookie session's token: account user-1, this session, aal1 (the code page). */
const TOKEN = `${seg({ alg: 'none', typ: 'JWT' })}.${seg({
  sub: 'user-1',
  aal: 'aal1',
  session_id: 'sess-this',
})}.`;

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: {
      getSession: async () => ({ data: { session: { access_token: TOKEN } }, error: null }),
      getClaims: async (token: string) => ({
        data: { claims: payloadOf(token), header: {}, signature: null },
        error: null,
      }),
      getUser: async (token: string) => {
        h.asked.push(token);
        return h.atAuth(token);
      },
    },
  })),
}));
vi.mock('@/lib/supabase/access-token-client', () => ({
  createAccessTokenClient: vi.fn(() => h.member.client),
}));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn(() => h.admin.client) }));

import { verifyPasswordSideChannel } from '@/lib/auth/verify-password';
import { emitAuthAudit } from '@/server/services/auth-audit';
import { signOutAs } from '@/server/security/passkey-auth';
import { sendRecoveryCodeUsedEmail } from '@/server/security/recovery-code-email';

import { consumeMfaRecoveryCodeAction } from './mfa-recovery';

const PW = 'sample-password-not-real';
const CODE = 'ABCD-EFGH-IJKL-MNOP';
const LIMITER_OK = {
  'rpc:increment_rate_limit': { data: [{ allowed: true, count: 1, reset_at: null }], error: null },
} as const;
const APP = { id: 'app-1', factor_type: 'totp', friendly_name: 'Phone', status: 'verified' };

const SIGN_IN_AGAIN = {
  ok: false,
  error: {
    code: 'unauthenticated',
    message: 'Sign in again, then try again.',
    details: { reason: 'session_changed' },
  },
};
const TRY_AGAIN = {
  ok: false,
  error: {
    code: 'internal_error',
    message: 'Could not check your recovery code just now. Try again.',
  },
};

function adminWith(results: Record<string, unknown>): Stub {
  const stub = makeSupabaseStub({ ...LIMITER_OK, ...results } as Parameters<
    typeof makeSupabaseStub
  >[0]);
  stub.client.auth.admin = {
    mfa: {
      listFactors: vi.fn(async () => ({ data: { factors: [APP] }, error: null })),
      deleteFactor: vi.fn(async () => ({ data: null, error: null })),
    },
  };
  h.admin = stub;
  return stub;
}
const WORLDS: Array<[string, () => Stub]> = [
  ['before 0475 (today’s consume)', () => adminWith(PASSKEY_RECOVERY_NOT_YET)],
  [
    'with 0475 live',
    () =>
      adminWith({
        'rpc:consume_recovery_code_with_passkeys': {
          data: [{ consumed: true, passkeys_removed: 0, bridge_factor_id: null }],
          error: null,
        },
      }),
  ],
];
const adminOf = (stub: Stub) =>
  stub.client.auth.admin as {
    mfa: { listFactors: ReturnType<typeof vi.fn>; deleteFactor: ReturnType<typeof vi.fn> };
  };
/** Every call that spends a code, on either client. */
const consumeCalls = (admin: Stub) => [
  ...admin.rpcCalls.filter((c) => c.name === 'consume_recovery_code_with_passkeys'),
  ...(h.member as Stub).rpcCalls.filter((c) => c.name === 'consume_mfa_recovery_code'),
];

const live = async (token: string): Promise<UserAnswer> => ({
  data: { user: { id: String(payloadOf(token).sub), email: 'member@example.test' } },
  error: null,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.asked = [];
  h.atAuth = live;
  h.member = makeSupabaseStub({
    'rpc:consume_mfa_recovery_code': { data: true, error: null },
    'rpc:revoke_my_other_sessions': { data: null, error: null },
  } as Parameters<typeof makeSupabaseStub>[0]);
});

describe.each(WORLDS)('a recovery code, %s', (_when, world) => {
  it('Auth still holds the session: asked once, with the held token, before the code is checked; the code is spent as before', async () => {
    const admin = world();
    expect(await consumeMfaRecoveryCodeAction({ code: CODE, password: PW })).toEqual({
      ok: true,
      data: { unenrolled: 1 },
    });
    expect(h.asked).toEqual([TOKEN]);
    expect(consumeCalls(admin).length).toBeGreaterThan(0);
  });

  const ENDED: Array<[string, (token: string) => Promise<UserAnswer>]> = [
    [
      'the session no longer exists at Auth (session_not_found)',
      async () => ({
        data: { user: null },
        error: { name: 'AuthSessionMissingError', message: 'Auth session missing!', status: 400 },
      }),
    ],
    [
      'Auth refuses the token (403)',
      async () => ({
        data: { user: null },
        error: { name: 'AuthApiError', message: 'sample refusal', status: 403 },
      }),
    ],
    [
      'Auth refuses the token (401)',
      async () => ({
        data: { user: null },
        error: { name: 'AuthApiError', message: 'sample refusal', status: 401 },
      }),
    ],
    [
      'Auth answers another account',
      async () => ({ data: { user: { id: 'user-2' } }, error: null }),
    ],
  ];

  it.each(ENDED)(
    '%s: "sign in again", and nothing is spent, removed, ended, audited or mailed',
    async (_case, answer) => {
      const admin = world();
      h.atAuth = answer;
      expect(await consumeMfaRecoveryCodeAction({ code: CODE, password: PW })).toEqual(
        SIGN_IN_AGAIN,
      );
      expect(consumeCalls(admin)).toEqual([]);
      expect(adminOf(admin).mfa.listFactors).not.toHaveBeenCalled();
      expect(adminOf(admin).mfa.deleteFactor).not.toHaveBeenCalled();
      expect(admin.rpcCalls.map((c) => c.name)).not.toContain('passkey_remove_all');
      expect(signOutAs).not.toHaveBeenCalled();
      expect(emitAuthAudit).not.toHaveBeenCalled();
      expect(sendRecoveryCodeUsedEmail).not.toHaveBeenCalled();
    },
  );

  const UNKNOWN: Array<[string, (token: string) => Promise<UserAnswer>]> = [
    [
      'Auth not reached',
      async () => ({
        data: { user: null },
        error: { name: 'AuthRetryableFetchError', message: 'fetch failed', status: 0 },
      }),
    ],
    [
      'Auth answers 500',
      async () => ({
        data: { user: null },
        error: { name: 'AuthApiError', message: 'sample failure', status: 500 },
      }),
    ],
  ];

  it.each(UNKNOWN)('%s: closed, "try again", and nothing is spent', async (_case, answer) => {
    const admin = world();
    h.atAuth = answer;
    expect(await consumeMfaRecoveryCodeAction({ code: CODE, password: PW })).toEqual(TRY_AGAIN);
    expect(consumeCalls(admin)).toEqual([]);
    expect(adminOf(admin).mfa.deleteFactor).not.toHaveBeenCalled();
    expect(signOutAs).not.toHaveBeenCalled();
    expect(sendRecoveryCodeUsedEmail).not.toHaveBeenCalled();
  });
});

describe.each(WORLDS)('a recovery code, %s, when the question throws', (_when, world) => {
  it('the action’s own catch refuses: an internal error, and nothing is spent', async () => {
    const admin = world();
    h.atAuth = async () => {
      throw new Error('sample throw');
    };
    const res = await consumeMfaRecoveryCodeAction({ code: CODE, password: PW });
    expect(res).toMatchObject({ ok: false, error: { code: 'internal_error' } });
    expect(consumeCalls(admin)).toEqual([]);
    expect(adminOf(admin).mfa.deleteFactor).not.toHaveBeenCalled();
    expect(signOutAs).not.toHaveBeenCalled();
    expect(sendRecoveryCodeUsedEmail).not.toHaveBeenCalled();
  });
});

describe('the question costs a refused press nothing', () => {
  it('a wrong password: Auth is not asked', async () => {
    adminWith(PASSKEY_RECOVERY_NOT_YET);
    vi.mocked(verifyPasswordSideChannel).mockResolvedValueOnce({
      ok: false,
      reason: 'invalid_password',
      message: 'That password is not right.',
    } as never);
    const res = await consumeMfaRecoveryCodeAction({ code: CODE, password: PW });
    expect(res.ok).toBe(false);
    expect(h.asked).toEqual([]);
  });

  it('no password: Auth is not asked', async () => {
    adminWith(PASSKEY_RECOVERY_NOT_YET);
    const res = await consumeMfaRecoveryCodeAction({ code: CODE });
    expect(res.ok).toBe(false);
    expect(h.asked).toEqual([]);
  });
});

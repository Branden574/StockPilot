import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Security invariant: no authenticator action checks, confirms, removes or
 * offers a passkey's bridge factor, and each knows it BY ITS RECORDED ID ONLY
 * (lib/auth/passkey-bridge.ts).
 *
 * The bridge is a TOTP factor at Supabase Auth whose secret only the server
 * holds; Auth itself would check a code for it, confirm it while unverified,
 * and remove it (proof B4, B6). So, in server/actions/mfa.ts:
 *   - challengeFactorAction refuses the recorded bridge with the words of a
 *     factor that is not a verified authenticator, before any attempt of the
 *     code budget is spent or a challenge is started;
 *   - verifyEnrollmentAction refuses it as a set-up that is not open;
 *   - unenrollFactorAction refuses it as an invalid factor;
 *   - enrollFactorAction's clean-up of unfinished set-ups leaves it, and the
 *     name it gives a new authenticator never carries the reserved prefix;
 *   - stepUpMethodsAction lists the account's verified authenticator apps
 *     without it.
 * A reserved-name factor that is not the recorded bridge is LISTED like any
 * authenticator app (and removable); once the records are read (a bridge
 * recorded, or none for this account) it is never offered for a typed code,
 * and the code check refuses it before any attempt, with the words of a
 * second step that cannot be used here, reported at error level (the lab
 * walk of stage 4, state S12). While the records cannot be read (a failed
 * read, or the table missing) a factor that carries the reserved name is
 * still never offered for a typed code, and the code check refuses it before
 * any attempt is spent and before Auth is asked, with the code page's own
 * "could not check, try again" words (fail closed); the step-up list then
 * says the records were not read, so a modal left with no app says "try
 * again" too. An account with no reserved-name factor makes no record read,
 * so a failed read changes nothing for it.
 * A record that cannot be read hides nothing from the Settings list (and is
 * reported);
 * the three actions that CHANGE a factor (remove, confirm a set-up, the
 * set-up clean-up) then leave every factor that carries the reserved name
 * alone, with "try again in a moment" (review 2-3 finding 2). The removal
 * looks at the names in the factor list withContext() already read, so an
 * account with no reserved-name factor makes no extra Auth read and causes no
 * report (finding 5). stepUpMethodsAction is limited per account at this
 * address and per account, closed, before any read (finding 8). Every record
 * read is of the account the request validated.
 */

vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), updateTag: vi.fn() }));
vi.mock('@/lib/auth/session', () => ({
  requireSession: vi.fn(async () => ({
    userId: 'user-1',
    email: 'u@example.test',
    fullName: null,
    avatarUrl: null,
    defaultOrganizationId: 'org-1',
  })),
  requireOrgContext: vi.fn(async () => ({
    userId: 'user-1',
    organizationId: 'org-1',
    role: 'admin',
  })),
}));
vi.mock('@/server/services/context', async () => {
  // The context keeps the factor list read it started, as withContext() does
  // (lib/auth/context-factor-list.ts, the real module).
  const { keepContextFactorListRead } = await import('@/lib/auth/context-factor-list');
  return {
    withContext: vi.fn(async () => {
      const ctx = {};
      h.contextReads += 1;
      keepContextFactorListRead(
        ctx,
        h.contextListFails
          ? Promise.reject(new Error('getMfaFactorsForRequest: unreadable'))
          : Promise.resolve({ userId: h.accountId, factors: h.factors }),
      );
      return ctx;
    }),
    assertCurrentAal2: vi.fn(async () => {}),
    ServiceError: class extends Error {
      constructor(
        public code: string,
        message: string,
      ) {
        super(message);
      }
    },
  };
});
vi.mock('@/lib/auth/verify-password', () => ({
  verifyPasswordSideChannel: vi.fn(async () => ({ ok: true })),
}));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, count: 1, resetAt: Date.now() + 1000 })),
}));
vi.mock('@/server/services/audit', () => ({ audit: vi.fn(async () => {}) }));
vi.mock('@/server/services/integration-events', () => ({ dispatchEvent: vi.fn(async () => {}) }));
vi.mock('@/lib/auth/verified-claims', () => ({
  readVerifiedSessionClaims: vi.fn(async () => ({
    userId: 'user-1',
    sessionId: 'session-1',
    aal: 'aal1',
    amr: [],
  })),
}));
vi.mock('next/headers', () => ({ headers: vi.fn(async () => new Headers()) }));
vi.mock('@/server/services/auth-audit', () => ({ emitAuthAudit: vi.fn(async () => {}) }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
// Stage 4: the passkey reads answer as for an account whose passkeys are not
// open (the stage 2 behaviour these tests pin); passkeys.test.ts covers them.
vi.mock('@/server/security/passkeys', () => ({
  passkeyStepFor: vi.fn(async () => 'none'),
  servingPasskeyIds: vi.fn(async () => []),
}));
// Stage 4: the app removal rule has its own tests
// (server/security/second-step-methods.test.ts and
// mfa.unenroll-no-change.test.ts); here a removal is allowed unless a test
// says otherwise, so what is pinned is the bridge's own refusal, and how the
// action asks the rule and answers its verdict.
vi.mock('@/server/security/second-step-methods', () => ({
  LAST_METHOD_WORDS: 'last method',
  appRemovalVerdict: vi.fn(async () => 'allowed'),
}));

type Factor = {
  id: string;
  status: string;
  factor_type?: string;
  friendly_name?: string | null;
  created_at?: string;
};

const h = vi.hoisted(() => ({
  /** The account's factors, as GoTrue lists them (getUser and listFactors). */
  factors: [] as Array<{
    id: string;
    status: string;
    factor_type?: string;
    friendly_name?: string | null;
    created_at?: string;
  }>,
  accountId: 'user-1',
  getUserFails: false,
  /** The context's own factor list read fails (withContext() started it). */
  contextListFails: false,
  contextReads: 0,
  /** passkey_bridges' answer for the account. */
  record: { data: null as unknown, error: null as unknown },
  /** The filters of every passkey_bridges read: whose record was asked for. */
  recordFilters: [] as Array<[string, unknown]>,
  adminClients: 0,
}));

const mfaStub = {
  challenge: vi.fn(async () => ({ data: { id: 'challenge-1' }, error: null })),
  verify: vi.fn(async () => ({ data: null, error: null })),
  listFactors: vi.fn(async () => ({
    data: {
      all: h.factors,
      totp: h.factors.filter(
        (f) => (f.factor_type ?? 'totp') === 'totp' && f.status === 'verified',
      ),
    },
    error: null,
  })),
  unenroll: vi.fn(async () => ({ data: null, error: null })),
  enroll: vi.fn(async () => ({
    data: {
      id: 'new-1',
      type: 'totp',
      totp: { qr_code: 'qr', secret: 'secret', uri: 'otpauth://example' },
    },
    error: null,
  })),
};
const authStub = {
  mfa: mfaStub,
  getUser: vi.fn(async () =>
    h.getUserFails
      ? {
          data: { user: null },
          error: { name: 'AuthRetryableFetchError', message: 'down', status: 0 },
        }
      : { data: { user: { id: h.accountId, factors: h.factors } }, error: null },
  ),
  signOut: vi.fn(async () => ({ error: null })),
};
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: authStub,
    from: () => {
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = () => q;
      q.maybeSingle = async () => ({ data: { mfa_policy: 'optional' }, error: null });
      return q;
    },
  })),
}));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(() => {
    h.adminClients += 1;
    const q: Record<string, unknown> = {};
    q.select = () => q;
    q.eq = (column: string, value: unknown) => {
      h.recordFilters.push([column, value]);
      return q;
    };
    q.maybeSingle = async () => h.record;
    return { from: (table: string) => (table === 'passkey_bridges' ? q : null) };
  }),
}));

import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { audit } from '@/server/services/audit';
import { servingPasskeyIds } from '@/server/security/passkeys';
import { appRemovalVerdict } from '@/server/security/second-step-methods';

import {
  challengeFactorAction,
  enrollFactorAction,
  stepUpMethodsAction,
  unenrollFactorAction,
  verifyEnrollmentAction,
} from './mfa';

const NOT_STARTED = 'Could not start the authenticator check. Please try again.';
/** The code page's own words for a code that could not be checked just now. */
const NOT_CHECKED = 'Could not check your code just now. Try again.';
/** The words of a second step that cannot be used here (the sign-in code page's own). */
const CANT_USE =
  "Your second step can't be used here right now. Use a recovery code to get back in, or try again later.";
const CANT_USE_WITH_APP =
  "Your second step can't be used here right now. Enter the code from your authenticator app, or use a recovery code.";
const SETUP_NOT_OPEN = 'This authenticator set-up is no longer open. Start again.';
const SESSION_ENDED = 'You were signed out on this device. Sign in again to continue.';
const TRY_AGAIN = 'Could not check this authenticator just now. Try again in a moment.';
const PAUSED = 'Too many checks of your authenticators. Try again in a few minutes.';
const LIMIT_REFUSED = { allowed: false, count: 1, resetAt: Date.now() + 1000 };
/** The record was read once, for the account the request validated. */
const READ_OWN_RECORD = [['user_id', 'user-1']];
const CODE = '246813';
/** A dull value under a neutral name (secret-shaped-fixtures guard). */
const ACCOUNT_VALUE = 'correct horse battery staple';

const APP: Factor = {
  id: 'app-1',
  status: 'verified',
  factor_type: 'totp',
  friendly_name: 'Phone',
};
const BRIDGE: Factor = {
  id: 'bridge-1',
  status: 'verified',
  factor_type: 'totp',
  friendly_name: 'sp-passkey-bridge-a1b2c3',
};
const IMPOSTOR: Factor = {
  id: 'other-1',
  status: 'verified',
  factor_type: 'totp',
  friendly_name: 'sp-passkey-bridge-zzz',
};
const RECORDED = { data: { factor_id: BRIDGE.id }, error: null };
const NOT_YET = {
  data: null,
  error: {
    code: 'PGRST205',
    message: "Could not find the table 'public.passkey_bridges' in the schema cache",
  },
};
const UNREADABLE = { data: null, error: { code: '57014', message: 'canceling statement' } };

function codeBudgetCalls() {
  return vi
    .mocked(checkRateLimit)
    .mock.calls.filter((c) => /^mfa-code(-account)?:/.test(String(c[0])));
}

beforeEach(() => {
  vi.clearAllMocks();
  h.factors = [APP];
  h.accountId = 'user-1';
  h.getUserFails = false;
  h.contextListFails = false;
  h.contextReads = 0;
  h.record = RECORDED;
  h.recordFilters = [];
  h.adminClients = 0;
});

describe('challengeFactorAction and the passkey bridge', () => {
  it('refuses the recorded bridge before any code attempt, with the words of a factor that is not an authenticator', async () => {
    h.factors = [BRIDGE, APP];
    const res = await challengeFactorAction({ factorId: BRIDGE.id, code: CODE });

    expect(res).toEqual({ ok: false, error: { code: 'internal_error', message: NOT_STARTED } });
    expect(codeBudgetCalls()).toEqual([]);
    expect(mfaStub.challenge).not.toHaveBeenCalled();
    expect(mfaStub.verify).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tag: 'actions.mfa.challenge',
        level: 'warning',
        extra: { factor: 'passkey_bridge' },
      }),
    );
    const reports = JSON.stringify(vi.mocked(reportError).mock.calls);
    expect(reports).not.toContain(BRIDGE.id);
    expect(reports).not.toContain(CODE);
    expect(h.recordFilters).toEqual(READ_OWN_RECORD);
  });

  it('checks the authenticator app beside the bridge as before', async () => {
    h.factors = [BRIDGE, APP];
    const res = await challengeFactorAction({ factorId: APP.id, code: CODE });
    expect(res).toEqual({ ok: true, data: undefined });
    expect(mfaStub.challenge).toHaveBeenCalledWith({ factorId: APP.id });
  });

  describe('a reserved-name factor that no record names, once the records are read (S12; S15 beside the recorded bridge)', () => {
    it.each([
      ['no bridge row for the account (S12)', { data: null, error: null }],
      ['beside the recorded bridge (S15)', RECORDED],
    ])(
      '%s, with an app: refused before any code attempt, the words point to the app, reported at error level',
      async (_state, record) => {
        h.factors = [IMPOSTOR, BRIDGE, APP];
        h.record = record;
        const res = await challengeFactorAction({ factorId: IMPOSTOR.id, code: CODE });
        expect(res).toEqual({
          ok: false,
          error: { code: 'forbidden', message: CANT_USE_WITH_APP },
        });
        expect(codeBudgetCalls()).toEqual([]);
        expect(mfaStub.challenge).not.toHaveBeenCalled();
        expect(mfaStub.verify).not.toHaveBeenCalled();
        const refusals = vi
          .mocked(reportError)
          .mock.calls.filter((c) => c[1].tag === 'actions.mfa.challenge');
        expect(refusals.map((c) => [c[1].level, c[1].extra])).toEqual([
          ['error', { factor: 'reserved_name_unrecorded' }],
        ]);
        const reports = JSON.stringify(vi.mocked(reportError).mock.calls);
        expect(reports).not.toContain(IMPOSTOR.id);
        expect(reports).not.toContain(CODE);
      },
    );

    it('with no app (only that factor): the words say to use a recovery code', async () => {
      h.factors = [IMPOSTOR];
      h.record = { data: null, error: null };
      const res = await challengeFactorAction({ factorId: IMPOSTOR.id, code: CODE });
      expect(res).toEqual({ ok: false, error: { code: 'forbidden', message: CANT_USE } });
      expect(mfaStub.challenge).not.toHaveBeenCalled();
    });

    it('the reports are paced: past the account’s window, the same refusal and no report', async () => {
      h.factors = [IMPOSTOR];
      h.record = { data: null, error: null };
      vi.mocked(checkRateLimit).mockImplementation(async (key) =>
        String(key).startsWith('mfa-factor-refused-report:')
          ? LIMIT_REFUSED
          : { allowed: true, count: 1, resetAt: Date.now() + 1000 },
      );
      const res = await challengeFactorAction({ factorId: IMPOSTOR.id, code: CODE });
      expect(res).toEqual({ ok: false, error: { code: 'forbidden', message: CANT_USE } });
      expect(
        vi.mocked(reportError).mock.calls.filter((c) => c[1].tag === 'actions.mfa.challenge'),
      ).toEqual([]);
      expect(mfaStub.challenge).not.toHaveBeenCalled();
    });
  });

  describe('while the record cannot be read (a failed read, or the table missing): fail closed', () => {
    it.each([
      ['a failed read, with an app beside it', UNREADABLE, [IMPOSTOR, APP], IMPOSTOR],
      ['a failed read, the bridge itself', UNREADABLE, [BRIDGE, APP], BRIDGE],
      ['a failed read, no app', UNREADABLE, [BRIDGE], BRIDGE],
      ['the table missing, with an app beside it', NOT_YET, [BRIDGE, APP], BRIDGE],
      ['the table missing, no app', NOT_YET, [BRIDGE], BRIDGE],
    ] as Array<[string, typeof UNREADABLE, Factor[], Factor]>)(
      '%s: a reserved-name factor is refused before any code attempt and before Auth is asked, with the try-again words',
      async (_state, record, factors, named) => {
        h.factors = factors;
        h.record = record;
        const res = await challengeFactorAction({ factorId: named.id, code: CODE });
        expect(res).toEqual({ ok: false, error: { code: 'internal_error', message: NOT_CHECKED } });
        expect(codeBudgetCalls()).toEqual([]);
        expect(mfaStub.challenge).not.toHaveBeenCalled();
        expect(mfaStub.verify).not.toHaveBeenCalled();
        // The failed read is what gets reported (by the read itself); the
        // press adds no report of its own, and none names the factor or code.
        expect(vi.mocked(reportError).mock.calls.map((c) => [c[1].tag, c[1].level])).toEqual([
          [
            record === NOT_YET ? 'passkeys.records_missing' : 'passkeys.bridge_unreadable',
            'error',
          ],
        ]);
        const reports = JSON.stringify(vi.mocked(reportError).mock.calls);
        expect(reports).not.toContain(named.id);
        expect(reports).not.toContain(CODE);
      },
    );

    it.each([
      ['a failed read', UNREADABLE],
      ['the table missing', NOT_YET],
    ])(
      '%s: the app beside a reserved-name factor is checked as before, with no record read',
      async (_state, record) => {
        h.factors = [BRIDGE, APP];
        h.record = record;
        const res = await challengeFactorAction({ factorId: APP.id, code: CODE });
        expect(res).toEqual({ ok: true, data: undefined });
        expect(mfaStub.challenge).toHaveBeenCalledWith({ factorId: APP.id });
        expect(h.adminClients).toBe(0);
      },
    );

    it.each([
      ['a failed read', UNREADABLE],
      ['the table missing', NOT_YET],
    ])(
      '%s: an account with no reserved-name factor is exactly as before (no record read, no report, the code checked)',
      async (_state, record) => {
        h.factors = [APP, { ...APP, id: 'app-2', friendly_name: 'Tablet' }];
        h.record = record;
        const res = await challengeFactorAction({ factorId: 'app-2', code: CODE });
        expect(res).toEqual({ ok: true, data: undefined });
        expect(mfaStub.challenge.mock.calls).toEqual([[{ factorId: 'app-2' }]]);
        expect(mfaStub.verify).toHaveBeenCalledTimes(1);
        expect(codeBudgetCalls()).toHaveLength(2);
        expect(h.adminClients).toBe(0);
        expect(reportError).not.toHaveBeenCalled();
      },
    );
  });

  it('with no reserved-name factor, the records are never read', async () => {
    const res = await challengeFactorAction({ factorId: APP.id, code: CODE });
    expect(res).toEqual({ ok: true, data: undefined });
    expect(h.adminClients).toBe(0);
  });
});

describe('verifyEnrollmentAction and the passkey bridge', () => {
  it('refuses the recorded bridge while it is unverified: it is no set-up of the member', async () => {
    h.factors = [{ ...BRIDGE, status: 'unverified' }];
    const res = await verifyEnrollmentAction({
      factorId: BRIDGE.id,
      code: CODE,
      password: ACCOUNT_VALUE,
    });
    expect(res).toEqual({
      ok: false,
      error: { code: 'validation_error', message: SETUP_NOT_OPEN },
    });
    expect(mfaStub.challenge).not.toHaveBeenCalled();
    expect(mfaStub.verify).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
    expect(h.recordFilters).toEqual(READ_OWN_RECORD);
  });

  it('while the record cannot be read, a reserved-name set-up is not confirmed: try again in a moment, reported', async () => {
    h.factors = [{ ...BRIDGE, status: 'unverified' }];
    h.record = UNREADABLE;
    const res = await verifyEnrollmentAction({
      factorId: BRIDGE.id,
      code: CODE,
      password: ACCOUNT_VALUE,
    });
    expect(res).toEqual({ ok: false, error: { code: 'internal_error', message: TRY_AGAIN } });
    expect(mfaStub.challenge).not.toHaveBeenCalled();
    expect(mfaStub.verify).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tag: 'passkeys.bridge_unreadable', level: 'error' }),
    );
  });

  it('while the record cannot be read, a set-up without the reserved name is confirmed, with no record read', async () => {
    h.factors = [{ ...APP, id: 'setup-1', friendly_name: 'StockPilot', status: 'unverified' }];
    h.record = UNREADABLE;
    const res = await verifyEnrollmentAction({
      factorId: 'setup-1',
      code: CODE,
      password: ACCOUNT_VALUE,
    });
    expect(res).toEqual({ ok: true, data: undefined });
    expect(h.adminClients).toBe(0);
    expect(reportError).not.toHaveBeenCalled();
  });

  it('confirms an unverified reserved-name factor that is not recorded like any set-up', async () => {
    h.factors = [{ ...IMPOSTOR, status: 'unverified' }];
    h.record = { data: null, error: null };
    const res = await verifyEnrollmentAction({
      factorId: IMPOSTOR.id,
      code: CODE,
      password: ACCOUNT_VALUE,
    });
    expect(res).toEqual({ ok: true, data: undefined });
    expect(mfaStub.challenge).toHaveBeenCalledWith({ factorId: IMPOSTOR.id });
  });
});

describe('unenrollFactorAction and the passkey bridge', () => {
  it('refuses to remove the recorded bridge, from the names the context already read', async () => {
    h.factors = [APP, BRIDGE];
    const res = await unenrollFactorAction({ factorId: BRIDGE.id });
    expect(res).toEqual({
      ok: false,
      error: { code: 'validation_error', message: 'Invalid factor' },
    });
    expect(mfaStub.unenroll).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
    expect(h.recordFilters).toEqual(READ_OWN_RECORD);
    // No second Auth read: the list is the one withContext() started.
    expect(authStub.getUser).not.toHaveBeenCalled();
    expect(h.contextReads).toBe(1);
  });

  it('removes the authenticator app beside the bridge as before, reading no record', async () => {
    h.factors = [BRIDGE, APP];
    const res = await unenrollFactorAction({ factorId: APP.id });
    expect(res).toEqual({ ok: true, data: undefined });
    expect(mfaStub.unenroll).toHaveBeenCalledWith({ factorId: APP.id });
    expect(h.adminClients).toBe(0);
  });

  it('names first: an account with no reserved-name factor makes no extra Auth read, no record read and no report', async () => {
    h.factors = [APP];
    const res = await unenrollFactorAction({ factorId: APP.id });
    expect(res).toEqual({ ok: true, data: undefined });
    expect(mfaStub.unenroll).toHaveBeenCalledWith({ factorId: APP.id });
    expect(authStub.getUser).not.toHaveBeenCalled();
    expect(h.adminClients).toBe(0);
    expect(reportError).not.toHaveBeenCalled();
  });

  it('removes a reserved-name factor that is not the recorded bridge, like any authenticator app', async () => {
    h.factors = [APP, IMPOSTOR];
    h.record = { data: null, error: null };
    const res = await unenrollFactorAction({ factorId: IMPOSTOR.id });
    expect(res).toEqual({ ok: true, data: undefined });
    expect(mfaStub.unenroll).toHaveBeenCalledWith({ factorId: IMPOSTOR.id });
  });

  it('while the record cannot be read, a factor that carries the reserved name is refused: try again in a moment, reported', async () => {
    h.factors = [APP, BRIDGE];
    h.record = UNREADABLE;
    const res = await unenrollFactorAction({ factorId: BRIDGE.id });
    expect(res).toEqual({ ok: false, error: { code: 'internal_error', message: TRY_AGAIN } });
    expect(mfaStub.unenroll).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tag: 'passkeys.bridge_unreadable', level: 'error' }),
    );
  });

  it('while the record cannot be read, a factor without the reserved name is removed as before, with no record read', async () => {
    h.factors = [APP, BRIDGE];
    h.record = UNREADABLE;
    const res = await unenrollFactorAction({ factorId: APP.id });
    expect(res).toEqual({ ok: true, data: undefined });
    expect(mfaStub.unenroll).toHaveBeenCalledWith({ factorId: APP.id });
    expect(h.adminClients).toBe(0);
  });

  it('before the records exist (the table missing), a reserved-name factor is removed like any app', async () => {
    h.factors = [APP, BRIDGE];
    h.record = NOT_YET;
    const res = await unenrollFactorAction({ factorId: BRIDGE.id });
    expect(res).toEqual({ ok: true, data: undefined });
    expect(mfaStub.unenroll).toHaveBeenCalledWith({ factorId: BRIDGE.id });
  });

  it('a factor list the context could not read hides nothing: the removal goes on as before, with no second read', async () => {
    h.contextListFails = true;
    const res = await unenrollFactorAction({ factorId: APP.id });
    expect(res).toEqual({ ok: true, data: undefined });
    expect(mfaStub.unenroll).toHaveBeenCalledWith({ factorId: APP.id });
    expect(authStub.getUser).not.toHaveBeenCalled();
    expect(h.adminClients).toBe(0);
  });

  it("another account's list (the session moved) is no answer: hides nothing, reads no record", async () => {
    h.factors = [APP, BRIDGE];
    h.accountId = 'user-2';
    const res = await unenrollFactorAction({ factorId: BRIDGE.id });
    expect(res).toEqual({ ok: true, data: undefined });
    expect(h.adminClients).toBe(0);
  });
});

describe('unenrollFactorAction and the app removal rule (the no-change rule of 2026-11-21)', () => {
  it("asks the rule with the list the context read, the active organization's policy, and the passkeys judged by the page's own rule, only when asked", async () => {
    h.factors = [APP, BRIDGE];
    await unenrollFactorAction({ factorId: APP.id });
    expect(appRemovalVerdict).toHaveBeenCalledOnce();
    const input = vi.mocked(appRemovalVerdict).mock.calls[0]![0];
    expect(input).toMatchObject({ userId: 'user-1', factorId: APP.id, activeRequired: false });
    expect(input.factors?.map((f) => f.id)).toEqual([APP.id, BRIDGE.id]);
    expect(servingPasskeyIds).not.toHaveBeenCalled();
    await input.servingPasskeys();
    expect(servingPasskeyIds).toHaveBeenCalledWith('user-1', input.factors);
  });

  it("an unread factor list, or another account's, reaches the rule as unknown (null), never as an empty list", async () => {
    h.contextListFails = true;
    await unenrollFactorAction({ factorId: APP.id });
    h.contextListFails = false;
    h.accountId = 'user-2';
    await unenrollFactorAction({ factorId: APP.id });
    expect(vi.mocked(appRemovalVerdict).mock.calls.map((c) => c[0].factors)).toEqual([null, null]);
  });

  it("the base rule: refused with the base's words, nothing removed", async () => {
    vi.mocked(appRemovalVerdict).mockResolvedValueOnce('policy');
    const res = await unenrollFactorAction({ factorId: APP.id });
    expect(res).toEqual({
      ok: false,
      error: {
        code: 'forbidden',
        message: 'Your organization requires MFA. Ask an admin to lower the policy before disabling.',
      },
    });
    expect(mfaStub.unenroll).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("the last method (a passkey holder): refused with the rule's words, nothing removed", async () => {
    vi.mocked(appRemovalVerdict).mockResolvedValueOnce('last_method');
    const res = await unenrollFactorAction({ factorId: APP.id });
    expect(res).toEqual({ ok: false, error: { code: 'forbidden', message: 'last method' } });
    expect(mfaStub.unenroll).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('what could not be read answers try again in a moment, never a removal', async () => {
    vi.mocked(appRemovalVerdict).mockResolvedValueOnce('unreadable');
    const res = await unenrollFactorAction({ factorId: APP.id });
    expect(res).toEqual({ ok: false, error: { code: 'internal_error', message: TRY_AGAIN } });
    expect(mfaStub.unenroll).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });
});

describe('enrollFactorAction and the passkey bridge', () => {
  it("the clean-up of unfinished set-ups leaves the recorded bridge and removes the member's own", async () => {
    h.factors = [
      { ...BRIDGE, status: 'unverified' },
      {
        id: 'setup-old',
        status: 'unverified',
        factor_type: 'totp',
        friendly_name: 'StockPilot · 2026-11-01',
      },
      APP,
    ];
    const res = await enrollFactorAction();
    expect(res.ok).toBe(true);
    expect(mfaStub.unenroll.mock.calls).toEqual([[{ factorId: 'setup-old' }]]);
    expect(h.recordFilters).toEqual(READ_OWN_RECORD);
  });

  it('while the record cannot be read, the clean-up leaves every reserved-name set-up alone and removes the others', async () => {
    h.factors = [
      { ...BRIDGE, status: 'unverified' },
      { ...IMPOSTOR, status: 'unverified' },
      {
        id: 'setup-old',
        status: 'unverified',
        factor_type: 'totp',
        friendly_name: 'StockPilot · 2026-11-01',
      },
    ];
    h.record = UNREADABLE;
    const res = await enrollFactorAction();
    expect(res.ok).toBe(true);
    expect(mfaStub.unenroll.mock.calls).toEqual([[{ factorId: 'setup-old' }]]);
    expect(reportError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tag: 'passkeys.bridge_unreadable', level: 'error' }),
    );
  });

  it('the clean-up removes an unfinished reserved-name factor that is not recorded, like any set-up', async () => {
    const old = new Date(Date.now() - 3 * 60_000).toISOString();
    h.factors = [{ ...IMPOSTOR, status: 'unverified', created_at: old }];
    h.record = { data: null, error: null };
    await enrollFactorAction();
    expect(mfaStub.unenroll.mock.calls).toEqual([[{ factorId: IMPOSTOR.id }]]);
  });

  it('stage 4: an unfinished reserved-name factor younger than two minutes (a registration in flight) is left alone', async () => {
    const young = new Date(Date.now() - 30_000).toISOString();
    for (const created_at of [young, undefined, 'not a time']) {
      mfaStub.unenroll.mockClear();
      h.factors = [{ ...IMPOSTOR, status: 'unverified', created_at }];
      h.record = { data: null, error: null };
      await enrollFactorAction();
      expect(mfaStub.unenroll).not.toHaveBeenCalled();
    }
  });

  it('the name it gives a new authenticator never carries the reserved prefix', async () => {
    await enrollFactorAction();
    expect(mfaStub.enroll).toHaveBeenCalledTimes(1);
    const [args] = mfaStub.enroll.mock.calls[0] as unknown as [{ friendlyName: string }];
    expect(args.friendlyName.startsWith('sp-passkey-bridge-')).toBe(false);
    expect(args.friendlyName.toLowerCase()).not.toContain('passkey');
  });
});

describe('stepUpMethodsAction', () => {
  it("lists the account's verified authenticator apps without the recorded bridge, whatever the order", async () => {
    const second = { ...APP, id: 'app-2', friendly_name: null };
    h.factors = [
      BRIDGE,
      APP,
      { id: 'setup-1', status: 'unverified', factor_type: 'totp', friendly_name: 'StockPilot' },
      { id: 'phone-1', status: 'verified', factor_type: 'phone', friendly_name: 'SMS' },
      second,
    ];
    const res = await stepUpMethodsAction();
    expect(res).toEqual({
      ok: true,
      data: {
        apps: [
          { id: APP.id, friendlyName: 'Phone' },
          { id: 'app-2', friendlyName: null },
        ],
        passkey: false,
      },
    });
    expect(h.recordFilters).toEqual(READ_OWN_RECORD);
  });

  it('is limited per account at this address, then per account, both closed, before any read', async () => {
    h.factors = [BRIDGE, APP];
    await stepUpMethodsAction();
    const limits = vi
      .mocked(checkRateLimit)
      .mock.calls.filter((c) => String(c[0]).startsWith('mfa-step-up-methods'));
    expect(limits).toEqual([
      [expect.stringMatching(/^mfa-step-up-methods:user-1:/), 20, 15 * 60_000, 'closed'],
      ['mfa-step-up-methods-account:user-1', 60, 15 * 60_000, 'closed'],
    ]);
  });

  it.each([
    ['at this address', 0],
    ['for the account', 1],
  ])('a limit refused %s answers rate_limited, with no Auth read and no record read', async (_n, which) => {
    h.factors = [BRIDGE, APP];
    if (which === 1) {
      vi.mocked(checkRateLimit)
        .mockResolvedValueOnce({ allowed: true, count: 1, resetAt: Date.now() + 1000 })
        .mockResolvedValueOnce(LIMIT_REFUSED);
    } else {
      vi.mocked(checkRateLimit).mockResolvedValueOnce(LIMIT_REFUSED);
    }
    const res = await stepUpMethodsAction();
    expect(res).toEqual({ ok: false, error: { code: 'rate_limited', message: PAUSED } });
    expect(authStub.getUser).not.toHaveBeenCalled();
    expect(h.adminClients).toBe(0);
  });

  it.each([
    ['beside the recorded bridge (S15)', RECORDED],
    ['with no bridge row for the account (S12)', { data: null, error: null }],
  ])(
    'never lists a reserved-name factor that no record names, %s: no code is asked for it',
    async (_state, record) => {
      h.factors = [IMPOSTOR, BRIDGE, APP];
      h.record = record;
      const res = await stepUpMethodsAction();
      // The apps exactly; stage 4 adds a field of its own beside them.
      expect(res).toMatchObject({
        ok: true,
        data: { apps: [{ id: APP.id, friendlyName: 'Phone' }] },
      });
      expect(res.ok && res.data.apps).toHaveLength(1);
    },
  );

  it.each([
    ['a failed read', UNREADABLE],
    ['the table missing', NOT_YET],
  ])(
    'while the record cannot be read (%s), no reserved-name factor is listed, and the answer says the records were not read',
    async (_state, record) => {
      h.record = record;
      h.factors = [BRIDGE, APP];
      const withApp = await stepUpMethodsAction();
      expect(withApp).toMatchObject({
        ok: true,
        data: { apps: [{ id: APP.id, friendlyName: 'Phone' }], recordsUnread: true, passkey: false },
      });
      expect(withApp.ok && withApp.data.apps).toHaveLength(1);

      h.factors = [IMPOSTOR];
      const alone = await stepUpMethodsAction();
      expect(alone).toMatchObject({
        ok: true,
        data: { apps: [], recordsUnread: true, passkey: false },
      });
    },
  );

  it.each([
    ['a failed read', UNREADABLE],
    ['the table missing', NOT_YET],
    ['records that answer', RECORDED],
  ])(
    'an account with no reserved-name factor (%s): its apps, no record read, and no word about the records',
    async (_state, record) => {
      h.record = record;
      h.factors = [APP];
      const res = await stepUpMethodsAction();
      expect(res).toMatchObject({ ok: true, data: { apps: [{ id: APP.id, friendlyName: 'Phone' }] } });
      expect(res.ok && 'recordsUnread' in res.data).toBe(false);
      expect(h.adminClients).toBe(0);
      expect(reportError).not.toHaveBeenCalled();
    },
  );

  it('with the records read, the answer carries no word about them', async () => {
    h.factors = [IMPOSTOR, BRIDGE, APP];
    const res = await stepUpMethodsAction();
    expect(res.ok && 'recordsUnread' in res.data).toBe(false);
  });

  it('answers nothing for a session that does not verify', async () => {
    const { readVerifiedSessionClaims } = await import('@/lib/auth/verified-claims');
    vi.mocked(readVerifiedSessionClaims).mockResolvedValueOnce(null);
    const res = await stepUpMethodsAction();
    expect(res).toEqual({ ok: false, error: { code: 'unauthenticated', message: SESSION_ENDED } });
    expect(authStub.getUser).not.toHaveBeenCalled();
  });

  it("answers nothing from another account's list, and signs that session out", async () => {
    h.factors = [BRIDGE, APP];
    h.accountId = 'user-2';
    const res = await stepUpMethodsAction();
    expect(res).toEqual({ ok: false, error: { code: 'unauthenticated', message: SESSION_ENDED } });
    expect(authStub.signOut).toHaveBeenCalledTimes(1);
    expect(h.adminClients).toBe(0);
  });
});

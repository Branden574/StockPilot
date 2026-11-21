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
 * A reserved-name factor that is not the recorded bridge, and every factor
 * while the records do not exist yet, is treated like any authenticator app.
 * A record that cannot be read hides nothing (and is reported).
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
vi.mock('@/server/services/context', () => ({
  withContext: vi.fn(async () => ({})),
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

type Factor = { id: string; status: string; factor_type?: string; friendly_name?: string | null };

const h = vi.hoisted(() => ({
  /** The account's factors, as GoTrue lists them (getUser and listFactors). */
  factors: [] as Array<{
    id: string;
    status: string;
    factor_type?: string;
    friendly_name?: string | null;
  }>,
  accountId: 'user-1',
  getUserFails: false,
  /** passkey_bridges' answer for the account. */
  record: { data: null as unknown, error: null as unknown },
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
    q.eq = () => q;
    q.maybeSingle = async () => h.record;
    return { from: (table: string) => (table === 'passkey_bridges' ? q : null) };
  }),
}));

import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { audit } from '@/server/services/audit';

import {
  challengeFactorAction,
  enrollFactorAction,
  stepUpMethodsAction,
  unenrollFactorAction,
  verifyEnrollmentAction,
} from './mfa';

const NOT_STARTED = 'Could not start the authenticator check. Please try again.';
const SETUP_NOT_OPEN = 'This authenticator set-up is no longer open. Start again.';
const SESSION_ENDED = 'You were signed out on this device. Sign in again to continue.';
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
  h.record = RECORDED;
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
  });

  it('checks the authenticator app beside the bridge as before', async () => {
    h.factors = [BRIDGE, APP];
    const res = await challengeFactorAction({ factorId: APP.id, code: CODE });
    expect(res).toEqual({ ok: true, data: undefined });
    expect(mfaStub.challenge).toHaveBeenCalledWith({ factorId: APP.id });
  });

  it('checks a reserved-name factor that is not the recorded bridge like any authenticator app', async () => {
    h.factors = [IMPOSTOR, APP];
    const res = await challengeFactorAction({ factorId: IMPOSTOR.id, code: CODE });
    expect(res).toEqual({ ok: true, data: undefined });
    expect(mfaStub.challenge).toHaveBeenCalledWith({ factorId: IMPOSTOR.id });
  });

  it('before the records exist, a reserved-name factor is checked like any authenticator app', async () => {
    h.factors = [BRIDGE];
    h.record = NOT_YET;
    const res = await challengeFactorAction({ factorId: BRIDGE.id, code: CODE });
    expect(res).toEqual({ ok: true, data: undefined });
    expect(mfaStub.challenge).toHaveBeenCalledWith({ factorId: BRIDGE.id });
    expect(reportError).not.toHaveBeenCalled();
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
  it('refuses to remove the recorded bridge', async () => {
    h.factors = [APP, BRIDGE];
    const res = await unenrollFactorAction({ factorId: BRIDGE.id });
    expect(res).toEqual({
      ok: false,
      error: { code: 'validation_error', message: 'Invalid factor' },
    });
    expect(mfaStub.unenroll).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('removes the authenticator app beside the bridge as before', async () => {
    h.factors = [BRIDGE, APP];
    const res = await unenrollFactorAction({ factorId: APP.id });
    expect(res).toEqual({ ok: true, data: undefined });
    expect(mfaStub.unenroll).toHaveBeenCalledWith({ factorId: APP.id });
  });

  it('removes a reserved-name factor that is not the recorded bridge, like any authenticator app', async () => {
    h.factors = [APP, IMPOSTOR];
    h.record = { data: null, error: null };
    const res = await unenrollFactorAction({ factorId: IMPOSTOR.id });
    expect(res).toEqual({ ok: true, data: undefined });
    expect(mfaStub.unenroll).toHaveBeenCalledWith({ factorId: IMPOSTOR.id });
  });

  it('a record that cannot be read hides nothing: the removal goes on, and is reported', async () => {
    h.factors = [APP, BRIDGE];
    h.record = UNREADABLE;
    const res = await unenrollFactorAction({ factorId: BRIDGE.id });
    expect(res).toEqual({ ok: true, data: undefined });
    expect(mfaStub.unenroll).toHaveBeenCalledWith({ factorId: BRIDGE.id });
    expect(reportError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tag: 'passkeys.bridge_unreadable', level: 'error' }),
    );
  });

  it('a factor list that cannot be read hides nothing: the removal goes on as before', async () => {
    h.getUserFails = true;
    const res = await unenrollFactorAction({ factorId: APP.id });
    expect(res).toEqual({ ok: true, data: undefined });
    expect(mfaStub.unenroll).toHaveBeenCalledWith({ factorId: APP.id });
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
  });

  it('the clean-up removes an unfinished reserved-name factor that is not recorded, like any set-up', async () => {
    h.factors = [{ ...IMPOSTOR, status: 'unverified' }];
    h.record = { data: null, error: null };
    await enrollFactorAction();
    expect(mfaStub.unenroll.mock.calls).toEqual([[{ factorId: IMPOSTOR.id }]]);
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
      },
    });
  });

  it('shows a reserved-name factor that is not the recorded bridge like any authenticator app', async () => {
    h.factors = [IMPOSTOR, BRIDGE];
    const res = await stepUpMethodsAction();
    expect(res).toEqual({
      ok: true,
      data: { apps: [{ id: IMPOSTOR.id, friendlyName: IMPOSTOR.friendly_name }] },
    });
  });

  it('a record that cannot be read hides nothing', async () => {
    h.factors = [BRIDGE, APP];
    h.record = UNREADABLE;
    const res = await stepUpMethodsAction();
    expect(res).toEqual({
      ok: true,
      data: {
        apps: [
          { id: BRIDGE.id, friendlyName: BRIDGE.friendly_name },
          { id: APP.id, friendlyName: 'Phone' },
        ],
      },
    });
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

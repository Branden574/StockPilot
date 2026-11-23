import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Security invariant (stage 4, the integrator's no-change rule of
 * 2026-11-21): while passkeys are dark, removing an authenticator app is
 * EXACTLY what it was before this work for an account that holds no passkey.
 * The rule is the base's: refused when the ACTIVE organization's policy
 * requires a second step of the member, with the base's words (no passkey in
 * them); a policy that cannot be read keeps its own words. Not one passkey
 * table is read and no passkey judgement is asked for such an account, in
 * every case, including those the unified rule would answer differently
 * (one of two apps under a requiring policy; another organization's policy;
 * an unfinished set-up).
 *
 * The unified last-method rule (server/security/second-step-methods.ts, with
 * both corrections) applies only to an account that holds an ACTIVE passkey
 * of this site. Names first: only a factor list that carries the reserved
 * bridge name leads to the one row read that tells. Its words name a
 * passkey; what cannot be read is "try again".
 *
 * The real modules decide here (server/actions/mfa.ts, second-step-methods,
 * lib/auth/passkey-bridge); the clients are fakes that record every read.
 * The passkey judgement (servingPasskeyIds) is a spy: passkeys.test.ts runs
 * the real one.
 */

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  role: 'admin' as string,
  orgRead: { data: { mfa_policy: 'optional' }, error: null } as {
    data: { mfa_policy: string } | null;
    error: { code: string; message: string } | null;
  },
  /** The factor list the context read (null: unread, or another account's). */
  factors: null as Row[] | null,
  passkeys: [] as Row[],
  /** Other organizations of the member (service-role reads). */
  memberships: [] as Row[],
  organizations: [] as Row[],
  failTables: new Set<string>(),
  tableReads: [] as string[],
  adminClients: 0,
  serving: [] as string[] | null,
}));

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
    role: h.role,
  })),
}));
vi.mock('@/server/services/context', async () => {
  const { keepContextFactorListRead } = await import('@/lib/auth/context-factor-list');
  return {
    withContext: vi.fn(async () => {
      const ctx = {};
      if (h.factors !== null)
        keepContextFactorListRead(
          ctx,
          Promise.resolve({ userId: 'user-1', factors: h.factors as never }),
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
vi.mock('@/server/services/audit', () => ({ audit: vi.fn(async () => {}) }));
vi.mock('@/server/services/integration-events', () => ({ dispatchEvent: vi.fn(async () => {}) }));
vi.mock('@/lib/auth/verify-password', () => ({
  verifyPasswordSideChannel: vi.fn(async () => ({ ok: true })),
}));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, count: 1, resetAt: Date.now() + 1000 })),
}));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('@/lib/auth/passkey-relying-party', () => ({
  passkeyRelyingParty: () => ({ rpId: 'localhost', origins: ['http://localhost:3000'] }),
}));
vi.mock('@/server/security/passkeys', () => ({
  passkeyStepFor: vi.fn(async () => 'none'),
  servingPasskeyIds: vi.fn(async () => h.serving),
}));

const unenroll = vi.fn(async () => ({ data: null, error: null }));
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => {
    const q = {
      select: () => q,
      eq: () => q,
      maybeSingle: async () => h.orgRead,
    };
    return { from: () => q, auth: { mfa: { unenroll } } };
  }),
}));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => {
    h.adminClients += 1;
    return {
      from: (table: string) => {
        h.tableReads.push(table);
        const filters: Array<(r: Row) => boolean> = [];
        let single = false;
        const rows = (): Row[] =>
          table === 'member_passkeys'
            ? h.passkeys
            : table === 'organization_members'
              ? h.memberships
              : table === 'organizations'
                ? h.organizations
                : table === 'passkey_bridges'
                  ? [{ user_id: 'user-1', factor_id: 'bridge-1' }]
                  : [];
        const answer = () => {
          if (h.failTables.has(table))
            return { data: null, error: { code: '57014', message: 'canceling statement' } };
          const out = rows().filter((r) => filters.every((f) => f(r)));
          return { data: single ? (out[0] ?? null) : out, error: null };
        };
        const q: Record<string, unknown> = {
          select: () => q,
          eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), q),
          is: (c: string, v: null) => (filters.push((r) => (r[c] ?? null) === v), q),
          not: (c: string) => (filters.push((r) => (r[c] ?? null) !== null), q),
          limit: () => q,
          order: () => q,
          maybeSingle: async () => ((single = true), answer()),
          then: (resolve: (v: unknown) => unknown) => Promise.resolve(answer()).then(resolve),
        };
        return q;
      },
    };
  },
}));

import { servingPasskeyIds } from '@/server/security/passkeys';

import { unenrollFactorAction } from './mfa';

const OLD_WORDS =
  'Your organization requires MFA. Ask an admin to lower the policy before disabling.';
const POLICY_UNREAD = "Could not check your organization's MFA policy. Try again.";
const LAST_METHOD =
  'Your organization requires a second step. Add another authenticator app or passkey before you remove this one.';
const TRY_AGAIN = 'Could not check this authenticator just now. Try again in a moment.';

const app = (id: string, extra: Row = {}) => ({
  id,
  factor_type: 'totp',
  status: 'verified',
  friendly_name: 'Phone',
  ...extra,
});
const APP = app('app-1');
const APP2 = app('app-2');
const BRIDGE = app('bridge-1', { friendly_name: 'sp-passkey-bridge-a1b2c3d4e5f6' });
const passkey = (extra: Row = {}) => ({
  id: 'p-1',
  user_id: 'user-1',
  rp_id: 'localhost',
  removed_at: null,
  ...extra,
});

function otherOrganization(policy: string, role = 'staff') {
  const id = `org-${h.organizations.length + 2}`;
  h.organizations.push({ id, mfa_policy: policy });
  h.memberships.push({
    user_id: 'user-1',
    organization_id: id,
    role,
    accepted_at: '2026-11-01T00:00:00Z',
    impersonation_expires_at: null,
  });
}

const refusedWith = (code: string, message: string) => ({ ok: false, error: { code, message } });
const REMOVED = { ok: true, data: undefined };

beforeEach(() => {
  vi.clearAllMocks();
  h.role = 'admin';
  h.orgRead = { data: { mfa_policy: 'optional' }, error: null };
  h.factors = null;
  h.passkeys = [];
  h.memberships = [];
  h.organizations = [];
  h.failTables = new Set();
  h.tableReads = [];
  h.adminClients = 0;
  h.serving = [];
});

describe('an account with no passkey: the base rule exactly, and no passkey read', () => {
  /** The factor lists such an account can come with: unread, one app, two apps, an unfinished set-up. */
  const LISTS: Array<[string, Row[] | null]> = [
    ['an unread list', null],
    ['one app', [APP]],
    ['two apps', [APP, APP2]],
    ['an unfinished set-up', [app('app-1', { status: 'unverified' })]],
  ];
  const nothingRead = () => {
    expect(h.adminClients).toBe(0);
    expect(h.tableReads).toEqual([]);
    expect(servingPasskeyIds).not.toHaveBeenCalled();
  };

  for (const [label, factors] of LISTS) {
    describe(label, () => {
      beforeEach(() => {
        h.factors = factors;
      });

      it('removes the factor under an optional policy', async () => {
        expect(await unenrollFactorAction({ factorId: 'app-1' })).toEqual(REMOVED);
        expect(unenroll).toHaveBeenCalledOnce();
        nothingRead();
      });

      it("refuses under a policy that requires MFA for this role, with the base's words", async () => {
        h.orgRead = { data: { mfa_policy: 'admins_required' }, error: null };
        expect(await unenrollFactorAction({ factorId: 'app-1' })).toEqual(
          refusedWith('forbidden', OLD_WORDS),
        );
        h.orgRead = { data: { mfa_policy: 'all_required' }, error: null };
        h.role = 'staff';
        expect(await unenrollFactorAction({ factorId: 'app-1' })).toEqual(
          refusedWith('forbidden', OLD_WORDS),
        );
        expect(unenroll).not.toHaveBeenCalled();
        nothingRead();
      });

      it('an admins-only policy does not hold a staff member: removed', async () => {
        h.orgRead = { data: { mfa_policy: 'admins_required' }, error: null };
        h.role = 'staff';
        expect(await unenrollFactorAction({ factorId: 'app-1' })).toEqual(REMOVED);
        nothingRead();
      });

      it("refuses when the policy read FAILS, with that read's own words", async () => {
        h.orgRead = { data: null, error: { code: '57014', message: 'statement timeout' } };
        expect(await unenrollFactorAction({ factorId: 'app-1' })).toEqual(
          refusedWith('internal_error', POLICY_UNREAD),
        );
        expect(unenroll).not.toHaveBeenCalled();
        nothingRead();
      });

      it('refuses when the row is HIDDEN, even for a role an admins-only policy would exempt', async () => {
        h.role = 'staff';
        h.orgRead = { data: null, error: null };
        expect(await unenrollFactorAction({ factorId: 'app-1' })).toEqual(
          refusedWith('forbidden', OLD_WORDS),
        );
        expect(unenroll).not.toHaveBeenCalled();
        nothingRead();
      });

      it("another organization's policy is not asked (the active one decides, as before)", async () => {
        otherOrganization('all_required', 'owner');
        expect(await unenrollFactorAction({ factorId: 'app-1' })).toEqual(REMOVED);
        nothingRead();
      });
    });
  }

  it('a reserved-name factor with no passkey row (not ours) is told by one row read, then the base rule', async () => {
    h.factors = [APP, APP2, app('other-1', { friendly_name: 'sp-passkey-bridge-zzz' })];
    h.orgRead = { data: { mfa_policy: 'all_required' }, error: null };
    expect(await unenrollFactorAction({ factorId: 'app-1' })).toEqual(
      refusedWith('forbidden', OLD_WORDS),
    );
    expect(h.tableReads).toEqual(['member_passkeys']);
    expect(servingPasskeyIds).not.toHaveBeenCalled();
  });

  it('a removed passkey, or one of another site, is no passkey held here: the base rule', async () => {
    h.factors = [APP, APP2, BRIDGE];
    h.orgRead = { data: { mfa_policy: 'all_required' }, error: null };
    for (const row of [
      passkey({ removed_at: '2026-11-20T00:00:00Z' }),
      passkey({ rp_id: 'other.example.test' }),
    ]) {
      h.passkeys = [row];
      expect(await unenrollFactorAction({ factorId: 'app-1' })).toEqual(
        refusedWith('forbidden', OLD_WORDS),
      );
    }
    expect(servingPasskeyIds).not.toHaveBeenCalled();
  });
});

describe('an account that holds an active passkey of this site: the unified rule', () => {
  beforeEach(() => {
    h.passkeys = [passkey()];
    h.orgRead = { data: { mfa_policy: 'all_required' }, error: null };
  });

  it('one of two apps may go under a requiring policy, with no passkey judgement asked', async () => {
    h.factors = [APP, APP2, BRIDGE];
    expect(await unenrollFactorAction({ factorId: 'app-1' })).toEqual(REMOVED);
    expect(h.tableReads).toEqual(['member_passkeys']);
    expect(servingPasskeyIds).not.toHaveBeenCalled();
  });

  it('the last app beside a passkey that serves may go; beside passkeys that cannot serve it is the last method', async () => {
    h.factors = [APP, BRIDGE];
    h.serving = ['p-1'];
    expect(await unenrollFactorAction({ factorId: 'app-1' })).toEqual(REMOVED);
    expect(servingPasskeyIds).toHaveBeenCalledWith('user-1', h.factors);
    h.serving = [];
    expect(await unenrollFactorAction({ factorId: 'app-1' })).toEqual(
      refusedWith('forbidden', LAST_METHOD),
    );
  });

  it("another organization's policy counts for a passkey holder", async () => {
    h.factors = [APP, BRIDGE];
    h.orgRead = { data: { mfa_policy: 'optional' }, error: null };
    expect(await unenrollFactorAction({ factorId: 'app-1' })).toEqual(REMOVED);
    otherOrganization('all_required');
    expect(await unenrollFactorAction({ factorId: 'app-1' })).toEqual(
      refusedWith('forbidden', LAST_METHOD),
    );
  });

  it('a passkey judgement that cannot be made, under a requiring policy: try again', async () => {
    h.factors = [APP, BRIDGE];
    h.serving = null;
    expect(await unenrollFactorAction({ factorId: 'app-1' })).toEqual(
      refusedWith('internal_error', TRY_AGAIN),
    );
    expect(unenroll).not.toHaveBeenCalled();
  });

  it('the row read that tells fails: try again under the active policy; with another app and no active policy, removed', async () => {
    h.factors = [APP, APP2, BRIDGE];
    h.failTables.add('member_passkeys');
    expect(await unenrollFactorAction({ factorId: 'app-1' })).toEqual(
      refusedWith('internal_error', TRY_AGAIN),
    );
    h.orgRead = { data: { mfa_policy: 'optional' }, error: null };
    expect(await unenrollFactorAction({ factorId: 'app-1' })).toEqual(REMOVED);
    h.factors = [APP, BRIDGE];
    otherOrganization('all_required');
    expect(await unenrollFactorAction({ factorId: 'app-1' })).toEqual(
      refusedWith('internal_error', TRY_AGAIN),
    );
  });

  it('the active policy read failing keeps its own words, as before', async () => {
    h.factors = [APP, BRIDGE];
    h.orgRead = { data: null, error: { code: '57014', message: 'statement timeout' } };
    expect(await unenrollFactorAction({ factorId: 'app-1' })).toEqual(
      refusedWith('internal_error', POLICY_UNREAD),
    );
  });
});

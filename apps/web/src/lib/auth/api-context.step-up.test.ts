import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Security invariant (docket S43a): an account with a verified authenticator
 * factor is not served through the API until its session has the code.
 *
 * Before S43a, withApiContext only LABELLED such a session (mfaRequired true,
 * mfaSatisfied false) and returned it; the refusal lived in assertPermission,
 * which the mobile snapshot, GET /api/v1/orders/[id], the CSV exports and
 * about 66 other handlers never call. So a password alone read the account's
 * organization through the API, and the phone synced before its code screen.
 *
 * Now both paths return null (each route's own 401) right after the identity
 * check when stepUpOwed(user.factors, aal) holds: before the context RPC, before
 * any table read, with one info line and no error report. A 401, not a 403:
 * phones already installed retry a 401 and keep their queued work.
 *
 * What does NOT change is pinned too: an unenrolled admin under
 * admins_required still reads (writes are refused by assertPermission, as
 * before), and the opt-out for the AAL1 allowlist (allowStepUpPending) gets
 * the labelled context.
 */

const refs = vi.hoisted(() => ({
  client: null as unknown,
  reportError: vi.fn(async () => {}),
}));

vi.mock('@/lib/error-reporter', () => ({
  reportError: (...a: unknown[]) => refs.reportError(...(a as [])),
}));
vi.mock('@/lib/env', () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: 'https://db.example.test',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
  },
}));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => refs.client }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => refs.client }));

import { verifiedSessionAuth } from '@/test/verified-session-stub';

import { cookieSessionOwesStepUp, withApiContext } from './api-context';

const USER = '99999999-9999-4999-8999-999999999999';
const ORG = 'aaaaaaaa-1111-4111-8111-111111111111';
const EMAIL = 'person@example.test';
const COOKIE_VALUE = 'cookie-value-not-for-logs';

type Policy = 'optional' | 'admins_required' | 'all_required';

/** Another account, whose session a cookie can refresh into mid-request. */
const OTHER = '33333333-3333-4333-8333-333333333333';

const world = {
  /** GoTrue's factors on the validated user (both paths read them off getUser). */
  factors: [] as Array<{ status: string }>,
  /** The cookie session's own level: the `aal` of its verified token. */
  cookieAal: 'aal1' as 'aal1' | 'aal2' | null,
  /** Whose session the cookie holds when its level is read (another account after a swap). */
  cookieSub: USER,
  /** How that level read goes. */
  aalRead: 'answer' as 'answer' | 'error' | 'throw',
  policy: 'optional' as Policy,
  role: 'staff' as 'owner' | 'admin' | 'manager' | 'staff' | 'viewer',
  disabled: false,
  /** Legacy path only: the MFA policy read fails. */
  policyReadFails: false,
  calls: [] as string[],
};

function bundleJson() {
  return {
    user_id: USER,
    profile: {
      id: USER,
      email: EMAIL,
      full_name: null,
      avatar_url: null,
      default_organization_id: ORG,
      disabled_at: world.disabled ? '2026-10-01T00:00:00Z' : null,
    },
    memberships: [
      {
        organization_id: ORG,
        role: world.role,
        organization: {
          id: ORG,
          name: 'Org',
          logo_url: null,
          terminology: null,
          mfa_policy: world.policy,
          timezone: null,
          nav_overrides: null,
          dashboard_layout: null,
          order_status_config: null,
          all_modules_comp: false,
          order_catalog_last_hide_at: null,
        },
        role_overrides: [],
        user_overrides: [],
        enabled_modules: [],
      },
    ],
  };
}

/** A PostgREST-shaped builder: chainable, awaitable and maybeSingle-able. */
function table(single: unknown, list: unknown[] = [], error: unknown = null) {
  const q: Record<string, unknown> = {};
  const self = () => q;
  for (const k of ['select', 'eq', 'is', 'not', 'in', 'limit', 'order']) q[k] = self;
  q.maybeSingle = async () => ({ data: error ? null : single, error, status: error ? 500 : 200 });
  q.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve({ data: error ? null : list, error, status: error ? 500 : 200 }).then(resolve);
  return q;
}

/** A single-row fake that also answers its row as a one-row list (the membership choice reads lists). */
const row = (r: unknown) => table(r, r ? [r] : []);

function makeClient() {
  return {
    rpc: async (name: string) => {
      world.calls.push(`rpc:${name}`);
      return { data: bundleJson(), error: null };
    },
    from: (name: string) => {
      world.calls.push(`from:${name}`);
      if (name === 'user_profiles')
        return row({
          id: USER,
          default_organization_id: ORG,
          disabled_at: world.disabled ? '2026-10-01T00:00:00Z' : null,
        });
      if (name === 'organization_members') return row({ organization_id: ORG, role: world.role });
      if (name === 'organizations')
        return table(
          { mfa_policy: world.policy, all_modules_comp: false },
          [],
          world.policyReadFails ? { code: '57014', message: 'canceling statement' } : null,
        );
      return table(null, []);
    },
    auth: {
      getUser: async () => {
        world.calls.push('auth:getUser');
        return { data: { user: { id: USER, email: EMAIL, factors: world.factors } }, error: null };
      },
      // The level read: the session's access token, then its verified claims
      // (lib/auth/verified-claims). Recorded as one 'auth:aal' per read.
      ...verifiedSessionAuth(
        () => ({ sub: world.cookieSub, aal: world.cookieAal, read: world.aalRead }),
        (call) => {
          if (call === 'getSession') world.calls.push('auth:aal');
        },
      ),
    },
  };
}

/** A token whose `aal` claim the bearer path reads after GoTrue accepted it. */
function jwt(aal?: 'aal1' | 'aal2'): string {
  const seg = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${seg({ alg: 'HS256', typ: 'JWT' })}.${seg({ sub: USER, email: EMAIL, ...(aal ? { aal } : {}) })}.sig`;
}

/** The phone's snapshot pull, with a query string that must never be logged. */
const SNAPSHOT_URL = `https://app.test/api/v1/mobile/snapshot?since=2026-10-01T00%3A00%3A00Z&email=${encodeURIComponent(EMAIL)}`;

function bearer(aal: 'aal1' | 'aal2' | undefined, url = SNAPSHOT_URL): Request {
  return new Request(url, {
    headers: { authorization: `Bearer ${jwt(aal)}`, 'x-organization-id': ORG },
  });
}

function cookie(url = 'https://app.test/api/inventory/export.csv?q=secret-search'): Request {
  return new Request(url, { headers: { cookie: `sb-example-auth-token=${COOKIE_VALUE}` } });
}

const VERIFIED = [{ status: 'verified' }];

let info: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  info = vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  delete process.env.REQUEST_CONTEXT_RPC;
  world.factors = [];
  world.cookieAal = 'aal1';
  world.cookieSub = USER;
  world.aalRead = 'answer';
  world.policy = 'optional';
  world.role = 'staff';
  world.disabled = false;
  world.policyReadFails = false;
  world.calls = [];
  refs.client = makeClient();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.REQUEST_CONTEXT_RPC;
});

describe('the bearer path (the phone) refuses a session that owes its code', () => {
  it('a verified factor and an aal1 token: null, and nothing past the identity check runs', async () => {
    world.factors = VERIFIED;
    expect(await withApiContext(bearer('aal1'))).toBeNull();
    expect(world.calls).toEqual(['auth:getUser']);
  });

  it('a token with no aal claim counts as not aal2', async () => {
    world.factors = VERIFIED;
    expect(await withApiContext(bearer(undefined))).toBeNull();
    expect(world.calls).toEqual(['auth:getUser']);
  });

  it('an aal2 token is served, labelled satisfied', async () => {
    world.factors = VERIFIED;
    const ctx = await withApiContext(bearer('aal2'));
    expect(ctx).not.toBeNull();
    expect(ctx?.mfaRequired).toBe(true);
    expect(ctx?.mfaSatisfied).toBe(true);
    expect(ctx?.mfaEnrolled).toBe(true);
  });

  it('no factor, or only an unverified one, is served at aal1 (the unattended QA path stays open)', async () => {
    for (const factors of [[], [{ status: 'unverified' }]]) {
      world.factors = factors;
      const ctx = await withApiContext(bearer('aal1'));
      expect(ctx).not.toBeNull();
      expect(ctx?.mfaRequired).toBe(false);
      expect(ctx?.mfaSatisfied).toBe(true);
    }
  });

  it('the legacy reads are refused just as early', async () => {
    process.env.REQUEST_CONTEXT_RPC = 'off';
    world.factors = VERIFIED;
    expect(await withApiContext(bearer('aal1'))).toBeNull();
    expect(world.calls).toEqual(['auth:getUser']);
  });
});

describe('the cookie path (the web) refuses a session that owes its code', () => {
  it('a verified factor and an aal1 session: null, after reading only the session level', async () => {
    world.factors = VERIFIED;
    world.cookieAal = 'aal1';
    expect(await withApiContext(cookie())).toBeNull();
    expect(world.calls).toEqual(['auth:getUser', 'auth:aal']);
  });

  it('an aal2 session is served, labelled satisfied', async () => {
    world.factors = VERIFIED;
    world.cookieAal = 'aal2';
    const ctx = await withApiContext(cookie());
    expect(ctx).not.toBeNull();
    expect(ctx?.mfaRequired).toBe(true);
    expect(ctx?.mfaSatisfied).toBe(true);
  });

  it('a level that cannot be read, or is missing, counts as not aal2', async () => {
    world.factors = VERIFIED;
    world.cookieAal = 'aal2';
    for (const mode of ['error', 'throw'] as const) {
      world.aalRead = mode;
      world.calls = [];
      expect(await withApiContext(cookie()), mode).toBeNull();
      expect(
        world.calls.some((c) => c.startsWith('rpc:') || c.startsWith('from:')),
        mode,
      ).toBe(false);
    }
    world.aalRead = 'answer';
    world.cookieAal = null;
    expect(await withApiContext(cookie())).toBeNull();
  });

  it('a caller with no factor is served, and its level is never read for this check', async () => {
    world.factors = [];
    const ctx = await withApiContext(cookie());
    expect(ctx).not.toBeNull();
    expect(world.calls).not.toContain('auth:aal');
  });

  it('the legacy reads are refused just as early', async () => {
    process.env.REQUEST_CONTEXT_RPC = 'off';
    world.factors = VERIFIED;
    expect(await withApiContext(cookie())).toBeNull();
    expect(world.calls).toEqual(['auth:getUser', 'auth:aal']);
  });
});

describe("the cookie level is the validated user's own (review round 1)", () => {
  // A cookie's refresh token and expires_at are the sender's to write, so the
  // load behind the level read can refresh into ANOTHER account's session after
  // getUser() validated this one. Its aal2 must count for nothing here.
  it("a session that now holds another account's aal2: refused, one info line, no read", async () => {
    world.factors = VERIFIED;
    world.cookieSub = OTHER;
    world.cookieAal = 'aal2';
    expect(await withApiContext(cookie())).toBeNull();
    expect(world.calls).toEqual(['auth:getUser', 'auth:aal']);
    expect(info).toHaveBeenCalledTimes(1);
  });

  it('on the AAL1 allowlist that context is labelled unsatisfied', async () => {
    world.factors = VERIFIED;
    world.cookieSub = OTHER;
    world.cookieAal = 'aal2';
    const ctx = await withApiContext(cookie(), { allowStepUpPending: true });
    expect(ctx?.mfaRequired).toBe(true);
    expect(ctx?.mfaSatisfied).toBe(false);
  });

  it.each([['fast'], ['legacy']] as const)(
    "an admin with no factor under admins_required: another account's aal2 cannot satisfy the policy (%s)",
    async (path) => {
      if (path === 'legacy') process.env.REQUEST_CONTEXT_RPC = 'off';
      world.policy = 'admins_required';
      world.role = 'admin';
      world.factors = [];
      world.cookieSub = OTHER;
      world.cookieAal = 'aal2';
      const ctx = await withApiContext(cookie());
      expect(ctx?.mfaRequired).toBe(true);
      expect(ctx?.mfaSatisfied).toBe(false);
      // The same admin's own aal2 session does satisfy it.
      world.cookieSub = USER;
      expect((await withApiContext(cookie()))?.mfaSatisfied).toBe(true);
    },
  );

  it('the refusal and the label share one level read', async () => {
    world.factors = VERIFIED;
    world.cookieAal = 'aal2';
    const ctx = await withApiContext(cookie());
    expect(ctx?.mfaSatisfied).toBe(true);
    expect(world.calls.filter((c) => c === 'auth:aal')).toHaveLength(1);
  });
});

describe('a refusal reads nothing, reports nothing, and logs one line with no secret in it', () => {
  it.each([
    [
      'bearer',
      () => bearer('aal1'),
      { method: 'GET', path: '/api/v1/mobile/snapshot', via: 'bearer' },
    ],
    ['cookie', () => cookie(), { method: 'GET', path: '/api/inventory/export.csv', via: 'cookie' }],
  ] as const)('%s', async (_kind, make, line) => {
    world.factors = VERIFIED;
    const req = make();
    expect(await withApiContext(req)).toBeNull();

    expect(world.calls.filter((c) => c.startsWith('rpc:') || c.startsWith('from:'))).toEqual([]);
    expect(refs.reportError).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]).toEqual([
      '[api-context] refused a session that still owes its authenticator code',
      line,
    ]);

    const logged = JSON.stringify(info.mock.calls);
    const token = req.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
    for (const secret of [COOKIE_VALUE, 'secret-search', 'since=', EMAIL, 'example.test', USER]) {
      expect(logged).not.toContain(secret);
    }
    if (token) expect(logged).not.toContain(token);
  });

  it('a served request logs nothing', async () => {
    world.factors = VERIFIED;
    world.cookieAal = 'aal2';
    expect(await withApiContext(cookie())).not.toBeNull();
    expect(await withApiContext(bearer('aal2'))).not.toBeNull();
    expect(info).not.toHaveBeenCalled();
  });
});

describe('what S43a leaves as it was', () => {
  it.each([
    ['bearer', () => bearer('aal1')],
    ['cookie', () => cookie()],
  ] as const)(
    'an admin with no factor under admins_required is still served at aal1, labelled unsatisfied (%s)',
    async (_kind, make) => {
      world.policy = 'admins_required';
      world.role = 'admin';
      world.factors = [];
      const ctx = await withApiContext(make());
      expect(ctx).not.toBeNull();
      expect(ctx?.mfaRequired).toBe(true);
      expect(ctx?.mfaSatisfied).toBe(false);
      expect(ctx?.mfaEnrolled).toBe(false);
    },
  );

  it.each([
    ['bearer', () => bearer('aal1')],
    ['cookie', () => cookie()],
  ] as const)(
    'a member of an all_required organization with no factor is still served at aal1 (HI-6 only; open question 2) (%s)',
    async (_kind, make) => {
      world.policy = 'all_required';
      world.role = 'staff';
      world.factors = [];
      const ctx = await withApiContext(make());
      expect(ctx).not.toBeNull();
      expect(ctx?.mfaSatisfied).toBe(false);
    },
  );

  it.each([
    ['bearer', () => bearer('aal2')],
    ['cookie', () => cookie()],
  ] as const)(
    'an enrolled aal2 session is not refused when the policy read fails (%s)',
    async (_kind, make) => {
      process.env.REQUEST_CONTEXT_RPC = 'off';
      world.factors = VERIFIED;
      world.cookieAal = 'aal2';
      world.policyReadFails = true;
      const ctx = await withApiContext(make());
      expect(ctx).not.toBeNull();
      // The policy read still fails closed on the labels, as before.
      expect(ctx?.mfaRequired).toBe(true);
    },
  );

  it('a disabled account is refused as before, with or without the code', async () => {
    world.disabled = true;
    world.factors = VERIFIED;
    world.cookieAal = 'aal2';
    expect(await withApiContext(cookie())).toBeNull();
    expect(await withApiContext(bearer('aal2'))).toBeNull();
  });
});

describe('allowStepUpPending: the reviewed AAL1 allowlist', () => {
  it.each([
    ['bearer', () => bearer('aal1')],
    ['cookie', () => cookie()],
  ] as const)('an enrolled aal1 session gets the labelled context (%s)', async (_kind, make) => {
    world.factors = VERIFIED;
    const ctx = await withApiContext(make(), { allowStepUpPending: true });
    expect(ctx).not.toBeNull();
    expect(ctx?.mfaRequired).toBe(true);
    expect(ctx?.mfaSatisfied).toBe(false);
    expect(ctx?.mfaEnrolled).toBe(true);
    expect(info).not.toHaveBeenCalled();
  });

  it('lets nothing else through: a disabled account is still refused', async () => {
    world.factors = VERIFIED;
    world.disabled = true;
    expect(await withApiContext(cookie(), { allowStepUpPending: true })).toBeNull();
    expect(await withApiContext(bearer('aal1'), { allowStepUpPending: true })).toBeNull();
  });
});

describe('cookieSessionOwesStepUp: the check the OAuth callbacks share', () => {
  const owes = () =>
    cookieSessionOwesStepUp(refs.client, { id: USER, factors: world.factors } as never);

  it('no factor: nothing owed, and the level is not read', async () => {
    world.factors = [];
    expect(await owes()).toBe(false);
    expect(world.calls).not.toContain('auth:aal');
  });

  it('a verified factor: owed at aal1, not at aal2', async () => {
    world.factors = VERIFIED;
    world.cookieAal = 'aal1';
    expect(await owes()).toBe(true);
    world.cookieAal = 'aal2';
    expect(await owes()).toBe(false);
  });

  it('a level that cannot be read, or is missing, is owed (fail closed)', async () => {
    world.factors = VERIFIED;
    world.cookieAal = 'aal2';
    world.aalRead = 'error';
    expect(await owes()).toBe(true);
    world.aalRead = 'throw';
    expect(await owes()).toBe(true);
    world.aalRead = 'answer';
    world.cookieAal = null;
    expect(await owes()).toBe(true);
  });

  it("another account's aal2 session is owed: the level must be the given user's", async () => {
    world.factors = VERIFIED;
    world.cookieAal = 'aal2';
    world.cookieSub = OTHER;
    expect(await owes()).toBe(true);
    world.cookieSub = USER;
    expect(await owes()).toBe(false);
  });
});

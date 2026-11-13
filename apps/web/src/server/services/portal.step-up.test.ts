import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Security invariant (docket S43c): the customer portal is held to the
 * authenticator rule. resolvePortalContext() is its own identity funnel: it
 * validates the signed-in account with getUser() and then reads with the
 * service-role client, so nothing in requireOrgContext() or the API context
 * speaks for it. An account that has a verified authenticator is a portal
 * customer only on a session at aal2; below that it is sent to the code page,
 * which returns to the portal, before the service-role client is made.
 *
 * The level is the account's own: the session's verified claims, held to the
 * account getUser() named. A load of the cookie session can refresh it into
 * another account's (see readVerifiedSessionClaimsOf), and claims of another
 * account are no level at all.
 *
 * The REAL @supabase/ssr server client and auth-js run against the fixture's
 * ES256 keys and Auth server (src/test/auth-session-fixture.ts), which lists a
 * verified TOTP factor for every account unless it is named in
 * `unenrolledUsers`. The service-role client is a stand-in that records every
 * table it is asked for. Made-up people and organizations only.
 */

const refs = vi.hoisted(() => ({
  adminMade: 0,
  adminTables: [] as string[],
  status: 'active' as 'active' | 'disabled',
}));

let jar = new Map<string, string>();
vi.mock('next/headers', async () => {
  const { cookieStoreOver } = await import('@/test/auth-session-fixture');
  return { cookies: async () => cookieStoreOver(jar), headers: async () => new Headers() };
});
vi.mock('@/lib/env', async () => {
  const f = await import('@/test/auth-session-fixture');
  return {
    env: {
      NEXT_PUBLIC_SUPABASE_URL: f.FIXTURE_SUPABASE_URL,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: f.FIXTURE_ANON_KEY,
    },
  };
});
vi.mock('next/navigation', () => ({
  redirect: vi.fn((to: string) => {
    throw new Error(`REDIRECT:${to}`);
  }),
  notFound: vi.fn(() => {
    throw new Error('NOT_FOUND');
  }),
}));
// The account-status read is a table read on the cookie client, which the
// fixture's Auth server does not answer; its own suite is
// lib/auth/account-status.test.ts.
vi.mock('@/lib/auth/account-status', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account-status')>()),
  loadAccountStatus: async () => refs.status,
}));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('@/server/services/integration-events', () => ({ dispatchEvent: vi.fn(async () => {}) }));
vi.mock('@/server/services/returns', () => ({
  pendingReturnQuantitiesByLine: vi.fn(async () => new Map<string, number>()),
}));

const ORG = 'aaaaaaaa-1111-4111-8111-111111111111';
const CUSTOMER = '77777777-7777-4777-8777-777777777777';

/** Minimal PostgREST-shaped stand-in: chainable, awaitable, and maybeSingle-able. */
function table(single: unknown, list: unknown[] = []) {
  const q: Record<string, unknown> = {};
  const self = () => q;
  for (const m of ['select', 'eq', 'is', 'update']) q[m] = self;
  q.maybeSingle = async () => ({ data: single, error: null });
  q.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve({ data: list, error: null }).then(resolve);
  return q;
}

/** The service-role client: one accepted, active customer of an organization with the portal on. */
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => {
    refs.adminMade += 1;
    return {
      from: (name: string) => {
        refs.adminTables.push(name);
        if (name === 'customer_users') {
          return table(null, [
            {
              customer_id: CUSTOMER,
              email: 'buyer@example.test',
              accepted_at: '2026-10-01T00:00:00Z',
              invited_at: '2026-09-01T00:00:00Z',
              customer: {
                id: CUSTOMER,
                name: 'Example Customer',
                status: 'active',
                organization_id: ORG,
                price_list_id: null,
              },
            },
          ]);
        }
        if (name === 'organization_modules') {
          return table({ module_id: 'b2b_portal', settings: null });
        }
        if (name === 'organizations') {
          return table({
            name: 'Example Supplier',
            logo_url: null,
            plan: null,
            access_tier: 'business',
          });
        }
        return table(null);
      },
    };
  },
}));

import {
  FIXTURE_USER_ID,
  fakeAuthServer,
  makeSigningKey,
  refreshGrant,
  sessionClaims,
  sessionCookies,
  signAccessToken,
  withEditedPayload,
  type FakeAuthServer,
  type SigningKey,
} from '@/test/auth-session-fixture';

import { PORTAL_CODE_PAGE, resolvePortalContext } from './portal';

/** Any other account, with its own authenticator. */
const OTHER = '33333333-3333-4333-8333-333333333333';
const OTHER_REFRESH = 'other-account-refresh';
const OWN_REFRESH = 'own-refresh';
/** GoTrue's /user round trip: the clock moves on while it is answered. */
const USER_ROUND_TRIP_MS = 300;
/** Not within auth-js's 90 s refresh margin at the identity read, within it 300 ms later. */
const CROSSES_DURING_USER = 90_000 + 150;

let projectKey: SigningKey;
let server: FakeAuthServer;
let authCalls: string[];

beforeAll(async () => {
  projectKey = await makeSigningKey('project-kid-1');
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-12T03:00:00.000Z'));
  refs.adminMade = 0;
  refs.adminTables = [];
  refs.status = 'active';
  authCalls = [];
  jar = new Map();
  server = fakeAuthServer(projectKey);
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const path = url.pathname.replace('/auth/v1', '');
    authCalls.push(path);
    const answer = await server.fetch(input, init);
    if (path === '/user') vi.setSystemTime(Date.now() + USER_ROUND_TRIP_MS);
    return answer;
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The account's own session at `aal`; the cookie carries `stored`'s refresh token and `expires_at`. */
async function signIn(
  aal: 'aal1' | 'aal2',
  stored: { refreshToken?: string; expiresInMs?: number } = {},
) {
  const claims = sessionClaims({ aal, ...(aal === 'aal2' ? { totpAgeSeconds: 60 } : {}) });
  jar = sessionCookies(await signAccessToken(projectKey, claims), claims, {
    ...(stored.refreshToken ? { refreshToken: stored.refreshToken } : {}),
    ...(stored.expiresInMs ? { expiresAt: (Date.now() + stored.expiresInMs) / 1000 } : {}),
  });
}

/** The redirect a call ends in, or null when it resolves. */
async function redirectOf(call: () => Promise<unknown>): Promise<string | null> {
  try {
    await call();
    return null;
  } catch (e) {
    const m = /^REDIRECT:(.*)$/.exec(e instanceof Error ? e.message : '');
    if (!m) throw e;
    return m[1]!;
  }
}

describe('the customer portal asks for the authenticator code before it resolves a customer', () => {
  it('the code page it names returns to the portal', () => {
    expect(PORTAL_CODE_PAGE).toBe('/signin/mfa?redirect=%2Fportal');
  });

  it('with an authenticator, at aal1: sent to the code page, and the service-role client is never made', async () => {
    await signIn('aal1');
    expect(await redirectOf(resolvePortalContext)).toBe(PORTAL_CODE_PAGE);
    expect(refs.adminMade).toBe(0);
    expect(refs.adminTables).toEqual([]);
  });

  it('with an authenticator, at aal2: a portal customer, on one Auth call', async () => {
    await signIn('aal2');
    await expect(resolvePortalContext()).resolves.toMatchObject({
      userId: FIXTURE_USER_ID,
      customerId: CUSTOMER,
      organizationId: ORG,
    });
    expect(server.calls['/user']).toBe(1);
    expect(authCalls).not.toContain('/token');
  });

  it('a token edited to claim aal2 names nobody: the sign-in prompt', async () => {
    const real = await signAccessToken(projectKey, sessionClaims({ aal: 'aal1' }));
    const forged = sessionClaims({ aal: 'aal2', totpAgeSeconds: 10 });
    jar = sessionCookies(withEditedPayload(real, forged), forged);
    // The Auth server refuses the edited token, so nobody is signed in: the
    // sign-in prompt, and nothing is read.
    await expect(resolvePortalContext()).resolves.toBeNull();
    expect(refs.adminMade).toBe(0);
  });

  it('with no authenticator, at aal1: a portal customer as before, and no level is read', async () => {
    server.unenrolledUsers.add(FIXTURE_USER_ID);
    await signIn('aal1');
    await expect(resolvePortalContext()).resolves.toMatchObject({ customerId: CUSTOMER });
    // The identity read is the only Auth call: its answer lists the factors.
    expect(authCalls).toEqual(['/user']);
  });

  it('signed out: not a portal user, and no redirect', async () => {
    await expect(resolvePortalContext()).resolves.toBeNull();
    expect(refs.adminMade).toBe(0);
  });

  it('a disabled account is not a portal user, whatever its session level', async () => {
    refs.status = 'disabled';
    await signIn('aal1');
    await expect(resolvePortalContext()).resolves.toBeNull();
    await signIn('aal2');
    await expect(resolvePortalContext()).resolves.toBeNull();
    expect(refs.adminMade).toBe(0);
  });
});

describe("the portal reads the level of the validated account's own session", () => {
  /** GoTrue knows the other account's own aal2 session under OTHER_REFRESH. */
  async function otherAccountSession() {
    const claims = sessionClaims({
      aal: 'aal2',
      sub: OTHER,
      sessionId: '44444444-4444-4444-8444-444444444444',
      email: 'other@example.test',
      totpAgeSeconds: 30,
    });
    server.refreshGrants.set(
      OTHER_REFRESH,
      refreshGrant(await signAccessToken(projectKey, claims), claims, 'other-account-refresh-2'),
    );
  }

  it('control: the password alone (aal1) goes to the code page, and no refresh happens', async () => {
    await signIn('aal1', { refreshToken: OTHER_REFRESH, expiresInMs: 3_600_000 });
    await otherAccountSession();
    expect(await redirectOf(resolvePortalContext)).toBe(PORTAL_CODE_PAGE);
    expect(authCalls).not.toContain('/token');
  });

  it("goes to the code page when the session refreshes into another account's aal2 after the identity read", async () => {
    await signIn('aal1', { refreshToken: OTHER_REFRESH, expiresInMs: CROSSES_DURING_USER });
    await otherAccountSession();
    const to = await redirectOf(resolvePortalContext);
    // The swap did happen: GoTrue was asked for the other account's session.
    expect(authCalls).toEqual(expect.arrayContaining(['/user', '/token']));
    expect(to).toBe(PORTAL_CODE_PAGE);
    expect(refs.adminMade).toBe(0);
  });

  it("control: the account's own aal2 session refreshing mid-read is still a portal customer", async () => {
    await signIn('aal2', { refreshToken: OWN_REFRESH, expiresInMs: CROSSES_DURING_USER });
    const renewed = sessionClaims({ aal: 'aal2', totpAgeSeconds: 61 });
    server.refreshGrants.set(
      OWN_REFRESH,
      refreshGrant(await signAccessToken(projectKey, renewed), renewed, 'own-refresh-2'),
    );
    await expect(resolvePortalContext()).resolves.toMatchObject({
      userId: FIXTURE_USER_ID,
      customerId: CUSTOMER,
    });
    expect(authCalls).toContain('/token');
  });
});

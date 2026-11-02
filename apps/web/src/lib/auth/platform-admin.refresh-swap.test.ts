import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Security invariant (S43a review round 1): the platform console's gates take
 * the AAL2 and fresh step-up claims from the session of the SAME account whose
 * verified email is on the allowlist.
 *
 * The gates read the verified email (getUser() on one client) and then the
 * verified claims (readVerifiedSessionClaims on a new client), two loads of the
 * cookie session. A load refreshes the session, with the cookie's own refresh
 * token, whenever the cookie's own `expires_at` says it is within 90 s of
 * expiry, and nothing signs either field. So the platform admin's password
 * alone (an aal1 token), beside the refresh token of ANY account with its own
 * authenticator (sign-up is open), timed to refresh after the email read,
 * passed the fresh step-up: the claims were the other account's, and nothing
 * compared their subject with the admin's id.
 *
 * The REAL @supabase/ssr server client and auth-js against the fixture's Auth
 * server (src/test/auth-session-fixture.ts); requireSession is stubbed exactly
 * as platform-admin.gates.test.ts stubs it.
 */

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
      STOCKPILOT_PLATFORM_ADMIN_EMAILS: f.FIXTURE_EMAIL,
    },
  };
});
vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('NOT_FOUND');
  }),
}));
vi.mock('./session', () => ({
  requireSession: vi.fn(async () => ({
    userId: '11111111-1111-4111-8111-111111111111',
    email: 'member@example.com',
    fullName: null,
    avatarUrl: null,
    defaultOrganizationId: null,
  })),
}));

import {
  FIXTURE_USER_ID,
  fakeAuthServer,
  makeSigningKey,
  refreshGrant,
  sessionClaims,
  sessionCookies,
  signAccessToken,
  type FakeAuthServer,
  type SigningKey,
} from '@/test/auth-session-fixture';

import { checkPlatformAdmin, requirePlatformAdmin } from './platform-admin';

/** Any account the caller owns, with its own authenticator. */
const OTHER = '33333333-3333-4333-8333-333333333333';
const OTHER_REFRESH = 'other-account-refresh';
const ADMIN_REFRESH = 'admin-own-refresh';
/** GoTrue's /user round trip: the clock moves on while it is answered. */
const USER_ROUND_TRIP_MS = 300;
/** Not within auth-js's 90 s refresh margin at the email read, within it 300 ms later. */
const CROSSES_DURING_USER = 90_000 + 150;

let projectKey: SigningKey;
let server: FakeAuthServer;
let authCalls: string[];

beforeAll(async () => {
  projectKey = await makeSigningKey('project-kid-1');
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-02T03:00:00.000Z'));
  authCalls = [];
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

/** The platform admin's own session at `aal`; the cookie carries `refreshToken` and `expires_at`. */
async function adminCookie(aal: 'aal1' | 'aal2', refreshToken: string, expiresInMs: number) {
  const claims = sessionClaims({ aal, ...(aal === 'aal2' ? { totpAgeSeconds: 60 } : {}) });
  jar = sessionCookies(await signAccessToken(projectKey, claims), claims, {
    refreshToken,
    expiresAt: (Date.now() + expiresInMs) / 1000,
  });
}

/** GoTrue knows the other account's own aal2 session, a step-up 30 s old, under OTHER_REFRESH. */
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

describe("the console's gates read the claims of the allowlisted account's own session", () => {
  it("control: the admin's password alone (aal1) is refused", async () => {
    await adminCookie('aal1', OTHER_REFRESH, 3_600_000);
    await otherAccountSession();
    await expect(checkPlatformAdmin({ requireStepUp: true })).resolves.toEqual({
      ok: false,
      reason: 'aal2_required',
    });
    await expect(requirePlatformAdmin()).rejects.toThrow('NOT_FOUND');
    expect(authCalls).not.toContain('/token');
  });

  it("a dangerous action is refused when the session refreshes into another account's aal2 after the email read", async () => {
    await adminCookie('aal1', OTHER_REFRESH, CROSSES_DURING_USER);
    await otherAccountSession();
    const check = await checkPlatformAdmin({ requireStepUp: true });
    // The swap did happen: GoTrue was asked for the other account's session.
    expect(authCalls).toEqual(expect.arrayContaining(['/user', '/token']));
    expect(check).toEqual({ ok: false, reason: 'aal2_required' });
  });

  it('a console page is a 404 the same way', async () => {
    await adminCookie('aal1', OTHER_REFRESH, CROSSES_DURING_USER);
    await otherAccountSession();
    await expect(requirePlatformAdmin()).rejects.toThrow('NOT_FOUND');
    expect(authCalls).toContain('/token');
  });

  it("control: the admin's own aal2 session refreshing mid-gate still passes", async () => {
    await adminCookie('aal2', ADMIN_REFRESH, CROSSES_DURING_USER);
    const renewed = sessionClaims({ aal: 'aal2', totpAgeSeconds: 61 });
    server.refreshGrants.set(
      ADMIN_REFRESH,
      refreshGrant(await signAccessToken(projectKey, renewed), renewed, 'admin-own-refresh-2'),
    );
    await expect(checkPlatformAdmin({ requireStepUp: true })).resolves.toMatchObject({
      ok: true,
      session: { userId: FIXTURE_USER_ID },
    });
    expect(authCalls).toContain('/token');
  });
});

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Security invariant (docket S43a, review round 1): on the cookie path the
 * session's assurance level is the level of the account getUser() validated,
 * never another account's.
 *
 * Every read of the cookie session LOADS it again, and a load refreshes it,
 * with the cookie's own refresh token, whenever the cookie's own `expires_at`
 * says it is within 90 s of expiry (auth-js __loadSession). Nothing signs
 * either field. So a cookie can carry an enrolled member's aal1 access token
 * (the password alone gives it) and the refresh token of ANOTHER account's
 * aal2 session, with `expires_at` set to cross the margin while GoTrue answers
 * /user. getUser() then validates the member, and the next load swaps in the
 * other session. The level used to come from that next load
 * (getAuthenticatorAssuranceLevel), so the step-up refusal passed and the
 * context was labelled satisfied.
 *
 * The REAL @supabase/ssr server client and auth-js run here against the
 * fixture's Auth server (src/test/auth-session-fixture.ts: ES256 keys, /user
 * checks the signature, a refresh grant for a session GoTrue knows), and a
 * PostgREST that answers as the token's subject under the repo's select
 * policies (0003_rls.sql: organization_members_select,
 * user_profiles_select_orgmates).
 */

let jar = new Map<string, string>();
vi.mock('next/headers', async () => {
  const { cookieStoreOver } = await import('@/test/auth-session-fixture');
  return { cookies: async () => cookieStoreOver(jar) };
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
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));

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
import { createClient } from '@/lib/supabase/server';

import { cookieSessionOwesStepUp, withApiContext } from './api-context';

/** The member whose password the caller has. */
const MEMBER = FIXTURE_USER_ID;
/** An account of the caller's own, with its own authenticator, in the same organization. */
const OTHER = '33333333-3333-4333-8333-333333333333';
const OTHER_SESSION = '44444444-4444-4444-8444-444444444444';
const ORG = 'aaaaaaaa-1111-4111-8111-111111111111';
const OTHER_REFRESH = 'other-account-refresh';
const MEMBER_REFRESH = 'member-own-refresh';

/** GoTrue's /user round trip: the clock moves on while it is answered. */
const USER_ROUND_TRIP_MS = 300;
/** Not within auth-js's 90 s refresh margin when getUser() loads, within it 300 ms later. */
const CROSSES_DURING_USER = 90_000 + 150;

const world = {
  memberRole: 'admin' as 'admin' | 'staff',
  policy: 'optional' as 'optional' | 'admins_required',
};

let projectKey: SigningKey;
let server: FakeAuthServer;
let authCalls: string[];
let restSubjects: string[];

beforeAll(async () => {
  projectKey = await makeSigningKey('project-kid-1');
});

function subOf(jwt: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8'));
    return typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}

/** PostgREST as the token's subject, with the select policies that matter here. */
function rest(url: URL, subject: string | null): Response {
  const members = [
    { user_id: MEMBER, organization_id: ORG, role: world.memberRole },
    { user_id: OTHER, organization_id: ORG, role: 'staff' },
  ];
  const profiles = [
    { id: MEMBER, default_organization_id: ORG, disabled_at: null },
    { id: OTHER, default_organization_id: ORG, disabled_at: null },
  ];
  const myOrgs = new Set(
    members.filter((m) => m.user_id === subject).map((m) => m.organization_id),
  );
  const name = url.pathname.replace('/rest/v1/', '');
  if (name === 'rpc/get_request_context') {
    // The function answers for auth.uid() (0355), never for anyone else.
    return Response.json({ user_id: subject, profile: null, memberships: [] });
  }
  let rows: Array<Record<string, unknown>> = [];
  if (name === 'organization_members') {
    rows = members.filter((m) => myOrgs.has(m.organization_id));
  } else if (name === 'user_profiles') {
    rows = profiles.filter(
      (p) =>
        p.id === subject ||
        members.some((m) => m.user_id === p.id && myOrgs.has(m.organization_id)),
    );
  } else if (name === 'organizations') {
    rows = myOrgs.has(ORG) ? [{ id: ORG, mfa_policy: world.policy, all_modules_comp: false }] : [];
  }
  for (const [key, value] of url.searchParams) {
    if (value.startsWith('eq.')) rows = rows.filter((r) => String(r[key]) === value.slice(3));
  }
  return Response.json(rows);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-02T03:00:00.000Z'));
  world.memberRole = 'admin';
  world.policy = 'optional';
  authCalls = [];
  restSubjects = [];
  server = fakeAuthServer(projectKey);
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    if (url.pathname.startsWith('/rest/v1/')) {
      const bearer =
        new Headers(init?.headers).get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
      const subject = subOf(bearer);
      restSubjects.push(subject ?? '(none)');
      return rest(url, subject);
    }
    const path = url.pathname.replace('/auth/v1', '');
    authCalls.push(path);
    const answer = await server.fetch(input, init);
    if (path === '/user') vi.setSystemTime(Date.now() + USER_ROUND_TRIP_MS);
    return answer;
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * The member's own session, signed by the project key, at `aal`; its cookie
 * carries `refreshToken` and an `expires_at` `expiresInMs` from now.
 */
async function memberCookie(aal: 'aal1' | 'aal2', refreshToken: string, expiresInMs: number) {
  const claims = sessionClaims({ aal, ...(aal === 'aal2' ? { totpAgeSeconds: 60 } : {}) });
  jar = sessionCookies(await signAccessToken(projectKey, claims), claims, {
    refreshToken,
    expiresAt: (Date.now() + expiresInMs) / 1000,
  });
}

/** GoTrue knows the other account's own aal2 session under OTHER_REFRESH. */
async function otherAccountSession() {
  const claims = sessionClaims({
    aal: 'aal2',
    sub: OTHER,
    sessionId: OTHER_SESSION,
    email: 'other@example.test',
    totpAgeSeconds: 30,
  });
  server.refreshGrants.set(
    OTHER_REFRESH,
    refreshGrant(await signAccessToken(projectKey, claims), claims, 'other-account-refresh-2'),
  );
}

function apiRequest(): Request {
  const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
  return new Request('https://app.example.test/api/v1/mobile/snapshot', { headers: { cookie } });
}

describe('the cookie step-up check reads the validated account, not a refreshed one', () => {
  it("control: an enrolled member's password alone (aal1) is owed the code", async () => {
    await memberCookie('aal1', OTHER_REFRESH, 3_600_000);
    await otherAccountSession();
    const supabase = await createClient();
    const { data } = await supabase.auth.getUser();
    expect(data.user?.id).toBe(MEMBER);
    expect(await cookieSessionOwesStepUp(supabase, data.user!)).toBe(true);
    expect(authCalls).not.toContain('/token');
  });

  it("still owed when the session refreshes into another account's aal2 session after getUser", async () => {
    await memberCookie('aal1', OTHER_REFRESH, CROSSES_DURING_USER);
    await otherAccountSession();
    const supabase = await createClient();
    const { data } = await supabase.auth.getUser();
    // GoTrue validated the MEMBER's aal1 token...
    expect(data.user?.id).toBe(MEMBER);
    // ...and the next load does refresh into the other account's session.
    expect(await cookieSessionOwesStepUp(supabase, data.user!)).toBe(true);
    expect(authCalls.filter((p) => p === '/token')).toHaveLength(1);
  });

  it('withApiContext refuses it: null, one info line, and no table read', async () => {
    await memberCookie('aal1', OTHER_REFRESH, CROSSES_DURING_USER);
    await otherAccountSession();
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    expect(await withApiContext(apiRequest())).toBeNull();
    expect(authCalls).toContain('/token');
    expect(restSubjects).toEqual([]);
    expect(info).toHaveBeenCalledTimes(1);
  });

  it('on the AAL1 allowlist, the context it hands back is labelled unsatisfied', async () => {
    await memberCookie('aal1', OTHER_REFRESH, CROSSES_DURING_USER);
    await otherAccountSession();
    const ctx = await withApiContext(apiRequest(), { allowStepUpPending: true });
    expect(ctx?.userId).toBe(MEMBER);
    expect(ctx?.mfaRequired).toBe(true);
    expect(ctx?.mfaSatisfied).toBe(false);
  });

  it("an admin with no authenticator under admins_required: another account's aal2 cannot satisfy the policy", async () => {
    world.policy = 'admins_required';
    server.unenrolledUsers.add(MEMBER);
    await memberCookie('aal1', OTHER_REFRESH, CROSSES_DURING_USER);
    await otherAccountSession();
    const ctx = await withApiContext(apiRequest());
    expect(authCalls).toContain('/token');
    expect(ctx?.userId).toBe(MEMBER);
    expect(ctx?.role).toBe('admin');
    expect(ctx?.mfaRequired).toBe(true);
    expect(ctx?.mfaSatisfied).toBe(false);
  });

  it("control: the member's own aal2 session refreshing mid-request is served, labelled satisfied", async () => {
    await memberCookie('aal2', MEMBER_REFRESH, CROSSES_DURING_USER);
    const renewed = sessionClaims({ aal: 'aal2', totpAgeSeconds: 61 });
    server.refreshGrants.set(
      MEMBER_REFRESH,
      refreshGrant(await signAccessToken(projectKey, renewed), renewed, 'member-own-refresh-2'),
    );
    const ctx = await withApiContext(apiRequest());
    expect(authCalls).toContain('/token');
    expect(ctx?.userId).toBe(MEMBER);
    expect(ctx?.mfaRequired).toBe(true);
    expect(ctx?.mfaSatisfied).toBe(true);
    expect(new Set(restSubjects)).toEqual(new Set([MEMBER]));
  });
});

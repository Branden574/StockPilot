// @vitest-environment node
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Security invariant (docket S43a): the dashboard layout's gate for an
 * enrolled member passes only on an aal2 session of THAT member, whatever
 * order the render's reads of the cookie session run in.
 *
 * Every read of the cookie session LOADS it, and a load refreshes it with the
 * cookie's own refresh token whenever the cookie's own `expires_at` is within
 * 90 s (auth-js __loadSession). Nothing signs either field, so a cookie can
 * carry an enrolled member's aal1 access token (the password alone gives it)
 * beside the refresh token of ANOTHER enrolled account's aal2 session.
 *
 * The S43a build said this gate was already protected by ordering: the layout
 * starts its claims read before requireOrgContext()'s identity read, so a load
 * that swaps accounts for the claims swaps them for the identity too, and
 * get_request_context() then refutes the proxy's header. Tested here with the
 * REAL @supabase/ssr server client, auth-js, requireOrgContext() and
 * resolveRequestContext(), against the fixture's Auth server (ES256 keys,
 * /user checks the signature, a refresh grant for a session GoTrue knows) and
 * a PostgREST that answers get_request_context() as the token's subject. Each
 * round trip moves the clock on, so a cookie can cross the margin between two
 * reads.
 *
 * - The claim holds for the order the layout gives its reads: crossing the
 *   margin before the render refreshes both reads (the identity is refuted:
 *   sign-in), and crossing it later leaves both on the member's aal1 token
 *   (the MFA challenge).
 * - It is a property of that order, not of the gate. The claims read is one
 *   request-cached read shared by the render (withContext() and the Security
 *   page take it too). Started after the context's round trip, as any reader
 *   that started it first would, it verified the other account's aal2 token,
 *   and the gate let the member through on it until it compared the claims'
 *   subject with the context's user.
 * - The gate's other input, the factor list, is a read of the same kind
 *   (review round s43ar). Started after the context's round trip, it listed
 *   the factors of an account with NO authenticator, so the enrolled member
 *   read as "no authenticator" and the gate was skipped at aal1, until the
 *   layout took the list only as the context user's own. The last block runs
 *   the REAL factor list; the blocks before it stub the member's own.
 */

const hoisted = vi.hoisted(() => ({
  realClaimsRead: null as null | (() => Promise<unknown>),
  realFactorsRead: null as null | (() => Promise<unknown>),
}));

let jar = new Map<string, string>();
vi.mock('next/headers', async () => {
  const f = await import('@/test/auth-session-fixture');
  return {
    // A Server Component's cookie store: Next refuses writes outside a Server
    // Action or Route Handler, and lib/supabase/server.ts swallows the refusal.
    // So a client that refreshes keeps the new session to itself, as in a
    // real render; a writable store would let one client's refresh cancel
    // another's (auth-js discards a refresh when the stored session changed
    // while it was in flight).
    cookies: async () => ({
      ...f.cookieStoreOver(jar),
      set: () => {
        throw new Error('Cookies can only be modified in a Server Action or Route Handler.');
      },
    }),
    // What the proxy forwarded once it had validated the cookie: the member.
    headers: async () =>
      new Headers({
        'x-pathname': '/dashboard/purchase-orders',
        'x-stockpilot-user-id': f.FIXTURE_USER_ID,
        'x-stockpilot-user-email': f.FIXTURE_EMAIL,
      }),
  };
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
vi.mock('next/navigation', () => ({
  redirect: vi.fn((to: string) => {
    throw new Error(`REDIRECT:${to}`);
  }),
}));
vi.mock('@/components/dashboard/dashboard-shell', () => ({ DashboardShell: () => null }));
vi.mock('@/components/dashboard/mfa-required-banner', () => ({ MfaRequiredBanner: () => null }));
vi.mock('@/components/dashboard/sidebar-pref', () => ({
  SIDEBAR_HIDDEN_COOKIE: 'sidebar-hidden',
  parseSidebarHidden: () => false,
  DENSITY_COOKIE: 'density',
  parseDensity: () => 'comfortable',
  NAV_COLLAPSED_COOKIE: 'nav-collapsed',
  parseCollapsedSections: () => null,
}));
vi.mock('@/components/platform/impersonation-banner', () => ({ ImpersonationBanner: () => null }));
vi.mock('@/components/realtime/inventory-realtime', () => ({ InventoryRealtime: () => null }));
vi.mock('@/components/activity-beacon', () => ({ ActivityBeacon: () => null }));
vi.mock('@/lib/auth/platform-admin', () => ({
  currentUserIsPlatformAdminFromRequestHeader: vi.fn(async () => false),
}));
// requireOrgContext() is REAL. Only getSessionMemberships() is stubbed: in a
// real render it shares requireOrgContext()'s load through cache(), which does
// not memoize outside a render, so here it would load the session a second time.
vi.mock('@/lib/auth/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/session')>()),
  getSessionMemberships: vi.fn(async () => []),
}));
// An enrolled member: the gate applies under the 'optional' policy. The claims
// cases stub the member's own list; the factor list cases read the REAL one.
vi.mock('@/lib/dashboard/request-cache', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/dashboard/request-cache')>();
  const f = await import('@/test/auth-session-fixture');
  hoisted.realFactorsRead = real.getMfaFactorsForRequest;
  return {
    getMfaFactorsForRequest: vi.fn(async () => ({
      userId: f.FIXTURE_USER_ID,
      factors: [{ status: 'verified' }],
    })),
    getModulesForRequest: vi.fn(async () => new Set()),
    getOrgRowForRequest: vi.fn(async () => ({
      terminology: null,
      mfa_policy: 'optional',
      logo_url: null,
      timezone: null,
      nav_overrides: null,
      dashboard_layout: null,
      order_status_config: null,
    })),
    getWarehousesForRequest: vi.fn(async () => []),
  };
});
vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: vi.fn(async () => ({
    readableIds: [],
    writableIds: [],
    hasAllAccess: false,
    primaryWarehouseId: null,
  })),
}));
vi.mock('@/lib/warehouse-filter', () => ({ getActiveWarehouseFilter: vi.fn(async () => null) }));
// The claims read is REAL; one case starts it later, as another reader would.
vi.mock('@/lib/auth/verified-claims', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/auth/verified-claims')>();
  hoisted.realClaimsRead = real.getVerifiedSessionClaimsForRequest;
  return {
    ...real,
    getVerifiedSessionClaimsForRequest: vi.fn(real.getVerifiedSessionClaimsForRequest),
  };
});

import {
  FIXTURE_EMAIL,
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
import { getVerifiedSessionClaimsForRequest } from '@/lib/auth/verified-claims';
import { getMfaFactorsForRequest } from '@/lib/dashboard/request-cache';

import DashboardLayout from './layout';

/** The member whose password the caller has; the proxy validated their token. */
const MEMBER = FIXTURE_USER_ID;
/** An account of the caller's own, with its own authenticator, in the same organization. */
const OTHER = '33333333-3333-4333-8333-333333333333';
const OTHER_SESSION = '44444444-4444-4444-8444-444444444444';
const ORG = 'aaaaaaaa-1111-4111-8111-111111111111';
const OTHER_REFRESH = 'other-account-refresh';
const MEMBER_REFRESH = 'member-own-refresh';
/** An account of the caller's own with NO authenticator. */
const NO_FACTOR = '55555555-5555-4555-8555-555555555555';
const NO_FACTOR_SESSION = '66666666-6666-4666-8666-666666666666';
const NO_FACTOR_REFRESH = 'no-factor-account-refresh';

/** Every round trip, to the Auth server or PostgREST: the clock moves on while it is answered. */
const ROUND_TRIP_MS = 300;
/** Already inside auth-js's 90 s refresh margin when the render starts. */
const CROSSED_BEFORE_RENDER = 30_000;
/** Outside the margin when the render's first reads load, inside it once the first round trip is answered. */
const CROSSES_DURING_FIRST_ROUND_TRIP = 90_000 + 150;

const TO_CHALLENGE = 'REDIRECT:/signin/mfa?redirect=%2Fdashboard%2Fpurchase-orders';

let projectKey: SigningKey;
let server: FakeAuthServer;
let authCalls: string[];
/** Who each Auth request was made as, in order (`/user as <sub>`). */
let authAs: string[];
let restSubjects: string[];
let onContextAnswered: (() => void) | null;

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

/** get_request_context() as PostgREST runs it: for auth.uid(), the token's subject, and no one else. */
function rest(url: URL, subject: string | null): Response {
  const name = url.pathname.replace('/rest/v1/', '');
  if (name !== 'rpc/get_request_context') {
    return Response.json({ message: `no fake for ${name}` }, { status: 404 });
  }
  if (!subject) return Response.json({ user_id: null, profile: null, memberships: [] });
  return Response.json({
    user_id: subject,
    profile: {
      id: subject,
      email: subject === MEMBER ? FIXTURE_EMAIL : 'other@example.test',
      full_name: null,
      avatar_url: null,
      default_organization_id: ORG,
      disabled_at: null,
    },
    memberships: [
      {
        organization_id: ORG,
        role: subject === MEMBER ? 'admin' : 'staff',
        organization: {
          id: ORG,
          name: 'Example Org',
          logo_url: null,
          terminology: null,
          mfa_policy: 'optional',
          timezone: null,
          nav_overrides: null,
          dashboard_layout: null,
          order_status_config: null,
          all_modules_comp: false,
        },
        role_overrides: [],
        user_overrides: [],
        enabled_modules: [],
      },
    ],
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-02T03:00:00.000Z'));
  authCalls = [];
  authAs = [];
  restSubjects = [];
  onContextAnswered = null;
  server = fakeAuthServer(projectKey);
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    let answer: Response;
    if (url.pathname.startsWith('/rest/v1/')) {
      const bearer =
        new Headers(init?.headers).get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
      const subject = subOf(bearer);
      restSubjects.push(subject ?? '(none)');
      answer = rest(url, subject);
    } else {
      const path = url.pathname.replace('/auth/v1', '');
      const bearer =
        new Headers(init?.headers).get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
      authCalls.push(path);
      authAs.push(`${path} as ${subOf(bearer) ?? '-'}`);
      answer = await server.fetch(input, init);
    }
    // A network answer arrives in a later turn of the event loop, after every
    // read the render started in this one has loaded the session. Answered in
    // the same turn, the key-set fetch (paid by whichever test runs first)
    // would move the clock between two of the render's loads.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    vi.setSystemTime(Date.now() + ROUND_TRIP_MS);
    if (url.pathname === '/rest/v1/rpc/get_request_context') onContextAnswered?.();
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
 * carries `refreshToken` and an `expires_at` that reaches auth-js's 90 s
 * margin `crossesInMs` after the render starts (negative: before it).
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

/** GoTrue renews the member's own aal2 session under MEMBER_REFRESH. */
async function memberOwnRefresh() {
  const renewed = sessionClaims({ aal: 'aal2', totpAgeSeconds: 61 });
  server.refreshGrants.set(
    MEMBER_REFRESH,
    refreshGrant(await signAccessToken(projectKey, renewed), renewed, 'member-own-refresh-2'),
  );
}

/**
 * The shared claims read, started only once get_request_context() has
 * answered: the order a reader of the render other than the layout gives it
 * when it starts the read first (withContext() reads the claims after the
 * context resolves).
 */
function startClaimsReadAfterTheContext() {
  vi.mocked(getVerifiedSessionClaimsForRequest).mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      onContextAnswered = resolve;
    });
    return (await hoisted.realClaimsRead!()) as Awaited<
      ReturnType<typeof getVerifiedSessionClaimsForRequest>
    >;
  });
}

describe('the layout gate with the real session reads: the order the layout gives them', () => {
  it('crossing the margin before the render: both reads take the other account, and the identity is refuted (sign-in)', async () => {
    await memberCookie('aal1', OTHER_REFRESH, CROSSED_BEFORE_RENDER);
    await otherAccountSession();
    await expect(DashboardLayout({ children: null })).rejects.toThrow(/^REDIRECT:\/signin$/);
    // The render's clients refreshed into the other account (each server client
    // loads the session once when it is made, for the INITIAL_SESSION event
    // @supabase/ssr listens for, and refreshes it then if the cookie says so)...
    expect(authCalls).toContain('/token');
    // ...and get_request_context() answered for it, not for the proxy's member.
    expect(restSubjects).toEqual([OTHER]);
  });

  it("crossing it during the render's first round trip: both reads keep the member's aal1 token (the MFA challenge)", async () => {
    await memberCookie('aal1', OTHER_REFRESH, CROSSES_DURING_FIRST_ROUND_TRIP);
    await otherAccountSession();
    await expect(DashboardLayout({ children: null })).rejects.toThrow(TO_CHALLENGE);
    expect(authCalls).not.toContain('/token');
    expect(restSubjects).toEqual([MEMBER]);
  });

  it("control: the member's own aal2 session refreshing before the render renders the dashboard", async () => {
    await memberCookie('aal2', MEMBER_REFRESH, CROSSED_BEFORE_RENDER);
    await memberOwnRefresh();
    await expect(DashboardLayout({ children: null })).resolves.toBeTruthy();
    expect(authCalls).toContain('/token');
    expect(restSubjects).toEqual([MEMBER]);
  });
});

describe('the layout gate with the real session reads: the shared claims read started after the context', () => {
  it("a cookie that swaps accounts between the context and the claims read sends the member to the MFA challenge, not in on the other account's aal2", async () => {
    startClaimsReadAfterTheContext();
    await memberCookie('aal1', OTHER_REFRESH, CROSSES_DURING_FIRST_ROUND_TRIP);
    await otherAccountSession();
    await expect(DashboardLayout({ children: null })).rejects.toThrow(TO_CHALLENGE);
    // The context is the member's (the proxy's header, confirmed)...
    expect(restSubjects).toEqual([MEMBER]);
    // ...and the claims read did refresh into the other account's aal2 session.
    expect(authCalls.filter((p) => p === '/token')).toHaveLength(1);
  });

  it("control: the member's own aal2 session refreshing between the context and the claims read renders the dashboard", async () => {
    startClaimsReadAfterTheContext();
    await memberCookie('aal2', MEMBER_REFRESH, CROSSES_DURING_FIRST_ROUND_TRIP);
    await memberOwnRefresh();
    await expect(DashboardLayout({ children: null })).resolves.toBeTruthy();
    expect(restSubjects).toEqual([MEMBER]);
    expect(authCalls.filter((p) => p === '/token')).toHaveLength(1);
  });
});

/** GoTrue knows the no-factor account's own session (aal1) under NO_FACTOR_REFRESH. */
async function noFactorAccountSession() {
  const claims = sessionClaims({
    aal: 'aal1',
    sub: NO_FACTOR,
    sessionId: NO_FACTOR_SESSION,
    email: 'nofactor@example.test',
  });
  server.unenrolledUsers.add(NO_FACTOR);
  server.refreshGrants.set(
    NO_FACTOR_REFRESH,
    refreshGrant(await signAccessToken(projectKey, claims), claims, 'no-factor-refresh-2', false),
  );
}

/** GoTrue renews the member's own aal1 session under MEMBER_REFRESH. */
async function memberOwnAal1Refresh() {
  const renewed = sessionClaims({ aal: 'aal1' });
  server.refreshGrants.set(
    MEMBER_REFRESH,
    refreshGrant(await signAccessToken(projectKey, renewed), renewed, 'member-own-refresh-2'),
  );
}

/** The REAL factor list, started where the layout starts it (first thing). */
function readTheRealFactorList() {
  vi.mocked(getMfaFactorsForRequest).mockImplementationOnce(
    () => hoisted.realFactorsRead!() as ReturnType<typeof getMfaFactorsForRequest>,
  );
}

/**
 * The REAL factor list, started only once get_request_context() has answered:
 * the same late start as the claims read's case above. The list is a
 * request-cached read the page's withContext() shares too.
 */
function startFactorsReadAfterTheContext() {
  vi.mocked(getMfaFactorsForRequest).mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      onContextAnswered = resolve;
    });
    return (await hoisted.realFactorsRead!()) as Awaited<
      ReturnType<typeof getMfaFactorsForRequest>
    >;
  });
}

/**
 * The gate's OTHER input (S43a, review round s43ar). Whether the member has a
 * verified factor decides whether the gate applies at all, and the list comes
 * from a read of the cookie session like the claims. A list that refreshed
 * into an account with NO factor read as "not enrolled", and the enrolled
 * member at aal1 skipped the gate. Only the member's own list may say that.
 */
describe("the layout gate with the real session reads: the factor list is the member's own", () => {
  it("today's order (the list first): the member's aal1 token with a no-factor account's refresh token goes to the MFA challenge", async () => {
    readTheRealFactorList();
    await memberCookie('aal1', NO_FACTOR_REFRESH, CROSSES_DURING_FIRST_ROUND_TRIP);
    await noFactorAccountSession();
    await expect(DashboardLayout({ children: null })).rejects.toThrow(TO_CHALLENGE);
    expect(restSubjects).toEqual([MEMBER]);
  });

  it('the list started after the context, refreshed into a no-factor account, sends the member to the MFA challenge, not into the dashboard', async () => {
    startFactorsReadAfterTheContext();
    await memberCookie('aal1', NO_FACTOR_REFRESH, CROSSES_DURING_FIRST_ROUND_TRIP);
    await noFactorAccountSession();
    await expect(DashboardLayout({ children: null })).rejects.toThrow(TO_CHALLENGE);
    // The context is the member's (the proxy's header, confirmed)...
    expect(restSubjects).toEqual([MEMBER]);
    // ...and the list did refresh into the no-factor account.
    expect(authCalls.filter((p) => p === '/token')).toHaveLength(1);
    expect(authAs).toContain(`/user as ${NO_FACTOR}`);
  });

  it("control: the member's own aal1 session refreshing before the late list goes to the MFA challenge", async () => {
    startFactorsReadAfterTheContext();
    await memberCookie('aal1', MEMBER_REFRESH, CROSSES_DURING_FIRST_ROUND_TRIP);
    await memberOwnAal1Refresh();
    await expect(DashboardLayout({ children: null })).rejects.toThrow(TO_CHALLENGE);
    expect(authCalls.filter((p) => p === '/token')).toHaveLength(1);
  });

  it("control: the member's own aal2 session refreshing before the late list renders the dashboard", async () => {
    startFactorsReadAfterTheContext();
    await memberCookie('aal2', MEMBER_REFRESH, CROSSES_DURING_FIRST_ROUND_TRIP);
    await memberOwnRefresh();
    await expect(DashboardLayout({ children: null })).resolves.toBeTruthy();
    expect(restSubjects).toEqual([MEMBER]);
    expect(authCalls.filter((p) => p === '/token')).toHaveLength(1);
  });
});

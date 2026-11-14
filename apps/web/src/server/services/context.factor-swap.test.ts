// @vitest-environment node
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Security invariant (docket S43a, review round s43ar): withContext()'s MFA
 * gate (resolveMfaState) counts a factor list only as the list of the member
 * the context resolved, whatever order the reads of the cookie session run in.
 *
 * Every read of the cookie session LOADS it, and a load refreshes it with the
 * cookie's own refresh token whenever the cookie's own `expires_at` is within
 * 90 s (auth-js __loadSession). Nothing signs either field. A cookie carrying
 * an enrolled member's aal1 token (the password alone gives it) beside the
 * refresh token of an account with NO factor made a factor list that loaded
 * the session after the context answer for that other account: empty, so the
 * enrolled member read as "not enrolled", the gate as not required, and
 * assertPermission let them through at aal1 under the 'optional' policy.
 * withContext() starts the list before requireOrgContext(), so its loads ran
 * beside the identity read and today's order kept it out; the gate must not
 * rely on that order.
 *
 * Real: withContext, requireOrgContext (lib/auth/session),
 * getMfaFactorsForRequest, the verified claims read, @supabase/ssr and
 * auth-js, against the fixture's Auth server and a PostgREST that answers
 * get_request_context() as the token's subject. Every round trip moves the
 * clock on. One case starts the factor list once get_request_context() has
 * answered, as a later reader of the list would.
 *
 * TWO GATES NOW READ THAT LIST (docket S43c). requireOrgContext() asks first
 * whether the session still owes its authenticator code (lib/auth/
 * step-up-gate) and sends it to /signin/mfa, on the same list, held to the
 * same member. The first block below takes that gate out, so it still shows
 * what it always did: resolveMfaState does not rely on anything in front of
 * it. The second block runs the same sessions through the real gate.
 */

const state = vi.hoisted(() => ({
  realFactorsRead: null as null | (() => Promise<unknown>),
  onContextAnswered: null as null | (() => void),
  /** Who each Auth request was made as, in order (`/user as <sub>`). */
  authAs: [] as string[],
  /** Take requireOrgContext()'s own code gate out, leaving resolveMfaState alone. */
  codeGateOut: true,
}));
vi.mock('@/lib/auth/step-up-gate', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/auth/step-up-gate')>();
  return {
    ...real,
    startStepUpReads: () =>
      state.codeGateOut
        ? ({} as ReturnType<typeof real.startStepUpReads>)
        : real.startStepUpReads(),
    stepUpIsOwed: async (...args: Parameters<typeof real.stepUpIsOwed>) =>
      state.codeGateOut ? false : real.stepUpIsOwed(...args),
  };
});
vi.mock('@/lib/dashboard/request-cache', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/dashboard/request-cache')>();
  state.realFactorsRead = real.getMfaFactorsForRequest;
  return { ...real, getMfaFactorsForRequest: vi.fn(real.getMfaFactorsForRequest) };
});

let jar = new Map<string, string>();
vi.mock('next/headers', async () => {
  const f = await import('@/test/auth-session-fixture');
  return {
    // A Server Action: the cookie store accepts writes.
    cookies: async () => f.cookieStoreOver(jar),
    // What the proxy forwarded once it had validated the cookie: the member.
    headers: async () =>
      new Headers({
        'x-pathname': '/dashboard/inventory',
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
import { getMfaFactorsForRequest } from '@/lib/dashboard/request-cache';

import { assertPermission, ServiceError, withContext } from './context';

/** The enrolled member whose password the caller has. */
const MEMBER = FIXTURE_USER_ID;
/** An account of the caller's own with NO authenticator. */
const NO_FACTOR = '55555555-5555-4555-8555-555555555555';
const NO_FACTOR_SESSION = '66666666-6666-4666-8666-666666666666';
const ORG = 'aaaaaaaa-1111-4111-8111-111111111111';
const NO_FACTOR_REFRESH = 'no-factor-account-refresh';
const MEMBER_REFRESH = 'member-own-refresh';

/** Every round trip, to the Auth server or PostgREST: the clock moves on while it is answered. */
const ROUND_TRIP_MS = 300;
/** Outside the margin when the first reads load, inside it once the first round trip is answered. */
const CROSSES_DURING_FIRST_ROUND_TRIP = 150;

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
      email: subject === MEMBER ? FIXTURE_EMAIL : 'nofactor@example.test',
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
  restSubjects = [];
  state.onContextAnswered = null;
  state.authAs = [];
  state.codeGateOut = true;
  server = fakeAuthServer(projectKey);
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    let answer: Response;
    const bearer =
      new Headers(init?.headers).get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
    if (url.pathname.startsWith('/rest/v1/')) {
      restSubjects.push(subOf(bearer) ?? '(none)');
      answer = rest(url, subOf(bearer));
    } else {
      const p = url.pathname.replace('/auth/v1', '');
      authCalls.push(p);
      state.authAs.push(`${p} as ${subOf(bearer) ?? '-'}`);
      answer = await server.fetch(input, init);
    }
    // A network answer arrives in a later turn of the event loop.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    vi.setSystemTime(Date.now() + ROUND_TRIP_MS);
    if (url.pathname === '/rest/v1/rpc/get_request_context') {
      const go = state.onContextAnswered;
      state.onContextAnswered = null;
      go?.();
    }
    return answer;
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

// auth-js keeps the key set in a module-global cache for 10 minutes, as a warm
// production instance has it. Warm it once so every case runs against the same
// timeline whichever runs first.
let warmed = false;
beforeEach(async () => {
  if (warmed) return;
  warmed = true;
  const claims = sessionClaims({ aal: 'aal1' });
  jar = sessionCookies(await signAccessToken(projectKey, claims), claims, {
    expiresAt: (Date.now() + 3_600_000) / 1000,
  });
  await withContext().catch(() => undefined);
  authCalls = [];
  restSubjects = [];
  state.authAs = [];
  vi.setSystemTime(new Date('2026-11-02T03:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The member's session at `aal`; `expires_at` reaches the 90 s margin `crossesInMs` after the request starts. */
async function memberCookie(aal: 'aal1' | 'aal2', refreshToken: string, crossesInMs: number) {
  const claims = sessionClaims({ aal, ...(aal === 'aal2' ? { totpAgeSeconds: 60 } : {}) });
  jar = sessionCookies(await signAccessToken(projectKey, claims), claims, {
    refreshToken,
    expiresAt: (Date.now() + 90_000 + crossesInMs) / 1000,
  });
}

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

/** GoTrue renews the member's own session, at `aal`, under MEMBER_REFRESH. */
async function memberOwnRefresh(aal: 'aal1' | 'aal2') {
  const renewed = sessionClaims({ aal, ...(aal === 'aal2' ? { totpAgeSeconds: 61 } : {}) });
  server.refreshGrants.set(
    MEMBER_REFRESH,
    refreshGrant(await signAccessToken(projectKey, renewed), renewed, 'member-own-refresh-2'),
  );
}

/** The factor list, started only once get_request_context() has answered. */
function startFactorsReadAfterTheContext() {
  vi.mocked(getMfaFactorsForRequest).mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      state.onContextAnswered = resolve;
    });
    return (await state.realFactorsRead!()) as Awaited<ReturnType<typeof getMfaFactorsForRequest>>;
  });
}

function mfaGateRefusal(ctx: Awaited<ReturnType<typeof withContext>>): ServiceError | null {
  try {
    assertPermission(ctx, 'items:read');
    return null;
  } catch (e) {
    return e as ServiceError;
  }
}

describe('withContext: the MFA gate counts only the factor list of the member the context resolved (the code gate in front taken out)', () => {
  it("today's order (the list first): an enrolled member at aal1 with a no-factor account's refresh token is held at the gate", async () => {
    await memberCookie('aal1', NO_FACTOR_REFRESH, CROSSES_DURING_FIRST_ROUND_TRIP);
    await noFactorAccountSession();
    const ctx = await withContext();
    expect(ctx.userId).toBe(MEMBER);
    expect(ctx.mfaRequired).toBe(true);
    expect(ctx.mfaSatisfied).toBe(false);
    expect(mfaGateRefusal(ctx)?.code).toBe('forbidden');
  });

  it("the list read after the context, refreshed into a no-factor account, fails the gate closed instead of reading 'not enrolled'", async () => {
    startFactorsReadAfterTheContext();
    await memberCookie('aal1', NO_FACTOR_REFRESH, CROSSES_DURING_FIRST_ROUND_TRIP);
    await noFactorAccountSession();
    const ctx = await withContext();
    // The context is the member's (the proxy's header, confirmed)...
    expect(restSubjects).toEqual([MEMBER]);
    expect(ctx.userId).toBe(MEMBER);
    // ...and the list did refresh into the no-factor account.
    expect(authCalls).toContain('/token');
    expect(state.authAs).toContain(`/user as ${NO_FACTOR}`);
    expect(ctx.mfaRequired).toBe(true);
    expect(ctx.mfaSatisfied).toBe(false);
    const refusal = mfaGateRefusal(ctx);
    expect(refusal?.code).toBe('forbidden');
    expect(refusal?.details).toEqual({ reason: 'mfa_required' });
  });

  it("control: the member's own aal1 session refreshing before the late list still owes the code", async () => {
    startFactorsReadAfterTheContext();
    await memberCookie('aal1', MEMBER_REFRESH, CROSSES_DURING_FIRST_ROUND_TRIP);
    await memberOwnRefresh('aal1');
    const ctx = await withContext();
    expect(authCalls).toContain('/token');
    expect(ctx.mfaRequired).toBe(true);
    expect(ctx.mfaSatisfied).toBe(false);
    expect(ctx.mfaEnrolled).toBe(true);
    expect(mfaGateRefusal(ctx)?.details).toEqual({ reason: 'aal2_required' });
  });

  it("control: the member's own aal2 session refreshing before the late list satisfies the gate", async () => {
    startFactorsReadAfterTheContext();
    await memberCookie('aal2', MEMBER_REFRESH, CROSSES_DURING_FIRST_ROUND_TRIP);
    await memberOwnRefresh('aal2');
    const ctx = await withContext();
    expect(authCalls).toContain('/token');
    expect(ctx.mfaRequired).toBe(true);
    expect(ctx.mfaSatisfied).toBe(true);
    expect(ctx.mfaEnrolled).toBe(true);
    expect(mfaGateRefusal(ctx)).toBeNull();
  });
});

describe("requireOrgContext's code gate, on the same sessions: held to the member the context resolved", () => {
  beforeEach(() => {
    state.codeGateOut = false;
  });

  it("today's order (the list first): an enrolled member at aal1 with a no-factor account's refresh token is sent to the code page", async () => {
    await memberCookie('aal1', NO_FACTOR_REFRESH, CROSSES_DURING_FIRST_ROUND_TRIP);
    await noFactorAccountSession();
    await expect(withContext()).rejects.toThrow('REDIRECT:/signin/mfa');
  });

  it("the list read after the context, refreshed into a no-factor account, is no answer: the code page, never 'not enrolled'", async () => {
    startFactorsReadAfterTheContext();
    await memberCookie('aal1', NO_FACTOR_REFRESH, CROSSES_DURING_FIRST_ROUND_TRIP);
    await noFactorAccountSession();
    await expect(withContext()).rejects.toThrow('REDIRECT:/signin/mfa');
    // The context was the member's, and the list did refresh into the
    // no-factor account.
    expect(restSubjects).toEqual([MEMBER]);
    expect(authCalls).toContain('/token');
    expect(state.authAs).toContain(`/user as ${NO_FACTOR}`);
  });

  it("control: the member's own aal1 session refreshing before the late list is sent to the code page", async () => {
    startFactorsReadAfterTheContext();
    await memberCookie('aal1', MEMBER_REFRESH, CROSSES_DURING_FIRST_ROUND_TRIP);
    await memberOwnRefresh('aal1');
    await expect(withContext()).rejects.toThrow('REDIRECT:/signin/mfa');
    expect(authCalls).toContain('/token');
  });

  it("control: the member's own aal2 session refreshing before the late list gets its context, satisfied", async () => {
    startFactorsReadAfterTheContext();
    await memberCookie('aal2', MEMBER_REFRESH, CROSSES_DURING_FIRST_ROUND_TRIP);
    await memberOwnRefresh('aal2');
    const ctx = await withContext();
    expect(authCalls).toContain('/token');
    expect(ctx.userId).toBe(MEMBER);
    expect(ctx.mfaSatisfied).toBe(true);
    expect(mfaGateRefusal(ctx)).toBeNull();
  });

  it('one factor read serves both gates: the Auth server is asked for the user once', async () => {
    // At aal2 the code gate reads no list; withContext() reads its own.
    await memberCookie('aal2', MEMBER_REFRESH, 3_600_000);
    const atAal2 = await withContext();
    expect(atAal2.mfaSatisfied).toBe(true);
    expect(authCalls.filter((p) => p === '/user')).toHaveLength(1);

    // Below aal2 the code gate needs the list, and takes the read
    // withContext() already started instead of a second one.
    authCalls = [];
    server.unenrolledUsers.add(MEMBER);
    await memberCookie('aal1', MEMBER_REFRESH, 3_600_000);
    const noFactor = await withContext();
    expect(noFactor.mfaRequired).toBe(false);
    expect(authCalls.filter((p) => p === '/user')).toHaveLength(1);
  });
});

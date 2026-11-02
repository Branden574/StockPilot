// @vitest-environment node
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Security invariant (docket S43a, review round s43ar): transferOwnershipAction
 * decides whether the owner must give the authenticator code from the factor
 * list of THE OWNER the context resolved, never from the list of whatever
 * account the cookie session holds by the time that list is read.
 *
 * The list is read after withContext() and requireSession() have settled the
 * owner, and every read LOADS the cookie session again: a load refreshes it
 * with the cookie's own refresh token whenever the cookie's own `expires_at`
 * is within 90 s (auth-js __loadSession). Nothing signs either field. So a
 * cookie carrying the enrolled owner's aal1 token (the password alone gives
 * it) beside the refresh token of an account with NO factor (an insider's
 * own) made the list come back empty: the step-up was skipped, the password
 * re-confirm passed (the caller has the password), and the service-role RPC
 * moved the organization to the insider.
 *
 * Real: withContext, requireOrgContext and requireSession (lib/auth/session),
 * getMfaFactorsForRequest, assertCurrentAal2, @supabase/ssr and auth-js,
 * against the fixture's Auth server (ES256 keys, /user checks the signature,
 * a refresh grant for a session GoTrue knows) and a PostgREST that answers
 * get_request_context() as the token's subject. Every round trip moves the
 * clock on, so the cookie can cross the margin between two reads.
 */

const state = vi.hoisted(() => ({
  adminRpc: [] as Array<{ fn: string; args: unknown }>,
  /** Who each Auth request was made as, in order (`/user as <sub>`). */
  authAs: [] as string[],
}));

let jar = new Map<string, string>();
vi.mock('next/headers', async () => {
  const f = await import('@/test/auth-session-fixture');
  return {
    // A Server Action: the cookie store accepts writes.
    cookies: async () => f.cookieStoreOver(jar),
    // What the proxy forwarded once it had validated the cookie: the owner.
    headers: async () =>
      new Headers({
        'x-pathname': '/dashboard/team',
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
  notFound: vi.fn(() => {
    throw new Error('NOT_FOUND');
  }),
  // Next's own rule, reduced to the redirect this harness throws.
  unstable_rethrow: (e: unknown) => {
    if (e instanceof Error && e.message.startsWith('REDIRECT:')) throw e;
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, remaining: 4, resetAt: Date.now() + 1 })),
}));
// The premise of S43: the caller has the owner's password.
vi.mock('@/lib/auth/verify-password', () => ({
  verifyPasswordSideChannel: vi.fn(async () => ({ ok: true })),
}));
vi.mock('@/server/services/audit', () => ({ audit: vi.fn(async () => {}) }));
vi.mock('@/lib/auth/password-reset-email', () => ({ sendPasswordResetEmail: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => {
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.eq = () => chain;
    // The target: the insider's own accepted membership in the organization.
    chain.maybeSingle = async () => ({
      data: {
        id: 'bbbbbbbb-2222-4222-8222-222222222222',
        user_id: '33333333-3333-4333-8333-333333333333',
        role: 'staff',
        accepted_at: '2026-10-01T00:00:00.000Z',
      },
      error: null,
    });
    return {
      from: () => chain,
      rpc: async (fn: string, args: unknown) => {
        state.adminRpc.push({ fn, args });
        return { data: null, error: null };
      },
    };
  },
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

import { transferOwnershipAction } from './team';

/** The enrolled owner whose password the caller has. */
const OWNER = FIXTURE_USER_ID;
/** The caller's own account in the same organization: no authenticator. */
const INSIDER = '33333333-3333-4333-8333-333333333333';
const INSIDER_SESSION = '44444444-4444-4444-8444-444444444444';
const ORG = 'aaaaaaaa-1111-4111-8111-111111111111';
const TARGET_MEMBER_ID = 'bbbbbbbb-2222-4222-8222-222222222222';
const INSIDER_REFRESH = 'insider-refresh';
const OWNER_REFRESH = 'owner-own-refresh';

/** Every round trip, to the Auth server or PostgREST: the clock moves on while it is answered. */
const ROUND_TRIP_MS = 300;

const INPUT = { targetMemberId: TARGET_MEMBER_ID, password: 'the-owner-password' };

/**
 * The action's reads, in order: withContext()'s factor list (started first)
 * and its get_request_context(), then requireSession()'s get_request_context(),
 * then the action's own factor list. Crossing the margin 700 ms in falls
 * between requireSession()'s identity read and the action's own list.
 */
const CROSSES_AFTER_THE_IDENTITY_READS = 700;
/** Crosses before requireSession()'s identity read. */
const CROSSES_BEFORE_REQUIRE_SESSION = 300;
/** Never inside the margin during the action. */
const NEVER = 3_600_000;

const COULD_NOT_CHECK = {
  ok: false,
  error: {
    code: 'internal_error',
    message: 'Could not check your two-factor status. Please try again.',
  },
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
      email: subject === OWNER ? FIXTURE_EMAIL : 'insider@example.test',
      full_name: null,
      avatar_url: null,
      default_organization_id: ORG,
      disabled_at: null,
    },
    memberships: [
      {
        organization_id: ORG,
        role: subject === OWNER ? 'owner' : 'staff',
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
  state.adminRpc = [];
  state.authAs = [];
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
    return answer;
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

// auth-js keeps the key set in a module-global cache for 10 minutes, as a warm
// production instance has it. The first claims read of the run fetches it: one
// more round trip, which would move the window by 300 ms for whichever case
// runs first. Warm it once so every case runs against the same timeline.
let warmed = false;
beforeEach(async () => {
  if (warmed) return;
  warmed = true;
  const claims = sessionClaims({ aal: 'aal1' });
  jar = sessionCookies(await signAccessToken(projectKey, claims), claims, {
    expiresAt: (Date.now() + 3_600_000) / 1000,
  });
  await transferOwnershipAction(INPUT).catch(() => undefined);
  authCalls = [];
  restSubjects = [];
  state.adminRpc = [];
  state.authAs = [];
  vi.setSystemTime(new Date('2026-11-02T03:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The owner's session at `aal`; `expires_at` reaches the 90 s margin `crossesInMs` after the action starts. */
async function ownerCookie(aal: 'aal1' | 'aal2', refreshToken: string, crossesInMs: number) {
  const claims = sessionClaims({ aal, ...(aal === 'aal2' ? { totpAgeSeconds: 60 } : {}) });
  jar = sessionCookies(await signAccessToken(projectKey, claims), claims, {
    refreshToken,
    expiresAt: (Date.now() + 90_000 + crossesInMs) / 1000,
  });
}

/** GoTrue knows the insider's own session (aal1, no factor) under INSIDER_REFRESH. */
async function insiderSession() {
  const claims = sessionClaims({
    aal: 'aal1',
    sub: INSIDER,
    sessionId: INSIDER_SESSION,
    email: 'insider@example.test',
  });
  server.unenrolledUsers.add(INSIDER);
  server.refreshGrants.set(
    INSIDER_REFRESH,
    refreshGrant(await signAccessToken(projectKey, claims), claims, 'insider-refresh-2', false),
  );
}

/** GoTrue renews the owner's own session, at `aal`, under OWNER_REFRESH. */
async function ownerOwnRefresh(aal: 'aal1' | 'aal2', enrolled = true) {
  const renewed = sessionClaims({ aal, ...(aal === 'aal2' ? { totpAgeSeconds: 61 } : {}) });
  server.refreshGrants.set(
    OWNER_REFRESH,
    refreshGrant(
      await signAccessToken(projectKey, renewed),
      renewed,
      'owner-own-refresh-2',
      enrolled,
    ),
  );
}

async function run() {
  try {
    return { result: await transferOwnershipAction(INPUT) };
  } catch (e) {
    return { thrown: (e as Error).message };
  }
}

describe("transferOwnershipAction: the step-up is decided from the owner's own factor list", () => {
  it("an enrolled owner's password alone, beside an insider's refresh token, is refused: nothing is transferred", async () => {
    await ownerCookie('aal1', INSIDER_REFRESH, CROSSES_AFTER_THE_IDENTITY_READS);
    await insiderSession();
    const { result, thrown } = await run();
    expect(thrown).toBeUndefined();
    expect(result).toEqual(COULD_NOT_CHECK);
    expect(state.adminRpc).toEqual([]);
    // Both identity reads (withContext's and requireSession's) were the owner's...
    expect(restSubjects).toEqual([OWNER, OWNER]);
    // ...and the action's own factor list did refresh into the insider: the
    // case the step-up decision has to survive, not a timeline that missed it.
    expect(authCalls).toContain('/token');
    expect(state.authAs.at(-1)).toBe(`/user as ${INSIDER}`);
  });

  it("control: the owner's own aal1 session refreshing at the same moment is refused (code required)", async () => {
    await ownerCookie('aal1', OWNER_REFRESH, CROSSES_AFTER_THE_IDENTITY_READS);
    await ownerOwnRefresh('aal1');
    const { result } = await run();
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'forbidden',
        message: 'Re-authenticate with MFA before changing security settings.',
      },
    });
    expect(state.adminRpc).toEqual([]);
    expect(authCalls).toContain('/token');
  });

  it("control: the owner's own aal2 session refreshing at the same moment transfers ownership", async () => {
    await ownerCookie('aal2', OWNER_REFRESH, CROSSES_AFTER_THE_IDENTITY_READS);
    await ownerOwnRefresh('aal2');
    const { result } = await run();
    expect(result).toEqual({ ok: true, data: { newOwnerUserId: INSIDER } });
    expect(authCalls).toContain('/token');
    expect(state.adminRpc).toEqual([
      {
        fn: 'transfer_org_ownership',
        args: { p_organization_id: ORG, p_caller_user_id: OWNER, p_target_user_id: INSIDER },
      },
    ]);
  });

  it('control: an owner with no authenticator, refreshing their own session, transfers with the password alone', async () => {
    server.unenrolledUsers.add(OWNER);
    await ownerCookie('aal1', OWNER_REFRESH, CROSSES_AFTER_THE_IDENTITY_READS);
    await ownerOwnRefresh('aal1', false);
    const { result } = await run();
    expect(result).toEqual({ ok: true, data: { newOwnerUserId: INSIDER } });
    expect(authCalls).toContain('/token');
    expect(state.adminRpc).toHaveLength(1);
  });

  it('control: an enrolled owner at aal1 with no refresh during the action is refused (code required)', async () => {
    await ownerCookie('aal1', INSIDER_REFRESH, NEVER);
    await insiderSession();
    const { result } = await run();
    expect(result).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    expect(state.adminRpc).toEqual([]);
    expect(authCalls).not.toContain('/token');
  });

  it('control: crossing before requireSession() refutes the identity (sign-in)', async () => {
    await ownerCookie('aal1', INSIDER_REFRESH, CROSSES_BEFORE_REQUIRE_SESSION);
    await insiderSession();
    const { thrown } = await run();
    expect(thrown).toBe('REDIRECT:/signin');
    expect(state.adminRpc).toEqual([]);
  });
});

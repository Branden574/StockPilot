// @vitest-environment node
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Security invariant (docket S50a): account deletion decides the
 * authenticator step-up, the platform-admin refusal and its last check before
 * the delete only for the account the action validated (requireSession()).
 *
 * A member's step-up comes from withContext(), held to the member. A person
 * with no organization is read from their own factor list (readMfaFactorList,
 * factorsOf) and their own verified level (readVerifiedSessionClaimsOf). The
 * platform-admin check reads the validated account's email by its id, with
 * the service role. Immediately before the delete, assertStepUpHeld checks
 * once more that the verified session is that account's and owes no step-up,
 * so nothing read between the gate and the delete can stand in for it.
 *
 * Real: requireSession, readSessionMemberships and withContext
 * (lib/auth/session, services/context) with get_request_context(),
 * @supabase/ssr and auth-js against the fixture's Auth server, and a PostgREST
 * that answers as the bearer token's subject. The service role's calls are
 * recorded. Every round trip, the mocked ones included, moves the clock on, so
 * each case places the session's renewal at the point of the action it names.
 */

const state = vi.hoisted(() => ({
  /** The account the proxy validated: the identity header it forwards. */
  headerUserId: '',
  /** The service role's calls, with the account each one named. */
  admin: [] as Array<{ call: string; userId: string }>,
  /** How long the limiter takes to answer (a round trip unless a case says otherwise). */
  rateLimitMs: 300,
  /** Take requireOrgContext()'s own code gate out, leaving the action's checks alone. */
  codeGateOut: true,
}));
// requireOrgContext() now sends a member who owes an authenticator code to
// /signin/mfa before withContext() returns (docket S43c, lib/auth/
// step-up-gate). The cases below take that gate out, so they still show the
// action's own checks holding by themselves; the last block puts it back.
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

/** A round trip: answered in a later turn of the event loop, with the clock moved on. */
const ROUND_TRIP_MS = 300;
async function roundTrip(ms: number = ROUND_TRIP_MS): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  vi.setSystemTime(Date.now() + ms);
}

let jar = new Map<string, string>();
vi.mock('next/headers', async () => {
  const f = await import('@/test/auth-session-fixture');
  return {
    // A Server Action: the cookie store accepts writes.
    cookies: async () => f.cookieStoreOver(jar),
    headers: async () =>
      new Headers({
        'x-pathname': '/dashboard/settings/profile',
        'x-stockpilot-user-id': state.headerUserId,
      }),
  };
});
vi.mock('@/lib/env', async () => {
  const f = await import('@/test/auth-session-fixture');
  return {
    env: {
      NEXT_PUBLIC_SUPABASE_URL: f.FIXTURE_SUPABASE_URL,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: f.FIXTURE_ANON_KEY,
      STOCKPILOT_PLATFORM_ADMIN_EMAILS: 'platform-admin@example.test',
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
  unstable_rethrow: (e: unknown) => {
    if (e instanceof Error && e.message.startsWith('REDIRECT:')) throw e;
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => {
    await roundTrip(state.rateLimitMs);
    return { allowed: true, remaining: 4, resetAt: Date.now() + 1 };
  }),
}));
vi.mock('@/server/services/platform/sessions', () => ({
  revokeAllSessionsForUser: vi.fn(async () => ({ ok: true, sessionIds: [] })),
}));
// The database's own answer (0388) is "deletable"; what the deletion leaves
// for review is read and reported elsewhere. The checks this file is about
// run before them and stay real.
vi.mock('@/server/lib/account-deletion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/lib/account-deletion')>()),
  checkAccountDeletable: vi.fn(async () => ({ ok: true })),
  readDeletionReviewFacts: vi.fn(async () => ({
    createdStillActive: null,
    soloPaidOrganizationIds: [],
  })),
  reportDeletionReviewFacts: vi.fn(),
  removeAvatarObjects: vi.fn(async () => {}),
  auditAccountDeleted: vi.fn(async () => {}),
}));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    auth: {
      admin: {
        getUserById: async (userId: string) => {
          state.admin.push({ call: 'getUserById', userId });
          return { data: { user: { id: userId, email: accountEmail(userId) } }, error: null };
        },
        deleteUser: async (userId: string) => {
          state.admin.push({ call: 'deleteUser', userId });
          return { data: null, error: null };
        },
        mfa: {
          listFactors: async ({ userId }: { userId: string }) => {
            state.admin.push({ call: 'listFactors', userId });
            return { data: { factors: accountFactors(userId) }, error: null };
          },
        },
      },
    },
  }),
}));

import { readVerifiedSessionClaims } from '@/lib/auth/verified-claims';
import { createClient } from '@/lib/supabase/server';
import { ACCOUNT_DELETE_RETRY_COPY } from '@/server/lib/account-deletion';
import {
  FIXTURE_EMAIL,
  FIXTURE_SESSION_ID,
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

import { deleteOwnAccountAction } from './profile';

const MEMBER = FIXTURE_USER_ID;
const OTHER = '33333333-3333-4333-8333-333333333333';
const PLATFORM_ADMIN = '55555555-5555-4555-8555-555555555555';
const ORG = 'aaaaaaaa-1111-4111-8111-111111111111';
const MEMBER_REFRESH = 'member-own-refresh';
const OTHER_REFRESH = 'other-refresh';

const EMAILS: Record<string, string> = {
  [MEMBER]: FIXTURE_EMAIL,
  [OTHER]: 'other@example.test',
  [PLATFORM_ADMIN]: 'platform-admin@example.test',
};
const SESSIONS: Record<string, string> = {
  [MEMBER]: FIXTURE_SESSION_ID,
  [OTHER]: '44444444-4444-4444-8444-444444444444',
  [PLATFORM_ADMIN]: '66666666-6666-4666-8666-666666666666',
};
function accountEmail(userId: string): string | null {
  return EMAILS[userId] ?? null;
}

/**
 * The action's round trips for a member: requireSession()'s
 * get_request_context() (0-300 ms), then the membership read's (300-600).
 * Crossing 150 ms in renews the session at the membership read.
 */
const CROSSES_AT_THE_MEMBERSHIP_READ = 150;
/**
 * For a person with no organization the factor list is read at 600 ms, after
 * the two get_request_context() reads: 450 ms renews the session at that read.
 */
const CROSSES_AT_THE_FACTOR_LIST = 450;
/** Well past the gate: the limiter is made slow enough to cross it (state.rateLimitMs). */
const CROSSES_DURING_THE_RATE_LIMIT = 60_000;
const NEVER = 3_600_000;

const SIGN_IN_AGAIN = {
  ok: false,
  error: {
    code: 'unauthenticated',
    message: 'Sign in again, then try again.',
    details: { reason: 'session_changed' },
  },
};

let projectKey: SigningKey;
let server: FakeAuthServer;
/** Auth server requests, by path, in order. */
let authCalls: string[];
/** get_request_context() calls, with the account each answered for. */
let contextAs: string[];
/** The accounts with an organization: their role there. */
let roles: Map<string, 'owner' | 'admin' | 'staff'>;
/**
 * get_request_context() fails, so the session is resolved with the legacy
 * reads, and of those the membership read fails while the profile read works.
 * Both failures are 500s: postgrest-js retries a GET answered 503 or 520 with
 * real sleeps, which would outlast the test's timeout.
 */
let membershipReadFails: boolean;

beforeAll(async () => {
  projectKey = await makeSigningKey('project-kid-1');
});

/** The account's factors as GoTrue keeps them (the same view the Auth server's /user gives). */
function accountFactors(userId: string) {
  return server.unenrolledUsers.has(userId)
    ? []
    : [{ id: `factor-of-${userId}`, factor_type: 'totp', status: 'verified' }];
}

function subOf(jwt: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8'));
    return typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}

/** PostgREST, answering as auth.uid(): the bearer token's subject. */
function rest(url: URL, subject: string | null): Response {
  const name = url.pathname.replace('/rest/v1/', '');
  if (membershipReadFails) return legacyReads(name, url, subject);
  if (name === 'rpc/get_request_context') {
    contextAs.push(subject ?? '(none)');
    if (!subject) return Response.json({ user_id: null, profile: null, memberships: [] });
    const role = roles.get(subject);
    return Response.json({
      user_id: subject,
      profile: {
        id: subject,
        email: accountEmail(subject),
        full_name: null,
        avatar_url: null,
        default_organization_id: role ? ORG : null,
        disabled_at: null,
      },
      memberships: role
        ? [
            {
              organization_id: ORG,
              role,
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
          ]
        : [],
    });
  }
  // The sole-owner pre-check: no account here owns an organization with
  // other members.
  if (name === 'organization_members') return Response.json([]);
  return Response.json({ message: `no fake for ${name}` }, { status: 404 });
}

/** PostgREST while membershipReadFails: see its comment. */
function legacyReads(name: string, url: URL, subject: string | null): Response {
  if (name === 'rpc/get_request_context') {
    contextAs.push(subject ?? '(none)');
    return Response.json({ code: 'XX000', message: 'internal' }, { status: 500 });
  }
  if (name === 'user_profiles') {
    if (!subject) return Response.json([]);
    return Response.json([
      {
        id: subject,
        email: accountEmail(subject),
        full_name: null,
        avatar_url: null,
        default_organization_id: roles.has(subject) ? ORG : null,
        disabled_at: null,
      },
    ]);
  }
  if (name === 'organization_members') {
    // The session loader's read embeds the organization; the sole-owner
    // pre-check's does not, and finds nothing.
    if (url.searchParams.get('select')?.includes('organizations:organization_id')) {
      return Response.json({ code: '57014', message: 'timeout' }, { status: 500 });
    }
    return Response.json([]);
  }
  return Response.json({ message: `no fake for ${name}` }, { status: 404 });
}

beforeEach(() => {
  state.codeGateOut = true;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-02T03:00:00.000Z'));
  server = fakeAuthServer(projectKey);
  authCalls = [];
  contextAs = [];
  roles = new Map([[MEMBER, 'staff']]);
  membershipReadFails = false;
  state.admin = [];
  state.rateLimitMs = ROUND_TRIP_MS;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const bearer =
      new Headers(init?.headers).get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
    let answer: Response;
    if (url.pathname.startsWith('/rest/v1/')) {
      answer = rest(url, subOf(bearer));
    } else {
      authCalls.push(url.pathname.replace('/auth/v1', ''));
      answer = await server.fetch(input, init);
    }
    await roundTrip();
    return answer;
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

// auth-js keeps the key set in a module-global cache, as a warm production
// instance has it. Fetching it is one more round trip, which would move the
// timeline of whichever case ran first, so it is fetched once up front.
let warmed = false;
beforeEach(async () => {
  if (warmed) return;
  warmed = true;
  const claims = sessionClaims({ aal: 'aal1' });
  jar = sessionCookies(await signAccessToken(projectKey, claims), claims, {
    expiresAt: (Date.now() + 3_600_000) / 1000,
  });
  await readVerifiedSessionClaims(await createClient());
  authCalls = [];
  vi.setSystemTime(new Date('2026-11-02T03:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function claimsOf(sub: string, aal: 'aal1' | 'aal2', totpAgeSeconds: number) {
  return sessionClaims({
    aal,
    sub,
    email: EMAILS[sub],
    sessionId: SESSIONS[sub],
    ...(aal === 'aal2' ? { totpAgeSeconds } : {}),
  });
}

/**
 * `sub` is the account the proxy validated: its session at `aal`, carrying
 * `refreshToken`, with `expires_at` reaching the 90 s margin `crossesInMs`
 * after the action starts.
 */
async function signedIn(
  sub: string,
  aal: 'aal1' | 'aal2',
  refreshToken: string,
  crossesInMs: number,
) {
  const claims = claimsOf(sub, aal, 60);
  jar = sessionCookies(await signAccessToken(projectKey, claims), claims, {
    refreshToken,
    expiresAt: (Date.now() + 90_000 + crossesInMs) / 1000,
  });
  state.headerUserId = sub;
}

/** GoTrue answers `refreshToken` with a session of `sub` at `aal`. */
async function grant(refreshToken: string, sub: string, aal: 'aal1' | 'aal2', enrolled = true) {
  const claims = claimsOf(sub, aal, 61);
  if (!enrolled) server.unenrolledUsers.add(sub);
  server.refreshGrants.set(
    refreshToken,
    refreshGrant(await signAccessToken(projectKey, claims), claims, `${refreshToken}-2`, enrolled),
  );
}

async function run() {
  try {
    return { result: await deleteOwnAccountAction({ confirm: 'DELETE' }) };
  } catch (e) {
    return { thrown: (e as Error).message };
  }
}

const deleted = () => state.admin.filter((c) => c.call === 'deleteUser').map((c) => c.userId);

describe('deleteOwnAccountAction: the step-up is decided only for the validated account', () => {
  for (const kind of [
    { label: 'an account with no authenticator', aal: 'aal1' as const, enrolled: false },
    { label: 'an account with an authenticator at aal2', aal: 'aal2' as const, enrolled: true },
  ]) {
    it(`a member with an authenticator at aal1: refused, nothing deleted, when the membership read is not the member's (${kind.label})`, async () => {
      await signedIn(MEMBER, 'aal1', OTHER_REFRESH, CROSSES_AT_THE_MEMBERSHIP_READ);
      await grant(OTHER_REFRESH, OTHER, kind.aal, kind.enrolled);
      const { result, thrown } = await run();
      expect(thrown).toBeUndefined();
      expect(result).toEqual(SIGN_IN_AGAIN);
      expect(deleted()).toEqual([]);
      // requireSession() validated the member; the membership read that
      // followed was not answered for the member, so it read as no
      // memberships.
      expect(contextAs[0]).toBe(MEMBER);
      expect(contextAs[1]).not.toBe(MEMBER);
      expect(authCalls).toContain('/token');
    });

    it(`a person with no organization, with an authenticator, at aal1: refused, nothing deleted, when the factor list read is not theirs (${kind.label})`, async () => {
      roles.delete(MEMBER);
      await signedIn(MEMBER, 'aal1', OTHER_REFRESH, CROSSES_AT_THE_FACTOR_LIST);
      await grant(OTHER_REFRESH, OTHER, kind.aal, kind.enrolled);
      const { result, thrown } = await run();
      expect(thrown).toBeUndefined();
      expect(result).toEqual(SIGN_IN_AGAIN);
      expect(deleted()).toEqual([]);
      expect(contextAs).toEqual([MEMBER, MEMBER]);
      expect(authCalls).toContain('/token');
    });
  }

  it('the last check: a member at aal2 is refused, nothing deleted, when the verified session is not theirs by the time of the delete', async () => {
    await signedIn(MEMBER, 'aal2', OTHER_REFRESH, CROSSES_DURING_THE_RATE_LIMIT);
    await grant(OTHER_REFRESH, OTHER, 'aal1', false);
    state.rateLimitMs = 120_000;
    const { result, thrown } = await run();
    expect(thrown).toBeUndefined();
    expect(result).toEqual(SIGN_IN_AGAIN);
    expect(deleted()).toEqual([]);
    expect(authCalls).toContain('/token');
  });

  it('the last check: the same for a person with no organization and no authenticator', async () => {
    roles.delete(MEMBER);
    server.unenrolledUsers.add(MEMBER);
    await signedIn(MEMBER, 'aal1', OTHER_REFRESH, CROSSES_DURING_THE_RATE_LIMIT);
    await grant(OTHER_REFRESH, OTHER, 'aal2', true);
    state.rateLimitMs = 120_000;
    const { result, thrown } = await run();
    expect(thrown).toBeUndefined();
    expect(result).toEqual(SIGN_IN_AGAIN);
    expect(deleted()).toEqual([]);
    expect(authCalls).toContain('/token');
  });

  it('an allowlisted platform admin with no authenticator: refused, nothing deleted, when the factor list read is not theirs', async () => {
    server.unenrolledUsers.add(PLATFORM_ADMIN);
    await signedIn(PLATFORM_ADMIN, 'aal1', OTHER_REFRESH, CROSSES_AT_THE_FACTOR_LIST);
    await grant(OTHER_REFRESH, OTHER, 'aal1', false);
    const { result, thrown } = await run();
    expect(thrown).toBeUndefined();
    expect(result).toEqual(SIGN_IN_AGAIN);
    expect(deleted()).toEqual([]);
    expect(authCalls).toContain('/token');
  });

  it('an allowlisted platform admin is refused by the email of their own account, read by its id with the service role', async () => {
    server.unenrolledUsers.add(PLATFORM_ADMIN);
    await signedIn(PLATFORM_ADMIN, 'aal1', OTHER_REFRESH, NEVER);
    const { result, thrown } = await run();
    expect(thrown).toBeUndefined();
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'forbidden', details: { reason: 'platform_admin' } },
    });
    expect(deleted()).toEqual([]);
  });
});

describe('deleteOwnAccountAction: controls (deleted as before)', () => {
  it('a member with no authenticator whose own session is renewed during the action', async () => {
    server.unenrolledUsers.add(MEMBER);
    await signedIn(MEMBER, 'aal1', MEMBER_REFRESH, CROSSES_AT_THE_MEMBERSHIP_READ);
    await grant(MEMBER_REFRESH, MEMBER, 'aal1', false);
    const { result, thrown } = await run();
    expect(thrown).toBeUndefined();
    expect(result).toEqual({ ok: true, data: undefined });
    expect(deleted()).toEqual([MEMBER]);
    expect(authCalls).toContain('/token');
  });

  it('a member with an authenticator at aal2 whose own session is renewed after the gate', async () => {
    await signedIn(MEMBER, 'aal2', MEMBER_REFRESH, CROSSES_DURING_THE_RATE_LIMIT);
    await grant(MEMBER_REFRESH, MEMBER, 'aal2');
    state.rateLimitMs = 120_000;
    const { result, thrown } = await run();
    expect(thrown).toBeUndefined();
    expect(result).toEqual({ ok: true, data: undefined });
    expect(deleted()).toEqual([MEMBER]);
    expect(authCalls).toContain('/token');
  });

  it('a person with no organization and no authenticator', async () => {
    roles.delete(MEMBER);
    server.unenrolledUsers.add(MEMBER);
    await signedIn(MEMBER, 'aal1', OTHER_REFRESH, NEVER);
    const { result, thrown } = await run();
    expect(thrown).toBeUndefined();
    expect(result).toEqual({ ok: true, data: undefined });
    expect(deleted()).toEqual([MEMBER]);
  });

  it('a person with no organization, with an authenticator, at aal2', async () => {
    roles.delete(MEMBER);
    await signedIn(MEMBER, 'aal2', OTHER_REFRESH, NEVER);
    const { result, thrown } = await run();
    expect(thrown).toBeUndefined();
    expect(result).toEqual({ ok: true, data: undefined });
    expect(deleted()).toEqual([MEMBER]);
  });

  it('a member with an authenticator at aal1 and no renewal is refused (code required)', async () => {
    await signedIn(MEMBER, 'aal1', OTHER_REFRESH, NEVER);
    const { result, thrown } = await run();
    expect(thrown).toBeUndefined();
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'forbidden', details: { reason: 'aal2_required' } },
    });
    expect(deleted()).toEqual([]);
  });
});

describe('deleteOwnAccountAction: a membership list that cannot be read', () => {
  it('a member whose membership list cannot be read: nothing is deleted, try again', async () => {
    membershipReadFails = true;
    server.unenrolledUsers.add(MEMBER);
    await signedIn(MEMBER, 'aal1', MEMBER_REFRESH, NEVER);
    const { result, thrown } = await run();
    expect(thrown).toBeUndefined();
    expect(result).toEqual({
      ok: false,
      error: { code: 'internal_error', message: ACCOUNT_DELETE_RETRY_COPY },
    });
    expect(deleted()).toEqual([]);
    // Each session read asked get_request_context() first, for the member.
    expect(contextAs.length).toBeGreaterThan(0);
    expect(new Set(contextAs)).toEqual(new Set([MEMBER]));
  });
});

describe("deleteOwnAccountAction with requireOrgContext()'s own gate in front, as in a real request", () => {
  beforeEach(() => {
    state.codeGateOut = false;
  });

  it('a member with an authenticator at aal1 is sent to the code page, and nothing is deleted', async () => {
    await signedIn(MEMBER, 'aal1', OTHER_REFRESH, NEVER);
    const { result, thrown } = await run();
    expect(thrown).toBe('REDIRECT:/signin/mfa');
    expect(result).toBeUndefined();
    expect(deleted()).toEqual([]);
  });

  it('a member with an authenticator at aal2 deletes the account, as before', async () => {
    await signedIn(MEMBER, 'aal2', OTHER_REFRESH, NEVER);
    const { result, thrown } = await run();
    expect(thrown).toBeUndefined();
    expect(result).toEqual({ ok: true, data: undefined });
    expect(deleted()).toEqual([MEMBER]);
  });

  it('a person with no organization and no authenticator deletes the account, as before', async () => {
    roles.delete(MEMBER);
    server.unenrolledUsers.add(MEMBER);
    await signedIn(MEMBER, 'aal1', OTHER_REFRESH, NEVER);
    const { result, thrown } = await run();
    expect(thrown).toBeUndefined();
    expect(result).toEqual({ ok: true, data: undefined });
    expect(deleted()).toEqual([MEMBER]);
  });
});

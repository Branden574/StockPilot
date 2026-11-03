// @vitest-environment node
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Security invariant (docket S50a): the recovery-code actions read the sign-in
 * level, and spend or mint codes, only as the account the action already
 * validated.
 *
 * requireSession() names the account. The check after it takes that
 * account's verified access token (readVerifiedSessionTokenOf answers only
 * when the verified token's subject is that account), and the database call
 * runs with that same token on a client that never loads or renews a session
 * (createAccessTokenClient). So a code is checked against that account's own
 * set, only that account's factors are removed, and minted codes are only
 * ever that account's.
 *
 * Real: requireSession (lib/auth/session) and get_request_context(),
 * @supabase/ssr and auth-js against the fixture's Auth server (ES256 keys,
 * /user checks the signature, a refresh grant for each session GoTrue knows),
 * and a PostgREST that runs every function as the bearer token's subject.
 * Every round trip, the mocked ones included, moves the clock on, so each case
 * places the session's renewal at the point of the action it names.
 */

const state = vi.hoisted(() => ({
  /** The account the proxy validated: the identity header it forwards. */
  headerUserId: '',
  /** The service-role factor calls, with the account each one named. */
  admin: [] as Array<{ call: 'listFactors' | 'deleteFactor'; userId: string }>,
}));

/** A round trip: answered in a later turn of the event loop, with the clock moved on. */
const ROUND_TRIP_MS = 300;
async function roundTrip(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  vi.setSystemTime(Date.now() + ROUND_TRIP_MS);
}

let jar = new Map<string, string>();
vi.mock('next/headers', async () => {
  const f = await import('@/test/auth-session-fixture');
  return {
    // A Server Action: the cookie store accepts writes.
    cookies: async () => f.cookieStoreOver(jar),
    headers: async () =>
      new Headers({ 'x-pathname': '/signin/mfa', 'x-stockpilot-user-id': state.headerUserId }),
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
  unstable_rethrow: (e: unknown) => {
    if (e instanceof Error && e.message.startsWith('REDIRECT:')) throw e;
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
// Each limiter answer is a database round trip of its own.
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => {
    await roundTrip();
    return { allowed: true, remaining: 4, resetAt: Date.now() + 1 };
  }),
}));
// The caller has the account's password; the check is a GoTrue round trip.
vi.mock('@/lib/auth/verify-password', () => ({
  verifyPasswordSideChannel: vi.fn(async () => {
    await roundTrip();
    return { ok: true };
  }),
}));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    auth: {
      admin: {
        mfa: {
          listFactors: async ({ userId }: { userId: string }) => {
            state.admin.push({ call: 'listFactors', userId });
            return {
              data: {
                factors: [{ id: `factor-of-${userId}`, factor_type: 'totp', status: 'verified' }],
              },
              error: null,
            };
          },
          deleteFactor: async ({ userId }: { userId: string; id: string }) => {
            state.admin.push({ call: 'deleteFactor', userId });
            return { data: null, error: null };
          },
        },
      },
    },
  }),
}));

import { combineChunks, stringFromBase64URL } from '@supabase/ssr';

import { readVerifiedSessionClaims } from '@/lib/auth/verified-claims';
import { createClient } from '@/lib/supabase/server';
import {
  FIXTURE_AUTH_COOKIE,
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

import { consumeMfaRecoveryCodeAction, generateMfaRecoveryCodesAction } from './mfa-recovery';

const MEMBER = FIXTURE_USER_ID;
const OTHER = '33333333-3333-4333-8333-333333333333';
const OTHER_SESSION = '44444444-4444-4444-8444-444444444444';
const OTHER_EMAIL = 'other@example.test';
const MEMBER_REFRESH = 'member-own-refresh';
const OTHER_REFRESH = 'other-refresh';

/** Each account's one unused code before the action runs. */
const MEMBER_CODE = 'member-unused-code';
const OTHER_CODE = 'other-unused-code';
const PASSWORD = 'the-member-password';

/**
 * consumeMfaRecoveryCodeAction's round trips, in order: requireSession()'s
 * get_request_context() (0-300 ms), the limiter (300-600), the password check
 * (600-900). Crossing 750 ms in renews the session at the first read after
 * the password check.
 */
const CROSSES_DURING_THE_PASSWORD_CHECK = 750;
/**
 * generateMfaRecoveryCodesAction's: requireSession() (0-300), the level read
 * at 300 (verified locally, no round trip), the limiter (300-600), then the
 * database call. 150 ms renews the session at the level read; 450 ms at the
 * first read after the limiter.
 */
const CROSSES_AT_THE_LEVEL_READ = 150;
const CROSSES_DURING_THE_RATE_LIMIT = 450;
const NEVER = 3_600_000;

const SIGN_IN_AGAIN = {
  ok: false,
  error: {
    code: 'unauthenticated',
    message: 'Sign in again, then try again.',
    details: { reason: 'session_changed' },
  },
};
const GENERATE_REFUSED = {
  ok: false,
  error: {
    code: 'forbidden',
    message: 'Re-authenticate with MFA before regenerating recovery codes.',
  },
};

let projectKey: SigningKey;
let server: FakeAuthServer;
/** Auth server requests, by path, in order. */
let authCalls: string[];
/** Every database function call, with the account it ran as. */
let rpcAs: Array<{ fn: string; as: string | null }>;
/** Each account's unused recovery codes, as the database holds them. */
let unusedCodes: Map<string, Set<string>>;

beforeAll(async () => {
  projectKey = await makeSigningKey('project-kid-1');
});

const emailOf = (sub: string) => (sub === MEMBER ? FIXTURE_EMAIL : OTHER_EMAIL);
const labelOf = (sub: string) => (sub === MEMBER ? 'member' : 'other');
const tenNewCodesOf = (sub: string) =>
  Array.from({ length: 10 }, (_, i) => `${labelOf(sub)}-new-code-${i + 1}`);

function subOf(jwt: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8'));
    return typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}

/** PostgREST: every function runs as auth.uid(), the bearer token's subject. */
function rest(url: URL, init: RequestInit | undefined, subject: string | null): Response {
  const name = url.pathname.replace('/rest/v1/', '');
  if (name.startsWith('rpc/')) rpcAs.push({ fn: name.slice('rpc/'.length), as: subject });
  if (name === 'rpc/get_request_context') {
    if (!subject) return Response.json({ user_id: null, profile: null, memberships: [] });
    return Response.json({
      user_id: subject,
      profile: {
        id: subject,
        email: emailOf(subject),
        full_name: null,
        avatar_url: null,
        default_organization_id: null,
        disabled_at: null,
      },
      memberships: [],
    });
  }
  if (name === 'rpc/consume_mfa_recovery_code') {
    const code = (JSON.parse(String(init?.body ?? '{}')) as { p_code?: string }).p_code ?? '';
    const own = subject ? unusedCodes.get(subject) : undefined;
    return Response.json(own?.delete(code) ?? false);
  }
  if (name === 'rpc/generate_mfa_recovery_codes') {
    if (!subject) return Response.json({ message: 'not signed in' }, { status: 401 });
    const fresh = tenNewCodesOf(subject);
    unusedCodes.set(subject, new Set(fresh));
    return Response.json(fresh.map((code) => ({ code })));
  }
  return Response.json({ message: `no fake for ${name}` }, { status: 404 });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-02T03:00:00.000Z'));
  server = fakeAuthServer(projectKey);
  authCalls = [];
  rpcAs = [];
  state.admin = [];
  unusedCodes = new Map([
    [MEMBER, new Set([MEMBER_CODE])],
    [OTHER, new Set([OTHER_CODE])],
  ]);
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const bearer =
      new Headers(init?.headers).get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
    let answer: Response;
    if (url.pathname.startsWith('/rest/v1/')) {
      answer = rest(url, init, subOf(bearer));
    } else {
      authCalls.push(url.pathname.replace('/auth/v1', ''));
      answer = await server.fetch(input, init);
    }
    await roundTrip();
    return answer;
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
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
  rpcAs = [];
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
    email: emailOf(sub),
    sessionId: sub === MEMBER ? FIXTURE_SESSION_ID : OTHER_SESSION,
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

/** The refresh token of the session the cookie store now holds. */
async function storedRefreshToken(): Promise<string | null> {
  const raw = await combineChunks(FIXTURE_AUTH_COOKIE, (name) => jar.get(name) || null);
  if (!raw) return null;
  const json = raw.startsWith('base64-') ? stringFromBase64URL(raw.slice('base64-'.length)) : raw;
  return (JSON.parse(json) as { refresh_token?: string }).refresh_token ?? null;
}

const callsOf = (fn: string) => rpcAs.filter((c) => c.fn === fn);

describe('consumeMfaRecoveryCodeAction: a code is spent only as the validated account', () => {
  it('nothing is spent and no factor is removed when the verified session is not the validated account (one with no authenticator)', async () => {
    await signedIn(MEMBER, 'aal1', OTHER_REFRESH, CROSSES_DURING_THE_PASSWORD_CHECK);
    await grant(OTHER_REFRESH, OTHER, 'aal1', false);
    const result = await consumeMfaRecoveryCodeAction({ code: OTHER_CODE, password: PASSWORD });
    expect(result).toEqual(SIGN_IN_AGAIN);
    expect(callsOf('consume_mfa_recovery_code')).toEqual([]);
    expect(state.admin).toEqual([]);
    expect(unusedCodes.get(OTHER)).toEqual(new Set([OTHER_CODE]));
    expect(unusedCodes.get(MEMBER)).toEqual(new Set([MEMBER_CODE]));
    // The identity read was the member's, and the session was renewed before
    // the check: the timeline the check has to hold on, not one that missed it.
    expect(callsOf('get_request_context')).toEqual([{ fn: 'get_request_context', as: MEMBER }]);
    expect(authCalls).toContain('/token');
  });

  it('the same when that account has an authenticator and an aal2 session', async () => {
    await signedIn(MEMBER, 'aal1', OTHER_REFRESH, CROSSES_DURING_THE_PASSWORD_CHECK);
    await grant(OTHER_REFRESH, OTHER, 'aal2', true);
    const result = await consumeMfaRecoveryCodeAction({ code: OTHER_CODE, password: PASSWORD });
    expect(result).toEqual(SIGN_IN_AGAIN);
    expect(callsOf('consume_mfa_recovery_code')).toEqual([]);
    expect(state.admin).toEqual([]);
    expect(unusedCodes.get(OTHER)).toEqual(new Set([OTHER_CODE]));
    expect(authCalls).toContain('/token');
  });

  it("control: the validated account's own session renewed at the same moment spends its own code, removes its own factors, and keeps the renewed cookie", async () => {
    await signedIn(MEMBER, 'aal1', MEMBER_REFRESH, CROSSES_DURING_THE_PASSWORD_CHECK);
    await grant(MEMBER_REFRESH, MEMBER, 'aal1');
    const result = await consumeMfaRecoveryCodeAction({ code: MEMBER_CODE, password: PASSWORD });
    expect(result).toEqual({ ok: true, data: { unenrolled: 1 } });
    expect(callsOf('consume_mfa_recovery_code')).toEqual([
      { fn: 'consume_mfa_recovery_code', as: MEMBER },
    ]);
    expect(unusedCodes.get(MEMBER)).toEqual(new Set());
    expect(state.admin).toEqual([
      { call: 'listFactors', userId: MEMBER },
      { call: 'deleteFactor', userId: MEMBER },
    ]);
    expect(authCalls).toContain('/token');
    expect(await storedRefreshToken()).toBe(`${MEMBER_REFRESH}-2`);
  });

  it("control: with no renewal during the action, the account's own code is spent as that account", async () => {
    await signedIn(MEMBER, 'aal1', OTHER_REFRESH, NEVER);
    await grant(OTHER_REFRESH, OTHER, 'aal1', false);
    const result = await consumeMfaRecoveryCodeAction({ code: MEMBER_CODE, password: PASSWORD });
    expect(result).toEqual({ ok: true, data: { unenrolled: 1 } });
    expect(callsOf('consume_mfa_recovery_code')).toEqual([
      { fn: 'consume_mfa_recovery_code', as: MEMBER },
    ]);
    expect(authCalls).not.toContain('/token');
  });

  it("control: another account's code is not a code of the validated account", async () => {
    await signedIn(MEMBER, 'aal1', OTHER_REFRESH, NEVER);
    const result = await consumeMfaRecoveryCodeAction({ code: OTHER_CODE, password: PASSWORD });
    expect(result).toMatchObject({ ok: false, error: { code: 'validation_error' } });
    expect(state.admin).toEqual([]);
    expect(unusedCodes.get(OTHER)).toEqual(new Set([OTHER_CODE]));
  });
});

describe('generateMfaRecoveryCodesAction: codes are minted only for the validated account', () => {
  it('refuses, minting nothing, when the verified session is not the validated account', async () => {
    await signedIn(MEMBER, 'aal1', OTHER_REFRESH, CROSSES_AT_THE_LEVEL_READ);
    await grant(OTHER_REFRESH, OTHER, 'aal2', true);
    const result = await generateMfaRecoveryCodesAction();
    expect(result).toEqual(GENERATE_REFUSED);
    expect(callsOf('generate_mfa_recovery_codes')).toEqual([]);
    expect(unusedCodes.get(OTHER)).toEqual(new Set([OTHER_CODE]));
    expect(authCalls).toContain('/token');
  });

  it("mints with the validated account's own verified token: the codes are that account's, and no other set changes", async () => {
    // Here the validated account is the second one (aal2, with an
    // authenticator).
    await signedIn(OTHER, 'aal2', MEMBER_REFRESH, CROSSES_DURING_THE_RATE_LIMIT);
    await grant(MEMBER_REFRESH, MEMBER, 'aal1');
    const result = await generateMfaRecoveryCodesAction();
    expect(callsOf('generate_mfa_recovery_codes')).toEqual([
      { fn: 'generate_mfa_recovery_codes', as: OTHER },
    ]);
    expect(result).toEqual({ ok: true, data: { codes: tenNewCodesOf(OTHER) } });
    expect(unusedCodes.get(MEMBER)).toEqual(new Set([MEMBER_CODE]));
    // The minting client never loads the cookie session, so nothing renews it.
    expect(authCalls).not.toContain('/token');
  });

  it("control: an aal2 session renewed as the same account mints that account's codes", async () => {
    await signedIn(MEMBER, 'aal2', MEMBER_REFRESH, CROSSES_AT_THE_LEVEL_READ);
    await grant(MEMBER_REFRESH, MEMBER, 'aal2');
    const result = await generateMfaRecoveryCodesAction();
    expect(result).toEqual({ ok: true, data: { codes: tenNewCodesOf(MEMBER) } });
    expect(callsOf('generate_mfa_recovery_codes')).toEqual([
      { fn: 'generate_mfa_recovery_codes', as: MEMBER },
    ]);
    expect(authCalls).toContain('/token');
    expect(await storedRefreshToken()).toBe(`${MEMBER_REFRESH}-2`);
  });

  it('control: an aal1 session renewed as the same account is refused', async () => {
    await signedIn(MEMBER, 'aal1', MEMBER_REFRESH, CROSSES_AT_THE_LEVEL_READ);
    await grant(MEMBER_REFRESH, MEMBER, 'aal1');
    const result = await generateMfaRecoveryCodesAction();
    expect(result).toEqual(GENERATE_REFUSED);
    expect(callsOf('generate_mfa_recovery_codes')).toEqual([]);
  });
});

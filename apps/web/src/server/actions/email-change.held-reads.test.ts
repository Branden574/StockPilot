// @vitest-environment node
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Security invariant (docket S50a): starting or resending an email change
 * decides the authenticator step-up only from the factors and the sign-in
 * level of the account the action validated.
 *
 * getUser() names the account, and its answer carries that account's own
 * factors, so "has an authenticator" comes from the same answer. The level is
 * read only as that account's (readVerifiedSessionClaimsOf); anything else
 * counts as not aal2, and the service then asks for the code before it mints
 * either link.
 *
 * Real: the actions and services/email-change.ts, @supabase/ssr and auth-js
 * against the fixture's Auth server, and a PostgREST that answers as the
 * bearer token's subject. The service role's link minting is recorded; the
 * password check and the emails are stubbed. Every round trip moves the clock
 * on, so each case places the session's renewal at the point of the action it
 * names.
 */

const state = vi.hoisted(() => ({
  /** The service role's generateLink calls (each one mints a link). */
  minted: [] as Array<{ type: string; email: string }>,
  cancelled: [] as string[],
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
    headers: async () => new Headers(),
  };
});
vi.mock('@/lib/env', async () => {
  const f = await import('@/test/auth-session-fixture');
  // Both links are signed for the account they are for (docket S25), and a
  // link that cannot be signed is not sent: a dull signing value under a
  // neutral name stands in for the service key.
  const SIGNING_INPUT = 'test-only-signing-input';
  return {
    env: {
      NEXT_PUBLIC_SUPABASE_URL: f.FIXTURE_SUPABASE_URL,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: f.FIXTURE_ANON_KEY,
      NEXT_PUBLIC_APP_URL: 'https://app.example.test',
      SUPABASE_SERVICE_ROLE_KEY: SIGNING_INPUT,
    },
  };
});
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, remaining: 2, resetAt: Date.now() + 1 })),
}));
// The caller has the account's password.
vi.mock('@/lib/auth/verify-password', () => ({
  verifyPasswordSideChannel: vi.fn(async () => ({ ok: true })),
}));
vi.mock('@/lib/email/resend', () => ({ sendEmail: vi.fn(async () => ({ ok: true })) }));
vi.mock('@/lib/email/es/families/security', () => {
  const rendered = () => ({ subject: 's', html: '<p>h</p>', text: 't', from: 'from@example.test' });
  return {
    renderEmailChangeCurrentEmail: rendered,
    renderEmailChangeNewEmail: rendered,
    renderEmailChangedNoticeEmail: rendered,
  };
});
vi.mock('@/server/services/audit', () => ({ insertAuditRowReported: vi.fn(async () => true) }));
vi.mock('@/lib/supabase/admin', async () => {
  const f = await import('@/test/auth-session-fixture');
  const profileRow = {
    default_organization_id: null,
    full_name: 'Placeholder Member',
    disabled_at: null,
    deleted_at: null,
  };
  const chain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => ({ data: profileRow, error: null }),
  };
  return {
    createAdminClient: () => ({
      from: () => chain,
      rpc: async (fn: string, args: { p_user_id?: string }) => {
        if (fn === 'cancel_pending_email_change') {
          state.cancelled.push(args.p_user_id ?? '');
          return { data: true, error: null };
        }
        // auth_user_exists_by_email: the new address is free.
        return { data: false, error: null };
      },
      auth: {
        admin: {
          getUserById: async (userId: string) => ({
            data: { user: { id: userId, email: f.FIXTURE_EMAIL, new_email: PENDING_EMAIL } },
            error: null,
          }),
          generateLink: async (args: { type: string; email: string }) => {
            state.minted.push({ type: args.type, email: args.email });
            return {
              // GoTrue's hashed token is a sha224 in hex: 56 characters.
              data: { properties: { hashed_token: 'ef'.repeat(28), email_otp: '000000' } },
              error: null,
            };
          },
        },
      },
    }),
  };
});

import { readVerifiedSessionClaims } from '@/lib/auth/verified-claims';
import { createClient } from '@/lib/supabase/server';
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

import {
  cancelEmailChangeAction,
  requestEmailChangeAction,
  resendEmailChangeAction,
} from './email-change';

const MEMBER = FIXTURE_USER_ID;
const OTHER = '33333333-3333-4333-8333-333333333333';
const OTHER_SESSION = '44444444-4444-4444-8444-444444444444';
const OTHER_EMAIL = 'other@example.test';
const MEMBER_REFRESH = 'member-own-refresh';
const OTHER_REFRESH = 'other-refresh';
const PENDING_EMAIL = 'pending@example.test';

const INPUT = { newEmail: 'new-address@example.test', currentPassword: 'the-member-password' };

/**
 * The actions' round trips, in order: getUser() (0-300 ms), then the account
 * status read (300-600). Crossing 150 ms in renews the session at the status
 * read, the first read after getUser().
 */
const CROSSES_AFTER_GET_USER = 150;
const NEVER = 3_600_000;

let projectKey: SigningKey;
let server: FakeAuthServer;
/** Auth server requests, by path, in order. */
let authCalls: string[];

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

/** PostgREST: the account status read (no account here is disabled). */
function rest(url: URL, subject: string | null): Response {
  const name = url.pathname.replace('/rest/v1/', '');
  if (name === 'user_profiles' && subject) return Response.json([{ disabled_at: null }]);
  return Response.json({ message: `no fake for ${name}` }, { status: 404 });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-02T03:00:00.000Z'));
  server = fakeAuthServer(projectKey);
  authCalls = [];
  state.minted = [];
  state.cancelled = [];
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
    email: sub === MEMBER ? FIXTURE_EMAIL : OTHER_EMAIL,
    sessionId: sub === MEMBER ? FIXTURE_SESSION_ID : OTHER_SESSION,
    ...(aal === 'aal2' ? { totpAgeSeconds } : {}),
  });
}

/**
 * The member's session at `aal`, carrying `refreshToken`, with `expires_at`
 * reaching the 90 s margin `crossesInMs` after the action starts.
 */
async function memberSignedIn(aal: 'aal1' | 'aal2', refreshToken: string, crossesInMs: number) {
  const claims = claimsOf(MEMBER, aal, 60);
  jar = sessionCookies(await signAccessToken(projectKey, claims), claims, {
    refreshToken,
    expiresAt: (Date.now() + 90_000 + crossesInMs) / 1000,
  });
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

const CODE_REQUIRED = { code: 'forbidden', details: { reason: 'aal2_required' } };

describe('email change: the step-up is decided from the validated account only', () => {
  for (const kind of [
    { label: 'an account with no authenticator', aal: 'aal1' as const, enrolled: false },
    { label: 'an account with an authenticator at aal2', aal: 'aal2' as const, enrolled: true },
  ]) {
    it(`start: a member with an authenticator at aal1 is asked for the code, and no link is minted, when the session read after getUser() is not theirs (${kind.label})`, async () => {
      await memberSignedIn('aal1', OTHER_REFRESH, CROSSES_AFTER_GET_USER);
      await grant(OTHER_REFRESH, OTHER, kind.aal, kind.enrolled);
      const result = await requestEmailChangeAction(INPUT);
      expect(result).toMatchObject({ ok: false, error: CODE_REQUIRED });
      expect(state.minted).toEqual([]);
      expect(authCalls).toContain('/token');
    });

    it(`resend: the same (${kind.label})`, async () => {
      await memberSignedIn('aal1', OTHER_REFRESH, CROSSES_AFTER_GET_USER);
      await grant(OTHER_REFRESH, OTHER, kind.aal, kind.enrolled);
      const result = await resendEmailChangeAction();
      expect(result).toMatchObject({ ok: false, error: CODE_REQUIRED });
      expect(state.minted).toEqual([]);
      expect(authCalls).toContain('/token');
    });
  }
});

describe('email change: controls', () => {
  it('the member at aal2, their own session renewed at the same moment: both links are minted', async () => {
    await memberSignedIn('aal2', MEMBER_REFRESH, CROSSES_AFTER_GET_USER);
    await grant(MEMBER_REFRESH, MEMBER, 'aal2');
    const result = await requestEmailChangeAction(INPUT);
    expect(result).toMatchObject({ ok: true, data: { pendingEmail: INPUT.newEmail } });
    expect(state.minted.map((m) => m.type)).toEqual(['email_change_current', 'email_change_new']);
    expect(authCalls).toContain('/token');
  });

  it('the member with an authenticator at aal1 and no renewal is asked for the code', async () => {
    await memberSignedIn('aal1', OTHER_REFRESH, NEVER);
    const result = await requestEmailChangeAction(INPUT);
    expect(result).toMatchObject({ ok: false, error: CODE_REQUIRED });
    expect(state.minted).toEqual([]);
  });

  it('a member with no authenticator starts and resends without a code', async () => {
    server.unenrolledUsers.add(MEMBER);
    await memberSignedIn('aal1', OTHER_REFRESH, NEVER);
    expect(await requestEmailChangeAction(INPUT)).toMatchObject({ ok: true });
    expect(await resendEmailChangeAction()).toMatchObject({
      ok: true,
      data: { pendingEmail: PENDING_EMAIL },
    });
    expect(state.minted).toHaveLength(4);
  });

  it('cancel asks for no code, as before', async () => {
    await memberSignedIn('aal1', OTHER_REFRESH, CROSSES_AFTER_GET_USER);
    await grant(OTHER_REFRESH, OTHER, 'aal1', false);
    const result = await cancelEmailChangeAction();
    expect(result).toEqual({ ok: true, data: { cancelled: true } });
    expect(state.cancelled).toEqual([MEMBER]);
  });
});

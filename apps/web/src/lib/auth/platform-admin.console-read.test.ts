import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Security invariant: checkPlatformConsoleRead() is the console's own rule
 * for a read the console polls (the attack map's Server Action), and it is
 * exactly what requirePlatformAdmin() asks of a page: a session, the verified
 * email on the allowlist, the session at aal2 outright, no passkey bridge.
 *
 * It is NOT the action check. checkPlatformAdmin() without a fresh step-up
 * serves an allowlisted account that has no authenticator on its password
 * alone; the console never does. So the first case here is that account, and
 * it is refused.
 *
 * Every refusal is the same frozen value, and nothing is thrown or
 * redirected. The same real session reads as platform-admin.gates.test.ts
 * (the fixture's ES256 keys and Auth server).
 */

const h = vi.hoisted(() => ({
  session: 'present' as 'present' | 'none' | 'redirects' | 'throws',
  bridge: { data: null, error: null } as { data: unknown; error: unknown },
  bridgeThrows: false,
  bridgeReads: 0,
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
      STOCKPILOT_PLATFORM_ADMIN_EMAILS: f.FIXTURE_EMAIL,
    },
  };
});
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => {
    if (h.bridgeThrows) throw new Error('no service client');
    return {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => {
              h.bridgeReads += 1;
              return h.bridge;
            },
          }),
        }),
      }),
    };
  },
}));
vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('NOT_FOUND');
  }),
}));
vi.mock('./session', () => {
  const session = {
    userId: '11111111-1111-4111-8111-111111111111',
    email: 'member@example.com',
    fullName: null,
    avatarUrl: null,
    defaultOrganizationId: null,
  };
  return {
    requireSession: vi.fn(async () => session),
    getServerSession: vi.fn(async () => {
      if (h.session === 'none') return null;
      if (h.session === 'redirects') {
        // What the session load raises for a disabled account.
        throw Object.assign(new Error('NEXT_REDIRECT'), {
          digest: 'NEXT_REDIRECT;replace;/account-disabled;307;',
        });
      }
      if (h.session === 'throws') throw new Error('the profile could not be read');
      return session;
    }),
  };
});

import {
  FIXTURE_USER_ID,
  fakeAuthServer,
  makeSigningKey,
  sessionClaims,
  sessionCookies,
  signAccessToken,
  withEditedPayload,
  type FakeAuthServer,
  type SigningKey,
} from '@/test/auth-session-fixture';

import {
  PLATFORM_CONSOLE_READ_REFUSED,
  checkPlatformAdmin,
  checkPlatformConsoleRead,
  requirePlatformAdmin,
} from './platform-admin';

let projectKey: SigningKey;
let server: FakeAuthServer;
let extraFactor: Record<string, unknown> | null = null;

beforeAll(async () => {
  projectKey = await makeSigningKey('project-kid-1');
});

beforeEach(() => {
  h.session = 'present';
  h.bridge = { data: null, error: null };
  h.bridgeThrows = false;
  h.bridgeReads = 0;
  extraFactor = null;
  server = fakeAuthServer(projectKey);
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await server.fetch(input as string, init);
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.endsWith('/user') || !extraFactor || res.status !== 200) return res;
    const body = (await res.json()) as { factors: unknown[] };
    body.factors = [...body.factors, extraFactor];
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  jar = new Map();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function signIn(claims: Record<string, unknown>, token?: string) {
  jar = sessionCookies(token ?? (await signAccessToken(projectKey, claims)), claims);
}

/** Refused, with THE refusal: the same frozen object every time. */
async function expectRefused() {
  const answer = await checkPlatformConsoleRead();
  expect(answer).toBe(PLATFORM_CONSOLE_READ_REFUSED);
  expect(answer).toEqual({ ok: false });
}

describe("checkPlatformConsoleRead: the page's rule, for a read the console polls", () => {
  it('an allowlisted account with NO authenticator, signed in with its password alone, is refused (the action check serves it)', async () => {
    server.unenrolledUsers.add(FIXTURE_USER_ID);
    await signIn(sessionClaims({ aal: 'aal1' }));
    // Why this check is its own: the action check says yes to this session.
    await expect(checkPlatformAdmin()).resolves.toMatchObject({ ok: true });
    // The console itself says no, and so does this check.
    await expect(requirePlatformAdmin()).rejects.toThrow('NOT_FOUND');
    await expectRefused();
  });

  it('an allowlisted account with an authenticator, on a session that has not entered its code, is refused', async () => {
    await signIn(sessionClaims({ aal: 'aal1' }));
    await expectRefused();
  });

  it('a verified aal2 session of an allowlisted account is served, however long ago the code was entered', async () => {
    await signIn(sessionClaims({ aal: 'aal2', totpAgeSeconds: 6 * 60 * 60 }));
    await expect(checkPlatformConsoleRead()).resolves.toEqual({ ok: true });
    await expect(requirePlatformAdmin()).resolves.toBeTruthy();
  });

  it('an account that is not on the allowlist is refused, at aal2 too', async () => {
    await signIn(sessionClaims({ aal: 'aal2', totpAgeSeconds: 60, email: 'someone@example.test' }));
    await expectRefused();
    // The bridge table is never read for it.
    expect(h.bridgeReads).toBe(0);
  });

  it('no session is refused, and nothing is asked of Auth', async () => {
    h.session = 'none';
    await signIn(sessionClaims({ aal: 'aal2', totpAgeSeconds: 60 }));
    await expectRefused();
    expect(server.calls['/user'] ?? 0).toBe(0);
  });

  it('signed out is refused', async () => {
    await expectRefused();
  });

  it('a token edited to claim aal2 is refused', async () => {
    const real = await signAccessToken(projectKey, sessionClaims({ aal: 'aal1' }));
    const forged = sessionClaims({ aal: 'aal2', totpAgeSeconds: 10 });
    await signIn(forged, withEditedPayload(real, forged));
    await expectRefused();
  });

  it("a recorded passkey bridge, a factor with the bridge's name, and a bridge table that cannot be read are refused", async () => {
    await signIn(sessionClaims({ aal: 'aal2', totpAgeSeconds: 60 }));
    h.bridge = { data: { factor_id: 'f-1' }, error: null };
    await expectRefused();
    h.bridge = { data: null, error: { code: '57014', message: 'canceling statement' } };
    await expectRefused();
    h.bridge = { data: null, error: null };
    h.bridgeThrows = true;
    await expectRefused();
    h.bridgeThrows = false;
    extraFactor = {
      id: 'bridge-1',
      factor_type: 'totp',
      status: 'verified',
      friendly_name: 'sp-passkey-bridge-0123456789ab',
    };
    await expectRefused();
  });

  it('it never redirects and never throws: a redirect or an error from the session load is the same refusal', async () => {
    await signIn(sessionClaims({ aal: 'aal2', totpAgeSeconds: 60 }));
    h.session = 'redirects';
    await expectRefused();
    h.session = 'throws';
    await expectRefused();
  });

  it('the refusal cannot be changed by a caller', () => {
    expect(Object.isFrozen(PLATFORM_CONSOLE_READ_REFUSED)).toBe(true);
    expect(Object.keys(PLATFORM_CONSOLE_READ_REFUSED)).toEqual(['ok']);
  });
});

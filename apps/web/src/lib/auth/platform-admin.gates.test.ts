import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Security invariant: the platform console's gates (requirePlatformAdmin for
 * pages, checkPlatformAdmin for actions) take the session's AAL2 and its
 * fresh step-up from an access token whose signature has been checked.
 *
 * They read the level through auth.mfa.getAuthenticatorAssuranceLevel() on a
 * fresh server client (the cookie's token decoded unchecked, plus its stored
 * user object, logged by auth-js as "could be insecure"), and the step-up's
 * `amr` timestamps from getSession()'s token, decoded unchecked.
 *
 * Two halves. The REAL server client and auth-js run against the fixture's
 * ES256 keys and Auth server (src/test/auth-session-fixture.ts) for the
 * sessions a platform admin really has. A stub then lets the Auth server
 * vouch for the admin while the cookie's own decode disagrees with the
 * verified claims: the gates must follow the verified claims, which the old
 * reads did not.
 */

const mode = vi.hoisted(() => ({ client: 'real' as 'real' | 'stub', stub: null as unknown }));

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
vi.mock('@/lib/supabase/server', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/supabase/server')>();
  return {
    createClient: async () => (mode.client === 'real' ? real.createClient() : mode.stub),
  };
});

import {
  FIXTURE_EMAIL,
  FIXTURE_USER_ID,
  INSECURE_USER_WARNING,
  fakeAuthServer,
  makeSigningKey,
  sessionClaims,
  sessionCookies,
  signAccessToken,
  withEditedPayload,
  type FakeAuthServer,
  type SigningKey,
} from '@/test/auth-session-fixture';

import { checkPlatformAdmin, requirePlatformAdmin } from './platform-admin';

let projectKey: SigningKey;
let server: FakeAuthServer;
let warn: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  projectKey = await makeSigningKey('project-kid-1');
});

beforeEach(() => {
  mode.client = 'real';
  mode.stub = null;
  server = fakeAuthServer(projectKey);
  vi.stubGlobal('fetch', server.fetch);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  jar = new Map();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function signIn(claims: Record<string, unknown>, token?: string) {
  jar = sessionCookies(token ?? (await signAccessToken(projectKey, claims)), claims);
}

const insecureWarnings = () =>
  warn.mock.calls.filter((c: unknown[]) => INSECURE_USER_WARNING.test(String(c[0]))).length;

describe('platform gates, real session reads', () => {
  it('a verified AAL2 session opens the console, with no warning and one Auth call (the verified email)', async () => {
    await signIn(sessionClaims({ aal: 'aal2', totpAgeSeconds: 60 }));
    await expect(requirePlatformAdmin()).resolves.toMatchObject({ userId: FIXTURE_USER_ID });
    expect(insecureWarnings()).toBe(0);
    expect(server.calls['/user']).toBe(1);
  });

  it('a verified AAL1 session gets the 404', async () => {
    await signIn(sessionClaims({ aal: 'aal1' }));
    await expect(requirePlatformAdmin()).rejects.toThrow('NOT_FOUND');
  });

  it('a token edited to claim AAL2 gets the 404', async () => {
    const real = await signAccessToken(projectKey, sessionClaims({ aal: 'aal1' }));
    const forged = sessionClaims({ aal: 'aal2', totpAgeSeconds: 10 });
    await signIn(forged, withEditedPayload(real, forged));
    await expect(requirePlatformAdmin()).rejects.toThrow('NOT_FOUND');
  });

  it('a dangerous action passes with a step-up asserted a minute ago', async () => {
    await signIn(sessionClaims({ aal: 'aal2', totpAgeSeconds: 60 }));
    await expect(checkPlatformAdmin({ requireStepUp: true })).resolves.toMatchObject({ ok: true });
    expect(insecureWarnings()).toBe(0);
  });

  it('a dangerous action is refused when the step-up is 20 minutes old', async () => {
    await signIn(sessionClaims({ aal: 'aal2', totpAgeSeconds: 20 * 60 }));
    await expect(checkPlatformAdmin({ requireStepUp: true })).resolves.toEqual({
      ok: false,
      reason: 'aal2_required',
    });
  });

  it('an expired AAL2 token that cannot be refreshed is refused', async () => {
    await signIn(sessionClaims({ aal: 'aal2', totpAgeSeconds: 60, expiresIn: -120 }));
    const check = await checkPlatformAdmin({ requireStepUp: true });
    expect(check.ok).toBe(false);
  });
});

/**
 * GoTrue vouches for the admin (getUser), the verified claims are what
 * getClaims() returns, and the cookie's own decode (getSession,
 * getAuthenticatorAssuranceLevel) says AAL2 with a fresh TOTP.
 */
function vouchedAdmin(verified: Record<string, unknown> | null) {
  const now = Math.floor(Date.now() / 1000);
  const stored = {
    sub: FIXTURE_USER_ID,
    aal: 'aal2',
    amr: [{ method: 'totp', timestamp: now - 5 }],
  };
  const storedToken = `h.${Buffer.from(JSON.stringify(stored)).toString('base64url')}.s`;
  mode.client = 'stub';
  mode.stub = {
    auth: {
      getUser: async (jwt?: string) =>
        jwt
          ? { data: { user: null }, error: { name: 'AuthApiError', message: 'invalid JWT' } }
          : { data: { user: { id: FIXTURE_USER_ID, email: FIXTURE_EMAIL } }, error: null },
      getClaims: async () =>
        verified
          ? { data: { claims: verified }, error: null }
          : {
              data: null,
              error: { name: 'AuthInvalidJwtError', message: 'Invalid JWT signature' },
            },
      getSession: async () => ({ data: { session: { access_token: storedToken } }, error: null }),
      mfa: {
        getAuthenticatorAssuranceLevel: async () => ({
          data: {
            currentLevel: 'aal2',
            nextLevel: 'aal2',
            currentAuthenticationMethods: stored.amr,
          },
          error: null,
        }),
      },
    },
  };
}

describe('platform gates follow the VERIFIED claims, not the cookie', () => {
  it('verified AAL1, cookie AAL2: the console is a 404', async () => {
    vouchedAdmin({ sub: FIXTURE_USER_ID, aal: 'aal1', amr: [] });
    await expect(requirePlatformAdmin()).rejects.toThrow('NOT_FOUND');
  });

  it('claims that do not verify, cookie AAL2: the console is a 404', async () => {
    vouchedAdmin(null);
    await expect(requirePlatformAdmin()).rejects.toThrow('NOT_FOUND');
  });

  it('verified step-up 20 minutes old, cookie step-up 5 seconds old: refused', async () => {
    const now = Math.floor(Date.now() / 1000);
    vouchedAdmin({
      sub: FIXTURE_USER_ID,
      aal: 'aal2',
      amr: [{ method: 'totp', timestamp: now - 20 * 60 }],
    });
    await expect(checkPlatformAdmin({ requireStepUp: true })).resolves.toEqual({
      ok: false,
      reason: 'aal2_required',
    });
  });

  it('claims that do not verify, cookie step-up 5 seconds old: refused', async () => {
    vouchedAdmin(null);
    await expect(checkPlatformAdmin({ requireStepUp: true })).resolves.toEqual({
      ok: false,
      reason: 'aal2_required',
    });
  });
});

// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NextRequest } from 'next/server';

// updateSession() is the security spine of the app: every /dashboard,
// /platform and /onboarding request rides the identity it establishes.
// Contract pinned here (trust chain cited by lib/auth/platform-admin.ts +
// lib/auth/session.ts):
//   1. FAST PATH — auth.getClaims() verifies the session JWT locally
//      (asymmetric ES256 + JWKS); on success the x-stockpilot-user-id /
//      x-stockpilot-user-email headers are forwarded WITHOUT any
//      auth.getUser() network round trip.
//   2. SLOW PATH — when getClaims() can't establish identity (no session,
//      expired-and-unrefreshable, JWKS hiccup, malformed cookie/throw), the
//      middleware falls back to exactly the old auth.getUser() flow.
//   3. Identity headers are DELETED unless verification succeeded — a
//      client-supplied (forged) header can never survive the proxy.
//   4. Cookie writes issued by the auth client (token refresh) always land
//      on the outgoing response — pass-through AND redirect alike.
//   5. AUTH_ROUTES redirect behavior is unchanged, including the
//      /signin/mfa and /reset exemptions.

interface TestCookie {
  name: string;
  value: string;
  options?: Record<string, unknown>;
}

interface CookieAdapter {
  getAll: () => { name: string; value: string }[];
  setAll: (cookies: TestCookie[]) => void;
}

const getClaims = vi.fn();
const getUser = vi.fn();
// Captured per updateSession() call so tests can simulate the auth client
// writing refreshed cookies through the middleware's setAll plumbing.
let cookieAdapter: CookieAdapter | null = null;

vi.mock('@supabase/ssr', () => ({
  createServerClient: (_url: unknown, _key: unknown, opts: { cookies: CookieAdapter }) => {
    cookieAdapter = opts.cookies;
    return { auth: { getClaims, getUser } };
  },
}));

vi.mock('@/lib/env', () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: 'https://test.supabase.co',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'test-anon-key',
  },
}));

import {
  SESSION_HEADER_USER_EMAIL,
  SESSION_HEADER_USER_ID,
  updateSession,
} from './middleware';

const BASE = 'https://app.example.com';
const USER_ID = '11111111-1111-1111-1111-111111111111';
const USER_EMAIL = 'user@example.com';

function req(path: string, headers?: Record<string, string>): NextRequest {
  return new NextRequest(`${BASE}${path}`, { headers });
}

/** Headers NextResponse.next() forwards to the render, by convention
 *  encoded as x-middleware-request-<name> on the response. */
function forwardedHeader(res: Response, name: string): string | null {
  return res.headers.get(`x-middleware-request-${name}`);
}

function mockSignedInClaims() {
  getClaims.mockResolvedValue({
    data: {
      claims: { sub: USER_ID, email: USER_EMAIL, aal: 'aal1', role: 'authenticated' },
      header: { alg: 'ES256', typ: 'JWT', kid: 'test-kid' },
      signature: new Uint8Array(),
    },
    error: null,
  });
}

function mockSignedOut() {
  // No session at all: getClaims resolves data:null/error:null and the
  // getUser fallback resolves user:null (both without a network call).
  getClaims.mockResolvedValue({ data: null, error: null });
  getUser.mockResolvedValue({ data: { user: null }, error: { name: 'AuthSessionMissingError' } });
}

beforeEach(() => {
  vi.clearAllMocks();
  cookieAdapter = null;
});

describe('updateSession — fast path (local getClaims verify)', () => {
  it('forwards identity headers from verified claims WITHOUT calling getUser', async () => {
    mockSignedInClaims();

    const res = await updateSession(req('/dashboard/items?tab=books'));

    expect(res.status).toBe(200);
    expect(forwardedHeader(res, SESSION_HEADER_USER_ID)).toBe(USER_ID);
    expect(forwardedHeader(res, SESSION_HEADER_USER_EMAIL)).toBe(USER_EMAIL);
    expect(forwardedHeader(res, 'x-pathname')).toBe('/dashboard/items');
    expect(forwardedHeader(res, 'x-nonce')).toBeTruthy();
    // The whole point of the change: zero GoTrue round trips on the warm path.
    expect(getUser).not.toHaveBeenCalled();
  });

  it('applies token-refresh cookies written during getClaims (near-expiry refresh)', async () => {
    // no-arg getClaims() loads the session via getSession(), which refreshes
    // a near-expiry token and writes new cookies through setAll BEFORE the
    // local verify. Those cookies must land on the outgoing response.
    getClaims.mockImplementation(async () => {
      cookieAdapter?.setAll([{ name: 'sb-test-auth-token', value: 'refreshed', options: {} }]);
      return {
        data: {
          claims: { sub: USER_ID, email: USER_EMAIL },
          header: { alg: 'ES256', typ: 'JWT', kid: 'test-kid' },
          signature: new Uint8Array(),
        },
        error: null,
      };
    });

    const res = await updateSession(req('/dashboard'));

    expect(res.status).toBe(200);
    expect(res.cookies.get('sb-test-auth-token')?.value).toBe('refreshed');
    expect(forwardedHeader(res, SESSION_HEADER_USER_ID)).toBe(USER_ID);
    expect(getUser).not.toHaveBeenCalled();
  });
});

describe('updateSession — slow path (getUser network fallback)', () => {
  it('falls back to getUser when getClaims errors, keeping refresh cookies', async () => {
    getClaims.mockResolvedValue({ data: null, error: { name: 'AuthUnknownError' } });
    getUser.mockImplementation(async () => {
      // Simulate the refresh that getUser's session load performs.
      cookieAdapter?.setAll([{ name: 'sb-test-auth-token', value: 'refreshed', options: {} }]);
      return { data: { user: { id: USER_ID, email: USER_EMAIL } }, error: null };
    });

    const res = await updateSession(req('/dashboard'));

    expect(getUser).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
    expect(forwardedHeader(res, SESSION_HEADER_USER_ID)).toBe(USER_ID);
    expect(forwardedHeader(res, SESSION_HEADER_USER_EMAIL)).toBe(USER_EMAIL);
    expect(res.cookies.get('sb-test-auth-token')?.value).toBe('refreshed');
  });

  it('falls back to getUser when getClaims THROWS instead of 500ing', async () => {
    // getClaims rethrows non-Auth errors (e.g. WebCrypto failures on a
    // garbage JWK). The middleware must trap that and let getUser decide.
    getClaims.mockRejectedValue(new TypeError('malformed key data'));
    getUser.mockResolvedValue({ data: { user: { id: USER_ID, email: USER_EMAIL } }, error: null });

    const res = await updateSession(req('/dashboard'));

    expect(res.status).toBe(200);
    expect(forwardedHeader(res, SESSION_HEADER_USER_ID)).toBe(USER_ID);
  });
});

describe('updateSession — signed-out gating', () => {
  it('redirects protected paths to /signin with the redirect param', async () => {
    mockSignedOut();

    const res = await updateSession(req('/dashboard/items?tab=books'));

    expect(res.status).toBe(307);
    // nextUrl.clone() keeps the original query alongside the redirect param —
    // longstanding behavior, pinned as-is.
    const location = new URL(res.headers.get('location') ?? '');
    expect(location.origin + location.pathname).toBe(`${BASE}/signin`);
    expect(location.searchParams.get('redirect')).toBe('/dashboard/items?tab=books');
  });

  it('carries auth-client cookie writes onto the redirect response', async () => {
    // An expired session whose refresh FAILS: the client clears its cookies
    // via setAll; those deletions must ride the redirect.
    getClaims.mockImplementation(async () => {
      cookieAdapter?.setAll([{ name: 'sb-test-auth-token', value: '', options: {} }]);
      return { data: null, error: { name: 'AuthApiError' } };
    });
    getUser.mockResolvedValue({ data: { user: null }, error: { name: 'AuthApiError' } });

    const res = await updateSession(req('/platform'));

    expect(res.status).toBe(307);
    expect(res.cookies.get('sb-test-auth-token')?.value).toBe('');
  });

  it('DELETES forged identity headers on non-protected matched routes', async () => {
    mockSignedOut();

    const res = await updateSession(
      req('/invite/abc123', {
        [SESSION_HEADER_USER_ID]: 'attacker-id',
        [SESSION_HEADER_USER_EMAIL]: 'admin@stockpilotusa.com',
      }),
    );

    // Passes through (not a protected prefix) but the forged identity is gone.
    expect(res.status).toBe(200);
    expect(forwardedHeader(res, SESSION_HEADER_USER_ID)).toBeNull();
    expect(forwardedHeader(res, SESSION_HEADER_USER_EMAIL)).toBeNull();
    const overridden = res.headers.get('x-middleware-override-headers') ?? '';
    expect(overridden).not.toContain(SESSION_HEADER_USER_ID);
    expect(overridden).not.toContain(SESSION_HEADER_USER_EMAIL);
  });

  it('lets anonymous users reach auth routes untouched', async () => {
    mockSignedOut();

    const res = await updateSession(req('/signin'));

    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
    expect(forwardedHeader(res, SESSION_HEADER_USER_ID)).toBeNull();
  });
});

describe('updateSession — signed-in AUTH_ROUTES behavior (unchanged)', () => {
  it('bounces a signed-in user from /signin to /dashboard', async () => {
    mockSignedInClaims();

    const res = await updateSession(req('/signin?redirect=%2Fdashboard%2Fitems'));

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe(`${BASE}/dashboard`);
  });

  it('keeps /signin/mfa reachable while signed in (AAL1 challenge page)', async () => {
    mockSignedInClaims();

    const res = await updateSession(req('/signin/mfa'));

    expect(res.status).toBe(200);
    expect(forwardedHeader(res, SESSION_HEADER_USER_ID)).toBe(USER_ID);
  });

  it('keeps the whole /reset tree reachable while signed in', async () => {
    mockSignedInClaims();

    for (const path of ['/reset', '/reset/complete', '/reset?error=link_expired']) {
      const res = await updateSession(req(path));
      expect(res.status, path).toBe(200);
    }
  });
});

// Auth helpers for k6 load tests.
//
// StockPilot uses Supabase Auth. Two ways to authenticate from k6:
//
// 1. Supabase password grant (signIn): POST email+password to
//    {SUPABASE_URL}/auth/v1/token?grant_type=password. Returns
//    { access_token, refresh_token, ... }. Cleanest path because k6 can
//    do it programmatically without a browser.
//
// 2. Pre-issued JWT shortcut (preIssuedToken): user signs in once in
//    the browser, copies the access_token out of devtools (or via the
//    Supabase JS client), and passes it as SUPABASE_ACCESS_TOKEN. Skips
//    auth dance entirely — useful when MFA blocks the password grant.
//
// Both return a `bearer` string that you attach via:
//
//   const headers = { Authorization: `Bearer ${bearer}`, ... };
//
// IMPORTANT: This works for /api/* routes (StockPilot's withApiContext
// honors `Authorization: Bearer <token>` in apps/web/src/lib/auth/
// api-context.ts). SSR dashboard pages like /dashboard/inventory read
// the session from sb-*-auth-token cookies set by @supabase/ssr — k6
// cannot easily forge those without running the full OAuth/PKCE flow.
// Scenarios that hit SSR pages either need a real browser tool
// (Playwright/Browser-k6) OR a pre-recorded cookie pasted in via
// SUPABASE_AUTH_COOKIE. See README for tradeoffs.

import http from 'k6/http';
import { check, fail } from 'k6';

/**
 * Sign in via Supabase password grant. Returns an access_token (JWT).
 * Fails the iteration loudly if creds are wrong — we want load tests
 * to break fast, not silently 401 everything.
 *
 * @param {string} supabaseUrl  e.g. https://abcd.supabase.co
 * @param {string} supabaseAnonKey
 * @param {string} email
 * @param {string} password
 * @returns {string} access_token
 */
export function signIn(supabaseUrl, supabaseAnonKey, email, password) {
  if (!supabaseUrl) fail('signIn: supabaseUrl is required');
  if (!supabaseAnonKey) fail('signIn: supabaseAnonKey is required');
  if (!email || !password) fail('signIn: email and password are required');

  const res = http.post(
    `${supabaseUrl}/auth/v1/token?grant_type=password`,
    JSON.stringify({ email, password }),
    {
      headers: {
        'Content-Type': 'application/json',
        apikey: supabaseAnonKey,
      },
      tags: { name: 'auth/signIn' },
    },
  );

  const ok = check(res, {
    'signIn returned 200': (r) => r.status === 200,
    'signIn returned access_token': (r) => {
      try {
        return typeof r.json('access_token') === 'string';
      } catch (_e) {
        return false;
      }
    },
  });

  if (!ok) {
    fail(`signIn failed: status=${res.status} body=${res.body}`);
  }
  return res.json('access_token');
}

/**
 * Return a bearer token resolved from env. Prefers SUPABASE_ACCESS_TOKEN
 * (pre-issued) over the username/password grant. Either is fine for
 * /api/* requests. Returns null if neither is configured.
 */
export function resolveBearer(env) {
  if (env.SUPABASE_ACCESS_TOKEN && env.SUPABASE_ACCESS_TOKEN.length > 10) {
    return env.SUPABASE_ACCESS_TOKEN;
  }
  if (env.SUPABASE_URL && env.SUPABASE_ANON_KEY && env.TEST_EMAIL && env.TEST_PASSWORD) {
    return signIn(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, env.TEST_EMAIL, env.TEST_PASSWORD);
  }
  return null;
}

/**
 * Build the standard Authorization header used by /api/* requests.
 * Throws if bearer is missing for scenarios that require auth.
 */
export function authHeaders(bearer, extra = {}) {
  if (!bearer) {
    fail(
      'authHeaders: no bearer token. Set SUPABASE_ACCESS_TOKEN or (SUPABASE_URL + SUPABASE_ANON_KEY + TEST_EMAIL + TEST_PASSWORD).',
    );
  }
  return {
    Authorization: `Bearer ${bearer}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...extra,
  };
}

/**
 * Build cookie header from SUPABASE_AUTH_COOKIE (pasted from devtools)
 * for SSR-page scenarios. Returns null if not set.
 */
export function sessionCookieHeader(env) {
  if (!env.SUPABASE_AUTH_COOKIE) return null;
  return { Cookie: env.SUPABASE_AUTH_COOKIE };
}

/**
 * Read BASE_URL — required for every scenario. Failing loudly here
 * prevents accidental prod hits via a forgotten env var.
 */
export function requireBaseUrl(env) {
  if (!env.BASE_URL) {
    fail('BASE_URL env var is required. Example: BASE_URL=https://preview-xxx.vercel.app');
  }
  return env.BASE_URL.replace(/\/$/, '');
}

/**
 * Default ramp profile used across scenarios: 0->50 in 30s, hold 50
 * for 60s, 50->0 in 30s. Overridable per scenario.
 */
export const DEFAULT_STAGES = [
  { duration: '30s', target: 50 },
  { duration: '1m', target: 50 },
  { duration: '30s', target: 0 },
];

/**
 * Default thresholds — fail the script if p95 latency > 1s or error
 * rate > 1%. Tune per scenario when a slower endpoint is acceptable.
 */
export const DEFAULT_THRESHOLDS = {
  http_req_duration: ['p(95)<1000'],
  http_req_failed: ['rate<0.01'],
};

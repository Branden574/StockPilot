// Scenario 02 — sign-in throughput.
//
// StockPilot has no /api/auth/signin endpoint — the production sign-in
// path is a React Server Action (apps/web/src/server/actions/auth.ts
// signInAction). Server Actions are not callable from k6 because their
// endpoint is content-hashed per build and the request body uses an
// undocumented multipart RSC encoding.
//
// What we CAN load-test is the upstream identity provider: Supabase
// Auth's password grant. Every sign-in eventually calls
// `supabase.auth.signInWithPassword({ email, password })`, which posts
// to {SUPABASE_URL}/auth/v1/token?grant_type=password. Hammering that
// endpoint measures the auth-server capacity that gates every login.
//
// Required env:
//   SUPABASE_URL          e.g. https://abcd.supabase.co
//   SUPABASE_ANON_KEY     project anon key
//   TEST_EMAIL            a real user in the test org
//   TEST_PASSWORD         that user's password
//
// SAFETY: do NOT enable this scenario unless you've created a test
// org with throwaway credentials. Repeatedly auth-grinding a real
// account will trip Supabase's rate limiter and may lock real users
// out. Default rate cap is ~30 sign-ins / 5min / IP.
//
// Run:
//   SUPABASE_URL=... SUPABASE_ANON_KEY=... TEST_EMAIL=... TEST_PASSWORD=... \
//     BASE_URL=https://preview-xxx.vercel.app \
//     ENABLE_SIGNIN=1 k6 run load-tests/k6/scenarios/02-signin.js

import http from 'k6/http';
import { check, sleep, fail } from 'k6';

import { DEFAULT_THRESHOLDS, requireBaseUrl } from '../lib/auth.js';

// Tighter ramp than DEFAULT_STAGES so we don't smoke the rate limiter
// instantly. Total run ~2min.
export const options = {
  stages: [
    { duration: '30s', target: 10 },
    { duration: '1m', target: 10 },
    { duration: '30s', target: 0 },
  ],
  thresholds: {
    ...DEFAULT_THRESHOLDS,
    // Allow 5% errors here — Supabase will throttle and that's expected.
    http_req_failed: ['rate<0.05'],
  },
};

// BASE_URL is read but the actual auth target is SUPABASE_URL. Keeping
// the same requireBaseUrl guard so the test surface is consistent.
requireBaseUrl(__ENV);

if (__ENV.ENABLE_SIGNIN !== '1') {
  fail(
    'Scenario 02 is disabled by default — pass ENABLE_SIGNIN=1 once you have a throwaway test user. See README rate-limit note.',
  );
}

const SUPABASE_URL = __ENV.SUPABASE_URL;
const SUPABASE_ANON_KEY = __ENV.SUPABASE_ANON_KEY;
const TEST_EMAIL = __ENV.TEST_EMAIL;
const TEST_PASSWORD = __ENV.TEST_PASSWORD;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !TEST_EMAIL || !TEST_PASSWORD) {
  fail(
    'Missing env. Set SUPABASE_URL, SUPABASE_ANON_KEY, TEST_EMAIL, TEST_PASSWORD.',
  );
}

export default function () {
  const res = http.post(
    `${SUPABASE_URL}/auth/v1/token?grant_type=password`,
    JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
    {
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_ANON_KEY,
      },
      tags: { name: 'POST supabase/auth/token' },
    },
  );
  check(res, {
    'signin 200 or 429 (rate-limited)': (r) => r.status === 200 || r.status === 429,
    'signin returned token on 200': (r) => {
      if (r.status !== 200) return true;
      try {
        return typeof r.json('access_token') === 'string';
      } catch (_e) {
        return false;
      }
    },
  });
  sleep(Math.random() * 1.5 + 0.5);
}

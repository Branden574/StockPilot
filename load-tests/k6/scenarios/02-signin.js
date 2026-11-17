// Scenario 02: sign-in throughput against the LOCAL Supabase Auth.
//
// The app's sign-in is a Server Action that calls
// supabase.auth.signInWithPassword, which posts to
// {supabase}/auth/v1/token?grant_type=password. This measures that call on the
// local stack. The seeded accounts have no password: give one local account
// a password first (it is never one of a real person) and pass it here.
//
//   LOADTEST_BASE_URL=http://127.0.0.1:3600 LOADTEST_SUPABASE_URL=http://127.0.0.1:58421 \
//   LOADTEST_SUPABASE_ANON_KEY=... LOADTEST_SIGNIN_EMAIL=... LOADTEST_SIGNIN_PASSWORD=... \
//     k6 run load-tests/k6/scenarios/02-signin.js
//
// The local stack's sign-in rate limit applies (config.toml [auth.rate_limit]
// sign_in_sign_ups); 429s count as failures here, so raise it on the stack the
// test runs against, never anywhere else.
import http from 'k6/http';
import { check, fail, sleep } from 'k6';

import { assertRequestUrl, localTarget } from '../lib/safety.js';

const { supabaseUrl } = localTarget(__ENV);

export const options = {
  stages: [
    { duration: '30s', target: 10 },
    { duration: '1m', target: 10 },
    { duration: '30s', target: 0 },
  ],
  thresholds: {
    checks: ['rate>0.99'],
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<1000'],
  },
};

const EMAIL = __ENV.LOADTEST_SIGNIN_EMAIL;
const PASSWORD = __ENV.LOADTEST_SIGNIN_PASSWORD;
const ANON = __ENV.LOADTEST_SUPABASE_ANON_KEY;
if (!EMAIL || !PASSWORD || !ANON) {
  fail('Set LOADTEST_SIGNIN_EMAIL, LOADTEST_SIGNIN_PASSWORD (a local account) and LOADTEST_SUPABASE_ANON_KEY.');
}

export default function () {
  const res = http.post(
    assertRequestUrl(`${supabaseUrl}/auth/v1/token?grant_type=password`),
    JSON.stringify({ email: EMAIL, password: PASSWORD }),
    {
      headers: { 'Content-Type': 'application/json', apikey: ANON },
      tags: { name: 'POST auth/v1/token', kind: 'api_read', role: 'signin' },
    },
  );
  check(res, {
    'sign-in 200 with a token': (r) => {
      if (r.status !== 200) return false;
      try {
        return typeof r.json('access_token') === 'string';
      } catch (_e) {
        return false;
      }
    },
  });
  sleep(Math.random() * 1.5 + 0.5);
}

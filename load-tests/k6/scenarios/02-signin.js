// Scenario 02: sign-in throughput against the LOCAL Supabase Auth.
//
// The app's sign-in is a Server Action that calls
// supabase.auth.signInWithPassword, which posts to
// {supabase}/auth/v1/token?grant_type=password. This measures that call on the
// local stack, for one seeded account (a made-up loadtest+...@example.com).
// Every seeded account's password is derived from the local stack's service
// key and its email (lib/auth.js accountPassword); setup() derives it, so only
// the email is needed:
//
//   set -a; . <loadtest env file>; set +a   # LOADTEST_* for the local stack, never printed
//   LOADTEST_SIGNIN_EMAIL=<a seeded account's email, from the manifest> \
//     k6 run load-tests/k6/scenarios/02-signin.js
//
// The local stack's sign-in rate limit applies (config.toml [auth.rate_limit]
// sign_in_sign_ups); 429s count as failures here, so raise it on the stack the
// test runs against, never anywhere else.
import http from 'k6/http';
import { check, fail, sleep } from 'k6';

import { accountPassword } from '../lib/auth.js';
import { assertRequestUrl, localTarget } from '../lib/safety.js';

const { supabaseUrl } = localTarget(__ENV);

export const options = {
  // A redirect is never followed: it is not a sign-in answer.
  maxRedirects: 0,
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
const ANON = __ENV.LOADTEST_SUPABASE_ANON_KEY;
if (!EMAIL || !ANON) {
  fail('Set LOADTEST_SIGNIN_EMAIL (a seeded account) and LOADTEST_SUPABASE_ANON_KEY.');
}
if (!/^loadtest\+[a-z0-9-]+@example\.com$/.test(EMAIL)) {
  fail('LOADTEST_SIGNIN_EMAIL must be a seeded load-test account (loadtest+...@example.com).');
}

// The service key is read here only, to derive the account's password.
export function setup() {
  const serviceKey = __ENV.LOADTEST_SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) fail('LOADTEST_SUPABASE_SERVICE_ROLE_KEY is not set (the local stack service key).');
  return { password: accountPassword(serviceKey, EMAIL) };
}

export default function (data) {
  const res = http.post(
    assertRequestUrl(`${supabaseUrl}/auth/v1/token?grant_type=password`),
    JSON.stringify({ email: EMAIL, password: data.password }),
    {
      redirects: 0,
      headers: { 'Content-Type': 'application/json', apikey: ANON },
      tags: { name: 'POST auth/v1/token', kind: 'auth', role: 'signin' },
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

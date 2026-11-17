// Scenario 99b: 250 anonymous visitors held for 2 minutes.
//
// Confirms the public pages hold steady under a sustained peak, not only a
// ramp: / , /signin, and /dashboard signed out (a redirect to sign-in is the
// right answer there). LOCAL ONLY: the address must be this machine
// (lib/safety.js) and there is no default.
//
//   LOADTEST_BASE_URL=http://127.0.0.1:3600 k6 run load-tests/k6/scenarios/99b-sustained-250.js
import http from 'k6/http';
import { check, sleep } from 'k6';

import { assertRequestUrl, localTarget } from '../lib/safety.js';

const BASE_URL = localTarget(__ENV, { needSupabase: false }).baseUrl;

export const options = {
  // A redirect is an answer to check, never followed off this machine.
  maxRedirects: 0,
  stages: [
    { duration: '15s', target: 250 },
    { duration: '2m', target: 250 },
    { duration: '15s', target: 0 },
  ],
  thresholds: {
    checks: ['rate>0.99'],
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<1500'],
  },
};

export default function () {
  const roll = Math.random();
  if (roll < 0.5) {
    const r = http.get(assertRequestUrl(`${BASE_URL}/`), { redirects: 0, tags: { route: 'home' } });
    check(r, { 'home 200': (x) => x.status === 200 });
  } else if (roll < 0.85) {
    const r = http.get(assertRequestUrl(`${BASE_URL}/signin`), {
      redirects: 0,
      tags: { route: 'signin' },
    });
    check(r, { 'signin 200': (x) => x.status === 200 });
  } else {
    const r = http.get(assertRequestUrl(`${BASE_URL}/dashboard`), {
      redirects: 0,
      tags: { route: 'dashboard-redirect' },
      responseCallback: http.expectedStatuses(307),
    });
    check(r, {
      'signed out: redirect to sign-in': (x) =>
        x.status === 307 && /\/signin/.test(x.headers.Location || ''),
    });
  }
  sleep(Math.random() * 0.4 + 0.1);
}

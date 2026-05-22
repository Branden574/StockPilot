// Scenario 99 — Capacity probe (anonymous routes only).
//
// Goal: find at what concurrent-user count the public surface starts
// to degrade (p95 > 1s, error rate > 1%). Safe to run against prod —
// only hits anon paths, NO writes, NO authenticated reads, NO Supabase
// auth grants.
//
// Hits four endpoints in a randomised mix to simulate real traffic
// shape:
//   - GET / (marketing landing — RSC + Tailwind)
//   - GET /signin (auth UI render)
//   - GET /dashboard (anon → 307 redirect — middleware cost only)
//   - POST /api/ai/chat with no auth cookie (fast-path 401 — withApiContext)
//
// Ramping load profile escalates 0 → 600 VUs over 5 minutes so we can
// see the breakpoint without a single fixed plateau (the existing
// DEFAULT_STAGES caps at 50, which doesn't push hard enough to find
// the ceiling).
//
// Run:
//   BASE_URL=https://stockpilotusa.com k6 run \
//     load-tests/k6/scenarios/99-capacity-anon.js \
//     --summary-export=load-tests/results/99-capacity-anon.json

import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Trend, Counter, Rate } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'https://stockpilotusa.com';

const homepageTrend = new Trend('homepage_ms');
const signinTrend = new Trend('signin_ms');
const redirectTrend = new Trend('dashboard_redirect_ms');
const apiAuthGateTrend = new Trend('api_auth_gate_ms');
const errors = new Counter('errors');
const fiveHundreds = new Counter('five_hundreds');
const ok = new Rate('responses_ok');

export const options = {
  // Stair-step ramp: each plateau is 30s so the system has time to
  // settle and metrics have enough samples to be meaningful.
  stages: [
    { duration: '20s', target: 10 },
    { duration: '30s', target: 10 },
    { duration: '20s', target: 50 },
    { duration: '30s', target: 50 },
    { duration: '20s', target: 100 },
    { duration: '30s', target: 100 },
    { duration: '20s', target: 250 },
    { duration: '30s', target: 250 },
    { duration: '20s', target: 500 },
    { duration: '30s', target: 500 },
    { duration: '20s', target: 0 },
  ],
  thresholds: {
    // Don't fail the run on threshold breaches — we WANT to find the
    // breakpoint. abortOnFail=false is the default; explicit for
    // clarity.
    http_req_duration: [{ threshold: 'p(95)<1500', abortOnFail: false }],
    http_req_failed: [{ threshold: 'rate<0.05', abortOnFail: false }],
  },
};

export default function () {
  // Weighted random pick — more realistic than even distribution.
  // Homepage and signin are the two most-hit public routes; the
  // anon dashboard hit and the API gate are both fast and worth
  // sampling to confirm middleware + fast-path 401 stay healthy
  // under load.
  const roll = Math.random();
  if (roll < 0.4) {
    group('GET /', () => {
      const r = http.get(`${BASE_URL}/`, { tags: { route: 'home' } });
      homepageTrend.add(r.timings.duration);
      checkResult(r, 'home');
    });
  } else if (roll < 0.7) {
    group('GET /signin', () => {
      const r = http.get(`${BASE_URL}/signin`, { tags: { route: 'signin' } });
      signinTrend.add(r.timings.duration);
      checkResult(r, 'signin');
    });
  } else if (roll < 0.9) {
    group('GET /dashboard (anon redirect)', () => {
      const r = http.get(`${BASE_URL}/dashboard`, {
        redirects: 0,
        tags: { route: 'dashboard-redirect' },
      });
      redirectTrend.add(r.timings.duration);
      check(r, { 'redirect 307': (x) => x.status === 307 });
      ok.add(r.status === 307);
      if (r.status >= 500) fiveHundreds.add(1);
    });
  } else {
    group('POST /api/ai/chat (anon → 401)', () => {
      const r = http.post(
        `${BASE_URL}/api/ai/chat`,
        JSON.stringify({ message: 'x' }),
        {
          headers: { 'Content-Type': 'application/json' },
          tags: { route: 'api-auth-gate' },
        },
      );
      apiAuthGateTrend.add(r.timings.duration);
      check(r, { 'auth gate 401': (x) => x.status === 401 });
      ok.add(r.status === 401);
      if (r.status >= 500) fiveHundreds.add(1);
    });
  }

  // 0.1-0.5s think time so each VU isn't pure-fire.
  sleep(Math.random() * 0.4 + 0.1);
}

function checkResult(r, label) {
  const isOk = r.status >= 200 && r.status < 400;
  ok.add(isOk);
  if (!isOk) errors.add(1, { label });
  if (r.status >= 500) fiveHundreds.add(1, { label });
  check(r, {
    [`${label} 2xx/3xx`]: () => isOk,
    [`${label} body present`]: () => r.body && r.body.length > 100,
  });
}

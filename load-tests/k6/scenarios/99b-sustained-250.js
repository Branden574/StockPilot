// Sustained 250-VU test for 2 minutes — confirms the system holds
// steady under a realistic peak operating load, not just a ramp.
//
// Run:
//   BASE_URL=https://stockpilotusa.com k6 run \
//     load-tests/k6/scenarios/99b-sustained-250.js

import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'https://stockpilotusa.com';

export const options = {
  stages: [
    { duration: '15s', target: 250 },
    { duration: '2m', target: 250 },
    { duration: '15s', target: 0 },
  ],
};

export default function () {
  const roll = Math.random();
  if (roll < 0.5) {
    const r = http.get(`${BASE_URL}/`, { tags: { route: 'home' } });
    check(r, { 'home 2xx': (x) => x.status === 200 });
  } else if (roll < 0.85) {
    const r = http.get(`${BASE_URL}/signin`, { tags: { route: 'signin' } });
    check(r, { 'signin 2xx': (x) => x.status === 200 });
  } else {
    const r = http.get(`${BASE_URL}/dashboard`, {
      redirects: 0,
      tags: { route: 'dashboard-redirect' },
    });
    check(r, { 'redirect 307': (x) => x.status === 307 });
  }
  sleep(Math.random() * 0.4 + 0.1);
}

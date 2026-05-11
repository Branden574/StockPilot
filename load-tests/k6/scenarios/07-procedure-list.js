// Scenario 07 — procedures list page.
//
// SSR GET /dashboard/procedures. Cookie-auth required (see scenario
// 03 for why bearer tokens don't work on SSR pages).
//
// Run:
//   BASE_URL=https://preview-xxx.vercel.app \
//     SUPABASE_AUTH_COOKIE='...' \
//     k6 run load-tests/k6/scenarios/07-procedure-list.js

import http from 'k6/http';
import { check, sleep } from 'k6';

import {
  DEFAULT_STAGES,
  DEFAULT_THRESHOLDS,
  requireBaseUrl,
  sessionCookieHeader,
} from '../lib/auth.js';

export const options = {
  stages: DEFAULT_STAGES,
  thresholds: DEFAULT_THRESHOLDS,
};

const BASE_URL = requireBaseUrl(__ENV);
const cookieHeader = sessionCookieHeader(__ENV);

export default function () {
  const res = http.get(`${BASE_URL}/dashboard/procedures`, {
    headers: cookieHeader ?? {},
    redirects: 0,
    tags: { name: 'GET /dashboard/procedures' },
  });
  check(res, {
    'procedures 200': (r) => r.status === 200,
    'procedures rendered': (r) => r.body && r.body.length > 500,
  });
  sleep(Math.random() * 2 + 1);
}

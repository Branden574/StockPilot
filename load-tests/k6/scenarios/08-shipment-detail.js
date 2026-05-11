// Scenario 08 — shipment detail.
//
// SSR GET /dashboard/shipments/[id]. Cookie-auth required.
//
// Required env:
//   SHIPMENT_IDS — comma-separated UUIDs of test shipments.
//
// Run:
//   BASE_URL=https://preview-xxx.vercel.app \
//     SUPABASE_AUTH_COOKIE='...' \
//     SHIPMENT_IDS='uuid1,uuid2' \
//     k6 run load-tests/k6/scenarios/08-shipment-detail.js

import http from 'k6/http';
import { check, sleep, fail } from 'k6';

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

const SHIPMENT_IDS = (__ENV.SHIPMENT_IDS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

if (SHIPMENT_IDS.length === 0) {
  fail('SHIPMENT_IDS env var is required (comma-separated UUIDs).');
}

function pickId() {
  return SHIPMENT_IDS[Math.floor(Math.random() * SHIPMENT_IDS.length)];
}

export default function () {
  const id = pickId();
  const res = http.get(`${BASE_URL}/dashboard/shipments/${id}`, {
    headers: cookieHeader ?? {},
    redirects: 0,
    tags: { name: 'GET /dashboard/shipments/[id]' },
  });
  check(res, {
    'shipment detail 200': (r) => r.status === 200,
    'shipment rendered': (r) => r.body && r.body.length > 500,
  });
  sleep(Math.random() * 2 + 1);
}

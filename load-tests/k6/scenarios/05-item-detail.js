// Scenario 05 — item detail pages.
//
// Hits GET /dashboard/inventory/[id] for a rotating set of item IDs.
// SSR page, so SUPABASE_AUTH_COOKIE is required (see scenario 03).
//
// Required env:
//   ITEM_IDS — comma-separated UUIDs of test items in your test org.
//              e.g. ITEM_IDS=abc-...,def-...,ghi-...
//
// Run:
//   BASE_URL=https://preview-xxx.vercel.app \
//     SUPABASE_AUTH_COOKIE='...' \
//     ITEM_IDS='uuid1,uuid2,uuid3' \
//     k6 run load-tests/k6/scenarios/05-item-detail.js

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

const ITEM_IDS = (__ENV.ITEM_IDS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

if (ITEM_IDS.length === 0) {
  fail(
    'ITEM_IDS env var is required — set to a comma-separated list of UUIDs from your test org.',
  );
}

function pickId() {
  return ITEM_IDS[Math.floor(Math.random() * ITEM_IDS.length)];
}

export default function () {
  const id = pickId();
  const url = `${BASE_URL}/dashboard/inventory/${id}`;
  const headers = cookieHeader ?? {};
  const res = http.get(url, {
    headers,
    redirects: 0,
    tags: { name: 'GET /dashboard/inventory/[id]' },
  });
  check(res, {
    'item detail 200': (r) => r.status === 200,
    'rendered detail body': (r) => r.body && r.body.length > 500,
  });
  sleep(Math.random() * 2 + 1);
}

// Scenario 03 — inventory list with random filters.
//
// Hits the SSR-rendered /dashboard/inventory page with varied query
// strings to exercise different code paths (?status=, ?stock=,
// ?cat=, ?q=, ?sort=). This page is the highest-traffic authenticated
// surface in the app.
//
// Authentication options:
//   A) SUPABASE_AUTH_COOKIE  — pasted from devtools after a manual
//      browser sign-in. Required for SSR pages because Next.js reads
//      the sb-*-auth-token cookie via @supabase/ssr. Bearer tokens
//      DO NOT work on SSR pages.
//   B) (fallback) request goes out without cookies; you'll measure
//      redirect-to-/signin latency, not real page-render latency.
//
// Run:
//   BASE_URL=https://preview-xxx.vercel.app \
//     SUPABASE_AUTH_COOKIE='sb-xxx-auth-token=...; sb-xxx-auth-token.0=...' \
//     k6 run load-tests/k6/scenarios/03-inventory-list.js

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

// Pre-baked filter combinations that mirror what real users click.
// Inspect apps/web/src/app/(dashboard)/dashboard/inventory/page.tsx —
// it accepts q, status, stock, type, page, sort, cat, loc.
const FILTERS = [
  '',
  '?status=active',
  '?status=archived',
  '?stock=low',
  '?stock=out',
  '?sort=name_asc',
  '?sort=qty_desc',
  '?sort=updated_desc',
  '?q=widget',
  '?q=screw',
  '?q=cable',
  '?status=active&stock=low',
  '?status=active&sort=qty_asc',
  '?page=2',
  '?page=3',
];

function pickFilter() {
  return FILTERS[Math.floor(Math.random() * FILTERS.length)];
}

export default function () {
  const filter = pickFilter();
  const url = `${BASE_URL}/dashboard/inventory${filter}`;

  const headers = cookieHeader ?? {};
  const res = http.get(url, {
    headers,
    redirects: 0, // Don't follow redirects — we want to know if we got bounced to /signin.
    tags: { name: 'GET /dashboard/inventory' },
  });

  check(res, {
    'authenticated (got 200 not 3xx)': (r) => r.status === 200,
    'page rendered': (r) => r.body && r.body.length > 500,
  });

  sleep(Math.random() * 2 + 1); // 1-3s think time
}

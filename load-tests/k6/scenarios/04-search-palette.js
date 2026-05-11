// Scenario 04 — command palette search.
//
// Hits GET /api/search?q=... — the cross-entity search backing ⌘K.
// Authenticated via bearer token (this is an API route, so the
// Authorization header path in withApiContext() works fine).
//
// The endpoint requires q.length >= 2; shorter queries return a
// trivial empty payload that doesn't exercise the DB. We seed a
// corpus of realistic terms.
//
// Run:
//   BASE_URL=https://preview-xxx.vercel.app \
//     SUPABASE_ACCESS_TOKEN=eyJ... \
//     k6 run load-tests/k6/scenarios/04-search-palette.js

import http from 'k6/http';
import { check, sleep } from 'k6';

import {
  DEFAULT_STAGES,
  DEFAULT_THRESHOLDS,
  authHeaders,
  requireBaseUrl,
  resolveBearer,
} from '../lib/auth.js';

export const options = {
  stages: DEFAULT_STAGES,
  thresholds: DEFAULT_THRESHOLDS,
};

const BASE_URL = requireBaseUrl(__ENV);

// resolveBearer is called in setup() so we only sign in once, not
// once per VU iteration. The returned value is passed to default().
export function setup() {
  const bearer = resolveBearer(__ENV);
  if (!bearer) {
    // We don't fail here — let default() fail with a clear message.
    return { bearer: null };
  }
  return { bearer };
}

// ~20 plausible search terms. Real-user corpus would be drawn from
// search analytics; until that exists, use common inventory nouns.
const TERMS = [
  'widget',
  'screw',
  'cable',
  'bolt',
  'nut',
  'washer',
  'box',
  'label',
  'tape',
  'shelf',
  'bin',
  'order',
  'PO-',
  'supplier',
  'warehouse',
  'pallet',
  'forklift',
  'sensor',
  'battery',
  'fuse',
];

function pickTerm() {
  return TERMS[Math.floor(Math.random() * TERMS.length)];
}

export default function (data) {
  const headers = authHeaders(data.bearer);
  const q = pickTerm();
  const res = http.get(`${BASE_URL}/api/search?q=${encodeURIComponent(q)}`, {
    headers,
    tags: { name: 'GET /api/search' },
  });
  check(res, {
    'search 200': (r) => r.status === 200,
    'search returned items array': (r) => {
      try {
        const json = r.json();
        return Array.isArray(json.items);
      } catch (_e) {
        return false;
      }
    },
  });
  sleep(Math.random() * 1 + 0.3); // 0.3-1.3s — palette spam is fast
}

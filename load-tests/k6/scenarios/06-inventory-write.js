// Scenario 06 — write throughput.
//
// IMPORTANT — REALITY CHECK on the brief:
// The brief asks for POST /api/v1/items (create) + PATCH for update.
// Those endpoints DO NOT EXIST in the current codebase. StockPilot
// performs item create/update via Next.js Server Actions
// (apps/web/src/server/actions/inventory.ts), which are NOT callable
// from k6 because their endpoint is content-hashed per build and uses
// an RSC-internal multipart encoding.
//
// To still get meaningful write capacity signal, this scenario calls
// the closest "real write" public API endpoint that exists:
//
//   POST /api/v1/po/[id]/receive-line  — records a received line on
//   a purchase order, which updates inventory_movements + bumps the
//   linked item's quantity_on_hand. Same DB load profile as the
//   server-action create path (single insert + trigger fan-out).
//
// Required env (in addition to BASE_URL + bearer):
//   ENABLE_WRITES=1               safety latch
//   PO_ID=<uuid>                  open PO in the test org
//   PO_LINE_ITEM_ID=<uuid>        line item on that PO to receive
//   PO_LINE_QTY=1                 quantity to receive per request (default 1)
//
// SAFETY: this WILL mutate state in the target org. Use a throwaway
// test org. Each run will add hundreds of receive events. Plan to
// either run a cleanup migration after or accept the noise.
//
// Run:
//   BASE_URL=https://preview-xxx.vercel.app \
//     SUPABASE_ACCESS_TOKEN=eyJ... \
//     ENABLE_WRITES=1 \
//     PO_ID=... PO_LINE_ITEM_ID=... \
//     k6 run load-tests/k6/scenarios/06-inventory-write.js

import http from 'k6/http';
import { check, sleep, fail } from 'k6';

import {
  DEFAULT_THRESHOLDS,
  authHeaders,
  requireBaseUrl,
  resolveBearer,
} from '../lib/auth.js';

// Lower VU ceiling than the read scenarios — writes are heavier and
// we don't want to DoS our own staging DB before measuring.
export const options = {
  stages: [
    { duration: '30s', target: 25 },
    { duration: '1m', target: 25 },
    { duration: '30s', target: 0 },
  ],
  thresholds: {
    ...DEFAULT_THRESHOLDS,
    // Writes are slower than reads — bump p95 ceiling.
    http_req_duration: ['p(95)<2000'],
  },
};

const BASE_URL = requireBaseUrl(__ENV);

if (__ENV.ENABLE_WRITES !== '1') {
  fail(
    'Scenario 06 is disabled by default. Pass ENABLE_WRITES=1 once you have a test org you do not mind polluting.',
  );
}

const PO_ID = __ENV.PO_ID;
const PO_LINE_ITEM_ID = __ENV.PO_LINE_ITEM_ID;
const PO_LINE_QTY = Number(__ENV.PO_LINE_QTY ?? '1');

if (!PO_ID || !PO_LINE_ITEM_ID) {
  fail('PO_ID and PO_LINE_ITEM_ID are required for scenario 06.');
}

export function setup() {
  const bearer = resolveBearer(__ENV);
  if (!bearer) {
    fail(
      'No bearer token available. Set SUPABASE_ACCESS_TOKEN or (SUPABASE_URL + SUPABASE_ANON_KEY + TEST_EMAIL + TEST_PASSWORD).',
    );
  }
  return { bearer };
}

export default function (data) {
  const headers = authHeaders(data.bearer);
  const payload = JSON.stringify({
    purchaseOrderItemId: PO_LINE_ITEM_ID,
    quantityReceived: PO_LINE_QTY,
  });
  const res = http.post(`${BASE_URL}/api/v1/po/${PO_ID}/receive-line`, payload, {
    headers,
    tags: { name: 'POST /api/v1/po/[id]/receive-line' },
  });
  check(res, {
    'receive-line 2xx': (r) => r.status >= 200 && r.status < 300,
  });
  sleep(Math.random() * 1 + 0.5);
}

// Scenario 01 — anonymous marketing pages.
//
// Hits the public-facing routes that any unauthenticated visitor can
// reach. Tests landing-page render cost (App Router RSC + Tailwind
// hydration). No auth.
//
// Run:
//   BASE_URL=https://preview-xxx.vercel.app k6 run load-tests/k6/scenarios/01-anon-marketing.js

import http from 'k6/http';
import { check, sleep, group } from 'k6';

import { DEFAULT_STAGES, DEFAULT_THRESHOLDS, requireBaseUrl } from '../lib/auth.js';

export const options = {
  stages: DEFAULT_STAGES,
  thresholds: DEFAULT_THRESHOLDS,
};

const BASE_URL = requireBaseUrl(__ENV);

// Note: there is no /features page in the current StockPilot codebase
// (only / and /pricing under apps/web/src/app/(marketing)/). We still
// probe /features to surface 404 latency — if it 404s consistently
// that's fine, but the thresholds will tolerate it via this group's
// own status check rather than http_req_failed.
const PAGES = ['/', '/pricing', '/features'];

export default function () {
  group('marketing pages', () => {
    for (const path of PAGES) {
      const res = http.get(`${BASE_URL}${path}`, {
        tags: { name: `GET ${path}` },
      });
      check(res, {
        [`${path} responded`]: (r) => r.status >= 200 && r.status < 500,
        [`${path} has body`]: (r) => r.body && r.body.length > 100,
      });
      sleep(Math.random() * 1 + 0.5); // 0.5-1.5s think time
    }
  });
}

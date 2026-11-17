// Scenario 01: anonymous marketing pages, / and /pricing.
//
// The public pages any visitor reaches, signed out. LOCAL ONLY: the address
// must be this machine (lib/safety.js). No manifest or keys needed.
//
// Run it through the runner (it starts the app under the outbound guard):
//   node --env-file=<loadtest env> load-tests/k6/run-scale.mjs --app-env <app env> \
//     --scenario scenarios/01-anon-marketing.js --ladder 1 --warmup 0
import http from 'k6/http';
import { check, group, sleep } from 'k6';

import { plainSummary } from '../lib/plain-summary.js';
import { assertRequestUrl, localTarget } from '../lib/safety.js';

const { baseUrl } = localTarget(__ENV, { needSupabase: false });

export const options = {
  // A redirect is an answer to check, never followed off this machine.
  maxRedirects: 0,
  stages: [
    { duration: '30s', target: 50 },
    { duration: '1m', target: 50 },
    { duration: '30s', target: 0 },
  ],
  thresholds: {
    checks: ['rate>0.99'],
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<1000'],
  },
};

const PAGES = ['/', '/pricing'];

export default function () {
  group('marketing pages', () => {
    for (const path of PAGES) {
      const res = http.get(assertRequestUrl(`${baseUrl}${path}`), {
        redirects: 0,
        tags: { name: `GET ${path}`, kind: 'ssr', role: 'anonymous' },
      });
      check(res, {
        [`${path} 200`]: (r) => r.status === 200,
        [`${path} has a page`]: (r) => typeof r.body === 'string' && r.body.length > 1000,
      });
      sleep(Math.random() + 0.5);
    }
  });
}

// The JSON summary run-scale.mjs reads (setup_data left out).
export function handleSummary(data) {
  return plainSummary(data);
}

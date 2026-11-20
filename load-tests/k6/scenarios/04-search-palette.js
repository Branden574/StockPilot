// Scenario 04: the search palette, GET /api/search.
//
// The route allows 120 searches a minute per person (search/route.ts), so the
// load is spread over every seeded staff, viewer and manager account (one
// session per VU) instead of one shared account: the per-person limit is not
// what this measures. Any 429 shows in rate_limited and fails the run through
// http_req_failed. LOCAL ONLY; needs the seeder manifest.
import { localTarget } from '../lib/safety.js';
import {
  buildOptions,
  iterate as runIteration,
  setupSessions,
  summarize,
} from '../lib/workload.js';

localTarget(__ENV);

const PLAN = {
  staff: { share: 0.5, actions: { web_search: 1 } },
  viewer: { share: 0.3, actions: { web_search: 1 } },
  manager: { share: 0.2, actions: { web_search: 1 } },
};
export const options = buildOptions(PLAN);
export function setup() {
  return setupSessions(PLAN);
}
export function iterate(data) {
  runIteration(PLAN, data);
}
export function handleSummary(data) {
  return summarize(data);
}

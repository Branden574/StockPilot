// Scenario 05: item pages, /dashboard/inventory/[id], signed in.
//
// Items come from the seeder manifest; each answer must be 200 and show the
// item's SKU. LOCAL ONLY.
import { localTarget } from '../lib/safety.js';
import { buildOptions, iterate as runIteration, setupSessions, summarize } from '../lib/workload.js';

localTarget(__ENV);

const PLAN = {
  staff: { share: 0.6, actions: { item_detail: 1 } },
  manager: { share: 0.4, actions: { item_detail: 1 } },
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

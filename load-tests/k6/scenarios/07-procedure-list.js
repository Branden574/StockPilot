// Scenario 07: the procedures page, /dashboard/procedures, signed in.
// LOCAL ONLY; needs the seeder manifest.
import { localTarget } from '../lib/safety.js';
import {
  buildOptions,
  iterate as runIteration,
  setupSessions,
  summarize,
} from '../lib/workload.js';

localTarget(__ENV);

const PLAN = {
  staff: { share: 0.6, actions: { procedures_list: 1 } },
  manager: { share: 0.4, actions: { procedures_list: 1 } },
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

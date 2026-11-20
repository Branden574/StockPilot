// Scenario 03: the items list, signed in.
//
// /dashboard/inventory pages 1-5 with filters, search and sorts, and the
// low-stock view, as staff and managers with real session cookies (built in
// setup() from the local stack; see lib/auth.js). A redirect to sign-in fails
// the run. LOCAL ONLY; needs the seeder manifest (see README).
import { localTarget } from '../lib/safety.js';
import {
  buildOptions,
  iterate as runIteration,
  setupSessions,
  summarize,
} from '../lib/workload.js';

localTarget(__ENV);

const PLAN = {
  staff: { share: 0.6, actions: { items_list: 4, low_stock: 1 } },
  manager: { share: 0.4, actions: { items_list: 4, low_stock: 1 } },
};
export const options = buildOptions(PLAN);
export function setup() {
  return setupSessions(PLAN, '/dashboard/inventory');
}
export function iterate(data) {
  runIteration(PLAN, data);
}
export function handleSummary(data) {
  return summarize(data);
}

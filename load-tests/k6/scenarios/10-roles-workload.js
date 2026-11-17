// Scenario 10: the signed-in workload, every role at once.
//
// Owners, admins, managers, staff, viewers and staff limited to one warehouse,
// each a constant-arrival-rate scenario sized from LOADTEST_ACTORS (concurrent
// people) and the role share in lib/workload.js. Web actions (items list pages
// 1-5 with filters and search, low stock, item detail, search, the order
// storefront page) think 3-8 s; phone actions (storefront, catalog,
// permissions, scan lookup, item history, place an order, adjust +1/-1,
// receive a purchase order line) think 1-3 s. Viewers try a write and must be
// refused; the one-warehouse staff probe the other warehouse and must see
// nothing of it.
//
// LOCAL ONLY. Run it through run-scale.mjs (its default scenario), which
// starts the app under the outbound guard, seeds, runs a ladder of rates and
// writes the report:
//   node --env-file=<loadtest env> load-tests/k6/run-scale.mjs --app-env <app env> --ladder 25,50
import { localTarget } from '../lib/safety.js';
import {
  buildOptions,
  defaultPlan,
  iterate as runIteration,
  setupSessions,
  summarize,
} from '../lib/workload.js';

localTarget(__ENV);

const PLAN = defaultPlan();
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

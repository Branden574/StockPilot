// Scenario 06: writes, as the phone app sends them.
//
//   POST /api/v1/items/[id]/adjust      {quantityChange: +1} then {-1}
//   POST /api/v1/po/[id]/receive-line   {itemId, qty, warehouseId, idempotencyKey}
//   POST /api/v1/orders                 the place-an-order body, with its key
// A share of receives and orders is sent twice with the same key and must
// answer the same receipt or order. Receiving is manager and above (the
// database function post_receipt_v2 refuses anyone below manager).
// Run tools/check-correctness.mjs afterwards (run-scale.sh does). LOCAL ONLY.
import { localTarget } from '../lib/safety.js';
import { buildOptions, iterate as runIteration, setupSessions, summarize } from '../lib/workload.js';

localTarget(__ENV);

const PLAN = {
  staff: { share: 0.6, actions: { adjust_pair: 2, place_order: 1 } },
  manager: { share: 0.4, actions: { adjust_pair: 1, receive_line: 2, place_order: 1 } },
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

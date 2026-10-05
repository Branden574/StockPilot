import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Call-site pins for the phone's Orders list (src/screens/orders.tsx), which
 * vitest cannot load (native modules). Each names the mutation it catches.
 */

const ROOT = path.resolve(__dirname, '../..');
/** Source with comments stripped, so a comment cannot satisfy a pin. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}
const orders = codeOnly(readFileSync(path.join(ROOT, 'src/screens/orders.tsx'), 'utf8'));

describe('the Orders list read', () => {
  // L107: after sign-out the list reloaded on focus with no user, as anon,
  // and logged a Postgres error. Mutation caught: the guard dropped, or only
  // the org checked.
  it('reads nothing without an organization and a signed-in user', () => {
    expect(orders).toMatch(/const load = React\.useCallback\(async \(\) => \{\s*if \(!orgId \|\| !userId\) return;/);
  });

  // L84: the approver's list could show pending_confirmation rows, the public
  // submissions not yet confirmed by email, which the web never lists
  // (OrderRequestsService.list). Mutation caught: the filter dropped.
  it('never lists orders still waiting for their email confirmation', () => {
    expect(orders).toMatch(/\.eq\('organization_id', orgId\)\s*\.neq\('status', 'pending_confirmation'\);/);
  });
});

describe('the order screen header (L83a)', () => {
  const screen = codeOnly(readFileSync(path.join(ROOT, 'app/order/[id].tsx'), 'utf8'));
  // Mutation caught: the raw key printed again ("PICKING IN PROGRESS").
  it('names the status through the tested helper, never its raw key', () => {
    // Re-pinned by returns RX-3 PR stage, polish (c) (was: without the
    // fulfilment): a completed pickup's header says HANDED OVER. In the
    // organization's own words since L83b (statusMeta, from the workspace).
    expect(screen).toMatch(
      /<Eyebrow>\s*\{orderHeaderEyebrow\(order\.orderNumber, order\.status, order\.fulfillmentType, statusMeta\)\}\s*<\/Eyebrow>/,
    );
    expect(screen).not.toContain("order.status.replace(/_/g, ' ')");
  });
});

describe("the order screen's returns cards (returns RX-3 PR stage, polish (d))", () => {
  const screen = codeOnly(readFileSync(path.join(ROOT, 'app/order/[id].tsx'), 'utf8'));
  // From the RX-2 Demo Co walk: a cancelled RMA's card read "Restock ·
  // pending". Mutation caught: the RMA's status not passed, so a denied or
  // cancelled RMA's unapplied line reads pending again.
  it("passes each RMA's status to the line row, so a denied or cancelled RMA's line reads not returned", () => {
    expect(screen).toMatch(/describeReturnLine\(\{[^}]*applied: rl\.applied,\s*returnStatus: r\.status,\s*\}\)/);
  });
});

// L83b: the organization's own status words and colours (Settings > Order
// statuses), read once with the workspace. Mutation caught: a screen that
// drops the org's map and prints core's defaults again.
describe("the organization's status names on every order screen (L83b)", () => {
  const detail = codeOnly(readFileSync(path.join(ROOT, 'app/order/[id].tsx'), 'utf8'));
  const placed = codeOnly(readFileSync(path.join(ROOT, 'app/order/new/placed.tsx'), 'utf8'));

  it('the order screen header reads the org map from the workspace store', () => {
    expect(detail).toContain('const statusMeta = useOrderStatusMeta();');
  });

  it('every Orders card pill uses the org map', () => {
    const card = orders.slice(orders.indexOf('function OrderCard('));
    expect(card).toContain('const statusMeta = useOrderStatusMeta();');
    expect(card).toContain('orderStatusPill(order.status, order.fulfillment_type, statusMeta)');
  });

  it('the placed screen names the status in the org words and colour too', () => {
    expect(placed).toContain('const statusMeta = useOrderStatusMeta();');
    expect(placed).toContain('<Pill status={orderStatusPill(order.status, null, statusMeta).status}>');
    expect(placed).toContain('{orderStatusLabel(order.status, statusMeta).toUpperCase()}');
  });
});

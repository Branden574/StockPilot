import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Assign delivery on the web order page (security slice D, migration 0390).
 * assignDelivery and assign_order_delivery ask orders:assign_delivery AND
 * orders:approve. The panel used to show the button to every approver, so a
 * staff member granted orders:approve alone pressed it and was refused; the
 * phone already asked both. The server page computes the second permission
 * and passes it down; this pins that wiring (the panel's own behaviour is in
 * manager-actions-panel.test.tsx).
 */
const PAGE = readFileSync(
  path.resolve(__dirname, '../../app/(dashboard)/dashboard/orders/[id]/page.tsx'),
  'utf8',
);
const PANEL = readFileSync(path.resolve(__dirname, 'manager-actions-panel.tsx'), 'utf8');

describe('Assign delivery follows both permissions on the web', () => {
  it('the page reads orders:assign_delivery, loads drivers only with both, and passes it to the panel', () => {
    expect(PAGE).toContain("const canAssignDelivery = can(ctx, 'orders:assign_delivery');");
    expect(PAGE).toContain(
      "const driversGate = canApprove && canAssignDelivery && request.status === 'staged_for_delivery';",
    );
    expect(PAGE).toContain('canAssignDelivery={canAssignDelivery}');
  });

  it('the panel renders the dialog only with both, hidden when the prop is left out', () => {
    expect(PANEL).toContain(
      "{status === 'staged_for_delivery' && canApprove && canAssignDelivery && (",
    );
    expect(PANEL).toContain('canAssignDelivery = false,');
  });
});

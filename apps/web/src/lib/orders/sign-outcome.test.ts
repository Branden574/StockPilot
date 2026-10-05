import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { signedOutcome } from './sign-outcome';

/**
 * L87: after a hand-over that left units owed, the sign page said "The order
 * is marked completed." although the order was backordered. The sign route
 * now answers the order's resulting status, and the panel's words follow it.
 */
describe('signedOutcome', () => {
  it('completed: says the order is completed and a receipt is on its way', () => {
    expect(signedOutcome('completed')).toEqual({
      message: 'The order is marked completed.',
      receiptOnItsWay: true,
      redirectTo: '/dashboard/orders?status=completed',
    });
  });

  it('backordered: says what was handed over is recorded and the rest stays on backorder', () => {
    expect(signedOutcome('backordered')).toEqual({
      message: 'What was handed over is recorded. The rest stays on backorder.',
      receiptOnItsWay: false,
      redirectTo: '/dashboard/orders?status=backordered',
    });
  });

  it('an unknown status claims nothing beyond the signature', () => {
    for (const status of [null, 'in_transit', 'something']) {
      expect(signedOutcome(status)).toEqual({
        message: 'Your signature is recorded.',
        receiptOnItsWay: false,
        redirectTo: '/dashboard/orders?status=all_active',
      });
    }
  });

  it('the sign page panel takes its words from it, and the on-behalf hint no longer promises completion', () => {
    const src = readFileSync(
      join(process.cwd(), 'src/components/orders/signature-collector.tsx'),
      'utf8',
    );
    expect(src).toContain('signedOutcome(');
    expect(src).not.toContain('The order is marked completed');
    expect(src).not.toContain('The order will be marked completed');
  });
});

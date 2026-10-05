import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { alreadySignedMessage, signedOutcome } from './sign-outcome';

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

/**
 * L87 (test stage): a used sign link said "looks like this order was already
 * completed. Check your inbox for the confirmation email." for every status,
 * so after a short hand-over it claimed a completion and an email that never
 * happen. Its words now follow the status the hand-over left.
 */
describe('alreadySignedMessage', () => {
  it('completed keeps the confirmation email line', () => {
    expect(alreadySignedMessage('completed')).toBe(
      'Thanks — looks like this order was already completed. Check your inbox for the confirmation email.',
    );
  });

  it('backordered says the rest stays on backorder and promises no email', () => {
    expect(alreadySignedMessage('backordered')).toBe(
      'Thanks. What was handed over is recorded. The rest stays on backorder.',
    );
  });

  it('any other status, or none, claims only the signature', () => {
    expect(alreadySignedMessage('cancelled')).toBe('Thanks. Your signature is recorded.');
    expect(alreadySignedMessage(null)).toBe('Thanks. Your signature is recorded.');
  });
});

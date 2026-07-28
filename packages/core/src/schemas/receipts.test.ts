import { describe, expect, it } from 'vitest';

import { postReceiptLineSchema } from './receipts';

const LINE = {
  poLineId: '11111111-1111-1111-1111-111111111111',
  qtyReceived: 2,
  qtyAccepted: 2,
  qtyRejected: 0,
};

/**
 * `.min(1)` ran BEFORE `.trim()`, so a whitespace-only serial ('   ') satisfied
 * the length check and then trimmed to ''. An empty serial reached
 * post_receipt_v2 and landed in serial_registry as a blank identifier — a
 * placeholder, which the sports requirements refuse outright ("Never send
 * placeholders"), and which no scan can ever match again.
 */
describe('postReceiptLineSchema — serials are trimmed BEFORE they are measured', () => {
  it('refuses a whitespace-only serial', () => {
    for (const blank of ['   ', '\t', '\n ']) {
      const parsed = postReceiptLineSchema.safeParse({ ...LINE, serials: [blank] });
      expect(parsed.success).toBe(false);
    }
  });

  it('refuses a blank serial hidden among good ones', () => {
    const parsed = postReceiptLineSchema.safeParse({
      ...LINE,
      serials: ['SN-0001', '  ', 'SN-0002'],
    });
    expect(parsed.success).toBe(false);
  });

  it('still trims and accepts a real serial with surrounding whitespace', () => {
    const parsed = postReceiptLineSchema.safeParse({ ...LINE, serials: ['  SN-0001  '] });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.serials).toEqual(['SN-0001']);
  });

  it('still accepts an omitted serials array (serial_optional)', () => {
    expect(postReceiptLineSchema.safeParse({ ...LINE }).success).toBe(true);
  });
});

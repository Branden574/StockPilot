import { describe, expect, it } from 'vitest';

import { buildPurchaseOrderFromPo } from './purchase-order';

describe('buildPurchaseOrderFromPo', () => {
  it('builds a single account-based PurchaseOrder line for the PO total', () => {
    const body = buildPurchaseOrderFromPo({
      vendorId: 'vendor-1',
      expenseAccountId: 'acct-9',
      amount: 123.456,
    });
    expect(body.VendorRef).toEqual({ value: 'vendor-1' });
    expect(body.Line).toHaveLength(1);
    expect(body.Line[0]).toEqual({
      DetailType: 'AccountBasedExpenseLineDetail',
      Amount: 123.46, // rounded 2dp
      AccountBasedExpenseLineDetail: { AccountRef: { value: 'acct-9' } },
    });
  });

  it('rounds the amount to 2 decimals (no binary-float drift)', () => {
    const body = buildPurchaseOrderFromPo({ vendorId: 'v', expenseAccountId: 'a', amount: 0.005 });
    expect(body.Line[0]?.Amount).toBe(0.01);
  });
});

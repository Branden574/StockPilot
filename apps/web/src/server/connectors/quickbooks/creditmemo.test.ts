import { describe, expect, it } from 'vitest';

import { buildCreditMemoFromReturn } from './creditmemo';

describe('buildCreditMemoFromReturn', () => {
  it('builds a one-line AccountBasedExpenseLineDetail CreditMemo with Amount = Σ qty×cost (2-dp)', () => {
    const body = buildCreditMemoFromReturn({
      customerId: 'cust-1',
      returnCreditAccountId: 'acct-47',
      lines: [{ quantity: 3, unitCost: 2 }],
    });

    expect(body).toEqual({
      CustomerRef: { value: 'cust-1' },
      Line: [
        {
          DetailType: 'AccountBasedExpenseLineDetail',
          Amount: 6,
          AccountBasedExpenseLineDetail: { AccountRef: { value: 'acct-47' } },
        },
      ],
    });
  });

  it('sums multiple lines and rounds the aggregate Amount to 2 decimal places', () => {
    const body = buildCreditMemoFromReturn({
      customerId: 'cust-2',
      returnCreditAccountId: 'acct-47',
      lines: [
        { quantity: 3, unitCost: 1.115 }, // 3.345
        { quantity: 2, unitCost: 0.1 }, // 0.2
      ],
    });

    // 3.345 + 0.2 = 3.545 -> round2 -> 3.55 (single aggregate line + round2)
    expect(body.Line).toHaveLength(1);
    expect(body.Line[0]!.Amount).toBe(3.55);
    expect(body.Line[0]!.AccountBasedExpenseLineDetail.AccountRef.value).toBe('acct-47');
  });

  it('omits CustomerRef entirely when no customer id is supplied', () => {
    const body = buildCreditMemoFromReturn({
      returnCreditAccountId: 'acct-47',
      lines: [{ quantity: 1, unitCost: 9.99 }],
    });

    expect(body.CustomerRef).toBeUndefined();
    expect(body.Line[0]!.Amount).toBe(9.99);
  });
});

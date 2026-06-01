import { describe, expect, it } from 'vitest';

import { buildReturnCreditJournalEntry } from './creditmemo';

describe('buildReturnCreditJournalEntry', () => {
  it('builds a BALANCED two-line JournalEntry: Debit inventoryAsset / Credit returnCredit, Amount = Σ qty×cost (2-dp)', () => {
    const body = buildReturnCreditJournalEntry({
      returnCreditAccountId: 'acct-47',
      inventoryAssetAccountId: 'acct-12',
      lines: [{ quantity: 3, unitCost: 2 }],
      txnDate: '2026-05-31',
    });

    expect(body).toEqual({
      TxnDate: '2026-05-31',
      Line: [
        {
          DetailType: 'JournalEntryLineDetail',
          Amount: 6,
          JournalEntryLineDetail: {
            PostingType: 'Debit',
            AccountRef: { value: 'acct-12' },
          },
        },
        {
          DetailType: 'JournalEntryLineDetail',
          Amount: 6,
          JournalEntryLineDetail: {
            PostingType: 'Credit',
            AccountRef: { value: 'acct-47' },
          },
        },
      ],
    });
  });

  it('produces a valid QBO JournalEntry shape: exactly one Debit + one Credit, balanced, no CustomerRef', () => {
    const body = buildReturnCreditJournalEntry({
      returnCreditAccountId: 'acct-47',
      inventoryAssetAccountId: 'acct-12',
      lines: [{ quantity: 2, unitCost: 4 }],
      txnDate: '2026-05-31',
    });

    // CustomerRef must NOT be present — a return-value posting has no customer.
    expect((body as unknown as Record<string, unknown>).CustomerRef).toBeUndefined();
    // Every line must be a JournalEntryLineDetail (never AccountBasedExpenseLineDetail,
    // which is purchase-side only and invalid on a JournalEntry).
    const lines = body.Line;
    expect(lines).toHaveLength(2);
    for (const l of lines) {
      expect(l.DetailType).toBe('JournalEntryLineDetail');
      expect(l.JournalEntryLineDetail.PostingType).toMatch(/^(Debit|Credit)$/);
    }
    const debits = lines.filter((l) => l.JournalEntryLineDetail.PostingType === 'Debit');
    const credits = lines.filter((l) => l.JournalEntryLineDetail.PostingType === 'Credit');
    expect(debits).toHaveLength(1);
    expect(credits).toHaveLength(1);
    // Balanced: Σ debits === Σ credits (QBO rejects an unbalanced entry).
    const sum = (arr: typeof lines) => arr.reduce((s, l) => s + l.Amount, 0);
    expect(sum(debits)).toBe(sum(credits));
  });

  it('sums multiple lines and rounds the aggregate Amount to 2 decimal places (still balanced)', () => {
    const body = buildReturnCreditJournalEntry({
      returnCreditAccountId: 'acct-47',
      inventoryAssetAccountId: 'acct-12',
      lines: [
        { quantity: 3, unitCost: 1.115 }, // 3.345
        { quantity: 2, unitCost: 0.1 }, // 0.2
      ],
      txnDate: '2026-05-31',
    });

    // 3.345 + 0.2 = 3.545 -> round2 -> 3.55 on BOTH the debit and credit line.
    expect(body.Line).toHaveLength(2);
    expect(body.Line[0]!.Amount).toBe(3.55);
    expect(body.Line[1]!.Amount).toBe(3.55);
    expect(body.Line[0]!.JournalEntryLineDetail.AccountRef.value).toBe('acct-12');
    expect(body.Line[1]!.JournalEntryLineDetail.AccountRef.value).toBe('acct-47');
  });
});

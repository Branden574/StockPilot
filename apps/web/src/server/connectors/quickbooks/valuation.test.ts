import { describe, expect, it } from 'vitest';

import { buildInventoryValuationJE } from './valuation';

/**
 * The journal entry MUST balance (Σ debits === Σ credits). A positive delta
 * (inventory grew) debits the inventory-asset account and credits the offset;
 * a negative delta swaps them. A zero delta produces no JE.
 */
function sumByPosting(
  je: NonNullable<ReturnType<typeof buildInventoryValuationJE>>,
  posting: 'Debit' | 'Credit',
): number {
  return je.Line.filter((l) => l.JournalEntryLineDetail.PostingType === posting).reduce(
    (sum, l) => sum + l.Amount,
    0,
  );
}

describe('buildInventoryValuationJE', () => {
  it('positive delta: Debit inventoryAsset / Credit valuationOffset, both Amount=delta', () => {
    const je = buildInventoryValuationJE({
      deltaValue: 100,
      inventoryAssetId: 'A',
      valuationOffsetId: 'B',
      txnDate: '2026-05-31',
    });

    expect(je).toEqual({
      TxnDate: '2026-05-31',
      Line: [
        {
          DetailType: 'JournalEntryLineDetail',
          Amount: 100,
          JournalEntryLineDetail: { PostingType: 'Debit', AccountRef: { value: 'A' } },
        },
        {
          DetailType: 'JournalEntryLineDetail',
          Amount: 100,
          JournalEntryLineDetail: { PostingType: 'Credit', AccountRef: { value: 'B' } },
        },
      ],
    });
    // balance check
    expect(sumByPosting(je!, 'Debit')).toBe(sumByPosting(je!, 'Credit'));
  });

  it('negative delta: swaps — Debit valuationOffset / Credit inventoryAsset, Amount=abs(delta)', () => {
    const je = buildInventoryValuationJE({
      deltaValue: -40,
      inventoryAssetId: 'A',
      valuationOffsetId: 'B',
      txnDate: '2026-05-31',
    });

    expect(je).toEqual({
      TxnDate: '2026-05-31',
      Line: [
        {
          DetailType: 'JournalEntryLineDetail',
          Amount: 40,
          JournalEntryLineDetail: { PostingType: 'Debit', AccountRef: { value: 'B' } },
        },
        {
          DetailType: 'JournalEntryLineDetail',
          Amount: 40,
          JournalEntryLineDetail: { PostingType: 'Credit', AccountRef: { value: 'A' } },
        },
      ],
    });
    expect(sumByPosting(je!, 'Debit')).toBe(sumByPosting(je!, 'Credit'));
  });

  it('zero delta: returns null (no JE)', () => {
    expect(
      buildInventoryValuationJE({
        deltaValue: 0,
        inventoryAssetId: 'A',
        valuationOffsetId: 'B',
        txnDate: '2026-05-31',
      }),
    ).toBeNull();
  });
});

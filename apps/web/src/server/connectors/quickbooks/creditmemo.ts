import 'server-only';

import { round2 } from './bill';

/**
 * return → QuickBooks Online JournalEntry mapping. ONE-WAY EXPORT ONLY: this
 * helper only builds the QBO JournalEntry body — nothing here ever writes QBO
 * data back into StockPilot.
 *
 * WHY A JOURNALENTRY (not a CreditMemo): a closed return books the returned
 * inventory's VALUE against GL accounts — there is no customer-facing sales
 * credit involved. QBO's CreditMemo is a SALES transaction that REQUIRES a
 * CustomerRef and item-based (SalesItemLineDetail/ItemRef) lines, neither of
 * which a return-value posting has. The correct account-based entity is a
 * balanced JournalEntry, which is exactly what the existing inventory-valuation
 * export uses (see valuation.ts) — so we mirror that proven shape rather than
 * the Bill's account-based-expense shape (which is only valid on purchase docs).
 *
 * v1 collapses every return line into ONE balanced debit/credit pair (the
 * aggregate credited value) — per-line item mapping is a deliberate future
 * extension, not a v1 requirement. Pure function (no I/O) so the body shape is
 * unit-testable without the network.
 */

/** One return line distilled to the two fields the credit amount needs. */
export interface ReturnCreditLine {
  quantity: number;
  unitCost: number;
}

export interface BuildReturnCreditArgs {
  /**
   * The account CREDITED by the return (the configured `returnCredit` account):
   * the GL account that offsets the returned inventory's value.
   */
  returnCreditAccountId: string;
  /**
   * The account DEBITED to balance the entry (the configured `inventoryAsset`
   * account): the returned goods re-enter inventory asset value. A JournalEntry
   * MUST balance (Σ debits === Σ credits), so a second account is required.
   */
  inventoryAssetAccountId: string;
  lines: ReturnCreditLine[];
}

/** One QBO JournalEntry line (mirrors valuation.ts). */
interface JournalEntryLine {
  DetailType: 'JournalEntryLineDetail';
  Amount: number;
  JournalEntryLineDetail: {
    PostingType: 'Debit' | 'Credit';
    AccountRef: { value: string };
  };
}

export interface ReturnCreditJournalEntryBody {
  /** Period-end posting date as YYYY-MM-DD. */
  TxnDate: string;
  Line: JournalEntryLine[];
}

/**
 * Build a BALANCED QBO JournalEntry crediting a closed return's value.
 *
 * Amount = Σ (quantity × unitCost), rounded to 2-dp (the same round2 the Bill
 * and valuation builders use). The returned value is CREDITED to the configured
 * `returnCredit` account and DEBITED to the configured `inventoryAsset` account
 * so Σ debits === Σ credits — QBO rejects an unbalanced JournalEntry. No
 * CustomerRef is needed (this is an account-only posting, not a sales credit).
 */
export function buildReturnCreditJournalEntry(
  args: BuildReturnCreditArgs & { txnDate: string },
): ReturnCreditJournalEntryBody {
  const amount = round2(args.lines.reduce((sum, l) => sum + l.quantity * l.unitCost, 0));
  return {
    TxnDate: args.txnDate,
    Line: [
      {
        DetailType: 'JournalEntryLineDetail',
        Amount: amount,
        JournalEntryLineDetail: {
          PostingType: 'Debit',
          AccountRef: { value: args.inventoryAssetAccountId },
        },
      },
      {
        DetailType: 'JournalEntryLineDetail',
        Amount: amount,
        JournalEntryLineDetail: {
          PostingType: 'Credit',
          AccountRef: { value: args.returnCreditAccountId },
        },
      },
    ],
  };
}

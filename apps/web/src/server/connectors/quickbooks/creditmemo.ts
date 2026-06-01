import 'server-only';

import { round2 } from './bill';

/**
 * return → QuickBooks Online CreditMemo mapping. ONE-WAY EXPORT ONLY: this
 * helper only builds the QBO CreditMemo body — nothing here ever writes QBO
 * data back into StockPilot, and (unlike the Bill's Vendor) a return needs no
 * customer resolution: a CreditMemo can post against a generic/default customer.
 *
 * CreditMemo is the QBO entity for a credit/return: it offsets a prior sale.
 * v1 collapses every return line into a SINGLE account-based credit line (the
 * aggregate credited value booked against the configured `returnCredit`
 * account), mirroring buildBillFromReceipt's single-line model — per-line item
 * mapping is a deliberate future extension, not a v1 requirement. Pure function
 * (no I/O) so the body shape is unit-testable without the network.
 */

/** One return line distilled to the two fields the CreditMemo amount needs. */
export interface CreditMemoLine {
  quantity: number;
  unitCost: number;
}

export interface BuildCreditMemoArgs {
  /**
   * The QBO Customer to credit. Optional: when a return has no resolvable
   * customer the caller may omit it and QBO books the CreditMemo against the
   * company's default — the connector passes a configured generic customer id
   * when present, else leaves CustomerRef off entirely.
   */
  customerId?: string;
  returnCreditAccountId: string;
  lines: CreditMemoLine[];
}

export interface QboCreditMemoBody {
  CustomerRef?: { value: string };
  Line: Array<{
    DetailType: 'AccountBasedExpenseLineDetail';
    Amount: number;
    AccountBasedExpenseLineDetail: { AccountRef: { value: string } };
  }>;
}

/**
 * Build the QBO CreditMemo request body from a closed return's lines.
 *
 * Amount = Σ (quantity × unitCost), rounded to 2-dp (the same round2 the Bill
 * builder uses, so a sub-cent total never posts a $0.00 line QBO rejects). The
 * credit is booked against the configured `returnCredit` account. CustomerRef
 * is included only when a customer id is supplied.
 */
export function buildCreditMemoFromReturn(args: BuildCreditMemoArgs): QboCreditMemoBody {
  const amount = round2(args.lines.reduce((sum, l) => sum + l.quantity * l.unitCost, 0));
  const body: QboCreditMemoBody = {
    Line: [
      {
        DetailType: 'AccountBasedExpenseLineDetail',
        Amount: amount,
        AccountBasedExpenseLineDetail: {
          AccountRef: { value: args.returnCreditAccountId },
        },
      },
    ],
  };
  if (args.customerId) {
    body.CustomerRef = { value: args.customerId };
  }
  return body;
}

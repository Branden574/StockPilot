import 'server-only';

import { round2 } from './bill';

/**
 * purchase order → QuickBooks Online PurchaseOrder mapping. ONE-WAY EXPORT ONLY:
 * builds/POSTs a QBO PurchaseOrder (vendor resolution reuses `resolveVendor`
 * from ./bill). Nothing here writes QBO data back into StockPilot.
 *
 * v1 collapses the PO into a SINGLE account-based expense line (the PO total,
 * rounded 2-dp, booked against the configured expense account) — same shape +
 * rationale as buildBillFromReceipt (per-line item mapping is a deliberate
 * future extension, not a v1 requirement). Pure function (no I/O).
 */
export interface BuildPurchaseOrderArgs {
  vendorId: string;
  expenseAccountId: string;
  /** PO total (Σ line qty×cost). Rounded to 2-dp here. */
  amount: number;
}

export function buildPurchaseOrderFromPo(args: BuildPurchaseOrderArgs): {
  VendorRef: { value: string };
  Line: Array<{
    DetailType: 'AccountBasedExpenseLineDetail';
    Amount: number;
    AccountBasedExpenseLineDetail: { AccountRef: { value: string } };
  }>;
} {
  return {
    VendorRef: { value: args.vendorId },
    Line: [
      {
        DetailType: 'AccountBasedExpenseLineDetail',
        Amount: round2(args.amount),
        AccountBasedExpenseLineDetail: {
          AccountRef: { value: args.expenseAccountId },
        },
      },
    ],
  };
}

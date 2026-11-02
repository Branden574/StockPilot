import { KeyValueRow } from '@/components/patterns/key-value-row';

import { PO_BILL_TO_LABEL, billToCharterDisplay, type BillToCharterRead } from '@stockpilot/core';

/**
 * The PO page's Summary row for the charter the purchase order is billed to
 * (purchase_orders.charter_id), B56: the PDF's name line under its label,
 * Bill to, with the status mark of a charter archived since in a muted span.
 * A read that failed says so, muted, and the page still renders. A purchase
 * order billed to no charter has no row, as the PDF prints none.
 *
 * Server component; put it inside a KeyValueList.
 */
export function PoBillToRow({ read }: { read: BillToCharterRead | null }) {
  const shown = read ? billToCharterDisplay(read) : null;
  if (!shown) return null;
  return (
    <KeyValueRow label={PO_BILL_TO_LABEL}>
      {shown.unreadable ? (
        <span className="text-muted-foreground">{shown.text}</span>
      ) : (
        <>
          {shown.text}
          {shown.note ? <span className="text-muted-foreground">{shown.note}</span> : null}
        </>
      )}
    </KeyValueRow>
  );
}

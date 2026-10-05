/**
 * Receiving a PO on the phone (app/po/[id].tsx), the parts vitest can reach.
 *
 * OVER-RECEIPT ASKS, IT DOES NOT REFUSE (L21). Vendors over-ship, so the
 * server allows a receipt past what was ordered (migration 0285) and the web
 * receive dialog takes it. The phone used to refuse it ("Too many"); it now
 * says how many more than ordered and asks.
 *
 * NOTES. The receipts route accepts a note (postReceiptSchema `notes`, at most
 * 2000 characters); the phone now sends one when it is typed.
 */

export const OVER_RECEIPT_CONFIRM_TITLE = 'Receive more than ordered?';
export const OVER_RECEIPT_CONFIRM_LABEL = 'Receive anyway';

export function overReceiptConfirmMessage(units: number): string {
  return `You're receiving ${units} more than ordered. Receive anyway?`;
}

/** Units entered past what is left to receive, summed over the lines. */
export function overReceiptUnits(
  lines: readonly { id: string; quantity_ordered: number; quantity_received: number }[],
  draft: Readonly<Record<string, { received: string } | undefined>>,
): number {
  let over = 0;
  for (const l of lines) {
    const entered = Number(draft[l.id]?.received ?? '') || 0;
    const remaining = Math.max(0, l.quantity_ordered - l.quantity_received);
    if (entered > remaining) over += entered - remaining;
  }
  return over;
}

export const RECEIPT_NOTES_LABEL = 'Notes (optional)';
const RECEIPT_NOTES_MAX = 2000;

/** The note as the route takes it: trimmed, at most 2000 characters, and
 *  left out when nothing was typed. */
export function receiptNotesForPost(text: string): string | undefined {
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed.slice(0, RECEIPT_NOTES_MAX) : undefined;
}

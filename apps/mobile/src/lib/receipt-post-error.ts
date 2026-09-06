/**
 * What to DO about a post_receipt_v2 failure on the mobile PO receive screen.
 *
 * THE BUG THIS CLOSES. The screen keeps one idempotency key per receive-intent
 * and deliberately retains it across failures, so a post that committed but
 * lost its ack is absorbed rather than posted twice. That contract only works
 * with a real request hash, which SP-077 added (see receipt-request-hash.ts) —
 * and it left a second, opposite hole open: once the operator EDITS the lines
 * after such a lost ack, the retained key plus the new hash raise
 * `idempotency_conflict` (0296:84), forever. The screen alerted the raw
 * Postgres token and returned, keeping the key, so every further attempt hit
 * the same wall: the receiver could not post the corrected receipt at all
 * without killing the app, and nothing on screen said the first attempt had
 * actually landed.
 *
 * The conflict is not a retryable error — it is the server saying "your first
 * post IS the receipt". So the only correct recovery is: retire the intent
 * (mint a fresh key), re-read the PO so `quantity_received` reflects what
 * really arrived, and let the operator enter only what is still outstanding.
 * Clearing the key WITHOUT that reload would let stale quantities be posted a
 * second time, which is the double-receive the key exists to prevent — the two
 * flags are handed back together on purpose.
 *
 * Every other raise string in 0296 aborts the whole function, so nothing was
 * written and the SAME key stays correct for the retry.
 *
 * Messages mirror apps/web/src/server/services/receiving.ts postReceipt's
 * mapping, and the enumerate-every-raise-string discipline is recurring
 * pattern #28: an unmapped code reaches the receiver as a Postgres token,
 * which is exactly how the over-receipt block stayed invisible to warehouse
 * staff for weeks (2026-07-21).
 */

export interface PostReceiptErrorLike {
  message?: string | null;
  code?: string | null;
  details?: string | null;
}

export interface PostReceiptErrorAction {
  /** Alert title. */
  title: string;
  /** Alert body — always a sentence a receiver can act on, never a raw code. */
  body: string;
  /**
   * The server already holds a receipt for this intent: retire the key so the
   * next post is a NEW intent. Only ever returned together with `reload`.
   */
  resetIntent: boolean;
  /** Re-read the PO (which also reseeds the draft) before anything else. */
  reload: boolean;
}

const keep = (title: string, body: string): PostReceiptErrorAction => ({
  title,
  body,
  resetIntent: false,
  reload: false,
});

export function mapPostReceiptError(
  error: PostReceiptErrorLike | null | undefined,
): PostReceiptErrorAction {
  const message = error?.message ?? '';
  const has = (needle: string) => message.includes(needle);

  if (has('idempotency_conflict')) {
    return {
      title: 'Already received',
      body:
        'Your first attempt reached the server and posted a receipt, so these edited quantities were refused instead of being received twice. The PO has been reloaded with what actually arrived — enter only what is still outstanding.',
      resetIntent: true,
      reload: true,
    };
  }
  if (has('po_already_closed')) {
    return keep(
      'PO is closed',
      'This PO is already closed and cannot accept further receipts.',
    );
  }
  if (has('forbidden')) {
    return keep('Not allowed', 'You cannot post receipts for this PO.');
  }
  // `po_line_not_found` does not contain `po_not_found`, so either arm is safe
  // here; they share one message because the receiver's next step is the same.
  if (has('po_not_found') || has('po_line_not_found')) {
    return keep(
      'Not found',
      'This PO or one of its lines no longer exists. Reload the PO and try again.',
    );
  }
  if (has('negative_quantity')) {
    return keep(
      'Check the quantities',
      'Received, accepted, and rejected quantities must each be zero or more.',
    );
  }
  if (has('lot_required')) {
    return keep(
      'Lot required',
      'This item is lot-tracked — it has to be received on the web, where lots can be entered.',
    );
  }
  if (has('lot_qty_mismatch')) {
    return keep(
      'Lot quantities do not match',
      'The lot quantities must add up to the accepted quantity for this line.',
    );
  }
  // Specific before general: `serial_count_exceeds_quantity` is its own case
  // in 0296 (the serial_optional branch) and must not be swallowed by the
  // exact-count arm below.
  if (has('serial_count_exceeds_quantity')) {
    return keep(
      'Too many serial numbers',
      'More serial numbers were entered than units accepted. Remove the extras, or raise the accepted quantity.',
    );
  }
  if (has('serials_required') || has('serial_count_mismatch')) {
    return keep(
      'Serial numbers required',
      'This item is serial-tracked — it needs exactly one serial number per accepted unit, entered on the web.',
    );
  }
  // serial_registry's UNIQUE (organization_id, item_id, serial_number) raises
  // straight out of the INSERT with no named RPC code to match on.
  if (
    error?.code === '23505' &&
    `${message} ${error?.details ?? ''}`.includes('serial_registry')
  ) {
    return keep(
      'Serial already registered',
      'That serial number is already registered for this item.',
    );
  }
  // Unmapped: show what the server said. A generic sentence here would hide
  // network and RLS failures from the only person who can report them.
  return keep(
    'Receive failed',
    message || 'The receipt could not be posted. Check your connection and try again.',
  );
}

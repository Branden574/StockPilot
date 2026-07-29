/**
 * The receipt sentinel that lives in `stock_movements.notes` — detecting it,
 * and keeping it off every screen. Shared by web and mobile for the same
 * reason `movement-order-ref.ts` is: a note is rendered on four surfaces and a
 * per-platform copy of this rule drifts.
 *
 * WHAT THE SENTINEL IS. The receiving RPCs stash an internal receipt UUID in
 * the `notes` column as a MACHINE reference. `post_receipt_v2` calls
 *
 *     adjust_stock(item, qty, 'receive_po', staging,
 *                  'PO ' || po_number,     -- p_reason
 *                  v_receipt.id::text)     -- p_notes   <-- the sentinel
 *
 * and `reverse_receipt` does the same with reason `receipt_reversal`. That
 * column is the ONLY link from the movement back to its receipt, which is why
 * `InventoryService.stagedWorklist` reads it and why migration 0231's own
 * header says "p_notes stays the receipt id — do not change it". It is never
 * text a person typed.
 *
 * THE DEFECT THIS EXISTS FOR. The masking used to key off the REASON:
 * `reason === 'receipt_line'`, which is the shape post_receipt_v2 wrote
 * BEFORE migration 0231. 0231 changed the writer's reason to `PO {number}`
 * and deliberately left the sentinel in `notes`. So from 0231 onward the
 * reason test matched nothing, and the raw UUID rendered on the item Activity
 * tab in curly quotes, indistinguishable from an operator's note — and next
 * to an edit affordance. Measured in prod 2026-07-29 across 2 orgs: 97 rows
 * carry a bare-UUID note, the reason test masked 17 of them, and 80 leaked
 * (49 `PO {number}` receipts + 31 `receipt_reversal` corrections).
 *
 * WHY THE SHAPE AND NOT THE REASON. The reason has now changed twice and is
 * written by several RPCs; the notes column has held exactly one thing since
 * 0013. The Movements page reached this conclusion first (its local copy of
 * this regex is what this module replaces) precisely because `list()` resolves
 * the reason to a display string before the cell sees it, leaving the sentinel
 * as the only per-row signal that survives. Keying off the payload rather than
 * a sibling field is also what stops the NEXT writer that changes its reason
 * from silently re-opening this hole.
 *
 * THE ACCEPTED TRADEOFF, stated plainly because it is a real (if tiny) loss:
 * a legitimate operator note whose ENTIRE content is a bare UUID and nothing
 * else is masked too. There is no way to tell it apart from the sentinel — the
 * bytes are identical — and the Movements page has already accepted this
 * tradeoff since the note cell became editable. A UUID *inside* a sentence is
 * deliberately NOT masked (see `isReceiptNoteSentinel`): that is real prose and
 * suppressing it would delete a human's words. Prod check at the time of this
 * change: zero rows in either org carry a UUID embedded in longer text, and
 * every one of the 97 bare-UUID rows was machine-written.
 *
 * DISPLAY-SIDE ONLY. Nothing here mutates the ledger. `stock_movements` is
 * append-only and the Movements page says so on the page; the 97 rows keep
 * their sentinel so `stagedWorklist` keeps working. Same posture as the
 * legacy order-reference resolution in `movement-order-ref.ts`.
 */

/**
 * A bare UUID and NOTHING else — anchored at both ends so it can only match a
 * note that is entirely an identifier. The anchoring is the whole safety
 * property: `^…$` is what makes "swapped for a1b2c3d4-… per Dana" pass
 * through untouched while the sentinel itself is caught.
 *
 * THE one definition of this shape in the repo. The web activity service, the
 * Movements page, the mobile movement-display helpers and `movement-history`'s
 * prose cleaner each used to carry a byte-identical private copy; they all
 * import this now. No `g` flag, so `.test()` carries no `lastIndex` state and
 * is safe to call repeatedly on a shared instance.
 */
export const RECEIPT_NOTE_SENTINEL_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * True when `notes` is the machine receipt reference rather than user text.
 *
 * Trims first, because the column is written by string concatenation in SQL
 * and a padded value is still the sentinel. Absent (`null`/`undefined`) and
 * empty are NOT sentinels — there is nothing to hide.
 */
export function isReceiptNoteSentinel(notes: string | null | undefined): boolean {
  return typeof notes === 'string' && RECEIPT_NOTE_SENTINEL_RE.test(notes.trim());
}

/**
 * The operator's own words, or null when the column holds only the sentinel.
 *
 * Returns the note VERBATIM when it is real text — untrimmed, unaltered. This
 * is a masking function, not a formatter: the surfaces that want prose cleanup
 * (`historyNote`) do their own, and quietly rewriting a note the user typed
 * would be its own small lie.
 */
export function userMovementNote(notes: string | null | undefined): string | null {
  const n = notes ?? null;
  if (n !== null && isReceiptNoteSentinel(n)) return null;
  return n;
}

/**
 * Whether a movement's note may be offered to an editor.
 *
 * TWO signals, because the UI has to agree with two different authorities and
 * they do not cover the same rows:
 *
 *  - `isReceiptNoteSentinel(notes)` — the row a save would DESTROY. Writing a
 *    user note over the sentinel would sever the movement's only link to its
 *    receipt (`stagedWorklist` resolves the source receipt through it). This
 *    is the signal that covers the 80 post-0231 rows.
 *  - `reason === 'receipt_line'` — the row the RPC REFUSES. `edit_movement_note`
 *    (migration 0274) raises errcode 22023 on exactly this reason value. Every
 *    such row also carries a sentinel note today, so this is belt-and-braces —
 *    but the UI must not offer an affordance whose only outcome is an error,
 *    and this keeps that promise from the RPC's own condition rather than from
 *    a coincidence about the data.
 *
 * KNOWN GAP, deliberately not closed here (it needs a migration, and this
 * change is display-side only): the RPC's guard is still the pre-0231
 * `reason = 'receipt_line'` test, so the DATABASE would happily let a caller
 * overwrite the sentinel on the 80 post-0231 rows. This function is what keeps
 * every shipped UI from asking. A follow-up migration should widen the RPC's
 * guard to the note's shape so the ledger is protected at the boundary too.
 */
export function isMovementNoteEditable(
  reason: string | null | undefined,
  notes: string | null | undefined,
): boolean {
  return !isReceiptNoteSentinel(notes) && reason !== 'receipt_line';
}

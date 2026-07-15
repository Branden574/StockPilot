/**
 * Pure display mapping for stock-movement ledger rows (item detail's
 * Movements tab). Extracted from app/item/[id].tsx so the old-row/new-row
 * mapping is unit-testable (mobile vitest only crawls src/lib).
 *
 * Two ledger realities these encode:
 *  - Transfers are NET-ZERO on hand: quantity_change is ALWAYS 0 (the ledger
 *    must sum to quantity_on_hand — snapshots/dashboards depend on it). The
 *    physical qty moved lives in moved_quantity (migration 0231), which is
 *    null on rows written before 0231 — those show NO number, never "0".
 *  - Receipts written before migration 0231 carry the internal reason
 *    'receipt_line' (their notes column holds the receipt id). New rows carry
 *    'PO {po_number}'. Old rows map to the generic 'PO receipt' label.
 */

export interface MovementAmountInput {
  movement_type: string;
  quantity_change: number;
  moved_quantity: number | null;
}

export type MovementAmount =
  /** Signed on-hand delta (adds/removes/adjusts). */
  | { kind: 'delta'; text: string; sign: 1 | -1 | 0 }
  /** Physical qty moved by a net-zero transfer — render neutrally, unsigned. */
  | { kind: 'moved'; text: string }
  /** Pre-0231 transfer row: qty moved unknown — render nothing. */
  | { kind: 'none' };

export function movementAmount(m: MovementAmountInput): MovementAmount {
  if (m.movement_type === 'transfer') {
    return m.moved_quantity != null
      ? { kind: 'moved', text: String(m.moved_quantity) }
      : { kind: 'none' };
  }
  const sign = m.quantity_change > 0 ? 1 : m.quantity_change < 0 ? -1 : 0;
  return {
    kind: 'delta',
    text: `${sign > 0 ? '+' : ''}${m.quantity_change}`,
    sign,
  };
}

/** Maps the pre-0231 internal 'receipt_line' reason to a human label; every
 *  other reason (including the new 'PO {number}') passes through verbatim. */
export function movementReasonLabel(reason: string | null): string | null {
  return reason === 'receipt_line' ? 'PO receipt' : reason;
}

/**
 * Masks the internal receipt uuid stashed in `notes` on pre-0231
 * 'receipt_line' rows — it's an implementation detail (already consumed by
 * `movementReasonLabel` to produce 'PO receipt'), never real user text.
 * Every other reason passes `notes` through verbatim. Mirrors the web's
 * reason/notes split in `ActivityService.forItem` (notes is never silently
 * dropped EXCEPT for this one legacy sentinel case).
 */
export function movementNotesForDisplay(reason: string | null, notes: string | null): string | null {
  return reason === 'receipt_line' ? null : notes;
}

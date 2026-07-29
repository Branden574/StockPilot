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
 *    'PO {po_number}'. Old rows resolve to 'PO {po_number}' too when the
 *    screen's batched receipt→PO lookup succeeds (Movement/Activity P5,
 *    `receiptLineSummary`); otherwise (map empty/unresolved) they fall back
 *    to the generic 'PO receipt' label — never the raw uuid.
 */

import {
  RECEIPT_NOTE_SENTINEL_RE,
  isMovementNoteEditable,
  userMovementNote,
} from '@stockpilot/core';

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
 *  other reason (including the new 'PO {number}') passes through verbatim.
 *  Superseded by `receiptLineSummary` for rows where a resolver map is
 *  available (Movement/Activity P5) — kept as the unconditional fallback
 *  used when no map was fetched at all, and as the literal string
 *  `receiptLineSummary` itself falls back to when a row is unresolvable. */
export function movementReasonLabel(reason: string | null): string | null {
  return reason === 'receipt_line' ? 'PO receipt' : reason;
}

/**
 * Matches a bare (unbraced) UUID. This used to be a private literal that a
 * comment claimed "mirrors the web's `UUID_RE` exactly" — three such mirrors
 * existed and they drifted, which is the whole reason the sentinel test now
 * has ONE home in @stockpilot/core. Re-exported under the old name so this
 * module's existing callers and tests are unaffected.
 *
 * Receipt rows stash a receipt id (as text) in `notes`; this guards
 * `collectReceiptLineIds` against ever batching a malformed/non-uuid value
 * into the `.in()` resolver query.
 */
export const RECEIPT_LINE_UUID_RE = RECEIPT_NOTE_SENTINEL_RE;

/**
 * Movement/Activity P5 (mobile web-parity gap): pre-0231 rows written by the
 * old post_receipt_v2 carry the internal reason 'receipt_line' with the
 * receipt id in notes. Given a resolver map (receipt id → po_number, fetched
 * by the screen via a batched `.in()` query — see resolveReceiptPoNumbers in
 * app/item/[id].tsx), returns the human summary: 'PO {number}', or the
 * existing masked fallback 'PO receipt' when unresolvable (map empty, RLS
 * degraded, receipt/PO deleted, or notes isn't a recognized uuid). Mirrors
 * `receiptLineSummary` in the web's activity.ts EXACTLY — same signature,
 * same fallback string, same trim-then-lookup semantics. Never leaks the raw
 * uuid: every branch returns a human string. Exported for unit tests.
 */
export function receiptLineSummary(
  notes: string | null,
  poNumberByReceipt: Map<string, string>,
): string {
  const rid = (notes ?? '').trim();
  const po = poNumberByReceipt.get(rid);
  return po ? `PO ${po}` : 'PO receipt';
}

/**
 * Collects the receipt ids referenced by pre-0231 'receipt_line' rows on
 * THIS page so they can be resolved to PO numbers in one batched query (same
 * pattern as `collectReferenceIdsByType` in movement-references.ts). Mirrors
 * the web's `collectReceiptLineIds` in activity.ts exactly. Exported for unit
 * tests; the actual `.in()` query lives in app/item/[id].tsx.
 */
export function collectReceiptLineIds(
  rows: { reason: string | null; notes: string | null }[],
): string[] {
  return [
    ...new Set(
      rows
        .filter(
          (m) => m.reason === 'receipt_line' && RECEIPT_LINE_UUID_RE.test((m.notes ?? '').trim()),
        )
        .map((m) => (m.notes as string).trim()),
    ),
  ];
}

/**
 * Masks the internal receipt uuid stashed in `notes` on receipt rows — it's an
 * implementation detail (the receipt link stagedWorklist resolves through),
 * never real user text. Every other note passes through verbatim.
 *
 * Masks by the SHAPE of the note. It used to take the row's REASON and return
 * `reason === 'receipt_line' ? null : notes`, which was the PRE-0231 shape:
 * migration 0231 changed the receipt writer's reason to 'PO {number}' while
 * deliberately keeping the sentinel in `notes`, so the reason test stopped
 * matching and the raw uuid rendered in curly quotes on the item Movements and
 * Activity tabs — the identical defect the web feed had, which is what a
 * per-platform copy of this rule always produces. The `reason` parameter is
 * gone rather than ignored: it was never the right signal.
 *
 * Aliased to the shared implementation (no wrapper) so mobile keeps its local
 * vocabulary while being physically incapable of drifting from web.
 */
export { userMovementNote as movementNotesForDisplay };

/**
 * Whether a movement's note is user-editable. False when the note IS the
 * machine receipt reference (saving over it would sever the movement's only
 * link to its receipt), and false for a pre-0231 'receipt_line' row, which the
 * SECURITY DEFINER `edit_movement_note` RPC rejects outright (errcode 22023).
 *
 * Takes the RAW `stock_movements.reason` and the RAW `notes` — call it BEFORE
 * the reason is resolved to a 'PO {number}' display string and before the note
 * is masked. Same implementation as the web's `noteEditable` field, so the two
 * cannot disagree.
 */
export { isMovementNoteEditable as movementNoteEditable };

/**
 * Web parity (Movement/Activity P1 review follow-up): renders a movement's
 * from/to location route the SAME way the web feed does (`ActivityFeed`'s
 * inline route logic in `activity-feed.tsx`) — both names resolved → "A → B";
 * only the destination resolved (receives) → "→ B"; only the source resolved
 * (removals) → "A →"; neither resolved (no location on the row, or a
 * resolved-but-deleted/unknown id) → null, meaning the caller MUST omit the
 * line entirely — never a dangling arrow or a raw uuid. `fromName`/`toName`
 * are already-resolved display names (see `resolveLocationNames` in
 * app/item/[id].tsx), not ids — this function does no lookup itself so it's
 * pure and unit-testable without a Supabase mock.
 */
export function formatMovementRoute(fromName: string | null, toName: string | null): string | null {
  if (fromName && toName) return `${fromName} → ${toName}`;
  if (toName) return `→ ${toName}`;
  if (fromName) return `${fromName} →`;
  return null;
}

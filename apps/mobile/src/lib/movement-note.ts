/**
 * Movement-note edit helpers (pure) — extracted from `app/item/[id].tsx` so the
 * optimistic-update logic behind the Movements tab's "Add/Edit note" action is
 * unit-tested without React or Supabase.
 *
 * The single write path is the Bearer endpoint `PATCH /api/v1/movements/[id]/note`
 * (web route), which calls the SECURITY DEFINER `edit_movement_note` RPC — the
 * ONLY sanctioned mutation into the append-only `stock_movements` ledger (mig
 * 0274). Both the RPC (`nullif(btrim(...), '')`) and the route normalize the
 * note the same way; `normalizeMovementNote` mirrors that so the optimistic card
 * update matches exactly what the server stored, and the endpoint's echoed
 * `note` can be applied verbatim.
 */

export const MOVEMENT_NOTE_MAX = 2000;

/**
 * Trim, then collapse an empty result to `null` — mirrors the server's
 * `nullif(btrim(p_note), '')`. So "  " and "" both clear the note, matching what
 * the ledger persists.
 */
export function normalizeMovementNote(input: string | null | undefined): string | null {
  if (input == null) return null;
  const trimmed = input.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Returns a NEW array with `notes` replaced on the row whose id matches
 * `movementId`; every other row is returned by reference (no needless churn).
 * Pure — the caller uses it to optimistically reflect a saved note edit across
 * whichever movement list(s) hold the row (the Movements tab and the Activity
 * tab keep independent arrays).
 */
export function applyNoteToMovements<T extends { id: string; notes: string | null }>(
  rows: T[],
  movementId: string,
  note: string | null,
): T[] {
  return rows.map((row) => (row.id === movementId ? { ...row, notes: note } : row));
}

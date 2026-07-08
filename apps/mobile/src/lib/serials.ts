import { ACCENT, palette, type ThemeMode } from './theme';

/**
 * Serial-number display + input helpers for the item screen's Serials
 * card. Pure TS (no RN / Expo imports) so it runs under the node vitest
 * harness — mirror of src/lib/movement-display.ts.
 *
 * Mirrors the serial_registry schema (mig 0015):
 *   current_status in ('available','reserved','damaged','rejected','sold','rma')
 *   unique (organization_id, item_id, serial_number)  → 23505 on dupes
 *   receipt_line_id null ⇒ manually added (deletable); non-null ⇒ captured
 *   by a PO receipt (status changes only — never deleted from mobile).
 */

export const SERIAL_STATUSES = [
  'available',
  'reserved',
  'damaged',
  'rejected',
  'sold',
  'rma',
] as const;

export type SerialStatus = (typeof SERIAL_STATUSES)[number];

export const SERIAL_STATUS_LABELS: Record<SerialStatus, string> = {
  available: 'Available',
  reserved: 'Reserved',
  damaged: 'Damaged',
  rejected: 'Rejected',
  sold: 'Sold',
  rma: 'RMA',
};

export function isSerialStatus(value: unknown): value is SerialStatus {
  return (
    typeof value === 'string' && (SERIAL_STATUSES as readonly string[]).includes(value)
  );
}

export interface SerialStatusTone {
  fg: string;
  bg: string;
  border: string;
}

/**
 * Pill colors per status, mapped onto the app's theme tokens (ACCENT +
 * warm-paper palette). Follows the recipe in components/ui/pill.tsx:
 * soft translucent fill, 30–40% border, saturated foreground.
 */
export function serialStatusColor(status: SerialStatus, mode: ThemeMode): SerialStatusTone {
  const p = palette(mode);
  switch (status) {
    case 'available':
      return {
        fg: mode === 'dark' ? ACCENT.mintInkDark : ACCENT.mintInk,
        bg: ACCENT.mintSoft,
        border: 'hsla(165, 38%, 56%, 0.4)',
      };
    case 'reserved':
      return {
        fg: ACCENT.pipTeal,
        bg: 'rgba(70,194,202,0.10)',
        border: 'rgba(70,194,202,0.35)',
      };
    case 'damaged':
      return {
        fg: ACCENT.warn,
        bg: 'rgba(245,176,66,0.10)',
        border: 'rgba(185,122,29,0.3)',
      };
    case 'rejected':
      return {
        fg: ACCENT.crit,
        bg: 'rgba(176,58,58,0.08)',
        border: 'rgba(176,58,58,0.3)',
      };
    case 'rma':
      return {
        fg: ACCENT.pipOrange,
        bg: 'rgba(255,122,69,0.10)',
        border: 'rgba(255,122,69,0.35)',
      };
    case 'sold':
      return { fg: p.ink3, bg: p.card, border: p.hair };
  }
}

export const SERIAL_MAX_LENGTH = 128;
export const SERIAL_BATCH_CAP = 500;

export interface SerialInputResult {
  serials: string[];
  errors: string[];
}

/**
 * Splits textarea-style input ("one serial per line") into trimmed,
 * unique, non-empty serials.
 *
 *  - blank / whitespace-only lines are skipped silently,
 *  - duplicate lines are collapsed to the first occurrence silently
 *    (pasting the same list twice shouldn't scold the user),
 *  - a line over SERIAL_MAX_LENGTH chars is an error (never truncated —
 *    a silently shortened serial is a corrupt serial),
 *  - more than SERIAL_BATCH_CAP unique serials is an error AND the list
 *    is capped, so even a caller that ignores `errors` can never insert
 *    an unbounded batch. Callers should block submit while errors exist.
 */
export function validateSerialInput(text: string): SerialInputResult {
  const errors: string[] = [];
  const seen = new Set<string>();
  const serials: string[] = [];
  const lines = text.split(/\r?\n/);
  let overCap = 0;

  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].trim();
    if (s === '') continue;
    if (s.length > SERIAL_MAX_LENGTH) {
      errors.push(`Line ${i + 1}: serial exceeds ${SERIAL_MAX_LENGTH} characters.`);
      continue;
    }
    if (seen.has(s)) continue;
    seen.add(s);
    if (serials.length >= SERIAL_BATCH_CAP) {
      overCap += 1;
      continue;
    }
    serials.push(s);
  }

  if (overCap > 0) {
    errors.push(
      `Too many serials — max ${SERIAL_BATCH_CAP} per batch (${overCap} over the limit).`,
    );
  }

  return { serials, errors };
}

/**
 * Source of a registry row: rows written by post_receipt carry their
 * receipt_line_id; manually added rows have it null.
 */
export function serialSourceLabel(receiptLineId: string | null): 'PO receipt' | 'Manual' {
  return receiptLineId ? 'PO receipt' : 'Manual';
}

/** Only manually-added rows may be deleted; receipt rows are audit trail. */
export function canDeleteSerial(receiptLineId: string | null): boolean {
  return receiptLineId === null;
}

/** Short created-at date for list rows, e.g. "Jul 8, 2026". */
export function formatSerialDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * Extracts the offending serial from a Postgres 23505 unique-violation
 * DETAIL string, e.g.
 *   "Key (organization_id, item_id, serial_number)=(a, b, SN-001) already exists."
 * Returns null when the shape doesn't match (caller falls back to a
 * generic duplicate message).
 */
export function duplicateSerialFromDbError(detail: string | null | undefined): string | null {
  if (!detail) return null;
  const m = /serial_number\)=\([^,]+,\s*[^,]+,\s*(.+)\) already exists/.exec(detail);
  return m ? m[1] : null;
}

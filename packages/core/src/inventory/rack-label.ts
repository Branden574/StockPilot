/**
 * THE single definition of how a rack label decomposes and recomposes.
 *
 * A rack is stored in TWO columns/keys — a number and a row:
 *   locations.rack_number / locations.rack_row
 *   inventory_items.custom_fields.rack_number      / .rack_row       (non-books)
 *   inventory_items.custom_fields.book_rack_number / .book_rack_row  (books)
 * and is SHOWN to humans as one label: "22-B".
 *
 * The 2026-07-23 incident: a rack was created with the WHOLE label parked in
 * the number column — ("22-B", null) instead of ("22","B"). Put-away faithfully
 * stamped that pair onto every item it placed there, the Rack column still
 * printed "22-B" (display just joins), but the Items filter — which splits the
 * selected label and requires number="22" AND row="B" — matched nothing. Eight
 * items went invisible to their own rack filter. The writer and the reader
 * disagreed about the SHAPE of a label and nothing enforced one.
 *
 * So: every writer decomposes through `parseRackLabel` / `normalizeRackFields`,
 * every display composes through `formatRackLabel`, and every reader uses
 * `isCompositeRackNumber` to stay tolerant of a legacy composite row (an
 * import, a restored backup, a writer we missed) instead of going blind again.
 *
 * Splitting is on the LAST dash — "22-B" is 22/B, and a rack legitimately named
 * "E2E-RACK-1" is E2E-RACK/1. Casing is preserved verbatim: this module is pure
 * decomposition, and the read path filters with an exact `eq`, so uppercasing
 * here would silently stop matching any row stored lowercase. Writers that want
 * a canonical uppercase row keep doing that themselves (they already did).
 */

export interface RackLabelParts {
  /** The rack number as stored in the *_rack_number column/key. Never contains a trailing row. */
  number: string;
  /** The row as stored in the *_rack_row column/key, or null for a number-only rack. */
  row: string | null;
}

/** Strip surrounding whitespace and any leading/trailing dashes ("22-" is just 22). */
function tidy(value: string): string {
  return value.trim().replace(/^-+|-+$/g, '').trim();
}

/**
 * Decompose a user-entered / stored label into its number and row.
 *
 *   "22"          -> { number: '22',       row: null }
 *   "22-B"        -> { number: '22',       row: 'B'  }
 *   "E2E-RACK-1"  -> { number: 'E2E-RACK', row: '1'  }
 *   "22-b"        -> { number: '22',       row: 'b'  }  (casing preserved)
 *   ""  / "   "   -> { number: '',         row: null }
 */
export function parseRackLabel(label: string | null | undefined): RackLabelParts {
  const cleaned = tidy(label ?? '');
  if (!cleaned) return { number: '', row: null };

  const idx = cleaned.lastIndexOf('-');
  // tidy() already removed edge dashes, so a surviving dash always has content
  // on both sides — but re-check rather than trust it, since an interior run
  // like "22--B" would leave an empty left/right half.
  if (idx <= 0 || idx >= cleaned.length - 1) return { number: cleaned, row: null };

  // tidy() each half too, so a doubled dash ("22--B") still yields ("22","B")
  // instead of parking a stray dash in the number column.
  const number = tidy(cleaned.slice(0, idx));
  const row = tidy(cleaned.slice(idx + 1));
  if (!number || !row) return { number: cleaned, row: null };
  return { number, row };
}

/**
 * Recompose the display label. This is the ONLY way a label should be built —
 * "do not change what a user sees a rack called" means every surface joins the
 * same way. Returns '' when there is no number (nothing to show).
 */
export function formatRackLabel(parts: {
  number: string | null | undefined;
  row?: string | null;
}): string {
  const number = (parts.number ?? '').trim();
  if (!number) return '';
  const row = (parts.row ?? '').trim();
  return row ? `${number}-${row}` : number;
}

/**
 * True when a value sitting in a *_rack_number column is actually a WHOLE
 * label ("22-B") rather than a bare number — i.e. the shape that caused the
 * incident. Readers use this to stay tolerant of legacy rows; the writer-guard
 * test uses it to fail the build if a writer ever stores one again.
 */
export function isCompositeRackNumber(rackNumber: string | null | undefined): boolean {
  return parseRackLabel(rackNumber).row !== null;
}

/**
 * The writers' entry point: take whatever a caller has (a number field a human
 * may have typed a full label into, plus an optional separate row) and return
 * the DECOMPOSED pair to store.
 *
 * A user typing "22-B" into the rack-number box is not an error — the label is
 * how humans name racks — so it is split, never rejected.
 *
 * When an explicit row IS supplied the number is trusted as already decomposed,
 * because splitting it would wreck a rack legitimately named "E2E-RACK" with
 * row "1". The one exception is double entry — "22-B" typed in the number box
 * AND "B" picked as the row — where the trailing segment is dropped rather than
 * stored as ("22-B","B") and rendered "22-B-B".
 */
export function normalizeRackFields(input: {
  number: string | null | undefined;
  row?: string | null;
}): RackLabelParts {
  const explicitRow = (input.row ?? '').trim();
  if (!explicitRow) return parseRackLabel(input.number);

  const parsed = parseRackLabel(input.number);
  const number =
    parsed.row !== null && parsed.row.toLowerCase() === explicitRow.toLowerCase()
      ? parsed.number
      : tidy(input.number ?? '');
  return { number, row: explicitRow };
}

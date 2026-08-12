/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ONE RULE for a book's crate summary.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * PHYSICAL TRUTH is `item_stock_levels -> locations`. A book sits wherever its
 * positive holdings sit, and a crate location carries first-class
 * `locations.crate_color` / `locations.crate_number` columns (migration 0188).
 * NEVER parse a crate out of `locations.name`.
 *
 * `inventory_items.custom_fields.book_crate_color` / `.book_crate_number` are a
 * SUMMARY of that truth — they exist so one item row can be printed, filtered
 * and exported without joining holdings. They are never authoritative.
 *
 * SYNCHRONISATION RULE (the owner's rule; every caller depends on it):
 *
 *   After a placement succeeds, load the item's POSITIVE holdings once.
 *     • If every PLACED holding resolves to exactly ONE rack/crate, the
 *       summary is synchronised to that location's crate columns — including
 *       CLEARING it when that one location is a rack (a book on a rack is in
 *       no crate, and a stale "Blue 4" would send a picker to the wrong bin).
 *     • If the placed holdings are SPLIT across two or more locations, the
 *       summary is LEFT ALONE. Stamping the newest crate over a split item
 *       would assert something false about the other half of the stock;
 *       holdings stay authoritative and the item detail shows every line.
 *   Not-yet-placed holdings (staging / unplaced buckets) are ignored for this
 *   decision — they are stock waiting to be put away, not a location.
 *
 * CONFIRMATION RULE: overwriting a crate a human already recorded is a
 * destructive edit, so the server refuses it unless the caller acknowledges.
 * `compareBookCratePlacement` below decides what counts as "overwriting"; the
 * tie-breaker whenever a case is ambiguous is ASK, never silently overwrite.
 *
 * PURE MODULE. No DB, no IO — the server does the reading, this decides.
 */

import { formatCrateLabel } from './book-storage';
import { getCrateColor } from './crate-colors';

/** Trim; '' and whitespace-only become null. */
function normalizeText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * The comparison key for a crate COLOR: the CRATE_COLORS slug when the value
 * resolves to a known color, otherwise the lower-cased raw text.
 *
 * Registry-first so "blue", "Blue" and " BLUE " are one color. Falling back to
 * lower-cased text rather than null means an unrecognised color still compares
 * to itself — production has never stored one, but discarding it would make an
 * unknown-to-unknown change read as "no change" and skip the confirmation.
 */
export function normalizeCrateColor(value: string | null | undefined): string | null {
  const raw = normalizeText(value);
  if (!raw) return null;
  const lowered = raw.toLowerCase();
  return getCrateColor(lowered)?.slug ?? lowered;
}

/**
 * The comparison key for a crate NUMBER: trimmed, lower-cased.
 *
 * FREE TEXT, DELIBERATELY UNVALIDATED. Production `book_crate_number` values
 * include 0, 1..16 and the strings "Bin", "BIN" and "Blue Shelf" — the
 * `CRATE_NUMBERS = 1..9` constant that used to sit in book-storage.ts had zero
 * consumers and would reject real books. Normalise for comparison ("Bin" and
 * "BIN" are one crate, " 4 " and "4" are one crate); never range-check.
 */
export function normalizeCrateNumber(value: string | null | undefined): string | null {
  const raw = normalizeText(value);
  return raw === null ? null : raw.toLowerCase();
}

export interface BookCratePlacementInput {
  /** The crate color recorded on the ITEM today — read from the DB, never from the client. */
  currentColor: string | null | undefined;
  /** The crate number recorded on the ITEM today — read from the DB, never from the client. */
  currentNumber: string | null | undefined;
  /** The destination location's `crate_color` (null for a rack). */
  nextColor: string | null | undefined;
  /** The destination location's `crate_number` (null for a rack). */
  nextNumber: string | null | undefined;
}

export interface BookCratePlacementComparison {
  /** True when the placement would OVERWRITE a value a human already recorded. */
  changed: boolean;
  colorChanged: boolean;
  numberChanged: boolean;
  /** "Blue 42" — how the item's crate reads today; null when it has none. */
  currentLabel: string | null;
  /** "Green 2" — how it would read after; null when the destination is a rack. */
  nextLabel: string | null;
  /** True when the item carries no crate color AND no crate number today. */
  isFirstAssignment: boolean;
}

/**
 * Per-field verdict. The asymmetry is the whole point:
 *
 *   current null            → false. FILLING a blank is not an overwrite; a
 *                             book that has never been crated should be
 *                             stamped without interrogating the user.
 *   current known, next null → TRUE. This is the rack case (and a colorless
 *                             crate): a recorded value is being ERASED, which
 *                             is exactly the destructive edit worth confirming.
 *   both known, differ       → TRUE.
 *   both known, equal        → false.
 */
function fieldOverwritten(current: string | null, next: string | null): boolean {
  if (current === null) return false;
  return current !== next;
}

/**
 * Compare the crate a book is recorded in against the crate it is being placed
 * into. Pure; both sides are normalised (trim, case-insensitive, color via the
 * CRATE_COLORS registry) before comparing.
 *
 * `changed` is what the confirmation gate reads. `isFirstAssignment` is a
 * REPORTING flag for the UI copy — when it is true, `changed` is provably
 * false, because every field's current value is null.
 */
export function compareBookCratePlacement(
  input: BookCratePlacementInput,
): BookCratePlacementComparison {
  const currentColor = normalizeCrateColor(input.currentColor);
  const currentNumber = normalizeCrateNumber(input.currentNumber);
  const nextColor = normalizeCrateColor(input.nextColor);
  const nextNumber = normalizeCrateNumber(input.nextNumber);

  const colorChanged = fieldOverwritten(currentColor, nextColor);
  const numberChanged = fieldOverwritten(currentNumber, nextNumber);

  return {
    changed: colorChanged || numberChanged,
    colorChanged,
    numberChanged,
    // Labels are built from the RAW values so the user sees what is actually
    // stored ("Bin", "Blue Shelf"), not the lower-cased comparison key.
    currentLabel: formatCrateLabel(input.currentColor, input.currentNumber),
    nextLabel: formatCrateLabel(input.nextColor, input.nextNumber),
    isFirstAssignment: currentColor === null && currentNumber === null,
  };
}

/**
 * Is this inline-created destination a CRATE?
 *
 * A crate NUMBER alone is enough. Four write paths used to decide with
 * `crateColor ? 'crate' : 'rack'`, so a user who typed a crate number but
 * picked no color silently got a RACK — the wrong `locations.kind`, the wrong
 * dedupe bucket (0270's unique index is kind-scoped) and no crate columns.
 * Colors are an optional visual aid; the number is the identity.
 */
export function isCrateDestination(input: {
  crateColor?: string | null;
  crateNumber?: string | null;
}): boolean {
  return normalizeText(input.crateColor) !== null || normalizeText(input.crateNumber) !== null;
}

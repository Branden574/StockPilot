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

/**
 * Display name for a crate COLOR: the CRATE_COLORS label when the value is a
 * known slug ("blue" → "Blue"), otherwise the raw text kept verbatim.
 *
 * A color is NEVER shown on its own as a swatch — every surface that renders
 * the hex also renders this string, because color alone is not information a
 * color-blind picker can act on.
 */
export function formatCrateColorLabel(value: string | null | undefined): string | null {
  const raw = normalizeText(value);
  if (!raw) return null;
  return getCrateColor(raw.toLowerCase())?.label ?? raw;
}

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

/**
 * The label a CONFIRMATION uses for one side of the comparison.
 *
 * `formatCrateLabel` is the SUMMARY spelling and answers "which crate is this
 * book in" — a color with no number is not a crate there, so it renders null.
 * The gate asks a different question: "is a recorded value being destroyed",
 * and a recorded color with no number IS such a value (`fieldOverwritten`
 * fires on it). Reusing the summary spelling produced a self-contradictory
 * payload — changed: true carrying currentLabel: null and nextLabel: null,
 * which reads "recorded in no crate … will change to no crate" and gives the
 * client nothing to render.
 *
 * So: number present → the summary spelling ("Blue 4", "4"). Number absent but
 * a color recorded → the color alone ("Blue"). Nothing recorded → null, which
 * now genuinely means nothing.
 */
export function formatCratePlacementLabel(
  crateColor: string | null | undefined,
  crateNumber: string | null | undefined,
): string | null {
  return formatCrateLabel(crateColor, crateNumber) ?? formatCrateColorLabel(crateColor);
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
    currentLabel: formatCratePlacementLabel(input.currentColor, input.currentNumber),
    nextLabel: formatCratePlacementLabel(input.nextColor, input.nextNumber),
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

// ═══════════════════════════════════════════════════════════════════════════
// THE CONFIRMATION CONTRACT — server refusal ⇄ client acknowledgement
//
// The gate lives on the server (it re-reads the DB), but the payload it
// throws is rendered by a client component that cannot import a service. Both
// halves therefore name the SAME constant and the SAME shape from here.
//
// The client ALSO predicts the refusal locally (it knows the book's summary
// and the destination it is about to send) so it can ask once, up front,
// instead of submitting, being refused, and asking afterwards. The prediction
// is a courtesy, never an authority: the server compares against the row it
// just read, and a placement that slips past a stale prediction is still
// refused and still re-rendered from THIS payload.
// ═══════════════════════════════════════════════════════════════════════════

export const BOOK_CRATE_CHANGE_REQUIRES_CONFIRMATION =
  'BOOK_CRATE_CHANGE_REQUIRES_CONFIRMATION' as const;

export interface BookCrateChangeItem {
  itemId: string;
  itemName: string;
  /** "Blue 4" — what the item says today. Null when it records no crate. */
  currentLabel: string | null;
  /** "Green 2" — or null when the destination is a rack (the crate is cleared). */
  nextLabel: string | null;
}

export interface BookCrateChangeDetail {
  reason: typeof BOOK_CRATE_CHANGE_REQUIRES_CONFIRMATION;
  items: BookCrateChangeItem[];
}

/**
 * Narrow an `ActionError.details` blob to the confirmation payload.
 *
 * Server actions type `details` as `Record<string, unknown>`, so the client
 * has to check rather than cast. Anything that is not exactly this payload
 * (another conflict, a details-less error) returns null and the caller falls
 * back to showing the plain message — a malformed payload must never render
 * an empty "are you sure?" with nothing in it.
 */
export function parseBookCrateChangeDetail(details: unknown): BookCrateChangeDetail | null {
  if (!details || typeof details !== 'object') return null;
  const d = details as { reason?: unknown; items?: unknown };
  if (d.reason !== BOOK_CRATE_CHANGE_REQUIRES_CONFIRMATION) return null;
  if (!Array.isArray(d.items) || d.items.length === 0) return null;
  const items: BookCrateChangeItem[] = [];
  for (const raw of d.items) {
    if (!raw || typeof raw !== 'object') return null;
    const it = raw as Record<string, unknown>;
    if (typeof it.itemId !== 'string' || typeof it.itemName !== 'string') return null;
    items.push({
      itemId: it.itemId,
      itemName: it.itemName,
      currentLabel: typeof it.currentLabel === 'string' ? it.currentLabel : null,
      nextLabel: typeof it.nextLabel === 'string' ? it.nextLabel : null,
    });
  }
  return { reason: BOOK_CRATE_CHANGE_REQUIRES_CONFIRMATION, items };
}

/**
 * The exact sentences a confirmation shows for ONE book, naming every field
 * that changes and never more.
 *
 * Field-level on purpose: "Blue 4 → Blue 7" makes a reader diff two strings to
 * find the one digit that moved. Each line states the field, the old value and
 * the new one, and a cleared field says "cleared" rather than "to none" so the
 * rack case reads as the erasure it is.
 *
 * Returns [] when nothing changes — the caller must then NOT confirm, which is
 * what keeps a same-crate or first-ever placement exactly as fast as before.
 */
export function describeBookCrateChange(input: BookCratePlacementInput): string[] {
  const cmp = compareBookCratePlacement(input);
  if (!cmp.changed) return [];
  const lines: string[] = [];
  if (cmp.colorChanged) {
    const from = formatCrateColorLabel(input.currentColor);
    const to = formatCrateColorLabel(input.nextColor);
    lines.push(
      to ? `Crate color will change from ${from} to ${to}.` : `Crate color ${from} will be cleared.`,
    );
  }
  if (cmp.numberChanged) {
    const from = normalizeText(input.currentNumber);
    const to = normalizeText(input.nextNumber);
    lines.push(
      to
        ? `Crate number will change from ${from} to ${to}.`
        : `Crate number ${from} will be cleared.`,
    );
  }
  return lines;
}

/**
 * ONE aggregated sentence-set for a BULK placement, instead of N dialogs.
 *
 * Every book in a bulk placement lands in the SAME destination, so the only
 * thing that varies is where each one is recorded today. Grouping by that
 * turns 200 rows into "4 titles now in Blue 4, 2 titles now in Green 2, 2
 * titles with no crate" — which is the shape a human can actually check.
 *
 * Groups are ordered largest-first, then alphabetically, so the same selection
 * always reads the same way; books with no recorded crate sort last because
 * they are the uninteresting case (nothing is being destroyed for them).
 */
export function summarizeBookCrateChanges(items: BookCrateChangeItem[]): {
  total: number;
  nextLabel: string | null;
  groups: Array<{ currentLabel: string | null; count: number }>;
} {
  const counts = new Map<string, { currentLabel: string | null; count: number }>();
  for (const it of items) {
    const key = it.currentLabel ?? ' none';
    const entry = counts.get(key) ?? { currentLabel: it.currentLabel, count: 0 };
    entry.count += 1;
    counts.set(key, entry);
  }
  const groups = [...counts.values()].sort((a, b) => {
    if (a.currentLabel === null) return 1;
    if (b.currentLabel === null) return -1;
    if (b.count !== a.count) return b.count - a.count;
    return a.currentLabel.localeCompare(b.currentLabel);
  });
  return {
    total: items.length,
    // Every item shares one destination, so the first item's next label speaks
    // for all of them.
    nextLabel: items[0]?.nextLabel ?? null,
    groups,
  };
}

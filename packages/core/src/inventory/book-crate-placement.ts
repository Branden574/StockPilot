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
 * destructive edit, so the server refuses it unless the caller acknowledges
 * THAT SPECIFIC CHANGE — an item id plus a fingerprint of the crate the caller
 * says it displayed, never a blanket boolean. `compareBookCratePlacement`
 * decides what counts as "overwriting"; the tie-breaker whenever a case is
 * ambiguous is ASK, never silently overwrite.
 *
 * TWO CONSEQUENCES OF THE SYNCHRONISATION RULE, both load-bearing:
 *
 *   • The gate must compute the comparison BEFORE it looks at any
 *     acknowledgement. An acknowledgement that short-circuits the comparison is
 *     not approval, it is a bypass — and a client whose acknowledgement comes
 *     from a render-time snapshot then destroys whatever the row says NOW.
 *   • The gate must not ASK about a change the sync will not make. A book whose
 *     stock stays SPLIT keeps its summary untouched, so confirming the change
 *     changes nothing. `bookCratePlacementWillSync` is the shared predicate
 *     that keeps the two sides from disagreeing.
 *
 * PURE MODULE. No DB, no IO — the server does the reading, this decides.
 */

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
 * The value to STORE for a crate color — the WRITE-side twin of
 * `normalizeCrateColor`, which is a comparison key and must not be used as
 * storage.
 *
 * A known color is canonicalised to its registry slug, so "Blue", " BLUE " and
 * "blue" all land in the column as "blue" and no reader has to be clever about
 * case. An UNKNOWN color is kept trimmed but VERBATIM — lower-casing it would
 * throw away the only spelling anyone has of a color the registry has never
 * heard of, and the comparison path normalises it anyway.
 *
 * Every writer of a crate color goes through this: `locations.crate_color` (the
 * single insert in LocationsService.create, which every inline rack/crate
 * creation path and the mobile transfer route funnel into) and the item-level
 * `book_crate_color` summary. Mixed case reached the database because the
 * Transfer dialog's color box is free text and `findOrCreateRackOrCrate`
 * dedupes on `lower(name)`, so a row created as "Blue" kept that spelling
 * forever — and an exact-match registry lookup then dropped the color, turning
 * "Blue 42" into "42".
 */
export function normalizeCrateColorForWrite(value: string | null | undefined): string | null {
  const raw = normalizeText(value);
  if (!raw) return null;
  return getCrateColor(raw)?.slug ?? raw;
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
 * ═══ THE GATE LABEL IS NOT THE SUMMARY LABEL — do not re-merge them ═══
 *
 * `formatCrateLabel` (book-storage.ts) is the SUMMARY spelling and answers
 * "which crate is this book in": the NUMBER is the identity, so a color with
 * no number renders null, and a color it does not recognise is dropped because
 * the number alone still names the crate.
 *
 * The gate asks a different question — "is a value a human recorded about to be
 * destroyed" — and BOTH of those drops are wrong for it:
 *
 *   • a recorded color with no number IS such a value (`fieldOverwritten`
 *     fires on it), and delegating produced `changed: true` carrying
 *     currentLabel null and nextLabel null: "recorded in no crate … will
 *     change to no crate";
 *   • dropping an unrecognised color made 'taupe 4' → 'blue 4' render as
 *     "recorded in 4 … will change to 4" — two strings a human reads as
 *     IDENTICAL, so the natural response is to click Continue and erase the
 *     color that was actually being destroyed.
 *
 * This used to be written as `formatCrateLabel(...) ?? formatCrateColorLabel(...)`,
 * which only reached the repaired fallback when the NUMBER was blank — i.e.
 * never, for the common numbered-crate case. So it COMPOSES instead, from
 * `formatCrateColorLabel` (case-insensitive, unknown color kept verbatim) and
 * the raw number.
 *
 *   ('blue','4')   → "Blue 4"      ('Blue','42')  → "Blue 42"
 *   ('taupe','4')  → "taupe 4"     (null,'42')    → "42"
 *   ('blue',null)  → "Blue"        (null,null)    → null
 *
 * INVARIANT (pinned by the label-matrix tests): whenever
 * `compareBookCratePlacement` reports `changed: true`, these two labels differ.
 * A confirmation that says "X will change to X" is worse than no confirmation
 * at all. The one residual collision is a crate NUMBER whose free text happens
 * to equal "<ColorLabel> <other number>" — ('blue','Shelf') vs (null,'Blue
 * Shelf') both render "Blue Shelf". That is a re-partition of identical text
 * between two columns rather than a move between two crates, and the
 * field-level `describeBookCrateChange` lines the dialog renders still name
 * exactly which column moves.
 */
export function formatCratePlacementLabel(
  crateColor: string | null | undefined,
  crateNumber: string | null | undefined,
): string | null {
  const color = formatCrateColorLabel(crateColor);
  const number = normalizeText(crateNumber);
  if (color && number) return `${color} ${number}`;
  return color ?? number;
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
//
// ═══ THE ACKNOWLEDGEMENT IS SCOPED, NEVER A BLANKET OFF-SWITCH ═══
//
// It used to be a bare `acknowledgeCrateChange: boolean`, and the server
// returned BEFORE computing any comparison when it was set. That is not "the
// user approved THIS change", it is "do not compare at all" — and because the
// client derived the flag from its own render-time snapshot, the FIRST AND
// ONLY request already carried it for every book that predicted a change. So:
// staging shows "Blue 4", someone edits the item to "Red 7" from the mobile
// item screen, the operator places onto a rack, the confirmation says "crate 4
// will be cleared", one request goes out pre-acknowledged, the gate is skipped,
// and Red 7 is destroyed. The user acknowledged erasing Blue 4 and the system
// erased Red 7 — the exact silent overwrite the gate exists to refuse.
//
// So an acknowledgement now names WHAT WAS SHOWN: an item id plus a
// fingerprint of the crate the client displayed for it. The server computes
// the conflict set FIRST, from the row it just read, and waives ONLY the
// conflicts whose fingerprint matches. Anything it was not shown still
// refuses, carrying the fresh payload so the client re-confirms against
// current truth.
//
// The fingerprint is a staleness proof, not an unforgeable capability token —
// a caller who already knows the current value can echo it. It does not need
// to be more: the user is authorised to change the crate; the gate exists to
// stop them changing it BLIND.
// ═══════════════════════════════════════════════════════════════════════════

export const BOOK_CRATE_CHANGE_REQUIRES_CONFIRMATION =
  'BOOK_CRATE_CHANGE_REQUIRES_CONFIRMATION' as const;

/**
 * A stable, comparable fingerprint of the crate a book is recorded in.
 *
 * Built from the NORMALISED pair, so it answers "is this the same crate the
 * user was looking at" rather than "is this byte-identical": " Blue "/" 4 "
 * and "blue"/"4" fingerprint the same, and a client that rendered "Bin"
 * still matches a row storing "BIN".
 *
 * JSON, not a joined string — `crate_number` is free text and production holds
 * "Blue Shelf", so ('blue','shelf 2') and ('blue shelf','2') would collide on
 * any separator that can appear inside a value. Same reasoning as the batching
 * key in syncBookCratePlacement.
 */
export function bookCrateFingerprint(
  crateColor: string | null | undefined,
  crateNumber: string | null | undefined,
): string {
  return JSON.stringify([normalizeCrateColor(crateColor), normalizeCrateNumber(crateNumber)]);
}

export interface BookCrateChangeItem {
  itemId: string;
  itemName: string;
  /** "Blue 4" — what the item says today. Null when it records no crate. */
  currentLabel: string | null;
  /** "Green 2" — or null when the destination is a rack (the crate is cleared). */
  nextLabel: string | null;
  /**
   * `bookCrateFingerprint` of the CURRENT crate this line described. The client
   * echoes it back to acknowledge THIS change and nothing else.
   */
  currentFingerprint: string;
}

/** One line of a scoped acknowledgement: "I was shown item X in crate F." */
export interface BookCrateAcknowledgedChange {
  itemId: string;
  currentFingerprint: string;
}

export interface BookCrateChangeDetail {
  reason: typeof BOOK_CRATE_CHANGE_REQUIRES_CONFIRMATION;
  items: BookCrateChangeItem[];
}

/**
 * The acknowledgement for a set of change lines: exactly the ids and
 * fingerprints that were rendered, and nothing else.
 *
 * Deliberately derived from the SHOWN items rather than assembled by hand at
 * each call site — the whole defect was a flag that existed independently of
 * what the user saw. Two fields per item keeps a 200-book bulk placement small
 * (~90 bytes each).
 *
 * The DESTINATION is deliberately NOT part of it. The server resolves the
 * destination from the same request and reads its crate columns off the
 * `locations` row, so there is nothing for the client to attest — and a
 * client-computed destination fingerprint would go stale the moment
 * `findOrCreateRackOrCrate` reuses an existing "Blue #4" for a typed "blue #4",
 * producing a mismatch the client could never resolve.
 */
export function toBookCrateAcknowledgement(
  items: ReadonlyArray<Pick<BookCrateChangeItem, 'itemId' | 'currentFingerprint'>>,
): BookCrateAcknowledgedChange[] {
  return items.map((i) => ({ itemId: i.itemId, currentFingerprint: i.currentFingerprint }));
}

/**
 * Did we already acknowledge EXACTLY this refusal?
 *
 * The client asks the user again whenever the server's payload says something
 * its last acknowledgement did not cover — which is precisely the stale-snapshot
 * case: the dialog showed "Blue 4", acknowledged Blue 4, and the server came
 * back naming Red 7. Re-asking there is the whole point of the scoped
 * acknowledgement; re-asking when the payload is identical to what we already
 * answered would be a loop, so that case falls through to the plain error.
 *
 * Order-insensitive: a 200-book batch must not re-ask because the server
 * enumerated the same books in a different order.
 */
export function bookCrateAcknowledgementsMatch(
  sent: ReadonlyArray<BookCrateAcknowledgedChange> | null | undefined,
  required: ReadonlyArray<BookCrateAcknowledgedChange>,
): boolean {
  const key = (a: BookCrateAcknowledgedChange) => `${a.itemId} ${a.currentFingerprint}`;
  const have = new Set((sent ?? []).map(key));
  return required.every((r) => have.has(key(r)));
}

/**
 * Index an acknowledgement for lookup. FIRST entry per item wins: a caller
 * that sends two fingerprints for one book is trying to cover both answers to
 * a question it was only asked once.
 */
export function bookCrateAcknowledgementIndex(
  ack: ReadonlyArray<BookCrateAcknowledgedChange> | null | undefined,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const a of ack ?? []) {
    if (!a || typeof a.itemId !== 'string') continue;
    if (out.has(a.itemId)) continue;
    out.set(a.itemId, a.currentFingerprint);
  }
  return out;
}

/**
 * Was THIS change — this item, in this crate, right now — the one the client
 * showed and the user agreed to?
 */
export function isBookCrateChangeAcknowledged(
  index: ReadonlyMap<string, string>,
  change: Pick<BookCrateChangeItem, 'itemId' | 'currentFingerprint'>,
): boolean {
  return index.get(change.itemId) === change.currentFingerprint;
}

/**
 * ONE constructor for a change line, so the fingerprint can never drift from
 * the labels it fingerprints. Returns null when nothing changes — the caller
 * must then NOT confirm.
 *
 * Both halves build their lines through here: the server gate (from the row it
 * just read) and the bulk dialog's local prediction (from its snapshot). That
 * is what makes a stale prediction detectable rather than authoritative — the
 * two fingerprints are computed by the same function from the same fields, so
 * they match exactly when, and only when, the snapshot is still true.
 */
export function describeBookCrateConflict(
  input: BookCratePlacementInput & { itemId: string; itemName: string },
): BookCrateChangeItem | null {
  const cmp = compareBookCratePlacement(input);
  if (!cmp.changed) return null;
  return {
    itemId: input.itemId,
    itemName: input.itemName,
    currentLabel: cmp.currentLabel,
    nextLabel: cmp.nextLabel,
    currentFingerprint: bookCrateFingerprint(input.currentColor, input.currentNumber),
  };
}

/**
 * Will the reconciliation ACTUALLY rewrite this book's summary after this
 * placement — or will it deliberately skip?
 *
 * `syncBookCratePlacement` only writes when every PLACED holding resolves to a
 * single rack/crate; a book whose stock is split across two placements is left
 * alone, because stamping the newest crate would assert something false about
 * the other half. For this org that skip is the COMMON outcome, not the rare
 * one — 405 units sit directly on Site DC4 (migration 0292), a NULL-kind
 * location that is a perfectly real second placement.
 *
 * The gate therefore has to ask the same question the sync will answer, or it
 * demands acknowledgement for a change that provably cannot happen: the
 * operator is told "crate 4 will be cleared", clicks Continue, and nothing is
 * cleared. A confirmation that is routinely false trains people to click
 * through the one that is true.
 *
 * `placedHoldings` must already EXCLUDE staging/unplaced (stock waiting to be
 * put away is not a location the book is in) — same filter the sync applies.
 * Returns true when the destination would be the only placement left, which is
 * exactly when the sync writes.
 */
export function bookCratePlacementWillSync(input: {
  placedHoldings: ReadonlyArray<{ locationId: string; quantity: number }>;
  destinationLocationId: string;
  fromLocationId: string;
  quantity: number;
}): boolean {
  for (const h of input.placedHoldings) {
    if (h.locationId === input.destinationLocationId) continue;
    // This placement drains the source; a holding it empties is not a rival
    // placement afterwards.
    const remaining =
      h.locationId === input.fromLocationId ? h.quantity - input.quantity : h.quantity;
    if (remaining > 0) return false;
  }
  return true;
}

/**
 * Narrow an `ActionError.details` blob to the confirmation payload.
 *
 * Server actions type `details` as `Record<string, unknown>`, so the client
 * has to check rather than cast. Anything that is not exactly this payload
 * (another conflict, a details-less error) returns null and the caller falls
 * back to showing the plain message — a malformed payload must never render
 * an empty "are you sure?" with nothing in it.
 *
 * `currentFingerprint` is REQUIRED, and a payload missing one is rejected
 * outright. A change line that cannot be acknowledged cannot be answered: the
 * dialog would render "Continue placement", send an acknowledgement that
 * matches nothing, and be refused again forever. Falling back to the plain
 * error message is the honest outcome.
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
    if (typeof it.currentFingerprint !== 'string' || it.currentFingerprint.length === 0) return null;
    items.push({
      itemId: it.itemId,
      itemName: it.itemName,
      currentLabel: typeof it.currentLabel === 'string' ? it.currentLabel : null,
      nextLabel: typeof it.nextLabel === 'string' ? it.nextLabel : null,
      currentFingerprint: it.currentFingerprint,
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
export function summarizeBookCrateChanges(
  // Structurally typed to the two fields it reads, not to the full change
  // line: this is presentation, and it has no business requiring the
  // acknowledgement fingerprint just to count groups.
  items: ReadonlyArray<Pick<BookCrateChangeItem, 'currentLabel' | 'nextLabel'>>,
): {
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

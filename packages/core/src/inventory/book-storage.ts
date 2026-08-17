/**
 * Book-specific storage location helpers. Books live on numbered racks
 * (rack number + row letter) and inside color-coded crates.
 * Stored as flat keys inside inventory_items.custom_fields:
 *   - book_rack_number   e.g. "38"
 *   - book_rack_row      e.g. "A"
 *   - book_crate_color   slug from CRATE_COLORS, e.g. "red"
 *   - book_crate_number  e.g. "5"
 *
 * Going through custom_fields keeps the schema unchanged — same pattern
 * the existing book "author" field already uses.
 *
 * THESE KEYS ARE A SUMMARY, NEVER THE SOURCE OF TRUTH. Where a book
 * physically sits is `item_stock_levels -> locations` (a real rack/crate row
 * carrying locations.crate_color / locations.crate_number). The custom_fields
 * pair exists so a single item row can be printed, filtered and exported
 * without joining holdings. See `book-crate-placement.ts` for the ONE rule that
 * decides when a placement is allowed to re-synchronize this summary.
 *
 * NO ALLOWED-NUMBERS LIST ON PURPOSE. An earlier `CRATE_NUMBERS = 1..9`
 * constant lived here with zero consumers, and production contradicts it: the
 * live book_crate_number values include 0, 1..16 and the free text "Bin",
 * "BIN" and "Blue Shelf". A crate number is FREE TEXT — normalise it (trim,
 * compare case-insensitively) but never range-validate it, or real books get
 * rejected. Do not "fix" this by reintroducing an enum.
 *
 * Lives in @stockpilot/core (not apps/web) because it is pure and both web and
 * mobile read these keys; apps/web/src/lib/book-storage.ts re-exports it so
 * existing imports keep working — the same shim pattern crate-colors.ts used.
 */

import { getCrateColor } from './crate-colors';
import {
  formatRackLabel,
  formatRackPosition,
  parseRackLabel,
  type RackPosition,
} from './rack-label';

/**
 * K-12 + post-secondary grade levels for educational books. Order
 * matters: the form's <Select> renders in this order, and the lookup
 * route's grade detector returns one of these slugs.
 */
export const GRADES = [
  'Pre-K',
  'K',
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  '10',
  '11',
  '12',
  'College',
  'Adult',
] as const;

export type Grade = (typeof GRADES)[number];

/** Formats a grade slug for display ("3" → "Grade 3", "K" → "Kindergarten"). */
export function formatGrade(slug: string | null | undefined): string | null {
  if (!slug) return null;
  if (slug === 'K') return 'Kindergarten';
  if (slug === 'Pre-K') return 'Pre-K';
  if (slug === 'College' || slug === 'Adult') return slug;
  if (/^\d{1,2}$/.test(slug)) return `Grade ${slug}`;
  return slug;
}

export interface BookStorageInfo {
  rackNumber: string | null;
  rackRow: string | null;
  crateColor: string | null;
  crateNumber: string | null;
  /** Grade level slug from GRADES. */
  grade: string | null;
  /** Compact "rack-row" label, e.g. "38-A" — null when both pieces missing. */
  rackLabel: string | null;
  /**
   * Compact crate label. The NUMBER identifies the crate; the color is an
   * optional visual aid. "Red 5" when a known color + number are set, "5" for
   * a number with no (or unknown) color, null when there's no number.
   */
  crateLabel: string | null;
}

function strOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length === 0 ? null : s;
}

/**
 * ═══ THE TWO CRATE SPELLINGS — documented HERE, in ONE place ═══
 *
 * A crate is written two different ways on purpose. Do not collapse them:
 *
 *   • `formatCrateLocationName()` → "Blue #42". This is the locations.name of
 *     the crate ROW. Migration 0270's partial unique index keys crate identity
 *     on `lower(name)` where kind in ('rack','crate'), so this string IS THE
 *     DEDUPE KEY — change its shape and every existing crate stops matching,
 *     minting duplicate `locations` rows. It stays "#"-style forever.
 *
 *   • `formatCrateLabel()` → "Blue 42". This is how a BOOK's crate SUMMARY is
 *     shown to a human (item detail, exports, pick/count sheets, the placement
 *     confirmation copy). It never reaches the database and carries no
 *     identity, so it is free to read nicely.
 *
 * BOTH are driven by the NUMBER. A crate is identified by its number; the
 * color is an optional visual aid (staff routinely assign a crate number
 * before they know which colored crate it lands in). A color with no number is
 * not a crate — `formatCrateLabel` yields null for it.
 *
 * Color rendering goes through the CRATE_COLORS registry so a stored slug
 * ("blue") prints as its label ("Blue"). `getCrateColor` is case-insensitive,
 * so a legacy row spelling it "Blue" resolves too — it used to be an exact
 * match, and this function then dropped a well-known color as "unrecognised"
 * and rendered the bare number.
 *
 * A genuinely UNRECOGNISED color is never invented away: this SUMMARY path
 * drops it (the number alone identifies the crate) and the location-name path
 * keeps the raw text, because a location name must stay reconstructible from
 * what the user typed. The placement GATE keeps it too — see
 * `formatCratePlacementLabel`, which is a different spelling on purpose and
 * must not be re-merged with this one.
 */
export function formatCrateLabel(
  crateColor: string | null | undefined,
  crateNumber: string | null | undefined,
): string | null {
  const number = strOrNull(crateNumber);
  if (!number) return null;
  const color = getCrateColor(strOrNull(crateColor));
  return color ? `${color.label} ${number}` : number;
}

/**
 * The "#"-style crate `locations.name` — see the split documented on
 * `formatCrateLabel` above. Returns '' when there is nothing to name, so the
 * caller can fall back (a crate created with only a rack number reuses it).
 *
 *   ('blue', '42')     → "Blue #42"
 *   ('taupe', '42')    → "taupe #42"   (unknown color kept verbatim)
 *   (null,   '42')     → "Crate #42"   (a number alone IS a crate — see
 *                                       isCrateDestination in
 *                                       book-crate-placement.ts)
 *   ('blue', null)     → ""            (no identity yet)
 *
 * Callers do NOT invent a number for that last case. It used to fall back to
 * the rack number ("Blue #A1"), which mixed two different destinations into one
 * name; `planNewLocation` (new-location.ts) now refuses a colour with no number
 * outright, and it is the only thing that should ever call this.
 *
 * ═══ THE POSITION IS PART OF THE NAME, AND THAT IS THE DEDUPE DECISION ═══
 *
 *   ('gray', 'BIN', {rackNumber:'43', rackRow:'B'}) → "Gray #BIN on rack 43-B"
 *   ('blue', '13',  {rackNumber:'38-B'})            → "Blue #13 on rack 38-B"
 *   ('blue', 'Shelf', null)                         → "Blue #Shelf"
 *
 * A CRATE SITS ON A RACK, and a crate's identity is (colour, number, rack
 * number, rack row) — NEVER colour+number alone. Production proves it: "gray
 * BIN" exists on FIVE distinct rack positions (43-B, 43-C, 42-B, 42-C, 41-C),
 * "yellow 5" on two, "blue 0" on three. "BIN" is a generic label repeated per
 * rack, not one bin.
 *
 * Migration 0270's partial unique index keys crate identity on `lower(name)`,
 * and `findOrCreateRackOrCrate` matches the same way. So folding the position
 * INTO the name is what keeps those five bins five `locations` rows: any
 * position-blind key would collapse them into one and stamp one crate's books
 * with another crate's location — a worse integrity failure than the bug this
 * change fixes. Doing it here rather than in the match predicate also means no
 * index migration, and every picker that renders `locations.name` shows a label
 * that distinguishes the bins instead of five identical "Gray #BIN" rows.
 *
 * A POSITION-LESS CRATE KEEPS ITS OLD NAME EXACTLY. That is not a nicety, it is
 * the backward-compatibility guarantee: every crate row in production today was
 * created position-less, so put-away must still FIND and REUSE it (production
 * really does hold a crate whose books have no rack at all — 5 books in blue
 * "Blue Shelf"). A position-less crate is a legitimate, permanent shape; never
 * backfill one.
 *
 * The rack half is composed by `formatRackPosition` (rack-label.ts), which
 * decomposes first — so "38-B" typed into an "On rack" box names "…on rack
 * 38-B", not "…on rack 38-B-B", and a row with no number names nothing at all.
 */
export function formatCrateLocationName(
  crateColor: string | null | undefined,
  crateNumber: string | null | undefined,
  position?: RackPosition | null,
): string {
  const number = strOrNull(crateNumber);
  if (!number) return '';
  const raw = strOrNull(crateColor);
  const known = getCrateColor(raw);
  const word = known ? known.label : raw;
  const base = word ? `${word} #${number}` : `Crate #${number}`;
  const rack = formatRackPosition(position);
  return rack ? `${base}${CRATE_ON_RACK} ${rack}` : base;
}

/**
 * The separator `formatCrateLocationName` folds a crate's POSITION into its
 * name with. Exported so the one reader of that suffix (`locationNameSitsOnRack`
 * below) cannot spell it differently from the writer — the two halves of a
 * name-carried fact are exactly the pair that drifts.
 */
export const CRATE_ON_RACK = ' on rack';

/**
 * Does a `locations.name` place stock ON the rack labelled `rackLabel`?
 *
 * TRUE in exactly two shapes, and this is the whole reason the function exists:
 *
 *   • the location IS that rack           — "43-B"                  vs "43-B"
 *   • the location is a CRATE SITTING ON IT — "Gray #BIN on rack 43-B" vs "43-B"
 *
 * The second shape is why a caller cannot just compare strings. Since crate
 * identity started carrying the position (see `formatCrateLocationName`), a
 * positioned crate's rack is INSIDE ITS NAME and nowhere else on a holding —
 * `RackHoldingLike` carries a name, a quantity and a kind, never a rack pair.
 * A reader that missed this would call a book in "Gray #BIN on rack 43-B" a
 * contradiction of its own "43-B" summary and blank a row that is TRUE.
 *
 * Both sides are canonicalised through `parseRackLabel`/`formatRackLabel`
 * before comparing, so a legacy rack stored "22 - B" still matches the summary
 * "22-B" — the same tolerance `findOrCreateRackOrCrate` applies at the write
 * boundary, for the same reason (the 2026-07-23 shape incident).
 *
 * NOTE — the crate arm depends on the suffix surviving in the name. It is a
 * rename away from being lost, which is why `LocationsService.update` refuses a
 * rename that strips it rather than leaving this function to guess.
 */
export function locationNameSitsOnRack(
  locationName: string | null | undefined,
  rackLabel: string | null | undefined,
): boolean {
  const canonRack = canonicalRack(rackLabel);
  if (!canonRack) return false;
  const name = (locationName ?? '').trim();
  if (!name) return false;
  if (canonicalRack(name) === canonRack) return true;
  // lastIndexOf, not endsWith: the tail is canonicalised too, so a crate named
  // "…on rack 43 - B" still resolves onto 43-B.
  const idx = name.toLowerCase().lastIndexOf(`${CRATE_ON_RACK} `);
  if (idx < 0) return false;
  return canonicalRack(name.slice(idx + CRATE_ON_RACK.length + 1)) === canonRack;
}

/** A rack label reduced to the one spelling every comparison uses. */
function canonicalRack(label: string | null | undefined): string {
  return formatRackLabel(parseRackLabel(label)).trim().toLowerCase();
}

/**
 * THE RACK POSITION a `locations.name` stands at — for the RACK COLUMN.
 *
 * ═══ THE LEAK THIS CLOSES (Hunger Games, L4L, 2026-08-17) ═══
 *
 * A book with 97 loose on rack "38-B" and 20 in crate "Blue #0 on rack 38-B"
 * rendered its Rack column as "38-B, Blue #0 on rack 38-B" — two entries for
 * ONE rack, because the holdings arm of `placementPhysicalNames` listed every
 * holding's full name. The Rack column answers "which racks does a picker walk
 * to"; the crate's identity ("Blue 0") is the CRATE column's job. So a crate
 * holding contributes its POSITION here and its identity there:
 *
 *   • a RACK row                     → its own label, canonicalised ("38-B")
 *   • a crate "… on rack X"          → X, canonicalised — the rack it SITS ON
 *   • a POSITION-LESS crate          → its own name ("Blue Shelf"): it sits on
 *                                       no rack, and its name is the only place
 *                                       a picker can walk to
 *
 * Canonicalised through the same `parseRackLabel`/`formatRackLabel` pair as
 * `locationNameSitsOnRack`, so a legacy "22 - B" and a summary "22-B" collapse
 * to one entry — which is what lets the caller DISTINCT the result and count
 * racks honestly. Two DIFFERENT racks stay two entries; that is the split case
 * the books header exists to count.
 *
 * `kind` decides the RACK arm: only a row the caller says is a rack has its
 * name decomposed as a rack label. A crate row, or a holding whose kind the
 * caller did not carry, is read by its name — the "on rack" suffix if it has
 * one, its own name otherwise. Absence of evidence resolves to the old
 * behaviour (the full name), never to a guess.
 */
export function rackPositionOfLocationName(
  locationName: string | null | undefined,
  kind?: string | null,
): string {
  const name = (locationName ?? '').trim();
  if (!name) return '';
  if (kind === 'rack') return formatRackLabel(parseRackLabel(name)).trim() || name;
  const idx = name.toLowerCase().lastIndexOf(`${CRATE_ON_RACK} `);
  if (idx >= 0) {
    const rack = formatRackLabel(parseRackLabel(name.slice(idx + CRATE_ON_RACK.length + 1))).trim();
    if (rack) return rack;
  }
  return name;
}

/**
 * Reads the non-book rack number/row out of an item's custom_fields.
 * Items use the neutral rack_number / rack_row keys (vs books which
 * use book_rack_* — both are matched by InventoryService.list per
 * item-type, so they stay isolated).
 */
export function readItemRack(
  customFields: Record<string, unknown> | null | undefined,
): { rackNumber: string | null; rackRow: string | null; rackLabel: string | null } {
  const cf = customFields ?? {};
  const rackNumber = strOrNull(cf.rack_number);
  const rackRow = strOrNull(cf.rack_row);
  const rackLabel =
    rackNumber || rackRow ? [rackNumber, rackRow].filter(Boolean).join('-') : null;
  return { rackNumber, rackRow, rackLabel };
}

/**
 * DISPLAY ONLY. Reads an item's rack/crate/grade for SHOWING to a human,
 * accepting the legacy and cross-family spellings that older imported rows
 * still carry alongside today's canonical keys.
 *
 * ═══ WHY THIS IS SEPARATE FROM `readBookStorage`, AND MUST STAY SEPARATE ═══
 *
 * The obvious tidy-up is to teach `readBookStorage` these fallbacks and delete
 * this function. That would be a data-integrity bug wearing a cleanup's
 * clothes.
 *
 * `readBookStorage` feeds `InventoryService`'s before-map, which is what the
 * crate and rack acknowledgement gates FINGERPRINT. A fingerprint is a promise
 * to a client: the phone computes the same pair and sends it back to prove it
 * answered the question it was actually shown. Widening what the server reads
 * would make the server fingerprint a pair the shipped client cannot compute
 * — so every live device's acknowledgement stops matching and dead-ends,
 * which is the exact Critical the rack channel was designed around. It would
 * also start ASKING about racks that only exist under a legacy key, for books
 * whose canonical pair is empty.
 *
 * So the split is deliberate:
 *   - `readBookStorage` / `readItemRack` — CANONICAL keys only. Anything that
 *     compares, gates, fingerprints, or writes uses these.
 *   - `readDisplayStorage` — canonical PLUS legacy. Anything that only renders
 *     a label to a human uses this.
 *
 * Never use this to decide something. Only to show it.
 *
 * The legacy keys are load-bearing rather than dead weight: older imports
 * stamped a single free-text rack label (`rackLabel` / `rack_label` / `rack`)
 * before the structured number/row split existed, and the bare `crateColor` /
 * `crate_color` variants predate the `book_` prefix. Reading only the
 * canonical keys is what made book crate colour and number render blank on the
 * phone (owner caught 2026-07-10).
 */
export interface DisplayStorageInfo {
  /** Structured "38-A" when present, else whatever legacy free-text label exists. */
  rackLabel: string | null;
  /**
   * The structured pieces, kept SEPARATE from the combined label because
   * downstream formatters need them apart: a display label ("38 · A") and a
   * `locations.name` ("38-A") are different strings, and comparing the wrong
   * one against a holding hid the rack row for essentially every item with a
   * holding once already.
   */
  rackNumber: string | null;
  rackRow: string | null;
  /**
   * The legacy free-text value ALONE — null when the structured pair supplied
   * `rackLabel`. Exposed separately so a caller can tell "this rack is
   * recorded the old way" from "this rack is recorded properly", which is a
   * different sentence to a human and a different confidence to a formatter.
   */
  legacyRackLabel: string | null;
  crateColor: string | null;
  crateNumber: string | null;
  grade: string | null;
}

/**
 * `strOrNull` with objects and arrays rejected instead of stringified.
 *
 * NOT a fix applied to `strOrNull` itself, deliberately. That helper coerces
 * with `String(v)`, which is CORRECT for the scalars that actually occur —
 * `book_rack_number: 38` written as a JSON number must read "38" — and the
 * canonical readers' output feeds gate fingerprints, so narrowing what they
 * accept would silently change what a book fingerprints to. An object,
 * though, has no sensible rendering: `String({})` is "[object Object]", and
 * custom_fields is operator- and import-writable JSONB, so that string is
 * reachable on a real item screen. Display refuses it; the canonical readers
 * keep their existing coercion.
 */
function displayStr(v: unknown): string | null {
  if (typeof v === 'object' && v !== null) return null;
  return strOrNull(v);
}

export function readDisplayStorage(
  customFields: Record<string, unknown> | null | undefined,
  itemType: string | null | undefined,
): DisplayStorageInfo {
  const cf = customFields ?? {};
  const isBook = itemType === 'book';

  // Each family's OWN key first, then the other family's. The cross-family
  // fallback is display-safe (a rack is a rack whichever key recorded it) but
  // is deliberately second, so a row carrying both is described by the key
  // that belongs to its type. `book_rack_*` and `rack_*` are separate columns
  // by design (0068) and are matched per item-type everywhere that decides.
  const rackNumber = isBook
    ? (displayStr(cf.book_rack_number) ?? displayStr(cf.rack_number))
    : (displayStr(cf.rack_number) ?? displayStr(cf.book_rack_number));
  const rackRow = isBook
    ? (displayStr(cf.book_rack_row) ?? displayStr(cf.rack_row))
    : (displayStr(cf.rack_row) ?? displayStr(cf.book_rack_row));

  const structured =
    rackNumber || rackRow ? [rackNumber, rackRow].filter(Boolean).join('-') : null;
  // The legacy single-value label is the LAST resort, never a merge: a row with
  // a structured pair AND a stale free-text label is described by the pair,
  // because the pair is what every writer maintains.
  const legacy =
    displayStr(cf.rackLabel) ?? displayStr(cf.rack_label) ?? displayStr(cf.rack);

  return {
    rackLabel: structured ?? legacy,
    rackNumber,
    rackRow,
    // Only when it is actually the value being shown. A stale free-text label
    // sitting behind a live structured pair is not "the legacy rack" — it is
    // dead data, and reporting it would let a formatter render both.
    legacyRackLabel: structured ? null : legacy,
    crateColor:
      displayStr(cf.book_crate_color) ??
      displayStr(cf.crateColor) ??
      displayStr(cf.crate_color),
    crateNumber:
      displayStr(cf.book_crate_number) ??
      displayStr(cf.crateNumber) ??
      displayStr(cf.crate_number),
    grade: displayStr(cf.book_grade) ?? displayStr(cf.grade),
  };
}

/**
 * Reads the book-storage fields out of an inventory item's custom_fields
 * JSONB. Returns nulls for any missing piece so callers can render
 * conditionally without checking each field individually.
 *
 * CANONICAL KEYS ONLY — see `readDisplayStorage` above for why this must never
 * learn the legacy spellings.
 */
export function readBookStorage(
  customFields: Record<string, unknown> | null | undefined,
): BookStorageInfo {
  const cf = customFields ?? {};
  const rackNumber = strOrNull(cf.book_rack_number);
  const rackRow = strOrNull(cf.book_rack_row);
  const crateColor = strOrNull(cf.book_crate_color);
  const crateNumber = strOrNull(cf.book_crate_number);
  const grade = strOrNull(cf.book_grade);
  const rackLabel =
    rackNumber || rackRow ? [rackNumber, rackRow].filter(Boolean).join('-') : null;
  return {
    rackNumber,
    rackRow,
    crateColor,
    crateNumber,
    grade,
    rackLabel,
    crateLabel: formatCrateLabel(crateColor, crateNumber),
  };
}

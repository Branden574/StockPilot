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
 *   ('blue', null)     → ""            (no identity yet — caller falls back)
 */
export function formatCrateLocationName(
  crateColor: string | null | undefined,
  crateNumber: string | null | undefined,
): string {
  const number = strOrNull(crateNumber);
  if (!number) return '';
  const raw = strOrNull(crateColor);
  const known = getCrateColor(raw);
  const word = known ? known.label : raw;
  return word ? `${word} #${number}` : `Crate #${number}`;
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
 * Reads the book-storage fields out of an inventory item's custom_fields
 * JSONB. Returns nulls for any missing piece so callers can render
 * conditionally without checking each field individually.
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

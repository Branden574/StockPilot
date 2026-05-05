/**
 * Book-specific storage location helpers. Books live on numbered racks
 * (rack number + row letter) and inside color-coded crates (1-9).
 * Stored as flat keys inside inventory_items.custom_fields:
 *   - book_rack_number   e.g. "38"
 *   - book_rack_row      e.g. "A"
 *   - book_crate_color   slug from CRATE_COLORS, e.g. "red"
 *   - book_crate_number  e.g. "5"
 *
 * Going through custom_fields keeps the schema unchanged — same pattern
 * the existing book "author" field already uses.
 */

export const CRATE_COLORS = [
  { slug: 'red', label: 'Red', hex: '#ef4444' },
  { slug: 'orange', label: 'Orange', hex: '#f97316' },
  { slug: 'yellow', label: 'Yellow', hex: '#eab308' },
  { slug: 'green', label: 'Green', hex: '#22c55e' },
  { slug: 'blue', label: 'Blue', hex: '#3b82f6' },
  { slug: 'purple', label: 'Purple', hex: '#a855f7' },
  { slug: 'pink', label: 'Pink', hex: '#ec4899' },
  { slug: 'black', label: 'Black', hex: '#27272a' },
  { slug: 'white', label: 'White', hex: '#f4f4f5' },
  { slug: 'gray', label: 'Gray', hex: '#9ca3af' },
] as const;

export type CrateColorSlug = (typeof CRATE_COLORS)[number]['slug'];

export const CRATE_NUMBERS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;

export function getCrateColor(slug: string | null | undefined) {
  if (!slug) return null;
  return CRATE_COLORS.find((c) => c.slug === slug) ?? null;
}

export interface BookStorageInfo {
  rackNumber: string | null;
  rackRow: string | null;
  crateColor: string | null;
  crateNumber: string | null;
  /** Compact "rack-row" label, e.g. "38-A" — null when both pieces missing. */
  rackLabel: string | null;
  /** Compact "color #N" label, e.g. "Red 5" — null when either piece missing. */
  crateLabel: string | null;
}

function strOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length === 0 ? null : s;
}

/**
 * Reads the four book-storage fields out of an inventory item's
 * custom_fields JSONB. Returns nulls for any missing piece so callers
 * can render conditionally without checking each field individually.
 */
export function readBookStorage(
  customFields: Record<string, unknown> | null | undefined,
): BookStorageInfo {
  const cf = customFields ?? {};
  const rackNumber = strOrNull(cf.book_rack_number);
  const rackRow = strOrNull(cf.book_rack_row);
  const crateColor = strOrNull(cf.book_crate_color);
  const crateNumber = strOrNull(cf.book_crate_number);
  const rackLabel =
    rackNumber || rackRow ? [rackNumber, rackRow].filter(Boolean).join('-') : null;
  const color = getCrateColor(crateColor);
  const crateLabel =
    color && crateNumber ? `${color.label} ${crateNumber}` : null;
  return { rackNumber, rackRow, crateColor, crateNumber, rackLabel, crateLabel };
}

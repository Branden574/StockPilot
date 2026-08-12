/**
 * Color-coded book crates (1-9). Shared by web + mobile so both surfaces
 * render the same swatch for a stored `book_crate_color` slug. Moved here
 * from apps/web/src/lib/book-storage.ts (which re-exports for compatibility)
 * when mobile book details gained the crate color swatch.
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

/**
 * Resolve a stored crate color to its registry entry. CASE-INSENSITIVE and
 * whitespace-trimming, deliberately.
 *
 * It used to be an exact `c.slug === slug` match, and that single line was the
 * root of a whole family of disagreements: three helpers called it three
 * different ways (two lower-cased first, one did not), so `formatCrateLabel`
 * silently DROPPED a perfectly well-known color merely because the row spelled
 * it "Blue" — turning "Blue 42" into "42" and making the placement gate say
 * "recorded in 42 … will change to 42".
 *
 * Mixed case reaches the database through shipped UI: the Transfer dialog's
 * crate-color box is free text ("e.g. Blue") and `findOrCreateRackOrCrate`
 * dedupes on `lower(name)`, so an existing row's `crate_color` keeps whatever
 * casing first created it forever. Writers normalise now (see
 * `normalizeCrateColor`), but years of rows already say "Blue", so the READER
 * has to be forgiving. Widening a lookup can only turn a miss into a hit, so
 * every caller either improves or is unaffected.
 */
export function getCrateColor(slug: string | null | undefined) {
  if (!slug) return null;
  const key = String(slug).trim().toLowerCase();
  if (key.length === 0) return null;
  return CRATE_COLORS.find((c) => c.slug === key) ?? null;
}

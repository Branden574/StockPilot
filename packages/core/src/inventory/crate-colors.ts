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

export function getCrateColor(slug: string | null | undefined) {
  if (!slug) return null;
  return CRATE_COLORS.find((c) => c.slug === slug) ?? null;
}

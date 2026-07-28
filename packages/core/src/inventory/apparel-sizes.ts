/**
 * The canonical apparel letter sizes — ONE list, shared by web and Expo.
 *
 * There is exactly one physical size per entry. That is the whole point: the
 * built-in `apparel_alpha` size scale seeded by migration 0294 deliberately
 * carries the UNION of every spelling the codebase has ever emitted or parsed
 * (14 rows: the nine below PLUS the 2XL/3XL/4XL/5XL aliases and 6XL), so that
 * nothing which renders today stops rendering. That union is right for
 * MATCHING an inbound string; it is wrong for OFFERING choices to a person.
 *
 * Rendering the union as a picker shows XXL and 2XL as two separate chips for
 * the same shirt, and a user who taps both creates two inventory items for one
 * physical size — with two SKUs, two stock levels and no way for a pick list to
 * know they are the same thing. Web has always offered these nine; the native
 * fallback must offer the same nine or the two surfaces disagree about what a
 * size run even is.
 *
 * This list is the FALLBACK vocabulary only, used when a category carries no
 * `size_scale_id` of its own (which today is every category — the 0294 scales
 * are opt-in and nothing has been backfilled). A category that DOES carry a
 * scale renders that scale verbatim, in its own sort order: a shoe run is
 * '7'..'15' with halves and could never be expressed by a letter list.
 *
 * Alias resolution — deciding that a stored 'XXL' and an imported '2XL' are the
 * same variant, and which one is canonical for display — is deliberately NOT
 * here. That is Tasks 17/19 (import matching and the variant backfill), and
 * inventing a mapping now would silently merge stock. `size-run.ts` already
 * PARSES both spellings off existing names; parsing is not merging.
 */
export const APPAREL_ALPHA_SIZES = [
  'XS',
  'S',
  'M',
  'L',
  'XL',
  'XXL',
  'XXXL',
  'XXXXL',
  'XXXXXL',
] as const;

export type ApparelAlphaSize = (typeof APPAREL_ALPHA_SIZES)[number];

const CANONICAL_APPAREL_SIZES: ReadonlySet<string> = new Set<string>(APPAREL_ALPHA_SIZES);

/**
 * True when `value` is one of the nine canonical spellings.
 *
 * Compared case-insensitively on the trimmed value because the caller is
 * usually filtering rows read out of `size_scale_values`, whose `value` column
 * is free text. It is NOT an alias check: '2XL' returns false, on purpose.
 */
export function isApparelAlphaSize(value: string): boolean {
  return CANONICAL_APPAREL_SIZES.has(value.trim().toUpperCase());
}

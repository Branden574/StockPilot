/**
 * Which size chips the Instant Size Count tally screen shows.
 *
 * Pure — no React, no network — so it can be unit-tested directly.
 *
 * The old screen hardcoded nine garment sizes (XS..5XL). That made a whole
 * category of count impossible rather than merely awkward: a shoe run is 9,
 * 9.5, 10, 10.5 and there was no chip to tap. Once a session names a product
 * group (migration 0302) the chips come from that group's own size scale.
 *
 * Two rules the fallback has to keep:
 *   1. an UNGROUPED session behaves exactly as it did before — the legacy nine;
 *   2. a size that already has counts against it is ALWAYS shown, even if it is
 *      not on the group's scale. Hiding a chip would hide a tally, and the
 *      counter would see a total that its visible chips do not add up to.
 */

/** The pre-0302 chip set. Still correct for any ungrouped session. */
export const LEGACY_SIZE_CHIPS = [
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

export function resolveSizeChips(input: {
  /** The group's size scale, already in scale order. Empty/absent = ungrouped
   *  session, or a group with no scale assigned. */
  groupSizes?: readonly string[] | null;
  /** Sizes that already carry a tally on this session. */
  talliedSizes?: readonly string[] | null;
}): string[] {
  const scale = (input.groupSizes ?? []).filter((s) => s.trim().length > 0);
  const base = scale.length > 0 ? scale : [...LEGACY_SIZE_CHIPS];

  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of base) {
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  // Anything counted but off-scale is appended rather than dropped.
  for (const s of input.talliedSizes ?? []) {
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

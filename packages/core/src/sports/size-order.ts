/**
 * Size ORDERING — the one place that decides what "next size up" means.
 *
 * A size run is only readable when its rows are in physical order: 10 follows
 * 9, XL follows L. String comparison gets both wrong ('10' < '9', 'XL' < 'XS'),
 * so every surface that renders a run — the PO receive grid, the mobile PO
 * screen, the size-run add mode — sorts through here.
 *
 * PRECEDENCE, deliberately:
 *
 *   1. The category's `size_scale_values.sort_order`, when the caller supplies
 *      one. That is the authored truth: a scale can carry halves, widths and a
 *      house order this module could never infer.
 *   2. A numeric fallback, for shoe-style runs on a category with no scale
 *      (which today is every category — the 0294 scales are opt-in and nothing
 *      has been backfilled).
 *   3. An alpha ladder, for letter apparel on a category with no scale.
 *   4. Alphabetical, for anything unrecognised, so the order is at least stable.
 *
 * ORDERING IS NOT IDENTITY. Giving 'XXL' and '2XL' the same rank puts the two
 * rows next to each other; it does NOT declare them the same variant. Alias
 * resolution — deciding a stored 'XXL' and an imported '2XL' are one physical
 * size — is Tasks 17/19 and would silently merge stock if done here. See the
 * header of `../inventory/apparel-sizes.ts`.
 */

import { normalizeSizeValue } from './variant-keys';

/** One row of a size scale, as read from `size_scale_values`. */
export interface SizeScaleValueOrder {
  /** The size AS PRINTED: 'XL', '10.5'. */
  value: string;
  /** The scale's stored match form, when the caller has it. */
  normalized?: string | null;
  /** `size_scale_values.sort_order` — display order within the scale. */
  sortOrder: number;
}

/** Rank tiers. A lower tier always sorts first, whatever the within-tier rank. */
const TIER_SCALE = 0;
const TIER_NUMERIC = 1;
const TIER_ALPHA = 2;
const TIER_UNKNOWN = 3;
const TIER_MISSING = 4;

/**
 * Letter-size ladder used ONLY when no scale is supplied.
 *
 * Both spellings of each extended size map to the same rank so a run that
 * happens to hold one of each renders them adjacent instead of at opposite
 * ends. Ranks are spaced by 10 so a future insert needs no renumbering.
 */
const ALPHA_LADDER: Readonly<Record<string, number>> = {
  XXS: 0,
  '2XS': 0,
  XS: 10,
  S: 20,
  M: 30,
  L: 40,
  XL: 50,
  XXL: 60,
  '2XL': 60,
  XXXL: 70,
  '3XL': 70,
  XXXXL: 80,
  '4XL': 80,
  XXXXXL: 90,
  '5XL': 90,
  XXXXXXL: 100,
  '6XL': 100,
};

/** A normalized-size -> sort_order lookup. Build it once per scale, not per compare. */
export type SizeOrderIndex = ReadonlyMap<string, number>;

/**
 * Build the lookup a comparator consults.
 *
 * Both the printed `value` and the stored `normalized` form are admitted as
 * keys (the same two-key posture `InventoryService.loadSizeScale` uses) because
 * an item's `variant_size` may have been written from either. The FIRST
 * sort_order for a key wins: a scale that repeats a value is malformed, and
 * silently taking the last one would make the order depend on row order.
 */
export function buildSizeOrder(rows: readonly SizeScaleValueOrder[]): SizeOrderIndex {
  const out = new Map<string, number>();
  const add = (raw: string | null | undefined, sortOrder: number) => {
    const key = normalizeSizeValue(raw);
    if (key === null) return;
    if (out.has(key)) return;
    out.set(key, sortOrder);
  };
  for (const r of rows) {
    add(r.value, r.sortOrder);
    add(r.normalized, r.sortOrder);
  }
  return out;
}

/** Where one size sits: tier first, then the rank inside that tier. */
function rankOf(
  raw: string | null | undefined,
  order?: SizeOrderIndex | null,
): { tier: number; rank: number; key: string } {
  const key = normalizeSizeValue(raw);
  if (key === null) return { tier: TIER_MISSING, rank: 0, key: '' };

  const scaled = order?.get(key);
  if (scaled !== undefined) return { tier: TIER_SCALE, rank: scaled, key };

  if (/^\d+(\.\d+)?$/.test(key)) return { tier: TIER_NUMERIC, rank: Number(key), key };

  const alpha = ALPHA_LADDER[key];
  if (alpha !== undefined) return { tier: TIER_ALPHA, rank: alpha, key };

  return { tier: TIER_UNKNOWN, rank: 0, key };
}

/**
 * Compare two sizes for display order. Returns the usual negative / zero /
 * positive so it drops straight into `Array.prototype.sort`.
 *
 * Zero means "same position in the run", which is a legitimate outcome (two
 * rows of the same size, or the XXL/2XL tie). Callers that need a total order
 * should rely on `sortBySizeOrder`, whose sort is stable.
 */
export function compareSizeValues(
  a: string | null | undefined,
  b: string | null | undefined,
  order?: SizeOrderIndex | null,
): number {
  const ra = rankOf(a, order);
  const rb = rankOf(b, order);
  if (ra.tier !== rb.tier) return ra.tier - rb.tier;
  if (ra.tier === TIER_MISSING) return 0;
  // The unknown tier has no rank of its own (every row is 0), so the
  // normalized text IS the order there — without it a run of unrecognised
  // sizes would render in whatever order the rows happened to arrive.
  if (ra.tier === TIER_UNKNOWN) return ra.key < rb.key ? -1 : ra.key > rb.key ? 1 : 0;
  // Every other tier has a real rank. Equal ranks are a genuine tie (two rows
  // of one size, or the XXL/2XL display tie) and stay tied so the stable sort
  // in `sortBySizeOrder` preserves the order the lines were added in.
  return ra.rank - rb.rank;
}

/**
 * Sort rows by the size each one carries, without mutating the input.
 *
 * `Array.prototype.sort` has been stable since ES2019, so rows that tie (same
 * size, or the XXL/2XL display tie) keep the order they arrived in — which for
 * a PO is the order the lines were added.
 */
export function sortBySizeOrder<T>(
  rows: readonly T[],
  sizeOf: (row: T) => string | null | undefined,
  order?: SizeOrderIndex | null,
): T[] {
  return [...rows].sort((x, y) => compareSizeValues(sizeOf(x), sizeOf(y), order));
}

/** The two variant columns a row needs to take part in a size run (0298). */
export interface SizeRunRow {
  groupId: string | null;
  variantSize: string | null;
}

/** One laid-out block: a size run, or a row that stands on its own. */
export type SizeRunBlock<T> =
  | { kind: 'run'; groupId: string; lines: T[] }
  | { kind: 'loose'; groupId: null; lines: [T] };

/**
 * Lay rows out as size runs plus loose rows — the ONE grouping rule, shared by
 * the web PO receive dialog and the Expo PO screen so the two surfaces can
 * never disagree about what a run is.
 *
 * Rows with no `groupId` fall through as loose, which is every row for every
 * non-sports org. A group contributing only ONE row is also loose: a
 * single-line "run" is not a run, and collapsing it would add a heading and a
 * subtotal to something that has nothing to collapse.
 *
 * A run anchors at the position of its FIRST row rather than being hoisted, so
 * the loose rows around it keep their original order and a partially-grouped
 * PO does not visually reshuffle itself.
 */
export function splitIntoSizeRuns<T extends SizeRunRow>(
  rows: readonly T[],
  orderFor?: (groupId: string) => SizeOrderIndex | null | undefined,
): Array<SizeRunBlock<T>> {
  const byGroup = new Map<string, T[]>();
  for (const r of rows) {
    if (!r.groupId) continue;
    const arr = byGroup.get(r.groupId);
    if (arr) arr.push(r);
    else byGroup.set(r.groupId, [r]);
  }

  const blocks: Array<SizeRunBlock<T>> = [];
  const emitted = new Set<string>();
  for (const r of rows) {
    const grouped = r.groupId ? byGroup.get(r.groupId) : undefined;
    if (!r.groupId || !grouped || grouped.length < 2) {
      blocks.push({ kind: 'loose', groupId: null, lines: [r] });
      continue;
    }
    if (emitted.has(r.groupId)) continue;
    emitted.add(r.groupId);
    blocks.push({
      kind: 'run',
      groupId: r.groupId,
      lines: sortBySizeOrder(grouped, (x) => x.variantSize, orderFor?.(r.groupId)),
    });
  }
  return blocks;
}

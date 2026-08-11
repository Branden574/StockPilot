/**
 * Apparel size-run parsing — the shared identity for grouping sized variants.
 *
 * A "size run" is a set of items that share a base name and differ only by a
 * trailing size token: `L4L - Pink Shirt - L / - XL / - 2XL`. Each size is its
 * OWN item with its OWN SKU (the (org, sku, charter, bin) uniqueness index
 * forbids sharing a SKU at the same rack), so they can't be grouped by SKU.
 * This module derives a display-only "style" identity from the NAME so the
 * inventory list can collapse a run into one expandable row.
 *
 * Pure functions, no platform imports — shared by the web + mobile inventory
 * lists and the "Add more sizes" button (which previously carried a private,
 * narrower copy of this regex that did NOT recognize `2XL`/`3XL`).
 *
 * SINCE TASK 18 the name regex is the FALLBACK, not the rule. An item that
 * carries a stored `product_groups` id groups by that id and the regex is never
 * consulted for it — see `SizeRunEntryMeta.groupId`. The regex still serves
 * every ungrouped item in every org, which is all of them until a human opts a
 * family in through the review tool (owner decision 2026-07-27: display
 * heuristics remain as fallback, and there is NO name-heuristic backfill).
 */

import { compareSizeValues } from '../sports/size-order';

/** Recognized apparel size tokens, longest-first so the regex prefers the
 *  longer match (`XXXXXL` over `XXXXL`, `2XL` over a bare `L`, `XS` over `S`). */
const SIZE_ALTERNATION = '6XL|5XL|4XL|3XL|2XL|XXXXXL|XXXXL|XXXL|XXL|XL|XS|L|M|S';

/** Trailing size on a NAME — separated by ` - `, `-`, or whitespace. */
const SIZE_NAME_REGEX = new RegExp(`(?:\\s*-\\s*|\\s+)(?:${SIZE_ALTERNATION})\\s*$`, 'i');

/** Trailing `-SIZE` on a SKU (only trusted when the NAME is also sized). */
const SIZE_SKU_REGEX = new RegExp(`-(?:${SIZE_ALTERNATION})$`, 'i');

/** Just the size token at the end of a NAME (used to read the size back). */
const SIZE_TOKEN_ONLY_REGEX = new RegExp(`(?:${SIZE_ALTERNATION})\\s*$`, 'i');

/** True when `name` ends in a recognized, separator-preceded size token. */
export function hasSizeSuffix(name: string): boolean {
  return SIZE_NAME_REGEX.test(name);
}

/**
 * Strip a trailing size suffix from a name, leaving the base ("L4L - Pink
 * Shirt - XL" -> "L4L - Pink Shirt"). Returns the trimmed original when there
 * is no recognized suffix.
 */
export function stripSizeSuffix(name: string): string {
  return name.replace(SIZE_NAME_REGEX, '').trim();
}

/**
 * Strip a KNOWN size from the end of a name, for display.
 *
 * `stripSizeSuffix` above pattern-matches against a fixed alternation of
 * APPAREL tokens (XS..6XL). It deliberately does not recognize numeric sizes,
 * and that is not an oversight to be corrected here: the same regex backs
 * `sizeRunStyleKey`, so teaching it to treat a trailing number as a size would
 * silently collapse "Nike Pegasus 41" and "Nike Pegasus 40" into one run — and
 * every other product whose name ends in a model number, a year or a count.
 *
 * A STORED variant does not need the guess. It carries its own size, so the
 * suffix can be removed by MATCHING THE KNOWN VALUE: "Court Shoe - 8" with
 * size "8" becomes "Court Shoe", and a numeric run finally reads as a family
 * name instead of one member's name. Falls back to the apparel regex when the
 * size is unknown or the name does not actually end in it, so nothing that
 * worked before changes.
 *
 * `size` is regex-escaped before use — half sizes like "3.5" contain a `.`
 * that would otherwise match any character.
 */
export function stripKnownSize(name: string, size: string | null | undefined): string {
  const trimmed = name.trim();
  if (size) {
    const escaped = size.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (escaped) {
      const known = new RegExp(`(?:\\s*-\\s*|\\s+)${escaped}\\s*$`, 'i');
      if (known.test(trimmed)) return trimmed.replace(known, '').trim();
    }
  }
  return stripSizeSuffix(trimmed);
}

/** The size token at the end of `name` (uppercased, e.g. "2XL"), or null. */
export function extractSize(name: string): string | null {
  if (!SIZE_NAME_REGEX.test(name)) return null;
  const m = name.match(SIZE_TOKEN_ONLY_REGEX);
  return m ? m[0].toUpperCase() : null;
}

/**
 * The grouping key for a size run: a case- and whitespace-normalized base
 * name. Two items with the same base but different size casing/tokens share a
 * key. Returns null when the item has NO size suffix, so an un-sized item is
 * never folded into a run.
 */
export function sizeRunStyleKey(name: string): string | null {
  if (!SIZE_NAME_REGEX.test(name)) return null;
  return stripSizeSuffix(name).toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Strip a trailing `-SIZE` from a SKU — BUT only when the NAME is also sized.
 * Auto-generated SKUs are random and can coincidentally end in `-L`/`-S`; tying
 * the strip to the name keeps it safe. Preserved for the "Add more sizes"
 * button, which derives a shared base SKU from the item being edited.
 */
export function stripSkuSuffix(sku: string | null, name: string): string | null {
  if (!sku) return null;
  if (!SIZE_NAME_REGEX.test(name)) return sku;
  return sku.replace(SIZE_SKU_REGEX, '');
}

// ---------------------------------------------------------------------------
// Size-run grouping — a pure, display-only collapse of a run into one entry.
// Generic over the caller's row/entry type so the web inventory table (which
// feeds already-SKU-grouped render entries) and the mobile flat list (which
// feeds raw item rows) share one implementation.
// ---------------------------------------------------------------------------

/** What `groupBySizeRun` needs to know about each entry. */
export interface SizeRunEntryMeta {
  /** Stable id for the entry (unused by the algorithm, handy for callers/debug). */
  key: string;
  /** The item name, used to derive the style base + size. */
  name: string;
  /** On-hand contributed by this entry, summed into the group's roll-up total. */
  quantity: number;
  /**
   * Identity of the STOCK-HOLDING unit behind this entry — the item id, or the
   * variant key. Several entries can share one, and when they do the run counts
   * it ONCE.
   *
   * Why it has to exist: the web Items list renders one row per PLACEMENT of an
   * item (the Chromebook in racks 1-A and 2-C is two rows) and every one of
   * those rows carries the item's TOTAL on hand, not the rack's. Folding them
   * into a run summed that total once per rack, so expanding a multi-placement
   * SKU inside a size run inflated the run header — "3 variants · 72 pairs" for
   * two variants holding 52. The unit of a size run is the VARIANT, not the row.
   *
   * Absent = the entry is its own unit (the mobile list, which has no placement
   * split, and every pre-existing caller).
   */
  unitKey?: string | null;
  /**
   * Whether this entry may be folded into a run. Pass false for entries that
   * must never collapse — e.g. a multi-placement SKU group header on web, whose
   * own children already expand. A non-groupable entry always renders `single`.
   */
  groupable: boolean;
  /**
   * The item's stored product_groups id. When present this is the ONLY
   * grouping signal used — the name regex is never consulted, so renaming an
   * item can no longer break or forge a family.
   *
   * NULL keeps the legacy name-suffix heuristic, which is the display-only
   * fallback for every ungrouped item in every org (owner decision
   * 2026-07-27: heuristics remain as fallback, and there is no backfill).
   */
  groupId?: string | null;
  /** Stored variant size, shown on the member row instead of a parsed token. */
  variantSize?: string | null;
  /**
   * The group's `default_counting_unit` ('pair', 'set', …) so the header can
   * say "52 pairs total" rather than a bare number. PAIR is a display
   * convention with no conversion behind it (requirements 5), so this is
   * READ from the group and never inferred — an entry that does not know its
   * unit passes null and the header falls back to a plain count.
   */
  countingUnit?: string | null;
}

/** A collapsed size run: the members plus the header's roll-up fields. */
export interface SizeRunGroup<T> {
  styleKey: string;
  /** Display base name (original casing) taken from the first member. */
  baseName: string;
  /** Sum of member `quantity`, counted once per distinct `unitKey`. */
  total: number;
  /** Number of distinct UNITS (sizes/variants) in the run — not of member rows,
   *  which can exceed it when one variant is rendered per placement. */
  sizeCount: number;
  /**
   * The stored product-group id this run collapsed on, or null when the run
   * came from the legacy name heuristic. A header can branch on it to say
   * "variants" (real identity) instead of "sizes" (a guess from a name).
   */
  groupId: string | null;
  /** The group's counting unit, when a member supplied one. Null otherwise. */
  countingUnit: string | null;
  members: T[];
}

/** Output entry: either a collapsed run or a passthrough single entry. */
export type SizeRunRenderEntry<T> =
  | { kind: 'size-run'; group: SizeRunGroup<T> }
  | { kind: 'single'; entry: T };

/**
 * The run key for one entry. Stored identity wins: a `group:` prefix keeps the
 * two key spaces disjoint so a group id can never collide with a derived style
 * key, and an item that HAS a group never touches the regex — its family
 * survives a rename, and a coincidental name match cannot forge one.
 */
function runKey(m: SizeRunEntryMeta): string | null {
  if (!m.groupable) return null;
  return m.groupId ? `group:${m.groupId}` : sizeRunStyleKey(m.name);
}

/**
 * Group a list of entries into size runs. An entry joins a run only when it is
 * `groupable`, it has a stored group id OR a name with a size suffix, and 2+
 * entries share the same key. A run is emitted at the position of its FIRST
 * member (later members are pulled up into it), so a run reads as one
 * contiguous block; everything else passes through in order as `single`. Pure —
 * no mutation of the inputs.
 *
 * MEMBER ORDER differs by provenance, deliberately:
 *   • A GROUP-keyed run is sorted by `variantSize` through `compareSizeValues`,
 *     because a stored variant's size is data and "10 after 9, XL after L" is
 *     the only readable order for a run.
 *   • A NAME-keyed run keeps arrival order, byte-identically to before Task 18.
 *     Its "size" is a token parsed out of a display string, and re-ordering
 *     every legacy list on the strength of a regex is exactly the kind of
 *     silent change the opt-in rule exists to avoid.
 */
export function groupBySizeRun<T>(
  entries: readonly T[],
  meta: (entry: T) => SizeRunEntryMeta,
): SizeRunRenderEntry<T>[] {
  // Pass 1: count groupable keys so a lone sized item never collapses.
  const counts = new Map<string, number>();
  for (const e of entries) {
    const key = runKey(meta(e));
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  // Pass 2: emit, folding run members into a group at the first occurrence.
  const out: SizeRunRenderEntry<T>[] = [];
  const groups = new Map<string, SizeRunGroup<T>>();
  // Member sizes, parallel to each group's `members`, kept only so a
  // group-keyed run can be size-ordered once at the end (sorting inside the
  // loop would be O(n^2) and would still have to re-read every meta).
  const memberSizes = new Map<string, Array<string | null>>();
  // Member names, parallel to `members` exactly like memberSizes, so a stored
  // run's `baseName` can be re-derived from whichever member ends up FIRST
  // after size-ordering. Kept as an array rather than re-invoking `meta` for
  // the same reason the sizes are: `meta` is caller-supplied and may not be
  // cheap.
  const memberNames = new Map<string, string[]>();
  // Units already counted into each group's roll-up. A row whose unit is
  // already in here is still a MEMBER (it renders), it just does not add its
  // quantity again — see SizeRunEntryMeta.unitKey.
  const countedUnits = new Map<string, Set<string>>();
  for (const e of entries) {
    const m = meta(e);
    const key = runKey(m);
    if (key && (counts.get(key) ?? 0) >= 2) {
      let g = groups.get(key);
      if (!g) {
        g = {
          styleKey: key,
          baseName: stripSizeSuffix(m.name),
          total: 0,
          sizeCount: 0,
          groupId: m.groupId ?? null,
          countingUnit: m.countingUnit ?? null,
          members: [],
        };
        groups.set(key, g);
        memberSizes.set(key, []);
        memberNames.set(key, []);
        countedUnits.set(key, new Set<string>());
        out.push({ kind: 'size-run', group: g });
      }
      // First member to KNOW the unit wins; a member that doesn't know it
      // (an older caller that passes no unit at all) never blanks it.
      if (g.countingUnit == null && m.countingUnit != null) g.countingUnit = m.countingUnit;
      g.members.push(e);
      memberSizes.get(key)!.push(m.variantSize ?? null);
      memberNames.get(key)!.push(m.name);
      // ONE contribution per stock-holding unit. A second row for the same
      // variant (its second placement) renders but does not re-add its total.
      const seen = countedUnits.get(key)!;
      if (m.unitKey != null && seen.has(m.unitKey)) continue;
      if (m.unitKey != null) seen.add(m.unitKey);
      g.total += m.quantity;
      g.sizeCount += 1;
    } else {
      out.push({ kind: 'single', entry: e });
    }
  }

  // Size-order the STORED runs only (see the member-order note above). Sorting
  // an index array keeps the entry and its size together without re-invoking
  // `meta`, and Array#sort has been stable since ES2019 so equal sizes keep
  // arrival order.
  for (const [key, g] of groups) {
    if (!g.groupId) continue;
    const sizes = memberSizes.get(key)!;
    const idx = g.members.map((_, i) => i);
    idx.sort((a, b) => compareSizeValues(sizes[a], sizes[b]));
    g.members = idx.map((i) => g.members[i]!);
    // Re-derive baseName from the member that is now FIRST. It was captured at
    // group-creation time, i.e. from the first-ARRIVING member, which is a
    // different row whenever arrival order is not size order — and the
    // inventory list's group header takes its name from baseName but its link,
    // thumbnail, category, location, reorder point and charter from
    // members[0]. The header therefore described one variant while navigating
    // to another. One representative member now drives all of it.
    //
    // Name-keyed runs are skipped by the `continue` above, so they keep
    // arrival order AND their original baseName — byte-identical.
    //
    // Uses the member's STORED size rather than the apparel regex, so a
    // numeric run ("Court Shoe - 8") reads as the family name rather than as
    // one member's name. See stripKnownSize for why the regex is not simply
    // widened to accept numbers.
    const firstIdx = idx[0]!;
    g.baseName = stripKnownSize(memberNames.get(key)![firstIdx]!, sizes[firstIdx]);
  }
  return out;
}

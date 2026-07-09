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
 */

/** Recognized apparel size tokens, longest-first so the regex prefers the
 *  longer match (`XXXXXL` over `XXXXL`, `2XL` over a bare `L`, `XS` over `S`). */
const SIZE_ALTERNATION =
  '6XL|5XL|4XL|3XL|2XL|XXXXXL|XXXXL|XXXL|XXL|XL|XS|L|M|S';

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
   * Whether this entry may be folded into a run. Pass false for entries that
   * must never collapse — e.g. a multi-placement SKU group header on web, whose
   * own children already expand. A non-groupable entry always renders `single`.
   */
  groupable: boolean;
}

/** A collapsed size run: the members plus the header's roll-up fields. */
export interface SizeRunGroup<T> {
  styleKey: string;
  /** Display base name (original casing) taken from the first member. */
  baseName: string;
  /** Sum of member `quantity`. */
  total: number;
  /** Number of members (sizes) in the run. */
  sizeCount: number;
  members: T[];
}

/** Output entry: either a collapsed run or a passthrough single entry. */
export type SizeRunRenderEntry<T> =
  | { kind: 'size-run'; group: SizeRunGroup<T> }
  | { kind: 'single'; entry: T };

/**
 * Group a list of entries into size runs. An entry joins a run only when it is
 * `groupable`, its name has a size suffix, and 2+ entries share the same style
 * base. A run is emitted at the position of its FIRST member (later members are
 * pulled up into it), so a run reads as one contiguous block; everything else
 * passes through in order as `single`. Pure — no mutation of the inputs.
 */
export function groupBySizeRun<T>(
  entries: readonly T[],
  meta: (entry: T) => SizeRunEntryMeta,
): SizeRunRenderEntry<T>[] {
  // Pass 1: count groupable style keys so a lone sized item never collapses.
  const counts = new Map<string, number>();
  for (const e of entries) {
    const m = meta(e);
    if (!m.groupable) continue;
    const key = sizeRunStyleKey(m.name);
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  // Pass 2: emit, folding run members into a group at the first occurrence.
  const out: SizeRunRenderEntry<T>[] = [];
  const groups = new Map<string, SizeRunGroup<T>>();
  for (const e of entries) {
    const m = meta(e);
    const key = m.groupable ? sizeRunStyleKey(m.name) : null;
    if (key && (counts.get(key) ?? 0) >= 2) {
      let g = groups.get(key);
      if (!g) {
        g = { styleKey: key, baseName: stripSizeSuffix(m.name), total: 0, sizeCount: 0, members: [] };
        groups.set(key, g);
        out.push({ kind: 'size-run', group: g });
      }
      g.members.push(e);
      g.total += m.quantity;
      g.sizeCount += 1;
    } else {
      out.push({ kind: 'single', entry: e });
    }
  }
  return out;
}

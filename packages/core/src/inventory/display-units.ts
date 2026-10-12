/**
 * THE DISPLAY CONTRACT (design-merged.md section 4): one deterministic rule
 * for how the Items and Books lists, on the web and the phone, put records
 * under a header. Three grouping layers compose here, in this precedence:
 *
 *   E  an EXPLICIT display group (Group selected, migration 0400): records
 *      carrying the same item_display_group_members.group_id form one unit
 *      when AT LEAST TWO DISTINCT RECORDS of it are present in the rows the
 *      surface holds. With one present (a search hit, a filter), the record
 *      falls back to the layers below and the screen shows an "In group"
 *      chip, so it stays findable with its context.
 *   K  the same-SKU family (Model B, group-by-sku.ts): rows not claimed by a
 *      formed E unit, keyed on the RAW non-blank SKU (the key the display,
 *      the 0234 index and the Model B fan-out use; never trimmed).
 *   R  the size run / certified product family (size-run.ts, Items only): rows
 *      neither in E nor in K, keyed on the stored product group first, then
 *      the name's size suffix.
 *   otherwise a single row.
 *
 * Each row gets exactly one key, so no pass can claim a row another pass
 * already claimed: nothing disappears and nothing renders twice. A display
 * group is display only: it never changes a record's SKU, family, size, stock
 * or identity, and nothing outside the lists reads it.
 *
 * Two entry points share the rule:
 *   - makeDisplayUnitKeyer: the ITEM-LEVEL unit key pagination packs
 *     (runAwarePages and the planned page 1 on the web; units on the phone),
 *     so a unit is never cut across pages;
 *   - composeDisplayList: what a list RENDERS from the rows it holds
 *     (placement rows on web Items, record rows elsewhere): headers, the size
 *     runs, and expansion. Expanded rows are emitted AFTER the run pass and
 *     marked nested, so they can never be pulled into a run elsewhere (the
 *     V3 defect: expanding a SKU header used to fold its rows into a run).
 * On record rows the two produce identical units (property P1); on placement
 * rows the render refines the units (P2: one record on two racks keeps its
 * "2 locations" header inside its unit).
 *
 * Totals are the caller's: a header sums the rows it expands to, each row
 * once (a placement row's own quantity on web Items, a record's on hand
 * elsewhere), and a size run counts each record once (its unitKey). On hand
 * and available stay separate figures.
 *
 * Pure: no I/O, no clock, no randomness; same rows in, same answer out.
 */

import { compareSizeValues } from '../sports/size-order';

import { sharedSkuKey } from './grouping-contract';
import {
  groupBySizeRun,
  sizeRunStyleKey,
  type SizeRunEntryMeta,
  type SizeRunGroup,
} from './size-run';

/** How a surface reads the three facts the rule needs from one of its rows. */
export interface DisplayRowAccess<R> {
  /** The record the row shows (one record may render on several rack rows). */
  itemIdOf: (row: R) => string;
  /** The record's SKU, raw. */
  skuOf: (row: R) => string | null | undefined;
  /** The record's explicit display group id, or null. */
  displayGroupOf: (row: R) => string | null | undefined;
}

/** A display group's id, name and version as a list carries them. The name
 *  and version are decoration: a failed or hidden read leaves them null and
 *  the header says "Group"; the id alone decides the grouping. */
export interface DisplayGroupRef {
  id: string;
  name: string | null;
  version: number | null;
}

function gidOf(v: string | null | undefined): string | null {
  return typeof v === 'string' && v.trim() ? v : null;
}

/** The explicit groups that form a unit over these rows: at least two
 *  DISTINCT records carry them (two rack rows of one record are one). */
export function formedDisplayGroups<R>(rows: readonly R[], acc: DisplayRowAccess<R>): Set<string> {
  const records = new Map<string, Set<string>>();
  for (const row of rows) {
    const g = gidOf(acc.displayGroupOf(row));
    if (!g) continue;
    let s = records.get(g);
    if (!s) records.set(g, (s = new Set()));
    s.add(acc.itemIdOf(row));
  }
  const out = new Set<string>();
  for (const [g, s] of records) if (s.size >= 2) out.add(g);
  return out;
}

/** The item-level row the keyer reads (runAwarePages' rows, the phone's). */
export interface DisplayUnitItemRow {
  id: string;
  name: string;
  sku?: string | null;
  group_id?: string | null;
  display_group_id?: string | null;
}

const ITEM_ACCESS: DisplayRowAccess<DisplayUnitItemRow> = {
  itemIdOf: (r) => r.id,
  skuOf: (r) => r.sku,
  displayGroupOf: (r) => r.display_group_id,
};

/** The size-run key of a record: its stored family first, then the name. */
function runKeyOf(r: { name: string; group_id?: string | null }): string | null {
  const fam = (r.group_id ?? '').trim();
  if (fam) return `group:${fam}`;
  return sizeRunStyleKey(r.name);
}

/**
 * The ITEM-LEVEL unit key of each row, over the whole set the caller holds
 * (E > K > R > single): 'grp:<group id>', 'sku:<raw sku>', 'run:<run key>' or
 * null. A unit is never cut across pages, so pagination packs these.
 * `sizeRuns: false` is the Books shape (no size runs).
 */
export function makeDisplayUnitKeyer<T extends DisplayUnitItemRow>(
  rows: readonly T[],
  options: { sizeRuns: boolean },
): (row: T) => string | null {
  const formed = formedDisplayGroups(rows, ITEM_ACCESS);
  const claimed = (r: T): string | null => {
    const g = gidOf(r.display_group_id);
    return g && formed.has(g) ? g : null;
  };
  // K: distinct records per raw SKU among the unclaimed.
  const skuRecords = new Map<string, Set<string>>();
  for (const r of rows) {
    if (claimed(r)) continue;
    const k = sharedSkuKey(r.sku);
    if (!k) continue;
    let s = skuRecords.get(k);
    if (!s) skuRecords.set(k, (s = new Set()));
    s.add(r.id);
  }
  const inSku = (r: T): string | null => {
    if (claimed(r)) return null;
    const k = sharedSkuKey(r.sku);
    return k && (skuRecords.get(k)?.size ?? 0) >= 2 ? k : null;
  };
  // R: rows per run key among those neither in E nor in K.
  const runCounts = new Map<string, number>();
  if (options.sizeRuns) {
    for (const r of rows) {
      if (claimed(r) || inSku(r)) continue;
      const k = runKeyOf(r);
      if (k) runCounts.set(k, (runCounts.get(k) ?? 0) + 1);
    }
  }
  return (r: T): string | null => {
    const g = claimed(r);
    if (g) return `grp:${g}`;
    const s = inSku(r);
    if (s) return `sku:${s}`;
    if (!options.sizeRuns) return null;
    const k = runKeyOf(r);
    return k && (runCounts.get(k) ?? 0) >= 2 ? `run:${k}` : null;
  };
}

/**
 * Records per RAW SKU over a whole set, counting only records a formed
 * explicit group does NOT claim (the SKU header's split detector compares its
 * records against this; counting claimed records too would stamp a false
 * "partial" on every partly grouped SKU). Blank SKUs are never grouped.
 */
export function countUnclaimedItemRowsBySku(
  rows: readonly DisplayUnitItemRow[],
): Map<string, number> {
  const formed = formedDisplayGroups(rows, ITEM_ACCESS);
  const records = new Map<string, Set<string>>();
  for (const r of rows) {
    const g = gidOf(r.display_group_id);
    if (g && formed.has(g)) continue;
    const k = sharedSkuKey(r.sku);
    if (!k) continue;
    let s = records.get(k);
    if (!s) records.set(k, (s = new Set()));
    s.add(r.id);
  }
  return new Map([...records].map(([k, s]) => [k, s.size]));
}

/** Records per FORMED explicit group over a whole set (the group header's
 *  split detector). */
export function countItemRowsByDisplayGroup(
  rows: readonly DisplayUnitItemRow[],
): Map<string, number> {
  const formed = formedDisplayGroups(rows, ITEM_ACCESS);
  const records = new Map<string, Set<string>>();
  for (const r of rows) {
    const g = gidOf(r.display_group_id);
    if (!g || !formed.has(g)) continue;
    let s = records.get(g);
    if (!s) records.set(g, (s = new Set()));
    s.add(r.id);
  }
  return new Map([...records].map(([k, s]) => [k, s.size]));
}

/** A chip on a record that is not under its group's header here. */
export type DisplayGroupChip =
  /** The record is in a group that has only it present here. */
  | { kind: 'in-group'; groupId: string }
  /** The record is in no group here, and a record in a formed group here
   *  shares its SKU ("Same SKU as records in <group>" with Add to group). */
  | { kind: 'same-sku'; groupId: string };

/** The chips for the rows a surface holds, by record id. */
export function displayGroupChips<R>(
  rows: readonly R[],
  acc: DisplayRowAccess<R>,
): Map<string, DisplayGroupChip> {
  const formed = formedDisplayGroups(rows, acc);
  const groupBySku = new Map<string, string>();
  for (const row of rows) {
    const g = gidOf(acc.displayGroupOf(row));
    const k = sharedSkuKey(acc.skuOf(row));
    if (g && formed.has(g) && k && !groupBySku.has(k)) groupBySku.set(k, g);
  }
  const out = new Map<string, DisplayGroupChip>();
  for (const row of rows) {
    const id = acc.itemIdOf(row);
    if (out.has(id)) continue;
    const g = gidOf(acc.displayGroupOf(row));
    if (g && !formed.has(g)) {
      out.set(id, { kind: 'in-group', groupId: g });
      continue;
    }
    if (g) continue;
    const k = sharedSkuKey(acc.skuOf(row));
    const other = k ? groupBySku.get(k) : undefined;
    if (other) out.set(id, { kind: 'same-sku', groupId: other });
  }
  return out;
}

/** One top-level entry before the run pass. */
type Entry<R> =
  | { kind: 'explicit'; groupId: string; rows: R[] }
  | { kind: 'sku'; sku: string; rows: R[] }
  | { kind: 'row'; row: R };

/** What a composed list renders, in order. */
export type DisplayListEntry<R> =
  /** An explicit group's header (2+ records present); `rows` are every row it
   *  expands to, in member order. */
  | { kind: 'explicit'; groupId: string; rows: R[]; expanded: boolean }
  /** A same-SKU header (2+ rows of one raw SKU, not claimed by a group). */
  | { kind: 'sku'; sku: string; rows: R[]; expanded: boolean }
  /** A size run or certified family (Items only). */
  | { kind: 'run'; run: SizeRunGroup<R>; expanded: boolean }
  /** A row: standalone (nested false) or under an expanded header. */
  | { kind: 'row'; row: R; nested: boolean };

export interface ComposeDisplayOptions<R> extends DisplayRowAccess<R> {
  /**
   * The size-run facts of a standalone row (Items). Omit it to switch size
   * runs off (Books: never sized, never parsed). The record is the run's unit
   * (its on hand counts once however many rack rows it has).
   */
  runMetaOf?: (row: R) => {
    name: string;
    quantity: number;
    groupId: string | null;
    variantSize: string | null;
    countingUnit?: string | null;
  };
  /** A row's stored size, to order an explicit group's members when every
   *  member has one (Items). Omit for Books: arrival order. */
  sizeOf?: (row: R) => string | null | undefined;
  /** Which headers are open: explicit group ids, raw SKUs, run style keys. */
  expanded: {
    explicit: ReadonlySet<string>;
    skus: ReadonlySet<string>;
    runs: ReadonlySet<string>;
  };
}

/** E then K over the rows, each entry at its first member's position. */
function buildEntries<R>(
  rows: readonly R[],
  acc: DisplayRowAccess<R>,
  sizeOf?: (row: R) => string | null | undefined,
): Entry<R>[] {
  const formed = formedDisplayGroups(rows, acc);
  const claimedBy = (row: R): string | null => {
    const g = gidOf(acc.displayGroupOf(row));
    return g && formed.has(g) ? g : null;
  };
  const skuRows = new Map<string, number>();
  for (const row of rows) {
    if (claimedBy(row)) continue;
    const k = sharedSkuKey(acc.skuOf(row));
    if (k) skuRows.set(k, (skuRows.get(k) ?? 0) + 1);
  }
  const out: Entry<R>[] = [];
  const explicitAt = new Map<string, Extract<Entry<R>, { kind: 'explicit' }>>();
  const skuAt = new Map<string, Extract<Entry<R>, { kind: 'sku' }>>();
  for (const row of rows) {
    const g = claimedBy(row);
    if (g) {
      let e = explicitAt.get(g);
      if (!e) {
        e = { kind: 'explicit', groupId: g, rows: [] };
        explicitAt.set(g, e);
        out.push(e);
      }
      e.rows.push(row);
      continue;
    }
    const k = sharedSkuKey(acc.skuOf(row));
    if (k && (skuRows.get(k) ?? 0) >= 2) {
      let e = skuAt.get(k);
      if (!e) {
        e = { kind: 'sku', sku: k, rows: [] };
        skuAt.set(k, e);
        out.push(e);
      }
      e.rows.push(row);
      continue;
    }
    out.push({ kind: 'row', row });
  }
  // Member order inside a group: stored sizes when every member has one
  // (stable, so equal sizes keep arrival order), else arrival order.
  if (sizeOf) {
    for (const e of explicitAt.values()) {
      const sizes = e.rows.map((row) => sizeOf(row) ?? null);
      if (sizes.every((s) => typeof s === 'string' && s.trim() !== '')) {
        const idx = e.rows.map((_, i) => i);
        idx.sort((a, b) => compareSizeValues(sizes[a], sizes[b]));
        e.rows = idx.map((i) => e.rows[i]!);
      }
    }
  }
  return out;
}

/**
 * The list a surface renders from the rows it holds, in order: explicit
 * group headers, same-SKU headers, size runs (when `runMetaOf` is given) and
 * rows. Explicit and SKU headers are never folded into a run. A header that
 * is expanded is followed by its own rows, marked nested; those are emitted
 * after the run pass, so they are never offered to it.
 */
export function composeDisplayList<R>(
  rows: readonly R[],
  options: ComposeDisplayOptions<R>,
): DisplayListEntry<R>[] {
  const entries = buildEntries(rows, options, options.sizeOf);
  const out: DisplayListEntry<R>[] = [];
  const emitHeaderEntry = (e: Exclude<Entry<R>, { kind: 'row' }>): void => {
    if (e.kind === 'explicit') {
      const expanded = options.expanded.explicit.has(e.groupId);
      out.push({ kind: 'explicit', groupId: e.groupId, rows: e.rows, expanded });
      if (expanded) for (const row of e.rows) out.push({ kind: 'row', row, nested: true });
      return;
    }
    const expanded = options.expanded.skus.has(e.sku);
    out.push({ kind: 'sku', sku: e.sku, rows: e.rows, expanded });
    if (expanded) for (const row of e.rows) out.push({ kind: 'row', row, nested: true });
  };

  const runMetaOf = options.runMetaOf;
  if (!runMetaOf) {
    for (const e of entries) {
      if (e.kind === 'row') out.push({ kind: 'row', row: e.row, nested: false });
      else emitHeaderEntry(e);
    }
    return out;
  }

  const meta = (e: Entry<R>): SizeRunEntryMeta => {
    if (e.kind !== 'row') {
      return {
        key: e.kind === 'explicit' ? `grp:${e.groupId}` : `sku:${e.sku}`,
        name: '',
        quantity: 0,
        groupable: false,
      };
    }
    const m = runMetaOf(e.row);
    return {
      key: `row:${options.itemIdOf(e.row)}`,
      name: m.name,
      quantity: m.quantity,
      unitKey: options.itemIdOf(e.row),
      groupable: true,
      groupId: m.groupId,
      variantSize: m.variantSize,
      countingUnit: m.countingUnit ?? null,
    };
  };
  for (const s of groupBySizeRun<Entry<R>>(entries, meta)) {
    if (s.kind === 'single') {
      const e = s.entry;
      if (e.kind === 'row') out.push({ kind: 'row', row: e.row, nested: false });
      else emitHeaderEntry(e);
      continue;
    }
    // Only standalone rows are groupable, so every member is a row entry.
    const members = s.group.members.map((m) => (m as Extract<Entry<R>, { kind: 'row' }>).row);
    const run: SizeRunGroup<R> = { ...s.group, members };
    const expanded = options.expanded.runs.has(run.styleKey);
    out.push({ kind: 'run', run, expanded });
    if (expanded) for (const row of members) out.push({ kind: 'row', row, nested: true });
  }
  return out;
}

/** One membership as a list read returns it: the record, its group, and the
 *  group's row when the reader may see it (an object or a one-element array,
 *  as PostgREST embeds return either). */
export interface DisplayGroupMembershipRow {
  item_id: string;
  group_id: string;
  item_display_groups?:
    | { id?: string | null; name?: string | null; version?: number | null }
    | Array<{ id?: string | null; name?: string | null; version?: number | null }>
    | null;
}

/** Record id -> its group, from a membership read. A missing group row (the
 *  read failed or the group is hidden) keeps the id with no name. */
export function indexDisplayGroupMemberships(
  rows: readonly DisplayGroupMembershipRow[] | null | undefined,
): Map<string, DisplayGroupRef> {
  const out = new Map<string, DisplayGroupRef>();
  for (const m of rows ?? []) {
    if (!m || typeof m.item_id !== 'string' || typeof m.group_id !== 'string') continue;
    const embed = Array.isArray(m.item_display_groups)
      ? (m.item_display_groups[0] ?? null)
      : (m.item_display_groups ?? null);
    out.set(m.item_id, {
      id: m.group_id,
      name: typeof embed?.name === 'string' ? embed.name : null,
      version: typeof embed?.version === 'number' ? embed.version : null,
    });
  }
  return out;
}

/** The words a header uses for a group whose name could not be read. */
export const DISPLAY_GROUP_FALLBACK_NAME = 'Group';

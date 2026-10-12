import {
  composeDisplayList,
  DISPLAY_GROUP_FALLBACK_NAME,
  displayGroupChips,
  GROUP_COPY,
  groupCoverRow,
  rollupStatus,
  sharedSkuKey,
  shownUnderByRecord,
  type DisplayListEntry,
  type UngroupKind,
} from '@stockpilot/core';

import type { LifecycleStatus } from './expected-items';

/**
 * Two-level display grouping for the mobile Items list — the mobile twin of
 * the web inventory table's `skuGroups` → `renderItems` → `styledRenderItems`
 * pipeline (apps/web/src/components/inventory/inventory-table.tsx). Pure and
 * platform-free so it can be unit-tested without React Native.
 *
 * The bug this closes: under Model B one SKU can be MULTIPLE `inventory_items`
 * rows (one per charter/bin/warehouse placement — migration 0234's
 * (org, sku, charter, bin) uniqueness), so a single product's placements
 * arrived as separate rows on mobile while web collapsed them into one. This
 * runs the same `groupPlacementsBySku` collapse the web table uses.
 *
 * Composition (identical ORDER to web):
 *   1. `groupPlacementsBySku` clusters same-SKU placements on the page.
 *   2. A SKU with exactly ONE placement becomes a normal single item and keeps
 *      flowing through `groupBySizeRun`, so apparel size-runs across DIFFERENT
 *      SKUs still collapse exactly as before.
 *   3. A SKU with >1 placement becomes a collapsed SKU-group header (summed
 *      total + rolled-up status). It is fed to `groupBySizeRun` as
 *      `groupable: false`, so a multi-placement header is never folded into a
 *      size run (its own children already expand).
 *
 * Pass 2 is opt-OUT (`enableSizeRuns: false`) for the Books list: books are
 * never sized, which is the same reason the web table gates size-run grouping
 * off behind `showBookFields`. Pass 1 (the same-SKU collapse) runs for both —
 * a book title legitimately exists once per charter/rack under 0234's
 * (org, sku, charter, bin) uniqueness, exactly like an item.
 *
 * PAGING NOTE — SUPERSEDED, and the comment is updated rather than left
 * contradicting the code. This helper used to be handed one 50-row server page,
 * so a SKU's other placements could sit on another page (the sorts are
 * updated_at / name / quantity — never sku) and a page-local sum could be
 * SHORT; two rounds of machinery (`familyCounts` from a second sku-only read,
 * before that page ANCHORING) existed to disclose or repair that. Both are
 * gone. The lists now fetch the WHOLE filtered set in one request and paginate
 * over GROUPS (`buildGroupUnits` below → `paginateGroups`, lib/inventory-
 * paging.ts), so the rows handed in always contain every placement of every SKU
 * they contain, and every group total is exact by construction.
 *
 * The one case left where the rows can genuinely be short is an org whose
 * filtered set exceeds PostgREST's `max_rows` cap — at today's volumes (111
 * books / 257 items on the largest org, cap 1000) it cannot happen, and it is
 * disclosed rather than hidden: the caller passes `datasetIsTruncated`, every
 * collapsed header wears the marker, and the screen says so above the list.
 * It defaults false, so a caller holding a complete set marks nothing.
 */

/** The shape this helper needs from each Items-list row. */
export interface GroupableItem {
  id: string;
  name: string;
  sku: string;
  quantity_on_hand: number;
  reorder_point: number;
  status: string;
  charter_id: string | null;
  primary_location_id: string | null;
  /**
   * Mig 0277 phantom flag. Carried here — not read from the screen's view
   * state — because a collapsed header's EXPECTED pill has to be derivable
   * from the rows it expands to. Deriving it from the active filter instead
   * badges the PREVIOUS view's rows during the debounce+fetch after a view
   * switch, i.e. a header contradicting its own children.
   */
  awaiting_first_receipt: boolean;
  /**
   * Sports (0298). The item's STORED product-group id. When present it is the
   * ONLY signal size-run grouping uses on this list — same rule as web, out of
   * the same shared `groupBySizeRun`. Optional so every existing caller (and
   * the Books list, which never reads it) compiles and behaves unchanged;
   * absent/null keeps the legacy name heuristic, which is every ungrouped item
   * in every org because there is no backfill.
   */
  group_id?: string | null;
  /** Sports (0298). Stored size, used to order a grouped run's members. */
  variant_size?: string | null;
  /**
   * The group's counting unit ('pair', 'set', …) when the screen has resolved
   * it. Display only — PAIR is a convention with no conversion behind it.
   */
  counting_unit?: string | null;
  /**
   * Group selected (0400): the record's explicit display group, read from
   * item_display_group_members next to the list (never a column of the item).
   * Display only. Optional: absent is a record in no group, and a list with
   * none groups exactly as before.
   */
  display_group_id?: string | null;
  display_group_name?: string | null;
  display_group_version?: number | null;
  /**
   * The record's list picture once the screen has resolved it (both lists
   * sign thumbnails after the rows load). Read only for an explicit group's
   * header picture (`coverUrl`). Optional: absent is no picture.
   */
  imageUrl?: string | null;
}

/** A single flattened FlatList entry. */
export type GroupedRow<T extends GroupableItem> =
  // Apparel size-run header (unchanged behavior).
  | {
      kind: 'header';
      key: string;
      styleKey: string;
      baseName: string;
      total: number;
      sizeCount: number;
      /**
       * The stored product-group id this run collapsed on, or null when the
       * run came from the legacy name heuristic. The card branches on it to
       * say "variants" (real identity) instead of "sizes" (a guess).
       */
      groupId: string | null;
      /** The group's counting unit, when the screen resolved one. */
      countingUnit: string | null;
    }
  // Model B same-SKU collapse header (new). `reorderPoint` is the SUM of the
  // group's placements' reorder points (see `emitEntry` for why), so the
  // header's badge derives from the summed total on the same scale, matching
  // the web StockStatusBadge precedence: lifecycle (archived/discontinued)
  // wins, else out/low/in from the total.
  | {
      kind: 'sku-header';
      key: string;
      sku: string;
      name: string;
      total: number;
      reorderPoint: number;
      placementCount: number;
      status: LifecycleStatus;
      /**
       * True only when EVERY placement in the group is an awaiting-first-
       * receipt phantom (mig 0277) — derived from the rows, never from the
       * screen's filter state, so the header's EXPECTED pill can never
       * contradict the pills on the rows it expands to. A mixed group falls
       * through to ordinary stock math, which is what its children show.
       */
      expected: boolean;
      /**
       * True when `total` / `placementCount` may cover only SOME of this
       * SKU's placements. With group-aware pagination over a complete set
       * this is ALWAYS false — a group is never split, so its header is
       * always exact. It survives for the one honest exception: a filtered
       * set larger than PostgREST's `max_rows` cap, where the rows in hand
       * really are a prefix of the truth. An unmarked short total is the
       * defect it exists to prevent.
       */
      partial: boolean;
    }
  // Group selected (0400): an explicit display group with two or more of its
  // records here. Every figure is derived from those records (each counted
  // once); `partial` only when the read was capped.
  | {
      kind: 'explicit-header';
      key: string;
      groupId: string;
      name: string;
      /**
       * The header's picture: the first record, in the order the header lists
       * them, that has one (core groupCoverRow, the web's rule too); null
       * keeps the placeholder. The people review (P5) had the header show
       * none; the owner overruled that on 2026-10-12 ("it should just use the
       * first picture of whatever was chosen for the grouping").
       */
      coverUrl: string | null;
      recordCount: number;
      total: number;
      reorderPoint: number;
      status: LifecycleStatus;
      expected: boolean;
      partial: boolean;
    }
  // A plain item row — standalone, an expanded size-run member, an expanded
  // SKU-group placement (in which case `placementLabel` differentiates it), or
  // an expanded display group's record. `groupChip`: "In group <name>" (its
  // group has only it here) or "Same SKU as records in <name>"; null otherwise.
  // `addToGroupId`: set with the second chip only, the group "Add to group"
  // opens the review for (nothing joins a group by itself).
  | {
      kind: 'row';
      key: string;
      item: T;
      placementLabel: string | null;
      groupChip?: string | null;
      addToGroupId?: string | null;
    };

/** Coerce a free-form status string to the lifecycle union `rollupStatus` needs. */
function toLifecycle(status: string): LifecycleStatus {
  return status === 'archived' || status === 'discontinued' ? status : 'active';
}

/**
 * First NON-NULL cover across a SKU's rows, for the collapsed header's thumb.
 *
 * A SKU is one product identity under 0234, so every placement is the same
 * title with the same cover — but only ONE placement may actually carry the
 * uploaded image (covers hang off `item_images` per inventory_item, and a
 * PO-created sibling placement is usually born without one). Taking the first
 * placement's `imageUrl` unconditionally therefore showed the placeholder icon
 * for titles that plainly have a cover on another row.
 */
export function firstCoverBySku(
  rows: readonly { sku: string; imageUrl: string | null }[],
): Map<string, string | null> {
  const m = new Map<string, string | null>();
  for (const r of rows) {
    // Seed with null so a coverless SKU is still present, then upgrade the
    // first time any placement supplies a real URL.
    if (!m.has(r.sku)) m.set(r.sku, r.imageUrl);
    else if (!m.get(r.sku) && r.imageUrl) m.set(r.sku, r.imageUrl);
  }
  return m;
}

export interface BuildGroupedRowsOptions<T extends GroupableItem> {
  /** Expanded apparel size-run style keys. */
  expandedSizeRuns: ReadonlySet<string>;
  /** Expanded SKU-group SKUs. */
  expandedSkuGroups: ReadonlySet<string>;
  /** Optional label for an expanded placement's secondary line (charter/bin). */
  placementLabelFor?: (item: T) => string | null;
  /**
   * Apparel size-run grouping (pass 2). Defaults TRUE — the Items list's
   * behavior is unchanged. Books pass FALSE: a book is never sized, and the
   * web table gates size runs off for `showBookFields` for exactly that
   * reason. Only the Model B same-SKU collapse (pass 1) applies there.
   */
  enableSizeRuns?: boolean;
  /**
   * True ONLY when the caller's read hit PostgREST's `max_rows` cap, i.e. the
   * rows handed in are a prefix of the filtered set and any SKU could have
   * siblings past the cut. Every collapsed header then wears the partial
   * marker, because with no further information any of them could be short.
   *
   * NOT "the list is paginated": the lists paginate over GROUPS from a
   * complete in-memory set (lib/inventory-paging.ts), so pagination no longer
   * makes any group short. The predecessor option (`datasetIsPaged`) was true
   * for every org past one page and stamped "≥N" on headers that were
   * demonstrably complete; that whole class of marker is gone.
   *
   * Defaults false — a caller holding a complete set marks nothing.
   */
  datasetIsTruncated?: boolean;
  /** Group selected (0400): expanded explicit display groups, by group id. */
  expandedExplicitGroups?: ReadonlySet<string>;
}

const EMPTY: ReadonlySet<string> = new Set();

/** The phone's rows to core's display rule: a record per row, keyed by id. */
function compose<T extends GroupableItem>(
  items: readonly T[],
  enableSizeRuns: boolean,
  expanded: { explicit: ReadonlySet<string>; skus: ReadonlySet<string>; runs: ReadonlySet<string> },
): DisplayListEntry<T>[] {
  return composeDisplayList<T>(items, {
    itemIdOf: (it) => it.id,
    skuOf: (it) => it.sku,
    displayGroupOf: (it) => it.display_group_id ?? null,
    ...(enableSizeRuns
      ? {
          runMetaOf: (it: T) => ({
            name: it.name,
            quantity: Number(it.quantity_on_hand) || 0,
            // Stored identity wins over the name regex — see GroupableItem.
            groupId: it.group_id ?? null,
            variantSize: it.variant_size ?? null,
            countingUnit: it.counting_unit ?? null,
          }),
          sizeOf: (it: T) => it.variant_size ?? null,
        }
      : {}),
    expanded,
  });
}

/**
 * THE UNIT OF PAGINATION: the items behind each top-level card, in render
 * order — one array per explicit display group, per collapsed SKU family, per
 * size run, or per standalone item. Feed the whole filtered set; hand the
 * result to `paginateGroups` (lib/inventory-paging.ts), then hand a page's
 * items back to `buildGroupedRows`. Both run core's ONE display rule
 * (composeDisplayList, the web's too: explicit group, then same SKU, then size
 * run), and both emit a group at its FIRST member's position, so grouping a
 * page produced this way reproduces exactly the units it was sliced from — a
 * family is whole on exactly one page, always — and the units equal the web's
 * runAwarePages units (the shared parity fixture).
 *
 * Display-only: no row is written, moved, dropped or duplicated.
 */
export function buildGroupUnits<T extends GroupableItem>(
  items: readonly T[],
  opts?: { enableSizeRuns?: boolean },
): T[][] {
  const list = compose(items, opts?.enableSizeRuns !== false, { explicit: EMPTY, skus: EMPTY, runs: EMPTY });
  const units: T[][] = [];
  for (const e of list) {
    if (e.kind === 'row') {
      if (!e.nested) units.push([e.row]);
    } else if (e.kind === 'run') {
      units.push([...e.run.members]);
    } else {
      units.push([...e.rows]);
    }
  }
  return units;
}

/**
 * Build the flattened `GroupedRow[]` the mobile Items/Books FlatList renders.
 * Display-only: nothing here writes or recomputes a record; totals are read-time
 * sums of each record's `quantity_on_hand`, each record counted once.
 */
export function buildGroupedRows<T extends GroupableItem>(
  items: readonly T[],
  opts: BuildGroupedRowsOptions<T>,
): GroupedRow<T>[] {
  const {
    expandedSizeRuns,
    expandedSkuGroups,
    placementLabelFor,
    enableSizeRuns = true,
    datasetIsTruncated = false,
    expandedExplicitGroups = EMPTY,
  } = opts;

  const list = compose(items, enableSizeRuns, {
    explicit: expandedExplicitGroups,
    skus: expandedSkuGroups,
    runs: expandedSizeRuns,
  });
  const chips = displayGroupChips(items, {
    itemIdOf: (it) => it.id,
    skuOf: (it) => it.sku,
    displayGroupOf: (it) => it.display_group_id ?? null,
  });
  const nameOf = new Map<string, string>();
  for (const it of items) {
    if (it.display_group_id && it.display_group_name && !nameOf.has(it.display_group_id)) {
      nameOf.set(it.display_group_id, it.display_group_name);
    }
  }
  const groupName = (g: string) => nameOf.get(g) ?? DISPLAY_GROUP_FALLBACK_NAME;

  const out: GroupedRow<T>[] = [];
  // Which header a nested row belongs to decides its secondary line: a SKU
  // group's placements read apart by charter/location; other records show
  // their own SKU.
  let under: 'sku' | 'other' = 'other';
  for (const e of list) {
    if (e.kind === 'explicit') {
      under = 'other';
      out.push({
        kind: 'explicit-header',
        key: `grp:${e.groupId}`,
        groupId: e.groupId,
        name: groupName(e.groupId),
        // `e.rows` are in the order the header lists and expands them.
        coverUrl: groupCoverRow(e.rows, (r) => r.imageUrl)?.imageUrl ?? null,
        recordCount: new Set(e.rows.map((r) => r.id)).size,
        total: e.rows.reduce((sum, r) => sum + (Number(r.quantity_on_hand) || 0), 0),
        // Summed like the SKU header's (see there): threshold and quantity on
        // the same scale, never healthier than a unanimous reading.
        reorderPoint: e.rows.reduce((sum, r) => sum + (Number(r.reorder_point) || 0), 0),
        status: rollupStatus(e.rows.map((r) => toLifecycle(r.status))),
        expected: e.rows.every((r) => r.awaiting_first_receipt),
        partial: datasetIsTruncated,
      });
      continue;
    }
    if (e.kind === 'sku') {
      under = 'sku';
      // Multi-placement SKU header. EVERY figure on the header is derived from
      // `e.rows` — the exact rows the chevron reveals — so the header can
      // never contradict them. When those rows may not be the whole family
      // the header says so (`partial`) rather than borrowing a figure from
      // another scope.
      out.push({
        kind: 'sku-header',
        key: `sku:${e.sku}`,
        sku: e.sku,
        name: e.rows[0]?.name ?? '',
        total: e.rows.reduce((sum, p) => sum + (Number(p.quantity_on_hand) || 0), 0),
        // reorder_point is PER PLACEMENT, and taking the first placement's let a
        // badge derived from the SUMMED total read HEALTHIER than every row
        // under it. Sum it, exactly as the web header does: the group's
        // replenishment need is the sum of its placements' needs.
        reorderPoint: e.rows.reduce((sum, p) => sum + (Number(p.reorder_point) || 0), 0),
        placementCount: e.rows.length,
        status: rollupStatus(e.rows.map((p) => toLifecycle(p.status))),
        expected: e.rows.every((p) => p.awaiting_first_receipt),
        // Exact unless the caller's read was capped — group-aware pagination
        // guarantees these placements ARE the SKU's placements.
        partial: datasetIsTruncated,
      });
      continue;
    }
    if (e.kind === 'run') {
      under = 'other';
      const g = e.run;
      out.push({
        kind: 'header',
        key: `g:${g.styleKey}`,
        styleKey: g.styleKey,
        baseName: g.baseName,
        total: g.total,
        sizeCount: g.sizeCount,
        groupId: g.groupId,
        countingUnit: g.countingUnit,
      });
      continue;
    }
    if (e.nested) {
      out.push({
        kind: 'row',
        key: e.row.id,
        item: e.row,
        placementLabel: under === 'sku' ? (placementLabelFor?.(e.row) ?? null) : null,
        groupChip: null,
        addToGroupId: null,
      });
      continue;
    }
    const chip = chips.get(e.row.id);
    out.push({
      kind: 'row',
      key: e.row.id,
      item: e.row,
      placementLabel: null,
      groupChip: chip
        ? chip.kind === 'in-group'
          ? GROUP_COPY.chipInGroup(groupName(chip.groupId))
          : GROUP_COPY.chipSameSku(groupName(chip.groupId))
        : null,
      addToGroupId: chip?.kind === 'same-sku' ? chip.groupId : null,
    });
  }
  return out;
}

/**
 * What the select bar keeps about a ticked record for Ungroup (owner
 * 2026-10-12, Ungroup anything): its display group, its size family, whether
 * another record in the list shares its raw SKU, and the grouping it is shown
 * under in the list's own composition (core shownUnderByRecord over the same
 * composeDisplayList the units come from). Taken from the whole filtered set
 * the tab holds, so a record's header is the one the member sees.
 */
export interface UngroupPickFacts {
  displayGroupId: string | null;
  familyId: string | null;
  sharesSku: boolean;
  shownUnder: UngroupKind | null;
}

export function ungroupFactsByItem<T extends GroupableItem>(
  items: readonly T[],
  opts?: { enableSizeRuns?: boolean },
): Map<string, UngroupPickFacts> {
  const shown = shownUnderByRecord(
    compose(items, opts?.enableSizeRuns !== false, { explicit: EMPTY, skus: EMPTY, runs: EMPTY }),
    (it) => it.id,
  );
  const recordsBySku = new Map<string, Set<string>>();
  for (const it of items) {
    const k = sharedSkuKey(it.sku);
    if (!k) continue;
    let set = recordsBySku.get(k);
    if (!set) recordsBySku.set(k, (set = new Set()));
    set.add(it.id);
  }
  const out = new Map<string, UngroupPickFacts>();
  for (const it of items) {
    if (out.has(it.id)) continue;
    const k = sharedSkuKey(it.sku);
    out.set(it.id, {
      displayGroupId: it.display_group_id ?? null,
      familyId: it.group_id ?? null,
      sharesSku: !!k && (recordsBySku.get(k)?.size ?? 0) >= 2,
      shownUnder: shown.get(it.id) ?? null,
    });
  }
  return out;
}

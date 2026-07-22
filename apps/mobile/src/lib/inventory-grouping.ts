import {
  groupBySizeRun,
  groupPlacementsBySku,
  rollupStatus,
  type PlacementRow,
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
  // A plain item row — standalone, an expanded size-run member, or an expanded
  // SKU-group placement (in which case `placementLabel` differentiates it).
  | { kind: 'row'; key: string; item: T; placementLabel: string | null };

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
}

// Internal, order-preserving entry between the two grouping passes.
type Entry<T extends GroupableItem> =
  | { kind: 'item'; item: T }
  | { kind: 'skuGroup'; sku: string; name: string; total: number; placements: T[] };

/**
 * PASS 1 — collapse same-SKU placements, preserving first-seen order.
 *
 * Extracted so `buildGroupedRows` (what renders) and `buildGroupUnits` (what
 * paginates) run the IDENTICAL collapse. If the pager grouped differently from
 * the renderer, a page could hold a unit the renderer then splits — the exact
 * failure the whole change exists to remove.
 */
function buildEntries<T extends GroupableItem>(items: readonly T[]): Entry<T>[] {
  // Stash the raw item on `__item` (PlacementRow's index signature allows it)
  // so we recover it afterward.
  const skuGroups = groupPlacementsBySku(
    items.map(
      (it): PlacementRow => ({
        id: it.id,
        sku: it.sku,
        name: it.name,
        charterId: it.charter_id,
        // Display labels are resolved at RENDER time from the screen's lookup
        // maps; this pass only needs identity + quantity.
        placementLabel: null,
        lineQuantity: Number(it.quantity_on_hand) || 0,
        __item: it,
      }),
    ),
  );
  // A single-placement SKU degrades to a normal item; a multi-placement SKU
  // becomes a header entry that the size-run pass must never fold in.
  return skuGroups.map((g): Entry<T> => {
    const placements = g.placements.map((p) => (p as PlacementRow & { __item: T }).__item);
    if (placements.length <= 1) {
      return { kind: 'item', item: placements[0]! };
    }
    return { kind: 'skuGroup', sku: g.sku, name: g.name, total: g.total, placements };
  });
}

/** The items an entry renders under one card. */
function entryItems<T extends GroupableItem>(e: Entry<T>): T[] {
  return e.kind === 'item' ? [e.item] : e.placements;
}

/** Size-run metadata for an entry — a SKU header is never groupable (its own
 *  children already expand), matching the web table. */
function entrySizeRunMeta<T extends GroupableItem>(e: Entry<T>) {
  return e.kind === 'item'
    ? {
        key: e.item.id,
        name: e.item.name,
        quantity: Number(e.item.quantity_on_hand) || 0,
        groupable: true,
      }
    : { key: `sku:${e.sku}`, name: e.name, quantity: 0, groupable: false };
}

/**
 * THE UNIT OF PAGINATION: the items behind each top-level card, in render
 * order — one array per collapsed SKU family, per size run, or per standalone
 * item. Feed the whole filtered set; hand the result to `paginateGroups`
 * (lib/inventory-paging.ts), then hand a page's items back to
 * `buildGroupedRows`. Because both functions run the same two passes and both
 * passes emit a group at its FIRST member's position, grouping a page produced
 * this way reproduces exactly the units it was sliced from — so a family is
 * whole on exactly one page, always.
 *
 * The mobile counterpart of `runAwarePages` on web (apps/web/src/lib/inventory/
 * instant-mode.ts), which packs a row budget without cutting a unit; mobile
 * pages a fixed number of units because one collapsed group is one card.
 * Display-only: no row is written, moved, dropped or duplicated — concatenating
 * every unit reproduces the input order exactly (modulo each group's members
 * clustering at the group's first position, which is what the list renders).
 */
export function buildGroupUnits<T extends GroupableItem>(
  items: readonly T[],
  opts?: { enableSizeRuns?: boolean },
): T[][] {
  const entries = buildEntries(items);
  if (opts?.enableSizeRuns === false) return entries.map(entryItems);
  return groupBySizeRun<Entry<T>>(entries, entrySizeRunMeta).map((s) =>
    s.kind === 'single' ? entryItems(s.entry) : s.group.members.flatMap(entryItems),
  );
}

/**
 * Build the flattened `GroupedRow[]` the mobile Items FlatList renders.
 * Display-only: nothing here writes or recomputes a record; totals are read-time
 * sums of each placement's `quantity_on_hand`.
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
  } = opts;

  // Pass 1 — collapse same-SKU placements (shared with `buildGroupUnits`, so
  // the pager and the renderer can never disagree about what a group is).
  const entries = buildEntries(items);

  // Emission for ONE entry — shared by the size-run path (its `single` branch)
  // and the size-runs-off path below, so the two can never drift apart.
  const emitEntry = (e: Entry<T>, out: GroupedRow<T>[]): void => {
    if (e.kind === 'item') {
      out.push({ kind: 'row', key: e.item.id, item: e.item, placementLabel: null });
      return;
    }
    // Multi-placement SKU header + (when expanded) its placement rows.
    // EVERY figure on the header is derived from `e.placements` — the exact
    // rows the chevron reveals — so the header can never contradict them.
    // When those rows may not be the whole family the header says so
    // (`partial`) rather than borrowing a figure from another scope.
    out.push({
      kind: 'sku-header',
      key: `sku:${e.sku}`,
      sku: e.sku,
      name: e.name,
      total: e.total,
      // reorder_point is PER PLACEMENT, and taking the first placement's let a
      // badge derived from the SUMMED total read HEALTHIER than every row
      // under it (4 placements of 3 against reorder points of 10 each: 12 > 10
      // reads OK over four rows all reading LOW). Sum it, exactly as the web
      // header does (`groupReorderPoint` in inventory-table.tsx): the group's
      // replenishment need is the sum of its placements' needs, which puts
      // threshold and quantity on the same scale and is the only rollup that
      // can never out-rank a UNANIMOUS reading — if every placement is low
      // then Σqty ≤ Σreorder, and if every placement is out then Σqty ≤ 0.
      reorderPoint: e.placements.reduce((sum, p) => sum + (Number(p.reorder_point) || 0), 0),
      placementCount: e.placements.length,
      status: rollupStatus(e.placements.map((p) => toLifecycle(p.status))),
      expected: e.placements.every((p) => p.awaiting_first_receipt),
      // Exact unless the caller's read was capped — group-aware pagination
      // guarantees these placements ARE the SKU's placements.
      partial: datasetIsTruncated,
    });
    if (expandedSkuGroups.has(e.sku)) {
      for (const p of e.placements) {
        out.push({
          kind: 'row',
          key: p.id,
          item: p,
          placementLabel: placementLabelFor?.(p) ?? null,
        });
      }
    }
  };

  // Books opt out of pass 2 entirely: a book is never sized, so a size-run
  // header derived from a title ending in a size-looking token would be pure
  // noise (web gates the same pass off behind `showBookFields`).
  if (!enableSizeRuns) {
    const bare: GroupedRow<T>[] = [];
    for (const e of entries) emitEntry(e, bare);
    return bare;
  }

  // Pass 2 — apparel size-run grouping ON TOP, over the single items only.
  const styled = groupBySizeRun<Entry<T>>(entries, entrySizeRunMeta);

  const out: GroupedRow<T>[] = [];
  for (const s of styled) {
    if (s.kind === 'single') {
      emitEntry(s.entry, out);
      continue;
    }
    // Size-run header — its members are always `item` entries (headers are
    // non-groupable, so they can never be pulled into a run).
    const g = s.group;
    out.push({
      kind: 'header',
      key: `g:${g.styleKey}`,
      styleKey: g.styleKey,
      baseName: g.baseName,
      total: g.total,
      sizeCount: g.sizeCount,
    });
    if (expandedSizeRuns.has(g.styleKey)) {
      for (const m of g.members) {
        if (m.kind === 'item') {
          out.push({ kind: 'row', key: m.item.id, item: m.item, placementLabel: null });
        }
      }
    }
  }
  return out;
}

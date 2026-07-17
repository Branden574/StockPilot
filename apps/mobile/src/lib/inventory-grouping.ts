import {
  groupBySizeRun,
  groupPlacementsBySku,
  rollupStatus,
  type PlacementRow,
} from '@stockpilot/core';

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
 * Per-page note: the mobile list is page-replace paginated (PAGE_SIZE 50), so
 * this collapses within the current page. A Map-based collapse gathers ALL
 * same-SKU rows on the page regardless of sort; the only edge is a SKU whose
 * placements straddle a page boundary, whose header then sums only this page's
 * placements — accepted (web has the full client-side dataset in instant mode
 * and mobile does not).
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
}

type LifecycleStatus = 'active' | 'archived' | 'discontinued';

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
  // Model B same-SKU collapse header (new). `reorderPoint` is the first
  // placement's (web mirrors this with `first.reorder_point`) so the header
  // can derive a stock badge from the SUMMED total, matching the web
  // StockStatusBadge precedence: lifecycle (archived/discontinued) wins,
  // else out/low/in from the total.
  | {
      kind: 'sku-header';
      key: string;
      sku: string;
      name: string;
      total: number;
      reorderPoint: number;
      placementCount: number;
      status: LifecycleStatus;
    }
  // A plain item row — standalone, an expanded size-run member, or an expanded
  // SKU-group placement (in which case `placementLabel` differentiates it).
  | { kind: 'row'; key: string; item: T; placementLabel: string | null };

/** Coerce a free-form status string to the lifecycle union `rollupStatus` needs. */
function toLifecycle(status: string): LifecycleStatus {
  return status === 'archived' || status === 'discontinued' ? status : 'active';
}

export interface BuildGroupedRowsOptions<T extends GroupableItem> {
  /** Expanded apparel size-run style keys. */
  expandedSizeRuns: ReadonlySet<string>;
  /** Expanded SKU-group SKUs. */
  expandedSkuGroups: ReadonlySet<string>;
  /** Optional label for an expanded placement's secondary line (charter/bin). */
  placementLabelFor?: (item: T) => string | null;
}

// Internal, order-preserving entry between the two grouping passes.
type Entry<T extends GroupableItem> =
  | { kind: 'item'; item: T }
  | { kind: 'skuGroup'; sku: string; name: string; total: number; placements: T[] };

/**
 * Build the flattened `GroupedRow[]` the mobile Items FlatList renders.
 * Display-only: nothing here writes or recomputes a record; totals are read-time
 * sums of each placement's `quantity_on_hand`.
 */
export function buildGroupedRows<T extends GroupableItem>(
  items: readonly T[],
  opts: BuildGroupedRowsOptions<T>,
): GroupedRow<T>[] {
  const { expandedSizeRuns, expandedSkuGroups, placementLabelFor } = opts;

  // Pass 1 — collapse same-SKU placements. Stash the raw item on `__item`
  // (PlacementRow's index signature allows it) so we recover it afterward.
  const skuGroups = groupPlacementsBySku(
    items.map(
      (it): PlacementRow => ({
        id: it.id,
        sku: it.sku,
        name: it.name,
        charterId: it.charter_id,
        placementLabel: placementLabelFor?.(it) ?? null,
        lineQuantity: Number(it.quantity_on_hand) || 0,
        __item: it,
      }),
    ),
  );

  // A single-placement SKU degrades to a normal item; a multi-placement SKU
  // becomes a header entry that the size-run pass must never fold in.
  const entries: Entry<T>[] = skuGroups.map((g) => {
    const placements = g.placements.map((p) => (p as PlacementRow & { __item: T }).__item);
    if (placements.length <= 1) {
      return { kind: 'item', item: placements[0]! };
    }
    return { kind: 'skuGroup', sku: g.sku, name: g.name, total: g.total, placements };
  });

  // Pass 2 — apparel size-run grouping ON TOP, over the single items only.
  const styled = groupBySizeRun<Entry<T>>(entries, (e) =>
    e.kind === 'item'
      ? {
          key: e.item.id,
          name: e.item.name,
          quantity: Number(e.item.quantity_on_hand) || 0,
          groupable: true,
        }
      : { key: `sku:${e.sku}`, name: e.name, quantity: 0, groupable: false },
  );

  const out: GroupedRow<T>[] = [];
  for (const s of styled) {
    if (s.kind === 'single') {
      const e = s.entry;
      if (e.kind === 'item') {
        out.push({ kind: 'row', key: e.item.id, item: e.item, placementLabel: null });
        continue;
      }
      // Multi-placement SKU header + (when expanded) its placement rows.
      out.push({
        kind: 'sku-header',
        key: `sku:${e.sku}`,
        sku: e.sku,
        name: e.name,
        total: e.total,
        reorderPoint: e.placements[0]!.reorder_point,
        placementCount: e.placements.length,
        status: rollupStatus(e.placements.map((p) => toLifecycle(p.status))),
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

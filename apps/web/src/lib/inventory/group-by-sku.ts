export interface PlacementRow {
  id: string;
  sku: string;
  name: string;
  charterId: string | null;
  placementLabel: string | null;
  lineQuantity: number;
  [k: string]: unknown;
}
export interface SkuGroup {
  sku: string;
  name: string;
  total: number;
  placements: PlacementRow[];
  /**
   * True when `total` is only a PAGE-SLICE sum — the group's placements
   * may not all be present in the rows this group was built from, so
   * the real cross-page total for this SKU could be higher. Set by the
   * caller (inventory-table.tsx), never by `groupPlacementsBySku` itself
   * (which only ever sees the rows it's given and sums them exactly).
   * Instant mode corrects `total` to the full filtered-set sum instead
   * of setting this flag; server mode, which only has the current page,
   * sets it on any multi-placement group when more than one page exists
   * — see the `skuGroups` derivation in inventory-table.tsx.
   */
  totalIsPartial?: boolean;
}

/**
 * Group placement rows (one per sku×charter×rack inventory_items row) into one
 * group per non-empty SKU, first-seen order, summing lineQuantity into total.
 * A blank/whitespace SKU is never grouped — each blank row is its own group
 * (blank SKUs are not a shared product identity).
 */
export function groupPlacementsBySku(rows: PlacementRow[]): SkuGroup[] {
  const order: string[] = [];
  const byKey = new Map<string, SkuGroup>();
  for (const r of rows) {
    const key = r.sku.trim() ? `sku:${r.sku}` : `blank:${r.id}`;
    let g = byKey.get(key);
    if (!g) {
      g = { sku: r.sku, name: r.name, total: 0, placements: [] };
      byKey.set(key, g);
      order.push(key);
    }
    g.total += r.lineQuantity;
    g.placements.push(r);
  }
  return order.map((k) => byKey.get(k)!);
}

const STATUS_SEVERITY: Record<'active' | 'archived' | 'discontinued', number> = {
  active: 0,
  archived: 1,
  discontinued: 2,
};

/**
 * Conservative status rollup for a SKU group-header row. `status` is a
 * PER-PLACEMENT field — placements of one SKU can legitimately differ
 * (e.g. one placement discontinued at a site while others stay active).
 * Picking an arbitrary placement's status (e.g. the first) can mask a
 * discontinued/archived placement behind a healthy badge for the whole
 * group, so this always returns the least-healthy status present:
 * discontinued > archived > active. When every placement agrees, that
 * shared status is returned unchanged.
 */
export function rollupStatus(
  statuses: ReadonlyArray<'active' | 'archived' | 'discontinued'>,
): 'active' | 'archived' | 'discontinued' {
  let worst: 'active' | 'archived' | 'discontinued' = 'active';
  for (const s of statuses) {
    if (STATUS_SEVERITY[s] > STATUS_SEVERITY[worst]) worst = s;
  }
  return worst;
}

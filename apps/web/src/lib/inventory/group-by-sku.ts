export interface PlacementRow {
  id: string;
  sku: string;
  name: string;
  charterId: string | null;
  charterName: string | null;
  placementLabel: string | null;
  lineQuantity: number;
  [k: string]: unknown;
}
export interface SkuGroup {
  sku: string;
  name: string;
  total: number;
  placements: PlacementRow[];
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

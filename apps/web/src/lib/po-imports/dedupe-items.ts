/**
 * SKU-dedupe for the PO-import match dropdown.
 *
 * This org's data model deliberately allows the same SKU across multiple
 * inventory_items rows (unique on org+sku+bin_location — the per-rack row
 * model behind "duplicate to rack"), so a naive one-option-per-row dropdown
 * shows "Into Algebra 1 (SP-8N8LR-8ND)" once per rack. This helper collapses
 * those duplicates to ONE option per SKU, targeting the OLDEST row.
 *
 * Pure + display-only: it shapes the combobox OPTIONS list. Every lookup by
 * id (stock-impact preview, lines already matched to a non-oldest duplicate)
 * must keep using the FULL items array.
 */

export interface SkuDedupableItem {
  id: string;
  /** Raw SKU; empty/null SKUs are never grouped — each row stands alone. */
  sku: string | null;
  /** ISO timestamp; the oldest row in a SKU group wins. */
  createdAt: string;
}

/**
 * True when `a` should represent the SKU group over `b`: older createdAt
 * wins; equal (or both unparseable) timestamps tie-break by ascending id so
 * the result is deterministic regardless of input order. An unparseable
 * createdAt sorts AFTER any real timestamp (it can't claim "oldest").
 */
function beats(a: SkuDedupableItem, b: SkuDedupableItem): boolean {
  const rawA = Date.parse(a.createdAt);
  const rawB = Date.parse(b.createdAt);
  const timeA = Number.isNaN(rawA) ? Number.POSITIVE_INFINITY : rawA;
  const timeB = Number.isNaN(rawB) ? Number.POSITIVE_INFINITY : rawB;
  if (timeA !== timeB) return timeA < timeB;
  return a.id < b.id;
}

/**
 * Collapse rows sharing a normalized SKU (`lower(trim(sku))`) to a single
 * row — the oldest by createdAt, tie-broken by id. Rows whose SKU is
 * null/empty/whitespace are NEVER grouped and pass through untouched.
 * Output order: first appearance of each group / ungrouped row.
 */
export function dedupeItemsBySku<T extends SkuDedupableItem>(rows: T[]): T[] {
  const out: T[] = [];
  const slotBySku = new Map<string, number>(); // normalized sku → index in `out`
  for (const row of rows) {
    const key = (row.sku ?? '').trim().toLowerCase();
    if (!key) {
      out.push(row);
      continue;
    }
    const slot = slotBySku.get(key);
    const current = slot === undefined ? undefined : out[slot];
    if (slot === undefined || current === undefined) {
      slotBySku.set(key, out.length);
      out.push(row);
    } else if (beats(row, current)) {
      out[slot] = row;
    }
  }
  return out;
}

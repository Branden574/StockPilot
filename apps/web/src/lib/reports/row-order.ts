/**
 * Report row order that does not depend on the order the rows arrive in.
 *
 * A report sorts by its figure, most first. Rows that tie on that figure used
 * to keep the order they arrived in, and several inputs have no fixed order:
 * a GROUP BY with no ORDER BY (report_movement_type_summary and
 * report_bundle_activity, 0380) and the vw_inventory_valuation_* views. The
 * planner can hand the same groups back in another order on the next load, so
 * tied rows swapped places on the page and in every export. On 2026-09-29
 * Demo Co's Stock movements CSV swapped `initial` and `bundle_distribution`
 * (3 each) between two exports of the same data, which reads as changed data
 * to anyone comparing the files.
 *
 * Each comparator keeps the report's figure as the first key, then breaks a
 * tie the way a reader looks for a row: the name (locale order, with numbers
 * in numeric order, so "Kit 2" comes before "Kit 10"), then the SKU or code,
 * then the id, which never ties.
 *
 * Pure (no server-only import): the report pages, the CSV, PDF and XLSX
 * routes and the service all use it, so a page and its exports list rows in
 * the same order.
 */

const collator = new Intl.Collator('en', { numeric: true });

/** Reader order for names, SKUs and codes. A missing value sorts as empty. */
export function compareText(a: string | null | undefined, b: string | null | undefined): number {
  return collator.compare(a ?? '', b ?? '');
}

/**
 * Exact code-unit order, for ids (the last key, so two rows never tie) and
 * for ISO timestamps (which sort chronologically as text). The collator is
 * not enough on its own: numeric collation treats "a01" and "a1" as equal.
 */
export function compareExact(a: string | null | undefined, b: string | null | undefined): number {
  const x = a ?? '';
  const y = b ?? '';
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Inventory valuation, by warehouse: value (most first), name, id. */
export function compareWarehouseRollups(
  a: { value: number; warehouseName: string; warehouseId: string | null },
  b: { value: number; warehouseName: string; warehouseId: string | null },
): number {
  return (
    b.value - a.value ||
    compareText(a.warehouseName, b.warehouseName) ||
    compareExact(a.warehouseId, b.warehouseId)
  );
}

/** Inventory valuation, by category: value (most first), name, id. */
export function compareCategoryRollups(
  a: { value: number; categoryName: string; categoryId: string | null },
  b: { value: number; categoryName: string; categoryId: string | null },
): number {
  return (
    b.value - a.value ||
    compareText(a.categoryName, b.categoryName) ||
    compareExact(a.categoryId, b.categoryId)
  );
}

/** Stock movements, by type: count (most first), then the type's code. */
export function compareMovementTypes(
  a: { count: number; movementType: string },
  b: { count: number; movementType: string },
): number {
  return (
    b.count - a.count ||
    compareText(a.movementType, b.movementType) ||
    compareExact(a.movementType, b.movementType)
  );
}

/** Bundle activity: kits out (most first), bundle name, SKU, id. */
export function compareBundleActivity(
  a: { kitsOut: number; bundleName: string; bundleSku: string | null; bundleId: string },
  b: { kitsOut: number; bundleName: string; bundleSku: string | null; bundleId: string },
): number {
  return (
    b.kitsOut - a.kitsOut ||
    compareText(a.bundleName, b.bundleName) ||
    compareText(a.bundleSku, b.bundleSku) ||
    compareExact(a.bundleId, b.bundleId)
  );
}

/** One price observation of the item cost history, flattened across suppliers. */
export interface CostHistoryRow {
  supplier: string;
  supplierId: string;
  /** ISO timestamp (or date) the price was committed or paid. */
  date: string;
  source: 'purchase_order' | 'receipt';
  unitCost: number;
}

/**
 * Item cost history: oldest first (the full timestamp), then supplier name,
 * supplier id, source (the order before its receipt) and unit cost. Rows
 * that tie on all five print identically.
 */
export function compareCostHistoryRows(a: CostHistoryRow, b: CostHistoryRow): number {
  return (
    compareExact(a.date, b.date) ||
    compareText(a.supplier, b.supplier) ||
    compareExact(a.supplierId, b.supplierId) ||
    compareExact(a.source, b.source) ||
    a.unitCost - b.unitCost
  );
}

/**
 * The item cost history's table rows: every supplier's points in one list,
 * in compareCostHistoryRows order. The page, the CSV, the PDF and the XLSX
 * all read this, so they list the same rows in the same order. (The CSV and
 * XLSX used to sort by the calendar day alone, so two prices on one day
 * could come out in the other order from the page.)
 */
export function costHistoryRows(
  series: ReadonlyArray<{
    supplierId: string;
    supplierName: string;
    points: ReadonlyArray<{ date: string; unitCost: number; source: 'purchase_order' | 'receipt' }>;
  }>,
): CostHistoryRow[] {
  return series
    .flatMap((s) =>
      s.points.map(
        (p): CostHistoryRow => ({
          supplier: s.supplierName,
          supplierId: s.supplierId,
          date: p.date,
          source: p.source,
          unitCost: p.unitCost,
        }),
      ),
    )
    .sort(compareCostHistoryRows);
}

/**
 * Warehouse view-filter semantics for locations lists.
 *
 * When the global warehouse selector is set (sp_warehouse_filter cookie), a
 * locations list should hide rows tied to a DIFFERENT warehouse, keep rows
 * tied to the selected one, and keep rows tied to none (legacy/unlinked
 * sites, racks created before warehouse linking) — hiding those everywhere
 * except "All warehouses" would make them unfindable.
 */
export function scopeLocationsToWarehouse<T extends { warehouse_id: string | null }>(
  rows: T[],
  warehouseId: string | null,
): T[] {
  if (!warehouseId) return rows;
  return rows.filter((r) => r.warehouse_id === null || r.warehouse_id === warehouseId);
}

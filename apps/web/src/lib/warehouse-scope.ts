/**
 * Warehouse-scope presentation helpers (Unit 4 of the auditor-visibility
 * plan). Pure functions — shared by the web scoped-view banner
 * (ScopedWarehouseNotice), the Items empty states, and the mobile snapshot
 * route's `warehouseScope` payload — so every surface derives the same
 * shape + copy from `getWarehouseAccess()` output and can be unit-tested
 * without a request context.
 */

export interface WarehouseScope {
  /** True for owner/admin/manager — every warehouse. */
  hasAllAccess: boolean;
  /** Names of the warehouses the user can read (all of them when
   *  hasAllAccess; the assigned subset otherwise; [] when a scoped user
   *  has no assignments at all). */
  warehouseNames: string[];
}

/**
 * Resolves a WarehouseScope from the access decision + a warehouse name
 * list. `warehouses` may be broader than the user's readable set (e.g. the
 * request-cached org-wide list, or the snapshot route's unfiltered query for
 * a zero-assignment user) — scoped users are always narrowed to readableIds
 * here, so a scoped user with zero assignments reports [] rather than the
 * org's full list.
 */
export function buildWarehouseScope(
  access: { hasAllAccess: boolean; readableIds: string[] },
  warehouses: Array<{ id: string; name: string }>,
): WarehouseScope {
  if (access.hasAllAccess) {
    return { hasAllAccess: true, warehouseNames: warehouses.map((w) => w.name) };
  }
  const readable = new Set(access.readableIds);
  return {
    hasAllAccess: false,
    warehouseNames: warehouses.filter((w) => readable.has(w.id)).map((w) => w.name),
  };
}

/**
 * The scoped-view banner line, or null when the user sees everything
 * (all-access users get no banner). Zero assigned warehouses gets its own
 * variant — "viewing nothing only" would read as a bug.
 */
export function scopedWarehouseMessage(scope: WarehouseScope): string | null {
  if (scope.hasAllAccess) return null;
  if (scope.warehouseNames.length === 0) {
    return 'You have no assigned warehouses. An admin can adjust warehouse access from the Team page.';
  }
  return `You're viewing ${scope.warehouseNames.join(', ')} only. An admin can adjust warehouse access from the Team page.`;
}

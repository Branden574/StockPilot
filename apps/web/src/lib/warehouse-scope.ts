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
   *  has no assignments at all, or when either flag below is set). */
  warehouseNames: string[];
  /**
   * Present (true) only when the scoped user's warehouse ACCESS could not be
   * read (getWarehouseAccess's `unreadable`). What they can see is unknown,
   * and every list built from that answer is empty because of the failure,
   * not because nothing is assigned: the copy must not say "no assigned
   * warehouses", which sends them to an admin to fix access that is fine.
   */
  unreadable?: true;
  /**
   * Present (true) only when the access is known and non-empty but the
   * warehouse NAMES could not be read. The user is scoped to real warehouses;
   * only which ones cannot be said.
   */
  namesUnreadable?: true;
}

/**
 * Resolves a WarehouseScope from the access decision + a warehouse name
 * list. `warehouses` may be broader than the user's readable set (e.g. the
 * request-cached org-wide list) — scoped users are always narrowed to
 * readableIds here, so a scoped user with zero assignments reports [] rather
 * than the org's full list.
 *
 * `warehouses` is null when the name list could not be read
 * (readWarehousesForRequest's `failed`). Neither failure is ever reported as
 * "no assigned warehouses": that answer is kept for a lookup that succeeded
 * and found none. The mobile snapshot never produces either flag: it refuses
 * a scoped caller whose access is unreadable (a 500, so the phone keeps its
 * cache), and it answers 500 when its own warehouses read fails.
 */
export function buildWarehouseScope(
  access: { hasAllAccess: boolean; readableIds: string[]; unreadable?: true },
  warehouses: Array<{ id: string; name: string }> | null,
): WarehouseScope {
  if (access.hasAllAccess) {
    return { hasAllAccess: true, warehouseNames: (warehouses ?? []).map((w) => w.name) };
  }
  if (access.unreadable) {
    return { hasAllAccess: false, warehouseNames: [], unreadable: true };
  }
  if (warehouses === null && access.readableIds.length > 0) {
    return { hasAllAccess: false, warehouseNames: [], namesUnreadable: true };
  }
  const readable = new Set(access.readableIds);
  return {
    hasAllAccess: false,
    warehouseNames: (warehouses ?? []).filter((w) => readable.has(w.id)).map((w) => w.name),
  };
}

/**
 * Appended to the scoped line on pages with placement columns (0371): staff
 * and viewers read stock locations in their own warehouses only, and stock
 * elsewhere is counted rather than named.
 */
export const SCOPED_PLACEMENT_NOTE =
  "Rack columns show your warehouses' racks; stock elsewhere shows as \"in other warehouses\".";

/** Shown when a scoped user's warehouse access could not be read. */
export const WAREHOUSE_ACCESS_UNREADABLE_MESSAGE =
  "We couldn't load your warehouse access. Refresh the page to try again.";

/**
 * The scoped-view banner line, or null when the user sees everything
 * (all-access users get no banner). Zero assigned warehouses gets its own
 * variant — "viewing nothing only" would read as a bug — and so does an
 * access or name read that failed, so a failure never reads as "none".
 */
export function scopedWarehouseMessage(scope: WarehouseScope): string | null {
  if (scope.hasAllAccess) return null;
  if (scope.unreadable) return WAREHOUSE_ACCESS_UNREADABLE_MESSAGE;
  if (scope.namesUnreadable) {
    return "You're viewing only the warehouses assigned to you. An admin can adjust warehouse access from the Team page.";
  }
  if (scope.warehouseNames.length === 0) {
    return 'You have no assigned warehouses. An admin can adjust warehouse access from the Team page.';
  }
  return `You're viewing ${scope.warehouseNames.join(', ')} only. An admin can adjust warehouse access from the Team page.`;
}

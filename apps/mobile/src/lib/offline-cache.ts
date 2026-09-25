/**
 * Settings > Offline cache > Clear.
 *
 * THE BUG (found by the S4 simulator walk, 2026-09-24): the button asked
 * "Clear offline cache?" and then only showed "Cleared". Nothing was deleted,
 * so an operator trying to shake off a stale or wrong local copy was told it
 * had worked when it had not.
 *
 * What it does now, in the same order a workspace switch uses:
 *   1. Refuse while offline. Clearing without a connection would leave the
 *      phone with no offline copy and no way to re-download one, which is the
 *      opposite of what someone reaching for this button needs.
 *   2. deleteOrgData(): the cached items, warehouses, POs, counts and bundles,
 *      plus the sync cursor and the cached permissions / warehouse scope.
 *      The outbox (pending_actions) is NEVER touched: unsent work survives.
 *   3. A forced FULL pull (no `?since`), so the lists refill from the server.
 *   4. Tell the permission and warehouse-scope hooks to re-read.
 *
 * Dependencies are injectable so the order and the offline refusal are
 * testable without a device.
 */

export interface OfflineCacheDeps {
  isOnline: () => Promise<boolean>;
  deleteOrgData: () => Promise<void>;
  syncNow: (force: boolean) => Promise<void>;
  refreshEffectivePermissions: () => void;
  refreshWarehouseScope: () => void;
}

export type ClearOfflineCacheResult = { ok: true } | { ok: false; reason: 'offline' };

export async function clearOfflineCache(deps: OfflineCacheDeps): Promise<ClearOfflineCacheResult> {
  if (!(await deps.isOnline())) return { ok: false, reason: 'offline' };
  await deps.deleteOrgData();
  await deps.syncNow(true);
  deps.refreshEffectivePermissions();
  deps.refreshWarehouseScope();
  return { ok: true };
}

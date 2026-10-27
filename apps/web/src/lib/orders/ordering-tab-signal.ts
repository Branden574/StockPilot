/**
 * WHAT AN OPEN ORDERING PAGE TELLS InventoryRealtime (ordering visibility,
 * 0413 review fix round, findings F1 and F2). Module state, one copy per
 * browser tab, read when a visibility-only realtime event arrives.
 *
 *   The storefront's warehouse. Place an Order shows one warehouse's catalog;
 *   a Show or Hide of another warehouse's record changes nothing it shows.
 *   InventoryRealtime refreshes the page only for an event of this warehouse
 *   (or when it is not known), so a write no longer re-renders every ordering
 *   tab of the organization against a catalog entry the write just expired.
 *
 *   This tab's own writes. Manage order items saves through a Server Action
 *   whose response already carries the re-rendered page; the realtime event
 *   of that same write would render it again. The page marks the ids it sends
 *   and InventoryRealtime drops their visibility-only events for a short
 *   while. Another manager's write to other records still refreshes the tab.
 *
 * Client only, never read on the server: nothing here is a security or
 * correctness rule (the server catalog's overlay and the database gate are),
 * only how many re-renders a tab asks for.
 */

let storefrontWarehouse: string | null = null;
const ownWrites = new Map<string, number>();
/** Bound on remembered ids (a write names at most 500). */
const OWN_WRITES_MAX = 2_000;

/** How long after its write settles a tab ignores the write's own events. */
export const OWN_VISIBILITY_WRITE_MS = 3_000;

/**
 * Place an Order registers the warehouse it shows. Returns the cleanup for
 * an effect: it clears the value only if no later page replaced it.
 */
export function setOrderingTabWarehouse(warehouseId: string): () => void {
  const value = warehouseId.toLowerCase();
  storefrontWarehouse = value;
  return () => {
    if (storefrontWarehouse === value) storefrontWarehouse = null;
  };
}

/** The warehouse the open Place an Order page shows, or null when none is
 *  registered (then every visibility-only event concerns it). */
export function orderingTabWarehouse(): string | null {
  return storefrontWarehouse;
}

/**
 * Marks ids this tab is writing (or wrote) as its own until `until` (epoch
 * ms). Called when a save is sent (until a generous bound, the action may be
 * slow) and again when it settles (until settle + OWN_VISIBILITY_WRITE_MS).
 */
export function markOwnVisibilityWrite(itemIds: readonly string[], until: number): void {
  for (const id of itemIds) {
    const key = id.toLowerCase();
    ownWrites.delete(key);
    ownWrites.set(key, until);
  }
  while (ownWrites.size > OWN_WRITES_MAX) {
    ownWrites.delete(ownWrites.keys().next().value as string);
  }
}

/** True while `itemId` is one of this tab's own visibility writes. */
export function isOwnVisibilityWrite(itemId: unknown, now: number = Date.now()): boolean {
  if (typeof itemId !== 'string') return false;
  const until = ownWrites.get(itemId.toLowerCase());
  if (until === undefined) return false;
  if (until < now) {
    ownWrites.delete(itemId.toLowerCase());
    return false;
  }
  return true;
}

/** Tests only: forget everything. */
export function resetOrderingTabSignalForTests(): void {
  storefrontWarehouse = null;
  ownWrites.clear();
}

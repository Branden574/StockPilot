import { ORDER_CATALOG_PREFIX, ORDER_PHOTOS_PREFIX } from './store';

/**
 * The order caches an involuntary sign-out removes (L137): the last catalog
 * answer and the photo map, which holds signed photo URLs. A deliberate
 * sign-out already removes every `workspace.` key (auth-context
 * clearAccountStorage); a session taken away (revoked from the web, an
 * eviction's own sign-out) removed nothing, so both stayed at rest. The
 * active organization and warehouse, the order prefs and the carts are kept,
 * so the person who signs back in finds their cart. Every account's caches go:
 * the session that ended may not be the last one cached.
 */
export function orderCacheKeys(allKeys: readonly string[]): string[] {
  return allKeys.filter((k) => k.startsWith(ORDER_CATALOG_PREFIX) || k.startsWith(ORDER_PHOTOS_PREFIX));
}

export interface KeyListingStore {
  getAllKeys(): Promise<readonly string[]>;
  multiRemove(keys: readonly string[]): Promise<void>;
}

/** Best-effort: never throws (a failed removal leaves the caches, as before). */
export async function removeOrderCachesAtRest(store: KeyListingStore): Promise<void> {
  try {
    const keys = orderCacheKeys(await store.getAllKeys());
    if (keys.length > 0) await store.multiRemove(keys);
  } catch {
    // Best-effort, like every other step of a session end.
  }
}

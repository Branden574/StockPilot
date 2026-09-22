import 'server-only';

// The Items/Books list cache's tag and its invalidation, in a LEAF module.
//
// WHY THIS IS NOT IN loaders/inventory-list.ts ANY MORE: the service write
// methods call it now (see invalidateInventoryListAfterWrite below), and that
// loader imports services (context, item-images, lib/item-trends). A service
// importing the loader would close an import cycle through InventoryService.
// This module imports nothing from the app, so any service can depend on it.
// The loader re-exports both names, so every existing importer and test mock
// keeps working. Moving them does NOT rotate the cached entries: Next keys
// unstable_cache on the wrapped function's source text and its keyParts
// (next/dist/server/web/spec-extension/unstable-cache.js, `fixedKey`), and
// none of the loader's cached functions changed.

import { revalidateTag } from 'next/cache';

/** Single source of truth for the per-org cache tag. */
export function inventoryListTag(organizationId: string): string {
  return `inventory-list-${organizationId}`;
}

/**
 * Invalidate the cached Items/Books views for one org. THROWS when Next has no
 * request scope to record the tag in (a script, a test, a render) — callers
 * on a write path use invalidateInventoryListAfterWrite, which never does.
 */
export function revalidateInventoryList(organizationId: string): void {
  // The object form with expire:0 is REQUIRED here — it means
  // "expired now, recompute before serving". The 'max' profile is
  // stale-while-revalidate (stale=now, expire=+INFINITE), so
  // unstable_cache would serve the pre-write entry ONE more time and
  // only recompute in the background — every write lacking a matching
  // revalidatePath for the viewed page would deterministically show
  // pre-write data on the next view (e.g. delete a book →
  // /dashboard/books still lists it, server-shared for all managers).
  // The legacy single-arg call also expires immediately but logs a
  // deprecation warning on every write. (updateTag would be rejected
  // in Route Handler callers.)
  revalidateTag(inventoryListTag(organizationId), { expire: 0 });
}

/**
 * THE call every service write method makes once its stock write has
 * committed. It lives in the SERVICE, not the action, because the 2026-09-22
 * census found five paths that moved stock with no invalidation at all: the
 * phone's only way to post a cycle count (/api/v1/cycle-counts/[id]/post),
 * the web's Reopen picking, a schedule event completing into a bundle
 * distribution, the AI cancelOrder / applyReorderPoint tools, and PO-import
 * approve/cancel. Each had a caller that forgot; a service call cannot be
 * forgotten by a caller. The guard in inventory-list-invalidation.guard.test.ts
 * fails the build when a service method writes stock without calling this.
 *
 * NEVER THROWS. The write already committed; a failed invalidation costs at
 * most the 60s TTL of staleness (LIST_TTL_SEC in the loader), which must not
 * turn a successful write into an error the user retries — a retried stock
 * adjustment applies twice. The failure is logged with `label` (a short
 * "domain.verb", e.g. 'cycle_count.post') so the log names the write path.
 *
 * ONE CALL COVERS THE WHOLE REQUEST: revalidateTag only RECORDS the tag on the
 * request's work store, and Next expires it when the Server Action or Route
 * Handler finishes (next/dist/server/revalidation-utils.js executeRevalidates),
 * so the cache entry's expiry is stamped after every write the request made,
 * not at this call. Call it right after the first write commits, so a later
 * step that throws cannot skip it; a second call in the same request is
 * de-duplicated by Next (revalidate.js, pendingRevalidatedTags findIndex).
 */
export function invalidateInventoryListAfterWrite(organizationId: string, label: string): void {
  try {
    revalidateInventoryList(organizationId);
  } catch (err) {
    console.warn(
      `[inventory-list] invalidation skipped after ${label}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

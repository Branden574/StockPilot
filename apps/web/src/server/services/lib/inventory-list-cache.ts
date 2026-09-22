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

import { AsyncLocalStorage } from 'node:async_hooks';

import { revalidateTag } from 'next/cache';
import { after } from 'next/server';

/** Single source of truth for the per-org cache tag. */
export function inventoryListTag(organizationId: string): string {
  return `inventory-list-${organizationId}`;
}

/**
 * Orgs whose stock was written inside the current runStreamedStockWrites call.
 * AsyncLocalStorage, not a module-level Set: one server instance serves many
 * requests at once, and each streamed body must flush only its own writes.
 */
const streamedWriteOrgs = new AsyncLocalStorage<Set<string>>();

/**
 * Invalidate the cached Items/Books views for one org. THROWS when Next has no
 * request scope to record the tag in (a script, a test, a render) — callers
 * on a write path use invalidateInventoryListAfterWrite, which never does.
 *
 * Inside runStreamedStockWrites the org is queued for that scope's flush
 * instead of being recorded now; see there for why a record made from inside
 * a streamed body is lost.
 */
export function revalidateInventoryList(organizationId: string): void {
  const streamed = streamedWriteOrgs.getStore();
  if (streamed) {
    streamed.add(organizationId);
    return;
  }
  expireInventoryListNow(organizationId);
}

function expireInventoryListNow(organizationId: string): void {
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
 * request's work store, and Next expires it when the Server Action finishes,
 * or when a Route Handler RETURNS its Response
 * (next/dist/server/revalidation-utils.js executeRevalidates), so the cache
 * entry's expiry is stamped after every write the request made, not at this
 * call. Call it right after the first write commits, so a later step that
 * throws cannot skip it; a second call in the same request is de-duplicated
 * by Next (revalidate.js, pendingRevalidatedTags findIndex).
 *
 * A write that runs AFTER the handler returned (inside a streamed body) is
 * past that point; such a route wraps its body in runStreamedStockWrites.
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

/**
 * Run the body of a STREAMED Route Handler response so the stock writes it
 * makes still expire the Items/Books cache.
 *
 * WHY IT IS NEEDED (measured on next 16.3.5 with src/test/next-route-harness):
 * a Route Handler's recorded tags are sent to the cache exactly once, when the
 * handler returns its Response (route-modules/app-route/module.js,
 * resolvePendingRevalidations). A streamed body keeps running after that. The
 * AI chat route (/api/ai/chat) returns a ReadableStream at once and runs the
 * model, and so every write tool (adjustStock, cancelOrder, applyReorderPoint,
 * the book import...), inside it. Those calls still reach revalidateTag, which
 * still finds the request's work store (the stream was created inside the
 * handler, so AsyncLocalStorage carries it) and pushes the tag onto
 * pendingRevalidatedTags. Nothing reads that array again. No error, no log:
 * the harness shows zero tags reaching the cache.
 *
 * WHY after(), AND WHY THE ORGS ARE HELD BACK UNTIL THEN: after() callbacks
 * run once the response has closed, inside withExecuteRevalidates
 * (after/after-context.js runCallbacks), which DOES send the tags they record
 * to the cache. But it sends only tags that are new relative to the work store
 * as it stood when the callbacks started (revalidation-utils.js
 * diffRevalidationState compares tag + profile). Had the tools recorded
 * `inventory-list-<org>` during the stream, the flush below would record the
 * same tag with the same profile, match that dead entry, and be dropped too:
 * the harness shows zero tags for that sequence as well. So inside this scope
 * revalidateInventoryList only queues the org, and the tag is recorded for the
 * first time in the after() callback.
 *
 * The callback waits for `fn` to settle before flushing, so a write that
 * commits after the client disconnected (a disconnect closes the response
 * early) is still covered. Invalidating before the response starts is not an
 * option: the model decides mid-stream which tools to call. The expiry lands
 * when the stream closes, right after the final `done` event; neither chat
 * client (web chat-panel, mobile ai/chat) re-reads a list on that event, so
 * the next read is a later navigation.
 *
 * Constraint: the request must not also invalidate the same org BEFORE its
 * handler returns. That entry would already be in the store when the flush
 * runs, and Next would de-duplicate the flush away. The chat route writes only
 * its own chat tables before returning.
 *
 * Where after() cannot register (outside a request, e.g. a script or a test
 * without Next's storages, or a host with no waitUntil) it throws, and `fn`
 * runs unscoped: every write invalidates inline, exactly as without this
 * wrapper. A flush failure is logged with `label`, never thrown.
 */
export async function runStreamedStockWrites<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const orgs = new Set<string>();
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  try {
    after(async () => {
      await settled;
      for (const org of orgs) {
        try {
          expireInventoryListNow(org);
        } catch (err) {
          console.warn(
            `[inventory-list] invalidation skipped after ${label}:`,
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    });
  } catch {
    return fn();
  }
  try {
    return await streamedWriteOrgs.run(orgs, fn);
  } finally {
    settle();
  }
}

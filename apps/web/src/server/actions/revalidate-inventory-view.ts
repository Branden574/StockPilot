'use server';

import { refreshInventoryViewForCurrentOrg } from '@/server/loaders/inventory-list';

/**
 * Called by the realtime listener (components/realtime/inventory-realtime.tsx)
 * when a watcher's browser receives an inventory change event. Re-renders the
 * watcher's page into this action's response (one round trip), and on Items
 * or Books, for a caller who reads the org-shared list caches (manager and
 * above), also expires those caches: writes that don't pass through this
 * server (SQL, platform tooling) can't fire the inventory-list tag
 * invalidation themselves, so the WATCHING managers do it on the writer's
 * behalf, and their refresh recomputes instead of reading the ≤60s cached
 * default view. Every other tab only re-renders (refresh()), because nothing
 * it shows reads those caches. See refreshInventoryViewForCurrentOrg.
 *
 * The invalidation or the refresh IS the re-render: either one inside a
 * Server Action marks the path revalidated (next 16.4.3,
 * server/web/spec-extension/revalidate.js: `expire === 0`, and refresh(), set
 * workStore.pathWasRevalidated), so the action handler re-renders the current
 * page into this action's own response and sends `x-action-revalidated`
 * (server/app-render/action-handler.js), and the client router applies it as
 * a RefreshAll navigation (router-reducer/reducers/server-action-reducer.js).
 * A router.refresh() after that rendered the whole page a second time.
 *
 * `view` is which list the tab shows ('items' or 'books'; anything else is
 * neither). It only narrows: it can never expire another organization's
 * cache, and a caller who may not read the shared caches expires nothing
 * whatever it says.
 *
 * Returns whether a re-render is coming. false means none is, so the caller
 * must refresh by itself.
 *
 * Safe to expose: org is derived from the caller's session (client input is
 * not trusted), the helper never throws, and spamming it is no worse than
 * repeatedly loading the list with a filter (the always-live path).
 */
export async function revalidateInventoryViewAction(view?: unknown): Promise<boolean> {
  return refreshInventoryViewForCurrentOrg(view);
}

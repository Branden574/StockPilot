'use server';

import { revalidateInventoryListForCurrentOrg } from '@/server/loaders/inventory-list';

/**
 * Called by the realtime listener (components/realtime/inventory-realtime.tsx)
 * when a watcher's browser receives an inventory change event. Writes that
 * don't pass through this server (mobile app direct-to-Supabase, SQL,
 * platform tooling) can't fire the inventory-list tag invalidation
 * themselves — so the WATCHING clients do it on the writer's behalf,
 * ensuring the refresh recomputes instead of reading the ≤60s cached
 * default view.
 *
 * The invalidation IS the refresh. revalidateTag(tag, { expire: 0 }) inside a
 * Server Action marks the path revalidated (next 16.3.5,
 * server/web/spec-extension/revalidate.js: `expire === 0` sets
 * workStore.pathWasRevalidated), so the action handler re-renders the current
 * page into this action's own response and sends `x-action-revalidated`
 * (server/app-render/action-handler.js), and the client router applies it as
 * a RefreshAll navigation (router-reducer/reducers/server-action-reducer.js).
 * A router.refresh() after that rendered the whole page a second time.
 *
 * Returns whether the invalidation happened. false means no re-render is
 * coming, so the caller must refresh by itself.
 *
 * Safe to expose: org is derived from the caller's session (client input is
 * not trusted), the helper never throws, and spamming it is no worse than
 * repeatedly loading the list with a filter (the always-live path).
 */
export async function revalidateInventoryViewAction(): Promise<boolean> {
  return revalidateInventoryListForCurrentOrg();
}

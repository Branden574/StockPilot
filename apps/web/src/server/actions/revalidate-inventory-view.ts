'use server';

import { revalidateInventoryListForCurrentOrg } from '@/server/loaders/inventory-list';

/**
 * Called by the realtime listener (components/realtime/inventory-realtime.tsx)
 * when a watcher's browser receives an inventory change event. Writes that
 * don't pass through this server (mobile app direct-to-Supabase, SQL,
 * platform tooling) can't fire the inventory-list tag invalidation
 * themselves — so the WATCHING clients do it on the writer's behalf, right
 * before router.refresh(), ensuring the refresh recomputes instead of
 * reading the ≤60s cached default view.
 *
 * Safe to expose: org is derived from the caller's session (client input is
 * not trusted), the helper never throws, and spamming it is no worse than
 * repeatedly loading the list with a filter (the always-live path).
 */
export async function revalidateInventoryViewAction(): Promise<void> {
  await revalidateInventoryListForCurrentOrg();
}

'use client';

import { usePathname, useRouter } from 'next/navigation';
import * as React from 'react';

import { createClient } from '@/lib/supabase/client';
import { ensureRealtimeAuth } from '@/lib/supabase/realtime-auth';
import { revalidateInventoryViewAction } from '@/server/actions/revalidate-inventory-view';

interface InventoryRealtimeProps {
  organizationId: string;
  /**
   * Which tables to listen to. The default is the dashboard-relevant set;
   * pages that only care about a subset can pass a narrower list to keep
   * subscriptions cheap.
   */
  tables?: Array<'inventory_items' | 'stock_movements' | 'purchase_orders' | 'rentals'>;
}

/**
 * Routes that have nothing to do with live inventory/orders/POs/rentals.
 * On these paths the realtime WebSocket is skipped entirely — no
 * subscription opens, no router.refresh() ever fires. Sole purpose:
 * stop paying for a WebSocket on routes whose RSC payload doesn't
 * change from inventory mutations (settings, reports, admin config,
 * schedule, procedures, etc).
 *
 * If you add a new dashboard section that needs live updates, omit it
 * from this list. New admin/config sections SHOULD be added here so
 * they don't open a useless socket.
 */
const REALTIME_SKIP_PREFIXES = [
  '/dashboard/admin',
  '/dashboard/settings',
  '/dashboard/reports',
  '/dashboard/schedule',
  '/dashboard/procedures',
  '/dashboard/team',
  '/dashboard/locations',
  '/dashboard/categories',
  '/dashboard/tags',
  '/dashboard/suppliers',
  '/dashboard/ai',
];

/**
 * Subscribes to org-scoped postgres_changes on the requested tables and
 * triggers `router.refresh()` (debounced) so RSC pages re-fetch with
 * fresh data. The actual data fetching remains in server components —
 * this just nudges Next.js to re-run them.
 *
 * RLS applies to realtime subscriptions, so events for rows the user
 * can't read are filtered out by Postgres before they reach the client.
 */
const THROTTLE_MS = 250;

export function InventoryRealtime({
  organizationId,
  tables = ['inventory_items', 'stock_movements', 'purchase_orders', 'rentals'],
}: InventoryRealtimeProps) {
  const router = useRouter();
  const pathname = usePathname();
  // Short-circuit on routes that don't need realtime — no WebSocket opens.
  const skip = React.useMemo(
    () => REALTIME_SKIP_PREFIXES.some((p) => pathname?.startsWith(p)),
    [pathname],
  );
  // Leading-edge throttle: the FIRST event fires router.refresh()
  // immediately so single inserts (e.g. mobile → web) feel instant;
  // subsequent events within the throttle window collapse into one
  // trailing refresh so bulk imports don't trigger N refreshes.
  //
  // Previously this was a 750ms trailing debounce, which meant every
  // single insert paid the full 750ms before the UI updated — the
  // dominant latency in the "phone → computer feels slow" complaint.
  const lastRefreshRef = React.useRef(0);
  const pendingRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    if (skip) return;
    // Wrap the entire realtime setup in try/catch. If a browser blocks
    // WebSockets (some Chrome enterprise policies, certain extensions,
    // restrictive networks), an exception thrown here would unmount the
    // dashboard shell and surface as a black screen — the live-update
    // feature isn't worth that. Worst case: stale-until-refresh, which
    // is exactly what we had before realtime existed.
    const cleanup: Array<() => void> = [];
    let cancelled = false;
    void (async () => {
    try {
      const supabase = createClient();
      // Join AFTER the auth token reaches the realtime socket. Subscribing
      // straight from the mount effect races session hydration; a lost race
      // registers the subscription as `anon`, auth.uid() is NULL, and RLS
      // filters EVERY event server-side while the channel still reports
      // SUBSCRIBED. See lib/supabase/realtime-auth.ts (diagnosed live
      // 2026-07-02 via realtime.subscription.claims_role).
      cleanup.push(await ensureRealtimeAuth(supabase));
      if (cancelled) return;
      const channel = supabase.channel(`org:${organizationId}:inventory`);

      // Bust this org's cached default list view BEFORE refreshing, so the
      // RSC re-fetch can never read the ≤60s inventory-list cache entry.
      // Web writes already invalidate it server-side; this covers writes
      // that bypass this server entirely (mobile direct-to-Supabase, SQL)
      // — the change event reaches watching browsers either way, and the
      // watcher invalidates on the writer's behalf. If the action call
      // fails, refresh anyway: the TTL still bounds staleness at 60s.
      function refreshWithFreshCache() {
        void revalidateInventoryViewAction()
          .catch(() => {
            /* noop — TTL bounds staleness */
          })
          .finally(() => router.refresh());
      }

      function nudge() {
        const now = Date.now();
        const since = now - lastRefreshRef.current;
        if (since >= THROTTLE_MS) {
          lastRefreshRef.current = now;
          refreshWithFreshCache();
          return;
        }
        if (pendingRef.current) return;
        pendingRef.current = setTimeout(() => {
          pendingRef.current = null;
          lastRefreshRef.current = Date.now();
          refreshWithFreshCache();
        }, THROTTLE_MS - since);
      }

      for (const table of tables) {
        channel.on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table,
            filter: `organization_id=eq.${organizationId}`,
          },
          nudge,
        );
      }

      channel.subscribe();
      cleanup.push(() => {
        try {
          supabase.removeChannel(channel);
        } catch {
          /* noop */
        }
      });
    } catch (err) {
      console.warn('[realtime] subscription failed; falling back to manual refresh', err);
    }
    })();

    return () => {
      cancelled = true;
      if (pendingRef.current) {
        clearTimeout(pendingRef.current);
        pendingRef.current = null;
      }
      for (const fn of cleanup) fn();
    };
  }, [organizationId, router, tables, skip]);

  return null;
}

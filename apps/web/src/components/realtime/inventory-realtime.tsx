'use client';

import { useRouter } from 'next/navigation';
import * as React from 'react';

import { createClient } from '@/lib/supabase/client';

interface InventoryRealtimeProps {
  organizationId: string;
  /**
   * Which tables to listen to. The default is the dashboard-relevant set;
   * pages that only care about a subset can pass a narrower list to keep
   * subscriptions cheap.
   */
  tables?: Array<'inventory_items' | 'stock_movements' | 'purchase_orders'>;
}

/**
 * Subscribes to org-scoped postgres_changes on the requested tables and
 * triggers `router.refresh()` (debounced) so RSC pages re-fetch with
 * fresh data. The actual data fetching remains in server components —
 * this just nudges Next.js to re-run them.
 *
 * RLS applies to realtime subscriptions, so events for rows the user
 * can't read are filtered out by Postgres before they reach the client.
 */
export function InventoryRealtime({
  organizationId,
  tables = ['inventory_items', 'stock_movements', 'purchase_orders'],
}: InventoryRealtimeProps) {
  const router = useRouter();
  const refreshTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    // Wrap the entire realtime setup in try/catch. If a browser blocks
    // WebSockets (some Chrome enterprise policies, certain extensions,
    // restrictive networks), an exception thrown here would unmount the
    // dashboard shell and surface as a black screen — the live-update
    // feature isn't worth that. Worst case: stale-until-refresh, which
    // is exactly what we had before realtime existed.
    const cleanup: Array<() => void> = [];
    try {
      const supabase = createClient();
      const channel = supabase.channel(`org:${organizationId}:inventory`);

      function nudge() {
        if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
        // 750ms debounce: a burst of updates from a CSV import shouldn't
        // produce 100 router.refresh() calls; collapse to one.
        refreshTimerRef.current = setTimeout(() => {
          router.refresh();
        }, 750);
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

    return () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      for (const fn of cleanup) fn();
    };
  }, [organizationId, router, tables]);

  return null;
}

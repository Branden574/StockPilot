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

    return () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      supabase.removeChannel(channel);
    };
  }, [organizationId, router, tables]);

  return null;
}

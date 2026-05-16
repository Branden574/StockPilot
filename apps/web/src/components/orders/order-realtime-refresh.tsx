'use client';

import { useRouter } from 'next/navigation';
import * as React from 'react';

import { createClient } from '@/lib/supabase/client';

interface Props {
  orderId: string;
}

/**
 * Subscribes to postgres_changes on the single order_request row
 * driving the current detail page. Any UPDATE (status flip, picker
 * assignment, signature, etc.) triggers `router.refresh()` so the
 * server-rendered tree re-fetches with the new state.
 *
 * Why row-level filter instead of org-level: cheaper subscription
 * (one row touch instead of every org event) and avoids re-rendering
 * when an unrelated order changes. RLS applies on top, so even an
 * over-broad filter wouldn't leak — this is just an efficiency
 * choice.
 *
 * Failure mode: if the WebSocket can't open (network, browser block,
 * realtime publication missing), the component is silent — the page
 * stays at its initial render and the user falls back to manual
 * refresh. We never throw.
 */
export function OrderRealtimeRefresh({ orderId }: Props) {
  const router = useRouter();
  const supabaseRef = React.useRef<ReturnType<typeof createClient> | null>(null);
  if (supabaseRef.current === null) {
    try {
      supabaseRef.current = createClient();
    } catch {
      supabaseRef.current = null;
    }
  }

  // Throttle refresh: a single signature submit triggers multiple
  // column writes inside one transaction, which surfaces as one
  // UPDATE event from Postgres. But future flows (bulk reservations,
  // line picks) could fire many events in quick succession; keep a
  // 500ms leading-edge debounce so the RSC tree only re-fetches
  // once per burst.
  const lastRefreshRef = React.useRef(0);
  const pendingRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestRefresh = React.useCallback(() => {
    const now = Date.now();
    const since = now - lastRefreshRef.current;
    if (since >= 500) {
      lastRefreshRef.current = now;
      router.refresh();
      return;
    }
    if (pendingRef.current) return;
    pendingRef.current = setTimeout(() => {
      pendingRef.current = null;
      lastRefreshRef.current = Date.now();
      router.refresh();
    }, 500 - since);
  }, [router]);

  React.useEffect(() => {
    const supabase = supabaseRef.current;
    if (!supabase) return;
    let channel: ReturnType<typeof supabase.channel> | null = null;
    try {
      channel = supabase.channel(`order:${orderId}`);
      channel.on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'order_requests',
          filter: `id=eq.${orderId}`,
        },
        () => requestRefresh(),
      );
      channel.subscribe();
    } catch {
      /* realtime unavailable — manual refresh still works */
    }
    return () => {
      if (channel && supabase) {
        try {
          supabase.removeChannel(channel);
        } catch {
          /* noop */
        }
      }
      if (pendingRef.current) {
        clearTimeout(pendingRef.current);
        pendingRef.current = null;
      }
    };
  }, [orderId, requestRefresh]);

  return null;
}

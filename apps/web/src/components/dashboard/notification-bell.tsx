'use client';

import { Bell } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import * as React from 'react';

import { createClient } from '@/lib/supabase/client';

interface Props {
  userId: string;
  initialUnread: number;
}

/**
 * Notification bell with live unread badge.
 *
 *   • Reads initial unread count from a server-passed prop (the dashboard
 *     layout already issues that query, so the badge is correct on first
 *     paint with zero extra round trips).
 *   • Subscribes to postgres_changes on `notifications` filtered to this
 *     user's rows (RLS already enforces this; the filter is just to keep
 *     the channel cheap). Any INSERT / UPDATE / DELETE re-counts.
 *   • Re-counts when the user navigates onto / off of /dashboard/notifications
 *     so visiting the page (which marks rows read) clears the dot
 *     immediately, no realtime round-trip needed.
 *
 * Falls back to silent (no badge, no errors) if the WebSocket channel
 * can't open — a working bell is way more important than a live one.
 */
export function NotificationBell({ userId, initialUnread }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const [count, setCount] = React.useState(initialUnread);
  // Cache the supabase client so the cleanup path can call removeChannel
  // on the SAME instance that opened the subscription. Calling
  // createClient() again in cleanup creates a fresh socket and leaks
  // the original (see M4).
  const supabaseRef = React.useRef<ReturnType<typeof createClient> | null>(null);
  if (supabaseRef.current === null) {
    try {
      supabaseRef.current = createClient();
    } catch {
      supabaseRef.current = null;
    }
  }

  const refetch = React.useCallback(async () => {
    const supabase = supabaseRef.current;
    if (!supabase) return;
    try {
      const { count: c, error } = await supabase
        .from('notifications')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .is('read_at', null);
      if (error) return;
      setCount(c ?? 0);
    } catch {
      // ignore
    }
  }, [userId]);

  // Throttle router.refresh() to at most once every 500ms. Without this,
  // a burst of postgres_changes events (e.g. bulk-import fan-out, mark
  // all read) re-renders the entire RSC tree N times. setTimeout +
  // pending flag is enough — we want a leading-edge call AND a trailing
  // call to capture the final state. (I3, M6)
  const lastRefreshAtRef = React.useRef(0);
  const refreshPendingRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestRefresh = React.useCallback(() => {
    const now = Date.now();
    const since = now - lastRefreshAtRef.current;
    if (since >= 500) {
      lastRefreshAtRef.current = now;
      router.refresh();
      return;
    }
    if (refreshPendingRef.current) return;
    refreshPendingRef.current = setTimeout(() => {
      refreshPendingRef.current = null;
      lastRefreshAtRef.current = Date.now();
      router.refresh();
    }, 500 - since);
  }, [router]);

  // Realtime: any change to this user's notifications retriggers a
  // count fetch. Cheap (head-only count query) and self-correcting if
  // a write happens off-channel (e.g. from another browser tab).
  React.useEffect(() => {
    const supabase = supabaseRef.current;
    if (!supabase) return;
    let channel: ReturnType<typeof supabase.channel> | null = null;
    try {
      channel = supabase.channel(`user:${userId}:notifications`);
      channel.on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'notifications',
          filter: `user_id=eq.${userId}`,
        },
        () => {
          // Both the bell badge and any open `/dashboard/notifications`
          // page should reflect new data. The page is RSC, so nudging
          // the router refresh re-fetches its data; the badge updates
          // via refetch() directly.
          void refetch();
          requestRefresh();
        },
      );
      channel.subscribe();
    } catch {
      // realtime unavailable; badge stays at initial value until next nav
    }

    return () => {
      if (channel && supabase) {
        try {
          supabase.removeChannel(channel);
        } catch {
          /* noop */
        }
      }
      if (refreshPendingRef.current) {
        clearTimeout(refreshPendingRef.current);
        refreshPendingRef.current = null;
      }
    };
  }, [userId, refetch, requestRefresh]);

  // Re-count on path change so visiting /dashboard/notifications (which
  // calls markAllRead in the page server action) immediately clears
  // the badge instead of waiting on the realtime echo.
  React.useEffect(() => {
    void refetch();
  }, [pathname, refetch]);

  const showBadge = count > 0;
  const label = count > 99 ? '99+' : String(count);

  return (
    <Link
      href="/dashboard/notifications"
      className="hover:bg-muted hover:text-foreground relative grid h-[30px] w-[30px] place-items-center rounded-md text-[var(--ed-ink-3)] transition-colors"
      aria-label={
        showBadge
          ? `Notifications (${count} unread)`
          : 'Notifications'
      }
    >
      <Bell className="h-3.5 w-3.5" />
      {showBadge && (
        <span
          aria-hidden
          className="outline-background bg-destructive text-destructive-foreground absolute -right-0.5 -top-0.5 grid min-h-[14px] min-w-[14px] place-items-center rounded-full px-1 text-[9.5px] font-bold leading-none outline outline-[1.5px]"
        >
          {label}
        </span>
      )}
    </Link>
  );
}

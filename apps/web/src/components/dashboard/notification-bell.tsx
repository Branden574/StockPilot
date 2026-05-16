'use client';

import { Bell } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import * as React from 'react';

import { queueLiveNotification } from '@/lib/notifications/live-toast';
import { createClient } from '@/lib/supabase/client';

interface Props {
  userId: string;
  initialUnread: number;
}

/**
 * Notification bell with live unread badge.
 *
 * Surface strategy is BELT-AND-SUSPENDERS:
 *   1. postgres_changes channel — fastest path; pops the toast within
 *      ~100ms of the row landing in Postgres.
 *   2. Refetch-driven catch-up — every refetch (route change, focus,
 *      visibility flip back to visible, channel subscribed/reconnect)
 *      pulls the latest unread rows and queues any we haven't seen
 *      before. This is the safety net: even if the realtime channel
 *      is silent (RLS-filtered, ICE/firewall, throttled mobile WS),
 *      the toast still fires the next time the bell refetches.
 *
 * `seenIds` dedupes across both paths so a row that arrives via
 * realtime AND refetch only pops once. It's a per-mount Set; closing
 * and reopening the dashboard tab resets it, which is fine — the user
 * has already seen those toasts.
 */
export function NotificationBell({ userId, initialUnread }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const [count, setCount] = React.useState(initialUnread);
  const supabaseRef = React.useRef<ReturnType<typeof createClient> | null>(null);
  if (supabaseRef.current === null) {
    try {
      supabaseRef.current = createClient();
    } catch {
      supabaseRef.current = null;
    }
  }

  // IDs we've already toasted this session. Survives across realtime
  // and refetch paths so the same row never pops twice.
  const seenIdsRef = React.useRef<Set<string>>(new Set());
  // Track the initial unread so the first session-mount refetch doesn't
  // re-pop everything that was already unread when the tab opened —
  // those are already "old news" the user opens the bell to see.
  const initializedRef = React.useRef(false);

  const navigate = React.useCallback(
    (link: string) => {
      router.push(link);
    },
    [router],
  );

  // Fetch the latest unread rows and pop a toast for each row id we
  // haven't seen yet this mount. Cheap when there's nothing new (the
  // ORDER + LIMIT 20 puts the active set in one page).
  const surfaceUnread = React.useCallback(async () => {
    const supabase = supabaseRef.current;
    if (!supabase) return;
    try {
      const { data, error } = await supabase
        .from('notifications')
        .select('id, type, title, body, link, created_at')
        .eq('user_id', userId)
        .is('read_at', null)
        .order('created_at', { ascending: false })
        .limit(20);
      if (error || !data) return;
      // Update the badge from the actual unread set instead of a
      // separate count() query — saves a round trip and keeps the
      // two values in lockstep.
      setCount(data.length);

      // On the first mount, just seed seenIds with everything that's
      // already unread. The user came to the dashboard expecting the
      // badge to mean "old work waiting" — popping a stack of toasts
      // for rows that landed hours ago is noise, not signal.
      if (!initializedRef.current) {
        initializedRef.current = true;
        for (const row of data) {
          seenIdsRef.current.add(row.id as string);
        }
        return;
      }

      // Toast newest-first so the most recent surfaces last (sonner
      // stacks bottom-up, so the latest event ends up on top of the
      // stack).
      const fresh = (data as Array<{
        id: string;
        type: string | null;
        title: string | null;
        body: string | null;
        link: string | null;
      }>).filter((row) => !seenIdsRef.current.has(row.id) && row.title);
      // newest in data[0], so iterate oldest→newest for stack order
      for (const row of fresh.slice().reverse()) {
        seenIdsRef.current.add(row.id);
        queueLiveNotification(
          {
            id: row.id,
            type: row.type ?? 'unknown',
            title: row.title ?? 'New notification',
            body: row.body ?? null,
            link: row.link ?? null,
          },
          navigate,
        );
      }
    } catch {
      /* ignore — realtime path may still cover it */
    }
  }, [userId, navigate]);

  // Throttle to at most once every 500ms so a burst of postgres_changes
  // events doesn't run surfaceUnread 50 times. Leading-edge + trailing
  // call: the first event fires immediately, follow-ups within 500ms
  // schedule a single trailing run.
  const lastRefreshAtRef = React.useRef(0);
  const refreshPendingRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestRefresh = React.useCallback(() => {
    const now = Date.now();
    const since = now - lastRefreshAtRef.current;
    if (since >= 500) {
      lastRefreshAtRef.current = now;
      void surfaceUnread();
      router.refresh();
      return;
    }
    if (refreshPendingRef.current) return;
    refreshPendingRef.current = setTimeout(() => {
      refreshPendingRef.current = null;
      lastRefreshAtRef.current = Date.now();
      void surfaceUnread();
      router.refresh();
    }, 500 - since);
  }, [router, surfaceUnread]);

  // Realtime path. Each event triggers a surfaceUnread() — the function
  // dedups via seenIds so it's safe to call on every event without
  // double-toasting.
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
          requestRefresh();
        },
      );
      // Capture subscribe status. On CHANNEL_ERROR or TIMED_OUT, the
      // refetch path still works — we deliberately don't surface the
      // failure to the user because a working bell is more important
      // than a "realtime broken" message.
      channel.subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          // Initial seed: this also marks already-unread rows as seen
          // so we don't pop stale toasts on page load.
          void surfaceUnread();
        }
      });
    } catch {
      // realtime client construction failed — fall back to refetch on
      // path change / focus, both wired below.
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
  }, [userId, requestRefresh, surfaceUnread]);

  // Path change → catch up. Visiting /dashboard/notifications marks
  // rows read; surfaceUnread() will return an empty set, count drops
  // to 0, no toasts. Visiting any other page after the bell has been
  // open: surfaces anything that landed while we weren't looking.
  React.useEffect(() => {
    void surfaceUnread();
  }, [pathname, surfaceUnread]);

  // Visibility / focus → catch up when the tab comes back. Mobile
  // Safari aggressively throttles WebSockets in backgrounded tabs;
  // this is the path that picks up rows missed during throttle.
  React.useEffect(() => {
    if (typeof document === 'undefined') return;
    const onVisible = () => {
      if (document.visibilityState === 'visible') void surfaceUnread();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [surfaceUnread]);

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

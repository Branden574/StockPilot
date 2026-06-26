'use client';

import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { createClient } from '@/lib/supabase/client';

interface Props {
  organizationId: string;
  userId: string;
  /** The viewer's role token — used to ignore role-override events for OTHER roles. */
  role: string;
}

/**
 * Subscribes to the permission-override tables (mig 0207, published for realtime
 * by 0209) and refreshes the dashboard the instant an admin changes this user's
 * access — so a revoked link disappears / a granted section appears without a
 * manual refresh. Mirrors OrderRealtimeRefresh.
 *
 * Relevance filter: a `role_permission_overrides` change matters only if it
 * targets THIS user's role; a `user_permission_overrides` change only if it
 * targets THIS user. RLS already scopes delivery to the user's org (and own
 * rows for the user table), so this client-side check is just to avoid
 * refreshing on an unrelated role's change.
 *
 * On a relevant change → debounced router.refresh() (re-runs requireOrgContext
 * → fresh ctx.permissions → nav re-gates + section layouts re-evaluate) + a
 * toast. Fail-silent: if the socket can't open, the user falls back to
 * refresh-on-navigate. Never throws.
 */
export function PermissionsRealtime({ organizationId, userId, role }: Props) {
  const router = useRouter();
  const supabaseRef = React.useRef<ReturnType<typeof createClient> | null>(null);
  if (supabaseRef.current === null) {
    try {
      supabaseRef.current = createClient();
    } catch {
      // eslint-disable-next-line react-hooks/refs -- ref init, not setState
      supabaseRef.current = null;
    }
  }

  // Leading-edge debounce: one matrix toggle writes a single row but a burst
  // (e.g. several quick toggles, or an upsert that fans out) should refresh
  // once, not once per event.
  const lastRefreshRef = React.useRef(0);
  const pendingRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const announce = React.useCallback(() => {
    const now = Date.now();
    const fire = () => {
      lastRefreshRef.current = Date.now();
      toast.message('Your access was updated', {
        description: 'Your permissions changed — refreshing.',
      });
      router.refresh();
    };
    const since = now - lastRefreshRef.current;
    if (since >= 800) {
      fire();
      return;
    }
    if (pendingRef.current) return;
    pendingRef.current = setTimeout(() => {
      pendingRef.current = null;
      fire();
    }, 800 - since);
  }, [router]);

  React.useEffect(() => {
    const supabase = supabaseRef.current;
    if (!supabase) return;
    let channel: ReturnType<typeof supabase.channel> | null = null;
    try {
      channel = supabase.channel(`perms:${organizationId}:${userId}`);
      // Role-level overrides for this org — react only when the row's role
      // matches ours. (postgres_changes filters on a single column, so we
      // filter by org and check role in the handler.)
      channel.on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'role_permission_overrides',
          filter: `organization_id=eq.${organizationId}`,
        },
        (payload) => {
          const row = (payload.new ?? payload.old) as { role?: string } | null;
          if (!row || row.role === role) announce();
        },
      );
      // User-level overrides targeting THIS user (RLS already restricts to own
      // rows for non-admins; the filter keeps an admin from refreshing on every
      // other user's change).
      channel.on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'user_permission_overrides',
          filter: `user_id=eq.${userId}`,
        },
        () => announce(),
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
  }, [organizationId, userId, role, announce]);

  return null;
}

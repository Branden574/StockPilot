'use client';

import { PERMISSION_META, type Permission } from '@stockpilot/core';
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

export interface PermissionToast {
  title: string;
  description: string;
}

/**
 * Builds the live toast for a permission-change ping. When the broadcast names
 * the exact permission (+ granted flag), the toast says which one and how it
 * moved; without them (older pings, or a payload we don't recognize) it falls
 * back to the generic message. `granted`: true = granted, false = revoked,
 * null = the override was cleared (reset to the role default). Exported for
 * unit tests.
 */
export function permissionChangeMessage(
  permission?: string,
  granted?: boolean | null,
): PermissionToast {
  const label = permission
    ? PERMISSION_META[permission as Permission]?.label
    : undefined;
  if (!label) {
    return { title: 'Your access was updated', description: 'Your permissions changed — refreshing.' };
  }
  if (granted === true) {
    return { title: 'Access granted', description: `You were granted "${label}" — refreshing.` };
  }
  if (granted === false) {
    return { title: 'Access updated', description: `"${label}" was revoked — refreshing.` };
  }
  // granted === null → the per-user/role override row was removed
  return { title: 'Access updated', description: `"${label}" was reset to your role default — refreshing.` };
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
  // Latest-wins message across a debounced burst: several quick toggles collapse
  // to one refresh, and the toast names the most recent change.
  const pendingMsgRef = React.useRef<PermissionToast | null>(null);
  const announce = React.useCallback(
    (msg: PermissionToast) => {
      pendingMsgRef.current = msg;
      const now = Date.now();
      const fire = () => {
        lastRefreshRef.current = Date.now();
        const m = pendingMsgRef.current ?? msg;
        pendingMsgRef.current = null;
        toast.message(m.title, { description: m.description });
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
    },
    [router],
  );

  React.useEffect(() => {
    const supabase = supabaseRef.current;
    if (!supabase) return;
    let channel: ReturnType<typeof supabase.channel> | null = null;
    try {
      // Broadcast (not postgres_changes): the server pings `perms:{org}` on
      // every override write. Reliable pub/sub — no RLS/replica-identity/token
      // fragility. React only when the ping targets this user's role or them.
      channel = supabase.channel(`perms:${organizationId}`);
      channel.on('broadcast', { event: 'changed' }, ({ payload }) => {
        const p = (payload ?? {}) as {
          role?: string;
          userId?: string;
          permission?: string;
          granted?: boolean | null;
        };
        if (p.userId === userId || (!!p.role && p.role === role)) {
          announce(permissionChangeMessage(p.permission, p.granted));
        }
      });
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

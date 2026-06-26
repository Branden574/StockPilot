import * as React from 'react';

import { supabase } from './supabase';
import { fetchEffectivePermissions } from './use-effective-permissions';

/**
 * Subscribes to the permission-override tables (web mig 0207, published for
 * realtime by 0209) so the drawer updates the instant an admin changes this
 * user's access — no app restart or manual sync. Mirrors the web
 * PermissionsRealtime component.
 *
 * On a relevant change (a role_permission_overrides row for THIS user's role,
 * or a user_permission_overrides row for THIS user) it does a light
 * fetchEffectivePermissions() → persists the new set → notifies
 * useEffectivePermissions() subscribers → the drawer re-renders with links
 * added/removed. (No visible toast: mobile has no toast lib; the live nav
 * update is the feedback. RLS already scopes which events this client receives,
 * so the org/user filters are just to avoid refreshing on an unrelated change.)
 *
 * Fail-silent: if the socket can't open, the user falls back to the next
 * snapshot sync (60s/foreground). Never throws.
 */
export function usePermissionsRealtime(params: {
  organizationId: string | null;
  userId: string | null;
  role: string | null;
}): void {
  const { organizationId, userId, role } = params;

  React.useEffect(() => {
    if (!organizationId || !userId) return;
    let channel: ReturnType<typeof supabase.channel> | null = null;
    try {
      channel = supabase.channel(`perms:${organizationId}:${userId}`);
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
          if (!row || !role || row.role === role) void fetchEffectivePermissions();
        },
      );
      channel.on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'user_permission_overrides',
          filter: `user_id=eq.${userId}`,
        },
        () => void fetchEffectivePermissions(),
      );
      channel.subscribe();
    } catch {
      /* realtime unavailable — snapshot sync still refreshes permissions */
    }

    return () => {
      if (channel) {
        try {
          void supabase.removeChannel(channel);
        } catch {
          /* noop */
        }
      }
    };
  }, [organizationId, userId, role]);
}

import { type Role, isAdminRole } from '@stockpilot/core';
import * as React from 'react';

import { useAuth } from './auth-context';
import {
  cachedRoleFor,
  clearRoleCache,
  readRoleOnce,
  roleNeedsRead,
  roleShownFor,
  subscribeRole,
  type HeldRole,
  type RoleReadResult,
} from './role-cache';
import { useOrg } from './use-org';
import { supabase } from './supabase';

/** One read of the member's role in this org. Never throws. */
async function readRole(userId: string, orgId: string): Promise<RoleReadResult> {
  const { data, error } = await supabase
    .from('organization_members')
    .select('role')
    .eq('user_id', userId)
    .eq('organization_id', orgId)
    .maybeSingle();
  if (error) return { ok: false };
  return { ok: true, role: (data?.role as Role | undefined) ?? null };
}

/**
 * Resolves the current user's role in their primary org.
 *
 * Served from a shared cache (role-cache.ts) so the drawer and the screens
 * that gate by role don't each re-query, but NOT kept forever: a role older
 * than ROLE_REVALIDATE_MS is re-read in the background when a screen mounts,
 * every mounted hook re-renders when it changes (screens whose reads depend on
 * the role re-run them), and signing out clears it. A demoted manager's phone
 * used to keep 'manager' until the app was killed, which skipped the
 * stock-in-other-warehouses reads (0371) and showed their own warehouses'
 * holdings as the whole.
 */
export function useRole(): { role: Role | null; isAdmin: boolean; loading: boolean } {
  const { user } = useAuth();
  const { orgId } = useOrg();
  const userId = user?.id ?? null;
  // The role held, WITH the member and workspace it was read for: what this
  // returns is worked out from it and the identity on screen
  // (roleShownFor), so a role read for the previous workspace is never
  // answered for the next one, not even for the render before the effect
  // below runs again.
  const [held, setHeld] = React.useState<HeldRole | null>(() => {
    if (!userId || !orgId) return null;
    const cached = cachedRoleFor(userId, orgId);
    return { userId, orgId, role: cached, loading: cached === null };
  });

  React.useEffect(() => {
    if (!userId) {
      // Signed out: nothing about the last session's role survives it.
      clearRoleCache();
    }
    if (!userId || !orgId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- identity sync: clears on identity loss; every other set below is either the shared cache's current value on a (re)subscribe or post-await.
      setHeld(null);
      return;
    }
    let cancelled = false;
    const hold = (role: Role | null) => setHeld({ userId, orgId, role, loading: false });
    const cached = cachedRoleFor(userId, orgId);
    if (cached) hold(cached);
    // Every hook follows the shared cache, so one screen's re-read updates
    // them all.
    const unsubscribe = subscribeRole(() => {
      if (cancelled) return;
      hold(cachedRoleFor(userId, orgId));
    });
    if (roleNeedsRead(userId, orgId)) {
      void readRoleOnce(userId, orgId, () => readRole(userId, orgId)).then((res) => {
        if (cancelled) return;
        // A failed read keeps whatever was known for this member and
        // workspace; with nothing known, the role is unknown (null).
        hold(res.ok ? res.role : cachedRoleFor(userId, orgId));
      });
    }
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [userId, orgId]);

  const shown = roleShownFor(held, userId, orgId);
  return {
    role: shown.role,
    isAdmin: shown.role ? isAdminRole(shown.role) : false,
    loading: shown.loading,
  };
}

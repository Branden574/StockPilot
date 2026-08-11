import { type Role, isAdminRole } from '@stockpilot/core';
import * as React from 'react';

import { useAuth } from './auth-context';
import { useOrg } from './use-org';
import { supabase } from './supabase';

let cachedRole: { userId: string; orgId: string; role: Role } | null = null;

/**
 * Resolves the current user's role in their primary org. Cached for
 * the session so the drawer + screens that gate by role don't each
 * re-query.
 */
export function useRole(): { role: Role | null; isAdmin: boolean; loading: boolean } {
  const { user } = useAuth();
  const { orgId } = useOrg();
  const [role, setRole] = React.useState<Role | null>(() => {
    if (user && orgId && cachedRole && cachedRole.userId === user.id && cachedRole.orgId === orgId) {
      return cachedRole.role;
    }
    return null;
  });
  const [loading, setLoading] = React.useState(role === null);

  React.useEffect(() => {
    if (!user || !orgId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- session-cache sync: the sync sets clear on identity loss and serve the module-level role cache on a workspace switch; the fetch set is post-await. The cached value cannot be derived at render without dropping the "fetch once per session" contract.
      setRole(null);
      setLoading(false);
      return;
    }
    if (cachedRole && cachedRole.userId === user.id && cachedRole.orgId === orgId) {
      setRole(cachedRole.role);
      setLoading(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      const { data } = await supabase
        .from('organization_members')
        .select('role')
        .eq('user_id', user.id)
        .eq('organization_id', orgId)
        .maybeSingle();
      if (cancelled) return;
      const r = (data?.role as Role | undefined) ?? null;
      if (r) cachedRole = { userId: user.id, orgId, role: r };
      setRole(r);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [user, orgId]);

  return { role, isAdmin: role ? isAdminRole(role) : false, loading };
}

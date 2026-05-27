import * as React from 'react';

import { useAuth } from './auth-context';
import { supabase } from './supabase';

interface OrgState {
  orgId: string | null;
  orgName: string | null;
  loading: boolean;
}

let cachedOrg: { userId: string; orgId: string; orgName: string } | null = null;

/**
 * Resolves the current user's primary accepted org membership. Cached
 * for the duration of the app session (keyed by user id), so the
 * many list screens that need an org id don't each round-trip Supabase
 * on mount.
 */
export function useOrg(): OrgState {
  const { user } = useAuth();
  const [state, setState] = React.useState<OrgState>(() =>
    user && cachedOrg && cachedOrg.userId === user.id
      ? { orgId: cachedOrg.orgId, orgName: cachedOrg.orgName, loading: false }
      : { orgId: null, orgName: null, loading: true },
  );

  React.useEffect(() => {
    if (!user) {
      setState({ orgId: null, orgName: null, loading: false });
      return;
    }
    if (cachedOrg && cachedOrg.userId === user.id) {
      setState({ orgId: cachedOrg.orgId, orgName: cachedOrg.orgName, loading: false });
      return;
    }
    let cancelled = false;
    void (async () => {
      const { data } = await supabase
        .from('organization_members')
        .select('organization_id, organizations:organization_id (name)')
        .eq('user_id', user.id)
        .not('accepted_at', 'is', null)
        .limit(1)
        .maybeSingle();
      if (cancelled) return;
      if (!data) {
        setState({ orgId: null, orgName: null, loading: false });
        return;
      }
      const orgId = data.organization_id as string;
      const orgRow = (data as { organizations?: unknown }).organizations;
      const orgObj = Array.isArray(orgRow) ? orgRow[0] : orgRow;
      const orgName = (orgObj as { name?: string } | null)?.name ?? 'Workspace';
      cachedOrg = { userId: user.id, orgId, orgName };
      setState({ orgId, orgName, loading: false });
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  return state;
}

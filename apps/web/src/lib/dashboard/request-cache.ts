import 'server-only';

import { cache } from 'react';

import { createClient } from '@/lib/supabase/server';

/**
 * Request-scoped React.cache() wrappers for data the dashboard layout AND
 * the dashboard page both need in the same render. Without these, the
 * layout fetches `organizations` (terminology + mfa_policy + logo_url +
 * timezone) and the page re-fetches `organizations.timezone` separately —
 * two PostgREST round-trips for the same row, every dashboard render.
 *
 * React's `cache()` is per-request, so two callers in the same render
 * share one result. Cross-render caching is unaffected (each new request
 * still re-fetches), so this is safe for user-personalized data.
 *
 * Pattern intentionally avoids `unstable_cache` — the previous attempt
 * at that layer was rolled back because Server Action POST responses
 * triggered a digest-only 500 under Next.js 16. Sticking with React
 * cache() until that's understood.
 */

export interface OrgRow {
  terminology: unknown;
  mfa_policy: 'optional' | 'admins_required' | 'all_required' | null;
  logo_url: string | null;
  timezone: string | null;
}

export const getOrgRowForRequest = cache(
  async (organizationId: string): Promise<OrgRow | null> => {
    const supabase = await createClient();
    const { data } = await supabase
      .from('organizations')
      .select('terminology, mfa_policy, logo_url, timezone')
      .eq('id', organizationId)
      .maybeSingle();
    return (data as OrgRow | null) ?? null;
  },
);

export interface DashboardWarehouse {
  id: string;
  name: string;
}

export const getWarehousesForRequest = cache(
  async (organizationId: string): Promise<DashboardWarehouse[]> => {
    const supabase = await createClient();
    const { data } = await supabase
      .from('warehouses')
      .select('id, name')
      .eq('organization_id', organizationId)
      .neq('status', 'archived')
      .order('name', { ascending: true });
    return (data ?? []) as DashboardWarehouse[];
  },
);

export interface MfaFactor {
  status: string;
}

export const getMfaFactorsForRequest = cache(async (): Promise<MfaFactor[]> => {
  const supabase = await createClient();
  const res = await supabase.auth.mfa.listFactors();
  return (res.data?.all ?? []) as MfaFactor[];
});

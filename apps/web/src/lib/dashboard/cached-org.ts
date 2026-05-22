import 'server-only';

import { unstable_cache } from 'next/cache';

import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Cached lookups for org-level data the (dashboard) layout reads on
 * every navigation. Previously every nav re-queried `organizations`
 * + `warehouses` even though the columns we read change ~never.
 *
 * Cache keys include the organizationId so each tenant has its own
 * entry. Tags are static (per-cache, not per-org) — invalidating
 * `dashboard-org` busts every org's row cache, which is fine: org
 * settings change rarely and the cost of refreshing a few sibling
 * orgs is negligible.
 *
 * NOTE: previous version of this file created the `unstable_cache`
 * wrapper INSIDE the exported function (the `unstable_cache(...)()`
 * IIFE pattern). That worked during normal page navs but broke
 * Server Action POSTs in Next.js 16 with a digest-only 500 ("error
 * in Server Components render") — Next's runtime doesn't allow
 * dynamic cache-wrapper creation inside action-response render
 * cycles. The fix is to declare the wrapper ONCE at module load.
 */
const fetchOrgRow = unstable_cache(
  async (organizationId: string) => {
    const supabase = createAdminClient();
    const { data, error } = await supabase
      .from('organizations')
      .select('terminology, mfa_policy, logo_url, timezone')
      .eq('id', organizationId)
      .maybeSingle();
    if (error) return null;
    return data as {
      terminology: unknown;
      mfa_policy: 'optional' | 'admins_required' | 'all_required' | null;
      logo_url: string | null;
      timezone: string | null;
    } | null;
  },
  ['dashboard-org-row'],
  {
    revalidate: 60,
    tags: ['dashboard-org'],
  },
);

export function getCachedOrgDashboardRow(organizationId: string) {
  return fetchOrgRow(organizationId);
}

const fetchOrgWarehouses = unstable_cache(
  async (organizationId: string) => {
    const supabase = createAdminClient();
    const { data } = await supabase
      .from('warehouses')
      .select('id, name')
      .eq('organization_id', organizationId)
      .neq('status', 'archived')
      .order('name', { ascending: true });
    return (data ?? []) as Array<{ id: string; name: string }>;
  },
  ['dashboard-org-warehouses'],
  {
    revalidate: 300,
    tags: ['dashboard-org', 'dashboard-warehouses'],
  },
);

export function getCachedOrgWarehouses(organizationId: string) {
  return fetchOrgWarehouses(organizationId);
}

/**
 * Resolve the org's IANA timezone string, falling back to UTC when
 * nothing is set. Goes through the cached org-row fetch so it pays
 * no extra DB cost.
 */
export async function getCachedOrgTimezone(organizationId: string): Promise<string> {
  const row = await getCachedOrgDashboardRow(organizationId);
  return row?.timezone || 'UTC';
}

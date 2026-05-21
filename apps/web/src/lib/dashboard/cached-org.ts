import 'server-only';

import { unstable_cache } from 'next/cache';

import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Cached lookup of the org-level dashboard layout data.
 *
 * The (dashboard) layout was re-querying `organizations` on EVERY
 * page navigation for three fields (terminology, mfa_policy,
 * logo_url) that change ~never. Pulling them through unstable_cache
 * eliminates one Postgres round trip from every dashboard
 * nav — measured at 60-120ms cold, 30-50ms warm.
 *
 * Cache key is the org ID. Tagged so the org settings page can
 * `revalidateTag('dashboard-org:<id>')` after an admin edits
 * terminology, MFA policy, or logo.
 *
 * Why service-role: this query reads three benign columns the
 * authenticated user is allowed to see anyway (they're rendered
 * into the dashboard shell for them on every page). Using service-
 * role here just bypasses the per-request RLS planning cost — the
 * data returned is the same.
 */
async function fetchOrgDashboardRowImpl(organizationId: string) {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('organizations')
    .select('terminology, mfa_policy, logo_url')
    .eq('id', organizationId)
    .maybeSingle();
  if (error) {
    // Don't throw — the layout's downstream code falls back to
    // sensible defaults for each field. A failed cache lookup
    // shouldn't break the dashboard.
    return null;
  }
  return data as {
    terminology: unknown;
    mfa_policy: 'optional' | 'admins_required' | 'all_required' | null;
    logo_url: string | null;
  } | null;
}

export const getCachedOrgDashboardRow = (organizationId: string) =>
  unstable_cache(
    () => fetchOrgDashboardRowImpl(organizationId),
    ['dashboard-org-row', organizationId],
    {
      // 60s is a good balance: covers a normal session's worth of
      // navigations, but a change to org settings is reflected
      // quickly without needing a manual invalidate. We still tag
      // it so org-settings writes can revalidate immediately.
      revalidate: 60,
      tags: [`dashboard-org:${organizationId}`],
    },
  )();

/**
 * Cached list of the org's non-archived warehouses (id + name only).
 * Used by the topbar's warehouse-filter dropdown — was previously
 * blocking the layout render on every nav, even though the list
 * changes maybe once a year.
 *
 * Per-org cache key, 5-minute TTL, tagged for explicit invalidation
 * from the warehouse-admin pages.
 */
async function fetchOrgWarehousesImpl(organizationId: string) {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from('warehouses')
    .select('id, name')
    .eq('organization_id', organizationId)
    .neq('status', 'archived')
    .order('name', { ascending: true });
  return (data ?? []) as Array<{ id: string; name: string }>;
}

export const getCachedOrgWarehouses = (organizationId: string) =>
  unstable_cache(
    () => fetchOrgWarehousesImpl(organizationId),
    ['dashboard-org-warehouses', organizationId],
    {
      revalidate: 300,
      tags: [`dashboard-org:${organizationId}`, `dashboard-warehouses:${organizationId}`],
    },
  )();

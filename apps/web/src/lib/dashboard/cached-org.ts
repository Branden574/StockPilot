import 'server-only';

import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Org-level lookups for the (dashboard) layout + PDF routes.
 *
 * NOTE on caching: this file previously wrapped these queries in
 * `unstable_cache(...)`, but that triggered digest-only 500s in the
 * Server Action POST response render under Next.js 16 (chased through
 * commits 91806fe / 9ae5251). Until we land a confirmed-safe caching
 * pattern, these are direct queries. The DB hit is small (single row
 * by primary key) and the layout's other 4 parallel queries dominate
 * the layout's latency anyway.
 *
 * Function names kept intentionally so call sites don't need to
 * change — only the implementation differs.
 */
export async function getCachedOrgDashboardRow(organizationId: string) {
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
}

export async function getCachedOrgWarehouses(organizationId: string) {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from('warehouses')
    .select('id, name')
    .eq('organization_id', organizationId)
    .neq('status', 'archived')
    .order('name', { ascending: true });
  return (data ?? []) as Array<{ id: string; name: string }>;
}

export async function getCachedOrgTimezone(organizationId: string): Promise<string> {
  const row = await getCachedOrgDashboardRow(organizationId);
  return row?.timezone || 'UTC';
}

import 'server-only';

import { cache } from 'react';

import { createClient } from '@/lib/supabase/server';

import { MODULE_REGISTRY, type ModuleId } from '@stockpilot/core';

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
  /**
   * Per-org sidebar customization (NavOverrides v1) + dashboard widget layout
   * (DashboardLayout v1), added by migration 0158. Typed `unknown` here so the
   * pure `@stockpilot/core` apply functions remain the single source of truth
   * for validation — both fail CLOSED on null/garbage. Reading these off the
   * already-cached org row costs zero extra round-trips (preserves load-perf).
   */
  nav_overrides: unknown;
  dashboard_layout: unknown;
  /**
   * Per-org SOFT order status presentation override (label/color/sortOrder per
   * status key), added by migration 0160. Typed `unknown` so the pure
   * `resolveOrderStatusConfig` in @stockpilot/core stays the single validator
   * (fails CLOSED to canonical defaults on null/garbage). Read off the cached
   * org row → zero extra round-trips (preserves load-perf).
   */
  order_status_config: unknown;
  /**
   * Platform-admin "Comped — all modules" flag (migration 0175). When true,
   * the entitlement layer treats every non-core module as enabled for this org
   * (used with a Comped Enterprise arrangement). Read off the cached org row →
   * zero extra round-trips.
   */
  all_modules_comp?: boolean | null;
}

export const getOrgRowForRequest = cache(
  async (organizationId: string): Promise<OrgRow | null> => {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from('organizations')
      .select(
        'terminology, mfa_policy, logo_url, timezone, nav_overrides, dashboard_layout, order_status_config, all_modules_comp',
      )
      .eq('id', organizationId)
      .maybeSingle();
    // FAIL CLOSED: this row feeds the MFA-policy gate (mfa_policy). Swallowing a
    // transient read error and returning null would resolve the policy to
    // 'optional' → silently disable MFA for the request. Throw so the gate
    // fails closed; a genuine missing row still returns null (no error).
    if (error) throw new Error(`getOrgRowForRequest: ${error.message}`);
    return (data as OrgRow | null) ?? null;
  },
);

/** Every non-core module id — the set a Comped org gets when all_modules_comp is on. */
const NON_CORE_MODULE_IDS: ModuleId[] = (Object.values(MODULE_REGISTRY) as Array<{ id: ModuleId; tier: string }>)
  .filter((m) => m.tier !== 'core')
  .map((m) => m.id);

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

/**
 * Enabled `organization_modules` for the org, as a Set of module ids.
 * Request-cached so the dashboard layout AND `withContext()` (in
 * `server/services/context.ts`) share ONE `organization_modules` round-trip
 * per render instead of each issuing its own identical query.
 *
 * Fail behaviour matches both prior call sites: on a query error this
 * returns an EMPTY set (logged). Callers treat an empty set as "core-only"
 * — `assertModuleEnabled` still lets core modules through via the registry,
 * while optional/premium modules are denied. So an error fails CLOSED for
 * optional modules and never widens entitlements. NOTE: this helper does NOT
 * throw; a thrown error from the underlying client would propagate to the
 * caller exactly as the inline query would have (it never threw before, and
 * the Supabase client surfaces failures as `{ error }`, not exceptions).
 */
export const getModulesForRequest = cache(
  async (organizationId: string): Promise<Set<ModuleId>> => {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from('organization_modules')
      .select('module_id')
      .eq('organization_id', organizationId)
      .eq('enabled', true);
    if (error) {
      console.error('[getModulesForRequest] organization_modules query failed:', error);
    }
    const enabled = new Set(
      ((data ?? []) as Array<{ module_id: string }>).map((r) => r.module_id as ModuleId),
    );

    // Comped "all modules" override: a platform admin granting full access
    // flips on every non-core module. getOrgRowForRequest is request-cached, so
    // this adds zero round-trips. Fails CLOSED — a null/false flag adds nothing.
    const org = await getOrgRowForRequest(organizationId);
    if (org?.all_modules_comp) {
      for (const id of NON_CORE_MODULE_IDS) enabled.add(id);
    }
    return enabled;
  },
);

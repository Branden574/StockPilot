import 'server-only';

import { cache } from 'react';

import {
  bundleMembership,
  loadRequestContextBundle,
  modulesFromMembership,
  orgRowFromMembership,
} from '@/lib/auth/request-context-bundle';
import { effectiveModules } from '@/lib/modules/effective-modules';
import { createClient } from '@/lib/supabase/server';

import { type ModuleId } from '@stockpilot/core';

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

export const getOrgRowForRequest = cache(async (organizationId: string): Promise<OrgRow | null> => {
  // Already in hand when `get_request_context()` answered for this request
  // (migration 0355): the same columns, read under the same RLS, in the round
  // trip that resolved the membership. Anything else (no bundle, not a
  // member, row hidden) takes the read below, errors and all.
  const fromBundle = orgRowFromMembership(
    bundleMembership(await loadRequestContextBundle(), organizationId),
  );
  if (fromBundle) return fromBundle;
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
});

export interface DashboardWarehouse {
  id: string;
  name: string;
}

/**
 * The org's non-archived warehouses AND whether the read succeeded.
 *
 * getWarehouseAccess (lib/auth/warehouse.ts) shares this read with the
 * dashboard layout, and it must be able to tell "the org has no warehouses"
 * from "the read failed": supabase-js RESOLVES a failed query as `{ data:
 * null, error }`, which the list-only helper below turns into `[]`. That is fine
 * for a picker and wrong for an access answer, so the outcome travels with
 * the rows here. One cached read serves both helpers.
 */
export interface WarehousesRead {
  rows: DashboardWarehouse[];
  failed: boolean;
}

export const readWarehousesForRequest = cache(
  async (organizationId: string): Promise<WarehousesRead> => {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from('warehouses')
      .select('id, name')
      .eq('organization_id', organizationId)
      .neq('status', 'archived')
      .order('name', { ascending: true });
    if (error) {
      console.error('[readWarehousesForRequest] warehouses query failed:', error.message);
      return { rows: [], failed: true };
    }
    return { rows: (data ?? []) as DashboardWarehouse[], failed: false };
  },
);

/**
 * The warehouse list for pickers and switchers: `[]` when the read failed,
 * exactly as before. Anything that DECIDES access from this list reads
 * readWarehousesForRequest instead, so a failure cannot pass for an answer.
 */
export const getWarehousesForRequest = cache(
  async (organizationId: string): Promise<DashboardWarehouse[]> =>
    (await readWarehousesForRequest(organizationId)).rows,
);

export interface MfaFactor {
  status: string;
}

/**
 * The signed-in user's MFA factors. THROWS when they cannot be read.
 *
 * `listFactors()` goes through GoTrue (`getUser`), and auth-js RESOLVES a
 * failure as `{ data: null, error }` rather than throwing. This used to read
 * that as `[]`: "no verified factor". An enrolled user then skipped the
 * dashboard layout's AAL2 gate, and `resolveMfaState` skipped the
 * enrollment escalation (HI-6), under an 'optional' policy, for as long as
 * GoTrue was failing. An unreadable authorization input must deny, so this
 * throws: `resolveMfaState` catches and fails closed (MFA required, not
 * satisfied), and the layout shows its error screen rather than a
 * dashboard without its gate. Same contract as getOrgRowForRequest above.
 */
export const getMfaFactorsForRequest = cache(async (): Promise<MfaFactor[]> => {
  const supabase = await createClient();
  const res = await supabase.auth.mfa.listFactors();
  if (res.error) throw new Error(`getMfaFactorsForRequest: ${res.error.name || 'unreadable'}`);
  return (res.data?.all ?? []) as MfaFactor[];
});

/**
 * Enabled `organization_modules` for the org, as a Set of module ids.
 * Request-cached so the dashboard layout, `withContext()` (in
 * `server/services/context.ts`) AND every page's `checkModuleAccess()` gate
 * (lib/modules/module-gate) share ONE answer per render instead of each
 * issuing its own identical query (the gate used to make a `module_enabled`
 * RPC per call).
 *
 * Fail behaviour matches both prior call sites: on a query error this
 * returns an EMPTY set (logged). Callers treat an empty set as "core-only"
 * — `assertModuleEnabled` and `checkModuleAccess` still let core modules
 * through via the registry, while optional/premium modules are denied. So an
 * error fails CLOSED for optional modules and never widens entitlements.
 * The page gate relies on this: do not make an unreadable row set come back
 * as anything but "no rows". NOTE: the rows read itself does not throw (the
 * Supabase client surfaces failures as `{ error }`, not exceptions), but on
 * the legacy path the comp flag comes from getOrgRowForRequest, which THROWS
 * on a read error because it also feeds the MFA gate. That rejection reaches
 * the caller: the layout shows its error screen, and checkModuleAccess
 * catches it and denies.
 */
export const getModulesForRequest = cache(
  async (organizationId: string): Promise<Set<ModuleId>> => {
    // Same source as getOrgRowForRequest above: the enabled module ids and the
    // comp flag came back with the membership. The rule that turns them into
    // the effective set is the SAME function either way.
    const fromBundle = modulesFromMembership(
      bundleMembership(await loadRequestContextBundle(), organizationId),
    );
    if (fromBundle) return fromBundle;
    const supabase = await createClient();
    const { data, error } = await supabase
      .from('organization_modules')
      .select('module_id')
      .eq('organization_id', organizationId)
      .eq('enabled', true);
    if (error) {
      console.error('[getModulesForRequest] organization_modules query failed:', error);
    }
    // Comped "all modules" override: a platform admin granting full access
    // flips on every non-core module. getOrgRowForRequest is request-cached, so
    // this adds zero round-trips. Fails CLOSED — a null/false flag adds nothing.
    // The rule itself lives in lib/modules/effective-modules so the API context
    // cannot drift from it again.
    const org = await getOrgRowForRequest(organizationId);
    return effectiveModules(data as Array<{ module_id: string }> | null, org?.all_modules_comp);
  },
);

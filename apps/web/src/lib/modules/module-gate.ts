import 'server-only';
import { unstable_rethrow } from 'next/navigation';

import { requireOrgContext } from '@/lib/auth/session';
import { getModulesForRequest } from '@/lib/dashboard/request-cache';
import { MODULE_REGISTRY, type ModuleId } from '@stockpilot/core';

export interface ModuleAccess {
  enabled: boolean;
  canManage: boolean;
}

/**
 * Server-side gate for a module's dashboard route. Core modules are always
 * enabled. An optional/premium module is enabled when it is in the org's
 * request-cached module set (`getModulesForRequest`): the enabled
 * `organization_modules` rows plus, for a comped organization, every non-core
 * module (see ./effective-modules). That is the same ACCESS rule SQL
 * module_enabled() answers since migration 0354, for the only caller this gate
 * ever has: a member of the org, whose organization context came from an
 * accepted membership (requireOrgContext).
 *
 * WHY NOT THE RPC ANY MORE. This used to call `module_enabled` over PostgREST
 * on every call: one round trip per gate, ~51 call sites, and the Books page
 * made two of them in series before its header. The set it now reads is
 * already in hand: `get_request_context()` (0355) returns the enabled module
 * ids and the comp flag with the membership, in the round trip
 * requireOrgContext makes anyway, and the dashboard layout reads the same set
 * for the sidebar. Measured 2026-09-22: 3-5% of calls from Vercel to Supabase
 * stall 1-8 s at Supabase's entry point on weekday daytimes, and a page waits
 * for the slowest of its serial calls, so every call removed from the path
 * before the header is a stall the page can no longer hit.
 *
 * STILL PER REQUEST. getModulesForRequest is React `cache()`d, which shares one
 * answer within one render and never across requests: a module switched off
 * in Settings is off on the very next request, as it was with the RPC.
 *
 * NEVER WIDER THAN THE RPC. The set is read under the caller's own RLS
 * (organization_modules and organizations are both readable only by
 * is_org_member), where module_enabled() is SECURITY DEFINER. For a member the
 * two agree row for row; for anyone else this sees nothing and denies.
 *
 * FAILS CLOSED. The set cannot be read -> the module is not enabled:
 *   - the membership bundle failed: getModulesForRequest falls back to the
 *     legacy reads, with their own rules below;
 *   - the organization_modules read failed: getModulesForRequest logs it and
 *     counts no rows (an empty set denies every non-core module; only a comp
 *     that WAS read can still grant, exactly as module_enabled() would);
 *   - the organization row read failed: getOrgRowForRequest throws, caught here.
 * Framework control flow (redirect, notFound, dynamic bailout) is rethrown,
 * not mistaken for a read failure.
 *
 * `canManage` is true for owner/admin (who can turn it on in Settings ->
 * Modules). requireOrgContext is React-cached, so calling this at the top of a
 * page that also resolves context elsewhere costs no extra round-trip.
 */
export async function checkModuleAccess(moduleId: ModuleId): Promise<ModuleAccess> {
  const ctx = await requireOrgContext();
  const canManage = ctx.role === 'owner' || ctx.role === 'admin';
  if (MODULE_REGISTRY[moduleId].tier === 'core') return { enabled: true, canManage };
  let modules: Set<ModuleId>;
  try {
    modules = await getModulesForRequest(ctx.organizationId);
  } catch (e) {
    unstable_rethrow(e);
    // Fail closed (show "not enabled") on a read error, but log it so infra
    // problems are observable rather than silently denying access.
    console.error(
      '[module-gate] module set unreadable, denying access',
      moduleId,
      e instanceof Error ? e.message : 'unknown error',
    );
    return { enabled: false, canManage };
  }
  return { enabled: modules.has(moduleId), canManage };
}

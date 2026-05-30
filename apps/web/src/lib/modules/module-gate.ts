import 'server-only';
import { requireOrgContext } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';
import { MODULE_REGISTRY, type ModuleId } from '@stockpilot/core';

export interface ModuleAccess {
  enabled: boolean;
  canManage: boolean;
}

/**
 * Server-side gate for a module's dashboard route. Core modules are always
 * enabled. For optional/premium, consults the canonical module_enabled() helper
 * for the caller's org. `canManage` is true for owner/admin (who can turn it on
 * in Settings → Modules). requireOrgContext is React-cached, so calling this at
 * the top of a page that also resolves context elsewhere costs no extra round-trip.
 */
export async function checkModuleAccess(moduleId: ModuleId): Promise<ModuleAccess> {
  const ctx = await requireOrgContext();
  const canManage = ctx.role === 'owner' || ctx.role === 'admin';
  if (MODULE_REGISTRY[moduleId].tier === 'core') return { enabled: true, canManage };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('module_enabled', {
    p_org: ctx.organizationId,
    p_module: moduleId,
  });
  // Fail closed (show "not enabled") on a read error, but log it so infra
  // problems are observable rather than silently denying access.
  if (error) {
    console.error('[module-gate] module_enabled RPC failed, denying access', moduleId, error.message);
  }
  return { enabled: data === true, canManage };
}

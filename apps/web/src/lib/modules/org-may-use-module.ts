import type { SupabaseClient } from '@supabase/supabase-js';

import type { ModuleId } from '@stockpilot/core';

import { effectiveModules } from './effective-modules';

/**
 * The ACCESS rule (see ./effective-modules) for ONE module, with a client the
 * caller already holds. It exists for paths that have no user context to
 * resolve a whole module set from: the public API-key path, which runs on the
 * service-role client.
 *
 * Fails CLOSED on both reads: a row that cannot be read is off, a flag that
 * cannot be read is not a comp.
 *
 * NOT for automation (crons, exports, emails, webhooks, public links): those
 * need the explicit enabled row and must keep reading it directly.
 */
export async function orgMayUseModule(
  client: Pick<SupabaseClient, 'from'>,
  organizationId: string,
  moduleId: ModuleId,
): Promise<boolean> {
  const [row, org] = await Promise.all([
    client
      .from('organization_modules')
      .select('enabled')
      .eq('organization_id', organizationId)
      .eq('module_id', moduleId)
      .maybeSingle(),
    client.from('organizations').select('all_modules_comp').eq('id', organizationId).maybeSingle(),
  ]);
  const enabled = !row.error && (row.data as { enabled?: boolean } | null)?.enabled === true;
  const comped =
    !org.error &&
    (org.data as { all_modules_comp?: boolean | null } | null)?.all_modules_comp === true;
  return effectiveModules(enabled ? [{ module_id: moduleId }] : [], comped).has(moduleId);
}

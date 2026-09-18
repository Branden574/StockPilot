import { MODULE_REGISTRY, type ModuleId } from '@stockpilot/core';

/**
 * THE rule for "which modules does this organization have?".
 *
 * A module is on through an explicit `organization_modules` row with
 * enabled = true, OR through the platform console's "Comped: all modules" flag
 * (`organizations.all_modules_comp`), which turns on every non-core module
 * WITHOUT writing any rows. The comp wins even over an explicit enabled = false.
 *
 * This used to be re-implemented wherever modules were resolved, and the copies
 * drifted: the dashboard honoured the comp, while the API context (every
 * /api/v1 route, and the mobile snapshot that drives the app's navigation) read
 * the rows alone. For a comped organization with no rows, the same person got
 * every module on the web and none through the API. One rule, imported by both.
 *
 * PURE on purpose. Callers do their own reads, with their own client and their
 * own failure policy, and must pass `comped = false` when the organization read
 * fails: an unreadable flag grants nothing.
 */

/** Every non-core module id: the set a comped organization gets. */
export const NON_CORE_MODULE_IDS: ModuleId[] = (
  Object.values(MODULE_REGISTRY) as Array<{ id: ModuleId; tier: string }>
)
  .filter((m) => m.tier !== 'core')
  .map((m) => m.id);

export function effectiveModules(
  enabledRows: ReadonlyArray<{ module_id: string }> | null | undefined,
  comped: boolean | null | undefined,
): Set<ModuleId> {
  const enabled = new Set((enabledRows ?? []).map((r) => r.module_id as ModuleId));
  if (comped === true) for (const id of NON_CORE_MODULE_IDS) enabled.add(id);
  return enabled;
}

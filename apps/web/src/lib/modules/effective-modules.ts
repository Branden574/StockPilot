import { MODULE_REGISTRY, type ModuleId } from '@stockpilot/core';

/**
 * THE rule for "may the people in this organization USE module X?".
 *
 * A module is on through an explicit `organization_modules` row with
 * enabled = true, OR because the organization is comped
 * (`organizations.all_modules_comp`, the platform console's "Unlock every
 * premium module (full feature access)"), which turns on every non-core module
 * WITHOUT writing any rows. The comp wins even over an explicit enabled = false:
 * seed_org_modules() writes an OFF row for most modules when an organization is
 * created, so "comped with an explicit false" is the ordinary state of a comped
 * organization, not an edge. 0175's column comment says the same thing: "the
 * entitlement layer treats every premium module as enabled".
 *
 * This used to be re-implemented wherever modules were resolved, and the copies
 * drifted: the dashboard honoured the comp while the API context (every /api/v1
 * route and the mobile snapshot) and SQL module_enabled() (RLS and the page
 * gate) read the rows alone. One organization was offered a module in its
 * navigation and told "not enabled" by the page. One rule now, imported by the
 * TypeScript resolvers and mirrored by module_enabled() since migration 0354.
 *
 * TWO QUESTIONS, ON PURPOSE. Do not "finish the job" by pointing everything here.
 *
 *   ACCESS      a signed-in member opens a module, or an admin's API key calls
 *               the public API. Someone chose to do it. -> THIS rule.
 *
 *   AUTOMATION  anything that acts on its own or faces outsiders: cron jobs
 *               (price pulls, briefings, auto-reorder, recurring POs,
 *               reminders), the connector drainer that writes to QuickBooks and
 *               Sage, outbound emails and webhooks, public catalog links, the
 *               customer portal. -> the explicit enabled ROW, and only the row.
 *
 * The reason is the comp winning over an explicit false. For access that is
 * harmless. For automation it would take away the only off switch: an admin who
 * turned Integrations off to stop exports would see them resume. A comp unlocks;
 * it does not start machines. Settings > Modules says exactly this to a comped
 * organization.
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

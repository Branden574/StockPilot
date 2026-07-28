import 'server-only';

import { checkModuleAccess } from '@/lib/modules/module-gate';

import { withContext } from './context';
import { ProductGroupsService, type ProductGroupDisplay } from './product-groups';

/**
 * Resolve the display metadata for the product groups a page's rows belong to.
 *
 * The ONE seam every size-run surface uses (PO detail, PO create, PO edit), so
 * the module gate, the empty-set short-circuit and the failure posture are
 * decided once instead of three times.
 *
 * Three deliberate properties:
 *
 *  - **Costs a non-sports org nothing.** No group ids means no queries at all,
 *    and no group ids is every PO in every org that has not opted in.
 *  - **Module-gated.** `ProductGroupsService` asserts `sports`; calling it for
 *    an org without the module would throw, so the gate runs first.
 *  - **Degrades, never breaks.** A failed read returns an empty map and the
 *    caller falls back to the flat renderer. Receiving is the most
 *    prod-hardened seam in the app and must not go down over a cosmetic
 *    grouping lookup.
 */
/**
 * Just the counting units, keyed by group id — what a LIST needs and no more.
 *
 * The full display map carries each group's size-order Map, which a list never
 * consults (its runs are ordered from the stored `variant_size` through the
 * fallback ladders) and which would be dead weight in the RSC payload. Same
 * gate, same zero cost for an org with no grouped rows.
 */
export async function loadCountingUnits(
  groupIds: Array<string | null | undefined>,
): Promise<Record<string, string>> {
  const display = await loadSizeRunGroups(groupIds);
  return Object.fromEntries(Object.entries(display).map(([id, d]) => [id, d.countingUnit]));
}

/**
 * Every counting unit the ORG's groups define — the whole-dataset form, for a
 * list that paginates on the CLIENT.
 *
 * WHY A SUPERSET. `loadCountingUnits` resolves the units for the group ids it is
 * handed, which is exactly right when the caller holds the whole dataset (the
 * Items list's instant branch does). The DEFAULT Items view does not: the server
 * renders 30 rows and streams the full dataset behind them, and the client then
 * paginates locally — so units derived from those 30 rows went missing on every
 * page after the first, and a size-run header that should read "52 pairs" fell
 * back to a bare count. Resolving what the ORG has cannot be wrong for any page
 * the client renders.
 *
 * SAME COST POSTURE as the per-id form: an org without the `sports` module pays
 * nothing at all. The module set is on the request-cached ServiceContext, so the
 * gate is a Set lookup with no round trip — deliberately NOT `checkModuleAccess`,
 * which would add a `module_enabled` RPC to the hottest page in the app for
 * every org, including the ones this must cost nothing. Uncached, like the
 * instant branch's call, so it can never serve a stale unit; one column-only
 * read for a sports org.
 *
 * DEGRADES, never breaks: a failed read returns {} and every header falls back
 * to a plain count.
 */
export async function loadCountingUnitsForOrg(): Promise<Record<string, string>> {
  try {
    const ctx = await withContext();
    if (!ctx.enabledModules.has('sports')) return {};
    return await new ProductGroupsService(ctx).countingUnits();
  } catch (e) {
    console.error(
      '[size-run-display] org counting-unit lookup failed, falling back to plain counts',
      e instanceof Error ? e.message : e,
    );
    return {};
  }
}

export async function loadSizeRunGroups(
  groupIds: Array<string | null | undefined>,
): Promise<Record<string, ProductGroupDisplay>> {
  const unique = Array.from(new Set(groupIds.filter((v): v is string => Boolean(v))));
  if (unique.length === 0) return {};

  const { enabled } = await checkModuleAccess('sports');
  if (!enabled) return {};

  try {
    const svc = await ProductGroupsService.forCurrentUser();
    const display = await svc.displayByIds(unique);
    return Object.fromEntries(display);
  } catch (e) {
    console.error(
      '[size-run-display] product group lookup failed, falling back to flat lines',
      e instanceof Error ? e.message : e,
    );
    return {};
  }
}

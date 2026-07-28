import 'server-only';

import { checkModuleAccess } from '@/lib/modules/module-gate';

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

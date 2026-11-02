/**
 * One row per item in a bundle's component set (L10): (bundle_id, item_id) is
 * bundle_components' key, so a set naming one item twice fails the insert or
 * the upsert part way through. Shared by the bundle forms' schema
 * (server/actions/bundles.ts) and BundlesService, which both refuse it before
 * anything is written. Kept out of the service module so the form schema does
 * not depend on it.
 */
export const BUNDLE_DUPLICATE_COMPONENT = 'Each item can be in a bundle only once.';

/** True when no item appears twice. */
export function componentItemsDistinct(components: ReadonlyArray<{ itemId: string }>): boolean {
  return new Set(components.map((c) => c.itemId)).size === components.length;
}

/**
 * A kit needs at least one required component (0415): assemble_bundle and
 * distribute_bundle refuse to build kits from a bundle whose components are
 * all optional (bundle_no_required_components), because such a kit could be
 * made from nothing. The form, the action schema and BundlesService refuse
 * that set when it is saved, before anything is written, so a bundle is not
 * left in a state no kit can be built from.
 */
export const BUNDLE_NO_REQUIRED_COMPONENT =
  'Mark at least one component as required. A kit made only of optional components could be built from nothing.';

/** True when at least one component is not optional. */
export function componentsHaveRequired(
  components: ReadonlyArray<{ isOptional?: boolean | null }>,
): boolean {
  return components.some((c) => !c.isOptional);
}

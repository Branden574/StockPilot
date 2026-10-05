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

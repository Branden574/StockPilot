/**
 * Mobile mirror of `apps/web/src/lib/activity-references.ts` for the item
 * detail Movements tab. `stock_movements.reference_type`/`reference_id`
 * point back at the record that CAUSED the movement — an approved order, a
 * posted cycle count, a completed return, an assembled/distributed bundle.
 *
 * This module is pure (no Supabase access, no React) so it's unit-testable
 * the same way `movement-display.ts` is. The actual network lookups (order
 * number / return number / bundle name, one batched query per type) live in
 * `app/item/[id].tsx` next to the `stock_movements` query itself, mirroring
 * the web's `ActivityService.forItem` resolvers — mobile has no equivalent
 * "service" layer, so screen-local batched queries are the existing
 * convention (see the file's other Supabase reads).
 *
 * Only order_request | cycle_count | return | bundle are ever written to
 * `stock_movements.reference_type` (verified in Unit 1 against every
 * writer) — purchase_order and rental never appear there. Unlike the web
 * resolver's route table (which keeps purchase_order/rental for forward
 * compat with web-only dashboard routes), this module only maps the types
 * that actually occur, plus keeps route entries ONLY for types with a
 * native detail screen today.
 *
 * GRACEFUL DEGRADE (required): `referenceRoute` returns null whenever the
 * type/id is missing OR there is no native screen for that type (currently:
 * `return` has no mobile detail screen — the app has no returns list/detail
 * route at all). Callers MUST render a plain, non-tappable label in that
 * case — never construct a broken navigation.
 */

const REFERENCE_ROUTES: Record<string, (id: string) => string> = {
  order_request: (id) => `/order/${id}`,
  cycle_count: (id) => `/cycle-count/${id}`,
  bundle: (id) => `/bundles/${id}`,
  // return: no native detail screen exists yet — intentionally omitted so
  // referenceRoute() degrades to null (label-only) rather than a dead link.
};

const REFERENCE_TYPE_LABELS: Record<string, string> = {
  order_request: 'Order',
  cycle_count: 'Cycle count',
  return: 'Return',
  bundle: 'Bundle',
};

/**
 * Builds the native route for a movement's reference, or null when the
 * type/id is missing OR the type has no native screen. null means "render a
 * plain label, not a link" — never construct a path for an unrecognized or
 * unsupported type.
 */
export function referenceRoute(type: string | null, id: string | null): string | null {
  if (!type || !id) return null;
  const build = REFERENCE_ROUTES[type];
  return build ? build(id) : null;
}

/**
 * Generic human label for a reference_type when no cheap resolved number is
 * available (or the resolver found nothing). Known types get a short display
 * name; anything else is title-cased from its raw snake_case value so a
 * future/unrecognized type still reads as English instead of raw code.
 */
export function referenceTypeLabel(type: string): string {
  const known = REFERENCE_TYPE_LABELS[type];
  if (known) return known;
  const spaced = type.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Groups this page's movement rows' reference ids by reference_type so the
 * caller can run ONE batched query per type (order_requests / returns /
 * bundles) instead of N+1. Rows missing either field are skipped. Exported
 * for unit tests; the actual per-type queries live in app/item/[id].tsx.
 */
export function collectReferenceIdsByType(
  rows: { reference_type: string | null; reference_id: string | null }[],
): Record<string, string[]> {
  const byType: Record<string, string[]> = {};
  for (const r of rows) {
    if (r.reference_type && r.reference_id) {
      (byType[r.reference_type] ??= []).push(r.reference_id);
    }
  }
  return byType;
}

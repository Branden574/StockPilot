/**
 * Pure reference_type → route resolver for the item detail Movements/Activity
 * feed. stock_movements.reference_type/reference_id point back at the record
 * that caused the movement (an approved order, a posted cycle count, a
 * completed return, an assembled/distributed bundle, …). This module ONLY
 * builds a URL + a generic fallback label from the type string — it never
 * touches the database — so it's safe to import from the client-rendered
 * ActivityFeed as well as from server code.
 *
 * The human display number (PO number, order number, return number, bundle
 * name) is resolved server-side in ActivityService.forItem (one batched
 * query per type, same pattern as the existing receipt→PO lookup) and
 * arrives on ActivityEvent.referenceLabel. When that's null — either there's
 * no cheap number for the type (cycle counts have none) or the lookup found
 * nothing — callers should fall back to `referenceTypeLabel()`.
 *
 * The maps below cover ONLY the reference_type values a writer actually sets
 * on stock_movements today (order_request | cycle_count | return | bundle —
 * verified in Movement/Activity P1 against every writer; mobile's
 * `movement-references.ts` mirrors the same set). `purchase_order` and
 * `rental` were removed here (P1 review follow-up) since nothing ever writes
 * them — keeping unreachable entries around implied a coverage that didn't
 * exist. This is safe by construction, not just today: any reference_type
 * NOT in these maps — a genuinely unrecognized value, or a future type before
 * its route/label is added — degrades to `referenceTypeLabel()`'s
 * title-cased fallback below, exactly what a real entry would look like
 * anyway, just not clickable yet.
 *
 * GRACEFUL DEGRADE (required): `referenceHref` returns null for any
 * reference_type not in the map below. Callers MUST render a plain label in
 * that case, never a broken link.
 */

const REFERENCE_ROUTES: Record<string, (id: string) => string> = {
  order_request: (id) => `/dashboard/orders/${id}`,
  cycle_count: (id) => `/dashboard/cycle-counts/${id}`,
  return: (id) => `/dashboard/returns/${id}`,
  bundle: (id) => `/dashboard/bundles/${id}`,
};

const REFERENCE_TYPE_LABELS: Record<string, string> = {
  order_request: 'Order',
  cycle_count: 'Cycle count',
  return: 'Return',
  bundle: 'Bundle',
};

/**
 * Builds the href for a movement's reference, or null when the type/id is
 * missing OR the type isn't a known route. null means "render a plain label,
 * not a link" — never construct a URL for an unrecognized type.
 */
export function referenceHref(type: string | null, id: string | null): string | null {
  if (!type || !id) return null;
  const build = REFERENCE_ROUTES[type];
  return build ? build(id) : null;
}

/**
 * Generic human label for a reference_type when no cheap resolved number is
 * available (ActivityEvent.referenceLabel is null). Known types get a short
 * display name; anything else is title-cased from its raw snake_case value
 * so a future/unrecognized type still reads as English instead of raw code.
 */
export function referenceTypeLabel(type: string): string {
  const known = REFERENCE_TYPE_LABELS[type];
  if (known) return known;
  const spaced = type.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

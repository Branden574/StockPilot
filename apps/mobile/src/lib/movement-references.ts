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
 * `mergeReferenceLabelMaps` + `attachReferenceLabels` below are the
 * dependency-injected merge/attach half of that pipeline: the screen still
 * owns the three `.in()` fetches, but hands the results (already-fetched
 * maps) to these pure functions to combine and stitch onto the movement
 * rows — the piece that used to be private, unexported, network-entangled
 * logic in `resolveReferenceLabels` with zero test coverage.
 *
 * Only order_request | cycle_count | return | bundle are ever written to
 * `stock_movements.reference_type` (verified in Unit 1 against every
 * writer) — purchase_order and rental never appear there. The web's
 * `activity-references.ts` LABEL/ROUTE maps were trimmed to this same set
 * (Movement/Activity P1 review follow-up — the purchase_order/rental entries
 * there were dead, forward-compat-only weight for types no writer produces),
 * so both platforms' maps now cover exactly the written set. This module
 * additionally keeps route entries ONLY for types with a native detail
 * screen today (narrower than the label map, see below).
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

/**
 * Merges N already-fetched "id → label" maps (one per reference type — the
 * results of the screen's batched order_requests/returns/bundles queries)
 * into a single map, later entries winning on a (theoretically impossible,
 * since ids are UUIDs from disjoint tables) collision. Pure: takes maps, not
 * ids or a Supabase client, so it needs no network mock to test. This is the
 * "merge" half of the batch-fetch → merge → attach pipeline (Unit 3) that
 * previously had zero coverage because it lived inline in
 * `resolveReferenceLabels` in app/item/[id].tsx, entangled with the fetches
 * themselves.
 */
export function mergeReferenceLabelMaps(
  maps: readonly (Map<string, string> | null | undefined)[],
): Map<string, string> {
  const merged = new Map<string, string>();
  for (const m of maps) {
    if (!m) continue;
    for (const [id, label] of m) merged.set(id, label);
  }
  return merged;
}

/**
 * The "attach" half of the pipeline: given the raw movement rows (only
 * `reference_id` is read; `reference_type` rides along unused today but is
 * kept on the input/output shape for callers that need it downstream) and
 * the merged label map from `mergeReferenceLabelMaps`, returns the same rows
 * with `reference_label` attached. Pure and dependency-injected — the
 * screen fetches the maps, this function never touches Supabase.
 *
 * Degrades safely in two cases that must never crash or produce a broken
 * card: a row with no `reference_id` (no source event) gets `null`; a row
 * whose `reference_id` IS set but is missing from `labelById` (e.g. the
 * order/return/bundle it pointed to was later deleted, or its type has no
 * cheap display field like cycle_count) also gets `null` rather than
 * throwing — the card then falls back to the generic `referenceTypeLabel()`.
 */
export function attachReferenceLabels<
  T extends { reference_type: string | null; reference_id: string | null },
>(rows: T[], labelById: Map<string, string>): (T & { reference_label: string | null })[] {
  return rows.map((row) => ({
    ...row,
    reference_label: row.reference_id ? (labelById.get(row.reference_id) ?? null) : null,
  }));
}

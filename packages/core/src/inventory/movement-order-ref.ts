/**
 * Order references inside a stock-movement's `reason` — parsing the LEGACY
 * form and rendering the human one. Shared by web and mobile so every surface
 * prints the identical handle (the same reason `formatOrderNumber` lives in
 * packages/core rather than in either app).
 *
 * THE DEFECT THIS EXISTS FOR. `complete_picking` has written
 *
 *     Order pick (order_request b3c7390a-b114-4839-a100-a008d3f3fde0)
 *
 * since migration 0111. `order_requests.order_number` — the number a human
 * actually says out loud — only arrived in 0254, so the note had nothing but
 * the row's uuid to point at. Migration 0306 fixes the WRITER (new rows read
 * `Order pick (SO-000060)` and carry the machine link in
 * `reference_type`/`reference_id`, the columns built for it). It deliberately
 * does NOT rewrite the rows already in the ledger: `stock_movements` is
 * append-only and the Movements page says so on the page. So the ~99 rows
 * already written have to be resolved at DISPLAY time instead, which is what
 * this module is for.
 *
 * WHY THE SAME SHAPE COVERS MORE THAN PICKS. `cancel_order_request` writes
 * `Order cancelled (order_request …)` with the identical parenthetical. The
 * matcher here keys off the `order_request <uuid>` form, not off the prose in
 * front of it, so those rows get the same treatment for free. Nothing else in
 * the schema writes that parenthetical.
 *
 * THE THREE-STATE CONTRACT, which callers must not "improve":
 *   1. No order reference in the reason  -> returned verbatim. This module is
 *      not a general reason cleaner; `historyNote` owns that vocabulary.
 *   2. Reference present AND resolvable  -> "Order pick (SO-000060)".
 *   3. Reference present, NOT resolvable -> "Order pick". The parenthetical is
 *      DROPPED, never left as a uuid. An unresolvable reference means the org
 *      scoping excluded it, the lookup errored, or the order was deleted —
 *      none of which is a reason to show an operator a machine identifier.
 *      This is exactly what `historyNote` already did unconditionally, so the
 *      unresolved path is byte-identical to today's item-history rendering.
 *
 * NO N+1. Callers collect every id on the page with `collectLegacyOrderRefIds`,
 * run ONE org-scoped lookup, build the label map with `orderNumberLabels`, and
 * pass that map to `resolveOrderRefReason` per row. The per-row function never
 * touches the network — it takes an already-fetched map, mirroring
 * `receiptLineSummary`'s dependency-injected shape.
 */

import { formatOrderNumber } from '../orders/order-number';

/**
 * The legacy parenthetical, anchored to the END of the reason because that is
 * precisely where both writers append it (`'… (order_request ' || id || ')'`).
 * Anchoring keeps this from ever chewing a parenthetical out of the middle of
 * text an operator typed.
 *
 * Deliberately NARROWER than `movement-history.ts`'s `TRAILING_REF_RE` (which
 * strips any of order/return/receipt/… because it only needs to remove them):
 * this one has to hand back a usable id, so it matches the one reference type
 * that has a display number to resolve to.
 */
export const LEGACY_ORDER_REF_RE =
  /\s*\(order_request\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)\s*$/i;

/**
 * The `order_requests.id` a legacy reason points at, or null when the reason
 * carries no such reference. Pure string work — the id is NOT validated
 * against the database here; callers scope their lookup by organization.
 */
export function legacyOrderRefId(reason: string | null | undefined): string | null {
  if (!reason) return null;
  const m = LEGACY_ORDER_REF_RE.exec(reason);
  return m ? (m[1] as string).toLowerCase() : null;
}

/**
 * Every distinct order id referenced by the legacy reasons on THIS page, so
 * the caller can resolve them in one batched query instead of per row.
 * Deduped; rows with no reference cost nothing.
 */
export function collectLegacyOrderRefIds(
  rows: ReadonlyArray<{ reason: string | null | undefined }>,
): string[] {
  const ids = new Set<string>();
  for (const r of rows) {
    const id = legacyOrderRefId(r.reason);
    if (id) ids.add(id);
  }
  return [...ids];
}

/**
 * Turns the rows of a batched `order_requests` lookup into the id -> label map
 * `resolveOrderRefReason` consumes. Formatting goes through
 * `formatOrderNumber`, so a movement note, the orders list and the mobile
 * order screen can never disagree about how SO-000060 is spelled. Rows whose
 * number is null or non-positive are simply absent from the map, which routes
 * them to the unresolved path (state 3) rather than into a broken "SO-" label.
 */
export function orderNumberLabels(
  rows: ReadonlyArray<{ id: string; order_number: number | null }>,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const r of rows) {
    const label = formatOrderNumber(r.order_number);
    if (label) map.set(r.id.toLowerCase(), label);
  }
  return map;
}

/**
 * Renders a movement reason for humans: see the three-state contract in the
 * module doc-comment. `orderNumberById` is the already-fetched map from
 * `orderNumberLabels` (or the web service's `resolveOrderNumbers`); omitting
 * it is legal and means "nothing resolved", i.e. every reference degrades to
 * state 3.
 *
 * Rows written by migration 0306 onward already contain `(SO-000060)` and
 * match nothing here, so they pass through state 1 untouched — one code path
 * serves the old ledger and the new without the caller having to know which
 * era a row came from.
 */
export function resolveOrderRefReason(
  reason: string | null | undefined,
  orderNumberById?: ReadonlyMap<string, string> | null,
): string | null {
  // null / undefined / '' all mean "nothing to say", normalized to null so a
  // surface never has to decide whether an empty string is a real reason.
  if (!reason) return null;
  const m = LEGACY_ORDER_REF_RE.exec(reason);
  if (!m) return reason;
  const head = reason.slice(0, m.index).trimEnd();
  const label = orderNumberById?.get((m[1] as string).toLowerCase()) ?? null;
  if (!label) return head || null;
  return head ? `${head} (${label})` : label;
}

/**
 * The order this movement belongs to, for LINKING — reference columns first
 * (0306+ rows, and every other writer that has always stamped them), falling
 * back to the id parsed out of a legacy reason. null means "render plain
 * text, not a link"; never construct a route from a value this returns null
 * for. Mirrors the graceful-degrade contract in `movement-references.ts`.
 */
export function movementOrderRefId(row: {
  reason?: string | null;
  reference_type?: string | null;
  reference_id?: string | null;
}): string | null {
  if (row.reference_type === 'order_request' && row.reference_id) return row.reference_id;
  return legacyOrderRefId(row.reason);
}

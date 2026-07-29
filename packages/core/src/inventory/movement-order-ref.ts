/**
 * Record references inside a stock-movement's `reason` — parsing the LEGACY
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
 * TWO REFERENCE SHAPES, NOT ONE. The identical parenthetical is written by
 * more than the pick writer, and every one of them is a raw uuid in a field a
 * human reads:
 *
 *   `Order pick (order_request …)`          complete_picking (0111 → 0305)
 *   `Order cancelled (order_request …)`     cancel_order_request (0137/0155)
 *   `Return restock (return …)`             apply_return_dispositions
 *   `Return scrap write-off (return …)`     (0153 → 0154 → 0197), STILL LIVE
 *
 * The return writers are not history — they are the shipped RPCs, writing that
 * text today. An earlier version of this module matched `order_request` only,
 * which left the Movements page and the CSV printing raw hex for returns while
 * `historyNote` stripped it: the exact two-surface split this whole change
 * exists to close. So the matcher keys off the reference KIND, and callers
 * resolve `order_request` ids to `SO-000060` and `return` ids to their
 * `return_number`.
 *
 * THE THREE-STATE CONTRACT, which callers must not "improve":
 *   1. No reference in the reason         -> returned verbatim. This module is
 *      not a general reason cleaner; `historyNote` owns that vocabulary.
 *   2. Reference present AND resolvable   -> "Order pick (SO-000060)".
 *   3. Reference present, NOT resolvable  -> "Order pick". The parenthetical is
 *      DROPPED, never left as a uuid. An unresolvable reference means the org
 *      scoping excluded it, the lookup errored, or the record was deleted —
 *      none of which is a reason to show an operator a machine identifier.
 *      This is exactly what `historyNote` already did unconditionally, so the
 *      unresolved path is byte-identical to today's item-history rendering.
 *
 * NO N+1. Callers collect every id on the page with `collectLegacyRefIdsByKind`
 * (or `collectLegacyOrderRefIds` when they only care about orders), run ONE
 * org-scoped lookup per kind, build the label map with `orderNumberLabels` /
 * `returnNumberLabels`, and pass the merged map to `resolveMovementRefReason`
 * per row. The per-row function never touches the network — it takes an
 * already-fetched map, mirroring `receiptLineSummary`'s dependency-injected
 * shape.
 */

import { formatOrderNumber } from '../orders/order-number';

/** The reference kinds a movement reason can name. Both have a display number
 *  worth resolving to; nothing else in the schema writes this parenthetical. */
export type LegacyRefKind = 'order_request' | 'return';

const UUID_SRC = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/**
 * The legacy parenthetical, anchored to the END of the reason because that is
 * precisely where every writer appends it (`'… (order_request ' || id || ')'`).
 * Anchoring keeps this from ever chewing a parenthetical out of the middle of
 * text an operator typed.
 *
 * Deliberately NARROWER than `movement-history.ts`'s `TRAILING_REF_RE` (which
 * strips any of order/return/receipt/… because it only needs to remove them):
 * this one has to hand back a usable id, so it matches the two reference kinds
 * that have a display number to resolve to.
 */
export const LEGACY_REF_RE = new RegExp(`\\s*\\((order_request|return)\\s+(${UUID_SRC})\\)\\s*$`, 'i');

/**
 * Order-only form of the same match, kept separate because the callers that
 * build a LINK use it: an order id routes to /dashboard/orders/{id}, and a
 * return id must never be handed to that route. See `movementOrderRefId`.
 */
export const LEGACY_ORDER_REF_RE = new RegExp(`\\s*\\(order_request\\s+(${UUID_SRC})\\)\\s*$`, 'i');

/** Any parenthetical containing a raw uuid, wherever it sits in the string —
 *  the last-resort broom for a surface that renders a reason with no label map
 *  to resolve against. Global (not anchored): a uuid is never something an
 *  operator typed, so there is no prose to protect. */
const UUID_PAREN_RE = new RegExp(`\\s*\\([^)]*${UUID_SRC}[^)]*\\)\\s*`, 'gi');

/** A reason that is a bare id and nothing else — same rule `historyNote`'s
 *  cleanProse applies: an identifier is not words. */
const BARE_UUID_RE = new RegExp(`^${UUID_SRC}$`, 'i');

/** The kind + id a legacy reason points at, or null when it carries no
 *  reference. Pure string work — the id is NOT validated against the database
 *  here; callers scope their lookup by organization. */
export function legacyRefMatch(
  reason: string | null | undefined,
): { kind: LegacyRefKind; id: string } | null {
  if (!reason) return null;
  const m = LEGACY_REF_RE.exec(reason);
  if (!m) return null;
  return {
    kind: (m[1] as string).toLowerCase() as LegacyRefKind,
    id: (m[2] as string).toLowerCase(),
  };
}

/**
 * The `order_requests.id` a legacy reason points at, or null when the reason
 * carries no ORDER reference. Returns null for a `return` reference on purpose:
 * every caller of this function uses the id to build an order route or an
 * `order_request` reference type, and a return id there is a broken link.
 */
export function legacyOrderRefId(reason: string | null | undefined): string | null {
  const m = legacyRefMatch(reason);
  return m && m.kind === 'order_request' ? m.id : null;
}

/**
 * Every distinct order id referenced by the legacy reasons on THIS page, so
 * the caller can resolve them in one batched query instead of per row.
 * Deduped; rows with no reference cost nothing.
 */
export function collectLegacyOrderRefIds(
  rows: ReadonlyArray<{ reason: string | null | undefined }>,
): string[] {
  return collectLegacyRefIdsByKind(rows).order_request;
}

/**
 * Same collection, split by kind, for surfaces that resolve both — one batched
 * lookup per kind, never one per row. Both buckets are always present (empty
 * arrays), so a caller can hand them straight to a resolver that no-ops on an
 * empty list.
 */
export function collectLegacyRefIdsByKind(
  rows: ReadonlyArray<{ reason: string | null | undefined }>,
): Record<LegacyRefKind, string[]> {
  const seen: Record<LegacyRefKind, Set<string>> = {
    order_request: new Set<string>(),
    return: new Set<string>(),
  };
  for (const r of rows) {
    const m = legacyRefMatch(r.reason);
    if (m) seen[m.kind].add(m.id);
  }
  return { order_request: [...seen.order_request], return: [...seen.return] };
}

/**
 * Turns the rows of a batched `order_requests` lookup into the id -> label map
 * `resolveMovementRefReason` consumes. Formatting goes through
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
 * The same map for `returns` rows. `return_number` is already a display string
 * in the database (there is no format function to share), so this only drops
 * the rows that have none — again routing them to state 3 instead of rendering
 * an empty parenthetical.
 */
export function returnNumberLabels(
  rows: ReadonlyArray<{ id: string; return_number: string | null }>,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const r of rows) {
    if (r.return_number) map.set(r.id.toLowerCase(), r.return_number);
  }
  return map;
}

/**
 * Renders a movement reason for humans: see the three-state contract in the
 * module doc-comment. `labelById` is the already-fetched map from
 * `orderNumberLabels` / `returnNumberLabels` (or the web service's
 * `resolveReferenceLabels`, which merges both plus bundles); omitting it is
 * legal and means "nothing resolved", i.e. every reference degrades to state 3.
 *
 * Rows written by migration 0306 onward already contain `(SO-000060)` and
 * match nothing here, so they pass through state 1 untouched — one code path
 * serves the old ledger and the new without the caller having to know which
 * era a row came from.
 */
export function resolveMovementRefReason(
  reason: string | null | undefined,
  labelById?: ReadonlyMap<string, string> | null,
): string | null {
  // null / undefined / '' all mean "nothing to say", normalized to null so a
  // surface never has to decide whether an empty string is a real reason.
  if (!reason) return null;
  const m = LEGACY_REF_RE.exec(reason);
  if (!m) return reason;
  const head = reason.slice(0, m.index).trimEnd();
  const label = labelById?.get((m[2] as string).toLowerCase()) ?? null;
  if (!label) return head || null;
  return head ? `${head} (${label})` : label;
}

/**
 * Drops the `(SO-000060)` a surface is about to render SEPARATELY — as a
 * linked reference chip beside the reason — so the same handle is not printed
 * twice on one row. Only an exact trailing `(label)` goes; prose an operator
 * typed is never touched, and a row whose reason is nothing BUT the label
 * collapses to null (the chip already carries it).
 */
export function reasonWithoutRefLabel(
  reason: string | null | undefined,
  label: string | null | undefined,
): string | null {
  if (!reason) return null;
  if (!label) return reason;
  const suffix = `(${label})`;
  if (!reason.endsWith(suffix)) return reason;
  return reason.slice(0, reason.length - suffix.length).trimEnd() || null;
}

/**
 * The one-line form for a cramped surface (the mobile home tab's recent-
 * movement teaser): resolve the reference, drop any parenthetical that still
 * carries a raw uuid, and clamp the length so the secondary line cannot wrap.
 *
 * It lives here, and not next to the teaser, for the reason the whole module
 * does: a private copy of this parsing on one platform is how "Order pick
 * (SO-000060)" on the web dashboard became a bare "Order pick" on the phone.
 * Pass the same batched label map the surface's other rows use and the two
 * platforms print the same words.
 */
export function movementReasonTeaser(
  reason: string | null | undefined,
  labelById?: ReadonlyMap<string, string> | null,
  maxLength = 38,
): string | null {
  const resolved = resolveMovementRefReason(reason, labelById);
  if (!resolved) return null;
  // Belt and braces for a reference shape this module does not resolve: no raw
  // uuid ever reaches a card, whatever a future writer invents — including a
  // reason that is nothing BUT an id, which is not words and renders as noise.
  const cleaned = resolved.replace(UUID_PAREN_RE, ' ').trim().replace(/\s+/g, ' ');
  if (!cleaned || BARE_UUID_RE.test(cleaned)) return null;
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, Math.max(1, maxLength - 2)).trimEnd()}…`;
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

import 'server-only';

import { formatOrderNumber } from '@stockpilot/core';

import { ServiceContext, withContext } from './context';

export interface ActivityEvent {
  id: string;
  kind: 'movement' | 'audit';
  type: string;
  createdAt: string;
  /** Movement: numeric delta. Audit: null. */
  delta: number | null;
  /** Movement: quantity on hand BEFORE this change (stock_movements.previous_quantity,
   *  NOT NULL since the original schema). Audit: null. Pair with `quantityAfter`
   *  to render the full "250 → 235" ledger line instead of only the after value. */
  previousQuantity: number | null;
  /** Movement: post-change quantity. Audit: null. */
  quantityAfter: number | null;
  /**
   * Transfers only: the physical quantity moved (stock_movements.moved_quantity,
   * migration 0231). Transfers are net-zero on hand so `delta` is 0 — this is
   * the number displays should show. null on pre-0231 transfer rows and on
   * every non-transfer event.
   */
  movedQuantity: number | null;
  /** Movement: source location id (transfers/removals). Audit: null. */
  fromLocationId: string | null;
  /** Movement: destination location id (transfers/receipts). Audit: null. */
  toLocationId: string | null;
  /**
   * Movement: the kind of record that caused this movement — order_request |
   * cycle_count | return | bundle, the only values any writer sets on
   * stock_movements (verified in Movement/Activity P1). Audit: null. Feeds
   * the reference_type → route resolver in `@/lib/activity-references` — an
   * unrecognized value there (a future type, or truly unknown data) degrades
   * to a plain label, never a broken link.
   */
  referenceType: string | null;
  /** Movement: id of the referenced record (stock_movements.reference_id). Audit: null. */
  referenceId: string | null;
  /**
   * Server-resolved human label for the reference (order number, PO number,
   * return number, bundle name) — resolved here because it's cheap (one
   * batched query per type, same pattern as `resolveReceiptPoNumbers`).
   * null when there's no cheap number to show (e.g. cycle counts have none)
   * or the row has no reference at all — the UI falls back to a generic
   * type label in that case, still linked when the route is known.
   */
  referenceLabel: string | null;
  /**
   * Free-text "why" for the change. Movement: stock_movements.reason (pre-0231
   * 'receipt_line' rows are pre-mapped to 'PO {number}' / 'PO receipt').
   * Audit: metadata.reason. Never silently replaced by `notes` — see `notes`.
   */
  reason: string | null;
  /**
   * User-entered free-text notes, carried through VERBATIM alongside `reason`
   * (previously these were dropped whenever `reason` was also set). Movement
   * only; null for pre-0231 'receipt_line' rows since their notes column
   * holds an internal receipt id, not user text. Audit: always null.
   */
  notes: string | null;
  /**
   * Whether this event's note is user-editable (drives the item feed's
   * add/edit-note affordance, alongside the caller's `movements:edit_notes`
   * permission). False for audit rows (never editable) AND for pre-0231
   * 'receipt_line' movements, whose `notes` column holds a machine receipt
   * reference the RPC refuses to overwrite (errcode 22023).
   */
  noteEditable: boolean;
  /** Display name of the actor (or "System") if attribution missing. */
  actor: string;
  actorEmail: string | null;
  /**
   * Audit rows only: the raw audit_logs.metadata object (entity_type,
   * entity_id, before, after, changed_keys, reason, …) passed through
   * verbatim so the feed can render the before/after diff drawer /
   * changed-keys chip (@/components/audit/metadata-diff — MetadataDiff).
   * Movement: always null (stock_movements has no such jsonb column).
   */
  metadata: Record<string, unknown> | null;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One kind's "Load older" keyset boundary — the (created_at, id) of the
 * OLDEST row of that kind already fetched. Pairing `id` alongside
 * `createdAt` (not `createdAt` alone) is what makes the boundary exact at a
 * tie: several rows can legitimately share the identical `created_at` (a
 * bulk operation, or plain second-resolution clustering), and a page's
 * `.limit()` can cut such a tie group in half. A created_at-only boundary
 * then either skips the rows on the wrong side of the cut (`.lt`, the
 * original bug — see below) or re-returns the whole tie group forever
 * (`.lte`). Paired with `ORDER BY created_at DESC, id DESC` (see `forItem`),
 * `(created_at, id)` is a total, deterministic order with no ties at all —
 * "strictly before this exact row" is always well-defined.
 */
export interface ActivityKindCursor {
  createdAt: string;
  /** RAW `stock_movements.id` / `audit_logs.id` — NOT the kind-prefixed
   * (`m:`/`a:`) composite `ActivityEvent.id` used for display/de-dupe. */
  id: string;
}

/**
 * `forItem`'s "Load older" cursor — one boundary PER KIND, never a single
 * shared value. Movements and audits are two independent underlying
 * queries/tables with independently-sized caps (`movementLimit` vs.
 * `auditLimit`), so whichever kind's cap is reached first has nothing to do
 * with where the OTHER kind's next page should start — sharing one boundary
 * across both (the original design) either skipped tied-boundary rows
 * (Blocker: created_at-only ordering) or forced re-fetching the other kind's
 * already-seen rows (the old "later of two boundaries" trade-off). See
 * `nextActivityCursor` in `lib/activity-pagination.ts` for how this is
 * derived from a page's events.
 */
export interface ActivityCursor {
  movement?: ActivityKindCursor;
  audit?: ActivityKindCursor;
}

/**
 * Display-duplication rule (Movement/Activity P2 Task 2): `InventoryService`
 * now emits an `audit_logs` row for every adjust/transfer/receive/remove
 * (`stock.adjusted` / `stock.transferred` / `stock.received` /
 * `stock.removed`) so the GLOBAL audit page (`/dashboard/admin/audit`,
 * `/dashboard/settings/audit` — which query `audit_logs` directly, NOT this
 * method) gets full before/after attribution for stock changes. But every
 * one of those mutations ALSO already writes a `stock_movements` row, and
 * `forItem` is the ONE feed that merges both sources for the item's
 * Activity tab — the movement row is the canonical, richer representation
 * there (it renders `prev → after` quantity and `from → to` location
 * inline; the audit row would just repeat the same fact with a plainer
 * summary). Showing both would double-render every adjust/transfer on the
 * item feed, regressing the P1 crowd-out fix. So these four events are
 * suppressed HERE ONLY (not from `audit_logs` itself, not from the global
 * audit page). Every other audit event — item edits, archive/restore/
 * delete/duplicate, serial add/update/remove, tag apply/remove, image
 * capture, … — has no movement-row counterpart and is left untouched;
 * those are exactly what drives the before/after diff drawer on the item
 * feed.
 */
const MOVEMENT_SHADOWED_AUDIT_EVENTS: readonly string[] = [
  'stock.adjusted',
  'stock.transferred',
  'stock.received',
  'stock.removed',
];

/**
 * Movement/Activity P3 Task 1 defense: `InventoryService.archive()` /
 * `softDelete()` used to write a FICTIONAL `stock_movements` row
 * (`movement_type='adjust'`, `reason='item_archived'|'item_deleted'`)
 * driving on-hand to 0 even though archive/delete deliberately PRESERVE
 * quantity_on_hand — no stock ever physically moved. That insert has been
 * removed at the source (see `inventory.ts` archive()/softDelete()) and a
 * one-time cleanup (migration 0271) deletes any rows it already wrote. This
 * denylist keeps any LEGACY row that slipped through the cleanup (or a
 * future accidental write) from ever rendering as a real stock event on the
 * item feed.
 *
 * Filtered in JS ONLY (see the `.filter()` below) — deliberately NOT at the
 * query layer, unlike `MOVEMENT_SHADOWED_AUDIT_EVENTS`. `reason` on
 * stock_movements is NULLABLE (most 'initial' rows and many 'add'/'transfer'
 * rows carry `reason: null`), and PostgREST's `.not(col, 'in', (...))`
 * compiles to `NOT (col = ANY(...))`, which is NULL — not TRUE — for a NULL
 * `col`. Postgres then drops the row instead of keeping it, so a query-layer
 * `.not('reason', 'in', ...)` here would silently discard every movement
 * with a null reason (verified against prod: 499/818 = 61% of movements),
 * gutting the item Activity feed. The audit-side `.not('event', 'in', ...)`
 * a few lines below does NOT have this problem: `audit_logs.event` is
 * NOT NULL, so `event = ANY(...)` is always TRUE or FALSE there, never NULL.
 */
const LIFECYCLE_REASON_MOVEMENTS: readonly string[] = ['item_archived', 'item_deleted'];

/**
 * Movement/Activity P4 Task 2: the audit half of `forItem`'s per-kind cap —
 * `auditLimit = ceil(limit / 2)`. Pulled out to its own function (was an
 * inline expression in `forItem`) so the "Load older" pagination surfaces
 * (the server action + item-detail's initial-page exhaustion check) can
 * compute the SAME cap without duplicating the formula. `Math.max(1, …)`
 * matches the original inline behavior: a limit of 1 still asks for at
 * least one audit row rather than zero.
 */
export function auditLimitFor(limit: number): number {
  return Math.max(1, Math.ceil(limit / 2));
}

/**
 * Display-layer mapping for pre-0231 receipt movements: rows written by the
 * old post_receipt_v2 carry the internal reason 'receipt_line' with the
 * receipt id in notes. Given a resolver map (receipt id → po_number), returns
 * the human summary: 'PO {number}', or 'PO receipt' when unresolvable.
 * New rows (0231+) already carry 'PO {number}' in reason and never hit this.
 * Exported for the display-mapping unit tests.
 */
export function receiptLineSummary(
  notes: string | null,
  poNumberByReceipt: Map<string, string>,
): string {
  const rid = (notes ?? '').trim();
  const po = poNumberByReceipt.get(rid);
  return po ? `PO ${po}` : 'PO receipt';
}

/**
 * Collects the receipt ids referenced by pre-0231 'receipt_line' rows so they
 * can be resolved to PO numbers in ONE batched query (the stagedWorklist join
 * pattern: sm.notes holds receipts.id as text). Exported for unit tests.
 */
export function collectReceiptLineIds(
  rows: Array<{ reason: string | null; notes: string | null }>,
): string[] {
  return [
    ...new Set(
      rows
        .filter((m) => m.reason === 'receipt_line' && UUID_RE.test((m.notes ?? '').trim()))
        .map((m) => (m.notes as string).trim()),
    ),
  ];
}

/**
 * Batch-resolves receipt ids → purchase_orders.po_number (one query). Errors
 * degrade gracefully to an empty map — displays then fall back to 'PO receipt'
 * rather than leaking the internal 'receipt_line' label or hiding the event.
 */
export async function resolveReceiptPoNumbers(
  ctx: ServiceContext,
  receiptIds: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (receiptIds.length === 0) return map;
  const { data, error } = await ctx.supabase
    .from('receipts')
    .select('id, purchase_orders(po_number)')
    .eq('organization_id', ctx.organizationId)
    .in('id', receiptIds);
  if (error) {
    console.error('activity: receipt→PO lookup failed', { error: error.message });
    return map;
  }
  for (const r of (data ?? []) as Array<Record<string, unknown>>) {
    const poField = r.purchase_orders as
      | { po_number?: string | null }
      | { po_number?: string | null }[]
      | null;
    const po = Array.isArray(poField) ? poField[0] : poField;
    if (po?.po_number) map.set(r.id as string, po.po_number);
  }
  return map;
}

/**
 * Batch-resolves order_request ids → their display "SO-000049" number
 * (stock_movements.reference_type='order_request', written by fulfillment).
 * One query, org-scoped. Errors/missing rows degrade to an empty map — the
 * feed then falls back to the generic "Order" label rather than breaking.
 * Exported for unit tests.
 */
export async function resolveOrderNumbers(
  ctx: ServiceContext,
  orderRequestIds: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (orderRequestIds.length === 0) return map;
  const { data, error } = await ctx.supabase
    .from('order_requests')
    .select('id, order_number')
    .eq('organization_id', ctx.organizationId)
    .in('id', orderRequestIds);
  if (error) {
    console.error('activity: order_request number lookup failed', { error: error.message });
    return map;
  }
  for (const r of (data ?? []) as Array<{ id: string; order_number: number | null }>) {
    const n = formatOrderNumber(r.order_number);
    if (n) map.set(r.id, n);
  }
  return map;
}

/**
 * Batch-resolves return ids → their return_number (reference_type='return').
 * Same shape/degrade-on-error contract as resolveOrderNumbers. Exported for
 * unit tests.
 */
export async function resolveReturnNumbers(
  ctx: ServiceContext,
  returnIds: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (returnIds.length === 0) return map;
  const { data, error } = await ctx.supabase
    .from('returns')
    .select('id, return_number')
    .eq('organization_id', ctx.organizationId)
    .in('id', returnIds);
  if (error) {
    console.error('activity: return number lookup failed', { error: error.message });
    return map;
  }
  for (const r of (data ?? []) as Array<{ id: string; return_number: string | null }>) {
    if (r.return_number) map.set(r.id, r.return_number);
  }
  return map;
}

/**
 * Batch-resolves bundle ids → their name (reference_type='bundle', written by
 * assembly/distribution). Same shape/degrade-on-error contract as
 * resolveOrderNumbers. Exported for unit tests.
 */
export async function resolveBundleNames(
  ctx: ServiceContext,
  bundleIds: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (bundleIds.length === 0) return map;
  const { data, error } = await ctx.supabase
    .from('bundles')
    .select('id, name')
    .eq('organization_id', ctx.organizationId)
    .in('id', bundleIds);
  if (error) {
    console.error('activity: bundle name lookup failed', { error: error.message });
    return map;
  }
  for (const r of (data ?? []) as Array<{ id: string; name: string | null }>) {
    if (r.name) map.set(r.id, r.name);
  }
  return map;
}

/**
 * Runs all three reference-label batch resolvers in parallel and merges them
 * into one id → label map. Each resolver already no-ops (no query) on an
 * empty id list, so types absent from this page's movements cost nothing.
 * cycle_count has no cheap display number (the table carries no display
 * field) — it's intentionally NOT queried here; those events fall back to
 * the generic type label in the UI while still linking to a known route.
 * purchase_order/rental resolvers were removed (Movement/Activity P1 review
 * follow-up): no writer ever sets those reference_types on stock_movements,
 * so the equivalent purchase_order resolver here only ever received an empty
 * id list — dead weight, not forward-compat. See the doc-comment on
 * `@/lib/activity-references` for the "unrecognized type degrades to a
 * title-cased label" contract a future type would hit the same way.
 */
async function resolveReferenceLabels(
  ctx: ServiceContext,
  idsByType: Record<string, string[]>,
): Promise<Map<string, string>> {
  const [order, ret, bundle] = await Promise.all([
    resolveOrderNumbers(ctx, idsByType.order_request ?? []),
    resolveReturnNumbers(ctx, idsByType.return ?? []),
    resolveBundleNames(ctx, idsByType.bundle ?? []),
  ]);
  const merged = new Map<string, string>();
  for (const m of [order, ret, bundle]) {
    for (const [id, label] of m) merged.set(id, label);
  }
  return merged;
}

export class ActivityService {
  private constructor(private ctx: ServiceContext) {}

  static async forCurrentUser() {
    return new ActivityService(await withContext());
  }

  /**
   * Returns a unified, time-sorted activity feed for the given item:
   * stock movements + audit-log entries that reference the item via
   * metadata.entity_id.
   *
   * Movements and audit rows are capped SEPARATELY (movementLimit=`limit`,
   * auditLimit=half that) rather than merging both sources and slicing the
   * combined list to `limit` total. The old combined-slice approach let
   * audit rows (edits, archives, …) crowd real movements out of the result
   * whenever audits happened to be more numerous or more recent — the
   * Movements tab (which filters this feed to kind==='movement') could then
   * show FEWER than `limit` movements even when more existed. Capping each
   * source independently — and never re-slicing the merge — guarantees the
   * Movements tab always gets up to its full requested limit of real rows.
   */
  async forItem(
    itemId: string,
    limit = 30,
    opts: { before?: ActivityCursor } = {},
  ): Promise<ActivityEvent[]> {
    const movementLimit = limit;
    const auditLimit = auditLimitFor(limit);
    const { before } = opts;

    // "Load older" pagination (Movement/Activity P4 Task 2, composite keyset
    // per the P4 review fix): each kind gets its OWN `(created_at, id)`
    // boundary — never a single shared `created_at` — because movements and
    // audits are two independent queries with independently-sized caps
    // (movementLimit/auditLimit are otherwise untouched, so an older page
    // still guarantees up to the full movementLimit of movements regardless
    // of audit volume, same P1 invariant as the first page). The keyset
    // predicate is PostgREST's `.or(a,and(b,c))` form: "strictly before this
    // row in (created_at DESC, id DESC) order" — `created_at < X` covers
    // every row on a strictly older timestamp, `created_at = X AND id < Y`
    // covers the remaining rows AT that exact timestamp that sort after this
    // one. This is deliberately NOT `.lte('created_at', X)`: a page that's
    // ENTIRELY one timestamp (e.g. a bulk op) would then never advance —
    // every row would re-match forever. Building each query as a mutable
    // variable (rather than one long inline chain) so the filter can be
    // inserted conditionally without duplicating the rest of the chain.
    let movementsQuery = this.ctx.supabase
      .from('stock_movements')
      .select(
        'id, movement_type, quantity_change, previous_quantity, new_quantity, moved_quantity, from_location_id, to_location_id, reason, reference_type, reference_id, notes, created_at, user_id',
      )
      .eq('organization_id', this.ctx.organizationId)
      .eq('item_id', itemId);
    if (before?.movement) {
      const { createdAt, id } = before.movement;
      movementsQuery = movementsQuery.or(
        `created_at.lt.${createdAt},and(created_at.eq.${createdAt},id.lt.${id})`,
      );
    }
    // Secondary `.order('id', …)` makes the ordering a total order — without
    // it, rows sharing the exact same `created_at` come back in a
    // DB-implementation-defined (nondeterministic) order, which is exactly
    // what let the keyset boundary above skip/duplicate rows in the first
    // place. Same reasoning on the audit query below.
    movementsQuery = movementsQuery
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(movementLimit);

    let auditQuery = this.ctx.supabase
      .from('audit_logs')
      .select('id, event, metadata, created_at, user_id')
      .eq('organization_id', this.ctx.organizationId)
      // Extracted-text equality so Postgres can use the
      // audit_logs_org_entity_created_idx expression index added in
      // migration 0135. The previous `.contains(metadata, …)` form
      // forced a sequential scan because @> can't use a BTREE on
      // the extracted text path.
      .eq('metadata->>entity_id', itemId);
    if (before?.audit) {
      const { createdAt, id } = before.audit;
      auditQuery = auditQuery.or(
        `created_at.lt.${createdAt},and(created_at.eq.${createdAt},id.lt.${id})`,
      );
    }
    auditQuery = auditQuery
      // Movement-shadowing stock.* events (see MOVEMENT_SHADOWED_AUDIT_EVENTS
      // above) are excluded at the query layer so `auditLimit` caps real,
      // kept audit rows for the item feed — not slots that get thrown away
      // below. Same `.not(col, 'in', '(...)')` shape as po-imports.ts.
      .not('event', 'in', `(${MOVEMENT_SHADOWED_AUDIT_EVENTS.join(',')})`)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(auditLimit);

    const [movementsRes, auditRes] = await Promise.all([movementsQuery, auditQuery]);

    // Defensive re-cap in JS: `.limit()` above already bounds each result at
    // the query layer, but slicing here again keeps the separate-caps
    // guarantee explicit regardless of the query layer's behavior.
    // This is also the ONLY place legacy lifecycle-reason rows (see
    // LIFECYCLE_REASON_MOVEMENTS) get filtered out — deliberately not at the
    // query layer, since `reason` is nullable and a `.not(col, 'in', ...)`
    // there would silently drop every null-reason movement too (see the
    // comment on LIFECYCLE_REASON_MOVEMENTS above). Filtering BEFORE slicing
    // to movementLimit ensures a legacy row can never occupy one of the
    // slots meant for a real movement.
    const movementRows = (movementsRes.data ?? [])
      .filter((m) => !LIFECYCLE_REASON_MOVEMENTS.includes(m.reason as string))
      .slice(0, movementLimit);
    // Belt-and-suspenders for the `.not(...)` filter above: filter out any
    // movement-shadowed stock.* row BEFORE slicing to auditLimit, so a
    // shadowed row can never occupy one of the slots meant for a real audit
    // event even if the query-layer filter is ever bypassed (e.g. a future
    // refactor of this query, or a test harness that doesn't evaluate
    // `.not()`). Filtering after the slice would let shadowed rows silently
    // crowd out real ones, under-filling the cap.
    const auditRows = (auditRes.data ?? [])
      .filter((a) => !MOVEMENT_SHADOWED_AUDIT_EVENTS.includes(a.event as string))
      .slice(0, auditLimit);

    const userIds = new Set<string>();
    for (const m of movementRows) {
      const uid = m.user_id as string | null;
      if (uid) userIds.add(uid);
    }
    for (const a of auditRows) {
      const uid = a.user_id as string | null;
      if (uid) userIds.add(uid);
    }

    // Pre-0231 receipt rows (reason='receipt_line', notes=receipt uuid):
    // resolve to PO numbers in one extra query so the feed reads 'PO {n}'
    // instead of the internal label. Runs alongside the profile lookup.
    const receiptIdsPromise = resolveReceiptPoNumbers(
      this.ctx,
      collectReceiptLineIds(
        movementRows.map((m) => ({
          reason: (m.reason as string | null) ?? null,
          notes: (m.notes as string | null) ?? null,
        })),
      ),
    );

    // Clickable source links (Issue 4): group this page's reference ids by
    // type so each resolver runs ONE batched query, same pattern as the
    // receipt→PO lookup above.
    const idsByType: Record<string, string[]> = {};
    for (const m of movementRows) {
      const rt = (m.reference_type as string | null) ?? null;
      const rid = (m.reference_id as string | null) ?? null;
      if (rt && rid) (idsByType[rt] ??= []).push(rid);
    }
    const referenceLabelsPromise = resolveReferenceLabels(this.ctx, idsByType);

    const profiles = new Map<string, { name: string; email: string | null }>();
    if (userIds.size > 0) {
      const { data } = await this.ctx.supabase
        .from('user_profiles')
        .select('id, full_name, email')
        .in('id', Array.from(userIds));
      for (const p of data ?? []) {
        profiles.set(p.id as string, {
          name: ((p.full_name as string | null) || (p.email as string | null) || 'Unknown').trim(),
          email: (p.email as string | null) ?? null,
        });
      }
    }
    const poNumberByReceipt = await receiptIdsPromise;
    const referenceLabelById = await referenceLabelsPromise;

    function actor(uid: string | null): { name: string; email: string | null } {
      if (!uid) return { name: 'System', email: null };
      return profiles.get(uid) ?? { name: 'Unknown', email: null };
    }

    const movementEvents: ActivityEvent[] = movementRows.map((m) => {
      const a = actor(m.user_id as string | null);
      const rawReason = (m.reason as string | null) ?? null;
      const rawNotes = (m.notes as string | null) ?? null;
      const isReceiptLine = rawReason === 'receipt_line';
      // Issue 3: `reason` and `notes` are carried through as TWO separate
      // fields (previously notes was silently dropped whenever reason was
      // non-empty). Exception: pre-0231 'receipt_line' rows stash the
      // internal receipt uuid in `notes` — that's an implementation detail,
      // never real user text, so it's masked to null here (it's already
      // been consumed above to produce the human 'PO {number}' reason).
      const reason = isReceiptLine
        ? receiptLineSummary(rawNotes, poNumberByReceipt)
        : rawReason;
      const notes = isReceiptLine ? null : rawNotes;
      const referenceType = (m.reference_type as string | null) ?? null;
      const referenceId = (m.reference_id as string | null) ?? null;
      const referenceLabel = referenceId ? (referenceLabelById.get(referenceId) ?? null) : null;
      return {
        id: `m:${m.id as string}`,
        kind: 'movement',
        type: m.movement_type as string,
        createdAt: m.created_at as string,
        delta: Number(m.quantity_change),
        previousQuantity: Number(m.previous_quantity),
        quantityAfter: Number(m.new_quantity),
        movedQuantity: m.moved_quantity == null ? null : Number(m.moved_quantity),
        fromLocationId: (m.from_location_id as string | null) ?? null,
        toLocationId: (m.to_location_id as string | null) ?? null,
        referenceType,
        referenceId,
        referenceLabel,
        reason,
        notes,
        // receipt_line rows carry a system-managed note (machine receipt
        // reference) — the RPC rejects edits, so never offer the affordance.
        noteEditable: !isReceiptLine,
        actor: a.name,
        actorEmail: a.email,
        metadata: null,
      };
    });

    const auditEvents: ActivityEvent[] = auditRows.map((row) => {
      const a = actor(row.user_id as string | null);
      const meta = (row.metadata as Record<string, unknown> | null) ?? {};
      const reason = (meta.reason as string | null) ?? null;
      return {
        id: `a:${row.id as string}`,
        kind: 'audit',
        type: row.event as string,
        createdAt: row.created_at as string,
        delta: null,
        previousQuantity: null,
        quantityAfter: null,
        movedQuantity: null,
        fromLocationId: null,
        toLocationId: null,
        referenceType: null,
        referenceId: null,
        referenceLabel: null,
        reason,
        notes: null,
        // Audit rows never carry an editable movement note.
        noteEditable: false,
        actor: a.name,
        actorEmail: a.email,
        metadata: meta,
      };
    });

    return [...movementEvents, ...auditEvents].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }
}

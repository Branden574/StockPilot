import 'server-only';

import { ServiceContext, withContext } from './context';

export interface ActivityEvent {
  id: string;
  kind: 'movement' | 'audit';
  type: string;
  createdAt: string;
  /** Movement: numeric delta. Audit: null. */
  delta: number | null;
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
  /** Free-text description suitable for a single-line event row. */
  summary: string | null;
  /** Display name of the actor (or "System") if attribution missing. */
  actor: string;
  actorEmail: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

export class ActivityService {
  private constructor(private ctx: ServiceContext) {}

  static async forCurrentUser() {
    return new ActivityService(await withContext());
  }

  /**
   * Returns a unified, time-sorted activity feed for the given item:
   * stock movements + audit-log entries that reference the item via
   * metadata.entity_id. Capped at `limit` total rows.
   */
  async forItem(itemId: string, limit = 30): Promise<ActivityEvent[]> {
    const halfLimit = Math.ceil(limit / 1.5);

    const [movementsRes, auditRes] = await Promise.all([
      this.ctx.supabase
        .from('stock_movements')
        .select(
          'id, movement_type, quantity_change, new_quantity, moved_quantity, from_location_id, to_location_id, reason, notes, created_at, user_id',
        )
        .eq('organization_id', this.ctx.organizationId)
        .eq('item_id', itemId)
        .order('created_at', { ascending: false })
        .limit(halfLimit),
      this.ctx.supabase
        .from('audit_logs')
        .select('id, event, metadata, created_at, user_id')
        .eq('organization_id', this.ctx.organizationId)
        // Extracted-text equality so Postgres can use the
        // audit_logs_org_entity_created_idx expression index added in
        // migration 0135. The previous `.contains(metadata, …)` form
        // forced a sequential scan because @> can't use a BTREE on
        // the extracted text path.
        .eq('metadata->>entity_id', itemId)
        .order('created_at', { ascending: false })
        .limit(halfLimit),
    ]);

    const userIds = new Set<string>();
    for (const m of movementsRes.data ?? []) {
      const uid = m.user_id as string | null;
      if (uid) userIds.add(uid);
    }
    for (const a of auditRes.data ?? []) {
      const uid = a.user_id as string | null;
      if (uid) userIds.add(uid);
    }

    // Pre-0231 receipt rows (reason='receipt_line', notes=receipt uuid):
    // resolve to PO numbers in one extra query so the feed reads 'PO {n}'
    // instead of the internal label. Runs alongside the profile lookup.
    const receiptIdsPromise = resolveReceiptPoNumbers(
      this.ctx,
      collectReceiptLineIds(
        (movementsRes.data ?? []).map((m) => ({
          reason: (m.reason as string | null) ?? null,
          notes: (m.notes as string | null) ?? null,
        })),
      ),
    );

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

    function actor(uid: string | null): { name: string; email: string | null } {
      if (!uid) return { name: 'System', email: null };
      return profiles.get(uid) ?? { name: 'Unknown', email: null };
    }

    const movementEvents: ActivityEvent[] = (movementsRes.data ?? []).map((m) => {
      const a = actor(m.user_id as string | null);
      const rawReason = (m.reason as string | null) ?? null;
      const summary =
        rawReason === 'receipt_line'
          ? receiptLineSummary((m.notes as string | null) ?? null, poNumberByReceipt)
          : (rawReason ?? (m.notes as string | null));
      return {
        id: `m:${m.id as string}`,
        kind: 'movement',
        type: m.movement_type as string,
        createdAt: m.created_at as string,
        delta: Number(m.quantity_change),
        quantityAfter: Number(m.new_quantity),
        movedQuantity: m.moved_quantity == null ? null : Number(m.moved_quantity),
        fromLocationId: (m.from_location_id as string | null) ?? null,
        toLocationId: (m.to_location_id as string | null) ?? null,
        summary,
        actor: a.name,
        actorEmail: a.email,
      };
    });

    const auditEvents: ActivityEvent[] = (auditRes.data ?? []).map((row) => {
      const a = actor(row.user_id as string | null);
      const meta = (row.metadata as Record<string, unknown> | null) ?? {};
      const reason = (meta.reason as string | null) ?? null;
      return {
        id: `a:${row.id as string}`,
        kind: 'audit',
        type: row.event as string,
        createdAt: row.created_at as string,
        delta: null,
        quantityAfter: null,
        movedQuantity: null,
        fromLocationId: null,
        toLocationId: null,
        summary: reason,
        actor: a.name,
        actorEmail: a.email,
      };
    });

    return [...movementEvents, ...auditEvents]
      .sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      )
      .slice(0, limit);
  }
}

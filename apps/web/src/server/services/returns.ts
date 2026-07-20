import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

import { audit } from './audit';
import { dispatchEvent } from './integration-events';
import {
  assertModuleEnabled,
  assertPermission,
  ServiceError,
  withContext,
  type ServiceContext,
} from './context';

/**
 * Returns / RMA service (Phase A foundation).
 *
 * The RMA lifecycle is a strict status machine:
 *
 *   requested ──approve──▶ approved ──receive──▶ received ──close──▶ closed
 *       │                     │
 *       ├──deny──▶ denied     └──cancel──▶ cancelled
 *       └──cancel──▶ cancelled
 *   approved ──cancel──▶ cancelled
 *
 * Every transition is guarded by ALLOWED_RETURN_TRANSITIONS and audited.
 *
 * INVENTORY CORRECTNESS (paramount):
 *   • createFromOrder REFUSES a non-returnable order (only 'completed' /
 *     legacy 'delivered' with fulfilled lines) and REFUSES a line quantity
 *     that exceeds the DURABLE budget — quantity_fulfilled MINUS
 *     order_request_lines.returned_quantity (0153) read straight off the
 *     immutable source line, NOT a SUM over mutable prior return rows. Because
 *     returned_quantity is incremented at apply-time and never reclaimed by a
 *     cancel/flip/delete, the cumulative returned quantity can never exceed what
 *     was fulfilled, even across many returns, and the old cancel→revive
 *     inflation hole is closed at the root. The DB constraint trigger
 *     return_lines_enforce_fulfilled_cap (0153) is the authoritative backstop;
 *     this service rejects early with a clear validation_error. It also enforces
 *     item identity: a return line may only restock the item that was fulfilled
 *     on its source line.
 *   • Inventory only moves when the return is RECEIVED, and it moves through
 *     the process_return_disposition RPC (0153), which is idempotent on each
 *     line's `applied` latch and itself flips received → closed in the same
 *     transaction as the stock write. The disposition can therefore never be
 *     applied twice.
 *
 * Gating: every method asserts the 'returns' module is enabled AND the caller
 * holds 'returns:manage' (owner + admin + manager). Reads are gated the same
 * way (the module is off-by-default, so a member of an org without returns
 * should not even enumerate them).
 */

/** Return lifecycle status (mirrors the 0153 returns.status CHECK). */
export type ReturnStatus =
  | 'requested'
  | 'approved'
  | 'received'
  | 'closed'
  | 'denied'
  | 'cancelled';

export type ReturnReasonCode =
  | 'damaged'
  | 'wrong_item'
  | 'end_of_year'
  | 'overage'
  | 'other';

export type ReturnDisposition = 'restock' | 'scrap';

/**
 * Legal `from → to` transitions for the staff RMA flow. Terminal states
 * (closed / denied / cancelled) have no outbound edges. `received → closed`
 * is the only edge that mutates inventory (it runs the disposition RPC).
 */
export const ALLOWED_RETURN_TRANSITIONS: Record<ReturnStatus, readonly ReturnStatus[]> = {
  requested: ['approved', 'denied', 'cancelled'],
  approved: ['received', 'cancelled'],
  received: ['closed'],
  closed: [],
  denied: [],
  cancelled: [],
};

/** A `returns` row as the service hands it back. */
export interface ReturnRow {
  id: string;
  organization_id: string;
  order_request_id: string;
  return_number: string | null;
  status: ReturnStatus;
  source: 'internal' | 'requester';
  reason_code: ReturnReasonCode | null;
  notes: string | null;
  denial_reason: string | null;
  requested_by: string | null;
  requester_email: string | null;
  requester_name: string | null;
  approved_by: string | null;
  approved_at: string | null;
  received_by: string | null;
  received_at: string | null;
  closed_by: string | null;
  closed_at: string | null;
  denied_by: string | null;
  denied_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ReturnLineRow {
  id: string;
  return_id: string;
  organization_id: string;
  order_request_line_id: string;
  item_id: string;
  quantity: number;
  disposition: ReturnDisposition;
  applied: boolean;
  created_at: string;
}

export interface ReturnWithLines extends ReturnRow {
  lines: ReturnLineRow[];
}

export interface ListReturnsFilters {
  status?: ReturnStatus | ReturnStatus[];
  orderRequestId?: string;
}

/** A still-returnable source line on a fulfilled order (drives the create dialog). */
export interface ReturnableLine {
  orderRequestLineId: string;
  itemId: string;
  itemName: string | null;
  itemSku: string | null;
  quantityFulfilled: number;
  /** Durable budget: quantity_fulfilled - order_request_lines.returned_quantity. */
  quantityRemaining: number;
}

const createLineSchema = z.object({
  orderRequestLineId: z.string().uuid(),
  quantity: z.number().positive(),
  disposition: z.enum(['restock', 'scrap']),
  // Optional item identity assertion. The return ALWAYS restocks the item that
  // was fulfilled on the source line (the service stamps item_id from the order
  // line, never from the client). If a caller passes itemId, it must match the
  // source line's item — a mismatch is rejected rather than silently coerced, so
  // no path can restock a different item than the one fulfilled.
  itemId: z.string().uuid().optional(),
});

const createFromOrderSchema = z.object({
  reasonCode: z.enum(['damaged', 'wrong_item', 'end_of_year', 'overage', 'other']).optional(),
  notes: z.string().max(2000).optional(),
  lines: z.array(createLineSchema).min(1),
});

export type CreateFromOrderInput = z.infer<typeof createFromOrderSchema>;

/** Returnable order statuses: a fully-fulfilled 'completed' order, or the
 * legacy 'delivered' status some older orders still carry. */
const RETURNABLE_ORDER_STATUSES = new Set<string>(['completed', 'delivered']);

export class RMAService {
  constructor(private readonly ctx: ServiceContext) {}

  static async forCurrentUser() {
    return new RMAService(await withContext());
  }

  /** Build from a ServiceContext resolved by `withApiContext` in an API route. */
  static forApiContext(ctx: ServiceContext) {
    return new RMAService(ctx);
  }

  /** Both gates, applied at the top of every method. */
  private gate() {
    assertModuleEnabled(this.ctx, 'returns');
    assertPermission(this.ctx, 'returns:manage');
  }

  // ── Reads ────────────────────────────────────────────────────────────

  async list(filters: ListReturnsFilters = {}): Promise<ReturnRow[]> {
    this.gate();

    let query = this.ctx.supabase
      .from('returns')
      .select('*')
      .eq('organization_id', this.ctx.organizationId)
      .order('created_at', { ascending: false });

    if (filters.orderRequestId) {
      query = query.eq('order_request_id', filters.orderRequestId);
    }
    if (filters.status) {
      const statuses = Array.isArray(filters.status) ? filters.status : [filters.status];
      query = query.in('status', statuses);
    }

    const { data, error } = await query;
    if (error) throw new ServiceError('internal_error', error.message);
    return (data as ReturnRow[] | null) ?? [];
  }

  async get(id: string): Promise<ReturnWithLines> {
    this.gate();

    const { data: header, error: headerError } = await this.ctx.supabase
      .from('returns')
      .select('*')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .maybeSingle();
    if (headerError) throw new ServiceError('internal_error', headerError.message);
    if (!header) throw new ServiceError('not_found', 'Return not found.');

    const { data: lines, error: linesError } = await this.ctx.supabase
      .from('return_lines')
      .select('*')
      .eq('organization_id', this.ctx.organizationId)
      .eq('return_id', id)
      .order('created_at', { ascending: true });
    if (linesError) throw new ServiceError('internal_error', linesError.message);

    return {
      ...(header as ReturnRow),
      lines: (lines as ReturnLineRow[] | null) ?? [],
    };
  }

  /**
   * The returnable lines for a fulfilled order, with the remaining returnable
   * quantity per source line. Remaining is the DURABLE budget read directly off
   * the source line: quantity_fulfilled - returned_quantity (0153). It is NOT a
   * SUM over prior return rows — returned_quantity is incremented at apply-time
   * inside process_return_disposition and lives on the immutable order line, so
   * a cancelled/flipped/deleted return header can never reclaim budget that
   * stock already moved against. Drives the "Create return" dialog: it pre-fills
   * each line to its remaining-returnable default and caps the input. Returns an
   * empty array (not an error) when the order is not returnable, so the caller
   * can simply hide the affordance.
   *
   * This mirrors the createFromOrder over-return validation so the UI and the
   * write path agree on what's returnable; the DB cap trigger remains the
   * authoritative backstop.
   */
  async returnableLinesForOrder(orderRequestId: string): Promise<ReturnableLine[]> {
    this.gate();

    const { data: order, error: orderError } = await this.ctx.supabase
      .from('order_requests')
      .select('id, status')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', orderRequestId)
      .maybeSingle();
    if (orderError) throw new ServiceError('internal_error', orderError.message);
    if (!order) return [];
    if (!RETURNABLE_ORDER_STATUSES.has((order as { status: string }).status)) return [];

    const { data: orderLines, error: linesError } = await this.ctx.supabase
      .from('order_request_lines')
      .select(
        `id, item_id, quantity_fulfilled, returned_quantity,
         item:inventory_items!item_id (id, name, sku)`,
      )
      .eq('order_request_id', orderRequestId);
    if (linesError) throw new ServiceError('internal_error', linesError.message);

    const lineRows = (orderLines as Array<{
      id: string;
      item_id: string;
      quantity_fulfilled: number | null;
      returned_quantity: number | null;
      item:
        | { id: string; name: string; sku: string | null }
        | { id: string; name: string; sku: string | null }[]
        | null;
    }> | null) ?? [];

    const out: ReturnableLine[] = [];
    for (const l of lineRows) {
      const fulfilled = Number(l.quantity_fulfilled) || 0;
      if (fulfilled <= 0) continue;
      // Durable budget: remaining = fulfilled - already-applied returned units.
      const remaining = fulfilled - (Number(l.returned_quantity) || 0);
      if (remaining <= 0) continue;
      const item = Array.isArray(l.item) ? (l.item[0] ?? null) : (l.item ?? null);
      out.push({
        orderRequestLineId: l.id,
        itemId: l.item_id,
        itemName: item?.name ?? null,
        itemSku: item?.sku ?? null,
        quantityFulfilled: fulfilled,
        quantityRemaining: remaining,
      });
    }
    return out;
  }

  // ── Create ───────────────────────────────────────────────────────────

  /**
   * Create a 'requested' return from a fulfilled order. Validates the order is
   * returnable and that every requested line quantity is within the DURABLE
   * remaining budget read directly off the source line: quantity_fulfilled -
   * returned_quantity (0153). returned_quantity is incremented at apply-time
   * inside process_return_disposition and lives on the immutable order line, so
   * the cap can NEVER be inflated by cancelling/flipping/deleting a prior return
   * header (the old SUM-over-live-return-rows aggregate was the inflation hole).
   * Also enforces item identity (the source line's item is the only item that
   * can be returned) and the status gate (order completed/delivered). Rejects
   * over-quantity / non-returnable / cross-item with a `validation_error` BEFORE
   * writing anything; the DB cap trigger remains the authoritative backstop.
   */
  async createFromOrder(
    orderRequestId: string,
    input: CreateFromOrderInput,
  ): Promise<ReturnWithLines> {
    this.gate();

    const parsed = createFromOrderSchema.parse(input);

    // 1. The order must exist in this org and be returnable.
    const { data: order, error: orderError } = await this.ctx.supabase
      .from('order_requests')
      .select('id, organization_id, status')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', orderRequestId)
      .maybeSingle();
    if (orderError) throw new ServiceError('internal_error', orderError.message);
    if (!order) throw new ServiceError('not_found', 'Order not found.');

    const orderStatus = (order as { status: string }).status;
    if (!RETURNABLE_ORDER_STATUSES.has(orderStatus)) {
      throw new ServiceError(
        'validation_error',
        'Only completed (or delivered) orders can be returned.',
      );
    }

    // 2. Load the order's fulfilled lines so we can validate each requested
    //    return line belongs to the order and is within the DURABLE budget.
    //    We read returned_quantity (0153) directly off each source line — this
    //    is the running total of units ALREADY APPLIED against the line and is
    //    the authoritative consumed-budget number. We do NOT sum prior return
    //    rows: that aggregate is freed by a cancel/delete and was the inflation
    //    hole the durable budget closes.
    const lineIds = parsed.lines.map((l) => l.orderRequestLineId);
    // NB: order_request_lines has NO organization_id column (RLS gates it via
    // the parent order_requests, 0044/0078). Org isolation here rests on the
    // in-org parent check above (line 'order' verified .eq(organization_id)),
    // order_request_lines RLS being org-scoped through that parent, AND the
    // per-line belonging re-check below (orderLine.order_request_id === id).
    const { data: orderLines, error: orderLinesError } = await this.ctx.supabase
      .from('order_request_lines')
      .select('id, order_request_id, item_id, quantity_fulfilled, returned_quantity')
      .eq('order_request_id', orderRequestId)
      .in('id', lineIds);
    if (orderLinesError) throw new ServiceError('internal_error', orderLinesError.message);

    const orderLineById = new Map<
      string,
      {
        id: string;
        order_request_id: string;
        item_id: string;
        quantity_fulfilled: number;
        returned_quantity: number;
      }
    >();
    for (const ol of (orderLines as Array<{
      id: string;
      order_request_id: string;
      item_id: string;
      quantity_fulfilled: number | null;
      returned_quantity: number | null;
    }> | null) ?? []) {
      orderLineById.set(ol.id, {
        id: ol.id,
        order_request_id: ol.order_request_id,
        item_id: ol.item_id,
        quantity_fulfilled: Number(ol.quantity_fulfilled) || 0,
        returned_quantity: Number(ol.returned_quantity) || 0,
      });
    }

    // 3. Validate each requested line against the durable budget. Also reject
    //    duplicate source lines in one request (the DB UNIQUE(return_id,
    //    order_request_line_id) would reject it, but a clear early error is
    //    friendlier). NOTE: a SINGLE request can still over-return within itself
    //    if two lines target the same source line — the duplicate guard prevents
    //    that; the budget bounds the cross-request aggregate.
    const seenLineIds = new Set<string>();
    for (const line of parsed.lines) {
      if (seenLineIds.has(line.orderRequestLineId)) {
        throw new ServiceError(
          'validation_error',
          'Each order line may appear at most once in a return.',
        );
      }
      seenLineIds.add(line.orderRequestLineId);

      const orderLine = orderLineById.get(line.orderRequestLineId);
      if (!orderLine || orderLine.order_request_id !== orderRequestId) {
        throw new ServiceError(
          'validation_error',
          'One or more lines do not belong to this order.',
        );
      }
      // Item identity: the only item that may be returned for a source line is
      // the item that was fulfilled on it. The service always STAMPS item_id
      // from the order line (below), so substitution is structurally impossible
      // here; but if a caller supplied an itemId we reject a mismatch rather
      // than silently coerce, mirroring the DB return_item_mismatch trigger.
      if (line.itemId && line.itemId !== orderLine.item_id) {
        throw new ServiceError(
          'validation_error',
          'A return line item must match the item fulfilled on that order line.',
          { orderRequestLineId: line.orderRequestLineId },
        );
      }
      if (orderLine.quantity_fulfilled <= 0) {
        throw new ServiceError(
          'validation_error',
          'You can only return lines that were fulfilled.',
        );
      }
      // DURABLE budget: remaining = quantity_fulfilled - returned_quantity,
      // read straight off the immutable source line. This bounds over-return
      // ACROSS multiple returns (returned_quantity accumulates at apply-time and
      // is never reclaimed by a cancel/flip/delete).
      const remaining = orderLine.quantity_fulfilled - orderLine.returned_quantity;
      if (line.quantity > remaining) {
        throw new ServiceError(
          'validation_error',
          `Cannot return ${line.quantity}; only ${remaining} of ${orderLine.quantity_fulfilled} fulfilled remain returnable for this line.`,
          { orderRequestLineId: line.orderRequestLineId, remaining, requested: line.quantity },
        );
      }
    }

    // 5. Insert the 'requested' return header + lines. The DB constraint
    //    trigger is the authoritative cap; this validation is the friendly
    //    early reject.
    const { data: inserted, error: insertError } = await this.ctx.supabase
      .from('returns')
      .insert({
        organization_id: this.ctx.organizationId,
        order_request_id: orderRequestId,
        return_number: this.generateReturnNumber(),
        status: 'requested',
        source: 'internal',
        reason_code: parsed.reasonCode ?? null,
        notes: parsed.notes ?? null,
        requested_by: this.ctx.userId,
      })
      .select('*')
      .single();
    if (insertError) throw new ServiceError('internal_error', insertError.message);
    const header = inserted as ReturnRow;

    const lineRows = parsed.lines.map((line) => {
      const orderLine = orderLineById.get(line.orderRequestLineId)!;
      return {
        return_id: header.id,
        organization_id: this.ctx.organizationId,
        order_request_line_id: line.orderRequestLineId,
        item_id: orderLine.item_id,
        quantity: line.quantity,
        disposition: line.disposition,
      };
    });

    const { data: insertedLines, error: linesError } = await this.ctx.supabase
      .from('return_lines')
      .insert(lineRows)
      .select('*');
    if (linesError) {
      // The DB cap trigger raises 'return_exceeds_fulfilled' under a concurrent
      // race that slipped past the read-time check above. Surface it as a
      // validation error rather than a 500.
      const msg = linesError.message ?? '';
      if (msg.includes('return_exceeds_fulfilled')) {
        throw new ServiceError(
          'validation_error',
          'This return would exceed the fulfilled quantity for one or more lines.',
        );
      }
      throw new ServiceError('internal_error', msg);
    }

    await audit(
      {
        event: 'return.created',
        entityType: 'return',
        entityId: header.id,
        extra: {
          orderRequestId,
          returnNumber: header.return_number,
          lineCount: lineRows.length,
        },
      },
      this.ctx,
    );
    void dispatchEvent(this.ctx.organizationId, 'return.created', {
      id: header.id,
      returnNumber: header.return_number,
      orderNumber: typeof orderRequestId === 'string' ? orderRequestId.slice(0, 8).toUpperCase() : null,
    });

    // Zendesk shell: surface a new return as a ticket (best-effort; dormant
    // until a zendesk connection is active — the drainer skips otherwise).
    try {
      await this.ctx.supabase.rpc('publish_outbox', {
        p_org_id: this.ctx.organizationId,
        p_topic: 'return.created',
        p_aggregate_type: 'return',
        p_aggregate_id: header.id,
        p_payload: {
          returnId: header.id,
          returnNumber: header.return_number,
          orderRequestId,
        },
        p_dedupe_key: `return.created:${header.id}`,
      });
    } catch {
      /* best-effort: a publish failure must not fail the created return */
    }

    return { ...header, lines: (insertedLines as ReturnLineRow[] | null) ?? [] };
  }

  // ── Lifecycle transitions ──────────────────────────────────────────────

  async approve(id: string): Promise<ReturnRow> {
    this.gate();
    const current = await this.requireReturn(id);
    this.assertTransition(current.status, 'approved');

    const updated = await this.applyTransition(id, current.status, {
      status: 'approved',
      approved_by: this.ctx.userId,
      approved_at: new Date().toISOString(),
    });

    await audit(
      { event: 'return.approved', entityType: 'return', entityId: id },
      this.ctx,
    );
    void dispatchEvent(this.ctx.organizationId, 'return.approved', {
      id,
      returnNumber: current.return_number,
      actorId: this.ctx.userId,
    });
    return updated;
  }

  async deny(id: string, reason?: string | null): Promise<ReturnRow> {
    this.gate();
    const current = await this.requireReturn(id);
    this.assertTransition(current.status, 'denied');

    // Write the reason to the dedicated `denial_reason` column (0154) — NOT
    // `notes`, which would clobber any creation-time notes from createFromOrder.
    const updated = await this.applyTransition(id, current.status, {
      status: 'denied',
      denied_by: this.ctx.userId,
      denied_at: new Date().toISOString(),
      ...(reason ? { denial_reason: reason } : {}),
    });

    await audit(
      { event: 'return.denied', entityType: 'return', entityId: id, reason: reason ?? undefined },
      this.ctx,
    );
    void dispatchEvent(this.ctx.organizationId, 'return.denied', {
      id,
      returnNumber: current.return_number,
      reason: reason ?? undefined,
      actorId: this.ctx.userId,
    });
    return updated;
  }

  /**
   * approved → received. Does NOT touch inventory — the disposition is applied
   * at `close()` via the process_return_disposition RPC, which the 0153
   * migration guards on status='received'. Keeping receive a pure transition
   * means a received-but-not-yet-closed return can be reviewed before any stock
   * moves.
   */
  async receive(id: string): Promise<ReturnRow> {
    this.gate();
    const current = await this.requireReturn(id);
    this.assertTransition(current.status, 'received');

    const updated = await this.applyTransition(id, current.status, {
      status: 'received',
      received_by: this.ctx.userId,
      received_at: new Date().toISOString(),
    });

    await audit(
      { event: 'return.received', entityType: 'return', entityId: id },
      this.ctx,
    );
    return updated;
  }

  /**
   * received → closed. This is the ONLY edge that moves inventory: it calls the
   * process_return_disposition RPC (0153), which restocks ('return', +qty) or
   * scraps ('loss', -qty) each not-yet-applied line, latches it `applied`, and
   * flips the return to 'closed' in the SAME transaction as the stock write.
   * The RPC is idempotent on the per-line latch and itself guards
   * status='received', so the disposition can never be applied twice.
   *
   * On a successful close we publish a `return.closed` outbox event (Phase B)
   * so the QuickBooks connector can book a JournalEntry. Mirrors
   * receiving.ts:188 (receipt.posted → Bill): the payload carries summary
   * fields only (no line items — the connector rehydrates return_lines by
   * aggregate id), and a stable dedupe key keeps a replayed close from queueing
   * a duplicate export. Best-effort, like receipt.posted: a publish failure must
   * NOT undo a close whose inventory the RPC already moved.
   */
  async close(id: string): Promise<ReturnRow> {
    this.gate();
    const current = await this.requireReturn(id);
    this.assertTransition(current.status, 'closed');

    const { data, error } = await this.ctx.supabase.rpc('process_return_disposition', {
      p_return_id: id,
    });
    if (error) {
      const msg = error.message ?? '';
      if (msg.includes('return_not_found'))
        throw new ServiceError('not_found', 'Return not found.');
      if (msg.includes('forbidden'))
        throw new ServiceError('forbidden', 'You do not have permission to close this return.');
      if (msg.includes('invalid_status_transition'))
        throw new ServiceError(
          'validation_error',
          'This return can no longer be closed (it must be received first).',
        );
      if (msg.includes('insufficient_stock'))
        throw new ServiceError(
          'validation_error',
          'Scrapping a return line would drive on-hand below zero.',
        );
      if (msg.includes('cross_org_item'))
        throw new ServiceError('forbidden', 'A return line references an item from another org.');
      throw new ServiceError('internal_error', msg);
    }

    const updated = data as ReturnRow;

    await audit(
      { event: 'return.closed', entityType: 'return', entityId: id },
      this.ctx,
    );

    // Publish return.closed for downstream connectors (QBO JournalEntry). The
    // payload total is informational (the connector recomputes from the lines
    // it rehydrates); we derive it here from each return line's quantity ×ⁿ the
    // source order line's unit_cost_at_request (0044) for the digest/summary.
    await this.publishReturnClosed(updated);

    void dispatchEvent(this.ctx.organizationId, 'return.closed', {
      id,
      returnNumber: updated.return_number,
      actorId: this.ctx.userId,
    });

    return updated;
  }

  /**
   * Best-effort publish of the `return.closed` outbox event. Computes the
   * line count + credit total from return_lines joined to their source order
   * lines (unit_cost_at_request). Failures are silently swallowed (NOT thrown,
   * and NOT reported) so they never undo a close whose disposition already
   * committed — exactly like the receipt.posted publish in receiving.ts. The
   * trade-off is no telemetry on a dropped publish; an unpublished close is
   * recoverable by re-closing or a manual outbox backfill.
   */
  private async publishReturnClosed(ret: ReturnRow): Promise<void> {
    try {
      const { data: lines, error: linesError } = await this.ctx.supabase
        .from('return_lines')
        .select(
          'quantity, order_request_line:order_request_lines!order_request_line_id (unit_cost_at_request)',
        )
        .eq('organization_id', this.ctx.organizationId)
        .eq('return_id', ret.id);
      if (linesError) return;

      const rows = (lines as Array<{
        quantity: number | null;
        order_request_line:
          | { unit_cost_at_request: number | null }
          | { unit_cost_at_request: number | null }[]
          | null;
      }> | null) ?? [];

      let total = 0;
      for (const row of rows) {
        const ol = Array.isArray(row.order_request_line)
          ? (row.order_request_line[0] ?? null)
          : (row.order_request_line ?? null);
        total += (Number(row.quantity) || 0) * (Number(ol?.unit_cost_at_request) || 0);
      }

      await this.ctx.supabase.rpc('publish_outbox', {
        p_org_id: this.ctx.organizationId,
        p_topic: 'return.closed',
        p_aggregate_type: 'return',
        p_aggregate_id: ret.id,
        p_payload: {
          orderRequestId: ret.order_request_id,
          returnNumber: ret.return_number,
          lineCount: rows.length,
          total: Math.round((total + Number.EPSILON) * 100) / 100,
        },
        p_dedupe_key: `return.closed:${ret.id}`,
      });
    } catch {
      // Best-effort: a publish failure must not fail an already-committed close.
    }
  }

  /**
   * Cancel a return that has not yet been received. Cancellation is only legal
   * from 'requested' or 'approved' — once a return is 'received' it is on the
   * close-and-dispose path and cannot be cancelled (no inventory was moved
   * before close, so cancelling pre-receipt never strands stock).
   */
  async cancel(id: string): Promise<ReturnRow> {
    this.gate();
    const current = await this.requireReturn(id);
    this.assertTransition(current.status, 'cancelled');

    const updated = await this.applyTransition(id, current.status, {
      status: 'cancelled',
    });

    await audit(
      { event: 'return.cancelled', entityType: 'return', entityId: id },
      this.ctx,
    );
    return updated;
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private async requireReturn(id: string): Promise<ReturnRow> {
    const { data, error } = await this.ctx.supabase
      .from('returns')
      .select('*')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    if (!data) throw new ServiceError('not_found', 'Return not found.');
    return data as ReturnRow;
  }

  private assertTransition(from: ReturnStatus, to: ReturnStatus): void {
    if (!ALLOWED_RETURN_TRANSITIONS[from]?.includes(to)) {
      throw new ServiceError(
        'validation_error',
        `Cannot move a return from "${from}" to "${to}".`,
      );
    }
  }

  /**
   * Compare-and-swap the transition: only update the row if it is STILL in the
   * expected `from` status, so a concurrent transition can't be clobbered. A
   * zero-row update means the status moved under us → reject as illegal.
   */
  private async applyTransition(
    id: string,
    from: ReturnStatus,
    updates: Record<string, unknown>,
  ): Promise<ReturnRow> {
    const { data, error } = await this.ctx.supabase
      .from('returns')
      .update(updates)
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .eq('status', from)
      .select('*')
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    if (!data) {
      throw new ServiceError(
        'validation_error',
        'The return changed state during this request. Reload and try again.',
      );
    }
    return data as ReturnRow;
  }

  /**
   * Human-friendly RMA number. Not relied on for uniqueness (the row id is the
   * key); it's a display handle. Format: RMA-<yyyymmdd>-<6 hex>.
   */
  private generateReturnNumber(): string {
    return generateReturnNumber();
  }
}

/** Shared RMA-number generator (also used by the requester portal path). */
function generateReturnNumber(): string {
  const now = new Date();
  const ymd = now.toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.floor(Math.random() * 0xffffff)
    .toString(16)
    .padStart(6, '0')
    .toUpperCase();
  return `RMA-${ymd}-${rand}`;
}

// ── Requester-initiated return portal (PUBLIC, UNAUTHENTICATED) ──────────────

/**
 * Input the public `/returns/request/[token]` page POSTs. The token is the
 * per-order `order_requests.return_token` (0156); it is the ONLY authorization
 * the anonymous requester carries, so every field below is treated as hostile
 * and re-validated server-side against the order the token resolves to. The
 * client picks lines + quantities + a reason — but the service NEVER trusts the
 * quantities or the item identity: it stamps item_id from the source line and
 * caps each quantity by the DURABLE budget read straight off the order line.
 */
const requesterLineSchema = z.object({
  orderRequestLineId: z.string().uuid(),
  quantity: z.number().positive(),
});

const requesterReturnSchema = z.object({
  reasonCode: z.enum(['damaged', 'wrong_item', 'end_of_year', 'overage', 'other']).optional(),
  notes: z.string().max(2000).optional(),
  lines: z.array(requesterLineSchema).min(1).max(100),
});

export type RequesterReturnInput = z.infer<typeof requesterReturnSchema>;

/** The minimal, token-scoped order context the public page renders. */
export interface RequesterReturnOrderContext {
  orderRequestId: string;
  organizationId: string;
  requesterEmail: string | null;
  requesterName: string | null;
  lines: ReturnableLine[];
}

/** The order-row projection both requester-return loaders resolve first. */
interface RequesterReturnOrderRow {
  id: string;
  organization_id: string;
  status: string;
  requester_email: string | null;
  requester_name: string | null;
}

/**
 * Shared second half of both requester-return loaders (token + B2B portal):
 * given an ALREADY-AUTHORIZED order row (the caller proved the requester may
 * act on this order — via return_token, or via the portal customer scope),
 * verify it is returnable, verify the org still has the returns module
 * enabled, and load the still-returnable lines with their DURABLE budget
 * (quantity_fulfilled - returned_quantity, read straight off each source
 * line). Returns null on any closed door — both public surfaces render that
 * as a 404-shaped answer so nothing about the org leaks.
 */
async function buildRequesterReturnContext(
  admin: SupabaseClient,
  order: RequesterReturnOrderRow,
): Promise<RequesterReturnOrderContext | null> {
  if (!RETURNABLE_ORDER_STATUSES.has(order.status)) return null;

  // The org must still have the returns module enabled. Mirror the public
  // order-request route's direct organization_modules check (no ServiceContext
  // on these external paths). 404 (return null) rather than 403 so we don't
  // leak that the org exists with the feature off.
  const { data: modRow, error: modErr } = await admin
    .from('organization_modules')
    .select('module_id')
    .eq('organization_id', order.organization_id)
    .eq('module_id', 'returns')
    .eq('enabled', true)
    .maybeSingle();
  if (modErr || !modRow) return null;

  const { data: orderLines, error: linesError } = await admin
    .from('order_request_lines')
    .select(
      `id, item_id, quantity_fulfilled, returned_quantity,
       item:inventory_items!item_id (id, name, sku)`,
    )
    .eq('order_request_id', order.id);
  if (linesError) return null;

  const lineRows = (orderLines as Array<{
    id: string;
    item_id: string;
    quantity_fulfilled: number | null;
    returned_quantity: number | null;
    item:
      | { id: string; name: string; sku: string | null }
      | { id: string; name: string; sku: string | null }[]
      | null;
  }> | null) ?? [];

  const lines: ReturnableLine[] = [];
  for (const l of lineRows) {
    const fulfilled = Number(l.quantity_fulfilled) || 0;
    if (fulfilled <= 0) continue;
    const remaining = fulfilled - (Number(l.returned_quantity) || 0);
    if (remaining <= 0) continue;
    const item = Array.isArray(l.item) ? (l.item[0] ?? null) : (l.item ?? null);
    lines.push({
      orderRequestLineId: l.id,
      itemId: l.item_id,
      itemName: item?.name ?? null,
      itemSku: item?.sku ?? null,
      quantityFulfilled: fulfilled,
      quantityRemaining: remaining,
    });
  }

  return {
    orderRequestId: order.id,
    organizationId: order.organization_id,
    requesterEmail: order.requester_email,
    requesterName: order.requester_name,
    lines,
  };
}

/**
 * Resolve a `return_token` to its single order's still-returnable lines, using
 * the service-role admin client (the requester has no JWT). Returns null when
 * the token is unknown/expired, the order is not returnable, or the org no
 * longer has the `returns` module enabled — every one of those is a closed-door
 * 404 on the public surface so we never leak which tokens are live. The token
 * scopes to EXACTLY ONE order (partial-unique index, 0156); we select by token
 * and read only that row's lines, so no cross-order data is ever exposed.
 *
 * `quantityRemaining` is the DURABLE budget (quantity_fulfilled -
 * returned_quantity) read directly off each source line — the same number the
 * staff path enforces. It is NOT a SUM over prior return rows.
 */
export async function loadRequesterReturnContext(
  admin: SupabaseClient,
  token: string,
): Promise<RequesterReturnOrderContext | null> {
  // A return_token is a uuid (0156). Reject anything that can't be one BEFORE
  // hitting the DB so a malformed token is a cheap 404, not a 500.
  if (!token || !/^[0-9a-fA-F-]{36}$/.test(token)) return null;

  const { data: order, error: orderError } = await admin
    .from('order_requests')
    .select('id, organization_id, status, requester_email, requester_name')
    .eq('return_token', token)
    .maybeSingle();
  if (orderError || !order) return null;

  return buildRequesterReturnContext(admin, order as RequesterReturnOrderRow);
}

/**
 * Resolve a B2B portal customer's OWN order to its still-returnable lines.
 * The portal principal is an external CUSTOMER (customer_users → NEVER
 * org_members), so this runs on the service-role admin client and the scope
 * (organizationId + customerId) MUST come from a server-resolved
 * PortalContext — never the client. The order lookup filters by id AND
 * organization_id AND customer_id, so a foreign or cross-customer order id
 * resolves to null (the action surfaces that as not_found; existence is
 * never leaked). Everything after the order row — returnable-status check,
 * returns-module gate, durable line budget — is the SAME shared
 * implementation the public token path uses.
 */
export async function loadPortalReturnContext(
  admin: SupabaseClient,
  scope: { organizationId: string; customerId: string; orderRequestId: string },
): Promise<RequesterReturnOrderContext | null> {
  // Same cheap pre-check as the token path: a malformed id is a 404 before
  // any query, not a 500.
  if (!scope.orderRequestId || !/^[0-9a-fA-F-]{36}$/.test(scope.orderRequestId)) return null;

  const { data: order, error: orderError } = await admin
    .from('order_requests')
    .select('id, organization_id, status, requester_email, requester_name')
    .eq('id', scope.orderRequestId)
    .eq('organization_id', scope.organizationId)
    .eq('customer_id', scope.customerId)
    .maybeSingle();
  if (orderError || !order) return null;

  return buildRequesterReturnContext(admin, order as RequesterReturnOrderRow);
}

/**
 * Create a `source='requester'`, `status='requested'` return from the public
 * portal. PUBLIC + UNAUTHENTICATED: the `token` is the only authorization, so
 * this RE-VALIDATES everything server-side against the order the token resolves
 * to — never trusting the client:
 *
 *   • The token must resolve to exactly one returnable order (else not_found).
 *   • Every submitted line must belong to THAT order (else validation_error).
 *   • Each quantity is capped by the DURABLE budget (quantity_fulfilled -
 *     returned_quantity) read straight off the source line — the same cap the
 *     staff path enforces. The DB cap trigger (0153) remains the authoritative
 *     backstop; this is the friendly early reject.
 *   • item_id is STAMPED from the source line (the client never chooses it), so
 *     a requester can never restock a different item than was fulfilled.
 *   • requester_email / requester_name are taken from the ORDER, not the client,
 *     so a stranger with a leaked token can't graft an arbitrary identity onto
 *     the return.
 *
 * It lands in the staff approval queue (status='requested'); no inventory moves
 * until a staff member approves + receives + closes it through the gated
 * RMAService. requested_by is null (no authenticated user). Uses the admin
 * client (RLS bypass) because the requester has no Supabase JWT.
 */
export async function createRequesterReturn(
  admin: SupabaseClient,
  token: string,
  input: RequesterReturnInput,
): Promise<{ id: string; returnNumber: string | null; organizationId: string }> {
  const parsed = requesterReturnSchema.parse(input);

  // 1. Re-resolve the token → order + returnable lines, server-side. This is
  //    the authoritative check; whatever the client rendered is irrelevant.
  const ctx = await loadRequesterReturnContext(admin, token);
  if (!ctx) {
    throw new ServiceError('not_found', 'This return link is invalid or has expired.');
  }

  return insertRequesterReturn(admin, ctx, parsed);
}

/**
 * B2B portal variant: same semantics as `createRequesterReturn` with the
 * order resolved via the PORTAL principal (server-resolved org + customer
 * scope) instead of a return token. Validation + insert are the ONE shared
 * implementation (`insertRequesterReturn`) — do not fork it.
 */
export async function createPortalReturn(
  admin: SupabaseClient,
  scope: { organizationId: string; customerId: string; orderRequestId: string },
  input: RequesterReturnInput,
): Promise<{ id: string; returnNumber: string | null; organizationId: string }> {
  const parsed = requesterReturnSchema.parse(input);

  const ctx = await loadPortalReturnContext(admin, scope);
  if (!ctx) {
    // Foreign org, another customer's order, unknown id, non-returnable
    // status, and module-off all collapse into ONE answer — no oracle.
    throw new ServiceError('not_found', 'This order could not be found.');
  }

  return insertRequesterReturn(admin, ctx, parsed);
}

/**
 * The shared requester-return core: validate the submitted lines against the
 * resolved order context (durable budget + belonging + no duplicate lines),
 * then insert the `status='requested'`, `source='requester'` header + lines.
 * Callers (public token path, B2B portal path) are responsible for HOW the
 * order context was authorized; everything from here down is identical.
 */
async function insertRequesterReturn(
  admin: SupabaseClient,
  ctx: RequesterReturnOrderContext,
  parsed: RequesterReturnInput,
): Promise<{ id: string; returnNumber: string | null; organizationId: string }> {
  const remainingByLine = new Map<string, ReturnableLine>();
  for (const l of ctx.lines) remainingByLine.set(l.orderRequestLineId, l);

  // 2. Validate each submitted line against the durable budget + belonging.
  const seen = new Set<string>();
  for (const line of parsed.lines) {
    if (seen.has(line.orderRequestLineId)) {
      throw new ServiceError(
        'validation_error',
        'Each order line may appear at most once in a return.',
      );
    }
    seen.add(line.orderRequestLineId);

    const src = remainingByLine.get(line.orderRequestLineId);
    if (!src) {
      throw new ServiceError(
        'validation_error',
        'One or more lines do not belong to this order or are no longer returnable.',
      );
    }
    if (line.quantity > src.quantityRemaining) {
      throw new ServiceError(
        'validation_error',
        `Cannot return ${line.quantity}; only ${src.quantityRemaining} of ${src.quantityFulfilled} fulfilled remain returnable for this line.`,
        {
          orderRequestLineId: line.orderRequestLineId,
          remaining: src.quantityRemaining,
          requested: line.quantity,
        },
      );
    }
  }

  // 3. Insert the 'requested' header. source='requester'; requester identity is
  //    copied from the ORDER, never the client. requested_by is null.
  const { data: inserted, error: insertError } = await admin
    .from('returns')
    .insert({
      organization_id: ctx.organizationId,
      order_request_id: ctx.orderRequestId,
      return_number: generateReturnNumber(),
      status: 'requested',
      source: 'requester',
      reason_code: parsed.reasonCode ?? null,
      notes: parsed.notes ?? null,
      requested_by: null,
      requester_email: ctx.requesterEmail,
      requester_name: ctx.requesterName,
    })
    .select('id, return_number, organization_id')
    .single();
  if (insertError || !inserted) {
    throw new ServiceError('internal_error', insertError?.message ?? 'Could not create return.');
  }
  const header = inserted as { id: string; return_number: string | null; organization_id: string };

  // 4. Insert the lines. item_id is STAMPED from the source line (the client's
  //    item choice is ignored entirely). The DB cap trigger backstops a race.
  const lineRows = parsed.lines.map((line) => {
    const src = remainingByLine.get(line.orderRequestLineId)!;
    return {
      return_id: header.id,
      organization_id: ctx.organizationId,
      order_request_line_id: line.orderRequestLineId,
      item_id: src.itemId,
      quantity: line.quantity,
      // Requester returns default to 'restock' — staff choose the real
      // disposition (restock vs scrap) at receive/close time. The requester
      // never decides whether goods are scrapped.
      disposition: 'restock' as const,
    };
  });

  const { error: linesError } = await admin.from('return_lines').insert(lineRows);
  if (linesError) {
    // Roll back the orphan header so a line-insert failure doesn't strand a
    // return with no lines (mirrors the public order-request route's pattern).
    await admin.from('returns').delete().eq('id', header.id);
    const msg = linesError.message ?? '';
    if (msg.includes('return_exceeds_fulfilled')) {
      throw new ServiceError(
        'validation_error',
        'This return would exceed the fulfilled quantity for one or more lines.',
      );
    }
    throw new ServiceError('internal_error', msg);
  }

  return {
    id: header.id,
    returnNumber: header.return_number,
    organizationId: header.organization_id,
  };
}

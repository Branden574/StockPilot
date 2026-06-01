import 'server-only';

import { z } from 'zod';

import { audit } from './audit';
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
 *     that exceeds quantity_fulfilled MINUS what prior live returns already
 *     claimed for that source line — so the cumulative returned quantity can
 *     never exceed what was fulfilled, even across many returns. The DB
 *     constraint trigger return_lines_enforce_fulfilled_cap (0153) is the
 *     authoritative backstop; this service rejects early with a clear
 *     validation_error.
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

const createLineSchema = z.object({
  orderRequestLineId: z.string().uuid(),
  quantity: z.number().positive(),
  disposition: z.enum(['restock', 'scrap']),
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

  // ── Create ───────────────────────────────────────────────────────────

  /**
   * Create a 'requested' return from a fulfilled order. Validates the order is
   * returnable and that every requested line quantity is within the remaining
   * returnable quantity (quantity_fulfilled minus quantities already claimed by
   * prior live returns for the same source line). Rejects over-quantity /
   * non-returnable orders with a `validation_error` BEFORE writing anything.
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
    //    return line belongs to the order and is within the fulfilled quantity.
    const lineIds = parsed.lines.map((l) => l.orderRequestLineId);
    // NB: order_request_lines has NO organization_id column (RLS gates it via
    // the parent order_requests, 0044/0078). Org isolation here rests on the
    // in-org parent check above (line 'order' verified .eq(organization_id)),
    // order_request_lines RLS being org-scoped through that parent, AND the
    // per-line belonging re-check below (orderLine.order_request_id === id).
    const { data: orderLines, error: orderLinesError } = await this.ctx.supabase
      .from('order_request_lines')
      .select('id, order_request_id, item_id, quantity_fulfilled')
      .eq('order_request_id', orderRequestId)
      .in('id', lineIds);
    if (orderLinesError) throw new ServiceError('internal_error', orderLinesError.message);

    const orderLineById = new Map<
      string,
      { id: string; order_request_id: string; item_id: string; quantity_fulfilled: number }
    >();
    for (const ol of (orderLines as Array<{
      id: string;
      order_request_id: string;
      item_id: string;
      quantity_fulfilled: number | null;
    }> | null) ?? []) {
      orderLineById.set(ol.id, {
        id: ol.id,
        order_request_id: ol.order_request_id,
        item_id: ol.item_id,
        quantity_fulfilled: Number(ol.quantity_fulfilled) || 0,
      });
    }

    // 3. Already-returned quantity per source line, across all live (not
    //    cancelled / denied) returns. This is what bounds OVER-RETURN across
    //    multiple returns — not just within this one.
    const { data: priorLines, error: priorError } = await this.ctx.supabase
      .from('return_lines')
      .select('order_request_line_id, quantity, returns!inner(status)')
      .eq('organization_id', this.ctx.organizationId)
      .in('order_request_line_id', lineIds);
    if (priorError) throw new ServiceError('internal_error', priorError.message);

    const alreadyReturnedByLine = new Map<string, number>();
    for (const pl of (priorLines as Array<{
      order_request_line_id: string;
      quantity: number | null;
      returns: { status: ReturnStatus } | { status: ReturnStatus }[] | null;
    }> | null) ?? []) {
      // The embedded relation can come back as an object or a single-element
      // array depending on the join cardinality — normalize both.
      const rel = Array.isArray(pl.returns) ? pl.returns[0] : pl.returns;
      const status = rel?.status;
      if (status === 'cancelled' || status === 'denied') continue;
      alreadyReturnedByLine.set(
        pl.order_request_line_id,
        (alreadyReturnedByLine.get(pl.order_request_line_id) ?? 0) + (Number(pl.quantity) || 0),
      );
    }

    // 4. Validate each requested line. Also reject duplicate source lines in
    //    one request (the DB UNIQUE(return_id, order_request_line_id) would
    //    reject it, but a clear early error is friendlier).
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
      if (orderLine.quantity_fulfilled <= 0) {
        throw new ServiceError(
          'validation_error',
          'You can only return lines that were fulfilled.',
        );
      }
      const alreadyReturned = alreadyReturnedByLine.get(line.orderRequestLineId) ?? 0;
      const remaining = orderLine.quantity_fulfilled - alreadyReturned;
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
   * (Phase B publishes return.closed to the outbox here.)
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
    return updated;
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
    const now = new Date();
    const ymd = now.toISOString().slice(0, 10).replace(/-/g, '');
    const rand = Math.floor(Math.random() * 0xffffff)
      .toString(16)
      .padStart(6, '0')
      .toUpperCase();
    return `RMA-${ymd}-${rand}`;
  }
}

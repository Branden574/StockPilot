import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  can,
  formatOrderNumber,
  mapReturnError,
  parseReturnBody,
  parseRestockOptions,
  randomRequestUuid,
  type OrderReturnView,
  type RestockOptions,
  type ReturnApproveDecision,
  type ReturnLineDecision,
  type ReturnStatus as CoreReturnStatus,
  type ReturnStepsRequest,
} from '@stockpilot/core';

import { orderIdForReturnToken } from '@/server/lib/order-secrets';

import { audit, insertAuditRowReported } from './audit';
import {
  assertModuleEnabled,
  assertPermission,
  ServiceError,
  withContext,
  type ServiceContext,
} from './context';
import { dispatchEvent } from './integration-events';
import { fetchAllRowsByIds } from './lib/fetch-by-ids';
import { invalidateInventoryListAfterWrite } from './lib/inventory-list-cache';
import { notifyRequesterReturnEvent, notifyStaffNewReturnRequest } from './returns-notify';
import {
  buildReturnListPage,
  buildReturnWorkbench,
  type ReturnListPage,
  type ReturnListQuery,
  type ReturnWorkbench,
} from './returns-workbench';

/**
 * Returns / RMA service (returns RX-1, migration 0395).
 *
 *   requested ──approve──▶ approved ──receive──▶ received ──close──▶ closed
 *       │                     │
 *       ├──deny──▶ denied     └──cancel──▶ cancelled
 *       └──cancel──▶ cancelled
 *
 * EVERY TRANSITION IS A DATABASE FUNCTION (0395). create_return_request,
 * approve_return (optionally receiving at the counter), deny_return,
 * receive_return, cancel_return, plan_return_dispositions and close_return
 * gate in their own bodies (signed in; a member; the returns module;
 * returns:manage; write access to the order's warehouse) and take the RMA
 * row lock, so this service never writes a return table itself. The checks
 * here (module, permission, MFA) are the friendly early refusal and the MFA
 * floor, which the functions do not hold.
 *
 * INVENTORY CORRECTNESS. Stock moves only in close_return, through the frozen
 * public.process_return_disposition wrapper and the restated ledger body: per
 * line, Staging (today's leg), the original rack proven by draw provenance
 * and revalidated under lock, or scrap (net zero). On hand, holdings,
 * movements, the durable budget, the applied latch and the header close
 * commit together or not at all. Approval and receipt move nothing.
 *
 * SIDE EFFECTS ONLY ON `changed: true`. Audit, the integration event, the
 * outbox and every notification are emitted by the call that changed state;
 * a replay (same key, same body) or an "already" answer emits nothing.
 *
 * ERRORS. A refusal is mapped by its database hint through core's
 * return-error-map (never by message text): the ServiceError carries the
 * plan's words and `details.reason` (and `details.detail` for structured
 * refusals such as a failed revalidation).
 *
 * Reads (list, workbench, get) accept returns:read or returns:manage.
 */

/** Return lifecycle status (core `order-returns-view.ts`), re-exported unchanged. */
export type ReturnStatus = CoreReturnStatus;

export type ReturnReasonCode = 'damaged' | 'wrong_item' | 'end_of_year' | 'overage' | 'other';

export type ReturnDisposition = 'restock' | 'scrap';

/** Legal `from → to` edges (mirrors the 0154 matrix; documentation for callers). */
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
  /** 0393: {requested_by|approved_by|received_by|closed_by|denied_by: when}
   *  for people who deleted their account ('*' selects carry it). */
  deleted_users?: unknown;
  created_at: string;
  updated_at: string;
}

/** A `returns` row plus the parent order's number (SO- handle). */
export interface ReturnRowWithOrder extends ReturnRow {
  order_number: number | null;
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

export interface ReturnWithLines extends ReturnRowWithOrder {
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
  /** Durable budget minus live pending demand (the number the cap trigger uses). */
  quantityRemaining: number;
}

export interface CreateFromOrderInput {
  reasonCode?: ReturnReasonCode | null;
  notes?: string | null;
  lines: Array<{
    orderRequestLineId: string;
    quantity: number;
    disposition?: ReturnDisposition;
    itemId?: string;
    exchange?: unknown;
  }>;
  /** "The item is here" (off by default): the counter channel; the
   *  workbench then offers "Approve and receive". Never a silent receipt. */
  itemIsHere?: boolean;
}

/** Returnable order statuses: 'completed', or the legacy 'delivered'. */
const RETURNABLE_ORDER_STATUSES = new Set<string>(['completed', 'delivered']);

/**
 * The read projection for a `returns` row plus the parent order's number.
 * The constraint is named: RX-2 adds a second relationship between the two
 * tables (the replacement link), so every embed between them is hinted.
 */
const RETURN_SELECT_WITH_ORDER = '*, order_request:order_requests!order_request_id (order_number)';

type ReturnRowEmbed = ReturnRow & {
  order_request?: { order_number: number | null } | { order_number: number | null }[] | null;
};

function withOrderNumber(row: ReturnRowEmbed): ReturnRowWithOrder {
  const { order_request: embed, ...rest } = row;
  const order = Array.isArray(embed) ? (embed[0] ?? null) : (embed ?? null);
  return { ...rest, order_number: order?.order_number ?? null };
}

/**
 * Live PENDING return demand per source line (unapplied lines on live
 * headers), exactly what the 0153 cap trigger counts. The header-status
 * filter runs in JS (pattern #23). Batched and paged (no cap on order lines).
 */
export async function pendingReturnQuantitiesByLine(
  client: SupabaseClient,
  organizationId: string,
  orderRequestLineIds: string[],
): Promise<Map<string, number>> {
  const pending = new Map<string, number>();
  if (orderRequestLineIds.length === 0) return pending;

  const data = await fetchAllRowsByIds<{
    order_request_line_id: string;
    quantity: number | null;
    applied: boolean;
    return: { status: string } | { status: string }[] | null;
  }>(
    orderRequestLineIds,
    (batch) => (from, to) =>
      client
        .from('return_lines')
        .select('order_request_line_id, quantity, applied, return:returns!return_id (status)')
        .eq('organization_id', organizationId)
        .in('order_request_line_id', batch)
        .eq('applied', false)
        .order('id')
        .range(from, to),
  );

  for (const row of data) {
    const header = Array.isArray(row.return) ? (row.return[0] ?? null) : (row.return ?? null);
    const status = header?.status;
    if (status === 'cancelled' || status === 'denied') continue;
    const qty = Number(row.quantity) || 0;
    if (qty <= 0) continue;
    pending.set(row.order_request_line_id, (pending.get(row.order_request_line_id) ?? 0) + qty);
  }
  return pending;
}

/** The order-side view of its returns (core `order-returns-view.ts`). */
export type OrderReturnWithLines = OrderReturnView;

/**
 * The order page's returns read: every return against an order with its
 * lines, oldest first. Ungated on purpose (RLS: every member reads returns);
 * a return that happened stays visible on the order page. Flat select (no
 * embed to order_requests), so RX-2's second relationship cannot make it
 * ambiguous.
 */
export async function loadOrderReturns(
  client: SupabaseClient,
  organizationId: string,
  orderRequestId: string,
): Promise<OrderReturnWithLines[]> {
  const { data, error } = await client
    .from('returns')
    .select(
      `id, return_number, status, reason_code, notes, created_at, closed_at,
       lines:return_lines (id, order_request_line_id, item_id, quantity, disposition, applied)`,
    )
    .eq('organization_id', organizationId)
    .eq('order_request_id', orderRequestId)
    .order('created_at', { ascending: true });
  if (error) throw new ServiceError('internal_error', error.message);

  type RawLine = {
    id: string;
    order_request_line_id: string;
    item_id: string;
    quantity: number | string | null;
    disposition: string;
    applied: boolean | null;
  };
  type Raw = {
    id: string;
    return_number: string | null;
    status: string;
    reason_code: string | null;
    notes: string | null;
    created_at: string;
    closed_at: string | null;
    lines: RawLine[] | RawLine | null;
  };
  return ((data as Raw[] | null) ?? []).map((r) => {
    const rawLines = Array.isArray(r.lines) ? r.lines : r.lines ? [r.lines] : [];
    return {
      id: r.id,
      returnNumber: r.return_number ?? null,
      status: r.status,
      reasonCode: r.reason_code ?? null,
      notes: r.notes ?? null,
      createdAt: r.created_at,
      closedAt: r.closed_at ?? null,
      lines: rawLines.map((l) => ({
        orderRequestLineId: l.order_request_line_id,
        itemId: l.item_id,
        quantity: Number(l.quantity) || 0,
        disposition: l.disposition,
        applied: l.applied === true,
      })),
    };
  });
}

// ── Database refusals ─────────────────────────────────────────────────────

/** A PostgREST error -> the ServiceError the plan's contract names. */
export function returnRpcError(
  error: { code?: string | null; hint?: string | null; message?: string | null; details?: string | null },
): ServiceError {
  const mapped = mapReturnError(error);
  if (mapped.code === 'internal_error') {
    return new ServiceError('internal_error', error.message ?? 'return rpc failed', { reason: 'failed' });
  }
  const details: Record<string, unknown> = { reason: mapped.reason };
  if (mapped.retryable) details.retryable = true;
  if (mapped.detail) details.detail = mapped.detail;
  else if (error.details && /^[a-z_]+$/.test(error.details.trim())) details.detail = error.details.trim();
  return new ServiceError(mapped.code, mapped.message, details);
}

function asObject(data: unknown): Record<string, unknown> {
  return data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// ── Answers ───────────────────────────────────────────────────────────────

export interface ReturnTransitionAnswer {
  /** True only for the call that changed state. */
  changed: boolean;
  status: ReturnStatus;
  /** Who and when, for "Already marked received by …" (changed false). */
  by: string | null;
  byName: string | null;
  at: string | null;
}

export interface ReturnApproveAnswer {
  changed: boolean;
  replay: boolean;
  status: ReturnStatus;
  revision: number;
}

export interface ReturnPlanAnswer {
  changed: boolean;
  appended: number;
  planSeq: number;
}

export interface ReturnCloseLine {
  returnLineId: string;
  itemId: string;
  quantity: number;
  disposition: ReturnDisposition;
  target: 'staging' | 'original' | 'source' | null;
  locationId: string | null;
  legs: Array<{ locationId: string | null; quantity: number; destination: 'rack' | 'staging' }>;
}

export interface ReturnCloseAnswer extends ReturnTransitionAnswer {
  lines: ReturnCloseLine[];
}

export type ReturnStepOutcome = 'done' | 'already' | 'refused';

export interface ReturnStepResult {
  step: 'approve' | 'receive' | 'process';
  outcome: ReturnStepOutcome;
  reason?: string;
  message?: string;
}

/** The header facts the side effects need, read once after a change. */
interface ReturnFacts {
  id: string;
  returnNumber: string | null;
  source: string;
  orderRequestId: string;
  warehouseId: string | null;
  orderNumber: number | null;
}

export class RMAService {
  constructor(private readonly ctx: ServiceContext) {}

  static async forCurrentUser() {
    return new RMAService(await withContext());
  }

  /** Build from a ServiceContext resolved by `withApiContext` in an API route. */
  static forApiContext(ctx: ServiceContext) {
    return new RMAService(ctx);
  }

  /** Writes: module on, returns:manage, and the MFA floor. */
  private gate() {
    assertModuleEnabled(this.ctx, 'returns');
    assertPermission(this.ctx, 'returns:manage');
  }

  /** Reads: module on, returns:read or returns:manage (manage implies read). */
  private gateRead() {
    assertModuleEnabled(this.ctx, 'returns');
    assertPermission(this.ctx, can(this.ctx, 'returns:manage') ? 'returns:manage' : 'returns:read');
  }

  // ── Reads ────────────────────────────────────────────────────────────

  async list(filters: ListReturnsFilters = {}): Promise<ReturnRowWithOrder[]> {
    this.gateRead();
    let query = this.ctx.supabase
      .from('returns')
      .select(RETURN_SELECT_WITH_ORDER)
      .eq('organization_id', this.ctx.organizationId)
      .order('created_at', { ascending: false });
    if (filters.orderRequestId) query = query.eq('order_request_id', filters.orderRequestId);
    if (filters.status) {
      const statuses = Array.isArray(filters.status) ? filters.status : [filters.status];
      // in-list-bound: return statuses are a fixed enum of a few values
      query = query.in('status', statuses);
    }
    const { data, error } = await query;
    if (error) throw new ServiceError('internal_error', error.message);
    return ((data as ReturnRowEmbed[] | null) ?? []).map(withOrderNumber);
  }

  /** The list page: filters, search, keyset paging at 25 (plan 3.10). */
  async listPage(query: ReturnListQuery): Promise<ReturnListPage> {
    this.gateRead();
    return buildReturnListPage(this.ctx, query);
  }

  async get(id: string): Promise<ReturnWithLines> {
    this.gateRead();
    const { data: header, error: headerError } = await this.ctx.supabase
      .from('returns')
      .select(RETURN_SELECT_WITH_ORDER)
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

    return { ...withOrderNumber(header as ReturnRowEmbed), lines: (lines as ReturnLineRow[] | null) ?? [] };
  }

  /** Everything the workbench shows, in one call (plan 4 RX-1). */
  async workbench(id: string): Promise<ReturnWorkbench> {
    this.gateRead();
    return buildReturnWorkbench(this.ctx, id);
  }

  /** The destination read (return_restock_options): staff only. */
  async restockOptions(id: string): Promise<RestockOptions> {
    this.gateRead();
    await this.factsInActiveOrg(id);
    const { data, error } = await this.ctx.supabase.rpc('return_restock_options', { p_return_id: id });
    if (error) throw returnRpcError(error);
    return parseRestockOptions(data);
  }

  /**
   * The returnable lines of a fulfilled order with what remains per line
   * (durable budget minus live pending demand), for the create dialog.
   * Empty when the order is not returnable.
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
    return returnableLinesFrom(this.ctx.supabase, this.ctx.organizationId, orderLines as RawOrderLine[] | null);
  }

  // ── Create ───────────────────────────────────────────────────────────

  /**
   * Create a 'requested' return from a fulfilled order: header, lines and the
   * created decision in ONE transaction (create_return_request). Idempotent on
   * (caller, key): the same key and body replays the RMA; another body under
   * the key is refused. A body without a key (installed phones before RX-1)
   * gets a fresh key per request, exactly as safe as before (plan A-4).
   */
  async createFromOrder(
    orderRequestId: string,
    input: CreateFromOrderInput,
    opts: { idempotencyKey?: string | null } = {},
  ): Promise<ReturnWithLines & { replay: boolean; channel: 'staff' | 'counter' }> {
    this.gate();
    const parsed = parseReturnBody('create', { ...input, idempotencyKey: opts.idempotencyKey ?? undefined });
    if (!parsed.ok) throw new ServiceError('validation_error', parsed.message, { reason: 'return_invalid' });
    const body = parsed.value;

    await this.assertOrderInActiveOrg(orderRequestId);

    // The item identity assertion is kept: the database stamps the item from
    // the source line, and a client that names another item is refused.
    if (body.lines.some((l) => l.itemId)) {
      await this.assertLineItems(orderRequestId, body.lines);
    }

    const key = body.idempotencyKey ?? randomRequestUuid();
    const request = {
      reasonCode: body.reasonCode ?? null,
      notes: body.notes ?? null,
      itemIsHere: body.itemIsHere === true,
      lines: body.lines.map((l) => ({
        orderRequestLineId: l.orderRequestLineId,
        quantity: l.quantity,
        disposition: l.disposition ?? 'restock',
        ...(l.exchange !== undefined ? { exchange: l.exchange } : {}),
      })),
    };
    const { data, error } = await this.ctx.supabase.rpc('create_return_request', {
      p_order_id: orderRequestId,
      p_request: request,
      p_key: key,
    });
    if (error) throw returnRpcError(error);
    const answer = asObject(data);
    const returnId = str(answer.returnId);
    if (!returnId) throw new ServiceError('internal_error', 'create_return_request returned no id', { reason: 'failed' });
    const replay = answer.replay === true;
    const channel = answer.channel === 'counter' ? 'counter' : 'staff';

    const created = await this.get(returnId);

    if (answer.changed === true) {
      await audit(
        {
          event: 'return.created',
          entityType: 'return',
          entityId: returnId,
          extra: {
            orderRequestId,
            returnNumber: created.return_number,
            lineCount: created.lines.length,
            source: 'internal',
            channel,
          },
        },
        this.ctx,
      );
      void dispatchEvent(this.ctx.organizationId, 'return.created', {
        id: returnId,
        returnNumber: created.return_number,
        orderNumber: formatOrderNumber(created.order_number) ?? orderRequestId.slice(0, 8).toUpperCase(),
      });
      await publishReturnCreated(this.ctx.supabase, this.ctx.organizationId, returnId, created.return_number, orderRequestId);
    }

    return { ...created, replay, channel };
  }

  private async assertLineItems(
    orderRequestId: string,
    lines: Array<{ orderRequestLineId: string; itemId?: string }>,
  ): Promise<void> {
    const ids = lines.map((l) => l.orderRequestLineId);
    const ctx = this.ctx;
    const rows = await fetchAllRowsByIds<{ id: string; item_id: string }>(
      ids,
      (batch) => (from, to) =>
        ctx.supabase
          .from('order_request_lines')
          .select('id, item_id')
          .eq('order_request_id', orderRequestId)
          .in('id', batch)
          .order('id')
          .range(from, to),
    );
    const byId = new Map(rows.map((r) => [r.id, r.item_id]));
    for (const l of lines) {
      if (l.itemId && byId.get(l.orderRequestLineId) !== l.itemId) {
        throw new ServiceError(
          'validation_error',
          'A return line item must match the item fulfilled on that order line.',
          { reason: 'return_invalid', orderRequestLineId: l.orderRequestLineId },
        );
      }
    }
  }

  // ── Lifecycle ────────────────────────────────────────────────────────

  /**
   * requested → approved with every line's disposition and destination
   * (approve_return). With `receiveNow` (the counter, off by default) it is
   * received in the same transaction. Moves no stock. Idempotent on
   * (RMA, expected revision).
   */
  async approve(
    id: string,
    input: { expectedRevision: number; decision: ReturnApproveDecision; receiveNow?: boolean },
  ): Promise<ReturnApproveAnswer> {
    this.gate();
    const parsed = parseReturnBody('approve', input.decision);
    if (!parsed.ok) throw new ServiceError('validation_error', parsed.message, { reason: 'return_invalid' });
    const facts = await this.factsInActiveOrg(id);
    const { data, error } = await this.ctx.supabase.rpc('approve_return', {
      p_return_id: id,
      p_expected_revision: input.expectedRevision,
      p_decision: parsed.value,
      p_receive_now: input.receiveNow === true,
    });
    if (error) throw returnRpcError(error);
    const answer = asObject(data);
    const status = (str(answer.status) ?? 'approved') as ReturnStatus;
    const result: ReturnApproveAnswer = {
      changed: answer.changed === true,
      replay: answer.replay === true,
      status,
      revision: num(answer.revision) ?? input.expectedRevision + 1,
    };

    if (result.changed) {
      const channel = input.receiveNow ? 'counter' : 'staff';
      const plan = parsed.value.lines.map((l) => ({
        returnLineId: l.returnLineId,
        disposition: l.disposition,
        target: l.disposition === 'restock' ? (l.restock?.target ?? 'staging') : null,
        locationId: l.restock?.locationId ?? null,
      }));
      await audit(
        {
          event: 'return.approved',
          entityType: 'return',
          entityId: id,
          warehouseId: facts.warehouseId,
          extra: { revision: result.revision, channel, plan },
        },
        this.ctx,
      );
      await audit(
        { event: 'return.disposition_planned', entityType: 'return', entityId: id, extra: { channel, plan } },
        this.ctx,
      );
      void dispatchEvent(this.ctx.organizationId, 'return.approved', {
        id,
        returnNumber: facts.returnNumber,
        actorId: this.ctx.userId,
      });
      if (input.receiveNow) {
        await audit(
          { event: 'return.received', entityType: 'return', entityId: id, extra: { channel: 'counter' } },
          this.ctx,
        );
        void dispatchEvent(this.ctx.organizationId, 'return.received', {
          id,
          returnNumber: facts.returnNumber,
          actorId: this.ctx.userId,
        });
      }
      await notifyRequesterReturnEvent({
        organizationId: this.ctx.organizationId,
        returnId: id,
        returnNumber: facts.returnNumber,
        orderId: facts.orderRequestId,
        event: 'approved',
        source: facts.source,
        channel,
      });
    }
    return result;
  }

  /** requested → denied with a reason (1 to 1,000 characters). */
  async deny(id: string, reason: string): Promise<ReturnTransitionAnswer> {
    this.gate();
    const parsed = parseReturnBody('deny', { reason });
    if (!parsed.ok) throw new ServiceError('validation_error', parsed.message, { reason: 'reason_required' });
    const facts = await this.factsInActiveOrg(id);
    const { data, error } = await this.ctx.supabase.rpc('deny_return', {
      p_return_id: id,
      p_reason: parsed.value.reason,
    });
    if (error) throw returnRpcError(error);
    const answer = await this.transitionAnswer(data, 'denied', 'deniedBy', 'deniedAt');
    if (answer.changed) {
      await audit(
        { event: 'return.denied', entityType: 'return', entityId: id, reason: parsed.value.reason },
        this.ctx,
      );
      void dispatchEvent(this.ctx.organizationId, 'return.denied', {
        id,
        returnNumber: facts.returnNumber,
        reason: parsed.value.reason,
        actorId: this.ctx.userId,
      });
      await notifyRequesterReturnEvent({
        organizationId: this.ctx.organizationId,
        returnId: id,
        returnNumber: facts.returnNumber,
        orderId: facts.orderRequestId,
        event: 'denied',
        source: facts.source,
      });
    }
    return answer;
  }

  /** approved → received. Moves no stock; already received answers changed false (P24). */
  async receive(id: string): Promise<ReturnTransitionAnswer> {
    this.gate();
    const facts = await this.factsInActiveOrg(id);
    const { data, error } = await this.ctx.supabase.rpc('receive_return', { p_return_id: id });
    if (error) throw returnRpcError(error);
    const answer = await this.transitionAnswer(data, 'received', 'receivedBy', 'receivedAt');
    if (answer.changed) {
      await audit({ event: 'return.received', entityType: 'return', entityId: id, extra: { channel: 'staff' } }, this.ctx);
      void dispatchEvent(this.ctx.organizationId, 'return.received', {
        id,
        returnNumber: facts.returnNumber,
        actorId: this.ctx.userId,
      });
      await notifyRequesterReturnEvent({
        organizationId: this.ctx.organizationId,
        returnId: id,
        returnNumber: facts.returnNumber,
        orderId: facts.orderRequestId,
        event: 'received',
        source: facts.source,
        channel: 'staff',
      });
    }
    return answer;
  }

  /** requested or approved → cancelled (reason optional for a return). */
  async cancel(
    id: string,
    input: { expectedRevision?: number | null; reason?: string | null } = {},
  ): Promise<ReturnTransitionAnswer> {
    this.gate();
    const parsed = parseReturnBody('cancel', input);
    if (!parsed.ok) throw new ServiceError('validation_error', parsed.message, { reason: 'return_invalid' });
    const facts = await this.factsInActiveOrg(id);
    const { data, error } = await this.ctx.supabase.rpc('cancel_return', {
      p_return_id: id,
      p_expected_revision: parsed.value.expectedRevision ?? null,
      p_reason: parsed.value.reason ?? null,
    });
    if (error) throw returnRpcError(error);
    const answer = await this.transitionAnswer(data, 'cancelled', null, null);
    if (answer.changed) {
      await audit(
        { event: 'return.cancelled', entityType: 'return', entityId: id, reason: parsed.value.reason ?? undefined },
        this.ctx,
      );
      void dispatchEvent(this.ctx.organizationId, 'return.cancelled', {
        id,
        returnNumber: facts.returnNumber,
        actorId: this.ctx.userId,
      });
      await notifyRequesterReturnEvent({
        organizationId: this.ctx.organizationId,
        returnId: id,
        returnNumber: facts.returnNumber,
        orderId: facts.orderRequestId,
        event: 'cancelled',
        source: facts.source,
      });
    }
    return answer;
  }

  /** While approved or received: change the destination of unapplied lines. */
  async planDispositions(id: string, lines: ReturnLineDecision[]): Promise<ReturnPlanAnswer> {
    this.gate();
    const parsed = parseReturnBody('dispositions', { lines });
    if (!parsed.ok) throw new ServiceError('validation_error', parsed.message, { reason: 'return_invalid' });
    await this.factsInActiveOrg(id);
    const { data, error } = await this.ctx.supabase.rpc('plan_return_dispositions', {
      p_return_id: id,
      p_lines: parsed.value.lines,
    });
    if (error) throw returnRpcError(error);
    const answer = asObject(data);
    const result: ReturnPlanAnswer = {
      changed: answer.changed === true,
      appended: num(answer.appended) ?? 0,
      planSeq: num(answer.planSeq) ?? 0,
    };
    if (result.changed) {
      await audit(
        {
          event: 'return.disposition_planned',
          entityType: 'return',
          entityId: id,
          extra: {
            channel: 'staff',
            plan: parsed.value.lines.map((l) => ({
              returnLineId: l.returnLineId,
              disposition: l.disposition,
              target: l.disposition === 'restock' ? (l.restock?.target ?? 'staging') : null,
              locationId: l.restock?.locationId ?? null,
            })),
          },
        },
        this.ctx,
      );
    }
    return result;
  }

  /**
   * received → closed: optional changed plans and the stock move in ONE
   * transaction (close_return). A planned rack that failed revalidation
   * raises restock_location_unavailable: nothing moved, the RMA stays
   * received, and this records the refusal in the audit log.
   */
  async close(
    id: string,
    input: { lines?: ReturnLineDecision[] | null; expectedPlanSeq?: number | null } = {},
  ): Promise<ReturnCloseAnswer> {
    this.gate();
    let lines: ReturnLineDecision[] | null = null;
    if (input.lines && input.lines.length > 0) {
      const parsed = parseReturnBody('dispositions', { lines: input.lines });
      if (!parsed.ok) throw new ServiceError('validation_error', parsed.message, { reason: 'return_invalid' });
      lines = parsed.value.lines;
    }
    const facts = await this.factsInActiveOrg(id);
    const { data, error } = await this.ctx.supabase.rpc('close_return', {
      p_return_id: id,
      p_lines: lines,
      p_expected_plan_seq: input.expectedPlanSeq ?? null,
    });
    if (error) {
      const refusal = returnRpcError(error);
      if (refusal.details?.reason === 'restock_location_unavailable') {
        await audit(
          {
            event: 'return.restock_location_unavailable',
            entityType: 'return',
            entityId: id,
            extra: { detail: refusal.details.detail ?? null },
          },
          this.ctx,
        );
      }
      throw refusal;
    }
    const base = await this.transitionAnswer(data, 'closed', 'closedBy', 'closedAt');
    const answer = asObject(data);
    const closeLines: ReturnCloseLine[] = (Array.isArray(answer.lines) ? answer.lines : []).map((raw) => {
      const l = asObject(raw);
      return {
        returnLineId: str(l.returnLineId) ?? '',
        itemId: str(l.itemId) ?? '',
        quantity: num(l.quantity) ?? 0,
        disposition: l.disposition === 'scrap' ? 'scrap' : 'restock',
        target: (str(l.target) as ReturnCloseLine['target']) ?? null,
        locationId: str(l.locationId),
        legs: (Array.isArray(l.legs) ? l.legs : []).map((g) => {
          const leg = asObject(g);
          return {
            locationId: str(leg.locationId),
            quantity: num(leg.quantity) ?? 0,
            destination: leg.destination === 'rack' ? ('rack' as const) : ('staging' as const),
          };
        }),
      };
    });
    const result: ReturnCloseAnswer = { ...base, lines: closeLines };

    if (result.changed) {
      invalidateInventoryListAfterWrite(this.ctx.organizationId, 'return.close');
      await audit(
        {
          event: 'return.closed',
          entityType: 'return',
          entityId: id,
          warehouseId: facts.warehouseId,
          extra: {
            lines: closeLines.map((l) => ({
              returnLineId: l.returnLineId,
              disposition: l.disposition,
              destination: l.disposition === 'scrap' ? 'scrap' : (l.target ?? 'staging'),
              locationIds: l.legs.map((g) => g.locationId).filter(Boolean),
            })),
          },
        },
        this.ctx,
      );
      await this.publishReturnClosed(id, facts);
      void dispatchEvent(this.ctx.organizationId, 'return.closed', {
        id,
        returnNumber: facts.returnNumber,
        actorId: this.ctx.userId,
      });
    }
    return result;
  }

  /**
   * The steps endpoint (plan 3.3.8, graft G2): approve, receive, process in
   * that order, each one RPC and one transaction. A step whose state is
   * already reached answers `already`; the first refusal stops the chain and
   * earlier steps stay committed. The answer always carries the whole
   * workbench, so the screen redraws from server truth, and a lost answer is
   * recovered by sending the same body again.
   */
  async runSteps(id: string, body: ReturnStepsRequest): Promise<{ ran: ReturnStepResult[]; workbench: ReturnWorkbench }> {
    this.gate();
    const ran: ReturnStepResult[] = [];
    for (const step of body.steps) {
      try {
        if (step === 'approve') {
          const r = await this.approve(id, {
            expectedRevision: body.expectedRevision ?? 0,
            decision: body.approve as ReturnApproveDecision,
            receiveNow: body.receiveNow === true,
          });
          ran.push({ step, outcome: r.changed ? 'done' : 'already' });
        } else if (step === 'receive') {
          const r = await this.receive(id);
          ran.push({ step, outcome: r.changed ? 'done' : 'already' });
        } else {
          const r = await this.close(id, {
            lines: body.process?.lines ?? null,
            expectedPlanSeq: body.expectedPlanSeq ?? null,
          });
          ran.push({ step, outcome: r.changed ? 'done' : 'already' });
        }
      } catch (e) {
        if (!(e instanceof ServiceError)) throw e;
        ran.push({
          step,
          outcome: 'refused',
          reason: typeof e.details?.reason === 'string' ? (e.details.reason as string) : e.code,
          message: e.message,
        });
        break;
      }
    }
    const workbench = await this.workbench(id);
    return { ran, workbench };
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private async transitionAnswer(
    data: unknown,
    fallback: ReturnStatus,
    byKey: string | null,
    atKey: string | null,
  ): Promise<ReturnTransitionAnswer> {
    const answer = asObject(data);
    const by = byKey ? str(answer[byKey]) : null;
    const at = atKey ? str(answer[atKey]) : null;
    const changed = answer.changed === true;
    return {
      changed,
      status: (str(answer.status) ?? fallback) as ReturnStatus,
      by,
      byName: !changed && by ? await this.nameOf(by) : null,
      at,
    };
  }

  private async nameOf(userId: string): Promise<string | null> {
    try {
      const { data } = await this.ctx.supabase
        .from('user_profiles')
        .select('full_name, email')
        .eq('id', userId)
        .maybeSingle();
      const row = data as { full_name: string | null; email: string | null } | null;
      return row?.full_name?.trim() || row?.email || null;
    } catch {
      return null;
    }
  }

  /**
   * The RMA read in the ACTIVE organization, before any function runs (desk
   * check F4). The functions gate on membership of the RMA's own
   * organization, so for a member of two organizations (a stale screen after
   * an organization switch, or a Bearer call naming the other organization)
   * the call would act on the other organization's RMA while this service
   * wrote the audit row, the webhook, the notification and the inventory
   * invalidation into the active one. A miss answers like a missing RMA,
   * before anything runs. The header facts the side effects need do not
   * change across a transition, so this one read serves them too.
   */
  private async factsInActiveOrg(id: string): Promise<ReturnFacts> {
    const { data, error } = await this.ctx.supabase
      .from('returns')
      .select('id, return_number, source, order_request_id, order_request:order_requests!order_request_id (warehouse_id, order_number)')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message, { reason: 'failed' });
    if (!data) throw returnRpcError({ hint: 'return_not_found' });
    const row = data as {
      id: string;
      return_number: string | null;
      source: string;
      order_request_id: string;
      order_request?: { warehouse_id: string | null; order_number: number | null } | Array<{ warehouse_id: string | null; order_number: number | null }> | null;
    };
    const order = Array.isArray(row.order_request) ? (row.order_request[0] ?? null) : (row.order_request ?? null);
    return {
      id: row.id,
      returnNumber: row.return_number,
      source: row.source,
      orderRequestId: row.order_request_id,
      warehouseId: order?.warehouse_id ?? null,
      orderNumber: order?.order_number ?? null,
    };
  }

  /** The order read in the ACTIVE organization before a create (desk check F4). */
  private async assertOrderInActiveOrg(orderRequestId: string): Promise<void> {
    const { data, error } = await this.ctx.supabase
      .from('order_requests')
      .select('id')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', orderRequestId)
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message, { reason: 'failed' });
    if (!data) throw returnRpcError({ hint: 'order_not_found' });
  }

  /**
   * Best-effort `return.closed` outbox event (the QuickBooks / Sage
   * connectors book the credit). The total is informational: each line's
   * quantity times its source order line's unit_cost_at_request.
   */
  private async publishReturnClosed(id: string, facts: ReturnFacts): Promise<void> {
    try {
      const { data: lines, error: linesError } = await this.ctx.supabase
        .from('return_lines')
        .select('quantity, order_request_line:order_request_lines!order_request_line_id (unit_cost_at_request)')
        .eq('organization_id', this.ctx.organizationId)
        .eq('return_id', id);
      if (linesError) return;
      const rows =
        (lines as Array<{
          quantity: number | null;
          order_request_line: { unit_cost_at_request: number | null } | { unit_cost_at_request: number | null }[] | null;
        }> | null) ?? [];
      let total = 0;
      for (const row of rows) {
        const ol = Array.isArray(row.order_request_line) ? (row.order_request_line[0] ?? null) : (row.order_request_line ?? null);
        total += (Number(row.quantity) || 0) * (Number(ol?.unit_cost_at_request) || 0);
      }
      await this.ctx.supabase.rpc('publish_outbox', {
        p_org_id: this.ctx.organizationId,
        p_topic: 'return.closed',
        p_aggregate_type: 'return',
        p_aggregate_id: id,
        p_payload: {
          orderRequestId: facts.orderRequestId,
          returnNumber: facts.returnNumber,
          lineCount: rows.length,
          total: Math.round((total + Number.EPSILON) * 100) / 100,
        },
        p_dedupe_key: `return.closed:${id}`,
      });
    } catch {
      // Best-effort: a publish failure must not fail an already-committed close.
    }
  }
}

/** Best-effort `return.created` outbox event (the Zendesk shell). */
async function publishReturnCreated(
  client: SupabaseClient,
  organizationId: string,
  returnId: string,
  returnNumber: string | null,
  orderRequestId: string,
): Promise<void> {
  try {
    await client.rpc('publish_outbox', {
      p_org_id: organizationId,
      p_topic: 'return.created',
      p_aggregate_type: 'return',
      p_aggregate_id: returnId,
      p_payload: { returnId, returnNumber, orderRequestId },
      p_dedupe_key: `return.created:${returnId}`,
    });
  } catch {
    /* best-effort */
  }
}

type RawOrderLine = {
  id: string;
  item_id: string;
  quantity_fulfilled: number | null;
  returned_quantity: number | null;
  item: { id: string; name: string; sku: string | null } | { id: string; name: string; sku: string | null }[] | null;
};

async function returnableLinesFrom(
  client: SupabaseClient,
  organizationId: string,
  orderLines: RawOrderLine[] | null,
): Promise<ReturnableLine[]> {
  const lineRows = orderLines ?? [];
  const pending = await pendingReturnQuantitiesByLine(
    client,
    organizationId,
    lineRows.map((l) => l.id),
  );
  const out: ReturnableLine[] = [];
  for (const l of lineRows) {
    const fulfilled = Number(l.quantity_fulfilled) || 0;
    if (fulfilled <= 0) continue;
    const remaining = fulfilled - (Number(l.returned_quantity) || 0) - (pending.get(l.id) ?? 0);
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

// ── Requester-initiated returns (PUBLIC token page and B2B portal) ─────────

/** What the requester surfaces POST (the token is the only authorization on
 *  the public page). Disposition is never accepted from a requester. */
export interface RequesterReturnInput {
  reasonCode?: ReturnReasonCode | null;
  notes?: string | null;
  lines: Array<{ orderRequestLineId: string; quantity: number; exchange?: unknown }>;
}

/** The minimal, token-scoped order context the public page renders. */
export interface RequesterReturnOrderContext {
  orderRequestId: string;
  organizationId: string;
  requesterEmail: string | null;
  requesterName: string | null;
  lines: ReturnableLine[];
}

interface RequesterReturnOrderRow {
  id: string;
  organization_id: string;
  status: string;
  requester_email: string | null;
  requester_name: string | null;
}

/**
 * Shared second half of both requester loaders: the order is returnable, the
 * org has the returns module on, and the still-returnable lines. Null on any
 * closed door (both public surfaces answer that 404-shaped).
 */
async function buildRequesterReturnContext(
  admin: SupabaseClient,
  order: RequesterReturnOrderRow,
): Promise<RequesterReturnOrderContext | null> {
  if (!RETURNABLE_ORDER_STATUSES.has(order.status)) return null;
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

  let lines: ReturnableLine[];
  try {
    lines = await returnableLinesFrom(admin, order.organization_id, orderLines as RawOrderLine[] | null);
  } catch {
    return null;
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
 * Resolve a return token to its single order's still-returnable lines (the
 * service-role client: the requester has no JWT). The token lives only in
 * order_request_secrets (0392); it opens exactly one order.
 */
export async function loadRequesterReturnContext(
  admin: SupabaseClient,
  token: string,
): Promise<RequesterReturnOrderContext | null> {
  if (!token || !/^[0-9a-fA-F-]{36}$/.test(token)) return null;
  const orderId = await orderIdForReturnToken(admin, token);
  if (!orderId) return null;
  const { data: order, error: orderError } = await admin
    .from('order_requests')
    .select('id, organization_id, status, requester_email, requester_name')
    .eq('id', orderId)
    .maybeSingle();
  if (orderError || !order) return null;
  return buildRequesterReturnContext(admin, order as RequesterReturnOrderRow);
}

/**
 * Resolve a B2B portal customer's OWN order (scope from the server-resolved
 * portal context, never the client) to its still-returnable lines.
 */
export async function loadPortalReturnContext(
  admin: SupabaseClient,
  scope: { organizationId: string; customerId: string; orderRequestId: string },
): Promise<RequesterReturnOrderContext | null> {
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

export interface RequesterReturnCreated {
  id: string;
  returnNumber: string | null;
  organizationId: string;
  replay: boolean;
}

/**
 * Create a requester return from the PUBLIC token page. The token resolves
 * the order server-side; every line is re-checked by
 * create_requester_return_request in one transaction (belonging, durable
 * budget less pending demand, the cap trigger), which stamps the item from
 * the source line, forces restock, and copies the requester's name and email
 * from the order. Idempotent on the request key.
 */
export async function createRequesterReturn(
  admin: SupabaseClient,
  token: string,
  input: RequesterReturnInput,
  opts: { idempotencyKey?: string | null } = {},
): Promise<RequesterReturnCreated> {
  const parsed = parseReturnBody('requester', { ...input, idempotencyKey: opts.idempotencyKey ?? undefined });
  if (!parsed.ok) throw new ServiceError('validation_error', parsed.message, { reason: 'return_invalid' });
  const ctx = await loadRequesterReturnContext(admin, token);
  if (!ctx) throw new ServiceError('not_found', 'This return link is invalid or has expired.');
  return createRequesterRpc(admin, ctx, parsed.value, { channel: 'token', userId: null });
}

/**
 * The B2B portal variant: the order resolved through the PORTAL principal
 * (server-resolved org and customer scope), the portal user recorded on the
 * created decision. Same database function as the token path.
 */
export async function createPortalReturn(
  admin: SupabaseClient,
  scope: { organizationId: string; customerId: string; orderRequestId: string; portalUserId: string },
  input: RequesterReturnInput,
  opts: { idempotencyKey?: string | null } = {},
): Promise<RequesterReturnCreated> {
  const parsed = parseReturnBody('requester', { ...input, idempotencyKey: opts.idempotencyKey ?? undefined });
  if (!parsed.ok) throw new ServiceError('validation_error', parsed.message, { reason: 'return_invalid' });
  const ctx = await loadPortalReturnContext(admin, scope);
  if (!ctx) throw new ServiceError('not_found', 'This order could not be found.');
  return createRequesterRpc(admin, ctx, parsed.value, { channel: 'portal', userId: scope.portalUserId });
}

async function createRequesterRpc(
  admin: SupabaseClient,
  ctx: RequesterReturnOrderContext,
  body: { reasonCode?: ReturnReasonCode | null; notes?: string; lines: Array<{ orderRequestLineId: string; quantity: number; exchange?: unknown }>; idempotencyKey?: string },
  actor: { channel: 'token' | 'portal' | 'member'; userId: string | null },
): Promise<RequesterReturnCreated> {
  const key = body.idempotencyKey ?? randomRequestUuid();
  const { data, error } = await admin.rpc('create_requester_return_request', {
    p_order_id: ctx.orderRequestId,
    p_request: {
      reasonCode: body.reasonCode ?? null,
      notes: body.notes ?? null,
      lines: body.lines.map((l) => ({
        orderRequestLineId: l.orderRequestLineId,
        quantity: l.quantity,
        ...(l.exchange !== undefined ? { exchange: l.exchange } : {}),
      })),
    },
    p_key: key,
    p_actor: { channel: actor.channel, userId: actor.userId },
  });
  if (error) {
    const refusal = returnRpcError(error);
    // Every requester-facing refusal that is not the requester's own input is
    // one closed door: the order went away or the module was switched off.
    if (refusal.code === 'not_found' || refusal.code === 'module_disabled') {
      throw new ServiceError('not_found', 'This return link is invalid or has expired.');
    }
    throw refusal;
  }
  const answer = asObject(data);
  const id = str(answer.returnId);
  if (!id) throw new ServiceError('internal_error', 'create_requester_return_request returned no id', { reason: 'failed' });
  const returnNumber = str(answer.returnNumber);
  const result: RequesterReturnCreated = {
    id,
    returnNumber,
    organizationId: str(answer.organizationId) ?? ctx.organizationId,
    replay: answer.replay === true,
  };

  if (answer.changed === true) {
    await insertAuditRowReported({
      organization_id: result.organizationId,
      user_id: actor.userId,
      event: 'return.created',
      metadata: {
        entity_type: 'return',
        entity_id: id,
        source: 'requester',
        channel: actor.channel,
        orderRequestId: ctx.orderRequestId,
        returnNumber,
        lineCount: body.lines.length,
      },
    });
    await publishReturnCreated(admin, result.organizationId, id, returnNumber, ctx.orderRequestId);
    void dispatchEvent(result.organizationId, 'return.created', { id, returnNumber, source: 'requester' });
    await notifyStaffNewReturnRequest({
      organizationId: result.organizationId,
      returnId: id,
      returnNumber,
      orderId: ctx.orderRequestId,
      actorUserId: actor.userId,
    });
    await notifyRequesterReturnEvent({
      organizationId: result.organizationId,
      returnId: id,
      returnNumber,
      orderId: ctx.orderRequestId,
      event: 'request_received',
      source: 'requester',
      channel: actor.channel,
    });
  }
  return result;
}

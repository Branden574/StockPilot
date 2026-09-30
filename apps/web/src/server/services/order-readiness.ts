import 'server-only';

import {
  assessOrderReadiness,
  can,
  isManagerOrAbove,
  parseOrderReadinessFacts,
  parseShortfallChangedDetail,
  parseShortfallPoResult,
  READINESS_FORBIDDEN_COPY,
  READINESS_MODULE_OFF_COPY,
  READINESS_ORDER_NOT_FOUND_COPY,
  READINESS_TO_PICK_STATUSES,
  readinessAnswersOrder,
  SHORTFALL_PO_BUSY_COPY,
  SHORTFALL_PO_CHANGED_COPY,
  SHORTFALL_PO_CONFLICT_COPY,
  SHORTFALL_PO_FORBIDDEN_COPY,
  SHORTFALL_PO_INVALID_COPY,
  SHORTFALL_PO_ITEM_NOT_DRAFTABLE_COPY,
  SHORTFALL_PO_KEY_MAX,
  SHORTFALL_PO_LINE_NOT_ON_ORDER_COPY,
  SHORTFALL_PO_LINES_CAPPED_COPY,
  SHORTFALL_PO_MAX_LINES,
  SHORTFALL_PO_NO_WAREHOUSE_ACCESS_COPY,
  SHORTFALL_PO_NOT_APPLICABLE_COPY,
  SHORTFALL_PO_NOT_FOUND_COPY,
  SHORTFALL_PO_ORDERS_OFF_COPY,
  SHORTFALL_PO_PURCHASE_ORDERS_OFF_COPY,
  SHORTFALL_PO_SIGN_IN_COPY,
  SHORTFALL_PO_TIMEOUT_COPY,
  type OrderReadinessAssessment,
  type OrderReadinessResult,
  type ShortfallPoFailureReason,
  type ShortfallPoLine,
  type ShortfallPoResult,
} from '@stockpilot/core';

import { assertWarehouseAccess } from '@/lib/auth/warehouse';
import { reportError } from '@/lib/error-reporter';
import { mapWithConcurrency } from '@/lib/supabase/in-filter';

import { auditMany, type AuditPayload } from './audit';
import {
  assertModuleEnabled,
  assertPermission,
  isModuleEnabled,
  ServiceError,
  withContext,
  type ServiceContext,
} from './context';
import { dispatchEvent } from './integration-events';
import { invalidateInventoryListAfterWrite } from './lib/inventory-list-cache';
import { postgrestErrorText, type PostgrestLikeError } from './lib/postgrest-error';

/**
 * ORDER READINESS (F2-1, migration 0377): per-line readiness and an order
 * roll-up for the order page, derived on read and never stored.
 *
 * FACTS IN SQL, JUDGEMENT IN CORE. order_readiness_facts (SECURITY DEFINER,
 * gated in its body) returns one order's raw facts as one JSON value, called
 * with the READER's client: its per-field gates (items the reader can read,
 * PO references the reader could open, other pending demand for approvers
 * only) answer for this reader. Core parses and assesses them, exactly as the
 * phone does with the same facts (it calls the same RPC directly).
 *
 * THE ORDER ID ONLY. The organization is the order's own, decided inside the
 * function from the order row; nothing here passes a client-supplied org.
 *
 * WHO. The function answers any member who can read the order (orders are
 * org-readable). Who SEES the panel is the page's call (core
 * readinessAudience: the full panel for approvers, pickers and buyers, one
 * sentence for the requester, nothing and no read for anyone else).
 *
 * A FAILED READ IS NEVER AN ANSWER. `get` throws a ServiceError; `result`
 * turns any failure into `{ state: 'failed' }`, which every consumer renders
 * as "Couldn't check readiness", never as ready, empty or zero (pattern #1).
 */

/** An order id is a uuid; anything else is not an order (and never reaches
 *  the database as a 22P02). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RpcError = PostgrestLikeError & { code?: string | null; hint?: string | null };

/**
 * The function's refusals as service errors:
 *   P0002 order_request_not_found  -> not_found (a missing order and another
 *                                     org's order read the same)
 *   42501 unauthenticated          -> forbidden (the function's OWN 42501,
 *                                     0377 gate 1)
 *   P0001 hint module_disabled     -> module_disabled
 *   anything else                  -> internal_error (the raw text stays in
 *                                     internalDetail, server side), INCLUDING
 *                                     any other 42501: Postgres raises 42501
 *                                     "permission denied for function" when
 *                                     the EXECUTE grant is gone (the 0318
 *                                     outage class). That is a fault to
 *                                     report, not "you are not allowed".
 */
export function mapReadinessRpcError(
  error: RpcError,
  response: { status?: number | null; statusText?: string | null } = {},
): ServiceError {
  const code = error.code ?? '';
  const message = error.message ?? '';
  if (code === 'P0002' || message === 'order_request_not_found') {
    return new ServiceError('not_found', READINESS_ORDER_NOT_FOUND_COPY);
  }
  if (code === '42501' && message === 'unauthenticated') {
    return new ServiceError('forbidden', READINESS_FORBIDDEN_COPY);
  }
  if (error.hint === 'module_disabled' || message === 'module_disabled') {
    return new ServiceError('module_disabled', READINESS_MODULE_OFF_COPY);
  }
  return new ServiceError(
    'internal_error',
    `order_readiness_facts failed: ${postgrestErrorText(error, response)}`,
  );
}

/**
 * A failed read's message, in core's words for the refusals both platforms can
 * name (core readinessFailureDetail shows those under "Couldn't check
 * readiness"); anything else is the generic text, never shown as a reason.
 */
function failureMessage(err: unknown): string {
  if (!(err instanceof ServiceError)) return 'Could not check readiness.';
  switch (err.code) {
    case 'not_found':
      return READINESS_ORDER_NOT_FOUND_COPY;
    case 'forbidden':
      return READINESS_FORBIDDEN_COPY;
    case 'module_disabled':
      return READINESS_MODULE_OFF_COPY;
    default:
      return err.message;
  }
}

// ── F2-5: draft a PO for the shortfall (migration 0385) ─────────────────────

/** What draftShortfallPos takes (the action's and the route's body). */
export interface DraftShortfallPosInput {
  orderId: string;
  lines: ShortfallPoLine[];
  /** Minted by the screen for this request (core shortfallIdempotencyKey),
   *  reused for its retries. */
  idempotencyKey: string;
}

/** po.created integration events in flight at once (one per draft). */
const PO_CREATED_DISPATCH_CONCURRENCY = 4;

function shortfallRefusal(
  code: ServiceError['code'],
  message: string,
  reason: ShortfallPoFailureReason,
  extra: Record<string, unknown> = {},
): ServiceError {
  return new ServiceError(code, message, { reason, ...extra });
}

/** An item: {why} map from item_not_draftable's detail, or null. */
function parseRefusals(detail: string | null | undefined): Record<string, string> | null {
  if (!detail) return null;
  try {
    const v = JSON.parse(detail) as unknown;
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
    const out: Record<string, string> = {};
    for (const [k, why] of Object.entries(v as Record<string, unknown>)) {
      if (typeof why === 'string') out[k] = why;
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * draft_order_shortfall_pos's refusals (0385) as ServiceErrors in core's
 * words, with `details.reason` a ShortfallPoFailureReason both platforms
 * switch on. Matched on the function's own messages (every `raise` in 0385,
 * pattern #28), the hints save_purchase_order_draft passes through, and the
 * lock and number codes; anything else (a revoked grant's "permission denied
 * for function", an RLS refusal, a network fault) is internal_error, whose
 * public message is generic.
 *   shortfall_changed   409, details.current = the draftable per item now;
 *   idempotency_conflict 409 (the key was used for another request);
 *   readiness_not_applicable 409 (past picking or closed; capped);
 *   item_not_draftable, line_not_on_order, line_invalid, key errors: 400;
 *   55P03 (a lock wait past 5 s) and 23505 (a PO number taken meanwhile by a
 *   PO written outside the reorder lock; 0385 steps past numbers live POs
 *   already carry): 409 busy, "being changed at the same time";
 *   57014 (the statement timeout): 409 busy, "took too long, so nothing was
 *   drafted". Both retryable: the whole call rolled back, key included, so
 *   the same request and key are safe to send again.
 */
export function shortfallPoRpcError(error: {
  message?: string | null;
  code?: string | null;
  hint?: string | null;
  details?: string | null;
}): ServiceError {
  const msg = error.message ?? '';
  const code = error.code ?? '';
  switch (msg) {
    case 'order_request_not_found':
      return shortfallRefusal('not_found', SHORTFALL_PO_NOT_FOUND_COPY, 'not_found');
    case 'module_disabled':
      return shortfallRefusal(
        'module_disabled',
        error.details === 'orders' ? SHORTFALL_PO_ORDERS_OFF_COPY : SHORTFALL_PO_PURCHASE_ORDERS_OFF_COPY,
        'module_disabled',
        { module: error.details === 'orders' ? 'orders' : 'purchase_orders' },
      );
    case 'shortfall_changed':
      return shortfallRefusal('conflict', SHORTFALL_PO_CHANGED_COPY, 'shortfall_changed', {
        current: parseShortfallChangedDetail(error.details ?? null),
      });
    case 'idempotency_conflict':
      return shortfallRefusal('conflict', SHORTFALL_PO_CONFLICT_COPY, 'idempotency_conflict');
    case 'readiness_not_applicable': {
      const status = error.details || null;
      // A to_pick status here means the order has more than 200 lines.
      const capped = status !== null && (READINESS_TO_PICK_STATUSES as readonly string[]).includes(status);
      return shortfallRefusal(
        'conflict',
        capped ? SHORTFALL_PO_LINES_CAPPED_COPY : SHORTFALL_PO_NOT_APPLICABLE_COPY,
        'not_applicable',
        { status },
      );
    }
    case 'item_not_draftable':
      return shortfallRefusal('validation_error', SHORTFALL_PO_ITEM_NOT_DRAFTABLE_COPY, 'item_not_draftable', {
        items: parseRefusals(error.details),
      });
    case 'line_not_on_order':
      return shortfallRefusal('validation_error', SHORTFALL_PO_LINE_NOT_ON_ORDER_COPY, 'line_not_on_order', {
        itemId: error.details || null,
      });
    case 'line_invalid':
    case 'idempotency_key_required':
    case 'idempotency_key_too_long':
      return shortfallRefusal('validation_error', SHORTFALL_PO_INVALID_COPY, 'invalid');
    default:
      break;
  }
  if (code === '42501' && msg === 'forbidden') {
    return shortfallRefusal(
      'forbidden',
      error.hint === 'warehouse_write' ? SHORTFALL_PO_NO_WAREHOUSE_ACCESS_COPY : SHORTFALL_PO_FORBIDDEN_COPY,
      'forbidden',
    );
  }
  if (code === '42501' && msg === 'unauthenticated') {
    return shortfallRefusal('unauthenticated', SHORTFALL_PO_SIGN_IN_COPY, 'forbidden');
  }
  // save_purchase_order_draft's own refusals, passed through (0366): a kit's
  // stock or a deleted item (its message names the item when the caller can
  // read it), or an item that is not the organization's.
  if (error.hint === 'po_line_bundle' || error.hint === 'po_line_deleted') {
    return shortfallRefusal('validation_error', msg || SHORTFALL_PO_ITEM_NOT_DRAFTABLE_COPY, 'item_not_draftable');
  }
  if (error.hint === 'po_not_in_org') {
    return shortfallRefusal('validation_error', SHORTFALL_PO_ITEM_NOT_DRAFTABLE_COPY, 'item_not_draftable');
  }
  if (code === '57014') {
    return shortfallRefusal('conflict', SHORTFALL_PO_TIMEOUT_COPY, 'busy', { retryable: true });
  }
  if (code === '55P03' || code === '23505') {
    return shortfallRefusal('conflict', SHORTFALL_PO_BUSY_COPY, 'busy', { retryable: true });
  }
  return shortfallRefusal(
    'internal_error',
    `draft_order_shortfall_pos failed: ${code || 'no code'}: ${msg || 'no message'}`,
    'failed',
  );
}

/** The request, checked before anything is read: the function refuses the
 *  same (22023), said here in core's words first. */
function checkShortfallInput(input: DraftShortfallPosInput): {
  orderId: string;
  lines: ShortfallPoLine[];
  key: string;
} {
  const invalid = () => shortfallRefusal('validation_error', SHORTFALL_PO_INVALID_COPY, 'invalid');
  if (typeof input.orderId !== 'string' || !UUID_RE.test(input.orderId)) {
    throw shortfallRefusal('not_found', SHORTFALL_PO_NOT_FOUND_COPY, 'not_found');
  }
  const key = typeof input.idempotencyKey === 'string' ? input.idempotencyKey.trim() : '';
  if (key === '' || key.length > SHORTFALL_PO_KEY_MAX) throw invalid();
  if (!Array.isArray(input.lines) || input.lines.length < 1 || input.lines.length > SHORTFALL_PO_MAX_LINES) {
    throw invalid();
  }
  const seen = new Set<string>();
  const lines: ShortfallPoLine[] = [];
  for (const l of input.lines) {
    if (!l || typeof l.itemId !== 'string' || !UUID_RE.test(l.itemId)) throw invalid();
    if (typeof l.quantity !== 'number' || !Number.isFinite(l.quantity)) throw invalid();
    // The quantity columns' grid (numeric(14,4)), as the function rounds.
    const q = Math.round(l.quantity * 10_000) / 10_000;
    if (q <= 0) throw invalid();
    const id = l.itemId.toLowerCase();
    if (seen.has(id)) throw invalid();
    seen.add(id);
    lines.push({ itemId: id, quantity: q });
  }
  return { orderId: input.orderId.toLowerCase(), lines, key };
}

export class OrderReadinessService {
  constructor(
    private readonly ctx: ServiceContext,
    private readonly now: () => Date = () => new Date(),
  ) {}

  static async forCurrentUser() {
    return new OrderReadinessService(await withContext());
  }

  /** The order's readiness, or a ServiceError (never an empty answer). */
  async get(orderId: string): Promise<OrderReadinessAssessment> {
    assertModuleEnabled(this.ctx, 'orders');
    if (typeof orderId !== 'string' || !UUID_RE.test(orderId)) {
      throw new ServiceError('not_found', READINESS_ORDER_NOT_FOUND_COPY);
    }
    // A uuid is case-insensitive and the database answers in lower case: ask
    // in that form, so the answer's id is compared like for like (an order
    // URL typed in upper case is the same order).
    const id = orderId.toLowerCase();
    const res = await this.ctx.supabase.rpc('order_readiness_facts', { p_order_id: id });
    const { data, error } = res as { data: unknown; error: RpcError | null };
    if (error) {
      const r = res as { status?: number | null; statusText?: string | null };
      throw mapReadinessRpcError(error, { status: r.status, statusText: r.statusText });
    }
    let facts;
    try {
      facts = parseOrderReadinessFacts(data);
    } catch (err) {
      throw new ServiceError(
        'internal_error',
        `order_readiness_facts returned an unexpected shape: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!readinessAnswersOrder(facts, id)) {
      throw new ServiceError('internal_error', 'order_readiness_facts answered for another order');
    }
    return assessOrderReadiness(facts, { now: this.now() });
  }

  /**
   * `get`, settled: an assessment, or `failed` for ANY error (reported, never
   * swallowed), so a page can render "Couldn't check readiness" in its own
   * card instead of throwing into the error boundary.
   */
  async result(orderId: string): Promise<OrderReadinessResult> {
    try {
      return { state: 'ok', assessment: await this.get(orderId) };
    } catch (err) {
      const code = err instanceof ServiceError ? err.code : 'internal_error';
      if (code === 'internal_error') {
        void reportError(err, {
          tag: 'orders.readiness_failed',
          level: 'warning',
          organizationId: this.ctx.organizationId,
          extra: { detail: err instanceof ServiceError ? (err.internalDetail ?? err.message) : String(err) },
        });
      }
      return { state: 'failed', message: failureMessage(err) };
    }
  }

  /**
   * Draft purchase orders for exactly the quantities chosen from an order's
   * shortfall (F2-5): one draft per supplier plus one for the items with no
   * supplier, all or nothing, through draft_order_shortfall_pos (0385), which
   * repeats every floor below, takes the reorder drafts' lock, recomputes
   * what may be drafted and refuses anything above it (never lowers it).
   *
   * Floors here first (pattern #4: the same as the database's, so no screen
   * offers what it refuses): both modules; a manager (idempotency keys are
   * manager-only) holding purchase_orders:manage, the MFA step-up included;
   * write access to the order's warehouse.
   *
   * On a new draft (not a replay): one audit entry on the order
   * (order_request.shortfall_po_drafted: the PO ids and numbers and the lines,
   * never a cost) and one purchase_order.created per draft, written together;
   * and po.created dispatched per draft to the organization's integrations,
   * as every other draft create does (best-effort). A replay writes nothing:
   * the first call already did. No email and no in-app notification is
   * sent; the organization's configured integrations (webhooks, Slack,
   * Teams) receive po.created per new draft, as for every draft PO.
   */
  async draftShortfallPos(input: DraftShortfallPosInput): Promise<ShortfallPoResult> {
    try {
      return await this.draftShortfallPosIn(input);
    } catch (e) {
      if (e instanceof ServiceError && e.code === 'internal_error') {
        void reportError(e.internalDetail ? new Error(e.internalDetail) : e, {
          tag: 'orders.shortfall_po_failed',
          organizationId: this.ctx.organizationId,
          extra: { orderId: input.orderId, detail: e.internalDetail ?? null },
        });
      }
      throw e;
    }
  }

  private async draftShortfallPosIn(input: DraftShortfallPosInput): Promise<ShortfallPoResult> {
    const ctx = this.ctx;
    if (!isModuleEnabled(ctx, 'orders')) {
      throw shortfallRefusal('module_disabled', SHORTFALL_PO_ORDERS_OFF_COPY, 'module_disabled', { module: 'orders' });
    }
    if (!isModuleEnabled(ctx, 'purchase_orders')) {
      throw shortfallRefusal('module_disabled', SHORTFALL_PO_PURCHASE_ORDERS_OFF_COPY, 'module_disabled', {
        module: 'purchase_orders',
      });
    }
    // Refused in core's words; the MFA step-up is left to assertPermission,
    // which words it for the step-up prompt.
    if (!(ctx.mfaRequired && !ctx.mfaSatisfied) && !(isManagerOrAbove(ctx.role) && can(ctx, 'purchase_orders:manage'))) {
      throw shortfallRefusal('forbidden', SHORTFALL_PO_FORBIDDEN_COPY, 'forbidden');
    }
    assertPermission(ctx, 'purchase_orders:manage');
    const req = checkShortfallInput(input);

    const orderRes = await ctx.supabase
      .from('order_requests')
      .select('id, warehouse_id, order_number')
      .eq('organization_id', ctx.organizationId)
      .eq('id', req.orderId)
      .maybeSingle();
    if (orderRes.error) {
      throw new ServiceError('internal_error', `shortfall PO: order read failed: ${orderRes.error.message}`);
    }
    const order = orderRes.data as { id: string; warehouse_id: string; order_number: number | null } | null;
    if (!order) throw shortfallRefusal('not_found', SHORTFALL_PO_NOT_FOUND_COPY, 'not_found');
    try {
      await assertWarehouseAccess(order.warehouse_id, 'write', ctx);
    } catch (e) {
      if (e instanceof Error && e.name === 'ForbiddenError') {
        throw shortfallRefusal('forbidden', SHORTFALL_PO_NO_WAREHOUSE_ACCESS_COPY, 'forbidden');
      }
      throw e;
    }

    const res = await ctx.supabase.rpc('draft_order_shortfall_pos', {
      p_order_id: req.orderId,
      p_lines: req.lines.map((l) => ({ item_id: l.itemId, quantity: l.quantity })),
      p_idempotency_key: req.key,
    });
    const { data, error } = res as {
      data: unknown;
      error: { message?: string; code?: string; hint?: string | null; details?: string | null } | null;
    };
    if (error) throw shortfallPoRpcError(error);
    let result: ShortfallPoResult;
    try {
      result = parseShortfallPoResult(data);
    } catch (e) {
      throw new ServiceError(
        'internal_error',
        `draft_order_shortfall_pos answered a shape it should not: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (result.orderId.toLowerCase() !== req.orderId) {
      throw new ServiceError('internal_error', 'draft_order_shortfall_pos answered for another order');
    }
    if (result.replay || result.created.length === 0) return result;
    // The drafts go through save_purchase_order_draft, which can tag
    // inventory_items (PO-born custom items). This call passes none, so no
    // item row changes today; the Items/Books cache is expired anyway, as
    // for every service call that reaches a stock-table write (the
    // inventory-list-invalidation guard): one tag, once per new draft call.
    invalidateInventoryListAfterWrite(ctx.organizationId, 'orders.shortfall_po');

    const payloads: AuditPayload[] = [
      {
        event: 'order_request.shortfall_po_drafted',
        entityType: 'order_request',
        entityId: req.orderId,
        warehouseId: order.warehouse_id,
        extra: {
          purchase_order_ids: result.created.map((c) => c.purchaseOrderId),
          po_numbers: result.created.map((c) => c.poNumber),
          lines: result.created.flatMap((c) =>
            c.lines.map((l) => ({ item_id: l.itemId, quantity: l.quantity, purchase_order_id: c.purchaseOrderId })),
          ),
        },
      },
      ...result.created.map(
        (c): AuditPayload => ({
          event: 'purchase_order.created',
          entityType: 'purchase_order',
          entityId: c.purchaseOrderId,
          extra: {
            po_number: c.poNumber,
            supplier_id: c.supplierId,
            line_count: c.lineCount,
            source: 'order_shortfall',
            order_request_id: req.orderId,
          },
        }),
      ),
    ];
    await auditMany(payloads, ctx);
    // Fan out to configured webhooks / Slack / Teams (best-effort), as
    // createDraftPo does for every draft; dispatchEvent never throws.
    void mapWithConcurrency(result.created, PO_CREATED_DISPATCH_CONCURRENCY, (c) =>
      dispatchEvent(ctx.organizationId, 'po.created', {
        id: c.purchaseOrderId,
        poNumber: c.poNumber,
        lineCount: c.lineCount,
      }),
    ).catch(() => {});
    return result;
  }
}

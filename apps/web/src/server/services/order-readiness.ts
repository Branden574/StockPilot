import 'server-only';

import {
  assessOrderReadiness,
  parseOrderReadinessFacts,
  type OrderReadinessAssessment,
  type OrderReadinessResult,
} from '@stockpilot/core';

import { reportError } from '@/lib/error-reporter';

import { assertModuleEnabled, ServiceError, withContext, type ServiceContext } from './context';
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
 *   42501 unauthenticated          -> forbidden
 *   P0001 hint module_disabled     -> module_disabled
 *   anything else                  -> internal_error (the raw text stays in
 *                                     internalDetail, server side)
 */
export function mapReadinessRpcError(
  error: RpcError,
  response: { status?: number | null; statusText?: string | null } = {},
): ServiceError {
  const code = error.code ?? '';
  const message = error.message ?? '';
  if (code === 'P0002' || message === 'order_request_not_found') {
    return new ServiceError('not_found', 'Order not found.');
  }
  if (code === '42501') {
    return new ServiceError('forbidden', 'You are not allowed to check readiness for this order.');
  }
  if (error.hint === 'module_disabled' || message === 'module_disabled') {
    return new ServiceError('module_disabled', 'Module not enabled for this organization: orders');
  }
  return new ServiceError(
    'internal_error',
    `order_readiness_facts failed: ${postgrestErrorText(error, response)}`,
  );
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
      throw new ServiceError('not_found', 'Order not found.');
    }
    const res = await this.ctx.supabase.rpc('order_readiness_facts', { p_order_id: orderId });
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
    if (facts.order.id !== orderId) {
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
      return {
        state: 'failed',
        message: err instanceof ServiceError ? err.message : 'Could not check readiness.',
      };
    }
  }
}

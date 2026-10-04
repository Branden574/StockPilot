import 'server-only';

import {
  formatOrderNumber,
  NEEDED_BY_IN_PAST_COPY,
  NEEDED_BY_OUT_OF_RANGE_COPY,
  ORDER_BUSY_COPY,
  ORDER_CONFLICT_COPY,
  ORDER_MODULE_DISABLED_COPY,
  ORDER_ON_BEHALF_NOT_PERMITTED_COPY,
  ORDER_PERMISSION_COPY,
  ORDER_PLACER_MISMATCH_COPY,
  ORDER_REFUSED_FINAL_COPY,
  ORDER_SIGN_IN_COPY,
  ORDER_SITE_INACTIVE_COPY,
  ORDER_WAREHOUSE_NOT_AVAILABLE_COPY,
  ORDER_WITHDRAWN_COPY,
  orderCreateRefusalCopy,
  orderItemsNotOrderableCopy,
  orderShapeRefusalFromSql,
  orderSiteNotServicedCopy,
  parseOrderSummary,
  type OrderSubmissionStatus,
  type OrderSummary,
} from '@stockpilot/core';

import { ServiceError } from './context';

/**
 * place_order_request, withdraw_order_submission and order_submission_status
 * (migration 0391) as the service speaks them: every raise and every recorded
 * reason mapped to a ServiceError with core's words and the `details` both
 * surfaces classify by (core classifyOrderSubmitResult reads status, code and
 * details only, never the message). Mapped by the function's own hint first,
 * then by SQLSTATE, specific before general (pattern #28); anything else is
 * internal_error, whose public message is the generic sentence and whose raw
 * text stays on internalDetail for the report.
 *
 * Plan 3.5's table, row by row:
 *   42501 placer_mismatch / not_member / unauthenticated -> forbidden (403)
 *   22023 order_invalid / delivery_needs_site            -> validation_error (400), core's reason
 *   22023 idempotency_key_*                              -> validation_error, invalid / idempotencyKey
 *   P0001 idempotency_conflict                           -> conflict (409), orderId / orderNumber
 *   55P03 (lock_timeout) / 57014 (statement timeout)     -> conflict, busy, retryable
 *   recorded module_disabled                             -> module_disabled (403), settled
 *   recorded permission / on_behalf_not_permitted        -> forbidden (403), settled
 *   recorded warehouse_not_available                     -> not_found (404), settled
 *   recorded needed_by_* / site_not_available /
 *     item_not_orderable / invalid                       -> validation_error (400), settled
 *   answered withdrawn                                   -> conflict, submission_withdrawn, settled
 */

export interface RpcError {
  message?: string | null;
  code?: string | null;
  hint?: string | null;
  details?: string | null;
}

function refusal(
  code: ServiceError['code'],
  message: string,
  details: Record<string, unknown>,
): ServiceError {
  return new ServiceError(code, message, details);
}

function parseDetailObject(text: string | null | undefined): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Errors the three functions RAISE (nothing recorded). `fn` names the
 *  function in the internal detail of a fault. */
export function orderSubmissionRpcError(fn: string, error: RpcError): ServiceError {
  const code = error.code ?? '';
  const hint = error.hint ?? '';
  switch (hint) {
    case 'placer_mismatch':
      return refusal('forbidden', ORDER_PLACER_MISMATCH_COPY, { reason: 'placer_mismatch' });
    case 'not_member':
    case 'unauthenticated':
      return refusal('forbidden', ORDER_SIGN_IN_COPY, { reason: hint });
    case 'order_invalid':
    case 'delivery_needs_site':
    case 'idempotency_key_required':
    case 'idempotency_key_invalid': {
      const shape = orderShapeRefusalFromSql(hint, error.details ?? null);
      return refusal('validation_error', orderCreateRefusalCopy(shape.reason, shape.field), {
        reason: shape.reason,
        ...(shape.field ? { field: shape.field } : {}),
      });
    }
    case 'idempotency_conflict': {
      const d = parseDetailObject(error.details);
      const orderId = typeof d?.orderId === 'string' ? d.orderId : null;
      const orderNumber =
        typeof d?.orderNumber === 'number' && Number.isInteger(d.orderNumber)
          ? d.orderNumber
          : null;
      return refusal('conflict', ORDER_CONFLICT_COPY, {
        reason: 'idempotency_conflict',
        ...(orderId ? { orderId } : {}),
        ...(orderNumber !== null ? { orderNumber } : {}),
      });
    }
    default:
      break;
  }
  if (code === '55P03' || code === '57014') {
    return refusal('conflict', ORDER_BUSY_COPY, { reason: 'busy', retryable: true });
  }
  return new ServiceError(
    'internal_error',
    `${fn} failed: ${code || 'no code'}: ${error.message || 'no message'}`,
    { reason: 'failed' },
  );
}

/** A refusal RECORDED under the key (place_order_request returned it), now
 *  or on an earlier send (`replay`). Final: `settled: true`. */
export function orderRecordedRefusalError(
  raw: { reason?: unknown; detail?: unknown } | null | undefined,
  replay: boolean,
): ServiceError {
  const reason = typeof raw?.reason === 'string' && raw.reason !== '' ? raw.reason : 'refused';
  const detail = raw?.detail ?? null;
  const base = { reason, settled: true, replay };
  switch (reason) {
    case 'module_disabled':
      return refusal('module_disabled', ORDER_MODULE_DISABLED_COPY, base);
    case 'permission':
      return refusal('forbidden', ORDER_PERMISSION_COPY, base);
    case 'on_behalf_not_permitted':
      return refusal('forbidden', ORDER_ON_BEHALF_NOT_PERMITTED_COPY, base);
    case 'warehouse_not_available':
      return refusal('not_found', ORDER_WAREHOUSE_NOT_AVAILABLE_COPY, base);
    case 'needed_by_past':
      return refusal('validation_error', NEEDED_BY_IN_PAST_COPY, base);
    case 'needed_by_out_of_range':
      return refusal('validation_error', NEEDED_BY_OUT_OF_RANGE_COPY, base);
    case 'site_not_available': {
      const site = detail === 'inactive' ? 'inactive' : 'not_serviced';
      return refusal(
        'validation_error',
        site === 'inactive' ? ORDER_SITE_INACTIVE_COPY : orderSiteNotServicedCopy(null),
        { ...base, site },
      );
    }
    case 'item_not_orderable': {
      const items: Record<string, string> = {};
      if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
        for (const [k, v] of Object.entries(detail as Record<string, unknown>)) {
          if (typeof v === 'string') items[k] = v;
        }
      }
      // The names come from the person's own cart (never from here, so an item
      // the person cannot see never leaks a name).
      return refusal('validation_error', orderItemsNotOrderableCopy([]), { ...base, items });
    }
    case 'invalid':
      return refusal('validation_error', orderCreateRefusalCopy('invalid', 'quantity'), {
        ...base,
        field: 'quantity',
      });
    default:
      return refusal('validation_error', ORDER_REFUSED_FINAL_COPY, base);
  }
}

/** The key was withdrawn ("Don't send it"): it can never place. Final. */
export function orderSubmissionWithdrawnError(): ServiceError {
  return refusal('conflict', ORDER_WITHDRAWN_COPY, {
    reason: 'submission_withdrawn',
    settled: true,
  });
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

/**
 * _order_submission_summary's snake_case object as core's OrderSummary,
 * checked by core's own parser (parseOrderSummary throws on a missing or
 * wrong field, so a shape drift is a fault, never a half-read answer).
 */
export function orderSummaryFromRpc(raw: unknown): OrderSummary {
  const r = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<
    string,
    unknown
  >;
  const orderNumber =
    typeof r.order_number === 'number' && Number.isInteger(r.order_number) ? r.order_number : null;
  const onBehalf = r.requester_user_id == null && str(r.requester_email) !== null;
  return parseOrderSummary({
    id: r.id,
    orderNumber,
    orderLabel: formatOrderNumber(orderNumber),
    status: r.status,
    warehouseId: r.warehouse_id,
    fulfillmentType: r.fulfillment_type,
    deliveryCharterId: r.delivery_charter_id ?? null,
    neededBy: r.needed_by ?? null,
    lineCount: r.line_count,
    unitCount: r.unit_count,
    createdAt: r.created_at,
    requestedFor: onBehalf
      ? {
          self: false,
          name: str(r.requester_name) ?? str(r.requester_email),
          email: r.requester_email,
        }
      : { self: true },
  });
}

/** order_submission_status's and withdraw_order_submission's answer, with the
 *  organization the caller is in, as core's OrderSubmissionStatus. A recorded
 *  refusal's detail is passed as the database recorded it (core reads both
 *  shapes). Throws on an outcome it does not know. */
export function submissionStatusFromRpc(
  organizationId: string,
  raw: unknown,
): OrderSubmissionStatus {
  const r = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<
    string,
    unknown
  >;
  switch (r.outcome) {
    case 'none':
      return { organizationId, outcome: 'none' };
    case 'withdrawn':
      return { organizationId, outcome: 'withdrawn' };
    case 'placed':
      return { organizationId, outcome: 'placed', order: orderSummaryFromRpc(r.order) };
    case 'refused': {
      const rf = (r.refusal && typeof r.refusal === 'object' ? r.refusal : {}) as Record<
        string,
        unknown
      >;
      const reason = str(rf.reason);
      if (!reason) throw new ServiceError('internal_error', 'a recorded refusal has no reason');
      return { organizationId, outcome: 'refused', refusal: { reason, detail: rf.detail ?? null } };
    }
    default:
      throw new ServiceError('internal_error', `unknown submission outcome: ${String(r.outcome)}`);
  }
}

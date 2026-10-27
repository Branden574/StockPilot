'use server';

import { rethrowControlFlow } from '@/lib/control-flow';
import { reportError } from '@/lib/error-reporter';
import { ServiceError, withContext } from '@/server/services/context';
import { OrderCatalogVisibilityService } from '@/server/services/order-catalog-visibility';

import {
  err,
  ok,
  ORDER_ITEMS_INTERNAL_COPY,
  type ActionResult,
  type OrderCatalogVisibilityWriteAnswer,
} from '@stockpilot/core';

/**
 * Show in Orders / Hide from Orders from the web's Manage order items page
 * (ordering visibility, 0413; design 4.3). Surface 'web'.
 *
 * The answer names exactly what this call changed and what was already in that
 * state. A refusal passes its `details` through, so the page decides by
 * `details.reason` (core ORDER_CATALOG_REFUSALS, plus 'rate_limited'), never by
 * message text:
 *   forbidden | feature_disabled | module_disabled  final: lock the page
 *   aal2_required   useStepUp() re-prompts, then send the SAME operationId
 *   mfa_required    enrol first
 *   items_unavailable (details.itemIds)  nothing changed; reload the list
 *   invalid         malformed request (details.field)
 *   busy (retryable, details.operationId)  nothing changed; retry the same
 *                   operationId
 *   rate_limited (retryable, details.retryAfterSeconds)
 * An internal error carries no details and core's words, never the database's.
 */
export async function setOrderCatalogVisibilityAction(input: {
  itemIds: string[];
  visible: boolean;
  operationId: string;
}): Promise<ActionResult<OrderCatalogVisibilityWriteAnswer>> {
  try {
    const ctx = await withContext();
    const answer = await new OrderCatalogVisibilityService(ctx).setVisibility({
      itemIds: input?.itemIds,
      visible: input?.visible,
      operationId: input?.operationId,
      surface: 'web',
    });
    return ok(answer);
  } catch (error) {
    rethrowControlFlow(error);
    if (error instanceof ServiceError && error.code !== 'internal_error') {
      return error.details
        ? err(error.code, error.message, error.details)
        : err(error.code, error.message);
    }
    void reportError(
      error instanceof ServiceError && error.internalDetail ? new Error(error.internalDetail) : error,
      { tag: 'order_catalog_visibility.action' },
    );
    return err('internal_error', ORDER_ITEMS_INTERNAL_COPY);
  }
}

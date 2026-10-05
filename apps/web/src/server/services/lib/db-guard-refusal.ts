import {
  dbGuardHint,
  dbPermissionRefusedCopy,
  ITEM_HOLDS_STOCK_COPY,
  ORDER_CANCEL_REQUESTER_PENDING_ONLY_COPY,
  type DbPermissionAction,
} from '@stockpilot/core';

import { ServiceError } from '../context';

/**
 * A 0396 database refusal as the ServiceError the app shows, or null for any
 * other error (each call site then maps the rest exactly as before). Call it
 * first in an RPC's error branch: the 42501s keep the message 'forbidden', so
 * a later `includes('forbidden')` arm would otherwise put a different
 * sentence on them (adjust's and transfer's warehouse wording, for one).
 *
 *   requester_pending_only -> 403 forbidden, the cancel window sentence
 *   permission             -> 403 forbidden, "<Action> needs the <label>
 *                             permission." for the action this call site is
 *   item_holds_stock       -> 400 validation_error, the holds-stock sentence
 *
 * The phone shows these sentences: it reaches every one of these actions
 * through the API, whose routes forward a ServiceError's message.
 */
export function dbGuardRefusal(
  error: { code?: string | null; hint?: string | null } | null | undefined,
  action?: DbPermissionAction,
): ServiceError | null {
  switch (dbGuardHint(error)) {
    case 'requester_pending_only':
      return new ServiceError('forbidden', ORDER_CANCEL_REQUESTER_PENDING_ONLY_COPY);
    case 'permission':
      return new ServiceError(
        'forbidden',
        action ? dbPermissionRefusedCopy(action) : "You don't have permission to do this.",
      );
    case 'item_holds_stock':
      return new ServiceError('validation_error', ITEM_HOLDS_STOCK_COPY);
    default:
      return null;
  }
}

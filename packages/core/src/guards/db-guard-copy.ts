/**
 * The database's own refusals that carry a hint (migration 0396, small fixes
 * slice 2), in the words the web and the phone both show.
 *
 * The web services map each hint to a ServiceError with one of these
 * sentences; the phone reaches every one of these actions through the API, so
 * it shows the service's sentence (the adjust, move, receive, count and order
 * screens all put the server's message on screen). Before 0396 the app
 * refused these cases itself and the database did not, so a hint normally
 * appears only when the two disagree for a moment: a status that changed
 * between the service's read and the call, a permission revoked mid-request,
 * or a raw call that skipped the service.
 *
 *   requester_pending_only (42501)  cancel_order_request: the person who
 *                                   placed the order cancels it only while it
 *                                   is pending approval.
 *   item_holds_stock       (23514)  an item with stock on record, or a
 *                                   holding, is never soft-deleted.
 *   permission             (42501)  a ledger function called without the
 *                                   permission the app checks first.
 */
import { PERMISSION_META, type Permission } from '../constants/permissions';

export const ORDER_CANCEL_REQUESTER_PENDING_ONLY_COPY =
  'Only a pending order can be cancelled by the person who placed it. Ask someone who approves orders to cancel it.';

export const ITEM_HOLDS_STOCK_COPY =
  'This item still has stock on record, so it cannot be deleted. Remove or move its stock first.';

/** The ledger actions 0396 gates, each with the permission the app asks first. */
export type DbPermissionAction =
  | 'adjust'
  | 'transfer'
  | 'count_post'
  | 'receipt_post'
  | 'receipt_reverse'
  | 'kit_assemble';

const PERMISSION_ACTIONS: Record<DbPermissionAction, { lead: string; permission: Permission }> = {
  adjust: { lead: 'Adjusting stock', permission: 'stock:adjust' },
  transfer: { lead: 'Moving stock', permission: 'stock:transfer' },
  count_post: { lead: 'Posting a count', permission: 'stock:adjust' },
  receipt_post: { lead: 'Receiving stock', permission: 'stock:adjust' },
  receipt_reverse: { lead: 'Reversing a receipt', permission: 'stock:adjust' },
  kit_assemble: { lead: 'Assembling a kit', permission: 'bundles:manage' },
};

/** The permission a gated ledger action needs (the one its service asserts). */
export function dbPermissionFor(action: DbPermissionAction): Permission {
  return PERMISSION_ACTIONS[action].permission;
}

/**
 * "Adjusting stock needs the Adjust on-hand permission. Ask an admin if you
 * need it." The permission is named as Settings > Roles names it.
 */
export function dbPermissionRefusedCopy(action: DbPermissionAction): string {
  const a = PERMISSION_ACTIONS[action];
  return `${a.lead} needs the ${PERMISSION_META[a.permission].label} permission. Ask an admin if you need it.`;
}

export type DbGuardHint = 'requester_pending_only' | 'item_holds_stock' | 'permission';

/**
 * Which 0396 refusal a PostgREST error is, or null for any other error. Keyed
 * on the SQLSTATE and the hint together: the message stays 'forbidden' on the
 * 42501s (so older mappings that only read the message still refuse), and a
 * hint alone could come from any function.
 */
export function dbGuardHint(
  error: { code?: string | null; hint?: string | null } | null | undefined,
): DbGuardHint | null {
  if (!error) return null;
  if (error.code === '42501' && (error.hint === 'requester_pending_only' || error.hint === 'permission')) {
    return error.hint;
  }
  if (error.code === '23514' && error.hint === 'item_holds_stock') return 'item_holds_stock';
  return null;
}

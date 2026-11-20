import 'server-only';

import {
  RECEIVE_MANAGER_ONLY_COPY,
  REVERSE_MANAGER_ONLY_COPY,
  roleCanReceivePurchaseOrders,
} from '@stockpilot/core';

import {
  assertModuleEnabled,
  assertPermission,
  ServiceError,
  type ServiceContext,
} from '../context';

/**
 * Throws unless this caller's ROLE lets them post a receipt: manager or above
 * (core roleCanReceivePurchaseOrders), post_receipt_v2's own has_org_role
 * check and its row lock of the order, which a grant of
 * purchase_orders:manage does not pass. The refusal carries the sentence
 * only, no details: installed phones show a refusal's details.reason in place
 * of its sentence.
 */
export function assertRoleCanPostReceipt(ctx: ServiceContext): void {
  if (!roleCanReceivePurchaseOrders(ctx.role)) {
    throw new ServiceError('forbidden', RECEIVE_MANAGER_ONLY_COPY);
  }
}

/**
 * Throws unless this caller may post a receipt, before anything is read: the
 * receiving module (the app's own check), then the rule post_receipt_v2
 * applies (core canPostReceipt): stock:adjust (the wrapper's has_permission
 * check), then the role (assertRoleCanPostReceipt). The receive-line route
 * asks it before it reads the order; ReceivingService.postReceipt asks the
 * same three checks in the same order.
 */
export function assertCanPostReceipt(ctx: ServiceContext): void {
  assertModuleEnabled(ctx, 'receiving');
  assertPermission(ctx, 'stock:adjust');
  assertRoleCanPostReceipt(ctx);
}

/**
 * Throws unless this caller's ROLE lets them reverse a receipt: manager or
 * above, reverse_receipt's own has_org_role check (the same role half as a
 * post, core canPostReceipt). The refusal carries the sentence only, no
 * details, as a post's does.
 */
export function assertRoleCanReverseReceipt(ctx: ServiceContext): void {
  if (!roleCanReceivePurchaseOrders(ctx.role)) {
    throw new ServiceError('forbidden', REVERSE_MANAGER_ONLY_COPY);
  }
}

/**
 * Throws unless this caller may reverse a receipt, before anything is read:
 * the receiving module, then the rule reverse_receipt applies (core
 * canPostReceipt): stock:adjust (the wrapper's has_permission check), then
 * the role (assertRoleCanReverseReceipt). ReceivingService.reverseReceipt
 * asks the same three checks in the same order.
 */
export function assertCanReverseReceipt(ctx: ServiceContext): void {
  assertModuleEnabled(ctx, 'receiving');
  assertPermission(ctx, 'stock:adjust');
  assertRoleCanReverseReceipt(ctx);
}

import 'server-only';

import { can, receivingGate, type ReceivingGate } from '@stockpilot/core';

import { isModuleEnabled, type ServiceContext } from '../context';

/**
 * core receivingGate for a request context, from its effective permissions
 * and modules: the one predicate ReceivingService.postReceipt, the receiving
 * checklist service, the web PO page and the phone share (F4-1, pattern #26).
 */
export function receivingGateFor(ctx: ServiceContext): ReceivingGate {
  return receivingGate({
    role: ctx.role,
    canAdjust: can(ctx, 'stock:adjust'),
    canReadPo: can(ctx, 'purchase_orders:read'),
    canManagePo: can(ctx, 'purchase_orders:manage'),
    receivingOn: isModuleEnabled(ctx, 'receiving'),
  });
}

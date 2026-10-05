import {
  ORDERS_LIST_EMPTY_BODY_COPY,
  ORDERS_LIST_EMPTY_OWN_BODY_COPY,
  ORDERS_LIST_EMPTY_TITLE_COPY,
  ORDERS_LIST_LOAD_FAILED_BODY_COPY,
  ORDERS_LIST_LOAD_FAILED_TITLE_COPY,
  ORDERS_LIST_RELOAD_FAILED_COPY,
  ORDER_STATUS_META,
  isOrderStatusKey,
  type OrderStatusColor,
  type Permission,
  type Role,
} from '@stockpilot/core';

import { showWriteCtaForRole } from './cta-gating';

/**
 * THE ORDERS LIST'S DECISIONS (phone ordering PO-4; audit D4, D5, D6). Pure,
 * so the screen (src/screens/orders.tsx, which vitest cannot load) is pinned
 * to them by order-storefront-wiring.test.ts.
 */

export type PillStatus = 'default' | 'ok' | 'warn' | 'crit';

/** Core's badge colours as the phone's four pill statuses. */
const PILL_FOR_COLOR: Record<OrderStatusColor, PillStatus> = {
  default: 'default',
  secondary: 'default',
  outline: 'default',
  success: 'ok',
  warning: 'warn',
  destructive: 'crit',
};

/**
 * Every status's pill from core's status defaults (customization/
 * order-status.ts ORDER_STATUS_META), the web badge's words. Only four of the
 * thirteen statuses had a pill before; the rest showed their raw key (D6).
 */
export function orderStatusPill(status: string): { label: string; status: PillStatus } {
  if (!isOrderStatusKey(status)) return { label: status.replace(/_/g, ' ').toUpperCase(), status: 'default' };
  const meta = ORDER_STATUS_META[status];
  return { label: meta.label.toUpperCase(), status: PILL_FOR_COLOR[meta.color] };
}

/** "+" and the empty state's "Place an order": the Orders module is on and
 *  the person may request orders (the effective set when loaded, else the
 *  role's defaults; the server refuses on its own). */
export function showPlaceOrder(input: {
  role: Role | null;
  permissions: ReadonlySet<Permission> | undefined;
  ordersModuleEnabled: boolean;
}): boolean {
  return input.ordersModuleEnabled && showWriteCtaForRole(input.role, input.permissions, 'orders:request');
}

/** What the list shows when it has no rows: a read that FAILED is not "No
 *  orders yet." (D4: the read ignored its error). Someone who does not
 *  approve orders sees only their own requests, so their empty list says so
 *  (PO-4 review). */
export function ordersListEmpty(failed: boolean, approver: boolean): { title: string; body: string } {
  if (failed) return { title: ORDERS_LIST_LOAD_FAILED_TITLE_COPY, body: ORDERS_LIST_LOAD_FAILED_BODY_COPY };
  return { title: ORDERS_LIST_EMPTY_TITLE_COPY, body: approver ? ORDERS_LIST_EMPTY_BODY_COPY : ORDERS_LIST_EMPTY_OWN_BODY_COPY };
}

/** A read again that failed over the rows already shown says so above them
 *  (desk check F12, PO-4 review); with no rows, the empty state says it. */
export function ordersListReloadNote(failed: boolean, rowCount: number): string | null {
  return failed && rowCount > 0 ? ORDERS_LIST_RELOAD_FAILED_COPY : null;
}

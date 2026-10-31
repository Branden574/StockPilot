import {
  ORDER_CATALOG_VISIBILITY_PERMISSION,
  ORDERS_LIST_EMPTY_BODY_COPY,
  ORDERS_LIST_EMPTY_OWN_BODY_COPY,
  ORDERS_LIST_EMPTY_TITLE_COPY,
  ORDERS_LIST_LOAD_FAILED_BODY_COPY,
  ORDERS_LIST_LOAD_FAILED_TITLE_COPY,
  ORDERS_LIST_RELOAD_FAILED_COPY,
  ORDER_STATUS_META,
  formatOrderNumber,
  isOrderStatusKey,
  orderStatusLabelForFulfillment,
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
 * With the order's fulfilment a completed pickup reads HANDED OVER, never
 * DELIVERED (core orderStatusLabelForFulfillment, the web badge's rule;
 * returns RX-3 PR stage, polish (c)).
 */
export function orderStatusPill(status: string, fulfillmentType?: string | null): { label: string; status: PillStatus } {
  if (!isOrderStatusKey(status)) return { label: status.replace(/_/g, ' ').toUpperCase(), status: 'default' };
  const meta = ORDER_STATUS_META[status];
  return { label: orderStatusLabelForFulfillment(status, meta.label, fulfillmentType).toUpperCase(), status: PILL_FOR_COLOR[meta.color] };
}

/** The order screen's header line, "ORDER SO-000049 · PICKING": the status
 *  in the same words as the list's pill, never its raw key (L83a). The org's
 *  renamed statuses come in a later slice. A completed pickup reads HANDED
 *  OVER (polish (c)). */
export function orderHeaderEyebrow(orderNumber: number | null, status: string, fulfillmentType?: string | null): string {
  const number = orderNumber ? formatOrderNumber(orderNumber) : null;
  return `ORDER${number ? ` ${number}` : ''} · ${orderStatusPill(status, fulfillmentType).label}`;
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

/** The Orders list's "Manage order items" (ordering visibility, 0413; design
 *  8.1): the Orders module on and the EFFECTIVE set, once loaded, holds
 *  orders:manage_catalog_visibility. Strict on purpose: hidden while the set
 *  is unknown and never decided by the role, because StockPilot can deny a
 *  manager, admin or owner (and allow a staff member or viewer). Not gated by
 *  orders:request, so a member allowed to manage who cannot place orders has
 *  a way in. Cosmetic: the routes and the database refuse on their own. */
export function showManageOrderItems(input: {
  permissions: ReadonlySet<Permission> | undefined;
  ordersModuleEnabled: boolean;
}): boolean {
  return (
    input.ordersModuleEnabled &&
    input.permissions !== undefined &&
    input.permissions.has(ORDER_CATALOG_VISIBILITY_PERMISSION)
  );
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

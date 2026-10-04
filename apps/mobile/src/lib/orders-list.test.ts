import { describe, expect, it } from 'vitest';

import {
  ORDERS_LIST_LOAD_FAILED_BODY_COPY,
  ORDERS_LIST_LOAD_FAILED_TITLE_COPY,
  ORDER_STATUS_KEYS,
  type Permission,
} from '@stockpilot/core';

import { orderStatusPill, ordersListEmpty, showPlaceOrder } from './orders-list';

describe('the Orders list (phone ordering PO-4; audit D4, D6)', () => {
  it('every one of core’s statuses has its pill, in the web badge’s words (D6)', () => {
    for (const key of ORDER_STATUS_KEYS) {
      const pill = orderStatusPill(key);
      expect(pill.label).not.toMatch(/_/);
      expect(pill.label).toBe(pill.label.toUpperCase());
    }
    expect(orderStatusPill('pending_approval')).toEqual({ label: 'PENDING', status: 'warn' });
    expect(orderStatusPill('completed')).toEqual({ label: 'DELIVERED', status: 'ok' });
    expect(orderStatusPill('denied')).toEqual({ label: 'DENIED', status: 'crit' });
    expect(orderStatusPill('picking_in_progress')).toEqual({ label: 'PICKING', status: 'default' });
    expect(orderStatusPill('backordered')).toEqual({ label: 'BACKORDERED', status: 'warn' });
    expect(orderStatusPill('something_new')).toEqual({ label: 'SOMETHING NEW', status: 'default' });
  });

  it('a failed read is said, never "No orders yet." (D4)', () => {
    expect(ordersListEmpty(true)).toEqual({ title: ORDERS_LIST_LOAD_FAILED_TITLE_COPY, body: ORDERS_LIST_LOAD_FAILED_BODY_COPY });
    expect(ordersListEmpty(false).title).toBe('No orders yet.');
  });

  it('Place an order: the Orders module on and orders:request (the effective set when loaded)', () => {
    const none = new Set<Permission>();
    const req = new Set<Permission>(['orders:request']);
    expect(showPlaceOrder({ role: 'staff', permissions: req, ordersModuleEnabled: true })).toBe(true);
    expect(showPlaceOrder({ role: 'staff', permissions: req, ordersModuleEnabled: false })).toBe(false);
    expect(showPlaceOrder({ role: 'owner', permissions: none, ordersModuleEnabled: true })).toBe(false);
    // Not loaded: the role's defaults (every role requests by default).
    expect(showPlaceOrder({ role: 'viewer', permissions: undefined, ordersModuleEnabled: true })).toBe(true);
    expect(showPlaceOrder({ role: null, permissions: undefined, ordersModuleEnabled: true })).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';

import {
  ORDERS_LIST_EMPTY_BODY_COPY,
  ORDERS_LIST_EMPTY_OWN_BODY_COPY,
  ORDERS_LIST_EMPTY_TITLE_COPY,
  ORDERS_LIST_LOAD_FAILED_BODY_COPY,
  ORDERS_LIST_LOAD_FAILED_TITLE_COPY,
  ORDERS_LIST_RELOAD_FAILED_COPY,
  ORDER_STATUS_KEYS,
  resolveOrderStatusConfig,
  type Permission,
} from '@stockpilot/core';

import {
  orderHeaderEyebrow,
  orderStatusPill,
  ordersListEmpty,
  ordersListReloadNote,
  showPlaceOrder,
} from './orders-list';

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

  // L83a: the order screen's header printed the raw status key
  // ("PICKING IN PROGRESS"); it now uses the status's words, as the list does.
  it('the order screen header names every status in words, after the order number', () => {
    for (const key of ORDER_STATUS_KEYS) {
      const line = orderHeaderEyebrow(49, key);
      expect(line).toBe(`ORDER SO-000049 · ${orderStatusPill(key).label}`);
      expect(line).not.toMatch(/_/);
    }
    expect(ORDER_STATUS_KEYS).toHaveLength(14);
    expect(orderHeaderEyebrow(49, 'picking_in_progress')).toBe('ORDER SO-000049 · PICKING');
    expect(orderHeaderEyebrow(49, 'staged_for_delivery')).toBe('ORDER SO-000049 · READY');
    expect(orderHeaderEyebrow(49, 'in_transit')).toBe('ORDER SO-000049 · IN TRANSIT');
    expect(orderHeaderEyebrow(null, 'completed')).toBe('ORDER · DELIVERED');
  });

  // Returns RX-3 PR stage, polish (c), from the RX-2 Demo Co walk: a
  // completed PICKUP order's header read "DELIVERED". It now says HANDED OVER
  // (core orderStatusLabelForFulfillment, the web badge's rule), in the list
  // and in the header alike; a delivery keeps DELIVERED.
  it('a completed pickup reads HANDED OVER in the list and the header; a delivery keeps DELIVERED', () => {
    expect(orderStatusPill('completed', 'pickup')).toEqual({ label: 'HANDED OVER', status: 'ok' });
    expect(orderStatusPill('completed', 'delivery')).toEqual({ label: 'DELIVERED', status: 'ok' });
    expect(orderStatusPill('staged_for_pickup', 'pickup')).toEqual(orderStatusPill('staged_for_pickup'));
    expect(orderHeaderEyebrow(27, 'completed', 'pickup')).toBe('ORDER SO-000027 · HANDED OVER');
    expect(orderHeaderEyebrow(28, 'completed', 'delivery')).toBe('ORDER SO-000028 · DELIVERED');
  });

  it('a failed read is said, never "No orders yet." (D4)', () => {
    expect(ordersListEmpty(true, true)).toEqual({ title: ORDERS_LIST_LOAD_FAILED_TITLE_COPY, body: ORDERS_LIST_LOAD_FAILED_BODY_COPY });
    expect(ordersListEmpty(false, true).title).toBe('No orders yet.');
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

// PO-4 review: someone who does not approve orders sees only their own
// requests, yet the empty list said requests from their warehouses land
// here; and a read that failed over rows already shown said nothing.
describe('the Orders list says what is true for who is reading it (PO-4 review)', () => {
  it('an approver’s empty list: requests from their warehouses land here; anyone else’s: their own requests show here', () => {
    expect(ordersListEmpty(false, true)).toEqual({ title: ORDERS_LIST_EMPTY_TITLE_COPY, body: ORDERS_LIST_EMPTY_BODY_COPY });
    expect(ordersListEmpty(false, false)).toEqual({ title: ORDERS_LIST_EMPTY_TITLE_COPY, body: ORDERS_LIST_EMPTY_OWN_BODY_COPY });
  });
  it('a read that failed over rows already shown says so; with none shown the empty state says it', () => {
    expect(ordersListReloadNote(true, 3)).toBe(ORDERS_LIST_RELOAD_FAILED_COPY);
    expect(ordersListReloadNote(true, 0)).toBeNull();
    expect(ordersListReloadNote(false, 3)).toBeNull();
  });
});

// L83b: the phone ignored the organization's own status words and colours
// (Settings > Order statuses), so the same order read differently on the web.
// The pill, the order screen header and the placed screen now take core's
// resolved config. The one live organization with a config today (63c13e64)
// changes seven COLOURS and no words; RENAMED is the words case.
describe("the organization's status names and colours (L83b)", () => {
  const RENAMED = resolveOrderStatusConfig({
    pending_approval: { label: 'Waiting for sign-off' },
    picking_in_progress: { label: 'Being picked', color: 'warning' },
  });
  const COLOURS_ONLY = resolveOrderStatusConfig({
    cancelled: { color: 'destructive' },
    in_transit: { color: 'warning' },
    packing_slip_generated: { color: 'warning' },
    picking_complete: { color: 'success' },
    picking_in_progress: { color: 'warning' },
    staged_for_delivery: { color: 'success' },
    staged_for_pickup: { color: 'success' },
  });

  it("the list pill shows the organization's words and colour", () => {
    expect(orderStatusPill('picking_in_progress', null, RENAMED)).toEqual({ label: 'BEING PICKED', status: 'warn' });
    expect(orderStatusPill('pending_approval', null, RENAMED)).toEqual({ label: 'WAITING FOR SIGN-OFF', status: 'warn' });
    // A status the organization did not touch keeps core's words and colour.
    expect(orderStatusPill('approved', null, RENAMED)).toEqual(orderStatusPill('approved'));
  });

  it("a colours-only config changes the pill's colour and keeps core's words", () => {
    expect(orderStatusPill('cancelled', null, COLOURS_ONLY)).toEqual({ label: 'CANCELLED', status: 'crit' });
    expect(orderStatusPill('staged_for_pickup', null, COLOURS_ONLY)).toEqual({ label: 'STAGED (PICKUP)', status: 'ok' });
    expect(orderStatusPill('picking_in_progress', null, COLOURS_ONLY)).toEqual({ label: 'PICKING', status: 'warn' });
    expect(orderStatusPill('in_transit', null, COLOURS_ONLY)).toEqual({ label: 'IN TRANSIT', status: 'warn' });
  });

  it('the order screen header uses the same words as the pill', () => {
    expect(orderHeaderEyebrow(49, 'picking_in_progress', null, RENAMED)).toBe('ORDER SO-000049 · BEING PICKED');
    expect(orderHeaderEyebrow(null, 'pending_approval', null, RENAMED)).toBe('ORDER · WAITING FOR SIGN-OFF');
    for (const key of ORDER_STATUS_KEYS) {
      expect(orderHeaderEyebrow(7, key, null, RENAMED)).toBe(`ORDER SO-000007 · ${orderStatusPill(key, null, RENAMED).label}`);
    }
  });

  it("no config (none set, or not read yet) is core's words, as before", () => {
    const none = resolveOrderStatusConfig(null);
    for (const key of ORDER_STATUS_KEYS) {
      expect(orderStatusPill(key, null, none)).toEqual(orderStatusPill(key));
    }
  });

  // With returns RX-3's fulfilment rule (polish (c)): a completed pickup reads
  // HANDED OVER while the status keeps core's word, in the organization's
  // colour; an organization that renamed "Delivered" keeps its own word for a
  // pickup too, as the web badge does (core orderStatusLabelForFulfillment).
  it("a completed pickup reads HANDED OVER in the organization's colour, and its own word when it renamed the status", () => {
    const RECOLOURED = resolveOrderStatusConfig({ completed: { color: 'warning' } });
    expect(orderStatusPill('completed', 'pickup', RECOLOURED)).toEqual({ label: 'HANDED OVER', status: 'warn' });
    expect(orderStatusPill('completed', 'delivery', RECOLOURED)).toEqual({ label: 'DELIVERED', status: 'warn' });
    const COLLECTED = resolveOrderStatusConfig({ completed: { label: 'Collected or shipped' } });
    expect(orderStatusPill('completed', 'pickup', COLLECTED)).toEqual({ label: 'COLLECTED OR SHIPPED', status: 'ok' });
    expect(orderHeaderEyebrow(27, 'completed', 'pickup', RECOLOURED)).toBe('ORDER SO-000027 · HANDED OVER');
    expect(orderHeaderEyebrow(27, 'completed', 'pickup', COLLECTED)).toBe('ORDER SO-000027 · COLLECTED OR SHIPPED');
  });

  it('a status core does not know keeps its own words whatever the config says', () => {
    expect(orderStatusPill('something_new', null, RENAMED)).toEqual({ label: 'SOMETHING NEW', status: 'default' });
  });
});

'use strict';

const { BASE_URL } = require('../constants');

// ── REST-hook plumbing (shared by every trigger) ────────────────────────────
// Subscribe = create a StockPilot automation webhook for one event type, target
// = Zapier's per-Zap hook URL. Unsubscribe = delete it. StockPilot then delivers
// each event to that URL (SSRF-guarded, HMAC-signed) via its existing engine.

const subscribe = (eventType) => async (z, bundle) => {
  const res = await z.request({
    url: `${BASE_URL}/api/public/v1/hooks`,
    method: 'POST',
    body: { target_url: bundle.targetUrl, event_types: [eventType] },
  });
  return res.data; // { id, secret, event_types } — id is reused on unsubscribe
};

const unsubscribe = async (z, bundle) => {
  const id = bundle.subscribeData && bundle.subscribeData.id;
  if (!id) return {};
  const res = await z.request({
    url: `${BASE_URL}/api/public/v1/hooks/${id}`,
    method: 'DELETE',
  });
  return res.data;
};

// Inbound delivery → unwrap the signed envelope's `data` so Zaps map the event
// payload directly (the event type is implied by the trigger).
const parseDelivery = (z, bundle) => {
  const body = bundle.cleanedRequest || {};
  return [body && body.data ? body.data : body];
};

function hookTrigger({ key, noun, label, description, eventType, listPath, sample }) {
  return {
    key,
    noun,
    display: { label, description, important: true },
    operation: {
      type: 'hook',
      performSubscribe: subscribe(eventType),
      performUnsubscribe: unsubscribe,
      perform: parseDelivery,
      // Pulls a few recent records (for the Zap test + initial de-dup by id).
      // Falls back to the static sample for events with no list endpoint yet.
      performList: async (z, bundle) => {
        if (!listPath) return [sample];
        const res = await z.request({ url: `${BASE_URL}${listPath}`, params: { limit: 3 } });
        return (res.data && res.data.data) || [];
      },
      sample,
    },
  };
}

// ── Triggers (StockPilot event → other apps) ────────────────────────────────
const poReceived = hookTrigger({
  key: 'po_received',
  noun: 'Purchase Order',
  label: 'Purchase Order Received',
  description: 'Triggers when stock is received against a purchase order.',
  eventType: 'po.received',
  listPath: '/api/public/v1/purchase-orders',
  sample: { id: 'po_123', poNumber: 'PO-1042', receiptNumber: 'R-20260623-0001', totalAccepted: 50 },
});

const poCreated = hookTrigger({
  key: 'po_created',
  noun: 'Purchase Order',
  label: 'Purchase Order Created',
  description: 'Triggers when a new purchase order is created.',
  eventType: 'po.created',
  listPath: '/api/public/v1/purchase-orders',
  sample: { id: 'po_123', poNumber: 'PO-1042', lineCount: 3 },
});

const orderCreated = hookTrigger({
  key: 'order_created',
  noun: 'Order',
  label: 'Order Created',
  description: 'Triggers when a new order request is created.',
  eventType: 'order.created',
  listPath: '/api/public/v1/orders',
  sample: { id: 'ord_123', status: 'requested', requestedBy: 'jane@example.com' },
});

const stockLow = hookTrigger({
  key: 'stock_low',
  noun: 'Item',
  label: 'Low Stock',
  description: 'Triggers when an item drops to or below its reorder point.',
  eventType: 'stock.low',
  listPath: '/api/public/v1/items',
  sample: { id: 'itm_123', sku: 'SP-1234', name: 'Foldable Tote', quantityOnHand: 4, reorderPoint: 10 },
});

const returnCreated = hookTrigger({
  key: 'return_created',
  noun: 'Return',
  label: 'Return Created',
  description: 'Triggers when a return/RMA is created.',
  eventType: 'return.created',
  listPath: null, // no public returns list endpoint yet — sample drives the test
  sample: { id: 'ret_123', status: 'requested', orderId: 'ord_123' },
});

module.exports = {
  [poReceived.key]: poReceived,
  [poCreated.key]: poCreated,
  [orderCreated.key]: orderCreated,
  [stockLow.key]: stockLow,
  [returnCreated.key]: returnCreated,
};

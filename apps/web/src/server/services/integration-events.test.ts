import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { buildRequest, describeEvent, signWebhook } from './integration-events';

const webhookEndpoint = {
  id: 'ep-1',
  organization_id: 'org-1',
  type: 'webhook' as const,
  url: 'https://example.com/hook',
  secret: 'whsec_test',
};

describe('signWebhook', () => {
  it('is deterministic and Stripe-shaped (t=…,v1=<sha256 hex>)', () => {
    const sig = signWebhook('whsec_test', '{"a":1}', 1_700_000_000);
    expect(sig).toBe(signWebhook('whsec_test', '{"a":1}', 1_700_000_000)); // deterministic
    const m = sig.match(/^t=(\d+),v1=([0-9a-f]{64})$/);
    expect(m).not.toBeNull();
    // matches an independent HMAC over `${ts}.${body}`
    const expected = createHmac('sha256', 'whsec_test').update('1700000000.{"a":1}').digest('hex');
    expect(m?.[2]).toBe(expected);
  });

  it('changes when the secret or body changes', () => {
    const base = signWebhook('s1', 'b', 1);
    expect(signWebhook('s2', 'b', 1)).not.toBe(base);
    expect(signWebhook('s1', 'b2', 1)).not.toBe(base);
  });
});

describe('describeEvent', () => {
  it('renders low-stock with item + reorder point', () => {
    const { title, summary } = describeEvent('stock.low', {
      name: 'Widget',
      sku: 'W-1',
      quantity: 2,
      reorderPoint: 10,
    });
    expect(title).toMatch(/low stock/i);
    expect(summary).toContain('Widget');
    expect(summary).toContain('W-1');
    expect(summary).toContain('10');
  });

  it('falls back gracefully for an unknown event', () => {
    const { title, summary } = describeEvent('something.weird', {});
    expect(title).toBeTruthy();
    expect(summary).toBe('something.weird');
  });
});

describe('buildRequest', () => {
  const envelope = {
    id: 'd-1',
    event: 'order.created',
    organization_id: 'org-1',
    created_at: '2026-06-08T00:00:00.000Z',
    data: { orderNumber: 'ORD-9', requester: 'Ray' },
  };

  it('webhook → signed JSON envelope with event header', () => {
    const { body, headers } = buildRequest(webhookEndpoint, 'order.created', envelope);
    expect(JSON.parse(body)).toMatchObject({ event: 'order.created', data: { orderNumber: 'ORD-9' } });
    expect(headers['content-type']).toBe('application/json');
    expect(headers['X-StockPilot-Signature']).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(headers['X-StockPilot-Event']).toBe('order.created');
  });

  it('webhook without a secret → no signature header (still delivers)', () => {
    const { headers } = buildRequest({ ...webhookEndpoint, secret: null }, 'order.created', envelope);
    expect(headers['X-StockPilot-Signature']).toBeUndefined();
  });

  it('slack/teams → a {text} chat message, not the raw envelope', () => {
    for (const type of ['slack', 'teams'] as const) {
      const { body } = buildRequest({ ...webhookEndpoint, type }, 'order.created', envelope);
      const parsed = JSON.parse(body) as { text: string };
      expect(parsed.text).toContain('ORD-9');
      expect(parsed).not.toHaveProperty('data'); // chat shape, not the webhook envelope
    }
  });
});

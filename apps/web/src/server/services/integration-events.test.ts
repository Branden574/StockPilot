import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

import type { ModuleId } from '@stockpilot/core';

import {
  buildRequest,
  describeEvent,
  INTEGRATION_WRITE_REFUSED,
  IntegrationEndpointsService,
  signWebhook,
} from './integration-events';

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

  it('renders order.status_changed with the order number and new status', () => {
    // Contract the new staging/packing-slip dispatch sites rely on.
    const { title, summary } = describeEvent('order.status_changed', {
      id: 'abcd1234-0000',
      orderNumber: 'ABCD1234',
      status: 'staged_for_delivery',
    });
    expect(title).toBeTruthy();
    expect(summary).toContain('ABCD1234');
    expect(summary).toContain('staged_for_delivery');
  });

  it('renders every security event with identity context and no raw secrets', () => {
    const newDevice = describeEvent('security.new_device_login', {
      email: 'jo@org.com',
      device: 'Chrome/# macOS',
      ip: '203.0.113.9',
    });
    expect(newDevice.title).toMatch(/new device/i);
    expect(newDevice.summary).toContain('jo@org.com');
    expect(newDevice.summary).toContain('203.0.113.9');

    const mfaOff = describeEvent('security.mfa_unenrolled', { email: 'jo@org.com' });
    expect(mfaOff.title).toMatch(/mfa/i);
    expect(mfaOff.summary).toContain('jo@org.com');

    const policy = describeEvent('security.mfa_policy_changed', {
      from: 'all_required',
      to: 'optional',
    });
    expect(policy.summary).toContain('all_required');
    expect(policy.summary).toContain('optional');

    // API key copy must carry the PREFIX only — never a raw key.
    const key = describeEvent('security.api_key_created', {
      name: 'Zapier',
      prefix: 'sk_live_abc1',
      scopes: 'items:read',
    });
    expect(key.summary).toContain('Zapier');
    expect(key.summary).toContain('sk_live_abc1…');

    const role = describeEvent('security.member_role_changed', { from: 'staff', to: 'admin' });
    expect(role.summary).toContain('staff');
    expect(role.summary).toContain('admin');

    const exfil = describeEvent('security.export_rate_limited', { email: 'jo@org.com' });
    expect(exfil.summary).toMatch(/export rate limit|exfiltration/i);
    expect(exfil.summary).toContain('jo@org.com');
  });

  it('security events degrade to generic copy when identity fields are absent', () => {
    const { summary } = describeEvent('security.new_device_login', {});
    expect(summary).toMatch(/a member/i);
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

/**
 * docket S27: the webhook and alert endpoints report what the database did.
 * The service gates on the member's effective Manage integrations, and the
 * table's row rule asks for the same key since 0428 (the admin role before
 * it), so a write the database refuses is one the request's view of the
 * member's access missed. Before S27a such a write changed nothing and was
 * reported as done: turning an endpoint off, removing it and rotating its
 * secret all reported success on 0 rows, and rotating returned a secret that
 * was never stored. Creating one read the refusal as an internal error.
 */
describe('IntegrationEndpointsService: writes report what the database did', () => {
  const service = (results: Record<string, unknown>) => {
    const stub = makeSupabaseStub(results as never);
    return {
      stub,
      svc: new IntegrationEndpointsService(
        makeServiceContext(stub.client, {
          role: 'manager',
          permissions: new Set(['integrations:manage']),
          enabledModules: new Set<ModuleId>(['integrations']),
        }),
      ),
    };
  };
  const NOT_FOUND = { code: 'not_found', message: 'Endpoint not found.' };

  it('turning an endpoint on or off: 0 rows is not found; the row it changed is done', async () => {
    await expect(
      service({ 'integration_endpoints.update': { data: [], error: null } }).svc.setEnabled(
        'ep-1',
        false,
      ),
    ).rejects.toMatchObject(NOT_FOUND);
    const { stub, svc } = service({
      'integration_endpoints.update': { data: [{ id: 'ep-1' }], error: null },
    });
    await expect(svc.setEnabled('ep-1', false)).resolves.toBeUndefined();
    expect(stub.chainArgs.get('integration_endpoints.update')).toContainEqual(['id', 'ep-1']);
  });

  it('removing an endpoint: 0 rows is not found; the row it removed is done', async () => {
    await expect(
      service({ 'integration_endpoints.delete': { data: [], error: null } }).svc.remove('ep-1'),
    ).rejects.toMatchObject(NOT_FOUND);
    await expect(
      service({
        'integration_endpoints.delete': { data: [{ id: 'ep-1' }], error: null },
      }).svc.remove('ep-1'),
    ).resolves.toBeUndefined();
  });

  it('rotating a secret returns no secret when none was stored, and the stored one when it was', async () => {
    await expect(
      service({ 'integration_endpoints.update': { data: [], error: null } }).svc.rotateSecret(
        'ep-1',
      ),
    ).rejects.toMatchObject(NOT_FOUND);
    const { stub, svc } = service({
      'integration_endpoints.update': { data: [{ id: 'ep-1' }], error: null },
    });
    const { secret } = await svc.rotateSecret('ep-1');
    expect(secret).toMatch(/^whsec_[0-9a-f]{48}$/);
    expect(stub.chainArgs.get('integration_endpoints.update')?.[0]?.[0]).toMatchObject({ secret });
  });

  it('creating an endpoint the database refused (42501) is a refusal, not an internal error', async () => {
    const { svc } = service({
      'integration_endpoints.insert': {
        data: null,
        error: {
          code: '42501',
          message: 'new row violates row-level security policy for table "integration_endpoints"',
        },
      },
    });
    await expect(
      svc.create({
        type: 'webhook',
        url: 'https://example.com/hook',
        eventTypes: ['order.created'],
      }),
    ).rejects.toMatchObject({ code: 'forbidden', message: INTEGRATION_WRITE_REFUSED });
  });
});

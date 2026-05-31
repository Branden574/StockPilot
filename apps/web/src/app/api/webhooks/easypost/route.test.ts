import crypto from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub } from '@/test/supabase-mock';

// Vault read of the per-connection webhook secret. Stubbed so the test never
// touches Vault; returns a fixed webhook secret + a (never-used here) apiKey.
const WEBHOOK_SECRET = 'whsec_easypost_test_secret';
const getSecretSpy = vi.fn(async (_admin: unknown, _secretId: string) => ({
  apiKey: 'EZTK-test-key',
  webhookSecret: WEBHOOK_SECRET,
  accessToken: 'EZTK-test-key',
  refreshToken: '',
  expiresAt: '',
}));
vi.mock('@/server/connectors/secret-store', () => ({
  getConnectionSecret: (admin: unknown, secretId: string) => getSecretSpy(admin, secretId),
}));

// The webhook writes/reads carrier_shipments + org_connections through the
// SERVICE-ROLE admin client. Point createAdminClient() at a mutable holder each
// test fills with a makeSupabaseStub client.
const adminHolder = { client: null as unknown };
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(() => adminHolder.client),
}));

// error-reporter is side-effecting; stub it so a reported error doesn't noise
// the test output and we can assert it's never handed a secret.
vi.mock('@/lib/error-reporter', () => ({
  reportError: vi.fn(async () => undefined),
}));

import { POST } from './route';

const SHIPMENT_ID = 'shp_easypost_123';
const TRACKING_CODE = '1Z999AA10123456784';

/** Build the EasyPost Event envelope for a tracker.updated event. */
function trackerEvent(status: string, overrides: Record<string, unknown> = {}) {
  return {
    description: 'tracker.updated',
    result: {
      object: 'Tracker',
      shipment_id: SHIPMENT_ID,
      tracking_code: TRACKING_CODE,
      status,
      public_url: 'https://track.easypost.com/1Z999AA10123456784',
      ...overrides,
    },
  };
}

/** Compute the EasyPost-style signature header for a raw body + secret. */
function sign(rawBody: string, secret = WEBHOOK_SECRET) {
  const hex = crypto
    .createHmac('sha256', Buffer.from(secret, 'utf8'))
    .update(Buffer.from(rawBody, 'utf8'))
    .digest('hex');
  return `hmac-sha256-hex=${hex}`;
}

/** Build a NextRequest-shaped POST with a raw JSON body + optional signature. */
function buildRequest(rawBody: string, signature: string | null) {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (signature) headers.set('X-Hmac-Signature', signature);
  return new Request('https://test.local/api/webhooks/easypost', {
    method: 'POST',
    headers,
    body: rawBody,
  }) as unknown as Parameters<typeof POST>[0];
}

/**
 * Wire the admin stub for the common happy-path lookups: a matched shipment row
 * (by easypost_shipment_id) on connection conn-1, and that connection's
 * secret_id. Tests override pieces as needed.
 */
function wireMatchedAdmin(overrides: Record<string, unknown> = {}) {
  const stub = makeSupabaseStub({
    'carrier_shipments.select.maybeSingle': {
      data: { id: 'cs-1', organization_id: 'org-1', connection_id: 'conn-1' },
      error: null,
    },
    'org_connections.select.maybeSingle': {
      data: { secret_id: 'secret-1' },
      error: null,
    },
    'carrier_shipments.update': { data: null, error: null },
    ...overrides,
  });
  adminHolder.client = stub.client;
  return stub;
}

describe('POST /api/webhooks/easypost', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    adminHolder.client = null;
  });

  it('updates the matched shipment on a valid HMAC + tracker.updated payload', async () => {
    const stub = wireMatchedAdmin();
    const rawBody = JSON.stringify(trackerEvent('in_transit'));
    const res = await POST(buildRequest(rawBody, sign(rawBody)));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, updated: true });

    // It looked the row up, resolved the connection secret, and updated.
    expect(getSecretSpy).toHaveBeenCalledWith(expect.anything(), 'secret-1');
    const updateChain = stub.chains.get('carrier_shipments.update');
    expect(updateChain).toContain('update');
    const updateArgs = stub.chainArgs.get('carrier_shipments.update');
    const updatePayload = updateArgs?.[0]?.[0] as Record<string, unknown>;
    expect(updatePayload).toMatchObject({
      tracking_status: 'in_transit',
      status: 'in_transit',
      tracking_url: 'https://track.easypost.com/1Z999AA10123456784',
    });
    // Updated by the matched row id.
    const eqArgs = updateArgs?.find((a) => a[0] === 'id');
    expect(eqArgs).toEqual(['id', 'cs-1']);
  });

  it('maps delivered tracker status to status=delivered', async () => {
    const stub = wireMatchedAdmin();
    const rawBody = JSON.stringify(trackerEvent('delivered'));
    const res = await POST(buildRequest(rawBody, sign(rawBody)));

    expect(res.status).toBe(200);
    const updatePayload = stub.chainArgs.get('carrier_shipments.update')?.[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(updatePayload.status).toBe('delivered');
    expect(updatePayload.tracking_status).toBe('delivered');
  });

  it('returns 401 on an invalid signature and does NOT update', async () => {
    const stub = wireMatchedAdmin();
    const rawBody = JSON.stringify(trackerEvent('in_transit'));
    const res = await POST(buildRequest(rawBody, 'hmac-sha256-hex=deadbeef'));

    expect(res.status).toBe(401);
    // No update was attempted.
    expect(stub.chains.has('carrier_shipments.update')).toBe(false);
  });

  it('returns 401 when the signature header is missing', async () => {
    const stub = wireMatchedAdmin();
    const rawBody = JSON.stringify(trackerEvent('in_transit'));
    const res = await POST(buildRequest(rawBody, null));

    expect(res.status).toBe(401);
    expect(stub.chains.has('carrier_shipments.update')).toBe(false);
  });

  it('returns 200 no-op when no shipment matches (no secret resolved, no update)', async () => {
    const stub = wireMatchedAdmin({
      'carrier_shipments.select.maybeSingle': { data: null, error: null },
    });
    const rawBody = JSON.stringify(trackerEvent('in_transit'));
    const res = await POST(buildRequest(rawBody, sign(rawBody)));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, ignored: 'no_shipment_match' });
    // Never resolved a secret or updated for an unknown shipment.
    expect(getSecretSpy).not.toHaveBeenCalled();
    expect(stub.chains.has('carrier_shipments.update')).toBe(false);
  });

  it('returns 200 no-op when the payload has no identifier', async () => {
    wireMatchedAdmin();
    const rawBody = JSON.stringify({ description: 'tracker.updated', result: { object: 'Tracker' } });
    const res = await POST(buildRequest(rawBody, sign(rawBody)));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, ignored: 'no_identifier' });
    expect(getSecretSpy).not.toHaveBeenCalled();
  });

  it('returns 200 ignored on an unparseable (non-JSON) body without touching Vault', async () => {
    wireMatchedAdmin();
    const res = await POST(buildRequest('not json{', 'hmac-sha256-hex=abc'));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, ignored: 'unparseable' });
    expect(getSecretSpy).not.toHaveBeenCalled();
  });

  it('matches by tracking_code when no shipment_id is present', async () => {
    const stub = makeSupabaseStub({
      // First lookup (by easypost_shipment_id) is skipped because there's no
      // shipment_id; the tracking_code lookup returns the row.
      'carrier_shipments.select.maybeSingle': {
        data: { id: 'cs-2', organization_id: 'org-1', connection_id: 'conn-1' },
        error: null,
      },
      'org_connections.select.maybeSingle': { data: { secret_id: 'secret-1' }, error: null },
      'carrier_shipments.update': { data: null, error: null },
    });
    adminHolder.client = stub.client;

    const rawBody = JSON.stringify(
      trackerEvent('out_for_delivery', { shipment_id: undefined }),
    );
    const res = await POST(buildRequest(rawBody, sign(rawBody)));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, updated: true });
    // out_for_delivery collapses to in_transit.
    const updatePayload = stub.chainArgs.get('carrier_shipments.update')?.[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(updatePayload.status).toBe('in_transit');
  });
});

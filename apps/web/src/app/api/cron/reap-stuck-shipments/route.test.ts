import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub } from '@/test/supabase-mock';

vi.mock('@/lib/env', () => ({
  env: { CRON_SECRET: 'test-cron-secret' },
}));

vi.mock('@/lib/error-reporter', () => ({
  reportError: vi.fn(),
}));

const adminClientHolder = { client: null as unknown };
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(() => adminClientHolder.client),
}));

const reapSpy = vi.fn(
  async (_admin: unknown, _row: unknown): Promise<'purchased' | 'draft' | 'skipped'> =>
    'purchased',
);
vi.mock('@/server/services/shipping', () => ({
  ShippingService: { reapStuckShipment: (admin: unknown, row: unknown) => reapSpy(admin, row) },
}));

import { GET } from './route';

function buildRequest(authHeader?: string) {
  return new Request('https://test.local/api/cron/reap-stuck-shipments', {
    method: 'GET',
    headers: authHeader ? { authorization: authHeader } : {},
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  reapSpy.mockResolvedValue('purchased');
});

describe('GET /api/cron/reap-stuck-shipments', () => {
  it('returns 401 with no Authorization header (fail-closed)', async () => {
    const stub = makeSupabaseStub({});
    adminClientHolder.client = stub.client;
    const res = await GET(buildRequest());
    expect(res.status).toBe(401);
    expect(reapSpy).not.toHaveBeenCalled();
  });

  it('returns 401 with a wrong secret', async () => {
    const stub = makeSupabaseStub({});
    adminClientHolder.client = stub.client;
    const res = await GET(buildRequest('Bearer wrong-secret'));
    expect(res.status).toBe(401);
    expect(reapSpy).not.toHaveBeenCalled();
  });

  it('selects ONLY stale purchasing rows and reaps each', async () => {
    const stuckRows = [
      { id: 'ship-1', organization_id: 'org-1', status: 'purchasing', easypost_shipment_id: 'shp_1' },
      { id: 'ship-2', organization_id: 'org-2', status: 'purchasing', easypost_shipment_id: 'shp_2' },
    ];
    const stub = makeSupabaseStub({
      'carrier_shipments.select': { data: stuckRows, error: null },
    });
    adminClientHolder.client = stub.client;
    // Distinct outcomes so the counters are exercised.
    reapSpy.mockResolvedValueOnce('purchased');
    reapSpy.mockResolvedValueOnce('draft');

    const res = await GET(buildRequest('Bearer test-cron-secret'));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      finalized: 1,
      reopened: 1,
      skipped: 0,
      failed: 0,
    });

    // The query must filter to status='purchasing' AND a staleness cutoff on
    // updated_at — a fresh, mid-flight buy must never be reaped.
    const chain = stub.chains.get('carrier_shipments.select');
    expect(chain).toContain('eq');
    expect(chain).toContain('lt');
    const args = stub.chainArgs.get('carrier_shipments.select') ?? [];
    const eqCall = args[chain?.indexOf('eq') ?? -1];
    expect(eqCall).toEqual(['status', 'purchasing']);
    const ltCall = args[chain?.indexOf('lt') ?? -1];
    expect(ltCall?.[0]).toBe('updated_at');

    // Reaped both stale rows.
    expect(reapSpy).toHaveBeenCalledTimes(2);
    expect(reapSpy.mock.calls[0]?.[1]).toMatchObject({ id: 'ship-1' });
    expect(reapSpy.mock.calls[1]?.[1]).toMatchObject({ id: 'ship-2' });
  });

  it('isolates a per-row failure (one bad row does not abort the run)', async () => {
    const stuckRows = [
      { id: 'ship-1', organization_id: 'org-1', status: 'purchasing', easypost_shipment_id: 'shp_1' },
      { id: 'ship-2', organization_id: 'org-2', status: 'purchasing', easypost_shipment_id: 'shp_2' },
    ];
    const stub = makeSupabaseStub({
      'carrier_shipments.select': { data: stuckRows, error: null },
    });
    adminClientHolder.client = stub.client;
    reapSpy.mockRejectedValueOnce(new Error('EasyPost down'));
    reapSpy.mockResolvedValueOnce('purchased');

    const res = await GET(buildRequest('Bearer test-cron-secret'));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, finalized: 1, failed: 1 });
    // Both rows were attempted despite the first throwing.
    expect(reapSpy).toHaveBeenCalledTimes(2);
  });

  it('returns ok with zero counts when nothing is stuck', async () => {
    const stub = makeSupabaseStub({
      'carrier_shipments.select': { data: [], error: null },
    });
    adminClientHolder.client = stub.client;

    const res = await GET(buildRequest('Bearer test-cron-secret'));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      finalized: 0,
      reopened: 0,
      skipped: 0,
      failed: 0,
    });
    expect(reapSpy).not.toHaveBeenCalled();
  });
});

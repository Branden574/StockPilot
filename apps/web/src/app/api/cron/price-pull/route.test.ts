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

const refreshSpy = vi.fn(
  async (): Promise<{ scanned: number; written: number; skipped: number }> => ({
    scanned: 0,
    written: 0,
    skipped: 0,
  }),
);
vi.mock('@/server/services/price-tracking', () => ({
  refreshBookPricesForOrg: (...args: unknown[]) => refreshSpy(...(args as [])),
}));

import { GET } from './route';

function buildRequest(authHeader?: string) {
  return new Request('https://test.local/api/cron/price-pull', {
    method: 'GET',
    headers: authHeader ? { authorization: authHeader } : {},
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  refreshSpy.mockResolvedValue({ scanned: 0, written: 0, skipped: 0 });
});

describe('GET /api/cron/price-pull', () => {
  it('returns 401 with no Authorization header (fail-closed)', async () => {
    const stub = makeSupabaseStub({});
    adminClientHolder.client = stub.client;
    const res = await GET(buildRequest());
    expect(res.status).toBe(401);
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it('returns 401 with a wrong secret', async () => {
    const stub = makeSupabaseStub({});
    adminClientHolder.client = stub.client;
    const res = await GET(buildRequest('Bearer wrong-secret'));
    expect(res.status).toBe(401);
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it('returns 200 and does no per-org work when no orgs have the module', async () => {
    const stub = makeSupabaseStub({
      'organization_modules.select': { data: [], error: null },
    });
    adminClientHolder.client = stub.client;

    const res = await GET(buildRequest('Bearer test-cron-secret'));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, orgs: 0, results: [] });
    expect(refreshSpy).not.toHaveBeenCalled();

    // Org list must filter to the enabled price_tracking module.
    const args = stub.chainArgs.get('organization_modules.select') ?? [];
    const flat = args.flat();
    expect(flat).toContain('price_tracking');
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub } from '@/test/supabase-mock';

import { KNOWN_HOT_ORG_IDS } from './org-sweep';

vi.mock('@/lib/env', () => ({
  env: {
    CRON_SECRET: 'test-cron-secret',
    BACKFILL_ADMIN_SECRET: 'test-backfill-secret',
  },
}));

const adminClientHolder = { client: null as unknown };
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(() => adminClientHolder.client),
}));

const inventoryResult = (organizationId: string, warehouseId?: string | null) => ({
  organizationId,
  warehouseKey: warehouseId ?? 'all',
  itemCount: 0,
  bookCount: 0,
  itemsMs: 0,
  booksMs: 0,
  itemsError: null,
  booksError: null,
});
const prewarmInventorySpy = vi.fn(async (organizationId: string, warehouseId?: string | null) =>
  inventoryResult(organizationId, warehouseId),
);
vi.mock('@/server/loaders/inventory-list', () => ({
  prewarmInventoryList: (...args: [string, (string | null)?]) => prewarmInventorySpy(...args),
}));

const prewarmCatalogSpy = vi.fn(async (organizationId: string, warehouseId: string) => ({
  organizationId,
  warehouseId,
  itemCount: 0,
  mediaCount: 0,
  charterCount: 0,
  catalogMs: 0,
  thumbMapMs: 0,
  chartersMs: 0,
  thumbMapError: null,
}));
vi.mock('@/server/loaders/orders-new-catalog', () => ({
  prewarmOrdersNewCatalog: (...args: [string, string]) => prewarmCatalogSpy(...args),
}));

import { GET } from './route';

const [HOT_1, HOT_2] = KNOWN_HOT_ORG_IDS;

function buildRequest(authHeader?: string, search = '') {
  return new Request(`https://test.local/api/cron/prewarm-orders-catalog${search}`, {
    method: 'GET',
    headers: authHeader ? { authorization: authHeader } : {},
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks keeps implementations — restore the happy-path one so
  // the failure-injection test can't leak into later tests.
  prewarmInventorySpy.mockImplementation(async (organizationId, warehouseId) =>
    inventoryResult(organizationId, warehouseId),
  );
});

describe('GET /api/cron/prewarm-orders-catalog', () => {
  it('returns 401 with no Authorization header (fail-closed)', async () => {
    const stub = makeSupabaseStub({});
    adminClientHolder.client = stub.client;
    const res = await GET(buildRequest());
    expect(res.status).toBe(401);
    expect(prewarmInventorySpy).not.toHaveBeenCalled();
    expect(prewarmCatalogSpy).not.toHaveBeenCalled();
  });

  it('returns 401 with a wrong secret', async () => {
    const stub = makeSupabaseStub({});
    adminClientHolder.client = stub.client;
    const res = await GET(buildRequest('Bearer wrong'));
    expect(res.status).toBe(401);
  });

  it('sweeps known-hot orgs FIRST, then every enumerated active org (all-variant)', async () => {
    const stub = makeSupabaseStub({
      'organizations.select': {
        data: [{ id: 'org-active-1' }, { id: HOT_1 }, { id: 'org-active-2' }],
        error: null,
        count: 3,
      },
      'warehouses.select': {
        data: [{ id: 'wh-1', organization_id: HOT_1 }],
        error: null,
      },
    });
    adminClientHolder.client = stub.client;

    const res = await GET(buildRequest('Bearer test-cron-secret'));
    expect(res.status).toBe(200);
    const body = await res.json();

    // Orders catalog: known-hot warehouse pairs only.
    expect(prewarmCatalogSpy.mock.calls).toEqual([[HOT_1, 'wh-1']]);

    // Inventory 'all' sweep order: known-hot seeded first (HOT_1 deduped
    // against its enumeration hit), then remaining active orgs, then the
    // known-hot per-warehouse variant LAST.
    expect(prewarmInventorySpy.mock.calls).toEqual([
      [HOT_1],
      [HOT_2],
      ['org-active-1'],
      ['org-active-2'],
      [HOT_1, 'wh-1'],
    ]);

    // Disclosure block: cap + counts, nothing shed in this run. No
    // scope param = the full sweep (the cron / deploy-hook contract).
    expect(body.scope).toBe('full');
    expect(body.orgSweep).toMatchObject({
      cap: 50,
      activeOrgTotal: 3,
      swept: 4,
      truncatedByCap: 0,
      skippedForBudget: 0,
    });
    expect(body.inventoryPrewarmed).toBe(5);
  });

  it('scope=hot warms ONLY the known-hot tier and never enumerates orgs (boot self-warm contract)', async () => {
    // No 'organizations.select' fixture on purpose: the hot tier must
    // not touch that table at all — fromCalls proves it below.
    const stub = makeSupabaseStub({
      'warehouses.select': {
        data: [{ id: 'wh-1', organization_id: HOT_1 }],
        error: null,
      },
    });
    adminClientHolder.client = stub.client;

    const res = await GET(buildRequest('Bearer test-backfill-secret', '?scope=hot'));
    expect(res.status).toBe(200);
    const body = await res.json();

    // The sweep enumeration is SKIPPED entirely — a deploy's K cold
    // instances must not each fire a 50-org sweep (thundering herd).
    expect(stub.fromCalls).not.toContain('organizations');

    // Pre-sweep behavior preserved as the hot tier: known-hot
    // orders-catalog pairs + known-hot inventory variants only.
    expect(prewarmCatalogSpy.mock.calls).toEqual([[HOT_1, 'wh-1']]);
    expect(prewarmInventorySpy.mock.calls).toEqual([[HOT_1], [HOT_2], [HOT_1, 'wh-1']]);

    expect(body.scope).toBe('hot');
    expect(body.orgSweep).toMatchObject({
      cap: 50,
      activeOrgTotal: null, // no enumeration ran
      swept: 2,
      truncatedByCap: 0,
      skippedForBudget: 0,
    });
  });

  it('scope=hot still requires the secret (tiering never weakens auth)', async () => {
    const stub = makeSupabaseStub({});
    adminClientHolder.client = stub.client;
    const res = await GET(buildRequest('Bearer wrong', '?scope=hot'));
    expect(res.status).toBe(401);
    expect(prewarmInventorySpy).not.toHaveBeenCalled();
  });

  it('filters enumeration to orgs with an accepted member, ordered by recent activity', async () => {
    const stub = makeSupabaseStub({
      'organizations.select': { data: [], error: null, count: 0 },
      'warehouses.select': { data: [], error: null },
    });
    adminClientHolder.client = stub.client;

    const res = await GET(buildRequest('Bearer test-backfill-secret'));
    expect(res.status).toBe(200);

    const chain = stub.chains.get('organizations.select') ?? [];
    const args = (stub.chainArgs.get('organizations.select') ?? []).flat();
    // Inner-join membership filter (empty embed = join-only, no payload).
    expect(args.join(' ')).toContain('organization_members!inner()');
    // accepted_at IS NOT NULL filter present.
    expect(chain).toContain('not');
    expect(args).toContain('organization_members.accepted_at');
    // Activity ordering + the disclosed cap.
    expect(chain).toContain('order');
    expect(args).toContain('updated_at');
    expect(chain).toContain('limit');
    expect(args).toContain(50);
  });

  it('isolates a failing org: the sweep continues past a throwing prewarm', async () => {
    const stub = makeSupabaseStub({
      'organizations.select': {
        data: [{ id: 'org-bad' }, { id: 'org-good' }],
        error: null,
        count: 2,
      },
      'warehouses.select': { data: [], error: null },
    });
    adminClientHolder.client = stub.client;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    prewarmInventorySpy.mockImplementation(async (organizationId, warehouseId) => {
      if (organizationId === 'org-bad') throw new Error('boom');
      return inventoryResult(organizationId, warehouseId);
    });

    const res = await GET(buildRequest('Bearer test-cron-secret'));
    expect(res.status).toBe(200);
    const body = await res.json();

    // org-bad threw but org-good (after it) was still warmed.
    const warmed = prewarmInventorySpy.mock.calls.map((c) => c[0]);
    expect(warmed).toContain('org-bad');
    expect(warmed).toContain('org-good');
    // 4 attempts (2 hot + 2 enumerated), 1 threw → 3 results.
    expect(body.inventoryPrewarmed).toBe(3);
    warnSpy.mockRestore();
  });

  it('returns 500 when the org enumeration itself fails (fail-closed, no partial sweep)', async () => {
    const stub = makeSupabaseStub({
      'organizations.select': { data: null, error: { message: 'db down' } },
    });
    adminClientHolder.client = stub.client;

    const res = await GET(buildRequest('Bearer test-cron-secret'));
    expect(res.status).toBe(500);
    expect(prewarmInventorySpy).not.toHaveBeenCalled();
  });

  it('discloses cap truncation when more active orgs exist than the cap', async () => {
    const stub = makeSupabaseStub({
      'organizations.select': {
        // Simulate the capped page of a 120-org fleet.
        data: Array.from({ length: 50 }, (_, i) => ({ id: `org-${i}` })),
        error: null,
        count: 120,
      },
      'warehouses.select': { data: [], error: null },
    });
    adminClientHolder.client = stub.client;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await GET(buildRequest('Bearer test-cron-secret'));
    const body = await res.json();

    expect(body.orgSweep.truncatedByCap).toBe(70);
    // Repo rule: no silent caps — shed work must hit the logs too.
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('truncatedByCap=70'));
    warnSpy.mockRestore();
  });
});

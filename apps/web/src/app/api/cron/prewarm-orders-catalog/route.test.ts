import { beforeEach, describe, expect, it, vi } from 'vitest';

import { reportError } from '@/lib/error-reporter';
import { makeSupabaseStub, servedLikePostgrest } from '@/test/supabase-mock';

import { KNOWN_HOT_ORG_IDS } from './org-sweep';

vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));
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

const prewarmPhoneSpy = vi.fn(async (organizationId: string, warehouseId: string) => ({
  organizationId,
  warehouseId,
  photoCount: 3,
  ms: 1,
  error: null as string | null,
}));
vi.mock('@/server/loaders/orders-phone-catalog', () => ({
  prewarmPhoneThumbMap: (...args: [string, string]) => prewarmPhoneSpy(...args),
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
  prewarmPhoneSpy.mockImplementation(async (organizationId, warehouseId) => ({
    organizationId,
    warehouseId,
    photoCount: 3,
    ms: 1,
    error: null,
  }));
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

  it('lists every org with an accepted member, in id order, a page at a time', async () => {
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
    // Every active org in id order, paged (no activity order, no limit:
    // the rotating window, not the read, decides which orgs this run warms).
    expect(chain).toContain('order');
    expect(args).toContain('id');
    expect(args).not.toContain('updated_at');
    expect(chain).not.toContain('limit');
    expect(chain).toContain('range');
    expect(args).toEqual(expect.arrayContaining([0, 999]));
  });

  it('pages past 1000 active orgs, so the rotation sees all of them', async () => {
    // The embed's accepted_at filter, as servedLikePostgrest reads it.
    const all = Array.from({ length: 1500 }, (_, i) => ({
      id: `org-${String(i).padStart(4, '0')}`,
      'organization_members.accepted_at': '2026-01-01T00:00:00Z',
    }));
    const stub = makeSupabaseStub({
      'organizations.select': servedLikePostgrest(all),
      'warehouses.select': { data: [], error: null },
    });
    adminClientHolder.client = stub.client;
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const body = await (await GET(buildRequest('Bearer test-cron-secret'))).json();
    expect(stub.chainsAll.get('organizations.select')).toHaveLength(2);
    expect(body.orgSweep).toMatchObject({
      activeOrgTotal: 1500,
      swept: 50,
      truncatedByCap: 1452,
      runsToCoverAll: 32,
    });
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
    // S16: the database's text is reported (it never was), never answered.
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      error: 'internal_error',
      message: 'Something went wrong. Please try again.',
    });
    expect(text).not.toContain('db down');
    expect(reportError).toHaveBeenCalledWith(expect.objectContaining({ message: 'db down' }), {
      tag: 'cron.prewarm-orders-catalog',
      extra: { step: 'org_enumeration' },
    });
  });

  it('discloses the orgs outside this run\'s window in an info line, and warns only when work was shed for time', async () => {
    const stub = makeSupabaseStub({
      'organizations.select': {
        // A 120-org fleet: the two known-hot orgs and a window of 48 run now.
        data: Array.from({ length: 120 }, (_, i) => ({ id: `org-${String(i).padStart(3, '0')}` })),
        error: null,
      },
      'warehouses.select': { data: [], error: null },
    });
    adminClientHolder.client = stub.client;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

    const res = await GET(buildRequest('Bearer test-cron-secret'));
    const body = await res.json();

    expect(body.orgSweep).toMatchObject({
      activeOrgTotal: 120,
      swept: 50,
      truncatedByCap: 72,
      runsToCoverAll: 3,
      skippedForBudget: 0,
    });
    // Repo rule: no silent caps. The window is routine, so an info line;
    // nothing was shed for time, so no warning.
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('truncatedByCap=72 runsToCoverAll=3'));
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('shed work'));
    warnSpy.mockRestore();
    infoSpy.mockRestore();
  });

  it('warns when the deadline sheds work', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-17T12:00:00.000Z'));
    adminClientHolder.client = makeSupabaseStub({
      'organizations.select': {
        data: Array.from({ length: 10 }, (_, i) => ({ id: `org-${i}` })),
        error: null,
      },
      'warehouses.select': { data: [], error: null },
    }).client;
    prewarmInventorySpy.mockImplementation(async (organizationId, warehouseId) => {
      vi.setSystemTime(Date.now() + 20_000);
      return inventoryResult(organizationId, warehouseId);
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});

    const body = await (await GET(buildRequest('Bearer test-cron-secret'))).json();
    // Warms start at 0, 20 and 40 s; the fourth would start at 60 s.
    expect(body.orgSweep.skippedForBudget).toBe(9);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('skippedForBudget=9'));
    vi.useRealTimers();
  });

  it('runs cut by the deadline still warm every org: the ones left go first next run', async () => {
    // 96 orgs; each warm takes 1.6 s, so about 30 of each window of 48 are
    // warmed before the 50 s deadline. A window chosen from the clock alone
    // cut the same tail every time and never warmed a third of them.
    vi.useFakeTimers({ toFake: ['Date'] });
    const fleet = Array.from({ length: 96 }, (_, i) => ({
      id: `org-${String(i).padStart(3, '0')}`,
      'organization_members.accepted_at': '2026-01-01T00:00:00Z',
    }));
    const attempts: Array<{ job: string; organization_id: string; last_attempt_at: string }> = [];
    prewarmInventorySpy.mockImplementation(async (organizationId, warehouseId) => {
      vi.setSystemTime(Date.now() + 1_600);
      return inventoryResult(organizationId, warehouseId);
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const warmed = new Set<string>();
    const t0 = Date.parse('2026-11-17T12:00:00.000Z');
    const runs = Math.ceil(96 / 30) + 1;
    for (let run = 0; run < runs; run += 1) {
      vi.setSystemTime(t0 + run * 30 * 60_000);
      const stub = makeSupabaseStub({
        'organizations.select': servedLikePostgrest(fleet),
        'warehouses.select': { data: [], error: null },
        'cron_sweep_attempts.select': servedLikePostgrest(() => attempts),
        'cron_sweep_attempts.insert': (call) => {
          const row = call.args[call.methods.indexOf('upsert')]![0] as {
            job: string;
            organization_id: string;
            last_attempt_at: string;
          };
          const prev = attempts.find((a) => a.organization_id === row.organization_id);
          if (prev) Object.assign(prev, row);
          else attempts.push({ ...row });
          return { data: null, error: null };
        },
      });
      adminClientHolder.client = stub.client;
      prewarmInventorySpy.mockClear();
      const body = await (await GET(buildRequest('Bearer test-cron-secret'))).json();
      const calls = prewarmInventorySpy.mock.calls.map((c) => c[0]);
      // The known-hot orgs lead every run.
      expect(calls.slice(0, 2)).toEqual([HOT_1, HOT_2]);
      expect(body.orgSweep.skippedForBudget).toBeGreaterThan(0);
      for (const id of calls.slice(2)) warmed.add(id);
      // Only window orgs are recorded, under job 'prewarm'.
      for (const args of stub.chainArgsAll.get('cron_sweep_attempts.insert') ?? []) {
        const row = args[0]![0] as { job: string; organization_id: string };
        expect(row.job).toBe('prewarm');
        expect([HOT_1, HOT_2]).not.toContain(row.organization_id);
      }
    }
    expect(warmed.size).toBe(96);
    vi.useRealTimers();
  });

  it('warms the phone photo map for each known-hot pair, and a failure does not stop the sweep', async () => {
    const stub = makeSupabaseStub({
      'organizations.select': { data: [{ id: HOT_1 }], error: null, count: 1 },
      'warehouses.select': {
        data: [
          { id: 'wh-1', organization_id: HOT_1 },
          { id: 'wh-2', organization_id: HOT_1 },
        ],
        error: null,
      },
    });
    adminClientHolder.client = stub.client;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    prewarmPhoneSpy.mockImplementationOnce(async (organizationId, warehouseId) => ({
      organizationId,
      warehouseId,
      photoCount: 0,
      ms: 1,
      error: 'photo sign failed',
    }));

    const res = await GET(buildRequest('Bearer test-cron-secret'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(prewarmPhoneSpy.mock.calls).toEqual([
      [HOT_1, 'wh-1'],
      [HOT_1, 'wh-2'],
    ]);
    expect(prewarmCatalogSpy.mock.calls).toEqual([
      [HOT_1, 'wh-1'],
      [HOT_1, 'wh-2'],
    ]);
    expect(body.phoneThumbMaps).toEqual([
      { organizationId: HOT_1, warehouseId: 'wh-1', photoCount: 0, ms: 1, error: 'photo sign failed' },
      { organizationId: HOT_1, warehouseId: 'wh-2', photoCount: 3, ms: 1, error: null },
    ]);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('phone photo map failed for org'),
    );
  });
});

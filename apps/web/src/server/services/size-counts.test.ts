import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_MODULE_IDS, type ModuleId } from '@stockpilot/core';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

vi.mock('@/lib/auth/warehouse', () => ({
  assertWarehouseAccess: vi.fn(),
  getWarehouseAccess: vi.fn(async () => ({
    readableIds: ['wh-a'],
    writableIds: ['wh-a'],
    hasAllAccess: true,
    primaryWarehouseId: 'wh-a',
  })),
  forcedWarehouseId: vi.fn(async () => null),
  ForbiddenError: class ForbiddenError extends Error {
    readonly code = 'forbidden' as const;
  },
}));

vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    userId: 'user-test',
    organizationId: 'org-test',
    role: 'admin',
  })),
}));

import { SizeCountsService } from './size-counts';

const withIsc = new Set<ModuleId>([...DEFAULT_MODULE_IDS, 'instant_size_count']);

beforeEach(() => vi.clearAllMocks());

describe('SizeCountsService.createSession', () => {
  it('creates a session and returns it', async () => {
    const stub = makeSupabaseStub({
      'size_count_sessions.insert': {
        data: { id: 'sess-1', organization_id: 'org-test', status: 'active', mode: 'rapid_pass' },
        error: null,
      },
    });
    const svc = new SizeCountsService(makeServiceContext(stub.client, { enabledModules: withIsc }));
    const session = await svc.createSession({ styleKey: 'TEE-BLACK' });
    expect(session).toMatchObject({ id: 'sess-1', status: 'active' });
  });

  it('throws when the instant_size_count module is disabled', async () => {
    const stub = makeSupabaseStub({});
    const svc = new SizeCountsService(
      makeServiceContext(stub.client, { enabledModules: new Set<ModuleId>(['inventory']) }),
    );
    await expect(svc.createSession({})).rejects.toMatchObject({ code: 'module_disabled' });
  });
});

describe('SizeCountsService.appendEvents', () => {
  it('idempotently appends and returns the count of NEW events', async () => {
    const stub = makeSupabaseStub({
      'size_count_sessions.select': { data: { warehouse_id: null, status: 'active' }, error: null },
      // upsert maps to op=insert in the stub; ignoreDuplicates returns only new rows.
      'size_count_events.insert': { data: [{ id: 'e1' }, { id: 'e2' }], error: null },
    });
    const svc = new SizeCountsService(makeServiceContext(stub.client, { enabledModules: withIsc }));
    const res = await svc.appendEvents('sess-1', [
      { idempotencyKey: 'k1', size: 'M' },
      { idempotencyKey: 'k2', size: 'L' },
      { idempotencyKey: 'k1', size: 'M' }, // replay — deduped server-side
    ]);
    expect(res).toEqual({ inserted: 2 });
  });

  it('rejects appending to a completed session (conflict)', async () => {
    const stub = makeSupabaseStub({
      'size_count_sessions.select': { data: { warehouse_id: null, status: 'completed' }, error: null },
    });
    const svc = new SizeCountsService(makeServiceContext(stub.client, { enabledModules: withIsc }));
    await expect(
      svc.appendEvents('sess-1', [{ idempotencyKey: 'k1', size: 'M' }]),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('404s when the session does not exist in the org', async () => {
    const stub = makeSupabaseStub({
      'size_count_sessions.select': { data: null, error: null },
    });
    const svc = new SizeCountsService(makeServiceContext(stub.client, { enabledModules: withIsc }));
    await expect(
      svc.appendEvents('missing', [{ idempotencyKey: 'k1', size: 'M' }]),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('is a no-op for an empty batch', async () => {
    const stub = makeSupabaseStub({});
    const svc = new SizeCountsService(makeServiceContext(stub.client, { enabledModules: withIsc }));
    expect(await svc.appendEvents('sess-1', [])).toEqual({ inserted: 0 });
  });
});

describe('SizeCountsService.completeSession', () => {
  it('locks an active session (status -> completed)', async () => {
    const stub = makeSupabaseStub({
      'size_count_sessions.update': { data: { id: 'sess-1', status: 'completed' }, error: null },
    });
    const svc = new SizeCountsService(makeServiceContext(stub.client, { enabledModules: withIsc }));
    const session = await svc.completeSession('sess-1');
    expect(session).toMatchObject({ status: 'completed' });
  });

  it('conflicts when the session is already completed/canceled (guard returns no row)', async () => {
    const stub = makeSupabaseStub({
      'size_count_sessions.update': { data: null, error: null },
    });
    const svc = new SizeCountsService(makeServiceContext(stub.client, { enabledModules: withIsc }));
    await expect(svc.completeSession('sess-1')).rejects.toMatchObject({ code: 'conflict' });
  });
});

describe('SizeCountsService.getSession', () => {
  it('returns the session + per-size tally (SUM of quantity_delta)', async () => {
    const stub = makeSupabaseStub({
      'size_count_sessions.select': {
        data: { id: 'sess-1', organization_id: 'org-test', status: 'active' },
        error: null,
      },
      'size_count_events.select': {
        data: [
          { size: 'M', quantity_delta: 1 },
          { size: 'M', quantity_delta: 1 },
          { size: 'L', quantity_delta: 1 },
          { size: 'L', quantity_delta: -1 }, // undo — nets L to 0, dropped
        ],
        error: null,
      },
    });
    const svc = new SizeCountsService(makeServiceContext(stub.client, { enabledModules: withIsc }));
    const { tally } = await svc.getSession('sess-1');
    const bySize = Object.fromEntries(tally.map((t) => [t.size, t.quantity]));
    expect(bySize).toEqual({ M: 2 }); // L netted to 0 and is filtered out
  });
});

// ---------------------------------------------------------------------------
// The capture screen's per-size counter is the only feedback a person gets that
// their photo work is being kept. It used to be a bare .select() whose rows
// were counted in JS, so PostgREST's [api] max_rows = 1000 clamp silently
// truncated it: at 2,171 real samples it reported 1,000 and stopped moving,
// which reads as "my photos are not saving" (owner report 2026-07-22).
// ---------------------------------------------------------------------------

describe('SizeCountsService.getTrainingStats', () => {
  function pagedStub(total: number) {
    // Emulate the server cap: never return more than 1000 rows per request,
    // and honour .range() so the pagination loop can actually walk the set.
    let call = 0;
    return makeSupabaseStub({
      'size_count_training_samples.select': () => {
        const from = call * 1000;
        call += 1;
        const remaining = Math.max(0, total - from);
        const size = Math.min(1000, remaining);
        return {
          data: Array.from({ length: size }, (_, i) => ({
            id: `s-${from + i}`,
            // Alternate two labels so the per-label split is checkable.
            size_label: (from + i) % 2 === 0 ? 'XS' : 'XXXL',
          })),
          error: null,
        };
      },
    });
  }

  function svc(stub: ReturnType<typeof makeSupabaseStub>) {
    return new SizeCountsService(
      makeServiceContext(stub.client, { organizationId: 'org-test', enabledModules: withIsc }),
    );
  }

  it('counts EVERY sample, not just the first server page', async () => {
    const res = await svc(pagedStub(2171)).getTrainingStats();
    expect(res.total).toBe(2171);
    expect(res.counts.XS! + res.counts.XXXL!).toBe(2171);
  });

  it('is exact on a dataset that fits in one page', async () => {
    const res = await svc(pagedStub(120)).getTrainingStats();
    expect(res.total).toBe(120);
  });

  it('reports zero for an org with no samples', async () => {
    const res = await svc(pagedStub(0)).getTrainingStats();
    expect(res.total).toBe(0);
    expect(res.counts).toEqual({});
  });
});

/**
 * Re-keying Instant Size Count from the display-only style_key to a real
 * product group (migration 0302).
 */
describe('SizeCountsService.createSession — product group identity', () => {
  it('persists the chosen product group', async () => {
    const stub = makeSupabaseStub({
      'size_count_sessions.insert': {
        data: { id: 'sess-g', organization_id: 'org-test', status: 'active' },
        error: null,
      },
    });
    const svc = new SizeCountsService(makeServiceContext(stub.client, { enabledModules: withIsc }));
    await svc.createSession({ productGroupId: 'grp-pegasus' });
    const args = (stub.chainArgs.get('size_count_sessions.insert') ?? []).flat();
    const row = args[0] as Record<string, unknown>;
    expect(row.product_group_id).toBe('grp-pegasus');
  });

  it('writes NULL, never a placeholder, when no group is named', async () => {
    const stub = makeSupabaseStub({
      'size_count_sessions.insert': {
        data: { id: 'sess-u', organization_id: 'org-test', status: 'active' },
        error: null,
      },
    });
    const svc = new SizeCountsService(makeServiceContext(stub.client, { enabledModules: withIsc }));
    await svc.createSession({ boxId: 'BOX-7' });
    const args = (stub.chainArgs.get('size_count_sessions.insert') ?? []).flat();
    const row = args[0] as Record<string, unknown>;
    expect(row.product_group_id).toBeNull();
    // The pre-0302 shape still goes in untouched.
    expect(row.style_key).toBeNull();
    expect(row.box_id).toBe('BOX-7');
  });

  it('still accepts the legacy styleKey for an org with no groups', async () => {
    const stub = makeSupabaseStub({
      'size_count_sessions.insert': {
        data: { id: 'sess-l', organization_id: 'org-test', status: 'active' },
        error: null,
      },
    });
    const svc = new SizeCountsService(makeServiceContext(stub.client, { enabledModules: withIsc }));
    await svc.createSession({ styleKey: 'nike pegasus 41' });
    const args = (stub.chainArgs.get('size_count_sessions.insert') ?? []).flat();
    const row = args[0] as Record<string, unknown>;
    expect(row.style_key).toBe('nike pegasus 41');
    expect(row.product_group_id).toBeNull();
  });
});

describe('SizeCountsService.getSession — group context for the tally screen', () => {
  const withIscAndSports = new Set<ModuleId>([
    ...DEFAULT_MODULE_IDS,
    'instant_size_count',
    'sports',
  ]);

  it('returns no group for an ungrouped session, so the chips stay legacy', async () => {
    const stub = makeSupabaseStub({
      'size_count_sessions.select': {
        data: { id: 's1', status: 'active', product_group_id: null, style_key: 'tee' },
        error: null,
      },
      'size_count_events.select': { data: [{ size: 'M', quantity_delta: 2 }], error: null },
    });
    const svc = new SizeCountsService(
      makeServiceContext(stub.client, { enabledModules: withIscAndSports }),
    );
    const res = await svc.getSession('s1');
    expect(res.group).toBeNull();
    expect(res.tally).toEqual([{ size: 'M', quantity: 2 }]);
  });

  it('returns the group name, counting unit and its size scale IN SCALE ORDER', async () => {
    const stub = makeSupabaseStub({
      'size_count_sessions.select': {
        data: { id: 's2', status: 'active', product_group_id: 'grp-1', style_key: null },
        error: null,
      },
      'size_count_events.select': { data: [], error: null },
      'product_groups.select': {
        data: [
          { id: 'grp-1', name: 'Nike Pegasus 41', default_counting_unit: 'pair', size_scale_id: 'sc-1' },
        ],
        error: null,
      },
      'size_scale_values.select': {
        data: [
          // Deliberately out of order — the sort_order decides, not the read.
          { size_scale_id: 'sc-1', value: '10', normalized: '10', sort_order: 3 },
          { size_scale_id: 'sc-1', value: '9', normalized: '9', sort_order: 1 },
          { size_scale_id: 'sc-1', value: '9.5', normalized: '9.5', sort_order: 2 },
        ],
        error: null,
      },
    });
    const svc = new SizeCountsService(
      makeServiceContext(stub.client, { enabledModules: withIscAndSports }),
    );
    const res = await svc.getSession('s2');
    expect(res.group).toMatchObject({
      id: 'grp-1',
      name: 'Nike Pegasus 41',
      countingUnit: 'pair',
    });
    // Half sizes the hardcoded nine could never tally.
    expect(res.group?.sizes).toEqual(['9', '9.5', '10']);
  });

  it('does NOT 403 a grouped session after the org turns the sports module off', async () => {
    // Reading back a count list you already made must never start failing.
    const stub = makeSupabaseStub({
      'size_count_sessions.select': {
        data: { id: 's3', status: 'completed', product_group_id: 'grp-1', style_key: null },
        error: null,
      },
      'size_count_events.select': { data: [{ size: '10', quantity_delta: 4 }], error: null },
    });
    const svc = new SizeCountsService(makeServiceContext(stub.client, { enabledModules: withIsc }));
    const res = await svc.getSession('s3');
    expect(res.group).toBeNull();
    expect(res.tally).toEqual([{ size: '10', quantity: 4 }]);
  });
});

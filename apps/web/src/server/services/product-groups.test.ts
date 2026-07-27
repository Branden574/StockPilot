import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildGroupKey, type ModuleId } from '@stockpilot/core';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

import { ProductGroupsService } from './product-groups';

vi.mock('./audit', () => ({ audit: vi.fn(async () => {}) }));

const SPORTS_MODULES = new Set<ModuleId>(['inventory', 'sports']);

function sportsCtx(client: unknown, over: Record<string, unknown> = {}) {
  return makeServiceContext(client, { enabledModules: SPORTS_MODULES, ...over });
}

function groupRow(over: Record<string, unknown> = {}) {
  return {
    id: 'grp-1',
    organization_id: 'org-test',
    category_id: 'cat-1',
    subcategory_key: 'shoes',
    name: 'Nike Pegasus 41',
    brand: 'Nike',
    manufacturer: null,
    model: 'Pegasus 41',
    style_number: 'FD2722',
    colorway: 'Black/White',
    team: null,
    league: null,
    season: null,
    home_away: null,
    color: null,
    size_scale_id: null,
    default_counting_unit: 'pair',
    tracking_mode: null,
    group_key: buildGroupKey({
      subcategoryKey: 'shoes',
      brand: 'Nike',
      model: 'Pegasus 41',
      styleNumber: 'FD2722',
      colorway: 'Black/White',
    }),
    status: 'active',
    created_at: '2026-07-27T00:00:00Z',
    updated_at: '2026-07-27T00:00:00Z',
    ...over,
  };
}

const CREATE_INPUT = {
  subcategoryKey: 'shoes',
  name: 'Nike Pegasus 41',
  categoryId: 'cat-1',
  brand: 'Nike',
  model: 'Pegasus 41',
  styleNumber: 'FD2722',
  colorway: 'Black/White',
  defaultCountingUnit: 'pair' as const,
};

describe('ProductGroupsService.findOrCreate', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates on the first call and matches the same key on the second', async () => {
    // First pass: the key lookup misses, so the insert runs.
    const first = makeSupabaseStub({
      'product_groups.select': { data: null, error: null },
      'product_groups.insert': { data: groupRow(), error: null },
    });
    const created = await new ProductGroupsService(sportsCtx(first.client)).findOrCreate(
      CREATE_INPUT,
    );
    expect(created.created).toBe(true);
    expect(created.group.id).toBe('grp-1');

    // The key written is the one buildGroupKey derives — never a client value.
    const insertArgs = first.chainArgs.get('product_groups.insert')?.[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(insertArgs.group_key).toBe(groupRow().group_key);
    expect(insertArgs.organization_id).toBe('org-test');

    // Second pass: the same key now exists, so nothing is inserted.
    const second = makeSupabaseStub({
      'product_groups.select': { data: [groupRow()], error: null },
    });
    const matched = await new ProductGroupsService(sportsCtx(second.client)).findOrCreate(
      CREATE_INPUT,
    );
    expect(matched.created).toBe(false);
    expect(matched.group.id).toBe('grp-1');
    expect(second.chains.has('product_groups.insert')).toBe(false);
  });

  it('re-reads instead of throwing when a concurrent writer wins the 23505 race', async () => {
    let selectCall = 0;
    const stub = makeSupabaseStub({
      // Miss on the pre-check, hit on the post-conflict re-read.
      'product_groups.select': () => {
        selectCall += 1;
        return selectCall === 1
          ? { data: null, error: null }
          : { data: [groupRow({ id: 'grp-raced' })], error: null };
      },
      'product_groups.insert': {
        data: null,
        error: { message: 'duplicate key', code: '23505' },
      },
    });

    const out = await new ProductGroupsService(sportsCtx(stub.client)).findOrCreate(CREATE_INPUT);
    expect(out.created).toBe(false);
    expect(out.group.id).toBe('grp-raced');
    expect(selectCall).toBe(2);
  });

  it('still throws when a 23505 leaves nothing readable behind', async () => {
    const stub = makeSupabaseStub({
      'product_groups.select': { data: null, error: null },
      'product_groups.insert': {
        data: null,
        error: { message: 'duplicate key', code: '23505' },
      },
    });
    await expect(
      new ProductGroupsService(sportsCtx(stub.client)).findOrCreate(CREATE_INPUT),
    ).rejects.toMatchObject({ code: 'internal_error' });
  });

  it('derives DIFFERENT keys for two colorways of the same model', async () => {
    const a = buildGroupKey({
      subcategoryKey: 'shoes',
      brand: 'Nike',
      model: 'Pegasus 41',
      styleNumber: 'FD2722',
      colorway: 'Black/White',
    });
    const b = buildGroupKey({
      subcategoryKey: 'shoes',
      brand: 'Nike',
      model: 'Pegasus 41',
      styleNumber: 'FD2722',
      colorway: 'Volt',
    });
    expect(a).not.toBe(b);
  });

  it('refuses to run at all when the sports module is off', async () => {
    const stub = makeSupabaseStub({});
    const ctx = makeServiceContext(stub.client, {
      enabledModules: new Set<ModuleId>(['inventory']),
    });
    await expect(
      new ProductGroupsService(ctx).findOrCreate(CREATE_INPUT),
    ).rejects.toMatchObject({ code: 'module_disabled' });
  });

  it('refuses a caller without items:create', async () => {
    const stub = makeSupabaseStub({});
    const ctx = sportsCtx(stub.client, { role: 'viewer' });
    await expect(
      new ProductGroupsService(ctx).findOrCreate(CREATE_INPUT),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('ProductGroupsService.candidates', () => {
  it('never returns a match on name alone', async () => {
    const stub = makeSupabaseStub({
      'product_groups.select': { data: [groupRow()], error: null },
    });
    const svc = new ProductGroupsService(sportsCtx(stub.client));

    const byName = await svc.candidates({
      subcategoryKey: 'shoes',
      name: 'Nike Pegasus 41',
    });
    expect(byName).toEqual([]);
    // Not one query was even issued — a name is not a probe.
    expect(stub.fromCalls).toEqual([]);
  });

  it('probes on style number when one is present', async () => {
    const stub = makeSupabaseStub({
      'product_groups.select': { data: [groupRow()], error: null },
    });
    const out = await new ProductGroupsService(sportsCtx(stub.client)).candidates({
      subcategoryKey: 'shoes',
      styleNumber: 'FD2722',
    });
    expect(out).toHaveLength(1);
    expect(stub.chains.get('product_groups.select')).toContain('ilike');
  });

  it('probes on brand + model only when BOTH are present', async () => {
    const brandOnly = makeSupabaseStub({
      'product_groups.select': { data: [groupRow()], error: null },
    });
    expect(
      await new ProductGroupsService(sportsCtx(brandOnly.client)).candidates({
        subcategoryKey: 'shoes',
        brand: 'Nike',
      }),
    ).toEqual([]);
    expect(brandOnly.fromCalls).toEqual([]);

    const both = makeSupabaseStub({
      'product_groups.select': { data: [groupRow()], error: null },
    });
    expect(
      await new ProductGroupsService(sportsCtx(both.client)).candidates({
        subcategoryKey: 'shoes',
        brand: 'Nike',
        model: 'Pegasus 41',
      }),
    ).toHaveLength(1);
  });
});

describe('ProductGroupsService.rollups', () => {
  it('reads the derived view, never a stored total', async () => {
    const stub = makeSupabaseStub({
      'product_group_rollups.select': {
        data: [
          { group_id: 'grp-1', variant_count: 3, total_quantity: 52, counting_unit: 'pair' },
        ],
        error: null,
      },
    });
    const out = await new ProductGroupsService(sportsCtx(stub.client)).rollups(['grp-1']);

    expect(stub.fromCalls).toEqual(['product_group_rollups']);
    expect(out.get('grp-1')).toEqual({
      variantCount: 3,
      totalQuantity: 52,
      countingUnit: 'pair',
    });
  });

  it('returns 0 / 0 for a group with no variants', async () => {
    const stub = makeSupabaseStub({
      'product_group_rollups.select': {
        data: [
          { group_id: 'grp-empty', variant_count: 0, total_quantity: 0, counting_unit: 'each' },
        ],
        error: null,
      },
    });
    const out = await new ProductGroupsService(sportsCtx(stub.client)).rollups(['grp-empty']);
    expect(out.get('grp-empty')).toEqual({
      variantCount: 0,
      totalQuantity: 0,
      countingUnit: 'each',
    });
  });

  it('short-circuits on an empty id list without touching the DB', async () => {
    const stub = makeSupabaseStub({});
    expect((await new ProductGroupsService(sportsCtx(stub.client)).rollups([])).size).toBe(0);
    expect(stub.fromCalls).toEqual([]);
  });
});

describe('ProductGroupsService.update', () => {
  beforeEach(() => vi.clearAllMocks());

  it('RECOMPUTES group_key from the merged row rather than patching it', async () => {
    const stub = makeSupabaseStub({
      'product_groups.select': { data: [groupRow()], error: null },
      'product_groups.update': {
        data: [groupRow({ style_number: 'FD9999' })],
        error: null,
      },
    });
    await new ProductGroupsService(sportsCtx(stub.client)).update('grp-1', {
      styleNumber: 'FD9999',
    });

    const patch = stub.chainArgs.get('product_groups.update')?.[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(patch.group_key).toBe(
      buildGroupKey({
        subcategoryKey: 'shoes',
        brand: 'Nike',
        model: 'Pegasus 41',
        styleNumber: 'FD9999',
        colorway: 'Black/White',
        name: 'Nike Pegasus 41',
      }),
    );
    // organization_id is never in the patch — it is pinned by the DB trigger
    // and must not be writable through the service either.
    expect(patch).not.toHaveProperty('organization_id');
  });

  it('requires sports:manage, not merely items:create', async () => {
    const stub = makeSupabaseStub({
      'product_groups.select': { data: [groupRow()], error: null },
    });
    const staff = sportsCtx(stub.client, { role: 'staff' });
    await expect(
      new ProductGroupsService(staff).update('grp-1', { name: 'x' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('does NOT fail open when RLS hides the row (no error, no row)', async () => {
    const stub = makeSupabaseStub({
      'product_groups.select': { data: [groupRow()], error: null },
      'product_groups.update': { data: null, error: null },
    });
    await expect(
      new ProductGroupsService(sportsCtx(stub.client)).update('grp-1', { name: 'x' }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});

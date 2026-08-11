import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildGroupKey, type ModuleId } from '@stockpilot/core';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

import { audit } from './audit';
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

/**
 * A stub that ACTUALLY APPLIES the status filter the service asked for.
 *
 * A test that only asserted `.eq('status', 'active')` was called proves the call
 * shape and nothing about the result. This fake filters the rows it hands back by
 * whatever status the query carried — so "the archived group is absent" is the
 * assertion, and deleting the filter from the service makes the fake return the
 * archived row and the test fail. A filter that stopped being applied would
 * otherwise be invisible.
 */
function filteringGroupStub(rows: Array<Record<string, unknown>>) {
  let stub: ReturnType<typeof makeSupabaseStub> | null = null;
  stub = makeSupabaseStub({
    'product_groups.select': () => {
      // Recorded by the time the chain is awaited, which is when this runs.
      const args = stub!.chainArgs.get('product_groups.select') ?? [];
      const statusArg = args.find((a) => a[0] === 'status');
      const wanted = statusArg?.[1] as string | undefined;
      return {
        // No status filter at all => every row, archived included. That is the
        // failure this fake exists to make visible.
        data: wanted === undefined ? rows : rows.filter((r) => r.status === wanted),
        error: null,
      };
    },
  });
  return stub;
}

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

  // ── Owner decision: a matched ARCHIVED group is RESTORED, not refused ──
  //
  // The alternative was refusing, and it is worse: findOrCreate runs inside PO
  // import and receiving, so a refusal aborts a run halfway with stock already
  // on the dock. Archive means "out of use"; a variant arriving under the exact
  // same identity is the world contradicting the archive. This mirrors the item
  // auto-archive precedent, whose own migration comment says auto_archived
  // "gates auto-restore-on-restock".
  it('restores an archived group that matches, and returns it ACTIVE', async () => {
    const stub = makeSupabaseStub({
      'product_groups.select': { data: [groupRow({ status: 'archived' })], error: null },
      'product_groups.update': { data: groupRow({ status: 'active' }), error: null },
    });

    const out = await new ProductGroupsService(sportsCtx(stub.client)).findOrCreate(CREATE_INPUT);

    expect(out.created).toBe(false);
    // The caller must receive the ACTIVE row, not the stale archived one it
    // matched on - otherwise the variant is attached to a group the caller
    // believes is archived.
    expect(out.group.status).toBe('active');
    // Restored in place, never duplicated behind the archive.
    expect(stub.chains.has('product_groups.insert')).toBe(false);
    const updateArgs = stub.chainArgs.get('product_groups.update')?.[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(updateArgs.status).toBe('active');
  });

  it('restores for an items:create-only caller — the PO-import path must not be refused', async () => {
    // THE TRAP THIS PINS: the public restore() asserts 'sports:manage'. Reusing
    // it here would refuse the item form, PO import and receiving, which hold
    // items:create only - reintroducing the exact mid-run abort the auto-restore
    // decision exists to prevent. findOrCreate already authorized the caller, so
    // the internal restore must not re-assert a STRICTER permission.
    const stub = makeSupabaseStub({
      'product_groups.select': { data: [groupRow({ status: 'archived' })], error: null },
      'product_groups.update': { data: groupRow({ status: 'active' }), error: null },
    });
    const ctx = sportsCtx(stub.client, { permissions: new Set(['items:create']) });

    const out = await new ProductGroupsService(ctx).findOrCreate(CREATE_INPUT);

    expect(out.group.status).toBe('active');
  });

  it('records the restore in the audit trail with its reason, so it is not silent', async () => {
    const { audit } = await import('./audit');
    const stub = makeSupabaseStub({
      'product_groups.select': { data: [groupRow({ status: 'archived' })], error: null },
      'product_groups.update': { data: groupRow({ status: 'active' }), error: null },
    });

    await new ProductGroupsService(sportsCtx(stub.client)).findOrCreate(CREATE_INPUT);

    const restored = vi
      .mocked(audit)
      .mock.calls.find(([e]) => (e as { event?: string }).event === 'sports.group.restored');
    expect(restored, 'a restore must leave an audit row').toBeTruthy();
    expect((restored![0] as { extra?: Record<string, unknown> }).extra?.reason).toBe(
      'variant_matched_archived_group',
    );
  });

  it('leaves an ACTIVE match completely alone — no needless status write', async () => {
    const stub = makeSupabaseStub({
      'product_groups.select': { data: [groupRow({ status: 'active' })], error: null },
    });

    const out = await new ProductGroupsService(sportsCtx(stub.client)).findOrCreate(CREATE_INPUT);

    expect(out.group.status).toBe('active');
    expect(stub.chains.has('product_groups.update')).toBe(false);
  });

  it('fails CLOSED when the restore update matches no row', async () => {
    // Recurring pattern: .update().eq() cannot tell "zero rows" from success.
    const stub = makeSupabaseStub({
      'product_groups.select': { data: [groupRow({ status: 'archived' })], error: null },
      'product_groups.update': { data: null, error: null },
    });

    await expect(
      new ProductGroupsService(sportsCtx(stub.client)).findOrCreate(CREATE_INPUT),
    ).rejects.toThrow(/not found/i);
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

  it('refuses a caller holding NEITHER items:create nor sports:manage', async () => {
    const stub = makeSupabaseStub({});
    const ctx = sportsCtx(stub.client, { role: 'viewer' });
    await expect(
      new ProductGroupsService(ctx).findOrCreate(CREATE_INPUT),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  // Task 18 review fix: the linking tool gates its WRITE on sports:manage, so
  // a reviewer granted only that could open the tool, tick a family, and be
  // refused at the "create the group to link into" step.
  it('accepts a sports:manage reviewer who was never granted items:create', async () => {
    const stub = makeSupabaseStub({
      'product_groups.select': { data: null, error: null },
      'product_groups.insert': { data: groupRow(), error: null },
    });
    const ctx = sportsCtx(stub.client, {
      role: 'viewer',
      permissions: new Set(['sports:manage']),
    });
    const out = await new ProductGroupsService(ctx).findOrCreate(CREATE_INPUT);
    expect(out.created).toBe(true);
  });

  it('still accepts an items:create caller with no sports:manage', async () => {
    const stub = makeSupabaseStub({
      'product_groups.select': { data: null, error: null },
      'product_groups.insert': { data: groupRow(), error: null },
    });
    const ctx = sportsCtx(stub.client, {
      role: 'staff',
      permissions: new Set(['items:create']),
    });
    const out = await new ProductGroupsService(ctx).findOrCreate(CREATE_INPUT);
    expect(out.created).toBe(true);
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

  it('scopes the view read to this organization', async () => {
    // The view is security_invoker so RLS already scopes it, but a service-role
    // context has no RLS at all — every other read here carries the predicate.
    const stub = makeSupabaseStub({
      'product_group_rollups.select': { data: [], error: null },
    });
    await new ProductGroupsService(sportsCtx(stub.client)).rollups(['grp-1']);

    const args = stub.chainArgs.get('product_group_rollups.select') ?? [];
    expect(args).toContainEqual(['organization_id', 'org-test']);
  });
});

describe('ProductGroupsService — sports module gate on the READ paths', () => {
  const NO_SPORTS = new Set<ModuleId>(['inventory']);

  it('refuses findByKey / rollups / variants / candidates with the module off', async () => {
    const stub = makeSupabaseStub({});
    const svc = new ProductGroupsService(
      makeServiceContext(stub.client, { enabledModules: NO_SPORTS }),
    );

    await expect(svc.findByKey('shoes|nike|pegasus 41||')).rejects.toMatchObject({
      code: 'module_disabled',
    });
    await expect(svc.rollups(['grp-1'])).rejects.toMatchObject({ code: 'module_disabled' });
    await expect(svc.variants('grp-1')).rejects.toMatchObject({ code: 'module_disabled' });
    await expect(svc.candidates({ subcategoryKey: 'shoes', styleNumber: 'FD2722' })).rejects.toMatchObject(
      { code: 'module_disabled' },
    );
    // Refused BEFORE any query — an entitlement check that still reads is not
    // a gate, it is a filter.
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

  // `subcategoryKey` was merged with `??`, which cannot see the difference
  // between "absent — keep the current one" and "explicitly null — clear it".
  // A patch of `{ subcategoryKey: null }` wrote NULL to the column while
  // computing group_key from the OLD subcategory, so the stored key described a
  // shape the row no longer had — and the subcategory decides which SLOTS
  // participate (jersey slots vs shoe slots), so the next findOrCreate for this
  // identity missed the key entirely and minted a duplicate group.
  it('computes group_key from the RESULTING state when the subcategory is explicitly cleared', async () => {
    const stub = makeSupabaseStub({
      'product_groups.select': { data: [groupRow()], error: null },
      'product_groups.update': { data: [groupRow({ subcategory_key: null })], error: null },
    });
    await new ProductGroupsService(sportsCtx(stub.client)).update('grp-1', {
      subcategoryKey: null,
    });

    const patch = stub.chainArgs.get('product_groups.update')?.[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(patch.subcategory_key).toBeNull();
    expect(patch.group_key).toBe(
      buildGroupKey({
        subcategoryKey: '',
        brand: 'Nike',
        model: 'Pegasus 41',
        styleNumber: 'FD2722',
        colorway: 'Black/White',
        name: 'Nike Pegasus 41',
      }),
    );
    // The key must NOT still describe the subcategory the row just lost.
    expect(patch.group_key).not.toBe(groupRow().group_key);
  });

  it('still keeps the current subcategory when the patch omits it', async () => {
    const stub = makeSupabaseStub({
      'product_groups.select': { data: [groupRow()], error: null },
      'product_groups.update': { data: [groupRow({ name: 'Renamed' })], error: null },
    });
    await new ProductGroupsService(sportsCtx(stub.client)).update('grp-1', { name: 'Renamed' });

    const patch = stub.chainArgs.get('product_groups.update')?.[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(patch).not.toHaveProperty('subcategory_key');
    expect(patch.group_key).toBe(groupRow().group_key);
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

describe('ProductGroupsService.variantsByKey', () => {
  beforeEach(() => vi.clearAllMocks());

  it('scopes the exact-key lookup to the org, the group and live rows', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': {
        data: [{ id: 'item-1', name: 'Pegasus 41 US10', sku: 'SKU-1' }],
        error: null,
      },
    });
    const rows = await new ProductGroupsService(sportsCtx(stub.client)).variantsByKey(
      'grp-1',
      'size=10|system=us_mens',
    );
    expect(rows).toEqual([{ id: 'item-1', name: 'Pegasus 41 US10', sku: 'SKU-1' }]);

    const args = stub.chainArgs.get('inventory_items.select') ?? [];
    const flat = args.flat();
    expect(flat).toContainEqual('org-test');
    expect(flat).toContainEqual('grp-1');
    expect(flat).toContainEqual('size=10|system=us_mens');
    expect(stub.chains.get('inventory_items.select')).toContain('is');
  });

  it('returns every colliding row rather than picking a winner', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': {
        data: [
          { id: 'a', name: 'A', sku: 'SKU-A' },
          { id: 'b', name: 'B', sku: 'SKU-B' },
        ],
        error: null,
      },
    });
    const rows = await new ProductGroupsService(sportsCtx(stub.client)).variantsByKey(
      'grp-1',
      'size=10',
    );
    expect(rows).toHaveLength(2);
  });

  it('is gated on the sports module', async () => {
    const stub = makeSupabaseStub({ 'inventory_items.select': { data: [], error: null } });
    const noSports = makeServiceContext(stub.client, {
      enabledModules: new Set<ModuleId>(['inventory']),
    });
    await expect(
      new ProductGroupsService(noSports).variantsByKey('grp-1', 'size=10'),
    ).rejects.toMatchObject({ code: 'module_disabled' });
  });
});

describe('ProductGroupsService.displayByIds (Task 16 review fix: chunking)', () => {
  it('chunks a >500 group-id list into batches instead of one un-bounded `.in()`', async () => {
    const manyIds = Array.from({ length: 1200 }, (_, i) => `grp-${i}`);
    let call = 0;
    const stub = makeSupabaseStub({
      'product_groups.select': () => {
        call += 1;
        // Each batch returns ONE distinct row so the merged map's size proves
        // every batch's result actually landed, not just the last one.
        return { data: [groupRow({ id: `grp-batch-${call}` })], error: null };
      },
    });
    const out = await new ProductGroupsService(sportsCtx(stub.client)).displayByIds(manyIds);

    // 1200 ids at 500/batch = 3 batches, merged into 3 map entries.
    expect(out.size).toBe(3);
    const chains = stub.chainsAll.get('product_groups.select') ?? [];
    const argsAll = stub.chainArgsAll.get('product_groups.select') ?? [];
    expect(chains).toHaveLength(3);
    const batchSizes = chains.map((chain, q) => {
      const idx = chain.indexOf('in');
      const args = argsAll[q]?.[idx] as [string, string[]];
      return args[1].length;
    });
    expect(batchSizes).toEqual([500, 500, 200]);
  });

  it('throws rather than swallowing a mid-batch error', async () => {
    const manyIds = Array.from({ length: 1200 }, (_, i) => `grp-${i}`);
    let call = 0;
    const stub = makeSupabaseStub({
      'product_groups.select': () => {
        call += 1;
        if (call === 2) return { data: null, error: { message: 'boom' } };
        return { data: [groupRow()], error: null };
      },
    });
    await expect(
      new ProductGroupsService(sportsCtx(stub.client)).displayByIds(manyIds),
    ).rejects.toMatchObject({ code: 'internal_error' });
  });

  it('a single small batch still works exactly as before', async () => {
    const stub = makeSupabaseStub({
      'product_groups.select': { data: [groupRow()], error: null },
    });
    const out = await new ProductGroupsService(sportsCtx(stub.client)).displayByIds(['grp-1']);
    expect(out.get('grp-1')).toMatchObject({ name: 'Nike Pegasus 41', countingUnit: 'pair' });
  });
});

describe('ProductGroupsService.variantsByGroupIds (Task 18 review fix: ROW-safe paging)', () => {
  /** One variant row, only the columns the merge reads. */
  function variantRow(id: string, groupId: string) {
    return {
      id,
      sku: `SKU-${id}`,
      name: `Variant ${id}`,
      quantity_on_hand: 1,
      variant_size: '9',
      variant_size_original: null,
      variant_size_system: null,
      variant_width: null,
      variant_fit: null,
      variant_color: null,
      jersey_number: null,
      player_name: null,
      variant_key: null,
      unit_of_measure: 'pair',
      tracking_type: 'none',
      warehouse_id: null,
      status: 'active',
      group_id: groupId,
    };
  }

  // The defect: the batch counted GROUPS (100 per `.in()`) while PostgREST caps
  // the RESPONSE at max_rows = 1000. 100 groups x 13 sizes = 1300 rows, of
  // which 1000 came back — silently, with no error — so an expansion showed
  // fewer variants than the group holds while the header (which reads the
  // roll-up VIEW) kept the true total. Paging by ROWS is the only fix.
  it('keeps paging past a FULL 1000-row response instead of taking it as the whole answer', async () => {
    const groupIds = Array.from({ length: 100 }, (_, i) => `grp-${i}`);
    let call = 0;
    const stub = makeSupabaseStub({
      'inventory_items.select': () => {
        call += 1;
        // First response is exactly the cap; the truth is 1300 rows.
        if (call === 1) {
          return {
            data: Array.from({ length: 1000 }, (_, i) => variantRow(`a${i}`, 'grp-0')),
            error: null,
          };
        }
        return { data: [variantRow('b0', 'grp-1'), variantRow('b1', 'grp-1')], error: null };
      },
    });

    const out = await new ProductGroupsService(sportsCtx(stub.client)).variantsByGroupIds(groupIds);

    expect(call).toBeGreaterThan(1);
    expect(out.get('grp-0')).toHaveLength(1000);
    expect(out.get('grp-1')).toHaveLength(2);
  });

  it('stops at a short page and never loops forever', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: [variantRow('v1', 'grp-1')], error: null },
    });
    const out = await new ProductGroupsService(sportsCtx(stub.client)).variantsByGroupIds([
      'grp-1',
    ]);
    expect(out.get('grp-1')).toHaveLength(1);
    expect(stub.chainsAll.get('inventory_items.select')).toHaveLength(1);
  });

  it('throws rather than swallowing a read error', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: null, error: { message: 'boom' } },
    });
    await expect(
      new ProductGroupsService(sportsCtx(stub.client)).variantsByGroupIds(['grp-1']),
    ).rejects.toMatchObject({ code: 'internal_error' });
  });
});

// ---------------------------------------------------------------------------
// Final-review wave C: three reads that were uncapped BY INTENT and therefore
// silently clamped at PostgREST's `[api] max_rows` = 1000. "No .limit()" is not
// "no cap" — the cap just moves somewhere that reports nothing.
// ---------------------------------------------------------------------------

/** One variant row, only the columns `variants()` selects. */
function singleGroupVariant(id: string, size: string | null = '9') {
  return {
    id,
    sku: `SKU-${id}`,
    name: `Variant ${id}`,
    quantity_on_hand: 1,
    variant_size: size,
    variant_size_original: null,
    variant_size_system: null,
    variant_width: null,
    variant_fit: null,
    variant_color: null,
    jersey_number: null,
    player_name: null,
    variant_key: null,
    unit_of_measure: 'pair',
    tracking_type: 'none',
    warehouse_id: null,
    status: 'active',
  };
}

describe('ProductGroupsService.variants — paged, not clamped', () => {
  beforeEach(() => vi.clearAllMocks());

  it('keeps paging past a FULL 1000-row response', async () => {
    let call = 0;
    const stub = makeSupabaseStub({
      'inventory_items.select': () => {
        call += 1;
        if (call === 1) {
          return {
            data: Array.from({ length: 1000 }, (_, i) => singleGroupVariant(`a${i}`)),
            error: null,
          };
        }
        return { data: [singleGroupVariant('b0'), singleGroupVariant('b1')], error: null };
      },
    });

    const rows = await new ProductGroupsService(sportsCtx(stub.client)).variants('grp-1');

    expect(call).toBeGreaterThan(1);
    expect(rows).toHaveLength(1002);
  });

  it('stops at a short page and never loops forever', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: [singleGroupVariant('v1')], error: null },
    });
    const rows = await new ProductGroupsService(sportsCtx(stub.client)).variants('grp-1');
    expect(rows).toHaveLength(1);
    expect(stub.chainsAll.get('inventory_items.select')).toHaveLength(1);
  });

  it('still returns size-then-sku order, with sizeless rows last', async () => {
    // The query paged on `id` (the only stable key), so the display order is
    // applied in JS — it must be the SAME order the clamped query produced.
    const stub = makeSupabaseStub({
      'inventory_items.select': {
        data: [
          singleGroupVariant('c', null),
          singleGroupVariant('b', '10'),
          singleGroupVariant('a', '10'),
          singleGroupVariant('d', '09'),
        ],
        error: null,
      },
    });
    const rows = await new ProductGroupsService(sportsCtx(stub.client)).variants('grp-1');
    expect(rows.map((r) => r.id)).toEqual(['d', 'a', 'b', 'c']);
  });

  it('throws rather than swallowing a read error', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: null, error: { message: 'boom' } },
    });
    await expect(
      new ProductGroupsService(sportsCtx(stub.client)).variants('grp-1'),
    ).rejects.toMatchObject({ code: 'internal_error' });
  });
});

describe('ProductGroupsService.countingUnits — whole-org, paged', () => {
  beforeEach(() => vi.clearAllMocks());

  it('keys every group to its own unit', async () => {
    const stub = makeSupabaseStub({
      'product_groups.select': {
        data: [
          { id: 'grp-1', default_counting_unit: 'pair' },
          { id: 'grp-2', default_counting_unit: 'set' },
        ],
        error: null,
      },
    });
    const units = await new ProductGroupsService(sportsCtx(stub.client)).countingUnits();
    expect(units).toEqual({ 'grp-1': 'pair', 'grp-2': 'set' });
  });

  it('keeps paging past a FULL 1000-row response', async () => {
    let call = 0;
    const stub = makeSupabaseStub({
      'product_groups.select': () => {
        call += 1;
        if (call === 1) {
          return {
            data: Array.from({ length: 1000 }, (_, i) => ({
              id: `g${i}`,
              default_counting_unit: 'pair',
            })),
            error: null,
          };
        }
        return { data: [{ id: 'last', default_counting_unit: 'set' }], error: null };
      },
    });
    const units = await new ProductGroupsService(sportsCtx(stub.client)).countingUnits();
    expect(call).toBeGreaterThan(1);
    expect(Object.keys(units)).toHaveLength(1001);
    expect(units.last).toBe('set');
  });

  it('is refused with the module off, before any query', async () => {
    const stub = makeSupabaseStub({});
    const svc = new ProductGroupsService(
      makeServiceContext(stub.client, { enabledModules: new Set<ModuleId>(['inventory']) }),
    );
    await expect(svc.countingUnits()).rejects.toMatchObject({ code: 'module_disabled' });
    expect(stub.fromCalls).toEqual([]);
  });
});

describe('ProductGroupsService.listForPicker — discloses its cap', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reports truncated:false and name order for a small org', async () => {
    const stub = makeSupabaseStub({
      'product_groups.select': {
        data: [
          { id: 'b', name: 'Zephyr', brand: null, model: null },
          { id: 'a', name: 'Apex', brand: 'Nike', model: 'A1' },
        ],
        error: null,
      },
    });
    const out = await new ProductGroupsService(sportsCtx(stub.client)).listForPicker();
    expect(out.truncated).toBe(false);
    expect(out.groups.map((g) => g.name)).toEqual(['Apex', 'Zephyr']);
  });

  it('reaches past the 200 `list()` clamp instead of silently stopping there', async () => {
    const stub = makeSupabaseStub({
      'product_groups.select': {
        data: Array.from({ length: 500 }, (_, i) => ({
          id: `g${i}`,
          name: `Group ${String(i).padStart(3, '0')}`,
          brand: null,
          model: null,
        })),
        error: null,
      },
    });
    const out = await new ProductGroupsService(sportsCtx(stub.client)).listForPicker();
    expect(out.groups).toHaveLength(500);
    expect(out.truncated).toBe(false);
  });

  it('never offers an ARCHIVED group as a link destination', async () => {
    const stub = filteringGroupStub([
      { id: 'g-active', name: 'Active group', brand: null, model: null, status: 'active' },
      { id: 'g-archived', name: 'Archived group', brand: null, model: null, status: 'archived' },
    ]);
    const out = await new ProductGroupsService(sportsCtx(stub.client)).listForPicker();
    expect(out.groups.map((g) => g.id)).toEqual(['g-active']);
  });

  it('DISCLOSES a real cap rather than presenting a prefix as the whole list', async () => {
    const stub = makeSupabaseStub({
      'product_groups.select': {
        data: Array.from({ length: 6 }, (_, i) => ({
          id: `g${i}`,
          name: `Group ${i}`,
          brand: null,
          model: null,
        })),
        error: null,
      },
    });
    const out = await new ProductGroupsService(sportsCtx(stub.client)).listForPicker(5);
    expect(out.groups).toHaveLength(5);
    expect(out.truncated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Archive / restore. The page had NO way to retire a group, so a leftover shell
// group was removed with hand-written SQL against production. The affordance is
// a SOFT, reversible status change — never a delete — and it refuses to hide a
// group whose sizes are still linked unless the operator says so explicitly.
// ---------------------------------------------------------------------------

describe('ProductGroupsService — an archived group is absent from the list that means "current"', () => {
  const ROWS = [
    groupRow({ id: 'grp-active', name: 'Active group' }),
    groupRow({ id: 'grp-archived', name: 'Archived group', status: 'archived' }),
  ];

  it('leaves an archived group out of the default list', async () => {
    const stub = filteringGroupStub(ROWS);
    const out = await new ProductGroupsService(sportsCtx(stub.client)).list();
    expect(out.map((g) => g.id)).toEqual(['grp-active']);
  });

  it('returns it ONLY when a caller explicitly asks for archived — the restore path', async () => {
    const stub = filteringGroupStub(ROWS);
    const out = await new ProductGroupsService(sportsCtx(stub.client)).list({
      status: 'archived',
    });
    expect(out.map((g) => g.id)).toEqual(['grp-archived']);
  });
});

describe('ProductGroupsService.archive', () => {
  beforeEach(() => vi.clearAllMocks());

  /** Stub for one archive: the group read, the variant count, the update. */
  function archiveStub(
    over: {
      group?: Record<string, unknown>;
      variantCount?: number | null;
      countError?: { message: string } | null;
      updated?: Array<Record<string, unknown>> | null;
    } = {},
  ) {
    return makeSupabaseStub({
      'product_groups.select': { data: [over.group ?? groupRow()], error: null },
      'inventory_items.select': {
        data: null,
        error: over.countError ?? null,
        count: over.variantCount === undefined ? 0 : over.variantCount,
      },
      'product_groups.update': {
        data: over.updated === undefined ? [groupRow({ status: 'archived' })] : over.updated,
        error: null,
      },
    });
  }

  it('REFUSES a group that still has variants linked, and names how many', async () => {
    const stub = archiveStub({ variantCount: 3 });
    const svc = new ProductGroupsService(sportsCtx(stub.client));

    const failure = await svc.archive('grp-1').then(
      () => null,
      (e: unknown) => e as { code?: string; message: string },
    );
    expect(failure?.code).toBe('validation_error');
    expect(failure?.message).toContain('3 variants');
    // The refusal must SAY the override exists — a dead end is what gets worked
    // around with hand-written SQL.
    expect(failure?.message).toContain('anyway');
    // Nothing was written, and nothing was recorded as though it had been.
    expect(stub.chains.has('product_groups.update')).toBe(false);
    expect(audit).not.toHaveBeenCalled();
  });

  it('counts in the singular for exactly one linked variant', async () => {
    const stub = archiveStub({ variantCount: 1 });
    const failure = await new ProductGroupsService(sportsCtx(stub.client)).archive('grp-1').then(
      () => null,
      (e: unknown) => e as { message: string },
    );
    expect(failure?.message).toContain('1 variant is');
    expect(failure?.message).not.toContain('1 variants');
  });

  it('counts LIVE, non-archived variants, scoped to this group by equality', async () => {
    const stub = archiveStub({ variantCount: 0 });
    await new ProductGroupsService(sportsCtx(stub.client)).archive('grp-1');

    const args = stub.chainArgs.get('inventory_items.select') ?? [];
    // status <> 'archived', not = 'active': a discontinued variant is still on
    // every screen that means current, so it still has to block.
    expect(stub.chains.get('inventory_items.select')).toContain('neq');
    expect(args).toContainEqual(['status', 'archived']);
    // A soft-deleted row is not a variant at all.
    expect(args).toContainEqual(['deleted_at', null]);
    // group_id is NULLABLE, so it is compared with `.eq` to one id — never with
    // `.in`/`not.in`, which silently drop NULL-column rows.
    expect(args).toContainEqual(['group_id', 'grp-1']);
    expect(args).toContainEqual(['organization_id', 'org-test']);
  });

  it('archives an EMPTY group with no acknowledgement, writing only status', async () => {
    const stub = archiveStub({ variantCount: 0 });
    const out = await new ProductGroupsService(sportsCtx(stub.client)).archive('grp-1');
    expect(out.status).toBe('archived');

    const patch = stub.chainArgs.get('product_groups.update')?.[0]?.[0] as Record<string, unknown>;
    expect(patch.status).toBe('archived');
    // NEVER a soft delete: every partial index on product_groups is
    // `where deleted_at is null`, uniqueness included, so writing deleted_at
    // would FREE the group_key and let a second group be created for an identity
    // that is only archived and still waiting to be restored.
    expect(patch).not.toHaveProperty('deleted_at');
    expect(patch).not.toHaveProperty('group_key');
    expect(patch).not.toHaveProperty('organization_id');
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'sports.group.archived',
        entityId: 'grp-1',
        extra: { acknowledged_active_variants: false },
      }),
      expect.anything(),
    );
  });

  it('lets an ACKNOWLEDGED archive through with variants still linked, and records that', async () => {
    const stub = archiveStub({ variantCount: 4 });
    const out = await new ProductGroupsService(sportsCtx(stub.client)).archive('grp-1', {
      acknowledgeActiveVariants: true,
    });
    expect(out.status).toBe('archived');

    const patch = stub.chainArgs.get('product_groups.update')?.[0]?.[0] as Record<string, unknown>;
    expect(patch.status).toBe('archived');
    expect(patch).not.toHaveProperty('deleted_at');
    // The variants KEEP their group_id: nothing here writes inventory_items, so
    // restoring the group brings the whole run back.
    expect(stub.chains.has('inventory_items.update')).toBe(false);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'sports.group.archived',
        extra: { acknowledged_active_variants: true },
      }),
      expect.anything(),
    );
  });

  it('does NOT fail open when the update matches no row (RLS hid it): no error, no row', async () => {
    const stub = archiveStub({ variantCount: 0, updated: null });
    await expect(
      new ProductGroupsService(sportsCtx(stub.client)).archive('grp-1'),
    ).rejects.toMatchObject({ code: 'not_found' });
    // An archive that did not happen is never recorded as though it had.
    expect(audit).not.toHaveBeenCalled();
  });

  it('is FAIL-CLOSED when the variant count cannot be read', async () => {
    const stub = archiveStub({ variantCount: 0, countError: { message: 'boom' } });
    await expect(
      new ProductGroupsService(sportsCtx(stub.client)).archive('grp-1'),
    ).rejects.toMatchObject({ code: 'internal_error' });
    expect(stub.chains.has('product_groups.update')).toBe(false);
  });

  it('is FAIL-CLOSED when the count comes back missing rather than zero', async () => {
    // No error and no count is not evidence of an empty group.
    const stub = archiveStub({ variantCount: null });
    await expect(
      new ProductGroupsService(sportsCtx(stub.client)).archive('grp-1'),
    ).rejects.toMatchObject({ code: 'internal_error' });
    expect(stub.chains.has('product_groups.update')).toBe(false);
  });

  it('is a no-op on an already-archived group: no write, no audit noise', async () => {
    const stub = archiveStub({ group: groupRow({ status: 'archived' }) });
    const out = await new ProductGroupsService(sportsCtx(stub.client)).archive('grp-1');
    expect(out.status).toBe('archived');
    expect(stub.chains.has('product_groups.update')).toBe(false);
    expect(audit).not.toHaveBeenCalled();
  });

  it('requires sports:manage — the permission every other group mutation takes', async () => {
    const stub = archiveStub();
    await expect(
      new ProductGroupsService(sportsCtx(stub.client, { role: 'staff' })).archive('grp-1'),
    ).rejects.toMatchObject({ code: 'forbidden' });
    // Refused BEFORE any query: a gate that still reads is not a gate.
    expect(stub.fromCalls).toEqual([]);
  });

  it('is refused with the sports module off, before any query', async () => {
    const stub = archiveStub();
    const svc = new ProductGroupsService(
      makeServiceContext(stub.client, { enabledModules: new Set<ModuleId>(['inventory']) }),
    );
    await expect(svc.archive('grp-1')).rejects.toMatchObject({ code: 'module_disabled' });
    expect(stub.fromCalls).toEqual([]);
  });
});

describe('ProductGroupsService.restore', () => {
  beforeEach(() => vi.clearAllMocks());

  function restoreStub(
    over: {
      group?: Record<string, unknown>;
      updated?: Array<Record<string, unknown>> | null;
    } = {},
  ) {
    return makeSupabaseStub({
      'product_groups.select': {
        data: [over.group ?? groupRow({ status: 'archived' })],
        error: null,
      },
      'product_groups.update': {
        data: over.updated === undefined ? [groupRow({ status: 'active' })] : over.updated,
        error: null,
      },
    });
  }

  it('puts an archived group back to active without touching anything else', async () => {
    const stub = restoreStub();
    const out = await new ProductGroupsService(sportsCtx(stub.client)).restore('grp-1');
    expect(out.status).toBe('active');

    const patch = stub.chainArgs.get('product_groups.update')?.[0]?.[0] as Record<string, unknown>;
    expect(patch.status).toBe('active');
    // Restore rebuilds nothing because archiving broke nothing: no variant
    // write, no key recompute, no deleted_at.
    expect(stub.chains.has('inventory_items.update')).toBe(false);
    expect(patch).not.toHaveProperty('group_key');
    expect(patch).not.toHaveProperty('deleted_at');
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'sports.group.restored', entityId: 'grp-1' }),
      expect.anything(),
    );
  });

  it('is also the way out of discontinued', async () => {
    const stub = restoreStub({ group: groupRow({ status: 'discontinued' }) });
    await new ProductGroupsService(sportsCtx(stub.client)).restore('grp-1');
    const patch = stub.chainArgs.get('product_groups.update')?.[0]?.[0] as Record<string, unknown>;
    expect(patch.status).toBe('active');
  });

  it('does NOT fail open when the update matches no row', async () => {
    const stub = restoreStub({ updated: null });
    await expect(
      new ProductGroupsService(sportsCtx(stub.client)).restore('grp-1'),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(audit).not.toHaveBeenCalled();
  });

  it('is a no-op on a group that is already active', async () => {
    const stub = restoreStub({ group: groupRow() });
    await new ProductGroupsService(sportsCtx(stub.client)).restore('grp-1');
    expect(stub.chains.has('product_groups.update')).toBe(false);
    expect(audit).not.toHaveBeenCalled();
  });

  it('requires sports:manage', async () => {
    const stub = restoreStub();
    await expect(
      new ProductGroupsService(sportsCtx(stub.client, { role: 'staff' })).restore('grp-1'),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(stub.fromCalls).toEqual([]);
  });
});

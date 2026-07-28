import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildVariantKey, type ModuleId } from '@stockpilot/core';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

import { ServiceError } from './context';
import { linkFamily, suggestFamilies, unlinkItems } from './product-group-linking';
import type { ProductGroupsService } from './product-groups';

const auditMock = vi.hoisted(() =>
  vi.fn(async (_payload: Record<string, unknown>, _ctx?: unknown) => {}),
);
vi.mock('./audit', () => ({ audit: auditMock }));

const SPORTS_MODULES = new Set<ModuleId>(['inventory', 'sports']);

function sportsCtx(client: unknown, over: Record<string, unknown> = {}) {
  return makeServiceContext(client, { enabledModules: SPORTS_MODULES, ...over });
}

/** A ProductGroupsService stand-in: only `get` / `findOrCreate` are reached. */
function groupsStub(over: Partial<Record<'get' | 'findOrCreate', unknown>> = {}) {
  return {
    get: vi.fn(async (id: string) => ({ id })),
    findOrCreate: vi.fn(async () => ({ group: { id: 'grp-new' }, created: true })),
    ...over,
  } as unknown as ProductGroupsService;
}

interface StubItemRow {
  id: string;
  name: string;
  sku: string;
  group_id: string | null;
  quantity_on_hand: number;
  variant_size: string | null;
  variant_size_original: string | null;
  variant_size_system: string | null;
  variant_width: string | null;
  variant_fit: string | null;
  variant_color: string | null;
  jersey_number: string | null;
  player_name: string | null;
  variant_key: string | null;
  category_id: string | null;
  warehouse_id: string | null;
  unit_of_measure: string | null;
  tracking_type: string;
}

function itemRow(over: Partial<StubItemRow> = {}): StubItemRow {
  return {
    id: 'item-1',
    name: 'L4L - Pink Shirt - L',
    sku: 'SP-PINK-L',
    group_id: null,
    quantity_on_hand: 6,
    variant_size: null,
    variant_size_original: null,
    variant_size_system: null,
    variant_width: null,
    variant_fit: null,
    variant_color: null,
    jersey_number: null,
    player_name: null,
    variant_key: null,
    category_id: 'cat-1',
    warehouse_id: 'wh-1',
    unit_of_measure: 'each',
    tracking_type: 'none',
    ...over,
  };
}

const THREE = [
  itemRow({ id: 'i-l', name: 'L4L - Pink Shirt - L', sku: 'SP-L' }),
  itemRow({ id: 'i-xl', name: 'L4L - Pink Shirt - XL', sku: 'SP-XL' }),
  itemRow({ id: 'i-2xl', name: 'L4L - Pink Shirt - 2XL', sku: 'SP-2XL' }),
];

const MEMBERS = [
  { itemId: 'i-l', variantSize: 'L', variantSizeOriginal: null, variantSizeSystem: null, jerseyNumber: null },
  { itemId: 'i-xl', variantSize: 'XL', variantSizeOriginal: null, variantSizeSystem: null, jerseyNumber: null },
  { itemId: 'i-2xl', variantSize: '2XL', variantSizeOriginal: null, variantSizeSystem: null, jerseyNumber: null },
];

beforeEach(() => vi.clearAllMocks());

describe('suggestFamilies — proposes, and writes nothing', () => {
  it('clusters ungrouped items on the same heuristic the lists render with', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': {
        data: [
          ...THREE,
          itemRow({ id: 'i-solo', name: 'Random Widget', sku: 'SP-W' }),
          itemRow({ id: 'i-lone', name: 'Solo Tee - XL', sku: 'SP-S' }),
        ],
        error: null,
      },
    });

    const out = await suggestFamilies({ supabase: stub.client, organizationId: 'org-test' });

    expect(out).toHaveLength(1);
    expect(out[0]!.baseName).toBe('L4L - Pink Shirt');
    expect(out[0]!.members.map((m) => m.id)).toEqual(['i-l', 'i-xl', 'i-2xl']);
    expect(out[0]!.members.map((m) => m.parsedSize)).toEqual(['L', 'XL', '2XL']);
  });

  it('reads ONLY ungrouped, non-deleted rows of the caller org', async () => {
    const stub = makeSupabaseStub({ 'inventory_items.select': { data: [], error: null } });
    await suggestFamilies({ supabase: stub.client, organizationId: 'org-test' });

    // Pair each chained method with its arguments so a null-valued `.is()`
    // filter is distinguishable from an absent one.
    const methods = stub.chains.get('inventory_items.select') ?? [];
    const args = stub.chainArgs.get('inventory_items.select') ?? [];
    const calls = methods.map((m, i) => [m, ...(args[i] ?? [])]);
    expect(calls).toContainEqual(['eq', 'organization_id', 'org-test']);
    expect(calls).toContainEqual(['is', 'group_id', null]);
    expect(calls).toContainEqual(['is', 'deleted_at', null]);
    expect(calls).toContainEqual(['eq', 'status', 'active']);
  });

  it('MUTATES NOTHING — no update, no insert, no rpc', async () => {
    const stub = makeSupabaseStub({ 'inventory_items.select': { data: THREE, error: null } });
    await suggestFamilies({ supabase: stub.client, organizationId: 'org-test' });

    expect(stub.chains.has('inventory_items.update')).toBe(false);
    expect(stub.chains.has('inventory_items.insert')).toBe(false);
    expect(stub.chains.has('product_groups.insert')).toBe(false);
    expect(stub.rpcCalls).toHaveLength(0);
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('labels every proposal as name-only, and discloses a split category', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': {
        data: [
          itemRow({ id: 'a', name: 'Tee - L', category_id: 'cat-1' }),
          itemRow({ id: 'b', name: 'Tee - XL', category_id: 'cat-2' }),
        ],
        error: null,
      },
    });
    const [family] = await suggestFamilies({ supabase: stub.client, organizationId: 'org-test' });
    expect(family!.caveats[0]).toMatch(/item name only/i);
    expect(family!.caveats.join(' ')).toMatch(/2 different categories/);
  });

  it('discloses two members that parsed to the SAME size', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': {
        data: [
          itemRow({ id: 'a', name: 'Tee - L', sku: 'A' }),
          itemRow({ id: 'b', name: 'Tee L', sku: 'B' }),
        ],
        error: null,
      },
    });
    const [family] = await suggestFamilies({ supabase: stub.client, organizationId: 'org-test' });
    expect(family!.caveats.join(' ')).toMatch(/same size \(L\)/);
  });
});

describe('linkFamily — writes only what a human named', () => {
  function linkStub(rows = THREE) {
    return makeSupabaseStub({
      'inventory_items.select': { data: rows, error: null },
      'inventory_items.update': { data: [{ id: 'ok' }], error: null },
    });
  }

  it('writes exactly three group_id values for three explicit item ids', async () => {
    const stub = linkStub();
    const out = await linkFamily(
      { groups: groupsStub(), supabase: stub.client, ctx: sportsCtx(stub.client) },
      { groupId: 'grp-1', members: MEMBERS, reason: 'Confirmed on the shelf' },
    );

    expect(out).toEqual({ groupId: 'grp-1', linked: 3 });
    const updates = stub.chainArgsAll.get('inventory_items.update') ?? [];
    expect(updates).toHaveLength(3);
    for (const chain of updates) {
      const patch = chain[0]![0] as Record<string, unknown>;
      expect(patch.group_id).toBe('grp-1');
    }
  });

  it('computes variant_key server-side from the confirmed attributes', async () => {
    const stub = linkStub();
    await linkFamily(
      { groups: groupsStub(), supabase: stub.client, ctx: sportsCtx(stub.client) },
      {
        groupId: 'grp-1',
        members: [
          {
            itemId: 'i-l',
            variantSize: ' xl ',
            variantSizeOriginal: 'Extra Large',
            variantSizeSystem: null,
            jerseyNumber: '#07',
          },
        ],
        reason: 'Confirmed',
      },
    );
    const patch = (stub.chainArgs.get('inventory_items.update') ?? [])[0]![0] as Record<
      string,
      unknown
    >;
    expect(patch.variant_size).toBe('XL');
    expect(patch.variant_size_original).toBe('Extra Large');
    // Leading zeroes survive: a jersey number is TEXT, never an integer.
    expect(patch.jersey_number).toBe('07');
    expect(patch.variant_key).toBe(buildVariantKey({ size: 'XL', jerseyNumber: '07' }));
  });

  it('NEVER touches quantity_on_hand and NEVER writes a stock_movements row', async () => {
    const stub = linkStub();
    await linkFamily(
      { groups: groupsStub(), supabase: stub.client, ctx: sportsCtx(stub.client) },
      { groupId: 'grp-1', members: MEMBERS, reason: 'Confirmed' },
    );

    for (const chain of stub.chainArgsAll.get('inventory_items.update') ?? []) {
      const patch = chain[0]![0] as Record<string, unknown>;
      expect(patch).not.toHaveProperty('quantity_on_hand');
    }
    expect(stub.fromCalls).not.toContain('stock_movements');
    expect(stub.fromCalls).not.toContain('item_stock_levels');
    expect(stub.rpcCalls).toHaveLength(0);
  });

  it('rejects an item that belongs to another org (the read finds it missing)', async () => {
    // Only two of the three ids come back scoped to the caller's org.
    const stub = linkStub([THREE[0]!, THREE[1]!]);
    await expect(
      linkFamily(
        { groups: groupsStub(), supabase: stub.client, ctx: sportsCtx(stub.client) },
        { groupId: 'grp-1', members: MEMBERS, reason: 'Confirmed' },
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(stub.chains.has('inventory_items.update')).toBe(false);
  });

  it('refuses an item already in a DIFFERENT group without force, and allows it with', async () => {
    const rows = [THREE[0]!, { ...THREE[1]!, group_id: 'grp-other' }, THREE[2]!];
    const refuse = linkStub(rows);
    await expect(
      linkFamily(
        { groups: groupsStub(), supabase: refuse.client, ctx: sportsCtx(refuse.client) },
        { groupId: 'grp-1', members: MEMBERS, reason: 'Confirmed' },
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(refuse.chains.has('inventory_items.update')).toBe(false);

    const forced = linkStub(rows);
    const out = await linkFamily(
      { groups: groupsStub(), supabase: forced.client, ctx: sportsCtx(forced.client) },
      { groupId: 'grp-1', members: MEMBERS, reason: 'Confirmed', force: true },
    );
    expect(out.linked).toBe(3);
  });

  it('allows a re-link of an item already in the DESTINATION group (a size correction)', async () => {
    const stub = linkStub(THREE.map((r) => ({ ...r, group_id: 'grp-1' })));
    const out = await linkFamily(
      { groups: groupsStub(), supabase: stub.client, ctx: sportsCtx(stub.client) },
      { groupId: 'grp-1', members: MEMBERS, reason: 'Fixed a size' },
    );
    expect(out.linked).toBe(3);
  });

  it('emits one audit event per item with the actor reason and before/after', async () => {
    const stub = linkStub();
    await linkFamily(
      { groups: groupsStub(), supabase: stub.client, ctx: sportsCtx(stub.client) },
      { groupId: 'grp-1', members: MEMBERS, reason: 'Walked the rack' },
    );
    expect(auditMock).toHaveBeenCalledTimes(3);
    const payload = auditMock.mock.calls[0]![0];
    expect(payload.event).toBe('sports.item.group_matched');
    expect(payload.entityId).toBe('i-l');
    expect(payload.reason).toBe('Walked the rack');
    expect((payload.before as Record<string, unknown>).group_id).toBeNull();
    expect((payload.after as Record<string, unknown>).group_id).toBe('grp-1');
  });

  it('requires a reason, a non-empty selection, and a destination', async () => {
    const stub = linkStub();
    const deps = { groups: groupsStub(), supabase: stub.client, ctx: sportsCtx(stub.client) };
    await expect(
      linkFamily(deps, { groupId: 'grp-1', members: MEMBERS, reason: '   ' }),
    ).rejects.toMatchObject({ code: 'validation_error' });
    await expect(
      linkFamily(deps, { groupId: 'grp-1', members: [], reason: 'ok' }),
    ).rejects.toMatchObject({ code: 'validation_error' });
    await expect(linkFamily(deps, { members: MEMBERS, reason: 'ok' })).rejects.toMatchObject({
      code: 'validation_error',
    });
    await expect(
      linkFamily(deps, {
        groupId: 'grp-1',
        members: [MEMBERS[0]!, MEMBERS[0]!],
        reason: 'ok',
      }),
    ).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('is gated on sports:manage and on the sports module', async () => {
    const stub = linkStub();
    await expect(
      linkFamily(
        {
          groups: groupsStub(),
          supabase: stub.client,
          ctx: sportsCtx(stub.client, { role: 'staff' }),
        },
        { groupId: 'grp-1', members: MEMBERS, reason: 'ok' },
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });

    const noModule = linkStub();
    await expect(
      linkFamily(
        {
          groups: groupsStub(),
          supabase: noModule.client,
          ctx: makeServiceContext(noModule.client, { enabledModules: new Set<ModuleId>(['inventory']) }),
        },
        { groupId: 'grp-1', members: MEMBERS, reason: 'ok' },
      ),
    ).rejects.toMatchObject({ code: 'module_disabled' });
  });

  it('creates a group only AFTER the item ownership check passes', async () => {
    const stub = linkStub([THREE[0]!]);
    const groups = groupsStub();
    await expect(
      linkFamily(
        { groups, supabase: stub.client, ctx: sportsCtx(stub.client) },
        {
          group: { subcategoryKey: 'sports_apparel', name: 'Pink Shirt', defaultCountingUnit: 'each' },
          members: MEMBERS,
          reason: 'ok',
        },
      ),
    ).rejects.toBeInstanceOf(ServiceError);
    expect(groups.findOrCreate).not.toHaveBeenCalled();
  });

  it('stops rather than reporting a link the database silently refused', async () => {
    // .update().eq() is fail-open under RLS: no error, no row.
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: THREE, error: null },
      'inventory_items.update': { data: [], error: null },
    });
    await expect(
      linkFamily(
        { groups: groupsStub(), supabase: stub.client, ctx: sportsCtx(stub.client) },
        { groupId: 'grp-1', members: MEMBERS, reason: 'ok' },
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
});

// Task 18 review fix: a variant key is what receiving, counting and PO
// matching resolve a size onto, and it carries NO uniqueness constraint. Two
// rows linked under one key are therefore a permanent ambiguity — the exact
// state `variantsByKey` refuses to pick a winner for. Catch it at the link.
describe('linkFamily — refuses a duplicate variant_key in the destination group', () => {
  /** First `inventory_items.select` = the link targets; second = the rows the
   *  destination group already holds under one of the computed keys. */
  function collisionStub(targets: StubItemRow[], existing: Array<Record<string, unknown>>) {
    let call = 0;
    return makeSupabaseStub({
      'inventory_items.select': () => {
        call += 1;
        return { data: call === 1 ? targets : existing, error: null };
      },
      'inventory_items.update': { data: [{ id: 'ok' }], error: null },
    });
  }

  const TWO_L = [
    itemRow({ id: 'i-l1', name: 'L4L - Pink Shirt - L', sku: 'SP-L1' }),
    itemRow({ id: 'i-l2', name: 'L4L - Pink Shirt - L (old)', sku: 'SP-L2' }),
  ];
  const BOTH_L = [
    { itemId: 'i-l1', variantSize: 'L', variantSizeOriginal: null, variantSizeSystem: null, jerseyNumber: null },
    { itemId: 'i-l2', variantSize: 'L', variantSizeOriginal: null, variantSizeSystem: null, jerseyNumber: null },
  ];

  it('refuses two rows in ONE batch that compute the same key from different SKUs', async () => {
    const stub = collisionStub(TWO_L, []);
    await expect(
      linkFamily(
        { groups: groupsStub(), supabase: stub.client, ctx: sportsCtx(stub.client) },
        { groupId: 'grp-1', members: BOTH_L, reason: 'Both look like the L' },
      ),
    ).rejects.toMatchObject({
      code: 'conflict',
      details: { code: 'VARIANT_ALREADY_EXISTS' },
    });
    // Nothing partial: the batch is refused BEFORE the first write.
    expect(stub.chains.has('inventory_items.update')).toBe(false);
  });

  it('refuses a row whose key already belongs to a DIFFERENT item in the group', async () => {
    const stub = collisionStub(
      [itemRow({ id: 'i-l1', sku: 'SP-L1' })],
      [{ id: 'i-existing', sku: 'SP-OLD-L', name: 'Pink Shirt L', variant_key: buildVariantKey({ size: 'L' }) }],
    );
    await expect(
      linkFamily(
        { groups: groupsStub(), supabase: stub.client, ctx: sportsCtx(stub.client) },
        { groupId: 'grp-1', members: [BOTH_L[0]!], reason: 'Adding the L' },
      ),
    ).rejects.toMatchObject({
      code: 'conflict',
      details: { code: 'VARIANT_ALREADY_EXISTS' },
    });
    expect(stub.chains.has('inventory_items.update')).toBe(false);
  });

  // MODEL B: (org, sku, charter, bin) uniqueness means the SAME sku legitimately
  // exists as several rows — one per placement. Those are the same variant in
  // two bins, not two variants claiming one identity.
  it('ALLOWS a same-SKU row already in the group (a second placement, not a collision)', async () => {
    const stub = collisionStub(
      [itemRow({ id: 'i-l1', sku: 'SP-L' })],
      [{ id: 'i-other-bin', sku: 'SP-L', name: 'Pink Shirt L', variant_key: buildVariantKey({ size: 'L' }) }],
    );
    const out = await linkFamily(
      { groups: groupsStub(), supabase: stub.client, ctx: sportsCtx(stub.client) },
      { groupId: 'grp-1', members: [BOTH_L[0]!], reason: 'Second bin' },
    );
    expect(out).toEqual({ groupId: 'grp-1', linked: 1 });
  });

  it('ALLOWS two batch rows sharing a SKU and a size (the same variant in two bins)', async () => {
    const stub = collisionStub(
      [
        itemRow({ id: 'i-l1', sku: 'SP-L' }),
        itemRow({ id: 'i-l2', sku: 'SP-L' }),
      ],
      [],
    );
    const out = await linkFamily(
      { groups: groupsStub(), supabase: stub.client, ctx: sportsCtx(stub.client) },
      { groupId: 'grp-1', members: BOTH_L, reason: 'One style, two bins' },
    );
    expect(out.linked).toBe(2);
  });

  it('does not count the item against ITSELF on a re-link', async () => {
    const stub = collisionStub(
      [itemRow({ id: 'i-l1', sku: 'SP-L1', group_id: 'grp-1', variant_key: buildVariantKey({ size: 'L' }) })],
      [{ id: 'i-l1', sku: 'SP-L1', name: 'Pink Shirt L', variant_key: buildVariantKey({ size: 'L' }) }],
    );
    const out = await linkFamily(
      { groups: groupsStub(), supabase: stub.client, ctx: sportsCtx(stub.client) },
      { groupId: 'grp-1', members: [BOTH_L[0]!], reason: 'Fixed the size system' },
    );
    expect(out.linked).toBe(1);
  });

  it('force does NOT wave a collision through — force is about moving groups', async () => {
    const stub = collisionStub(TWO_L, []);
    await expect(
      linkFamily(
        { groups: groupsStub(), supabase: stub.client, ctx: sportsCtx(stub.client) },
        { groupId: 'grp-1', members: BOTH_L, reason: 'Anyway', force: true },
      ),
    ).rejects.toMatchObject({ code: 'conflict', details: { code: 'VARIANT_ALREADY_EXISTS' } });
  });

  it('names the offending rows so the reviewer knows which two to fix', async () => {
    const stub = collisionStub(TWO_L, []);
    const error = await linkFamily(
      { groups: groupsStub(), supabase: stub.client, ctx: sportsCtx(stub.client) },
      { groupId: 'grp-1', members: BOTH_L, reason: 'Both look like the L' },
    ).catch((e: unknown) => e as ServiceError);
    expect((error as ServiceError).details?.itemIds).toEqual(['i-l1', 'i-l2']);
    expect((error as ServiceError).message).toContain('SP-L2');
  });
});

describe('unlinkItems — the undo', () => {
  it('restores group_id to null and clears the now-meaningless variant_key', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': {
        data: [{ id: 'i-l', group_id: 'grp-1', variant_key: 'size=L' }],
        error: null,
      },
      'inventory_items.update': { data: [{ id: 'i-l' }], error: null },
    });
    const out = await unlinkItems(
      { supabase: stub.client, ctx: sportsCtx(stub.client) },
      { itemIds: ['i-l'], reason: 'Wrong family' },
    );
    expect(out).toEqual({ unlinked: 1 });
    const patch = (stub.chainArgs.get('inventory_items.update') ?? [])[0]![0] as Record<
      string,
      unknown
    >;
    expect(patch.group_id).toBeNull();
    expect(patch.variant_key).toBeNull();
    // The observed size is data about the physical item — an undo of a
    // grouping must not delete it.
    expect(patch).not.toHaveProperty('variant_size');
    expect(patch).not.toHaveProperty('quantity_on_hand');
  });

  it('audits the unlink with before/after and the reason', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': {
        data: [{ id: 'i-l', group_id: 'grp-1', variant_key: 'size=L' }],
        error: null,
      },
      'inventory_items.update': { data: [{ id: 'i-l' }], error: null },
    });
    await unlinkItems(
      { supabase: stub.client, ctx: sportsCtx(stub.client) },
      { itemIds: ['i-l'], reason: 'Wrong family' },
    );
    const payload = auditMock.mock.calls[0]![0];
    expect(payload.event).toBe('sports.item.group_unlinked');
    expect(payload.reason).toBe('Wrong family');
    expect((payload.before as Record<string, unknown>).group_id).toBe('grp-1');
    expect((payload.after as Record<string, unknown>).group_id).toBeNull();
  });

  it('is a no-op (no write, no audit) for an item that was never grouped', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': {
        data: [{ id: 'i-l', group_id: null, variant_key: null }],
        error: null,
      },
    });
    const out = await unlinkItems(
      { supabase: stub.client, ctx: sportsCtx(stub.client) },
      { itemIds: ['i-l'], reason: 'ok' },
    );
    expect(out).toEqual({ unlinked: 0 });
    expect(stub.chains.has('inventory_items.update')).toBe(false);
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('rejects an item from another org and requires a reason', async () => {
    const stub = makeSupabaseStub({ 'inventory_items.select': { data: [], error: null } });
    const deps = { supabase: stub.client, ctx: sportsCtx(stub.client) };
    await expect(deps && unlinkItems(deps, { itemIds: ['nope'], reason: 'x' })).rejects.toMatchObject(
      { code: 'not_found' },
    );
    await expect(unlinkItems(deps, { itemIds: ['i-l'], reason: ' ' })).rejects.toMatchObject({
      code: 'validation_error',
    });
  });
});

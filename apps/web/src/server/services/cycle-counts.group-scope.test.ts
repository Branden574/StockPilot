import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_MODULE_IDS, type ModuleId } from '@stockpilot/core';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: vi.fn(async () => ({
    readableIds: ['wh-a'],
    writableIds: ['wh-a'],
    hasAllAccess: true,
    primaryWarehouseId: 'wh-a',
  })),
  assertWarehouseAccess: vi.fn(),
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

import { CycleCountsService } from './cycle-counts';

const withSports = new Set<ModuleId>([...DEFAULT_MODULE_IDS, 'sports']);

beforeEach(() => vi.clearAllMocks());

/**
 * Counting BY VARIANT under a group.
 *
 * The contract these tests pin down: a group scope EXPANDS to its variant
 * items and then runs the ordinary selection path. Nothing group-shaped ever
 * reaches the database — the `cycle_counts.scope` check constraint (0141) and
 * the atomic snapshot RPC (0226) still only know 'warehouse' and 'selection',
 * and the assignee lock, the post-time move guard and every other consumer
 * keep behaving exactly as they do for a hand-picked selection.
 */
describe('CycleCountsService.start (group scope)', () => {
  it('expands a group to one line per variant and snapshots them as a selection', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': {
        data: [
          { id: 'v-9', warehouse_id: 'wh-a' },
          { id: 'v-10', warehouse_id: 'wh-a' },
          { id: 'v-11', warehouse_id: 'wh-a' },
        ],
        error: null,
      },
      'rpc:start_cycle_count': {
        data: [{ cycle_count_id: 'cc-1', line_count: 3 }],
        error: null,
      },
    });
    const svc = new CycleCountsService(
      makeServiceContext(stub.client, { enabledModules: withSports }),
    );

    const result = await svc.start({
      scope: 'group',
      warehouseId: null,
      groupIds: ['grp-pegasus'],
    });

    expect(result).toEqual({ id: 'cc-1', lineCount: 3, skipped: 0 });

    // The RPC is called with the PERSISTED scope, never 'group'.
    const rpc = stub.rpcCalls.find((c) => c.name === 'start_cycle_count');
    const args = rpc?.args as { p_scope: string; p_item_ids: string[] | null };
    expect(args.p_scope).toBe('selection');
    // One id per variant — this is what "count by variant" means.
    expect(args.p_item_ids).toEqual(['v-9', 'v-10', 'v-11']);
  });

  it('resolves variants by group_id, org-scoped, active and not deleted', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: [{ id: 'v-9', warehouse_id: 'wh-a' }], error: null },
      'rpc:start_cycle_count': {
        data: [{ cycle_count_id: 'cc-2', line_count: 1 }],
        error: null,
      },
    });
    const svc = new CycleCountsService(
      makeServiceContext(stub.client, { enabledModules: withSports }),
    );
    await svc.start({ scope: 'group', warehouseId: null, groupIds: ['grp-a', 'grp-b'] });

    // The FIRST inventory_items query is the group expansion.
    const chains = stub.chainsAll.get('inventory_items.select') ?? [];
    const argsAll = stub.chainArgsAll.get('inventory_items.select') ?? [];
    expect(chains[0]).toContain('in');
    const expansionArgs = argsAll[0] ?? [];
    const flat = expansionArgs.flat();
    expect(flat).toContain('group_id');
    expect(flat).toContainEqual(['grp-a', 'grp-b']);
    // Archived / soft-deleted variants are never counted.
    expect(chains[0]).toContain('is');
    expect(flat).toContain('deleted_at');
    expect(flat).toContain('active');
  });

  it('counts hand-picked items alongside a group in one pass, de-duplicated', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': {
        data: [
          { id: 'v-9', warehouse_id: 'wh-a' },
          { id: 'extra-1', warehouse_id: 'wh-a' },
        ],
        error: null,
      },
      'rpc:start_cycle_count': {
        data: [{ cycle_count_id: 'cc-3', line_count: 2 }],
        error: null,
      },
    });
    const svc = new CycleCountsService(
      makeServiceContext(stub.client, { enabledModules: withSports }),
    );
    await svc.start({
      scope: 'group',
      warehouseId: null,
      groupIds: ['grp-a'],
      // 'v-9' is already a variant of the group — it must not be counted twice.
      itemIds: ['v-9', 'extra-1'],
    });
    const rpc = stub.rpcCalls.find((c) => c.name === 'start_cycle_count');
    const ids = (rpc?.args as { p_item_ids: string[] }).p_item_ids;
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('refuses a group scope with no groups', async () => {
    const stub = makeSupabaseStub({});
    const svc = new CycleCountsService(
      makeServiceContext(stub.client, { enabledModules: withSports }),
    );
    await expect(
      svc.start({ scope: 'group', warehouseId: null, groupIds: [] }),
    ).rejects.toMatchObject({ code: 'validation_error' });
    // Nothing was snapshotted.
    expect(stub.rpcCalls).toHaveLength(0);
  });

  it('refuses a group whose variants are all archived, rather than starting an empty count', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: [], error: null },
    });
    const svc = new CycleCountsService(
      makeServiceContext(stub.client, { enabledModules: withSports }),
    );
    await expect(
      svc.start({ scope: 'group', warehouseId: null, groupIds: ['grp-empty'] }),
    ).rejects.toMatchObject({ code: 'validation_error' });
    expect(stub.rpcCalls).toHaveLength(0);
  });

  it('is gated on the sports module', async () => {
    const stub = makeSupabaseStub({});
    const svc = new CycleCountsService(
      makeServiceContext(stub.client, {
        enabledModules: new Set<ModuleId>([...DEFAULT_MODULE_IDS]),
      }),
    );
    await expect(
      svc.start({ scope: 'group', warehouseId: null, groupIds: ['grp-a'] }),
    ).rejects.toMatchObject({ code: 'module_disabled' });
  });

  it('leaves the warehouse scope completely untouched', async () => {
    const stub = makeSupabaseStub({
      'rpc:start_cycle_count': {
        data: [{ cycle_count_id: 'cc-4', line_count: 40 }],
        error: null,
      },
    });
    const svc = new CycleCountsService(
      makeServiceContext(stub.client, { enabledModules: withSports }),
    );
    const res = await svc.start({ scope: 'warehouse', warehouseId: 'wh-a' });
    const rpc = stub.rpcCalls.find((c) => c.name === 'start_cycle_count');
    const args = rpc?.args as { p_scope: string; p_item_ids: string[] | null };
    expect(args.p_scope).toBe('warehouse');
    expect(args.p_item_ids).toBeNull();
    // A warehouse count never "skips" — the snapshot IS the scope.
    expect(res.skipped).toBe(0);
  });
});

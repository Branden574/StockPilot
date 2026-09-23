import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Cycle counts batch their id lists.
 *
 * A hand-picked count carries up to 1000 ids (a group expansion has no cap)
 * and a count page shows up to 200 lines. One `.in()` past ~215 uuids answers
 * 414 locally and fails as "fetch failed" in production after ~7 s of retries.
 */

const reportError = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/lib/error-reporter', () => ({ reportError }));
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

import { DEFAULT_MODULE_IDS, type ModuleId } from '@stockpilot/core';

import {
  inFilters,
  makeServiceContext,
  makeSupabaseStub,
  type MockCall,
} from '@/test/supabase-mock';

import { ServiceError } from './context';
import { CycleCountsService } from './cycle-counts';

const uuid = (i: number, p = '0') => `${p.repeat(8)}-0000-4000-8000-${String(i).padStart(12, '0')}`;
const ids = (n: number, p?: string) => Array.from({ length: n }, (_, i) => uuid(i, p));

function inList(call: MockCall, column: string): string[] | null {
  const hit = inFilters(call).find(([c]) => c === column);
  return hit ? (hit[1] as string[]) : null;
}

beforeEach(() => {
  reportError.mockClear();
});

describe('CycleCountsService.start with a large selection', () => {
  it('re-reads 250 picks in batches of at most 100 and starts the count with all of them', async () => {
    const lists: string[][] = [];
    const stub = makeSupabaseStub({
      'inventory_items.select': (call) => {
        const list = inList(call, 'id') ?? [];
        lists.push(list);
        return { data: list.map((id) => ({ id, warehouse_id: 'wh-a' })), error: null };
      },
      'rpc:start_cycle_count': { data: [{ cycle_count_id: 'cc-1', line_count: 250 }], error: null },
    });
    const svc = new CycleCountsService(makeServiceContext(stub.client));
    const res = await svc.start({ scope: 'selection', warehouseId: null, itemIds: ids(250) });
    expect(lists.map((l) => l.length)).toEqual([100, 100, 50]);
    expect(res.id).toBe('cc-1');
    const rpc = stub.rpcCalls.find((c) => c.name === 'start_cycle_count');
    expect((rpc?.args as { p_item_ids: string[] }).p_item_ids).toHaveLength(250);
  });

  it('fails with internal_error and starts nothing when a batch fails', async () => {
    let n = 0;
    const stub = makeSupabaseStub({
      'inventory_items.select': (call) => {
        n += 1;
        if (n === 2) return { data: null, error: { message: 'URI too long' } };
        return {
          data: (inList(call, 'id') ?? []).map((id) => ({ id, warehouse_id: 'wh-a' })),
          error: null,
        };
      },
    });
    const svc = new CycleCountsService(makeServiceContext(stub.client));
    const err = await svc
      .start({ scope: 'selection', warehouseId: null, itemIds: ids(250) })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe('internal_error');
    expect(stub.rpcCalls.find((c) => c.name === 'start_cycle_count')).toBeUndefined();
  });

  it('expands 150 product groups in batches of at most 100', async () => {
    const withSports = new Set<ModuleId>([...DEFAULT_MODULE_IDS, 'sports' as ModuleId]);
    const groupLists: string[][] = [];
    const stub = makeSupabaseStub({
      'inventory_items.select': (call) => {
        const groups = inList(call, 'group_id');
        if (groups) {
          groupLists.push(groups);
          return { data: groups.map((g) => ({ id: `v-${g}` })), error: null };
        }
        const list = inList(call, 'id') ?? [];
        return { data: list.map((id) => ({ id, warehouse_id: 'wh-a' })), error: null };
      },
      'rpc:start_cycle_count': { data: [{ cycle_count_id: 'cc-2', line_count: 150 }], error: null },
    });
    const svc = new CycleCountsService(
      makeServiceContext(stub.client, { enabledModules: withSports }),
    );
    await svc.start({ scope: 'group', warehouseId: null, groupIds: ids(150, 'g') });
    expect(groupLists.map((l) => l.length)).toEqual([100, 50]);
    const rpc = stub.rpcCalls.find((c) => c.name === 'start_cycle_count');
    expect((rpc?.args as { p_item_ids: string[] }).p_item_ids).toHaveLength(150);
  });
});

describe('CycleCountsService.getDetailPage variant read', () => {
  it('reads the variant columns for a 200-line page in two batches', async () => {
    const lines = ids(200).map((item_id, i) => ({
      id: `line-${i}`,
      cycle_count_id: 'cc-1',
      item_id,
      warehouse_id: 'wh-a',
      expected_quantity: 1,
      counted_quantity: null,
      full_count: 200,
    }));
    const lists: string[][] = [];
    const stub = makeSupabaseStub({
      'cycle_counts.select': {
        data: [{ id: 'cc-1', status: 'in_progress', warehouse_id: null }],
        error: null,
      },
      'rpc:cycle_count_lines_page': { data: lines, error: null },
      'rpc:cycle_count_summary': { data: [], error: null },
      'inventory_items.select': (call) => {
        const list = inList(call, 'id') ?? [];
        lists.push(list);
        return {
          data: list.map((id) => ({ id, group_id: 'grp', variant_size: 'M', jersey_number: null })),
          error: null,
        };
      },
    });
    const svc = new CycleCountsService(makeServiceContext(stub.client));
    const page = await svc.getDetailPage('cc-1', { pageSize: 200 });
    expect(lists.map((l) => l.length)).toEqual([100, 100]);
    expect(page.lines.at(-1)?.item?.variant_size).toBe('M');
  });
});

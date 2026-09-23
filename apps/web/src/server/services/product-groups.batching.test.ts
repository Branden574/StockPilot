import { describe, expect, it, vi } from 'vitest';

/**
 * Product-group reads batch their group ids.
 *
 * A list page hands over every group it shows and the PO pages up to ~1000.
 * One `.in()` past ~215 uuids answers 414 locally and fails as "fetch failed"
 * in production after ~7 s of retries. Every batch is also paged past
 * PostgREST's 1000-row cap, and a failed batch throws.
 */

vi.mock('./audit', () => ({ audit: vi.fn(async () => {}) }));

import type { ModuleId } from '@stockpilot/core';

import {
  inFilters,
  makeServiceContext,
  makeSupabaseStub,
  type MockCall,
} from '@/test/supabase-mock';

import { ProductGroupsService } from './product-groups';

const uuid = (i: number, p = '0') => `${p.repeat(8)}-0000-4000-8000-${String(i).padStart(12, '0')}`;
const ctxFor = (client: unknown) =>
  makeServiceContext(client, { enabledModules: new Set<ModuleId>(['inventory', 'sports']) });

function inList(call: MockCall, column: string): string[] {
  return (inFilters(call).find(([c]) => c === column)?.[1] ?? []) as string[];
}

describe('ProductGroupsService batched reads', () => {
  it('rollups() reads 250 groups in batches of at most 100', async () => {
    const lists: string[][] = [];
    const stub = makeSupabaseStub({
      'product_group_rollups.select': (call) => {
        const list = inList(call, 'group_id');
        lists.push(list);
        return {
          data: list.map((group_id) => ({
            group_id,
            variant_count: 3,
            total_quantity: 9,
            counting_unit: 'each',
          })),
          error: null,
        };
      },
    });
    const ids = Array.from({ length: 250 }, (_, i) => uuid(i, 'g'));
    const out = await new ProductGroupsService(ctxFor(stub.client)).rollups(ids);
    expect(lists.map((l) => l.length)).toEqual([100, 100, 50]);
    expect(out.get(uuid(249, 'g'))?.variantCount).toBe(3);
  });

  it('rollups() throws when a batch fails', async () => {
    let n = 0;
    const stub = makeSupabaseStub({
      'product_group_rollups.select': () => {
        n += 1;
        return n === 2 ? { data: null, error: { message: 'boom' } } : { data: [], error: null };
      },
    });
    const ids = Array.from({ length: 250 }, (_, i) => uuid(i, 'g'));
    await expect(new ProductGroupsService(ctxFor(stub.client)).rollups(ids)).rejects.toMatchObject({
      code: 'internal_error',
    });
  });

  it('displayByIds() reads 150 distinct size scales in batches and keeps each scale whole', async () => {
    const groupIds = Array.from({ length: 150 }, (_, i) => uuid(i, 'g'));
    const scaleLists: string[][] = [];
    const stub = makeSupabaseStub({
      'product_groups.select': (call) => ({
        data: inList(call, 'id').map((id) => ({
          id,
          name: `Group ${id.slice(-3)}`,
          default_counting_unit: 'each',
          size_scale_id: uuid(Number(id.slice(-12)), 's'),
        })),
        error: null,
      }),
      'size_scale_values.select': (call) => {
        const list = inList(call, 'size_scale_id');
        scaleLists.push(list);
        return {
          data: list.flatMap((size_scale_id) => [
            { size_scale_id, value: 'S', normalized: 'S', sort_order: 1 },
            { size_scale_id, value: 'M', normalized: 'M', sort_order: 2 },
          ]),
          error: null,
        };
      },
    });
    const out = await new ProductGroupsService(ctxFor(stub.client)).displayByIds(groupIds);
    expect(scaleLists.map((l) => l.length)).toEqual([100, 50]);
    expect(out.size).toBe(150);
    expect(out.get(uuid(149, 'g'))?.sizeOrder).toBeTruthy();
  });

  it('variantsByGroupIds() reads 250 groups in batches of at most 100', async () => {
    const lists: string[][] = [];
    const stub = makeSupabaseStub({
      'inventory_items.select': (call) => {
        const list = inList(call, 'group_id');
        lists.push(list);
        return {
          data: list.map((group_id) => ({ id: `v-${group_id}`, sku: 'S', group_id })),
          error: null,
        };
      },
    });
    const ids = Array.from({ length: 250 }, (_, i) => uuid(i, 'g'));
    const out = await new ProductGroupsService(ctxFor(stub.client)).variantsByGroupIds(ids);
    expect(lists.map((l) => l.length)).toEqual([100, 100, 50]);
    expect(out.get(uuid(249, 'g'))).toHaveLength(1);
  });
});

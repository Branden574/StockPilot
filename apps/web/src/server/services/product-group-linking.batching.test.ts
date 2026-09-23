import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Family linking and the PO-import line reads batch their id lists.
 *
 * linkFamily/unlinkItems take up to 200 items, and the PO-import line tools up
 * to 200 line ids. 200 uuids in one `.in()` plus the rest of the URL passes
 * the local gateway's ~8 KB limit, and a variant key (~55 characters) costs
 * more than a uuid. A failed batch throws: these reads decide what may be
 * written, and an item must never read as "not in this organization" because
 * its read failed.
 */

vi.mock('./audit', () => ({ audit: vi.fn(async () => {}) }));

import type { ModuleId } from '@stockpilot/core';

import { encodedInValueLength, IN_FILTER_MAX_ENCODED_CHARS } from '@/lib/supabase/in-filter';
import {
  inFilters,
  makeServiceContext,
  makeSupabaseStub,
  type MockCall,
} from '@/test/supabase-mock';

import { findDuplicatesForPoLines } from './po-imports-lines';
import { linkFamily, unlinkItems } from './product-group-linking';
import type { ProductGroupsService } from './product-groups';

const uuid = (i: number, p = '0') => `${p.repeat(8)}-0000-4000-8000-${String(i).padStart(12, '0')}`;
const SPORTS = new Set<ModuleId>(['inventory', 'sports']);
const groups = {
  get: vi.fn(async (id: string) => ({ id })),
  findOrCreate: vi.fn(),
} as unknown as ProductGroupsService;

function inList(call: MockCall, column: string): string[] | null {
  const hit = inFilters(call).find(([c]) => c === column);
  return hit ? (hit[1] as string[]) : null;
}

function itemRow(id: string, i: number) {
  return {
    id,
    name: `Jersey ${i}`,
    sku: `J-${i}`,
    group_id: null,
    quantity_on_hand: 1,
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
  };
}

beforeEach(() => vi.clearAllMocks());

describe('linkFamily with 150 members', () => {
  const ids = Array.from({ length: 150 }, (_, i) => uuid(i));
  const members = ids.map((itemId, i) => ({
    itemId,
    variantSize: 'L',
    variantSizeOriginal: null,
    variantSizeSystem: null,
    jerseyNumber: String(i + 1),
  }));

  it('reads the targets and probes the variant keys in batches within the URL budget', async () => {
    const idLists: string[][] = [];
    const keyLists: string[][] = [];
    const stub = makeSupabaseStub({
      'inventory_items.select': (call) => {
        const byId = inList(call, 'id');
        if (byId) {
          idLists.push(byId);
          return { data: byId.map((id) => itemRow(id, ids.indexOf(id))), error: null };
        }
        keyLists.push(inList(call, 'variant_key') ?? []);
        return { data: [], error: null };
      },
      'inventory_items.update': { data: [{ id: 'ok' }], error: null },
    });
    const out = await linkFamily(
      {
        groups,
        supabase: stub.client,
        ctx: makeServiceContext(stub.client, { enabledModules: SPORTS }),
      },
      { groupId: 'grp-1', members, reason: 'Confirmed on the shelf' },
    );
    expect(out.linked).toBe(150);
    expect(idLists.map((l) => l.length)).toEqual([100, 50]);
    expect(keyLists.flat()).toHaveLength(150);
    for (const l of keyLists) {
      expect(l.reduce((n, v) => n + encodedInValueLength(v) + 3, 0)).toBeLessThanOrEqual(
        IN_FILTER_MAX_ENCODED_CHARS,
      );
    }
  });

  it('throws internal_error and writes nothing when a target batch fails', async () => {
    let n = 0;
    const stub = makeSupabaseStub({
      'inventory_items.select': (call) => {
        n += 1;
        if (n === 2) return { data: null, error: { message: 'URI too long' } };
        const byId = inList(call, 'id') ?? [];
        return { data: byId.map((id) => itemRow(id, 0)), error: null };
      },
    });
    await expect(
      linkFamily(
        {
          groups,
          supabase: stub.client,
          ctx: makeServiceContext(stub.client, { enabledModules: SPORTS }),
        },
        { groupId: 'grp-1', members, reason: 'Confirmed' },
      ),
    ).rejects.toMatchObject({ code: 'internal_error' });
    expect(stub.chainsAll.get('inventory_items.update')).toBeUndefined();
  });
});

describe('unlinkItems with 150 items', () => {
  it('reads the targets in batches of at most 100', async () => {
    const ids = Array.from({ length: 150 }, (_, i) => uuid(i, 'u'));
    const lists: string[][] = [];
    const stub = makeSupabaseStub({
      'inventory_items.select': (call) => {
        const byId = inList(call, 'id') ?? [];
        lists.push(byId);
        return {
          data: byId.map((id) => ({ id, group_id: 'grp-1', variant_key: `k-${id}` })),
          error: null,
        };
      },
      'inventory_items.update': { data: [{ id: 'ok' }], error: null },
    });
    const out = await unlinkItems(
      { supabase: stub.client, ctx: makeServiceContext(stub.client, { enabledModules: SPORTS }) },
      { itemIds: ids, reason: 'Wrong family' },
    );
    expect(lists.map((l) => l.length)).toEqual([100, 50]);
    expect(out.unlinked).toBe(150);
  });
});

describe('findDuplicatesForPoLines with 200 line ids', () => {
  it('reads the lines in batches of at most 100', async () => {
    const lineIds = Array.from({ length: 200 }, (_, i) => uuid(i, 'l'));
    const lists: string[][] = [];
    const stub = makeSupabaseStub({
      'po_imports.select': { data: { id: 'imp-1' }, error: null },
      'po_import_lines.select': (call) => {
        const list = inList(call, 'id') ?? [];
        lists.push(list);
        return {
          data: list.map((id) => ({
            id,
            description: null,
            vendor_item_number: `V-${id}`,
            vendor_product_number: null,
            auxiliary_number: null,
          })),
          error: null,
        };
      },
      'inventory_items.select': {
        data: [{ id: 'dup', name: 'Dup', sku: 'D', barcode: 'x', quantity_on_hand: 1 }],
        error: null,
      },
    });
    const out = await findDuplicatesForPoLines(
      { supabase: stub.client, organizationId: 'org-test' },
      { poImportId: 'imp-1', lineIds },
    );
    expect(lists.map((l) => l.length)).toEqual([100, 100]);
    expect(Object.keys(out.matches)).toHaveLength(200);
  });
});

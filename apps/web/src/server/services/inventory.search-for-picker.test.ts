import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub, type MockCall } from '@/test/supabase-mock';

/**
 * InventoryService.searchForPicker: the relevance search behind
 * /api/items/search?rank=relevance (the bundle component picker).
 *
 * Pinned here: what it may return (the same scope as list(), plus the
 * exclusions a caller asks for), the order it returns it in, and how many
 * requests one search costs.
 */

const h = vi.hoisted(() => ({
  access: {
    hasAllAccess: true,
    readableIds: ['wh-1'],
    writableIds: ['wh-1'],
    primaryWarehouseId: 'wh-1',
  } as {
    hasAllAccess: boolean;
    readableIds: string[];
    writableIds: string[];
    primaryWarehouseId: string | null;
  },
  timeline: [] as string[],
}));

vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: vi.fn(async () => {
    h.timeline.push('warehouse access');
    return h.access;
  }),
  // The real rule (warehouse.ts): the role alone decides for manager and up.
  roleSeesEveryWarehouse: (role: string) => ['owner', 'admin', 'manager'].includes(role),
  forcedWarehouseId: vi.fn(async () => null),
  assertWarehouseAccess: vi.fn(async () => undefined),
  ForbiddenError: class extends Error {},
}));

import { getWarehouseAccess } from '@/lib/auth/warehouse';

import { InventoryService } from './inventory';
import { UserCategoriesService } from './user-categories';

type Row = Record<string, unknown>;

function row(id: string, name: string, sku: string, over: Row = {}): Row {
  return {
    id,
    name,
    sku,
    barcode: null,
    model_number: null,
    item_type: 'product',
    quantity_on_hand: 5,
    awaiting_first_receipt: false,
    category_id: null,
    warehouse: { name: 'DC4' },
    ...over,
  };
}

function isExactLookup(call: MockCall): boolean {
  return call.methods.some(
    (m, i) => m === 'or' && String(call.args[i]?.[0]).startsWith('sku.in.('),
  );
}

/** A client whose matches query answers `matches` (with `count`) and whose
 *  exact lookup answers `exact`. Every answer is logged on the timeline. */
function stubFor(opts: {
  matches: Row[];
  exact?: Row[];
  count?: number;
  fail?: 'matches' | 'exact';
}) {
  const stub = makeSupabaseStub({
    'inventory_items.select': (call) => {
      const exact = isExactLookup(call);
      h.timeline.push(exact ? 'exact lookup' : 'matches');
      if (opts.fail === (exact ? 'exact' : 'matches')) {
        return { data: null, error: { message: 'boom' } };
      }
      return exact
        ? { data: opts.exact ?? [], error: null }
        : { data: opts.matches, error: null, count: opts.count ?? opts.matches.length };
    },
  });
  return stub;
}

function svc(stub: ReturnType<typeof makeSupabaseStub>, role = 'manager') {
  return new InventoryService({
    supabase: stub.client,
    organizationId: 'org-1',
    userId: 'u-1',
    role,
  } as never);
}

/** [method, args] pairs of the Nth inventory_items query. */
function chainOf(stub: ReturnType<typeof makeSupabaseStub>, n: number): Array<[string, unknown[]]> {
  const methods = stub.chainsAll.get('inventory_items.select')?.[n] ?? [];
  const args = stub.chainArgsAll.get('inventory_items.select')?.[n] ?? [];
  return methods.map((m, i) => [m, args[i] ?? []]);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.timeline.length = 0;
  h.access = {
    hasAllAccess: true,
    readableIds: ['wh-1'],
    writableIds: ['wh-1'],
    primaryWarehouseId: 'wh-1',
  };
});

describe('searchForPicker: what it may return', () => {
  it('scopes both requests like list(): organization, not deleted, active, received, no rentals, and the asked exclusions', async () => {
    const stub = stubFor({ matches: [] });
    await svc(stub).searchForPicker({
      q: 'pen',
      itemType: 'all',
      excludeBundles: true,
      status: 'active',
    });
    for (const n of [0, 1]) {
      const chain = chainOf(stub, n);
      expect(chain).toContainEqual(['eq', ['organization_id', 'org-1']]);
      expect(chain).toContainEqual(['is', ['deleted_at', null]]);
      expect(chain).toContainEqual(['eq', ['status', 'active']]);
      expect(chain).toContainEqual(['eq', ['awaiting_first_receipt', false]]);
      expect(chain).toContainEqual(['eq', ['is_rental', false]]);
      // A kit's pre-assembled stock: list()'s exact exclusion clause.
      expect(chain).toContainEqual(['or', ['is_bundle.is.null,is_bundle.eq.false']]);
      // type=all: no item_type predicate at all.
      expect(chain.some(([m, a]) => (m === 'eq' || m === 'in') && a[0] === 'item_type')).toBe(
        false,
      );
    }
  });

  it("expected: 'any' drops the awaiting-first-receipt predicate; the default item type is product", async () => {
    const stub = stubFor({ matches: [] });
    await svc(stub).searchForPicker({ q: 'pen', expected: 'any' });
    const chain = chainOf(stub, 0);
    expect(chain.some(([m, a]) => m === 'eq' && a[0] === 'awaiting_first_receipt')).toBe(false);
    expect(chain).toContainEqual(['eq', ['item_type', 'product']]);
    // Without excludeBundles, no kit clause (list()'s opt-in).
    expect(chain.some(([m, a]) => m === 'or' && String(a[0]).includes('is_bundle'))).toBe(false);
  });

  it('a staff member is held to their warehouses on BOTH requests, so the exact lookup cannot widen it', async () => {
    h.access = {
      hasAllAccess: false,
      readableIds: ['wh-7'],
      writableIds: ['wh-7'],
      primaryWarehouseId: 'wh-7',
    };
    const stub = stubFor({ matches: [] });
    await svc(stub, 'staff').searchForPicker({ q: 'pen' });
    expect(chainOf(stub, 0)).toContainEqual(['in', ['warehouse_id', ['wh-7']]]);
    expect(chainOf(stub, 1)).toContainEqual(['in', ['warehouse_id', ['wh-7']]]);
  });

  it('a staff member with no warehouses gets nothing and no item query is made', async () => {
    h.access = { hasAllAccess: false, readableIds: [], writableIds: [], primaryWarehouseId: null };
    const stub = stubFor({ matches: [row('a', 'Pen', 'P')] });
    const result = await svc(stub, 'staff').searchForPicker({ q: 'pen' });
    expect(result).toEqual({ items: [], total: 0 });
    expect(stub.fromCalls).toEqual([]);
  });

  it('a viewer is held to their granted categories on both requests', async () => {
    const grants = vi
      .spyOn(UserCategoriesService.prototype, 'getGrantedCategoryIdsForViewer')
      .mockResolvedValue(new Set(['cat-1']));
    const stub = stubFor({ matches: [] });
    await svc(stub, 'viewer').searchForPicker({ q: 'pen' });
    expect(chainOf(stub, 0)).toContainEqual(['in', ['category_id', ['cat-1']]]);
    expect(chainOf(stub, 1)).toContainEqual(['in', ['category_id', ['cat-1']]]);
    grants.mockRestore();
  });

  it('a viewer with no granted categories gets nothing and no item query is made', async () => {
    const grants = vi
      .spyOn(UserCategoriesService.prototype, 'getGrantedCategoryIdsForViewer')
      .mockResolvedValue(new Set());
    const stub = stubFor({ matches: [row('a', 'Pen', 'P')] });
    expect(await svc(stub, 'viewer').searchForPicker({ q: 'pen' })).toEqual({
      items: [],
      total: 0,
    });
    expect(stub.fromCalls).toEqual([]);
    grants.mockRestore();
  });

  it('a manager may narrow to one warehouse', async () => {
    const stub = stubFor({ matches: [] });
    await svc(stub).searchForPicker({ q: 'pen', warehouseId: 'wh-2' });
    expect(chainOf(stub, 0)).toContainEqual(['eq', ['warehouse_id', 'wh-2']]);
  });

  it('under two characters there is no request', async () => {
    const stub = stubFor({ matches: [] });
    expect(await svc(stub).searchForPicker({ q: ' p ' })).toEqual({ items: [], total: 0 });
    expect(stub.fromCalls).toEqual([]);
  });

  it('a request that fails is an error, never an empty result', async () => {
    await expect(
      svc(stubFor({ matches: [], fail: 'matches' })).searchForPicker({ q: 'pen' }),
    ).rejects.toThrow();
    await expect(
      svc(stubFor({ matches: [], fail: 'exact' })).searchForPicker({ q: 'pen' }),
    ).rejects.toThrow();
  });
});

describe('searchForPicker: matching', () => {
  it("one word is exactly list()'s clause, and the exact lookup asks for the code in each case", async () => {
    const stub = stubFor({ matches: [] });
    await svc(stub).searchForPicker({ q: 'kit-1' });
    const chain = chainOf(stub, 0);
    expect(chain).toContainEqual([
      'or',
      ['name.ilike.%kit-1%,sku.ilike.%kit-1%,barcode.ilike.%kit-1%,model_number.ilike.%kit-1%'],
    ]);
    expect(chainOf(stub, 1)).toContainEqual([
      'or',
      ['sku.in.("kit-1","KIT-1"),barcode.in.("kit-1","KIT-1")'],
    ]);
  });

  it('each word must match (one clause per word, ANDed), and a phrase search makes no exact lookup', async () => {
    const stub = stubFor({ matches: [] });
    await svc(stub).searchForPicker({ q: '  red   pen ' });
    const ors = chainOf(stub, 0)
      .filter(([m]) => m === 'or')
      .map(([, a]) => a[0]);
    expect(ors).toEqual([
      'name.ilike.%red%,sku.ilike.%red%,barcode.ilike.%red%,model_number.ilike.%red%',
      'name.ilike.%pen%,sku.ilike.%pen%,barcode.ilike.%pen%,model_number.ilike.%pen%',
    ]);
    expect(stub.fromCalls).toEqual(['inventory_items']);
  });

  it('commas and parentheses cannot escape a clause', async () => {
    const stub = stubFor({ matches: [] });
    await svc(stub).searchForPicker({ q: 'ab),sku.eq.x' });
    const ors = chainOf(stub, 0)
      .filter(([m]) => m === 'or')
      .map(([, a]) => String(a[0]));
    expect(ors).toEqual([
      'name.ilike.%ab%,sku.ilike.%ab%,barcode.ilike.%ab%,model_number.ilike.%ab%',
      'name.ilike.%sku.eq.x%,sku.ilike.%sku.eq.x%,barcode.ilike.%sku.eq.x%,model_number.ilike.%sku.eq.x%',
    ]);
  });

  it('a double quote or backslash never reaches a quoted exact value', async () => {
    const stub = stubFor({ matches: [] });
    await svc(stub).searchForPicker({ q: 'ab"c\\d' });
    expect(chainOf(stub, 1)).toContainEqual([
      'or',
      ['sku.in.("abcd","ABCD"),barcode.in.("abcd","ABCD")'],
    ]);
  });

  it('a typed ISBN finds the book stored under its other form, as an exact match', async () => {
    const book = row('b', "Charlotte's Web", 'BK-1', { barcode: '014240733X', item_type: 'book' });
    const stub = stubFor({ matches: [book], exact: [book] });
    const result = await svc(stub).searchForPicker({
      q: '9780142407332',
      itemType: 'all',
      isbnVariants: ['9780142407332', '014240733X'],
    });
    expect(String(chainOf(stub, 0).find(([m]) => m === 'or')?.[1][0])).toContain(
      'barcode.in.("9780142407332","014240733X")',
    );
    expect(result.items[0]).toMatchObject({ id: 'b', match: 'exact' });
  });
});

describe('searchForPicker: order', () => {
  it('exact SKU first, then name/SKU prefix, then a word in the name, then anything containing it, then word-by-word', async () => {
    const matches = [
      // The server returns name order; ranking is ours.
      row('1', 'Blue Pen', 'B-1'),
      row('2', 'Open-ended notebook', 'N-1'),
      row('3', 'Pencil', 'W-1'),
      row('4', 'Zebra marker', 'PEN'),
    ];
    const stub = stubFor({ matches });
    const result = await svc(stub).searchForPicker({ q: 'pen' });
    expect(result.items.map((i) => [i.id, i.match])).toEqual([
      ['4', 'exact'],
      ['3', 'prefix'],
      ['1', 'word'],
      ['2', 'contains'],
    ]);
  });

  it('the exact item is first even when it lies outside the matches the window read', async () => {
    // 200 name-ordered matches came back and the item whose SKU was typed is
    // not among them; the exact lookup still brings it, first.
    const window = Array.from({ length: 200 }, (_, i) =>
      row(`m${i}`, `Aardvark ${i} 10`, `A-${i}`),
    );
    const target = row('t', 'Zinc washer', '10');
    const stub = stubFor({ matches: window, exact: [target], count: 640 });
    const result = await svc(stub).searchForPicker({ q: '10' });
    expect(result.items[0]).toMatchObject({ id: 't', match: 'exact' });
    expect(result.items).toHaveLength(20);
    expect(result.total).toBe(640);
  });

  it('returns the picker shape, capped at limit', async () => {
    const matches = Array.from({ length: 30 }, (_, i) =>
      row(`r${i}`, `Pen ${i}`, `P-${i}`, {
        quantity_on_hand: '2.5000',
        awaiting_first_receipt: i === 0,
      }),
    );
    const stub = stubFor({ matches, count: 30 });
    const result = await svc(stub).searchForPicker({ q: 'pen', limit: 5 });
    expect(result.total).toBe(30);
    expect(result.items).toHaveLength(5);
    expect(result.items[0]).toEqual({
      id: 'r0',
      sku: 'P-0',
      name: 'Pen 0',
      barcode: null,
      item_type: 'product',
      quantity_on_hand: 2.5,
      awaiting_first_receipt: true,
      warehouse_name: 'DC4',
      match: 'prefix',
    });
  });
});

describe('searchForPicker: round trips', () => {
  it('a manager: no warehouse read, and both item requests go out together (one level, two requests)', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': (call) => {
        // By the time the first answer is read, BOTH requests were already made.
        h.timeline.push(`answer with ${stub.fromCalls.length} requests made`);
        return isExactLookup(call)
          ? { data: [], error: null }
          : { data: [], error: null, count: 0 };
      },
    });
    await svc(stub, 'manager').searchForPicker({ q: 'pencil' });
    expect(getWarehouseAccess).not.toHaveBeenCalled();
    expect(stub.fromCalls).toEqual(['inventory_items', 'inventory_items']);
    expect(stub.rpcCalls).toEqual([]);
    expect(h.timeline[0]).toBe('answer with 2 requests made');
  });

  it('a staff member: the warehouse read, then the item requests (two levels)', async () => {
    h.access = {
      hasAllAccess: false,
      readableIds: ['wh-1'],
      writableIds: ['wh-1'],
      primaryWarehouseId: 'wh-1',
    };
    const stub = stubFor({ matches: [] });
    await svc(stub, 'staff').searchForPicker({ q: 'pencil' });
    expect(h.timeline).toEqual(['warehouse access', 'matches', 'exact lookup']);
  });

  it('no holdings, images, value sum or count-only query: nothing but inventory_items', async () => {
    const stub = stubFor({ matches: [row('a', 'Pencil', 'P-1')] });
    await svc(stub).searchForPicker({ q: 'pencil' });
    expect(new Set(stub.fromCalls)).toEqual(new Set(['inventory_items']));
    // The matches query counts; the exact lookup does not.
    expect(chainOf(stub, 0)[0]).toEqual(['select', [expect.any(String), { count: 'exact' }]]);
    expect(chainOf(stub, 1)[0]).toEqual(['select', [expect.any(String), undefined]]);
  });
});

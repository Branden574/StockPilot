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
    unreadable?: true;
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

type ReadKind = 'matches' | 'exact' | 'prefix' | 'word';

/** Which of searchForPicker's reads a chain is: the exact SKU/barcode lookup,
 *  the name/SKU prefix read, the word-in-the-name read, or the matches. */
function kindOf(call: MockCall): ReadKind {
  if (isExactLookup(call)) return 'exact';
  if (call.methods.includes('ilike')) return 'word';
  if (
    call.methods.some(
      (m, i) => m === 'or' && /^name\.ilike\.[^%]/.test(String(call.args[i]?.[0])),
    )
  ) {
    return 'prefix';
  }
  return 'matches';
}

const TIMELINE_LABEL: Record<ReadKind, string> = {
  matches: 'matches',
  exact: 'exact lookup',
  prefix: 'prefix read',
  word: 'word read',
};

/** A client whose matches query answers `matches` (with `count`), whose
 *  exact lookup answers `exact`, and whose prefix and word reads answer
 *  `prefix` and `word`. Every answer is logged on the timeline. */
function stubFor(opts: {
  matches: Row[];
  exact?: Row[];
  prefix?: Row[];
  word?: Row[];
  count?: number;
  fail?: ReadKind;
}) {
  const stub = makeSupabaseStub({
    'inventory_items.select': (call) => {
      const kind = kindOf(call);
      h.timeline.push(TIMELINE_LABEL[kind]);
      if (opts.fail === kind) {
        return { data: null, error: { message: 'boom' } };
      }
      if (kind === 'matches') {
        return { data: opts.matches, error: null, count: opts.count ?? opts.matches.length };
      }
      return { data: opts[kind] ?? [], error: null };
    },
  });
  return stub;
}

/** The Nth inventory_items query's chain, by kind. */
function chainOfKind(
  stub: ReturnType<typeof makeSupabaseStub>,
  kind: ReadKind,
): Array<[string, unknown[]]> {
  const all = stub.chainsAll.get('inventory_items.select') ?? [];
  const args = stub.chainArgsAll.get('inventory_items.select') ?? [];
  const n = all.findIndex((methods, i) =>
    kindOf({ table: 'inventory_items', op: 'select', methods, args: args[i] ?? [] }) === kind,
  );
  if (n < 0) throw new Error(`no ${kind} read was made`);
  return chainOf(stub, n);
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
  it('scopes every request like list(): organization, not deleted, active, received, no rentals, and the asked exclusions', async () => {
    const stub = stubFor({ matches: [] });
    await svc(stub).searchForPicker({
      q: 'pen',
      itemType: 'all',
      excludeBundles: true,
      status: 'active',
    });
    expect(stub.fromCalls).toHaveLength(4);
    for (const n of [0, 1, 2, 3]) {
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

  it('a staff member is held to their warehouses on EVERY request, so no extra read can widen it', async () => {
    h.access = {
      hasAllAccess: false,
      readableIds: ['wh-7'],
      writableIds: ['wh-7'],
      primaryWarehouseId: 'wh-7',
    };
    const stub = stubFor({ matches: [] });
    await svc(stub, 'staff').searchForPicker({ q: 'pen' });
    for (const n of [0, 1, 2, 3]) {
      expect(chainOf(stub, n)).toContainEqual(['in', ['warehouse_id', ['wh-7']]]);
    }
  });

  it('a staff member whose warehouse access cannot be read gets an error, never "no matches"', async () => {
    // getWarehouseAccess reports a failed assignments or membership read as
    // no warehouses plus `unreadable`. Answering that with an empty list made
    // the picker say `No items match "pencil"` when the search had failed.
    h.access = {
      hasAllAccess: false,
      readableIds: [],
      writableIds: [],
      primaryWarehouseId: null,
      unreadable: true,
    };
    const stub = stubFor({ matches: [row('a', 'Pencil', 'P-1')] });
    await expect(svc(stub, 'staff').searchForPicker({ q: 'pencil' })).rejects.toMatchObject({
      code: 'internal_error',
    });
    // Access is still denied: no item is read.
    expect(stub.fromCalls).toEqual([]);
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
    for (const n of [0, 1, 2, 3]) {
      expect(chainOf(stub, n)).toContainEqual(['in', ['category_id', ['cat-1']]]);
    }
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
    for (const fail of ['exact', 'prefix', 'word'] as const) {
      await expect(
        svc(stubFor({ matches: [], fail })).searchForPicker({ q: 'pen' }),
      ).rejects.toThrow();
    }
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
    const ors = chainOfKind(stub, 'matches')
      .filter(([m]) => m === 'or')
      .map(([, a]) => a[0]);
    expect(ors).toEqual([
      'name.ilike.%red%,sku.ilike.%red%,barcode.ilike.%red%,model_number.ilike.%red%',
      'name.ilike.%pen%,sku.ilike.%pen%,barcode.ilike.%pen%,model_number.ilike.%pen%',
    ]);
    // The matches, the prefix read and the word read; no exact lookup.
    expect(stub.fromCalls).toHaveLength(3);
    expect(() => chainOfKind(stub, 'exact')).toThrow();
    // The phrase itself is the prefix and the word start.
    expect(chainOfKind(stub, 'prefix')).toContainEqual([
      'or',
      ['name.ilike.red pen%,sku.ilike.red pen%'],
    ]);
    expect(chainOfKind(stub, 'word')).toContainEqual(['ilike', ['name', '% red pen%']]);
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
    // The other ISBN form is a BARCODE: the ranker never counts a SKU equal to
    // it as exact, so the SKU half of the lookup does not ask for it.
    expect(chainOfKind(stub, 'exact')).toContainEqual([
      'or',
      ['sku.in.("9780142407332"),barcode.in.("9780142407332","014240733X")'],
    ]);
    expect(result.items[0]).toMatchObject({ id: 'b', match: 'exact' });
  });

  it('a hyphenated ISBN is an ISBN too', async () => {
    const stub = stubFor({ matches: [] });
    await svc(stub).searchForPicker({
      q: '978-0-14-240733-2',
      itemType: 'all',
      isbnVariants: ['9780142407332', '014240733X'],
    });
    expect(String(chainOfKind(stub, 'exact').find(([m]) => m === 'or')?.[1][0])).toContain(
      'barcode.in.("978-0-14-240733-2","9780142407332","014240733X")',
    );
  });

  it('a SKU that merely contains ten digits is not an ISBN, so an unrelated barcode is never exact', async () => {
    // isbnVariants("ABC1234567890") keeps the digits and answers
    // ["1234567890", "9781234567897"], which the route passes on for isbn=1.
    const zebra = row('z', 'Zebra stapler', 'ABC1234567890');
    const atlas = row('a', 'Atlas of birds', 'ATL-1', { barcode: '1234567890' });
    // The exact lookup answers both, as it did when it asked for the digits.
    const stub = stubFor({ matches: [zebra], exact: [zebra, atlas] });
    const result = await svc(stub).searchForPicker({
      q: 'ABC1234567890',
      itemType: 'all',
      isbnVariants: ['1234567890', '9781234567897'],
    });
    const clauses = chainOf(stub, 0)
      .concat(chainOfKind(stub, 'exact'))
      .filter(([m]) => m === 'or')
      .map(([, a]) => String(a[0]));
    expect(clauses.join(' ')).not.toContain('"1234567890"');
    expect(clauses.join(' ')).not.toContain('9781234567897');
    expect(chainOfKind(stub, 'exact')).toContainEqual([
      'or',
      [
        'sku.in.("ABC1234567890","abc1234567890"),barcode.in.("ABC1234567890","abc1234567890")',
      ],
    ]);
    // The item whose SKU was typed is the exact match, first; the other is not.
    expect(result.items.map((i) => [i.id, i.match])).toEqual([
      ['z', 'exact'],
      ['a', 'words'],
    ]);
  });

  it('the prefix and word reads carry the scope and every word, and cannot break the filter string', async () => {
    const stub = stubFor({ matches: [] });
    await svc(stub).searchForPicker({ q: 'Pen (blue)', itemType: 'all' });
    const prefix = chainOfKind(stub, 'prefix');
    const word = chainOfKind(stub, 'word');
    for (const chain of [prefix, word]) {
      expect(chain).toContainEqual(['eq', ['organization_id', 'org-1']]);
      expect(chain).toContainEqual(['is', ['deleted_at', null]]);
      expect(chain).toContainEqual(['eq', ['is_rental', false]]);
      // Every word, as the matches carry them: a subset of the matches.
      expect(chain).toContainEqual([
        'or',
        ['name.ilike.%Pen%,sku.ilike.%Pen%,barcode.ilike.%Pen%,model_number.ilike.%Pen%'],
      ]);
      expect(chain).toContainEqual([
        'or',
        ['name.ilike.%blue%,sku.ilike.%blue%,barcode.ilike.%blue%,model_number.ilike.%blue%'],
      ]);
      expect(chain).toContainEqual(['order', ['name', { ascending: true }]]);
    }
    // Parentheses become one-character wildcards, so "Pen (blue)" still reads
    // the item named exactly that, and the filter string stays whole.
    expect(prefix).toContainEqual(['or', ['name.ilike.Pen _blue_%,sku.ilike.Pen _blue_%']]);
    expect(word).toContainEqual(['ilike', ['name', '% Pen _blue_%']]);
  });

  it('a search starting with a double quote cannot open a quoted filter value', async () => {
    const stub = stubFor({ matches: [] });
    await svc(stub).searchForPicker({ q: '"atlas' });
    expect(chainOfKind(stub, 'prefix')).toContainEqual([
      'or',
      ['name.ilike._atlas%,sku.ilike._atlas%'],
    ]);
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

  it('a broad search still puts the items that START with it first, though they sort past the window', async () => {
    // "pen" matches 900 items. The window holds the first 200 in name order,
    // none of which starts with "pen" ("Appendix 000 open pen"...). The items
    // named "Pencil..." sort after all of them, so only the prefix read has them.
    const window = Array.from({ length: 200 }, (_, i) =>
      row(`m${i}`, `Appendix ${String(i).padStart(3, '0')} open pen`, `A-${i}`),
    );
    const pencils = [row('p1', 'Pencil #2', 'W-1'), row('p2', 'Pen cup', 'W-2')];
    const stub = stubFor({ matches: window, prefix: pencils, count: 900 });
    const result = await svc(stub).searchForPicker({ q: 'pen' });
    expect(result.items.slice(0, 3).map((i) => [i.id, i.match])).toEqual([
      ['p2', 'prefix'],
      ['p1', 'prefix'],
      ['m0', 'word'],
    ]);
    expect(result.total).toBe(900);
  });

  it('and a word in the name starting with it comes before rows that only contain it', async () => {
    const window = Array.from({ length: 200 }, (_, i) =>
      row(`m${i}`, `Appendix ${String(i).padStart(3, '0')}`, `A-${i}`),
    );
    const zebra = row('w', 'Zebra blue pen', 'Z-1');
    const stub = stubFor({ matches: window, word: [zebra], count: 450 });
    const result = await svc(stub).searchForPicker({ q: 'pen' });
    expect(result.items.slice(0, 2).map((i) => [i.id, i.match])).toEqual([
      ['w', 'word'],
      ['m0', 'contains'],
    ]);
  });

  it('the prefix and word reads are name order, at most the window each', async () => {
    const stub = stubFor({ matches: [] });
    await svc(stub).searchForPicker({ q: 'pen' });
    expect(chainOfKind(stub, 'prefix')).toContainEqual([
      'or',
      ['name.ilike.pen%,sku.ilike.pen%'],
    ]);
    expect(chainOfKind(stub, 'word')).toContainEqual(['ilike', ['name', '% pen%']]);
    for (const kind of ['prefix', 'word'] as const) {
      expect(chainOfKind(stub, kind)).toContainEqual(['limit', [200]]);
      expect(chainOfKind(stub, kind)[0]).toEqual(['select', [expect.any(String), undefined]]);
    }
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
  it('a manager: no warehouse read, and all four item requests go out together (one level)', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': (call) => {
        // By the time the first answer is read, EVERY request was already made.
        h.timeline.push(`answer with ${stub.fromCalls.length} requests made`);
        return kindOf(call) === 'matches'
          ? { data: [], error: null, count: 0 }
          : { data: [], error: null };
      },
    });
    await svc(stub, 'manager').searchForPicker({ q: 'pencil' });
    expect(getWarehouseAccess).not.toHaveBeenCalled();
    expect(stub.fromCalls).toEqual([
      'inventory_items',
      'inventory_items',
      'inventory_items',
      'inventory_items',
    ]);
    expect(stub.rpcCalls).toEqual([]);
    expect(h.timeline[0]).toBe('answer with 4 requests made');
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
    expect(h.timeline[0]).toBe('warehouse access');
    expect([...h.timeline.slice(1)].sort()).toEqual([
      'exact lookup',
      'matches',
      'prefix read',
      'word read',
    ]);
  });

  it('no holdings, images, value sum or count-only query: nothing but inventory_items', async () => {
    const stub = stubFor({ matches: [row('a', 'Pencil', 'P-1')] });
    await svc(stub).searchForPicker({ q: 'pencil' });
    expect(new Set(stub.fromCalls)).toEqual(new Set(['inventory_items']));
    // The matches query counts; no other read does.
    expect(chainOfKind(stub, 'matches')[0]).toEqual([
      'select',
      [expect.any(String), { count: 'exact' }],
    ]);
    for (const kind of ['exact', 'prefix', 'word'] as const) {
      expect(chainOfKind(stub, kind)[0]).toEqual(['select', [expect.any(String), undefined]]);
    }
  });
});

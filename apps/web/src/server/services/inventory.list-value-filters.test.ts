import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

/**
 * The inventory list's value footer is one aggregate in the database
 * (inventory_list_value, migration 0470), asked with filters that
 * buildItemListValueFilters builds from the list's own filters, and low stock
 * is the computed field is_low_stock, filtered in the request. This file
 * holds:
 *   - the builder, filter by filter, against what applyContentFilters sends;
 *   - the drift guard: every key of ItemListFilters is either a row filter
 *     the builder hands on (and the SQL function accepts) or listed as not a
 *     row filter, so a filter added later cannot be left out of the total;
 *   - list(): one call for the total, in parallel with the page, no paging of
 *     the whole view, and a low-stock page that is full with an exact count.
 */

const { fetchAllRowsSpy } = vi.hoisted(() => ({ fetchAllRowsSpy: vi.fn() }));
vi.mock('./lib/paginate', async (importOriginal) => {
  const original = await importOriginal<typeof import('./lib/paginate')>();
  return {
    ...original,
    fetchAllRows: (...args: Parameters<typeof original.fetchAllRows>) => {
      fetchAllRowsSpy(...args);
      return original.fetchAllRows(...args);
    },
  };
});
vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: vi.fn(async () => ({
    readableIds: ['wh-a', 'wh-b'],
    writableIds: ['wh-a', 'wh-b'],
    hasAllAccess: true,
    primaryWarehouseId: 'wh-a',
  })),
  assertWarehouseAccess: vi.fn(),
  forcedWarehouseId: vi.fn(async () => null),
  ForbiddenError: class ForbiddenError extends Error {
    readonly code = 'forbidden' as const;
  },
}));
const grants = vi.hoisted(() => ({ value: null as Set<string> | null }));
vi.mock('./user-categories', () => ({
  UserCategoriesService: class {
    async getGrantedCategoryIdsForViewer() {
      return grants.value;
    }
  },
}));

import { getWarehouseAccess } from '@/lib/auth/warehouse';
import { buildInstantSearchTerm } from '@/lib/inventory/instant-mode';

import {
  buildItemListValueFilters,
  buildItemSearchClause,
  buildRackFilterClause,
  InventoryService,
  ITEM_LIST_FILTER_KEYS,
  type ItemListFilters,
  type ItemListValueFilters,
} from './inventory';

const MANAGER = {
  access: { hasAllAccess: true, readableIds: ['wh-a', 'wh-b'] },
  categoryGrants: null,
};
const STAFF = { access: { hasAllAccess: false, readableIds: ['wh-a'] }, categoryGrants: null };
const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';

/** What every list sends when no filter is chosen (a manager's view). */
const DEFAULTS: ItemListValueFilters = {
  status: 'active',
  awaiting_first_receipt: false,
  item_types: ['product'],
  is_rental: false,
};

const build = (
  filters: ItemListFilters,
  scope: Parameters<typeof buildItemListValueFilters>[1] = MANAGER,
) => buildItemListValueFilters(filters, scope);

beforeEach(() => {
  vi.clearAllMocks();
  grants.value = null;
});

describe('buildItemListValueFilters: the scope', () => {
  it("a manager's default view: the defaults the page sends, and no warehouse limit", () => {
    expect(build({})).toEqual(DEFAULTS);
  });

  it("a staff member's view is limited to their readable warehouses, whatever warehouse they ask for", () => {
    expect(build({}, STAFF)).toEqual({ ...DEFAULTS, warehouse_ids: ['wh-a'] });
    expect(build({ warehouseId: 'wh-b' }, STAFF)).toEqual({ ...DEFAULTS, warehouse_ids: ['wh-a'] });
  });

  it('a manager who chose a warehouse gets that one', () => {
    expect(build({ warehouseId: UUID_A })).toEqual({ ...DEFAULTS, warehouse_ids: [UUID_A] });
  });

  it("a viewer's category grants travel as category_grants, however many there are", () => {
    const many = Array.from({ length: 150 }, (_x, i) => `cat-${i}`);
    expect(build({}, { ...STAFF, categoryGrants: many })).toEqual({
      ...DEFAULTS,
      warehouse_ids: ['wh-a'],
      category_grants: many,
    });
  });
});

describe('buildItemListValueFilters: each filter as applyContentFilters sends it', () => {
  it.each<[string, ItemListFilters, ItemListValueFilters]>([
    ['status archived', { status: 'archived' }, { ...DEFAULTS, status: 'archived' }],
    ['status active', { status: 'active' }, DEFAULTS],
    [
      'every status',
      { status: 'all' },
      { awaiting_first_receipt: false, item_types: ['product'], is_rental: false },
    ],
    [
      'auto-archived',
      { status: 'archived', autoArchived: true },
      { ...DEFAULTS, status: 'archived', auto_archived: true },
    ],
    ['expected only', { expected: true }, { ...DEFAULTS, awaiting_first_receipt: true }],
    [
      'expected or not',
      { expected: 'any' },
      { status: 'active', item_types: ['product'], is_rental: false },
    ],
    ['expected false', { expected: false }, DEFAULTS],
    ['a search', { q: '  tee  ' }, { ...DEFAULTS, search: 'tee' }],
    ['a search with filter syntax', { q: 'a,b(c)%d*e' }, { ...DEFAULTS, search: 'a b c  d e' }],
    ['a blank search', { q: '   ' }, DEFAULTS],
    ['a search of only syntax', { q: '(' }, { ...DEFAULTS, search: ' ' }],
    [
      'a search with ISBN forms',
      { q: '9780306406157', isbnVariants: ['0-306-40615-2', 'nope', '978030640615x'] },
      {
        ...DEFAULTS,
        search: '9780306406157',
        search_isbn_variants: ['0306406152', '978030640615X'],
      },
    ],
    ['ISBN forms without a search', { isbnVariants: ['0306406152'] }, DEFAULTS],
    ['a barcode', { barcode: ' 0123 ' }, { ...DEFAULTS, barcode: '0123' }],
    ['a blank barcode', { barcode: '  ' }, DEFAULTS],
    [
      'a rack',
      { rack: '17-B' },
      { ...DEFAULTS, rack: { number: '17', row: 'B', label: '17-B', keys: 'item' } },
    ],
    [
      'a rack number',
      { rack: '17' },
      { ...DEFAULTS, rack: { number: '17', row: null, label: '17', keys: 'item' } },
    ],
    [
      'a Books rack',
      { rack: '17-B', itemType: 'book' },
      {
        ...DEFAULTS,
        item_types: ['book'],
        rack: { number: '17', row: 'B', label: '17-B', keys: 'book' },
      },
    ],
    [
      'a rack over every type',
      { rack: '17-B', itemType: 'all' },
      {
        status: 'active',
        awaiting_first_receipt: false,
        is_rental: false,
        rack: { number: '17', row: 'B', label: '17-B', keys: 'by_type' },
      },
    ],
    [
      'a rack sanitized',
      { rack: ' 1,7.-B) ' },
      { ...DEFAULTS, rack: { number: '17', row: 'B', label: '17-B', keys: 'item' } },
    ],
    ['a rack of nothing usable', { rack: '%%' }, DEFAULTS],
    [
      'categories',
      { categoryIds: [UUID_A, UUID_B], categoryId: UUID_B },
      { ...DEFAULTS, category_ids: [UUID_A, UUID_B] },
    ],
    [
      'one category',
      { categoryIds: [], categoryId: UUID_A },
      { ...DEFAULTS, category_ids: [UUID_A] },
    ],
    ['locations', { locationIds: [UUID_A] }, { ...DEFAULTS, location_ids: [UUID_A] }],
    ['one location', { locationId: UUID_B }, { ...DEFAULTS, location_ids: [UUID_B] }],
    ['suppliers', { supplierIds: [UUID_A] }, { ...DEFAULTS, supplier_ids: [UUID_A] }],
    ['one supplier', { supplierId: UUID_B }, { ...DEFAULTS, supplier_ids: [UUID_B] }],
    [
      'charters and Generic',
      { charterIds: ['generic', UUID_A, 'bad'] },
      { ...DEFAULTS, charter_generic: true, charter_ids: [UUID_A] },
    ],
    ['Generic only', { charterIds: ['generic'] }, { ...DEFAULTS, charter_generic: true }],
    ['charters', { charterIds: [UUID_A, UUID_B] }, { ...DEFAULTS, charter_ids: [UUID_A, UUID_B] }],
    ['charters that are not ids: no filter, as the page', { charterIds: ['x'] }, DEFAULTS],
    ['out of stock', { outOfStock: true }, { ...DEFAULTS, out_of_stock: true }],
    ['with a unit cost', { hasUnitCost: true }, { ...DEFAULTS, has_unit_cost: true }],
    ['low stock', { lowStock: true }, { ...DEFAULTS, low_stock: true }],
    [
      'item types',
      { itemTypes: ['product', 'asset'], itemType: 'book' },
      { ...DEFAULTS, item_types: ['product', 'asset'] },
    ],
    [
      'empty item types fall back to the type',
      { itemTypes: [], itemType: 'consumable' },
      { ...DEFAULTS, item_types: ['consumable'] },
    ],
    [
      'every type',
      { itemType: 'all' },
      { status: 'active', awaiting_first_receipt: false, is_rental: false },
    ],
    ['no bundles', { excludeBundles: true }, { ...DEFAULTS, exclude_bundles: true }],
    [
      'shown in Orders only',
      { orderCatalogVisibleOnly: true },
      { ...DEFAULTS, order_catalog_visible: true },
    ],
    ['rentals', { rentalsOnly: true }, { ...DEFAULTS, is_rental: true }],
    [
      'dates',
      {
        createdSince: '2026-01-01',
        createdUntil: '2026-02-01',
        updatedSince: '2026-03-01',
        updatedUntil: '2026-04-01',
      },
      {
        ...DEFAULTS,
        created_since: '2026-01-01',
        created_until: '2026-02-01',
        updated_since: '2026-03-01',
        updated_until: '2026-04-01',
      },
    ],
    ['ids', { ids: [UUID_A, UUID_B] }, { ...DEFAULTS, ids: [UUID_A, UUID_B] }],
    ['no ids', { ids: [] }, DEFAULTS],
  ])('%s', (_name, filters, want) => {
    expect(build(filters)).toEqual(want);
  });

  it('the search term is the one the page clause carries, byte for byte', () => {
    for (const q of ['tee', 'a,b(c)%d*e', 'x'.repeat(200), ' _\\" ']) {
      const out = build({ q, isbnVariants: ['0306406152'] });
      expect(buildItemSearchClause(q, ['0306406152'])).toBe(
        `name.ilike.%${out.search}%,sku.ilike.%${out.search}%,barcode.ilike.%${out.search}%,model_number.ilike.%${out.search}%,barcode.in.("0306406152")`,
      );
    }
    expect(build({ q: 'x'.repeat(200) }).search).toHaveLength(120);
  });

  it('the rack parts are the ones the page clause is built from', () => {
    for (const [rack, itemType] of [
      ['17-B', undefined],
      ['17', undefined],
      ['17-B', 'book'],
      ['A1-2-C', undefined],
    ] as const) {
      const parts = build({ rack, itemType: itemType as ItemListFilters['itemType'] }).rack!;
      const clause = buildRackFilterClause(rack, itemType);
      const nk =
        itemType === 'book' ? 'custom_fields->>book_rack_number' : 'custom_fields->>rack_number';
      const rk = itemType === 'book' ? 'custom_fields->>book_rack_row' : 'custom_fields->>rack_row';
      if (parts.row === null) {
        expect(clause).toEqual({ kind: 'eq', column: nk, value: parts.number });
      } else {
        expect(clause).toEqual({
          kind: 'or',
          expr: `and(${nk}.eq.${parts.number},${rk}.eq.${parts.row}),${nk}.eq.${parts.label}`,
        });
      }
    }
  });

  it('refuses, before any request, what the database function would refuse', () => {
    const tooMany = Array.from({ length: 1001 }, () => UUID_A);
    for (const filters of [
      { categoryIds: tooMany },
      { locationIds: tooMany },
      { supplierIds: tooMany },
      { charterIds: tooMany },
      { ids: tooMany },
      { barcode: '1'.repeat(4097) },
      { itemTypes: Array.from({ length: 11 }, () => 'product' as const) },
      { q: '9780306406157', isbnVariants: Array.from({ length: 21 }, () => '0306406152') },
    ] as ItemListFilters[]) {
      expect(() => build(filters)).toThrow(expect.objectContaining({ code: 'validation_error' }));
    }
    expect(() => build({}, { ...STAFF, categoryGrants: tooMany })).toThrow(
      expect.objectContaining({ code: 'validation_error' }),
    );
    expect(build({ barcode: '1'.repeat(4096) }).barcode).toHaveLength(4096);
  });
});

// ─── the drift guard ────────────────────────────────────────────────────────

const REPO = resolve(__dirname, '../../../../..');
const SERVICE_SOURCE = readFileSync(join(__dirname, 'inventory.ts'), 'utf8');

/** The property names of an `export interface <name> {` block, top level only. */
function interfaceKeys(name: string): string[] {
  const start = SERVICE_SOURCE.indexOf(`export interface ${name} {`);
  expect(start, name).toBeGreaterThanOrEqual(0);
  const lines = SERVICE_SOURCE.slice(start).split('\n');
  const keys: string[] = [];
  for (const line of lines.slice(1)) {
    if (line === '}') break;
    const m = /^ {2}([A-Za-z_]\w*)\??:/.exec(line);
    if (m) keys.push(m[1]!);
  }
  return keys;
}

/** The keys inventory_list_value accepts, read from its latest migration. */
function sqlFunctionKeys(): { top: string[]; rack: string[] } {
  const dir = join(REPO, 'supabase/migrations');
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .filter((f) =>
      /create or replace function public\.inventory_list_value\(/i.test(
        readFileSync(join(dir, f), 'utf8'),
      ),
    );
  expect(files.length).toBeGreaterThan(0);
  const sql = readFileSync(join(dir, files[files.length - 1]!), 'utf8');
  const body = sql.slice(sql.search(/create or replace function public\.inventory_list_value\(/i));
  const top = new Set<string>();
  for (const m of body.matchAll(/v_key in \(([^)]*)\)/g)) {
    for (const k of m[1]!.matchAll(/'([a-z_]+)'/g)) top.add(k[1]!);
  }
  for (const m of body.matchAll(/v_key = '([a-z_]+)' then/g)) top.add(m[1]!);
  const rackList = /where k not in \(([^)]*)\)/.exec(body);
  expect(rackList).not.toBeNull();
  const rack = [...rackList![1]!.matchAll(/'([a-z_]+)'/g)].map((k) => k[1]!);
  return { top: [...top].sort(), rack: rack.sort() };
}

/**
 * For every row filter: a value that must change what the value total is
 * asked for (`base` when the key only acts alongside another one). A key
 * added to ITEM_LIST_FILTER_KEYS as a row filter fails here until it has a
 * sample and the builder hands it on.
 */
const ROW_FILTER_SAMPLES: Record<string, { base?: ItemListFilters; set: ItemListFilters }> = {
  q: { set: { q: 'tee' } },
  barcode: { set: { barcode: '0123' } },
  rack: { set: { rack: '17-B' } },
  status: { set: { status: 'archived' } },
  categoryId: { set: { categoryId: UUID_A } },
  categoryIds: { set: { categoryIds: [UUID_A] } },
  locationId: { set: { locationId: UUID_A } },
  locationIds: { set: { locationIds: [UUID_A] } },
  supplierId: { set: { supplierId: UUID_A } },
  supplierIds: { set: { supplierIds: [UUID_A] } },
  charterIds: { set: { charterIds: ['generic'] } },
  warehouseId: { set: { warehouseId: UUID_A } },
  ids: { set: { ids: [UUID_A] } },
  itemType: { set: { itemType: 'book' } },
  itemTypes: { set: { itemTypes: ['asset'] } },
  excludeBundles: { set: { excludeBundles: true } },
  orderCatalogVisibleOnly: { set: { orderCatalogVisibleOnly: true } },
  lowStock: { set: { lowStock: true } },
  outOfStock: { set: { outOfStock: true } },
  hasUnitCost: { set: { hasUnitCost: true } },
  createdSince: { set: { createdSince: '2026-01-01' } },
  createdUntil: { set: { createdUntil: '2026-01-01' } },
  updatedSince: { set: { updatedSince: '2026-01-01' } },
  updatedUntil: { set: { updatedUntil: '2026-01-01' } },
  rentalsOnly: { set: { rentalsOnly: true } },
  autoArchived: { set: { autoArchived: true } },
  expected: { set: { expected: true } },
  isbnVariants: { base: { q: '9780306406157' }, set: { isbnVariants: ['0306406152'] } },
};

const NOT_A_ROW_FILTER_SAMPLES: Record<string, ItemListFilters> = {
  plannedTotals: { plannedTotals: { total: 3, valueOnHand: 4 } },
  withElsewhere: { withElsewhere: true },
  cursor: { cursor: 'abc' },
  limit: { limit: 7 },
  offset: { offset: 70 },
  sort: { sort: 'name_asc' },
};

describe('drift guard: every list filter reaches the value total', () => {
  it('ITEM_LIST_FILTER_KEYS sorts exactly the keys ItemListFilters declares', () => {
    expect(Object.keys(ITEM_LIST_FILTER_KEYS).sort()).toEqual(
      interfaceKeys('ItemListFilters').sort(),
    );
  });

  it('every row filter has a sample, and every key that is not one is listed with a sample too', () => {
    const rows = Object.entries(ITEM_LIST_FILTER_KEYS)
      .filter(([, role]) => role === 'row_filter')
      .map(([k]) => k)
      .sort();
    const others = Object.entries(ITEM_LIST_FILTER_KEYS)
      .filter(([, role]) => role === 'not_a_row_filter')
      .map(([k]) => k)
      .sort();
    expect(Object.keys(ROW_FILTER_SAMPLES).sort()).toEqual(rows);
    expect(Object.keys(NOT_A_ROW_FILTER_SAMPLES).sort()).toEqual(others);
  });

  it.each(Object.entries(ROW_FILTER_SAMPLES))(
    '%s changes what the value total is asked for',
    (key, s) => {
      const before = build(s.base ?? {});
      const after = build({ ...(s.base ?? {}), ...s.set });
      expect(Object.keys(s.set)).toEqual([key]);
      expect(after).not.toEqual(before);
    },
  );

  it.each(Object.entries(NOT_A_ROW_FILTER_SAMPLES))('%s does not change it', (key, set) => {
    expect(Object.keys(set)).toEqual([key]);
    expect(build(set)).toEqual(build({}));
    expect(build(set, STAFF)).toEqual(build({}, STAFF));
  });

  it('the SQL function accepts exactly the keys ItemListValueFilters declares, and the rack parts', () => {
    const sql = sqlFunctionKeys();
    expect(sql.top).toEqual(interfaceKeys('ItemListValueFilters').sort());
    expect(sql.rack).toEqual(['keys', 'label', 'number', 'row']);
    // And the builder sends nothing the function does not accept.
    const sent = new Set<string>();
    for (const s of Object.values(ROW_FILTER_SAMPLES)) {
      for (const scope of [MANAGER, STAFF, { ...STAFF, categoryGrants: ['c'] }]) {
        for (const k of Object.keys(build({ ...(s.base ?? {}), ...s.set }, scope))) sent.add(k);
      }
    }
    for (const k of sent) expect(sql.top).toContain(k);
    for (const r of ['17-B', '17']) {
      expect(Object.keys(build({ rack: r }).rack!).sort()).toEqual(sql.rack);
    }
  });

  it('the other way: every key the SQL accepts is one the builder sends, and the SQL uses every one it reads', () => {
    const sql = sqlFunctionKeys();
    const sent = new Set<string>();
    for (const [filters, scope] of COVERAGE) {
      for (const k of Object.keys(build(filters, scope))) sent.add(k);
    }
    expect([...sent].sort()).toEqual(sql.top);
    // In the function: each accepted key is read after the checks, and each
    // variable read from the filters is used in the WHERE (a key that is
    // checked and then dropped would narrow nothing).
    const body = sqlFunctionBody();
    const cut = body.indexOf('from public.inventory_items i');
    expect(cut).toBeGreaterThan(0);
    const setup = body.slice(0, cut);
    const where = body.slice(cut);
    for (const k of sql.top) {
      expect(setup, k).toMatch(new RegExp(`p_filters\\s*(\\?|->>|->|#>>)\\s*'\\{?${k}\\b`));
    }
    const vars = [...setup.matchAll(/\b(v_[a-z_]+) :=/g)]
      .map((m) => m[1]!)
      .filter((v) => v !== 'v_max');
    expect(vars.length).toBeGreaterThan(20);
    for (const v of new Set(vars)) expect(where, v).toMatch(new RegExp(`\\b${v}\\b`));
  });

  it.each(PAGE_CASES)(
    'the page request and the value total carry the same filters, both ways: %s',
    async (_name, filters, who) => {
      const { pageCalls, pFilters } = await listBoth(filters, who);
      const covered = new Set<string>();
      for (const call of pageCalls) {
        for (const k of totalKeyFor(call, pFilters).split('+')) covered.add(k);
      }
      // Every key the total was given stands for a filter on the page.
      for (const k of Object.keys(pFilters)) expect(covered, `total key ${k}`).toContain(k);
    },
  );
});

/** Every filter set the drift guard covers, with the three scopes. */
const COVERAGE: Array<[ItemListFilters, Parameters<typeof buildItemListValueFilters>[1]]> = [
  ...Object.values(ROW_FILTER_SAMPLES).flatMap((s) =>
    [MANAGER, STAFF, { ...STAFF, categoryGrants: ['c'] }].map(
      (scope) => [{ ...(s.base ?? {}), ...s.set }, scope] as [ItemListFilters, typeof scope],
    ),
  ),
  [{ charterIds: [UUID_A] }, MANAGER],
];

/** The body of the latest inventory_list_value. */
function sqlFunctionBody(): string {
  const dir = join(REPO, 'supabase/migrations');
  const file = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .filter((f) =>
      /create or replace function public\.inventory_list_value\(/i.test(
        readFileSync(join(dir, f), 'utf8'),
      ),
    )
    .pop()!;
  const sql = readFileSync(join(dir, file), 'utf8');
  const start = sql.search(/create or replace function public\.inventory_list_value\(/i);
  return sql.slice(start, sql.indexOf('$$;', start));
}

type Who = 'manager' | 'staff' | 'viewer';
const PAGE_CASES: Array<[string, ItemListFilters, Who]> = [
  ...(['manager', 'staff', 'viewer'] as const).flatMap((who) =>
    [
      ...Object.entries(ROW_FILTER_SAMPLES).map(
        ([k, s]) => [k, { ...(s.base ?? {}), ...s.set }] as [string, ItemListFilters],
      ),
      ['charters', { charterIds: [UUID_A, UUID_B] }] as [string, ItemListFilters],
      ['Generic and a charter', { charterIds: ['generic', UUID_A] }] as [string, ItemListFilters],
      ['a Books rack', { rack: '17-B', itemType: 'book' }] as [string, ItemListFilters],
      ['a rack number over every type', { rack: '17', itemType: 'all' }] as [
        string,
        ItemListFilters,
      ],
      ['a rack over every type', { rack: '17-B', itemType: 'all' }] as [string, ItemListFilters],
      ['every status, any receipt', { status: 'all', expected: 'any' }] as [
        string,
        ItemListFilters,
      ],
      [
        'everything at once',
        {
          q: '9780306406157',
          isbnVariants: ['0306406152'],
          barcode: '0123',
          rack: '17-B',
          status: 'archived',
          autoArchived: true,
          categoryIds: [UUID_A],
          locationId: UUID_B,
          supplierIds: [UUID_A],
          charterIds: ['generic', UUID_B],
          warehouseId: UUID_A,
          outOfStock: true,
          lowStock: true,
          hasUnitCost: true,
          itemTypes: ['book', 'asset'],
          excludeBundles: true,
          orderCatalogVisibleOnly: true,
          rentalsOnly: true,
          createdSince: '2026-01-01',
          createdUntil: '2026-02-01',
          updatedSince: '2026-03-01',
          updatedUntil: '2026-04-01',
          expected: true,
          ids: [UUID_A, UUID_B],
        },
      ] as [string, ItemListFilters],
    ].map(([name, f]) => [`${name} (${who})`, f, who] as [string, ItemListFilters, Who]),
  ),
];

/** One list() call: the page request's filters, and what the total was given. */
async function listBoth(filters: ItemListFilters, who: Who) {
  if (who === 'manager') {
    vi.mocked(getWarehouseAccess).mockResolvedValueOnce({
      readableIds: ['wh-a', 'wh-b'],
      writableIds: ['wh-a', 'wh-b'],
      hasAllAccess: true,
      primaryWarehouseId: 'wh-a',
    });
  } else {
    vi.mocked(getWarehouseAccess).mockResolvedValueOnce({
      readableIds: ['wh-a'],
      writableIds: who === 'staff' ? ['wh-a'] : [],
      hasAllAccess: false,
      primaryWarehouseId: 'wh-a',
    });
  }
  grants.value = who === 'viewer' ? new Set(['cat-1', 'cat-2']) : null;
  const stub = makeSupabaseStub({
    'inventory_items.select': { data: [], error: null, count: 0 },
    'rpc:inventory_list_value': { data: 0, error: null },
  });
  const svc = new InventoryService(makeServiceContext(stub.client, { role: who }));
  await svc.list({ ...filters, limit: 30, offset: 0 });
  const methods = stub.chainsAll.get('inventory_items.select')![0]!;
  const args = stub.chainArgsAll.get('inventory_items.select')![0]!;
  const pageCalls = methods
    .map((m, i) => ({ m, a: args[i] ?? [] }))
    .filter((c) => !['select', 'order', 'range'].includes(c.m));
  expect(stub.rpcCalls).toHaveLength(1);
  const pFilters = (stub.rpcCalls[0]!.args as { p_filters: ItemListValueFilters }).p_filters;
  return { pageCalls, pFilters };
}

const set = (xs: unknown) => new Set(xs as string[]);

/** The rack clause the page must carry for these parts, written out here on
 *  its own (not by buildRackFilterClause), so a change of meaning on either
 *  side fails. */
function rackExpected(r: NonNullable<ItemListValueFilters['rack']>) {
  const item = ['custom_fields->>rack_number', 'custom_fields->>rack_row'] as const;
  const book = ['custom_fields->>book_rack_number', 'custom_fields->>book_rack_row'] as const;
  const tolerant = ([nk, rk]: readonly [string, string]) =>
    r.row
      ? `or(and(${nk}.eq.${r.number},${rk}.eq.${r.row}),${nk}.eq.${r.label})`
      : `${nk}.eq.${r.number}`;
  if (r.keys === 'by_type') {
    return {
      m: 'or',
      a: [`and(item_type.eq.book,${tolerant(book)}),and(item_type.neq.book,${tolerant(item)})`],
    };
  }
  const [nk, rk] = r.keys === 'book' ? book : item;
  if (!r.row) return { m: 'filter', a: [nk, 'eq', r.number] };
  return { m: 'or', a: [`and(${nk}.eq.${r.number},${rk}.eq.${r.row}),${nk}.eq.${r.label}`] };
}

/**
 * The value-total key that stands for one filter of the page request, after
 * checking that the two say the same thing. A filter on the page that maps to
 * no key (a new scope filter in list(), a new predicate, or a changed
 * operator such as lte -> lt) fails here.
 */
function totalKeyFor(call: { m: string; a: unknown[] }, pf: ItemListValueFilters): string {
  const [col, val] = call.a as [string, unknown];
  const where = `${call.m}(${JSON.stringify(call.a)})`;
  switch (`${call.m}:${col}`) {
    case 'eq:organization_id':
      expect(val, where).toBe('org-test');
      return 'organization';
    case 'is:deleted_at':
      expect(val, where).toBeNull();
      return 'live';
    case 'in:warehouse_id':
      expect(pf.warehouse_ids, where).toEqual(val);
      return 'warehouse_ids';
    case 'eq:warehouse_id':
      expect(pf.warehouse_ids, where).toEqual([val]);
      return 'warehouse_ids';
    case 'in:category_id':
      if (
        pf.category_grants &&
        set(pf.category_grants).size === set(val).size &&
        [...set(val)].every((v) => pf.category_grants!.includes(v))
      ) {
        return 'category_grants';
      }
      expect(pf.category_ids, where).toEqual(val);
      return 'category_ids';
    case 'eq:category_id':
      expect(pf.category_ids, where).toEqual([val]);
      return 'category_ids';
    case 'eq:status':
      expect(pf.status, where).toBe(val);
      return 'status';
    case 'eq:auto_archived':
      expect([val, pf.auto_archived], where).toEqual([true, true]);
      return 'auto_archived';
    case 'eq:awaiting_first_receipt':
      expect(pf.awaiting_first_receipt, where).toBe(val);
      return 'awaiting_first_receipt';
    case 'eq:barcode':
      expect(pf.barcode, where).toBe(val);
      return 'barcode';
    case 'in:primary_location_id':
      expect(pf.location_ids, where).toEqual(val);
      return 'location_ids';
    case 'eq:primary_location_id':
      expect(pf.location_ids, where).toEqual([val]);
      return 'location_ids';
    case 'in:supplier_id':
      expect(pf.supplier_ids, where).toEqual(val);
      return 'supplier_ids';
    case 'eq:supplier_id':
      expect(pf.supplier_ids, where).toEqual([val]);
      return 'supplier_ids';
    case 'is:charter_id':
      expect([val, pf.charter_generic, pf.charter_ids], where).toEqual([null, true, undefined]);
      return 'charter_generic';
    case 'in:charter_id':
      expect([pf.charter_generic, pf.charter_ids], where).toEqual([undefined, val]);
      return 'charter_ids';
    case 'lte:quantity_on_hand':
      expect([val, pf.out_of_stock], where).toEqual([0, true]);
      return 'out_of_stock';
    case 'gt:unit_cost':
      expect([val, pf.has_unit_cost], where).toEqual([0, true]);
      return 'has_unit_cost';
    case 'eq:is_low_stock':
      expect([val, pf.low_stock], where).toEqual([true, true]);
      return 'low_stock';
    case 'in:item_type':
      expect(pf.item_types, where).toEqual(val);
      return 'item_types';
    case 'eq:item_type':
      expect(pf.item_types, where).toEqual([val]);
      return 'item_types';
    case 'eq:order_catalog_visible':
      expect([val, pf.order_catalog_visible], where).toEqual([true, true]);
      return 'order_catalog_visible';
    case 'eq:is_rental':
      expect(pf.is_rental, where).toBe(val);
      return 'is_rental';
    case 'gte:created_at':
      expect(pf.created_since, where).toBe(val);
      return 'created_since';
    case 'lt:created_at':
      expect(pf.created_until, where).toBe(val);
      return 'created_until';
    case 'gte:updated_at':
      expect(pf.updated_since, where).toBe(val);
      return 'updated_since';
    case 'lt:updated_at':
      expect(pf.updated_until, where).toBe(val);
      return 'updated_until';
    case 'in:id':
      expect(pf.ids, where).toEqual(val);
      return 'ids';
  }
  if (call.m === 'filter' || (call.m === 'or' && String(col).includes('custom_fields->>'))) {
    expect(pf.rack, where).toBeDefined();
    expect(call, where).toEqual(rackExpected(pf.rack!));
    return 'rack';
  }
  if (call.m === 'or' && String(col).startsWith('name.ilike.')) {
    const t = pf.search!;
    const isbn = pf.search_isbn_variants
      ? `,barcode.in.(${pf.search_isbn_variants.map((v) => `"${v}"`).join(',')})`
      : '';
    expect(col, where).toBe(
      `name.ilike.%${t}%,sku.ilike.%${t}%,barcode.ilike.%${t}%,model_number.ilike.%${t}%${isbn}`,
    );
    // search_isbn_variants rides inside the same clause.
    return pf.search_isbn_variants ? 'search+search_isbn_variants' : 'search';
  }
  if (
    call.m === 'or' &&
    col ===
      'charter_id.is.null,charter_id.in.(' +
        (pf.charter_ids ?? []).map((v) => `"${v}"`).join(',') +
        ')'
  ) {
    expect(pf.charter_generic, where).toBe(true);
    return 'charter_generic+charter_ids';
  }
  if (call.m === 'or' && col === 'is_bundle.is.null,is_bundle.eq.false') {
    expect(pf.exclude_bundles, where).toBe(true);
    return 'exclude_bundles';
  }
  throw new Error(`a filter on the page that the value total does not carry: ${where}`);
}

// ─── list() ─────────────────────────────────────────────────────────────────

describe('the search term is cut on whole characters, the same on the page, the total and the screen', () => {
  const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  const pageTerm = (calls: Array<{ m: string; a: unknown[] }>) => {
    const clause = calls.find((c) => c.m === 'or' && String(c.a[0]).startsWith('name.ilike.'));
    return clause ? String(clause.a[0]).slice('name.ilike.%'.length).split('%,')[0] : null;
  };

  it('119 characters and an emoji: all 120 kept, the emoji whole, on the page and in the total', async () => {
    const q = 'a'.repeat(119) + '\u{1F600}';
    expect(q.length).toBe(121); // the emoji is two UTF-16 units
    const { pageCalls, pFilters } = await listBoth({ q }, 'manager');
    expect(pFilters.search).toBe(q);
    expect(pageTerm(pageCalls)).toBe(q);
    expect(LONE.test(pFilters.search!)).toBe(false);
    // The list screen filters on the same term while the request is on its way.
    expect(buildInstantSearchTerm(q)).toBe(q);
  });

  it('120 characters and an emoji: the emoji is dropped whole, never half of it', async () => {
    const q = 'a'.repeat(120) + '\u{1F600}';
    const { pageCalls, pFilters } = await listBoth({ q }, 'staff');
    expect(pFilters.search).toBe('a'.repeat(120));
    expect(pageTerm(pageCalls)).toBe('a'.repeat(120));
    expect(buildInstantSearchTerm(q)).toBe('a'.repeat(120));
  });

  it('a lone surrogate half typed in the term becomes U+FFFD, the same everywhere', async () => {
    const q = 'tee\uD83D';
    const { pageCalls, pFilters } = await listBoth({ q }, 'viewer');
    expect(pFilters.search).toBe('tee�');
    expect(pageTerm(pageCalls)).toBe('tee�');
    expect(buildInstantSearchTerm(q)).toBe('tee�');
    // The SQL function's 120-character cap counts the same characters.
    expect(Array.from(build({ q: 'b'.repeat(119) + '\u{1F600}' }).search!)).toHaveLength(120);
  });
});

describe('list(): the value footer is one aggregate, the low-stock view is filtered in the database', () => {
  it('asks inventory_list_value once with the builder filters, and never pages the whole view', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: [], error: null, count: 0 },
      'rpc:inventory_list_value': { data: 1234.5, error: null },
    });
    const svc = new InventoryService(makeServiceContext(stub.client, { role: 'manager' }));
    const filters: ItemListFilters = {
      q: 'tee',
      rack: '17-B',
      lowStock: true,
      warehouseId: UUID_A,
    };
    const out = await svc.list({ ...filters, limit: 50, offset: 0 });
    expect(out.valueOnHand).toBe(1234.5);
    expect(stub.rpcCalls).toEqual([
      {
        name: 'inventory_list_value',
        args: { p_organization_id: 'org-test', p_filters: build(filters) },
      },
    ]);
    // One read of inventory_items: the page. No 1000-row windows.
    expect(stub.chainsAll.get('inventory_items.select')).toHaveLength(1);
    expect(fetchAllRowsSpy).not.toHaveBeenCalled();
  });

  it('a staff member and a viewer: their warehouses and grants reach the total', async () => {
    vi.mocked(getWarehouseAccess).mockResolvedValueOnce({
      readableIds: ['wh-a'],
      writableIds: [],
      hasAllAccess: false,
      primaryWarehouseId: 'wh-a',
    });
    grants.value = new Set(['cat-1']);
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: [], error: null, count: 0 },
      'rpc:inventory_list_value': { data: 0, error: null },
    });
    const svc = new InventoryService(makeServiceContext(stub.client, { role: 'viewer' }));
    await svc.list({});
    expect(stub.rpcCalls[0]!.args).toEqual({
      p_organization_id: 'org-test',
      p_filters: { ...DEFAULTS, warehouse_ids: ['wh-a'], category_grants: ['cat-1'] },
    });
  });

  it('asks for the total while the page is still on its way (in parallel)', async () => {
    let releasePage!: () => void;
    const pageHeld = new Promise<void>((r) => {
      releasePage = r;
    });
    const order: string[] = [];
    const chain: Record<string, unknown> = new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === 'then') {
            return (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) =>
              pageHeld
                .then(() => {
                  order.push('page answered');
                  return { data: [], error: null, count: 0 };
                })
                .then(ok, bad);
          }
          return () => chain;
        },
      },
    );
    const client = {
      from: () => chain,
      rpc: vi.fn(async () => {
        order.push('total asked');
        return { data: 0, error: null };
      }),
    };
    const svc = new InventoryService(makeServiceContext(client, { role: 'manager' }));
    const pending = svc.list({});
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual(['total asked']);
    releasePage();
    await pending;
    expect(order).toEqual(['total asked', 'page answered']);
  });

  it.each([
    ['an error', { data: null, error: { message: 'boom' } }],
    ['no answer', { data: null, error: null }],
    ['a non-number', { data: 'abc', error: null }],
  ])('%s from the total fails the list, never a footer of 0', async (_name, answer) => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: [], error: null, count: 0 },
      'rpc:inventory_list_value': answer as never,
    });
    const svc = new InventoryService(makeServiceContext(stub.client, { role: 'manager' }));
    await expect(svc.list({})).rejects.toMatchObject({ code: 'internal_error' });
  });

  it('a numeric that arrives as text is read as the number', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: [], error: null, count: 0 },
      'rpc:inventory_list_value': { data: '1049.2500', error: null },
    });
    const svc = new InventoryService(makeServiceContext(stub.client, { role: 'manager' }));
    expect((await svc.list({})).valueOnHand).toBe(1049.25);
  });

  it('a low-stock page is the requested slice of the low-stock set: full, with the exact count', async () => {
    // The stub plays the database for a request that asked is_low_stock=eq.true:
    // three rows for a page of three, and the size of the whole low set.
    const rows = [
      { id: 'a', quantity_on_hand: 0, reorder_point: 0 },
      { id: 'b', quantity_on_hand: 2, reorder_point: 5 },
      { id: 'c', quantity_on_hand: -1, reorder_point: 0 },
    ];
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: rows, error: null, count: 41 },
      'rpc:inventory_list_value': { data: 0, error: null },
    });
    const svc = new InventoryService(makeServiceContext(stub.client, { role: 'manager' }));
    const out = await svc.list({ lowStock: true, limit: 3, offset: 6 });
    const methods = stub.chainsAll.get('inventory_items.select')![0]!;
    const args = stub.chainArgsAll.get('inventory_items.select')![0]!;
    const calls = methods.map((m, i) => [m, ...(args[i] ?? [])]);
    expect(calls).toContainEqual(['eq', 'is_low_stock', true]);
    expect(calls).toContainEqual(['range', 6, 8]);
    expect(methods).not.toContain('or');
    expect(out.items.map((i) => (i as { id: string }).id)).toEqual(['a', 'b', 'c']);
    expect(out.total).toBe(41);
  });

  it('planned totals: no total is asked at all', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: [], error: null, count: 0 },
    });
    const svc = new InventoryService(makeServiceContext(stub.client, { role: 'staff' }));
    const out = await svc.list({ ids: [UUID_A], plannedTotals: { total: 9, valueOnHand: 8 } });
    expect(stub.rpcCalls).toEqual([]);
    expect(out).toMatchObject({ total: 9, valueOnHand: 8 });
  });
});

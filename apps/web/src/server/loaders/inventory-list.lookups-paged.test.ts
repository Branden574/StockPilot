import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Location filter on the Items and Books pages. A manager's options come
 * from the cached lookups (loadInventoryLookups), a staff member's or a
 * viewer's from LocationsService.list({ sitesOnly: true }), and the loader's
 * read is the documented mirror of that service. Small fixes slice 8 made
 * list() read every page (it was one read, capped at PostgREST's 1000 rows of
 * every kind before the sites were picked out), and the loader kept the one
 * capped read: past 1000 locations a manager's filter left out each site whose
 * name sorts after the first 1000 rows, while a staff member's listed it. The
 * loader now reads page by page too, ordered by name and then id.
 *
 * Both run here against the same in-memory PostgREST (servedLikePostgrest:
 * the query's own filters, order and range, 1000 rows at most per response).
 */

const h = vi.hoisted(() => ({
  admin: null as unknown,
  // The shared LOOKUP_ROW_CEILING, lowered by the ceiling tests.
  ceiling: { value: 10_000 },
  reportError: vi.fn(async (..._args: unknown[]) => {}),
}));

vi.mock('next/cache', () => ({
  revalidateTag: vi.fn(),
  unstable_cache: vi.fn((fn: unknown) => fn),
}));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => h.admin }));
vi.mock('@/lib/error-reporter', () => ({ reportError: h.reportError }));
// A getter, so a test can lower the ceiling: the loader and the services read
// the binding on every call.
vi.mock('@/server/services/lib/lookup-ceiling', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/services/lib/lookup-ceiling')>()),
  get LOOKUP_ROW_CEILING() {
    return h.ceiling.value;
  },
}));

import { CategoriesService } from '@/server/services/categories';
import { ChartersService } from '@/server/services/charters';
import { LocationsService } from '@/server/services/locations';
import { SuppliersService } from '@/server/services/suppliers';
import { TagsService } from '@/server/services/tags';
import {
  makeServiceContext,
  makeSupabaseStub,
  servedLikePostgrest,
  type MockCall,
  type QueryResult,
} from '@/test/supabase-mock';

import { loadInventoryLookups } from './inventory-list';

const ORG = 'org-test';

type LocationRow = Record<string, unknown>;

/** `n` racks named "A rack 0000" onward: each sorts before the site. */
function racks(n: number): LocationRow[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    organization_id: ORG,
    name: `A rack ${String(i).padStart(4, '0')}`,
    kind: 'rack',
    type: 'shelf',
    warehouse_id: 'wh-1',
    deleted_at: null,
  }));
}

const SITE: LocationRow = {
  id: 'ffffffff-0000-4000-8000-000000000001',
  organization_id: ORG,
  name: 'Zebra Warehouse',
  kind: null,
  type: 'warehouse',
  warehouse_id: 'wh-1',
  deleted_at: null,
};

/** The cached lookups, read from `locations` served like PostgREST. */
async function cachedLookups(locations: (call: MockCall) => QueryResult) {
  const stub = makeSupabaseStub({ 'locations.select': locations });
  h.admin = stub.client;
  const lookups = await loadInventoryLookups(ORG);
  return { lookups, pages: stub.chainArgsAll.get('locations.select') ?? [], stub };
}

/** What a staff member's Location filter lists: the live service's sites. */
async function liveSites(rows: LocationRow[]) {
  const stub = makeSupabaseStub({ 'locations.select': servedLikePostgrest(rows) });
  const sites = await new LocationsService(makeServiceContext(stub.client) as never).list({
    sitesOnly: true,
  });
  return sites.map((l) => ({ id: l.id as string, name: l.name as string }));
}

describe('the cached lookups read every page of locations, as LocationsService.list does', () => {
  it("a manager's Location filter lists a site past the first 1000 locations, as a staff member's does", async () => {
    const rows = [...racks(1200), SITE];

    const { lookups, pages } = await cachedLookups(servedLikePostgrest(rows));

    expect(lookups.locations).toEqual([{ id: SITE.id, name: 'Zebra Warehouse' }]);
    expect(lookups.locations).toEqual(await liveSites(rows));
    expect(pages).toHaveLength(2);
  });

  it('pages by name and then id, from row 0 in windows of 1000, so a page boundary never repeats or skips a row', async () => {
    const { stub } = await cachedLookups(servedLikePostgrest([...racks(1200), SITE]));

    const chains = stub.chainsAll.get('locations.select') ?? [];
    const args = stub.chainArgsAll.get('locations.select') ?? [];
    const argsOf = (page: number, method: string) =>
      chains[page]!.flatMap((m, i) => (m === method ? [args[page]![i]] : []));
    expect(argsOf(0, 'order').map((a) => a![0])).toEqual(['name', 'id']);
    expect(argsOf(0, 'range')).toEqual([[0, 999]]);
    expect(argsOf(1, 'range')).toEqual([[1000, 1999]]);
    // Every page keeps the organization and the not-deleted filters.
    for (const page of [0, 1]) {
      expect(argsOf(page, 'eq')).toContainEqual(['organization_id', ORG]);
      expect(argsOf(page, 'is')).toContainEqual(['deleted_at', null]);
    }
  });

  it('under 1000 locations it is still one request', async () => {
    const { lookups, pages } = await cachedLookups(servedLikePostgrest([...racks(3), SITE]));

    expect(lookups.locations).toEqual([{ id: SITE.id, name: 'Zebra Warehouse' }]);
    expect(pages).toHaveLength(1);
  });

  it('a failed second page throws, so a partial list is never cached', async () => {
    const served = servedLikePostgrest([...racks(1200), SITE]);
    let calls = 0;
    await expect(
      cachedLookups((call) => {
        calls += 1;
        return calls === 1 ? served(call) : { data: null, error: { message: 'statement timeout' } };
      }),
    ).rejects.toThrow();
    expect(calls).toBe(2);
  });

  it('a failed page names the locations lookup and keeps the PostgREST text for the log', async () => {
    const served = servedLikePostgrest([...racks(1200), SITE]);
    let calls = 0;
    await expect(
      cachedLookups((call) => {
        calls += 1;
        return calls === 1 ? served(call) : { data: null, error: { message: 'statement timeout' } };
      }),
    ).rejects.toThrow(/inventory-list locations query failed: .*statement timeout/);
  });
});

/**
 * B47: the categories, tags, active charters and suppliers lookups were each
 * ONE read ordered by name with no range, in the cached loader and in the live
 * services alike, so past 1000 of any of them both paths lost every row whose
 * name sorts after the first 1000 (the Category, Charter and Supplier filters,
 * the row labels, bulk Set category). Both paths now read page by page,
 * ordered by name and then id. A parity check alone would pass on the old
 * code, because both paths were cut at the same 1000; the row past the first
 * 1000 and the page counts are what the old code fails.
 */
beforeEach(() => {
  h.ceiling.value = 10_000;
  h.reportError.mockClear();
});

describe('the cached lookups read every page of categories, tags, charters and suppliers, as the live services do', () => {
  const N = 1200;
  const pad = (i: number) => String(i).padStart(4, '0');
  const uuid = (prefix: string, i: number) =>
    `${prefix}-0000-4000-8000-${String(i).padStart(12, '0')}`;

  // Each list: N rows named "A … 0000" onward, one row named "Zebra …" that
  // sorts past the first 1000, and rows its filters must leave out.
  const CATEGORIES = [
    ...Array.from({ length: N }, (_, i) => ({
      id: uuid('00000000', i),
      organization_id: ORG,
      name: `A category ${pad(i)}`,
      color: i % 2 ? '#112233' : null,
      deleted_at: null,
    })),
    {
      id: uuid('ffffffff', 1),
      organization_id: ORG,
      name: 'Zebra category',
      color: null,
      deleted_at: null,
    },
    {
      id: uuid('eeeeeeee', 1),
      organization_id: ORG,
      name: 'B deleted',
      color: null,
      deleted_at: '2026-01-01T00:00:00Z',
    },
    {
      id: uuid('dddddddd', 1),
      organization_id: 'org-other',
      name: 'A other',
      color: null,
      deleted_at: null,
    },
  ];
  const TAGS = [
    ...Array.from({ length: N }, (_, i) => ({
      id: uuid('00000000', i),
      organization_id: ORG,
      name: `a tag ${pad(i)}`,
      color: null,
      created_at: '2026-01-01T00:00:00Z',
    })),
    {
      id: uuid('ffffffff', 2),
      organization_id: ORG,
      name: 'zebra tag',
      color: '#445566',
      created_at: '2026-01-01T00:00:00Z',
    },
    {
      id: uuid('dddddddd', 2),
      organization_id: 'org-other',
      name: 'a other',
      color: null,
      created_at: '2026-01-01T00:00:00Z',
    },
  ];
  const CHARTERS = [
    ...Array.from({ length: N }, (_, i) => ({
      id: uuid('00000000', i),
      organization_id: ORG,
      name: `A charter ${pad(i)}`,
      code: i % 2 ? `C${i}` : null,
      status: 'active',
      warehouses: [],
      users: [],
    })),
    {
      id: uuid('ffffffff', 3),
      organization_id: ORG,
      name: 'Zebra charter',
      code: 'Z',
      status: 'active',
      warehouses: [],
      users: [],
    },
    {
      id: uuid('eeeeeeee', 3),
      organization_id: ORG,
      name: 'B archived',
      code: null,
      status: 'archived',
      warehouses: [],
      users: [],
    },
    {
      id: uuid('eeeeeeee', 4),
      organization_id: ORG,
      name: 'B inactive',
      code: null,
      status: 'inactive',
      warehouses: [],
      users: [],
    },
    {
      id: uuid('dddddddd', 3),
      organization_id: 'org-other',
      name: 'A other',
      code: null,
      status: 'active',
      warehouses: [],
      users: [],
    },
  ];
  const SUPPLIERS = [
    ...Array.from({ length: N }, (_, i) => ({
      id: uuid('00000000', i),
      organization_id: ORG,
      name: `A supplier ${pad(i)}`,
      deleted_at: null,
    })),
    { id: uuid('ffffffff', 4), organization_id: ORG, name: 'Zebra supplier', deleted_at: null },
    {
      id: uuid('eeeeeeee', 5),
      organization_id: ORG,
      name: 'B deleted',
      deleted_at: '2026-01-01T00:00:00Z',
    },
    { id: uuid('dddddddd', 4), organization_id: 'org-other', name: 'A other', deleted_at: null },
  ];

  const TABLES = {
    categories: CATEGORIES,
    tags: TAGS,
    charters: CHARTERS,
    suppliers: SUPPLIERS,
  } as const;
  type Lookup = keyof typeof TABLES;

  /** Every lookup table served like PostgREST; the suppliers module on. */
  function stubFor(failing?: Lookup) {
    const results: Record<string, (call: MockCall) => QueryResult> = {};
    for (const table of Object.keys(TABLES) as Lookup[]) {
      const served = servedLikePostgrest(TABLES[table]);
      let calls = 0;
      results[`${table}.select`] = (call) => {
        // The archived and inactive charters' read (B97) is its own list, not
        // a page of the active one.
        if (isUnlistedChartersRead(call)) return served(call);
        calls += 1;
        return table === failing && calls === 2
          ? { data: null, error: { message: 'statement timeout' } }
          : served(call);
      };
    }
    return makeSupabaseStub({
      ...results,
      'locations.select': servedLikePostgrest([SITE]),
      // servedLikePostgrest cannot evaluate .maybeSingle(); the module gate
      // reads are static: Suppliers enabled, not comped.
      'organization_modules.select': { data: { enabled: true }, error: null },
      'organizations.select': { data: { all_modules_comp: false }, error: null },
    });
  }

  /** The loader's read of the archived and inactive charters (B97). */
  function isUnlistedChartersRead(call: Pick<MockCall, 'methods' | 'args'>) {
    return call.methods.some((m, i) => m === 'neq' && call.args[i]?.[0] === 'status');
  }

  /** A lookup's pages, as [methods, args]; for charters, the active list's. */
  function pagesOf(stub: ReturnType<typeof makeSupabaseStub>, table: Lookup, unlisted = false) {
    const chains = stub.chainsAll.get(`${table}.select`) ?? [];
    const args = stub.chainArgsAll.get(`${table}.select`) ?? [];
    return chains
      .map((methods, i) => ({ methods, args: args[i] ?? [] }))
      .filter((p) => isUnlistedChartersRead(p) === unlisted);
  }

  function argsOf(
    stub: ReturnType<typeof makeSupabaseStub>,
    table: Lookup,
    page: number,
    method: string,
    unlisted = false,
  ) {
    const { methods, args } = pagesOf(stub, table, unlisted)[page] ?? { methods: [], args: [] };
    return methods.flatMap((m, i) => (m === method ? [args[i]] : []));
  }

  /** What the live branch lists, mapped as the pages' fetchLiveLookups maps it. */
  async function liveLookups() {
    const stub = stubFor();
    const ctx = makeServiceContext(stub.client) as never;
    const [categories, suppliers, tags, charters] = await Promise.all([
      new CategoriesService(ctx).list(),
      new SuppliersService(ctx).listForLookups(),
      new TagsService(ctx).list(),
      new ChartersService(ctx).list(),
    ]);
    return {
      categories: categories.map((c) => ({
        id: c.id as string,
        name: c.name as string,
        color: (c.color as string | null) ?? null,
      })),
      suppliers: suppliers.map((s) => ({ id: s.id as string, name: s.name as string })),
      tags: tags.map((t) => ({ id: t.id, name: t.name, color: t.color })),
      charters: charters.map((c) => ({ id: c.id, name: c.name, code: c.code ?? null })),
    };
  }

  it('each list includes the row past the first 1000 by name, and equals the live service list', async () => {
    const stub = stubFor();
    h.admin = stub.client;

    const lookups = await loadInventoryLookups(ORG);

    expect(lookups.categories).toHaveLength(N + 1);
    expect(lookups.categories.at(-1)).toEqual({
      id: uuid('ffffffff', 1),
      name: 'Zebra category',
      color: null,
    });
    expect(lookups.tags).toHaveLength(N + 1);
    expect(lookups.tags.at(-1)).toEqual({
      id: uuid('ffffffff', 2),
      name: 'zebra tag',
      color: '#445566',
    });
    expect(lookups.charters).toHaveLength(N + 1);
    expect(lookups.charters.at(-1)).toEqual({
      id: uuid('ffffffff', 3),
      name: 'Zebra charter',
      code: 'Z',
    });
    expect(lookups.suppliers).toHaveLength(N + 1);
    expect(lookups.suppliers.at(-1)).toEqual({ id: uuid('ffffffff', 4), name: 'Zebra supplier' });

    const live = await liveLookups();
    expect(lookups.categories).toEqual(live.categories);
    expect(lookups.tags).toEqual(live.tags);
    expect(lookups.charters).toEqual(live.charters);
    expect(lookups.suppliers).toEqual(live.suppliers);
  });

  it('each list takes two requests by name then id, from row 0 in windows of 1000, with its filters on every page', async () => {
    const stub = stubFor();
    h.admin = stub.client;

    await loadInventoryLookups(ORG);

    for (const table of Object.keys(TABLES) as Lookup[]) {
      expect(pagesOf(stub, table), table).toHaveLength(2);
      expect(
        argsOf(stub, table, 0, 'order').map((a) => a![0]),
        table,
      ).toEqual(['name', 'id']);
      expect(argsOf(stub, table, 0, 'range'), table).toEqual([[0, 999]]);
      expect(argsOf(stub, table, 1, 'range'), table).toEqual([[1000, 1999]]);
      for (const page of [0, 1]) {
        expect(argsOf(stub, table, page, 'eq'), table).toContainEqual(['organization_id', ORG]);
      }
    }
    for (const page of [0, 1]) {
      expect(argsOf(stub, 'categories', page, 'is')).toContainEqual(['deleted_at', null]);
      expect(argsOf(stub, 'suppliers', page, 'is')).toContainEqual(['deleted_at', null]);
      expect(argsOf(stub, 'charters', page, 'eq')).toContainEqual(['status', 'active']);
    }
    // The archived and inactive charters (B97): one read here, by name then
    // id, from row 0, never the active ones.
    expect(pagesOf(stub, 'charters', true)).toHaveLength(1);
    expect(argsOf(stub, 'charters', 0, 'neq', true)).toEqual([['status', 'active']]);
    expect(argsOf(stub, 'charters', 0, 'eq', true)).toContainEqual(['organization_id', ORG]);
    expect(argsOf(stub, 'charters', 0, 'order', true).map((a) => a![0])).toEqual(['name', 'id']);
    expect(argsOf(stub, 'charters', 0, 'range', true)).toEqual([[0, 999]]);
  });

  it("names this organization's archived and inactive charters for the Charter cell, as the live service lists them (B97)", async () => {
    const stub = stubFor();
    h.admin = stub.client;

    const lookups = await loadInventoryLookups(ORG);

    expect(lookups.unlistedCharters).toEqual([
      { id: uuid('eeeeeeee', 3), name: 'B archived', code: null, status: 'archived' },
      { id: uuid('eeeeeeee', 4), name: 'B inactive', code: null, status: 'inactive' },
    ]);
    const live = await new ChartersService(
      makeServiceContext(stubFor().client) as never,
    ).listLabels({ exceptActive: true });
    expect(lookups.unlistedCharters).toEqual(live);
  });

  it.each(['categories', 'tags', 'charters', 'suppliers'] as const)(
    'a failed second page of %s rejects with a message naming the lookup and keeping the PostgREST text',
    async (table) => {
      h.admin = stubFor(table).client;

      await expect(loadInventoryLookups(ORG)).rejects.toThrow(
        new RegExp(`inventory-list ${table} query failed: .*statement timeout`),
      );
    },
  );

  /** The reports reportLookupCeiling made, as [tag, extra], by tag (the
   *  reads run in parallel, so they finish in any order). */
  const ceilingReports = () =>
    h.reportError.mock.calls
      .map((c) => c[1] as { tag: string; extra: Record<string, unknown> })
      .filter((c) => c.tag.startsWith('lookup_ceiling.'))
      .map((c) => [c.tag, c.extra] as const)
      .sort((a, b) => a[0].localeCompare(b[0]));

  it('under the ceiling nothing is reported', async () => {
    h.admin = stubFor().client;
    await loadInventoryLookups(ORG);
    await liveLookups();
    expect(ceilingReports()).toEqual([]);
  });

  /**
   * B47 decisions round (2026-11-01): each of these reads stops at
   * LOOKUP_ROW_CEILING, the first rows by name and then id, in the cached
   * loader and in the live services alike, and reports reaching it once.
   * Lowered here to 1100, so the second page is cut at row 1100.
   */
  it('at the ceiling each list is its first rows by name then id, in both paths, and each read reports it once', async () => {
    h.ceiling.value = 1100;
    const stub = stubFor();
    h.admin = stub.client;

    const lookups = await loadInventoryLookups(ORG);

    for (const table of Object.keys(TABLES) as Lookup[]) {
      expect(lookups[table], table).toHaveLength(1100);
      expect(argsOf(stub, table, 1, 'range'), table).toEqual([[1000, 1099]]);
    }
    // The first 1100 by name: the "A … 0000" onward rows, so not Zebra.
    expect(lookups.categories.at(-1)?.name).toBe('A category 1099');
    expect(lookups.tags.at(-1)?.name).toBe('a tag 1099');
    expect(lookups.charters.at(-1)?.name).toBe('A charter 1099');
    expect(lookups.suppliers.at(-1)?.name).toBe('A supplier 1099');
    expect(ceilingReports()).toEqual(
      ['categories', 'charters', 'suppliers', 'tags'].map((lookup) => [
        `lookup_ceiling.inventory_lookups.${lookup}`,
        { lookup: `inventory_lookups.${lookup}`, organizationId: ORG },
      ]),
    );

    // The live services stop at the same rows, so a manager (cached) and a
    // staff member (live) still see the same lists.
    h.reportError.mockClear();
    const live = await liveLookups();
    expect(lookups.categories).toEqual(live.categories);
    expect(lookups.tags).toEqual(live.tags);
    expect(lookups.charters).toEqual(live.charters);
    expect(lookups.suppliers).toEqual(live.suppliers);
    expect(ceilingReports()).toEqual(
      ['categories', 'charters', 'suppliers', 'tags'].map((lookup) => [
        `lookup_ceiling.${lookup}.list`,
        { lookup: `${lookup}.list`, organizationId: ORG },
      ]),
    );
  });

  it('the archived lists stop at the ceiling too', async () => {
    h.ceiling.value = 3;
    const archived = (prefix: string) =>
      Array.from({ length: 5 }, (_, i) => ({
        id: uuid(prefix, i),
        organization_id: ORG,
        name: `B archived ${i}`,
        status: 'archived',
        deleted_at: '2026-01-01T00:00:00Z',
        warehouses: [],
        users: [],
      }));
    const stub = makeSupabaseStub({
      'categories.select': servedLikePostgrest(archived('aaaaaaaa')),
      'suppliers.select': servedLikePostgrest(archived('bbbbbbbb')),
      'charters.select': servedLikePostgrest(archived('cccccccc')),
    });
    const ctx = makeServiceContext(stub.client) as never;

    const [categories, suppliers, charters] = await Promise.all([
      new CategoriesService(ctx).list({ includeArchived: true }),
      new SuppliersService(ctx).list({ includeArchived: true }),
      new ChartersService(ctx).list({ includeArchived: true }),
    ]);

    expect(categories.map((c) => c.name)).toEqual(['B archived 0', 'B archived 1', 'B archived 2']);
    expect(suppliers).toHaveLength(3);
    expect(charters).toHaveLength(3);
    expect(ceilingReports().map(([tag]) => tag)).toEqual([
      'lookup_ceiling.categories.list',
      'lookup_ceiling.charters.list',
      'lookup_ceiling.suppliers.list',
    ]);
  });
});

import { describe, expect, it, vi } from 'vitest';

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

const h = vi.hoisted(() => ({ admin: null as unknown }));

vi.mock('next/cache', () => ({
  revalidateTag: vi.fn(),
  unstable_cache: vi.fn((fn: unknown) => fn),
}));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => h.admin }));

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

  function argsOf(
    stub: ReturnType<typeof makeSupabaseStub>,
    table: Lookup,
    page: number,
    method: string,
  ) {
    const methods = stub.chainsAll.get(`${table}.select`)?.[page] ?? [];
    const args = stub.chainArgsAll.get(`${table}.select`)?.[page] ?? [];
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
      expect(stub.chainsAll.get(`${table}.select`), table).toHaveLength(2);
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
});

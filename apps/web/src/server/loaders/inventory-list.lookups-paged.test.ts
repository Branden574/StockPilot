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

import { LocationsService } from '@/server/services/locations';
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
});

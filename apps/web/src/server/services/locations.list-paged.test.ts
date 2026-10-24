import { describe, expect, it } from 'vitest';

import { makeServiceContext, makeSupabaseStub, servedLikePostgrest } from '@/test/supabase-mock';

import { LocationsService } from './locations';

/**
 * LocationsService.list was ONE read: every location kind (racks, crates,
 * areas, staging), ordered by name, with no paging, so PostgREST's 1000-row
 * cap cut it off, and only then were the sites picked out (sitesOnly). An
 * organization with more than 1000 locations lost every site whose name
 * sorts past the first 1000 rows of any kind: the New and Edit purchase
 * order pickers and the recurring form could not offer it, and Edit
 * purchase order named such a destination as one "you can't pick here"
 * (small fixes slice 8 review). The list is now read page by page, ordered by
 * name and then id, so the pages are stable.
 */

const ORG = 'org-test';

function racks(n: number) {
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

const SITE = {
  id: 'ffffffff-0000-4000-8000-000000000001',
  organization_id: ORG,
  name: 'Zebra Warehouse',
  kind: null,
  type: 'warehouse',
  warehouse_id: 'wh-1',
  deleted_at: null,
};

describe('LocationsService.list reads every page', () => {
  it('returns a site past the first 1000 rows of every kind', async () => {
    const stub = makeSupabaseStub({
      'locations.select': servedLikePostgrest([...racks(1200), SITE]),
    });
    const svc = new LocationsService(makeServiceContext(stub.client) as never);

    const sites = await svc.list({ sitesOnly: true });

    expect(sites.map((l) => l.id)).toEqual([SITE.id]);
    const pages = stub.chainArgsAll.get('locations.select') ?? [];
    expect(pages).toHaveLength(2);
    // Ordered by name, then id, so a page boundary never repeats or skips a row.
    const methods = stub.chainsAll.get('locations.select')![0]!;
    const orders = methods.flatMap((m, i) => (m === 'order' ? [pages[0]![i]![0]] : []));
    expect(orders).toEqual(['name', 'id']);
  });

  it('returns every row of a full list, each once', async () => {
    const stub = makeSupabaseStub({ 'locations.select': servedLikePostgrest(racks(2000)) });
    const svc = new LocationsService(makeServiceContext(stub.client) as never);

    const all = await svc.list();

    expect(all).toHaveLength(2000);
    expect(new Set(all.map((l) => l.id)).size).toBe(2000);
  });
});

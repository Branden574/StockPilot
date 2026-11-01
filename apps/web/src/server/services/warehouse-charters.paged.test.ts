import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./audit', () => ({ audit: vi.fn(async () => undefined) }));

import {
  inFilters,
  makeServiceContext,
  makeSupabaseStub,
  servedLikePostgrest,
  type MockCall,
  type QueryResult,
  type SupabaseStub,
} from '@/test/supabase-mock';

import { WarehouseChartersService } from './warehouse-charters';

/**
 * warehouse_charters links a warehouse to each charter (delivery site) it
 * serves. Its key is (warehouse_id, charter_id); it has no id column, and
 * archiving a charter keeps its links. Nothing caps the links, so four
 * warehouses that each serve 251 charters pass PostgREST's 1000-row max_rows.
 *
 * listPairs read every link of the organization in ONE read with no order and
 * no range: past 1000 links an arbitrary set dropped out, with no error, and
 * the item forms, Team's member Charters dialog and the warehouse page could
 * not offer those charters (B47). It now reads page by page, ordered by
 * warehouse and then charter.
 */

const ORG = 'org-test';
const W1 = '00000000-0000-4000-8000-0000000000a1';
const W2 = '00000000-0000-4000-8000-0000000000a2';
const W3 = '00000000-0000-4000-8000-0000000000a3';

const charterId = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;

function links(warehouseId: string, from: number, n: number, organizationId = ORG) {
  return Array.from({ length: n }, (_, i) => ({
    organization_id: organizationId,
    warehouse_id: warehouseId,
    charter_id: charterId(from + i),
  }));
}

function pageArgs(stub: SupabaseStub, key: string, page: number, method: string): unknown[][] {
  const methods = stub.chainsAll.get(key)?.[page] ?? [];
  const args = stub.chainArgsAll.get(key)?.[page] ?? [];
  return methods.flatMap((m, i) => (m === method ? [args[i]!] : []));
}

describe('WarehouseChartersService.listPairs reads every page', () => {
  it('returns all 1500 links across three warehouses, in two pages ordered by warehouse then charter', async () => {
    // Stored out of key order, as a table with no ORDER BY may answer.
    const all = [...links(W3, 1000, 500), ...links(W1, 0, 500), ...links(W2, 500, 500)];
    const stub = makeSupabaseStub({
      'warehouse_charters.select': servedLikePostgrest([
        ...all,
        ...links(W1, 5000, 3, 'org-other'),
      ]),
    });

    const pairs = await new WarehouseChartersService(
      makeServiceContext(stub.client) as never,
    ).listPairs();

    expect(pairs).toHaveLength(1500);
    expect(new Set(pairs.map((p) => `${p.warehouse_id}/${p.charter_id}`)).size).toBe(1500);
    expect(pairs.map((p) => p.warehouse_id).filter((w, i, a) => i === 0 || a[i - 1] !== w)).toEqual(
      [W1, W2, W3],
    );
    expect(stub.chainsAll.get('warehouse_charters.select')).toHaveLength(2);
    expect(pageArgs(stub, 'warehouse_charters.select', 0, 'order').map((a) => a[0])).toEqual([
      'warehouse_id',
      'charter_id',
    ]);
    expect(pageArgs(stub, 'warehouse_charters.select', 0, 'range')).toEqual([[0, 999]]);
    expect(pageArgs(stub, 'warehouse_charters.select', 1, 'range')).toEqual([[1000, 1999]]);
    for (const page of [0, 1]) {
      expect(pageArgs(stub, 'warehouse_charters.select', page, 'eq')).toContainEqual([
        'organization_id',
        ORG,
      ]);
    }
  });
});

/**
 * The Admin > Warehouses save sends the warehouse's whole charter list, and
 * setForWarehouse compares it with the links the warehouse has. That read had
 * no order, no range and an ignored error: past 1000 links on one warehouse it
 * stopped at 1000, so a save that changed nothing re-inserted links that
 * already existed and failed on the primary key (after the warehouse row was
 * written), and a failed read was "no links" (B47 part C). It now reads every
 * page, ordered by charter, and a failed page throws before any write.
 */
describe('WarehouseChartersService.setForWarehouse compares against every link', () => {
  const W1_LINKS = links(W1, 0, 1200);
  // Another warehouse's links to other charters: never compared, never removed.
  const W2_LINKS = links(W2, 2000, 300);

  let writes: { inserts: MockCall[]; deletes: MockCall[]; counts: MockCall[] };

  beforeEach(() => {
    writes = { inserts: [], deletes: [], counts: [] };
  });

  function stubWith(select: (call: MockCall) => QueryResult) {
    return makeSupabaseStub({
      'warehouse_charters.select': select,
      'warehouse_charters.insert': (call) => {
        writes.inserts.push(call);
        return { data: null, error: null };
      },
      'warehouse_charters.delete': (call) => {
        writes.deletes.push(call);
        return { data: null, error: null };
      },
      'inventory_items.select': (call) => {
        writes.counts.push(call);
        return { data: null, error: null, count: 0 };
      },
    });
  }

  function service(stub: SupabaseStub) {
    return new WarehouseChartersService(makeServiceContext(stub.client) as never);
  }

  const served = servedLikePostgrest([...W1_LINKS, ...W2_LINKS]);
  const w1Ids = W1_LINKS.map((l) => l.charter_id);

  it('the same 1200 charters: no insert, no count, no delete', async () => {
    const stub = stubWith(served);

    await service(stub).setForWarehouse(W1, w1Ids);

    expect(writes.inserts).toEqual([]);
    expect(writes.counts).toEqual([]);
    expect(writes.deletes).toEqual([]);
    // Every page keeps the organization and the warehouse, ordered by charter.
    const pages = stub.chainsAll.get('warehouse_charters.select') ?? [];
    expect(pages).toHaveLength(2);
    expect(pageArgs(stub, 'warehouse_charters.select', 0, 'order').map((a) => a[0])).toEqual([
      'charter_id',
    ]);
    for (const page of [0, 1]) {
      expect(pageArgs(stub, 'warehouse_charters.select', page, 'eq')).toEqual(
        expect.arrayContaining([
          ['organization_id', ORG],
          ['warehouse_id', W1],
        ]),
      );
    }
  });

  it('one charter unticked: one count and one delete, each for exactly that charter, and no insert', async () => {
    const unticked = w1Ids[1100]!;

    await service(stubWith(served)).setForWarehouse(
      W1,
      w1Ids.filter((id) => id !== unticked),
    );

    expect(writes.inserts).toEqual([]);
    expect(writes.counts).toHaveLength(1);
    expect(inFilters(writes.counts[0]!)).toEqual([['charter_id', [unticked]]]);
    expect(writes.deletes).toHaveLength(1);
    expect(inFilters(writes.deletes[0]!)).toEqual([['charter_id', [unticked]]]);
  });

  it('one charter added: one insert of exactly that link, and no delete', async () => {
    const added = charterId(9999);

    await service(stubWith(served)).setForWarehouse(W1, [...w1Ids, added]);

    expect(writes.inserts).toHaveLength(1);
    expect(writes.inserts[0]!.args[0]![0]).toEqual([
      { organization_id: ORG, warehouse_id: W1, charter_id: added },
    ]);
    expect(writes.counts).toEqual([]);
    expect(writes.deletes).toEqual([]);
  });

  it('a failed second page of the current links rejects with internal_error before any write', async () => {
    let calls = 0;
    const stub = stubWith((call) => {
      calls += 1;
      return calls === 1 ? served(call) : { data: null, error: { message: 'statement timeout' } };
    });

    await expect(service(stub).setForWarehouse(W1, w1Ids)).rejects.toMatchObject({
      code: 'internal_error',
      internalDetail: expect.stringContaining('statement timeout'),
    });
    expect(writes.inserts).toEqual([]);
    expect(writes.counts).toEqual([]);
    expect(writes.deletes).toEqual([]);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { ceiling, reportError } = vi.hoisted(() => ({
  // The shared LOOKUP_ROW_CEILING, lowered by the ceiling tests.
  ceiling: { value: 10_000 },
  reportError: vi.fn(async (..._args: unknown[]) => {}),
}));

vi.mock('./audit', () => ({ audit: vi.fn(async () => undefined) }));
vi.mock('@/lib/error-reporter', () => ({ reportError }));
// A getter, so a test can lower the ceiling: the service reads the binding on
// every call.
vi.mock('@/server/services/lib/lookup-ceiling', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/services/lib/lookup-ceiling')>()),
  get LOOKUP_ROW_CEILING() {
    return ceiling.value;
  },
}));

import {
  callArgs,
  countedLikePostgrest,
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

beforeEach(() => {
  ceiling.value = 10_000;
  reportError.mockClear();
});

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
    // Under the ceiling: nothing to report.
    expect(reportError).not.toHaveBeenCalled();
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

  // The links, and the organization's link count a save that removes a link
  // reads (a head count, answered as PostgREST answers one).
  const served = countedLikePostgrest([...W1_LINKS, ...W2_LINKS]);
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

/**
 * B47 decisions round (2026-11-01, integrator_decision_ceiling_1101): every
 * paged read B47 added stops at LOOKUP_ROW_CEILING, reports reaching it, and
 * a save that would act on a list cut there refuses in plain words instead.
 */
describe('at LOOKUP_ROW_CEILING', () => {
  it('listPairs answers the first links by warehouse then charter, and reports it once', async () => {
    ceiling.value = 1100;
    const all = [...links(W3, 1000, 500), ...links(W1, 0, 500), ...links(W2, 500, 500)];
    const stub = makeSupabaseStub({ 'warehouse_charters.select': servedLikePostgrest(all) });

    const pairs = await new WarehouseChartersService(
      makeServiceContext(stub.client) as never,
    ).listPairs();

    expect(pairs).toHaveLength(1100);
    // W1's 500, W2's 500, then W3's first 100 by charter.
    expect(pairs.filter((p) => p.warehouse_id === W3).map((p) => p.charter_id)).toEqual(
      links(W3, 1000, 100).map((l) => l.charter_id),
    );
    expect(pageArgs(stub, 'warehouse_charters.select', 0, 'range')).toEqual([[0, 999]]);
    expect(pageArgs(stub, 'warehouse_charters.select', 1, 'range')).toEqual([[1000, 1099]]);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0]?.[1]).toMatchObject({
      tag: 'lookup_ceiling.warehouse_charters.list_pairs',
      extra: { lookup: 'warehouse_charters.list_pairs', organizationId: ORG },
    });
  });

  describe('setForWarehouse', () => {
    const W1_LINKS = links(W1, 0, 1200);
    const W2_LINKS = links(W2, 2000, 300);
    const w1Ids = W1_LINKS.map((l) => l.charter_id);
    const added = charterId(9999);

    let writes: { inserts: MockCall[]; deletes: MockCall[]; counts: MockCall[] };

    beforeEach(() => {
      writes = { inserts: [], deletes: [], counts: [] };
    });

    /** Items at warehouses, deleted ones included, for the items count. */
    function stubWith(opts: {
      links?: (call: MockCall) => QueryResult;
      items?: Array<Record<string, unknown>>;
      itemsCount?: (call: MockCall) => QueryResult;
    }) {
      const itemsCounted = countedLikePostgrest(opts.items ?? []);
      return makeSupabaseStub({
        'warehouse_charters.select': opts.links ?? countedLikePostgrest([...W1_LINKS, ...W2_LINKS]),
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
          return (opts.itemsCount ?? itemsCounted)(call);
        },
      });
    }

    const service = (stub: SupabaseStub) =>
      new WarehouseChartersService(makeServiceContext(stub.client) as never);

    it("refuses when the warehouse's own links reach the ceiling, before any write, and reports it", async () => {
      ceiling.value = 1100;
      const stub = stubWith({});

      // The same list back, plus one new charter: nothing may be compared
      // against part of the warehouse's links.
      await expect(service(stub).setForWarehouse(W1, [...w1Ids, added])).rejects.toMatchObject({
        code: 'conflict',
        message:
          'This warehouse is linked to 1,100 or more charters, more than this page can check, so nothing was saved.',
      });
      expect(writes).toEqual({ inserts: [], deletes: [], counts: [] });
      expect(pageArgs(stub, 'warehouse_charters.select', 1, 'range')).toEqual([[1000, 1099]]);
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError.mock.calls[0]?.[1]).toMatchObject({
        tag: 'lookup_ceiling.warehouse_charters.set_for_warehouse',
        extra: { lookup: 'warehouse_charters.set_for_warehouse', warehouseId: W1 },
      });
    });

    it("a save that removes a link refuses while the organization's links reach the ceiling: the editor's list may be cut", async () => {
      // W1's own 1200 links are under it; the organization's 1500 are not.
      ceiling.value = 1400;
      const stub = stubWith({});

      await expect(
        service(stub).setForWarehouse(W1, [...w1Ids.slice(1), added]),
      ).rejects.toMatchObject({
        code: 'conflict',
        message:
          'This organization has 1,400 or more warehouse charter links, more than this page can list, so a charter cannot be removed from a warehouse here. Nothing was saved.',
      });
      expect(writes).toEqual({ inserts: [], deletes: [], counts: [] });
      // The count is the organization's, as WarehousesService.list reads it.
      const count = (stub.chainsAll.get('warehouse_charters.select') ?? []).length - 1;
      expect(pageArgs(stub, 'warehouse_charters.select', count, 'select')).toEqual([
        ['charter_id', { count: 'exact', head: true }],
      ]);
      expect(pageArgs(stub, 'warehouse_charters.select', count, 'eq')).toEqual([
        ['organization_id', ORG],
      ]);
    });

    it('a save that only adds goes ahead at the ceiling', async () => {
      ceiling.value = 1400;

      await service(stubWith({})).setForWarehouse(W1, [...w1Ids, added]);

      expect(writes.inserts).toHaveLength(1);
      expect(writes.inserts[0]!.args[0]![0]).toEqual([
        { organization_id: ORG, warehouse_id: W1, charter_id: added },
      ]);
      expect(writes.deletes).toEqual([]);
    });

    it('a links count that fails refuses in plain words, before any write', async () => {
      const served = countedLikePostgrest([...W1_LINKS, ...W2_LINKS]);
      const stub = stubWith({
        links: (call) =>
          (callArgs(call, 'select')?.[1] as { head?: boolean } | undefined)?.head
            ? { data: null, error: { message: 'statement timeout' } }
            : served(call),
      });

      await expect(
        service(stub).setForWarehouse(W1, [...w1Ids.slice(1), added]),
      ).rejects.toMatchObject({
        code: 'conflict',
        message:
          "Could not check this organization's warehouse charter links, so nothing was saved. Try again.",
      });
      expect(writes).toEqual({ inserts: [], deletes: [], counts: [] });
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError.mock.calls[0]?.[1]).toMatchObject({
        tag: 'warehouse_charters.save_check',
        extra: { warehouseId: W1, check: 'links' },
      });
      expect(String((reportError.mock.calls[0]?.[0] as unknown as Error).message)).toContain(
        'statement timeout',
      );
    });

    it('counts deleted items too, as the foreign key does, and says how to clear them, before any write', async () => {
      const removed = w1Ids[1100]!;
      const stub = stubWith({
        items: [
          // Only a deleted item still holds the removed charter here.
          {
            id: 'item-deleted',
            organization_id: ORG,
            warehouse_id: W1,
            charter_id: removed,
            deleted_at: '2026-10-01T00:00:00Z',
          },
          // The same charter at another warehouse does not block W1.
          {
            id: 'item-elsewhere',
            organization_id: ORG,
            warehouse_id: W2,
            charter_id: removed,
            deleted_at: null,
          },
        ],
      });

      await expect(
        service(stub).setForWarehouse(W1, [...w1Ids.filter((id) => id !== removed), added]),
      ).rejects.toMatchObject({
        code: 'conflict',
        message:
          'Cannot remove a charter: 1 item at this warehouse, deleted ones included, is still tagged to it. Move it to another charter or warehouse, or restore deleted ones from Settings > Recovery and retag them. Nothing was saved.',
      });
      // The added charter is not inserted either: the refusal comes first.
      expect(writes.inserts).toEqual([]);
      expect(writes.deletes).toEqual([]);
      expect(writes.counts).toHaveLength(1);
      expect(inFilters(writes.counts[0]!)).toEqual([['charter_id', [removed]]]);
      expect(writes.counts[0]!.methods).not.toContain('is');
    });

    it('several items: the count and the plural words', async () => {
      const removed = [w1Ids[5]!, w1Ids[6]!];
      const stub = stubWith({
        items: [
          {
            id: 'i1',
            organization_id: ORG,
            warehouse_id: W1,
            charter_id: removed[0],
            deleted_at: null,
          },
          {
            id: 'i2',
            organization_id: ORG,
            warehouse_id: W1,
            charter_id: removed[1],
            deleted_at: null,
          },
          {
            id: 'i3',
            organization_id: ORG,
            warehouse_id: W1,
            charter_id: removed[1],
            deleted_at: '2026-10-01T00:00:00Z',
          },
        ],
      });

      await expect(
        service(stub).setForWarehouse(
          W1,
          w1Ids.filter((id) => !removed.includes(id)),
        ),
      ).rejects.toMatchObject({
        message:
          'Cannot remove a charter: 3 items at this warehouse, deleted ones included, are still tagged to it. Move them to another charter or warehouse, or restore deleted ones from Settings > Recovery and retag them. Nothing was saved.',
      });
      expect(writes.deletes).toEqual([]);
    });

    it('an items count that fails refuses in plain words, before any write', async () => {
      const stub = stubWith({
        itemsCount: () => ({ data: null, error: { message: 'permission denied for table x' } }),
      });

      await expect(
        service(stub).setForWarehouse(W1, [...w1Ids.slice(1), added]),
      ).rejects.toMatchObject({
        code: 'conflict',
        message:
          'Could not check which items use the charters you removed, so nothing was saved. Try again.',
      });
      expect(writes.inserts).toEqual([]);
      expect(writes.deletes).toEqual([]);
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError.mock.calls[0]?.[1]).toMatchObject({
        tag: 'warehouse_charters.save_check',
        extra: { warehouseId: W1, check: 'items' },
      });
    });

    it('an items count with no number in the answer refuses too', async () => {
      const stub = stubWith({ itemsCount: () => ({ data: null, error: null }) });

      await expect(service(stub).setForWarehouse(W1, w1Ids.slice(1))).rejects.toMatchObject({
        code: 'conflict',
      });
      expect(writes.deletes).toEqual([]);
    });
  });
});

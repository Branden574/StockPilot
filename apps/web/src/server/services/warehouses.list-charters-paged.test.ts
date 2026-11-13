import { beforeEach, describe, expect, it, vi } from 'vitest';

const { ceiling, reportError } = vi.hoisted(() => ({
  // The shared LOOKUP_ROW_CEILING, lowered by the ceiling tests.
  ceiling: { value: 10_000 },
  reportError: vi.fn(async (..._args: unknown[]) => {}),
}));

vi.mock('./audit', () => ({ audit: vi.fn(async () => undefined) }));
vi.mock('@/lib/error-reporter', () => ({ reportError }));
// A getter, so a test can lower the ceiling: the services read the binding on
// every call.
vi.mock('@/server/services/lib/lookup-ceiling', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/services/lib/lookup-ceiling')>()),
  get LOOKUP_ROW_CEILING() {
    return ceiling.value;
  },
}));

import {
  countedLikePostgrest,
  makeServiceContext,
  makeSupabaseStub,
  servedLikePostgrest,
  type MockCall,
  type QueryResult,
  type SupabaseStub,
} from '@/test/supabase-mock';

import { WarehouseChartersService } from './warehouse-charters';
import { WarehousesService } from './warehouses';

/**
 * Admin > Warehouses opens a warehouse's editor with the charters
 * WarehousesService.list gives it, and every save sends that list back to
 * setForWarehouse, which compares it with the links the warehouse has. Both
 * sides must be complete: if setForWarehouse read every link while list() gave
 * the editor a list cut at 1000 (list() took them from a to-many embed, which
 * PostgREST may cut like any response), a save that changed nothing would
 * DELETE the links nobody unticked, and the cascade would remove the staff
 * charter assignments on them (B47 part C). list() now builds each warehouse's
 * charters from a paged read of the links, ordered by warehouse and then
 * charter, so the editor starts from every link.
 */

const ORG = 'org-test';
const W1 = '00000000-0000-4000-8000-0000000000a1';
const W2 = '00000000-0000-4000-8000-0000000000a2';
const ARCHIVED_CHARTER = 'aaaaaaaa-0000-4000-8000-000000000001';

const charterId = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;

/** Links as the paged read embeds them: the charter's id and name. */
function links(warehouseId: string, from: number, n: number) {
  return Array.from({ length: n }, (_, i) => ({
    organization_id: ORG,
    warehouse_id: warehouseId,
    charter_id: charterId(from + i),
    charter: { id: charterId(from + i), name: `Site ${String(from + i).padStart(4, '0')}` },
  }));
}

// W1 serves 1200 charters, one of them archived (archiving keeps its link,
// and the editor must keep it named). W2 serves 300 others.
const W1_LINKS = [
  ...links(W1, 0, 1199),
  {
    organization_id: ORG,
    warehouse_id: W1,
    charter_id: ARCHIVED_CHARTER,
    charter: { id: ARCHIVED_CHARTER, name: 'Archived site' },
  },
];
const W2_LINKS = links(W2, 2000, 300);
const LINKS = [...W1_LINKS, ...W2_LINKS];

function warehouse(id: string, name: string) {
  return {
    id,
    organization_id: ORG,
    name,
    code: name.toUpperCase(),
    contact_name: null,
    contact_email: null,
    contact_phone: null,
    manager_user_id: null,
    status: 'active',
    notes: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    manager: null,
    assignments: [],
    items: [],
    // What a to-many embed would carry if PostgREST cut it at 1000: list()
    // must not build the editor's list from it.
    wh_charters: LINKS.filter((l) => l.warehouse_id === id)
      .slice(0, 1000)
      .map((l) => ({ charter: l.charter })),
  };
}

const WAREHOUSES = [warehouse(W1, 'North'), warehouse(W2, 'South')];

function pageArgs(stub: SupabaseStub, key: string, page: number, method: string): unknown[][] {
  const methods = stub.chainsAll.get(key)?.[page] ?? [];
  const args = stub.chainArgsAll.get(key)?.[page] ?? [];
  return methods.flatMap((m, i) => (m === method ? [args[i]!] : []));
}

beforeEach(() => {
  ceiling.value = 10_000;
  reportError.mockClear();
});

describe('WarehousesService.list builds each warehouse charters from every link', () => {
  let writes: MockCall[];

  beforeEach(() => {
    writes = [];
  });

  function stubWith(linksSelect: (call: MockCall) => QueryResult) {
    const record = (call: MockCall) => {
      writes.push(call);
      return { data: null, error: null, count: 0 };
    };
    return makeSupabaseStub({
      'warehouses.select': servedLikePostgrest(WAREHOUSES),
      'warehouse_charters.select': linksSelect,
      'warehouse_charters.insert': record,
      'warehouse_charters.delete': record,
      'inventory_items.select': record,
    });
  }

  it('gives W1 all 1200 charters sorted by name, the archived one named, and W2 its own 300', async () => {
    const stub = stubWith(servedLikePostgrest(LINKS));

    const list = await new WarehousesService(makeServiceContext(stub.client) as never).list();

    const north = list.find((w) => w.id === W1)!;
    const south = list.find((w) => w.id === W2)!;
    expect(north.charters).toHaveLength(1200);
    expect(north.charters[0]).toEqual({ id: ARCHIVED_CHARTER, name: 'Archived site' });
    expect(north.charters.map((c) => c.name)).toEqual(
      [...north.charters.map((c) => c.name)].sort((a, b) => a.localeCompare(b)),
    );
    expect(south.charters.map((c) => c.id).sort()).toEqual(
      W2_LINKS.map((l) => l.charter_id).sort(),
    );
    // The links are their own paged read, ordered by warehouse then charter,
    // and the warehouses read no longer embeds them.
    expect(stub.chainsAll.get('warehouse_charters.select')).toHaveLength(2);
    expect(pageArgs(stub, 'warehouse_charters.select', 0, 'order').map((a) => a[0])).toEqual([
      'warehouse_id',
      'charter_id',
    ]);
    for (const page of [0, 1]) {
      expect(pageArgs(stub, 'warehouse_charters.select', page, 'eq')).toContainEqual([
        'organization_id',
        ORG,
      ]);
    }
    const warehousesSelect = String(pageArgs(stub, 'warehouses.select', 0, 'select')[0]?.[0] ?? '');
    expect(warehousesSelect).not.toMatch(/warehouse_charters/);
  });

  it("round trip: saving the editor's list unchanged writes nothing", async () => {
    const stub = stubWith(servedLikePostgrest(LINKS));
    const ctx = makeServiceContext(stub.client) as never;

    const list = await new WarehousesService(ctx).list();
    const ids = list.find((w) => w.id === W1)!.charters.map((c) => c.id);
    await new WarehouseChartersService(ctx).setForWarehouse(W1, ids);

    expect(ids).toHaveLength(1200);
    expect(writes).toEqual([]);
  });

  it('a failed links page makes list() reject with internal_error', async () => {
    const served = servedLikePostgrest(LINKS);
    let calls = 0;
    const stub = stubWith((call) => {
      calls += 1;
      return calls === 1 ? served(call) : { data: null, error: { message: 'statement timeout' } };
    });

    await expect(
      new WarehousesService(makeServiceContext(stub.client) as never).list(),
    ).rejects.toMatchObject({
      code: 'internal_error',
      internalDetail: expect.stringContaining('statement timeout'),
    });
  });
});

/**
 * B47 decisions round (2026-11-01): the links read stops at
 * LOOKUP_ROW_CEILING for the whole organization and reports it. The editor
 * then starts from a cut list, so its save must refuse instead of removing
 * the links it could not show; and every refusal of the charter list comes
 * before the warehouse row is written (lead L-7).
 */
describe('Admin > Warehouses at LOOKUP_ROW_CEILING, and the order of the save', () => {
  let writes: { rows: MockCall[]; links: MockCall[]; counts: MockCall[] };

  beforeEach(() => {
    writes = { rows: [], links: [], counts: [] };
  });

  function stubWith(opts: { items?: Array<Record<string, unknown>> } = {}) {
    const itemsCounted = countedLikePostgrest(opts.items ?? []);
    const record = (into: MockCall[]) => (call: MockCall) => {
      into.push(call);
      return { data: null, error: null };
    };
    return makeSupabaseStub({
      'warehouses.select': servedLikePostgrest(WAREHOUSES),
      // The save asks its changed row back; one row answers it.
      'warehouses.update': (call) => {
        writes.rows.push(call);
        return { data: [{ id: W1 }], error: null };
      },
      'warehouse_charters.select': countedLikePostgrest(LINKS),
      'warehouse_charters.insert': record(writes.links),
      'warehouse_charters.delete': record(writes.links),
      'inventory_items.select': (call) => {
        writes.counts.push(call);
        return itemsCounted(call);
      },
    });
  }

  it("list(): the first links by warehouse then charter, the organization's ceiling reported once", async () => {
    ceiling.value = 1100;
    const stub = stubWith();

    const list = await new WarehousesService(makeServiceContext(stub.client) as never).list();

    // W1 sorts first: its first 1100 links by charter (the archived charter's
    // id sorts last, so it is past the ceiling); W2 gets none of its 300.
    const north = list.find((w) => w.id === W1)!;
    expect(north.charters).toHaveLength(1100);
    expect(north.charters.map((c) => c.id)).not.toContain(ARCHIVED_CHARTER);
    expect(list.find((w) => w.id === W2)!.charters).toEqual([]);
    expect(pageArgs(stub, 'warehouse_charters.select', 1, 'range')).toEqual([[1000, 1099]]);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0]?.[1]).toMatchObject({
      tag: 'lookup_ceiling.warehouses.list.charter_links',
      extra: { lookup: 'warehouses.list.charter_links', organizationId: ORG },
    });
  });

  it.each([
    // W2's 300 links are rows 1200-1499 of the organization's read: the
    // editor shows 200 of them, though W2's own read (300) is under it.
    ['W2, whose list the ceiling cuts', 1400, W2, 200, '1,400 or more warehouse charter links'],
    ['W2, past the ceiling altogether', 1100, W2, 0, '1,100 or more warehouse charter links'],
    // W1's own 1200 links reach it: the save cannot compare against them.
    ['W1, whose own links reach it', 1100, W1, 1100, 'This warehouse is linked to 1,100 or more'],
  ] as const)(
    "saving the editor's list unchanged for %s refuses: no row, no link written",
    async (_label, at, warehouseId, shown, words) => {
      ceiling.value = at;
      const stub = stubWith();
      const ctx = makeServiceContext(stub.client) as never;

      const list = await new WarehousesService(ctx).list();
      const ids = list.find((w) => w.id === warehouseId)!.charters.map((c) => c.id);
      expect(ids).toHaveLength(shown);

      await expect(
        new WarehousesService(ctx).update(warehouseId, { name: 'Renamed', charterIds: ids }),
      ).rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining(words) });
      expect(writes).toEqual({ rows: [], links: [], counts: [] });
    },
  );

  it('a charter save refused for items still tagged to it writes no warehouse row (L-7: the refusal comes first)', async () => {
    const removed = W1_LINKS[3]!.charter_id;
    const stub = stubWith({
      items: [
        {
          id: 'item-1',
          organization_id: ORG,
          warehouse_id: W1,
          charter_id: removed,
          deleted_at: null,
        },
      ],
    });
    const ids = W1_LINKS.map((l) => l.charter_id).filter((id) => id !== removed);

    await expect(
      new WarehousesService(makeServiceContext(stub.client) as never).update(W1, {
        name: 'North renamed',
        charterIds: [...ids, '00000000-0000-4000-8000-000000009999'],
      }),
    ).rejects.toMatchObject({
      code: 'conflict',
      message: expect.stringContaining('Cannot remove a charter'),
    });
    // Not the rename, not the added link, not the removal.
    expect(writes.rows).toEqual([]);
    expect(writes.links).toEqual([]);
    expect(writes.counts).toHaveLength(1);
  });

  it('a save that passes its checks writes the row, then the links', async () => {
    const removed = W1_LINKS[3]!.charter_id;
    const stub = stubWith();
    const ids = W1_LINKS.map((l) => l.charter_id).filter((id) => id !== removed);

    await new WarehousesService(makeServiceContext(stub.client) as never).update(W1, {
      name: 'North renamed',
      charterIds: ids,
    });

    expect(writes.rows).toHaveLength(1);
    expect(writes.rows[0]!.args[0]![0]).toEqual({ name: 'North renamed' });
    expect(writes.links).toHaveLength(1);
    expect(writes.links[0]!.op).toBe('delete');
  });
});

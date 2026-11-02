import { beforeEach, describe, expect, it, vi } from 'vitest';

const { audit, mockWithContext, reportError } = vi.hoisted(() => ({
  audit: vi.fn(async (..._args: unknown[]) => {}),
  mockWithContext: vi.fn(),
  reportError: vi.fn(async (..._args: unknown[]) => {}),
}));
vi.mock('./audit', () => ({ audit }));
vi.mock('@/lib/error-reporter', () => ({ reportError }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
// The real gates and ServiceError; only the request context is the test's.
vi.mock('@/server/services/context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/services/context')>()),
  withContext: mockWithContext,
}));

import { effectivePermissions, type Role } from '@stockpilot/core';

import { updateWarehouseAction } from '@/server/actions/warehouses';
import {
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
import { WarehousesService } from './warehouses';

/**
 * A warehouse's charter links (B99). wc_admin_write (0321) lets only admins
 * write warehouse_charters: for a member below admin given organization:update
 * the link INSERT is refused with 42501 and the DELETE removes nothing with no
 * error. The DELETE asked for no rows back, so the save went on, and its audit
 * row said the links were changed.
 *
 * The save now checks owner or admin first, asks the DELETE for the rows it
 * removed, re-reads once when fewer come back than it asked for (another admin
 * may have removed them first), and refuses only when some are still there.
 * When part of the save had landed, the audit row says what is in place.
 */

const ORG = 'org-test';
const WH = '00000000-0000-4000-8000-0000000000a1';
const C1 = '00000000-0000-4000-8000-0000000000c1';
const C2 = '00000000-0000-4000-8000-0000000000c2';
const C3 = '00000000-0000-4000-8000-0000000000c3';

const W1 = 'Only owners and admins can change warehouses and charters. Nothing was saved.';
const W3 = 'Nothing was saved. Reload the page and try again.';
const W4 = 'Part of this change was not saved. Reload the page to see what was saved.';

const REFUSED_BY_POLICY: QueryResult = {
  data: null,
  error: {
    message: 'new row violates row-level security policy for table "warehouse_charters"',
    code: '42501',
  },
};

const grant = [{ permission: 'organization:update' as const, granted: true }];

function memberCtx(stub: SupabaseStub, role: Role, overrides = [] as typeof grant) {
  return makeServiceContext(stub.client, {
    role: role as 'owner' | 'admin' | 'manager' | 'staff' | 'viewer',
    permissions: effectivePermissions(role, overrides),
  }) as never;
}

interface Recorded {
  warehouseUpdates: MockCall[];
  linkInserts: MockCall[];
  linkDeletes: MockCall[];
  itemCounts: MockCall[];
}

/**
 * The links as the table holds them, and the writes. The DELETE removes and
 * returns what `deleteRemoves` lets it (all it was asked for by default);
 * `beforeDelete` changes the table first, as another admin's save would;
 * `linkDelete` answers the DELETE with an error instead, removing nothing;
 * `linksReRead` answers the links read with an `.in` filter (the re-read
 * after a DELETE that answered fewer rows than it was asked to remove)
 * instead of the table.
 */
function stubWith(opts: {
  links: string[];
  linkInsert?: QueryResult;
  linkDelete?: QueryResult;
  linksReRead?: QueryResult;
  deleteRemoves?: (asked: string[]) => string[];
  beforeDelete?: (links: string[]) => string[];
}) {
  let table = opts.links.map((charter_id) => ({
    organization_id: ORG,
    warehouse_id: WH,
    charter_id,
  }));
  const recorded: Recorded = {
    warehouseUpdates: [],
    linkInserts: [],
    linkDeletes: [],
    itemCounts: [],
  };
  const stub = makeSupabaseStub({
    // The warehouse itself, this organization's.
    'warehouses.select': servedLikePostgrest([{ id: WH, organization_id: ORG }]),
    'warehouses.update': (call) => {
      recorded.warehouseUpdates.push(call);
      return { data: [{ id: WH }], error: null };
    },
    'warehouse_charters.select': (call) =>
      opts.linksReRead && call.methods.includes('in')
        ? opts.linksReRead
        : countedLikePostgrest(() => table)(call),
    'warehouse_charters.insert': (call) => {
      recorded.linkInserts.push(call);
      const result = opts.linkInsert ?? { data: null, error: null };
      if (!result.error) table = [...table, ...(call.args[0]![0] as typeof table)];
      return result;
    },
    'warehouse_charters.delete': (call) => {
      recorded.linkDeletes.push(call);
      if (opts.linkDelete) return opts.linkDelete;
      if (opts.beforeDelete) {
        const keep = opts.beforeDelete(table.map((r) => r.charter_id));
        table = table.filter((r) => keep.includes(r.charter_id));
      }
      const asked = (inFilters(call)[0]?.[1] ?? []) as string[];
      const removed = (opts.deleteRemoves ?? ((ids: string[]) => ids))(asked).filter((id) =>
        table.some((r) => r.charter_id === id),
      );
      table = table.filter((r) => !removed.includes(r.charter_id));
      return { data: removed.map((charter_id) => ({ charter_id })), error: null };
    },
    'inventory_items.select': (call) => {
      recorded.itemCounts.push(call);
      return { data: null, error: null, count: 0 };
    },
  });
  return { stub, recorded, links: () => table.map((r) => r.charter_id) };
}

const editorSave = (charterIds: string[], name = 'North DC') => ({
  name,
  code: 'NDC',
  charterIds,
  managerUserId: null,
  status: 'active' as const,
});

const auditEvents = () => audit.mock.calls.map((c) => (c[0] as { event: string }).event);

/** The last read of warehouse_charters, as a MockCall. */
function lastLinksRead(stub: SupabaseStub): MockCall {
  return {
    table: 'warehouse_charters',
    op: 'select',
    methods: stub.chainsAll.get('warehouse_charters.select')!.at(-1)!,
    args: stub.chainArgsAll.get('warehouse_charters.select')!.at(-1)!,
  };
}

beforeEach(() => {
  audit.mockClear();
  reportError.mockClear();
  mockWithContext.mockReset();
});

describe('WarehouseChartersService refuses a member below admin first', () => {
  it('prepareSetForWarehouse: a manager granted organization:update is refused before the links read', async () => {
    const { stub, recorded } = stubWith({
      links: [C1],
      linkInsert: REFUSED_BY_POLICY,
      deleteRemoves: () => [],
    });

    await expect(
      new WarehouseChartersService(memberCtx(stub, 'manager', grant)).prepareSetForWarehouse(WH, [
        C2,
      ]),
    ).rejects.toMatchObject({ code: 'forbidden', message: W1 });

    expect(stub.chainsAll.get('warehouse_charters.select')).toBeUndefined();
    expect(recorded.itemCounts).toEqual([]);
    expect(recorded.linkInserts).toEqual([]);
    expect(recorded.linkDeletes).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it('setForWarehouse: the same refusal, with nothing read or written', async () => {
    const { stub, recorded } = stubWith({
      links: [C1],
      linkInsert: REFUSED_BY_POLICY,
      deleteRemoves: () => [],
    });

    await expect(
      new WarehouseChartersService(memberCtx(stub, 'manager', grant)).setForWarehouse(WH, []),
    ).rejects.toMatchObject({ code: 'forbidden', message: W1 });

    expect(stub.chainsAll.get('warehouse_charters.select')).toBeUndefined();
    expect(recorded.linkDeletes).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });
});

describe('a link DELETE that removes nothing', () => {
  it('with nothing else of the save landed: W3, and no audit row with the unchanged list', async () => {
    const { stub, recorded, links } = stubWith({ links: [C1, C2], deleteRemoves: () => [] });

    await expect(
      new WarehouseChartersService(memberCtx(stub, 'admin')).setForWarehouse(WH, [C1]),
    ).rejects.toMatchObject({ code: 'conflict', message: W3 });

    expect(recorded.linkDeletes).toHaveLength(1);
    expect(recorded.linkDeletes[0]!.methods).toContain('select');
    // The re-read after it asked only for the link the save removes.
    expect(inFilters(lastLinksRead(stub))).toEqual([['charter_id', [C2]]]);
    expect(links()).toEqual([C1, C2]);
    expect(audit).not.toHaveBeenCalled();
  });

  it('after the row change landed (WarehousesService.update): W4, one warehouse.updated row and no link row', async () => {
    const { stub, recorded } = stubWith({ links: [C1, C2], deleteRemoves: () => [] });

    await expect(
      new WarehousesService(memberCtx(stub, 'admin')).update(WH, editorSave([C1], 'Renamed')),
    ).rejects.toMatchObject({ code: 'conflict', message: W4 });

    expect(recorded.warehouseUpdates).toHaveLength(1);
    expect(auditEvents()).toEqual(['warehouse.updated']);
    expect(audit.mock.calls[0]![0]).toMatchObject({
      event: 'warehouse.updated',
      after: { name: 'Renamed', code: 'NDC', managerUserId: null, status: 'active' },
    });
    expect((audit.mock.calls[0]![0] as { after: object }).after).not.toHaveProperty('charterIds');
  });

  it('after the INSERT landed: the audit row names the links now in place, then W4', async () => {
    const { stub, recorded, links } = stubWith({ links: [C1, C2], deleteRemoves: () => [] });

    // Add C3, remove C2: C3 lands, C2 stays.
    await expect(
      new WarehouseChartersService(memberCtx(stub, 'admin')).setForWarehouse(WH, [C1, C3]),
    ).rejects.toMatchObject({ code: 'conflict', message: W4 });

    expect(recorded.linkInserts).toHaveLength(1);
    expect(links()).toEqual([C1, C2, C3]);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls[0]![0]).toEqual({
      event: 'warehouse_charters.updated',
      entityType: 'warehouse',
      entityId: WH,
      before: { charterIds: [C1, C2] },
      after: { charterIds: [C1, C3, C2] },
    });
  });

  it('a link another admin removed first is not a refusal: the save goes through and is audited once', async () => {
    // The save removes C2 and C3; C3 was already gone when the DELETE ran.
    const { stub, links } = stubWith({
      links: [C1, C2, C3],
      beforeDelete: (current) => current.filter((id) => id !== C3),
    });

    await new WarehouseChartersService(memberCtx(stub, 'admin')).setForWarehouse(WH, [C1]);

    expect(links()).toEqual([C1]);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls[0]![0]).toEqual({
      event: 'warehouse_charters.updated',
      entityType: 'warehouse',
      entityId: WH,
      before: { charterIds: [C1, C2, C3] },
      after: { charterIds: [C1] },
    });
  });
});

describe('a link DELETE that removes some of the links and not the others', () => {
  // Nothing added; the save removes C2 and C3, and the DELETE removes only C2.
  const removesOnlyC2 = (asked: string[]) => asked.filter((id) => id !== C3);

  it('the re-read finds the other still there: the audit row names the links now in place, then W4', async () => {
    const { stub, links } = stubWith({ links: [C1, C2, C3], deleteRemoves: removesOnlyC2 });

    await expect(
      new WarehouseChartersService(memberCtx(stub, 'admin')).setForWarehouse(WH, [C1]),
    ).rejects.toMatchObject({ code: 'conflict', message: W4 });

    // The re-read asks for every link the save removes.
    expect(inFilters(lastLinksRead(stub))).toEqual([['charter_id', [C2, C3]]]);
    expect(links()).toEqual([C1, C3]);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls[0]![0]).toEqual({
      event: 'warehouse_charters.updated',
      entityType: 'warehouse',
      entityId: WH,
      before: { charterIds: [C1, C2, C3] },
      after: { charterIds: [C1, C3] },
    });
    expect(reportError).not.toHaveBeenCalled();
  });

  it('the re-read fails: the link the DELETE did not answer for counts as still there, the save is not taken as done, and the failure is reported', async () => {
    const DB_TEXT = 'canceling statement due to statement timeout on "warehouse_charters"';
    const { stub, links } = stubWith({
      links: [C1, C2, C3],
      deleteRemoves: removesOnlyC2,
      linksReRead: { data: null, error: { message: DB_TEXT, code: '57014' } },
    });

    await expect(
      new WarehouseChartersService(memberCtx(stub, 'admin')).setForWarehouse(WH, [C1]),
    ).rejects.toMatchObject({ code: 'conflict', message: W4 });

    expect(links()).toEqual([C1, C3]);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls[0]![0]).toMatchObject({
      event: 'warehouse_charters.updated',
      after: { charterIds: [C1, C3] },
    });
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(String((reportError.mock.calls[0]![0] as Error).message)).toContain(DB_TEXT);
    expect(reportError.mock.calls[0]![1]).toEqual({
      tag: 'warehouse_charters.save_check',
      extra: { warehouseId: WH, check: 'removed' },
    });
  });

  it('the DELETE removes none and the re-read fails: W3, no audit row, and the failure is reported', async () => {
    const { stub, links } = stubWith({
      links: [C1, C2, C3],
      deleteRemoves: () => [],
      linksReRead: { data: null, error: { message: 'connection reset', code: '08006' } },
    });

    await expect(
      new WarehouseChartersService(memberCtx(stub, 'admin')).setForWarehouse(WH, [C1]),
    ).rejects.toMatchObject({ code: 'conflict', message: W3 });

    expect(links()).toEqual([C1, C2, C3]);
    expect(audit).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0]![1]).toMatchObject({ tag: 'warehouse_charters.save_check' });
  });
});

describe('a link INSERT the policy refuses, with nothing of the save landed', () => {
  it('setForWarehouse: W3, not the internal error, before the DELETE, and no audit row', async () => {
    // Add C2, remove C1: the INSERT runs first and is refused.
    const { stub, recorded, links } = stubWith({ links: [C1], linkInsert: REFUSED_BY_POLICY });

    await expect(
      new WarehouseChartersService(memberCtx(stub, 'admin')).setForWarehouse(WH, [C2]),
    ).rejects.toMatchObject({ code: 'conflict', message: W3 });

    expect(recorded.linkInserts).toHaveLength(1);
    expect(recorded.linkDeletes).toEqual([]);
    expect(links()).toEqual([C1]);
    expect(audit).not.toHaveBeenCalled();
  });

  it('through the action, a save of only the charter list: the answer is W3, not "An internal error occurred."', async () => {
    const { stub, recorded } = stubWith({ links: [C1], linkInsert: REFUSED_BY_POLICY });
    mockWithContext.mockResolvedValue(memberCtx(stub, 'admin'));

    const res = await updateWarehouseAction(WH, { charterIds: [C1, C2] });

    expect(res).toEqual({ ok: false, error: { code: 'conflict', message: W3 } });
    expect(recorded.warehouseUpdates).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });
});

describe('a link DELETE that fails', () => {
  // The database's own words for the failure; they go to the server log only.
  const DB_TEXT = 'canceling statement due to statement timeout on "warehouse_charters"';

  it('with nothing else of the save landed: W3, the database text only in the server report, and no audit row', async () => {
    const { stub, recorded, links } = stubWith({
      links: [C1, C2],
      linkDelete: { data: null, error: { message: DB_TEXT, code: '57014' } },
    });

    const refusal = await new WarehouseChartersService(memberCtx(stub, 'admin'))
      .setForWarehouse(WH, [C1])
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(refusal).toMatchObject({ code: 'conflict', message: W3 });
    // Nothing of the database's words travels with the error to the caller.
    expect(refusal).not.toHaveProperty('internalDetail', expect.anything());
    expect(JSON.stringify(refusal)).not.toContain('statement timeout');
    expect(String((refusal as Error).message)).not.toContain('statement timeout');
    expect(recorded.linkDeletes).toHaveLength(1);
    expect(links()).toEqual([C1, C2]);
    expect(audit).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(String((reportError.mock.calls[0]![0] as Error).message)).toContain(DB_TEXT);
    expect(reportError.mock.calls[0]![1]).toMatchObject({ extra: { warehouseId: WH } });
  });

  it('through the action: the answer is W3, not the database text', async () => {
    const { stub } = stubWith({
      links: [C1, C2],
      linkDelete: { data: null, error: { message: DB_TEXT, code: '57014' } },
    });
    mockWithContext.mockResolvedValue(memberCtx(stub, 'admin'));

    const res = await updateWarehouseAction(WH, { charterIds: [C1] });

    expect(res).toEqual({ ok: false, error: { code: 'conflict', message: W3 } });
  });

  it('after the INSERT landed: the partly-saved path is unchanged (the audit row names the links in place, then W4)', async () => {
    const { stub, links } = stubWith({
      links: [C1, C2],
      linkDelete: { data: null, error: { message: DB_TEXT, code: '57014' } },
    });

    await expect(
      new WarehouseChartersService(memberCtx(stub, 'admin')).setForWarehouse(WH, [C1, C3]),
    ).rejects.toMatchObject({ code: 'conflict', message: W4 });

    expect(links()).toEqual([C1, C2, C3]);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls[0]![0]).toMatchObject({
      event: 'warehouse_charters.updated',
      after: { charterIds: [C1, C3, C2] },
    });
  });
});

describe('updateWarehouseAction', () => {
  it('a row change that lands and a link INSERT the policy refuses: the action answers W4, not the internal error', async () => {
    const { stub } = stubWith({ links: [C1], linkInsert: REFUSED_BY_POLICY });
    mockWithContext.mockResolvedValue(memberCtx(stub, 'admin'));

    const res = await updateWarehouseAction(WH, editorSave([C1, C2], 'Renamed'));

    expect(res).toEqual({ ok: false, error: { code: 'conflict', message: W4 } });
  });
});

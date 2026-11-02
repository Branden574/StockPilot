import { beforeEach, describe, expect, it, vi } from 'vitest';

const { audit, reportError } = vi.hoisted(() => ({
  audit: vi.fn(async (..._args: unknown[]) => {}),
  reportError: vi.fn(async (..._args: unknown[]) => {}),
}));
vi.mock('./audit', () => ({ audit }));
vi.mock('@/lib/error-reporter', () => ({ reportError }));

import { effectivePermissions, type Role } from '@stockpilot/core';

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

import { WarehousesService } from './warehouses';

/**
 * Admin > Warehouses (B99). Every write policy on warehouses and
 * warehouse_charters asks the admin role (warehouses_admin_write in 0140,
 * wc_admin_write in 0321), while the service asked only organization:update,
 * which an owner or admin can give a manager, staff member or viewer. For such
 * a member every UPDATE and the link DELETE changed no row with no error, and
 * every INSERT was refused: the editor said "<Warehouse> updated." and the
 * audit log recorded changes that never happened, and adding a link or a
 * warehouse answered "An internal error occurred".
 *
 * The service now checks owner or admin before any read or write, asks the
 * row UPDATE for its row back, and says what landed when a later write of the
 * same save fails after an earlier one landed.
 */

const ORG = 'org-test';
const WH = '00000000-0000-4000-8000-0000000000a1';
const NEW_WH = '00000000-0000-4000-8000-0000000000a9';
/** Another organization's warehouse, and an id no warehouse has. */
const OTHER_ORG_WH = '00000000-0000-4000-8000-0000000000b1';
const UNKNOWN_WH = '00000000-0000-4000-8000-0000000000b9';
const C1 = '00000000-0000-4000-8000-0000000000c1';
const C2 = '00000000-0000-4000-8000-0000000000c2';

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
const revoke = [{ permission: 'organization:update' as const, granted: false }];

/** A member's request context: the role with its effective permission set. */
function memberCtx(
  stub: SupabaseStub,
  role: Role,
  overrides: Array<{ permission: 'organization:update'; granted: boolean }> = [],
  extra: { mfaRequired?: boolean; mfaSatisfied?: boolean } = {},
) {
  return makeServiceContext(stub.client, {
    role: role as 'owner' | 'admin' | 'manager' | 'staff' | 'viewer',
    permissions: effectivePermissions(role, overrides),
    ...extra,
  }) as never;
}

/** The warehouse's charter links, as the table holds them. */
function linkRows(charterIds: string[]) {
  return charterIds.map((charter_id) => ({
    organization_id: ORG,
    warehouse_id: WH,
    charter_id,
  }));
}

interface Recorded {
  warehouseReads: MockCall[];
  warehouseUpdates: MockCall[];
  warehouseInserts: MockCall[];
  linkInserts: MockCall[];
  linkDeletes: MockCall[];
  itemCounts: MockCall[];
}

/**
 * A stub that answers as the database does. `rowUpdate` answers the warehouse
 * UPDATE (its row back for an admin; none when the policy hides it),
 * `rowRead` the warehouse read instead of the rows below, `linkInsert` the
 * link INSERT, and the link DELETE removes and returns the rows it was asked
 * for unless `deleteRemoves` says otherwise.
 */
function stubWith(opts: {
  links?: string[];
  rowUpdate?: QueryResult;
  rowRead?: QueryResult;
  warehouseInsert?: QueryResult;
  linkInsert?: QueryResult;
  deleteRemoves?: (asked: string[]) => string[];
}) {
  let table = linkRows(opts.links ?? []);
  const recorded: Recorded = {
    warehouseReads: [],
    warehouseUpdates: [],
    warehouseInserts: [],
    linkInserts: [],
    linkDeletes: [],
    itemCounts: [],
  };
  const warehouses = servedLikePostgrest([
    { id: WH, organization_id: ORG },
    { id: OTHER_ORG_WH, organization_id: 'org-other' },
  ]);
  const stub = makeSupabaseStub({
    'warehouses.select': (call) => {
      recorded.warehouseReads.push(call);
      return opts.rowRead ?? warehouses(call);
    },
    'warehouses.update': (call) => {
      recorded.warehouseUpdates.push(call);
      return opts.rowUpdate ?? { data: [{ id: WH }], error: null };
    },
    'warehouses.insert': (call) => {
      recorded.warehouseInserts.push(call);
      return opts.warehouseInsert ?? { data: { id: NEW_WH }, error: null };
    },
    'warehouse_charters.select': countedLikePostgrest(() => table),
    'warehouse_charters.insert': (call) => {
      recorded.linkInserts.push(call);
      const result = opts.linkInsert ?? { data: null, error: null };
      if (!result.error) {
        table = [...table, ...(call.args[0]![0] as typeof table)];
      }
      return result;
    },
    'warehouse_charters.delete': (call) => {
      recorded.linkDeletes.push(call);
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

/** What the editor sends on Save: every field, and the whole charter list. */
function editorSave(charterIds: string[], name = 'North DC') {
  return {
    name,
    code: 'NDC',
    charterIds,
    managerUserId: null,
    status: 'active' as const,
  };
}

const auditEvents = () => audit.mock.calls.map((c) => (c[0] as { event: string }).event);

beforeEach(() => {
  audit.mockClear();
  reportError.mockClear();
});

describe('WarehousesService refuses a member below admin before any read or write', () => {
  it('update: a manager granted organization:update is refused, and nothing is read, written or audited', async () => {
    // Removing a link and renaming: today both changed no row and were audited.
    const { stub, recorded } = stubWith({
      links: [C1],
      rowUpdate: { data: null, error: null },
      deleteRemoves: () => [],
    });

    await expect(
      new WarehousesService(memberCtx(stub, 'manager', grant)).update(
        WH,
        editorSave([], 'Renamed'),
      ),
    ).rejects.toMatchObject({ code: 'forbidden', message: W1 });

    expect(recorded.warehouseUpdates).toEqual([]);
    expect(stub.chainsAll.get('warehouse_charters.select')).toBeUndefined();
    expect(recorded.linkInserts).toEqual([]);
    expect(recorded.linkDeletes).toEqual([]);
    expect(recorded.itemCounts).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  // No charter list in these saves, so the charter save's own check never
  // runs: only update()'s own check stands between them and the database. A
  // direct call to updateWarehouseAction can send either. The fields-only
  // UPDATE changed no row for this manager, and the empty save passed the row
  // read (warehouses_select lets a manager read it) and wrote warehouse.updated.
  it.each([
    ['a save of row fields with no charter list', { name: 'Renamed' }],
    ['a save with nothing in it', {}],
  ])(
    'update: %s from a manager granted organization:update is refused, with nothing read, written or audited',
    async (_label, patch) => {
      const { stub, recorded } = stubWith({ links: [C1], rowUpdate: { data: null, error: null } });

      await expect(
        new WarehousesService(memberCtx(stub, 'manager', grant)).update(WH, patch),
      ).rejects.toMatchObject({ code: 'forbidden', message: W1 });

      expect(recorded.warehouseReads).toEqual([]);
      expect(recorded.warehouseUpdates).toEqual([]);
      expect(stub.chainsAll.get('warehouse_charters.select')).toBeUndefined();
      expect(recorded.linkInserts).toEqual([]);
      expect(recorded.linkDeletes).toEqual([]);
      expect(audit).not.toHaveBeenCalled();
    },
  );

  it('create: staff granted organization:update for the role are refused before the INSERT', async () => {
    const { stub, recorded } = stubWith({ warehouseInsert: REFUSED_BY_POLICY });

    await expect(
      new WarehousesService(memberCtx(stub, 'staff', grant)).create({
        name: 'Overflow',
        code: 'OVF',
        charterIds: [C1],
        status: 'active',
      }),
    ).rejects.toMatchObject({ code: 'forbidden', message: W1 });

    expect(recorded.warehouseInserts).toEqual([]);
    expect(recorded.linkInserts).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it('archive and restore: a viewer granted organization:update is refused before the UPDATE', async () => {
    const { stub, recorded } = stubWith({ rowUpdate: { data: null, error: null } });
    const svc = new WarehousesService(memberCtx(stub, 'viewer', grant));

    await expect(svc.archive(WH)).rejects.toMatchObject({ code: 'forbidden', message: W1 });
    await expect(svc.restore(WH)).rejects.toMatchObject({ code: 'forbidden', message: W1 });

    expect(recorded.warehouseUpdates).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it('a manager without the grant is refused with the same words', async () => {
    const { stub, recorded } = stubWith({ links: [C1] });

    await expect(
      new WarehousesService(memberCtx(stub, 'manager')).update(WH, editorSave([C1])),
    ).rejects.toMatchObject({ code: 'forbidden', message: W1 });
    expect(recorded.warehouseUpdates).toEqual([]);
  });
});

describe('WarehousesService.update asks its rows back', () => {
  it("an admin's row UPDATE that changes no row refuses with W3, before any link write and with no audit row", async () => {
    // The row is not this organization's any more (a tab left on another
    // organization), so the UPDATE matches nothing.
    const { stub, recorded } = stubWith({ links: [C1], rowUpdate: { data: null, error: null } });

    await expect(
      new WarehousesService(memberCtx(stub, 'admin')).update(WH, editorSave([C1, C2])),
    ).rejects.toMatchObject({ code: 'conflict', message: W3 });

    expect(recorded.warehouseUpdates).toHaveLength(1);
    expect(recorded.warehouseUpdates[0]!.methods).toEqual(
      expect.arrayContaining(['update', 'select']),
    );
    expect(recorded.linkInserts).toEqual([]);
    expect(recorded.linkDeletes).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it('the row lands and the link INSERT is refused: W4, and one audit row for the row change, without charterIds', async () => {
    const { stub, recorded } = stubWith({ links: [C1], linkInsert: REFUSED_BY_POLICY });

    await expect(
      new WarehousesService(memberCtx(stub, 'admin')).update(WH, editorSave([C1, C2], 'Renamed')),
    ).rejects.toMatchObject({ code: 'conflict', message: W4 });

    expect(recorded.warehouseUpdates).toHaveLength(1);
    expect(recorded.linkInserts).toHaveLength(1);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls[0]![0]).toEqual({
      event: 'warehouse.updated',
      entityType: 'warehouse',
      entityId: WH,
      warehouseId: WH,
      after: { name: 'Renamed', code: 'NDC', managerUserId: null, status: 'active' },
    });
  });
});

describe('WarehousesService.update with no row field', () => {
  // No UPDATE is sent, so nothing else proves the id is a warehouse of this
  // organization before the audit rows name it.
  it.each([
    ['another organization', OTHER_ORG_WH],
    ['no warehouse', UNKNOWN_WH],
  ])(
    "an admin's save of only the charter list on an id of %s: W3, before the links are read, and no audit row",
    async (_label, id) => {
      const { stub, recorded } = stubWith({ links: [C1] });

      await expect(
        new WarehousesService(memberCtx(stub, 'admin')).update(id, { charterIds: [] }),
      ).rejects.toMatchObject({ code: 'conflict', message: W3 });

      expect(recorded.warehouseReads).toHaveLength(1);
      expect(stub.chainsAll.get('warehouse_charters.select')).toBeUndefined();
      expect(recorded.warehouseUpdates).toEqual([]);
      expect(recorded.linkInserts).toEqual([]);
      expect(recorded.linkDeletes).toEqual([]);
      expect(audit).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['another organization', OTHER_ORG_WH],
    ['no warehouse', UNKNOWN_WH],
  ])(
    "an admin's save with nothing in it on an id of %s: W3 and no audit row",
    async (_label, id) => {
      const { stub, recorded } = stubWith({});

      await expect(
        new WarehousesService(memberCtx(stub, 'admin')).update(id, {}),
      ).rejects.toMatchObject({ code: 'conflict', message: W3 });

      expect(recorded.warehouseUpdates).toEqual([]);
      expect(audit).not.toHaveBeenCalled();
    },
  );

  it("on this organization's warehouse the charter list saves with the same two audit rows as before", async () => {
    const { stub, recorded, links } = stubWith({ links: [C1] });

    await new WarehousesService(memberCtx(stub, 'admin')).update(WH, { charterIds: [C1, C2] });

    expect(recorded.warehouseReads).toHaveLength(1);
    expect(recorded.warehouseUpdates).toEqual([]);
    expect(links()).toEqual([C1, C2]);
    expect(auditEvents()).toEqual(['warehouse_charters.updated', 'warehouse.updated']);
  });

  it("an admin's save of only the charter list whose link INSERT the policy refuses: W3, not the internal error, and no audit row", async () => {
    // The row check is a read, so nothing of this save landed before the
    // INSERT.
    const { stub, recorded, links } = stubWith({ links: [C1], linkInsert: REFUSED_BY_POLICY });

    await expect(
      new WarehousesService(memberCtx(stub, 'admin')).update(WH, { charterIds: [C1, C2] }),
    ).rejects.toMatchObject({ code: 'conflict', message: W3 });

    expect(recorded.warehouseUpdates).toEqual([]);
    expect(recorded.linkInserts).toHaveLength(1);
    expect(links()).toEqual([C1]);
    expect(audit).not.toHaveBeenCalled();
  });

  it.each([
    ['only the charter list', { charterIds: [C1, C2] }],
    ['nothing in it', {}],
  ])(
    "an admin's save of %s whose row check read fails: W3, the database text only in the server report, and no audit row",
    async (_label, patch) => {
      const DB_TEXT = 'canceling statement due to statement timeout on "warehouses"';
      const { stub, recorded, links } = stubWith({
        links: [C1],
        rowRead: { data: null, error: { message: DB_TEXT, code: '57014' } },
      });

      const refusal = await new WarehousesService(memberCtx(stub, 'admin')).update(WH, patch).then(
        () => null,
        (e: unknown) => e,
      );

      expect(refusal).toMatchObject({ code: 'conflict', message: W3 });
      expect(JSON.stringify(refusal)).not.toContain('statement timeout');
      expect(recorded.warehouseReads).toHaveLength(1);
      expect(stub.chainsAll.get('warehouse_charters.select')).toBeUndefined();
      expect(recorded.warehouseUpdates).toEqual([]);
      expect(recorded.linkInserts).toEqual([]);
      expect(links()).toEqual([C1]);
      expect(audit).not.toHaveBeenCalled();
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(String((reportError.mock.calls[0]![0] as Error).message)).toContain(DB_TEXT);
      expect(reportError.mock.calls[0]![1]).toEqual({
        tag: 'organization_setup.row_check',
        extra: { table: 'warehouses', id: WH },
      });
    },
  );

  it('a save with a row field sends no extra read: the UPDATE asks its row back', async () => {
    const { stub, recorded } = stubWith({ links: [C1] });

    await new WarehousesService(memberCtx(stub, 'admin')).update(WH, editorSave([C1]));

    expect(recorded.warehouseReads).toEqual([]);
    expect(recorded.warehouseUpdates).toHaveLength(1);
  });
});

describe('WarehousesService.create says what landed', () => {
  it('the warehouse is created and its link INSERT is refused: W4, and warehouse.created without charterIds', async () => {
    const { stub, recorded } = stubWith({ linkInsert: REFUSED_BY_POLICY });

    await expect(
      new WarehousesService(memberCtx(stub, 'admin')).create({
        name: 'Overflow',
        code: 'OVF',
        charterIds: [C1],
        status: 'active',
      }),
    ).rejects.toMatchObject({ code: 'conflict', message: W4 });

    expect(recorded.warehouseInserts).toHaveLength(1);
    expect(recorded.linkInserts).toHaveLength(1);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls[0]![0]).toEqual({
      event: 'warehouse.created',
      entityType: 'warehouse',
      entityId: NEW_WH,
      warehouseId: NEW_WH,
      after: { name: 'Overflow', code: 'OVF', status: 'active' },
    });
  });

  it('a warehouse INSERT the policy refuses answers W3, not the internal error', async () => {
    const { stub, recorded } = stubWith({
      warehouseInsert: {
        data: null,
        error: {
          message: 'new row violates row-level security policy for table "warehouses"',
          code: '42501',
        },
      },
    });

    await expect(
      new WarehousesService(memberCtx(stub, 'admin')).create({
        name: 'Overflow',
        code: 'OVF',
        charterIds: [C1],
        status: 'active',
      }),
    ).rejects.toMatchObject({ code: 'conflict', message: W3 });
    expect(recorded.linkInserts).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });
});

describe('what stays as it was', () => {
  it("an admin's normal save writes the row and the link, and the same two audit rows as before", async () => {
    const { stub, recorded, links } = stubWith({ links: [C1] });
    const patch = editorSave([C1, C2], 'Renamed');

    await new WarehousesService(memberCtx(stub, 'admin')).update(WH, patch);

    expect(recorded.warehouseUpdates).toHaveLength(1);
    expect(links()).toEqual([C1, C2]);
    expect(auditEvents()).toEqual(['warehouse_charters.updated', 'warehouse.updated']);
    expect(audit.mock.calls[0]![0]).toEqual({
      event: 'warehouse_charters.updated',
      entityType: 'warehouse',
      entityId: WH,
      before: { charterIds: [C1] },
      after: { charterIds: [C1, C2] },
    });
    expect(audit.mock.calls[1]![0]).toEqual({
      event: 'warehouse.updated',
      entityType: 'warehouse',
      entityId: WH,
      warehouseId: WH,
      after: patch,
    });
  });

  it("the owner's create, archive and restore go through", async () => {
    const { stub, recorded } = stubWith({});
    const svc = new WarehousesService(memberCtx(stub, 'owner'));

    await expect(
      svc.create({ name: 'Overflow', code: 'OVF', charterIds: [C1], status: 'active' }),
    ).resolves.toEqual({ id: NEW_WH });
    await svc.archive(WH);
    await svc.restore(WH);

    expect(recorded.warehouseInserts).toHaveLength(1);
    expect(recorded.linkInserts).toHaveLength(1);
    expect(recorded.warehouseUpdates).toHaveLength(2);
    expect(auditEvents()).toEqual([
      'warehouse.created',
      'warehouse.archived',
      'warehouse.restored',
    ]);
  });

  it('an admin whose organization:update was revoked keeps "Missing permission: organization:update"', async () => {
    const { stub, recorded } = stubWith({ links: [C1] });

    await expect(
      new WarehousesService(memberCtx(stub, 'admin', revoke)).update(WH, editorSave([C1])),
    ).rejects.toMatchObject({
      code: 'forbidden',
      message: 'Missing permission: organization:update',
    });
    expect(recorded.warehouseUpdates).toEqual([]);
  });

  it('with MFA required and not satisfied, the step-up error comes first, for a granted manager too', async () => {
    for (const [role, overrides] of [
      ['admin', []],
      ['manager', grant],
    ] as const) {
      const { stub, recorded } = stubWith({ links: [C1] });
      await expect(
        new WarehousesService(
          memberCtx(stub, role, [...overrides], { mfaRequired: true, mfaSatisfied: false }),
        ).update(WH, editorSave([C1])),
        role,
      ).rejects.toMatchObject({ code: 'forbidden', details: { reason: 'mfa_required' } });
      expect(recorded.warehouseUpdates, role).toEqual([]);
    }
  });

  it('archive of a row that is not there still says "Warehouse not found."', async () => {
    const { stub } = stubWith({ rowUpdate: { data: null, error: null } });

    await expect(new WarehousesService(memberCtx(stub, 'admin')).archive(WH)).rejects.toMatchObject(
      {
        code: 'not_found',
        message: 'Warehouse not found.',
      },
    );
  });
});

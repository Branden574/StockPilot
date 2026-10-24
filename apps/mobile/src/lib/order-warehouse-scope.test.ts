import { describe, expect, it } from 'vitest';

import type { AssignmentReadClient } from './holdings-elsewhere';
import {
  needsOrderWarehouseScope,
  orderWarehouseAccess,
  readOrderWarehouseScope,
  type OrderWarehouseScope,
} from './order-warehouse-scope';

/**
 * Security slice E (migration 0405): the phone's order screen reads the
 * viewer's warehouses with the order and offers an approver outside the
 * order's warehouse none of an approver's controls (and a picker there no
 * Claim or Release), as the web order page does. Each case names the
 * mutation it catches.
 */

const WH_A = '0a000000-0000-0000-0000-0000000000a1';
const WH_B = '0a000000-0000-0000-0000-0000000000b1';

type Filter = [string, string];
function fakeAssignments(answer: () => unknown) {
  const reads: { table: string; select: string; filters: Filter[] }[] = [];
  const client: AssignmentReadClient & { reads: typeof reads } = {
    reads,
    from(table: string) {
      const rec = { table, select: '', filters: [] as Filter[] };
      reads.push(rec);
      const chain = {
        select(cols: string) {
          rec.select = cols;
          return chain;
        },
        eq(col: string, val: string) {
          rec.filters.push([col, val]);
          return chain;
        },
        then(onOk: (v: unknown) => unknown, onErr?: (e: unknown) => unknown) {
          return Promise.resolve().then(answer).then(onOk, onErr);
        },
      };
      return chain;
    },
  };
  return client;
}

describe('needsOrderWarehouseScope', () => {
  const base = { role: 'staff', canApproveOrders: false, canPick: false, status: 'approved' };

  it('an approver below manager rank, at any status (mutation: the approver term dropped)', () => {
    for (const status of ['pending_approval', 'approved', 'picking_complete', 'in_transit', 'backordered', 'completed']) {
      expect(needsOrderWarehouseScope({ ...base, canApproveOrders: true, status }), status).toBe(true);
    }
    expect(needsOrderWarehouseScope({ ...base, role: 'viewer', canApproveOrders: true })).toBe(true);
  });

  it('a picker only while the order is in picking (mutation: the status term dropped)', () => {
    expect(needsOrderWarehouseScope({ ...base, canPick: true, status: 'pick_slip_generated' })).toBe(true);
    expect(needsOrderWarehouseScope({ ...base, canPick: true, status: 'picking_in_progress' })).toBe(true);
    for (const status of ['approved', 'picking_complete', 'packing_slip_generated', null]) {
      expect(needsOrderWarehouseScope({ ...base, canPick: true, status }), String(status)).toBe(false);
    }
  });

  it('nobody else, and never an owner, admin or manager (they work in every warehouse by role) or a role not known yet', () => {
    expect(needsOrderWarehouseScope(base)).toBe(false);
    for (const role of ['owner', 'admin', 'manager']) {
      expect(needsOrderWarehouseScope({ ...base, role, canApproveOrders: true, canPick: true, status: 'picking_in_progress' }), role).toBe(false);
    }
    for (const role of [null, undefined, '']) {
      expect(needsOrderWarehouseScope({ ...base, role, canApproveOrders: true })).toBe(false);
    }
  });
});

describe('readOrderWarehouseScope', () => {
  const base = { organizationId: 'org-1', userId: 'user-1' };

  it("staff: their assignment rows are where they write and read (readDestinationWarehouseScope's read)", async () => {
    const client = fakeAssignments(() => ({ data: [{ warehouse_id: WH_A }, { warehouse_id: WH_A }], error: null }));
    expect(await readOrderWarehouseScope(client, { ...base, role: 'staff' })).toEqual({
      writableIds: [WH_A],
      readableIds: [WH_A],
      unreadable: false,
    });
    expect(client.reads).toEqual([
      {
        table: 'user_warehouse_assignments',
        select: 'warehouse_id',
        filters: [
          ['organization_id', 'org-1'],
          ['user_id', 'user-1'],
        ],
      },
    ]);
  });

  it('a viewer: writes nowhere, reads where assigned (the line edits ask read) (mutation: the viewer read skipped)', async () => {
    const client = fakeAssignments(() => ({ data: [{ warehouse_id: WH_A }], error: null }));
    expect(await readOrderWarehouseScope(client, { ...base, role: 'viewer' })).toEqual({
      writableIds: [],
      readableIds: [WH_A],
      unreadable: false,
    });
    expect(client.reads).toHaveLength(1);
  });

  it('a manager: every warehouse, no read', async () => {
    const client = fakeAssignments(() => ({ data: [], error: null }));
    expect(await readOrderWarehouseScope(client, { ...base, role: 'manager' })).toEqual({
      writableIds: null,
      readableIds: null,
      unreadable: false,
    });
    expect(client.reads).toHaveLength(0);
  });

  it.each([
    ['an error answer', () => ({ data: null, error: { message: 'x' } })],
    ['a rejected request', () => {
      throw new Error('Network request failed');
    }],
  ])('a failed read is unreadable, for staff and a viewer, and never throws: %s', async (_label, answer) => {
    for (const role of ['staff', 'viewer']) {
      const scope = await readOrderWarehouseScope(fakeAssignments(answer), { ...base, role });
      expect(scope.unreadable, role).toBe(true);
    }
  });
});

describe('orderWarehouseAccess', () => {
  const read = (writableIds: string[] | null, readableIds: string[] | null = writableIds): OrderWarehouseScope => ({
    writableIds,
    readableIds,
    unreadable: false,
  });

  it("staff of warehouse A: write and read on A's order, neither on B's (mutation: the warehouse comparison dropped)", () => {
    expect(orderWarehouseAccess({ role: 'staff', warehouseId: WH_A, scope: read([WH_A]) })).toEqual({ writes: true, reads: true });
    expect(orderWarehouseAccess({ role: 'staff', warehouseId: WH_B, scope: read([WH_A]) })).toEqual({ writes: false, reads: false });
    expect(orderWarehouseAccess({ role: 'staff', warehouseId: WH_B, scope: read([WH_A, WH_B]) })).toEqual({ writes: true, reads: true });
    expect(orderWarehouseAccess({ role: 'staff', warehouseId: null, scope: read([WH_A]) })).toEqual({ writes: false, reads: false });
  });

  it('a viewer never writes; reads where assigned (mutation: the viewer rule dropped)', () => {
    expect(orderWarehouseAccess({ role: 'viewer', warehouseId: WH_A, scope: read([], [WH_A]) })).toEqual({ writes: false, reads: true });
    expect(orderWarehouseAccess({ role: 'viewer', warehouseId: WH_B, scope: read([], [WH_A]) })).toEqual({ writes: false, reads: false });
  });

  it('an owner, admin or manager: every warehouse by role, whatever was read', () => {
    for (const role of ['owner', 'admin', 'manager']) {
      expect(orderWarehouseAccess({ role, warehouseId: WH_B, scope: read([WH_A]) }), role).toEqual({ writes: true, reads: true });
      expect(orderWarehouseAccess({ role, warehouseId: WH_B, scope: null }), role).toEqual({ writes: true, reads: true });
    }
  });

  // Slice E review: the line edits (Add items, change and remove) ask READ
  // access to the order's warehouse of the person who placed it too
  // (loadEditableOrderHeader), so the screen offers them on `reads` alone.
  // The two requesters that decides for, end to end through the screen's
  // read decision.
  it("the person who placed the order: an approver's own order outside their warehouses offers no line edit; a requester who neither approves nor picks has nothing read and is offered as before", () => {
    const approverRequester = { role: 'staff', canApproveOrders: true, canPick: true, status: 'pending_approval' };
    expect(needsOrderWarehouseScope(approverRequester)).toBe(true);
    expect(orderWarehouseAccess({ role: 'staff', warehouseId: WH_B, scope: read([WH_A]) }).reads).toBe(false);
    expect(orderWarehouseAccess({ role: 'staff', warehouseId: WH_A, scope: read([WH_A]) }).reads).toBe(true);

    const plainRequester = { role: 'staff', canApproveOrders: false, canPick: false, status: 'pending_approval' };
    expect(needsOrderWarehouseScope(plainRequester)).toBe(false);
    expect(orderWarehouseAccess({ role: 'staff', warehouseId: WH_B, scope: null }).reads).toBe(true);
  });

  // The phone's precedent for this screen (neededBySheetOpening): a read that
  // did not happen, or failed, decides nothing; the server answers.
  it('a scope not read, or unreadable, offers as before (a viewer still never writes)', () => {
    const unreadable: OrderWarehouseScope = { writableIds: [], readableIds: [], unreadable: true };
    expect(orderWarehouseAccess({ role: 'staff', warehouseId: WH_B, scope: unreadable })).toEqual({ writes: true, reads: true });
    expect(orderWarehouseAccess({ role: 'staff', warehouseId: WH_B, scope: null })).toEqual({ writes: true, reads: true });
    expect(orderWarehouseAccess({ role: 'staff', warehouseId: WH_B, scope: undefined })).toEqual({ writes: true, reads: true });
    expect(orderWarehouseAccess({ role: 'viewer', warehouseId: WH_B, scope: unreadable })).toEqual({ writes: false, reads: true });
  });
});

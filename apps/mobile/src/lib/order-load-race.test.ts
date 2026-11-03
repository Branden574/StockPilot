import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import {
  availableOrderActions,
  can,
  deletedDriverHandOverLine,
  isDeliveryDriverDeleted,
  ROLE_PERMISSIONS,
  type FulfillmentType,
  type OrderStatus,
  type Permission,
  type Role,
} from '@stockpilot/core';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

import { canAddOrderItems } from '../components/add-order-items';
import { parseTsx } from './__fixtures__/jsx-touch-audit';
import {
  awaitsIn,
  callbackStatements,
  commitsIn,
  unguardedCommits,
  walk,
} from './__fixtures__/load-commit-audit';
import {
  deferred,
  fakeOrderClient,
  flush,
  headerAnswer,
  linesAnswer,
  ORDER_ID,
  orderScreen,
  SCREEN as SCREEN_FILE,
  workIn,
  type Answer,
  type AttachmentsRead,
  type OrderRow,
  type Render,
  type ShownOrder,
} from './__fixtures__/order-screen-loads';
import { screenFunction } from './__fixtures__/screen-functions';
import { reloadAfterFailedOrderAction } from './order-action-refusal';
import { phoneOrderCancel } from './order-cancel-action';
import { orderManagerActions, type OrderManagerActions } from './order-manager-actions';
import { canOfferNeededByChange } from './order-needed-by';
import { readinessPermissionsFor } from './order-readiness';
import { keepReasonDialogOpen } from './order-reason-dialog';
import {
  orderWarehouseAccess,
  orderWarehouseAccessAsShown,
  type OrderWarehouseAccess,
} from './order-warehouse-scope';
import { NO_PERMISSIONS, permissionsOnceRead } from './use-effective-permissions';

// use-effective-permissions reads the device store and the API; only its
// pure permissionsOnceRead is used here.
vi.mock('./db', () => ({ getMeta: vi.fn(), setMeta: vi.fn() }));
vi.mock('./api', () => ({ api: vi.fn() }));
// The screen's load reads delivery-request-actions' predicates, and that
// module imports expo-linking.
vi.mock('expo-linking', () => ({
  openURL: vi.fn(async () => undefined),
  canOpenURL: vi.fn(async () => true),
}));

/**
 * S2 FOLLOW-UP: THE PHONE'S ORDER SCREEN SHOWS ONLY ITS NEWEST LOAD, AND
 * NEVER GATES ON PERMISSIONS IT HAS NOT READ (lab walk of #378's release step
 * 6, walk-s2-phone-1103 finding F1, and the review of that fix, F1 to F4).
 *
 * A staff approver of warehouse A, granted orders:approve by a per-user
 * exception, opened warehouse B's order and was offered every approver
 * control (Approve, Deny, Cancel order, the needed-by Change, the line edits,
 * Add items, Collect signature with the deleted-driver line) on most fresh
 * opens, until a refresh. useEffectivePermissions() starts undefined, so the
 * first load ran with the static staff defaults (no orders:approve) and read
 * no warehouses at a status outside picking; the saved set arrived, rpApprove
 * changed, the load ran again WITH the read, and whichever finished last was
 * shown. The unscoped one finishing last left the order's scope null, which
 * orderWarehouseAccess answers "offered as before". The server refused every
 * tap; the screen was wrong.
 *
 * Fixed, each pinned here:
 *   1. every load takes a number and only the newest one started changes the
 *      screen (order, error, spinner, tracking, the view kept for offline);
 *   2. the screen gates with nothing until the saved set is read
 *      (permissionsOnceRead), and `load` waits for it, so no load runs with
 *      the static defaults while the saved set is still being read;
 *   3. an order on screen whose load did not read the warehouses that the
 *      permissions the render gates with now ask for is offered nothing that
 *      needs them (orderWarehouseAccessAsShown), until the newer load lands;
 *   4. (review F1) every reload after the screen opened (an action's, a
 *      sheet's, the pick's) runs the newest `load`, which the screen keeps
 *      in the runner after every render (`reload`), never the `load` its
 *      handler's render built;
 *   5. (review F2) a reload waits for the newest load (lib/newest-load), so
 *      an action clears its busy key, and a refused Deny or Reopen picking
 *      settles its dialog, on the order read again;
 *   6. (review F4) only the newest read of the attachments shows them,
 *      whether the order's load or an upload, a delete or Try again made it.
 *
 * WHAT RUNS (review F3). The behaviour sections run the screen's own code,
 * compiled from app/order/[id].tsx (__fixtures__/order-screen-loads): its
 * `load`, `loadAttachments`, `reload`, layout and focus effects and state
 * initializers,
 * and its `runAction`, `act`, `submitDeny` and `settleFailedReasonDialog`,
 * over a fake transport whose reads the tests hold and release. A check taken
 * out of `load`, a reload pointed back at an older `load`, or a runAction
 * that stops waiting fails them, not only the wiring pins. Two things are
 * played by hand: React (which render's `load` a focus effect or a handler
 * holds, as the screen's hooks decide; the wiring section pins those hooks),
 * and the render's gating chain (`offered` below calls the helpers the
 * screen's render calls, with the values it derives; the wiring pins and
 * order-manager-actions hold the screen to them).
 */

const WH_A = '0a000000-0000-0000-0000-0000000000a1';
const WH_B = '0a000000-0000-0000-0000-0000000000b1';
const APPROVER = '0d000000-0000-0000-0000-0000000000d1';
const SOMEONE_ELSE = '0d000000-0000-0000-0000-0000000000d2';

/** The staff approver's saved set: the staff defaults and a per-user grant. */
const SAVED_APPROVER: ReadonlySet<Permission> = new Set<Permission>([
  ...ROLE_PERMISSIONS.staff,
  'orders:approve',
]);
const SAVED_MANAGER: ReadonlySet<Permission> = new Set<Permission>(ROLE_PERMISSIONS.manager);
/** A picker's saved set, and the approver's before the grant lands: the staff defaults. */
const SAVED_PICKER: ReadonlySet<Permission> = new Set<Permission>(ROLE_PERMISSIONS.staff);

/** What the screen gates with once the saved set `saved` is read. */
const savedSet = (saved: ReadonlySet<Permission>) =>
  permissionsOnceRead({ permissions: new Set(saved), read: true });

const SCOPE_A = { writableIds: [WH_A], readableIds: [WH_A], unreadable: false };

const row = (over: Partial<OrderRow> = {}): OrderRow => ({
  status: 'pending_approval',
  warehouseId: WH_B,
  fulfillmentType: 'delivery',
  requesterUserId: SOMEONE_ELSE,
  assignedPickerId: null,
  assignedDeliveryUserId: null,
  inTransitAt: null,
  ...over,
});

/** The order as the server holds it now, and the warehouses the viewer works in. */
interface Server {
  row: OrderRow;
  workingIn: string[];
}

/** Reads queued to wait, by table: each read of a table waits for the next one queued for it. */
type Holds = Partial<Record<string, Promise<void>[]>>;

/** A client that answers from `server` at the time it answers, after any hold queued for the read. */
function serverClient(server: Server, holds: Holds = {}) {
  const held = (table: string, answer: () => Answer) => async (): Promise<Answer> => {
    await holds[table]?.shift();
    return answer();
  };
  return fakeOrderClient({
    order_requests: held('order_requests', () => headerAnswer(server.row)),
    order_request_lines: held('order_request_lines', () => linesAnswer()),
    user_warehouse_assignments: held('user_warehouse_assignments', () =>
      workIn(...server.workingIn),
    ),
    organizations: held('organizations', () => ({
      data: { timezone: 'America/Los_Angeles', email_routing: null },
      error: null,
    })),
  });
}

/** One render of the staff approver's screen once the saved set is read. */
const approverRender = (client: Render['client']): Render => ({
  role: 'staff',
  permissions: savedSet(SAVED_APPROVER),
  permissionsRead: true,
  client,
});

/** What the screen offers for `order`, gated with `permissions`, through the
 *  screen's own chain of helpers; `access` is the warehouse decision (the
 *  screen's orderWarehouseAccessAsShown, or the one it used before). */
function offered(
  order: ShownOrder,
  viewer: { role: Role; permissions: ReadonlySet<Permission> | undefined; userId?: string },
  access: (
    input: Parameters<typeof orderWarehouseAccessAsShown>[0],
  ) => OrderWarehouseAccess = orderWarehouseAccessAsShown,
) {
  const { role, permissions } = viewer;
  const userId = viewer.userId ?? APPROVER;
  const { canApproveOrders: rpApprove, canUpdateItems: rpItems } = readinessPermissionsFor(
    role,
    permissions,
  );
  const isManager = ['owner', 'admin', 'manager'].includes(role);
  const viewerCanPick = isManager || can({ role, permissions }, 'items:update');
  const orderAccess = access({
    role,
    warehouseId: order.warehouseId,
    scope: order.warehouseScope,
    status: order.status,
    canApproveOrders: rpApprove,
    canPick: rpItems,
  });
  const writesHere = orderAccess.writes === true;
  const viewerCanPickHere = viewerCanPick && writesHere;
  const machine = availableOrderActions({
    status: order.status,
    fulfillmentType: order.fulfillmentType,
    hasAssignedDelivery: order.assignedDeliveryUserId !== null,
    viewerRole: role,
    viewerUserId: userId,
    assignedPickerId: order.assignedPickerId,
    assignedDeliveryUserId: order.assignedDeliveryUserId,
    viewerCanPick: viewerCanPickHere,
    canApproveOrders: rpApprove && writesHere,
    isReplacement: false,
  });
  const manager: OrderManagerActions = orderManagerActions({
    status: order.status,
    fulfillmentType: order.fulfillmentType,
    canApproveOrders: rpApprove,
    writesOrderWarehouse: writesHere,
    canAssignDelivery: can({ role, permissions }, 'orders:assign_delivery'),
    isManagerByRole: isManager,
    isAssignedDriver: !!order.assignedDeliveryUserId && order.assignedDeliveryUserId === userId,
    hasAssignedDriver: !!order.assignedDeliveryUserId,
    driverDeleted: isDeliveryDriverDeleted(order),
    machineOffersClosePartial: machine.includes('close_partial'),
    machineOffersReopen: machine.includes('reopen_picking'),
    isViewerRole: role === 'viewer',
  });
  const cancel = phoneOrderCancel({
    status: order.status,
    canApproveOrders: rpApprove,
    writesOrderWarehouse: writesHere,
    isOwnRequest: !!order.requesterUserId && order.requesterUserId === userId,
    canRequestOrders: can({ role, permissions }, 'orders:request'),
  });
  const lineGate = {
    status: order.status,
    requesterUserId: order.requesterUserId,
    viewerUserId: userId,
    viewerRole: role,
    permissions,
    ordersModuleEnabled: true,
  };
  return {
    /** Every button of the order's actions section that is offered. */
    actions: Object.entries(manager)
      .filter(([key, on]) => key !== 'showSection' && on === true)
      .map(([key]) => key),
    deletedDriverLine: manager.deletedDriverLine,
    cancel: cancel?.label ?? null,
    lineChanges: canAddOrderItems(lineGate) && orderAccess.reads === true,
    neededBy: canOfferNeededByChange({
      status: order.status,
      role,
      canApproveOrders: rpApprove && writesHere,
      ordersModuleEnabled: true,
    }),
    claim: machine.includes('claim_picking'),
    release: machine.includes('release_picking'),
    pick: machine.includes('open_digital_pick'),
    /** The section itself, for the reason dialogs' check. */
    manager,
  };
}

/** `offered` without the section object, for comparisons. */
function offeredButtons(...args: Parameters<typeof offered>) {
  const { manager: _section, ...buttons } = offered(...args);
  return buttons;
}

const APPROVER_VIEW = { role: 'staff' as const, permissions: SAVED_APPROVER };

const NOTHING = {
  actions: [],
  deletedDriverLine: null,
  cancel: null,
  lineChanges: false,
  neededBy: false,
  claim: false,
  release: false,
  pick: false,
};

/** Every status outside picking whose controls an approver is offered. */
const APPROVER_STATUSES: { status: OrderStatus; fulfillmentType: FulfillmentType }[] = [
  { status: 'pending_approval', fulfillmentType: 'delivery' },
  { status: 'approved', fulfillmentType: 'delivery' },
  { status: 'picking_complete', fulfillmentType: 'pickup' },
  { status: 'packing_slip_generated', fulfillmentType: 'pickup' },
  { status: 'staged_for_pickup', fulfillmentType: 'pickup' },
  { status: 'staged_for_delivery', fulfillmentType: 'delivery' },
  { status: 'in_transit', fulfillmentType: 'delivery' },
  { status: 'backordered', fulfillmentType: 'delivery' },
];

/** One load of the order, run to the end, by a fresh screen with `saved`. */
async function singleLoad(
  role: Role,
  saved: ReadonlySet<Permission>,
  order: OrderRow,
  workingIn: string[],
) {
  const s = orderScreen(APPROVER);
  const client = serverClient({ row: order, workingIn });
  s.render({ role, permissions: savedSet(saved), permissionsRead: true, client }).focus();
  await s.settled();
  return { s, reads: client.reads };
}

/** Where the older load is held when the newer one starts: each is followed by its own check. */
type HeldAt = 'header' | 'org row' | 'attachments' | 'tracking';

/**
 * Two loads of the screen, the older one finishing last: the render before a
 * per-user grant of orders:approve lands (`before`: the staff defaults saved,
 * or nothing saved yet, so the static defaults decide: no warehouse read
 * outside picking) and the render after it. The older load is held at
 * `heldAt` (by default its header read, so the newer one starts before it has
 * read anything); held later, it has already passed the checks before that
 * read, and only the check after it can stop it. The newer one is held at
 * its header and released first.
 */
async function race(
  order: OrderRow,
  before: ReadonlySet<Permission> | undefined = SAVED_PICKER,
  heldAt: HeldAt = 'header',
) {
  const s = orderScreen(APPROVER);
  const server: Server = { row: order, workingIn: [WH_A] };
  const older = deferred();
  const newer = deferred();
  const olderReads = { tracking: 0 };
  const olderClient = serverClient(
    server,
    heldAt === 'header'
      ? { order_requests: [older.promise] }
      : heldAt === 'org row'
        ? { organizations: [older.promise] }
        : {},
  );
  const newerClient = serverClient(server, { order_requests: [newer.promise] });
  s.render({
    role: 'staff',
    permissions: before === undefined ? undefined : savedSet(before),
    permissionsRead: true,
    client: olderClient,
    readAttachments:
      heldAt === 'attachments'
        ? async () => {
            await older.promise;
            return { attachments: [], error: null };
          }
        : undefined,
    getOrderShipment: async () => {
      olderReads.tracking += 1;
      if (heldAt === 'tracking') await older.promise;
      return null;
    },
  }).focus();
  // Held past its first reads, the older load is the newest until the newer starts.
  if (heldAt !== 'header') await flush();
  s.render(approverRender(newerClient)).focus();
  newer.resolve();
  await flush();
  const afterNewer = s.state.order;
  older.resolve();
  await s.settled();
  return {
    s,
    afterNewer,
    olderReads: olderClient.reads,
    newerReads: newerClient.reads,
    olderTrackingReads: olderReads.tracking,
  };
}

describe('(1) a fresh open: nothing is read before the saved set is, then one load, with the warehouses', () => {
  it('the render before the saved set is read reads nothing and shows nothing; the next loads once (mutation: the wait removed)', async () => {
    const s = orderScreen(APPROVER);
    const server: Server = { row: row(), workingIn: [WH_A] };
    const unreadClient = serverClient(server);
    const unread = permissionsOnceRead({ permissions: undefined, read: false });
    expect(unread).toBe(NO_PERMISSIONS);
    s.render({
      role: 'staff',
      permissions: unread,
      permissionsRead: false,
      client: unreadClient,
    }).focus();
    await s.settled();
    expect(unreadClient.reads).toEqual([]);
    expect(s.state.order).toBeUndefined();
    expect(s.state.loading).toBe(true);
    const readClient = serverClient(server);
    s.render(approverRender(readClient)).focus();
    await s.settled();
    // One header read in all (the walk saw two), with the warehouses beside it.
    expect(readClient.reads.filter((t) => t === 'order_requests')).toHaveLength(1);
    expect(readClient.reads).toContain('user_warehouse_assignments');
    expect(s.state.order?.warehouseScope).toEqual(SCOPE_A);
    expect(s.state.loading).toBe(false);
    expect(offeredButtons(s.state.order!, APPROVER_VIEW)).toEqual(NOTHING);
  });

  it('until the saved set is read the screen gates with nothing, never the static defaults (mutation: gate with the hook value)', () => {
    const unread = permissionsOnceRead({ permissions: undefined, read: false });
    const onA: ShownOrder = { ...row({ warehouseId: WH_A }), warehouseScope: null };
    // A manager whose orders:approve the saved set revokes: the static
    // defaults would offer them everything until the set was read.
    expect(offered(onA, { role: 'manager', permissions: unread }).actions).toEqual([]);
    expect(offered(onA, { role: 'manager', permissions: undefined }).actions).toContain('approve');
  });
});

describe('(2) two loads, the older one finishing last: the newer stays on screen, and a warehouse-B order offers no approver control', () => {
  it.each(APPROVER_STATUSES)(
    '$status (mutation: a newest-load check taken out of load)',
    async ({ status, fulfillmentType }) => {
      const order = row({
        status,
        fulfillmentType,
        assignedDeliveryUserId: status === 'in_transit' ? SOMEONE_ELSE : null,
      });
      const { s, afterNewer, olderReads, newerReads } = await race(order);
      // The older load read no warehouses (no orders:approve yet), the newer
      // did; overtaken, the older read nothing after its lines.
      expect(olderReads).toEqual(['order_requests', 'order_request_lines']);
      expect(newerReads).toContain('user_warehouse_assignments');
      expect(afterNewer?.warehouseScope).toEqual(SCOPE_A);
      // The older one landed last and changed nothing.
      expect(s.state.order?.warehouseScope).toEqual(SCOPE_A);
      expect(s.state.remembered).toHaveLength(1);
      expect(s.state.remembered[0]!.order.warehouseScope).toEqual(SCOPE_A);
      expect(s.state.loading).toBe(false);
      expect(offeredButtons(s.state.order!, APPROVER_VIEW)).toEqual(NOTHING);
    },
  );

  // Each check in `load` run for real: the older load held at the read
  // before it, so that check alone stands between it and the screen.
  it.each([
    { heldAt: 'org row', check: 'the check before the order is shown' },
    { heldAt: 'attachments', check: 'the check after the attachments read' },
    { heldAt: 'tracking', check: 'the check after the tracking read' },
  ] as const)(
    'the older load held at its $heldAt read when the newer starts: $check stops it (mutation: that check taken out)',
    async ({ heldAt }) => {
      const { s, olderTrackingReads } = await race(
        row({ status: 'approved' }),
        SAVED_PICKER,
        heldAt,
      );
      expect(s.state.order?.warehouseScope).toEqual(SCOPE_A);
      expect(s.state.remembered).toHaveLength(1);
      expect(s.state.remembered[0]!.order.warehouseScope).toEqual(SCOPE_A);
      expect(s.state.loading).toBe(false);
      // Overtaken, it reads nothing more: no tracking read after the attachments.
      expect(olderTrackingReads).toBe(heldAt === 'tracking' ? 1 : 0);
      expect(offeredButtons(s.state.order!, APPROVER_VIEW)).toEqual(NOTHING);
    },
  );

  it("the walk's own race, the older load run with nothing saved (the static defaults): the same", async () => {
    const { s, olderReads } = await race(row(), undefined);
    expect(olderReads).not.toContain('user_warehouse_assignments');
    expect(s.state.order?.warehouseScope).toEqual(SCOPE_A);
    expect(offeredButtons(s.state.order!, APPROVER_VIEW)).toEqual(NOTHING);
  });

  it("the same race on warehouse A's order offers the approver controls, from the newer load's warehouses (the older one landing last would leave nothing offered)", async () => {
    const { s } = await race(row({ warehouseId: WH_A }));
    const a = offered(s.state.order!, APPROVER_VIEW);
    expect(a.actions).toEqual(expect.arrayContaining(['approve', 'approvePartial', 'deny']));
    expect(a).toMatchObject({ cancel: 'Cancel order', lineChanges: true, neededBy: true });
  });

  it("the older load's order, gated with the saved set before the newer one lands, offers nothing either (mutation: orderWarehouseAccess in place of orderWarehouseAccessAsShown)", () => {
    for (const { status, fulfillmentType } of APPROVER_STATUSES) {
      const unscoped: ShownOrder = { ...row({ status, fulfillmentType }), warehouseScope: null };
      expect(offeredButtons(unscoped, APPROVER_VIEW), status).toEqual(NOTHING);
    }
  });
});

describe("(3) the approver's own pending request in warehouse B, and B23", () => {
  const own = row({ requesterUserId: APPROVER });

  it('their own request after the race: Cancel request, no approver control, no line change', async () => {
    const { s } = await race(own);
    expect(s.state.order?.warehouseScope).toEqual(SCOPE_A);
    expect(offeredButtons(s.state.order!, APPROVER_VIEW)).toEqual({
      ...NOTHING,
      cancel: 'Cancel request',
    });
  });

  it("the older load's order before the newer one lands: the same", () => {
    const unscoped: ShownOrder = { ...own, warehouseScope: null };
    expect(offeredButtons(unscoped, APPROVER_VIEW)).toEqual({
      ...NOTHING,
      cancel: 'Cancel request',
    });
  });

  it('in warehouse A, their own request keeps every approver control', async () => {
    const { s } = await race({ ...own, warehouseId: WH_A });
    expect(offered(s.state.order!, APPROVER_VIEW)).toMatchObject({
      cancel: 'Cancel order',
      lineChanges: true,
      neededBy: true,
    });
  });

  const gone = row({
    status: 'in_transit',
    fulfillmentType: 'delivery',
    inTransitAt: '2026-11-02T22:00:00Z',
    assignedDeliveryUserId: null,
  });

  it('B23, an in-transit delivery of warehouse B whose driver deleted their account: no deleted-driver line, no Collect signature, nothing offered', async () => {
    const { s } = await race(gone);
    const b = offered(s.state.order!, APPROVER_VIEW);
    expect(b.deletedDriverLine).toBeNull();
    expect(b.actions).not.toContain('digitalSignature');
    expect(offeredButtons(s.state.order!, APPROVER_VIEW)).toEqual(NOTHING);
    const unscoped: ShownOrder = { ...gone, warehouseScope: null };
    expect(offeredButtons(unscoped, APPROVER_VIEW)).toEqual(NOTHING);
  });

  it('B23 in warehouse A: the line, and Collect signature', async () => {
    const { s } = await race({ ...gone, warehouseId: WH_A });
    const a = offered(s.state.order!, APPROVER_VIEW);
    expect(a.deletedDriverLine).toBe(deletedDriverHandOverLine({ offersPhysicalSignature: false }));
    expect(a.actions).toContain('digitalSignature');
  });
});

describe('(4) a single load is unchanged: managers, pickers and a failed read', () => {
  const before = (input: Parameters<typeof orderWarehouseAccessAsShown>[0]) =>
    orderWarehouseAccess(input);

  it('a manager: no warehouse read, every approver control on any warehouse, as before', async () => {
    for (const { status, fulfillmentType } of APPROVER_STATUSES) {
      const { s, reads } = await singleLoad(
        'manager',
        SAVED_MANAGER,
        row({ status, fulfillmentType }),
        [],
      );
      expect(reads, status).not.toContain('user_warehouse_assignments');
      expect(s.state.order?.warehouseScope, status).toBeNull();
      const view = { role: 'manager' as const, permissions: SAVED_MANAGER };
      const now = offeredButtons(s.state.order!, view);
      expect(now, status).toEqual(offeredButtons(s.state.order!, view, before));
      expect(now.actions.length + (now.cancel ? 1 : 0), status).toBeGreaterThan(0);
    }
  });

  it('a picker (staff, no orders:approve): Claim and the pick in their own warehouse only, read at a picking status, as before', async () => {
    const view = { role: 'staff' as const, permissions: SAVED_PICKER };
    for (const [warehouseId, expected] of [
      [WH_A, { claim: true, release: true, pick: true }],
      [WH_B, { claim: false, release: false, pick: false }],
    ] as const) {
      const one = await singleLoad(
        'staff',
        SAVED_PICKER,
        row({ status: 'pick_slip_generated', warehouseId }),
        [WH_A],
      );
      expect(one.reads).toContain('user_warehouse_assignments');
      const claim = offeredButtons(one.s.state.order!, view);
      expect(claim.claim, warehouseId).toBe(expected.claim);
      expect(claim).toEqual(offeredButtons(one.s.state.order!, view, before));
      const two = await singleLoad(
        'staff',
        SAVED_PICKER,
        row({ status: 'picking_in_progress', assignedPickerId: APPROVER, warehouseId }),
        [WH_A],
      );
      const picking = offeredButtons(two.s.state.order!, view);
      expect(picking.release, warehouseId).toBe(expected.release);
      expect(picking.pick, warehouseId).toBe(expected.pick);
      expect(picking).toEqual(offeredButtons(two.s.state.order!, view, before));
    }
  });

  it('a picker outside picking: nothing read, offered as before (their own pending request: Cancel request and the line changes)', async () => {
    const { s, reads } = await singleLoad(
      'staff',
      SAVED_PICKER,
      row({ requesterUserId: APPROVER }),
      [WH_A],
    );
    expect(reads).not.toContain('user_warehouse_assignments');
    const view = { role: 'staff' as const, permissions: SAVED_PICKER };
    const now = offeredButtons(s.state.order!, view);
    expect(now).toEqual(offeredButtons(s.state.order!, view, before));
    expect(now).toEqual({ ...NOTHING, cancel: 'Cancel request', lineChanges: true });
  });

  it("a staff approver's single load: exactly what the warehouses it read decide, as before", async () => {
    for (const warehouseId of [WH_A, WH_B]) {
      const { s } = await singleLoad('staff', SAVED_APPROVER, row({ warehouseId }), [WH_A]);
      expect(offeredButtons(s.state.order!, APPROVER_VIEW)).toEqual(
        offeredButtons(s.state.order!, APPROVER_VIEW, before),
      );
    }
  });

  it('a warehouse read that failed still decides nothing: offered as before, the server answers', async () => {
    const s = orderScreen(APPROVER);
    const client = fakeOrderClient({
      order_requests: () => headerAnswer(row()),
      order_request_lines: () => linesAnswer(),
      user_warehouse_assignments: () => ({ data: null, error: { message: 'timeout' } }),
    });
    s.render(approverRender(client)).focus();
    await s.settled();
    expect(s.state.order?.warehouseScope).toEqual({
      writableIds: [],
      readableIds: [],
      unreadable: true,
    });
    const now = offeredButtons(s.state.order!, APPROVER_VIEW);
    expect(now).toEqual(offeredButtons(s.state.order!, APPROVER_VIEW, before));
    expect(now.actions).toContain('approve');
  });
});

describe('(5) an offline open is unchanged: the view kept in memory, gated with the saved set on the phone', () => {
  it('an offline load reads nothing and takes no number: a load already on its way still shows what it read (mutation: offline takes a number)', async () => {
    const s = orderScreen(APPROVER);
    const server: Server = { row: row({ warehouseId: WH_A }), workingIn: [WH_A] };
    const held = deferred();
    s.render(approverRender(serverClient(server, { order_requests: [held.promise] }))).focus();
    const offlineClient = serverClient(server);
    s.render({ ...approverRender(offlineClient), offline: true }).focus();
    held.resolve();
    await s.settled();
    expect(offlineClient.reads).toEqual([]);
    expect(s.state.order?.warehouseScope).toEqual(SCOPE_A);
    expect(s.state.remembered).toHaveLength(1);
  });

  it("the view kept for offline is the newest load's, and offers offline what it offered online", async () => {
    for (const warehouseId of [WH_A, WH_B]) {
      const { s } = await race(row({ warehouseId }));
      expect(s.state.remembered).toHaveLength(1);
      const recalled = s.state.remembered[0]!.order;
      expect(recalled.warehouseScope).toEqual(SCOPE_A);
      const cached = savedSet(SAVED_APPROVER);
      expect(offeredButtons(recalled, { role: 'staff', permissions: cached })).toEqual(
        offeredButtons(s.state.order!, APPROVER_VIEW),
      );
      expect(offeredButtons(recalled, { role: 'staff', permissions: cached })).toEqual(
        offeredButtons(recalled, { role: 'staff', permissions: cached }, (input) =>
          orderWarehouseAccess(input),
        ),
      );
    }
  });

  it('once read, the saved set gates (or the static defaults when nothing is saved, as before)', () => {
    const saved = new Set<Permission>(SAVED_APPROVER);
    expect(permissionsOnceRead({ permissions: saved, read: true })).toBe(saved);
    expect(permissionsOnceRead({ permissions: undefined, read: true })).toBeUndefined();
  });
});

/** The screen's runAction as the render that built it holds it. */
function runActionOf(
  s: ReturnType<typeof orderScreen>,
  rendered: { load: () => Promise<void> },
  log: string[],
) {
  return screenFunction<(key: string, fn: () => Promise<void>) => Promise<boolean>>(
    SCREEN_FILE,
    'runAction',
    {
      // Each change of the busy key, with the order on screen at that moment.
      setActing: (key: string | null) => log.push(`acting ${key} on ${s.state.order?.status}`),
      Alert: { alert: () => log.push('alert') },
      reloadAfterFailedOrderAction,
      load: rendered.load,
      reload: s.reload,
    },
  );
}

describe("(6) review F1: an action's reload runs the newest load, never the one its render built", () => {
  // The reviewer's case: a picker of warehouse A taps an action (Complete
  // picking's reload is the same, through DigitalPick's onCompleted) and a
  // per-user grant of orders:approve lands while it is on its way. The grant
  // rebuilt `load` and the focus effect read the order with it; then the
  // action's reload ran the `load` from the tap, without orders:approve, so
  // at picking_complete it read no warehouses, and the order it left on
  // screen was offered nothing until a refresh.
  it('a grant that lands while the action is on its way: the reload reads the warehouses and warehouse A offers the approver controls (mutation: the reload runs the load from the tap)', async () => {
    const s = orderScreen(APPROVER);
    const server: Server = {
      row: row({
        status: 'picking_in_progress',
        fulfillmentType: 'pickup',
        warehouseId: WH_A,
        assignedPickerId: APPROVER,
      }),
      workingIn: [WH_A],
    };
    const atTap = s.render({
      role: 'staff',
      permissions: savedSet(SAVED_PICKER),
      permissionsRead: true,
      client: serverClient(server),
    });
    atTap.focus();
    await s.settled();
    expect(s.state.order?.status).toBe('picking_in_progress');
    const log: string[] = [];
    const sent = deferred();
    const tap = runActionOf(
      s,
      atTap,
      log,
    )('complete-picking', async () => {
      await sent.promise;
      server.row = { ...server.row, status: 'picking_complete' };
    });
    // The grant lands: the screen renders again and its focus effect reads
    // the order with the new `load` (held, so the action's reload is newer).
    const focusRead = deferred();
    s.render(approverRender(serverClient(server, { order_requests: [focusRead.promise] }))).focus();
    sent.resolve();
    await expect(tap).resolves.toBe(true);
    focusRead.resolve();
    await s.settled();
    expect(s.state.order?.status).toBe('picking_complete');
    expect(s.state.order?.warehouseScope).toEqual(SCOPE_A);
    // What a fresh open offers the approver on this order, nothing less.
    const fresh = await singleLoad('staff', SAVED_APPROVER, server.row, [WH_A]);
    const now = offeredButtons(s.state.order!, APPROVER_VIEW);
    expect(now).toEqual(offeredButtons(fresh.s.state.order!, APPROVER_VIEW));
    expect(now.actions).toContain('generatePackingSlips');
  });
});

describe('(7) review F2: after an action, the busy key and the reason dialog wait for the newest load', () => {
  // Docket B60's flow with a newer load on its way: a Deny refused because
  // another phone approved the order, while the connection dropped and came
  // back (the focus effect started a newer load). The reload stopped at its
  // check, runAction returned over the order from before the tap, and the
  // dialog kept its reason for a Deny the order no longer offered.
  it('a refused Deny: the busy key clears and the dialog settles on the order read again (mutation: runAction returns when its own reload stops)', async () => {
    const s = orderScreen(APPROVER);
    const holds: Holds = {};
    const server: Server = { row: row({ warehouseId: WH_A }), workingIn: [WH_A] };
    const shown = s.render(approverRender(serverClient(server, holds)));
    shown.focus();
    await s.settled();
    expect(offered(s.state.order!, APPROVER_VIEW).manager.deny).toBe(true);

    const log: string[] = [];
    const runAction = runActionOf(s, shown, log);
    const act = screenFunction<(body: unknown, key: string) => Promise<boolean>>(
      SCREEN_FILE,
      'act',
      {
        id: ORDER_ID,
        runAction,
        transitionOrder: async () => {
          throw Object.assign(new Error('Request not found or no longer pending approval.'), {
            status: 409,
          });
        },
      },
    );
    const dialog = {
      open: true,
      reason: 'Duplicate of another request.',
      check: null as string | null,
    };
    const setDenyOpen = (v: boolean) => {
      dialog.open = v;
    };
    const setDenyReason = (v: string) => {
      dialog.reason = v;
    };
    const setFailedReasonDialog = (v: string | null) => {
      dialog.check = v;
    };
    const submitDeny = screenFunction<() => Promise<void>>(SCREEN_FILE, 'submitDeny', {
      acting: null,
      denyReason: dialog.reason,
      Alert: { alert: () => log.push('alert') },
      act,
      setDenyOpen,
      setDenyReason,
      setFailedReasonDialog,
    });
    // The screen's effect, in the render after the tap is over: the check
    // runs on the order on screen then.
    const settleNow = () => {
      const order = s.state.order ?? null;
      const settle = screenFunction<(dialog: 'deny' | 'reopen') => void>(
        SCREEN_FILE,
        'settleFailedReasonDialog',
        {
          managerActions: order
            ? offered(order, APPROVER_VIEW).manager
            : { deny: false, reopenPicking: false },
          order,
          loadError: s.state.loadError ?? null,
          keepReasonDialogOpen,
          setFailedReasonDialog,
          dismissDenyModal: screenFunction(SCREEN_FILE, 'dismissDenyModal', {
            setDenyOpen,
            setDenyReason,
          }),
          dismissReopenModal: screenFunction(SCREEN_FILE, 'dismissReopenModal', {
            setReopenOpen: () => undefined,
            setReopenReason: () => undefined,
          }),
        },
      );
      log.push(`settled on ${order?.status}`);
      if (dialog.check === 'deny') settle('deny');
    };

    // Another phone approves it; this phone's reload after the refusal is held.
    server.row = { ...server.row, status: 'approved' };
    const reloadRead = deferred();
    holds.order_requests = [reloadRead.promise];
    const tap = submitDeny().then(settleNow);
    await flush();
    // The connection drops and comes back: two renders, the second's focus
    // load newer than the reload.
    s.render({ ...approverRender(serverClient(server)), offline: true }).focus();
    const newerRead = deferred();
    s.render(approverRender(serverClient(server, { order_requests: [newerRead.promise] }))).focus();
    reloadRead.resolve();
    await flush();
    newerRead.resolve();
    await tap;
    await s.settled();

    expect(log).toEqual([
      'acting deny on pending_approval',
      'alert',
      'acting null on approved',
      'settled on approved',
    ]);
    // Deny is no longer offered: the dialog closed and its reason is gone.
    expect(dialog).toEqual({ open: false, reason: '', check: null });
  });

  it('a successful action clears its busy key only once the newest load is on screen', async () => {
    const s = orderScreen(APPROVER);
    const holds: Holds = {};
    const server: Server = { row: row({ warehouseId: WH_A }), workingIn: [WH_A] };
    const shown = s.render(approverRender(serverClient(server, holds)));
    shown.focus();
    await s.settled();
    const log: string[] = [];
    const reloadRead = deferred();
    holds.order_requests = [reloadRead.promise];
    const tap = runActionOf(
      s,
      shown,
      log,
    )('approve', async () => {
      server.row = { ...server.row, status: 'approved' };
    });
    await flush();
    s.render({ ...approverRender(serverClient(server)), offline: true }).focus();
    const newerRead = deferred();
    s.render(approverRender(serverClient(server, { order_requests: [newerRead.promise] }))).focus();
    reloadRead.resolve();
    await flush();
    expect(log).toEqual(['acting approve on pending_approval']);
    newerRead.resolve();
    await expect(tap).resolves.toBe(true);
    expect(log).toEqual(['acting approve on pending_approval', 'acting null on approved']);
  });
});

describe('(8) review F4: only the newest read of the attachments shows them', () => {
  const OLD: AttachmentsRead = { attachments: ['proof 1'], error: null };
  const NEW: AttachmentsRead = { attachments: ['proof 1', 'proof 2'], error: null };

  /** A screen whose attachment reads answer in turn from `answers`. */
  function withAttachments(answers: Promise<AttachmentsRead | null>[]) {
    const s = orderScreen(APPROVER);
    const server: Server = {
      row: row({ warehouseId: WH_A, status: 'approved' }),
      workingIn: [WH_A],
    };
    const rendered = s.render({
      ...approverRender(serverClient(server)),
      readAttachments: () => answers.shift() ?? Promise.resolve(NEW),
    });
    return { s, rendered };
  }

  it("the order's load read before an upload's row was saved, and lands after the upload's read: the upload's list stays (mutation: the load shows any attachments it read)", async () => {
    const loadsRead = deferred<AttachmentsRead | null>();
    const { s, rendered } = withAttachments([loadsRead.promise, Promise.resolve(NEW)]);
    rendered.focus();
    await flush();
    // The load is reading the attachments; the upload finishes and reads them.
    await rendered.loadAttachments();
    expect(s.state.attachments).toEqual(NEW.attachments);
    loadsRead.resolve(OLD);
    await s.settled();
    expect(s.state.order?.status).toBe('approved');
    expect(s.state.attachments).toEqual(NEW.attachments);
  });

  it("an upload's read that a pull to refresh overtook: the refresh's list stays (mutation: loadAttachments shows any list it read)", async () => {
    const uploadRead = deferred<AttachmentsRead | null>();
    const { s, rendered } = withAttachments([
      Promise.resolve(OLD),
      uploadRead.promise,
      Promise.resolve(NEW),
    ]);
    rendered.focus();
    await s.settled();
    expect(s.state.attachments).toEqual(OLD.attachments);
    const upload = rendered.loadAttachments();
    rendered.focus();
    await s.settled();
    expect(s.state.attachments).toEqual(NEW.attachments);
    uploadRead.resolve(OLD);
    await upload;
    expect(s.state.attachments).toEqual(NEW.attachments);
  });
});

// ── Wiring: the screen's hooks call these, in this order ────────────────────

const SCREEN = readFileSync(path.resolve(__dirname, '../..', SCREEN_FILE), 'utf8');

/** Source with comments stripped, so a comment can never satisfy a pin. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** The statements of the screen's `load` callback body, found by the parser. */
function loadStatements(): { sf: ts.SourceFile; statements: readonly ts.Statement[] } {
  const found = callbackStatements(SCREEN, SCREEN_FILE, 'load');
  expect(found, 'load in the order screen').not.toBeNull();
  return found!;
}

/** Everything the load changes on screen (or keeps for offline). */
const COMMITS = new Set([
  'setOrder',
  'setLoadError',
  'setLoading',
  'setAttachments',
  'setAttachmentsError',
  'setShipment',
  'rememberOrderView',
]);

/**
 * Every use of the name `load` in the screen that is the order screen's own
 * `load` (not a property, a JSX attribute or a declaration), with the text
 * of the expression it sits in.
 */
function usesOfLoad(): string[] {
  const sf = parseTsx(SCREEN, SCREEN_FILE);
  const out: string[] = [];
  walk(sf, (n) => {
    if (!ts.isIdentifier(n) || n.text !== 'load') return;
    const p = n.parent;
    if (ts.isPropertyAccessExpression(p) && p.name === n) return;
    if ((ts.isPropertyAssignment(p) || ts.isJsxAttribute(p)) && p.name === n) return;
    if (ts.isVariableDeclaration(p) && p.name === n) return;
    if (ts.isBindingElement(p)) return;
    out.push(p.getText(sf).replace(/\s+/g, ' '));
  });
  return out;
}

describe('wiring: the order screen', () => {
  it('numbers its loads with the tested runner, and its attachment reads with their own guard', () => {
    const code = codeOnly(SCREEN);
    expect(code).toContain("import { createNewestLoads } from '@/lib/newest-load';");
    expect(code).toContain('const [loads] = React.useState(() => createNewestLoads());');
    expect(code).toContain("import { createSequenceGuard } from '@/lib/debounced-list-load';");
    expect(code).toContain(
      'const [attachmentReads] = React.useState(() => createSequenceGuard());',
    );
  });

  // Mutation caught: any newest-load check deleted, or a change to the
  // screen moved after a read without one (the walk's defect: every change
  // after a read went on screen whichever load it belonged to).
  it('changes nothing after a read unless it is still the newest load', () => {
    const { sf, statements } = loadStatements();
    const { unguarded, guards } = unguardedCommits(
      sf,
      statements,
      COMMITS,
      '!loads.isCurrent(seq)',
    );
    expect(unguarded).toEqual([]);
    expect(guards).toBeGreaterThanOrEqual(4);
    // The commits the check covers are all still in `load`.
    const all = statements.flatMap((st) => commitsIn(st, COMMITS));
    for (const name of COMMITS) expect(all, name).toContain(name);
  });

  // Mutation caught: the number taken after the header read (an older load
  // would then count as newer), the offline return taking one (a load on its
  // way would be dropped offline), or the wait for the saved set removed.
  // The runner reads the number a load took before its first await
  // (lib/newest-load), so nothing may be awaited before it.
  it('waits for the saved set, then takes its number before its first read; offline it takes none', () => {
    const { sf, statements } = loadStatements();
    const at = (pred: (st: ts.Statement) => boolean, label: string) => {
      const i = statements.findIndex(pred);
      expect(i, label).toBeGreaterThan(-1);
      return i;
    };
    const text = (st: ts.Statement) => st.getText(sf);
    const uuid = at((st) => text(st).startsWith('if (!isUuid(id))'), 'uuid branch');
    const offline = at((st) => text(st).startsWith('if (offline)'), 'offline return');
    const wait = at((st) => text(st) === 'if (!permissionsRead) return;', 'wait for the saved set');
    const ticket = at((st) => text(st) === 'const seq = loads.next();', 'the number');
    const header = at((st) => text(st).includes("from('order_requests')"), 'header read');
    expect(uuid).toBeLessThan(offline);
    expect(offline).toBeLessThan(wait);
    expect(wait).toBeLessThan(ticket);
    expect(ticket).toBe(header - 1);
    expect(codeOnly(text(statements[uuid]!))).toContain('loads.next();');
    expect(codeOnly(text(statements[offline]!))).not.toContain('loads.next');
    expect(statements.slice(0, header).filter((st) => awaitsIn(st))).toEqual([]);
  });

  it('runs again when the saved set is read, every focus load through the runner', () => {
    expect(SCREEN).toMatch(
      /\}, \[\s*orgId,\s*id,\s*loads,\s*attachmentReads,\s*readAttachments,\s*offline,\s*permissionsRead,\s*userId,\s*role,\s*rpApprove,\s*rpItems,\s*rpBuy,?\s*\]\);/,
    );
    expect(SCREEN).toMatch(
      /useFocusEffect\(\s*React\.useCallback\(\(\) => \{\s*void loads\.run\(load\);\s*\}, \[loads, load\]\),\s*\);/,
    );
  });

  // Review F1. Mutation caught: any reload calling `load` (the one its
  // handler's render built), or the newest load no longer kept for reload.
  it('every reload after the screen opened runs the newest load, kept in the runner after every render', () => {
    const code = codeOnly(SCREEN);
    expect(code).toMatch(
      /React\.useLayoutEffect\(\(\) => \{\s*loads\.keep\(load\);\s*\}, \[loads, load\]\);/,
    );
    expect(code).toContain('const reload = React.useCallback(() => loads.reload(), [loads]);');
    // `load` itself is only ever handed to the runner (kept for reload, and
    // run by the focus effect); nothing calls it.
    expect(usesOfLoad().sort()).toEqual(
      ['loads.keep(load)', '[loads, load]', 'loads.run(load)', '[loads, load]'].sort(),
    );
    // So every caller reloads through `reload`: the actions, the sheets, the
    // pick, the signature pad, pull to refresh and Try again.
    expect(code).toContain('onCompleted={() => void reload()}');
    expect(code).toMatch(
      /reread: \(orderId\) => readOrderReadiness\(supabase, orderId\),\s*reload,\s*\}/,
    );
  });

  // Review F2: runAction keeps its busy key until the newest load is on
  // screen (also run above, (7)).
  it('runAction reloads through reload, under its busy key', () => {
    const code = codeOnly(SCREEN).replace(/\s+/g, ' ');
    expect(code).toContain('await fn(); await reload(); return true;');
    expect(code).toContain(
      'if (reloadAfterFailedOrderAction(e)) await reload().catch(() => undefined);',
    );
  });

  // Mutation caught: the screen gating with useEffectivePermissions() (the
  // static defaults until the saved set is read).
  it('gates with the saved set once read, and with nothing until then', () => {
    const code = codeOnly(SCREEN);
    expect(code).toContain(
      "import { permissionsOnceRead, useEffectivePermissionsState } from '@/lib/use-effective-permissions';",
    );
    expect(code).toContain('const savedPermissions = useEffectivePermissionsState();');
    expect(code).toContain('const permissionsRead = savedPermissions.read === true;');
    expect(code).toMatch(
      /const permissions = React\.useMemo\(\s*\(\) => permissionsOnceRead\(savedPermissions\),\s*\[savedPermissions\],?\s*\);/,
    );
    expect(code).not.toMatch(/useEffectivePermissions\(\)/);
    expect(code).toMatch(/\} = readinessPermissionsFor\(role, permissions\);/);
  });

  it('decides the warehouse gates for the permissions it gates with, the ones the scope read is asked with', () => {
    expect(SCREEN).toMatch(
      /const orderAccess = orderWarehouseAccessAsShown\(\{\s*role,\s*warehouseId: order\?\.warehouseId \?\? null,\s*scope: order\?\.warehouseScope \?\? null,\s*status: order\?\.status \?\? null,\s*canApproveOrders: rpApprove === true,\s*canPick: rpItems === true,\s*\}\);/,
    );
    expect(SCREEN).toMatch(
      /needsOrderWarehouseScope\(\{\s*role,\s*canApproveOrders: rpApprove,\s*canPick: rpItems,\s*status: \(headerForReadiness\.status as string \| null\) \?\? null,\s*\}\)/,
    );
  });

  // Review F4: each read of the attachments takes a number from their own
  // guard and shows what it read only while it is the newest read of them;
  // the load's also only while it is the newest load (run above, (8)).
  it('reads the attachments without showing them, and shows a read only while it is the newest', () => {
    const code = codeOnly(SCREEN);
    const read = code.slice(
      code.indexOf('const readAttachments = React.useCallback('),
      code.indexOf('const loadAttachments = React.useCallback('),
    );
    expect(read).toContain("from('order_request_attachments')");
    expect(read).not.toMatch(/setAttachments(Error)?\(/);
    expect(code).toMatch(
      /const loadAttachments = React\.useCallback\(async \(\) => \{\s*const seq = attachmentReads\.next\(\);\s*const read = await readAttachments\(\);\s*if \(!read \|\| !attachmentReads\.isCurrent\(seq\)\) return;\s*setAttachmentsError\(read\.error\);\s*setAttachments\(read\.attachments\);\s*\}, \[attachmentReads, readAttachments\]\);/,
    );
    expect(code).toMatch(
      /const attachmentsSeq = attachmentReads\.next\(\);\s*const attachmentsRead = await readAttachments\(\);\s*if \(!loads\.isCurrent\(seq\)\) return;\s*if \(attachmentsRead && attachmentReads\.isCurrent\(attachmentsSeq\)\) \{\s*setAttachmentsError\(attachmentsRead\.error\);\s*setAttachments\(attachmentsRead\.attachments\);\s*\}/,
    );
    // readAttachments is read only by these two.
    expect(code.match(/await readAttachments\(\)/g)).toHaveLength(2);
    // loadAttachments shows what it read: `load` never calls it.
    const { statements } = loadStatements();
    const calls: string[] = [];
    for (const st of statements) {
      walk(st, (n) => {
        if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) calls.push(n.expression.text);
      });
    }
    expect(calls).toContain('readAttachments');
    expect(calls).not.toContain('loadAttachments');
  });
});

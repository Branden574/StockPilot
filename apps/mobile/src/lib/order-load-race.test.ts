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
import { createSequenceGuard } from './debounced-list-load';
import type { AssignmentReadClient } from './holdings-elsewhere';
import { phoneOrderCancel } from './order-cancel-action';
import { orderManagerActions } from './order-manager-actions';
import { canOfferNeededByChange } from './order-needed-by';
import { readinessPermissionsFor } from './order-readiness';
import {
  needsOrderWarehouseScope,
  orderWarehouseAccess,
  orderWarehouseAccessAsShown,
  readOrderWarehouseScope,
  type OrderWarehouseAccess,
  type OrderWarehouseScope,
} from './order-warehouse-scope';
import { NO_PERMISSIONS, permissionsOnceRead } from './use-effective-permissions';

// use-effective-permissions reads the device store and the API; only its
// pure permissionsOnceRead is used here.
vi.mock('./db', () => ({ getMeta: vi.fn(), setMeta: vi.fn() }));
vi.mock('./api', () => ({ api: vi.fn() }));

/**
 * S2 FOLLOW-UP: THE PHONE'S ORDER SCREEN SHOWS ONLY ITS NEWEST LOAD, AND
 * NEVER GATES ON PERMISSIONS IT HAS NOT READ (lab walk of #378's release step
 * 6, walk-s2-phone-1103 finding F1).
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
 * Fixed three ways, each pinned here:
 *   1. every load takes a number (createSequenceGuard, the returns
 *      workbench's guard) and only the newest one started changes the screen
 *      (order, error, spinner, attachments, tracking, the view kept for
 *      offline);
 *   2. the screen gates with nothing until the saved set is read
 *      (permissionsOnceRead), and `load` waits for it, so no load runs with
 *      the static defaults;
 *   3. an order on screen whose load did not read the warehouses that the
 *      permissions the render gates with now ask for is offered nothing that
 *      needs them (orderWarehouseAccessAsShown), until the load those
 *      permissions started lands.
 *
 * The screen imports native modules, so vitest cannot render it: the model
 * below runs the screen's load decisions with the same helpers, in the order
 * the wiring pins at the end of this file hold the screen to.
 */

const ORG = '0c000000-0000-0000-0000-0000000000c1';
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
const SAVED_PICKER: ReadonlySet<Permission> = new Set<Permission>(ROLE_PERMISSIONS.staff);

/** The order row as the header read answers it (what the gates read). */
interface OrderRow {
  status: OrderStatus;
  warehouseId: string;
  fulfillmentType: FulfillmentType;
  requesterUserId: string | null;
  assignedPickerId: string | null;
  assignedDeliveryUserId: string | null;
  inTransitAt: string | null;
}

/** What a load put on screen: the row and the warehouses it read with it. */
interface Shown extends OrderRow {
  warehouseScope: OrderWarehouseScope | null;
  /** Which load it came from. */
  from: string;
}

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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** user_warehouse_assignments as the viewer reads it, answered when the test says. */
function assignments(answer: Promise<unknown>) {
  const reads: string[] = [];
  const client: AssignmentReadClient & { reads: string[] } = {
    reads,
    from(table: string) {
      reads.push(table);
      const chain = {
        select: () => chain,
        eq: () => chain,
        then(onOk: (v: unknown) => unknown, onErr?: (e: unknown) => unknown) {
          return answer.then(onOk, onErr);
        },
      };
      return chain;
    },
  };
  return client;
}
const workIn = (...ids: string[]) => ({
  data: ids.map((warehouse_id) => ({ warehouse_id })),
  error: null,
});

/**
 * The screen's order and its loads. `load` is the screen's: a number first,
 * the header, the warehouses read beside the lines when the permissions it
 * runs with ask for them (the screen's needsOrderWarehouseScope call), and
 * the newest-load check after every read that is followed by a change to
 * the screen.
 */
function orderScreen(role: Role, viewerUserId = APPROVER) {
  const loads = createSequenceGuard();
  const screen = {
    shown: null as Shown | null,
    /** What the screen keeps in memory for an offline open (rememberOrderView). */
    remembered: null as Shown | null,
    loading: true,
  };
  async function load(input: {
    from: string;
    permissions: ReadonlySet<Permission> | undefined;
    header: Promise<OrderRow>;
    lines: Promise<void>;
    client: AssignmentReadClient;
  }): Promise<void> {
    const seq = loads.next();
    const order = await input.header;
    const { canApproveOrders: rpApprove, canUpdateItems: rpItems } = readinessPermissionsFor(
      role,
      input.permissions,
    );
    const warehouseScopeRead = needsOrderWarehouseScope({
      role,
      canApproveOrders: rpApprove,
      canPick: rpItems,
      status: order.status,
    })
      ? readOrderWarehouseScope(input.client, { role, organizationId: ORG, userId: viewerUserId })
      : null;
    await input.lines;
    if (!loads.isCurrent(seq)) return;
    const warehouseScope = warehouseScopeRead ? await warehouseScopeRead : null;
    if (!loads.isCurrent(seq)) return;
    screen.shown = { ...order, warehouseScope, from: input.from };
    // The attachments and tracking reads, each followed by the same check.
    await Promise.resolve();
    if (!loads.isCurrent(seq)) return;
    screen.remembered = screen.shown;
    screen.loading = false;
  }
  return { screen, load };
}

/** What the screen offers for `order`, gated with `permissions`, through the
 *  screen's own chain of helpers; `access` is the warehouse decision (the
 *  screen's orderWarehouseAccessAsShown, or the one it used before). */
function offered(
  order: Shown,
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
  const manager = orderManagerActions({
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
  };
}

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

/**
 * The race the walk found: the first load (284fd40e7: run with the static
 * staff defaults, so no orders:approve and no warehouse read) starts, then
 * the second (the saved set: orders:approve, the warehouses read); the
 * second finishes first and the first finishes last.
 */
async function race(order: OrderRow) {
  const s = orderScreen('staff');
  const first = {
    header: deferred<OrderRow>(),
    lines: deferred<void>(),
    assigned: deferred<unknown>(),
  };
  const second = {
    header: deferred<OrderRow>(),
    lines: deferred<void>(),
    assigned: deferred<unknown>(),
  };
  const firstClient = assignments(first.assigned.promise);
  const secondClient = assignments(second.assigned.promise);
  const older = s.load({
    from: 'static defaults',
    permissions: undefined,
    header: first.header.promise,
    lines: first.lines.promise,
    client: firstClient,
  });
  const newer = s.load({
    from: 'saved set',
    permissions: SAVED_APPROVER,
    header: second.header.promise,
    lines: second.lines.promise,
    client: secondClient,
  });
  second.header.resolve(order);
  second.lines.resolve();
  second.assigned.resolve(workIn(WH_A));
  await newer;
  const afterNewer = s.screen.shown;
  first.header.resolve(order);
  first.lines.resolve();
  await older;
  return { s, afterNewer, firstReads: firstClient.reads, secondReads: secondClient.reads };
}

describe('(1) two loads, the older unscoped one finishing last: the newer shows, and a warehouse-B order offers no approver control', () => {
  it.each(APPROVER_STATUSES)('$status', async ({ status, fulfillmentType }) => {
    const order = row({
      status,
      fulfillmentType,
      assignedDeliveryUserId: status === 'in_transit' ? SOMEONE_ELSE : null,
    });
    const { s, afterNewer, firstReads, secondReads } = await race(order);
    // The older load read no warehouses (the static defaults hold no
    // orders:approve), the newer one did.
    expect(firstReads).toEqual([]);
    expect(secondReads).toEqual(['user_warehouse_assignments']);
    // The newer load is on screen, and stays there when the older one lands
    // (mutation: drop a newest-load check, or take the number after a read).
    expect(afterNewer?.from).toBe('saved set');
    expect(s.screen.shown?.from).toBe('saved set');
    expect(s.screen.shown?.warehouseScope).toEqual({
      writableIds: [WH_A],
      readableIds: [WH_A],
      unreadable: false,
    });
    expect(s.screen.remembered?.from).toBe('saved set');
    expect(s.screen.loading).toBe(false);
    expect(offered(s.screen.shown!, { role: 'staff', permissions: SAVED_APPROVER })).toEqual(
      NOTHING,
    );
  });

  it("the older load's order, gated with the saved set before the newer one lands, offers nothing either (mutation: orderWarehouseAccess in place of orderWarehouseAccessAsShown)", () => {
    for (const { status, fulfillmentType } of APPROVER_STATUSES) {
      const unscoped: Shown = {
        ...row({ status, fulfillmentType }),
        warehouseScope: null,
        from: 'static defaults',
      };
      expect(offered(unscoped, { role: 'staff', permissions: SAVED_APPROVER }), status).toEqual(
        NOTHING,
      );
    }
  });

  it("the same race on warehouse A's order offers the approver controls, from the newer load's warehouses", async () => {
    const { s } = await race(row({ warehouseId: WH_A }));
    const a = offered(s.screen.shown!, { role: 'staff', permissions: SAVED_APPROVER });
    expect(a.actions).toEqual(expect.arrayContaining(['approve', 'approvePartial', 'deny']));
    expect(a).toMatchObject({ cancel: 'Cancel order', lineChanges: true, neededBy: true });
  });

  it('until the saved set is read the screen gates with nothing, never the static defaults (mutation: gate with the hook value)', () => {
    const unread = permissionsOnceRead({ permissions: undefined, read: false });
    expect(unread).toBe(NO_PERMISSIONS);
    expect(unread?.size).toBe(0);
    const onA: Shown = { ...row({ warehouseId: WH_A }), warehouseScope: null, from: 'none' };
    // A manager whose orders:approve the saved set revokes: the static
    // defaults would offer them everything until the set was read.
    expect(offered(onA, { role: 'manager', permissions: unread }).actions).toEqual([]);
    expect(offered(onA, { role: 'manager', permissions: undefined }).actions).toContain('approve');
  });
});

describe("(2) the approver's own pending request in warehouse B: Cancel request only", () => {
  const own = row({ requesterUserId: APPROVER });

  it('after the race: Cancel request, no approver control, no line change', async () => {
    const { s } = await race(own);
    expect(s.screen.shown?.from).toBe('saved set');
    expect(offered(s.screen.shown!, { role: 'staff', permissions: SAVED_APPROVER })).toEqual({
      ...NOTHING,
      cancel: 'Cancel request',
    });
  });

  it("the older load's order before the newer one lands: the same", () => {
    const unscoped: Shown = { ...own, warehouseScope: null, from: 'static defaults' };
    expect(offered(unscoped, { role: 'staff', permissions: SAVED_APPROVER })).toEqual({
      ...NOTHING,
      cancel: 'Cancel request',
    });
  });

  it('in warehouse A, their own request keeps every approver control', async () => {
    const { s } = await race({ ...own, warehouseId: WH_A });
    expect(offered(s.screen.shown!, { role: 'staff', permissions: SAVED_APPROVER })).toMatchObject({
      cancel: 'Cancel order',
      lineChanges: true,
      neededBy: true,
    });
  });
});

describe('(3) B23: an in-transit delivery of warehouse B whose driver deleted their account', () => {
  const gone = row({
    status: 'in_transit',
    fulfillmentType: 'delivery',
    inTransitAt: '2026-11-02T22:00:00Z',
    assignedDeliveryUserId: null,
  });

  it('after the race the approver reads no deleted-driver line and is offered no Collect signature', async () => {
    const { s } = await race(gone);
    const b = offered(s.screen.shown!, { role: 'staff', permissions: SAVED_APPROVER });
    expect(b.deletedDriverLine).toBeNull();
    expect(b.actions).not.toContain('digitalSignature');
    expect(b).toEqual(NOTHING);
  });

  it("nor from the older load's order before the newer one lands", () => {
    const unscoped: Shown = { ...gone, warehouseScope: null, from: 'static defaults' };
    expect(offered(unscoped, { role: 'staff', permissions: SAVED_APPROVER })).toEqual(NOTHING);
  });

  it('in warehouse A the approver reads the line and is offered Collect signature', async () => {
    const { s } = await race({ ...gone, warehouseId: WH_A });
    const a = offered(s.screen.shown!, { role: 'staff', permissions: SAVED_APPROVER });
    expect(a.deletedDriverLine).toBe(deletedDriverHandOverLine({ offersPhysicalSignature: false }));
    expect(a.actions).toContain('digitalSignature');
  });
});

/** One load with the saved set, run to the end. */
async function singleLoad(
  role: Role,
  permissions: ReadonlySet<Permission>,
  order: OrderRow,
  workingIn: string[],
) {
  const s = orderScreen(role);
  const client = assignments(Promise.resolve(workIn(...workingIn)));
  await s.load({
    from: 'saved set',
    permissions,
    header: Promise.resolve(order),
    lines: Promise.resolve(),
    client,
  });
  return { s, reads: client.reads };
}

describe('(4) a single load is unchanged: a manager and a picker', () => {
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
      expect(reads, status).toEqual([]);
      expect(s.screen.shown?.warehouseScope, status).toBeNull();
      const now = offered(s.screen.shown!, { role: 'manager', permissions: SAVED_MANAGER });
      expect(now, status).toEqual(
        offered(s.screen.shown!, { role: 'manager', permissions: SAVED_MANAGER }, before),
      );
      expect(now.actions.length + (now.cancel ? 1 : 0), status).toBeGreaterThan(0);
    }
  });

  it('a picker (staff, no orders:approve): Claim and the pick in their own warehouse only, read at a picking status, as before', async () => {
    const unclaimed = { status: 'pick_slip_generated' as const };
    const mine = { status: 'picking_in_progress' as const, assignedPickerId: APPROVER };
    for (const [warehouseId, expected] of [
      [WH_A, { claim: true, release: true, pick: true }],
      [WH_B, { claim: false, release: false, pick: false }],
    ] as const) {
      const one = await singleLoad('staff', SAVED_PICKER, row({ ...unclaimed, warehouseId }), [
        WH_A,
      ]);
      expect(one.reads).toEqual(['user_warehouse_assignments']);
      const claim = offered(one.s.screen.shown!, { role: 'staff', permissions: SAVED_PICKER });
      expect(claim.claim, warehouseId).toBe(expected.claim);
      expect(claim).toEqual(
        offered(one.s.screen.shown!, { role: 'staff', permissions: SAVED_PICKER }, before),
      );
      const two = await singleLoad('staff', SAVED_PICKER, row({ ...mine, warehouseId }), [WH_A]);
      const picking = offered(two.s.screen.shown!, { role: 'staff', permissions: SAVED_PICKER });
      expect(picking.release, warehouseId).toBe(expected.release);
      expect(picking.pick, warehouseId).toBe(expected.pick);
      expect(picking).toEqual(
        offered(two.s.screen.shown!, { role: 'staff', permissions: SAVED_PICKER }, before),
      );
    }
  });

  it('a picker outside picking: nothing read, offered as before (their own pending request: Cancel request and the line changes)', async () => {
    const { s, reads } = await singleLoad(
      'staff',
      SAVED_PICKER,
      row({ requesterUserId: APPROVER }),
      [WH_A],
    );
    expect(reads).toEqual([]);
    const now = offered(s.screen.shown!, { role: 'staff', permissions: SAVED_PICKER });
    expect(now).toEqual(
      offered(s.screen.shown!, { role: 'staff', permissions: SAVED_PICKER }, before),
    );
    expect(now).toEqual({ ...NOTHING, cancel: 'Cancel request', lineChanges: true });
  });

  it("a staff approver's single load: exactly what the warehouses it read decide, as before", async () => {
    for (const warehouseId of [WH_A, WH_B]) {
      const { s } = await singleLoad('staff', SAVED_APPROVER, row({ warehouseId }), [WH_A]);
      expect(offered(s.screen.shown!, { role: 'staff', permissions: SAVED_APPROVER })).toEqual(
        offered(s.screen.shown!, { role: 'staff', permissions: SAVED_APPROVER }, before),
      );
    }
  });

  it('a read that failed still decides nothing: offered as before, the server answers', () => {
    const unreadable: Shown = {
      ...row(),
      warehouseScope: { writableIds: [], readableIds: [], unreadable: true },
      from: 'saved set',
    };
    const now = offered(unreadable, { role: 'staff', permissions: SAVED_APPROVER });
    expect(now).toEqual(
      offered(unreadable, { role: 'staff', permissions: SAVED_APPROVER }, before),
    );
    expect(now.actions).toContain('approve');
  });
});

describe('(5) an offline open is unchanged: the view kept in memory, gated with the saved set on the phone', () => {
  it("the view kept for offline is the newest load's, and offers offline what it offered online", async () => {
    for (const warehouseId of [WH_A, WH_B]) {
      const { s } = await race(row({ warehouseId }));
      const recalled = s.screen.remembered!;
      expect(recalled.from).toBe('saved set');
      const cached = permissionsOnceRead({ permissions: new Set(SAVED_APPROVER), read: true });
      expect(offered(recalled, { role: 'staff', permissions: cached })).toEqual(
        offered(s.screen.shown!, { role: 'staff', permissions: SAVED_APPROVER }),
      );
      expect(offered(recalled, { role: 'staff', permissions: cached })).toEqual(
        offered(recalled, { role: 'staff', permissions: cached }, (input) =>
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

  it('a picker and a manager offline: what a single load kept, as before', async () => {
    const picker = await singleLoad(
      'staff',
      SAVED_PICKER,
      row({ status: 'pick_slip_generated', warehouseId: WH_A }),
      [WH_A],
    );
    const manager = await singleLoad('manager', SAVED_MANAGER, row(), []);
    for (const [role, permissions, kept] of [
      ['staff', SAVED_PICKER, picker.s.screen.remembered!],
      ['manager', SAVED_MANAGER, manager.s.screen.remembered!],
    ] as const) {
      const cached = permissionsOnceRead({ permissions: new Set(permissions), read: true });
      expect(offered(kept, { role, permissions: cached })).toEqual(
        offered(kept, { role, permissions: cached }, (input) => orderWarehouseAccess(input)),
      );
    }
  });
});

// ── Wiring: the screen runs these decisions, in this order ──────────────────

const SCREEN_FILE = 'app/order/[id].tsx';
const SCREEN = readFileSync(path.resolve(__dirname, '../..', SCREEN_FILE), 'utf8');

/** Source with comments stripped, so a comment can never satisfy a pin. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** The statements of the screen's `load` callback body, found by the parser. */
function loadStatements(): { sf: ts.SourceFile; statements: readonly ts.Statement[] } {
  const sf = parseTsx(SCREEN, SCREEN_FILE);
  let body: ts.Block | null = null;
  const visit = (n: ts.Node) => {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === 'load' &&
      n.initializer &&
      ts.isCallExpression(n.initializer) &&
      n.initializer.expression.getText(sf) === 'React.useCallback'
    ) {
      const fn = n.initializer.arguments[0];
      if (fn && ts.isArrowFunction(fn) && ts.isBlock(fn.body)) body = fn.body;
    }
    if (body === null) ts.forEachChild(n, visit);
  };
  visit(sf);
  expect(body, 'load in the order screen').not.toBeNull();
  return { sf, statements: (body as unknown as ts.Block).statements };
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

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

function commitsIn(st: ts.Node): string[] {
  const out: string[] = [];
  walk(st, (n) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && COMMITS.has(n.expression.text)) {
      out.push(n.expression.text);
    }
  });
  return out;
}

function awaitsIn(st: ts.Node): boolean {
  let found = false;
  walk(st, (n) => {
    if (ts.isAwaitExpression(n)) found = true;
  });
  return found;
}

const isGuard = (st: ts.Statement, sf: ts.SourceFile) =>
  ts.isIfStatement(st) &&
  st.expression.getText(sf) === '!loads.isCurrent(seq)' &&
  ts.isReturnStatement(st.thenStatement) &&
  st.elseStatement === undefined;

describe('wiring: the order screen', () => {
  it('numbers its loads with the tested sequence guard', () => {
    const code = codeOnly(SCREEN);
    expect(code).toContain("import { createSequenceGuard } from '@/lib/debounced-list-load';");
    expect(code).toContain('const [loads] = React.useState(() => createSequenceGuard());');
  });

  // Mutation caught: any newest-load check deleted, or a change to the
  // screen moved after a read without one (the walk's defect: every change
  // after a read went on screen whichever load it belonged to).
  it('changes nothing after a read unless it is still the newest load', () => {
    const { sf, statements } = loadStatements();
    const unguarded: string[] = [];
    let readSinceCheck = false;
    let guards = 0;
    for (const st of statements) {
      if (isGuard(st, sf)) {
        readSinceCheck = false;
        guards += 1;
        continue;
      }
      const commits = commitsIn(st);
      const awaits = awaitsIn(st);
      if (commits.length > 0 && (readSinceCheck || awaits)) {
        unguarded.push(`${commits.join(', ')}: ${st.getText(sf).slice(0, 60)}`);
      }
      if (awaits) readSinceCheck = true;
    }
    expect(unguarded).toEqual([]);
    expect(guards).toBeGreaterThanOrEqual(4);
    // The commits the check covers are all still in `load`.
    const all = statements.flatMap((st) => commitsIn(st));
    for (const name of COMMITS) expect(all, name).toContain(name);
  });

  // Mutation caught: the number taken after the header read (an older load
  // would then count as newer), the offline return taking one (a load on its
  // way would be dropped offline), or the wait for the saved set removed.
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

  it('runs again when the saved set is read, with the guard and the attachments read among its dependencies', () => {
    expect(SCREEN).toMatch(
      /\}, \[\s*orgId,\s*id,\s*loads,\s*readAttachments,\s*offline,\s*permissionsRead,\s*userId,\s*role,\s*rpApprove,\s*rpItems,\s*rpBuy,?\s*\]\);/,
    );
    expect(SCREEN).toMatch(
      /useFocusEffect\(\s*React\.useCallback\(\(\) => \{\s*void load\(\);\s*\}, \[load\]\),\s*\);/,
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

  // The attachments a load read go on screen only through its own check;
  // the upload, delete and Try again paths read and show them directly.
  it('reads the attachments without showing them, and shows them from the load only behind its check', () => {
    const code = codeOnly(SCREEN);
    const read = code.slice(
      code.indexOf('const readAttachments = React.useCallback('),
      code.indexOf('const loadAttachments = React.useCallback('),
    );
    expect(read).toContain("from('order_request_attachments')");
    expect(read).not.toMatch(/setAttachments(Error)?\(/);
    expect(code).toMatch(
      /const loadAttachments = React\.useCallback\(async \(\) => \{\s*const read = await readAttachments\(\);\s*if \(!read\) return;\s*setAttachmentsError\(read\.error\);\s*setAttachments\(read\.attachments\);\s*\}, \[readAttachments\]\);/,
    );
    expect(code).toMatch(
      /const attachmentsRead = await readAttachments\(\);\s*if \(!loads\.isCurrent\(seq\)\) return;\s*if \(attachmentsRead\) \{\s*setAttachmentsError\(attachmentsRead\.error\);\s*setAttachments\(attachmentsRead\.attachments\);\s*\}/,
    );
    // loadAttachments shows what it read at once: `load` never calls it
    // (mutation: the load's own read put back as loadAttachments()).
    const { sf, statements } = loadStatements();
    const calls: string[] = [];
    for (const st of statements) {
      walk(st, (n) => {
        if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) calls.push(n.expression.text);
      });
    }
    expect(sf.fileName).toBe(SCREEN_FILE);
    expect(calls).toContain('readAttachments');
    expect(calls).not.toContain('loadAttachments');
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Security invariant: completing a schedule event whose kit is to be handed
 * out is refused, before anything is written, for a member whose role the
 * database does not accept for a hand-out.
 *
 *   - Completing an in-progress event hands out its kit (distribute_bundle),
 *     whose body refuses every caller below manager (roleCanHandOutKits).
 *     When the event as the save will leave it has a kit, a quantity and a kit
 *     warehouse, and no hand-out yet, such a caller is refused with one plain
 *     sentence: no update, no hand-out, no audit row.
 *   - The role only: distribute_bundle lets the Schedule's own completion
 *     through without bundles:distribute (0415), so a manager whose
 *     permission is revoked completes and the kit is handed out.
 *   - An event with no kit, a save that clears the kit, and a kit already
 *     handed out complete for staff with no hand-out.
 *   - Order: the warehouses the patch names are checked first (they guard
 *     what any save writes), then the role, then the stored kit's warehouse.
 *   - A kit the row gains between the check and the save is not handed out
 *     for such a caller; the "marked complete, but" sentence says to ask a
 *     manager. That sentence names no path or id; for a member who may hand
 *     the kit out from its page it says so and names the kit in details.
 */

const h = vi.hoisted(() => ({ withContext: vi.fn() }));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));
vi.mock('@/lib/auth/warehouse', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/warehouse')>()),
  assertWarehouseAccess: vi.fn(),
}));
vi.mock('./audit', () => ({ audit: vi.fn(async () => undefined) }));
vi.mock('./context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./context')>()),
  withContext: h.withContext,
}));

import { revalidatePath } from 'next/cache';

import {
  DEFAULT_MODULE_IDS,
  effectivePermissions,
  type ModuleId,
  type Permission,
  type Role,
} from '@stockpilot/core';

import { assertWarehouseAccess, ForbiddenError } from '@/lib/auth/warehouse';
import { updateScheduleEventAction } from '@/server/actions/schedule';
import {
  callArgs,
  makeServiceContext,
  makeSupabaseStub,
  type MockCall,
  type SupabaseStub,
} from '@/test/supabase-mock';

import { audit } from './audit';
import { ServiceError } from './context';
import { ScheduleService } from './schedule';

const EVENT = 'e1e1e1e1-0000-4000-8000-000000000301';
const EVENT_WAREHOUSE = 'a1a1a1a1-0000-4000-8000-000000000302';
const KIT_WAREHOUSE = 'b2b2b2b2-0000-4000-8000-000000000303';
const OTHER_WAREHOUSE = 'c3c3c3c3-0000-4000-8000-000000000304';
const KIT = 'd4d4d4d4-0000-4000-8000-000000000305';

const ROLE_REFUSED =
  "You can't complete this event because its kit has to be handed out by a manager. Ask a manager to complete it.";
const KIT_WAREHOUSE_REFUSED =
  "You don't have write access to the warehouse this event's kit comes from, so nothing was saved. Choose a warehouse you work in, or ask a manager.";

type Row = Record<string, unknown>;

function eventRow(over: Row = {}): Row {
  return {
    id: EVENT,
    organization_id: 'org-test',
    title: 'Library open day',
    starts_at: '2026-12-04T17:00:00.000Z',
    ends_at: null,
    all_day: false,
    location_text: null,
    warehouse_id: EVENT_WAREHOUSE,
    requester_name: null,
    details: null,
    status: 'in_progress',
    bundle_id: KIT,
    bundle_quantity: 2,
    bundle_warehouse_id: KIT_WAREHOUSE,
    order_request_id: null,
    created_by: 'user-creator',
    updated_by: 'user-creator',
    created_at: '2026-11-01T00:00:00.000Z',
    updated_at: '2026-11-01T00:00:00.000Z',
    deleted_users: null,
    warehouse: { name: 'Main' },
    ...over,
  };
}

interface World {
  row: Row;
  handedOut: boolean;
  /** Overrides what the update hands back (a row changed in between). */
  savedOver: Row;
  /** What distribute_bundle answers. */
  rpcError: { code?: string; message: string } | null;
  payloads: Row[];
}

let world: World;
let stub: SupabaseStub;

function clientFor(w: World): SupabaseStub {
  return makeSupabaseStub({
    'schedule_events.select': () => ({ data: [w.row], error: null }),
    'schedule_events.update': (call: MockCall) => {
      const payload = (callArgs(call, 'update')?.[0] ?? {}) as Row;
      w.payloads.push(payload);
      w.row = { ...w.row, ...payload };
      return { data: [{ ...w.row, ...w.savedOver }], error: null };
    },
    'bundle_distributions.select': () => ({
      data: w.handedOut ? [{ schedule_event_id: EVENT }] : [],
      error: null,
    }),
    'user_profiles.select': { data: [], error: null },
    'rpc:distribute_bundle': () => {
      if (w.rpcError) return { data: null, error: w.rpcError };
      w.handedOut = true;
      return { data: 'dist-1', error: null };
    },
  });
}

/** Signs in as `role` holding schedule:manage on top of the role's defaults, with `revoke` taken away. */
function signIn(role: Role, over: Partial<World> = {}, revoke: Permission[] = []) {
  world = {
    row: eventRow(),
    handedOut: false,
    savedOver: {},
    rpcError: null,
    payloads: [],
    ...over,
  };
  stub = clientFor(world);
  const permissions = effectivePermissions(role, [
    { permission: 'schedule:manage', granted: true },
    ...revoke.map((permission) => ({ permission, granted: false })),
  ]);
  const ctx = makeServiceContext(stub.client, {
    role,
    userId: `user-${role}`,
    permissions,
    enabledModules: new Set<ModuleId>([...DEFAULT_MODULE_IDS, 'schedule' as ModuleId]),
  });
  h.withContext.mockResolvedValue(ctx);
  return new ScheduleService(ctx as never);
}

const completedExtra = () =>
  vi
    .mocked(audit)
    .mock.calls.map((c) => c[0] as { event: string; extra?: Row })
    .find((e) => e.event === 'schedule.completed')?.extra;

function expectNothingWritten() {
  expect(stub.chainsAll.get('schedule_events.update')).toBeUndefined();
  expect(stub.rpcCalls).toEqual([]);
  expect(audit).not.toHaveBeenCalled();
  expect(world.row.status).toBe('in_progress');
}

function refuse(id: string) {
  vi.mocked(assertWarehouseAccess).mockImplementation(async (wh) => {
    if (wh === id) throw new ForbiddenError(`User does not have write access to warehouse ${id}.`);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(assertWarehouseAccess).mockResolvedValue(undefined);
});

describe('completing an event whose kit is still to be handed out, below manager', () => {
  it('staff with schedule:manage and the default bundles:distribute are refused before anything is written', async () => {
    const svc = signIn('staff');
    const err = await svc.update(EVENT, { status: 'completed' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect(err).toMatchObject({ code: 'forbidden', message: ROLE_REFUSED });
    expectNothingWritten();
  });

  it('the web action answers forbidden with that sentence and refreshes nothing', async () => {
    signIn('staff');
    const res = await updateScheduleEventAction(EVENT, { status: 'completed' });
    expect(res).toEqual({ ok: false, error: { code: 'forbidden', message: ROLE_REFUSED } });
    expectNothingWritten();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('a kit added in the same save is refused the same way', async () => {
    const svc = signIn('staff', {
      row: eventRow({ bundle_id: null, bundle_quantity: null, bundle_warehouse_id: null }),
    });
    const err = await svc
      .update(EVENT, {
        status: 'completed',
        bundleId: KIT,
        bundleQuantity: 2,
        bundleWarehouseId: KIT_WAREHOUSE,
      })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'forbidden', message: ROLE_REFUSED });
    expectNothingWritten();
  });

  it('the role is checked before the stored kit warehouse, with no warehouse read', async () => {
    const svc = signIn('staff');
    refuse(KIT_WAREHOUSE);
    const err = await svc.update(EVENT, { status: 'completed' }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'forbidden', message: ROLE_REFUSED });
    expect(assertWarehouseAccess).not.toHaveBeenCalled();
    expectNothingWritten();
  });

  it('a kit warehouse the patch names is checked first, with its own sentence', async () => {
    const svc = signIn('staff', { row: eventRow({ bundle_warehouse_id: OTHER_WAREHOUSE }) });
    refuse(KIT_WAREHOUSE);
    const err = await svc
      .update(EVENT, {
        status: 'completed',
        bundleId: KIT,
        bundleQuantity: 2,
        bundleWarehouseId: KIT_WAREHOUSE,
      })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'forbidden', message: KIT_WAREHOUSE_REFUSED });
    expectNothingWritten();
  });

  it('a viewer granted schedule:manage is refused the same way', async () => {
    const svc = signIn('viewer');
    await expect(svc.update(EVENT, { status: 'completed' })).rejects.toMatchObject({
      code: 'forbidden',
      message: ROLE_REFUSED,
    });
    expectNothingWritten();
  });
});

describe('staff completions with nothing to hand out keep their behaviour', () => {
  it('an event with no kit completes, with no hand-out', async () => {
    const svc = signIn('staff', {
      row: eventRow({ bundle_id: null, bundle_quantity: null, bundle_warehouse_id: null }),
    });
    const row = await svc.update(EVENT, { status: 'completed' });
    expect(row.status).toBe('completed');
    expect(stub.rpcCalls).toEqual([]);
    expect(completedExtra()).toEqual({ autoDistributed: false });
  });

  it('a save that clears the kit while completing completes, with no hand-out', async () => {
    const svc = signIn('staff');
    const row = await svc.update(EVENT, {
      status: 'completed',
      bundleId: null,
      bundleQuantity: null,
      bundleWarehouseId: null,
    });
    expect(row.status).toBe('completed');
    expect(stub.rpcCalls).toEqual([]);
  });

  it('an event whose kit was already handed out completes, with no second hand-out', async () => {
    const svc = signIn('staff', { handedOut: true });
    const row = await svc.update(EVENT, { status: 'completed' });
    expect(row.status).toBe('completed');
    expect(stub.rpcCalls).toEqual([]);
    expect(completedExtra()).toEqual({ autoDistributed: true });
  });

  it('staff still start, cancel and rename an event with a kit', async () => {
    const svc = signIn('staff', { row: eventRow({ status: 'scheduled' }) });
    await svc.update(EVENT, { status: 'in_progress' });
    await svc.update(EVENT, { title: 'Renamed' });
    await svc.update(EVENT, { status: 'cancelled' });
    expect(world.payloads.map((p) => p.status ?? p.title)).toEqual([
      'in_progress',
      'Renamed',
      'cancelled',
    ]);
    expect(stub.rpcCalls).toEqual([]);
  });
});

describe('managers and above complete and the kit is handed out', () => {
  it.each(['owner', 'admin', 'manager'] as const)('a %s', async (role) => {
    const svc = signIn(role);
    const row = await svc.update(EVENT, { status: 'completed' });
    expect(row.status).toBe('completed');
    expect(stub.rpcCalls).toEqual([
      expect.objectContaining({
        name: 'distribute_bundle',
        args: expect.objectContaining({ p_bundle_id: KIT, p_schedule_event_id: EVENT }),
      }),
    ]);
    expect(completedExtra()).toEqual({ autoDistributed: true });
  });

  it('a manager whose bundles:distribute is revoked completes and the hand-out is made', async () => {
    const svc = signIn('manager', {}, ['bundles:distribute']);
    const row = await svc.update(EVENT, { status: 'completed' });
    expect(row.status).toBe('completed');
    expect(stub.rpcCalls.map((c) => c.name)).toEqual(['distribute_bundle']);
    expect(completedExtra()).toEqual({ autoDistributed: true });
  });
});

describe('a kit the row gains between the check and the save', () => {
  it('is not handed out for staff: the event is completed and the sentence says to ask a manager', async () => {
    const svc = signIn('staff', {
      row: eventRow({ bundle_id: null, bundle_quantity: null, bundle_warehouse_id: null }),
      savedOver: { bundle_id: KIT, bundle_quantity: 2, bundle_warehouse_id: KIT_WAREHOUSE },
    });
    const err = await svc.update(EVENT, { status: 'completed' }).catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: 'conflict',
      message:
        "Event marked complete, but bundle distribution failed: Only a manager can hand out a kit. Ask a manager to hand it out from the kit's page.",
    });
    expect((err as ServiceError).details).toBeUndefined();
    expect(stub.rpcCalls).toEqual([]);
    expect(completedExtra()).toEqual({ autoDistributed: false });
  });
});

describe('the "marked complete, but" sentence', () => {
  const FAULT = { code: 'XX000', message: 'some database fault' };

  it('names no path or id; for a manager it says to hand the kit out from its page and names the kit in details', async () => {
    const svc = signIn('manager', { rpcError: FAULT });
    const err = await svc.update(EVENT, { status: 'completed' }).catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: 'conflict',
      message:
        "Event marked complete, but the bundle could not be distributed. Hand it out from the kit's page.",
      details: { kitId: KIT },
    });
    expect((err as Error).message).not.toContain(KIT);
    expect((err as Error).message).not.toContain('/dashboard');
  });

  it('the web action passes the kit on to the page', async () => {
    signIn('manager', { rpcError: FAULT });
    const res = await updateScheduleEventAction(EVENT, { status: 'completed' });
    expect(res).toEqual({
      ok: false,
      error: {
        code: 'conflict',
        message:
          "Event marked complete, but the bundle could not be distributed. Hand it out from the kit's page.",
        details: { kitId: KIT },
      },
    });
  });

  it('for a manager whose bundles:distribute is revoked it says to ask a manager, with no kit named', async () => {
    const svc = signIn('manager', { rpcError: FAULT }, ['bundles:distribute']);
    const err = await svc.update(EVENT, { status: 'completed' }).catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: 'conflict',
      message:
        "Event marked complete, but the bundle could not be distributed. Ask a manager to hand it out from the kit's page.",
    });
    expect((err as ServiceError).details).toBeUndefined();
  });
});

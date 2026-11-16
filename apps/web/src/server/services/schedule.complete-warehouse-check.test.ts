import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Security invariant: ScheduleService.update checks every warehouse a save
 * depends on BEFORE anything is written.
 *
 *   - Completing an in-progress event hands out its kit (distribute_bundle)
 *     from the kit's warehouse. The caller's write access to that warehouse
 *     (the kit fields as the save will leave them: the patch's over the stored
 *     ones) is checked before the status is saved, when the event has a kit
 *     and no hand-out yet. A refusal writes nothing: no update, no hand-out,
 *     no audit row, and the person reads one sentence that names no id.
 *   - A check that could not read the caller's own access is thrown as the
 *     ForbiddenError it is, so the web action answers the shared retryable
 *     "could not check" sentence, never a final refusal. The same holds for
 *     the two checks of warehouses named in the patch.
 *   - An update the row policy refuses (the event is someone else's and the
 *     caller is not a manager) matches no row: a plain forbidden sentence,
 *     with no audit row and no hand-out.
 *
 * Completing as a member who may write, an event with no kit, and reopen then
 * complete keep their behaviour.
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
  ORDER_WAREHOUSE_ACCESS_UNREADABLE_COPY,
  type ModuleId,
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

const EVENT = 'e1e1e1e1-0000-4000-8000-000000000101';
const EVENT_WAREHOUSE = 'a1a1a1a1-0000-4000-8000-000000000102';
const KIT_WAREHOUSE = 'b2b2b2b2-0000-4000-8000-000000000103';
const OTHER_WAREHOUSE = 'c3c3c3c3-0000-4000-8000-000000000104';
const KIT = 'd4d4d4d4-0000-4000-8000-000000000105';

const COMPLETE_REFUSED =
  "You can't complete this event because you don't have write access to the warehouse its kit comes from. Ask a manager to complete it, or to give you access to that warehouse.";
const EVENT_WAREHOUSE_REFUSED =
  "You don't have write access to the warehouse set for this event, so nothing was saved. Choose a warehouse you work in, or ask a manager.";
const KIT_WAREHOUSE_REFUSED =
  "You don't have write access to the warehouse this event's kit comes from, so nothing was saved. Choose a warehouse you work in, or ask a manager.";
const UPDATE_REFUSED = "You can't change this event. Ask a manager.";

type Row = Record<string, unknown>;

function eventRow(over: Row = {}): Row {
  return {
    id: EVENT,
    organization_id: 'org-test',
    title: 'Science night setup',
    starts_at: '2026-12-03T17:00:00.000Z',
    ends_at: null,
    all_day: false,
    location_text: null,
    warehouse_id: EVENT_WAREHOUSE,
    requester_name: null,
    details: null,
    status: 'in_progress',
    bundle_id: KIT,
    bundle_quantity: 3,
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
  /** The event already has a bundle_distributions row. */
  handedOut: boolean;
  /** The row policy lets the update through (the creator or a manager). */
  mayUpdate: boolean;
  /** Overrides what the update hands back (a row changed in between). */
  savedOver: Row;
  payloads: Row[];
}

let world: World;
let stub: SupabaseStub;

function makeWorld(over: Partial<World> = {}): World {
  return {
    row: eventRow(),
    handedOut: false,
    mayUpdate: true,
    savedOver: {},
    payloads: [],
    ...over,
  };
}

/**
 * A user client over `world.row`. The update answers as PostgREST does: the
 * row (with the payload applied) when the policy lets it through; no row when
 * it does not, which a single-object read answers as 406 PGRST116 and a
 * maybe-single read as no data and no error.
 */
function clientFor(w: World): SupabaseStub {
  const updated = (call: MockCall) => {
    const payload = (callArgs(call, 'update')?.[0] ?? {}) as Row;
    w.payloads.push(payload);
    if (!w.mayUpdate) return null;
    w.row = { ...w.row, ...payload };
    return { ...w.row, ...w.savedOver };
  };
  return makeSupabaseStub({
    'schedule_events.select': () => ({ data: [w.row], error: null }),
    'schedule_events.update.single': (call) => {
      const row = updated(call);
      return row
        ? { data: row, error: null }
        : {
            data: null,
            error: {
              code: 'PGRST116',
              message: 'JSON object requested, multiple (or no) rows returned',
              details: 'The result contains 0 rows',
            },
          };
    },
    'schedule_events.update.maybeSingle': (call) => {
      const row = updated(call);
      return { data: row ? [row] : [], error: null };
    },
    'bundle_distributions.select': () => ({
      data: w.handedOut ? [{ schedule_event_id: EVENT }] : [],
      error: null,
    }),
    'user_profiles.select': { data: [], error: null },
    'rpc:distribute_bundle': () => {
      w.handedOut = true;
      return { data: 'dist-1', error: null };
    },
  });
}

function signIn(over: Partial<World> = {}) {
  world = makeWorld(over);
  stub = clientFor(world);
  const ctx = makeServiceContext(stub.client, {
    role: 'staff',
    userId: 'user-staff',
    permissions: new Set(['schedule:manage']),
    enabledModules: new Set<ModuleId>([...DEFAULT_MODULE_IDS, 'schedule' as ModuleId]),
  });
  h.withContext.mockResolvedValue(ctx);
  return new ScheduleService(ctx as never);
}

const outOfScope = (id: string) =>
  new ForbiddenError(`User does not have write access to warehouse ${id}.`);
const unreadable = (id: string) =>
  new ForbiddenError(`User does not have write access to warehouse ${id}.`, {
    accessUnreadable: true,
  });

/** assertWarehouseAccess refuses `id` with `make(id)`, and lets every other warehouse through. */
function refuse(id: string, make: (id: string) => ForbiddenError) {
  vi.mocked(assertWarehouseAccess).mockImplementation(async (wh) => {
    if (wh === id) throw make(id);
  });
}

const auditEvents = () => vi.mocked(audit).mock.calls.map((c) => (c[0] as { event: string }).event);
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

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(assertWarehouseAccess).mockResolvedValue(undefined);
});

describe('completing an in-progress event whose kit comes from a warehouse the caller may not write', () => {
  it('refuses before anything is written, with a sentence that names no id', async () => {
    const svc = signIn();
    refuse(KIT_WAREHOUSE, outOfScope);
    const err = await svc.update(EVENT, { status: 'completed' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect(err).toMatchObject({ code: 'forbidden', message: COMPLETE_REFUSED });
    expect((err as Error).message).not.toContain(KIT_WAREHOUSE);
    expectNothingWritten();
  });

  it('the web action answers forbidden with that sentence and writes nothing', async () => {
    signIn();
    refuse(KIT_WAREHOUSE, outOfScope);
    const res = await updateScheduleEventAction(EVENT, { status: 'completed' });
    expect(res).toEqual({ ok: false, error: { code: 'forbidden', message: COMPLETE_REFUSED } });
    expectNothingWritten();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('a kit warehouse named in the same save is refused by the patch check, before anything is written', async () => {
    const svc = signIn({ row: eventRow({ bundle_warehouse_id: OTHER_WAREHOUSE }) });
    refuse(KIT_WAREHOUSE, outOfScope);
    const err = await svc
      .update(EVENT, {
        status: 'completed',
        bundleId: KIT,
        bundleQuantity: 3,
        bundleWarehouseId: KIT_WAREHOUSE,
      })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'forbidden', message: KIT_WAREHOUSE_REFUSED });
    expectNothingWritten();
  });

  it('a save that clears the kit while completing checks no kit warehouse and hands nothing out', async () => {
    const svc = signIn();
    refuse(KIT_WAREHOUSE, outOfScope);
    await svc.update(EVENT, {
      status: 'completed',
      bundleId: null,
      bundleQuantity: null,
      bundleWarehouseId: null,
    });
    expect(world.row.status).toBe('completed');
    expect(stub.rpcCalls).toEqual([]);
    expect(completedExtra()).toEqual({ autoDistributed: false });
  });
});

describe('completing when the access could not be read', () => {
  it('throws the ForbiddenError as it is, before anything is written', async () => {
    const svc = signIn();
    refuse(KIT_WAREHOUSE, unreadable);
    const err = await svc.update(EVENT, { status: 'completed' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenError);
    expect((err as ForbiddenError).accessUnreadable).toBe(true);
    expectNothingWritten();
  });

  it('the web action answers the shared "could not check" sentence, retryable', async () => {
    signIn();
    refuse(KIT_WAREHOUSE, unreadable);
    const res = await updateScheduleEventAction(EVENT, { status: 'completed' });
    expect(res).toEqual({
      ok: false,
      error: {
        code: 'conflict',
        message: ORDER_WAREHOUSE_ACCESS_UNREADABLE_COPY,
        details: { reason: 'failed', retryable: true },
      },
    });
    expectNothingWritten();
  });
});

describe('completing as a member who may write the kit warehouse', () => {
  it('saves the status, hands the kit out once and writes the completion audit row', async () => {
    const svc = signIn();
    const row = await svc.update(EVENT, { status: 'completed' });
    expect(row.status).toBe('completed');
    expect(world.payloads).toEqual([expect.objectContaining({ status: 'completed' })]);
    expect(stub.rpcCalls).toHaveLength(1);
    expect(stub.rpcCalls[0]).toMatchObject({
      name: 'distribute_bundle',
      args: {
        p_bundle_id: KIT,
        p_quantity: 3,
        p_warehouse_id: KIT_WAREHOUSE,
        p_schedule_event_id: EVENT,
      },
    });
    expect(auditEvents()).toEqual(['schedule.completed']);
    expect(completedExtra()).toEqual({ autoDistributed: true });
  });

  it('the web action answers ok and refreshes the schedule pages', async () => {
    signIn();
    const res = await updateScheduleEventAction(EVENT, { status: 'completed' });
    expect(res).toEqual({ ok: true, data: { id: EVENT } });
    expect(stub.rpcCalls).toHaveLength(1);
    expect(revalidatePath).toHaveBeenCalledWith(`/dashboard/schedule/${EVENT}`);
  });

  it('a kit warehouse that changed in between is checked again after the save, with no id in the answer', async () => {
    const svc = signIn({ savedOver: { bundle_warehouse_id: OTHER_WAREHOUSE } });
    refuse(OTHER_WAREHOUSE, outOfScope);
    const err = await svc.update(EVENT, { status: 'completed' }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'conflict' });
    expect((err as Error).message).toBe(
      "Event marked complete, but bundle distribution failed: You don't have write access to the warehouse its kit comes from. " +
        `Retry from /dashboard/bundles/${KIT}.`,
    );
    expect((err as Error).message).not.toContain(OTHER_WAREHOUSE);
    expect(stub.rpcCalls).toEqual([]);
    expect(completedExtra()).toEqual({ autoDistributed: false });
  });

  it('that second check, when the access could not be read, answers the could-not-hand-out sentence', async () => {
    const svc = signIn({ savedOver: { bundle_warehouse_id: OTHER_WAREHOUSE } });
    refuse(OTHER_WAREHOUSE, unreadable);
    const err = await svc.update(EVENT, { status: 'completed' }).catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: 'conflict',
      message: `Event marked complete, but the bundle could not be distributed. Retry from /dashboard/bundles/${KIT}.`,
    });
    expect(stub.rpcCalls).toEqual([]);
    expect(completedExtra()).toEqual({ autoDistributed: false });
  });
});

describe('the other completions keep their behaviour', () => {
  it('an event with no kit completes with no warehouse check and no hand-out', async () => {
    const svc = signIn({
      row: eventRow({ bundle_id: null, bundle_quantity: null, bundle_warehouse_id: null }),
    });
    const row = await svc.update(EVENT, { status: 'completed' });
    expect(row.status).toBe('completed');
    expect(assertWarehouseAccess).not.toHaveBeenCalled();
    expect(stub.rpcCalls).toEqual([]);
    expect(completedExtra()).toEqual({ autoDistributed: false });
  });

  it('reopen, start and complete again: a kit already handed out is not checked or handed out twice', async () => {
    const svc = signIn({ row: eventRow({ status: 'completed' }), handedOut: true });
    refuse(KIT_WAREHOUSE, outOfScope);
    await svc.update(EVENT, { status: 'scheduled' });
    await svc.update(EVENT, { status: 'in_progress' });
    const row = await svc.update(EVENT, { status: 'completed' });
    expect(row.status).toBe('completed');
    expect(world.payloads.map((p) => p.status)).toEqual(['scheduled', 'in_progress', 'completed']);
    expect(assertWarehouseAccess).not.toHaveBeenCalled();
    expect(stub.rpcCalls).toEqual([]);
    expect(auditEvents()).toEqual(['schedule.updated', 'schedule.updated', 'schedule.completed']);
    expect(completedExtra()).toEqual({ autoDistributed: true });
  });

  it('reopen, start and complete an event with no hand-out yet: the kit is handed out once', async () => {
    const svc = signIn({ row: eventRow({ status: 'cancelled' }) });
    await svc.update(EVENT, { status: 'scheduled' });
    await svc.update(EVENT, { status: 'in_progress' });
    await svc.update(EVENT, { status: 'completed' });
    expect(stub.rpcCalls.map((c) => c.name)).toEqual(['distribute_bundle']);
    expect(completedExtra()).toEqual({ autoDistributed: true });
  });
});

describe('the checks of warehouses named in the patch', () => {
  it.each([
    [
      "the event's warehouse",
      { warehouseId: OTHER_WAREHOUSE },
      OTHER_WAREHOUSE,
      EVENT_WAREHOUSE_REFUSED,
    ],
    [
      "the kit's warehouse",
      { bundleId: KIT, bundleQuantity: 3, bundleWarehouseId: OTHER_WAREHOUSE },
      OTHER_WAREHOUSE,
      KIT_WAREHOUSE_REFUSED,
    ],
  ] as const)(
    'a refusal of %s names no id and writes nothing',
    async (_label, patch, warehouse, sentence) => {
      const svc = signIn({ row: eventRow({ status: 'scheduled' }) });
      refuse(warehouse, outOfScope);
      const err = await svc.update(EVENT, { title: 'Renamed', ...patch }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ServiceError);
      expect(err).toMatchObject({ code: 'forbidden', message: sentence });
      expect(stub.chainsAll.get('schedule_events.update')).toBeUndefined();
      expect(audit).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["the event's warehouse", { warehouseId: OTHER_WAREHOUSE }],
    [
      "the kit's warehouse",
      { bundleId: KIT, bundleQuantity: 3, bundleWarehouseId: OTHER_WAREHOUSE },
    ],
  ] as const)(
    'a check of %s that could not read the access is the retryable "could not check" answer',
    async (_label, patch) => {
      const svc = signIn({ row: eventRow({ status: 'scheduled' }) });
      refuse(OTHER_WAREHOUSE, unreadable);
      const err = await svc.update(EVENT, { title: 'Renamed', ...patch }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ForbiddenError);
      expect((err as ForbiddenError).accessUnreadable).toBe(true);
      expect(stub.chainsAll.get('schedule_events.update')).toBeUndefined();

      const res = await updateScheduleEventAction(EVENT, { title: 'Renamed', ...patch });
      expect(res).toEqual({
        ok: false,
        error: {
          code: 'conflict',
          message: ORDER_WAREHOUSE_ACCESS_UNREADABLE_COPY,
          details: { reason: 'failed', retryable: true },
        },
      });
      expect(stub.chainsAll.get('schedule_events.update')).toBeUndefined();
      expect(audit).not.toHaveBeenCalled();
    },
  );
});

describe('an update the row policy refuses', () => {
  it('answers a plain forbidden sentence, with no hand-out and no audit row', async () => {
    const svc = signIn({ mayUpdate: false });
    const err = await svc.update(EVENT, { status: 'completed' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect(err).toMatchObject({ code: 'forbidden', message: UPDATE_REFUSED });
    expect(world.row.status).toBe('in_progress');
    expect(stub.rpcCalls).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it('the web action answers that sentence', async () => {
    signIn({ mayUpdate: false });
    const res = await updateScheduleEventAction(EVENT, { title: 'Renamed' });
    expect(res).toEqual({ ok: false, error: { code: 'forbidden', message: UPDATE_REFUSED } });
    expect(audit).not.toHaveBeenCalled();
  });
});

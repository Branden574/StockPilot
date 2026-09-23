import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Planning and the schedule batch their id lists.
 *
 * The planning candidate set's suppliers and a calendar range's events have
 * no cap; one `.in()` past ~215 uuids answers 414 locally and fails as "fetch
 * failed" in production after ~7 s of retries.
 *
 * - Supplier and creator names are labels: a failed read leaves them blank and
 *   is reported.
 * - The schedule's "distributed" flag degrades on a list view, but update()
 *   uses it to lock a distributed event's bundle fields, so there it throws.
 */

const reportError = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/lib/error-reporter', () => ({ reportError }));
vi.mock('@/lib/auth/warehouse', () => ({
  assertWarehouseAccess: vi.fn(),
  ForbiddenError: class ForbiddenError extends Error {},
}));
vi.mock('./audit', () => ({ audit: vi.fn(async () => {}) }));
const getBulkItemVelocities = vi.hoisted(() => vi.fn());
vi.mock('./forecasting', () => ({
  getBulkItemVelocities: (...a: unknown[]) => getBulkItemVelocities(...a),
  computeReorderSuggestion: (velocity: unknown) => ({
    velocity,
    suggestedReorderPoint: 1,
    suggestedReorderQty: 1,
    currentReorderPoint: 0,
    currentReorderQty: 0,
    leadTimeDays: 14,
    safetyMultiplier: 1.5,
    rationale: 't',
  }),
}));
vi.mock('./purchase-orders', () => ({ PurchaseOrdersService: class {} }));

import { DEFAULT_MODULE_IDS, type ModuleId } from '@stockpilot/core';

import {
  inFilters,
  makeServiceContext,
  makeSupabaseStub,
  type MockCall,
} from '@/test/supabase-mock';

import { audit } from './audit';
import { PlanningService } from './planning';
import { ScheduleService } from './schedule';

const uuid = (i: number, p = '0') => `${p.repeat(8)}-0000-4000-8000-${String(i).padStart(12, '0')}`;

function inList(call: MockCall, column: string): string[] {
  return (inFilters(call).find(([c]) => c === column)?.[1] ?? []) as string[];
}
const tags = () =>
  reportError.mock.calls.map((c) => (c as unknown as [Error, { tag: string }])[1].tag);

beforeEach(() => {
  reportError.mockClear();
});

describe('PlanningService supplier names for 150 suppliers', () => {
  const items = Array.from({ length: 150 }, (_, i) => ({
    id: uuid(i),
    sku: `S${i}`,
    name: `Item ${i}`,
    quantity_on_hand: 0,
    reorder_point: 1,
    reorder_quantity: 1,
    unit_cost: 1,
    supplier_id: uuid(i, 's'),
    created_at: '2026-01-01T00:00:00Z',
  }));

  function svc(suppliers: (call: MockCall) => { data: unknown; error: unknown }) {
    getBulkItemVelocities.mockResolvedValue(
      new Map(
        items.map((it) => [
          it.id,
          { itemId: it.id, unitsOutPerDay: 1, quantityOnHand: 0, daysOfStockRemaining: 1 },
        ]),
      ),
    );
    const stub = makeSupabaseStub({
      'organization_modules.select': { data: [], error: null },
      'inventory_items.select': { data: items, error: null },
      'suppliers.select': suppliers as never,
    });
    return new PlanningService(
      makeServiceContext(stub.client, {
        enabledModules: new Set<ModuleId>([...DEFAULT_MODULE_IDS, 'planning' as ModuleId]),
      }) as never,
    );
  }

  it('resolves names in batches of at most 100', async () => {
    const lists: string[][] = [];
    const out = await svc((call) => {
      const list = inList(call, 'id');
      lists.push(list);
      return { data: list.map((id) => ({ id, name: `Sup ${id.slice(-3)}` })), error: null };
    }).getReorderSuggestions();
    expect(lists.map((l) => l.length)).toEqual([100, 50]);
    expect(JSON.stringify(out)).toContain('Sup 149');
  });

  it('still plans, with blank names and a report, when a name batch fails', async () => {
    let n = 0;
    const out = await svc(() => {
      n += 1;
      return n === 2 ? { data: null, error: { message: 'boom' } } : { data: [], error: null };
    }).getReorderSuggestions();
    expect(out.length).toBeGreaterThan(0);
    expect(tags()).toEqual(['planning.supplier_names']);
  });
});

describe('ScheduleService distributed flag', () => {
  const events = Array.from({ length: 150 }, (_, i) => ({
    id: uuid(i, 'e'),
    title: `Event ${i}`,
    starts_at: '2026-09-01T00:00:00Z',
    ends_at: null,
    status: 'scheduled',
    created_by: uuid(i, 'u'),
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
  }));
  const ctxFor = (client: unknown) =>
    makeServiceContext(client, {
      enabledModules: new Set<ModuleId>([...DEFAULT_MODULE_IDS, 'schedule' as ModuleId]),
    }) as never;

  it('a calendar of 150 events reads distributions and creator names in batches', async () => {
    const distLists: string[][] = [];
    const nameLists: string[][] = [];
    const stub = makeSupabaseStub({
      'schedule_events.select': { data: events, error: null },
      'bundle_distributions.select': (call) => {
        const list = inList(call, 'schedule_event_id');
        distLists.push(list);
        return {
          data: list
            .filter((id) => id === uuid(149, 'e'))
            .map((schedule_event_id) => ({ schedule_event_id })),
          error: null,
        };
      },
      'user_profiles.select': (call) => {
        const list = inList(call, 'id');
        nameLists.push(list);
        return { data: list.map((id) => ({ id, full_name: 'N', email: null })), error: null };
      },
    });
    const rows = await new ScheduleService(ctxFor(stub.client)).listInRange(
      new Date('2026-09-01'),
      new Date('2026-10-01'),
    );
    expect(distLists.map((l) => l.length)).toEqual([100, 50]);
    expect(nameLists.map((l) => l.length)).toEqual([100, 50]);
    expect(rows.find((r) => r.id === uuid(149, 'e'))?.bundleDistributed).toBe(true);
  });

  it('a calendar still renders, unflagged and reported, when the distribution read fails', async () => {
    const stub = makeSupabaseStub({
      'schedule_events.select': { data: events, error: null },
      'bundle_distributions.select': { data: null, error: { message: 'boom' } },
      'user_profiles.select': { data: [], error: null },
    });
    const rows = await new ScheduleService(ctxFor(stub.client)).listInRange(
      new Date('2026-09-01'),
      new Date('2026-10-01'),
    );
    expect(rows).toHaveLength(150);
    expect(rows.every((r) => r.bundleDistributed === false)).toBe(true);
    expect(tags()).toContain('schedule.distributed_events');
  });

  it('update() refuses to decide the bundle lock on a failed distribution read', async () => {
    const stub = makeSupabaseStub({
      'schedule_events.select': {
        data: [
          {
            status: 'scheduled',
            bundle_id: null,
            bundle_quantity: null,
            bundle_warehouse_id: null,
            warehouse_id: null,
          },
        ],
        error: null,
      },
      'bundle_distributions.select': { data: null, error: { message: 'boom' } },
    });
    await expect(
      new ScheduleService(ctxFor(stub.client)).update(uuid(1, 'e'), { title: 'Renamed' } as never),
    ).rejects.toMatchObject({ code: 'internal_error' });
    expect(stub.chainsAll.get('schedule_events.update')).toBeUndefined();
  });

  describe('the completion audit', () => {
    const eventId = uuid(1, 'e');
    function completeWith(rpc: { data: null; error: { message: string; code?: string } | null }) {
      let distReads = 0;
      const stub = makeSupabaseStub({
        'schedule_events.select': {
          data: [
            {
              status: 'in_progress',
              bundle_id: 'bundle-1',
              bundle_quantity: 2,
              bundle_warehouse_id: 'wh-1',
              warehouse_id: null,
            },
          ],
          error: null,
        },
        // The first read decides the lock (nothing distributed yet); the
        // re-read after the update fails.
        'bundle_distributions.select': () => {
          distReads += 1;
          return distReads === 1
            ? { data: [], error: null }
            : { data: null, error: { message: 'boom' } };
        },
        'schedule_events.update': {
          data: [{ ...events[1], id: eventId, status: 'completed' }],
          error: null,
        },
        'rpc:distribute_bundle': rpc,
      });
      vi.mocked(audit).mockClear();
      return {
        run: () =>
          new ScheduleService(ctxFor(stub.client)).update(eventId, {
            status: 'completed',
          } as never),
        stub,
      };
    }
    const completedExtra = () =>
      vi
        .mocked(audit)
        .mock.calls.map((c) => c[0] as { event: string; extra?: Record<string, unknown> })
        .find((e) => e.event === 'schedule.completed')?.extra;

    it('records a distribution this call made even when the re-read after it fails', async () => {
      const { run, stub } = completeWith({ data: null, error: null });
      await run();
      expect(stub.rpcCalls.map((c) => c.name)).toEqual(['distribute_bundle']);
      expect(completedExtra()).toEqual({ autoDistributed: true });
    });

    it('records no distribution when the distribution failed', async () => {
      const { run } = completeWith({ data: null, error: { message: 'short on kits' } });
      await expect(run()).rejects.toMatchObject({ code: 'conflict' });
      expect(completedExtra()).toEqual({ autoDistributed: false });
    });

    it('records a distribution another caller made first (unique violation)', async () => {
      const { run } = completeWith({
        data: null,
        error: { message: 'duplicate key', code: '23505' },
      });
      await run();
      expect(completedExtra()).toEqual({ autoDistributed: true });
    });
  });
});

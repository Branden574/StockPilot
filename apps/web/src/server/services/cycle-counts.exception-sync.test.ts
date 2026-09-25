import { after } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Posting or cancelling a count schedules an Exception Center sync (F1-1):
 *   - only once the write has landed (a refused post or cancel schedules
 *     nothing);
 *   - AFTER the response: the caller never waits for the sync (owner
 *     decision F1 Q9 — freshness must not slow anything down).
 * Both the web action and the phone's /api/v1 post route call these service
 * methods, so this covers both.
 */

vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: vi.fn(async () => ({
    readableIds: ['wh-a'],
    writableIds: ['wh-a'],
    hasAllAccess: true,
    primaryWarehouseId: 'wh-a',
  })),
  assertWarehouseAccess: vi.fn(),
  forcedWarehouseId: vi.fn(async () => null),
  ForbiddenError: class ForbiddenError extends Error {
    readonly code = 'forbidden' as const;
  },
}));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn() }));
vi.mock('./integration-events', () => ({ dispatchEvent: vi.fn(async () => undefined) }));
vi.mock('next/server', () => ({ after: vi.fn() }));

// The sync itself never settles here: if post() or cancel() awaited it, the
// call would hang and the "never waits" tests below would fail.
const syncOrg = vi.hoisted(() => vi.fn(() => new Promise<never>(() => {})));
vi.mock('./exception-occurrences', () => ({ ExceptionOccurrencesService: { syncOrg } }));

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

import { CycleCountsService } from './cycle-counts';
import { scheduleExceptionSync } from './lib/exception-sync-schedule';

const scheduled = vi.mocked(scheduleExceptionSync);
const afterMock = vi.mocked(after);

function svcFor(
  opts: {
    rpcError?: { message: string };
    cancelRow?: { id: string } | null;
    role?: 'admin' | 'staff';
  } = {},
) {
  const order: string[] = [];
  const stub = makeSupabaseStub({
    'cycle_counts.select.maybeSingle': { data: { warehouse_id: 'wh-a' }, error: null },
    'rpc:post_cycle_count': () => {
      order.push('rpc');
      return opts.rpcError
        ? { data: null, error: opts.rpcError }
        : { data: { id: 'cc-1', status: 'completed' }, error: null };
    },
    'cycle_counts.update.maybeSingle': () => {
      order.push('update');
      return { data: opts.cancelRow === undefined ? { id: 'cc-1' } : opts.cancelRow, error: null };
    },
  });
  scheduled.mockImplementation(() => {
    order.push('schedule');
  });
  const ctx = makeServiceContext(stub.client, { organizationId: 'org-1', role: opts.role ?? 'admin' });
  return { svc: new CycleCountsService(ctx as never), order };
}

beforeEach(() => {
  vi.clearAllMocks();
  scheduled.mockReset();
  afterMock.mockReset();
});

describe('post() schedules an exception sync only after the post lands', () => {
  it('a successful post schedules one forced sync for the org, after the RPC', async () => {
    const { svc, order } = svcFor();
    await svc.post('cc-1');
    expect(scheduled).toHaveBeenCalledTimes(1);
    expect(scheduled).toHaveBeenCalledWith('org-1', 'cycle_count.post');
    expect(order).toEqual(['rpc', 'schedule']);
  });

  it('a refused post schedules nothing', async () => {
    const { svc } = svcFor({ rpcError: { message: 'cycle_count_not_open' } });
    await expect(svc.post('cc-1')).rejects.toMatchObject({ code: 'conflict' });
    expect(scheduled).not.toHaveBeenCalled();
  });
});

describe('cancel() schedules an exception sync only after the cancel lands', () => {
  it('a successful cancel schedules one forced sync for the org', async () => {
    const { svc, order } = svcFor();
    await svc.cancel('cc-1');
    expect(scheduled).toHaveBeenCalledWith('org-1', 'cycle_count.cancel');
    expect(order).toEqual(['update', 'schedule']);
  });

  it('a cancel that finds the count already closed schedules nothing', async () => {
    const { svc } = svcFor({ cancelRow: null });
    await expect(svc.cancel('cc-1')).rejects.toMatchObject({ code: 'conflict' });
    expect(scheduled).not.toHaveBeenCalled();
  });

  it('a cancel refused by the permission gate schedules nothing', async () => {
    const { svc } = svcFor({ role: 'staff' });
    await expect(svc.cancel('cc-1')).rejects.toMatchObject({ code: 'forbidden' });
    expect(scheduled).not.toHaveBeenCalled();
  });
});

describe('the caller never waits for the sync', () => {
  /** Swap the no-op mock for the REAL scheduler, with after() capturing the
   *  task instead of running it. */
  async function useRealScheduler(): Promise<Array<() => unknown>> {
    const real = await vi.importActual<typeof import('./lib/exception-sync-schedule')>(
      './lib/exception-sync-schedule',
    );
    const tasks: Array<() => unknown> = [];
    afterMock.mockImplementation((task) => {
      tasks.push(task as () => unknown);
    });
    scheduled.mockImplementation(real.scheduleExceptionSync);
    return tasks;
  }

  const within = <T,>(p: Promise<T>, ms = 1000) =>
    Promise.race([p.then(() => 'settled' as const), new Promise((r) => setTimeout(() => r('timed out'), ms))]);

  // Mutation caught: `await ExceptionOccurrencesService.syncOrg(...)` inside
  // post() (or a scheduler that awaits the sync) — the sync below never
  // settles, so the post would never return.
  it('post() returns while the sync has not even started', async () => {
    const { svc } = svcFor();
    const tasks = await useRealScheduler();
    await expect(within(svc.post('cc-1'))).resolves.toBe('settled');
    expect(tasks).toHaveLength(1);
    expect(syncOrg).not.toHaveBeenCalled();

    // The registered task is the forced sync for this org.
    void tasks[0]!();
    await vi.waitFor(() => expect(syncOrg).toHaveBeenCalledWith('org-1', { force: true, reason: 'cycle_count.post' }));
  });

  it('cancel() returns while the sync has not even started', async () => {
    const { svc } = svcFor();
    const tasks = await useRealScheduler();
    await expect(within(svc.cancel('cc-1'))).resolves.toBe('settled');
    expect(tasks).toHaveLength(1);
    expect(syncOrg).not.toHaveBeenCalled();
  });
});

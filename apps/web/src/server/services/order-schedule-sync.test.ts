import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub, type SupabaseStub } from '@/test/supabase-mock';

/**
 * syncOrderScheduleEvent closes the Schedule entry an order created when the
 * order completes or is cancelled. It runs after the response (kept alive at
 * the sign route, deferred in the service), so a failure is seen only in a
 * report. supabase-js answers a refused UPDATE with `{ error }` instead of
 * throwing, and the function only caught throws: a refused close went
 * unreported and the entry stayed scheduled on a closed order.
 */

const h = vi.hoisted(() => ({ admin: null as SupabaseStub | null }));

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => h.admin!.client }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('@/lib/realtime/broadcast', () => ({ broadcastOrderChanged: vi.fn(async () => {}) }));
vi.mock('./integration-events', () => ({ dispatchEvent: vi.fn(async () => {}) }));

import { reportError } from '@/lib/error-reporter';

import { syncOrderScheduleEvent } from './order-requests';

beforeEach(() => {
  vi.mocked(reportError).mockClear();
});

describe('syncOrderScheduleEvent', () => {
  it('closes only the open entries of the order, and reports nothing when that works', async () => {
    h.admin = makeSupabaseStub({ 'schedule_events.update': { data: null, error: null } });
    await syncOrderScheduleEvent('order-1', 'completed', 'org-1');
    expect(h.admin.chainArgs.get('schedule_events.update')).toEqual([
      [{ status: 'completed' }],
      ['order_request_id', 'order-1'],
      ['status', ['scheduled', 'in_progress']],
    ]);
    expect(reportError).not.toHaveBeenCalled();
  });

  // Mutation caught: the returned error ignored (only a throw was caught).
  it('a refused close is reported, never silent, and never thrown', async () => {
    h.admin = makeSupabaseStub({
      'schedule_events.update': {
        data: null,
        error: { message: 'permission denied for table schedule_events' },
      },
    });
    await expect(syncOrderScheduleEvent('order-1', 'cancelled', 'org-1')).resolves.toBeUndefined();
    expect(reportError).toHaveBeenCalledTimes(1);
    const [err, ctx] = vi.mocked(reportError).mock.calls[0]!;
    expect((err as Error).message).toBe(
      'schedule_events update: permission denied for table schedule_events',
    );
    expect(ctx).toEqual({
      tag: 'orders.auto-schedule.sync',
      organizationId: 'org-1',
      extra: { orderId: 'order-1', outcome: 'cancelled' },
    });
  });
});

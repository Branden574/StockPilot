import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CYCLE_COUNT_CANCEL_MANAGER_ONLY_COPY, CYCLE_COUNT_POST_MANAGER_ONLY_COPY } from '@stockpilot/core';

/**
 * F1-2's Post/Cancel fix, on the service both the web action and the phone's
 * /api/v1 routes call. ledger.post_cycle_count refuses anyone below manager,
 * and it answers a staff caller "cycle_count_not_found" (its FOR UPDATE runs
 * under the manager-only UPDATE policy), so staff who tapped Post were told
 * the count did not exist. The service now refuses them first, in words, with
 * the same predicate (core cycleCountCloseGate) the screens hide the buttons
 * with. Starting a count gets the manager floor too (the INSERT policy's).
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

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

import { CycleCountsService } from './cycle-counts';

/** Staff given every permission the old gates looked at. */
const STAFF_WITH_GRANTS = new Set(['stock:adjust', 'cycle_counts:assign', 'cycle_counts:read', 'items:read']);

function svcFor(role: 'owner' | 'admin' | 'manager' | 'staff', permissions?: Set<string>) {
  const stub = makeSupabaseStub({
    'cycle_counts.select.maybeSingle': { data: { warehouse_id: 'wh-a' }, error: null },
    'rpc:post_cycle_count': { data: { id: 'cc-1', status: 'completed' }, error: null },
    'cycle_counts.update.maybeSingle': { data: { id: 'cc-1' }, error: null },
    'inventory_items.select': { data: [{ id: 'i1', warehouse_id: 'wh-a' }], error: null },
    'rpc:start_cycle_count': { data: [{ cycle_count_id: 'cc-1', line_count: 1 }], error: null },
  });
  const ctx = makeServiceContext(stub.client, { role, ...(permissions ? { permissions } : {}) });
  return { svc: new CycleCountsService(ctx as never), stub };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('post(): manager or above', () => {
  // Mutation caught: gating post() on stock:adjust alone (staff hold it).
  it('refuses staff holding stock:adjust, in words, before any database call', async () => {
    const { svc, stub } = svcFor('staff');
    await expect(svc.post('cc-1')).rejects.toMatchObject({
      code: 'forbidden',
      message: CYCLE_COUNT_POST_MANAGER_ONLY_COPY,
      details: { reason: 'manager_posts' },
    });
    expect(stub.rpcCalls).toEqual([]);
    expect(stub.fromCalls).toEqual([]);
  });

  it('a manager posts', async () => {
    for (const role of ['owner', 'admin', 'manager'] as const) {
      const { svc, stub } = svcFor(role);
      await svc.post('cc-1');
      expect(stub.rpcCalls.map((c) => c.name)).toEqual(['post_cycle_count']);
    }
  });
});

describe('cancel(): manager or above, even when an override grants cycle_counts:assign', () => {
  it('refuses staff granted cycle_counts:assign, before any database call', async () => {
    const { svc, stub } = svcFor('staff', STAFF_WITH_GRANTS);
    await expect(svc.cancel('cc-1')).rejects.toMatchObject({
      code: 'forbidden',
      message: CYCLE_COUNT_CANCEL_MANAGER_ONLY_COPY,
    });
    expect(stub.fromCalls).toEqual([]);
  });

  it('a manager cancels', async () => {
    const { svc } = svcFor('manager');
    await expect(svc.cancel('cc-1')).resolves.toBeUndefined();
  });
});

describe('start(): the INSERT policy\'s manager floor', () => {
  it('refuses staff granted cycle_counts:assign with forbidden, not an RLS failure', async () => {
    const { svc, stub } = svcFor('staff', STAFF_WITH_GRANTS);
    await expect(svc.start({ scope: 'selection', warehouseId: null, itemIds: ['i1'] })).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect(stub.rpcCalls).toEqual([]);
    expect(stub.fromCalls).toEqual([]);
  });
});

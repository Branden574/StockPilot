import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Rentals, the digest, restore-point pruning and maintenance notification
 * preferences batch their id lists.
 *
 * None of these lists has a cap the service enforces. One `.in()` past ~215
 * uuids answers 414 locally and fails as "fetch failed" in production after
 * ~7 s of retries.
 */

const { reportError, adminRef } = vi.hoisted(() => ({
  reportError: vi.fn(async () => {}),
  adminRef: { current: null as unknown },
}));
vi.mock('@/lib/error-reporter', () => ({ reportError }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => adminRef.current }));
vi.mock('@/lib/auth/warehouse', () => ({
  assertWarehouseAccess: vi.fn(),
  getWarehouseAccess: vi.fn(async () => ({ hasAllAccess: true, readableIds: [], writableIds: [] })),
  forcedWarehouseId: vi.fn(async () => null),
  ForbiddenError: class extends Error {},
}));
vi.mock('./audit', () => ({ audit: vi.fn(async () => undefined) }));
vi.mock('./notifications', () => ({ createNotification: vi.fn(async () => 'n') }));

import { DEFAULT_MODULE_IDS, type ModuleId } from '@stockpilot/core';

import {
  callArgs,
  inFilters,
  makeServiceContext,
  makeSupabaseStub,
  type MockCall,
} from '@/test/supabase-mock';

import { getDigestData } from './digest';
import { resolveMaintenanceAudience } from './maintenance-notify';
import { RentalsService } from './rentals';
import { pruneSnapshots } from './restore-points';

const uuid = (i: number, p = '0') => `${p.repeat(8)}-0000-4000-8000-${String(i).padStart(12, '0')}`;
function inList(call: MockCall, column: string): string[] {
  return (inFilters(call).find(([c]) => c === column)?.[1] ?? []) as string[];
}
const tags = () =>
  reportError.mock.calls.map((c) => (c as unknown as [Error, { tag: string }])[1].tag);

beforeEach(() => vi.clearAllMocks());

describe('RentalsService.create with 150 lines', () => {
  const lines = Array.from({ length: 150 }, (_, i) => ({ itemId: uuid(i, 'a'), quantity: 1 }));
  const input = {
    warehouseId: 'wh-1',
    borrowerName: 'Pat',
    expectedReturnAt: new Date(Date.now() + 86_400_000).toISOString(),
    lines,
  };
  const svcFor = (client: unknown) =>
    new RentalsService(
      makeServiceContext(client, {
        enabledModules: new Set<ModuleId>([...DEFAULT_MODULE_IDS, 'rentals' as ModuleId]),
      }) as never,
    );

  // The item and availability checks moved into create_rental (migration
  // 0361), which reads them inside the database: there is no id list in a
  // URL left to batch. What remains is that all 150 lines reach it in ONE
  // call, so the check and the writes cover the whole checkout atomically.
  it('sends every line to create_rental in one call, with no id-list reads of its own', async () => {
    const stub = makeSupabaseStub({
      'rpc:create_rental': { data: 'rental-150', error: null },
    });
    await expect(svcFor(stub.client).create(input as never)).resolves.toEqual({ id: 'rental-150' });
    const calls = stub.rpcCalls.filter((c) => c.name === 'create_rental');
    expect(calls).toHaveLength(1);
    expect((calls[0]!.args as { p_lines: unknown[] }).p_lines).toHaveLength(150);
    expect(stub.chains.has('inventory_items.select')).toBe(false);
    expect(stub.chains.has('stock_reservations.select')).toBe(false);
  });

  it("maps the function's availability refusal to validation_error with its wording", async () => {
    const stub = makeSupabaseStub({
      'rpc:create_rental': {
        data: null,
        error: {
          message: 'Item: only 0 available to rent (1 on hand, 1 already reserved) — 1 requested.',
          code: '22023',
          hint: 'rental_invalid',
        },
      },
    });
    await expect(svcFor(stub.client).create(input as never)).rejects.toMatchObject({
      code: 'validation_error',
      message: expect.stringMatching(/only 0 available to rent/),
    });
  });
});

describe('getDigestData open cycle counts', () => {
  it("reads 250 open counts' lines in batches, paged on a stable key", async () => {
    const counts = Array.from({ length: 250 }, (_, i) => ({
      id: uuid(i, 'c'),
      started_at: '2026-09-01T00:00:00Z',
      warehouse: null,
    }));
    const lists: string[][] = [];
    const orders: unknown[] = [];
    const stub = makeSupabaseStub({
      'cycle_counts.select': { data: counts, error: null },
      'cycle_count_lines.select': (call) => {
        const list = inList(call, 'cycle_count_id');
        lists.push(list);
        orders.push(callArgs(call, 'order')?.[0]);
        return {
          data: list.map((cycle_count_id) => ({ cycle_count_id, counted_quantity: 1 })),
          error: null,
        };
      },
    });
    const out = await getDigestData(stub.client, 'org-1');
    expect(lists.map((l) => l.length)).toEqual([100, 100, 50]);
    expect(orders.every((o) => o === 'id')).toBe(true);
    expect(out.openCycleCounts).toHaveLength(250);
  });
});

describe('pruneSnapshots', () => {
  it('deletes stale snapshots in batches and reports a failed batch', async () => {
    const stale = Array.from({ length: 250 }, (_, i) => ({ id: uuid(i, 'r') }));
    let n = 0;
    const lists: string[][] = [];
    const stub = makeSupabaseStub({
      'restore_points.select': { data: stale, error: null },
      'restore_points.delete': (call) => {
        n += 1;
        lists.push(inList(call, 'id'));
        return n === 2 ? { data: null, error: { message: 'boom' } } : { data: null, error: null };
      },
    });
    await pruneSnapshots(stub.client as never, 'org-1');
    expect(lists.map((l) => l.length)).toEqual([100, 100]);
    expect(tags()).toEqual(['restore_points.prune']);
  });
});

describe('resolveMaintenanceAudience preference read', () => {
  it("reads 150 recipients' preferences in batches and honours an opt-out in the last batch", async () => {
    const members = Array.from({ length: 151 }, (_, i) => ({
      user_id: uuid(i, 'u'),
      role: 'admin',
    }));
    const lists: string[][] = [];
    const stub = makeSupabaseStub({
      'organization_members.select': { data: members, error: null },
      'role_permission_overrides.select': { data: [], error: null },
      'user_permission_overrides.select': { data: [], error: null },
      'organization_modules.select': {
        data: {
          settings: {
            notifyAudience: Object.fromEntries(members.map((m) => [m.user_id, 'all'])),
          },
        },
        error: null,
      },
      'notification_preferences.select': (call) => {
        const list = inList(call, 'user_id');
        lists.push(list);
        return {
          data: list
            .filter((id) => id === uuid(150, 'u'))
            .map((user_id) => ({ user_id, push_maintenance_new_request: false })),
          error: null,
        };
      },
    });
    adminRef.current = stub.client;
    const out = await resolveMaintenanceAudience({
      organizationId: 'org-1',
      event: 'new_request',
      actorUserId: uuid(0, 'u'),
    });
    expect(lists.map((l) => l.length)).toEqual([100, 50]);
    expect(out).toHaveLength(149);
    expect(out).not.toContain(uuid(150, 'u'));
  });
});

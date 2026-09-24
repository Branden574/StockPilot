import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Phase 0 S5-C (migration 0369), the service half.
 *
 *   recordCount   writes captured_at ONLY when given (the web action and old
 *                 phone bundles send none, and a database before 0369 has no
 *                 such column), and a record that timed out behind an
 *                 in-flight post (55P03 lock_not_available, 57014
 *                 query_canceled) is a RETRYABLE internal error, never a
 *                 conflict or validation error, which the phone's drain would
 *                 treat as final.
 *   D8            rental equipment and kit phantoms are never counted: the
 *                 in-scope count, the selection pre-read and the group
 *                 expansion all repeat start_cycle_count's predicate.
 *   D7            the detail page carries each line's capture time for the
 *                 review, and a failed read of it degrades to none.
 */

const reportError = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/lib/error-reporter', () => ({ reportError }));
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
vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    userId: 'user-test',
    organizationId: 'org-test',
    role: 'admin',
  })),
}));

import { DEFAULT_MODULE_IDS, type ModuleId } from '@stockpilot/core';

import {
  makeServiceContext,
  makeSupabaseStub,
  servedLikePostgrest,
  type MockCall,
} from '@/test/supabase-mock';

import { ServiceError } from './context';
import { CycleCountsService } from './cycle-counts';

beforeEach(() => {
  reportError.mockClear();
});

function openCount() {
  return {
    data: { warehouse_id: 'wh-a', assigned_to: null, status: 'in_progress', scope: 'warehouse' },
    error: null,
  };
}

describe('recordCount — capture time (0369)', () => {
  it('writes captured_at when the route gives one', async () => {
    const stub = makeSupabaseStub({
      'cycle_counts.select': openCount(),
      'cycle_count_lines.update': { data: { id: 'line-1' }, error: null },
    });
    const svc = new CycleCountsService(makeServiceContext(stub.client));
    await svc.recordCount({
      cycleCountId: 'cc-1',
      lineId: 'line-1',
      countedQuantity: 20,
      capturedAt: '2026-09-24T17:20:00.000Z',
    });
    const update = stub.chainArgs.get('cycle_count_lines.update')?.[0]?.[0] as Record<string, unknown>;
    expect(update.captured_at).toBe('2026-09-24T17:20:00.000Z');
    expect(update.counted_quantity).toBe(20);
  });

  it('does not touch captured_at when none is given (web action, old phones)', async () => {
    const stub = makeSupabaseStub({
      'cycle_counts.select': openCount(),
      'cycle_count_lines.update': { data: { id: 'line-1' }, error: null },
    });
    const svc = new CycleCountsService(makeServiceContext(stub.client));
    await svc.recordCount({ cycleCountId: 'cc-1', lineId: 'line-1', countedQuantity: 20 });
    const update = stub.chainArgs.get('cycle_count_lines.update')?.[0]?.[0] as Record<string, unknown>;
    expect('captured_at' in update).toBe(false);
    // The AI-scan link is untouched when no aiScanId is given, too.
    expect('ai_scan_id' in update).toBe(false);
  });

  it.each(['55P03', '57014'])(
    'a %s (waited too long behind an in-flight post) is a RETRYABLE internal error',
    async (code) => {
      const stub = makeSupabaseStub({
        'cycle_counts.select': openCount(),
        'cycle_count_lines.update': {
          data: null,
          error: { message: 'canceling statement due to lock timeout', code },
        },
      });
      const svc = new CycleCountsService(makeServiceContext(stub.client));
      const err = await svc
        .recordCount({ cycleCountId: 'cc-1', lineId: 'line-1', countedQuantity: 20 })
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(err).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).code).toBe('internal_error');
      expect((err as ServiceError).details).toEqual({ retryable: true });
      // The public message stays generic (S13).
      expect((err as ServiceError).message).not.toContain(code);
    },
  );

  it('any other write error stays a plain internal error (not marked retryable)', async () => {
    const stub = makeSupabaseStub({
      'cycle_counts.select': openCount(),
      'cycle_count_lines.update': {
        data: null,
        error: { message: 'new row violates check constraint', code: '23514' },
      },
    });
    const svc = new CycleCountsService(makeServiceContext(stub.client));
    await expect(
      svc.recordCount({ cycleCountId: 'cc-1', lineId: 'line-1', countedQuantity: 20 }),
    ).rejects.toMatchObject({ code: 'internal_error', details: undefined });
  });
});

describe('rental equipment and kit phantoms are not counted (0369, D8)', () => {
  const items = [
    { id: 'plain', organization_id: 'org-test', warehouse_id: 'wh-a', deleted_at: null, status: 'active', is_rental: false, is_bundle: false, group_id: 'g1' },
    { id: 'rental', organization_id: 'org-test', warehouse_id: 'wh-a', deleted_at: null, status: 'active', is_rental: true, is_bundle: false, group_id: 'g1' },
    { id: 'kit', organization_id: 'org-test', warehouse_id: 'wh-a', deleted_at: null, status: 'active', is_rental: false, is_bundle: true, group_id: 'g1' },
  ];

  it('itemsInScopeCount repeats the snapshot predicate', async () => {
    const stub = makeSupabaseStub({
      'cycle_counts.select': openCount(),
      'inventory_items.select': (call: MockCall) => ({
        data: null,
        error: null,
        count: (servedLikePostgrest(items)(call).data as unknown[]).length,
      }),
    });
    const svc = new CycleCountsService(makeServiceContext(stub.client));
    expect(await svc.itemsInScopeCount('cc-1')).toBe(1);
    const chain = stub.chainArgs.get('inventory_items.select') ?? [];
    expect(chain).toContainEqual(['is_rental', false]);
    expect(chain).toContainEqual(['is_bundle', false]);
  });

  it('a selection drops rentals and kits (reported as skipped) before the snapshot', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': servedLikePostgrest(items),
      'rpc:start_cycle_count': { data: [{ cycle_count_id: 'cc-9', line_count: 1 }], error: null },
    });
    const svc = new CycleCountsService(makeServiceContext(stub.client));
    const res = await svc.start({
      scope: 'selection',
      warehouseId: null,
      itemIds: ['plain', 'rental', 'kit'],
    });
    const rpc = stub.rpcCalls.find((c) => c.name === 'start_cycle_count');
    expect((rpc?.args as { p_item_ids: string[] }).p_item_ids).toEqual(['plain']);
    expect(res.skipped).toBe(2);
  });

  it('a selection of only rentals and kits starts nothing', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': servedLikePostgrest(items),
    });
    const svc = new CycleCountsService(makeServiceContext(stub.client));
    await expect(
      svc.start({ scope: 'selection', warehouseId: null, itemIds: ['rental', 'kit'] }),
    ).rejects.toMatchObject({
      code: 'validation_error',
      message: expect.stringContaining('rental equipment and kits are left out of counts'),
    });
    expect(stub.rpcCalls.find((c) => c.name === 'start_cycle_count')).toBeUndefined();
  });

  it('a group count expands to countable variants only', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': servedLikePostgrest(items),
      'rpc:start_cycle_count': { data: [{ cycle_count_id: 'cc-9', line_count: 1 }], error: null },
    });
    const svc = new CycleCountsService(
      makeServiceContext(stub.client, {
        enabledModules: new Set<ModuleId>([...DEFAULT_MODULE_IDS, 'cycle_counts', 'sports']),
      }),
    );
    await svc.start({ scope: 'group', warehouseId: null, groupIds: ['g1'] });
    const expansion = stub.chainArgsAll.get('inventory_items.select')?.[0] ?? [];
    expect(expansion).toContainEqual(['is_rental', false]);
    expect(expansion).toContainEqual(['is_bundle', false]);
    const rpc = stub.rpcCalls.find((c) => c.name === 'start_cycle_count');
    expect((rpc?.args as { p_item_ids: string[] }).p_item_ids).toEqual(['plain']);
  });
});

describe('getDetailPage — capture time for the review (0369, D7)', () => {
  const line = (id: string) => ({
    id,
    cycle_count_id: 'cc-1',
    item_id: `item-${id}`,
    warehouse_id: 'wh-a',
    expected_quantity: 20,
    counted_quantity: 20,
    counted_at: '2026-09-25T15:00:00.000Z',
    full_count: 2,
  });

  it('carries each line\'s captured_at', async () => {
    const stub = makeSupabaseStub({
      'cycle_counts.select': { data: [{ id: 'cc-1', status: 'in_progress', warehouse_id: null }], error: null },
      'rpc:cycle_count_lines_page': { data: [line('l1'), line('l2')], error: null },
      'rpc:cycle_count_summary': { data: [], error: null },
      'inventory_items.select': { data: [], error: null },
      'cycle_count_lines.select': servedLikePostgrest([
        { id: 'l1', cycle_count_id: 'cc-1', captured_at: '2026-09-24T17:20:00.000Z' },
        { id: 'l2', cycle_count_id: 'cc-1', captured_at: null },
      ]),
    });
    const svc = new CycleCountsService(makeServiceContext(stub.client));
    const page = await svc.getDetailPage('cc-1', { pageSize: 50 });
    expect(page.lines.map((l) => l.captured_at)).toEqual(['2026-09-24T17:20:00.000Z', null]);
  });

  it('a refused capture-time read shows none instead of breaking the page', async () => {
    const stub = makeSupabaseStub({
      'cycle_counts.select': { data: [{ id: 'cc-1', status: 'in_progress', warehouse_id: null }], error: null },
      'rpc:cycle_count_lines_page': { data: [line('l1')], error: null },
      'rpc:cycle_count_summary': { data: [], error: null },
      'inventory_items.select': { data: [], error: null },
      'cycle_count_lines.select': {
        data: null,
        error: { message: 'column cycle_count_lines.captured_at does not exist', code: '42703' },
      },
    });
    const svc = new CycleCountsService(makeServiceContext(stub.client));
    const page = await svc.getDetailPage('cc-1', { pageSize: 50 });
    expect(page.lines).toHaveLength(1);
    expect(page.lines[0]?.captured_at).toBeNull();
    expect(reportError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tag: 'cycle_counts.detail.captured_at_read' }),
    );
  });
});

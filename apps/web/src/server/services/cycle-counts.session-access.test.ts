// assertSessionAccess on a NULL-header count (org-wide, or a selection that
// spans warehouses) gates on the warehouses the count's LINES touch — the
// cycle_count_lines RLS is org-wide, so this service gate is the only thing
// standing between a warehouse-scoped staffer and another warehouse's lines.
//
// Regression pin for SP-062: the line scan was a bare `.select()`, which
// PostgREST silently clamps to `[api] max_rows = 1000` (recurring bug pattern
// #3). On a >1000-line count whose foreign-warehouse rows sat past the cap the
// gate evaluated an arbitrary SUBSET, passed, and the write went through.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

vi.mock('@/lib/auth/warehouse', () => {
  class ForbiddenError extends Error {
    readonly code = 'forbidden' as const;
  }
  return {
    getWarehouseAccess: vi.fn(async () => ({
      readableIds: ['wh-a'],
      writableIds: ['wh-a'],
      hasAllAccess: false,
      primaryWarehouseId: 'wh-a',
    })),
    // Writable: wh-a only. wh-b is another warehouse's stock.
    assertWarehouseAccess: vi.fn(async (warehouseId: string) => {
      if (warehouseId !== 'wh-a') throw new ForbiddenError('No access to that warehouse.');
    }),
    forcedWarehouseId: vi.fn(async () => null),
    ForbiddenError,
  };
});

vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    userId: 'user-test',
    organizationId: 'org-test',
    role: 'admin',
  })),
}));

import { CycleCountsService } from './cycle-counts';

beforeEach(() => vi.clearAllMocks());

describe('assertSessionAccess — null-header count, >1000 lines', () => {
  it('refuses a foreign-warehouse line that sits PAST the 1000-row PostgREST cap', async () => {
    let page = 0;
    const stub = makeSupabaseStub({
      // Null header warehouse + unassigned → the line-warehouse fallback runs
      // and the assignee lock allows the caller.
      'cycle_counts.select': {
        data: { warehouse_id: null, assigned_to: null, status: 'in_progress' },
        error: null,
      },
      'cycle_count_lines.select': () => {
        page += 1;
        // Page 1 is a FULL page of the staffer's own warehouse; the single
        // wh-b line only appears on page 2. An unpaginated read never sees it.
        if (page === 1) {
          return {
            data: Array.from({ length: 1000 }, () => ({ warehouse_id: 'wh-a' })),
            error: null,
          };
        }
        return { data: [{ warehouse_id: 'wh-b' }], error: null };
      },
      'cycle_count_lines.update': { data: { id: 'line-1' }, error: null },
    });
    const svc = new CycleCountsService(
      makeServiceContext(stub.client, { role: 'staff', userId: 'me' }),
    );

    await expect(
      svc.recordCount({ cycleCountId: 'cc-1', lineId: 'line-1', countedQuantity: 5 }),
    ).rejects.toMatchObject({ code: 'forbidden' });

    // The gate must fire BEFORE the write, and it must have paged.
    expect(stub.chainArgs.get('cycle_count_lines.update')).toBeUndefined();
    expect(page).toBeGreaterThanOrEqual(2);
  });

  it('still allows the staffer when every line is in her own warehouse', async () => {
    let page = 0;
    const stub = makeSupabaseStub({
      'cycle_counts.select': {
        data: { warehouse_id: null, assigned_to: null, status: 'in_progress' },
        error: null,
      },
      'cycle_count_lines.select': () => {
        page += 1;
        if (page === 1) {
          return {
            data: Array.from({ length: 1000 }, () => ({ warehouse_id: 'wh-a' })),
            error: null,
          };
        }
        return { data: [{ warehouse_id: 'wh-a' }], error: null };
      },
      'cycle_count_lines.update': { data: { id: 'line-1' }, error: null },
    });
    const svc = new CycleCountsService(
      makeServiceContext(stub.client, { role: 'staff', userId: 'me' }),
    );

    await expect(
      svc.recordCount({ cycleCountId: 'cc-1', lineId: 'line-1', countedQuantity: 5 }),
    ).resolves.toBeUndefined();
  });
});

// assertSessionAccess on a NULL-header count (org-wide, or a selection that
// spans warehouses) gates on the warehouses the count's LINES touch: the whole
// count is refused unless the caller may write every one of them.
//
// Since S48 cycle_count_lines_select shows a member only the lines of their
// own warehouses, so the gate reads the line warehouses with the service role
// (createAdminClient), after the header read under RLS has found the count.
// Read under RLS, it would see only the caller's warehouses and pass.
//
// Regression pin for SP-062: the line scan was a bare `.select()`, which
// PostgREST silently clamps to `[api] max_rows = 1000` (recurring bug pattern
// #3). On a >1000-line count whose foreign-warehouse rows sat past the cap the
// gate evaluated an arbitrary SUBSET, passed, and the write went through.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub, type SupabaseStub } from '@/test/supabase-mock';

const h = vi.hoisted(() => ({
  admin: null as unknown,
  adminThrows: false,
  access: {
    readableIds: ['wh-a'],
    writableIds: ['wh-a'],
    hasAllAccess: false,
    primaryWarehouseId: 'wh-a',
  } as Record<string, unknown>,
}));

vi.mock('@/lib/auth/warehouse', () => {
  class ForbiddenError extends Error {
    readonly code = 'forbidden' as const;
  }
  return {
    getWarehouseAccess: vi.fn(async () => h.access),
    // Writable: wh-a only, or wh-a and wh-b for the member with both. wh-b is
    // another warehouse's stock.
    assertWarehouseAccess: vi.fn(async (warehouseId: string) => {
      const writable = h.access.writableIds as string[];
      if (!writable.includes(warehouseId)) throw new ForbiddenError('No access to that warehouse.');
    }),
    forcedWarehouseId: vi.fn(async () => null),
    ForbiddenError,
  };
});

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(() => {
    if (h.adminThrows) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not configured');
    return h.admin;
  }),
}));

vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    userId: 'user-test',
    organizationId: 'org-test',
    role: 'admin',
  })),
}));

import { CycleCountsService } from './cycle-counts';

beforeEach(() => {
  vi.clearAllMocks();
  h.admin = null;
  h.adminThrows = false;
  h.access = {
    readableIds: ['wh-a'],
    writableIds: ['wh-a'],
    hasAllAccess: false,
    primaryWarehouseId: 'wh-a',
  };
});

/** The caller's own client: the header (null warehouse, unassigned, open)
 *  and the line write. `rlsLines` is what cycle_count_lines_select returns
 *  to this caller: only her own warehouse's lines. */
function userStub(rlsLines: Array<{ warehouse_id: string | null }> = [{ warehouse_id: 'wh-a' }]) {
  return makeSupabaseStub({
    'cycle_counts.select': {
      data: { warehouse_id: null, assigned_to: null, status: 'in_progress' },
      error: null,
    },
    'cycle_count_lines.select': { data: rlsLines, error: null },
    'cycle_count_lines.update': { data: { id: 'line-1' }, error: null },
  });
}

/** The service-role client: every line of the count, paged. */
function adminStub(pages: Array<Array<{ warehouse_id: string | null }>>): {
  stub: SupabaseStub;
  pagesRead: () => number;
} {
  let page = 0;
  const stub = makeSupabaseStub({
    'cycle_count_lines.select': () => {
      page += 1;
      return { data: pages[page - 1] ?? [], error: null };
    },
  });
  return { stub, pagesRead: () => page };
}

const fullPageOf = (wh: string) => Array.from({ length: 1000 }, () => ({ warehouse_id: wh }));

describe('assertSessionAccess — null-header count, >1000 lines', () => {
  it('refuses a foreign-warehouse line that sits PAST the 1000-row PostgREST cap', async () => {
    // Page 1 is a FULL page of the staffer's own warehouse; the single wh-b
    // line only appears on page 2. An unpaginated read never sees it.
    const admin = adminStub([fullPageOf('wh-a'), [{ warehouse_id: 'wh-b' }]]);
    h.admin = admin.stub.client;
    const user = userStub();
    const svc = new CycleCountsService(
      makeServiceContext(user.client, { role: 'staff', userId: 'me' }),
    );

    await expect(
      svc.recordCount({ cycleCountId: 'cc-1', lineId: 'line-1', countedQuantity: 5 }),
    ).rejects.toMatchObject({ code: 'forbidden' });

    // The gate must fire BEFORE the write, and it must have paged.
    expect(user.chainArgs.get('cycle_count_lines.update')).toBeUndefined();
    expect(admin.pagesRead()).toBeGreaterThanOrEqual(2);
  });

  it('still allows the staffer when every line is in her own warehouse', async () => {
    const admin = adminStub([fullPageOf('wh-a'), [{ warehouse_id: 'wh-a' }]]);
    h.admin = admin.stub.client;
    const user = userStub();
    const svc = new CycleCountsService(
      makeServiceContext(user.client, { role: 'staff', userId: 'me' }),
    );

    await expect(
      svc.recordCount({ cycleCountId: 'cc-1', lineId: 'line-1', countedQuantity: 5 }),
    ).resolves.toBeUndefined();
  });
});

describe('assertSessionAccess — reads the line warehouses past RLS', () => {
  it('refuses the whole count when RLS shows her only her own lines but the count also has a line elsewhere', async () => {
    // Under RLS she reads only wh-a lines; the count also has a wh-b line.
    const admin = adminStub([[{ warehouse_id: 'wh-a' }, { warehouse_id: 'wh-b' }]]);
    h.admin = admin.stub.client;
    const user = userStub([{ warehouse_id: 'wh-a' }]);
    const svc = new CycleCountsService(
      makeServiceContext(user.client, { role: 'staff', userId: 'me' }),
    );

    await expect(
      svc.recordCount({ cycleCountId: 'cc-1', lineId: 'line-1', countedQuantity: 5 }),
    ).rejects.toMatchObject({ code: 'forbidden', message: 'No access to that warehouse.' });
    expect(user.chainArgs.get('cycle_count_lines.update')).toBeUndefined();
    // The decision was made from the service-role read, by count id, and the
    // gate read no line under RLS.
    expect(admin.stub.chainArgs.get('cycle_count_lines.select')).toContainEqual([
      'cycle_count_id',
      'cc-1',
    ]);
    expect(user.chains.get('cycle_count_lines.select')).toBeUndefined();
  });

  it('lets a staff member with both warehouses count the same count', async () => {
    h.access = {
      readableIds: ['wh-a', 'wh-b'],
      writableIds: ['wh-a', 'wh-b'],
      hasAllAccess: false,
      primaryWarehouseId: 'wh-a',
    };
    const admin = adminStub([[{ warehouse_id: 'wh-a' }, { warehouse_id: 'wh-b' }]]);
    h.admin = admin.stub.client;
    const user = userStub([{ warehouse_id: 'wh-a' }, { warehouse_id: 'wh-b' }]);
    const svc = new CycleCountsService(
      makeServiceContext(user.client, { role: 'staff', userId: 'me' }),
    );

    await expect(
      svc.recordCount({ cycleCountId: 'cc-1', lineId: 'line-1', countedQuantity: 5 }),
    ).resolves.toBeUndefined();
  });

  it('still needs every-warehouse access for a line with no warehouse', async () => {
    const admin = adminStub([[{ warehouse_id: 'wh-a' }, { warehouse_id: null }]]);
    h.admin = admin.stub.client;
    const user = userStub([{ warehouse_id: 'wh-a' }]);
    const svc = new CycleCountsService(
      makeServiceContext(user.client, { role: 'staff', userId: 'me' }),
    );

    await expect(
      svc.recordCount({ cycleCountId: 'cc-1', lineId: 'line-1', countedQuantity: 5 }),
    ).rejects.toMatchObject({
      code: 'forbidden',
      message: 'You cannot modify a count that includes items with no warehouse.',
    });
    expect(user.chainArgs.get('cycle_count_lines.update')).toBeUndefined();
  });

  it('a failed service-role read is an internal error and never passes', async () => {
    const stub = makeSupabaseStub({
      'cycle_count_lines.select': { data: null, error: { message: 'upstream unavailable' } },
    });
    h.admin = stub.client;
    const user = userStub();
    const svc = new CycleCountsService(
      makeServiceContext(user.client, { role: 'staff', userId: 'me' }),
    );

    await expect(
      svc.recordCount({ cycleCountId: 'cc-1', lineId: 'line-1', countedQuantity: 5 }),
    ).rejects.toMatchObject({ code: 'internal_error' });
    expect(user.chainArgs.get('cycle_count_lines.update')).toBeUndefined();
  });

  it('an answer that is not a list is an internal error and never passes', async () => {
    const stub = makeSupabaseStub({
      'cycle_count_lines.select': { data: null, error: null },
    });
    h.admin = stub.client;
    const user = userStub();
    const svc = new CycleCountsService(
      makeServiceContext(user.client, { role: 'staff', userId: 'me' }),
    );

    await expect(
      svc.recordCount({ cycleCountId: 'cc-1', lineId: 'line-1', countedQuantity: 5 }),
    ).rejects.toMatchObject({ code: 'internal_error' });
    expect(user.chainArgs.get('cycle_count_lines.update')).toBeUndefined();
  });

  it('a missing service-role key is an internal error and never passes', async () => {
    h.adminThrows = true;
    const user = userStub();
    const svc = new CycleCountsService(
      makeServiceContext(user.client, { role: 'staff', userId: 'me' }),
    );

    await expect(
      svc.recordCount({ cycleCountId: 'cc-1', lineId: 'line-1', countedQuantity: 5 }),
    ).rejects.toMatchObject({ code: 'internal_error' });
    expect(user.chainArgs.get('cycle_count_lines.update')).toBeUndefined();
  });
});

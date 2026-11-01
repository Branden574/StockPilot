import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ORDER_WAREHOUSE_ACCESS_UNREADABLE_COPY, type ModuleId } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { makeSupabaseStub, type QueryResult } from '@/test/supabase-mock';

import { POST as clearPOST } from './clear/route';
import { POST as recordPOST } from './record/route';

/**
 * The phone's count outbox sends a record or a clear again on a 503 and parks
 * it in Unsent work on a 403 (drain-failure.ts). So a refusal that comes from
 * a read of the caller's own warehouse access that FAILED must be a 503,
 * never a 403: the next send may well be allowed, and a parked count is lost
 * (the line's unsynced flag is cleared, and a later Post uses the server's
 * older value for it).
 *
 * The real routes, the real CycleCountsService and the real
 * getWarehouseAccess. Only the request context, the rate limit, the reporter
 * and the database are stubbed. The count's header has no warehouse and its
 * one line is an item with no warehouse, which assertSessionAccess allows
 * only to a caller with every warehouse: here a staff member with the
 * all-warehouses flag, whose assignments read fails (a statement timeout).
 */

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn() }));
// The context below brings its own client, so neither fallback may be reached.
vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => {
    throw new Error('requireOrgContext must not be reached: the route passes its context');
  }),
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => {
    throw new Error('the cookie client must not be created: the context brings a client');
  }),
}));
vi.mock('@/lib/dashboard/request-cache', () => ({
  readWarehousesForRequest: vi.fn(async () => {
    throw new Error('a staff member never reads the warehouse list');
  }),
}));

const CC = '11111111-1111-4111-8111-111111111111';
const LINE = '22222222-2222-4222-8222-222222222222';

/** What PostgREST hands back for a statement that did not run. */
const TIMED_OUT: QueryResult = {
  data: null,
  error: { message: 'canceling statement due to statement timeout', code: '57014' },
};

function database(assignments: QueryResult, allWarehouses = true) {
  return makeSupabaseStub({
    // Header with no warehouse, open and unassigned.
    'cycle_counts.select': {
      data: { warehouse_id: null, assigned_to: null, status: 'in_progress' },
      error: null,
    },
    // One line: an item with no warehouse.
    'cycle_count_lines.select': { data: [{ warehouse_id: null }], error: null },
    'cycle_count_lines.update': { data: { id: LINE }, error: null },
    'user_warehouse_assignments.select': assignments,
    'organization_members.select': { data: [{ all_warehouses: allWarehouses }], error: null },
  });
}

function useContext(stub: ReturnType<typeof makeSupabaseStub>) {
  vi.mocked(withApiContext).mockResolvedValue({
    organizationId: 'org-1',
    userId: 'u-1',
    role: 'staff' as const,
    supabase: stub.client as never,
    mfaRequired: false,
    mfaSatisfied: true,
    enabledModules: new Set<ModuleId>(['cycle_counts']),
  } as never);
}

const params = { params: Promise.resolve({ id: CC, lineId: LINE }) };

function recordRequest() {
  return new Request(`https://test.local/api/v1/cycle-counts/${CC}/lines/${LINE}/record`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ countedQuantity: 4 }),
  }) as unknown as Parameters<typeof recordPOST>[0];
}

function clearRequest() {
  return new Request(`https://test.local/api/v1/cycle-counts/${CC}/lines/${LINE}/clear`, {
    method: 'POST',
  }) as unknown as Parameters<typeof clearPOST>[0];
}

describe('count line writes when the caller warehouse access could not be read', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: true,
      count: 1,
      resetAt: Date.now() + 60_000,
    });
  });

  it('a record is a 503 the phone sends again, not a 403 that parks the count', async () => {
    const stub = database(TIMED_OUT);
    useContext(stub);
    const res = await recordPOST(recordRequest(), params);
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('5');
    expect(await res.json()).toEqual({
      error: 'check_failed',
      message: ORDER_WAREHOUSE_ACCESS_UNREADABLE_COPY,
    });
    // Nothing was written, and the failure is reported as a warning.
    expect(stub.chainArgs.get('cycle_count_lines.update')).toBeUndefined();
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'ForbiddenError', accessUnreadable: true }),
      expect.objectContaining({ tag: 'api.v1.cycle_counts.record', level: 'warning' }),
    );
  });

  it('a clear is a 503 the phone sends again, not a 403 that parks the clear', async () => {
    const stub = database(TIMED_OUT);
    useContext(stub);
    const res = await clearPOST(clearRequest(), params);
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('5');
    expect(await res.json()).toEqual({
      error: 'check_failed',
      message: ORDER_WAREHOUSE_ACCESS_UNREADABLE_COPY,
    });
    expect(stub.chainArgs.get('cycle_count_lines.update')).toBeUndefined();
  });

  it('control: the same record goes through when the access read works', async () => {
    const stub = database({
      data: [{ warehouse_id: 'wh-a', is_primary: true }],
      error: null,
    });
    useContext(stub);
    const res = await recordPOST(recordRequest(), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('a staff member without every warehouse, read correctly, is still a final 403', async () => {
    const stub = database(
      { data: [{ warehouse_id: 'wh-a', is_primary: true }], error: null },
      false,
    );
    useContext(stub);
    const res = await recordPOST(recordRequest(), params);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'forbidden',
      message: 'You cannot modify a count that includes items with no warehouse.',
    });
    expect(reportError).not.toHaveBeenCalled();
  });
});

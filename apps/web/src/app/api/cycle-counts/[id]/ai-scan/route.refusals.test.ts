import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ORDER_WAREHOUSE_ACCESS_UNREADABLE_COPY, type ModuleId } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { makeSupabaseStub, type QueryResult } from '@/test/supabase-mock';

import { POST } from './route';

/**
 * POST /api/cycle-counts/[id]/ai-scan when the warehouse gate refuses.
 *
 * getLineSetForAiScan runs the count's whole gate (assertSessionAccess)
 * before the photo is stored or a model is called, and that gate refuses with
 * a ForbiddenError. S16 at first answered it like any unexpected error: a 500
 * with "Something went wrong", reported at level error on every tap, where
 * before S16 the person read the refusal's own words. Now it is a 403 with
 * those words, not reported; and a 503 the person can simply retry when their
 * own warehouse access could not be read (S16 review round 1, as distribute).
 *
 * The real route, the real CycleCountsService and the real
 * getWarehouseAccess. The context, the environment, the rate limit, the
 * reporter and the database are stubbed; nothing reaches storage or a model.
 * The count's one line is an item with no warehouse, which only a caller with
 * every warehouse may count.
 */

const h = vi.hoisted(() => {
  /** What a configured key reads as here: no model is ever called. */
  const configured = 'configured-in-test';
  return { env: { GEMINI_API_KEY: configured, GEMINI_MODEL: 'test-model' } };
});

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn() }));
vi.mock('@/lib/env', () => ({ env: h.env }));
// A refusal comes before any spend: none of these may be reached.
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(() => {
    throw new Error('storage must not be reached: the gate refuses first');
  }),
}));
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

/** What PostgREST hands back for a statement that did not run. */
const TIMED_OUT: QueryResult = {
  data: null,
  error: { message: 'canceling statement due to statement timeout', code: '57014' },
};

function database(assignments: QueryResult, allWarehouses: boolean) {
  return makeSupabaseStub({
    'cycle_counts.select': {
      data: { warehouse_id: null, assigned_to: null, status: 'in_progress' },
      error: null,
    },
    'cycle_count_lines.select': { data: [{ warehouse_id: null }], error: null },
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
    enabledModules: new Set<ModuleId>(['cycle_counts', 'ai_shelf_scan']),
  } as never);
}

function scanRequest() {
  const form = new FormData();
  form.append('image', new File(['not really a photo'], 'scan.jpg', { type: 'image/jpeg' }));
  return {
    req: new Request(`https://test.local/api/cycle-counts/${CC}/ai-scan`, {
      method: 'POST',
      body: form,
    }) as unknown as Parameters<typeof POST>[0],
    params: { params: Promise.resolve({ id: CC }) },
  };
}

describe('POST /api/cycle-counts/[id]/ai-scan when the warehouse gate refuses', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: true,
      count: 1,
      resetAt: Date.now() + 60_000,
    });
  });

  it('a refusal is a 403 with its own words, and is not reported', async () => {
    useContext(
      database({ data: [{ warehouse_id: 'wh-a', is_primary: true }], error: null }, false),
    );
    const { req, params } = scanRequest();
    const res = await POST(req, params);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'forbidden',
      message: 'You cannot modify a count that includes items with no warehouse.',
    });
    expect(reportError).not.toHaveBeenCalled();
  });

  it('access that could not be read is a 503 to retry, reported as a warning', async () => {
    useContext(database(TIMED_OUT, true));
    const { req, params } = scanRequest();
    const res = await POST(req, params);
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('5');
    expect(await res.json()).toEqual({
      error: 'check_failed',
      message: ORDER_WAREHOUSE_ACCESS_UNREADABLE_COPY,
    });
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'ForbiddenError', accessUnreadable: true }),
      expect.objectContaining({
        tag: 'cycle_counts.ai_scan',
        organizationId: 'org-1',
        level: 'warning',
      }),
    );
  });
});

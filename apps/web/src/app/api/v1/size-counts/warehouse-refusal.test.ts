import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ORDER_WAREHOUSE_ACCESS_UNREADABLE_COPY,
  type ModuleId,
  type Permission,
} from '@stockpilot/core';

import { claudeGenerateJsonString } from '@/lib/ai/claude';
import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { createAdminClient } from '@/lib/supabase/admin';
import { makeSupabaseStub, type QueryResult } from '@/test/supabase-mock';

import { POST as eventsPOST } from './[id]/events/route';
import { POST as scanPOST } from './[id]/scan/route';
import { POST as startPOST } from './route';

/**
 * The size-count routes when assertWarehouseAccess refuses (B73).
 *
 * Start, append and scan check the caller's warehouse access for a size count
 * that names a warehouse, before any write and before any vision call. That
 * check refuses with a ForbiddenError, which is not a ServiceError, so
 * sizeCountError answered it like any unexpected error: a 500 internal_error,
 * reported at level error on every request. Now a refusal is a 403 with its
 * own words and is not reported, and a refusal that comes from a failed read
 * of the caller's own access is a 503 to retry, reported as a warning: the
 * answer S16 gave bundle distribute and the count routes.
 *
 * The real routes, the real SizeCountsService and the real
 * getWarehouseAccess. The context, the environment, the rate limit, the
 * reporter, the Claude client and the database are stubbed; nothing reaches
 * a model or the admin client. The caller is a staff member (who holds
 * stock:adjust by default) assigned to one warehouse, and the size count was
 * started in another.
 */

const h = vi.hoisted(() => {
  /** What a configured key reads as here: no model is ever called. */
  const configured = 'configured-in-test';
  return {
    env: {
      ANTHROPIC_API_KEY: configured,
      ANTHROPIC_SIZE_SCAN_MODEL: 'test-model',
      GEMINI_API_KEY: configured,
      GEMINI_MODEL: 'test-model',
    },
  };
});

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn() }));
vi.mock('@/lib/env', () => ({ env: h.env }));
// A refusal comes before any spend: neither may be reached.
vi.mock('@/lib/ai/claude', () => ({
  claudeGenerateJsonString: vi.fn(async () => {
    throw new Error('the model must not be called: the gate refuses first');
  }),
}));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(() => {
    throw new Error('the admin client must not be reached: the gate refuses first');
  }),
}));
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

const SESSION = '11111111-1111-4111-8111-111111111111';
const WH_HOME = '22222222-2222-4222-8222-222222222222';
const WH_OTHER = '33333333-3333-4333-8333-333333333333';
const EVENT_KEY = '44444444-4444-4444-8444-444444444444';
const INSERTED_EVENT = '55555555-5555-4555-8555-555555555555';

/** What PostgREST hands back for a statement that did not run. */
const TIMED_OUT: QueryResult = {
  data: null,
  error: { message: 'canceling statement due to statement timeout', code: '57014' },
};

const HOME_ONLY: QueryResult = {
  data: [{ warehouse_id: WH_HOME, is_primary: true }],
  error: null,
};

function database(assignments: QueryResult = HOME_ONLY) {
  return makeSupabaseStub({
    // An open, ungrouped size count started in a warehouse the caller does
    // not work in.
    'size_count_sessions.select': {
      data: { warehouse_id: WH_OTHER, status: 'active', product_group_id: null },
      error: null,
    },
    'size_count_sessions.insert': {
      data: { id: SESSION, warehouse_id: WH_HOME, status: 'active' },
      error: null,
    },
    'user_warehouse_assignments.select': assignments,
    'organization_members.select': { data: [{ all_warehouses: false }], error: null },
    'size_count_events.insert': { data: [{ id: INSERTED_EVENT }], error: null },
  });
}

function useContext(
  stub: ReturnType<typeof makeSupabaseStub>,
  caller: { role?: 'staff' | 'viewer'; permissions?: Set<Permission> } = {},
) {
  vi.mocked(withApiContext).mockResolvedValue({
    organizationId: 'org-1',
    userId: 'u-1',
    role: caller.role ?? 'staff',
    ...(caller.permissions ? { permissions: caller.permissions } : {}),
    supabase: stub.client as never,
    mfaRequired: false,
    mfaSatisfied: true,
    enabledModules: new Set<ModuleId>(['instant_size_count', 'ai']),
  } as never);
}

const params = () => ({ params: Promise.resolve({ id: SESSION }) });

function startRequest(warehouseId: string) {
  return new Request('https://test.local/api/v1/size-counts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'rapid_pass', warehouseId }),
  }) as unknown as Parameters<typeof startPOST>[0];
}

function eventsRequest() {
  return new Request(`https://test.local/api/v1/size-counts/${SESSION}/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ events: [{ idempotencyKey: EVENT_KEY, size: 'M' }] }),
  }) as unknown as Parameters<typeof eventsPOST>[0];
}

function scanRequest() {
  const form = new FormData();
  form.append('image', new File(['not really a photo'], 'scan.jpg', { type: 'image/jpeg' }));
  return new Request(`https://test.local/api/v1/size-counts/${SESSION}/scan`, {
    method: 'POST',
    body: form,
  }) as unknown as Parameters<typeof scanPOST>[0];
}

const REFUSED = {
  error: 'forbidden',
  message: `User does not have write access to warehouse ${WH_OTHER}.`,
};

const CHECK_FAILED = { error: 'check_failed', message: ORDER_WAREHOUSE_ACCESS_UNREADABLE_COPY };

describe('size-count requests the warehouse check refuses (B73)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: true,
      count: 1,
      resetAt: Date.now() + 60_000,
    });
  });

  describe('append (POST /api/v1/size-counts/[id]/events)', () => {
    it('a warehouse the caller does not work in is a 403 with its words, not reported', async () => {
      const stub = database();
      useContext(stub);
      const res = await eventsPOST(eventsRequest(), params());
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual(REFUSED);
      expect(reportError).not.toHaveBeenCalled();
      expect(stub.chainArgs.get('size_count_events.insert')).toBeUndefined();
    });

    it('access that could not be read is a 503 to retry, reported as a warning', async () => {
      const stub = database(TIMED_OUT);
      useContext(stub);
      const res = await eventsPOST(eventsRequest(), params());
      expect(res.status).toBe(503);
      expect(res.headers.get('Retry-After')).toBe('5');
      expect(await res.json()).toEqual(CHECK_FAILED);
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'ForbiddenError', accessUnreadable: true }),
        { tag: 'size-counts.api', level: 'warning' },
      );
      expect(stub.chainArgs.get('size_count_events.insert')).toBeUndefined();
    });

    it('a viewer granted stock:adjust is a 403 with its words, not reported', async () => {
      const stub = database();
      useContext(stub, { role: 'viewer', permissions: new Set<Permission>(['stock:adjust']) });
      const res = await eventsPOST(eventsRequest(), params());
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({
        error: 'forbidden',
        message: 'Read-only auditor cannot perform write operations.',
      });
      expect(reportError).not.toHaveBeenCalled();
      expect(stub.chainArgs.get('size_count_events.insert')).toBeUndefined();
    });

    it('control: the same events land when the caller works in that warehouse', async () => {
      const stub = database({
        data: [
          { warehouse_id: WH_HOME, is_primary: true },
          { warehouse_id: WH_OTHER, is_primary: false },
        ],
        error: null,
      });
      useContext(stub);
      const res = await eventsPOST(eventsRequest(), params());
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, inserted: 1 });
      expect(stub.chainArgs.get('size_count_events.insert')).toBeDefined();
      expect(reportError).not.toHaveBeenCalled();
    });
  });

  describe('scan (POST /api/v1/size-counts/[id]/scan)', () => {
    function expectNothingSpent() {
      expect(checkRateLimit).not.toHaveBeenCalled();
      expect(claudeGenerateJsonString).not.toHaveBeenCalled();
      expect(createAdminClient).not.toHaveBeenCalled();
    }

    it('a warehouse the caller does not work in is a 403 with its words, not reported', async () => {
      useContext(database());
      const res = await scanPOST(scanRequest(), params());
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual(REFUSED);
      expect(reportError).not.toHaveBeenCalled();
      expectNothingSpent();
    });

    it('access that could not be read is a 503 to retry, reported as a warning', async () => {
      useContext(database(TIMED_OUT));
      const res = await scanPOST(scanRequest(), params());
      expect(res.status).toBe(503);
      expect(res.headers.get('Retry-After')).toBe('5');
      expect(await res.json()).toEqual(CHECK_FAILED);
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'ForbiddenError', accessUnreadable: true }),
        { tag: 'size-counts.api', level: 'warning' },
      );
      expectNothingSpent();
    });

    it('control: past the gate, the same scan reaches the rate limits', async () => {
      useContext(
        database({
          data: [
            { warehouse_id: WH_HOME, is_primary: true },
            { warehouse_id: WH_OTHER, is_primary: false },
          ],
          error: null,
        }),
      );
      const res = await scanPOST(scanRequest(), params());
      // The bytes are not an image, so the route stops before any model call.
      expect(res.status).toBe(422);
      expect(await res.json()).toMatchObject({ error: 'invalid_image' });
      expect(checkRateLimit).toHaveBeenCalledTimes(2);
      expect(claudeGenerateJsonString).not.toHaveBeenCalled();
      expect(reportError).not.toHaveBeenCalled();
    });
  });

  describe('start (POST /api/v1/size-counts)', () => {
    it('naming a warehouse the caller does not work in is a 403 with its words, not reported', async () => {
      const stub = database();
      useContext(stub);
      const res = await startPOST(startRequest(WH_OTHER));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual(REFUSED);
      expect(reportError).not.toHaveBeenCalled();
      expect(stub.fromCalls).not.toContain('size_count_sessions');
    });

    it("control: naming the caller's own warehouse starts the size count", async () => {
      const stub = database();
      useContext(stub);
      const res = await startPOST(startRequest(WH_HOME));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, session: { id: SESSION } });
      expect(stub.fromCalls).toContain('size_count_sessions');
      expect(stub.chainArgs.get('size_count_sessions.insert')?.[0]?.[0]).toMatchObject({
        warehouse_id: WH_HOME,
      });
      expect(reportError).not.toHaveBeenCalled();
    });
  });
});

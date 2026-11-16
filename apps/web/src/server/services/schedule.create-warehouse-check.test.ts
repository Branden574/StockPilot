import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Security invariant: ScheduleService.create refuses an event whose warehouse
 * (or a linked kit's warehouse) the caller cannot write, before the event is
 * written, and keeps two refusals apart:
 *
 *   - the caller's real scope does not include the warehouse: the
 *     ServiceError 'forbidden' with the check's words; the web action answers
 *     it as forbidden, POST /api/v1/schedule as 403;
 *   - the check could not read the caller's own access (ForbiddenError's
 *     accessUnreadable): the ForbiddenError itself, so the web action answers
 *     the shared "could not check" sentence as a retryable conflict, and the
 *     route the retryable 503 check_failed, never a final 403.
 *
 * Neither writes the event or an audit row.
 */

const h = vi.hoisted(() => ({ withContext: vi.fn() }));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));
vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, count: 1, resetAt: Date.now() + 60_000 })),
}));
vi.mock('@/lib/auth/warehouse', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/warehouse')>()),
  assertWarehouseAccess: vi.fn(),
}));
vi.mock('./context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./context')>()),
  withContext: h.withContext,
}));

import { ORDER_WAREHOUSE_ACCESS_UNREADABLE_COPY } from '@stockpilot/core';

import { POST } from '@/app/api/v1/schedule/route';
import { withApiContext } from '@/lib/auth/api-context';
import { assertWarehouseAccess, ForbiddenError } from '@/lib/auth/warehouse';
import { createScheduleEventAction } from '@/server/actions/schedule';
import { makeServiceContext, makeSupabaseStub, type SupabaseStub } from '@/test/supabase-mock';

import { audit } from './audit';
import { ServiceError } from './context';
import { ScheduleService } from './schedule';

const WAREHOUSE = '3c1d2e4f-0000-4000-8000-000000000051';
const KIT_WAREHOUSE = '3c1d2e4f-0000-4000-8000-000000000052';
const KIT = '4d4d4d4d-0000-4000-8000-000000000053';

const input = {
  title: 'Science night setup',
  startsAt: '2026-12-03T17:00:00.000Z',
  allDay: false,
  status: 'scheduled' as const,
  warehouseId: WAREHOUSE,
};

let stub: SupabaseStub;

function signIn() {
  stub = makeSupabaseStub({
    'schedule_events.insert': { data: null, error: { message: 'not expected' } },
  });
  const ctx = makeServiceContext(stub.client, {
    organizationId: 'org-route',
    userId: 'user-route',
    role: 'staff',
    permissions: new Set(['schedule:manage']),
  });
  vi.mocked(withApiContext).mockResolvedValue(ctx as never);
  h.withContext.mockResolvedValue(ctx);
  return ctx;
}

const unreadable = () =>
  new ForbiddenError(`User does not have write access to warehouse ${WAREHOUSE}.`, {
    accessUnreadable: true,
  });
const outOfScope = () =>
  new ForbiddenError(`User does not have write access to warehouse ${WAREHOUSE}.`);

function routeRequest(body: unknown = input) {
  return new Request('https://test.local/api/v1/schedule', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(assertWarehouseAccess).mockResolvedValue(undefined);
});

describe('ScheduleService.create: the warehouse check', () => {
  it("a warehouse outside the caller's scope is the ServiceError forbidden, with the check's words", async () => {
    const ctx = signIn();
    vi.mocked(assertWarehouseAccess).mockRejectedValueOnce(outOfScope());
    const err = await new ScheduleService(ctx as never).create(input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect(err).toMatchObject({
      code: 'forbidden',
      message: `User does not have write access to warehouse ${WAREHOUSE}.`,
    });
    expect(stub.fromCalls).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it.each([
    ["the event's warehouse", input, WAREHOUSE],
    [
      "a linked kit's warehouse",
      {
        ...input,
        warehouseId: undefined,
        bundleId: KIT,
        bundleQuantity: 2,
        bundleWarehouseId: KIT_WAREHOUSE,
      },
      KIT_WAREHOUSE,
    ],
  ] as const)(
    'a check of %s that could not read the caller access is thrown as it is, flag kept',
    async (_label, body, warehouse) => {
      const ctx = signIn();
      const thrown = unreadable();
      vi.mocked(assertWarehouseAccess).mockImplementation(async (id) => {
        if (id === warehouse) throw thrown;
      });
      const err = await new ScheduleService(ctx as never).create(body).catch((e: unknown) => e);
      expect(err).toBe(thrown);
      expect((err as ForbiddenError).accessUnreadable).toBe(true);
      expect(stub.fromCalls).toEqual([]);
      expect(audit).not.toHaveBeenCalled();
    },
  );
});

describe('the answers of the web action and the route', () => {
  it('the web action answers the shared "could not check" sentence, retryable, when the access could not be read', async () => {
    signIn();
    vi.mocked(assertWarehouseAccess).mockRejectedValueOnce(unreadable());
    const res = await createScheduleEventAction(input);
    expect(res).toEqual({
      ok: false,
      error: {
        code: 'conflict',
        message: ORDER_WAREHOUSE_ACCESS_UNREADABLE_COPY,
        details: { reason: 'failed', retryable: true },
      },
    });
    expect(audit).not.toHaveBeenCalled();
  });

  it('the web action answers forbidden with the words for a warehouse outside the scope', async () => {
    signIn();
    vi.mocked(assertWarehouseAccess).mockRejectedValueOnce(outOfScope());
    const res = await createScheduleEventAction(input);
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error.code).toBe('forbidden');
    expect(!res.ok && res.error.message).toBe(
      `User does not have write access to warehouse ${WAREHOUSE}.`,
    );
  });

  it('the route answers the retryable 503 check_failed when the access could not be read', async () => {
    signIn();
    vi.mocked(assertWarehouseAccess).mockRejectedValueOnce(unreadable());
    const res = await POST(routeRequest());
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('5');
    expect(await res.json()).toEqual({
      error: 'check_failed',
      message: ORDER_WAREHOUSE_ACCESS_UNREADABLE_COPY,
    });
    expect(stub.fromCalls).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it('the route answers 403 with the words for a warehouse outside the scope', async () => {
    signIn();
    vi.mocked(assertWarehouseAccess).mockRejectedValueOnce(outOfScope());
    const res = await POST(routeRequest());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'forbidden',
      message: `User does not have write access to warehouse ${WAREHOUSE}.`,
    });
    expect(audit).not.toHaveBeenCalled();
  });
});

import { revalidatePath } from 'next/cache';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { contextUnavailableBody, DEFAULT_MODULE_IDS, type ModuleId } from '@stockpilot/core';

import { MembershipUnavailableError } from '@/lib/auth/membership-unavailable';
import { withApiContext } from '@/lib/auth/api-context';
import { assertWarehouseAccess, ForbiddenError } from '@/lib/auth/warehouse';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { audit } from '@/server/services/audit';
import { makeServiceContext, makeSupabaseStub, type SupabaseStub } from '@/test/supabase-mock';

import { POST } from './route';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn() }));
vi.mock('@/lib/auth/warehouse', () => ({
  assertWarehouseAccess: vi.fn(async () => undefined),
  ForbiddenError: class ForbiddenError extends Error {},
}));

/**
 * Security invariant: POST /api/v1/schedule puts one event on the Schedule
 * through ScheduleService.create, the service the website's Schedule form
 * calls, and the service writes the event's one `schedule.created` audit row
 * with the caller's organization and account.
 *
 * The route builds its context with withApiContext (cookie or Bearer),
 * through the API context gate, so the service's module check, permission,
 * authenticator rule and warehouse checks are the website's own. A refused
 * request writes no event and no audit row. These run the real service over
 * a recording database client; only the audit writer is a recorder.
 */

const WAREHOUSE = '3c1d2e4f-0000-4000-8000-000000000001';
const EVENT = '9e8d7c6b-0000-4000-8000-000000000002';

const savedRow = {
  id: EVENT,
  organization_id: 'org-route',
  title: 'Field day pickup',
  starts_at: '2026-12-01T16:00:00.000Z',
  ends_at: '2026-12-01T17:00:00.000Z',
  all_day: false,
  location_text: 'Gym',
  warehouse_id: WAREHOUSE,
  requester_name: 'Pat Example',
  details: null,
  status: 'scheduled',
  bundle_id: null,
  bundle_quantity: null,
  bundle_warehouse_id: null,
  order_request_id: null,
  created_by: 'user-route',
  updated_by: 'user-route',
  created_at: '2026-11-15T00:00:00.000Z',
  updated_at: '2026-11-15T00:00:00.000Z',
  deleted_users: null,
  warehouse: { name: 'Main' },
};

const eventBody = {
  title: 'Field day pickup',
  startsAt: '2026-12-01T16:00:00.000Z',
  endsAt: '2026-12-01T17:00:00.000Z',
  allDay: false,
  locationText: 'Gym',
  warehouseId: WAREHOUSE,
  requesterName: 'Pat Example',
};

let stub: SupabaseStub;

function signIn(
  overrides: Parameters<typeof makeServiceContext>[1] = {},
  insert: { data: unknown; error: { message: string } | null } = { data: savedRow, error: null },
) {
  stub = makeSupabaseStub({
    'schedule_events.insert': insert,
    'user_profiles.select': { data: [], error: null },
  });
  const ctx = makeServiceContext(stub.client, {
    organizationId: 'org-route',
    userId: 'user-route',
    role: 'manager',
    ...overrides,
  });
  vi.mocked(withApiContext).mockResolvedValue(ctx as never);
  return ctx;
}

function request(body: unknown = eventBody, raw?: string) {
  return new Request('https://test.local/api/v1/schedule', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw ?? JSON.stringify(body),
  }) as unknown as Parameters<typeof POST>[0];
}

describe('POST /api/v1/schedule', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: true,
      count: 1,
      resetAt: Date.now() + 60_000,
    });
  });

  it('makes the event and writes exactly one schedule.created row, as the caller, in the caller organization', async () => {
    const ctx = signIn();
    const res = await POST(request());
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true, id: EVENT });

    const inserted = stub.chainArgs.get('schedule_events.insert')![0]![0] as Record<
      string,
      unknown
    >;
    expect(inserted).toMatchObject({
      organization_id: 'org-route',
      title: 'Field day pickup',
      warehouse_id: WAREHOUSE,
      created_by: 'user-route',
      updated_by: 'user-route',
      status: 'scheduled',
    });

    expect(audit).toHaveBeenCalledTimes(1);
    const [payload, auditCtx] = vi.mocked(audit).mock.calls[0]!;
    expect(payload).toEqual({
      event: 'schedule.created',
      entityType: 'schedule_event',
      entityId: EVENT,
      warehouseId: WAREHOUSE,
      after: {
        title: 'Field day pickup',
        startsAt: '2026-12-01T16:00:00.000Z',
        endsAt: '2026-12-01T17:00:00.000Z',
        status: 'scheduled',
        bundleId: null,
        bundleQuantity: null,
        bundleWarehouseId: null,
      },
    });
    // The route's own context: the row names this account and organization.
    expect(auditCtx).toBe(ctx);
    expect(checkRateLimit).toHaveBeenCalledWith('schedule-create:user-route', 60, 60_000);
    expect(revalidatePath).toHaveBeenCalledWith('/dashboard/schedule');
  });

  it('answers 401 without a context, with nothing written', async () => {
    vi.mocked(withApiContext).mockResolvedValue(null);
    const res = await POST(request());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthenticated' });
    expect(audit).not.toHaveBeenCalled();
  });

  it("answers the gate's 503 when the caller's access could not be read, before any work", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(withApiContext).mockRejectedValue(new MembershipUnavailableError());
    const res = await POST(request());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual(contextUnavailableBody());
    expect(checkRateLimit).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it.each([
    ['a body that is not JSON', undefined, '{not json'],
    ['no title', { ...eventBody, title: '' }, undefined],
    ['a start that is not a time', { ...eventBody, startsAt: 'tomorrow' }, undefined],
    ['an end before the start', { ...eventBody, endsAt: '2026-12-01T15:00:00.000Z' }, undefined],
  ])('answers 400 for %s, with nothing written', async (_label, body, raw) => {
    signIn();
    const res = await POST(request(body, raw));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('validation_error');
    expect(stub.fromCalls).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it('a member without schedule:manage is refused 403, with no event and no audit row', async () => {
    signIn({ role: 'viewer' });
    const res = await POST(request());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'forbidden',
      message: 'Missing permission: schedule:manage',
    });
    expect(stub.fromCalls).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it("the organization's authenticator rule refuses before any write, with its reason, and no audit row", async () => {
    signIn({ mfaRequired: true, mfaSatisfied: false });
    const res = await POST(request());
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('forbidden');
    expect(body.details?.reason).toBe('mfa_required');
    expect(stub.fromCalls).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it('an organization without the Schedule module is refused, with no audit row', async () => {
    signIn({
      enabledModules: new Set<ModuleId>(DEFAULT_MODULE_IDS.filter((m) => m !== 'schedule')),
    });
    const res = await POST(request());
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('module_disabled');
    expect(stub.fromCalls).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it('a warehouse the caller cannot write is refused 403, with no event and no audit row', async () => {
    signIn();
    vi.mocked(assertWarehouseAccess).mockRejectedValueOnce(
      new ForbiddenError('You do not have write access to this warehouse.'),
    );
    const res = await POST(request());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'forbidden',
      message:
        "You don't have write access to the warehouse set for this event, so nothing was saved. Choose a warehouse you work in, or ask a manager.",
    });
    expect(stub.chainArgs.get('schedule_events.insert')).toBeUndefined();
    expect(audit).not.toHaveBeenCalled();
  });

  it('a write the database refused answers a fixed sentence, writes no audit row, and is reported', async () => {
    signIn({}, { data: null, error: { message: 'new row violates row-level security policy' } });
    const res = await POST(request());
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain('row-level security');
    expect(JSON.parse(text).error).toBe('internal_error');
    expect(audit).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(expect.anything(), {
      tag: 'api.v1.schedule.create',
      organizationId: 'org-route',
    });
  });

  it('answers 429 with Retry-After when the account is over its limit, with nothing written', async () => {
    signIn();
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: false,
      count: 61,
      resetAt: Date.now() + 30_000,
    });
    const res = await POST(request());
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(stub.fromCalls).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  NEEDED_BY_BUSY_COPY,
  NEEDED_BY_CLOSED_COPY,
  NEEDED_BY_IN_PAST_COPY,
  NEEDED_BY_MODULE_OFF_COPY,
  NEEDED_BY_NO_WAREHOUSE_ACCESS_COPY,
  NEEDED_BY_NOT_APPROVER_COPY,
  NEEDED_BY_NOT_FOUND_COPY,
  NEEDED_BY_NOT_PENDING_COPY,
  NEEDED_BY_OUT_OF_RANGE_COPY,
  NEEDED_BY_REASON_REQUIRED_COPY,
  NEEDED_BY_RELOAD_COPY,
  NEEDED_BY_SIGN_IN_COPY,
  NEEDED_BY_TIMEZONE_UNREADABLE_COPY,
  neededByChangedCopy,
  neededByInvalidTimeCopy,
  ORDER_WAREHOUSE_ACCESS_UNREADABLE_COPY,
  ORDER_WAREHOUSE_WRITE_REFUSED_COPY,
  orderScheduleEventDetails,
  type ModuleId,
  type Role,
} from '@stockpilot/core';

import { assertWarehouseAccess, ForbiddenError } from '@/lib/auth/warehouse';
import { reportError } from '@/lib/error-reporter';
import { broadcastOrderChanged } from '@/lib/realtime/broadcast';
import { makeServiceContext, makeSupabaseStub, type MockCall, type QueryResult } from '@/test/supabase-mock';

import { audit } from './audit';
import { ServiceError } from './context';
import { OrderRequestsService, type ReviseNeededByInput } from './order-requests';

// F2-4 (0383): change an order's needed-by. The function is the authority
// (its gates, the lock, the stale check, the event move: pgTAP 0383 and the
// two-session race); these pin the service around it: its gates and their
// words, the ORG-zone conversion, what it sends, every refusal it words, the
// missing-event path through autoScheduleFromOrder (the one writer of new
// events), the audit entry and the broadcast.

vi.mock('@/lib/auth/warehouse', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/auth/warehouse')>();
  return {
    ...real,
    assertWarehouseAccess: vi.fn(async () => {}),
    getWarehouseAccess: vi.fn(async () => ({
      readableIds: ['wh-1'],
      writableIds: ['wh-1'],
      hasAllAccess: true,
      primaryWarehouseId: 'wh-1',
    })),
  };
});
vi.mock('./audit', () => ({ audit: vi.fn(async () => {}) }));
vi.mock('./notifications', () => ({ createNotification: vi.fn(async () => 'notif-1') }));
vi.mock('@/lib/realtime/broadcast', () => ({ broadcastOrderChanged: vi.fn(async () => {}) }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('@/lib/email/order-requests', () => ({ sendOrderRequestEmail: vi.fn(async () => {}) }));
vi.mock('./integration-events', () => ({ dispatchEvent: vi.fn(async () => {}) }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => adminHandle.client }));
const adminHandle: { client: unknown } = { client: null };

const ORDER = '0f000000-0000-4000-8000-000000000016';
const LA = 'America/Los_Angeles';
const OLD = '2026-10-01T21:00:00+00:00';

function orderRow(over: Record<string, unknown> = {}) {
  return {
    id: ORDER,
    organization_id: 'org-test',
    warehouse_id: 'wh-1',
    status: 'approved',
    needed_by: OLD,
    order_number: 16,
    fulfillment_type: 'pickup',
    requester_name: 'Doua Vang',
    assigned_delivery_user_id: null,
    ...over,
  };
}

/** revise_order_needed_by's answer for a call that moved the event. */
function answer(over: Record<string, unknown> = {}) {
  return {
    changed: true,
    previous: OLD,
    neededBy: '2026-10-03T21:00:00+00:00',
    eventId: 'ev-1',
    eventUpdated: true,
    eventStatus: 'scheduled',
    status: 'approved',
    ...over,
  };
}

const NEW = '2026-10-03T21:00:00.000Z';
/** The order's event as the admin client reads it after an insert. */
function eventRow(over: Record<string, unknown> = {}) {
  return {
    id: 'ev-9',
    status: 'scheduled',
    starts_at: '2026-10-03T21:00:00+00:00',
    ends_at: null,
    details: orderScheduleEventDetails({ id: ORDER, orderNumber: 16, neededBy: NEW }, LA),
    ...over,
  };
}
/** The order as the admin client reads it after an insert (bringing the
 *  event in step with it). */
function orderNow(over: Record<string, unknown> = {}) {
  return { id: ORDER, status: 'approved', needed_by: '2026-10-03T21:00:00+00:00', order_number: 16, ...over };
}
/** The admin client's answers for an order past approval with no event. */
function missingEvent(over: Record<string, Result> = {}): Record<string, Result> {
  return {
    'order_requests.select': { data: orderNow(), error: null },
    'schedule_events.select': { data: eventRow(), error: null },
    ...over,
  };
}

type Result = QueryResult | ((call: MockCall) => QueryResult);

function build(
  opts: {
    order?: Result;
    org?: Result;
    rpc?: Result;
    admin?: Record<string, Result>;
    role?: Role;
    permissions?: string[];
    modules?: ModuleId[];
    mfaRequired?: boolean;
    mfaSatisfied?: boolean;
  } = {},
) {
  const stub = makeSupabaseStub({
    'order_requests.select': opts.order ?? { data: orderRow(), error: null },
    'organizations.select': opts.org ?? { data: { timezone: LA }, error: null },
    'rpc:revise_order_needed_by': opts.rpc ?? { data: answer(), error: null },
  });
  const admin = makeSupabaseStub({
    'schedule_events.insert': { data: null, error: null },
    ...(opts.admin ?? {}),
  });
  adminHandle.client = admin.client;
  const svc = new (OrderRequestsService as unknown as new (ctx: unknown) => OrderRequestsService)(
    makeServiceContext(stub.client, {
      role: opts.role ?? 'manager',
      userId: 'approver-1',
      enabledModules: new Set<ModuleId>(opts.modules ?? ['orders']),
      ...(opts.permissions ? { permissions: new Set(opts.permissions) } : {}),
      ...(opts.mfaRequired !== undefined ? { mfaRequired: opts.mfaRequired } : {}),
      ...(opts.mfaSatisfied !== undefined ? { mfaSatisfied: opts.mfaSatisfied } : {}),
    }),
  );
  return { stub, admin, svc };
}

function input(over: Partial<ReviseNeededByInput> = {}): ReviseNeededByInput {
  return {
    id: ORDER,
    neededByLocal: '2026-10-03T14:00',
    expectedNeededBy: OLD,
    reason: '  The school moved the day  ',
    ...over,
  };
}

const rpcArgs = (stub: ReturnType<typeof makeSupabaseStub>) =>
  stub.rpcCalls[0]?.args as Record<string, unknown> | undefined;

async function refusal(p: Promise<unknown>): Promise<ServiceError> {
  const e = await p.catch((x: unknown) => x);
  expect(e).toBeInstanceOf(ServiceError);
  return e as ServiceError;
}

beforeEach(() => {
  vi.mocked(audit).mockClear();
  vi.mocked(broadcastOrderChanged).mockClear();
  vi.mocked(reportError).mockClear();
  vi.mocked(assertWarehouseAccess).mockReset();
  vi.mocked(assertWarehouseAccess).mockImplementation(async () => {});
});

describe('what it sends', () => {
  it('the order, the instant in the ORG zone, the value the caller saw as read, the trimmed reason and core\'s description', async () => {
    const { stub, svc } = build();
    await svc.reviseNeededBy(input());
    expect(stub.rpcCalls).toHaveLength(1);
    expect(rpcArgs(stub)).toEqual({
      p_id: ORDER,
      // Oct 3, 2:00 PM PDT.
      p_needed_by: '2026-10-03T21:00:00.000Z',
      p_expected_needed_by: OLD,
      p_reason: 'The school moved the day',
      p_event_details: 'Auto-created from order SO-000016. Needed by Oct 3, 2026, 2:00 PM.',
    });
  });

  it('passes the expected value exactly as read, microseconds included (the stale check compares it exactly)', async () => {
    const { stub, svc } = build({ order: { data: orderRow({ needed_by: '2026-10-01T21:00:00.123456+00:00' }), error: null } });
    await svc.reviseNeededBy(input({ expectedNeededBy: '2026-10-01T21:00:00.123456+00:00' }));
    expect(rpcArgs(stub)?.p_expected_needed_by).toBe('2026-10-01T21:00:00.123456+00:00');
  });

  it('a wall clock equal to the stored one sends the STORED instant, so an unedited date changes nothing', async () => {
    // Seconds (2 production orders carry sub-minute digits) and the other
    // occurrence of a repeated fall-back hour (Auckland resolves 02:30 to
    // its second occurrence; this one is stored at the first) both read back
    // as the same minute wall clock but convert to another instant.
    const cases: Array<[string, string, string]> = [
      [LA, '2026-10-01T21:00:30.123456+00:00', '2026-10-01T14:00'],
      ['Pacific/Auckland', '2027-04-03T13:30:00+00:00', '2027-04-04T02:30'],
    ];
    for (const [zone, stored, local] of cases) {
      const { stub, svc } = build({
        order: { data: orderRow({ needed_by: stored }), error: null },
        org: { data: { timezone: zone }, error: null },
      });
      await svc.reviseNeededBy(input({ neededByLocal: local, expectedNeededBy: stored }));
      expect(rpcArgs(stub)?.p_needed_by, zone).toBe(stored);
    }
  });

  it('a different wall clock is converted as usual, even on an order with seconds stored', async () => {
    const { stub, svc } = build({ order: { data: orderRow({ needed_by: '2026-10-01T21:00:30+00:00' }), error: null } });
    await svc.reviseNeededBy(input({ neededByLocal: '2026-10-01T14:30', expectedNeededBy: '2026-10-01T21:00:30+00:00' }));
    expect(rpcArgs(stub)?.p_needed_by).toBe('2026-10-01T21:30:00.000Z');
  });

  it('a first date on an order that had none sends expected null', async () => {
    const { stub, svc } = build({ order: { data: orderRow({ needed_by: null, status: 'pending_approval' }), error: null } });
    await svc.reviseNeededBy(input({ expectedNeededBy: null }));
    expect(rpcArgs(stub)?.p_expected_needed_by).toBeNull();
  });

  it('the event description is core orderScheduleEventDetails, the text approval writes (copies guard)', async () => {
    const { stub, svc } = build();
    await svc.reviseNeededBy(input({ neededByLocal: '2027-01-08T09:00' }));
    expect(rpcArgs(stub)?.p_event_details).toBe(
      orderScheduleEventDetails({ id: ORDER, orderNumber: 16, neededBy: '2027-01-08T17:00:00.000Z' }, LA),
    );
  });

  it('reads the order and the org zone in parallel (no new serial round trip)', async () => {
    // The stub answers maybeSingle() at call time. Parallel code issues the
    // org read in the same synchronous run, before any await; serial code
    // (await the order, then read the zone) issues it only after a microtask,
    // so the check one microtask later tells them apart.
    let orgStartedFirst = false;
    const { stub, svc } = build({
      order: () => {
        queueMicrotask(() => {
          orgStartedFirst = stub.fromCalls.includes('organizations');
        });
        return { data: orderRow(), error: null };
      },
    });
    await svc.reviseNeededBy(input());
    expect(orgStartedFirst).toBe(true);
    expect(stub.fromCalls.filter((t) => t === 'order_requests')).toHaveLength(1);
    expect(stub.fromCalls.filter((t) => t === 'organizations')).toHaveLength(1);
  });
});

describe('the wall clock is read in the ORGANIZATION\'s zone', () => {
  const realTz = process.env.TZ;
  afterEach(() => {
    if (realTz === undefined) delete process.env.TZ;
    else process.env.TZ = realTz;
  });

  it('across the 2026-11-01 fall-back in Los Angeles: PDT the day before, PST the day after', async () => {
    const sent: unknown[] = [];
    for (const local of ['2026-10-31T14:00', '2026-11-01T14:00', '2026-11-02T14:00']) {
      const { stub, svc } = build();
      await svc.reviseNeededBy(input({ neededByLocal: local }));
      sent.push(rpcArgs(stub)?.p_needed_by);
    }
    expect(sent).toEqual(['2026-10-31T21:00:00.000Z', '2026-11-01T22:00:00.000Z', '2026-11-02T22:00:00.000Z']);
  });

  it('whatever zone the server runs in (mutation: the device or server zone)', async () => {
    for (const tz of ['UTC', 'Asia/Kolkata', 'Pacific/Auckland']) {
      process.env.TZ = tz;
      const { stub, svc } = build();
      await svc.reviseNeededBy(input({ neededByLocal: '2026-11-01T14:00' }));
      expect(rpcArgs(stub)?.p_needed_by, tz).toBe('2026-11-01T22:00:00.000Z');
    }
  });

  it('in the org\'s own zone, not the default', async () => {
    const { stub, svc } = build({ org: { data: { timezone: 'America/New_York' }, error: null } });
    const out = await svc.reviseNeededBy(input({ neededByLocal: '2026-11-01T14:00' }));
    expect(rpcArgs(stub)?.p_needed_by).toBe('2026-11-01T19:00:00.000Z');
    expect(out.timeZone).toBe('America/New_York');
  });

  it('refuses a time that never happens there (the spring-forward hour, Feb 30) and sends nothing', async () => {
    for (const local of ['2027-03-14T02:30', '2026-02-30T10:00', 'soon']) {
      const { stub, svc } = build();
      const e = await refusal(svc.reviseNeededBy(input({ neededByLocal: local })));
      expect(e).toMatchObject({ code: 'validation_error', message: neededByInvalidTimeCopy(LA) });
      expect(e.details).toEqual({ reason: 'invalid_time' });
      expect(stub.rpcCalls).toHaveLength(0);
    }
  });

  it('refuses when the org zone cannot be read, rather than guess one', async () => {
    for (const org of [
      { data: null, error: { message: 'boom' } },
      { data: null, error: null },
    ] as QueryResult[]) {
      const { stub, svc } = build({ org });
      const e = await refusal(svc.reviseNeededBy(input()));
      expect(e).toMatchObject({ code: 'conflict', message: NEEDED_BY_TIMEZONE_UNREADABLE_COPY });
      expect(e.details).toEqual({ reason: 'timezone_unreadable', retryable: true });
      expect(stub.rpcCalls).toHaveLength(0);
    }
  });

  it('the AI suggestion\'s instant is taken as it is (it was read in the org zone already)', async () => {
    const { stub, svc } = build({ order: { data: orderRow({ status: 'pending_approval', needed_by: null }), error: null } });
    await svc.reviseNeededBy({
      id: ORDER,
      neededByAt: '2027-01-15T13:00:00-05:00',
      expectedNeededBy: null,
      reason: "Set from the requester's note",
      onlyWhenPending: true,
    });
    expect(rpcArgs(stub)?.p_needed_by).toBe('2027-01-15T18:00:00.000Z');
  });
});

describe('gates, in core\'s words, before anything is sent', () => {
  it('the orders module', async () => {
    const { stub, svc } = build({ modules: [] });
    const e = await refusal(svc.reviseNeededBy(input()));
    expect(e).toMatchObject({ code: 'module_disabled', message: NEEDED_BY_MODULE_OFF_COPY });
    expect(stub.rpcCalls).toHaveLength(0);
  });

  it('orders:approve: staff without it, and a viewer', async () => {
    for (const role of ['staff', 'viewer'] as Role[]) {
      const { stub, svc } = build({ role });
      const e = await refusal(svc.reviseNeededBy(input()));
      expect(e, role).toMatchObject({ code: 'forbidden', message: NEEDED_BY_NOT_APPROVER_COPY });
      expect(stub.rpcCalls).toHaveLength(0);
    }
  });

  it('staff WITH an orders:approve grant are let through to the function (pattern #4)', async () => {
    const { stub, svc } = build({ role: 'staff', permissions: ['orders:approve', 'orders:read'] });
    await svc.reviseNeededBy(input());
    expect(stub.rpcCalls).toHaveLength(1);
  });

  it('the MFA step-up is left to assertPermission (its own words, for the step-up prompt)', async () => {
    const { stub, svc } = build({ mfaRequired: true, mfaSatisfied: false });
    const e = await refusal(svc.reviseNeededBy(input()));
    expect(e.code).toBe('forbidden');
    expect(e.message).not.toBe(NEEDED_BY_NOT_APPROVER_COPY);
    expect(stub.rpcCalls).toHaveLength(0);
  });

  it('write access to the order\'s warehouse', async () => {
    vi.mocked(assertWarehouseAccess).mockRejectedValueOnce(new ForbiddenError('no'));
    const { stub, svc } = build();
    const e = await refusal(svc.reviseNeededBy(input()));
    // Re-pinned by the small fixes slice 2 review (was NEEDED_BY_NO_WAREHOUSE_ACCESS_COPY):
    // outside the order's warehouse, the date says what every order action says.
    expect(e).toMatchObject({ code: 'forbidden', message: ORDER_WAREHOUSE_WRITE_REFUSED_COPY });
    expect(e.details).toEqual({ reason: 'forbidden' });
    expect(assertWarehouseAccess).toHaveBeenCalledWith('wh-1', 'write', expect.anything(), expect.anything());
    expect(stub.rpcCalls).toHaveLength(0);
  });

  it('a viewer granted orders:approve keeps the date\'s own sentence: they work there, read-only', async () => {
    vi.mocked(assertWarehouseAccess).mockRejectedValueOnce(
      new ForbiddenError('Read-only auditor cannot perform write operations.'),
    );
    const { stub, svc } = build({ role: 'viewer', permissions: ['orders:approve', 'orders:request'] });
    const e = await refusal(svc.reviseNeededBy(input()));
    expect(e).toMatchObject({ code: 'forbidden', message: NEEDED_BY_NO_WAREHOUSE_ACCESS_COPY });
    expect(stub.rpcCalls).toHaveLength(0);
  });

  it('the caller\'s own access could not be read: retryable, never "a warehouse you don\'t work in"', async () => {
    vi.mocked(assertWarehouseAccess).mockRejectedValueOnce(
      new ForbiddenError('User does not have write access to warehouse wh-1.', { accessUnreadable: true }),
    );
    const { stub, svc } = build({ role: 'staff', permissions: ['orders:approve', 'orders:request'] });
    const e = await refusal(svc.reviseNeededBy(input()));
    expect(e).toMatchObject({ code: 'conflict', message: ORDER_WAREHOUSE_ACCESS_UNREADABLE_COPY });
    expect(e.details).toEqual({ reason: 'failed', retryable: true });
    expect(stub.rpcCalls).toHaveLength(0);
  });

  it('an order that is not there (or another org\'s: the read is org-filtered)', async () => {
    const { stub, svc } = build({ order: { data: null, error: null } });
    const e = await refusal(svc.reviseNeededBy(input()));
    expect(e).toMatchObject({ code: 'not_found', message: NEEDED_BY_NOT_FOUND_COPY });
    const eqs = stub.chainArgs.get('order_requests.select')?.filter((_a, i) => stub.chains.get('order_requests.select')?.[i] === 'eq');
    expect(eqs).toEqual(expect.arrayContaining([['organization_id', 'org-test'], ['id', ORDER]]));
    expect(stub.rpcCalls).toHaveLength(0);
  });

  it('a reason empty or over 500 characters (after trimming)', async () => {
    for (const reason of ['', '   ', 'x'.repeat(501)]) {
      const { stub, svc } = build();
      const e = await refusal(svc.reviseNeededBy(input({ reason })));
      expect(e).toMatchObject({ code: 'validation_error', message: NEEDED_BY_REASON_REQUIRED_COPY });
      expect(stub.rpcCalls).toHaveLength(0);
    }
  });

  it('a date later than five years from now (or one no screen can hold), before anything is sent', async () => {
    for (const over of [
      { neededByLocal: '2099-01-15T10:00' },
      { neededByLocal: undefined, neededByAt: '9999-12-31T00:00:00Z' },
    ] as Array<Partial<ReviseNeededByInput>>) {
      const { stub, svc } = build();
      const e = await refusal(svc.reviseNeededBy(input(over)));
      expect(e).toMatchObject({ code: 'validation_error', message: NEEDED_BY_OUT_OF_RANGE_COPY });
      expect(e.details).toEqual({ reason: 'needed_by_out_of_range' });
      expect(stub.rpcCalls).toHaveLength(0);
    }
  });

  it('an unreadable starting value', async () => {
    const { stub, svc } = build();
    const e = await refusal(svc.reviseNeededBy(input({ expectedNeededBy: 'yesterday' })));
    expect(e).toMatchObject({ code: 'validation_error', message: NEEDED_BY_RELOAD_COPY });
    expect(stub.rpcCalls).toHaveLength(0);
  });

  it('the AI suggestion\'s Apply stays pending-only', async () => {
    const { stub, svc } = build();
    const e = await refusal(
      svc.reviseNeededBy({ id: ORDER, neededByAt: '2027-01-15T18:00:00Z', expectedNeededBy: null, reason: 'r', onlyWhenPending: true }),
    );
    expect(e).toMatchObject({ code: 'conflict', message: NEEDED_BY_NOT_PENDING_COPY });
    expect(e.details).toEqual({ reason: 'not_pending' });
    expect(stub.rpcCalls).toHaveLength(0);
  });
});

describe('every refusal of the function, in core\'s words (pattern #28: each raise in 0383)', () => {
  const cases: Array<[string, QueryResult['error'], Partial<ServiceError>, Record<string, unknown>]> = [
    ['unauthenticated', { message: 'unauthenticated', code: '42501' }, { code: 'unauthenticated', message: NEEDED_BY_SIGN_IN_COPY }, { reason: 'forbidden' }],
    ['not found', { message: 'order_request_not_found', code: 'P0002' }, { code: 'not_found', message: NEEDED_BY_NOT_FOUND_COPY }, { reason: 'not_found' }],
    ['module off', { message: 'module_disabled', code: 'P0001', hint: 'module_disabled' }, { code: 'module_disabled', message: NEEDED_BY_MODULE_OFF_COPY }, { reason: 'module_disabled' }],
    ['not an approver', { message: 'forbidden', code: '42501', hint: 'orders_approve' }, { code: 'forbidden', message: NEEDED_BY_NOT_APPROVER_COPY }, { reason: 'forbidden' }],
    ['no warehouse write', { message: 'forbidden', code: '42501', hint: 'warehouse_write' }, { code: 'forbidden', message: NEEDED_BY_NO_WAREHOUSE_ACCESS_COPY }, { reason: 'forbidden' }],
    ['closed', { message: 'order_closed', code: 'P0001', hint: 'order_closed', details: 'cancelled' }, { code: 'conflict', message: NEEDED_BY_CLOSED_COPY }, { reason: 'order_closed', status: 'cancelled' }],
    ['in the past', { message: 'needed_by_in_past', code: '22023', hint: 'needed_by_in_past' }, { code: 'validation_error', message: NEEDED_BY_IN_PAST_COPY }, { reason: 'needed_by_in_past' }],
    ['out of range', { message: 'needed_by_out_of_range', code: '22023', hint: 'needed_by_out_of_range' }, { code: 'validation_error', message: NEEDED_BY_OUT_OF_RANGE_COPY }, { reason: 'needed_by_out_of_range' }],
    ['null', { message: 'needed_by_required', code: '22023', hint: 'needed_by_required' }, { code: 'validation_error', message: neededByInvalidTimeCopy(LA) }, { reason: 'invalid_time' }],
    ['reason', { message: 'reason_required', code: '22023', hint: 'reason_required' }, { code: 'validation_error', message: NEEDED_BY_REASON_REQUIRED_COPY }, { reason: 'reason_required' }],
    [
      'stale',
      { message: 'needed_by_changed', code: 'P0001', hint: 'needed_by_changed', details: '2026-10-05T21:00:00+00:00' },
      { code: 'conflict', message: neededByChangedCopy('2026-10-05T21:00:00.000Z', LA) },
      { reason: 'needed_by_changed', current: '2026-10-05T21:00:00+00:00' },
    ],
    [
      // The function's text passes through untouched (a JS Date would drop the
      // microseconds, and the screen sends it back as the next expected value).
      'stale, microseconds kept',
      { message: 'needed_by_changed', code: 'P0001', hint: 'needed_by_changed', details: '2026-10-05T21:00:00.123456+00:00' },
      { code: 'conflict', message: neededByChangedCopy('2026-10-05T21:00:00.123Z', LA) },
      { reason: 'needed_by_changed', current: '2026-10-05T21:00:00.123456+00:00' },
    ],
    [
      'stale, an unreadable detail',
      { message: 'needed_by_changed', code: 'P0001', hint: 'needed_by_changed', details: 'soon' },
      { code: 'conflict', message: neededByChangedCopy(null, LA) },
      { reason: 'needed_by_changed', current: null },
    ],
    [
      'stale, the date cleared elsewhere',
      { message: 'needed_by_changed', code: 'P0001', hint: 'needed_by_changed', details: '' },
      { code: 'conflict', message: neededByChangedCopy(null, LA) },
      { reason: 'needed_by_changed', current: null },
    ],
    ['lock timeout', { message: 'canceling statement due to lock timeout', code: '55P03' }, { code: 'conflict', message: NEEDED_BY_BUSY_COPY }, { reason: 'busy', retryable: true }],
    ['statement timeout', { message: 'canceling statement due to statement timeout', code: '57014' }, { code: 'conflict', message: NEEDED_BY_BUSY_COPY }, { reason: 'busy', retryable: true }],
  ];

  it.each(cases)('%s', async (_label, error, want, details) => {
    const { svc } = build({ rpc: { data: null, error } });
    const e = await refusal(svc.reviseNeededBy(input()));
    expect(e).toMatchObject(want);
    expect(e.details).toEqual(details);
    expect(audit).not.toHaveBeenCalled();
    expect(broadcastOrderChanged).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });

  it('anything else is a fault: generic to the caller, reported with its cause', async () => {
    const { svc } = build({ rpc: { data: null, error: { message: 'permission denied for function revise_order_needed_by', code: '42501' } } });
    const e = await refusal(svc.reviseNeededBy(input()));
    expect(e.code).toBe('internal_error');
    expect(e.message).not.toContain('permission denied');
    expect(e.details).toEqual({ reason: 'failed' });
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(vi.mocked(reportError).mock.calls[0]![1]).toMatchObject({ tag: 'orders.needed_by_failed' });
  });

  it('an answer of the wrong shape is a fault, never guessed', async () => {
    const { svc } = build({ rpc: { data: { changed: 'yes' }, error: null } });
    const e = await refusal(svc.reviseNeededBy(input()));
    expect(e.code).toBe('internal_error');
    expect(audit).not.toHaveBeenCalled();
  });
});

describe('the Schedule entry', () => {
  it('moved with the order: no new event is written here, and the answer names its status', async () => {
    const { admin, svc } = build();
    const out = await svc.reviseNeededBy(input());
    expect(out).toMatchObject({ schedule: 'moved', eventUpdated: true, eventStatus: 'scheduled', changed: true, timeZone: LA });
    expect(admin.chains.get('schedule_events.insert')).toBeUndefined();
    expect(admin.fromCalls).toEqual([]);
  });

  it('completed or cancelled: left as it was, none created', async () => {
    const { admin, svc } = build({ rpc: { data: answer({ eventUpdated: false }), error: null } });
    const out = await svc.reviseNeededBy(input());
    expect(out.schedule).toBe('left_closed');
    expect(admin.chains.get('schedule_events.insert')).toBeUndefined();
  });

  it('a pending order has none yet, and none is created (approval makes it)', async () => {
    const { admin, svc } = build({
      order: { data: orderRow({ status: 'pending_approval' }), error: null },
      rpc: { data: answer({ eventId: null, eventUpdated: false, status: 'pending_approval' }), error: null },
    });
    const out = await svc.reviseNeededBy(input());
    expect(out.schedule).toBe('none_yet');
    expect(admin.chains.get('schedule_events.insert')).toBeUndefined();
  });

  it('past approval with none: autoScheduleFromOrder creates it at the NEW date, with core\'s text and no second zone read', async () => {
    for (const status of ['approved', 'picking_in_progress', 'staged_for_delivery', 'backordered']) {
      const { admin, svc } = build({
        order: { data: orderRow({ status, needed_by: null }), error: null },
        rpc: { data: answer({ previous: null, eventId: null, eventUpdated: false, eventStatus: null, status }), error: null },
        admin: missingEvent({ 'order_requests.select': { data: orderNow({ status }), error: null } }),
      });
      const out = await svc.reviseNeededBy(input({ expectedNeededBy: null }));
      expect(out.schedule, status).toBe('created');
      const inserted = admin.chainArgs.get('schedule_events.insert')?.[0]?.[0] as Record<string, unknown>;
      expect(inserted, status).toMatchObject({
        organization_id: 'org-test',
        order_request_id: ORDER,
        starts_at: '2026-10-03T21:00:00.000Z',
        status: 'scheduled',
        warehouse_id: 'wh-1',
        created_by: 'approver-1',
        title: 'SO-000016 pickup — Doua Vang',
        details: orderScheduleEventDetails({ id: ORDER, orderNumber: 16, neededBy: '2026-10-03T21:00:00.000Z' }, LA),
      });
      // The zone was read once, by the revision; the admin client read none.
      expect(admin.fromCalls).not.toContain('organizations');
      expect(out.eventStatus, status).toBe('scheduled');
      // In step with the order already: nothing moved or closed.
      expect(admin.chains.get('schedule_events.update'), status).toBeUndefined();
    }
  });

  it('the order closed while its entry was being added: the entry is closed too, and the screens say it stays', async () => {
    // cancel_order_request committed between the function and the insert: its
    // own close found no entry, so the new one would sit scheduled on a
    // cancelled order and the reminder cron would email about it.
    for (const [closed, eventOutcome] of [
      ['cancelled', 'cancelled'],
      ['denied', 'cancelled'],
      ['completed', 'completed'],
    ] as const) {
      // The entry as read before the close, then as read after it.
      let reads = 0;
      const { admin, svc } = build({
        order: { data: orderRow({ needed_by: null }), error: null },
        rpc: { data: answer({ previous: null, eventId: null, eventUpdated: false, eventStatus: null }), error: null },
        admin: missingEvent({
          'order_requests.select': { data: orderNow({ status: closed }), error: null },
          'schedule_events.select': () => {
            reads += 1;
            return { data: eventRow(reads > 1 ? { status: eventOutcome } : {}), error: null };
          },
          'schedule_events.update': { data: null, error: null },
        }),
      });
      const out = await svc.reviseNeededBy(input({ expectedNeededBy: null }));
      expect(out.schedule, closed).toBe('left_closed');
      expect(out.eventStatus, closed).toBe(eventOutcome);
      expect(admin.chainArgs.get('schedule_events.update')?.[0]?.[0], closed).toEqual({ status: eventOutcome });
      expect(admin.chainArgs.get('schedule_events.update'), closed).toEqual(
        expect.arrayContaining([['order_request_id', ORDER], ['status', ['scheduled', 'in_progress']]]),
      );
    }
  });

  it('closing the entry of an order closed meanwhile is confirmed, never assumed (pattern #2): a close that did not land is reported and said', async () => {
    // syncOrderScheduleEvent swallows its own errors; a close that matched no
    // row would leave the entry scheduled on a cancelled order, and the
    // reminder cron would email about it.
    let reads = 0;
    const { svc } = build({
      order: { data: orderRow({ needed_by: null }), error: null },
      rpc: { data: answer({ previous: null, eventId: null, eventUpdated: false, eventStatus: null }), error: null },
      admin: missingEvent({
        'order_requests.select': { data: orderNow({ status: 'cancelled' }), error: null },
        // The first read finds it scheduled; the read after the close still does.
        'schedule_events.select': () => {
          reads += 1;
          return { data: eventRow(), error: null };
        },
        'schedule_events.update': { data: null, error: { message: 'boom' } },
      }),
    });
    const out = await svc.reviseNeededBy(input({ expectedNeededBy: null }));
    expect(reads).toBe(2);
    expect(out.schedule).toBe('not_moved');
    expect(vi.mocked(reportError).mock.calls.map((c) => (c[1] as { tag: string }).tag)).toContain(
      'orders.needed_by_event_drift',
    );
  });

  it('an entry someone else made meanwhile at the same date counts as created', async () => {
    const same = build({
      order: { data: orderRow({ needed_by: null }), error: null },
      rpc: { data: answer({ previous: null, eventId: null, eventUpdated: false, eventStatus: null }), error: null },
      admin: missingEvent({ 'schedule_events.insert': { data: null, error: { message: 'duplicate key', code: '23505' } } }),
    });
    const out = await same.svc.reviseNeededBy(input({ expectedNeededBy: null }));
    expect(out.schedule).toBe('created');
    expect(same.admin.chains.get('schedule_events.update')).toBeUndefined();
    expect(reportError).not.toHaveBeenCalled();
  });

  it('an entry an approval made meanwhile at the OLD date is moved to the order\'s date, keeping what a person wrote', async () => {
    // approve() defers its insert with the needed-by it read; this revision
    // committed first, found no entry, and its own insert met 23505. The
    // entry is brought in step with the order row (the source of truth),
    // guarded on the start it was read at, both reminder stamps cleared.
    const old = orderScheduleEventDetails({ id: ORDER, orderNumber: 16, neededBy: '2026-10-01T21:00:00Z' }, LA);
    const { admin, svc } = build({
      order: { data: orderRow({ needed_by: null }), error: null },
      rpc: { data: answer({ previous: null, eventId: null, eventUpdated: false, eventStatus: null }), error: null },
      admin: missingEvent({
        'schedule_events.insert': { data: null, error: { message: 'duplicate key', code: '23505' } },
        'schedule_events.select': {
          data: eventRow({
            starts_at: '2026-10-01T21:00:00+00:00',
            ends_at: '2026-10-01T22:30:00+00:00',
            details: `${old}\nGate code 4411.`,
          }),
          error: null,
        },
        'schedule_events.update': { data: { id: 'ev-9' }, error: null },
      }),
    });
    const out = await svc.reviseNeededBy(input({ expectedNeededBy: null }));
    expect(out).toMatchObject({ schedule: 'moved', eventStatus: 'scheduled' });
    expect(admin.chainArgs.get('schedule_events.update')?.[0]?.[0]).toEqual({
      starts_at: '2026-10-03T21:00:00+00:00',
      ends_at: '2026-10-03T22:30:00.000Z',
      details: `${orderScheduleEventDetails({ id: ORDER, orderNumber: 16, neededBy: NEW }, LA)}\nGate code 4411.`,
      reminded_24h_at: null,
      reminded_1h_at: null,
      updated_by: 'approver-1',
    });
    expect(admin.chainArgs.get('schedule_events.update')).toEqual(
      expect.arrayContaining([
        ['id', 'ev-9'],
        ['starts_at', '2026-10-01T21:00:00+00:00'],
        ['status', ['scheduled', 'in_progress']],
      ]),
    );
    expect(reportError).not.toHaveBeenCalled();
  });

  it('an entry at another date that cannot be moved (someone moved it again) is reported and said', async () => {
    const { svc } = build({
      order: { data: orderRow({ needed_by: null }), error: null },
      rpc: { data: answer({ previous: null, eventId: null, eventUpdated: false, eventStatus: null }), error: null },
      admin: missingEvent({
        'schedule_events.insert': { data: null, error: { message: 'duplicate key', code: '23505' } },
        'schedule_events.select': { data: eventRow({ starts_at: '2026-10-01T21:00:00+00:00' }), error: null },
        'schedule_events.update': { data: null, error: null },
      }),
    });
    const out = await svc.reviseNeededBy(input({ expectedNeededBy: null }));
    expect(out.schedule).toBe('not_moved');
    expect(vi.mocked(reportError).mock.calls.map((c) => (c[1] as { tag: string }).tag)).toEqual([
      'orders.needed_by_event_drift',
    ]);
  });

  it('an insert that fails: the order moved, the screens say the entry was not added, and it is reported', async () => {
    const { svc } = build({
      order: { data: orderRow({ needed_by: null }), error: null },
      rpc: { data: answer({ previous: null, eventId: null, eventUpdated: false, eventStatus: null }), error: null },
      admin: { 'schedule_events.insert': { data: null, error: { message: 'boom', code: 'XX000' } } },
    });
    const out = await svc.reviseNeededBy(input({ expectedNeededBy: null }));
    expect(out.schedule).toBe('not_added');
    expect(out.changed).toBe(true);
    expect(reportError).toHaveBeenCalled();
  });

  it('saving the same date again adds a missing entry (the words after a failed insert say so)', async () => {
    const { admin, svc } = build({
      rpc: {
        data: answer({ changed: false, previous: NEW, neededBy: NEW, eventId: null, eventUpdated: false, eventStatus: null }),
        error: null,
      },
      admin: missingEvent(),
    });
    const out = await svc.reviseNeededBy(input({ expectedNeededBy: NEW }));
    expect(out).toMatchObject({ changed: false, schedule: 'created', eventStatus: 'scheduled' });
    expect(admin.chainArgs.get('schedule_events.insert')?.[0]?.[0]).toMatchObject({ starts_at: NEW, order_request_id: ORDER });
    // Nothing changed on the order: no audit, no broadcast.
    expect(audit).not.toHaveBeenCalled();
    expect(broadcastOrderChanged).not.toHaveBeenCalled();
  });

  it('an unchanged save leaves an existing entry and a pending order alone', async () => {
    for (const over of [
      { eventId: 'ev-1', eventStatus: 'scheduled' },
      { eventId: null, eventStatus: null, status: 'pending_approval' },
    ]) {
      const { admin, svc } = build({
        rpc: { data: answer({ changed: false, previous: NEW, neededBy: NEW, eventUpdated: false, ...over }), error: null },
      });
      const out = await svc.reviseNeededBy(input({ expectedNeededBy: NEW }));
      expect(out.schedule).toBe('unchanged');
      expect(admin.fromCalls).toEqual([]);
    }
  });
});

describe('the audit entry and the broadcast', () => {
  it('order_request.needed_by_revised {from, to, reason}, once, and the order page is told', async () => {
    const { svc } = build();
    await svc.reviseNeededBy(input());
    expect(audit).toHaveBeenCalledTimes(1);
    expect(vi.mocked(audit).mock.calls[0]![0]).toEqual({
      event: 'order_request.needed_by_revised',
      entityType: 'order_request',
      entityId: ORDER,
      warehouseId: 'wh-1',
      before: { needed_by: '2026-10-01T21:00:00.000Z' },
      after: { needed_by: '2026-10-03T21:00:00.000Z' },
      reason: 'The school moved the day',
      extra: {
        from: '2026-10-01T21:00:00.000Z',
        to: '2026-10-03T21:00:00.000Z',
        schedule: 'moved',
        event_id: 'ev-1',
      },
    });
    expect(broadcastOrderChanged).toHaveBeenCalledWith('org-test', ORDER);
  });

  it('an equal value changed nothing: no audit, no broadcast', async () => {
    const { svc } = build({ rpc: { data: answer({ changed: false, eventUpdated: false, previous: OLD, neededBy: OLD }), error: null } });
    const out = await svc.reviseNeededBy(input({ neededByLocal: '2026-10-01T14:00' }));
    expect(out.schedule).toBe('unchanged');
    expect(audit).not.toHaveBeenCalled();
    expect(broadcastOrderChanged).not.toHaveBeenCalled();
  });

  it('nothing is emailed or notified by a revision (Outlook rule 1)', async () => {
    const { sendOrderRequestEmail } = await import('@/lib/email/order-requests');
    const { createNotification } = await import('./notifications');
    const { admin, stub, svc } = build();
    await svc.reviseNeededBy(input());
    expect(sendOrderRequestEmail).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
    expect([...stub.fromCalls, ...admin.fromCalls]).not.toContain('notifications');
  });
});

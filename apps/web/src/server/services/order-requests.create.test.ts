import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import {
  NEEDED_BY_IN_PAST_COPY,
  NEEDED_BY_OUT_OF_RANGE_COPY,
  ORDER_BUSY_COPY,
  ORDER_CONFLICT_COPY,
  ORDER_MODULE_DISABLED_COPY,
  ORDER_NEEDED_BY_INVALID_TIME_COPY,
  ORDER_ON_BEHALF_NOT_PERMITTED_COPY,
  ORDER_ORGANIZATION_CHANGED_COPY,
  ORDER_ORGANIZATION_CHANGED_UNCONFIRMED_COPY,
  ORDER_PERMISSION_COPY,
  ORDER_PLACER_MISMATCH_COPY,
  ORDER_PLACER_MISMATCH_UNCONFIRMED_COPY,
  ORDER_REFUSED_FINAL_COPY,
  ORDER_SIGN_IN_COPY,
  ORDER_SITE_INACTIVE_COPY,
  ORDER_TIMEZONE_UNREADABLE_COPY,
  ORDER_WAREHOUSE_NOT_AVAILABLE_COPY,
  ORDER_WITHDRAWN_COPY,
  orderCreateRefusalCopy,
  orderItemsNotOrderableCopy,
  orderSiteNotServicedCopy,
  type ModuleId,
  type OrderCreateRequestInput,
} from '@stockpilot/core';

import { makeServiceContext, makeSupabaseStub, type QueryResult } from '@/test/supabase-mock';

/**
 * OrderRequestsService.create: the one create path (phone ordering PO-2,
 * migration 0391). The web action and POST /api/v1/orders both call it; it
 * calls place_order_request, which calls the frozen create_order_request.
 *
 * Pinned here:
 *   - the gate order: the Orders module, the MFA step-up, orders:request,
 *     then core's schema, then the needed-by wall clock in the organization's
 *     zone (a failed zone read is refused BEFORE the call), then ONE rpc;
 *   - p_request exactly as the database reads it: the body's placer passed
 *     through unchanged (never the session's), the surface, the lines as
 *     sent (the database sums them), the key as p_key;
 *   - every raise and every recorded reason mapped to its code, words and
 *     details (`settled` on a recorded refusal), specific before general;
 *   - a NEW order runs the tail (audit with the surface and the kits, the
 *     "received" email, order.created) and a replay runs none of it.
 */

vi.mock('@/lib/auth/warehouse', () => ({ assertWarehouseAccess: vi.fn() }));
const { audit, dispatchEvent } = vi.hoisted(() => ({
  audit: vi.fn(async () => {}),
  dispatchEvent: vi.fn(async () => {}),
}));
vi.mock('./audit', () => ({ audit }));
vi.mock('./integration-events', () => ({ dispatchEvent }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));

import { OrderRequestsService } from './order-requests';

const ORG = 'org-test';
const USER = 'dddddddd-0000-4000-8000-000000000001';
const WH = 'aaaaaaaa-0000-4000-8000-000000000001';
const ITEM_A = 'bbbbbbbb-0000-4000-8000-00000000000a';
const ITEM_B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const SITE = 'cccccccc-0000-4000-8000-000000000001';
const KEY = 'eeeeeeee-0000-4000-8000-000000000001';
const ORDER = 'ffffffff-0000-4000-8000-000000000001';

function body(overrides: Partial<OrderCreateRequestInput> = {}): OrderCreateRequestInput {
  return {
    idempotencyKey: KEY,
    placerUserId: USER,
    warehouseId: WH,
    fulfillmentType: 'pickup',
    deliveryCharterId: null,
    onBehalfOf: null,
    notes: null,
    neededByLocal: null,
    lines: [
      { itemId: ITEM_A, quantity: 2 },
      { itemId: ITEM_B, quantity: 1 },
    ],
    ...overrides,
  };
}

const SUMMARY = {
  id: ORDER,
  order_number: 42,
  status: 'pending_approval',
  warehouse_id: WH,
  fulfillment_type: 'pickup',
  delivery_charter_id: null,
  needed_by: null,
  created_at: '2026-10-04T10:00:00+00:00',
  requester_user_id: USER,
  requester_name: null,
  requester_email: null,
  line_count: 2,
  unit_count: 3,
};

function placed(replay = false): QueryResult {
  return { data: { outcome: 'placed', replay, order: SUMMARY }, error: null };
}

function svc(
  stub: ReturnType<typeof makeSupabaseStub>,
  overrides: Parameters<typeof makeServiceContext>[1] = {},
) {
  return new (OrderRequestsService as unknown as new (ctx: unknown) => OrderRequestsService)(
    makeServiceContext(stub.client, {
      role: 'staff',
      userId: USER,
      enabledModules: new Set<ModuleId>(['orders']),
      ...overrides,
    }),
  );
}

function stubWith(rpc: QueryResult, extra: Record<string, QueryResult> = {}) {
  return makeSupabaseStub({
    'organizations.select': { data: { timezone: 'America/Los_Angeles' }, error: null },
    'order_requests.select': { data: { ...SUMMARY, organization_id: ORG }, error: null },
    'rpc:place_order_request': rpc,
    ...extra,
  });
}

function rpcArgs(stub: ReturnType<typeof makeSupabaseStub>) {
  const call = stub.rpcCalls.find((c) => c.name === 'place_order_request');
  return call?.args as { p_request: Record<string, unknown>; p_key: string } | undefined;
}

type WithNotify = { notifyEmail: (...args: unknown[]) => Promise<void> };
let notifyEmail: MockInstance<WithNotify['notifyEmail']>;
beforeEach(() => {
  vi.clearAllMocks();
  notifyEmail = vi
    .spyOn(OrderRequestsService.prototype as unknown as WithNotify, 'notifyEmail')
    .mockResolvedValue(undefined);
});

/** The deferred tail runs as plain fire-and-forget outside a request. */
async function flushTail() {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
}

async function refusal(p: Promise<unknown>) {
  const e = (await p.catch((err: unknown) => err)) as {
    code?: string;
    message?: string;
    details?: Record<string, unknown>;
    internalDetail?: string;
  };
  return e;
}

function expectNoTail() {
  expect(audit).not.toHaveBeenCalled();
  expect(dispatchEvent).not.toHaveBeenCalled();
  expect(notifyEmail).not.toHaveBeenCalled();
}

describe('create: the gates come first, in order, before anything is read or sent', () => {
  it('the Orders module off: module_disabled in core words, nothing called', async () => {
    const stub = stubWith(placed());
    const e = await refusal(
      svc(stub, { enabledModules: new Set<ModuleId>([]) }).create({ body: body(), surface: 'web' }),
    );
    expect([e.code, e.message, e.details]).toEqual([
      'module_disabled',
      ORDER_MODULE_DISABLED_COPY,
      { reason: 'module_disabled' },
    ]);
    expect(stub.rpcCalls).toEqual([]);
    expect(stub.fromCalls).toEqual([]);
  });

  it('the MFA step-up comes before the permission (its own reason for the prompt)', async () => {
    const stub = stubWith(placed());
    const e = await refusal(
      svc(stub, { mfaRequired: true, mfaSatisfied: false, permissions: new Set() }).create({
        body: body(),
        surface: 'web',
      }),
    );
    expect(e.code).toBe('forbidden');
    expect(e.details?.reason).toBe('mfa_required');
    expect(stub.rpcCalls).toEqual([]);
  });

  it('orders:request revoked: permission in core words, nothing called', async () => {
    const stub = stubWith(placed());
    const e = await refusal(
      svc(stub, { permissions: new Set(['inventory:read']) }).create({
        body: body(),
        surface: 'web',
      }),
    );
    expect([e.code, e.message, e.details]).toEqual([
      'forbidden',
      ORDER_PERMISSION_COPY,
      { reason: 'permission' },
    ]);
    expect(stub.rpcCalls).toEqual([]);
  });

  it('a body core refuses is a validation_error with its reason and words, nothing called', async () => {
    const stub = stubWith(placed());
    const e = await refusal(
      svc(stub).create({
        body: body({ lines: [{ itemId: ITEM_A, quantity: 1.5 }] }),
        surface: 'web',
      }),
    );
    expect([e.code, e.details]).toEqual(['validation_error', { reason: 'quantity_not_whole' }]);
    expect(e.message).toBe(orderCreateRefusalCopy('quantity_not_whole'));
    expect(stub.rpcCalls).toEqual([]);
  });

  it('a body with an unknown key is refused (.strict()), nothing called', async () => {
    const stub = stubWith(placed());
    const e = await refusal(svc(stub).create({ body: { ...body(), price: 3 }, surface: 'app' }));
    expect(e.code).toBe('validation_error');
    expect(e.details).toEqual({ reason: 'invalid', field: 'price' });
    expect(stub.rpcCalls).toEqual([]);
  });
});

describe('create: the needed-by is the organization wall clock', () => {
  it('converts it in the organization zone (10:00 Los Angeles is 17:00 UTC in October)', async () => {
    const stub = stubWith(placed());
    await svc(stub).create({ body: body({ neededByLocal: '2026-10-05T10:00' }), surface: 'web' });
    expect(rpcArgs(stub)?.p_request.needed_by).toBe('2026-10-05T17:00:00.000Z');
  });

  it('reads no zone when there is no needed-by', async () => {
    const stub = stubWith(placed());
    await svc(stub).create({ body: body(), surface: 'web' });
    expect(stub.fromCalls).not.toContain('organizations');
    expect(rpcArgs(stub)?.p_request.needed_by).toBeNull();
  });

  it('a zone that cannot be read is refused BEFORE the call (timezone_unreadable, retryable)', async () => {
    const stub = stubWith(placed(), {
      'organizations.select': { data: null, error: { message: 'fetch failed' } },
    });
    const e = await refusal(
      svc(stub).create({ body: body({ neededByLocal: '2026-10-05T10:00' }), surface: 'web' }),
    );
    expect([e.code, e.message, e.details]).toEqual([
      'conflict',
      ORDER_TIMEZONE_UNREADABLE_COPY,
      { reason: 'timezone_unreadable', retryable: true },
    ]);
    expect(stub.rpcCalls).toEqual([]);
  });

  it('a wall clock that does not exist there (the spring-forward hour) is needed_by_invalid_time', async () => {
    const stub = stubWith(placed());
    const e = await refusal(
      svc(stub).create({ body: body({ neededByLocal: '2027-03-14T02:30' }), surface: 'web' }),
    );
    expect([e.code, e.message, e.details]).toEqual([
      'validation_error',
      ORDER_NEEDED_BY_INVALID_TIME_COPY,
      { reason: 'needed_by_invalid_time' },
    ]);
    expect(stub.rpcCalls).toEqual([]);
  });

  it('the legacy branch passes its instant through unconverted', async () => {
    const stub = stubWith(placed());
    await svc(stub).create({
      body: body(),
      surface: 'web',
      legacyNeededBy: '2026-10-05T17:00:00Z',
    });
    expect(rpcArgs(stub)?.p_request.needed_by).toBe('2026-10-05T17:00:00.000Z');
    expect(stub.fromCalls).not.toContain('organizations');
  });
});

describe('create: one call, the request as the database reads it', () => {
  it('sends p_request with the placer as sent (never the session), the surface and the lines as sent', async () => {
    const stub = stubWith(placed());
    const other = 'dddddddd-0000-4000-8000-0000000000ff';
    await svc(stub).create({
      body: body({
        placerUserId: other,
        fulfillmentType: 'delivery',
        deliveryCharterId: SITE,
        onBehalfOf: { name: ' Doua Vang ', email: ' doua@example.org ' },
        notes: '  For room 12 ',
        lines: [
          { itemId: ITEM_A, quantity: 5 },
          { itemId: ITEM_A, quantity: 5 },
        ],
        kits: [{ bundleId: SITE, count: 2 }],
      }),
      surface: 'app',
    });
    expect(stub.rpcCalls.map((c) => c.name)).toEqual(['place_order_request']);
    expect(rpcArgs(stub)).toEqual({
      p_request: {
        organization_id: ORG,
        placer_user_id: other,
        surface: 'app',
        warehouse_id: WH,
        fulfillment_type: 'delivery',
        delivery_charter_id: SITE,
        on_behalf_name: 'Doua Vang',
        on_behalf_email: 'doua@example.org',
        notes: 'For room 12',
        needed_by: null,
        lines: [
          { item_id: ITEM_A, quantity: 5 },
          { item_id: ITEM_A, quantity: 5 },
        ],
      },
      p_key: KEY,
    });
    // Never a direct write, and never the frozen function from here.
    expect(stub.rpcCalls.map((c) => c.name)).not.toContain('create_order_request');
    for (const key of [
      'order_requests.insert',
      'order_request_lines.insert',
      'order_submissions.insert',
    ]) {
      expect(stub.chainsAll.get(key), key).toBeUndefined();
    }
  });

  it('a new order answers the summary and runs the tail: audit (surface, kits), email, order.created', async () => {
    const stub = stubWith(placed(false));
    const answer = await svc(stub).create({
      body: body({ kits: [{ bundleId: SITE, count: 2 }] }),
      surface: 'web',
    });
    expect(answer).toEqual({
      organizationId: ORG,
      replay: false,
      order: {
        id: ORDER,
        orderNumber: 42,
        orderLabel: 'SO-000042',
        status: 'pending_approval',
        warehouseId: WH,
        fulfillmentType: 'pickup',
        deliveryCharterId: null,
        neededBy: null,
        lineCount: 2,
        unitCount: 3,
        createdAt: '2026-10-04T10:00:00+00:00',
        requestedFor: { self: true },
      },
    });
    expect(audit).toHaveBeenCalledWith(
      {
        event: 'order_request.created',
        entityType: 'order_request',
        entityId: ORDER,
        after: {
          lineCount: 2,
          warehouseId: WH,
          surface: 'web',
          kits: [{ bundleId: SITE, count: 2 }],
        },
      },
      expect.anything(),
    );
    await flushTail();
    expect(notifyEmail).toHaveBeenCalledTimes(1);
    expect(notifyEmail.mock.calls[0]?.[1]).toBe('submitted');
    expect(dispatchEvent).toHaveBeenCalledWith(ORG, 'order.created', {
      id: ORDER,
      orderNumber: 'SO-000042',
      requester: null,
      lineCount: 2,
    });
  });

  it('an on-behalf order names the person it is for in the summary and the event', async () => {
    const stub = stubWith({
      data: {
        outcome: 'placed',
        replay: false,
        order: {
          ...SUMMARY,
          requester_user_id: null,
          requester_name: 'Doua Vang',
          requester_email: 'doua@example.org',
        },
      },
      error: null,
    });
    const answer = await svc(stub).create({
      body: body({ onBehalfOf: { name: 'Doua Vang', email: 'doua@example.org' } }),
      surface: 'web',
    });
    expect(answer.order.requestedFor).toEqual({
      self: false,
      name: 'Doua Vang',
      email: 'doua@example.org',
    });
    await flushTail();
    expect(dispatchEvent).toHaveBeenCalledWith(
      ORG,
      'order.created',
      expect.objectContaining({ requester: 'Doua Vang' }),
    );
  });

  it('a REPLAY answers the same order and runs none of the tail', async () => {
    const stub = stubWith(placed(true));
    const answer = await svc(stub).create({ body: body(), surface: 'web' });
    expect(answer.replay).toBe(true);
    expect(answer.order.id).toBe(ORDER);
    await flushTail();
    expectNoTail();
  });
});

describe('create: every raise mapped by its hint, then its code, specific before general', () => {
  const cases: Array<
    [string, NonNullable<QueryResult['error']>, string, string, Record<string, unknown>]
  > = [
    [
      'placer_mismatch',
      { message: 'placer_mismatch', code: '42501', hint: 'placer_mismatch' },
      'forbidden',
      ORDER_PLACER_MISMATCH_COPY,
      { reason: 'placer_mismatch' },
    ],
    [
      'not_member',
      { message: 'not_member', code: '42501', hint: 'not_member' },
      'forbidden',
      ORDER_SIGN_IN_COPY,
      { reason: 'not_member' },
    ],
    [
      'unauthenticated',
      { message: 'unauthenticated', code: '42501', hint: 'unauthenticated' },
      'forbidden',
      ORDER_SIGN_IN_COPY,
      { reason: 'unauthenticated' },
    ],
    [
      'order_invalid notes',
      { message: 'order_invalid', code: '22023', hint: 'order_invalid', details: 'notes' },
      'validation_error',
      orderCreateRefusalCopy('notes_too_long'),
      { reason: 'notes_too_long' },
    ],
    [
      'order_invalid on_behalf',
      { message: 'order_invalid', code: '22023', hint: 'order_invalid', details: 'on_behalf' },
      'validation_error',
      orderCreateRefusalCopy('on_behalf_invalid'),
      { reason: 'on_behalf_invalid' },
    ],
    [
      'order_invalid surface',
      { message: 'order_invalid', code: '22023', hint: 'order_invalid', details: 'surface' },
      'validation_error',
      orderCreateRefusalCopy('invalid', 'body'),
      { reason: 'invalid', field: 'body' },
    ],
    [
      'delivery_needs_site',
      { message: 'delivery_needs_site', code: '22023', hint: 'delivery_needs_site' },
      'validation_error',
      orderCreateRefusalCopy('delivery_needs_site'),
      { reason: 'delivery_needs_site' },
    ],
    [
      'idempotency_key_invalid',
      { message: 'idempotency_key_invalid', code: '22023', hint: 'idempotency_key_invalid' },
      'validation_error',
      orderCreateRefusalCopy('invalid', 'idempotencyKey'),
      { reason: 'invalid', field: 'idempotencyKey' },
    ],
    [
      'idempotency_conflict (placed)',
      {
        message: 'idempotency_conflict',
        code: 'P0001',
        hint: 'idempotency_conflict',
        details: '{"orderId": "o-9", "orderNumber": 9}',
      },
      'conflict',
      ORDER_CONFLICT_COPY,
      { reason: 'idempotency_conflict', orderId: 'o-9', orderNumber: 9 },
    ],
    [
      'idempotency_conflict (refused)',
      { message: 'idempotency_conflict', code: 'P0001', hint: 'idempotency_conflict' },
      'conflict',
      ORDER_CONFLICT_COPY,
      { reason: 'idempotency_conflict' },
    ],
    [
      '55P03 lock timeout',
      { message: 'canceling statement due to lock timeout', code: '55P03' },
      'conflict',
      ORDER_BUSY_COPY,
      { reason: 'busy', retryable: true },
    ],
    [
      '57014 statement timeout',
      { message: 'canceling statement due to statement timeout', code: '57014' },
      'conflict',
      ORDER_BUSY_COPY,
      { reason: 'busy', retryable: true },
    ],
  ];
  it.each(cases)('%s', async (_label, error, code, message, details) => {
    const stub = stubWith({ data: null, error });
    const e = await refusal(svc(stub).create({ body: body(), surface: 'web' }));
    expect([e.code, e.message, e.details]).toEqual([code, message, details]);
    await flushTail();
    expectNoTail();
  });

  const faults: Array<[string, NonNullable<QueryResult['error']>]> = [
    [
      'an RLS refusal with no hint (the floors and the policy disagree)',
      {
        message: 'new row violates row-level security policy for table "order_requests"',
        code: '42501',
      },
    ],
    [
      'a 42501 hint it does not know',
      { message: 'forbidden', code: '42501', hint: 'something_else' },
    ],
    [
      'a deadlock (never raised by the function, still not retried here)',
      { message: 'deadlock detected', code: '40P01' },
    ],
    [
      'the internal hint',
      {
        message: 'place_order_request_internal',
        code: 'P0001',
        hint: 'place_order_request_internal',
      },
    ],
    ['a network failure', { message: 'fetch failed' }],
  ];
  it.each(faults)(
    '%s is internal_error (generic words, raw text kept for the report)',
    async (_label, error) => {
      const stub = stubWith({ data: null, error });
      const e = await refusal(svc(stub).create({ body: body(), surface: 'web' }));
      expect(e.code).toBe('internal_error');
      expect(e.details).toEqual({ reason: 'failed' });
      expect(e.internalDetail).toContain(error.message);
      await flushTail();
      expectNoTail();
    },
  );
});

describe('create: every recorded refusal is final (details.settled), in core words', () => {
  const recorded: Array<[string, unknown, string, string, Record<string, unknown>]> = [
    ['module_disabled', null, 'module_disabled', ORDER_MODULE_DISABLED_COPY, {}],
    ['permission', null, 'forbidden', ORDER_PERMISSION_COPY, {}],
    ['on_behalf_not_permitted', null, 'forbidden', ORDER_ON_BEHALF_NOT_PERMITTED_COPY, {}],
    ['warehouse_not_available', null, 'not_found', ORDER_WAREHOUSE_NOT_AVAILABLE_COPY, {}],
    ['needed_by_past', null, 'validation_error', NEEDED_BY_IN_PAST_COPY, {}],
    ['needed_by_out_of_range', null, 'validation_error', NEEDED_BY_OUT_OF_RANGE_COPY, {}],
    [
      'site_not_available',
      'inactive',
      'validation_error',
      ORDER_SITE_INACTIVE_COPY,
      { site: 'inactive' },
    ],
    [
      'site_not_available',
      'not_serviced',
      'validation_error',
      orderSiteNotServicedCopy(null),
      { site: 'not_serviced' },
    ],
    [
      'item_not_orderable',
      { [ITEM_A]: 'rental', [ITEM_B]: 'kit_stock' },
      'validation_error',
      orderItemsNotOrderableCopy([]),
      { items: { [ITEM_A]: 'rental', [ITEM_B]: 'kit_stock' } },
    ],
    [
      'invalid',
      null,
      'validation_error',
      orderCreateRefusalCopy('invalid', 'quantity'),
      { field: 'quantity' },
    ],
    ['something_new', null, 'validation_error', ORDER_REFUSED_FINAL_COPY, {}],
  ];
  it.each(recorded)('%s (%j)', async (reason, detail, code, message, extra) => {
    for (const replay of [false, true]) {
      const stub = stubWith({
        data: { outcome: 'refused', replay, refusal: { reason, detail } },
        error: null,
      });
      const e = await refusal(svc(stub).create({ body: body(), surface: 'web' }));
      expect([e.code, e.message, e.details]).toEqual([
        code,
        message,
        { reason, settled: true, replay, ...extra },
      ]);
    }
    await flushTail();
    expectNoTail();
  });

  it('a withdrawn key answers submission_withdrawn, settled, and places nothing', async () => {
    const stub = stubWith({ data: { outcome: 'withdrawn' }, error: null });
    const e = await refusal(svc(stub).create({ body: body(), surface: 'web' }));
    expect([e.code, e.message, e.details]).toEqual([
      'conflict',
      ORDER_WITHDRAWN_COPY,
      { reason: 'submission_withdrawn', settled: true },
    ]);
    await flushTail();
    expectNoTail();
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['an unknown outcome', { outcome: 'maybe' }],
    ['placed without replay', { outcome: 'placed', order: SUMMARY }],
    ['placed with an unreadable order', { outcome: 'placed', replay: false, order: { id: ORDER } }],
  ])('%s from the function is internal_error and announces nothing', async (_label, data) => {
    const stub = stubWith({ data, error: null });
    const e = await refusal(svc(stub).create({ body: body(), surface: 'web' }));
    expect(e.code).toBe('internal_error');
    await flushTail();
    expectNoTail();
  });
});

describe('submissionStatus and withdrawSubmission: membership only', () => {
  const answers: Array<[string, unknown, unknown]> = [
    ['none', { outcome: 'none' }, { organizationId: ORG, outcome: 'none' }],
    ['withdrawn', { outcome: 'withdrawn' }, { organizationId: ORG, outcome: 'withdrawn' }],
    [
      'refused',
      {
        outcome: 'refused',
        refusal: { reason: 'item_not_orderable', detail: { [ITEM_A]: 'rental' } },
      },
      {
        organizationId: ORG,
        outcome: 'refused',
        refusal: { reason: 'item_not_orderable', detail: { [ITEM_A]: 'rental' } },
      },
    ],
  ];
  it.each(answers)('the status read answers %s', async (_label, data, expected) => {
    const stub = makeSupabaseStub({ 'rpc:order_submission_status': { data, error: null } });
    // Module off and orders:request revoked: settling your own key never
    // depends on them.
    const answer = await svc(stub, {
      enabledModules: new Set<ModuleId>([]),
      permissions: new Set(),
    }).submissionStatus(KEY);
    expect(answer).toEqual(expected);
    expect(stub.rpcCalls).toEqual([
      { name: 'order_submission_status', args: { p_org: ORG, p_key: KEY } },
    ]);
  });

  it('the status read answers placed with the summary', async () => {
    const stub = makeSupabaseStub({
      'rpc:order_submission_status': { data: { outcome: 'placed', order: SUMMARY }, error: null },
    });
    const answer = await svc(stub).submissionStatus(KEY);
    expect(answer).toMatchObject({
      organizationId: ORG,
      outcome: 'placed',
      order: { id: ORDER, orderLabel: 'SO-000042' },
    });
  });

  it('withdraw passes its surface and maps the answer; it too needs no module or permission', async () => {
    const stub = makeSupabaseStub({
      'rpc:withdraw_order_submission': { data: { outcome: 'withdrawn' }, error: null },
    });
    const answer = await svc(stub, {
      enabledModules: new Set<ModuleId>([]),
      permissions: new Set(),
    }).withdrawSubmission(KEY, 'web');
    expect(answer).toEqual({ organizationId: ORG, outcome: 'withdrawn' });
    expect(stub.rpcCalls).toEqual([
      { name: 'withdraw_order_submission', args: { p_org: ORG, p_key: KEY, p_surface: 'web' } },
    ]);
  });

  it('withdraw maps busy (the placement under the key still running)', async () => {
    const stub = makeSupabaseStub({
      'rpc:withdraw_order_submission': {
        data: null,
        error: { message: 'lock timeout', code: '55P03' },
      },
    });
    const e = await refusal(svc(stub).withdrawSubmission(KEY, 'app'));
    expect([e.code, e.details]).toEqual(['conflict', { reason: 'busy', retryable: true }]);
  });

  it('a non-member is refused in sign-in words; an unknown outcome is a fault', async () => {
    const stub = makeSupabaseStub({
      'rpc:order_submission_status': {
        data: null,
        error: { message: 'not_member', code: '42501', hint: 'not_member' },
      },
    });
    const e = await refusal(svc(stub).submissionStatus(KEY));
    expect([e.code, e.message]).toEqual(['forbidden', ORDER_SIGN_IN_COPY]);
    const stub2 = makeSupabaseStub({
      'rpc:order_submission_status': { data: { outcome: 'odd' }, error: null },
    });
    expect((await refusal(svc(stub2).submissionStatus(KEY))).code).toBe('internal_error');
  });
});

describe('the organization and the account a call was sent from (review round 1)', () => {
  const OTHER_ORG = 'org-other';
  const OTHER_USER = 'dddddddd-0000-4000-8000-000000000009';

  it('create: a page sent from another organization is refused organization_changed before ANY gate, read or call', async () => {
    const stub = stubWith(placed());
    // Even with the module off here: every gate is this organization's, so
    // none of them speaks for the page's.
    const e = await refusal(
      svc(stub, { enabledModules: new Set<ModuleId>([]) }).create({
        body: body(),
        surface: 'web',
        expectedOrganizationId: OTHER_ORG,
      }),
    );
    expect([e.code, e.message, e.details]).toEqual([
      'conflict',
      ORDER_ORGANIZATION_CHANGED_COPY,
      { reason: 'organization_changed' },
    ]);
    expect(e.details?.settled).toBeUndefined();
    expect(stub.rpcCalls).toEqual([]);
    expect(stub.fromCalls).toEqual([]);
    await flushTail();
    expectNoTail();
  });

  it('create: the same organization (any case) places as before', async () => {
    const stub = stubWith(placed());
    const answer = await svc(stub).create({
      body: body(),
      surface: 'web',
      expectedOrganizationId: ORG.toUpperCase(),
    });
    expect(answer.replay).toBe(false);
    expect(rpcArgs(stub)?.p_key).toBe(KEY);
  });

  it.each([
    ['submissionStatus', (s: OrderRequestsService, scope: Record<string, string>) => s.submissionStatus(KEY, scope)],
    ['withdrawSubmission', (s: OrderRequestsService, scope: Record<string, string>) => s.withdrawSubmission(KEY, 'web', scope)],
  ] as const)('%s: another organization is organization_changed, another account placer_mismatch, never settled, nothing called', async (_label, call) => {
    const stub = makeSupabaseStub({
      'rpc:order_submission_status': { data: { outcome: 'withdrawn' }, error: null },
      'rpc:withdraw_order_submission': { data: { outcome: 'withdrawn' }, error: null },
    });
    const s = svc(stub);
    const org = await refusal(call(s, { organizationId: OTHER_ORG, placerUserId: USER }));
    expect([org.code, org.message, org.details]).toEqual([
      'conflict',
      ORDER_ORGANIZATION_CHANGED_UNCONFIRMED_COPY,
      { reason: 'organization_changed' },
    ]);
    const placer = await refusal(call(s, { organizationId: ORG, placerUserId: OTHER_USER }));
    expect([placer.code, placer.message, placer.details]).toEqual([
      'forbidden',
      ORDER_PLACER_MISMATCH_UNCONFIRMED_COPY,
      { reason: 'placer_mismatch' },
    ]);
    // The organization is checked first: both wrong answers organization_changed.
    const both = await refusal(call(s, { organizationId: OTHER_ORG, placerUserId: OTHER_USER }));
    expect(both.details).toEqual({ reason: 'organization_changed' });
    expect(stub.rpcCalls).toEqual([]);
    // Both right (any case): the function is called as before.
    await call(s, { organizationId: ORG.toUpperCase(), placerUserId: USER.toUpperCase() });
    expect(stub.rpcCalls).toHaveLength(1);
  });

  it('the service names the organization it answers for (the transports stamp it on refusals)', () => {
    expect(svc(makeSupabaseStub({})).organizationId).toBe(ORG);
  });
});

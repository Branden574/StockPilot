import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ORDER_BODY_UNREADABLE_COPY,
  ORDER_FAULT_COPY,
  ORDER_ORGANIZATION_CHANGED_COPY,
  ORDER_ORGANIZATION_CHANGED_UNCONFIRMED_COPY,
  ORDER_PLACER_MISMATCH_UNCONFIRMED_COPY,
  type ModuleId,
} from '@stockpilot/core';

import { reportError } from '@/lib/error-reporter';
import { withContext } from '@/server/services/context';
import { makeServiceContext, makeSupabaseStub, type QueryResult } from '@/test/supabase-mock';

/**
 * createOrderRequestAction and the two settle actions (phone ordering PO-2):
 * a thin wrapper over OrderRequestsService. Pinned here:
 *   - the new body goes to the service as sent, `surface: 'web'`, and the
 *     answer is the route's own `{ organizationId, result: { replay, order } }`;
 *   - revalidatePath('/dashboard/orders') stays, and the storefront catalog
 *     tag is NOT revalidated (placing reserves nothing: graft 5);
 *   - a refusal keeps the service's code, words and details; a fault is core's
 *     "couldn't be confirmed" sentence with reason 'failed', and is reported;
 *   - the LEGACY branch (one release): a body with no key, from a tab opened
 *     before the deploy, gets a server-minted key and the session as placer,
 *     its needed-by instant passes through, and its phone and pickup notes are
 *     dropped;
 *   - getOrderSubmissionAction / withdrawOrderSubmissionAction call the
 *     status and withdraw functions with the caller's org and the key.
 */

vi.mock('@/server/services/context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/services/context')>()),
  withContext: vi.fn(),
}));
vi.mock('@/server/services/audit', () => ({ audit: vi.fn(async () => {}) }));
vi.mock('@/server/services/integration-events', () => ({ dispatchEvent: vi.fn(async () => {}) }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
const { revalidatePath, revalidateTag } = vi.hoisted(() => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));
vi.mock('next/cache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/cache')>()),
  revalidateTag,
  revalidatePath,
}));

import { OrderRequestsService } from '@/server/services/order-requests';

import {
  createOrderRequestAction,
  getOrderSubmissionAction,
  withdrawOrderSubmissionAction,
} from './order-requests';

const ORG = 'org-test';
const USER = 'eeeeeeee-0000-4000-8000-0000000000aa';
const WH = 'aaaaaaaa-0000-4000-8000-000000000001';
const ITEM = 'bbbbbbbb-0000-4000-8000-00000000000a';
const KEY = 'eeeeeeee-0000-4000-8000-000000000001';
const SUMMARY = {
  id: 'ffffffff-0000-4000-8000-000000000001',
  order_number: 7,
  status: 'pending_approval',
  warehouse_id: WH,
  fulfillment_type: 'pickup',
  delivery_charter_id: null,
  needed_by: null,
  created_at: '2026-10-04T10:00:00+00:00',
  requester_user_id: USER,
  requester_name: null,
  requester_email: null,
  line_count: 1,
  unit_count: 2,
};

function arrange(results: Record<string, QueryResult>) {
  const stub = makeSupabaseStub({
    'organizations.select': { data: { timezone: 'America/Los_Angeles' }, error: null },
    ...results,
  });
  vi.mocked(withContext).mockResolvedValue(
    makeServiceContext(stub.client, {
      role: 'staff',
      userId: USER,
      enabledModules: new Set<ModuleId>(['orders']),
    }) as never,
  );
  return stub;
}

const BODY = {
  idempotencyKey: KEY,
  placerUserId: USER,
  warehouseId: WH,
  fulfillmentType: 'pickup' as const,
  deliveryCharterId: null,
  onBehalfOf: null,
  notes: null,
  neededByLocal: null,
  lines: [{ itemId: ITEM, quantity: 2 }],
};

function request(stub: ReturnType<typeof makeSupabaseStub>) {
  const call = stub.rpcCalls.find((c) => c.name === 'place_order_request');
  return call?.args as { p_request: Record<string, unknown>; p_key: string } | undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(
    OrderRequestsService.prototype as unknown as { notifyEmail: () => Promise<void> },
    'notifyEmail',
  ).mockResolvedValue(undefined);
});

describe('createOrderRequestAction', () => {
  it("answers the route's own shape, keeps the orders list fresh, and never clears the catalog", async () => {
    const stub = arrange({
      'rpc:place_order_request': {
        data: { outcome: 'placed', replay: false, order: SUMMARY },
        error: null,
      },
    });
    const res = await createOrderRequestAction(BODY, { organizationId: ORG });
    expect(res).toMatchObject({
      ok: true,
      data: {
        organizationId: ORG,
        result: { replay: false, order: { id: SUMMARY.id, orderLabel: 'SO-000007' } },
      },
    });
    expect(request(stub)?.p_request.surface).toBe('web');
    expect(request(stub)?.p_key).toBe(KEY);
    expect(revalidatePath).toHaveBeenCalledWith('/dashboard/orders');
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it('a recorded refusal keeps its code, words and details (settled), so the storefront classifies it as the phone does', async () => {
    arrange({
      'rpc:place_order_request': {
        data: {
          outcome: 'refused',
          replay: true,
          refusal: { reason: 'warehouse_not_available', detail: null },
        },
        error: null,
      },
    });
    const res = await createOrderRequestAction(BODY, { organizationId: ORG });
    expect(res).toMatchObject({
      ok: false,
      error: {
        code: 'not_found',
        details: {
          reason: 'warehouse_not_available',
          settled: true,
          replay: true,
          // The organization that answered, so a tab left in another one
          // never takes it as its own (review round 1).
          organizationId: ORG,
        },
      },
    });
  });

  it("a fault is core's couldn't-be-confirmed sentence with reason 'failed', and is reported", async () => {
    arrange({ 'rpc:place_order_request': { data: null, error: { message: 'fetch failed' } } });
    const res = await createOrderRequestAction(BODY, { organizationId: ORG });
    expect(res).toEqual({
      ok: false,
      error: {
        code: 'internal_error',
        message: ORDER_FAULT_COPY,
        details: { reason: 'failed', organizationId: ORG },
      },
    });
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(vi.mocked(reportError).mock.calls[0]?.[1]).toEqual({ tag: 'actions.orders.create' });
  });

  it('a page opened in another organization (a workspace switch elsewhere) is refused organization_changed, never settled, nothing called', async () => {
    const stub = arrange({
      'rpc:place_order_request': {
        data: { outcome: 'refused', replay: false, refusal: { reason: 'warehouse_not_available', detail: null } },
        error: null,
      },
    });
    const res = await createOrderRequestAction(BODY, { organizationId: 'org-q' });
    expect(res).toEqual({
      ok: false,
      error: {
        code: 'conflict',
        message: ORDER_ORGANIZATION_CHANGED_COPY,
        details: { reason: 'organization_changed', organizationId: ORG },
      },
    });
    expect(stub.rpcCalls).toEqual([]);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('a keyed body that does not name its organization is refused, nothing called', async () => {
    const stub = arrange({});
    for (const scope of [undefined, {}, { organizationId: '' }] as const) {
      const res = await createOrderRequestAction(BODY, scope as never);
      expect(res).toMatchObject({
        ok: false,
        error: { code: 'validation_error', details: { reason: 'invalid', field: 'organizationId' } },
      });
    }
    expect(stub.rpcCalls).toEqual([]);
  });

  it('the LEGACY branch (no key): a server-minted key, the session as placer, the instant passed through', async () => {
    const stub = arrange({
      'rpc:place_order_request': {
        data: { outcome: 'placed', replay: false, order: SUMMARY },
        error: null,
      },
    });
    const res = await createOrderRequestAction({
      warehouseId: WH,
      notes: 'Room 12',
      neededBy: '2026-10-05T17:00:00.000Z',
      fulfillmentType: 'pickup',
      requesterPhone: '555-0100',
      deliveryCharterId: 'cccccccc-0000-4000-8000-000000000001',
      pickupLocationNotes: 'Back door',
      onBehalfOf: null,
      lines: [{ itemId: ITEM, quantity: 2, notes: 'blue' }],
    });
    expect(res.ok).toBe(true);
    const args = request(stub);
    expect(args?.p_key).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(args?.p_request).toEqual({
      organization_id: ORG,
      placer_user_id: USER,
      surface: 'web',
      warehouse_id: WH,
      fulfillment_type: 'pickup',
      // A pickup carries no site; the phone and pickup notes are not sent.
      delivery_charter_id: null,
      on_behalf_name: null,
      on_behalf_email: null,
      notes: 'Room 12',
      needed_by: '2026-10-05T17:00:00.000Z',
      lines: [{ item_id: ITEM, quantity: 2 }],
    });
    // Each legacy call is its own key (no retry protection, as before).
    await createOrderRequestAction({
      warehouseId: WH,
      fulfillmentType: 'pickup',
      lines: [{ itemId: ITEM, quantity: 1 }],
    });
    const keys = stub.rpcCalls
      .filter((c) => c.name === 'place_order_request')
      .map((c) => (c.args as { p_key: string }).p_key);
    expect(new Set(keys).size).toBe(2);
  });

  it('a legacy body that does not read is refused, nothing called', async () => {
    const stub = arrange({});
    const res = await createOrderRequestAction({ warehouseId: 'nope', lines: [] } as never);
    expect(res).toEqual({
      ok: false,
      error: {
        code: 'validation_error',
        message: ORDER_BODY_UNREADABLE_COPY,
        details: { reason: 'invalid', field: 'body' },
      },
    });
    expect(stub.rpcCalls).toEqual([]);
  });
});

describe('the settle actions', () => {
  it('getOrderSubmissionAction reads the caller key in the caller organization', async () => {
    const stub = arrange({
      'rpc:order_submission_status': { data: { outcome: 'none' }, error: null },
    });
    const res = await getOrderSubmissionAction({ warehouseId: WH, key: KEY, organizationId: ORG, placerUserId: USER });
    expect(res).toEqual({ ok: true, data: { organizationId: ORG, outcome: 'none' } });
    expect(stub.rpcCalls).toEqual([
      { name: 'order_submission_status', args: { p_org: ORG, p_key: KEY } },
    ]);
  });

  it('withdrawOrderSubmissionAction withdraws as the web', async () => {
    const stub = arrange({
      'rpc:withdraw_order_submission': { data: { outcome: 'placed', order: SUMMARY }, error: null },
    });
    const res = await withdrawOrderSubmissionAction({ warehouseId: WH, key: KEY, organizationId: ORG, placerUserId: USER });
    expect(res).toMatchObject({
      ok: true,
      data: { organizationId: ORG, outcome: 'placed', order: { id: SUMMARY.id } },
    });
    expect(stub.rpcCalls).toEqual([
      { name: 'withdraw_order_submission', args: { p_org: ORG, p_key: KEY, p_surface: 'web' } },
    ]);
  });

  it('a key that is not a uuid is refused before anything is called', async () => {
    const stub = arrange({});
    for (const action of [getOrderSubmissionAction, withdrawOrderSubmissionAction]) {
      const res = await action({ warehouseId: WH, key: 'shortfall-1', organizationId: ORG, placerUserId: USER });
      expect(res).toMatchObject({
        ok: false,
        error: { code: 'validation_error', details: { field: 'idempotencyKey' } },
      });
    }
    expect(stub.rpcCalls).toEqual([]);
  });

  it('a tab left in another organization or under another account settles nothing: refused before the function, never settled (review round 1)', async () => {
    const stub = arrange({
      'rpc:order_submission_status': { data: { outcome: 'withdrawn' }, error: null },
      'rpc:withdraw_order_submission': { data: { outcome: 'withdrawn' }, error: null },
    });
    for (const action of [getOrderSubmissionAction, withdrawOrderSubmissionAction]) {
      const org = await action({ warehouseId: WH, key: KEY, organizationId: 'org-q', placerUserId: USER });
      expect(org).toEqual({
        ok: false,
        error: {
          code: 'conflict',
          message: ORDER_ORGANIZATION_CHANGED_UNCONFIRMED_COPY,
          details: { reason: 'organization_changed', organizationId: ORG },
        },
      });
      const placer = await action({
        warehouseId: WH,
        key: KEY,
        organizationId: ORG,
        placerUserId: 'eeeeeeee-0000-4000-8000-0000000000bb',
      });
      expect(placer).toEqual({
        ok: false,
        error: {
          code: 'forbidden',
          message: ORDER_PLACER_MISMATCH_UNCONFIRMED_COPY,
          details: { reason: 'placer_mismatch', organizationId: ORG },
        },
      });
    }
    expect(stub.rpcCalls).toEqual([]);
  });

  it('a settle call that does not name its organization and account is refused, nothing called', async () => {
    const stub = arrange({});
    for (const action of [getOrderSubmissionAction, withdrawOrderSubmissionAction]) {
      for (const input of [
        { warehouseId: WH, key: KEY },
        { warehouseId: WH, key: KEY, organizationId: ORG },
        { warehouseId: WH, key: KEY, placerUserId: USER },
        { warehouseId: WH, key: KEY, organizationId: ORG, placerUserId: 'not-a-uuid' },
      ]) {
        const res = await action(input as never);
        expect(res).toMatchObject({ ok: false, error: { code: 'validation_error' } });
      }
    }
    expect(stub.rpcCalls).toEqual([]);
  });

  it('a busy withdraw keeps its retryable details', async () => {
    arrange({
      'rpc:withdraw_order_submission': {
        data: null,
        error: { message: 'lock timeout', code: '55P03' },
      },
    });
    const res = await withdrawOrderSubmissionAction({ warehouseId: WH, key: KEY, organizationId: ORG, placerUserId: USER });
    expect(res).toMatchObject({
      ok: false,
      error: { code: 'conflict', details: { reason: 'busy', retryable: true } },
    });
  });
});

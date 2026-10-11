import { beforeEach, describe, expect, it, vi } from 'vitest';

import { forbiddenRequesterKeys } from '@stockpilot/core';

import { ServiceError } from '@/server/services/context';

/**
 * The member requester routes (returns RX-3): GET the sheet, POST the
 * request, POST the sizes. Bearer or cookie through withApiContext (a
 * disabled account resolves to null: 401), the caller's own order only (the
 * scope comes from the server context, never the body), the returns module,
 * per-user limits, no-store, and core's requester schema on the body.
 */

const withApiContext = vi.fn();
vi.mock('@/lib/auth/api-context', () => ({ withApiContext: (...a: unknown[]) => withApiContext(...a) }));
const checkRateLimit = vi.fn(async (..._a: unknown[]) => ({ allowed: true, count: 1, resetAt: Date.now() + 1000 }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: (...a: unknown[]) => checkRateLimit(...a) }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ admin: true }) }));
vi.mock('server-only', () => ({}));

const createMemberReturn = vi.fn();
vi.mock('@/server/services/returns', () => ({ createMemberReturn: (...a: unknown[]) => createMemberReturn(...a) }));
const loadMemberReturnSheet = vi.fn();
const exchangeOptionsForMember = vi.fn();
vi.mock('@/server/services/returns-requester', () => ({
  loadMemberReturnSheet: (...a: unknown[]) => loadMemberReturnSheet(...a),
  exchangeOptionsForMember: (...a: unknown[]) => exchangeOptionsForMember(...a),
}));

import { POST as POST_OPTIONS } from './options/route';
import { GET, POST } from './route';

const ORDER = '11111111-1111-4111-8111-111111111111';
const LINE = '22222222-2222-4222-8222-222222222222';
const ITEM = '33333333-3333-4333-8333-333333333333';
const KEY = '44444444-4444-4444-8444-444444444444';

const CTX = {
  organizationId: 'org-1',
  userId: 'member-1',
  role: 'staff',
  supabase: {},
  mfaRequired: false,
  mfaSatisfied: true,
  enabledModules: new Set(['returns', 'orders']),
};

const SHEET = {
  orderNumber: 'SO-000103',
  requesterName: 'Pat Lee',
  exchangesEnabled: true,
  lines: [{ orderRequestLineId: LINE, name: 'New Hire Shirt', sizeLabel: 'Size M', photo: null, quantityFulfilled: 2, quantityRemaining: 2 }],
  tracking: [],
};

function req(method: 'GET' | 'POST', body?: unknown) {
  return new Request(`https://test.local/api/v1/orders/${ORDER}/return-request`, {
    method,
    headers: { 'content-type': 'application/json', authorization: 'Bearer t' },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  }) as unknown as Parameters<typeof GET>[0];
}
const params = (id = ORDER) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  withApiContext.mockResolvedValue(CTX);
  loadMemberReturnSheet.mockResolvedValue(SHEET);
  exchangeOptionsForMember.mockResolvedValue({ exchangesEnabled: true, lines: [] });
  createMemberReturn.mockResolvedValue({ id: 'ret-1', returnNumber: 'RMA-1', organizationId: 'org-1', replay: false });
});

describe('GET /api/v1/orders/[id]/return-request (the sheet)', () => {
  it('answers the sheet of the caller own order, no-store, the organization and order echoed', async () => {
    const res = await GET(req('GET'), params());
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const body = await res.json();
    expect(body).toEqual({ organizationId: 'org-1', orderId: ORDER, ...SHEET });
    // The scope comes from the server context alone.
    expect(loadMemberReturnSheet).toHaveBeenCalledWith({ admin: true }, { organizationId: 'org-1', userId: 'member-1', orderRequestId: ORDER });
    const { organizationId: _org, orderId: _order, ...sheet } = body;
    expect(forbiddenRequesterKeys(sheet)).toEqual([]);
  });

  it('signed out, or a disabled account (withApiContext answers null): 401 before anything', async () => {
    withApiContext.mockResolvedValueOnce(null);
    const res = await GET(req('GET'), params());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthenticated', message: 'Sign in again.' });
    expect(checkRateLimit).not.toHaveBeenCalled();
    expect(loadMemberReturnSheet).not.toHaveBeenCalled();
  });

  it("another member's order, a missing one or a malformed id: the one 404", async () => {
    loadMemberReturnSheet.mockResolvedValueOnce(null);
    const other = await GET(req('GET'), params());
    expect(other.status).toBe(404);
    expect(await other.json()).toEqual({ error: 'not_found', message: "This order isn't available." });
    const bad = await GET(req('GET'), params('not-an-id'));
    expect(bad.status).toBe(404);
    expect(loadMemberReturnSheet).toHaveBeenCalledTimes(1);
  });

  it('the returns module off: 403 module_disabled', async () => {
    withApiContext.mockResolvedValueOnce({ ...CTX, enabledModules: new Set(['orders']) });
    const res = await GET(req('GET'), params());
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('module_disabled');
    expect(loadMemberReturnSheet).not.toHaveBeenCalled();
  });

  it('per-user, fail-closed read limit', async () => {
    checkRateLimit.mockResolvedValueOnce({ allowed: false, count: 121, resetAt: Date.now() + 1000 });
    const res = await GET(req('GET'), params());
    expect(res.status).toBe(429);
    expect(checkRateLimit).toHaveBeenCalledWith('return-request-read:member-1', 120, 3_600_000, 'closed');
  });
});

describe('POST /api/v1/orders/[id]/return-request (the request)', () => {
  const body = {
    reasonCode: 'wrong_item',
    lines: [{ orderRequestLineId: LINE, quantity: 1, exchange: { itemId: ITEM, quantity: 1 } }],
    idempotencyKey: KEY,
  };

  it('creates on the caller own order with the exchange and the key; scope from the server, never the body', async () => {
    const res = await POST(req('POST', { ...body, organizationId: 'org-forged', userId: 'someone-else' }), params());
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(await res.json()).toEqual({ id: 'ret-1', returnNumber: 'RMA-1', replay: false });
    const [admin, scope, input, opts] = createMemberReturn.mock.calls[0]!;
    expect(admin).toEqual({ admin: true });
    expect(scope).toEqual({ organizationId: 'org-1', userId: 'member-1', orderRequestId: ORDER });
    expect(input).toEqual({
      reasonCode: 'wrong_item',
      notes: null,
      lines: [{ orderRequestLineId: LINE, quantity: 1, exchange: { itemId: ITEM, quantity: 1 } }],
    });
    expect(opts).toEqual({ idempotencyKey: KEY });
    expect(checkRateLimit).toHaveBeenCalledWith('return-request-write:member-1', 30, 3_600_000, 'closed');
  });

  it('strips a forged disposition, status, warehouse, location and approved item on the line', async () => {
    await POST(
      req('POST', {
        lines: [
          {
            orderRequestLineId: LINE,
            quantity: 1,
            disposition: 'scrap',
            status: 'approved',
            warehouseId: 'w',
            locationId: 'l',
            approvedItemId: ITEM,
            replacementOrderId: ORDER,
          },
        ],
      }),
      params(),
    );
    const [, , input, opts] = createMemberReturn.mock.calls[0]!;
    expect(input.lines).toEqual([{ orderRequestLineId: LINE, quantity: 1 }]);
    expect(opts).toEqual({ idempotencyKey: null });
  });

  it.each([
    ['a quantity of 0', [{ orderRequestLineId: LINE, quantity: 0 }]],
    ['a fractional quantity', [{ orderRequestLineId: LINE, quantity: 1.5 }]],
    ['an exchange above the returned quantity', [{ orderRequestLineId: LINE, quantity: 1, exchange: { itemId: ITEM, quantity: 2 } }]],
    ['a forged field inside the exchange', [{ orderRequestLineId: LINE, quantity: 1, exchange: { itemId: ITEM, approvedItemId: ITEM } }]],
    ['no lines', []],
  ])('refuses %s with 400 before the service', async (_label, lines) => {
    const res = await POST(req('POST', { lines }), params());
    expect(res.status).toBe(400);
    expect((await res.json()).details).toEqual({ reason: 'return_invalid' });
    expect(createMemberReturn).not.toHaveBeenCalled();
  });

  it('the MFA floor applies to the write', async () => {
    withApiContext.mockResolvedValueOnce({ ...CTX, mfaRequired: true, mfaSatisfied: false, mfaEnrolled: true });
    const res = await POST(req('POST', body), params());
    expect(res.status).toBe(403);
    expect((await res.json()).details).toEqual({ reason: 'aal2_required' });
    expect(createMemberReturn).not.toHaveBeenCalled();
  });

  it("another member's order is the one 404; a refusal keeps its words and reason; a fault is generic", async () => {
    createMemberReturn.mockRejectedValueOnce(new ServiceError('not_found', "This order isn't available."));
    const nf = await POST(req('POST', body), params());
    expect(nf.status).toBe(404);
    createMemberReturn.mockRejectedValueOnce(
      new ServiceError('validation_error', "That item can't be used as a replacement.", { reason: 'exchange_item_not_eligible' }),
    );
    const refused = await POST(req('POST', body), params());
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({
      error: 'validation_error',
      message: "That item can't be used as a replacement.",
      details: { reason: 'exchange_item_not_eligible' },
    });
    createMemberReturn.mockRejectedValueOnce(new ServiceError('internal_error', 'relation does not exist'));
    const fault = await POST(req('POST', body), params());
    expect(fault.status).toBe(500);
    expect(JSON.stringify(await fault.json())).not.toMatch(/relation/);
  });

  it('a disabled account (withApiContext null): 401, nothing created', async () => {
    withApiContext.mockResolvedValueOnce(null);
    const res = await POST(req('POST', body), params());
    expect(res.status).toBe(401);
    expect(createMemberReturn).not.toHaveBeenCalled();
  });
});

describe('POST /api/v1/orders/[id]/return-request/options (the sizes)', () => {
  it('answers the caller own order sizes; the body is never read (no oracle)', async () => {
    const res = await POST_OPTIONS(req('POST', { itemId: ITEM, groupId: 'g', warehouseId: 'w', quantity: 9 }), params());
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(await res.json()).toEqual({ organizationId: 'org-1', orderId: ORDER, exchangesEnabled: true, lines: [] });
    expect(exchangeOptionsForMember).toHaveBeenCalledWith({ admin: true }, { organizationId: 'org-1', userId: 'member-1', orderRequestId: ORDER });
  });

  it("another member's order: 404; signed out: 401", async () => {
    exchangeOptionsForMember.mockResolvedValueOnce(null);
    expect((await POST_OPTIONS(req('POST', {}), params())).status).toBe(404);
    withApiContext.mockResolvedValueOnce(null);
    expect((await POST_OPTIONS(req('POST', {}), params())).status).toBe(401);
  });
});

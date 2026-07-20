import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ServiceError } from '@/server/services/context';

/**
 * Tests for the B2B portal "Request a return" server action. The action's
 * load-bearing contract:
 *
 *   • identity comes ONLY from resolvePortalContext() (server-side,
 *     accepted-mapping-wins) — no portal context means a refusal before any
 *     rate-limit or service work.
 *   • the fail-CLOSED per-user rate limit sits BEFORE the service call.
 *   • the service scope (organizationId + customerId) is derived from the
 *     SERVER-resolved context — never the client input — so a forged orderId
 *     can only ever be looked up inside the caller's own customer scope.
 *   • ServiceError not_found (cross-customer/foreign id) maps to a not_found
 *     ActionResult without leaking anything else.
 */

const resolvePortalContext = vi.fn();
const checkRateLimit = vi.fn();
const createPortalReturn = vi.fn();
const revalidatePath = vi.fn();

vi.mock('next/cache', () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: (...a: unknown[]) => checkRateLimit(...a),
}));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ mocked: 'admin' }) }));
vi.mock('@/server/services/portal', () => ({
  resolvePortalContext: (...a: unknown[]) => resolvePortalContext(...a),
  portalSubmitOrder: vi.fn(),
}));
vi.mock('@/server/services/returns', () => ({
  createPortalReturn: (...a: unknown[]) => createPortalReturn(...a),
}));

import { requestPortalReturnAction } from './portal';

const ORDER_ID = '11111111-1111-4111-8111-111111111111';
const OLINE_ID = '22222222-2222-4222-8222-222222222222';

const PORTAL_CTX = {
  userId: 'user-1',
  email: 'buyer@customer.example.com',
  customerId: 'cust-1',
  customerName: 'Casey Customer',
  organizationId: 'org-1',
  orgName: 'Supplier Co',
  orgLogoUrl: null,
  priceListId: null,
};

const VALID_INPUT = {
  orderId: ORDER_ID,
  reasonCode: 'damaged' as const,
  lines: [{ orderRequestLineId: OLINE_ID, quantity: 2 }],
};

beforeEach(() => {
  vi.clearAllMocks();
  resolvePortalContext.mockResolvedValue(PORTAL_CTX);
  checkRateLimit.mockResolvedValue({ allowed: true, count: 1, resetAt: Date.now() + 1000 });
  createPortalReturn.mockResolvedValue({
    id: 'ret-1',
    returnNumber: 'RMA-20260720-ABCDEF',
    organizationId: 'org-1',
  });
});

describe('requestPortalReturnAction', () => {
  it('denies an unauthenticated / non-portal user before any work', async () => {
    resolvePortalContext.mockResolvedValue(null);
    const res = await requestPortalReturnAction(VALID_INPUT);
    expect(res).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    expect(checkRateLimit).not.toHaveBeenCalled();
    expect(createPortalReturn).not.toHaveBeenCalled();
  });

  it('applies a fail-CLOSED per-user rate limit BEFORE the service call', async () => {
    checkRateLimit.mockResolvedValue({ allowed: false, count: 11, resetAt: Date.now() + 1000 });
    const res = await requestPortalReturnAction(VALID_INPUT);
    expect(res).toMatchObject({ ok: false, error: { code: 'rate_limited' } });
    expect(checkRateLimit).toHaveBeenCalledWith(
      'portal-return:user:user-1',
      10,
      60 * 60 * 1000,
      'closed',
    );
    expect(createPortalReturn).not.toHaveBeenCalled();
  });

  it('rejects malformed input without calling the service', async () => {
    const res = await requestPortalReturnAction({ orderId: ORDER_ID, lines: [] });
    expect(res).toMatchObject({ ok: false, error: { code: 'validation_error' } });
    expect(createPortalReturn).not.toHaveBeenCalled();
  });

  it('derives the service scope from the SERVER-resolved context, never the client', async () => {
    const res = await requestPortalReturnAction(VALID_INPUT);
    expect(res).toEqual({ ok: true, data: { id: 'ret-1', status: 'requested' } });

    expect(createPortalReturn).toHaveBeenCalledTimes(1);
    const [admin, scope, input] = createPortalReturn.mock.calls[0]!;
    expect(admin).toEqual({ mocked: 'admin' });
    // org + customer come from resolvePortalContext — the ONLY client-supplied
    // part of the scope is the orderId, which the service can then only find
    // inside this customer's own orders.
    expect(scope).toEqual({
      organizationId: 'org-1',
      customerId: 'cust-1',
      orderRequestId: ORDER_ID,
    });
    expect(input).toEqual({
      reasonCode: 'damaged',
      notes: undefined,
      lines: [{ orderRequestLineId: OLINE_ID, quantity: 2 }],
    });
    expect(revalidatePath).toHaveBeenCalledWith('/portal');
  });

  it('maps a ServiceError not_found (cross-customer/foreign id) to not_found', async () => {
    createPortalReturn.mockRejectedValue(
      new ServiceError('not_found', 'This order could not be found.'),
    );
    const res = await requestPortalReturnAction(VALID_INPUT);
    expect(res).toMatchObject({ ok: false, error: { code: 'not_found' } });
  });

  it('surfaces a budget validation_error message from the shared core', async () => {
    createPortalReturn.mockRejectedValue(
      new ServiceError('validation_error', 'Cannot return 3; only 2 of 10 fulfilled remain returnable for this line.'),
    );
    const res = await requestPortalReturnAction(VALID_INPUT);
    expect(res).toMatchObject({
      ok: false,
      error: { code: 'validation_error', message: expect.stringContaining('only 2 of 10') },
    });
  });
});

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
const exchangeOptionsForPortal = vi.fn();
const loadPortalReturnSheet = vi.fn();
vi.mock('@/server/services/returns-requester', () => ({
  exchangeOptionsForPortal: (...a: unknown[]) => exchangeOptionsForPortal(...a),
  loadPortalReturnSheet: (...a: unknown[]) => loadPortalReturnSheet(...a),
}));

import { portalReturnOptionsAction, portalReturnSheetAction, requestPortalReturnAction } from './portal';

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
    // Re-pinned by returns RX-3: the answer also names the RMA and says
    // whether the key replayed (the claim stands: scope from the server).
    expect(res).toEqual({
      ok: true,
      data: { id: 'ret-1', status: 'requested', returnNumber: 'RMA-20260720-ABCDEF', replay: false },
    });

    expect(createPortalReturn).toHaveBeenCalledTimes(1);
    const [admin, scope, input, opts] = createPortalReturn.mock.calls[0]!;
    // No key in the body: the service mints one (a body with one replays).
    expect(opts).toEqual({ idempotencyKey: null });
    expect(admin).toEqual({ mocked: 'admin' });
    // org + customer come from resolvePortalContext — the ONLY client-supplied
    // part of the scope is the orderId, which the service can then only find
    // inside this customer's own orders.
    expect(scope).toEqual({
      organizationId: 'org-1',
      customerId: 'cust-1',
      orderRequestId: ORDER_ID,
      // The portal user, from the server-resolved context (recorded on the
      // created decision, 0394).
      portalUserId: 'user-1',
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

// ── Returns RX-3: the portal customer's own exchange ──────────────────────
describe('portal exchange (returns RX-3)', () => {
  const ITEM = '33333333-3333-4333-8333-333333333333';
  const KEY = '44444444-4444-4444-8444-444444444444';

  it('passes a line exchange and the form key through; scope still from the server', async () => {
    const res = await requestPortalReturnAction({
      ...VALID_INPUT,
      lines: [{ orderRequestLineId: OLINE_ID, quantity: 2, exchange: { itemId: ITEM, quantity: 1 } }],
      idempotencyKey: KEY,
    });
    expect(res.ok).toBe(true);
    const [, scope, input, opts] = createPortalReturn.mock.calls[0]!;
    expect(scope).toMatchObject({ organizationId: 'org-1', customerId: 'cust-1', portalUserId: 'user-1' });
    expect(input.lines).toEqual([{ orderRequestLineId: OLINE_ID, quantity: 2, exchange: { itemId: ITEM, quantity: 1 } }]);
    expect(opts).toEqual({ idempotencyKey: KEY });
  });

  it('refuses a forged field inside the exchange before the service', async () => {
    const res = await requestPortalReturnAction({
      ...VALID_INPUT,
      lines: [{ orderRequestLineId: OLINE_ID, quantity: 1, exchange: { itemId: ITEM, approvedItemId: ITEM } as never }],
    });
    expect(res).toMatchObject({ ok: false, error: { code: 'validation_error' } });
    expect(createPortalReturn).not.toHaveBeenCalled();
  });

  it('an ineligible item keeps the generic words and reason; a conflict keeps its words', async () => {
    createPortalReturn.mockRejectedValueOnce(
      new ServiceError('validation_error', "That item can't be used as a replacement.", { reason: 'exchange_item_not_eligible' }),
    );
    expect(await requestPortalReturnAction(VALID_INPUT)).toEqual({
      ok: false,
      error: { code: 'validation_error', message: "That item can't be used as a replacement.", details: { reason: 'exchange_item_not_eligible' } },
    });
    createPortalReturn.mockRejectedValueOnce(
      new ServiceError('conflict', 'This request was already sent with different details. Reload and try again.', { reason: 'idempotency_conflict' }),
    );
    expect(await requestPortalReturnAction(VALID_INPUT)).toMatchObject({ ok: false, error: { code: 'conflict' } });
  });

  it('the options: the customer own order, a fail-closed read limit, not_found for anything else', async () => {
    exchangeOptionsForPortal.mockResolvedValueOnce({ exchangesEnabled: true, lines: [] });
    expect(await portalReturnOptionsAction(ORDER_ID)).toEqual({ ok: true, data: { exchangesEnabled: true, lines: [] } });
    expect(exchangeOptionsForPortal).toHaveBeenCalledWith({ mocked: 'admin' }, { organizationId: 'org-1', customerId: 'cust-1', orderRequestId: ORDER_ID });
    expect(checkRateLimit).toHaveBeenCalledWith('portal-return-read:user:user-1', 120, 60 * 60 * 1000, 'closed');

    exchangeOptionsForPortal.mockResolvedValueOnce(null);
    expect(await portalReturnOptionsAction(ORDER_ID)).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(await portalReturnOptionsAction('not-an-id')).toMatchObject({ ok: false, error: { code: 'not_found' } });

    resolvePortalContext.mockResolvedValueOnce(null);
    expect(await portalReturnOptionsAction(ORDER_ID)).toMatchObject({ ok: false, error: { code: 'forbidden' } });
  });

  it('the sheet: the customer own order; a failure is reported and generic', async () => {
    loadPortalReturnSheet.mockResolvedValueOnce({ orderNumber: 'SO-000007', requesterName: 'Casey', exchangesEnabled: true, lines: [], tracking: [] });
    expect(await portalReturnSheetAction(ORDER_ID)).toMatchObject({ ok: true, data: { orderNumber: 'SO-000007' } });
    loadPortalReturnSheet.mockRejectedValueOnce(new Error('boom'));
    expect(await portalReturnSheetAction(ORDER_ID)).toMatchObject({ ok: false, error: { code: 'internal_error' } });
    checkRateLimit.mockResolvedValueOnce({ allowed: false, count: 121, resetAt: Date.now() + 1000 });
    expect(await portalReturnSheetAction(ORDER_ID)).toMatchObject({ ok: false, error: { code: 'rate_limited' } });
  });
});


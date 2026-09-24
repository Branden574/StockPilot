import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * S6-A rentals hardening, against the REAL ServiceError (rentals.test.ts mocks
 * it, so it cannot see the internal_error sanitisation):
 *
 *   - a lock or statement timeout (55P03 / 57014) from the rental functions is
 *     a retryable conflict with an operator sentence, not a 500;
 *   - any other function error is an internal_error whose PUBLIC message is
 *     generic, with the raw text only in `internalDetail`;
 *   - an outcome the functions never answer is an internal_error, and nothing
 *     downstream runs;
 *   - the checkout email runs after the response (next/server `after()`),
 *     never inside the request.
 */

vi.mock('@/lib/auth/warehouse', () => ({
  assertWarehouseAccess: vi.fn(async () => undefined),
  ForbiddenError: class ForbiddenError extends Error {},
}));
vi.mock('./audit', () => ({ audit: vi.fn(async () => undefined) }));
vi.mock('@/lib/email/rentals', () => ({
  sendRentalCheckoutEmail: vi.fn(async () => undefined),
  sendRentalReturnedEmail: vi.fn(async () => undefined),
}));

// after() registers the callback; the test decides when "the response has
// been sent" by flushing. Mirrors order-requests.approve.test.ts.
let afterCalls: Array<() => unknown> = [];
vi.mock('next/server', () => ({ after: (fn: () => unknown) => afterCalls.push(fn) }));

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

import { sendRentalCheckoutEmail, sendRentalReturnedEmail } from '@/lib/email/rentals';

import { audit } from './audit';
import { RentalsService } from './rentals';

async function flushAfter() {
  const calls = afterCalls;
  afterCalls = [];
  for (const fn of calls) await fn();
}

const WAREHOUSE = '00000000-0000-0000-0000-000000000099';
const ITEM = '00000000-0000-0000-0000-000000000001';

const createInput = {
  warehouseId: WAREHOUSE,
  borrowerName: 'Jane Doe',
  borrowerUserId: null,
  expectedReturnAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  notes: null,
  lines: [{ itemId: ITEM, quantity: 1, notes: null }],
};

const OUT_ROW = {
  status: 'out',
  expected_return_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  warehouse_id: WAREHOUSE,
};

function service(results: Parameters<typeof makeSupabaseStub>[0]) {
  const stub = makeSupabaseStub(results);
  return { stub, svc: new RentalsService(makeServiceContext(stub.client)) };
}

const TIMEOUT_SENTENCE =
  'Someone else is checking out or approving these items right now. Try again in a moment.';

beforeEach(() => {
  vi.clearAllMocks();
  afterCalls = [];
});

describe('rental function timeouts are a retryable conflict', () => {
  // Mutation caught: deleting the 55P03/57014 arm, so a lock wait behind an
  // order approval falls to the default and answers 500 "server broken".
  it.each([
    ['55P03', 'canceling statement due to lock timeout'],
    ['57014', 'canceling statement due to statement timeout'],
  ])('create: SQLSTATE %s maps to conflict with the operator sentence', async (code, message) => {
    const { svc } = service({
      'rpc:create_rental': {
        data: null,
        error: { code, message: `${message} while locking tuple (0,6) in relation "inventory_items"` },
      },
    });
    await expect(svc.create(createInput)).rejects.toMatchObject({
      code: 'conflict',
      message: TIMEOUT_SENTENCE,
    });
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
    expect(afterCalls).toHaveLength(0);
  });

  it('return: a lock timeout maps to conflict too, with no audit and no email', async () => {
    const { svc } = service({
      'rentals.select.maybeSingle': { data: OUT_ROW, error: null },
      'rpc:return_rental': {
        data: null,
        error: { code: '55P03', message: 'canceling statement due to lock timeout' },
      },
    });
    await expect(svc.markReturned({ id: 'r-1' })).rejects.toMatchObject({ code: 'conflict' });
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
    expect(sendRentalReturnedEmail).not.toHaveBeenCalled();
  });
});

describe('an unmapped function error never carries raw text in its public message', () => {
  // The S13 boundary: whatever the route or action does with `e.message`, the
  // raw PostgREST text is not in it. Mutation caught: rentalRpcError building
  // a non-internal code from the raw message, or dropping the detail.
  it('create: internal_error, generic message, raw text only in internalDetail', async () => {
    const raw = 'permission denied for table stock_reservations';
    const { svc } = service({
      'rpc:create_rental': { data: null, error: { code: '42501', message: raw } },
    });
    const e = await svc.create(createInput).catch((x: unknown) => x);
    expect(e).toMatchObject({ code: 'internal_error', internalDetail: raw });
    expect((e as Error).message).not.toContain('stock_reservations');
  });

  it('create: an empty error message still leaves a usable log detail', async () => {
    const { svc } = service({
      'rpc:create_rental': { data: null, error: { code: 'XX000', message: '' } },
    });
    const e = await svc.create(createInput).catch((x: unknown) => x);
    expect(e).toMatchObject({ code: 'internal_error' });
    expect((e as { internalDetail?: string }).internalDetail).toContain('XX000');
  });
});

describe('an outcome the rental functions never answer', () => {
  // Mutation caught: treating anything other than 'noop' as success, which
  // would audit and email a return that did not happen.
  it('markReturned: internal_error, no audit, no email', async () => {
    const { svc } = service({
      'rentals.select.maybeSingle': { data: OUT_ROW, error: null },
      'rpc:return_rental': { data: null, error: null },
    });
    await expect(svc.markReturned({ id: 'r-1' })).rejects.toMatchObject({
      code: 'internal_error',
    });
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
    expect(sendRentalReturnedEmail).not.toHaveBeenCalled();
  });

  it('cancel: internal_error, no audit', async () => {
    const { svc } = service({
      'rentals.select.maybeSingle': { data: OUT_ROW, error: null },
      'rpc:cancel_rental': { data: 'returned', error: null },
    });
    await expect(svc.cancel({ id: 'r-1', reason: 'x' })).rejects.toMatchObject({
      code: 'internal_error',
    });
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  });

  it('a noop still resolves quietly through the real error class', async () => {
    const { svc } = service({
      'rentals.select.maybeSingle': { data: OUT_ROW, error: null },
      'rpc:return_rental': { data: 'noop', error: null },
      'rpc:cancel_rental': { data: 'noop', error: null },
    });
    await expect(svc.markReturned({ id: 'r-1' })).resolves.toBeUndefined();
    await expect(svc.cancel({ id: 'r-1', reason: 'x' })).resolves.toBeUndefined();
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
    expect(sendRentalReturnedEmail).not.toHaveBeenCalled();
  });
});

describe('the checkout email runs after the response', () => {
  // Mutation caught: going back to `await sendRentalCheckoutEmail(...)` inside
  // create(), which holds the request open for a service-role read plus a
  // Resend call after the commit (the retry window S6-B is about).
  it('create resolves before the email is sent; the after() callback sends it', async () => {
    const { svc } = service({ 'rpc:create_rental': { data: 'rental-9', error: null } });

    await expect(svc.create(createInput)).resolves.toEqual({ id: 'rental-9' });
    expect(sendRentalCheckoutEmail).not.toHaveBeenCalled();
    expect(afterCalls).toHaveLength(1);

    await flushAfter();
    expect(sendRentalCheckoutEmail).toHaveBeenCalledTimes(1);
    expect(sendRentalCheckoutEmail).toHaveBeenCalledWith('rental-9');
  });

  it('a refused checkout registers no email', async () => {
    const { svc } = service({
      'rpc:create_rental': {
        data: null,
        error: { code: '22023', message: 'Projector: only 0 available to rent.', hint: 'rental_invalid' },
      },
    });
    await expect(svc.create(createInput)).rejects.toMatchObject({ code: 'validation_error' });
    expect(afterCalls).toHaveLength(0);
    expect(sendRentalCheckoutEmail).not.toHaveBeenCalled();
  });

  it('a failing send inside after() does not throw out of the callback', async () => {
    vi.mocked(sendRentalCheckoutEmail).mockRejectedValueOnce(new Error('resend down'));
    const { svc } = service({ 'rpc:create_rental': { data: 'rental-9', error: null } });
    await svc.create(createInput);
    await expect(flushAfter()).resolves.toBeUndefined();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { revalidateTag } from 'next/cache';
import { NextRequest } from 'next/server';

import { HOLD_BUSY_COPY } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { checkRateLimit } from '@/lib/rate-limit';
import { ServiceError } from '@/server/services/context';
import { OrderRequestsService } from '@/server/services/order-requests';

import { DELETE, PATCH, POST } from './route';

// F2-2: the phone's add-items and edit-line flows read the automatic top-up's
// outcome from this route, so it must pass `hold` through untouched: what was
// held, or why nothing was (never swallowed), or null when none was tried.

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn() }));
vi.mock('@/server/services/order-requests', () => ({ OrderRequestsService: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('next/cache', () => ({ revalidateTag: vi.fn() }));

const addLines = vi.fn();
const updateLineQuantity = vi.fn();
const removeLine = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true, resetAt: 0 } as never);
  vi.mocked(withApiContext).mockResolvedValue({ userId: 'u1', organizationId: 'o1' } as never);
  vi.mocked(OrderRequestsService).mockImplementation(function () {
    return { addLines, updateLineQuantity, removeLine } as unknown as InstanceType<typeof OrderRequestsService>;
  });
});

const ORDER = '11111111-1111-1111-1111-111111111111';
const ITEM = '22222222-2222-2222-2222-222222222222';
const LINE = '33333333-3333-3333-3333-333333333333';
const params = Promise.resolve({ id: ORDER });

function req(method: 'POST' | 'PATCH', body: unknown) {
  return new NextRequest(`http://localhost/api/v1/orders/${ORDER}/lines`, {
    method,
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

describe('POST /api/v1/orders/[id]/lines returns the hold outcome', () => {
  it.each([
    ['held', { ok: true, held: [{ itemId: ITEM, added: 3 }], stillShort: [], hiddenHeldItems: 0, hiddenShortItems: 0 }],
    ['a failure, said', { ok: false, reason: 'busy', message: HOLD_BUSY_COPY }],
    ['none tried', null],
  ])('%s', async (_name, hold) => {
    addLines.mockResolvedValueOnce({ added: 1, merged: 0, pickSlipStale: false, hold });
    const res = await POST(req('POST', { lines: [{ itemId: ITEM, quantity: 3 }] }), { params });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, added: 1, merged: 0, pickSlipStale: false, hold });
    expect(addLines).toHaveBeenCalledWith(ORDER, [{ itemId: ITEM, quantity: 3 }]);
    expect(revalidateTag).toHaveBeenCalledWith('orders-new-v2-catalog', 'max');
  });
});

// Returns RX-3 fix round 2: the web dialog and the phone read the same reason
// for a refused add. Busy wrote nothing (the same request is safe again); a
// partial answer saved the top-ups (the client must reload, never resend).
// An internal error carries no details.
describe('POST /api/v1/orders/[id]/lines answers a refusal with its reason', () => {
  const PARTIAL = 'Part of this change was saved. Reload the order to see it before adding again.';

  it.each([
    ['partial', new ServiceError('conflict', PARTIAL, { reason: 'partial', retryable: false }), 409,
      { error: 'conflict', message: PARTIAL, details: { reason: 'partial', retryable: false } }],
    ['busy', new ServiceError('conflict', 'Busy. Try again.', { reason: 'busy', retryable: true }), 409,
      { error: 'conflict', message: 'Busy. Try again.', details: { reason: 'busy', retryable: true } }],
    ['no details', new ServiceError('validation_error', 'Pick at least one item to add.'), 400,
      { error: 'validation_error', message: 'Pick at least one item to add.' }],
    ['internal, never its details', new ServiceError('internal_error', 'relation secret', { table: 'secret' }), 500,
      { error: 'internal_error', message: 'An internal error occurred. Please try again.' }],
  ])('%s', async (_name, refusal, status, body) => {
    addLines.mockRejectedValueOnce(refusal);
    const res = await POST(req('POST', { lines: [{ itemId: ITEM, quantity: 3 }] }), { params });
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual(body);
    expect(revalidateTag).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/v1/orders/[id]/lines returns the hold outcome', () => {
  it.each([
    ['held', { ok: true, held: [{ itemId: ITEM, added: 4 }], stillShort: [{ itemId: ITEM, quantity: 1 }], hiddenHeldItems: 0, hiddenShortItems: 1 }],
    ['a failure, said', { ok: false, reason: 'forbidden', message: 'x' }],
    ['none tried', null],
  ])('%s', async (_name, hold) => {
    updateLineQuantity.mockResolvedValueOnce({ pickSlipStale: true, quantity: 14, hold });
    const res = await PATCH(req('PATCH', { lineId: LINE, quantity: 14 }), { params });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, pickSlipStale: true, quantity: 14, hold });
    expect(updateLineQuantity).toHaveBeenCalledWith(ORDER, LINE, 14);
    expect(revalidateTag).toHaveBeenCalledWith('orders-new-v2-catalog', 'max');
  });
});

describe('the storefront catalog is revalidated after every line write, as the web actions do', () => {
  it('a removal (it releases what the line held)', async () => {
    removeLine.mockResolvedValueOnce({ pickSlipStale: false, removedItemId: ITEM });
    const res = await DELETE(
      new NextRequest(`http://localhost/api/v1/orders/${ORDER}/lines?lineId=${LINE}`, { method: 'DELETE' }),
      { params },
    );
    expect(res.status).toBe(200);
    expect(revalidateTag).toHaveBeenCalledWith('orders-new-v2-catalog', 'max');
  });

  it('never after a refused write', async () => {
    addLines.mockRejectedValueOnce(new Error('boom'));
    const res = await POST(req('POST', { lines: [{ itemId: ITEM, quantity: 3 }] }), { params });
    expect(res.status).toBe(500);
    expect(revalidateTag).not.toHaveBeenCalled();
  });
});

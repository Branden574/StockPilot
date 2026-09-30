import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ShortfallPoResultShapeError } from '@stockpilot/core';

import { draftOrderShortfallPos } from './orders-api';

// ./api reaches for expo-constants, AsyncStorage and the Supabase client at
// import time; hoisted mock as in orders-api.hold.test.ts.
const apiMock = vi.hoisted(() => ({ api: vi.fn(async (..._args: unknown[]) => ({}) as unknown) }));
vi.mock('./api', () => apiMock);

beforeEach(() => apiMock.api.mockReset());

const ORDER = '11111111-1111-4111-8111-111111111111';
const ITEM = '22222222-2222-4222-8222-222222222222';
const PO = '33333333-3333-4333-8333-333333333333';

const RESULT = {
  orderId: ORDER,
  orderNumber: 17,
  created: [
    {
      purchaseOrderId: PO,
      poNumber: 'PO-2026-0044',
      supplierId: null,
      lineCount: 1,
      units: 10,
      lines: [{ itemId: ITEM, quantity: 10 }],
    },
  ],
  replay: false,
};

const BODY = { lines: [{ itemId: ITEM, quantity: 10 }], idempotencyKey: 'shortfall-k1' };

describe('draftOrderShortfallPos (F2-5, phone)', () => {
  it('POSTs the chosen lines and the key to the shortfall-po route, and reads the answer with core', async () => {
    apiMock.api.mockResolvedValueOnce({ result: RESULT });
    await expect(draftOrderShortfallPos(ORDER, BODY)).resolves.toEqual(RESULT);
    expect(apiMock.api).toHaveBeenCalledWith(`/api/v1/orders/${ORDER}/shortfall-po`, {
      method: 'POST',
      body: BODY,
    });
  });

  it('a replay (the same request’s key) is the first answer, said as such', async () => {
    apiMock.api.mockResolvedValueOnce({ result: { ...RESULT, replay: true } });
    await expect(draftOrderShortfallPos(ORDER, BODY)).resolves.toMatchObject({ replay: true, created: RESULT.created });
  });

  it('keys it does not know are ignored (a later additive change never breaks this build)', async () => {
    apiMock.api.mockResolvedValueOnce({ result: { ...RESULT, later: 1 }, extra: true });
    await expect(draftOrderShortfallPos(ORDER, BODY)).resolves.toEqual(RESULT);
  });

  it('an answer it cannot read, or one about another order, is an error, never a guessed result', async () => {
    for (const res of [
      {},
      { result: null },
      { result: { ...RESULT, created: 'x' } },
      { result: { ...RESULT, replay: undefined } },
      { result: { ...RESULT, orderId: '44444444-4444-4444-8444-444444444444' } },
    ]) {
      apiMock.api.mockResolvedValueOnce(res);
      await expect(draftOrderShortfallPos(ORDER, BODY)).rejects.toBeInstanceOf(ShortfallPoResultShapeError);
    }
  });

  it('the order id matches whatever its case', async () => {
    apiMock.api.mockResolvedValueOnce({ result: { ...RESULT, orderId: ORDER.toUpperCase() } });
    await expect(draftOrderShortfallPos(ORDER, BODY)).resolves.toMatchObject({ orderId: ORDER.toUpperCase() });
  });

  it('a refusal reaches the caller as the api client threw it (status, details.reason)', async () => {
    const refusal = Object.assign(new Error('Stock or POs changed since you looked.'), {
      status: 409,
      details: { reason: 'shortfall_changed', current: { [ITEM]: 4 } },
    });
    apiMock.api.mockRejectedValueOnce(refusal);
    await expect(draftOrderShortfallPos(ORDER, BODY)).rejects.toBe(refusal);
  });
});

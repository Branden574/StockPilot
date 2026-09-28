import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HoldResultShapeError } from '@stockpilot/core';

import { holdOrderStock } from './orders-api';

// ./api reaches for expo-constants, AsyncStorage and the Supabase client at
// import time; hoisted mock as in maintenance-api.test.ts.
const apiMock = vi.hoisted(() => ({ api: vi.fn(async (..._args: unknown[]) => ({}) as unknown) }));
vi.mock('./api', () => apiMock);

beforeEach(() => apiMock.api.mockReset());

const ORDER = '11111111-1111-1111-1111-111111111111';

describe('holdOrderStock (F2-2 "Hold available stock", phone)', () => {
  it('POSTs the hold_stock transition and reads the answer with the core parser', async () => {
    apiMock.api.mockResolvedValueOnce({
      hold: {
        held: [{ itemId: 'i1', added: 8 }],
        stillShort: [{ itemId: 'i2', quantity: '6.0000' }],
        hiddenHeldItems: 0,
        hiddenShortItems: 1,
      },
    });
    await expect(holdOrderStock(ORDER)).resolves.toEqual({
      held: [{ itemId: 'i1', added: 8 }],
      stillShort: [{ itemId: 'i2', quantity: 6 }],
      hiddenHeldItems: 0,
      hiddenShortItems: 1,
    });
    expect(apiMock.api).toHaveBeenCalledWith(`/api/v1/orders/${ORDER}/transition`, {
      method: 'POST',
      body: { action: 'hold_stock' },
    });
  });

  it('an answer it cannot read is an error, never a guessed number', async () => {
    apiMock.api.mockResolvedValueOnce({ order: { id: ORDER } });
    await expect(holdOrderStock(ORDER)).rejects.toBeInstanceOf(HoldResultShapeError);
  });

  it("a refusal carries the server's message", async () => {
    apiMock.api.mockRejectedValueOnce(new Error('API 409: {"error":"conflict"}'));
    await expect(holdOrderStock(ORDER)).rejects.toThrow('API 409');
  });
});

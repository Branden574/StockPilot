import { beforeEach, describe, expect, it, vi } from 'vitest';

import { commitPartialFulfilment, partialFulfilmentAction } from './orders-api';

// ./api reaches for expo-constants, AsyncStorage and the Supabase client at
// import time; hoisted mock as in orders-api.hold.test.ts.
const apiMock = vi.hoisted(() => ({ api: vi.fn(async (..._args: unknown[]) => ({}) as unknown) }));
vi.mock('./api', () => apiMock);

beforeEach(() => apiMock.api.mockReset());

const ORDER = '11111111-1111-1111-1111-111111111111';

/**
 * The approve-partial sheet's confirm (F2-3) calls the EXISTING transitions,
 * unchanged: no new write path. Mutations caught: a new action name the route
 * does not know, or resume sent as approve_partial.
 */
describe('commitPartialFulfilment', () => {
  it('approve partial is the existing approve_partial transition', async () => {
    apiMock.api.mockResolvedValueOnce({ order: { id: ORDER } });
    await commitPartialFulfilment(ORDER, 'approve_partial');
    expect(apiMock.api).toHaveBeenCalledWith(`/api/v1/orders/${ORDER}/transition`, {
      method: 'POST',
      body: { action: 'approve_partial' },
    });
  });

  it('resume is the existing resume_fulfillment transition', async () => {
    apiMock.api.mockResolvedValueOnce({ order: { id: ORDER } });
    await commitPartialFulfilment(ORDER, 'resume');
    expect(apiMock.api).toHaveBeenCalledWith(`/api/v1/orders/${ORDER}/transition`, {
      method: 'POST',
      body: { action: 'resume_fulfillment' },
    });
    expect(partialFulfilmentAction('resume')).toEqual({ action: 'resume_fulfillment' });
    expect(partialFulfilmentAction('approve_partial')).toEqual({ action: 'approve_partial' });
  });

  it("a refusal carries the server's message (the sheet shows it in place)", async () => {
    apiMock.api.mockRejectedValueOnce(
      Object.assign(new Error('This order is no longer waiting for approval.'), { status: 409 }),
    );
    await expect(commitPartialFulfilment(ORDER, 'approve_partial')).rejects.toThrow(
      'This order is no longer waiting for approval.',
    );
  });
});

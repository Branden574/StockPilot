import { beforeEach, describe, expect, it, vi } from 'vitest';

import { postCycleCount } from './cycle-counts-api';

// ./api reaches for expo-constants, AsyncStorage and the Supabase client at
// import time, none of which exist under the node test environment. Same idiom
// as maintenance-api.test.ts / item-create.test.ts.
const apiMock = vi.hoisted(() => ({ api: vi.fn(async (..._args: unknown[]) => ({}) as unknown) }));
vi.mock('./api', () => apiMock);

beforeEach(() => apiMock.api.mockClear());

describe('postCycleCount (SP-055)', () => {
  it('POSTs the Bearer twin so the service runs the module gate, audit and webhook', async () => {
    apiMock.api.mockResolvedValueOnce({ ok: true, cycleCount: { id: 'cc-1' } });
    await postCycleCount('cc-1');
    expect(apiMock.api).toHaveBeenCalledWith('/api/v1/cycle-counts/cc-1/post', {
      method: 'POST',
    });
  });

  it('propagates the server refusal so the screen can show its message', async () => {
    apiMock.api.mockRejectedValueOnce(
      new Error('You do not have permission to post this cycle count.'),
    );
    await expect(postCycleCount('cc-1')).rejects.toThrow(
      'You do not have permission to post this cycle count.',
    );
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { listCycleCounts, postCycleCount } from './cycle-counts-api';

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

describe('listCycleCounts', () => {
  it('GETs one page of the server history for the view, passing the cancel signal', async () => {
    const ctrl = new AbortController();
    apiMock.api.mockResolvedValueOnce({ items: [], page: 2 });
    await listCycleCounts({ q: 'CC-42', status: 'completed', page: 2 }, { summary: true, signal: ctrl.signal });
    expect(apiMock.api).toHaveBeenCalledWith(
      '/api/v1/cycle-counts?q=CC-42&status=completed&page=2&summary=1',
      { signal: ctrl.signal },
    );
  });

  it('asks for page 1 without a page parameter and no summary unless asked', async () => {
    apiMock.api.mockResolvedValueOnce({ items: [], page: 1 });
    await listCycleCounts({ q: '  ', status: null, page: 1 });
    expect(apiMock.api).toHaveBeenCalledWith('/api/v1/cycle-counts', { signal: undefined });
  });
});

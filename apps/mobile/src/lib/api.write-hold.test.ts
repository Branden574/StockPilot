import { beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from './api';
import { writesInFlight } from './update-prompt-holds';

/**
 * api() counts every write while it is in flight (B44): the phone update's
 * Restart now waits for writes in flight, and its pop-up waits while any is,
 * because a restart cancels every request on the wire. The seams are
 * api.body-factory.test.ts's.
 */

vi.hoisted(() => {
  (globalThis as Record<string, unknown>).__DEV__ = true;
});

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(async () => 'org-b') },
}));
vi.mock('expo-constants', () => ({ default: { expoConfig: { extra: {} } } }));
vi.mock('./supabase', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({
        data: { session: { access_token: 't', user: { id: 'u1' } } },
      })),
    },
  },
}));
vi.mock('./account-eviction', () => ({ notifyUnauthorized: vi.fn() }));
vi.mock('./request-cancellation', () => ({ registerInFlight: vi.fn(() => vi.fn()) }));

let answer: (() => void) | null = null;
const fetchMock = vi.fn(
  () =>
    new Promise((resolve) => {
      answer = () =>
        resolve({ ok: true, status: 200, text: async () => '{}', json: async () => ({}) });
    }),
);

beforeEach(() => {
  answer = null;
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});

async function untilSent(): Promise<void> {
  for (let i = 0; i < 20 && fetchMock.mock.calls.length === 0; i += 1) {
    await new Promise((r) => setTimeout(r, 0));
  }
  expect(fetchMock).toHaveBeenCalledTimes(1);
}

describe('api() and writes in flight', () => {
  it.each(['POST', 'PATCH', 'DELETE'] as const)(
    'counts a %s from the call until it settles',
    async (method) => {
      const call = api('/api/v1/x', { method, body: { a: 1 } });
      expect(writesInFlight()).toBe(1);
      await untilSent();
      expect(writesInFlight()).toBe(1);
      answer!();
      await call;
      expect(writesInFlight()).toBe(0);
    },
  );

  it('never counts a GET', async () => {
    const call = api('/api/v1/x');
    expect(writesInFlight()).toBe(0);
    await untilSent();
    expect(writesInFlight()).toBe(0);
    answer!();
    await call;
    expect(writesInFlight()).toBe(0);
  });

  it('leaves nothing counted when the call throws before it is sent', async () => {
    const call = api('/api/v1/x', { method: 'POST', body: {}, asUserId: 'someone-else' });
    expect(writesInFlight()).toBe(1);
    await expect(call).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(writesInFlight()).toBe(0);
  });
});

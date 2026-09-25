import { beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from './api';

// vi.hoisted / vi.mock are hoisted above these imports by vitest's transform,
// so __DEV__ and the mocks are in place before api.ts loads.

/**
 * api() body FACTORY (server 0369). The cycle-count record says when it left
 * the phone (clientSentAt); the server places the offline capture at its own
 * arrival clock minus the gap between clientSentAt and capturedAt, so a stamp
 * taken before the credentials are read (a token refresh is a network round
 * trip) lands the capture that much later than the real count, where a pick
 * reads as before it. A factory is built after the headers, right before send.
 */

vi.hoisted(() => {
  (globalThis as Record<string, unknown>).__DEV__ = true;
});

const state = vi.hoisted(() => ({ sessionRead: false, orgRead: false }));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async () => {
      state.orgRead = true;
      return 'org-b';
    }),
  },
}));
vi.mock('expo-constants', () => ({ default: { expoConfig: { extra: {} } } }));
vi.mock('./supabase', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(async () => {
        // A slow session read (a token refresh).
        await new Promise((r) => setTimeout(r, 5));
        state.sessionRead = true;
        return { data: { session: { access_token: 't', user: { id: 'u1' } } } };
      }),
    },
  },
}));
vi.mock('./account-eviction', () => ({ notifyUnauthorized: vi.fn() }));
vi.mock('./request-cancellation', () => ({ registerInFlight: vi.fn(() => vi.fn()) }));

const fetchMock = vi.fn(async () => ({
  ok: true,
  status: 200,
  text: async () => '{}',
  json: async () => ({}),
}));

beforeEach(() => {
  state.sessionRead = false;
  state.orgRead = false;
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});

describe('api() body factory', () => {
  it('is built after the bearer and the workspace header are resolved, and sent as JSON', async () => {
    const seen: { sessionRead: boolean; orgRead: boolean }[] = [];
    await api('/api/v1/x', {
      method: 'POST',
      body: () => {
        seen.push({ sessionRead: state.sessionRead, orgRead: state.orgRead });
        return { clientSentAt: 'now' };
      },
    });
    // Mutation: build the body before the headers, and both read false.
    expect(seen).toEqual([{ sessionRead: true, orgRead: true }]);
    const init = (fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1];
    expect(JSON.parse(init.body)).toEqual({ clientSentAt: 'now' });
  });

  it('a plain body is sent unchanged', async () => {
    await api('/api/v1/x', { method: 'POST', body: { a: 1 } });
    const init = (fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1];
    expect(JSON.parse(init.body)).toEqual({ a: 1 });
  });
});

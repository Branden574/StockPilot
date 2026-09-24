import { beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from './api';
import { OutboxSessionChangedError } from './outbox-scope';

// vi.hoisted / vi.mock are hoisted above these imports by vitest's transform,
// so __DEV__ and the mocks are in place before api.ts loads.

/**
 * api() options the outbox relies on (S4a), executed against the real api.ts.
 *
 *   orgId     — a queued row is sent under the workspace it was queued in,
 *               not the one saved on the device when the drain runs.
 *   asUserId  — a queued row leaves only under the bearer of the account that
 *               queued it; the check reads the SAME session the token comes
 *               from, so nothing can change between the check and the send.
 */

vi.hoisted(() => {
  (globalThis as Record<string, unknown>).__DEV__ = true;
});

const state = vi.hoisted(() => ({
  storedOrg: 'org-b' as string | null,
  session: { access_token: 'token-u1', user: { id: 'u1' } } as null | {
    access_token: string;
    user: { id: string };
  },
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(async () => state.storedOrg) },
}));
vi.mock('expo-constants', () => ({ default: { expoConfig: { extra: {} } } }));
vi.mock('./supabase', () => ({
  supabase: { auth: { getSession: vi.fn(async () => ({ data: { session: state.session } })) } },
}));
vi.mock('./account-eviction', () => ({ notifyUnauthorized: vi.fn() }));
vi.mock('./request-cancellation', () => ({ registerInFlight: vi.fn(() => vi.fn()) }));

const fetchMock = vi.fn(async () => ({
  ok: true,
  status: 200,
  text: async () => '{}',
  json: async () => ({}),
}));

function sentHeaders(): Record<string, string> {
  const init = (
    fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string> }]
  )[1];
  return init.headers;
}

beforeEach(() => {
  state.storedOrg = 'org-b';
  state.session = { access_token: 'token-u1', user: { id: 'u1' } };
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});

describe('api() orgId', () => {
  it('without it, the saved workspace is sent (unchanged behaviour)', async () => {
    await api('/api/v1/x');
    expect(sentHeaders()['X-Organization-Id']).toBe('org-b');
  });

  it('overrides the saved workspace: a row queued in org A goes to org A while org B is active', async () => {
    await api('/api/v1/x', { orgId: 'org-a' });
    expect(sentHeaders()['X-Organization-Id']).toBe('org-a');
  });

  it('null falls back to the saved workspace', async () => {
    await api('/api/v1/x', { orgId: null });
    expect(sentHeaders()['X-Organization-Id']).toBe('org-b');
  });
});

describe('api() asUserId', () => {
  it('sends when the live session is that account', async () => {
    await api('/api/v1/x', { asUserId: 'u1' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentHeaders().Authorization).toBe('Bearer token-u1');
  });

  it('refuses BEFORE anything leaves when another account is signed in', async () => {
    state.session = { access_token: 'token-u2', user: { id: 'u2' } };
    await expect(api('/api/v1/x', { asUserId: 'u1' })).rejects.toBeInstanceOf(
      OutboxSessionChangedError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses when nobody is signed in', async () => {
    state.session = null;
    await expect(api('/api/v1/x', { asUserId: 'u1' })).rejects.toBeInstanceOf(
      OutboxSessionChangedError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

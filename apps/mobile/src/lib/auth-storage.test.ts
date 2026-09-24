import { createClient, GoTrueClient, isAuthRetryableFetchError } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  authStorageKeyFor,
  readStoredAuthSession,
  storedSessionUserId,
  type AuthStorageReader,
} from './auth-storage';
import { endSession } from './sign-out-flow';

/**
 * WHO HOLDS THE SESSION, read from storage (auth-storage.ts).
 *
 * The S4 review reproduced, against the auth-js 2.105.1 dist this app
 * resolves, that getSession() answers "no session" for an access token it
 * could not refresh offline while the session stays stored, and that
 * signOut() then fails without removing it. The real GoTrueClient runs below
 * (fake timers stand in for its ~25 s retry backoff), so the premise every
 * fix rests on is itself under test: if a later auth-js changes it, this file
 * says so.
 */

const URL_ = 'https://abcdefghijklmnopqrst.supabase.co';
const KEY = authStorageKeyFor(URL_);

describe('authStorageKeyFor = the key supabase-js already uses (passing it moved no session)', () => {
  it.each([
    'https://abcdefghijklmnopqrst.supabase.co',
    'https://abcdefghijklmnopqrst.supabase.co/',
    'http://127.0.0.1:54321',
    'http://192.168.1.20:54321',
    'https://api.example.com',
  ])('%s', (url) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const client = createClient(url, 'anon-key', {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    });
    warn.mockRestore();
    const defaultKey = (client.auth as unknown as { storageKey: string }).storageKey;
    expect(defaultKey).toMatch(/^sb-.+-auth-token$/);
    expect(authStorageKeyFor(url)).toBe(defaultKey);
  });
});

describe('storedSessionUserId', () => {
  const session = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      access_token: 'a',
      refresh_token: 'r',
      expires_at: 1,
      user: { id: 'u1' },
      ...over,
    });

  it('reads the user of a session auth-js would accept', () => {
    expect(storedSessionUserId(session())).toBe('u1');
  });

  it('has no owner for anything auth-js would discard or cannot attribute', () => {
    expect(storedSessionUserId(null)).toBeNull();
    expect(storedSessionUserId('not json')).toBeNull();
    expect(storedSessionUserId('"a string"')).toBeNull();
    expect(storedSessionUserId(JSON.stringify({ access_token: 'a', expires_at: 1, user: { id: 'u1' } }))).toBeNull();
    expect(storedSessionUserId(session({ user: null }))).toBeNull();
    expect(storedSessionUserId(session({ user: { id: 7 } }))).toBeNull();
    expect(storedSessionUserId(session({ user: { id: '' } }))).toBeNull();
  });
});

describe('readStoredAuthSession', () => {
  const reader = (head: string | null, full: string | null): AuthStorageReader => ({
    head: vi.fn(async () => head),
    full: vi.fn(async () => full),
  });
  const valid = JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_at: 1, user: { id: 'u1' } });

  it('no head entry: no session', async () => {
    expect(await readStoredAuthSession(reader(null, null), KEY)).toEqual({ present: false, userId: null });
  });

  it('a head entry: a session, and whose', async () => {
    expect(await readStoredAuthSession(reader(valid, valid), KEY)).toEqual({ present: true, userId: 'u1' });
  });

  it('a head entry whose chunks are mid-rewrite: still a session, owner not known right now', async () => {
    expect(await readStoredAuthSession(reader('__chunked:2', null), KEY)).toEqual({
      present: true,
      userId: null,
    });
  });

  it('rejects when storage cannot be read (the caller chooses the safe direction)', async () => {
    const broken: AuthStorageReader = {
      head: async () => {
        throw new Error('keychain locked');
      },
      full: async () => null,
    };
    await expect(readStoredAuthSession(broken, KEY)).rejects.toThrow('keychain locked');
  });
});

describe('against the real auth-js client: the stored session is the truth getSession() cannot tell offline', () => {
  const store = new Map<string, string>();
  const memory = {
    getItem: async (k: string) => store.get(k) ?? null,
    setItem: async (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: async (k: string) => {
      store.delete(k);
    },
  };
  const reader: AuthStorageReader = { head: memory.getItem, full: memory.getItem };
  const user = {
    id: 'u1',
    aud: 'authenticated',
    app_metadata: {},
    user_metadata: {},
    created_at: '2026-09-24T00:00:00Z',
  };
  const net = { mode: 'offline' as 'offline' | 'online' | 'refused' };
  const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
    if (net.mode === 'offline') throw new TypeError('Network request failed');
    const url = String(input);
    if (url.includes('grant_type=refresh_token')) {
      if (net.mode === 'refused') {
        return new Response(
          JSON.stringify({ error: 'invalid_grant', error_description: 'Refresh Token Not Found' }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        );
      }
      const now = Math.floor(Date.now() / 1000);
      return new Response(
        JSON.stringify({
          access_token: 'new.a.b',
          refresh_token: 'r2',
          token_type: 'bearer',
          expires_in: 3600,
          expires_at: now + 3600,
          user,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };

  /** A session stored `expiresInS` from now (negative: already expired). */
  async function clientWithSession(expiresInS: number): Promise<GoTrueClient> {
    const now = Math.floor(Date.now() / 1000);
    store.set(
      KEY,
      JSON.stringify({
        access_token: 'x.y.z',
        refresh_token: 'r',
        token_type: 'bearer',
        expires_in: 3600,
        expires_at: now + expiresInS,
        user,
      }),
    );
    const client = new GoTrueClient({
      url: 'http://127.0.0.1:9',
      storage: memory,
      storageKey: KEY,
      autoRefreshToken: false,
      persistSession: true,
      detectSessionInUrl: false,
      fetch: fetchImpl,
    });
    await settle(client.initialize());
    return client;
  }

  /** Await an auth-js call, running its retry backoff on the fake clock. */
  async function settle<T>(p: Promise<T>): Promise<T> {
    await vi.advanceTimersByTimeAsync(60_000);
    return p;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    store.clear();
    net.mode = 'offline';
    // auth-js logs every failed retry; the assertions below say what happened.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('expired + offline: getSession() says "no session" while the session is still stored', async () => {
    const client = await clientWithSession(-30);
    const { data, error } = await settle(client.getSession());
    expect(data.session).toBeNull();
    expect(isAuthRetryableFetchError(error)).toBe(true);
    // ...yet the session never left the device:
    expect(await readStoredAuthSession(reader, KEY)).toEqual({ present: true, userId: 'u1' });
  });

  it('expired + offline: a local sign-out fails and keeps the session, and endSession says so', async () => {
    const client = await clientWithSession(-30);
    const ended = await settle(
      endSession(
        {
          signOut: (scope) => client.signOut({ scope }),
          hasSession: async () => (await readStoredAuthSession(reader, KEY)).present,
        },
        'local',
      ),
    );
    expect(ended).toBe(false);
    expect(store.has(KEY)).toBe(true);
    // The read the app used to make would have called that an ended session.
    expect((await settle(client.getSession())).data.session).toBeNull();

    // And it was never over: with the network back, the same account returns.
    net.mode = 'online';
    expect((await settle(client.getSession())).data.session?.user.id).toBe('u1');
  });

  it('online: the sign-out removes the stored session, and endSession reports it ended', async () => {
    const client = await clientWithSession(3600);
    net.mode = 'online';
    const ended = await settle(
      endSession(
        {
          signOut: (scope) => client.signOut({ scope }),
          hasSession: async () => (await readStoredAuthSession(reader, KEY)).present,
        },
        'local',
      ),
    );
    expect(ended).toBe(true);
    expect(await readStoredAuthSession(reader, KEY)).toEqual({ present: false, userId: null });
  });

  it('a refresh the server REFUSED really ends the session: nothing is left stored', async () => {
    const client = await clientWithSession(-30);
    net.mode = 'refused';
    const { data } = await settle(client.getSession());
    expect(data.session).toBeNull();
    expect(await readStoredAuthSession(reader, KEY)).toEqual({ present: false, userId: null });
  });

  it('a valid token: the stored read and getSession() agree', async () => {
    const client = await clientWithSession(3600);
    const { data } = await settle(client.getSession());
    expect(data.session?.user.id).toBe('u1');
    expect((await readStoredAuthSession(reader, KEY)).userId).toBe('u1');
  });
});

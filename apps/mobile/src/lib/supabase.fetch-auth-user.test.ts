import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * fetchAuthUser (supabase.ts): the request the phone sends to ask the Auth
 * server about its session before it acts on a "signed out from another
 * device" message (session-check.ts). A wrong address or a missing header
 * gets an answer with no session code from the gateway, which reads as no
 * answer: the phone would then never act on a real sign-out from another
 * device until its token could no longer be refreshed. So the request is
 * pinned to the one auth-js itself sends for getUser(token), on the real
 * client this module creates (only the Keychain is faked).
 */

const project = vi.hoisted(() => {
  const address = 'https://project-ref.example.test';
  const publicValue = 'public-value-for-tests';
  process.env.EXPO_PUBLIC_SUPABASE_URL = address;
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = publicValue;
  return { address, publicValue };
});

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: vi.fn(async () => undefined),
}));
vi.mock('react-native-url-polyfill/auto', () => ({}));

import { fetchAuthUser, supabase } from './supabase';

type Sent = { url: string; method: string; headers: Record<string, string>; signal?: unknown };

function recordingFetch(sent: Sent[]) {
  return vi.fn(async (input: unknown, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    sent.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(headers.entries()),
      signal: init?.signal,
    });
    return new Response(JSON.stringify({ id: 'u1' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchAuthUser', () => {
  it('GETs <project>/auth/v1/user with the public key, the token as the bearer and the API version', async () => {
    const sent: Sent[] = [];
    vi.stubGlobal('fetch', recordingFetch(sent));
    const ctrl = new AbortController();
    const res = await fetchAuthUser('access-1', ctrl.signal);
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      url: `${project.address}/auth/v1/user`,
      method: 'GET',
      headers: {
        apikey: project.publicValue,
        authorization: 'Bearer access-1',
        'x-supabase-api-version': '2024-01-01',
      },
      signal: ctrl.signal,
    });
  });

  it('is the request auth-js sends for getUser(token): same address, key, bearer and API version', async () => {
    const ours: Sent[] = [];
    vi.stubGlobal('fetch', recordingFetch(ours));
    await fetchAuthUser('access-1', new AbortController().signal);

    const theirs: Sent[] = [];
    vi.stubGlobal('fetch', recordingFetch(theirs));
    const { data } = await supabase.auth.getUser('access-1');
    expect(data.user).not.toBeNull();
    expect(theirs).toHaveLength(1);

    const pick = (s: Sent) => ({
      url: s.url,
      method: s.method,
      apikey: s.headers.apikey,
      authorization: s.headers.authorization,
      version: s.headers['x-supabase-api-version'],
    });
    expect(pick(ours[0]!)).toEqual(pick(theirs[0]!));
  });
});

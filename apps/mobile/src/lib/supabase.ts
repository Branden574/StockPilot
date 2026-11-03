import * as SecureStore from 'expo-secure-store';
import { createClient } from '@supabase/supabase-js';
import 'react-native-url-polyfill/auto';

import { authStorageKeyFor, readStoredAuthSession, type StoredAuthSession } from './auth-storage';
import { writeTrackingFetch } from './update-prompt-holds';

import type { Database } from '@stockpilot/core';

const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
const anon = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
if (!url || !anon) {
  throw new Error(
    'Missing EXPO_PUBLIC_SUPABASE_URL or EXPO_PUBLIC_SUPABASE_ANON_KEY. Set them in apps/mobile/.env.local',
  );
}

/**
 * SecureStore-backed storage adapter for the Supabase auth session.
 *
 * SecureStore has a 2 KB per-key cap (a Keychain attribute limit on
 * iOS). Supabase's modern session JSON (refresh token + access token
 * + user payload) now sits around 2.5–3 KB, which trips the SDK's
 * "Value being stored in SecureStore is larger than 2048 bytes…"
 * warning and is documented to throw in a future expo-secure-store
 * release.
 *
 * We chunk values >1900 bytes into `<key>.0`, `<key>.1`, … entries
 * and stamp the original key with a tiny manifest (`__chunked:N`)
 * that tells `getItem` how many chunks to reassemble. Reads stay
 * compatible with sessions written by the legacy single-key adapter:
 * if the stamp isn't present, the raw value is returned as-is.
 */
const CHUNK_SIZE = 1900;
const CHUNK_PREFIX = '__chunked:';

// Sweeps any previously-written chunk entries for `key` so a shrinking
// rewrite doesn't leave orphan tail chunks. We stop at the first
// missing index — chunk writes are sequential so a gap means no more.
async function clearChunks(key: string): Promise<void> {
  for (let i = 0; i < 64; i++) {
    const k = `${key}.${i}`;
    const v = await SecureStore.getItemAsync(k);
    if (v === null) break;
    await SecureStore.deleteItemAsync(k);
  }
}

const ExpoSecureStoreAdapter = {
  async getItem(key: string): Promise<string | null> {
    const head = await SecureStore.getItemAsync(key);
    if (head === null) return null;
    if (!head.startsWith(CHUNK_PREFIX)) return head;
    const count = Number.parseInt(head.slice(CHUNK_PREFIX.length), 10);
    if (!Number.isFinite(count) || count <= 0) return null;
    const parts: string[] = [];
    for (let i = 0; i < count; i++) {
      const piece = await SecureStore.getItemAsync(`${key}.${i}`);
      if (piece === null) return null;
      parts.push(piece);
    }
    return parts.join('');
  },
  async setItem(key: string, value: string): Promise<void> {
    if (value.length <= CHUNK_SIZE) {
      await clearChunks(key);
      await SecureStore.setItemAsync(key, value);
      return;
    }
    const chunks: string[] = [];
    for (let i = 0; i < value.length; i += CHUNK_SIZE) {
      chunks.push(value.slice(i, i + CHUNK_SIZE));
    }
    await clearChunks(key);
    await SecureStore.setItemAsync(key, `${CHUNK_PREFIX}${chunks.length}`);
    for (let i = 0; i < chunks.length; i++) {
      await SecureStore.setItemAsync(`${key}.${i}`, chunks[i]);
    }
  },
  async removeItem(key: string): Promise<void> {
    await clearChunks(key);
    await SecureStore.deleteItemAsync(key);
  },
};

/**
 * The key the session is persisted under. Exactly supabase-js's own default
 * for this URL (auth-storage.test.ts pins that), passed explicitly so the
 * client and readDeviceAuthSession() below read and write the same entry by
 * construction rather than by coincidence.
 */
const AUTH_STORAGE_KEY = authStorageKeyFor(url);

export const supabase = createClient<Database>(url, anon, {
  auth: {
    storage: ExpoSecureStoreAdapter as never,
    storageKey: AUTH_STORAGE_KEY,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
  // Every request but a GET or a HEAD (row and storage writes, RPC calls, a
  // token refresh) counts as a write in flight: the phone update's Restart
  // now waits for it, since a restart cancels it (update-prompt-holds.ts).
  global: { fetch: writeTrackingFetch },
});

/**
 * The session persisted on this device and whose it is, WITHOUT a refresh
 * (auth-storage.ts explains why getSession() cannot answer this offline).
 * Rejects when SecureStore cannot be read.
 */
export function readDeviceAuthSession(): Promise<StoredAuthSession> {
  return readStoredAuthSession(
    { head: (key) => SecureStore.getItemAsync(key), full: (key) => ExpoSecureStoreAdapter.getItem(key) },
    AUTH_STORAGE_KEY,
  );
}

// The project's /auth/v1/user, resolved as supabase-js resolves its Auth
// address (SupabaseClient: new URL('auth/v1', the URL with a trailing slash)),
// and its public key, for the function below.
const AUTH_USER_URL = new URL(
  'auth/v1/user',
  url.trim().endsWith('/') ? url.trim() : `${url.trim()}/`,
).href;
const PROJECT_PUBLIC_KEY: string = anon;

/**
 * Ask the Auth server whether it still accepts an access token: GET
 * /auth/v1/user, OUTSIDE auth-js, so the answer changes nothing on this device
 * (session-check.ts). auth-js's own getUser() removes the session from the
 * device when the server answers session_not_found, even with the token passed
 * in (auth-js 2.105.1 GoTrueClient.js:2480-2511), and the caller has to keep
 * it there for what it does next.
 *
 * The request auth-js itself makes for getUser(): the project's public key,
 * the token as the bearer, and the API version that makes the server name its
 * error codes (auth-js lib/fetch.js _request). Rejects when the request cannot
 * be made or is aborted.
 */
export function fetchAuthUser(accessToken: string, signal: AbortSignal): Promise<Response> {
  return fetch(AUTH_USER_URL, {
    method: 'GET',
    headers: {
      apikey: PROJECT_PUBLIC_KEY,
      Authorization: `Bearer ${accessToken}`,
      'X-Supabase-Api-Version': '2024-01-01',
    },
    signal,
  });
}

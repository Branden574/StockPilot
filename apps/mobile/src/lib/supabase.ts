import * as SecureStore from 'expo-secure-store';
import { createClient } from '@supabase/supabase-js';
import 'react-native-url-polyfill/auto';

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

export const supabase = createClient<Database>(url, anon, {
  auth: {
    storage: ExpoSecureStoreAdapter as never,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});

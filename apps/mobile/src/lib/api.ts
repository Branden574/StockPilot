import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';

import { supabase } from './supabase';

/**
 * Resolve the API base URL once at module load. We deliberately fall
 * through three sources and ONLY accept localhost in dev (`__DEV__`):
 *   1. Expo runtime config `extra.apiUrl` (set in app.config.ts at
 *      build time)
 *   2. EXPO_PUBLIC_API_URL inlined into the bundle
 *   3. localhost — only when `__DEV__` is true
 *
 * Without the dev-only gate, a release build that forgot the env var
 * would ship with `http://localhost:3000` baked in and try to talk
 * to the developer's machine. Better to crash loudly at startup than
 * to silently fail every API call (or worse, to actually reach a
 * local dev server on the user's network).
 */
// Hardcoded production fallback. A release build/OTA must NEVER talk to
// localhost — this guards the OTA footgun where `eas update` is run WITHOUT
// EXPO_PUBLIC_API_URL set, so app.config.ts defaults extra.apiUrl to
// http://localhost:3000 and bakes it into the JS bundle. That broke every API
// call (and the scan→/orders/sign URL) on prod devices until republished.
const PROD_API_FALLBACK = 'https://stockpilotusa.com';

function resolveApiUrl(): string {
  const fromExtra = (Constants.expoConfig?.extra as { apiUrl?: string } | undefined)?.apiUrl;
  const fromEnv = process.env.EXPO_PUBLIC_API_URL;
  const candidate = (fromExtra || fromEnv || '').trim();
  const isLocalhost = /\/\/(localhost|127\.0\.0\.1)/i.test(candidate);

  // In a release, a missing OR localhost candidate is a misconfiguration —
  // use the known prod host instead of poisoning the bundle with localhost.
  if (!__DEV__ && (!candidate || isLocalhost)) return PROD_API_FALLBACK;
  if (candidate.length > 0) return candidate;
  if (__DEV__) return 'http://localhost:3000';
  return PROD_API_FALLBACK;
}

const API_URL = resolveApiUrl();

interface ApiOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
}

async function authHeader(): Promise<Record<string, string>> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) return {};
  return { Authorization: `Bearer ${session.access_token}` };
}

export async function api<T>(path: string, opts: ApiOptions = {}): Promise<T> {
  // Scope every request to the active workspace org. The server (withApiContext)
  // validates membership and 401s on a bad value. Key MUST match
  // ORG_STORAGE_KEY in use-workspace.ts ('workspace.activeOrgId') — kept as a
  // literal here to avoid importing use-workspace (which would create a cycle:
  // use-workspace → sync → api).
  const orgId = await AsyncStorage.getItem('workspace.activeOrgId');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(await authHeader()),
    ...(orgId ? { 'X-Organization-Id': orgId } : {}),
  };

  const res = await fetch(`${API_URL}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${res.status}: ${text || res.statusText}`);
  }
  return (await res.json()) as T;
}

export const API_BASE = API_URL;

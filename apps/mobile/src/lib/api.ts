import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';

import { notifyUnauthorized } from './account-eviction';
import { registerInFlight } from './request-cancellation';
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

/**
 * Typed API failure. The app used to throw a bare Error with the message only,
 * so no caller could tell a 401 from a 500 — which is why nothing signed out on
 * auth failure and why the offline outbox retried a permanently rejected write
 * forever.
 *
 * `message` is unchanged from the previous behaviour and remains the ONLY thing
 * that should ever be shown to a person; `status` and `code` are for control
 * flow. `code` is whatever our JSON body put in `error`; most routes send a
 * machine code (`'unauthenticated'`, `'internal_error'`), a few still send a
 * sentence (`'isbn is required'`), so treat it as a HINT and never render it —
 * and never key a permanent-failure decision off it. HTTP status is the only
 * uniformly trustworthy field.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  /**
   * The server's APP-AUTHORED `details` blob, when it sent one.
   *
   * Our routes forward `ServiceError.details` for every code EXCEPT
   * internal_error (whose detail is raw DB text — S13), so this is always
   * structured metadata a screen may act on: today, the book-crate confirmation
   * payload a put-away re-asks from. Without it the caller sees a sentence and
   * a question it cannot answer, which is exactly why the transfer route used
   * to skip the gate entirely.
   */
  readonly details?: unknown;

  constructor(message: string, status: number, code?: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

interface ApiOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  /** Per-request timeout override in ms. Defaults to DEFAULT_TIMEOUT_MS. */
  timeoutMs?: number;
}

// React Native's fetch has NO default timeout. A half-open TCP / captive-portal
// / dead-air socket that accepts the connection but never replies leaves the
// promise pending forever. That not only strands a screen on a permanent
// spinner, it wedges the whole sync engine: syncNow()'s single-flight guard
// (sync.ts) never clears its in-flight promise, so every later sync tick returns
// the same stuck promise and queued offline writes never drain for the session.
// We therefore compose an internal AbortController timeout into every request so
// it is ALWAYS guaranteed to settle.
const DEFAULT_TIMEOUT_MS = 20_000;

async function authHeader(): Promise<Record<string, string>> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) return {};
  return { Authorization: `Bearer ${session.access_token}` };
}

/**
 * The active-workspace header, for the handful of screens that call `fetch`
 * or `postMultipart` directly (multipart uploads, streaming chat) instead of
 * `api()`. Without it the server falls back to the user's DEFAULT org, so a
 * multi-org user's AI-scan counts, PO scans and chat questions resolved
 * against the wrong workspace. Key MUST match ORG_STORAGE_KEY in
 * use-workspace.ts ('workspace.activeOrgId') — kept as a literal here to avoid
 * importing use-workspace (which would create a cycle: use-workspace → sync →
 * api). Every raw call site is pinned to spread this by
 * org-header-wiring.test.ts.
 */
export async function orgHeader(): Promise<Record<string, string>> {
  const orgId = await AsyncStorage.getItem('workspace.activeOrgId');
  return orgId ? { 'X-Organization-Id': orgId } : {};
}

export async function api<T>(path: string, opts: ApiOptions = {}): Promise<T> {
  // Scope every request to the active workspace org. The server (withApiContext)
  // validates membership and 401s on a bad value.
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(await authHeader()),
    ...(await orgHeader()),
  };

  // Internal timeout, composed with any caller-supplied signal. Either firing
  // aborts the fetch so the promise settles instead of hanging indefinitely.
  const ctrl = new AbortController();
  // Registered so an account eviction can cancel requests ALREADY on the wire:
  // one that lands after the credentials are cleared would repopulate a cache
  // the eviction just wiped. Released in `finally`, always.
  const releaseInFlight = registerInFlight(ctrl);
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const onCallerAbort = () => ctrl.abort();
  if (opts.signal) {
    if (opts.signal.aborted) ctrl.abort();
    else opts.signal.addEventListener('abort', onCallerAbort);
  }

  try {
    const res = await fetch(`${API_URL}${path}`, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: ctrl.signal,
    });

    if (!res.ok) {
      // NEVER echo the raw body. Our own API answers errors as
      // { error, message }, but anything that does not reach a route handler —
      // a 404 from the framework, an edge/bot challenge, a proxy error page —
      // answers with an HTML DOCUMENT. Echoing that put a full page of raw
      // markup on screen where a sentence belonged (seen in the simulator on
      // the staging screen, 2026-07-22). Read the body, use it ONLY when it
      // parses as our JSON error shape, and otherwise say something a person
      // can act on.
      const raw = await res.text().catch(() => '');
      let message: string | null = null;
      let code: string | undefined;
      let details: unknown;
      if (raw.trimStart().startsWith('{')) {
        try {
          const body = JSON.parse(raw) as {
            message?: unknown;
            error?: unknown;
            details?: unknown;
          };
          const m = typeof body.message === 'string' ? body.message : null;
          const e = typeof body.error === 'string' ? body.error : null;
          message = m ?? e;
          code = e ?? undefined;
          // Carried through UNINSPECTED — the shape is the caller's business,
          // and every consumer narrows it before rendering.
          details = body.details;
        } catch {
          message = null;
        }
      }
      if (!message) {
        message =
          res.status === 401 || res.status === 403
            ? 'You do not have access to that.'
            : res.status === 404
              ? 'That is not available on this version of the app. Update the app and try again.'
              : res.status >= 500
                ? 'The server had a problem. Try again in a moment.'
                : `Request failed (${res.status}).`;
      }
      // A 401 is the app's earliest reliable signal that the account was
      // disabled while the device was offline or missed the broadcast — but the
      // server will NOT say so (it answers a uniform 401 on purpose), so this
      // only ASKS for a probe. The bus filters to 401 (a 403 is a permission
      // answer, not an identity one), throttles to one getUser() per burst, and
      // never throws back into this path.
      notifyUnauthorized({ status: res.status });
      throw new ApiError(message, res.status, code, details);
    }
    return (await res.json()) as T;
  } catch (err) {
    // Our timeout aborted (the caller did NOT cancel) → surface a clear,
    // retryable message instead of an opaque AbortError.
    if (ctrl.signal.aborted && !(opts.signal && opts.signal.aborted)) {
      throw new Error('Request timed out. Check your connection and try again.');
    }
    throw err;
  } finally {
    clearTimeout(timer);
    releaseInFlight();
    if (opts.signal) opts.signal.removeEventListener('abort', onCallerAbort);
  }
}

export const API_BASE = API_URL;

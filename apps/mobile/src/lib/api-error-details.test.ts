import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The API client must carry a route's APP-AUTHORED `details` blob through to
 * the caller.
 *
 * Without it a screen can only REPORT a refusal, never re-ask it — and that was
 * the stated reason POST /api/v1/items/<id>/transfer ran neither the book-crate
 * gate nor the reconciliation, so a book put away from the phone got no
 * book_crate_* written at all. The put-away sheet now renders the refusal and
 * retries with a scoped acknowledgement; this is the wire that makes it
 * possible.
 *
 * `message` behaviour is unchanged and re-pinned here, because the details blob
 * must never start leaking into what a person is shown.
 */

// The module resolves its base URL AT LOAD and reads React Native's __DEV__,
// so this has to run before the import below — hence vi.hoisted, not a plain
// stubGlobal in the body.
vi.hoisted(() => {
  (globalThis as Record<string, unknown>).__DEV__ = true;
});

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(async () => null) },
}));
vi.mock('expo-constants', () => ({ default: { expoConfig: { extra: {} } } }));
vi.mock('./supabase', () => ({ supabase: { auth: { getSession: vi.fn(async () => ({ data: { session: null } })) } } }));
vi.mock('./account-eviction', () => ({ notifyUnauthorized: vi.fn() }));
vi.mock('./request-cancellation', () => ({ registerInFlight: vi.fn(() => vi.fn()) }));

import { notifyUnauthorized } from './account-eviction';
import { api, ApiError } from './api';

function respondWith(status: number, body: string) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
      json: async () => JSON.parse(body),
    })),
  );
}

const REFUSAL = JSON.stringify({
  error: 'conflict',
  message: 'Persepolis is recorded in Blue 4.',
  details: {
    reason: 'BOOK_CRATE_CHANGE_REQUIRES_CONFIRMATION',
    items: [
      {
        itemId: 'i1',
        itemName: 'Persepolis',
        currentLabel: 'Blue 4',
        nextLabel: null,
        currentFingerprint: '["blue","4"]',
      },
    ],
  },
});

beforeEach(() => vi.clearAllMocks());

describe('ApiError carries the structured refusal', () => {
  it('exposes `details` so a caller can re-ask the question', async () => {
    respondWith(409, REFUSAL);
    const err = await api('/api/v1/items/i1/transfer', { method: 'POST', body: {} }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    const e = err as ApiError;
    expect(e.status).toBe(409);
    expect(e.code).toBe('conflict');
    expect(e.details).toMatchObject({ reason: 'BOOK_CRATE_CHANGE_REQUIRES_CONFIRMATION' });
    // …and the message stays the sentence a person is shown, blob or no blob.
    expect(e.message).toBe('Persepolis is recorded in Blue 4.');
  });

  it('leaves `details` undefined when the route sent none', async () => {
    respondWith(400, JSON.stringify({ error: 'validation_error', message: 'Nope.' }));
    const e = (await api('/x', { method: 'POST', body: {} }).catch((x: unknown) => x)) as ApiError;
    expect(e.details).toBeUndefined();
    expect(e.message).toBe('Nope.');
  });

  it('an HTML error page is still never echoed, and carries no details', async () => {
    // A framework 404 / edge bot challenge answers with a whole document. It
    // used to be put on screen verbatim (simulator, 2026-07-22).
    respondWith(404, '<!doctype html><html><body>Not found</body></html>');
    const e = (await api('/x').catch((x: unknown) => x)) as ApiError;
    expect(e.message).not.toContain('<');
    expect(e.details).toBeUndefined();
  });
});

// The body reader and the sentences moved to api-error-body.ts (docket B75),
// so the AI chat reads a refusal as api() does. api() words every failure as
// it did: the message, else the code, else the status sentence; an empty
// message counts as none.
describe('api() words a failure as before the reader moved', () => {
  it('a code without a message: the code, as before', async () => {
    respondWith(400, JSON.stringify({ error: 'validation_error' }));
    const e = (await api('/x', { method: 'POST', body: {} }).catch((x: unknown) => x)) as ApiError;
    expect(e).toBeInstanceOf(ApiError);
    expect(e.message).toBe('validation_error');
    expect(e.code).toBe('validation_error');
  });

  it('an empty message at 500: the server sentence', async () => {
    respondWith(500, '{"message":""}');
    const e = (await api('/x').catch((x: unknown) => x)) as ApiError;
    expect(e.message).toBe('The server had a problem. Try again in a moment.');
    expect(e.code).toBeUndefined();
  });

  it('an empty body at 403: the access sentence', async () => {
    respondWith(403, '');
    const e = (await api('/x').catch((x: unknown) => x)) as ApiError;
    expect(e.status).toBe(403);
    expect(e.message).toBe('You do not have access to that.');
  });

  // The bus probes only on a 401 (account-eviction.ts); api() hands it every
  // refusal's status.
  it('a 401 is handed to the account probe', async () => {
    respondWith(401, JSON.stringify({ error: 'unauthenticated' }));
    const e = (await api('/x').catch((x: unknown) => x)) as ApiError;
    expect(e.message).toBe('unauthenticated');
    expect(vi.mocked(notifyUnauthorized).mock.calls).toEqual([[{ status: 401 }]]);
  });
});

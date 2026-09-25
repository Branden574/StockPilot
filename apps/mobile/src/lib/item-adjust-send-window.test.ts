import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { submitItemAdjust } from './item-adjust';
import { UNCONFIRMED_SETTLE_MS, unconfirmedStock } from './unconfirmed-stock';

/**
 * REVIEW FINDING: the "may still land" window of an unconfirmed adjustment was
 * started when submitItemAdjust called post(), but api() first awaits the
 * session (authHeader). A token refresh there can take seconds, and the
 * request only leaves after it, so the window could close while the write
 * could still land. The window now starts when api() hands the request to
 * fetch (its onSend hook), and api()'s own timeout is armed in the same tick.
 *
 * This runs the REAL chain — submitItemAdjust -> adjustItemStock -> api() —
 * with only the platform edges stubbed (the session read, the org header,
 * fetch), so a slow session read is exercised where it actually happens.
 */

// api.ts resolves its base URL at load and reads React Native's __DEV__.
// vi.hoisted and vi.mock run before the imports above, whatever their place.
vi.hoisted(() => {
  (globalThis as Record<string, unknown>).__DEV__ = true;
});

const session = vi.hoisted(() => ({ refreshMs: 0 }));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(async () => null) },
}));
vi.mock('expo-constants', () => ({ default: { expoConfig: { extra: {} } } }));
vi.mock('./supabase', () => ({
  supabase: {
    auth: {
      // A session read that has to refresh the token first.
      getSession: vi.fn(
        () =>
          new Promise((resolve) =>
            setTimeout(
              () => resolve({ data: { session: { access_token: 'token' } } }),
              session.refreshMs,
            ),
          ),
      ),
    },
  },
}));
vi.mock('./account-eviction', () => ({ notifyUnauthorized: vi.fn() }));
vi.mock('./request-cancellation', () => ({ registerInFlight: vi.fn(() => vi.fn()) }));

const T0 = 1_000_000;
const REFRESH_MS = 5_000;
/** api()'s DEFAULT_TIMEOUT_MS. */
const API_TIMEOUT_MS = 20_000;

let fetchCalledAt: number[] = [];

/** A connection that accepts the request and never answers, until aborted. */
function hangingFetch() {
  return vi.fn(
    (_url: string, init: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        fetchCalledAt.push(Date.now());
        init.signal.addEventListener('abort', () => reject(new Error('Aborted')));
      }),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  session.refreshMs = REFRESH_MS;
  fetchCalledAt = [];
  unconfirmedStock.resetForTests();
});

afterEach(() => {
  unconfirmedStock.resetForTests();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('an unconfirmed adjustment is bounded from the hand-off to fetch, not the tap', () => {
  it('a 5 s token refresh before the send moves the window 5 s later', async () => {
    vi.stubGlobal('fetch', hangingFetch());

    const pending = submitItemAdjust('item-1', 1, { shownTotal: 10 });

    // During the refresh nothing has left the phone, but the write is already
    // registered, so a read now cannot be taken as proof of another write.
    await vi.advanceTimersByTimeAsync(REFRESH_MS - 1);
    expect(fetchCalledAt).toEqual([]);
    expect(unconfirmedStock.writes('item-1').size).toBe(1);
    expect(unconfirmedStock.get('item-1')).toBeNull();

    await vi.advanceTimersByTimeAsync(1);
    expect(fetchCalledAt).toEqual([T0 + REFRESH_MS]);

    // api()'s own timeout, counted from the same hand-off.
    await vi.advanceTimersByTimeAsync(API_TIMEOUT_MS);
    const out = await pending;

    expect(out.kind).toBe('unconfirmed');
    expect(unconfirmedStock.get('item-1')).toEqual({
      expectedTotal: 11,
      settlesAt: T0 + REFRESH_MS + UNCONFIRMED_SETTLE_MS,
      mayStillLand: true,
    });
  });

  it('a fast network failure after a slow refresh is bounded from the hand-off too', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        fetchCalledAt.push(Date.now());
        throw new TypeError('Network request failed');
      }),
    );

    const pending = submitItemAdjust('item-1', -2, { shownTotal: 10 });
    await vi.advanceTimersByTimeAsync(REFRESH_MS);
    const out = await pending;

    expect(out.kind).toBe('unconfirmed');
    expect(fetchCalledAt).toEqual([T0 + REFRESH_MS]);
    expect(unconfirmedStock.get('item-1')?.settlesAt).toBe(T0 + REFRESH_MS + UNCONFIRMED_SETTLE_MS);
  });

  it('a read sent just before the (correct) bound does not settle it', async () => {
    vi.stubGlobal('fetch', hangingFetch());
    const pending = submitItemAdjust('item-1', 1, { shownTotal: 10 });
    await vi.advanceTimersByTimeAsync(REFRESH_MS + API_TIMEOUT_MS);
    await pending;

    // Past a window counted from the TAP, but inside the one counted from the
    // hand-off: the write can still land, so the pre-write total proves nothing.
    unconfirmedStock.recordRead('item-1', 10, T0 + UNCONFIRMED_SETTLE_MS + 1);
    expect(unconfirmedStock.get('item-1')).not.toBeNull();
    unconfirmedStock.recordRead('item-1', 10, T0 + REFRESH_MS + UNCONFIRMED_SETTLE_MS);
    expect(unconfirmedStock.get('item-1')).toBeNull();
  });
});

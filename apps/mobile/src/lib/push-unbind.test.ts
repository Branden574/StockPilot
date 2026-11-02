import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unbinding this phone's push token at sign-out (S5, plans/S5.md 3.3 steps 2
 * and 4), run against the real push-unbind.ts and use-push-notifications.ts
 * with the native modules and the Supabase client faked.
 *
 * THE DEFECT. Nothing on the phone ever deleted its push_tokens row: a
 * deliberate sign-out ended the session and left the row bound to the account,
 * so a shared or handed-on phone kept showing that account's purchase order,
 * order and stock notifications on its lock screen for up to 120 days.
 * DELETE /api/v1/push/register said it "Lets the mobile app deregister on
 * sign-out"; nothing in the app called it.
 */

const h = vi.hoisted(() => ({
  store: new Map<string, string>(),
  storeFails: false,
  token: 'ExponentPushToken[test-token-1]',
  rpcGate: null as Promise<void> | null,
  rpc: vi.fn(),
  /** The delete: every call recorded, answered from `deleteAnswer`. */
  deletes: [] as {
    table: string;
    eq: unknown[][];
    select: unknown[];
    signal: AbortSignal | null;
    sent: number;
  }[],
  deleteAnswer: { data: [{ id: 'row-1' }], error: null } as { data: unknown; error: unknown },
  deleteGate: null as Promise<void> | null,
  deleteThrows: false,
  dismiss: vi.fn(async () => undefined),
}));

vi.mock('react', () => ({ useEffect: (fn: () => unknown) => fn() }));
vi.mock('react-native', () => ({
  Linking: { openURL: vi.fn(async () => undefined) },
  Platform: { OS: 'ios' },
}));
vi.mock('expo-constants', () => ({ default: { expoConfig: { extra: {} }, easConfig: null } }));
vi.mock('expo-device', () => ({ isDevice: true }));
vi.mock('expo-notifications', () => ({
  setNotificationHandler: vi.fn(),
  getPermissionsAsync: vi.fn(async () => ({ status: 'granted' })),
  requestPermissionsAsync: vi.fn(async () => ({ status: 'granted' })),
  setNotificationChannelAsync: vi.fn(async () => undefined),
  getExpoPushTokenAsync: vi.fn(async () => ({ data: h.token })),
  addNotificationResponseReceivedListener: vi.fn(() => ({ remove: vi.fn() })),
  dismissAllNotificationsAsync: () => h.dismiss(),
  AndroidImportance: { DEFAULT: 3 },
}));
vi.mock('./web-path-rewrite', () => ({ rewriteWebPath: (p: string) => p }));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (k: string) => {
      if (h.storeFails) throw new Error('storage unreadable');
      return h.store.get(k) ?? null;
    }),
    setItem: vi.fn(async (k: string, v: string) => {
      h.store.set(k, v);
    }),
  },
}));

/** A supabase-js delete builder: lazy, sent once per `then` (pattern #22). */
function deleteBuilder(table: string) {
  const call = {
    table,
    eq: [] as unknown[][],
    select: [] as unknown[],
    signal: null as AbortSignal | null,
    sent: 0,
  };
  h.deletes.push(call);
  const b = {
    eq: (...a: unknown[]) => {
      call.eq.push(a);
      return b;
    },
    select: (cols: unknown) => {
      call.select.push(cols);
      return b;
    },
    abortSignal: (s: AbortSignal) => {
      call.signal = s;
      return b;
    },
    then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
      call.sent += 1;
      const answer = (h.deleteGate ?? Promise.resolve()).then(() => {
        if (h.deleteThrows) throw new Error('Network request failed');
        return h.deleteAnswer;
      });
      return answer.then(resolve, reject);
    },
  };
  return b;
}

vi.mock('./supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => h.rpc(...args),
    from: (table: string) => ({ delete: () => deleteBuilder(table) }),
    auth: {
      mfa: {
        getAuthenticatorAssuranceLevel: vi.fn(async () => ({
          data: { currentLevel: 'aal2', nextLevel: 'aal2' },
          error: null,
        })),
      },
    },
  },
}));

import {
  clearDeliveredNotifications,
  deviceSignOutSteps,
  FALLBACK_UNBIND_TIMEOUT_MS,
  REVOKED_UNBIND_TIMEOUT_MS,
  SIGN_OUT_UNBIND_TIMEOUT_MS,
  unbindThisDevice,
} from './push-unbind';
import { PUSH_TOKEN_STORAGE_KEY, registerThisDevice } from './use-push-notifications';

const USER = { id: 'user-1' } as never;
const tick = () => new Promise((r) => setTimeout(r, 0));

function rpcBuilder() {
  return {
    then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
      return (h.rpcGate ?? Promise.resolve())
        .then(() => ({ data: null, error: null }))
        .then(resolve, reject);
    },
  };
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  h.store.clear();
  h.storeFails = false;
  h.rpcGate = null;
  h.rpc.mockReset();
  h.rpc.mockImplementation(() => rpcBuilder());
  h.deletes.length = 0;
  h.deleteAnswer = { data: [{ id: 'row-1' }], error: null };
  h.deleteGate = null;
  h.deleteThrows = false;
  h.dismiss.mockReset();
  h.dismiss.mockResolvedValue(undefined);
  warn?.mockRestore();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('unbindThisDevice', () => {
  it('deletes this phone’s row by the token it registered, and awaits the delete (pattern #22)', async () => {
    h.store.set(PUSH_TOKEN_STORAGE_KEY, h.token);
    expect(await unbindThisDevice({ timeoutMs: 1_000 })).toBe('deleted');
    expect(h.deletes).toHaveLength(1);
    const [del] = h.deletes;
    expect(del!.table).toBe('push_tokens');
    // By the token only: row level security (push_tokens_self) keeps it to the
    // caller's own row.
    expect(del!.eq).toEqual([['token', h.token]]);
    expect(del!.select).toEqual(['id']);
    expect(del!.signal).toBeInstanceOf(AbortSignal);
    // Sent exactly once: awaited, never voided.
    expect(del!.sent).toBe(1);
  });

  it('no token remembered: sends nothing', async () => {
    expect(await unbindThisDevice({ timeoutMs: 1_000 })).toBe('nothing-registered');
    expect(h.deletes).toHaveLength(0);
  });

  it('a row of this account that was not there (already rebound, or never written) is not an error', async () => {
    h.store.set(PUSH_TOKEN_STORAGE_KEY, h.token);
    h.deleteAnswer = { data: [], error: null };
    expect(await unbindThisDevice({ timeoutMs: 1_000 })).toBe('none');
  });

  it('waits for a registration in flight first, so the row it is writing is the row deleted', async () => {
    let answer!: () => void;
    h.rpcGate = new Promise<void>((r) => {
      answer = r;
    });
    // The phone's FIRST registration, so no token is remembered yet.
    const registering = registerThisDevice(USER);
    await tick();
    const unbinding = unbindThisDevice({ timeoutMs: 1_000 });
    await tick();
    expect(h.deletes).toHaveLength(0);
    answer();
    expect(await unbinding).toBe('deleted');
    expect(h.deletes[0]!.eq).toEqual([['token', h.token]]);
    await registering;
  });

  it('the wait is bounded at half the budget: a registration that does not answer still leaves time for the delete', async () => {
    h.store.set(PUSH_TOKEN_STORAGE_KEY, h.token);
    let answer!: () => void;
    h.rpcGate = new Promise<void>((r) => {
      answer = r;
    });
    const registering = registerThisDevice(USER);
    await tick();
    const started = Date.now();
    expect(await unbindThisDevice({ timeoutMs: 60 })).toBe('deleted');
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(h.deletes).toHaveLength(1);
    answer();
    await registering;
  });

  it('a delete that does not answer is abandoned at the budget, and its request aborted', async () => {
    h.store.set(PUSH_TOKEN_STORAGE_KEY, h.token);
    h.deleteGate = new Promise<void>(() => undefined);
    const started = Date.now();
    expect(await unbindThisDevice({ timeoutMs: 30 })).toBe('timed-out');
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(h.deletes[0]!.signal!.aborted).toBe(true);
  });

  it('never throws: a refused delete, a failed request, unreadable storage', async () => {
    h.store.set(PUSH_TOKEN_STORAGE_KEY, h.token);
    h.deleteAnswer = { data: null, error: { code: '42501', message: 'permission denied' } };
    expect(await unbindThisDevice({ timeoutMs: 1_000 })).toBe('failed');
    h.deleteThrows = true;
    expect(await unbindThisDevice({ timeoutMs: 1_000 })).toBe('failed');
    h.storeFails = true;
    expect(await unbindThisDevice({ timeoutMs: 1_000 })).toBe('failed');
    expect(warn).toHaveBeenCalled();
  });

  it('the budgets: 6 s at sign-out (the flow’s cap), 4 s for the fallbacks, 3 s when signed out from another device', () => {
    expect(SIGN_OUT_UNBIND_TIMEOUT_MS).toBe(6_000);
    expect(FALLBACK_UNBIND_TIMEOUT_MS).toBe(4_000);
    expect(REVOKED_UNBIND_TIMEOUT_MS).toBe(3_000);
  });
});

describe('deviceSignOutSteps', () => {
  it('before the session ends: holds registration, then unbinds and sends the note side by side', async () => {
    h.store.set(PUSH_TOKEN_STORAGE_KEY, h.token);
    let noteDone!: () => void;
    const note = vi.fn(
      () =>
        new Promise<void>((r) => {
          noteDone = r;
        }),
    );
    const steps = deviceSignOutSteps({ user: USER, unbindTimeoutMs: 1_000, note });
    const before = steps.beforeSessionEnds();
    await tick();
    // Side by side: the delete went out while the note is still open.
    expect(note).toHaveBeenCalledTimes(1);
    expect(h.deletes).toHaveLength(1);
    // Held: a token refresh that runs the registration again sends nothing.
    await registerThisDevice(USER);
    expect(h.rpc).not.toHaveBeenCalled();
    noteDone();
    await before;
    steps.release();
  });

  it('after the session ended: the hold is released and nothing is registered', async () => {
    const steps = deviceSignOutSteps({ user: USER, unbindTimeoutMs: 1_000 });
    await steps.beforeSessionEnds();
    await steps.afterSessionEnd(true);
    await tick();
    expect(h.rpc).not.toHaveBeenCalled();
    // The next sign-in on this phone registers.
    await registerThisDevice(USER);
    expect(h.rpc).toHaveBeenCalledTimes(1);
  });

  it('the session survived: the hold is released and this phone registers again', async () => {
    const steps = deviceSignOutSteps({ user: USER, unbindTimeoutMs: 1_000 });
    await steps.beforeSessionEnds();
    await steps.afterSessionEnd(false);
    await tick();
    expect(h.rpc).toHaveBeenCalledTimes(1);
  });

  it('release() is the backstop: it releases a hold the flow left, and is safe to call twice', async () => {
    const steps = deviceSignOutSteps({ user: USER, unbindTimeoutMs: 1_000 });
    await steps.beforeSessionEnds();
    steps.release();
    steps.release();
    await steps.afterSessionEnd(true);
    await registerThisDevice(USER);
    expect(h.rpc).toHaveBeenCalledTimes(1);
  });

  it('a note that fails is only warned: the unbind still runs and nothing throws', async () => {
    h.store.set(PUSH_TOKEN_STORAGE_KEY, h.token);
    const steps = deviceSignOutSteps({
      user: USER,
      unbindTimeoutMs: 1_000,
      note: async () => {
        throw new Error('offline');
      },
    });
    await expect(steps.beforeSessionEnds()).resolves.toBeUndefined();
    expect(h.deletes).toHaveLength(1);
    steps.release();
  });
});

describe('clearDeliveredNotifications (until #371 lands its notificationIntents.clear)', () => {
  it('dismisses what this phone shows, and never rejects', async () => {
    await clearDeliveredNotifications();
    expect(h.dismiss).toHaveBeenCalledTimes(1);
    h.dismiss.mockRejectedValueOnce(new Error('native module unavailable'));
    await expect(clearDeliveredNotifications()).resolves.toBeUndefined();
  });

  it('is the one place the app calls dismissAllNotificationsAsync, so #371 replaces one line', () => {
    const code = (f: string) =>
      readFileSync(path.join(__dirname, f), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
    const callers = [
      'auth-context.tsx',
      'use-session-revocation.ts',
      'push-unbind.ts',
      'use-push-notifications.ts',
    ].filter((f) => /dismissAllNotificationsAsync\(/.test(code(f)));
    expect(callers).toEqual(['push-unbind.ts']);
  });
});

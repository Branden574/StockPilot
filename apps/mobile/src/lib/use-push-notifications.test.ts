import { beforeEach, describe, expect, it, vi } from 'vitest';

import { accountScopedStorageKeys } from './account-eviction';

/**
 * Push registration (S5, plans/S5.md 3.3 step 1), run against the real
 * use-push-notifications.ts with the native modules faked.
 *
 * THE DEFECTS. Registration ran whenever there was a user: at the password
 * step, before the authenticator code, so a password alone bound this phone to
 * the account's notifications; and during a sign-out, where a token refresh
 * re-ran the effect and bound the phone again after it had been unbound.
 * Nothing remembered which token the phone had registered, so nothing could
 * unbind it.
 *
 * React is replaced so calling the hook runs its effect at once (a mount).
 */

const h = vi.hoisted(() => ({
  isDevice: true,
  aal: { data: { currentLevel: 'aal2', nextLevel: 'aal2' }, error: null } as {
    data: { currentLevel: string | null; nextLevel: string | null } | null;
    error: unknown;
  },
  aalThrows: false,
  store: new Map<string, string>(),
  token: 'ExponentPushToken[test-token-1]',
  /** Each rpc() call's builder; `then` counts how often it was sent. */
  rpcSends: 0,
  rpcGate: null as Promise<void> | null,
  rpcError: null as unknown,
  rpc: vi.fn(),
  effects: [] as (() => unknown)[],
}));

vi.mock('react', () => ({
  useEffect: (fn: () => unknown) => {
    h.effects.push(fn);
    fn();
  },
}));
vi.mock('react-native', () => ({
  Linking: { openURL: vi.fn(async () => undefined) },
  Platform: { OS: 'ios' },
}));
vi.mock('expo-constants', () => ({
  default: { expoConfig: { extra: { eas: { projectId: 'project-1' } } }, easConfig: null },
}));
vi.mock('expo-device', () => ({
  get isDevice() {
    return h.isDevice;
  },
}));
vi.mock('expo-notifications', () => ({
  setNotificationHandler: vi.fn(),
  getPermissionsAsync: vi.fn(async () => ({ status: 'granted' })),
  requestPermissionsAsync: vi.fn(async () => ({ status: 'granted' })),
  setNotificationChannelAsync: vi.fn(async () => undefined),
  getExpoPushTokenAsync: vi.fn(async () => ({ data: h.token })),
  addNotificationResponseReceivedListener: vi.fn(() => ({ remove: vi.fn() })),
  dismissAllNotificationsAsync: vi.fn(async () => undefined),
  AndroidImportance: { DEFAULT: 3 },
}));
vi.mock('./web-path-rewrite', () => ({ rewriteWebPath: (p: string) => p }));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (k: string) => h.store.get(k) ?? null),
    setItem: vi.fn(async (k: string, v: string) => {
      h.store.set(k, v);
    }),
  },
}));
vi.mock('./supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => h.rpc(...args),
    auth: {
      mfa: {
        getAuthenticatorAssuranceLevel: vi.fn(async () => {
          if (h.aalThrows) throw new Error('keychain locked');
          return h.aal;
        }),
      },
    },
  },
}));

import {
  holdRegistration,
  PUSH_TOKEN_STORAGE_KEY,
  registerThisDevice,
  registrationSettled,
  releaseRegistration,
  rememberedPushToken,
  usePushNotifications,
} from './use-push-notifications';

const USER = { id: 'user-1' } as never;

/** A supabase-js builder: lazy, and sent once per `then` (pattern #22). */
function rpcBuilder() {
  return {
    then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
      h.rpcSends += 1;
      const answer = (h.rpcGate ?? Promise.resolve()).then(() => ({
        data: null,
        error: h.rpcError,
      }));
      return answer.then(resolve, reject);
    },
  };
}

const held: symbol[] = [];

beforeEach(() => {
  h.isDevice = true;
  h.aal = { data: { currentLevel: 'aal2', nextLevel: 'aal2' }, error: null };
  h.aalThrows = false;
  h.store.clear();
  h.rpcSends = 0;
  h.rpcGate = null;
  h.rpcError = null;
  h.rpc.mockReset();
  h.rpc.mockImplementation(() => rpcBuilder());
  h.effects.length = 0;
  while (held.length) releaseRegistration(held.pop()!);
});

function hold(): symbol {
  const s = holdRegistration();
  held.push(s);
  return s;
}

describe('registerThisDevice', () => {
  it('registers through register_push_token and remembers the token, outside the account’s workspace keys', async () => {
    await registerThisDevice(USER);
    expect(h.rpc).toHaveBeenCalledWith('register_push_token', {
      p_token: h.token,
      p_platform: 'ios',
      p_device_id: null,
    });
    expect(h.rpcSends).toBe(1);
    expect(await rememberedPushToken()).toBe(h.token);
    // The sign-out removes the `workspace.` keys AFTER the session ends; the
    // token is the phone's, not the account's, and must outlive that.
    expect(accountScopedStorageKeys([PUSH_TOKEN_STORAGE_KEY])).toEqual([]);
  });

  it('a refused registration is not remembered', async () => {
    h.rpcError = { code: '42501', message: 'unauthenticated' };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await registerThisDevice(USER);
    expect(await rememberedPushToken()).toBeNull();
    expect(warn).toHaveBeenCalledWith('[push] registration failed', expect.anything());
    warn.mockRestore();
  });

  it('a session that still owes its authenticator code does not register (aal1, next aal2)', async () => {
    h.aal = { data: { currentLevel: 'aal1', nextLevel: 'aal2' }, error: null };
    await registerThisDevice(USER);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it('a level that cannot be read does not register (fail closed): an error, a throw, or no session', async () => {
    h.aal = { data: null, error: { message: 'session expired' } };
    await registerThisDevice(USER);
    h.aal = { data: { currentLevel: null, nextLevel: null }, error: null };
    await registerThisDevice(USER);
    h.aalThrows = true;
    await registerThisDevice(USER);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it('registers at aal2, and at aal1 when no authenticator is set up', async () => {
    h.aal = { data: { currentLevel: 'aal1', nextLevel: 'aal1' }, error: null };
    await registerThisDevice(USER);
    expect(h.rpc).toHaveBeenCalledTimes(1);
  });

  it('no user, or a simulator: nothing', async () => {
    await registerThisDevice(null);
    h.isDevice = false;
    await registerThisDevice(USER);
    expect(h.rpc).not.toHaveBeenCalled();
  });
});

describe('the sign-out hold', () => {
  it('while held, no registration is sent, including the re-run a token refresh causes during the sign-out', async () => {
    hold();
    await registerThisDevice(USER);
    // TOKEN_REFRESHED hands RootGate a new user object, and the hook runs again.
    usePushNotifications({ id: 'user-1' } as never);
    await new Promise((r) => setTimeout(r, 0));
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it('is checked after every await: a hold set while the token is being fetched still stops the RPC', async () => {
    let releaseToken!: () => void;
    const tokenGate = new Promise<void>((r) => {
      releaseToken = r;
    });
    const notifications = await import('expo-notifications');
    vi.mocked(notifications.getExpoPushTokenAsync).mockImplementationOnce(async () => {
      await tokenGate;
      return { data: h.token } as never;
    });
    const run = registerThisDevice(USER);
    await new Promise((r) => setTimeout(r, 0));
    hold();
    releaseToken();
    await run;
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it('released, the next sign-in on this phone registers', async () => {
    const s = hold();
    await registerThisDevice(USER);
    expect(h.rpc).not.toHaveBeenCalled();
    releaseRegistration(s);
    usePushNotifications({ id: 'user-2' } as never);
    await new Promise((r) => setTimeout(r, 0));
    expect(h.rpc).toHaveBeenCalledTimes(1);
  });

  it('two holds at once: registration waits for both to be released, and a release is per hold', async () => {
    const a = hold();
    const b = hold();
    releaseRegistration(a);
    releaseRegistration(a);
    await registerThisDevice(USER);
    expect(h.rpc).not.toHaveBeenCalled();
    releaseRegistration(b);
    await registerThisDevice(USER);
    expect(h.rpc).toHaveBeenCalledTimes(1);
  });
});

describe('registrationSettled', () => {
  it('waits for a registration in flight (sent once, never again for the wait), then for the token to be remembered', async () => {
    let answer!: () => void;
    h.rpcGate = new Promise<void>((r) => {
      answer = r;
    });
    const run = registerThisDevice(USER);
    await new Promise((r) => setTimeout(r, 0));
    let settled = false;
    const wait = registrationSettled(1_000).then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(settled).toBe(false);
    answer();
    await wait;
    expect(await rememberedPushToken()).toBe(h.token);
    await run;
    expect(h.rpcSends).toBe(1);
  });

  it('is bounded: a registration that does not answer is waited for no longer than asked', async () => {
    let answer!: () => void;
    h.rpcGate = new Promise<void>((r) => {
      answer = r;
    });
    const run = registerThisDevice(USER);
    await new Promise((r) => setTimeout(r, 0));
    const started = Date.now();
    await registrationSettled(20);
    expect(Date.now() - started).toBeLessThan(1_000);
    // Let it finish, so the next test starts with nothing in flight.
    answer();
    await run;
  });

  it('nothing in flight: answers at once', async () => {
    await expect(registrationSettled(10_000)).resolves.toBeUndefined();
  });
});

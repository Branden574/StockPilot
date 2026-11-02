import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Security invariant: a "signed out from another device" message changes
 * nothing on the phone until the Auth server says the phone's session is gone
 * (S5, integrator decision 2026-11-02, from the security review of S5a).
 *
 * THE DEFECT. The channel `user:<id>:sessions` is public: anyone holding the
 * app's public key and a person's user id can post `{ keepId: 'x' }` to it.
 * The phone acted on any message aimed at it before checking anything: it
 * deleted its push token row first, then signed out, cleared Notification
 * Center and showed "You were signed out from another device." while its
 * session was still live (main signed it out too, without the delete).
 *
 * Run end to end through the REAL use-session-revocation.ts, session-check.ts,
 * push-unbind.ts and use-push-notifications.ts. Only the Supabase client, the
 * native modules and React are faked; the account gate's first refusal is its
 * own decision (classifyAuthProbe, gateForRevocation, isDisableRevocation),
 * as use-account-gate.ts onSessionRevoked makes it.
 */

const MY_SESSION = '5f0c9a1e-7b2d-4c3e-9f10-aa55bb66cc77';
const REMEMBERED = 'ExponentPushToken[phone-under-test]';

const h = vi.hoisted(() => ({
  log: [] as string[],
  handlers: [] as ((msg: { payload: unknown }) => void)[],
  deletes: [] as { eq: unknown[][] }[],
  alert: vi.fn(),
  /** What the Auth server answers GET /auth/v1/user with. */
  authAnswer: vi.fn(),
  /** What the account gate's getUser() probe gets. */
  gateProbe: vi.fn(),
  asked: [] as string[],
}));

vi.mock('react', () => ({
  useRef: (v: unknown) => ({ current: v }),
  useEffect: (fn: () => unknown) => {
    fn();
  },
}));
vi.mock('react-native', () => ({
  Alert: { alert: (...a: unknown[]) => h.alert(...a) },
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
  getExpoPushTokenAsync: vi.fn(async () => ({ data: REMEMBERED })),
  addNotificationResponseReceivedListener: vi.fn(() => ({ remove: vi.fn() })),
  dismissAllNotificationsAsync: vi.fn(async () => {
    h.log.push('notification-center-cleared');
  }),
  AndroidImportance: { DEFAULT: 3 },
}));
vi.mock('./web-path-rewrite', () => ({ rewriteWebPath: (p: string) => p }));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (k: string) => (k === 'sp_push_token_v1' ? REMEMBERED : null)),
    setItem: vi.fn(async () => undefined),
  },
}));

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}
const ACCESS = `${b64url({ alg: 'ES256', typ: 'JWT' })}.${b64url({ session_id: MY_SESSION, sub: 'u1' })}.sig`;

vi.mock('./supabase', () => {
  const builder = () => {
    const call = { eq: [] as unknown[][] };
    h.deletes.push(call);
    const b = {
      eq: (...a: unknown[]) => {
        call.eq.push(a);
        return b;
      },
      select: () => b,
      abortSignal: () => b,
      then(resolve: (v: unknown) => unknown) {
        h.log.push('push_tokens-row-deleted');
        return Promise.resolve({ data: [{ id: 'row-1' }], error: null }).then(resolve);
      },
    };
    return b;
  };
  return {
    supabase: {
      rpc: vi.fn(async () => ({ error: null })),
      from: (table: string) => ({
        delete: () => {
          h.log.push(`delete-from:${table}`);
          return builder();
        },
      }),
      auth: {
        getSession: async () => ({ data: { session: { access_token: ACCESS } }, error: null }),
        getUser: async () => h.gateProbe(),
        signOut: async (o: unknown) => {
          h.log.push(`signOut:${(o as { scope: string }).scope}`);
          return { error: null };
        },
        mfa: {
          getAuthenticatorAssuranceLevel: async () => ({
            data: { currentLevel: 'aal2', nextLevel: 'aal2' },
            error: null,
          }),
        },
      },
      channel: () => {
        const ch: Record<string, unknown> = {
          on: (_t: string, _f: unknown, cb: (msg: { payload: unknown }) => void) => {
            h.handlers.push(cb);
            return ch;
          },
          subscribe: vi.fn(),
        };
        return ch;
      },
      removeChannel: vi.fn(),
    },
    fetchAuthUser: async (accessToken: string) => {
      h.asked.push(accessToken);
      return h.authAnswer();
    },
  };
});

import { isDisableRevocation } from '@stockpilot/core';

import { classifyAuthProbe } from './account-disabled-probe';
import { gateForRevocation } from './account-eviction';
import { supabase } from './supabase';
import { useSessionRevocation as subscribe } from './use-session-revocation';

/** use-account-gate.ts onSessionRevoked, minus setAccountGateState. */
async function accountGateFirstRefusal(payload: unknown): Promise<boolean> {
  const probe = classifyAuthProbe(await supabase.auth.getUser());
  h.log.push(`gate-probe:${probe}`);
  return gateForRevocation(isDisableRevocation(payload), probe) === 'disabled';
}

function answer(status: number, body: unknown) {
  return async () => {
    h.log.push(`auth-server:${status}`);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

async function mount() {
  const onSignedOut = vi.fn(() => h.log.push('onSignedOut'));
  subscribe('u1', onSignedOut, { onTargeted: accountGateFirstRefusal });
  await settle();
  expect(h.handlers).toHaveLength(1);
  return { send: (payload: unknown) => h.handlers[0]!({ payload }), onSignedOut };
}

beforeEach(() => {
  h.log.length = 0;
  h.handlers.length = 0;
  h.deletes.length = 0;
  h.asked.length = 0;
  h.alert.mockReset();
  h.authAnswer.mockReset();
  h.gateProbe.mockReset();
  // The session the message names is really gone: getUser() gets the error
  // auth-js turns session_not_found into.
  h.gateProbe.mockImplementation(async () => ({
    data: { user: null },
    error: { name: 'AuthSessionMissingError', status: 400 },
  }));
});

describe('a forged message about a live session changes nothing on the phone', () => {
  it.each([
    ['{ keepId: <anything> }', { keepId: 'forged-by-anyone' }],
    ['{ keepId: null }', { keepId: null }],
    ['{ keepId: null, reason: account_disabled }', { keepId: null, reason: 'account_disabled' }],
    ['{ sessionIds: [this session] }', { sessionIds: [MY_SESSION] }],
  ])('%s: no push row deleted, no sign-out, nothing cleared, no alert', async (_n, payload) => {
    // The session is live: the Auth server knows it, and so would the gate.
    h.authAnswer.mockImplementation(answer(200, { id: 'u1', aud: 'authenticated' }));
    h.gateProbe.mockImplementation(async () => ({ data: { user: { id: 'u1' } }, error: null }));
    const { send, onSignedOut } = await mount();
    send(payload);
    await settle();
    // The Auth server said the session is live, and asking it is the only
    // thing that happened...
    expect(h.log).toEqual(['auth-server:200']);
    expect(h.deletes).toHaveLength(0);
    // ...asked with this session's current access token.
    expect(h.asked).toEqual([ACCESS]);
    expect(h.alert).not.toHaveBeenCalled();
    expect(onSignedOut).not.toHaveBeenCalled();
  });
});

describe('no answer from the Auth server changes nothing either', () => {
  it('offline: nothing happens (a revoked session still ends at its next refresh)', async () => {
    h.authAnswer.mockImplementation(async () => {
      h.log.push('auth-server:unreachable');
      throw new TypeError('Network request failed');
    });
    h.gateProbe.mockImplementation(async () => ({
      data: { user: null },
      error: { name: 'AuthRetryableFetchError', status: 0 },
    }));
    const { send, onSignedOut } = await mount();
    send({ keepId: null });
    await settle();
    expect(h.log).toEqual(['auth-server:unreachable']);
    expect(h.deletes).toHaveLength(0);
    expect(h.alert).not.toHaveBeenCalled();
    expect(onSignedOut).not.toHaveBeenCalled();
  });

  it('the Auth server fails (503): nothing happens', async () => {
    h.authAnswer.mockImplementation(answer(503, { message: 'upstream unavailable' }));
    h.gateProbe.mockImplementation(async () => ({
      data: { user: null },
      error: { name: 'AuthRetryableFetchError', status: 503 },
    }));
    const { send, onSignedOut } = await mount();
    send({ sessionIds: [MY_SESSION] });
    await settle();
    expect(h.log).toEqual(['auth-server:503']);
    expect(h.deletes).toHaveLength(0);
    expect(onSignedOut).not.toHaveBeenCalled();
  });
});

describe('a real sign-out from another device (the session is gone)', () => {
  it('unbinds while the token is still here, then the gate, the local sign-out, the clear and the alert', async () => {
    h.authAnswer.mockImplementation(
      answer(403, { code: 'session_not_found', message: 'Session not found' }),
    );
    const { send, onSignedOut } = await mount();
    send({ sessionIds: [MY_SESSION] });
    await settle();
    expect(h.log).toEqual([
      'auth-server:403',
      'delete-from:push_tokens',
      'push_tokens-row-deleted',
      'gate-probe:signed-out',
      'signOut:local',
      'notification-center-cleared',
      'onSignedOut',
    ]);
    expect(h.deletes[0]!.eq).toEqual([['token', REMEMBERED]]);
    expect(h.alert).toHaveBeenCalledWith(
      'Signed out',
      'You were signed out from another device.',
      [{ text: 'OK' }],
      { cancelable: false },
    );
    expect(onSignedOut).toHaveBeenCalledTimes(1);
  });

  it('a platform disable: unbound, then the account gate takes over (no alert, no local sign-out here)', async () => {
    h.authAnswer.mockImplementation(
      answer(403, { code: 'session_not_found', message: 'Session not found' }),
    );
    const { send, onSignedOut } = await mount();
    send({ keepId: null, reason: 'account_disabled' });
    await settle();
    expect(h.log).toEqual([
      'auth-server:403',
      'delete-from:push_tokens',
      'push_tokens-row-deleted',
      'gate-probe:signed-out',
    ]);
    expect(h.alert).not.toHaveBeenCalled();
    expect(onSignedOut).not.toHaveBeenCalled();
  });
});

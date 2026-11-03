import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The phone's "signed out from another device" listener, run against the real
 * use-session-revocation.ts with React, the Supabase client and the native
 * modules faked (React is replaced so calling the hook runs its effect at
 * once: a mount).
 *
 * THE PAYLOAD (S5, integrator decision 2026-11-01). "Sign out all other devices",
 * Change password and the phone's own sign-out (POST /api/v1/auth/signed-out)
 * now name the sessions they ended, `{ sessionIds: [...] }`, instead of
 * `{ keepId: <the session that stays> }`: the channel is public, and keepId
 * put a LIVE session id on it. The targeting rule is unchanged, so a phone
 * still on the old listener reads the new payload the same way: it signs out
 * when its own session is named and stays signed in when it is not (the
 * session that made the change is never named). The first describe below
 * passed against the listener as it was before S5 (recorded in the PR).
 *
 * WHAT S5 ADDS (open question 5). A message aimed at this phone also deletes
 * this phone's push token row (best effort, at most 3 s, while the access
 * token the delete needs is still here) and, once signed out, clears what
 * Notification Center still shows of the account.
 *
 * A MESSAGE IS A CLAIM (integrator decision 2026-11-02, from the security
 * review of S5a). The channel is public, so the phone first asks the Auth
 * server about its own session (session-check.ts), and acts only when the
 * answer is that the session is gone. Here the Auth server's answer is faked
 * (fetchAuthUser); by default it says the session is gone, as it does for
 * every real message. use-session-revocation.forged.test.ts runs the same
 * story through the real push modules.
 */

const MINE = '5f0c9a1e-7b2d-4c3e-9f10-aa55bb66cc77';
const OTHER_A = '11111111-2222-4333-8444-555555555555';
const OTHER_B = '66666666-7777-4888-9999-aaaaaaaaaaaa';

const h = vi.hoisted(() => ({
  handlers: [] as ((msg: { payload: unknown }) => void)[],
  channelName: vi.fn(),
  log: [] as string[],
  signOut: vi.fn(),
  getSession: vi.fn(),
  alert: vi.fn(),
  unbind: vi.fn(),
  clear: vi.fn(),
  hold: vi.fn(),
  release: vi.fn(),
  /** The Auth server's answer to GET /auth/v1/user (session-check.ts). */
  authAnswer: vi.fn(),
  asked: [] as string[],
}));

vi.mock('react', () => ({
  useRef: (v: unknown) => ({ current: v }),
  useEffect: (fn: () => unknown) => {
    fn();
  },
}));
vi.mock('react-native', () => ({ Alert: { alert: (...a: unknown[]) => h.alert(...a) } }));
vi.mock('./supabase', () => ({
  supabase: {
    auth: { getSession: () => h.getSession(), signOut: (o: unknown) => h.signOut(o) },
    channel: (name: string) => {
      h.channelName(name);
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
    h.log.push('check');
    return h.authAnswer();
  },
}));
// The device steps (push-unbind.ts has its own tests): recorded in order.
vi.mock('./push-unbind', () => ({
  REVOKED_UNBIND_TIMEOUT_MS: 3_000,
  deviceSignOutSteps: (opts: { user: unknown; unbindTimeoutMs: number }) => ({
    beforeSessionEnds: async () => {
      h.hold();
      h.log.push('hold');
      await h.unbind(opts);
      h.log.push('unbind');
    },
    afterSessionEnd: async () => undefined,
    release: () => {
      h.release();
      h.log.push('release');
    },
  }),
  clearDeliveredNotifications: async () => {
    await h.clear();
    h.log.push('clear');
  },
}));

// React is replaced above, so the hook is an ordinary call here (named so the
// rules of hooks do not read the helper below as a component).
import { useSessionRevocation as subscribeToRevocations } from './use-session-revocation';

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}
const TOKEN = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ session_id: MINE, sub: 'u1' })}.sig`;

const tick = () => new Promise((r) => setTimeout(r, 0));

function authAnswer(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function mount(onTargeted?: (payload: unknown) => Promise<boolean>) {
  const onSignedOut = vi.fn(() => {
    h.log.push('onSignedOut');
  });
  subscribeToRevocations('u1', onSignedOut, onTargeted ? { onTargeted } : {});
  await tick();
  expect(h.channelName).toHaveBeenCalledWith('user:u1:sessions');
  expect(h.handlers).toHaveLength(1);
  return { send: (payload: unknown) => h.handlers[0]!({ payload }), onSignedOut };
}

beforeEach(() => {
  h.handlers.length = 0;
  h.log.length = 0;
  h.channelName.mockReset();
  h.getSession.mockReset();
  h.getSession.mockResolvedValue({ data: { session: { access_token: TOKEN } } });
  h.signOut.mockReset();
  h.signOut.mockImplementation(async () => {
    h.log.push('signOut:local');
    return { error: null };
  });
  h.alert.mockReset();
  h.unbind.mockReset();
  h.unbind.mockResolvedValue('deleted');
  h.clear.mockReset();
  h.clear.mockResolvedValue(undefined);
  h.hold.mockReset();
  h.release.mockReset();
  h.asked.length = 0;
  h.authAnswer.mockReset();
  h.authAnswer.mockImplementation(async () => authAnswer(403, { code: 'session_not_found' }));
});

describe('which sessions a payload signs out (unchanged by S5: an old phone reads the new payload the same way)', () => {
  it('{ sessionIds } naming this session: signed out locally, with the alert', async () => {
    const { send, onSignedOut } = await mount();
    send({ sessionIds: [OTHER_A, MINE] });
    await tick();
    expect(h.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(h.alert).toHaveBeenCalledWith(
      'Signed out',
      'You were signed out from another device.',
      [{ text: 'OK' }],
      { cancelable: false },
    );
    expect(onSignedOut).toHaveBeenCalledTimes(1);
  });

  it('{ sessionIds } of the OTHER sessions (what the session that stays sends): this phone stays signed in', async () => {
    const { send, onSignedOut } = await mount();
    send({ sessionIds: [OTHER_A, OTHER_B] });
    send({ sessionIds: [] });
    await tick();
    expect(h.signOut).not.toHaveBeenCalled();
    expect(h.alert).not.toHaveBeenCalled();
    expect(onSignedOut).not.toHaveBeenCalled();
  });

  it('{ keepId: null } (sign out everywhere) still signs this phone out', async () => {
    const { send } = await mount();
    send({ keepId: null });
    await tick();
    expect(h.signOut).toHaveBeenCalledWith({ scope: 'local' });
  });
});

describe('a message aimed at this phone also unbinds it and clears Notification Center (S5, open question 5)', () => {
  it('in order: ask the Auth server, hold registration, delete this phone’s push token row (3 s), sign out locally, clear Notification Center, release', async () => {
    const { send } = await mount();
    send({ sessionIds: [MINE] });
    await tick();
    expect(h.unbind).toHaveBeenCalledWith(expect.objectContaining({ unbindTimeoutMs: 3_000 }));
    expect(h.log).toEqual([
      'check',
      'hold',
      'unbind',
      'signOut:local',
      'clear',
      'release',
      'onSignedOut',
    ]);
    expect(h.asked).toEqual([TOKEN]);
  });

  it('the unbind runs before the account gate’s probe, which can drop the session the delete needs', async () => {
    const onTargeted = vi.fn(async () => {
      h.log.push('gate');
      return false;
    });
    const { send } = await mount(onTargeted);
    send({ keepId: null });
    await tick();
    expect(h.log).toEqual([
      'check',
      'hold',
      'unbind',
      'gate',
      'signOut:local',
      'clear',
      'release',
      'onSignedOut',
    ]);
  });

  it('the gate took the eviction over (a platform disable): no local sign-out, alert or clear here, and the hold is released', async () => {
    const onTargeted = vi.fn(async () => true);
    const { send, onSignedOut } = await mount(onTargeted);
    send({ keepId: null, reason: 'account_disabled' });
    await tick();
    expect(h.unbind).toHaveBeenCalledTimes(1);
    expect(h.signOut).not.toHaveBeenCalled();
    expect(h.clear).not.toHaveBeenCalled();
    expect(h.alert).not.toHaveBeenCalled();
    expect(onSignedOut).not.toHaveBeenCalled();
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it('an unbind that fails or a sign-out that throws still ends in the alert, and the hold is released', async () => {
    h.unbind.mockRejectedValueOnce(new Error('offline'));
    h.signOut.mockRejectedValueOnce(new Error('offline'));
    const { send, onSignedOut } = await mount();
    send({ sessionIds: [MINE] });
    await tick();
    expect(h.alert).toHaveBeenCalledTimes(1);
    expect(onSignedOut).toHaveBeenCalledTimes(1);
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it('a message aimed elsewhere does nothing at all', async () => {
    const { send } = await mount();
    send({ sessionIds: [OTHER_A] });
    send({ keepId: MINE });
    send({});
    await tick();
    expect(h.asked).toEqual([]);
    expect(h.hold).not.toHaveBeenCalled();
    expect(h.unbind).not.toHaveBeenCalled();
    expect(h.clear).not.toHaveBeenCalled();
    expect(h.signOut).not.toHaveBeenCalled();
  });
});

describe('a message is a claim: nothing happens unless the Auth server says this session is gone (S5, 2026-11-02)', () => {
  it.each([
    ['{ keepId: <anything> }', { keepId: 'forged' }],
    ['{ keepId: null }', { keepId: null }],
    ['{ sessionIds: [this session] }', { sessionIds: [MINE] }],
    ['{ keepId: null, reason: account_disabled }', { keepId: null, reason: 'account_disabled' }],
  ])(
    'the session is live (200): %s holds nothing, unbinds nothing, asks no gate, signs nothing out, clears nothing',
    async (_n, payload) => {
      h.authAnswer.mockImplementation(async () => authAnswer(200, { id: 'u1' }));
      const onTargeted = vi.fn(async () => true);
      const { send, onSignedOut } = await mount(onTargeted);
      send(payload);
      await tick();
      expect(h.log).toEqual(['check']);
      expect(h.hold).not.toHaveBeenCalled();
      expect(h.unbind).not.toHaveBeenCalled();
      expect(onTargeted).not.toHaveBeenCalled();
      expect(h.signOut).not.toHaveBeenCalled();
      expect(h.clear).not.toHaveBeenCalled();
      expect(h.release).not.toHaveBeenCalled();
      expect(h.alert).not.toHaveBeenCalled();
      expect(onSignedOut).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['offline (the request fails)', () => Promise.reject(new TypeError('Network request failed'))],
    ['a server failure (500)', async () => authAnswer(500, { code: 'unexpected_failure' })],
    ['a gateway failure (503)', async () => authAnswer(503, { message: 'unavailable' })],
    ['an expired token (401 bad_jwt)', async () => authAnswer(401, { code: 'bad_jwt' })],
    [
      'an answer with no code (401)',
      async () => authAnswer(401, { message: 'Invalid credentials' }),
    ],
    ['an answer that is not JSON (403)', async () => new Response('<html>', { status: 403 })],
  ])('no answer, %s: nothing happens', async (_n, reply) => {
    h.authAnswer.mockImplementation(reply);
    const { send, onSignedOut } = await mount();
    send({ sessionIds: [MINE] });
    await tick();
    expect(h.log).toEqual(['check']);
    expect(h.unbind).not.toHaveBeenCalled();
    expect(h.signOut).not.toHaveBeenCalled();
    expect(h.clear).not.toHaveBeenCalled();
    expect(h.alert).not.toHaveBeenCalled();
    expect(onSignedOut).not.toHaveBeenCalled();
  });

  it.each([
    ['session_not_found (403)', 403, { code: 'session_not_found' }],
    [
      'session_not_found, an older server (403, error_code)',
      403,
      { code: 403, error_code: 'session_not_found' },
    ],
    ['session_expired', 401, { code: 'session_expired' }],
    ['user_banned', 403, { code: 'user_banned' }],
  ])('the session is gone, %s: the phone signs out', async (_n, status, body) => {
    h.authAnswer.mockImplementation(async () => authAnswer(status, body));
    const { send, onSignedOut } = await mount();
    send({ keepId: null });
    await tick();
    expect(h.log).toEqual([
      'check',
      'hold',
      'unbind',
      'signOut:local',
      'clear',
      'release',
      'onSignedOut',
    ]);
    expect(onSignedOut).toHaveBeenCalledTimes(1);
  });
});

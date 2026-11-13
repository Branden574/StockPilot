import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { codeGateUp, type SessionLike, type UserLike } from './mfa-level';
import {
  createStepUpReconciler,
  handOverLiveUser,
  setLiveUserHandler,
  setStepUpForcedFor,
  stepUpForcedFor,
  subscribeStepUpForced,
} from './mfa-reconcile';

/**
 * Security invariant (docket S43b): the phone's code gate follows the
 * server's own factor list in both directions, and the two directions are not
 * symmetrical. It goes UP on the server's word at once, refresh or no
 * refresh; it comes DOWN only through a session the server issued.
 */

function jwt(claims: Record<string, unknown>): string {
  return [{ alg: 'HS256', typ: 'JWT' }, claims, 'signature']
    .map((part) => Buffer.from(JSON.stringify(part)).toString('base64url'))
    .join('.');
}

const TOTP = { id: 'factor-totp', factor_type: 'totp', status: 'verified' };

const session = (aal: string, factors?: unknown[], userId = 'u1'): SessionLike => ({
  access_token: jwt({ sub: userId, aal }),
  user: { id: userId, ...(factors ? { factors } : {}) } as UserLike,
});
const liveUser = (factors?: unknown[], id = 'u1'): UserLike =>
  ({ id, ...(factors ? { factors } : {}) }) as UserLike;

/** The two calls auth-context.tsx supplies, as fakes with a call log. */
function harness(current: SessionLike | null) {
  const state = {
    current,
    /** What the next refresh answers: a session (stored as current), or null (it failed). */
    refreshTo: null as SessionLike | null,
    refreshes: 0,
  };
  const reconcile = createStepUpReconciler({
    currentSession: async () => state.current,
    refreshSession: async () => {
      state.refreshes += 1;
      if (state.refreshTo) state.current = state.refreshTo;
      return state.refreshTo;
    },
  });
  return { state, reconcile };
}

beforeEach(() => {
  setStepUpForcedFor(null);
  setLiveUserHandler(null);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('the note: the account whose session owes a code its copy does not show', () => {
  it('is read back, and subscribers hear each change once', () => {
    const heard = vi.fn();
    const off = subscribeStepUpForced(heard);
    expect(stepUpForcedFor()).toBeNull();
    setStepUpForcedFor('u1');
    expect(stepUpForcedFor()).toBe('u1');
    setStepUpForcedFor('u1'); // no change, no notification
    expect(heard).toHaveBeenCalledTimes(1);
    setStepUpForcedFor(null);
    expect(heard).toHaveBeenCalledTimes(2);
    off();
    setStepUpForcedFor('u2');
    expect(heard).toHaveBeenCalledTimes(2);
  });
});

describe('handOverLiveUser: a getUser() answer on its way through a promise chain', () => {
  it('hands the user over and returns the answer untouched', () => {
    const handler = vi.fn();
    setLiveUserHandler(handler);
    const answer = { data: { user: liveUser([TOTP]) }, error: null };
    expect(handOverLiveUser(answer)).toBe(answer);
    expect(handler).toHaveBeenCalledWith(answer.data.user);
  });

  it('an answer with an error, or with no user, hands nothing over', () => {
    const handler = vi.fn();
    setLiveUserHandler(handler);
    const failed = { data: { user: null }, error: { status: 500 } };
    expect(handOverLiveUser(failed)).toBe(failed);
    // A user beside an error is not taken either: the answer is not a clean read.
    handOverLiveUser({ data: { user: liveUser([TOTP]) }, error: { status: 500 } });
    handOverLiveUser(null);
    handOverLiveUser(undefined);
    expect(handler).not.toHaveBeenCalled();
  });

  it('with nobody registered, or a handler that throws, the chain it sits in goes on', () => {
    const answer = { data: { user: liveUser() }, error: null };
    expect(handOverLiveUser(answer)).toBe(answer);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    setLiveUserHandler(() => {
      throw new Error('boom');
    });
    expect(handOverLiveUser(answer)).toBe(answer);
  });
});

describe('reconcile: the session and the server agree', () => {
  it('both list the factor (the code screen is already showing): nothing happens', async () => {
    const { state, reconcile } = harness(session('aal1', [TOTP]));
    expect(await reconcile(liveUser([TOTP]))).toBe('none');
    expect(state.refreshes).toBe(0);
    expect(stepUpForcedFor()).toBeNull();
  });

  it('neither lists one: nothing happens', async () => {
    const { state, reconcile } = harness(session('aal1'));
    expect(await reconcile(liveUser())).toBe('none');
    expect(state.refreshes).toBe(0);
  });

  it('a session that entered its code is left alone when a second factor is added', async () => {
    const { state, reconcile } = harness(session('aal2', [TOTP]));
    expect(await reconcile(liveUser([TOTP, { id: 'f2', factor_type: 'totp', status: 'verified' }]))).toBe('none');
    expect(state.refreshes).toBe(0);
    expect(stepUpForcedFor()).toBeNull();
  });

  it('signed out, no answer, or an answer about another account: nothing happens', async () => {
    const signedOut = harness(null);
    expect(await signedOut.reconcile(liveUser([TOTP]))).toBe('none');
    const signedIn = harness(session('aal1'));
    expect(await signedIn.reconcile(null)).toBe('none');
    expect(await signedIn.reconcile(liveUser([TOTP], 'u2'))).toBe('none');
    expect(signedIn.state.refreshes).toBe(0);
    expect(stepUpForcedFor()).toBeNull();
  });
});

describe('reconcile: an authenticator turned on elsewhere while this phone is signed in', () => {
  it('the refresh brings the factor: the session itself now owes the code, no note needed', async () => {
    const { state, reconcile } = harness(session('aal1'));
    state.refreshTo = session('aal1', [TOTP]);
    expect(await reconcile(liveUser([TOTP]))).toBe('refreshed');
    expect(state.refreshes).toBe(1);
    expect(stepUpForcedFor()).toBeNull();
    expect(codeGateUp(state.current, stepUpForcedFor())).toBe(true);
  });

  it('the refresh fails: the gate goes up anyway, on the note', async () => {
    const { state, reconcile } = harness(session('aal1'));
    expect(codeGateUp(state.current, stepUpForcedFor())).toBe(false);
    expect(await reconcile(liveUser([TOTP]))).toBe('forced');
    expect(stepUpForcedFor()).toBe('u1');
    expect(codeGateUp(state.current, stepUpForcedFor())).toBe(true);
  });

  it('a later answer tries the refresh again, and a refresh that works settles the note', async () => {
    const { state, reconcile } = harness(session('aal1'));
    await reconcile(liveUser([TOTP]));
    expect(stepUpForcedFor()).toBe('u1');
    state.refreshTo = session('aal1', [TOTP]);
    expect(await reconcile(liveUser([TOTP]))).toBe('refreshed');
    expect(state.refreshes).toBe(2);
    expect(stepUpForcedFor()).toBeNull();
    expect(codeGateUp(state.current, stepUpForcedFor())).toBe(true);
  });

  it('a refreshed session that still lists no factor does not lower the gate', async () => {
    const { state, reconcile } = harness(session('aal1'));
    state.refreshTo = session('aal1');
    expect(await reconcile(liveUser([TOTP]))).toBe('forced');
    expect(stepUpForcedFor()).toBe('u1');
    expect(codeGateUp(state.current, stepUpForcedFor())).toBe(true);
  });

  it('a refresh that answers with another account changes nothing but the note', async () => {
    const { state, reconcile } = harness(session('aal1'));
    state.refreshTo = session('aal1', [TOTP], 'u2');
    expect(await reconcile(liveUser([TOTP]))).toBe('forced');
    expect(stepUpForcedFor()).toBe('u1');
  });
});

describe('reconcile: an authenticator removed since the session was stored', () => {
  it('the refresh brings the session without it: the gate comes down through that session', async () => {
    const { state, reconcile } = harness(session('aal1', [TOTP]));
    state.refreshTo = session('aal1');
    expect(await reconcile(liveUser())).toBe('refreshed');
    expect(codeGateUp(state.current, stepUpForcedFor())).toBe(false);
  });

  it('the refresh fails: the gate stays up (it is never lowered on an answer alone)', async () => {
    const { state, reconcile } = harness(session('aal1', [TOTP]));
    expect(await reconcile(liveUser())).toBe('kept');
    expect(state.refreshes).toBe(1);
    expect(stepUpForcedFor()).toBeNull();
    expect(codeGateUp(state.current, stepUpForcedFor())).toBe(true);
  });

  it('a note the server no longer backs is settled by a refresh, not dropped', async () => {
    // Turned on, noted (the refresh failed), then turned off again.
    const { state, reconcile } = harness(session('aal1'));
    await reconcile(liveUser([TOTP]));
    expect(stepUpForcedFor()).toBe('u1');

    // The refresh still fails: the note, and the gate, stay.
    expect(await reconcile(liveUser())).toBe('kept');
    expect(stepUpForcedFor()).toBe('u1');
    expect(codeGateUp(state.current, stepUpForcedFor())).toBe(true);

    // The refresh works: the server issued a session with no factor.
    state.refreshTo = session('aal1');
    expect(await reconcile(liveUser())).toBe('refreshed');
    expect(stepUpForcedFor()).toBeNull();
    expect(codeGateUp(state.current, stepUpForcedFor())).toBe(false);
  });

  it("another account's note is left alone", async () => {
    setStepUpForcedFor('u9');
    const { state, reconcile } = harness(session('aal1', [TOTP]));
    state.refreshTo = session('aal1');
    expect(await reconcile(liveUser())).toBe('refreshed');
    expect(stepUpForcedFor()).toBe('u9');
  });
});

describe('reconcile: one run at a time, and never a throw', () => {
  it('a burst of answers makes one refresh', async () => {
    let release!: (s: SessionLike | null) => void;
    const pending = new Promise<SessionLike | null>((resolve) => {
      release = resolve;
    });
    let refreshes = 0;
    const reconcile = createStepUpReconciler({
      currentSession: async () => session('aal1'),
      refreshSession: () => {
        refreshes += 1;
        return pending;
      },
    });
    const runs = [reconcile(liveUser([TOTP])), reconcile(liveUser([TOTP])), reconcile(liveUser([TOTP]))];
    release(session('aal1', [TOTP]));
    expect(await Promise.all(runs)).toEqual(['refreshed', 'refreshed', 'refreshed']);
    expect(refreshes).toBe(1);
    // The next answer starts a run of its own.
    release(null);
    expect(await reconcile(liveUser([TOTP]))).toBe('refreshed');
    expect(refreshes).toBe(2);
  });

  it('a session read that throws ends the run with nothing changed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const reconcile = createStepUpReconciler({
      currentSession: async () => {
        throw new Error('keychain locked');
      },
      refreshSession: async () => null,
    });
    expect(await reconcile(liveUser([TOTP]))).toBe('none');
    expect(stepUpForcedFor()).toBeNull();
  });

  it('a refresh that throws, with the server listing a factor, is not a way around the gate', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const current = session('aal1');
    const reconcile = createStepUpReconciler({
      currentSession: async () => current,
      refreshSession: async () => {
        throw new Error('network');
      },
    });
    await reconcile(liveUser([TOTP]));
    expect(codeGateUp(current, stepUpForcedFor())).toBe(true);
  });
});

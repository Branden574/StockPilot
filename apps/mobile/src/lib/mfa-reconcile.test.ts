import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as level from './mfa-level';
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

describe('reconcile: the note is never kept for a session that entered its code', () => {
  /** A reconciler whose refresh is held open until the test settles it. */
  function slowRefresh(first: SessionLike) {
    const state = {
      current: first as SessionLike | null,
      /** The note as each read of the session found it. */
      noteAtRead: [] as (string | null)[],
    };
    let settle!: (s: SessionLike | null) => void;
    const pending = new Promise<SessionLike | null>((resolve) => {
      settle = resolve;
    });
    const reconcile = createStepUpReconciler({
      currentSession: async () => {
        state.noteAtRead.push(stepUpForcedFor());
        return state.current;
      },
      refreshSession: () => pending,
    });
    return { state, reconcile, settle };
  }
  /** Let the run read its session and reach its refresh. */
  const reachRefresh = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };

  it('a refresh that fails after the code was entered leaves no note', async () => {
    const { state, reconcile, settle } = slowRefresh(session('aal1'));
    const run = reconcile(liveUser([TOTP]));
    await reachRefresh();
    // The code is entered while the refresh is still out: auth-js holds the
    // aal2 session and the provider clears the note (MFA_CHALLENGE_VERIFIED).
    state.current = session('aal2', [TOTP]);
    setStepUpForcedFor(null);
    settle(null);
    expect(await run).toBe('none');
    expect(stepUpForcedFor()).toBeNull();
    expect(codeGateUp(state.current, stepUpForcedFor())).toBe(false);
  });

  it('a refresh that answers late, without the factor, after the code was entered leaves no note', async () => {
    const { state, reconcile, settle } = slowRefresh(session('aal1'));
    const run = reconcile(liveUser([TOTP]));
    await reachRefresh();
    state.current = session('aal2', [TOTP]);
    setStepUpForcedFor(null);
    settle(session('aal1'));
    expect(await run).toBe('none');
    expect(stepUpForcedFor()).toBeNull();
  });

  it('the session is read again after the note is raised, never before', async () => {
    const { state, reconcile, settle } = slowRefresh(session('aal1'));
    const heard: (string | null)[] = [];
    const off = subscribeStepUpForced(() => heard.push(stepUpForcedFor()));
    const run = reconcile(liveUser([TOTP]));
    await reachRefresh();
    expect(state.noteAtRead).toEqual([null]);
    settle(null);
    expect(await run).toBe('forced');
    off();
    // Raised at once on the failed refresh; the one further read finds the
    // note already up. Still aal1, so it stays.
    expect(heard).toEqual(['u1']);
    expect(state.noteAtRead).toEqual([null, 'u1']);
    expect(stepUpForcedFor()).toBe('u1');
  });

  it('the same holds when the refresh answers without the factor', async () => {
    const { state, reconcile, settle } = slowRefresh(session('aal1'));
    const run = reconcile(liveUser([TOTP]));
    await reachRefresh();
    settle(session('aal1'));
    expect(await run).toBe('forced');
    expect(state.noteAtRead).toEqual([null, 'u1']);
    expect(stepUpForcedFor()).toBe('u1');
  });

  it('a second read that fails, or shows nobody or another account, keeps the note', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    for (const second of ['throws', 'nobody', 'another'] as const) {
      setStepUpForcedFor(null);
      let reads = 0;
      const reconcile = createStepUpReconciler({
        currentSession: async () => {
          reads += 1;
          if (reads === 1) return session('aal1');
          if (second === 'throws') throw new Error('keychain locked');
          return second === 'nobody' ? null : session('aal2', [TOTP], 'u2');
        },
        refreshSession: async () => null,
      });
      expect(await reconcile(liveUser([TOTP])), second).toBe('forced');
      expect(stepUpForcedFor(), second).toBe('u1');
    }
  });

  it('a note settled while the second read is out is not raised again when the read answers', async () => {
    for (const settledBy of ['the code', 'a sign-out'] as const) {
      setStepUpForcedFor(null);
      let reads = 0;
      const reconcile = createStepUpReconciler({
        currentSession: async () => {
          reads += 1;
          if (reads === 1) return session('aal1');
          // This read answers with the session as it was; before the run goes
          // on, the note is settled (auth-context.tsx clears it on both events).
          expect(stepUpForcedFor()).toBe('u1');
          setStepUpForcedFor(null);
          return settledBy === 'the code' ? session('aal1') : null;
        },
        refreshSession: async () => null,
      });
      expect(await reconcile(liveUser([TOTP])), settledBy).toBe('none');
      expect(stepUpForcedFor(), settledBy).toBeNull();
    }
  });

  it('a note found on a session at aal2 is withdrawn, with no refresh', async () => {
    setStepUpForcedFor('u1');
    const { state, reconcile } = harness(session('aal2', [TOTP]));
    expect(await reconcile(liveUser([TOTP]))).toBe('none');
    expect(stepUpForcedFor()).toBeNull();
    expect(state.refreshes).toBe(0);
    // Whatever the server lists: the session entered its code.
    setStepUpForcedFor('u1');
    expect(await reconcile(liveUser())).toBe('none');
    expect(stepUpForcedFor()).toBeNull();
    expect(state.refreshes).toBe(0);
  });

  it("a session at aal2 leaves another account's note alone", async () => {
    setStepUpForcedFor('u9');
    const { reconcile } = harness(session('aal2', [TOTP]));
    expect(await reconcile(liveUser([TOTP]))).toBe('none');
    expect(stepUpForcedFor()).toBe('u9');
  });
});

describe('reconcile: whether to refresh is the comparison in mfa-level.ts, not a second copy', () => {
  it('asks reconcileStepUp with the session it read and the answer it was handed', async () => {
    const asked = vi.spyOn(level, 'reconcileStepUp');
    const current = session('aal1');
    const answer = liveUser([TOTP]);
    const { reconcile } = harness(current);
    await reconcile(answer);
    expect(asked).toHaveBeenCalledWith(current, answer);
  });

  it('refreshes exactly when reconcileStepUp says so, or a note is no longer backed', async () => {
    const TWO = [TOTP, { id: 'f2', factor_type: 'phone', status: 'verified' }];
    const cases: [SessionLike, UserLike][] = [
      [session('aal1'), liveUser()],
      [session('aal1'), liveUser([TOTP])],
      [session('aal1', [TOTP]), liveUser()],
      [session('aal1', [TOTP]), liveUser(TWO)],
      [session('aal2', [TOTP]), liveUser(TWO)],
      [session('aal2', [TOTP]), liveUser()],
    ];
    for (const [current, answer] of cases) {
      setStepUpForcedFor(null);
      const { state, reconcile } = harness(current);
      await reconcile(answer);
      expect(state.refreshes, JSON.stringify([current.user, answer])).toBe(
        level.reconcileStepUp(current, answer) === 'refresh' ? 1 : 0,
      );
    }
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

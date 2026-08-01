import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetSessionEndedForTests,
  __resetUnauthorizedBusForTests,
  accountScopedStorageKeys,
  AUTH_SIGN_IN_ROUTE,
  AUTH_WELCOME_ROUTE,
  EVICTION_STEP_ORDER,
  gateForRevocation,
  clearSessionEnded,
  isInvoluntarySessionEnd,
  markSessionEnded,
  nextGateForProbe,
  notifyUnauthorized,
  probeAndSettle,
  PROBE_MIN_INTERVAL_MS,
  runAccountEviction,
  setUnauthorizedHandler,
  settleProbeResult,
  shouldRunEviction,
  shouldRunProbeNow,
  signedOutRoute,
  UNVERIFIED_RETRY_DELAYS_MS,
  unverifiedRetryDelayMs,
  withTimeout,
} from './account-eviction';

function steps(overrides: Partial<Record<string, () => Promise<void> | void>> = {}) {
  const calls: string[] = [];
  const make = (name: string) => async () => {
    calls.push(name);
    const o = overrides[name];
    if (o) await o();
  };
  return {
    calls,
    deps: {
      cancelRequests: make('cancelRequests'),
      signOutLocal: make('signOutLocal'),
      clearCaches: make('clearCaches'),
      clearAccountStorage: make('clearAccountStorage'),
      resetNavigation: make('resetNavigation'),
    },
  };
}

describe('runAccountEviction', () => {
  it('runs every step, in the one order that is safe', async () => {
    // Requests are cancelled BEFORE credentials are cleared: an in-flight
    // request that resolves after the token is gone would re-populate a cache
    // we are about to wipe. Navigation is reset LAST so nothing renders
    // against half-cleared state.
    const { calls, deps } = steps();

    const failures = await runAccountEviction(deps);

    expect(calls).toEqual([...EVICTION_STEP_ORDER]);
    expect(failures).toEqual([]);
  });

  it('completes the eviction even when a step throws', async () => {
    // Fail-safe, not fail-fast: the account is already disabled. A Keychain
    // rejection while clearing credentials must not leave the caches, the
    // outbox and the navigation stack behind.
    const { calls, deps } = steps({
      signOutLocal: () => {
        throw new Error('Keychain unavailable');
      },
    });

    const failures = await runAccountEviction(deps);

    expect(calls).toEqual([...EVICTION_STEP_ORDER]);
    expect(failures).toEqual(['signOutLocal']);
  });

  it('reports every failing step and never rejects', async () => {
    const { deps } = steps({
      clearCaches: () => Promise.reject(new Error('db closed')),
      resetNavigation: () => {
        throw new Error('navigator not mounted');
      },
    });

    await expect(runAccountEviction(deps)).resolves.toEqual(['clearCaches', 'resetNavigation']);
  });

  it('cancels requests before it clears credentials', () => {
    expect(EVICTION_STEP_ORDER.indexOf('cancelRequests')).toBeLessThan(
      EVICTION_STEP_ORDER.indexOf('signOutLocal'),
    );
    expect(EVICTION_STEP_ORDER.indexOf('signOutLocal')).toBeLessThan(
      EVICTION_STEP_ORDER.indexOf('clearCaches'),
    );
    expect(EVICTION_STEP_ORDER[EVICTION_STEP_ORDER.length - 1]).toBe('resetNavigation');
  });
});

describe('nextGateForProbe', () => {
  it('maps a confirmed ban to the disabled gate', () => {
    expect(nextGateForProbe('ok', 'disabled')).toBe('disabled');
    expect(nextGateForProbe('unverified', 'disabled')).toBe('disabled');
  });

  it('maps a resolving user back to ok, clearing a stale screen', () => {
    expect(nextGateForProbe('unverified', 'active')).toBe('ok');
    expect(nextGateForProbe('disabled', 'active')).toBe('ok');
  });

  it('maps an identity-server outage to unverified, NEVER to disabled', () => {
    expect(nextGateForProbe('ok', 'unavailable')).toBe('unverified');
  });

  it('changes nothing on unknown — an offline device keeps working', () => {
    expect(nextGateForProbe('ok', 'unknown')).toBeNull();
  });

  it('keeps a disabled account disabled when it goes offline', () => {
    expect(nextGateForProbe('disabled', 'unknown')).toBeNull();
  });

  it('releases the BLOCKING retry screen on an inconclusive retry', () => {
    // Otherwise a warehouse that loses its uplink while the transient screen is
    // up is stuck behind a retry button that can never succeed.
    expect(nextGateForProbe('unverified', 'unknown')).toBe('ok');
  });

  /**
   * 'signed-out' says nothing about the ACCOUNT — only that this device's
   * session is gone. It must therefore move the gate exactly as little as
   * 'unknown' does. Mapping it to 'disabled' would be the fake distinction:
   * an ordinary sign-out-everywhere from another device produces the identical
   * answer, and it would tell a perfectly healthy user to contact their
   * administrator.
   */
  it('never turns a dead session into a disabled account', () => {
    expect(nextGateForProbe('ok', 'signed-out')).toBeNull();
    expect(nextGateForProbe('disabled', 'signed-out')).toBeNull();
    expect(nextGateForProbe('unverified', 'signed-out')).toBe('ok');
  });
});

/**
 * WHERE a signed-out device lands.
 *
 * Before this, a revoked session drained away through supabase-js's own
 * handling and the app fell through the plain `!session` redirect to the
 * MARKETING screen — the observed line-5 symptom. A device that has just been
 * told its session is gone should be asked to sign in, because signing in is
 * the one action that can still learn the truth: GoTrue answers `user_banned`
 * to a disabled user's password grant even though it will not answer a probe.
 */
describe('the signed-out destination latch', () => {
  beforeEach(() => {
    __resetSessionEndedForTests();
  });

  it('defaults to the marketing screen — the pre-existing behaviour', () => {
    expect(signedOutRoute()).toBe(AUTH_WELCOME_ROUTE);
    expect(AUTH_WELCOME_ROUTE).toBe('/(auth)/welcome');
  });

  it('sends a device whose session died to SIGN-IN instead', () => {
    markSessionEnded();
    expect(signedOutRoute()).toBe(AUTH_SIGN_IN_ROUTE);
    expect(AUTH_SIGN_IN_ROUTE).toBe('/(auth)/sign-in');
  });

  /**
   * RootGate's redirect effect depends on `segments`, which has not updated by
   * the time the effect re-runs after the first `replace`. So it fires more
   * than once per sign-out. A read-and-clear latch answered sign-in on the
   * first call and the MARKETING SCREEN on the second, which then won — the
   * bug this replaced, caught on the simulator.
   */
  it('is STABLE across repeated reads — the redirect effect runs more than once', () => {
    markSessionEnded();
    expect(signedOutRoute()).toBe(AUTH_SIGN_IN_ROUTE);
    expect(signedOutRoute()).toBe(AUTH_SIGN_IN_ROUTE);
    expect(signedOutRoute()).toBe(AUTH_SIGN_IN_ROUTE);
  });

  it('goes back to the marketing screen once the device is healthy again', () => {
    markSessionEnded();
    expect(signedOutRoute()).toBe(AUTH_SIGN_IN_ROUTE);
    clearSessionEnded();
    expect(signedOutRoute()).toBe(AUTH_WELCOME_ROUTE);
  });
});

describe('settleProbeResult', () => {
  beforeEach(() => {
    __resetSessionEndedForTests();
  });

  it('signs the device out locally, once, when the session is gone', async () => {
    const signOutLocal = vi.fn(async () => {});

    const gate = await settleProbeResult('ok', 'signed-out', signOutLocal);

    expect(signOutLocal).toHaveBeenCalledTimes(1);
    expect(gate).toBeNull();
    expect(signedOutRoute()).toBe(AUTH_SIGN_IN_ROUTE);
  });

  it('leaves the session alone for every other verdict', async () => {
    const signOutLocal = vi.fn(async () => {});

    expect(await settleProbeResult('ok', 'disabled', signOutLocal)).toBe('disabled');
    expect(await settleProbeResult('ok', 'active', signOutLocal)).toBe('ok');
    expect(await settleProbeResult('ok', 'unavailable', signOutLocal)).toBe('unverified');
    expect(await settleProbeResult('ok', 'unknown', signOutLocal)).toBeNull();

    expect(signOutLocal).not.toHaveBeenCalled();
    expect(signedOutRoute()).toBe(AUTH_WELCOME_ROUTE);
  });

  it('still marks the destination when the sign-out itself throws', async () => {
    // The Keychain can reject. The session is gone either way, so the user must
    // still be routed somewhere they can actually recover from.
    const signOutLocal = vi.fn(async () => {
      throw new Error('Keychain unavailable');
    });

    await expect(settleProbeResult('ok', 'signed-out', signOutLocal)).resolves.toBeNull();
    expect(signedOutRoute()).toBe(AUTH_SIGN_IN_ROUTE);
  });
});

/**
 * WHY THE DESTINATION IS STAKED BEFORE THE PROBE, NOT AFTER IT.
 *
 * Pinned from a simulator run that failed. gotrue-js `await`s `_removeSession()`
 * — which notifies SIGNED_OUT — from INSIDE `getUser()`, before it returns the
 * result. So the app's session hits null, and RootGate's `!session` redirect
 * runs, while the probe call is still on the stack. Marking the destination in
 * the `.then()` is unconditionally too late: the redirect has already read the
 * unstaked latch and sent the device to the marketing screen. Observed exactly
 * that way — a relaunch against a disabled account landed on the marketing
 * screen despite the classifier being correct.
 *
 * So the stake goes up FIRST and comes down if the account turns out to be
 * fine. It cannot produce a false positive: the only thing that consumes it is
 * a redirect that fires because the session is gone, and during a probe the
 * session can only go away if it was already dead.
 */
describe('probeAndSettle', () => {
  beforeEach(() => {
    __resetSessionEndedForTests();
  });

  it('has already staked SIGN-IN by the time the probe drops the session', async () => {
    let routeSeenMidProbe: string | null = null;
    const res = await probeAndSettle(
      'ok',
      async () => {
        // Stands in for gotrue-js's internal _removeSession(): the redirect
        // effect runs HERE, before the probe result exists.
        routeSeenMidProbe = signedOutRoute();
        return { data: { user: null }, error: { name: 'AuthSessionMissingError', status: 400 } };
      },
      async () => {},
    );

    expect(routeSeenMidProbe).toBe(AUTH_SIGN_IN_ROUTE);
    expect(res.result).toBe('signed-out');
    expect(res.gate).toBeNull();
  });

  it('takes the stake back down when the account is healthy', async () => {
    const res = await probeAndSettle(
      'ok',
      async () => ({ data: { user: { id: 'u1' } }, error: null }),
      async () => {},
    );

    expect(res.result).toBe('active');
    expect(res.gate).toBe('ok');
    expect(signedOutRoute()).toBe(AUTH_WELCOME_ROUTE);
  });

  it('takes it down on an inconclusive answer too — an offline device keeps its session', async () => {
    const res = await probeAndSettle('ok', async () => null, async () => {});

    expect(res.result).toBe('unknown');
    expect(signedOutRoute()).toBe(AUTH_WELCOME_ROUTE);
  });

  it('leaves it down for a confirmed ban — the disabled screen owns the render', async () => {
    const res = await probeAndSettle(
      'ok',
      async () => ({ data: { user: null }, error: { code: 'user_banned' } }),
      async () => {},
    );

    expect(res.gate).toBe('disabled');
    expect(signedOutRoute()).toBe(AUTH_WELCOME_ROUTE);
  });

  it('signs out locally when the session is gone', async () => {
    const signOutLocal = vi.fn(async () => {});

    await probeAndSettle(
      'ok',
      async () => ({ data: { user: null }, error: { code: 'refresh_token_not_found' } }),
      signOutLocal,
    );

    expect(signOutLocal).toHaveBeenCalledTimes(1);
  });

  it('classifies a probe that threw as inconclusive rather than exploding', async () => {
    const res = await probeAndSettle(
      'ok',
      async () => {
        throw new Error('Network request failed');
      },
      async () => {},
    );

    expect(res.result).toBe('unknown');
    expect(res.gate).toBeNull();
    expect(signedOutRoute()).toBe(AUTH_WELCOME_ROUTE);
  });
});

/**
 * The ONLINE half of the fix, and the only place the broadcast's reason is
 * allowed to matter.
 *
 * `user:{id}:sessions` is a PUBLIC realtime channel (broadcast.ts posts with
 * `private: false`), so anyone holding the shipped anon key and a user's uuid
 * can forge a payload on it. Today the worst that buys them is a forced
 * sign-out. Letting a forged `reason` alone raise the disabled gate would also
 * hand them the ability to terminally reject a warehouse's queued offline work
 * — real data loss on an unauthenticated message.
 *
 * So the two halves are split by what each can be trusted for: the BROADCAST
 * says what happened, and the PROBE corroborates that it happened. A forged
 * disable against a live session is refused because getUser() still resolves
 * the user, and the device falls through to the ordinary force-logout it would
 * have done anyway.
 */
describe('gateForRevocation', () => {
  it('accepts a disable that the probe corroborates', () => {
    expect(gateForRevocation(true, 'signed-out')).toBe('disabled');
  });

  it('accepts a ban the probe confirmed outright, reason or not', () => {
    expect(gateForRevocation(true, 'disabled')).toBe('disabled');
    expect(gateForRevocation(false, 'disabled')).toBe('disabled');
  });

  it('REFUSES a claimed disable while the session is demonstrably alive', () => {
    expect(gateForRevocation(true, 'active')).toBeNull();
  });

  it('refuses a claimed disable it could not corroborate at all', () => {
    expect(gateForRevocation(true, 'unknown')).toBeNull();
    expect(gateForRevocation(true, 'unavailable')).toBeNull();
  });

  it('treats a reasonless revoke exactly as before — an ordinary sign-out', () => {
    expect(gateForRevocation(false, 'signed-out')).toBeNull();
    expect(gateForRevocation(false, 'active')).toBeNull();
    expect(gateForRevocation(false, 'unknown')).toBeNull();
  });
});

describe('accountScopedStorageKeys', () => {
  const keys = [
    'workspace.activeOrgId',
    'workspace.activeWarehouseId.org-1',
    'workspace.activeWarehouseId.org-2',
    'onboarding.whatsNew.seen',
    'scanner.tip.seen',
  ];

  it('picks the keys that belong to the signed-in account', () => {
    expect(accountScopedStorageKeys(keys).sort()).toEqual([
      'workspace.activeOrgId',
      'workspace.activeWarehouseId.org-1',
      'workspace.activeWarehouseId.org-2',
    ]);
  });

  it('leaves device-level preferences alone', () => {
    // These survive a sign-out today and must survive an eviction too: they
    // say nothing about the account, and wiping them would silently reset a
    // shared warehouse device.
    expect(accountScopedStorageKeys(keys)).not.toContain('scanner.tip.seen');
    expect(accountScopedStorageKeys(keys)).not.toContain('onboarding.whatsNew.seen');
  });

  it('is empty when there is nothing to clear', () => {
    expect(accountScopedStorageKeys([])).toEqual([]);
  });
});

describe('shouldRunProbeNow', () => {
  it('always runs the first probe', () => {
    expect(shouldRunProbeNow(1_000, null)).toBe(true);
  });

  it('refuses a second probe inside the window', () => {
    // Every screen on a dead session 401s at once. One getUser() round trip
    // per burst, not one per request.
    expect(shouldRunProbeNow(1_000 + PROBE_MIN_INTERVAL_MS - 1, 1_000)).toBe(false);
  });

  it('allows another probe once the window has passed', () => {
    expect(shouldRunProbeNow(1_000 + PROBE_MIN_INTERVAL_MS, 1_000)).toBe(true);
  });

  it('survives a clock that jumped backwards', () => {
    expect(shouldRunProbeNow(500, 1_000)).toBe(true);
  });
});

describe('withTimeout', () => {
  it('passes the real answer through when it arrives in time', async () => {
    await expect(withTimeout(Promise.resolve('answer'), 50, 'fallback')).resolves.toBe('answer');
  });

  it('falls back rather than waiting forever', async () => {
    // A captive portal accepts the connection and never replies. RN fetch has
    // no default timeout, so without this the force-logout path would hang.
    const never = new Promise<string>(() => {});
    await expect(withTimeout(never, 5, 'fallback')).resolves.toBe('fallback');
  });

  it('treats a rejection as the fallback, never as a throw', async () => {
    await expect(withTimeout(Promise.reject(new Error('offline')), 50, null)).resolves.toBeNull();
  });
});

describe('the unauthorized bus', () => {
  beforeEach(() => __resetUnauthorizedBusForTests());

  it('forwards a 401 to the registered handler exactly once per window', () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);

    notifyUnauthorized({ status: 401 }, 1_000);
    notifyUnauthorized({ status: 401 }, 1_500);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('forwards again after the window', () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);

    notifyUnauthorized({ status: 401 }, 1_000);
    notifyUnauthorized({ status: 401 }, 1_000 + PROBE_MIN_INTERVAL_MS);

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('ignores everything that is not a 401', () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);

    notifyUnauthorized({ status: 403 }, 1_000);
    notifyUnauthorized({ status: 500 }, 2_000);
    notifyUnauthorized(new Error('Network request failed'), 3_000);
    notifyUnauthorized(null, 4_000);

    expect(handler).not.toHaveBeenCalled();
  });

  it('is safe with no handler mounted, and does not burn the window', () => {
    expect(() => notifyUnauthorized({ status: 401 }, 1_000)).not.toThrow();

    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    notifyUnauthorized({ status: 401 }, 1_001);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('never lets a handler failure escape into the request path', () => {
    setUnauthorizedHandler(() => {
      throw new Error('probe exploded');
    });

    expect(() => notifyUnauthorized({ status: 401 }, 1_000)).not.toThrow();
  });

  it('stops forwarding once the handler is unmounted', () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    setUnauthorizedHandler(null);

    notifyUnauthorized({ status: 401 }, 1_000);

    expect(handler).not.toHaveBeenCalled();
  });
});

/**
 * THE EVICTION PRECONDITION — the unauthenticated data-destruction bug.
 *
 * The eviction terminally rejects THIS DEVICE's offline outbox and wipes its
 * SQLite cache. It used to hang off nothing but the transition into `disabled`,
 * and one of the paths into that transition is a FAILED sign-in: GoTrue
 * evaluates the ban BEFORE the password, so `user_banned` comes back for any
 * password at all. Anyone who could reach the sign-in screen and knew one
 * disabled colleague's email address could therefore destroy whatever queued
 * warehouse work was sitting on the device — which, after "Use password
 * instead" on the biometric lock, routinely belongs to somebody else entirely.
 *
 * So the verdict now has to say WHOSE it is. Only a verdict established about
 * the session this device is holding may evict; a verdict typed at the sign-in
 * screen may raise the screen and nothing more.
 */
describe('shouldRunEviction', () => {
  it('refuses to evict on a verdict typed at the SIGN-IN screen', () => {
    expect(
      shouldRunEviction({ state: 'disabled', evidence: 'sign-in', alreadyEvicting: false }),
    ).toBe(false);
  });

  it('evicts when the verdict is about the session this device holds', () => {
    expect(
      shouldRunEviction({ state: 'disabled', evidence: 'session', alreadyEvicting: false }),
    ).toBe(true);
  });

  it('fails CLOSED on an unattributed verdict', () => {
    expect(
      shouldRunEviction({ state: 'disabled', evidence: null, alreadyEvicting: false }),
    ).toBe(false);
  });

  it('never evicts without a confirmed disable', () => {
    for (const state of ['ok', 'unverified'] as const) {
      expect(shouldRunEviction({ state, evidence: 'session', alreadyEvicting: false })).toBe(
        false,
      );
    }
  });

  it('evicts at most once per transition', () => {
    expect(
      shouldRunEviction({ state: 'disabled', evidence: 'session', alreadyEvicting: true }),
    ).toBe(false);
  });
});

/**
 * WHICH auth events mean "this device LOST a session", as opposed to "this
 * device does not have one".
 *
 * auth-js delivers INITIAL_SESSION to every new subscriber, with a null session
 * on a device that has never signed in (GoTrueClient's `callback('INITIAL_SESSION',
 * null)`). Latching the signed-out destination on `!session` therefore fired on
 * a FRESH INSTALL and sent every first-run user to the sign-in screen —
 * `/(auth)/welcome`, the marketing screen, became unreachable at launch.
 *
 * A genuinely revoked session is different: auth-js drops it inside its own
 * initialize() via `_removeSession()`, which notifies SIGNED_OUT. That event is
 * the only trace a relaunch has, and it is the one that must latch.
 */
describe('isInvoluntarySessionEnd', () => {
  it('a fresh install is not a lost session', () => {
    expect(isInvoluntarySessionEnd('INITIAL_SESSION', false)).toBe(false);
  });

  it('a dropped session is', () => {
    expect(isInvoluntarySessionEnd('SIGNED_OUT', false)).toBe(true);
  });

  it('ignores every other null-session event', () => {
    for (const event of ['TOKEN_REFRESHED', 'USER_UPDATED', 'PASSWORD_RECOVERY']) {
      expect(isInvoluntarySessionEnd(event, false)).toBe(false);
    }
  });

  it('never latches while a session is still in hand', () => {
    expect(isInvoluntarySessionEnd('SIGNED_OUT', true)).toBe(false);
    expect(isInvoluntarySessionEnd('INITIAL_SESSION', true)).toBe(false);
  });

  it('leaves a signed-out cold launch on the marketing screen', () => {
    __resetSessionEndedForTests();
    if (isInvoluntarySessionEnd('INITIAL_SESSION', false)) markSessionEnded();
    expect(signedOutRoute()).toBe(AUTH_WELCOME_ROUTE);
  });

  it('still sends a revoked relaunch to sign-in', () => {
    __resetSessionEndedForTests();
    if (isInvoluntarySessionEnd('SIGNED_OUT', false)) markSessionEnded();
    expect(signedOutRoute()).toBe(AUTH_SIGN_IN_ROUTE);
  });
});

/**
 * A GoTrue 5xx must not blockade an offline-first app.
 *
 * `unverified` used to replace the whole app with a retry button, so an
 * identity-server blip cut a warehouse phone off from its own SQLite cache and
 * its own outbox — the two things built to work without a server. It is now a
 * background condition: the app runs on its cached session and re-probes on a
 * backoff until the answer lands.
 */
describe('unverifiedRetryDelayMs', () => {
  it('retries soon enough to clear a blip on its own', () => {
    expect(unverifiedRetryDelayMs(0)).toBe(UNVERIFIED_RETRY_DELAYS_MS[0]);
    expect(unverifiedRetryDelayMs(0)).toBeLessThanOrEqual(30_000);
  });

  it('backs off rather than hammering an already-failing identity server', () => {
    expect(unverifiedRetryDelayMs(1)).toBeGreaterThan(unverifiedRetryDelayMs(0));
    expect(unverifiedRetryDelayMs(2)).toBeGreaterThan(unverifiedRetryDelayMs(1));
  });

  it('caps, and stays capped for a long outage', () => {
    const last = UNVERIFIED_RETRY_DELAYS_MS[UNVERIFIED_RETRY_DELAYS_MS.length - 1];
    expect(unverifiedRetryDelayMs(UNVERIFIED_RETRY_DELAYS_MS.length)).toBe(last);
    expect(unverifiedRetryDelayMs(9_999)).toBe(last);
  });

  it('never schedules a zero or negative timer', () => {
    for (const attempt of [-5, -1, 0, 1, 4, 40]) {
      expect(unverifiedRetryDelayMs(attempt)).toBeGreaterThan(0);
    }
  });
});

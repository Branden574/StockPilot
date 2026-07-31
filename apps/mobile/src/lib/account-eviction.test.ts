import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetUnauthorizedBusForTests,
  accountScopedStorageKeys,
  EVICTION_STEP_ORDER,
  nextGateForProbe,
  notifyUnauthorized,
  PROBE_MIN_INTERVAL_MS,
  runAccountEviction,
  setUnauthorizedHandler,
  shouldRunProbeNow,
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

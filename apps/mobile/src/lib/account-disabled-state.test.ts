import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetAccountGateForTests,
  getAccountDisabled,
  getAccountGateState,
  resetAccountDisabled,
  setAccountDisabled,
  setAccountGateState,
  subscribeAccountDisabled,
  subscribeAccountGate,
} from './account-disabled-state';

describe('account-disabled flag', () => {
  beforeEach(() => __resetAccountGateForTests());

  it('starts false', () => {
    expect(getAccountDisabled()).toBe(false);
  });

  it('notifies subscribers on a real change only', () => {
    const seen = vi.fn();
    subscribeAccountDisabled(seen);

    setAccountDisabled(true);
    setAccountDisabled(true);

    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenCalledWith(true);
    expect(getAccountDisabled()).toBe(true);
  });

  it('clears on re-enable so a fresh sign-in is not blocked by a stale flag', () => {
    setAccountDisabled(true);
    setAccountDisabled(false);

    expect(getAccountDisabled()).toBe(false);
  });

  it('unsubscribes cleanly', () => {
    const seen = vi.fn();
    const off = subscribeAccountDisabled(seen);
    off();

    setAccountDisabled(true);

    expect(seen).not.toHaveBeenCalled();
  });

  it('resetAccountDisabled clears the flag but KEEPS the listeners', () => {
    // RootGate subscribes exactly once, in a mount effect with an empty dep
    // array. If a reset dropped that subscription, a later disable in the same
    // JS runtime would set the flag with nobody listening and the screen would
    // never render.
    const seen = vi.fn();
    subscribeAccountDisabled(seen);
    setAccountDisabled(true);
    seen.mockClear();

    resetAccountDisabled();

    expect(getAccountDisabled()).toBe(false);
    expect(seen).toHaveBeenCalledWith(false);
  });
});

describe('account gate state', () => {
  beforeEach(() => __resetAccountGateForTests());

  it('starts ok', () => {
    expect(getAccountGateState()).toBe('ok');
  });

  it('carries the third state the web guard has: unverified is NOT disabled', () => {
    // Mirrors AccountStatusUnavailableError on the web. An unreadable status
    // must deny, and must NOT look like a disable: the disabled copy tells a
    // person to contact their administrator, which is the wrong thing to say
    // to someone whose account is fine.
    setAccountGateState('unverified');

    expect(getAccountGateState()).toBe('unverified');
    expect(getAccountDisabled()).toBe(false);
  });

  it('does not wake the boolean subscribers when only the transient state moved', () => {
    const seen = vi.fn();
    subscribeAccountDisabled(seen);

    setAccountGateState('unverified');
    setAccountGateState('ok');

    expect(seen).not.toHaveBeenCalled();
  });

  it('notifies gate subscribers on every real transition', () => {
    const seen = vi.fn();
    subscribeAccountGate(seen);

    setAccountGateState('unverified');
    setAccountGateState('unverified');
    setAccountGateState('disabled');

    expect(seen.mock.calls).toEqual([['unverified'], ['disabled']]);
  });

  it('setAccountDisabled(true) is the same transition as the disabled state', () => {
    const seen = vi.fn();
    subscribeAccountGate(seen);

    setAccountDisabled(true);

    expect(getAccountGateState()).toBe('disabled');
    expect(seen).toHaveBeenCalledWith('disabled');
  });
});

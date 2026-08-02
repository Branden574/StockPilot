import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetAccountGateForTests,
  getAccountDisabled,
  getAccountGateState,
  getDisableEvidence,
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

/**
 * WHOSE verdict is it?
 *
 * The gate is raised from two very different places. A probe (or a corroborated
 * eviction broadcast) answers about the session THIS DEVICE is holding. A
 * password grant typed at the sign-in screen answers about whatever email was
 * typed — by anyone, with any password, since GoTrue evaluates the ban before
 * the password. Only the first may drive the eviction, which terminally rejects
 * the device's offline outbox, so the state has to carry which one it was.
 */
describe('how the disabled verdict was established', () => {
  beforeEach(() => __resetAccountGateForTests());

  it('has no evidence at rest', () => {
    expect(getDisableEvidence()).toBeNull();
  });

  it('attributes a probe/broadcast verdict to this device session', () => {
    setAccountGateState('disabled');
    expect(getDisableEvidence()).toBe('session');
  });

  it('records a sign-in rejection as exactly that', () => {
    setAccountDisabled(true, 'sign-in');
    expect(getAccountGateState()).toBe('disabled');
    expect(getDisableEvidence()).toBe('sign-in');
  });

  it('forgets the evidence the moment the gate leaves disabled', () => {
    setAccountDisabled(true, 'sign-in');
    setAccountDisabled(false);
    expect(getDisableEvidence()).toBeNull();
  });

  it('does not let a stale sign-in verdict outlive a re-raise from the session', () => {
    setAccountDisabled(true, 'sign-in');
    resetAccountDisabled();
    setAccountGateState('disabled');
    expect(getDisableEvidence()).toBe('session');
  });

  it('carries no evidence for the transient state', () => {
    setAccountGateState('unverified');
    expect(getDisableEvidence()).toBeNull();
  });
});

/**
 * M-1 — THE STRENGTHEN-MUST-NOTIFY TRAP.
 *
 * A repeat 'disabled' verdict that upgrades 'sign-in' evidence to 'session'
 * (the sign-in screen raised the screen first; a corroborated probe or
 * broadcast confirms it is really this device's own session afterwards) used
 * to return silently — no gateListeners call at all. use-account-gate.ts's
 * eviction effect depends on React state; without a notification here it can
 * never learn the verdict strengthened, and a legitimately evictable device
 * would sit on the disabled screen forever with its outbox never rejected.
 */
describe('a strengthened verdict must notify gate listeners', () => {
  beforeEach(() => __resetAccountGateForTests());

  it('notifies when a repeat disabled verdict upgrades sign-in to session', () => {
    setAccountDisabled(true, 'sign-in');
    const seen = vi.fn();
    subscribeAccountGate(seen);

    setAccountGateState('disabled', 'session');

    expect(getDisableEvidence()).toBe('session');
    expect(seen).toHaveBeenCalledWith('disabled');
  });

  it('does not re-notify when the repeat verdict already carries session evidence', () => {
    setAccountDisabled(true, 'session');
    const seen = vi.fn();
    subscribeAccountGate(seen);

    setAccountGateState('disabled', 'session');

    expect(seen).not.toHaveBeenCalled();
  });

  it('does not notify a repeat verdict that stays (or would weaken to) sign-in', () => {
    setAccountDisabled(true, 'sign-in');
    const seen = vi.fn();
    subscribeAccountGate(seen);

    setAccountGateState('disabled', 'sign-in');

    expect(getDisableEvidence()).toBe('sign-in');
    expect(seen).not.toHaveBeenCalled();
  });

  it('never wakes the boolean subscribers on a strengthen — the boolean did not move', () => {
    setAccountDisabled(true, 'sign-in');
    const seen = vi.fn();
    subscribeAccountDisabled(seen);

    setAccountGateState('disabled', 'session');

    expect(seen).not.toHaveBeenCalled();
  });
});

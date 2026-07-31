import { beforeEach, describe, expect, it } from 'vitest';

import {
  abortAllInFlight,
  inFlightCount,
  registerInFlight,
} from './request-cancellation';

describe('in-flight request registry', () => {
  beforeEach(() => {
    abortAllInFlight();
  });

  it('tracks a request while it is in flight and releases it afterwards', () => {
    const ctrl = new AbortController();
    const release = registerInFlight(ctrl);

    expect(inFlightCount()).toBe(1);

    release();

    expect(inFlightCount()).toBe(0);
    expect(ctrl.signal.aborted).toBe(false);
  });

  it('aborts every registered request and empties the registry', () => {
    // Eviction has to reach requests that are ALREADY on the wire: one that
    // lands after the credentials are cleared would repopulate a cache the
    // eviction just wiped, with data the account may no longer read.
    const a = new AbortController();
    const b = new AbortController();
    registerInFlight(a);
    registerInFlight(b);

    const aborted = abortAllInFlight();

    expect(aborted).toBe(2);
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(true);
    expect(inFlightCount()).toBe(0);
  });

  it('is idempotent and safe over an already-aborted request', () => {
    const ctrl = new AbortController();
    registerInFlight(ctrl);
    ctrl.abort();

    expect(() => abortAllInFlight()).not.toThrow();
    expect(abortAllInFlight()).toBe(0);
  });

  it('releasing twice does not disturb another request', () => {
    const a = new AbortController();
    const b = new AbortController();
    const releaseA = registerInFlight(a);
    registerInFlight(b);

    releaseA();
    releaseA();

    expect(inFlightCount()).toBe(1);
    expect(b.signal.aborted).toBe(false);
  });
});

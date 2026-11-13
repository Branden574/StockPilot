import { describe, expect, it } from 'vitest';

import {
  bundleRefillStep,
  parseBundleRefill,
  serializeBundleRefill,
  type BundleRefillState,
} from './bundle-refill';

/** The rule behind "kits come back after access returns" (bundle-refill.ts). */

const none: BundleRefillState = { missing: [], fullPullOwed: false };
const step = (fullPull: boolean, active: string[], cached: string[], previous = none) =>
  bundleRefillStep({ fullPull, activeIds: active, cachedIds: new Set(cached), previous });

describe('bundleRefillStep', () => {
  it('nothing missing: nothing owed, nothing reported', () => {
    expect(step(false, ['k1'], ['k1'])).toEqual({ next: none, stillMissing: null });
    expect(step(true, ['k1'], ['k1'])).toEqual({ next: none, stillMissing: null });
  });

  it('a delta naming a kit the phone lacks owes one full pull', () => {
    expect(step(false, ['k2', 'k1'], ['k1'])).toEqual({
      next: { missing: ['k2'], fullPullOwed: true },
      stillMissing: null,
    });
  });

  it('a full pull that still lacks it reports it and owes nothing more', () => {
    const owed = { missing: ['k2'], fullPullOwed: true };
    expect(step(true, ['k1', 'k2'], ['k1'], owed)).toEqual({
      next: { missing: ['k2'], fullPullOwed: false },
      stillMissing: ['k2'],
    });
  });

  it('the same missing ids on later deltas ask for no further full pull', () => {
    const reported = { missing: ['k2'], fullPullOwed: false };
    expect(step(false, ['k1', 'k2'], ['k1'], reported).next.fullPullOwed).toBe(false);
  });

  it('a new missing id asks again; a full pull still owed stays owed', () => {
    const reported = { missing: ['k2'], fullPullOwed: false };
    expect(step(false, ['k1', 'k2', 'k3'], ['k1'], reported).next).toEqual({
      missing: ['k2', 'k3'],
      fullPullOwed: true,
    });
    const owed = { missing: ['k2'], fullPullOwed: true };
    expect(step(false, ['k2'], [], owed).next.fullPullOwed).toBe(true);
  });
});

describe('an answer with no active list (an older server, a failed read of the list)', () => {
  const owed = { missing: ['k2'], fullPullOwed: true };
  const noList = (fullPull: boolean, previous: BundleRefillState) =>
    bundleRefillStep({ fullPull, activeIds: null, cachedIds: new Set(), previous });

  it('a full pull ends the request and keeps the ids remembered', () => {
    expect(noList(true, owed)).toEqual({
      next: { missing: ['k2'], fullPullOwed: false },
      stillMissing: null,
    });
    // So the same id on a later delta asks for no second full pull.
    expect(step(false, ['k2'], [], noList(true, owed).next).next.fullPullOwed).toBe(false);
  });

  it('a delta changes nothing', () => {
    expect(noList(false, owed)).toEqual({ next: owed, stillMissing: null });
    expect(noList(false, none)).toEqual({ next: none, stillMissing: null });
  });
});

describe('the saved value', () => {
  it('round-trips, and reads absent or unreadable as nothing missing', () => {
    const v = { missing: ['k2'], fullPullOwed: true };
    expect(parseBundleRefill(serializeBundleRefill(v))).toEqual(v);
    expect(parseBundleRefill(null)).toEqual(none);
    expect(parseBundleRefill('not json')).toEqual(none);
    expect(parseBundleRefill('{"missing":"k2","fullPullOwed":"yes"}')).toEqual(none);
  });
});

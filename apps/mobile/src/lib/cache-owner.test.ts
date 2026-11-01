import { describe, expect, it } from 'vitest';

import { cacheOwnerAction } from './cache-owner';

describe('cacheOwnerAction', () => {
  it("resets another account's cache", () => {
    expect(cacheOwnerAction('u0', 'u1')).toBe('reset');
  });

  it("keeps this account's own cache", () => {
    expect(cacheOwnerAction('u1', 'u1')).toBe('keep');
  });

  // Which wipes may leave no record, in what order, and what an adopt clears
  // (the photos, and the rows it cannot confirm) are executed in
  // cache-owner.sqlite.test.ts.
  it('adopts a cache with no recorded owner (a fresh install, one emptied with its photos at a sign-out or an eviction, or one an older release left)', () => {
    expect(cacheOwnerAction(null, 'u1')).toBe('adopt');
    expect(cacheOwnerAction('', 'u1')).toBe('adopt');
  });

  it('decides nothing with nobody signed in', () => {
    expect(cacheOwnerAction('u0', null)).toBe('keep');
    expect(cacheOwnerAction(null, null)).toBe('keep');
    expect(cacheOwnerAction('u0', null, true)).toBe('keep');
  });

  // B18 review of 254fb9c72: a photo clear that failed at the reset or the
  // adopt is recorded beside the owner, never by leaving the owner absent
  // (which made another account adopt this one's rows instead of resetting
  // them). Executed end to end in cache-owner.sqlite.test.ts.
  it("clears the photos again, and does nothing else, for this account's own cache while a clear is owed", () => {
    expect(cacheOwnerAction('u1', 'u1', true)).toBe('clear-photos');
    expect(cacheOwnerAction('u1', 'u1', false)).toBe('keep');
  });

  it("a clear owed changes nothing for another account's cache, or for one with no owner recorded", () => {
    expect(cacheOwnerAction('u0', 'u1', true)).toBe('reset');
    expect(cacheOwnerAction(null, 'u1', true)).toBe('adopt');
  });
});

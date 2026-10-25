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
  // (the photos, not the rows) are executed in cache-owner.sqlite.test.ts.
  it('adopts a cache with no recorded owner (a fresh install, one emptied with its photos at a sign-out or an eviction, or one an older release left)', () => {
    expect(cacheOwnerAction(null, 'u1')).toBe('adopt');
    expect(cacheOwnerAction('', 'u1')).toBe('adopt');
  });

  it('decides nothing with nobody signed in', () => {
    expect(cacheOwnerAction('u0', null)).toBe('keep');
    expect(cacheOwnerAction(null, null)).toBe('keep');
  });
});

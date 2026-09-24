import { describe, expect, it } from 'vitest';

import { cacheOwnerAction } from './cache-owner';

describe('cacheOwnerAction', () => {
  it("resets another account's cache", () => {
    expect(cacheOwnerAction('u0', 'u1')).toBe('reset');
  });

  it("keeps this account's own cache", () => {
    expect(cacheOwnerAction('u1', 'u1')).toBe('keep');
  });

  it('adopts a cache with no recorded owner (pulled before owners were recorded, or just wiped)', () => {
    expect(cacheOwnerAction(null, 'u1')).toBe('adopt');
    expect(cacheOwnerAction('', 'u1')).toBe('adopt');
  });

  it('decides nothing with nobody signed in', () => {
    expect(cacheOwnerAction('u0', null)).toBe('keep');
    expect(cacheOwnerAction(null, null)).toBe('keep');
  });
});

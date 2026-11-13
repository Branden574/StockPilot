import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { refreshCacheOwner, useCacheOwnerState } from './use-cache-owner';

/**
 * WHOSE CACHE THIS IS, AS A SCREEN SEES IT.
 *
 * The phone records the account its cache was pulled for (db.ts
 * getCacheOwner, cache-owner.ts). A session can end without a wipe ("Use a
 * different account", a revoked session, an expired refresh token), and the
 * next account's reset waits for its first pull, so for a while the saved
 * permissions and modules are another account's. screen-access.ts counts
 * saved access as this member's only when the recorded owner is the signed-in
 * account; this hook gives it the recorded owner, and whether the store has
 * answered: false until a read comes back, 'failed' when one threw (on a
 * re-read too), true once one comes back. Re-read when refreshCacheOwner() is
 * called (a pull records the owner; a switch re-reads).
 *
 * React is replaced so a call is a render (the harness of
 * use-effective-permissions.test.ts).
 */

const react = vi.hoisted(() => ({
  mounted: false,
  state: undefined as unknown,
  cleanup: undefined as undefined | (() => void),
}));
vi.mock('react', () => ({
  useState: (initial: unknown) => {
    if (!react.mounted) {
      react.mounted = true;
      react.state = initial;
    }
    const set = (next: unknown) => {
      react.state =
        typeof next === 'function' ? (next as (prev: unknown) => unknown)(react.state) : next;
    };
    return [react.state, set];
  },
  useEffect: (effect: () => undefined | (() => void)) => {
    if (react.cleanup === undefined) react.cleanup = effect() ?? (() => undefined);
  },
}));

const db = vi.hoisted(() => ({
  getCacheOwner: vi.fn<() => Promise<string | null>>(),
}));
vi.mock('./db', () => db);

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  react.mounted = false;
  react.state = undefined;
  db.getCacheOwner.mockReset();
});

afterEach(() => {
  react.cleanup?.();
  react.cleanup = undefined;
});

describe('useCacheOwnerState', () => {
  it('before the store answers: not answered', () => {
    db.getCacheOwner.mockReturnValue(new Promise(() => undefined));
    expect(useCacheOwnerState()).toEqual({ ownerId: null, answered: false });
  });

  it('the recorded account, answered', async () => {
    db.getCacheOwner.mockResolvedValue('u-a');
    useCacheOwnerState();
    await settle();
    expect(useCacheOwnerState()).toEqual({ ownerId: 'u-a', answered: true });
  });

  it('none recorded: answered, nobody', async () => {
    db.getCacheOwner.mockResolvedValue(null);
    useCacheOwnerState();
    await settle();
    expect(useCacheOwnerState()).toEqual({ ownerId: null, answered: true });
  });

  it('a read that throws answers failed, and drops the owner read before', async () => {
    db.getCacheOwner.mockResolvedValue('u-a');
    useCacheOwnerState();
    await settle();
    db.getCacheOwner.mockRejectedValue(new Error('database is locked'));
    await refreshCacheOwner();
    expect(useCacheOwnerState()).toEqual({ ownerId: null, answered: 'failed' });
  });

  it('a refresh reads it again: the next account recorded by its reset', async () => {
    db.getCacheOwner.mockResolvedValue('u-a');
    useCacheOwnerState();
    await settle();
    db.getCacheOwner.mockResolvedValue('u-b');
    await refreshCacheOwner();
    expect(useCacheOwnerState()).toEqual({ ownerId: 'u-b', answered: true });
  });
});

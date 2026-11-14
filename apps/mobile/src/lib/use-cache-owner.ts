import * as React from 'react';

import { getCacheOwner } from './db';

/**
 * WHOSE CACHE THIS IS, FOR A SCREEN DECIDING WHAT IT READS OR SHOWS.
 *
 * The phone records the account its cache was pulled for (cache-owner.ts,
 * db.ts getCacheOwner). A session can end without a wipe ("Use a different
 * account", a revoked session, an expired refresh token), and the next
 * account's reset runs in its first pull, so until then the saved
 * permissions and modules are another account's. screen-access.ts counts
 * saved access as the signed-in member's only when the recorded owner is
 * that account.
 *
 * `answered` is false until a read comes back, 'failed' when the latest read
 * threw (the owner read before is dropped with it), true once one comes back.
 * Re-read when refreshCacheOwner() is called: sync.ts after it records an
 * owner (a reset, an adopt, a pull that landed), and a workspace switch.
 */
export interface CacheOwnerState {
  /** The account recorded as the cache's, or null when none is. */
  ownerId: string | null;
  answered: boolean | 'failed';
}

const listeners = new Set<() => Promise<void>>();

/**
 * Tell every screen to read whose cache this is again. Resolves once every
 * one has read it; never rejects.
 */
export function refreshCacheOwner(): Promise<void> {
  return Promise.all([...listeners].map((fn) => fn().catch(() => undefined))).then(() => undefined);
}

const UNREAD: CacheOwnerState = { ownerId: null, answered: false };

export function useCacheOwnerState(): CacheOwnerState {
  const [state, setState] = React.useState<CacheOwnerState>(UNREAD);

  React.useEffect(() => {
    let cancelled = false;
    const reread = async (): Promise<void> => {
      if (cancelled) return;
      let next: CacheOwnerState;
      try {
        next = { ownerId: await getCacheOwner(), answered: true };
      } catch {
        next = { ownerId: null, answered: 'failed' };
      }
      if (cancelled) return;
      setState((prev) =>
        prev.ownerId === next.ownerId && prev.answered === next.answered ? prev : next,
      );
    };
    listeners.add(reread);
    void reread();
    return () => {
      cancelled = true;
      listeners.delete(reread);
    };
  }, []);

  return state;
}

import {
  BUNDLES_NOT_AVAILABLE,
  NOT_SYNCED_YET,
  SAVED_ACCESS_UNREADABLE,
  type ScreenAccess,
} from './screen-access';

/**
 * WHAT A BUNDLE SCREEN SHOWS IN PLACE OF THE KITS, BY THE MEMBER'S ACCESS (S75).
 *
 * `busy` is a pull or a refresh still out. `refresh` is what the list's
 * Refresh and pull do: 'sync' (a sync; allowed, the kits are read again), a
 * 'reread' of what the phone saved about the member's access, or nothing to
 * offer (null: no Refresh).
 *   - allowed: the kits (the list's own body); Refresh syncs.
 *   - unknown: the spinner.
 *   - denied: "Bundles are not available to you in this workspace."
 *   - not synced yet for this member: the spinner while a pull is out, then
 *     that this phone has not finished syncing the workspace; Refresh syncs.
 *   - unreadable: said; Refresh reads it again.
 */
export interface BundlesGateView {
  spinner: boolean;
  words: string | null;
  refresh: 'sync' | 'reread' | null;
}

export function bundlesGateView(access: ScreenAccess, busy: boolean): BundlesGateView {
  switch (access) {
    case 'allowed':
      return { spinner: false, words: null, refresh: 'sync' };
    case 'unknown':
      return { spinner: true, words: null, refresh: null };
    case 'denied':
      return { spinner: false, words: BUNDLES_NOT_AVAILABLE, refresh: null };
    case 'not-synced':
      return busy
        ? { spinner: true, words: null, refresh: 'sync' }
        : { spinner: false, words: NOT_SYNCED_YET, refresh: 'sync' };
    case 'unreadable':
      return busy
        ? { spinner: true, words: null, refresh: 'reread' }
        : { spinner: false, words: SAVED_ACCESS_UNREADABLE, refresh: 'reread' };
  }
}

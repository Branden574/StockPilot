import * as Network from 'expo-network';
import * as React from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import { isOfflineState } from './exceptions-api';
import { syncNow } from './sync';
import { retryWorkspace } from './use-workspace';

import type { User } from '@supabase/supabase-js';

const FOREGROUND_INTERVAL_MS = 60_000;

/**
 * Run sync on:
 *   • mount (when a user is signed in)
 *   • app foreground transition
 *   • a 60s timer while foregrounded
 *
 * No-op when not signed in. Errors are swallowed inside syncNow so a
 * sync failure never crashes the app shell.
 *
 * The same moments, and the connection coming back, also load the workspace
 * again when none is shown (retryWorkspace, a no-op while one is): a launch
 * offline left the rental screens, and every screen reading with the
 * workspace, waiting until some other screen mounted online (review
 * 2026-09-26).
 */
export function useSync(user: User | null): void {
  React.useEffect(() => {
    if (!user) return;

    let cancelled = false;
    let interval: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (interval) return;
      interval = setInterval(() => {
        if (cancelled) return;
        void syncNow();
        void retryWorkspace();
      }, FOREGROUND_INTERVAL_MS);
    };
    const stop = () => {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    };

    void syncNow();
    start();

    const onAppStateChange = (state: AppStateStatus) => {
      if (state === 'active') {
        void syncNow();
        void retryWorkspace();
        start();
      } else {
        stop();
      }
    };
    const sub = AppState.addEventListener('change', onAppStateChange);
    // Back online: the same rule sync.ts isOnline() applies (isOfflineState).
    const netSub = Network.addNetworkStateListener((state) => {
      if (!cancelled && !isOfflineState(state)) void retryWorkspace();
    });

    return () => {
      cancelled = true;
      stop();
      sub.remove();
      netSub.remove();
    };
  }, [user]);
}

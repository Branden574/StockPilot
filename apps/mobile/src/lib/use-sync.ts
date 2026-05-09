import * as React from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import { syncNow } from './sync';

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
 */
export function useSync(user: User | null): void {
  React.useEffect(() => {
    if (!user) return;

    let cancelled = false;
    let interval: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (interval) return;
      interval = setInterval(() => {
        if (!cancelled) void syncNow();
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
        start();
      } else {
        stop();
      }
    };
    const sub = AppState.addEventListener('change', onAppStateChange);

    return () => {
      cancelled = true;
      stop();
      sub.remove();
    };
  }, [user]);
}

import * as React from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import { reportSeen } from './activity-beacon';

/**
 * Wires the "last seen" beacon to the two moments a PERSON drives: the app
 * coming to the foreground, and navigation (`routeKey` changes). No interval,
 * deliberately; see activity-beacon.ts. Does nothing while signed out.
 */
export function useActivityBeacon(userId: string | null, routeKey: string): void {
  React.useEffect(() => {
    if (!userId) return;
    void reportSeen(userId);
  }, [userId, routeKey]);

  React.useEffect(() => {
    if (!userId) return;
    const onChange = (state: AppStateStatus) => {
      if (state === 'active') void reportSeen(userId);
    };
    const sub = AppState.addEventListener('change', onChange);
    return () => sub.remove();
  }, [userId]);
}

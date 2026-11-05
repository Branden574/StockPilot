import * as React from 'react';

import { useAuth } from '../auth-context';
import { getAppearanceController } from './singleton';

/**
 * Tells the appearance controller who is signed in, from inside AuthProvider
 * (the AppearanceProvider sits above it). AuthProvider mounts as soon as the
 * fonts are ready, never behind the appearance wait (app/_layout.tsx), so
 * this may report while the first paint still waits. Runs once per person;
 * the account read never holds the screen (plan 3.4 rule 3), except on the
 * first start of the new JS on a phone with no record of its own, where the
 * controller has already read the stored session itself, inside the
 * first-paint cap (item 31): the same person reported here is a no-op, and
 * nobody (the session ended at its refresh) ends that wait at once:
 *   - a session: 'authenticated' (read the account's row: adopt it, or offer
 *     a fresh choice made signed out in this run, or this person's unsaved
 *     one, checked against the row first: SR1, SR4);
 *   - no session: 'signed-out' (the device keeps its look; the sync record goes);
 *   - while the session is still loading, or owes its authenticator code
 *     (MFA), nothing is reported: that person is not signed in yet.
 */
export function AppearanceSessionBridge() {
  const { session, loading, mfaRequired } = useAuth();
  const userId = session?.user?.id ?? null;
  React.useEffect(() => {
    if (loading || mfaRequired) return;
    getAppearanceController().setSession(userId);
  }, [loading, mfaRequired, userId]);
  return null;
}

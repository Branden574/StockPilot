import * as React from 'react';

import { useAuth } from '../auth-context';
import { getAppearanceController } from './singleton';

/**
 * Tells the appearance controller who is signed in, from inside AuthProvider
 * (the AppearanceProvider sits above it). Runs once per person, after the
 * first paint, so the account read never holds the screen (plan 3.4 rule 3);
 * the one exception is the first start of the new JS on a phone with no
 * record of its own, where the controller has already read the stored
 * session itself, inside the first-paint cap (item 31), and the same person
 * reported here is a no-op:
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

import * as React from 'react';

import { useAuth } from '../auth-context';
import { getAppearanceController } from './singleton';

/**
 * Tells the appearance controller who is signed in, from inside AuthProvider
 * (the AppearanceProvider sits above it). Runs once per person, after the
 * first paint, so the account read never holds the screen (plan 3.4 rule 3):
 *   - a session: 'authenticated' (adopt the account's row, or push a fresh
 *     pre-sign-in choice or this person's unsaved one);
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

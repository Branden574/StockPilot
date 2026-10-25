'use client';

import * as React from 'react';

import { expireInterruptedRuns, listenForPurges } from '@/lib/interrupted-run';

/**
 * Removes what an interrupted run kept in this tab (lib/interrupted-run) once
 * nobody can need it: whenever the app loads in the tab, every record over an
 * hour old or unreadable goes, whoever's it is, and while the app stays loaded
 * each remaining record goes at its hour (navigations inside the app keep the
 * root layout mounted; the timer covers them). Nothing is handed out: a fresh
 * record stays for its own account's page.
 *
 * It also listens, while it is mounted, for a sign-out in another tab of this
 * browser: the tabs share the session cookies, so that sign-out ends this
 * tab's session too, and some sign-outs send no revoke (the error pages'
 * "Sign out and back in", Delete my account). Its purge then clears this tab
 * as well, including a run going here (listenForPurges; the channel is open
 * only while this tab holds something to clear).
 *
 * Mounted in the root layout, so it runs whatever page the app loads on, above
 * all the sign-in page a session that expired leaves the tab on: that page
 * knows no account, so the app shell's sweep
 * (components/dashboard/dashboard-shell.tsx) never runs there. Renders nothing.
 */
export function InterruptedRunExpiry(): null {
  React.useEffect(() => {
    expireInterruptedRuns();
    return listenForPurges();
  }, []);
  return null;
}

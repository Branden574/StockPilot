'use client';

import * as React from 'react';

import { expireInterruptedRuns } from '@/lib/interrupted-run';

/**
 * Removes what an interrupted run kept in this tab (lib/interrupted-run) once
 * nobody can need it: as each page of the app loads, every record over an
 * hour old or unreadable goes, whoever's it is, and while the page stays open
 * each remaining record goes at its hour. Nothing is handed out: a fresh
 * record stays for its own account's page.
 *
 * Mounted in the root layout, so it runs on every page, above all the sign-in
 * page a session that expired leaves the tab on: that page knows no account,
 * so the app shell's sweep (components/dashboard/dashboard-shell.tsx) never
 * runs there. Renders nothing.
 */
export function InterruptedRunExpiry(): null {
  React.useEffect(() => {
    expireInterruptedRuns();
  }, []);
  return null;
}

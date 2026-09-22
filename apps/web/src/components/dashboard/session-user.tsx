'use client';

import * as React from 'react';

/**
 * The signed-in user's id, as the (dashboard) layout resolved it on the
 * server for this render (requireOrgContext). It exists to KEY per-person
 * client state (the tour state kept for the browser session, see
 * lib/onboarding/tour-state-cache.ts), so one person's cached UI state is
 * never served to another person in the same tab.
 *
 * It is NOT an authorization input and must never become one: every server
 * read and write derives the user from the session cookie, not from this.
 *
 * Default null: a component rendered outside the dashboard shell gets no key,
 * and callers treat that as "do not cache".
 */
const SessionUserIdContext = React.createContext<string | null>(null);

export function SessionUserProvider({
  userId,
  children,
}: {
  userId: string;
  children: React.ReactNode;
}) {
  return <SessionUserIdContext.Provider value={userId}>{children}</SessionUserIdContext.Provider>;
}

export function useSessionUserId(): string | null {
  return React.useContext(SessionUserIdContext);
}

import type { Role } from '@stockpilot/core';

import type { Announcement } from './announcements';

/**
 * PURE What's New filter + stamp logic — no Supabase, no Next, no I/O — so the
 * exact same semantics run on BOTH the web server action (cookie session,
 * actions.ts) and the mobile Bearer route (api/v1/me/announcements). Both
 * platforms write the SAME user_onboarding.viewed_announcements jsonb row, so a
 * single shared implementation is the only thing that keeps their "seen" maps
 * from drifting on the quirks that matter (array-order slice(0,3), roles
 * stripped before leaving the server, all:true stamps the ENTIRE registry, and
 * the preserve-don't-overwrite merge). Keep it dependency-free and unit-tested.
 */

/** What the client receives — the registry entry with `roles` stripped. */
export type ClientAnnouncement = Omit<Announcement, 'roles'>;

/**
 * Role-filtered, unseen, newest-first (registry array order — NEVER date-sort),
 * capped at 3, with `roles` stripped so role-gated copy never leaves the server
 * for a viewer who can't reach the feature. Mirrors the web action exactly.
 */
export function filterUnseenForClient(
  announcements: Announcement[],
  viewed: Record<string, unknown>,
  role: Role,
): ClientAnnouncement[] {
  return announcements
    .filter((a) => !viewed[a.id] && (!a.roles || a.roles.includes(role)))
    .slice(0, 3)
    .map(({ roles: _roles, ...rest }) => rest);
}

/**
 * The next viewed_announcements map after a close. `all` (the What's New
 * "I'm caught up" close) stamps EVERY registry id, not just the capped 1–3
 * shown — otherwise a backlog drips one modal per load. An id already present
 * keeps its original { at, outcome } (preserve, don't overwrite). `at` is
 * passed in (not read from the clock) so this stays pure/testable.
 */
export function computeSeenViewedMap(
  current: Record<string, unknown>,
  shownIds: string[],
  outcome: 'seen' | 'dismissed',
  all: boolean,
  allIds: string[],
  at: string,
): Record<string, unknown> {
  const ids = all ? allIds : shownIds;
  const additions = Object.fromEntries(
    ids.map((id) => [id, (current[id] as object | undefined) ?? { at, outcome }]),
  );
  return { ...current, ...additions };
}

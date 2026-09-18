import type { Role } from '@stockpilot/core';

import { RELEASES } from '@/lib/releases/registry';

/**
 * LEGACY VIEW of the release registry, kept for the mobile compatibility route
 * (/api/v1/me/announcements) and the pure helpers in announcement-logic.ts.
 *
 * The source of truth moved to lib/releases/registry.ts. This module used to BE
 * the registry; it now derives the old five-field shape from it so that nothing
 * is written twice and the two can never drift. The ids are unchanged, because
 * they key every person's seen-state on web and mobile
 * (user_onboarding.viewed_announcements): renaming one re-announces it to
 * everybody.
 *
 * `roles` carries only the role dimension of a release's audience. Reach is
 * decided by lib/releases/logic.ts (roles AND permissions AND modules); this
 * field is here for the legacy helper's signature, not as the gate.
 */
export interface Announcement {
  /** Stable slug — stored in user_onboarding.viewed_announcements. */
  id: string;
  /** ISO date of release, shown as the badge. */
  date: string;
  title: string;
  body: string;
  cta?: { href: string; label: string };
  roles?: Role[];
}

export const ANNOUNCEMENTS: Announcement[] = RELEASES.filter((r) => r.status === 'published').map(
  (r) => {
    const linked = r.entries.find((e) => e.link);
    const roles = r.audience?.roles ?? linked?.audience?.roles;
    return {
      id: r.id,
      date: r.publishedAt.slice(0, 10),
      title: r.title,
      body: r.summary,
      ...(linked?.link ? { cta: { href: linked.link.href, label: linked.link.label } } : {}),
      ...(roles ? { roles: [...roles] } : {}),
    };
  },
);

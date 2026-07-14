import { api } from './api';

/**
 * What's New transport (mobile parity for the web feature). The registry, the
 * role filter, and the seen/stamp semantics ALL live server-side
 * (/api/v1/me/announcements, which shares pure logic with the web action) — so
 * role-gated copy never ships in the app bundle and the two platforms can't
 * drift on the shared user_onboarding.viewed_announcements row. This file is
 * transport only.
 */

export interface AnnouncementItem {
  id: string;
  date: string;
  title: string;
  body: string;
  cta?: { href: string; label: string };
}

/** Unseen, role-filtered announcements (server-capped at 3). Fail-quiet to []. */
export async function getUnseenAnnouncements(): Promise<AnnouncementItem[]> {
  try {
    const res = await api<{ items: AnnouncementItem[] }>('/api/v1/me/announcements');
    return res.items ?? [];
  } catch {
    // What's New must never break the shell — no unseen items on any error.
    return [];
  }
}

/**
 * Record announcements seen. The close is "I'm caught up", so `all` defaults to
 * true and the server stamps the ENTIRE registry (not just the shown 1–3),
 * matching the web all:true close. Best-effort — a lost write re-shows once.
 */
export async function recordAnnouncementsSeen(
  ids: string[],
  outcome: 'seen' | 'dismissed',
  all = true,
): Promise<void> {
  try {
    await api('/api/v1/me/announcements', { method: 'POST', body: { ids, outcome, all } });
  } catch {
    // Swallow — never surface to the user.
  }
}

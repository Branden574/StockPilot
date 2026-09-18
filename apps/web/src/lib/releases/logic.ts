import {
  audienceIncludes,
  type ClientRelease,
  type ClientReleaseList,
  type ClientReleaseSummary,
  type Release,
  type ReleaseViewer,
} from '@stockpilot/core';

/**
 * PURE release logic: who sees what, what is unread, and what old clients get.
 * No Supabase, no Next, no clock (`now` and the baseline are parameters), so the
 * web routes, the dashboard pages and the mobile-compatibility route all share
 * one implementation and one set of tests.
 */

/** One row of user_release_state, as the service reads it. */
export interface ReleaseStateRow {
  release_id: string;
  /** The revision the timestamps below were recorded against. */
  revision: number;
  dismissed_at: string | null;
  opened_at: string | null;
  read_at: string | null;
}

/**
 * What a reader is allowed to see, newest first, in registry order.
 *
 *   - drafts never leave the server;
 *   - a release whose own audience excludes the reader is dropped;
 *   - inside it, entries the reader cannot reach are dropped, and a release left
 *     with no entries is dropped too: "there is news, but none of it is for you"
 *     is not news;
 *   - a WITHDRAWN release stays in history for readers it was addressed to, with
 *     its note and WITHOUT its entries or links, so nobody is sent to a feature
 *     that was pulled.
 */
export function visibleReleases(releases: readonly Release[], viewer: ReleaseViewer): Release[] {
  const out: Release[] = [];
  for (const r of releases) {
    if (r.status === 'draft') continue;
    if (!audienceIncludes(r.audience, viewer)) continue;
    const entries = r.entries.filter((e) => audienceIncludes(e.audience, viewer));
    if (entries.length === 0) continue;
    out.push({ ...r, entries: r.status === 'withdrawn' ? [] : entries });
  }
  return out;
}

/**
 * Is this release unread FOR THIS READER?
 *
 *   read        a read stamp recorded at this revision or later. Editing a typo
 *               does not bump the revision, so it never un-reads anything; a
 *               deliberate re-announcement does.
 *   no backlog  anything published before `baselineIso` (the day the account was
 *               created) counts as read. A new member should not be greeted by
 *               the product's entire history as a wall of unread dots.
 *   withdrawn   never unread: there is nothing to go and read.
 */
export function isUnread(
  release: Release,
  row: ReleaseStateRow | undefined,
  baselineIso: string | null,
): boolean {
  if (release.status !== 'published') return false;
  if (row?.read_at && row.revision >= release.revision) return false;
  const baseline = baselineIso ? Date.parse(baselineIso) : NaN;
  if (Number.isFinite(baseline) && Date.parse(release.publishedAt) < baseline) return false;
  return true;
}

function isDismissed(release: Release, row: ReleaseStateRow | undefined): boolean {
  return Boolean(row?.dismissed_at && row.revision >= release.revision);
}

export function toClientSummary(
  release: Release,
  row: ReleaseStateRow | undefined,
  baselineIso: string | null,
): ClientReleaseSummary {
  return {
    id: release.id,
    revision: release.revision,
    status: release.status === 'withdrawn' ? 'withdrawn' : 'published',
    ...(release.version ? { version: release.version } : {}),
    title: release.title,
    summary: release.summary,
    publishedAt: release.publishedAt,
    entryCount: release.entries.length,
    state: { read: !isUnread(release, row, baselineIso), dismissed: isDismissed(release, row) },
  };
}

/** `audience` is STRIPPED, on the release and on every entry. */
export function toClientRelease(
  release: Release,
  row: ReleaseStateRow | undefined,
  baselineIso: string | null,
): ClientRelease {
  return {
    ...toClientSummary(release, row, baselineIso),
    ...(release.withdrawnNote ? { withdrawnNote: release.withdrawnNote } : {}),
    entries: release.entries.map(({ audience: _audience, ...entry }) => entry),
  };
}

/**
 * The list the dashboard works from. `latestUnread` is what the notification
 * offers: the NEWEST unread release, and only while its notification has not
 * been dismissed.
 *
 * It deliberately does NOT fall through to the next unread release once the
 * newest is dismissed. That version shipped for an hour: closing the notice made
 * the next one appear, then the next, a drip of one prompt per missed release,
 * which is the burst this is meant to prevent. Closing the notice means "not
 * now" for What's New as a whole. Older unread releases stay one click away,
 * marked unread in history and counted on the topbar entry, and a NEWER release
 * prompts again.
 */
export function buildReleaseList(
  releases: readonly Release[],
  viewer: ReleaseViewer,
  rows: readonly ReleaseStateRow[],
  baselineIso: string | null,
): ClientReleaseList {
  const byId = new Map(rows.map((r) => [r.release_id, r]));
  const summaries = visibleReleases(releases, viewer).map((r) =>
    toClientSummary(r, byId.get(r.id), baselineIso),
  );
  const unread = summaries.filter((s) => !s.state.read);
  return {
    releases: summaries,
    unreadCount: unread.length,
    latestUnread: offeredRelease(unread),
    stateAvailable: true,
  };
}

/** The one release a notice may offer: the newest unread, unless it was dismissed. */
export function offeredRelease<T extends { state: { dismissed: boolean } }>(
  unreadNewestFirst: readonly T[],
): T | null {
  const newest = unreadNewestFirst[0];
  return newest && !newest.state.dismissed ? newest : null;
}

/**
 * Everything about the registry that can change what ANY reader sees, as one
 * string: every non-draft release with its revision and status, in order.
 *
 * /api/version is unauthenticated, so it serves a HASH of this and never an id:
 * a slug such as "pricing-change-owners" would tell a stranger that a release
 * exists, who it is for, and when it was re-announced. A tab only needs to know
 * that the registry CHANGED, to refetch its own per-reader list. Drafts are left
 * out so that preparing one changes nothing a client can observe.
 */
export function registryFingerprint(releases: readonly Release[]): string {
  return releases
    .filter((r) => r.status !== 'draft')
    .map((r) => `${r.id}@${r.revision}:${r.status}`)
    .join('|');
}

// ── Compatibility with mobile builds already in the field ───────────────────

/** Exactly what GET /api/v1/me/announcements has always returned per item. */
export interface LegacyAnnouncementItem {
  id: string;
  date: string;
  title: string;
  body: string;
  cta?: { href: string; label: string };
}

/**
 * The v1 announcements contract, served from the release registry.
 *
 * Old binaries render date/title/body/cta.label straight into <Text> with no
 * validation, so every one of them MUST be a string or the app's shell crashes;
 * the OTA channel cannot reach a binary on an older runtime to fix it. They also
 * cap nothing themselves (one dot per item), hence the server-side 3.
 *
 * "Seen" on this path is the legacy viewed_announcements map, by truthiness,
 * exactly as before. It is NOT the web's read state: one tap on a phone stamps
 * the entire registry as seen, which is fine for a phone and would erase the
 * web's dismissed/opened/read distinction if the two were the same thing.
 */
export function legacyAnnouncementsFor(
  releases: readonly Release[],
  viewer: ReleaseViewer,
  viewed: Record<string, unknown>,
): LegacyAnnouncementItem[] {
  return visibleReleases(releases, viewer)
    .filter((r) => r.status === 'published' && !viewed[r.id])
    .slice(0, 3)
    .map((r) => {
      const link = r.entries.find((e) => e.link)?.link;
      return {
        id: r.id,
        date: r.publishedAt.slice(0, 10),
        title: r.title,
        body: r.summary,
        ...(link ? { cta: { href: link.href, label: link.label } } : {}),
      };
    });
}

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  MODULE_REGISTRY,
  PERMISSIONS,
  type ModuleId,
  type Release,
  type ReleaseViewer,
} from '@stockpilot/core';

import { ANNOUNCEMENTS } from '@/lib/onboarding/announcements';

import {
  buildReleaseList,
  legacyAnnouncementsFor,
  registryFingerprint,
  visibleReleases,
} from './logic';
import { RELEASES } from './registry';

/**
 * Added by docs/whats-new-2026-11-02b (2026-11-02): the web changes merged on
 * 2026-11-02 (the last, #437, at 05:28:31Z; its web build answered from
 * 05:29:49Z) and S4 (#379, merged 02:00Z), in one release. No phone update
 * ships with it. It is the newest published release and sits directly below
 * the B44 phone update draft, which is dated later and stays a draft.
 *
 * Its own file, so the release tests other open branches edit stay as they
 * are. These tests pin what a published release must hold: its id, status,
 * revision and date, its entries, its links and who they reach, the notice
 * and the old phone builds' list.
 */
const ID = 'lists-delivery-sites-and-fixes-2026-11';
const release = () => RELEASES.find((r) => r.id === ID)!;

const everyone: ReleaseViewer = {
  role: 'owner',
  permissions: [...PERMISSIONS],
  enabledModules: Object.keys(MODULE_REGISTRY) as ModuleId[],
};
/** A member who holds no permission and no module. */
const member: ReleaseViewer = { role: 'viewer', permissions: [], enabledModules: [] };

/** '/dashboard/orders?x=y' -> does app/(dashboard)/dashboard/orders/page.tsx exist? */
const DASHBOARD_APP_DIR = resolve(__dirname, '../../app/(dashboard)');
function pageExistsFor(href: string): boolean {
  const path = href.split('?')[0]!.replace(/\/+$/, '');
  return existsSync(resolve(DASHBOARD_APP_DIR, `.${path}`, 'page.tsx'));
}

/** Every string a reader can see in the release. */
function readerText(r: Release): string[] {
  return [
    r.title,
    r.summary,
    ...r.entries.flatMap((e) => [
      e.title,
      e.area ?? '',
      e.whatChanged,
      e.whyItMatters,
      e.howItAffectsYou,
      e.whatToDo,
      e.link?.label ?? '',
    ]),
  ];
}

/**
 * Added by docs/whats-new-s43a-2026-11 (2026-11-02): the two releases
 * published after this one, directly below the B44 phone update draft and
 * above this release. The authenticator code release reaches every member (no
 * entry has an audience); the integration retries release reaches whoever
 * manages integrations with the Integrations module on, the owner here among
 * them. A test that expects this release to be a reader's notice, or first in
 * an old phone build's list, reads or sees both first (a read of a release a
 * reader is not told changes nothing).
 */
const AUTH_CODE_ID = 'authenticator-code-requests-2026-11';
const RETRIES_ID = 'integration-retries-2026-11';
const newerReads = [AUTH_CODE_ID, RETRIES_ID].map((id) => ({
  release_id: id,
  revision: 1,
  dismissed_at: null,
  opened_at: '2026-11-02T15:50:00Z',
  read_at: '2026-11-02T15:50:00Z',
}));
const newerSeen: Record<string, boolean> = { [AUTH_CODE_ID]: true, [RETRIES_ID]: true };

describe('the lists, delivery sites and fixes release (2026-11-02)', () => {
  // Renamed by docs/whats-new-s43a-2026-11 (2026-11-02; was: "is published once, as revision 1, directly below the B44 phone update draft and above the export fixes release", with ID at RELEASES[1], the export fixes release at RELEASES[2] and ID the first published release): the authenticator code and integration retries releases are published later, directly below the B44 phone update draft and above this one, so it and the export fixes release move down by two, and it is the third published release. Claim kept: published once, as revision 1, below the B44 phone update draft and directly above the export fixes release.
  it('is published once, as revision 1, directly below the authenticator code and integration retries releases (published later, below the B44 phone update draft) and above the export fixes release', () => {
    expect(RELEASES.filter((r) => r.id === ID)).toHaveLength(1);
    expect(release().status).toBe('published');
    expect(release().revision).toBe(1);
    expect(RELEASES[0]?.id).toBe('mobile-app-asks-before-restarting');
    expect(RELEASES[0]?.status).toBe('draft');
    expect(RELEASES[1]?.id).toBe(AUTH_CODE_ID);
    expect(RELEASES[1]?.status).toBe('published');
    expect(RELEASES[2]?.id).toBe(RETRIES_ID);
    expect(RELEASES[2]?.status).toBe('published');
    expect(RELEASES[3]?.id).toBe(ID);
    expect(RELEASES[4]?.id).toBe('export-fixes-2026-10');
    expect(
      RELEASES.filter((r) => r.status === 'published')
        .slice(0, 3)
        .map((r) => r.id),
    ).toEqual([AUTH_CODE_ID, RETRIES_ID, ID]);
  });

  it('is dated in the past on a whole minute, after its last change went live, and after every release below it', () => {
    const at = Date.parse(release().publishedAt);
    expect(release().publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/);
    expect(at).toBeLessThanOrEqual(Date.now());
    // #437 merged at 05:28:31Z and its web build answered from 05:29:49Z.
    expect(at).toBeGreaterThanOrEqual(Date.parse('2026-11-02T05:28:31Z'));
    expect(at).toBeGreaterThanOrEqual(Date.parse('2026-11-02T05:29:49Z'));
    expect(at).toBeLessThanOrEqual(Date.parse('2026-11-03T00:00:00Z'));
    const index = RELEASES.findIndex((r) => r.id === ID);
    for (const r of RELEASES.slice(index + 1)) {
      expect(at, r.id).toBeGreaterThan(Date.parse(r.publishedAt));
    }
  });

  it('has at most twelve entries, each with its own id and an answer to all four questions', () => {
    const entries = release().entries;
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.length).toBeLessThanOrEqual(12);
    expect(new Set(entries.map((e) => e.id)).size).toBe(entries.length);
    for (const e of entries) {
      expect(e.whatChanged.length, e.id).toBeGreaterThan(0);
      expect(e.whyItMatters.length, e.id).toBeGreaterThan(0);
      expect(e.howItAffectsYou.length, e.id).toBeGreaterThan(0);
      expect(e.whatToDo.length, e.id).toBeGreaterThan(0);
    }
  });

  it('links only to dashboard pages that exist, and every linked entry says who can reach it, with real permission and module names', () => {
    const linked = release().entries.filter((e) => e.link);
    expect(linked.map((e) => e.id)).toEqual([
      'lists-keep-search-and-filters',
      'delivery-sites-by-name-and-deleted-driver',
      'calendar-more-lists-the-day',
      'maintenance-draft-reminder-setting-words',
    ]);
    const known = new Set<string>(PERMISSIONS);
    for (const e of linked) {
      expect(e.link!.href, e.id).toMatch(/^\/dashboard(\/|$)/);
      expect(pageExistsFor(e.link!.href), `${e.id} -> ${e.link!.href}`).toBe(true);
      expect(e.audience, e.id).toBeDefined();
      for (const p of e.audience?.anyPermission ?? []) {
        expect(known.has(p), `${e.id}: ${p}`).toBe(true);
      }
      for (const m of e.audience?.modules ?? []) {
        expect(Object.keys(MODULE_REGISTRY), `${e.id}: ${m}`).toContain(m);
      }
    }
    expect(release().audience).toBeUndefined();
  });

  // Renamed by docs/whats-new-s43a-2026-11 (2026-11-02; was: "reaches every member, so it is the first notice for an owner and for a member with no permission, and an old phone build lists it first", with nothing read or seen): the authenticator code release, published later above it, reaches every member, and the integration retries release, published later too, reaches the owner, so every reader here reads or sees both first. Claim kept: it reaches every member, it is the first notice for an owner and for a member with no permission once those newer releases are read, and an old phone build lists it first once they are seen.
  it('reaches every member, so it is the first notice for an owner and for a member with no permission once the newer releases are read, and an old phone build lists it first once they are seen', () => {
    expect(
      visibleReleases(RELEASES, member)
        .find((r) => r.id === ID)
        ?.entries.map((e) => e.id),
    ).toEqual([
      'pdf-photos-on-white',
      'mistyped-link-not-found',
      'password-reset-asks-for-authenticator-code',
    ]);
    expect(
      visibleReleases(RELEASES, everyone)
        .find((r) => r.id === ID)
        ?.entries.map((e) => e.id),
    ).toEqual(release().entries.map((e) => e.id));
    for (const v of [everyone, member]) {
      expect(buildReleaseList(RELEASES, v, newerReads, null).latestUnread?.id, v.role).toBe(ID);
    }
    expect(legacyAnnouncementsFor(RELEASES, everyone, newerSeen)[0]).toEqual({
      id: ID,
      date: '2026-11-02',
      title: release().title,
      body: release().summary,
      cta: { href: '/dashboard/inventory', label: 'Open Items' },
    });
    // A member reaches no linked entry, so an old phone build shows the title
    // and the summary alone.
    expect(legacyAnnouncementsFor(RELEASES, member, newerSeen)[0]).toEqual({
      id: ID,
      date: '2026-11-02',
      title: release().title,
      body: release().summary,
    });
  });

  it('is in every feed and in the fingerprint, so publishing it changes what clients observe', () => {
    expect(buildReleaseList(RELEASES, everyone, [], null).releases.map((r) => r.id)).toContain(ID);
    expect(ANNOUNCEMENTS.map((a) => a.id)).toContain(ID);
    expect(registryFingerprint(RELEASES)).toContain(`${ID}@1:published`);
    expect(registryFingerprint(RELEASES)).not.toBe(
      registryFingerprint(RELEASES.filter((r) => r.id !== ID)),
    );
  });

  it('promises no phone update, and says which lines are on the web and which in the mobile app', () => {
    const text = readerText(release()).join(' ');
    expect(text).not.toMatch(
      /App Store|TestFlight|update the (mobile )?app|after the latest update/i,
    );
    expect(release().summary).toMatch(/^On the web, /);
    expect(release().summary).toContain('On the web and in the mobile app, delivery sites');
    expect(release().summary).toContain('In the mobile app, long AI Assistant chats');
  });
});

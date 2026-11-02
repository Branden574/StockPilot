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

describe('the lists, delivery sites and fixes release (2026-11-02)', () => {
  it('is published once, as revision 1, directly below the B44 phone update draft and above the export fixes release', () => {
    expect(RELEASES.filter((r) => r.id === ID)).toHaveLength(1);
    expect(release().status).toBe('published');
    expect(release().revision).toBe(1);
    expect(RELEASES[0]?.id).toBe('mobile-app-asks-before-restarting');
    expect(RELEASES[0]?.status).toBe('draft');
    expect(RELEASES[1]?.id).toBe(ID);
    expect(RELEASES[2]?.id).toBe('export-fixes-2026-10');
    expect(RELEASES.find((r) => r.status === 'published')?.id).toBe(ID);
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

  it('reaches every member, so it is the first notice for an owner and for a member with no permission, and an old phone build lists it first', () => {
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
      expect(buildReleaseList(RELEASES, v, [], null).latestUnread?.id, v.role).toBe(ID);
    }
    expect(legacyAnnouncementsFor(RELEASES, everyone, {})[0]).toEqual({
      id: ID,
      date: '2026-11-02',
      title: release().title,
      body: release().summary,
      cta: { href: '/dashboard/inventory', label: 'Open Items' },
    });
    // A member reaches no linked entry, so an old phone build shows the title
    // and the summary alone.
    expect(legacyAnnouncementsFor(RELEASES, member, {})[0]).toEqual({
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

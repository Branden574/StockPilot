import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  COUNT_START_MANAGER_ONLY_COPY,
  countStartAllowed,
  countStartManagerOnly,
  deletedDriverHandOverLine,
  type Permission,
  MODULE_REGISTRY,
  PERMISSION_META,
  PERMISSIONS,
  type ModuleId,
  type Release,
  type ReleaseViewer,
} from '@stockpilot/core';

import { buildReleaseList, registryFingerprint, visibleReleases } from './logic';
import { RELEASES } from './registry';

/**
 * Added by docs/whats-new-2026-11-02d (2026-11-02): four releases published
 * at the top, newest first, above the web fixes release:
 *
 * - export-items-permission-2026-11: B68, #446 (squash 22e52f1ea, live
 *   23:45:39Z), Export items and Export only for members who hold it, and no
 *   Export on Rentals.
 * - mobile-app-fixes-2026-11-02: the phone halves of B42 #423, B23 #406, B65
 *   #476, B75 #435 and S5a #450, in EAS update group 9cf9ecf7 (from
 *   a34543b81; iOS launches from 23:09Z).
 * - clearer-web-messages-2026-11: S31, #481 (squash a34543b81, live
 *   22:55:57Z), and S29, #470 (squash 5cc3e778e, live 21:37:13Z).
 * - invites-calendar-record-pages-2026-11: QW1, #483 (squash c7d6cc625, live
 *   22:28:58Z).
 *
 * Its own file, so the release tests other open branches edit stay as they
 * are. These tests pin each release's ids, status, revision, date and order,
 * who each entry reaches, and the code its words rest on.
 */
const EXPORT_ID = 'export-items-permission-2026-11';
const PHONE_ID = 'mobile-app-fixes-2026-11-02';
const MESSAGES_ID = 'clearer-web-messages-2026-11';
const QW1_ID = 'invites-calendar-record-pages-2026-11';
const NEW_IDS = [EXPORT_ID, PHONE_ID, MESSAGES_ID, QW1_ID];
const WEB_FIXES_ID = 'web-fixes-2026-11-02';
// Added by docs/whats-new-2026-11-05 (2026-11-05): the S2 release, published
// later, at the top, above these four. It reaches whoever approves orders or
// picks where Orders is on (an owner with every permission and module among
// them), not a member with no permission.
const S2_ID = 'approver-controls-own-warehouses-2026-11';
// Added by docs/whats-new-count-sheet-long-names (2026-11-10): the count sheet
// release (#492), published later still, at the top, above the S2 release. It
// reaches whoever can open a cycle count's PDF where Cycle Counts is on (an
// owner with every permission and module among them), not a member with no
// permission.
const COUNT_SHEET_ID = 'count-sheet-long-names-2026-11';
// Added by feat/order-add-all (2026-11-10): the Add all release, published at
// the top, above the count sheet release. It reaches whoever may place orders
// (orders:request) where Orders is on.
const ADD_ALL_ID = 'order-add-all-2026-11';
// Added by docs/whatsnew-returns-1112 (2026-11-12): the returns request and names release, published at the top, above the Add all release.
const RETURNS_REQUEST_ID = 'returns-request-email-names-2026-11';
// Added by docs/whatsnew-phone-1112 (2026-11-12): the phone appearance and returns release,
// published at the top, below the Liquid Glass draft and above the returns request and names
// release. It reaches every member: its Appearance entry has no audience.
const PHONE_APPEARANCE_ID = 'phone-appearance-returns-2026-11';
const byId = (id: string) => RELEASES.find((r) => r.id === id)!;
const entry = (releaseId: string, entryId: string) =>
  byId(releaseId).entries.find((e) => e.id === entryId)!;

const everyone: ReleaseViewer = {
  role: 'owner',
  permissions: [...PERMISSIONS],
  enabledModules: Object.keys(MODULE_REGISTRY) as ModuleId[],
};
/** A member who holds no permission and no module. */
const member: ReleaseViewer = { role: 'viewer', permissions: [], enabledModules: [] };
/** Staff who read items, with Rentals on, and no export. */
const staff: ReleaseViewer = {
  role: 'staff',
  permissions: ['items:read', 'items:update', 'stock:adjust', 'cycle_counts:read'],
  enabledModules: ['rentals', 'cycle_counts'],
};
/** A manager who exports where Rentals is on. */
const exporter: ReleaseViewer = {
  role: 'manager',
  permissions: ['items:export'],
  enabledModules: ['rentals'],
};
/** The same with Rentals off. */
const exporterNoRentals: ReleaseViewer = {
  role: 'manager',
  permissions: ['items:export'],
  enabledModules: [],
};
/** Staff who approve orders where Orders is on. */
const approver: ReleaseViewer = {
  role: 'staff',
  permissions: ['orders:approve'],
  enabledModules: ['orders'],
};
/** Staff who use the AI Assistant. */
const aiUser: ReleaseViewer = {
  role: 'staff',
  permissions: ['items:update'],
  enabledModules: ['ai'],
};
/** A manager who distributes bundles where Bundles is on. */
const distributor: ReleaseViewer = {
  role: 'manager',
  permissions: ['bundles:distribute'],
  enabledModules: ['bundles'],
};
/** Staff who hold bundles:distribute by default but are not offered Distribute. */
const staffDistributor: ReleaseViewer = {
  role: 'staff',
  permissions: ['bundles:distribute'],
  enabledModules: ['bundles'],
};

/** A file in the repository, as written. */
const REPO = resolve(__dirname, '../../../../..');
const repoFile = (rel: string) => readFileSync(resolve(REPO, rel), 'utf8');
/** A source file under apps/web/src, as written. */
const source = (rel: string) => repoFile(`apps/web/src/${rel}`);
/** A file in the mobile app, as written. */
const phone = (rel: string) => repoFile(`apps/mobile/${rel}`);

/** '/dashboard/orders?x=y' -> does app/(dashboard)/dashboard/orders/page.tsx exist? */
const DASHBOARD_APP_DIR = resolve(__dirname, '../../app/(dashboard)');
function pageExistsFor(href: string): boolean {
  const path = href.split('?')[0]!.replace(/\/+$/, '');
  return existsSync(resolve(DASHBOARD_APP_DIR, `.${path}`, 'page.tsx'));
}

/** Every string a reader can see in a release. */
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

/** Each entry answers all four questions, with its own id. */
function expectFourAnswers(r: Release): void {
  expect(new Set(r.entries.map((e) => e.id)).size).toBe(r.entries.length);
  for (const e of r.entries) {
    expect(e.whatChanged.length, e.id).toBeGreaterThan(0);
    expect(e.whyItMatters.length, e.id).toBeGreaterThan(0);
    expect(e.howItAffectsYou.length, e.id).toBeGreaterThan(0);
    expect(e.whatToDo.length, e.id).toBeGreaterThan(8);
  }
}

/** Every link opens a dashboard page that exists, and says who can reach it. */
function expectLinksReachable(r: Release): void {
  const known = new Set<string>(PERMISSIONS);
  for (const e of r.entries.filter((x) => x.link)) {
    expect(e.link!.href, e.id).toMatch(/^\/dashboard(\/|$)/);
    expect(pageExistsFor(e.link!.href), `${e.id} -> ${e.link!.href}`).toBe(true);
    const audience = e.audience ?? r.audience;
    expect(audience, e.id).toBeDefined();
    expect(audience?.anyPermission?.length ?? 0, e.id).toBeGreaterThan(0);
    for (const p of audience?.anyPermission ?? []) {
      expect(known.has(p), `${e.id}: ${p}`).toBe(true);
    }
  }
}

const entriesFor = (id: string, v: ReleaseViewer) =>
  visibleReleases(RELEASES, v)
    .find((r) => r.id === id)
    ?.entries.map((e) => e.id);

const read = (id: string) => ({
  release_id: id,
  revision: 1,
  dismissed_at: null,
  opened_at: '2026-11-03T00:00:00Z',
  read_at: '2026-11-03T00:00:00Z',
});

/** The phone's way to load the update, as each phone entry says it. */
const LOAD_UPDATE =
  'To load the latest update, tap Restart now when the app says Update ready, or close the app completely and open it again.';

describe('the four releases of 2026-11-02 night: order, status and dates', () => {
  it('are published once each, as revision 1, at the top in date order, above the web fixes release', () => {
    for (const id of NEW_IDS) {
      expect(
        RELEASES.filter((r) => r.id === id),
        id,
      ).toHaveLength(1);
      expect(byId(id).status, id).toBe('published');
      expect(byId(id).revision, id).toBe(1);
      expect(byId(id).withdrawnNote, id).toBeUndefined();
    }
    // Re-pinned by docs/whats-new-2026-11-05 (2026-11-05; was: every pinned position one place higher): the S2 release is published at the top, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-count-sheet-long-names (2026-11-10; was: every pinned position one place higher): the count sheet release is published at the top, so every position below it moves down by one.
    // Re-pinned by feat/order-add-all (2026-11-10; was: every pinned position one place higher): the Add all release is published at the top, so every position below it moves down by one.
    // Re-pinned by lg/s5-flag-home (2026-11-09; was: every pinned position one place higher, and no draft): the Liquid Glass release is held as a draft at the top until G5, so every position below it moves down by one and it is the one draft.
    // Re-pinned by docs/whatsnew-returns-1112 (2026-11-12; was: every pinned position one place higher): the returns request and names release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whatsnew-phone-1112 (2026-11-12; was: every pinned position one place higher): the phone appearance and returns release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-2026-11-13 (2026-11-13; was: every pinned position three places higher): the Release count, AI Assistant and not found releases are published at the top, below the Liquid Glass draft, so every position below it moves down by three.
    // Re-pinned by docs/whatsnew-emailed-links-1113 (2026-11-13; was: every pinned position one place higher): the emailed links release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    expect(RELEASES.slice(10, 15).map((r) => r.id)).toEqual([...NEW_IDS, WEB_FIXES_ID]);
    // Re-pinned by docs/whats-new-2026-11-05 (2026-11-05; was: EXPORT_ID): the S2 release is published after it, at the top, the newest published release.
    // Re-pinned by docs/whats-new-count-sheet-long-names (2026-11-10; was: S2_ID): the count sheet release is published after it, at the top, the newest published release.
    // Re-pinned by feat/order-add-all (2026-11-10; was: COUNT_SHEET_ID): the Add all release is published after it, at the top, the newest published release.
    // Re-pinned by docs/whatsnew-returns-1112 (2026-11-12; was: ADD_ALL_ID): the returns request and names release is published after it, at the top, the newest published release.
    // Re-pinned by docs/whatsnew-phone-1112 (2026-11-12; was: the returns request and names release, the newest published): the phone appearance and returns release is published later, at the top, directly below the Liquid Glass draft.
    expect(RELEASES.find((r) => r.status === 'published')?.id).toBe(
      // Re-pinned by docs/whats-new-2026-11-13 (2026-11-13; was: the phone appearance and returns release): the Release count release is published after it, at the top, the newest published release.
      // Re-pinned by docs/whatsnew-emailed-links-1113 (2026-11-13; was: the Release count release): the emailed links release is published after it, at the top, the newest published release.
      'emailed-links-name-their-account-2026-11',
    );
    expect(RELEASES.filter((r) => r.status === 'draft').map((r) => r.id)).toEqual([
      'liquid-glass-2026-11',
    ]);
  });

  it('are dated in the past on a whole minute, each after its change went live, and after every release below', () => {
    const at = (id: string) => Date.parse(byId(id).publishedAt);
    for (const id of NEW_IDS) {
      expect(byId(id).publishedAt, id).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/);
      expect(at(id), id).toBeLessThanOrEqual(Date.now());
    }
    // #446 went live at 23:45:39Z.
    expect(at(EXPORT_ID)).toBeGreaterThan(Date.parse('2026-11-02T23:45:39Z'));
    // The phone update was published about 23:05Z and launched on iOS at 23:09Z.
    expect(at(PHONE_ID)).toBeGreaterThanOrEqual(Date.parse('2026-11-02T23:10:00Z'));
    // #481 went live at 22:55:57Z, #470 at 21:37:13Z.
    expect(at(MESSAGES_ID)).toBeGreaterThan(Date.parse('2026-11-02T22:55:57Z'));
    expect(at(MESSAGES_ID)).toBeGreaterThan(Date.parse('2026-11-02T21:37:13Z'));
    // #483 went live at 22:28:58Z.
    expect(at(QW1_ID)).toBeGreaterThan(Date.parse('2026-11-02T22:28:58Z'));
    for (let i = 0; i < NEW_IDS.length; i += 1) {
      // Re-pinned by docs/whats-new-2026-11-05 (2026-11-05; was: every pinned position one place higher): the S2 release is published at the top, so every position below it moves down by one.
      // Re-pinned by docs/whats-new-count-sheet-long-names (2026-11-10; was: every pinned position one place higher): the count sheet release is published at the top, so every position below it moves down by one.
      // Re-pinned by feat/order-add-all (2026-11-10; was: i + 3): the Add all release is published at the top, so every position below it moves down by one.
      // Re-pinned by lg/s5-flag-home (2026-11-09; was: every pinned position one place higher): the Liquid Glass release is held as a draft at the top until G5, so every position below it moves down by one.
      // Re-pinned by docs/whatsnew-returns-1112 (2026-11-12; was: i + 5): the returns request and names release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
      // Re-pinned by docs/whatsnew-phone-1112 (2026-11-12; was: i + 6): the phone appearance and returns release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
      // Re-pinned by docs/whats-new-2026-11-13 (2026-11-13; was: i + 7): the Release count, AI Assistant and not found releases are published at the top, so every position below them moves down by three.
      // Re-pinned by docs/whatsnew-emailed-links-1113 (2026-11-13; was: i + 10): the emailed links release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
      for (const r of RELEASES.slice(i + 11)) {
        expect(at(NEW_IDS[i]!), `${NEW_IDS[i]} after ${r.id}`).toBeGreaterThan(
          Date.parse(r.publishedAt),
        );
      }
    }
  });

  it('are in the fingerprint, so publishing them changes what clients observe', () => {
    for (const id of NEW_IDS) {
      expect(registryFingerprint(RELEASES)).toContain(`${id}@1:published`);
    }
  });

  it('answer the four questions in each entry, with reachable links and no draft words', () => {
    for (const id of NEW_IDS) {
      expectFourAnswers(byId(id));
      expectLinksReachable(byId(id));
      expect(byId(id).audience, id).toBeUndefined();
      const text = readerText(byId(id)).join(' ');
      expect(text, id).not.toMatch(/\bbook(ed)? (qty|quantity|quantities|corrected)\b/i);
      expect(text, id).not.toMatch(/!|guarantee|verified|instantly/i);
    }
  });

  it('is the notice in date order for an owner, and the three that reach every member come first for a member', () => {
    // Re-pinned by docs/whatsnew-returns-1112 (2026-11-12; was: each read set without it): the returns request and names release is published later, at the top, and reaches an owner, so it is read first in each set, and the notice each set leads to is the one this test checked before. It does not reach a member with no permission, whose first notice is unchanged.
    // Re-pinned by docs/whats-new-2026-11-05 (2026-11-05; was: each read set without it): the S2 release is published later, at the top, and reaches an owner, so it is read first in each set, and the notice each set leads to is the one this test checked before.
    // Re-pinned by docs/whats-new-count-sheet-long-names (2026-11-10; was: each read set without it): the count sheet release is published later, at the top, and reaches an owner, so it is read first in each set, and the notice each set leads to is the one this test checked before.
    // Re-pinned by feat/order-add-all (2026-11-10; was: each read set without it): the Add all release is published later, at the top, and reaches an owner, so it is read first in each set, and the notice each set leads to is the one this test checked before. It does not reach a member with no permission, whose first notice is unchanged.
    expect(
      buildReleaseList(
        RELEASES,
        everyone,
        // Re-pinned by docs/whatsnew-phone-1112 (2026-11-12; was: without it): the phone appearance and returns release is published later, at the top, and reaches every member, so it is read first in each set.
        [
          // Re-pinned by docs/whats-new-2026-11-13 (2026-11-13; was: without them): the Release count, AI Assistant and not found releases are published later, at the top, and reach an owner with every permission and module, so they are read, seen or listed with the newer releases, and every notice this test checks is the one it checked before.
          // Re-pinned by docs/whatsnew-emailed-links-1113 (2026-11-13; was: without it): the emailed links release is published later, at the top, and reaches every member (it has no audience), so it is read, seen or listed with the newer releases, and every notice this test checks is the one it checked before.
          read('emailed-links-name-their-account-2026-11'),
          read('cycle-count-already-released-2026-11'),
          read('ai-assistant-plain-words-2026-11'),
          read('changes-that-did-not-happen-2026-11'),
          read(PHONE_APPEARANCE_ID),
          read(RETURNS_REQUEST_ID),
          read(ADD_ALL_ID),
          read(COUNT_SHEET_ID),
          read(S2_ID),
        ],
        null,
      ).latestUnread?.id,
    ).toBe(EXPORT_ID);
    expect(
      buildReleaseList(
        RELEASES,
        everyone,
        [
          // Re-pinned by docs/whatsnew-phone-1112 (2026-11-12; was: without it): the phone appearance and returns release is published later, at the top, and reaches every member (its Appearance entry has no audience), so it is read, seen or listed with the newer releases, and every older notice these lead to is the one each test checked before.
          // Re-pinned by docs/whats-new-2026-11-13 (2026-11-13; was: without them): the Release count, AI Assistant and not found releases are published later, at the top, and reach an owner with every permission and module, so they are read, seen or listed with the newer releases, and every notice this test checks is the one it checked before.
          // Re-pinned by docs/whatsnew-emailed-links-1113 (2026-11-13; was: without it): the emailed links release is published later, at the top, and reaches every member (it has no audience), so it is read, seen or listed with the newer releases, and every notice this test checks is the one it checked before.
          read('emailed-links-name-their-account-2026-11'),
          read('cycle-count-already-released-2026-11'),
          read('ai-assistant-plain-words-2026-11'),
          read('changes-that-did-not-happen-2026-11'),
          read(PHONE_APPEARANCE_ID),
          read(RETURNS_REQUEST_ID),
          read(ADD_ALL_ID),
          read(COUNT_SHEET_ID),
          read(S2_ID),
          read(EXPORT_ID),
        ],
        null,
      ).latestUnread?.id,
    ).toBe(PHONE_ID);
    expect(
      buildReleaseList(
        RELEASES,
        everyone,
        [
          // Re-pinned by docs/whatsnew-phone-1112 (2026-11-12; was: without it): the phone appearance and returns release is published later, at the top, and reaches every member (its Appearance entry has no audience), so it is read, seen or listed with the newer releases, and every older notice these lead to is the one each test checked before.
          // Re-pinned by docs/whats-new-2026-11-13 (2026-11-13; was: without them): the Release count, AI Assistant and not found releases are published later, at the top, and reach an owner with every permission and module, so they are read, seen or listed with the newer releases, and every notice this test checks is the one it checked before.
          // Re-pinned by docs/whatsnew-emailed-links-1113 (2026-11-13; was: without it): the emailed links release is published later, at the top, and reaches every member (it has no audience), so it is read, seen or listed with the newer releases, and every notice this test checks is the one it checked before.
          read('emailed-links-name-their-account-2026-11'),
          read('cycle-count-already-released-2026-11'),
          read('ai-assistant-plain-words-2026-11'),
          read('changes-that-did-not-happen-2026-11'),
          read(PHONE_APPEARANCE_ID),
          read(RETURNS_REQUEST_ID),
          read(ADD_ALL_ID),
          read(COUNT_SHEET_ID),
          read(S2_ID),
          read(EXPORT_ID),
          read(PHONE_ID),
        ],
        null,
      ).latestUnread?.id,
    ).toBe(MESSAGES_ID);
    expect(
      buildReleaseList(
        RELEASES,
        everyone,
        [
          // Re-pinned by docs/whatsnew-phone-1112 (2026-11-12; was: without it): the phone appearance and returns release is published later, at the top, and reaches every member (its Appearance entry has no audience), so it is read, seen or listed with the newer releases, and every older notice these lead to is the one each test checked before.
          // Re-pinned by docs/whats-new-2026-11-13 (2026-11-13; was: without them): the Release count, AI Assistant and not found releases are published later, at the top, and reach an owner with every permission and module, so they are read, seen or listed with the newer releases, and every notice this test checks is the one it checked before.
          // Re-pinned by docs/whatsnew-emailed-links-1113 (2026-11-13; was: without it): the emailed links release is published later, at the top, and reaches every member (it has no audience), so it is read, seen or listed with the newer releases, and every notice this test checks is the one it checked before.
          read('emailed-links-name-their-account-2026-11'),
          read('cycle-count-already-released-2026-11'),
          read('ai-assistant-plain-words-2026-11'),
          read('changes-that-did-not-happen-2026-11'),
          read(PHONE_APPEARANCE_ID),
          read(RETURNS_REQUEST_ID),
          read(ADD_ALL_ID),
          read(COUNT_SHEET_ID),
          read(S2_ID),
          read(EXPORT_ID),
          read(PHONE_ID),
          read(MESSAGES_ID),
        ],
        null,
      ).latestUnread?.id,
    ).toBe(QW1_ID);
    expect(
      buildReleaseList(
        RELEASES,
        everyone,
        // Re-pinned by docs/whatsnew-phone-1112 (2026-11-12; was: without it): the phone appearance and returns release is read first too.
        [
          // Re-pinned by docs/whats-new-2026-11-13 (2026-11-13; was: without them): the Release count, AI Assistant and not found releases are published later, at the top, and reach an owner with every permission and module, so they are read, seen or listed with the newer releases, and every notice this test checks is the one it checked before.
          // Re-pinned by docs/whatsnew-emailed-links-1113 (2026-11-13; was: without it): the emailed links release is published later, at the top, and reaches every member (it has no audience), so it is read, seen or listed with the newer releases, and every notice this test checks is the one it checked before.
          'emailed-links-name-their-account-2026-11',
          'cycle-count-already-released-2026-11',
          'ai-assistant-plain-words-2026-11',
          'changes-that-did-not-happen-2026-11',
          PHONE_APPEARANCE_ID,
          RETURNS_REQUEST_ID,
          ADD_ALL_ID,
          COUNT_SHEET_ID,
          S2_ID,
          ...NEW_IDS,
        ].map(read),
        null,
      ).latestUnread?.id,
    ).toBe(WEB_FIXES_ID);
    // Re-pinned by docs/whatsnew-phone-1112 (2026-11-12; was: nothing read): the phone appearance and returns release reaches every member, so a member is told it first and the Export items release once it is read.
    // Re-pinned by docs/whatsnew-emailed-links-1113 (2026-11-13; was: the phone appearance and returns release with nothing read, and the Export items release once it is read): the emailed links release reaches every member, so a member is told it first, the phone appearance and returns release once it is read, and the Export items release once both are read.
    expect(buildReleaseList(RELEASES, member, [], null).latestUnread?.id).toBe(
      'emailed-links-name-their-account-2026-11',
    );
    expect(
      buildReleaseList(RELEASES, member, [read('emailed-links-name-their-account-2026-11')], null)
        .latestUnread?.id,
    ).toBe(PHONE_APPEARANCE_ID);
    expect(
      buildReleaseList(
        RELEASES,
        member,
        [read('emailed-links-name-their-account-2026-11'), read(PHONE_APPEARANCE_ID)],
        null,
      ).latestUnread?.id,
    ).toBe(EXPORT_ID);
  });
});

describe('the Export items release (B68)', () => {
  const release = () => byId(EXPORT_ID);

  it('has its two entries, the permission name for every member and Rentals for who can export there', () => {
    expect(release().entries.map((e) => e.id)).toEqual([
      'export-items-permission-name',
      'rentals-export-removed',
    ]);
    expect(release().summary).toMatch(/^On the web, /);
    const name = entry(EXPORT_ID, 'export-items-permission-name');
    expect([name.category, name.area]).toEqual(['improved', 'Settings']);
    expect(name.audience).toBeUndefined();
    expect(name.link).toBeUndefined();
    const rentals = entry(EXPORT_ID, 'rentals-export-removed');
    expect([rentals.category, rentals.area]).toEqual(['fixed', 'Rentals']);
    expect(rentals.audience).toEqual({ anyPermission: ['items:export'], modules: ['rentals'] });
    expect(rentals.link).toBeUndefined();
    expect(entriesFor(EXPORT_ID, everyone)).toEqual([
      'export-items-permission-name',
      'rentals-export-removed',
    ]);
    expect(entriesFor(EXPORT_ID, exporter)).toEqual([
      'export-items-permission-name',
      'rentals-export-removed',
    ]);
    expect(entriesFor(EXPORT_ID, exporterNoRentals)).toEqual(['export-items-permission-name']);
    expect(entriesFor(EXPORT_ID, staff)).toEqual(['export-items-permission-name']);
    expect(entriesFor(EXPORT_ID, member)).toEqual(['export-items-permission-name']);
  });

  it('rests on the label, the pages that pass canExport and Rentals, which passes none', () => {
    expect(PERMISSION_META['items:export'].label).toBe('Export items');
    expect(PERMISSION_META['items:export'].description).toBe(
      'Download Items and Books as PDF, Excel or CSV files.',
    );
    const name = entry(EXPORT_ID, 'export-items-permission-name');
    expect(name.whatChanged).toContain('called Export items instead of Export CSV');
    expect(name.howItAffectsYou).toContain('ask an admin for the Export items permission');
    expect(source('app/(dashboard)/dashboard/inventory/page.tsx')).toContain(
      "const canExport = can(sessionCtx, 'items:export');",
    );
    expect(source('app/(dashboard)/dashboard/books/page.tsx')).toContain(
      "const canExport = can(sessionCtx, 'items:export');",
    );
    expect(source('app/(dashboard)/dashboard/rentals/items/page.tsx')).not.toMatch(/canExport=\{/);
    expect(source('components/inventory/inventory-table.tsx')).toContain('canExport = false,');
    expect(source('components/inventory/bulk-actions.tsx')).toContain('canExport = false,');
  });
});

describe('the phone update release (B42, B23, B65, B75 and S5a)', () => {
  const release = () => byId(PHONE_ID);

  it('has its six entries, says the mobile app in the summary and how to load the update', () => {
    expect(release().entries.map((e) => e.id)).toEqual([
      'app-sign-out-stops-notifications',
      'app-sign-ins-in-audit-log',
      'app-mistyped-record-link-not-found',
      'app-ai-new-chat-and-plain-errors',
      'app-count-start-managers-only',
      'app-deleted-driver-hand-over-line',
    ]);
    expect(release().summary).toMatch(/^In the mobile app, after the latest update, /);
    expect(release().summary).toContain(
      'Tap Restart now when the app says Update ready, or close the app completely and open it again.',
    );
    for (const e of release().entries) {
      expect(e.whatChanged, e.id).toMatch(/^In the mobile app, after the latest update, /);
      expect(e.whatToDo, e.id).toContain(LOAD_UPDATE);
      expect(e.link, e.id).toBeUndefined();
    }
  });

  it('quotes the update prompt as the phone words it', () => {
    const prompt = phone('src/lib/ota-update-prompt.ts');
    expect(prompt).toContain("export const UPDATE_PROMPT_TITLE = 'Update ready';");
    expect(prompt).toContain("export const UPDATE_PROMPT_RESTART = 'Restart now';");
  });

  it('reaches each reader with only the entries they can use', () => {
    const forEveryone = [
      'app-sign-out-stops-notifications',
      'app-sign-ins-in-audit-log',
      'app-mistyped-record-link-not-found',
    ];
    expect(entriesFor(PHONE_ID, everyone)).toEqual(release().entries.map((e) => e.id));
    expect(entriesFor(PHONE_ID, member)).toEqual(forEveryone);
    expect(entriesFor(PHONE_ID, staff)).toEqual([...forEveryone, 'app-count-start-managers-only']);
    expect(entriesFor(PHONE_ID, approver)).toEqual([
      ...forEveryone,
      'app-deleted-driver-hand-over-line',
    ]);
    expect(entriesFor(PHONE_ID, aiUser)).toEqual([
      ...forEveryone,
      'app-ai-new-chat-and-plain-errors',
    ]);
    expect(entry(PHONE_ID, 'app-sign-out-stops-notifications').audience).toBeUndefined();
    expect(entry(PHONE_ID, 'app-sign-ins-in-audit-log').audience).toBeUndefined();
    expect(entry(PHONE_ID, 'app-mistyped-record-link-not-found').audience).toBeUndefined();
    expect(entry(PHONE_ID, 'app-ai-new-chat-and-plain-errors').audience).toEqual({
      anyPermission: ['items:update'],
      modules: ['ai'],
    });
    expect(entry(PHONE_ID, 'app-count-start-managers-only').audience).toEqual({
      anyPermission: ['items:read', 'cycle_counts:read', 'stock:adjust'],
    });
    expect(entry(PHONE_ID, 'app-deleted-driver-hand-over-line').audience).toEqual({
      anyPermission: ['orders:approve'],
      modules: ['orders'],
    });
  });

  it('S5a: rests on the unbind before the global logout, the cleared notifications and the notes', () => {
    const unbind = phone('src/lib/push-unbind.ts');
    expect(unbind).toContain(
      'export async function unbindThisDevice(opts: { timeoutMs: number }): Promise<UnbindResult> {',
    );
    expect(unbind).toContain('await Notifications.dismissAllNotificationsAsync();');
    const flow = phone('src/lib/sign-out-flow.ts');
    expect(flow.indexOf("await deviceStep('before'")).toBeGreaterThan(-1);
    expect(flow.indexOf("await deviceStep('before'")).toBeLessThan(
      flow.indexOf("const ended = await endSession(deps, 'global');"),
    );
    const auth = phone('src/lib/auth-context.tsx');
    expect(auth).toContain("if (outcome === 'signed-out') await clearDeliveredNotifications();");
    expect(auth).toContain('const signOutToFallback');
    const notes = phone('src/lib/auth-notes.ts');
    expect(notes).toContain("'/api/v1/auth/signed-in'");
    expect(notes).toContain("'/api/v1/auth/signed-out'");
    expect(source('app/api/v1/auth/signed-out/route.ts')).toContain(
      "ctx.supabase.rpc('revoke_my_other_sessions'",
    );
    expect(source('app/api/v1/auth/signed-in/route.ts')).toContain("event: 'user.signed_in',");
    expect(source('lib/auth/login-device.ts')).toContain('if (hadKnownDevices && args.email) {');
    expect(entry(PHONE_ID, 'app-sign-ins-in-audit-log').whatChanged).toContain(
      'StockPilot app on iPhone 15 Pro (iOS 18.1)',
    );
    expect(source('app/api/v1/auth/signed-in/route.ts')).toContain(
      'return `StockPilot app on ${d.model}${system}`;',
    );
  });

  it('S5a: says what changes for people, and nothing on how a sign-out could be misused', () => {
    const text = [
      ...readerText(release()).filter((t) => /sign/i.test(t)),
      entry(PHONE_ID, 'app-sign-out-stops-notifications').whyItMatters,
    ].join(' ');
    expect(text).not.toMatch(/forged|forge|attacker|exploit|spoof|channel|token/i);
  });

  it('B65: rests on each screen checking the link id before it reads', () => {
    expect(phone('app/order/[id].tsx')).toContain('if (!isUuid(id)) {');
    expect(phone('app/item/[id].tsx')).toContain(
      "const ITEM_NOT_FOUND_COPY = 'This item is not available to you, or it no longer exists.';",
    );
    expect(phone('app/po/[id].tsx')).toContain(
      'This PO was not found, or you no longer have access to it.',
    );
    expect(phone('app/exceptions/[id].tsx')).toContain(
      "'This exception is not available to you, or it no longer exists.'",
    );
    expect(entry(PHONE_ID, 'app-mistyped-record-link-not-found').howItAffectsYou).toContain(
      '“This item is not available to you, or it no longer exists.”',
    );
  });

  it('B75: rests on New chat and the sentences Chat error shows', () => {
    const chat = phone('app/ai/chat.tsx');
    expect(chat).toContain('accessibilityLabel="New chat"');
    expect(chat).toContain('{turns.length > 0 && !busy && !uploading ? (');
    expect(phone('src/lib/connection-copy.ts')).toContain(
      "'Could not reach the server. Check your connection and try again.'",
    );
    expect(source('app/api/ai/chat/route.ts')).toContain(
      "'Your message is too long. Keep it under 2,000 characters.'",
    );
    const e = entry(PHONE_ID, 'app-ai-new-chat-and-plain-errors');
    expect(e.whatChanged).toContain('“Your message is too long. Keep it under 2,000 characters.”');
    expect(e.whatChanged).toContain(
      '“Could not reach the server. Check your connection and try again.”',
    );
    // The route part (long chats keep answering) is told in
    // phone-ai-long-chats-keep-answering, so it is not told again here.
    expect(e.whatChanged).not.toMatch(/22nd|keeps answering/);
  });

  it('B42: quotes the manager-only sentence and the empty list words the phone shows', () => {
    const e = entry(PHONE_ID, 'app-count-start-managers-only');
    expect(e.whatChanged).toContain(`“${COUNT_START_MANAGER_ONLY_COPY}”`);
    expect(e.howItAffectsYou).toContain('“Counts a manager starts appear here.”');
    expect(phone('app/(drawer)/(tabs)/cycle-counts.tsx')).toContain(
      "'Counts a manager starts appear here.'",
    );
    expect(phone('app/cycle-count/new.tsx')).toContain(
      'disabled={busy || picks.length === 0 || managerOnly}',
    );
    expect(phone('src/lib/count-select-offers.ts')).toContain(
      'return { review, group, unlinkFamilies, any: review || group };',
    );
  });

  // Added in the review round of docs/whats-new-2026-11-02d (2026-11-02): New count's sentence comes from countStartManagerOnly, which leaves the module out, so a manager who can assign counts and adjust stock where Cycle Counts is off cannot start a count and still reads no sentence. The entry names who reads it instead of "anyone else".
  it('B42: names who reads the New count sentence, which a manager able to start counts never reads, even with Cycle Counts off', () => {
    const managerCan = new Set<Permission>(['cycle_counts:assign', 'stock:adjust']);
    expect(
      countStartAllowed({ role: 'manager', permissions: managerCan, cycleCountsEnabled: false }),
    ).toBe(false);
    expect(countStartManagerOnly({ role: 'manager', permissions: managerCan })).toBe(false);
    expect(countStartManagerOnly({ role: 'staff', permissions: managerCan })).toBe(true);
    expect(
      countStartManagerOnly({
        role: 'manager',
        permissions: new Set<Permission>(['stock:adjust']),
      }),
    ).toBe(true);
    expect(phone('app/cycle-count/new.tsx')).toContain(
      'const managerOnly = countStartManagerOnly({ role, permissions });',
    );
    const e = entry(PHONE_ID, 'app-count-start-managers-only');
    expect(e.whatChanged).not.toMatch(/Anyone else/);
    expect(e.whatChanged).toContain(
      'Anyone who is not a manager able to assign counts and adjust stock and opens New count',
    );
  });

  it('B23: quotes the line core words for a manager', () => {
    const e = entry(PHONE_ID, 'app-deleted-driver-hand-over-line');
    expect(e.whatChanged).toContain(
      `“${deletedDriverHandOverLine({ offersPhysicalSignature: true })}”`,
    );
    expect(phone('src/lib/order-manager-actions.ts')).toContain(
      'deletedDriverHandOverLine({ offersPhysicalSignature: gates.physicalSignature })',
    );
  });
});

describe('the clearer web messages release (S31 and S29)', () => {
  const release = () => byId(MESSAGES_ID);

  it('has its two entries for every member, on the web', () => {
    expect(release().entries.map((e) => e.id)).toEqual([
      'web-unexpected-failure-sentence',
      'authenticator-code-plain-words',
    ]);
    expect(release().summary).toMatch(/^On the web, /);
    for (const e of release().entries) {
      expect(e.audience, e.id).toBeUndefined();
      expect(e.link, e.id).toBeUndefined();
    }
    expect(entriesFor(MESSAGES_ID, member)).toEqual([
      'web-unexpected-failure-sentence',
      'authenticator-code-plain-words',
    ]);
    // S31's draft entry about set-up is folded into S29's, so no second entry
    // tells it.
    expect(release().entries.map((e) => e.id)).not.toContain('authenticator-code-words');
  });

  it('quotes the sentences the code answers', () => {
    expect(source('server/lib/api-error-response.ts')).toContain(
      "export const UNEXPECTED_ERROR_MESSAGE = 'Something went wrong. Please try again.';",
    );
    expect(source('server/lib/action-error-result.ts')).toContain(
      "export const ROW_NOT_IMPORTED_MESSAGE = 'Could not import this row.';",
    );
    const attempts = source('lib/auth/mfa-code-attempts.ts');
    expect(attempts).toContain(
      "'That code is not valid. Check your authenticator app and try again.';",
    );
    expect(attempts).toContain(
      "export const MFA_CODE_BUDGET_SPENT = 'Too many code attempts. Wait a few minutes and try again.';",
    );
    expect(attempts).toContain('export const MFA_CODE_ATTEMPT_LIMIT = 10;');
    expect(attempts).toContain('export const MFA_CODE_ACCOUNT_WINDOW_MS = 60 * 60_000;');
    const failure = entry(MESSAGES_ID, 'web-unexpected-failure-sentence');
    expect(failure.whatChanged).toContain('“Something went wrong. Please try again.”');
    expect(failure.whatChanged).toContain('“Could not import this row.”');
    const codes = entry(MESSAGES_ID, 'authenticator-code-plain-words');
    expect(codes.whatChanged).toContain(
      'That code is not valid. Check your authenticator app and try again.',
    );
    expect(codes.whatChanged).toContain(
      'Too many code attempts. Wait a few minutes and try again.',
    );
  });
});

describe('the QW1 release (#483)', () => {
  const release = () => byId(QW1_ID);

  it('has its five entries, each for whoever uses that page', () => {
    expect(release().entries.map((e) => e.id)).toEqual([
      'invite-sign-in-link',
      'team-calendar-seven-days',
      'record-pages-could-not-load',
      'distribute-own-events',
      'billing-checkout-result',
    ]);
    expect(release().summary).toMatch(/^On the web, /);
    expect(entry(QW1_ID, 'invite-sign-in-link').audience).toBeUndefined();
    expect(entry(QW1_ID, 'team-calendar-seven-days').audience).toEqual({
      anyPermission: ['schedule:read', 'schedule:manage'],
      modules: ['schedule'],
    });
    expect(entry(QW1_ID, 'record-pages-could-not-load').audience).toEqual({
      modules: ['bundles', 'orders', 'purchase_orders', 'schedule'],
    });
    expect(entry(QW1_ID, 'distribute-own-events').audience).toEqual({
      roles: ['owner', 'admin', 'manager'],
      anyPermission: ['bundles:distribute'],
      modules: ['bundles'],
    });
    expect(entry(QW1_ID, 'billing-checkout-result').audience).toEqual({
      anyPermission: ['billing:manage'],
    });
    expect(entriesFor(QW1_ID, member)).toEqual(['invite-sign-in-link']);
    expect(entriesFor(QW1_ID, distributor)).toEqual([
      'invite-sign-in-link',
      'record-pages-could-not-load',
      'distribute-own-events',
    ]);
    expect(entriesFor(QW1_ID, staffDistributor)).toEqual([
      'invite-sign-in-link',
      'record-pages-could-not-load',
    ]);
  });

  // Added in the review round of docs/whats-new-2026-11-02d (2026-11-02): #483 changed the failed-read handling on the bundle page, its edit page and an order's pick and print views. The order page already sent only not_found to Page not found before #483 (c7d6cc625^, orders/[id]/page.tsx:253-262), so the entry and the summary do not name it for the failed read; its module check is the entry's third sentence.
  it('names for the failed read only the four pages #483 changed, and the order page for its module check', () => {
    const dashboard = 'app/(dashboard)/dashboard/';
    for (const page of [
      'bundles/[id]/page.tsx',
      'bundles/[id]/edit/page.tsx',
      'orders/[id]/pick/page.tsx',
      'orders/[id]/print/page.tsx',
    ]) {
      expect(source(dashboard + page), page).toContain(
        "if (e instanceof ServiceError && e.code === 'not_found') notFound();",
      );
    }
    expect(source(dashboard + 'orders/[id]/page.tsx')).toContain(
      '<ModuleUnavailable moduleId="orders" access={moduleAccess} />',
    );
    const e = entry(QW1_ID, 'record-pages-could-not-load');
    expect(e.whatChanged).toMatch(
      /^On the web, when a bundle, or an order’s pick or print view, cannot be loaded, /,
    );
    expect(e.whatChanged).toContain(
      'A link to a bundle, order, purchase order or Schedule event whose module is turned off now says the module is off.',
    );
    expect(e.title).not.toMatch(/order pages/);
    expect(release().summary).toContain(
      'Bundle pages and an order’s pick and print views that cannot be loaded say so with Try again',
    );
    expect(release().summary).not.toMatch(/Bundle and order pages/);
  });

  it('quotes the invite, the error page and the Billing lines the code shows', () => {
    const copy = source('app/invite/[token]/invite-copy.ts');
    expect(copy).toContain("export const INVITE_SIGN_IN_PROMPT = 'Already have an account?';");
    expect(copy).toContain("export const INVITE_SIGN_IN_LINK = 'Sign in';");
    expect(entry(QW1_ID, 'invite-sign-in-link').whatChanged).toContain(
      '“Already have an account? Sign in”',
    );
    expect(source('app/(dashboard)/error.tsx')).toContain('Something broke loading this page');
    const billing = source('app/(dashboard)/dashboard/settings/billing/page.tsx');
    const billingEntry = entry(QW1_ID, 'billing-checkout-result');
    for (const line of [
      'Checkout complete. Your plan shows here once Stripe confirms the payment; reload the page if it has not changed yet.',
      'Checkout cancelled. Nothing was charged, and your plan has not changed.',
    ]) {
      expect(billing).toContain(line);
      expect(billingEntry.whatChanged).toContain(`“${line}”`);
    }
    expect(source('app/(dashboard)/dashboard/bundles/[id]/page.tsx')).toContain(
      ".eq('organization_id', organizationId)",
    );
    expect(source('components/schedule/schedule-calendar.tsx')).toContain(
      '<span className="tabular-nums">{`${time} `}</span>',
    );
  });
});

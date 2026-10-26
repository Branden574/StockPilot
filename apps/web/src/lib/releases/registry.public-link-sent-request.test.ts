import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  MODULE_REGISTRY,
  PERMISSIONS,
  type ModuleId,
  type Release,
  type ReleaseViewer,
} from '@stockpilot/core';

import { buildReleaseList, legacyAnnouncementsFor, registryFingerprint, visibleReleases } from './logic';
import { RELEASES } from './registry';

/**
 * fix/placed-cart-draft (#336): a request sent from a public order link no
 * longer leaves its notes, Delivery choice and delivery site in that browser
 * for the next person (public-orders-v2.sent-request-draft.test.tsx). Its own
 * file so the release tests that other open branches edit stay as they are;
 * only the position pins that list the releases above them moved, each with a
 * note (five in registry.test.ts, one in registry.dates-fixes.test.ts).
 *
 * The people who use a public order link never sign in, so the release is
 * told to whoever can open the Public requests settings page, as the page
 * checks: the module, and Manage public links or organization:update.
 *
 * Held as a DRAFT until the web deploy was live (web build 78fd7fb5eea3,
 * built 2026-10-06 06:24:42Z, live 06:25:18Z).
 * docs/whats-new-dates-link-submit publishes it, the newest release, a
 * minute after the dates fixes release. It was not exercised in production
 * (Demo Co has no public order link); the evidence is #336's own test.
 */
const ID = 'public-link-sent-request-2026-10';
const release = () => RELEASES.find((r) => r.id === ID)!;

const everyone: ReleaseViewer = {
  role: 'owner',
  permissions: [...PERMISSIONS],
  enabledModules: Object.keys(MODULE_REGISTRY) as ModuleId[],
};

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

describe('the public order link release (a sent request leaves nothing behind)', () => {
  // Re-pinned by docs/whats-new-dates-link-submit (2026-10-06; was: "is a
  // draft, so no feed carries it, and preparing it changes nothing a client
  // can observe": a draft, in no feed, no legacy list and no fingerprint).
  it('is published after the web deploy, so every feed it reaches carries it, and it is the notice for whoever manages public links', () => {
    expect(release()).toBeDefined();
    expect(release().status).toBe('published');
    expect(release().revision).toBe(1);
    expect(visibleReleases(RELEASES, everyone).map((r) => r.id)).toContain(ID);
    const list = buildReleaseList(RELEASES, everyone, [], null);
    expect(list.releases.map((r) => r.id)).toContain(ID);
    // The newest release, so it is the notice for whoever it reaches.
    // Re-pinned by docs/whats-new-returns-exchange (2026-10-11; was: ID for
    // an owner with every module): returns RX-2's release is published later
    // and reaches that owner first. Claim kept: it is the notice for whoever
    // manages public links (below), whom RX-2's release does not reach.
    // Re-pinned by docs/whats-new-returns-requester (2026-10-12; was:
    // returns-exchange-2026-10, and ID once RX-2's release was read): returns
    // RX-3's release is published later still and reaches that owner first,
    // so ID is the notice once both returns releases are read. Claim kept: it
    // is the notice for whoever manages public links (below), whom neither
    // returns release reaches.
    // Re-pinned by docs/whats-new-returns-close-rest (2026-10-12; was:
    // returns-requester-exchange-2026-10, and ID once RX-2's and RX-3's
    // releases were read): returns RX-4's release is published later still
    // and reaches that owner first, so ID is the notice once the three
    // returns releases are read. Claim kept: it is the notice for whoever
    // manages public links (below), whom no returns release reaches.
    // Re-pinned by docs/whats-new-return-history-hand-over (2026-10-12; was:
    // returns-close-rest-2026-10, and ID once the three returns releases were
    // read): the return history hand-over release is published later still
    // and reaches that owner first, so ID is the notice once the four returns
    // releases are read. Claim kept: it is the notice for whoever manages
    // public links (below), whom no returns release reaches.
    // Re-pinned by the What's New publish of ungroup-2026-10 and
    // group-selected-2026-10 (2026-10-12): was returns-history-hand-over-2026-10,
    // and ID once the four returns releases were read. Ungroup's release and
    // then Group selected's, a minute later, are published later still and
    // reach that owner first, so ID is the notice once those two and the four
    // returns releases are read. Group selected's reaches every member (its
    // list entries have no audience), so whoever manages public links is told
    // it first, and this one once it is read. Claim kept: it is the notice
    // for whoever manages public links, whom no returns release reaches.
    // Re-pinned by docs/whats-new-ungroup-follow-ups (2026-10-12; was: group-selected-2026-10): the Ungroup follow-ups release is published after it, at the top and reaches this reader.
    // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: ungroup-follow-ups-2026-10): the pages-keep-groups-whole release is published after it, at the top, and reaches this reader.
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: pages-keep-groups-whole-2026-10): the parked ai-search-finds-every-item release (#367) and the three redesign releases are published after it, at the top, and redesign-2026-10, the newest, reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: redesign-2026-10): the unsubscribe-rack-question-fixes release is published after it, at the top, and reaches every member, this reader included.
    expect(list.latestUnread?.id).toBe('unsubscribe-rack-question-fixes-2026-10');
    const rx2Read = {
      release_id: 'returns-exchange-2026-10',
      revision: 1,
      dismissed_at: null,
      opened_at: '2026-10-11T23:00:00Z',
      read_at: '2026-10-11T23:00:00Z',
    };
    const rx3Read = { ...rx2Read, release_id: 'returns-requester-exchange-2026-10' };
    const rx4Read = { ...rx2Read, release_id: 'returns-close-rest-2026-10' };
    const handOverRead = { ...rx2Read, release_id: 'returns-history-hand-over-2026-10' };
    const ungroupRead = { ...rx2Read, release_id: 'ungroup-2026-10' };
    const groupSelectedRead = { ...rx2Read, release_id: 'group-selected-2026-10' };
    // Re-pinned by docs/whats-new-ungroup-follow-ups (2026-10-12): the Ungroup follow-ups release is published at the top and reaches this reader, so it is read or seen here too and the order this test checks holds.
    const followUpsRead = { ...rx2Read, release_id: 'ungroup-follow-ups-2026-10' };
    // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: the newer reads without it): the pages-keep-groups-whole release is published at the top and reaches this reader, so it is read here too and the order this test checks holds.
    const pagesRead = { ...rx2Read, release_id: 'pages-keep-groups-whole-2026-10' };
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: the newer reads without them, and pages-keep-groups-whole-2026-10 first with only RX-2's read): the three redesign releases and the parked ai-search-finds-every-item release (#367) are published at the top and reach this reader, so they are the notices first, then are read here too and the order this test checks holds.
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: redesign-2026-10 first with only RX-2's read, the same for whoever manages public links with nothing read or seen, and the redesign reads and seen set without the newest release): the unsubscribe-rack-question-fixes release is published at the top and reaches every member, so it is the notice first for both readers, then is read or seen with the redesign releases and the order this test checks holds.
    const newestRead = { ...rx2Read, release_id: 'unsubscribe-rack-question-fixes-2026-10' };
    const redesignRead = [
      'unsubscribe-rack-question-fixes-2026-10',
      'redesign-2026-10',
      'redesign-mobile-app-2026-10',
      'redesign-web-fixes-2026-10',
    ].map((id) => ({ ...rx2Read, release_id: id }));
    const aiSearchRead = { ...rx2Read, release_id: 'ai-search-finds-every-item-2026-10' };
    const newerRead = [
      ...redesignRead,
      aiSearchRead,
      pagesRead,
      followUpsRead,
      groupSelectedRead,
      ungroupRead,
    ];
    expect(buildReleaseList(RELEASES, everyone, [rx2Read], null).latestUnread?.id).toBe(
      'unsubscribe-rack-question-fixes-2026-10',
    );
    expect(buildReleaseList(RELEASES, everyone, [rx2Read, newestRead], null).latestUnread?.id).toBe(
      'redesign-2026-10',
    );
    expect(
      buildReleaseList(RELEASES, everyone, [rx2Read, ...redesignRead], null).latestUnread?.id,
    ).toBe('ai-search-finds-every-item-2026-10');
    expect(
      buildReleaseList(RELEASES, everyone, [rx2Read, ...redesignRead, aiSearchRead], null)
        .latestUnread?.id,
    ).toBe('pages-keep-groups-whole-2026-10');
    expect(
      buildReleaseList(
        RELEASES,
        everyone,
        [rx2Read, ...redesignRead, aiSearchRead, pagesRead],
        null,
      ).latestUnread?.id,
    ).toBe('ungroup-follow-ups-2026-10');
    expect(
      buildReleaseList(
        RELEASES,
        everyone,
        [rx2Read, ...redesignRead, aiSearchRead, pagesRead, followUpsRead],
        null,
      ).latestUnread?.id,
    ).toBe('group-selected-2026-10');
    expect(
      buildReleaseList(
        RELEASES,
        everyone,
        [rx2Read, ...redesignRead, aiSearchRead, pagesRead, followUpsRead, groupSelectedRead],
        null,
      ).latestUnread?.id,
    ).toBe('ungroup-2026-10');
    expect(buildReleaseList(RELEASES, everyone, [rx2Read, ...newerRead], null).latestUnread?.id).toBe(
      'returns-history-hand-over-2026-10',
    );
    expect(buildReleaseList(RELEASES, everyone, [rx2Read, handOverRead, ...newerRead], null).latestUnread?.id).toBe(
      'returns-close-rest-2026-10',
    );
    expect(
      buildReleaseList(RELEASES, everyone, [rx2Read, rx4Read, handOverRead, ...newerRead], null).latestUnread?.id,
    ).toBe('returns-requester-exchange-2026-10');
    expect(
      buildReleaseList(RELEASES, everyone, [rx2Read, rx3Read, rx4Read, handOverRead, ...newerRead], null)
        .latestUnread?.id,
    ).toBe(ID);
    const linkManager: ReleaseViewer = {
      role: 'staff',
      permissions: ['public_links:manage'],
      enabledModules: ['public_requests'],
    };
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: group-selected-2026-10 first, and ID once it was
    // read): the three redesign releases reach every member, so whoever manages public links is told
    // redesign-2026-10 first, Group selected's once the three are read, and this one once that is read too.
    // The ai-search-finds-every-item release does not reach them. Claim kept: it is the notice for whoever manages
    // public links once the newer releases that reach them are read.
    expect(buildReleaseList(RELEASES, linkManager, [], null).latestUnread?.id).toBe(
      'unsubscribe-rack-question-fixes-2026-10',
    );
    expect(buildReleaseList(RELEASES, linkManager, [newestRead], null).latestUnread?.id).toBe(
      'redesign-2026-10',
    );
    expect(buildReleaseList(RELEASES, linkManager, redesignRead, null).latestUnread?.id).toBe(
      'group-selected-2026-10',
    );
    expect(
      buildReleaseList(RELEASES, linkManager, [...redesignRead, groupSelectedRead], null)
        .latestUnread?.id,
    ).toBe(ID);
    // An old phone build lists it first, with its link.
    // Re-pinned by docs/whats-new-returns-exchange (2026-10-11; was: the
    // owner with every module, who is now told RX-2's release first): the
    // reader who manages public links.
    // Re-pinned by the What's New publish of ungroup-2026-10 and
    // group-selected-2026-10 (2026-10-12; was: first with nothing seen):
    // Group selected's release is first for that reader until it is seen.
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: Group selected's release first with nothing seen,
    // and this one once it is seen): the three redesign releases come first until they are seen too.
    const redesignSeen = Object.fromEntries(redesignRead.map((r) => [r.release_id, true]));
    expect(legacyAnnouncementsFor(RELEASES, linkManager, {})[0]?.id).toBe(
      'unsubscribe-rack-question-fixes-2026-10',
    );
    expect(
      legacyAnnouncementsFor(RELEASES, linkManager, {
        'unsubscribe-rack-question-fixes-2026-10': true,
      })[0]?.id,
    ).toBe('redesign-2026-10');
    expect(legacyAnnouncementsFor(RELEASES, linkManager, redesignSeen)[0]?.id).toBe(
      'group-selected-2026-10',
    );
    expect(
      legacyAnnouncementsFor(RELEASES, linkManager, {
        ...redesignSeen,
        'group-selected-2026-10': true,
      })[0],
    ).toEqual({
      id: ID,
      date: '2026-10-06',
      title: release().title,
      body: release().summary,
      cta: { href: '/dashboard/settings/public-requests', label: 'Open public requests' },
    });
    // Publishing it changes what clients observe.
    expect(registryFingerprint(RELEASES)).toContain(`${ID}@1:published`);
    expect(registryFingerprint(RELEASES)).not.toBe(
      registryFingerprint(RELEASES.filter((r) => r.id !== ID)),
    );
    // A real time on a whole minute, after the web deploy went live and a
    // minute after the dates fixes release published with it: never the
    // draft's placeholder date (2026-10-15T17:00Z).
    // Re-pinned by the claims review of #339 (2026-10-06; was: after
    // 06:24:42Z, the build's builtAt): the build went live at 06:25:18Z,
    // when Vercel marked it READY and assigned the alias.
    expect(release().publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/);
    expect(Date.parse(release().publishedAt)).toBeGreaterThan(Date.parse('2026-10-06T06:25:18Z'));
    expect(Date.parse(release().publishedAt)).toBeLessThanOrEqual(Date.parse('2026-10-07T00:00:00Z'));
  });

  // Re-pinned by returns RX-2 (2026-10-11; was: "is the newest entry, at the
  // top, dated after every other release"): RX-2's draft, dated later, sits
  // above it. Claim kept: it is the newest published release, dated after
  // every release below it.
  // Re-pinned by docs/whats-new-returns-exchange (2026-10-11; was: "is the
  // newest published release, directly below returns RX-2's draft"): RX-2's
  // release is published, in the same place, so it is the newest published
  // release. Claim kept: directly below it, dated after every release below.
  // Re-pinned by returns RX-3 (2026-10-11; was: "sits directly below returns
  // RX-2's release", at 1, with no draft): RX-3's draft, dated later still,
  // sits at the top above RX-2's published release. Claim kept: directly
  // below RX-2's release, the newest published one, dated after every
  // release below it.
  // Re-pinned by docs/whats-new-returns-requester (2026-10-12; was: "sits
  // directly below returns RX-2's release (published later) and RX-3's draft
  // above it", RX-3's a draft and RX-2's the newest published): RX-3's
  // release is published, in the same place, so it is the newest published
  // release and no draft is left. Claim kept: directly below RX-2's release,
  // with RX-3's above that, dated after every release below it.
  // Re-pinned by returns RX-4 (2026-10-12; was: at 2, RX-3's release at 0,
  // "no draft is left"): RX-4's draft, dated later still, sits at the top
  // above RX-3's published release, and it is the only draft. Claim kept:
  // directly below RX-2's release, with RX-3's above that, dated after every
  // release below it.
  // Re-pinned by docs/whats-new-returns-close-rest (2026-10-12; was: "...
  // and the returns RX-4 draft at the top", RX-4's a draft and RX-3's the
  // newest published): RX-4's release is published, in the same place, so it
  // is the newest published release and no draft is left. Claim kept:
  // directly below RX-2's release, with RX-3's and RX-4's above that, dated
  // after every release below it.
  // Re-pinned by the return history hand-over fix (D-H1, 2026-10-12; was: at
  // 3, RX-4's release at 0, "and no draft is left"): its draft, dated later
  // still, sits at the top above RX-4's published release, and it is the
  // only draft. Claim kept: directly below RX-2's release, with RX-3's and
  // RX-4's above that, dated after every release below it.
  // Re-pinned by docs/whats-new-return-history-hand-over (2026-10-12; was:
  // "... and the return history hand-over draft at the top", its draft the
  // only one and RX-4's the newest published): its release is published, in
  // the same place, so it is the newest published release and no draft is
  // left. Claim kept: directly below RX-2's release, with RX-3's, RX-4's and
  // the hand-over release above that, dated after every release below it.
  // Re-pinned by Ungroup G1 (2026-10-12, rebased onto #354; was: at 4, the
  // return history hand-over release at 0, "and no draft is left"):
  // Ungroup's draft, dated later still, sits at the top above the hand-over
  // release, and it is the only draft. Claim kept: directly below RX-2's
  // release, with RX-3's, RX-4's and the hand-over release above that, dated
  // after every release below it.
  // Re-pinned by Group selected G2 (2026-10-12, rebased onto #351; was: at
  // 5, Ungroup's draft at 0 and the only draft): Group selected's draft,
  // dated later still, sits at the top above Ungroup's draft, so there are
  // two drafts. Claim kept: directly below RX-2's release, with RX-3's,
  // RX-4's and the hand-over release above that, dated after every release
  // below it.
  // Re-pinned by the What's New publish of ungroup-2026-10 and
  // group-selected-2026-10 (2026-10-12; was: "... and the Group selected and
  // Ungroup drafts at the top, the only drafts", the hand-over release the
  // newest published): both are published in the same places, so Group
  // selected's is the newest published release and no draft is left. Claim
  // kept: directly below RX-2's release, with RX-3's, RX-4's and the
  // hand-over release above that, dated after every release below it.
  // Renamed by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: "... and the Ungroup and Group selected releases at the top ..."): the Ungroup follow-ups release (#362) and the pages-keep-groups-whole release are published above them, at the top. Claim kept: directly below RX-2's release, with RX-3's, RX-4's and the hand-over release above that, dated after every release below it.
  // Renamed by docs/whats-new-redesign-2026-10 (2026-10-20; was: "... Ungroup follow-ups and pages-keep-groups-whole releases at the top ..."): the parked ai-search-finds-every-item release (#367) and the three redesign releases are published above them, at the top. Claim kept: directly below RX-2's release, with RX-3's, RX-4's and the hand-over release above that, dated after every release below it.
  // Renamed by docs/whats-new-2026-10-25 (2026-10-25; was: "... ai-search-finds-every-item and three redesign releases at the top ..."): the unsubscribe-rack-question-fixes release is published above them, at the top. Claim kept: directly below RX-2's release, with RX-3's, RX-4's and the hand-over release above that, dated after every release below it.
  it("sits directly below returns RX-2's release, with returns RX-3's, RX-4's and the return history hand-over release above that, and the Ungroup, Group selected, Ungroup follow-ups, pages-keep-groups-whole, ai-search-finds-every-item, three redesign and unsubscribe-rack-question-fixes releases at the top (all published later), dated after every release below it, and no draft is left", () => {
    // Re-pinned by docs/whats-new-ungroup-follow-ups (2026-10-12): the Ungroup follow-ups release is published at the top, above Group selected's, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: the Ungroup follow-ups release at 0 and this one at 7): the pages-keep-groups-whole release is published at the top, above the Ungroup follow-ups release, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: the pages-keep-groups-whole release at 0, this one at 8, slice(9), the dates of RELEASES[1] to [7] and pages-keep-groups-whole-2026-10 the newest published): the three redesign releases and the parked ai-search-finds-every-item release (#367) are published at the top, above the pages-keep-groups-whole release, so every position below them moves down by four, redesign-2026-10 is the newest published release, and the releases from the top down to the pages-keep-groups-whole release are dated later too.
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: the redesign and ai-search-finds-every-item releases at 0 to 3, this one at 12, slice(13), the dates of RELEASES[5] to [11], slice(0, 5) and redesign-2026-10 the newest published): the unsubscribe-rack-question-fixes release is published at the top, above the redesign releases, so every position below it moves down by one, it is the newest published release, and it is dated later too.
    expect(RELEASES[0]?.id).toBe('unsubscribe-rack-question-fixes-2026-10');
    expect(RELEASES[0]?.status).toBe('published');
    expect(RELEASES.slice(1, 5).map((r) => [r.id, r.status])).toEqual([
      ['redesign-2026-10', 'published'],
      ['redesign-mobile-app-2026-10', 'published'],
      ['redesign-web-fixes-2026-10', 'published'],
      ['ai-search-finds-every-item-2026-10', 'published'],
    ]);
    expect(RELEASES[5]?.id).toBe('pages-keep-groups-whole-2026-10');
    expect(RELEASES[5]?.status).toBe('published');
    expect(RELEASES[6]?.id).toBe('ungroup-follow-ups-2026-10');
    expect(RELEASES[6]?.status).toBe('published');
    expect(RELEASES[7]?.id).toBe('group-selected-2026-10');
    expect(RELEASES[7]?.status).toBe('published');
    expect(RELEASES[8]?.id).toBe('ungroup-2026-10');
    expect(RELEASES[8]?.status).toBe('published');
    expect(RELEASES[9]?.id).toBe('returns-history-hand-over-2026-10');
    expect(RELEASES[9]?.status).toBe('published');
    expect(RELEASES[10]?.id).toBe('returns-close-rest-2026-10');
    expect(RELEASES[10]?.status).toBe('published');
    expect(RELEASES[11]?.id).toBe('returns-requester-exchange-2026-10');
    expect(RELEASES[11]?.status).toBe('published');
    expect(RELEASES[12]?.id).toBe('returns-exchange-2026-10');
    expect(RELEASES[12]?.status).toBe('published');
    expect(RELEASES[13]?.id).toBe(ID);
    expect(RELEASES.find((r) => r.status === 'published')?.id).toBe(
      'unsubscribe-rack-question-fixes-2026-10',
    );
    expect(RELEASES.filter((r) => r.status === 'draft').map((r) => r.id)).toEqual([]);
    for (const r of RELEASES.slice(14)) {
      expect(Date.parse(release().publishedAt), r.id).toBeGreaterThan(Date.parse(r.publishedAt));
    }
    expect(Date.parse(RELEASES[6]!.publishedAt)).toBeGreaterThan(Date.parse(release().publishedAt));
    expect(Date.parse(RELEASES[7]!.publishedAt)).toBeGreaterThan(Date.parse(release().publishedAt));
    expect(Date.parse(RELEASES[8]!.publishedAt)).toBeGreaterThan(Date.parse(release().publishedAt));
    expect(Date.parse(RELEASES[9]!.publishedAt)).toBeGreaterThan(Date.parse(release().publishedAt));
    expect(Date.parse(RELEASES[10]!.publishedAt)).toBeGreaterThan(
      Date.parse(release().publishedAt),
    );
    expect(Date.parse(RELEASES[11]!.publishedAt)).toBeGreaterThan(
      Date.parse(release().publishedAt),
    );
    expect(Date.parse(RELEASES[12]!.publishedAt)).toBeGreaterThan(
      Date.parse(release().publishedAt),
    );
    for (const r of RELEASES.slice(0, 6)) {
      expect(Date.parse(r.publishedAt), r.id).toBeGreaterThan(Date.parse(release().publishedAt));
    }
  });

  it('is told to whoever can open the Public requests settings page, and links there', () => {
    const gate = {
      anyPermission: ['public_links:manage', 'organization:update'],
      modules: ['public_requests'],
    };
    const r = release();
    expect(r.audience).toEqual(gate);
    expect(r.entries.map((e) => e.id)).toEqual(['public-link-sent-request-blank']);
    expect(r.entries[0]!.link).toEqual({
      href: '/dashboard/settings/public-requests',
      label: 'Open public requests',
    });
    expect(r.entries[0]!.audience).toEqual(gate);

    // Re-pinned by docs/whats-new-dates-link-submit (2026-10-06; was: a copy
    // forced to published): the release itself is published now.
    expect(r.status).toBe('published');
    const told = (permissions: ReleaseViewer['permissions'], modules: ModuleId[]) =>
      visibleReleases([r], { role: 'staff', permissions, enabledModules: modules }).length > 0;
    expect(told(['public_links:manage'], ['public_requests'])).toBe(true);
    expect(told(['organization:update'], ['public_requests'])).toBe(true);
    expect(told(['public_links:manage'], [])).toBe(false);
    expect(told(['orders:request', 'orders:approve'], ['public_requests', 'orders'])).toBe(false);
  });

  it("uses the page's words, says what a request that is not sent keeps, and says nothing of how the browser stores it", () => {
    const r = release();
    const text = readerText(r).join(' ');
    for (const words of ['Pickup', 'Delivery', 'delivery site', 'notes', 'Open public requests']) {
      expect(text).toContain(words);
    }
    const entry = r.entries[0]!;
    expect(entry.whatChanged).toContain('starts with Pickup, no delivery site and no notes');
    expect(entry.howItAffectsYou).toContain('a request that is refused or cannot reach StockPilot keeps them');
    expect(entry.category).toBe('fixed');
    expect(entry.area).toBe('Public requests');
    expect(text).not.toMatch(/localStorage|local storage|\bkey\b|\bdraft\b|debounce|\bcache|cookie|\d+ ?ms\b/i);
    expect(r.summary).toContain('for the same warehouse');
  });

  // Claims review of #339 (2026-10-06): the page has two notes fields. Only
  // the cart's Notes is kept with the request (the whole cart is saved once
  // it holds anything, its Delivery choice too); the Your info card's Name,
  // Email, Phone and Pickup notes are the page's own state, never kept.
  it("names the notes that are kept, Notes, and says nothing under Your info is, Pickup notes included", () => {
    const howItAffectsYou = release().entries[0]!.howItAffectsYou;
    expect(howItAffectsYou).toContain(
      'its items, its Notes, its Delivery choice and its delivery site are kept on that browser until it is sent (what is typed under Your info, including Pickup notes, never is)',
    );
    const dir = resolve(__dirname, '../../components/orders/public-v2');
    const page = readFileSync(resolve(dir, 'public-orders-v2.tsx'), 'utf8');
    expect(page).toContain("const [pickupNotes, setPickupNotes] = React.useState('');");
    const card = readFileSync(resolve(dir, 'public-your-info-card.tsx'), 'utf8');
    expect(card).toContain('<UserRound size={15} /> Your info');
    expect(card).toContain('Pickup notes <span className="opt">Optional</span>');
    const rail = readFileSync(resolve(dir, 'public-cart-rail.tsx'), 'utf8');
    expect(rail).toContain("onChange={(e) => dispatch({ type: 'set-notes', value: e.target.value })}");
  });
});

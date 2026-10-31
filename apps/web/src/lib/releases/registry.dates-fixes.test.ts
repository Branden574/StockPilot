import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { MODULE_REGISTRY, PERMISSIONS, type ModuleId, type ReleaseViewer } from '@stockpilot/core';

import {
  buildReleaseList,
  legacyAnnouncementsFor,
  registryFingerprint,
  visibleReleases,
} from './logic';
import { RELEASES } from './registry';

/**
 * fix/dates-in-org-and-utc (no migration, web and phone), told in the dates
 * fixes draft. Its own file so the release tests that other open branches edit
 * (registry.test.ts) change only where this draft moves the others.
 *
 * fix/overdue-by-org-day (no migration, web and phone) adds its lines to the
 * same draft: a purchase order is overdue, and a delivery late, only after
 * its expected date has passed in the organization's zone.
 *
 * Held as a DRAFT until the web deploy was live (#335 from 06:05Z, in
 * 7cbf73b4's build 7851fcefca49 and in 78fd7fb5eea3; #338 in f6e8be37b217)
 * and the over-the-air update with the phone part (OTA group e3111729, iOS
 * update 01a1111c) had launched on phones (1 launch, 0 failed, read
 * 2026-10-06 12:34Z).
 * docs/whats-new-dates-link-submit publishes it, between the public link and
 * PO-2 releases published with it. Each entry is told to whoever can open
 * the screen it is about.
 */
const ID = 'dates-fixes-2026-10';
const release = () => RELEASES.find((r) => r.id === ID)!;
const entry = (id: string) => release().entries.find((e) => e.id === id)!;
const REPO = resolve(__dirname, '../../../../..');
const source = (rel: string) => readFileSync(resolve(REPO, rel), 'utf8');

// Re-pinned by docs/whats-new-dates-link-submit (2026-10-06; was: "the dates
// fixes release is held as a draft").
describe('the dates fixes release is published', () => {
  const everyone: ReleaseViewer = {
    role: 'owner',
    permissions: [...PERMISSIONS],
    enabledModules: Object.keys(MODULE_REGISTRY) as ModuleId[],
  };
  const member: ReleaseViewer = { role: 'viewer', permissions: [], enabledModules: [] };

  // Re-pinned by docs/whats-new-dates-link-submit (2026-10-06; was: "is a
  // draft, so no feed carries it, and preparing it changes nothing a client
  // can observe": a draft, in no feed, no legacy list and no fingerprint).
  it('is published after the web deploys and the phone update, so every feed carries it, and it is the notice for every member the public link release does not reach', () => {
    expect(release()).toBeDefined();
    expect(release().status).toBe('published');
    expect(release().revision).toBe(1);
    for (const viewer of [everyone, member]) {
      expect(visibleReleases(RELEASES, viewer).map((r) => r.id)).toContain(ID);
    }
    expect(buildReleaseList(RELEASES, everyone, [], null).releases.map((r) => r.id)).toContain(ID);
    // The public link release, published a minute later, is the notice for
    // whoever manages public links; every other member is told this one
    // first, since its digest line reaches every member.
    // Re-pinned by docs/whats-new-returns-exchange (2026-10-11; was:
    // public-link-sent-request-2026-10): returns RX-2's release is published
    // later still, and an owner with every module is told it first. Claim
    // kept: a member the public link release does not reach is told this one.
    // Re-pinned by docs/whats-new-returns-requester (2026-10-12; was:
    // returns-exchange-2026-10): returns RX-3's release is published later
    // still, and an owner with every module is told it first. Claim kept: a
    // member the public link release does not reach is told this one.
    // Re-pinned by docs/whats-new-returns-close-rest (2026-10-12; was:
    // returns-requester-exchange-2026-10): returns RX-4's release is
    // published later still, and an owner with every module is told it
    // first. Claim kept: a member the public link release does not reach is
    // told this one (RX-4's reaches no member without a permission).
    // Re-pinned by docs/whats-new-return-history-hand-over (2026-10-12; was:
    // returns-close-rest-2026-10): the return history hand-over release is
    // published later still, and an owner with every module is told it
    // first. Claim kept: a member the public link release does not reach is
    // told this one (the hand-over release reaches no member without a
    // returns permission).
    // Re-pinned by the What's New publish of ungroup-2026-10 and
    // group-selected-2026-10 (2026-10-12): was returns-history-hand-over-2026-10
    // for the owner, and ID for a member with no permission. Group selected's
    // release is published later still and reaches every member (its list
    // entries have no audience; Ungroup's reaches no member without
    // items:update or items:create), so both are told it first. Claim kept:
    // a member the public link release does not reach is told this one once
    // the newer releases that reach them are read.
    // Re-pinned by docs/whats-new-ungroup-follow-ups (2026-10-12): the Ungroup follow-ups release is published at the top and reaches this reader, so it is read or seen here too and the order this test checks holds.
    // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: ungroup-follow-ups-2026-10): the pages-keep-groups-whole release is published after it, at the top, and reaches this reader (items:read); it reaches no member without items:read, so the member's notices below are unchanged.
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: pages-keep-groups-whole-2026-10 for the owner,
    // group-selected-2026-10 for the member, and the member's reads and seen sets below without the redesign
    // releases): the three redesign releases are published at the top and reach every member, so both are told
    // redesign-2026-10 first; the parked ai-search-finds-every-item release (#367) reaches the owner only. Once the
    // three are read, the member is told Group selected's, then this one, as before. Claim kept: a member the
    // public link release does not reach is told this one once the newer releases that reach them are read.
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: redesign-2026-10 for both with nothing read, and the
    // member's reads and seen sets below without the newest release): the unsubscribe-rack-question-fixes release
    // is published at the top and reaches every member, so both are told it first, and the member reads or sees it
    // with the three redesign releases. Claim kept: a member the public link release does not reach is told this one
    // once the newer releases that reach them are read.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: unsubscribe-rack-question-fixes-2026-10 for both
    // with nothing read, the reads and seen sets below without the release at the top, and the newest release's
    // read alone before redesign-2026-10): the ended-session-group-page-fixes release is published at the top and
    // reaches every member, so both are told it first, the unsubscribe-rack-question-fixes release once it is
    // read, and the member reads or sees it with the newer releases. Claim kept: a member the public link release
    // does not reach is told this one once the newer releases that reach them are read.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: ended-session-group-page-fixes-2026-10 for both
    // with nothing read, the reads and seen sets below without the release at the top, and the reads before
    // unsubscribe-rack-question-fixes-2026-10 and redesign-2026-10 without it): the
    // manage-order-items-and-app-fixes release is published at the top and reaches every member, so both are told
    // it first, the ended-session-group-page-fixes release once it is read, and the member reads or sees it with
    // the newer releases. Claim kept: a member the public link release does not reach is told this one once the
    // newer releases that reach them are read.
    // Re-pinned by docs/whats-new-small-fixes-8 (2026-10-31; was: manage-order-items-and-app-fixes-2026-10 for both
    // with nothing read, the reads and seen sets below without the release at the top, and the reads before
    // ended-session-group-page-fixes-2026-10, unsubscribe-rack-question-fixes-2026-10 and redesign-2026-10 without
    // it): the small-fixes-8 release is published at the top and reaches every member, so both are told it first,
    // the manage-order-items-and-app-fixes release once it is read, and the member reads or sees it with the newer
    // releases. Claim kept: a member the public link release does not reach is told this one once the newer
    // releases that reach them are read.
    // Re-pinned by docs/whats-new-small-fixes-8 for export-fixes-2026-10 (2026-10-31; was: small-fixes-8-2026-10 for
    // both with nothing read, and the reads below without the release at the top): the export fixes release is
    // published at the top and reaches whoever can export, so the owner is told it first and the small-fixes-8
    // release once it is read; the member cannot export and is told the small-fixes-8 release first, as before. Its
    // read sits first in redesignRead (a read of a release the member is not told changes nothing), so every slice
    // below takes one more. Claim kept: a member the public link release does not reach is told this one once the
    // newer releases that reach them are read.
    expect(buildReleaseList(RELEASES, everyone, [], null).latestUnread?.id).toBe(
      'export-fixes-2026-10',
    );
    expect(buildReleaseList(RELEASES, member, [], null).latestUnread?.id).toBe(
      'small-fixes-8-2026-10',
    );
    const redesignRead = [
      'export-fixes-2026-10',
      'small-fixes-8-2026-10',
      'manage-order-items-and-app-fixes-2026-10',
      'ended-session-group-page-fixes-2026-10',
      'unsubscribe-rack-question-fixes-2026-10',
      'redesign-2026-10',
      'redesign-mobile-app-2026-10',
      'redesign-web-fixes-2026-10',
    ].map((id) => ({
      release_id: id,
      revision: 1,
      dismissed_at: null,
      opened_at: '2026-10-20T13:00:00Z',
      read_at: '2026-10-20T13:00:00Z',
    }));
    const redesignSeen = Object.fromEntries(redesignRead.map((r) => [r.release_id, true]));
    // Added by docs/whats-new-small-fixes-8 for export-fixes-2026-10 (2026-10-31): once the release at the top
    // (its read sits first in redesignRead) is read, the owner is told the small-fixes-8 release.
    expect(
      buildReleaseList(RELEASES, everyone, redesignRead.slice(0, 1), null).latestUnread?.id,
    ).toBe('small-fixes-8-2026-10');
    // Added by docs/whats-new-small-fixes-8 (2026-10-31): once the release at the top (its read sits first in
    // redesignRead) is read, both are told the manage-order-items-and-app-fixes release.
    // Re-pinned by docs/whats-new-small-fixes-8 for export-fixes-2026-10 (2026-10-31; was: redesignRead.slice(0, 1)):
    // the export fixes release's read now sits first in redesignRead, above it, and both are read.
    expect(
      buildReleaseList(RELEASES, everyone, redesignRead.slice(0, 2), null).latestUnread?.id,
    ).toBe('manage-order-items-and-app-fixes-2026-10');
    expect(
      buildReleaseList(RELEASES, member, redesignRead.slice(0, 2), null).latestUnread?.id,
    ).toBe('manage-order-items-and-app-fixes-2026-10');
    // Added by docs/whats-new-2026-10-30 (2026-10-30): once the release at the top (its read sits first in
    // redesignRead) is read, both are told the ended-session-group-page-fixes release.
    // Re-pinned by docs/whats-new-small-fixes-8 (2026-10-31; was: redesignRead.slice(0, 1)): the small-fixes-8
    // release now sits first in redesignRead, above it, and both are read.
    // Re-pinned by docs/whats-new-small-fixes-8 for export-fixes-2026-10 (2026-10-31; was: redesignRead.slice(0, 2)):
    // the export fixes release's read now sits first in redesignRead, above them, and all three are read.
    expect(
      buildReleaseList(RELEASES, everyone, redesignRead.slice(0, 3), null).latestUnread?.id,
    ).toBe('ended-session-group-page-fixes-2026-10');
    expect(
      buildReleaseList(RELEASES, member, redesignRead.slice(0, 3), null).latestUnread?.id,
    ).toBe('ended-session-group-page-fixes-2026-10');
    // Once the release at the top (its read sits first in redesignRead) is read, both are told
    // the unsubscribe-rack-question-fixes release.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: redesignRead.slice(0, 1)): the
    // manage-order-items-and-app-fixes release now sits first in redesignRead, above it, and both are read.
    // Re-pinned by docs/whats-new-small-fixes-8 (2026-10-31; was: redesignRead.slice(0, 2)): the small-fixes-8
    // release now sits first in redesignRead, above them, and all three are read.
    // Re-pinned by docs/whats-new-small-fixes-8 for export-fixes-2026-10 (2026-10-31; was: redesignRead.slice(0, 3)):
    // the export fixes release's read now sits first in redesignRead, above them, and all four are read.
    expect(
      buildReleaseList(RELEASES, everyone, redesignRead.slice(0, 4), null).latestUnread?.id,
    ).toBe('unsubscribe-rack-question-fixes-2026-10');
    expect(
      buildReleaseList(RELEASES, member, redesignRead.slice(0, 4), null).latestUnread?.id,
    ).toBe('unsubscribe-rack-question-fixes-2026-10');
    // Once the newest release (its read sits first in redesignRead) is read, both are told
    // redesign-2026-10, as before.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: redesignRead.slice(0, 1)): the two releases
    // above the redesign ones now sit first in redesignRead, and both are read.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: redesignRead.slice(0, 2)): the three releases
    // above the redesign ones now sit first in redesignRead, and all three are read.
    // Re-pinned by docs/whats-new-small-fixes-8 (2026-10-31; was: redesignRead.slice(0, 3)): the four releases
    // above the redesign ones now sit first in redesignRead, and all four are read.
    // Re-pinned by docs/whats-new-small-fixes-8 for export-fixes-2026-10 (2026-10-31; was: redesignRead.slice(0, 4)):
    // the five releases above the redesign ones now sit first in redesignRead, and all five are read.
    expect(
      buildReleaseList(RELEASES, everyone, redesignRead.slice(0, 5), null).latestUnread?.id,
    ).toBe('redesign-2026-10');
    expect(
      buildReleaseList(RELEASES, member, redesignRead.slice(0, 5), null).latestUnread?.id,
    ).toBe('redesign-2026-10');
    expect(buildReleaseList(RELEASES, member, redesignRead, null).latestUnread?.id).toBe(
      'group-selected-2026-10',
    );
    const groupSelectedRead = {
      release_id: 'group-selected-2026-10',
      revision: 1,
      dismissed_at: null,
      opened_at: '2026-10-12T13:48:00Z',
      read_at: '2026-10-12T13:48:00Z',
    };
    expect(
      buildReleaseList(RELEASES, member, [...redesignRead, groupSelectedRead], null).latestUnread
        ?.id,
    ).toBe(ID);
    // An old phone build lists it first for a member once Group selected's
    // release is seen, with the notification settings link (the one entry
    // of this release that member is told).
    // Re-pinned by the same publish (2026-10-12; was: first with nothing
    // seen): Group selected's release is first until it is seen.
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: group-selected-2026-10 first with nothing seen,
    // and this one once it is seen): the three redesign releases come first until they are seen too.
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: redesign-2026-10 first with nothing seen): the
    // unsubscribe-rack-question-fixes release, published at the top, comes first until it is seen too, and the seen
    // set below includes it.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: unsubscribe-rack-question-fixes-2026-10 first with
    // nothing seen, and redesign-2026-10 once it is seen): the ended-session-group-page-fixes release, published at
    // the top, comes first until it is seen too, then the unsubscribe-rack-question-fixes release, and the seen sets
    // below include it.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: ended-session-group-page-fixes-2026-10 first with
    // nothing seen, and the seen sets below without the release at the top): the manage-order-items-and-app-fixes
    // release, published at the top, comes first until it is seen too, then the ended-session-group-page-fixes
    // release, and the seen sets below include it.
    // Re-pinned by docs/whats-new-small-fixes-8 (2026-10-31; was: manage-order-items-and-app-fixes-2026-10 first
    // with nothing seen, and the seen sets below without the release at the top): the small-fixes-8 release,
    // published at the top, comes first until it is seen too, then the manage-order-items-and-app-fixes release,
    // and the seen sets below include it.
    expect(legacyAnnouncementsFor(RELEASES, member, {})[0]?.id).toBe('small-fixes-8-2026-10');
    expect(
      legacyAnnouncementsFor(RELEASES, member, {
        'small-fixes-8-2026-10': true,
      })[0]?.id,
    ).toBe('manage-order-items-and-app-fixes-2026-10');
    expect(
      legacyAnnouncementsFor(RELEASES, member, {
        'small-fixes-8-2026-10': true,
        'manage-order-items-and-app-fixes-2026-10': true,
      })[0]?.id,
    ).toBe('ended-session-group-page-fixes-2026-10');
    expect(
      legacyAnnouncementsFor(RELEASES, member, {
        'small-fixes-8-2026-10': true,
        'manage-order-items-and-app-fixes-2026-10': true,
        'ended-session-group-page-fixes-2026-10': true,
      })[0]?.id,
    ).toBe('unsubscribe-rack-question-fixes-2026-10');
    expect(
      legacyAnnouncementsFor(RELEASES, member, {
        'small-fixes-8-2026-10': true,
        'manage-order-items-and-app-fixes-2026-10': true,
        'ended-session-group-page-fixes-2026-10': true,
        'unsubscribe-rack-question-fixes-2026-10': true,
      })[0]?.id,
    ).toBe('redesign-2026-10');
    expect(legacyAnnouncementsFor(RELEASES, member, redesignSeen)[0]?.id).toBe(
      'group-selected-2026-10',
    );
    expect(
      legacyAnnouncementsFor(RELEASES, member, {
        ...redesignSeen,
        'group-selected-2026-10': true,
      })[0],
    ).toEqual({
      id: ID,
      date: '2026-10-06',
      title: release().title,
      body: release().summary,
      cta: { href: '/dashboard/settings/notifications', label: 'Open notification settings' },
    });
    // Publishing it changes what clients observe.
    expect(registryFingerprint(RELEASES)).toContain(`${ID}@1:published`);
    expect(registryFingerprint(RELEASES)).not.toBe(
      registryFingerprint(RELEASES.filter((r) => r.id !== ID)),
    );
  });

  // Re-pinned by docs/whats-new-dates-link-submit (2026-10-06; was: "is a
  // draft just below the public link draft, dated after every other release
  // but that one"): both are published now, a minute apart.
  it('sits just below the public link release (published a minute later), dated after every other release, at a real time after the phone update launched', () => {
    // Re-pinned by fix/b44-update-restart-prompt (2026-10-31; was: every pinned position one place higher): the B44 phone update draft (mobile-app-asks-before-restarting) is dated after every release, at the top, above the export fixes release, so every position below it moves down by one.
    // Re-pinned by the small fixes slice 8 draft (fix/small-fixes-8; was:
    // without it): dated after every release, it sits at the top, so every
    // position below it moves down by one, and it is the one draft.
    // Re-pinned by the public link draft (fix/placed-cart-draft; was: the
    // newest entry, at the top, dated after every other release): it is
    // dated later and sits above this one.
    // Re-pinned by returns RX-2 (2026-10-11; was: at 1, the public link
    // release at 0): RX-2's draft, dated later, sits at the top. Claim kept:
    // the public link release, published a minute later, sits directly above.
    // Re-pinned by docs/whats-new-returns-exchange (2026-10-11; was: RX-2's
    // release at the top as a draft): it is published, in the same place.
    // Re-pinned by returns RX-3 (2026-10-11; was: at 2, RX-2's published
    // release at 0 and the public link release at 1): RX-3's draft, dated
    // later still, sits at the top above RX-2's published release. Claim
    // kept: the public link release, published a minute later, sits directly
    // above.
    // Re-pinned by docs/whats-new-returns-requester (2026-10-12; was: RX-3's
    // release at the top as a draft): it is published, in the same place.
    // Re-pinned by returns RX-4 (2026-10-12; was: at 3, RX-3's published
    // release at 0, RX-2's at 1, the public link release at 2): RX-4's draft,
    // dated later still, sits at the top above RX-3's published release.
    // Claim kept: the public link release, published a minute later, sits
    // directly above.
    // Re-pinned by docs/whats-new-returns-close-rest (2026-10-12; was: RX-4's
    // release at the top as a draft): it is published, in the same place.
    // Re-pinned by the return history hand-over fix (D-H1, 2026-10-12; was:
    // at 4, RX-4's published release at 0, RX-3's at 1, RX-2's at 2, the
    // public link release at 3): its draft, dated later still, sits at the
    // top above RX-4's published release. Claim kept: the public link
    // release, published a minute later, sits directly above.
    // Re-pinned by docs/whats-new-return-history-hand-over (2026-10-12; was:
    // its release at the top as a draft): it is published, in the same place.
    // Re-pinned by Ungroup G1 (2026-10-12, rebased onto #354; was: at 5, the
    // return history hand-over release at 0): Ungroup's draft, dated later
    // still, sits at the top above it. Claim kept: the public link release,
    // published a minute later, sits directly above.
    // Re-pinned by Group selected G2 (2026-10-12, rebased onto #351; was: at
    // 6, Ungroup's draft at 0): Group selected's draft, dated later still,
    // sits at the top above Ungroup's draft. Claim kept: the public link
    // release, published a minute later, sits directly above.
    // Re-pinned by the What's New publish of ungroup-2026-10 and
    // group-selected-2026-10 (2026-10-12): was: both at the top as drafts.
    // They are published, in the same places. Claim kept: the public link
    // release, published a minute later, sits directly above.
    const at = RELEASES.findIndex((r) => r.id === ID);
    // Re-pinned by docs/whats-new-ungroup-follow-ups (2026-10-12; was: 7): the Ungroup follow-ups release is published after it, at the top.
    // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: 8): the pages-keep-groups-whole release is published after it, at the top.
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: 9): the three redesign releases and the parked ai-search-finds-every-item release (#367) are published after it, at the top, so it sits four places lower.
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: 13): the unsubscribe-rack-question-fixes release is published after it, at the top, so it sits one place lower.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: 14): the ended-session-group-page-fixes release is published after it, at the top, so it sits one place lower.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: 15): the manage-order-items-and-app-fixes release is published after it, at the top, so it sits one place lower.
    // Re-pinned by docs/whats-new-small-fixes-8 for export-fixes-2026-10 (2026-10-31; was: 17): the export fixes release is published after it, at the top, so it sits one place lower.
    expect(at).toBe(19);
    // Re-pinned by docs/whats-new-ungroup-follow-ups (2026-10-12): the Ungroup follow-ups release is published at the top, above Group selected's, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: the Ungroup follow-ups release at 0, the public link release at 7): the pages-keep-groups-whole release is published at the top, above the Ungroup follow-ups release, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: the pages-keep-groups-whole release at 0, the public link release at 8): the three redesign releases and the parked ai-search-finds-every-item release (#367) are published at the top, above the pages-keep-groups-whole release, so every position below them moves down by four.
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: the redesign and ai-search-finds-every-item releases at 0 to 3, the public link release at 12): the unsubscribe-rack-question-fixes release is published at the top, above the redesign releases, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: the unsubscribe-rack-question-fixes release at 0, slice(1, 5), the public link release at 13): the ended-session-group-page-fixes release is published at the top, above it, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: the ended-session-group-page-fixes release at 0, slice(2, 6), the public link release at 14): the manage-order-items-and-app-fixes release is published at the top, above it, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-small-fixes-8 (2026-10-31; was: the slice 8 draft at 0): it is published in the same place, at the top, the newest release.
    // Re-pinned by docs/whats-new-small-fixes-8 for export-fixes-2026-10 (2026-10-31; was: the small-fixes-8 release at 0): the export fixes release is published at the top, the newest release, directly above it.
    expect(RELEASES[1]?.id).toBe('export-fixes-2026-10');
    expect(RELEASES[1]?.status).toBe('published');
    // Re-pinned by docs/whats-new-small-fixes-8 for export-fixes-2026-10 (2026-10-31; was: one place higher): the export fixes release is published at the top, above the small-fixes-8 release, so every position below it moves down by one.
    expect(RELEASES[2]?.id).toBe('small-fixes-8-2026-10');
    expect(RELEASES[2]?.status).toBe('published');
    expect(RELEASES[3]?.id).toBe('manage-order-items-and-app-fixes-2026-10');
    expect(RELEASES[3]?.status).toBe('published');
    expect(RELEASES[4]?.id).toBe('ended-session-group-page-fixes-2026-10');
    expect(RELEASES[4]?.status).toBe('published');
    expect(RELEASES[5]?.id).toBe('unsubscribe-rack-question-fixes-2026-10');
    expect(RELEASES[5]?.status).toBe('published');
    expect(RELEASES.slice(6, 10).map((r) => [r.id, r.status])).toEqual([
      ['redesign-2026-10', 'published'],
      ['redesign-mobile-app-2026-10', 'published'],
      ['redesign-web-fixes-2026-10', 'published'],
      ['ai-search-finds-every-item-2026-10', 'published'],
    ]);
    // Re-pinned by docs/whats-new-small-fixes-8 for export-fixes-2026-10 (2026-10-31; was: one place higher): the export fixes release is published at the top, above the small-fixes-8 release, so every position below it moves down by one.
    expect(RELEASES[10]?.id).toBe('pages-keep-groups-whole-2026-10');
    expect(RELEASES[10]?.status).toBe('published');
    expect(RELEASES[11]?.id).toBe('ungroup-follow-ups-2026-10');
    expect(RELEASES[11]?.status).toBe('published');
    expect(RELEASES[12]?.id).toBe('group-selected-2026-10');
    expect(RELEASES[12]?.status).toBe('published');
    expect(RELEASES[13]?.id).toBe('ungroup-2026-10');
    expect(RELEASES[13]?.status).toBe('published');
    expect(RELEASES[14]?.id).toBe('returns-history-hand-over-2026-10');
    expect(RELEASES[14]?.status).toBe('published');
    expect(RELEASES[15]?.id).toBe('returns-close-rest-2026-10');
    expect(RELEASES[15]?.status).toBe('published');
    expect(RELEASES[16]?.id).toBe('returns-requester-exchange-2026-10');
    expect(RELEASES[16]?.status).toBe('published');
    expect(RELEASES[17]?.id).toBe('returns-exchange-2026-10');
    expect(RELEASES[17]?.status).toBe('published');
    expect(RELEASES[18]?.id).toBe('public-link-sent-request-2026-10');
    expect(RELEASES[18]?.status).toBe('published');
    expect(Date.parse(RELEASES[18]!.publishedAt) - Date.parse(release().publishedAt)).toBe(60_000);
    for (const r of RELEASES.slice(at + 1)) {
      expect(Date.parse(release().publishedAt), r.id).toBeGreaterThan(Date.parse(r.publishedAt));
    }
    // A real time on a whole minute, after EAS showed the phone update
    // launching on iOS (read 2026-10-06 12:34Z): never the draft's
    // placeholder date (2026-10-14T17:00Z).
    expect(release().publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/);
    expect(Date.parse(release().publishedAt)).toBeGreaterThan(Date.parse('2026-10-06T12:34:00Z'));
    expect(Date.parse(release().publishedAt)).toBeLessThanOrEqual(
      Date.parse('2026-10-07T00:00:00Z'),
    );
  });
});

describe('the dates fixes release tells each change to whoever can see it', () => {
  // Re-pinned by docs/whats-new-dates-link-submit (2026-10-06; was: a copy
  // forced to published): the release itself is published now.
  const ids = (
    role: ReleaseViewer['role'],
    permissions: ReleaseViewer['permissions'],
    modules: ModuleId[],
  ) => {
    expect(release().status).toBe('published');
    return (
      visibleReleases([release()], { role, permissions, enabledModules: modules })[0]?.entries.map(
        (e) => e.id,
      ) ?? []
    );
  };

  it('has no release-wide audience: each entry carries its own', () => {
    expect(release().audience).toBeUndefined();
    // fix/overdue-by-org-day added the five overdue and on-time lines, after
    // the two expected-date lines they follow from.
    expect(release().entries.map((e) => e.id)).toEqual([
      'phone-po-list-expected-date',
      'phone-receive-expected-date',
      'phone-receive-overdue',
      'dashboard-overdue-purchase-orders',
      'briefing-overdue-purchase-orders',
      'digest-overdue-purchase-orders',
      'supplier-scorecard-on-time',
      'calendar-current-month',
      'digest-send-time',
    ]);
  });

  // Re-pinned by the claims review of #339 (2026-10-06; was: "Receiving on,
  // no permission, as the screen asks", audience { modules: ['receiving'] }):
  // the screen shows with Receiving on, but it lists purchase orders read
  // under row-level security, which needs purchase_orders:read, so without
  // it the screen is empty and its count has nothing to count.
  it("the phone's Receive POs overdue line: purchase_orders:read with Receiving on, as the screen's rows ask", () => {
    expect(ids('viewer', ['purchase_orders:read'], ['purchase_orders', 'receiving'])).toContain(
      'phone-receive-overdue',
    );
    expect(ids('viewer', [], ['purchase_orders', 'receiving'])).not.toContain(
      'phone-receive-overdue',
    );
    expect(ids('viewer', ['purchase_orders:read'], ['purchase_orders'])).not.toContain(
      'phone-receive-overdue',
    );
    expect(entry('phone-receive-overdue').audience).toEqual({
      anyPermission: ['purchase_orders:read'],
      modules: ['receiving'],
    });
  });

  it("the dashboard line: purchase_orders:read with Purchase orders on, as the count's rows and its link ask", () => {
    // The count reads only the purchase orders the member may read
    // (purchase_orders_select needs purchase_orders:read), and it links to
    // the purchase orders page (Purchase orders on).
    expect(ids('viewer', ['purchase_orders:read'], ['purchase_orders'])).toContain(
      'dashboard-overdue-purchase-orders',
    );
    expect(ids('viewer', [], ['purchase_orders'])).not.toContain('dashboard-overdue-purchase-orders');
    expect(ids('viewer', ['purchase_orders:read'], [])).not.toContain(
      'dashboard-overdue-purchase-orders',
    );
    expect(entry('dashboard-overdue-purchase-orders').audience).toEqual({
      anyPermission: ['purchase_orders:read'],
      modules: ['purchase_orders'],
    });
  });

  it("the briefing line: the briefing page's items:update with AI on", () => {
    expect(ids('manager', ['items:update'], ['ai'])).toContain('briefing-overdue-purchase-orders');
    expect(ids('manager', ['items:update'], [])).not.toContain('briefing-overdue-purchase-orders');
    expect(ids('viewer', [], ['ai'])).not.toContain('briefing-overdue-purchase-orders');
    expect(entry('briefing-overdue-purchase-orders').audience).toEqual({
      anyPermission: ['items:update'],
      modules: ['ai'],
    });
  });

  it("the digest's overdue line: whoever the digest sends purchase orders to (purchase_orders:read)", () => {
    // services/digest.ts canReadPo: the purchase order section needs
    // purchase_orders:read; the digest checks no module.
    expect(ids('viewer', ['purchase_orders:read'], [])).toContain('digest-overdue-purchase-orders');
    expect(ids('viewer', [], ['purchase_orders'])).not.toContain('digest-overdue-purchase-orders');
    expect(entry('digest-overdue-purchase-orders').audience).toEqual({
      anyPermission: ['purchase_orders:read'],
    });
  });

  it("the scorecard line: the report's reports:read with Purchase orders on, linked to it", () => {
    expect(ids('viewer', ['reports:read'], ['purchase_orders'])).toContain(
      'supplier-scorecard-on-time',
    );
    expect(ids('viewer', ['reports:read'], [])).not.toContain('supplier-scorecard-on-time');
    expect(ids('viewer', [], ['purchase_orders'])).not.toContain('supplier-scorecard-on-time');
    expect(entry('supplier-scorecard-on-time').audience).toEqual({
      anyPermission: ['reports:read'],
      modules: ['purchase_orders'],
    });
    expect(entry('supplier-scorecard-on-time').link).toEqual({
      href: '/dashboard/reports/supplier-scorecard',
      label: 'Open the supplier scorecard',
    });
    // The page's own gate: reports:read and the report's modules.
    const access = source('apps/web/src/lib/reports/report-access.ts');
    expect(access).toContain("'supplier-scorecard': ['purchase_orders'],");
  });

  it("the phone's Purchase orders line: purchase_orders:read with Purchase orders on, as the drawer's item asks", () => {
    expect(ids('viewer', ['purchase_orders:read'], ['purchase_orders'])).toContain(
      'phone-po-list-expected-date',
    );
    expect(ids('viewer', ['purchase_orders:read'], [])).not.toContain(
      'phone-po-list-expected-date',
    );
    expect(ids('viewer', [], ['purchase_orders'])).not.toContain('phone-po-list-expected-date');
    expect(entry('phone-po-list-expected-date').audience).toEqual({
      anyPermission: ['purchase_orders:read'],
      modules: ['purchase_orders'],
    });
  });

  // Re-pinned by the claims review of #339 (2026-10-06; was: "Receiving on,
  // no permission, as its drawer item and tab ask", audience { modules:
  // ['receiving'] }): the drawer item and tab ask only Receiving, but each
  // ETA is a purchase order the member may read, as slice 2's receiving line
  // already counts it.
  it("the phone's Receive POs line: purchase_orders:read with Receiving on, as the screen's rows ask", () => {
    expect(ids('viewer', ['purchase_orders:read'], ['purchase_orders', 'receiving'])).toContain(
      'phone-receive-expected-date',
    );
    expect(ids('viewer', [], ['purchase_orders', 'receiving'])).not.toContain(
      'phone-receive-expected-date',
    );
    expect(ids('viewer', ['purchase_orders:read'], ['purchase_orders'])).not.toContain(
      'phone-receive-expected-date',
    );
    expect(entry('phone-receive-expected-date').audience).toEqual({
      anyPermission: ['purchase_orders:read'],
      modules: ['receiving'],
    });
    // The screen reads purchase_orders with the member's own session, and
    // the drawer item asks no permission: the rows are what row-level
    // security lets the member read (purchase_orders_select, 0322).
    const receive = source('apps/mobile/app/(drawer)/(tabs)/receive.tsx');
    expect(receive).toContain(".from('purchase_orders')");
    const policy = source('supabase/migrations/0322_quantity_guards_avatar_scope_override_clears.sql');
    expect(policy).toContain("(select public.rls_orgs_with_permission('purchase_orders:read'))");
    const slice2 = RELEASES.find((r) => r.id === 'order-partial-approval-held-2026-10')!;
    expect(slice2.entries.find((e) => e.id === 'receiving-follows-permission')!.audience).toEqual(
      entry('phone-receive-expected-date').audience,
    );
  });

  it("the calendar line: the page's schedule:read or schedule:manage, Schedule on", () => {
    expect(ids('viewer', ['schedule:read'], ['schedule'])).toContain('calendar-current-month');
    expect(ids('manager', ['schedule:manage'], ['schedule'])).toContain('calendar-current-month');
    expect(ids('viewer', [], ['schedule'])).not.toContain('calendar-current-month');
    expect(ids('viewer', ['schedule:read'], [])).not.toContain('calendar-current-month');
  });

  it('the digest line: every member, linked to their notification settings', () => {
    expect(ids('viewer', [], [])).toEqual(['digest-send-time']);
    expect(entry('digest-send-time').audience).toBeUndefined();
    expect(entry('digest-send-time').link).toEqual({
      href: '/dashboard/settings/notifications',
      label: 'Open notification settings',
    });
  });
});

describe('the dates fixes release says only what shipped', () => {
  const all = () =>
    [
      release().title,
      release().summary,
      ...release().entries.flatMap((e) => [
        e.title,
        e.whatChanged,
        e.whyItMatters,
        e.howItAffectsYou,
        e.whatToDo,
      ]),
    ].join('\n');

  it('says the phone changes come with the latest update, and how to load it', () => {
    // Re-pinned by the review of #338 (2026-10-06; was: "... the Purchase
    // orders and Receive POs screens"): the summary also says the phone's
    // Receive POs overdue count comes with the update, within 500 characters.
    expect(release().summary).toContain(
      'In the mobile app, after the latest update, Purchase orders and Receive POs show each expected date as it was set, and Receive POs counts overdue ones as the web does.',
    );
    for (const id of ['phone-po-list-expected-date', 'phone-receive-expected-date']) {
      expect(entry(id).whatChanged, id).toContain(
        'In the mobile app, after the latest update, it shows the date that was set.',
      );
      expect(entry(id).whatToDo, id).toBe(
        'Close the app completely and open it again to load the latest update.',
      );
    }
    expect(entry('phone-receive-overdue').whatChanged).toContain(
      'In the mobile app, after the latest update, a purchase order counts as overdue once its expected date has passed',
    );
    expect(entry('phone-receive-overdue').whatToDo).toBe(
      'Close the app completely and open it again to load the latest update.',
    );
    // The web lines need no update.
    for (const id of [
      'dashboard-overdue-purchase-orders',
      'briefing-overdue-purchase-orders',
      'digest-overdue-purchase-orders',
      'supplier-scorecard-on-time',
    ]) {
      expect(entry(id).whatToDo, id).toBe('No action needed.');
      expect(entry(id).whatChanged, id).not.toContain('mobile app');
    }
  });

  it('states the rule once, as the code decides it: overdue or late only after the expected date, in the organization zone', () => {
    expect(release().summary).toContain(
      "A purchase order now counts as overdue only once its expected date has passed in your organization's time zone, and a delivery received on its expected date counts as on time.",
    );
    for (const id of [
      'phone-receive-overdue',
      'dashboard-overdue-purchase-orders',
      'briefing-overdue-purchase-orders',
      'digest-overdue-purchase-orders',
    ]) {
      expect(entry(id).whatChanged, id).toContain(
        "once its expected date has passed in your organization's time zone",
      );
    }
    expect(entry('supplier-scorecard-on-time').whatChanged).toContain(
      "only when it is received after its expected date, in your organization's time zone",
    );
    // Every surface decides it through core's one rule.
    const core = source('packages/core/src/time/calendar-date.ts');
    expect(core).toContain('export function isPastExpectedDay(');
    expect(core).toContain('export function pastExpectedDayCutoff(');
    expect(source('apps/web/src/server/services/purchase-orders.ts')).toContain(
      "lt('expected_at', cutoff)",
    );
    // Re-pinned by the review of #338 (2026-10-06; was: isPastExpectedDay per
    // row): the same rule, the organization's day worked out once per list.
    expect(source('apps/web/src/server/services/digest.ts')).toContain(
      'const isPast = pastExpectedDayTest(clock.now, clock.timeZone);',
    );
    expect(source('apps/web/src/server/services/digest.ts')).toContain('isOverdue: isPast(r.expected_at),');
    expect(source('apps/web/src/server/services/reports.ts')).toContain(
      'if (!isPastExpectedDay(po.expected_at, po.received_at, timeZone)) {',
    );
    // Re-pinned by the review of #338 (2026-10-06; was: isPastExpectedDay per
    // purchase order): the same rule, the organization's day worked out once.
    expect(source('apps/mobile/src/lib/receive-overdue.ts')).toContain(
      'const isPast = pastExpectedDayTest(now, timeZone);',
    );
    expect(source('packages/core/src/time/calendar-date.ts')).toContain(
      'return pastExpectedDayTest(at, timeZone)(expectedAt);',
    );
  });

  it('names the overdue counts the way each screen does', () => {
    const receive = source('apps/mobile/app/(drawer)/(tabs)/receive.tsx');
    expect(receive).toContain("` · ${overdueCount} OVERDUE`");
    expect(entry('phone-receive-overdue').whatChanged).toContain(
      "In US time zones, the mobile app's Receive POs screen counted a purchase order as overdue",
    );
    const dashboard = source('apps/web/src/app/(dashboard)/dashboard/page.tsx');
    expect(dashboard).toContain(
      "title: `${poOverdueCount} overdue purchase order${poOverdueCount === 1 ? '' : 's'}`,",
    );
    expect(entry('dashboard-overdue-purchase-orders').whatChanged).toContain(
      "In US time zones, the dashboard's list of what needs attention counted a purchase order as overdue",
    );
    const insights = source('apps/web/src/server/services/insights.ts');
    expect(insights).toContain("'overdue inbound PO'");
    const briefingPage = source('apps/web/src/app/(dashboard)/dashboard/insights/page.tsx');
    expect(briefingPage).toContain('Today&apos;s briefing');
    // Re-pinned by the review of #338 (2026-10-06; was: "Today's briefing and
    // the morning briefing notification" counted from the day before): the
    // notification runs at 13:00 UTC on weekdays, 6 AM Pacific, so it counted
    // a purchase order due that same day; only the Insights page, opened after
    // 5 PM, counted it from the evening before.
    // Re-pinned by the claims review of #339 (2026-10-06; was: "... from the
    // evening before its expected date, and ..."): midnight UTC is the
    // afternoon in Alaska and Hawaii, and 4 PM Pacific in winter, so the line
    // says "late in the day before" with the Pacific times.
    expect(entry('briefing-overdue-purchase-orders').whatChanged).toContain(
      "Today's briefing counted a purchase order as an overdue inbound PO from late in the day before its expected date (from 5 PM Pacific time, 4 PM in winter), and the morning briefing notification counted it on its expected date.",
    );
    const digest = source('apps/web/src/lib/email/es/families/digest.ts');
    expect(digest).toContain("`${plural(overdueTotal, 'purchase order')} overdue`");
    const scorecard = source('apps/web/src/app/(dashboard)/dashboard/reports/supplier-scorecard/page.tsx');
    expect(scorecard).toContain('<TableHead className="text-right">On-time</TableHead>');
    // The page's own note says the rule, not the old column comparison.
    expect(scorecard).not.toContain('received_at ≤ expected_at');
    expect(scorecard.replace(/\s+/g, ' ')).toContain(
      'On-time = received on or before the expected date (the day it was received, in your organization&apos;s time zone)',
    );
  });

  it('names the screens and the ETA the way the phone does', () => {
    const list = source('apps/mobile/src/screens/purchase-orders.tsx');
    expect(list).toContain('title="Purchase"');
    expect(list).toContain('`ETA ${formatCalendarDate(po.expected_at)}`');
    const receive = source('apps/mobile/app/(drawer)/(tabs)/receive.tsx');
    expect(receive).toContain('<SmallStat label="ETA" value={etaText} mono />');
    const registry = source('packages/core/src/modules/registry.ts');
    expect(registry).toContain("label: 'Receive POs', href: '/receive'");
  });

  it('describes the calendar as the page now works: the month in the organization zone, and Today drops the month', () => {
    const page = source('apps/web/src/app/(dashboard)/dashboard/schedule/page.tsx');
    expect(page).toContain('const today = zonedParts(new Date(), timeZone);');
    const calendar = source('apps/web/src/components/schedule/schedule-calendar.tsx');
    expect(calendar).toContain("params.delete('m');");
    expect(entry('calendar-current-month').whatChanged).toContain(
      'opening the team calendar or pressing Today showed the next month',
    );
  });

  it('quotes the card as it read, and says it now gives the footer time', () => {
    const controls = source('apps/web/src/components/settings/digest-controls.tsx');
    expect(controls).not.toContain('every Monday morning');
    expect(controls).toContain("Sent {scheduleLabel}, in your workspace's time zone.");
    expect(entry('digest-send-time').whatChanged).toContain('said it is sent every Monday morning');
    expect(entry('digest-send-time').whatChanged).toContain(
      "the same time the digest email's footer gives",
    );
  });

  it('claims nothing it cannot stand behind: no numbers, no promises, no word for a recorded quantity', () => {
    expect(all()).not.toMatch(/\bbooks?\b|%|guarantee|always|never|instantly|verified/i);
  });

  // Publish re-read (docs/whats-new-dates-link-submit, 2026-10-06), against
  // the code on main and what readers saw before the fixes.
  it('says only what happened: no weekly digest has been sent, the old ETA was a day early, and the calendar ran ahead in US zones', () => {
    // No weekly digest has been sent yet (each Monday run stopped before
    // sending until #326, and the first run with it is 2026-10-12, after
    // #338), so the line says what a preview counted and what the Monday
    // digest would have counted, never that a digest listed anything.
    const digest = entry('digest-overdue-purchase-orders');
    // Re-pinned by the claims review of #339 (2026-10-06; was: "... from the
    // evening before its expected date: a preview sent that evening counted
    // it, ..." and "..., or the evening before."): "late in the day before",
    // as the other lines say it.
    expect(digest.whatChanged).toContain(
      'counted a purchase order as overdue from late in the day before its expected date (from 5 PM Pacific time, 4 PM in winter): a preview sent then counted it, and the Monday digest would have counted one expected that Monday.',
    );
    expect(`${digest.whatChanged} ${digest.whyItMatters}`).not.toMatch(
      /Monday's digest listed|the Monday it was sent/,
    );
    expect(digest.whyItMatters).toBe(
      'A digest could count a purchase order as overdue on the day it was due, or late in the day before.',
    );
    const weekly = RELEASES.find((r) => r.id === 'weekly-digest-and-fixes-2026-10')!;
    expect(weekly.entries[0]!.whatChanged).toContain('so no weekly digest was ever sent');
    expect(source('apps/web/vercel.json')).toContain('"schedule": "0 14 * * 1"');
    // Before #335's update the Receive POs screen printed the ETA a day
    // early, so the why does not lean on the ETA a reader saw.
    // Re-pinned by the claims review of #339 (2026-10-06; was: "On the
    // evening before a purchase order was due, ..."): "Late in the day
    // before", true in every US zone.
    expect(entry('phone-receive-overdue').whyItMatters).toBe(
      'Late in the day before a purchase order was due, the screen could already count it as overdue.',
    );
    // The server's month ran ahead of the organization's only west of UTC.
    expect(entry('calendar-current-month').whatChanged).toMatch(
      /^In US time zones, late in the day on the last day of a month, /,
    );
  });
});

// Claims review of #339 (2026-10-06), against the code on main.
describe('the dates fixes release says what a reader saw, in every US zone', () => {
  it("the calendar line says only that the calendar opened on the next month: the next month's grid still showed today, unless that month began on a Sunday", () => {
    // The grid is 42 days from the Sunday on or before the 1st, events load
    // for the whole grid, and a day outside the month is only shaded, so on
    // a month's last day the next month's first row still held today and its
    // events. "today's events were a month away" was not true at most
    // month-ends (Sep 30 2026 opened October, whose grid starts Sun Sep 27).
    const calendar = source('apps/web/src/components/schedule/schedule-calendar.tsx');
    // Re-pinned by small fixes slice 8 (the calendar in the organization's time
    // zone): the grid is still the 42 days from the Sunday on or before the
    // 1st, now counted in UTC calendar days, and the page still reads events
    // for the whole grid (its range now padded two days each side), so the
    // claim this line was checked against still holds.
    expect(calendar).toContain('const d = new Date(Date.UTC(year, month - 1, 1 - firstWeekday + i));');
    expect(calendar).toContain('for (let i = 0; i < 42; i++) {');
    // The out-of-month shade moved to the redesign's sunk token (P4.F2, W-WS-04); the
    // day is still only shaded, never hidden, so its events still show.
    expect(calendar).toContain("!inMonth && 'bg-sunk',");
    const page = source('apps/web/src/app/(dashboard)/dashboard/schedule/page.tsx');
    expect(page).toContain('const events = await svc.listInRange(rangeFrom, rangeTo);');
    expect(entry('calendar-current-month').whyItMatters).toBe(
      'Late that day, the calendar opened on the next month instead of the current one.',
    );
    expect(entry('calendar-current-month').whyItMatters).not.toMatch(/a month away|events/);
  });

  it('no zone-generic line says "evening": midnight UTC is the afternoon in Alaska and Hawaii, and 4 PM Pacific in winter', () => {
    for (const e of release().entries) {
      const text = `${e.whatChanged} ${e.whyItMatters} ${e.howItAffectsYou}`;
      expect(text, e.id).not.toMatch(/evening/i);
    }
    for (const id of [
      'phone-receive-overdue',
      'dashboard-overdue-purchase-orders',
      'briefing-overdue-purchase-orders',
      'digest-overdue-purchase-orders',
    ]) {
      expect(entry(id).whatChanged, id).toContain('(from 5 PM Pacific time, 4 PM in winter)');
    }
  });

  it('the digest setting is matched to the footer of the next digest email, as the card and a Monday email compute them', () => {
    // The card names the NEXT run; a Monday email's footer names its own run
    // ('this-week') and a preview's the next. From the last Monday run before
    // a clock change until the first run after it, the card and the last
    // Monday email differ (Oct 26 2026: "7:00 AM PDT" in that email, "6:00 AM
    // PST" on the card from 14:00Z).
    const settings = source('apps/web/src/app/(dashboard)/dashboard/settings/notifications/page.tsx');
    expect(settings).toContain("digestScheduleLabel(org?.timezone, digestSendAt(new Date(), 'next'))");
    const email = source('apps/web/src/lib/email/es/families/digest.ts');
    expect(email).toContain("digestSendAt(now, preview ? 'next' : 'this-week')");
    expect(entry('digest-send-time').howItAffectsYou).toBe(
      'The setting gives the same day and time as the footer of the next digest email.',
    );
  });
});

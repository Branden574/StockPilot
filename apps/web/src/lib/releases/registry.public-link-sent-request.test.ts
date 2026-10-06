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
 * 2026-10-06 06:24:42Z). docs/whats-new-dates-link-submit publishes it, the
 * newest release, a minute after the dates fixes release. It was not
 * exercised in production (Demo Co has no public order link); the evidence
 * is #336's own test.
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
    expect(list.latestUnread?.id).toBe(ID);
    const linkManager: ReleaseViewer = {
      role: 'staff',
      permissions: ['public_links:manage'],
      enabledModules: ['public_requests'],
    };
    expect(buildReleaseList(RELEASES, linkManager, [], null).latestUnread?.id).toBe(ID);
    // An old phone build lists it first, with its link.
    expect(legacyAnnouncementsFor(RELEASES, everyone, {})[0]).toEqual({
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
    // A real time on a whole minute, after the web deploy (06:24:42Z) and
    // a minute after the dates fixes release published with it: never the
    // draft's placeholder date (2026-10-15T17:00Z).
    expect(release().publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/);
    expect(Date.parse(release().publishedAt)).toBeGreaterThan(Date.parse('2026-10-06T06:24:42Z'));
    expect(Date.parse(release().publishedAt)).toBeLessThanOrEqual(Date.parse('2026-10-07T00:00:00Z'));
  });

  it('is the newest entry, at the top, dated after every other release', () => {
    expect(RELEASES[0]?.id).toBe(ID);
    for (const r of RELEASES.slice(1)) {
      expect(Date.parse(release().publishedAt), r.id).toBeGreaterThan(Date.parse(r.publishedAt));
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
});

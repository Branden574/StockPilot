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
 * fix/placed-cart-draft: a request sent from a public order link no longer
 * leaves its notes, Delivery choice and delivery site in that browser for the
 * next person (public-orders-v2.sent-request-draft.test.tsx). Its own file so
 * the release tests that other open branches edit stay as they are; only the
 * position pins that list the releases above them moved, each with a note
 * (five in registry.test.ts, one in registry.dates-fixes.test.ts).
 *
 * The people who use a public order link never sign in, so the release is
 * told to whoever can open the Public requests settings page, as the page
 * checks: the module, and Manage public links or organization:update.
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
  it('is a draft, so no feed carries it, and preparing it changes nothing a client can observe', () => {
    expect(release()).toBeDefined();
    expect(release().status).toBe('draft');
    expect(release().revision).toBe(1);
    expect(visibleReleases(RELEASES, everyone).map((r) => r.id)).not.toContain(ID);
    expect(buildReleaseList(RELEASES, everyone, [], null).releases.map((r) => r.id)).not.toContain(ID);
    expect(legacyAnnouncementsFor(RELEASES, everyone, {}).map((a) => a.id)).not.toContain(ID);
    expect(registryFingerprint(RELEASES)).toBe(
      registryFingerprint(RELEASES.filter((r) => r.id !== ID)),
    );
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

    const published: Release = { ...r, status: 'published' };
    const told = (permissions: ReleaseViewer['permissions'], modules: ModuleId[]) =>
      visibleReleases([published], { role: 'staff', permissions, enabledModules: modules }).length > 0;
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

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  MODULE_REGISTRY,
  PERMISSIONS,
  releaseSchema,
  ROLE_PERMISSIONS,
  type ModuleId,
  type Release,
  type ReleaseViewer,
} from '@stockpilot/core';

import { buildReleaseList, legacyAnnouncementsFor, visibleReleases } from './logic';
import { RELEASES } from './registry';

/**
 * Added by docs/whats-new-unreadable-access-and-settings (2026-11-15): the
 * module check release for #557 (squash 4cd92b204, web only, no phone update,
 * no migration): when StockPilot cannot check which modules are on, or a
 * member's access, pages, buttons and links on the web say so and offer Try
 * again. Four entries: every member (pages and buttons), whoever can open
 * Settings, Modules and Navigation, whoever manages public request links, and
 * whoever manages customer portal accounts (Place order whose answer did not
 * come back).
 *
 * It sits directly below the settings release for #563
 * (settings-not-loaded-2026-11, registry.settings-not-loaded.test.ts), which
 * went live later, and above the count read rule release. Its own file, so
 * the release tests other open branches edit stay as they are.
 *
 * Re-pinned by docs/whats-new-navigation-keeps-choices (2026-11-15): the
 * navigation release is published later, directly above the settings release
 * and below the Liquid Glass draft. Each changed line has its own note.
 */
const ID = 'module-check-try-again-2026-11';
const SETTINGS_ID = 'settings-not-loaded-2026-11';
const COUNT_RELEASE_ID = 'count-read-rule-2026-11';
const EMAIL_RELEASE_ID = 'email-change-expired-2026-11';
// Added by docs/whats-new-navigation-keeps-choices (2026-11-15): the navigation release (owners and admins who can open Settings, Navigation), published later, directly above the settings release.
const NAVIGATION_ID = 'navigation-keeps-choices-2026-11';

const PAGES = 'pages-say-when-modules-not-checked';
const MODULE_SETTINGS = 'module-settings-say-when-not-checked';
const PUBLIC_LINKS = 'public-links-say-when-not-checked';
const PORTAL = 'portal-place-order-not-confirmed';

const release = () => RELEASES.find((r) => r.id === ID)!;
const entry = (id: string) => release().entries.find((e) => e.id === id)!;

const viewer = (
  role: ReleaseViewer['role'],
  permissions: ReleaseViewer['permissions'],
  enabledModules: ReleaseViewer['enabledModules'],
): ReleaseViewer => ({ role, permissions, enabledModules });
const EVERY_MODULE = Object.keys(MODULE_REGISTRY) as ModuleId[];
const without = (...ids: ModuleId[]) => EVERY_MODULE.filter((m) => !ids.includes(m));
const owner = viewer('owner', [...PERMISSIONS], EVERY_MODULE);
const admin = viewer('admin', ROLE_PERMISSIONS.admin, EVERY_MODULE);
const manager = viewer('manager', ROLE_PERMISSIONS.manager, EVERY_MODULE);
const staff = viewer('staff', ROLE_PERMISSIONS.staff, EVERY_MODULE);
const defaultViewer = viewer('viewer', ROLE_PERMISSIONS.viewer, EVERY_MODULE);
const member = viewer('viewer', [], []);
const entriesFor = (v: ReleaseViewer) =>
  visibleReleases(RELEASES, v)
    .find((r) => r.id === ID)
    ?.entries.map((e) => e.id) ?? [];

const REPO = resolve(__dirname, '../../../../..');
/** A source file under apps/web/src, as written. */
const source = (rel: string) => readFileSync(resolve(REPO, `apps/web/src/${rel}`), 'utf8');

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

const readNow = (releaseId: string) => ({
  release_id: releaseId,
  revision: 1,
  dismissed_at: null,
  opened_at: '2026-11-15T04:30:00Z',
  read_at: '2026-11-15T04:30:00Z',
});

describe('the module check release: order, status and date', () => {
  it('is published once, as revision 1, directly below the settings release and above the count read rule release', () => {
    expect(RELEASES.filter((r) => r.id === ID)).toHaveLength(1);
    expect(release().status).toBe('published');
    expect(release().revision).toBe(1);
    expect(release().withdrawnNote).toBeUndefined();
    // Re-pinned by docs/whats-new-navigation-keeps-choices (2026-11-15; was: RELEASES.slice(1, 5)): the navigation release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    expect(RELEASES.slice(2, 6).map((r) => [r.id, r.status])).toEqual([
      [SETTINGS_ID, 'published'],
      [ID, 'published'],
      [COUNT_RELEASE_ID, 'published'],
      [EMAIL_RELEASE_ID, 'published'],
    ]);
  });

  it('is dated the whole minute after #557 went live, in the past, after every release below it and before the settings release above it', () => {
    // #557 is live in production since 2026-11-15 03:45:33Z.
    expect(release().publishedAt).toBe('2026-11-15T03:46:00Z');
    const at = Date.parse(release().publishedAt);
    expect(at).toBeGreaterThan(Date.parse('2026-11-15T03:45:33Z'));
    expect(at).toBeLessThanOrEqual(Date.now());
    // Re-pinned by docs/whats-new-navigation-keeps-choices (2026-11-15; was: every pinned position one place higher): the navigation release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    expect(Date.parse(RELEASES[2]!.publishedAt)).toBeGreaterThan(at);
    expect(Date.parse(RELEASES[0]!.publishedAt)).toBeGreaterThanOrEqual(at);
    // Re-pinned by docs/whats-new-navigation-keeps-choices (2026-11-15; was: every pinned position one place higher): the navigation release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    for (const r of RELEASES.slice(4)) {
      expect(at, r.id).toBeGreaterThan(Date.parse(r.publishedAt));
    }
  });

  it('parses under the shared schema, in plain text, with its four entries', () => {
    expect(releaseSchema.safeParse(release()).success).toBe(true);
    for (const text of readerText(release())) expect(text).not.toMatch(/[<>]/);
    expect(release().entries.map((e) => [e.id, e.category, e.area])).toEqual([
      [PAGES, 'fixed', 'Web app'],
      [MODULE_SETTINGS, 'fixed', 'Settings'],
      [PUBLIC_LINKS, 'fixed', 'Public requests'],
      [PORTAL, 'fixed', 'Customer portal'],
    ]);
    for (const e of release().entries) {
      expect(
        RELEASES.filter((r) => r.entries.some((x) => x.id === e.id)).map((r) => r.id),
        e.id,
      ).toEqual([ID]);
    }
  });
});

describe('the module check release: the words', () => {
  it('has a title and a summary that stand on their own', () => {
    expect(release().title).toBe(
      'Clearer messages when StockPilot cannot check which modules are on',
    );
    expect(release().summary).toBe(
      'If StockPilot cannot check which modules are on, or your access, for a moment, pages, buttons and links on the web now say so, instead of leaving a feature out without saying why. This is usually temporary: try again in a moment. No app update is needed.',
    );
  });

  it('pages and buttons', () => {
    const e = entry(PAGES);
    expect(e.title).toBe('Pages say so when StockPilot cannot check which modules are on');
    expect(e.whatChanged).toBe(
      "If StockPilot cannot check which modules are on for your organization, a strip above the page now says We couldn't check which modules are on, with Try again. A page that needs that check says This page couldn't be loaded (a settings page says We couldn't load this settings page), with Try again, and a button that saves or changes something says Your access could not be checked. Please try again.",
    );
    expect(e.whyItMatters).toBe(
      'Before, a page could leave out a menu item or a feature without saying why.',
    );
    expect(e.howItAffectsYou).toBe(
      'This is rare and usually passes in a moment. When a button says your access could not be checked, nothing was changed.',
    );
    expect(e.whatToDo).toBe('If you see one of these messages, wait a moment and press Try again.');
  });

  it('Settings, Modules and Navigation', () => {
    const e = entry(MODULE_SETTINGS);
    expect(e.title).toBe('Settings, Modules and Navigation say so when modules cannot be checked');
    expect(e.whatChanged).toBe(
      "If StockPilot cannot check which modules are on, Settings, Modules says We couldn't load your modules and Settings, Navigation says We couldn't check which modules are on, each with Try again, instead of showing the switches or the menu editor.",
    );
    expect(e.whyItMatters).toBe(
      'Switches or a menu shown without that check might not match what your organization has turned on.',
    );
    expect(e.howItAffectsYou).toBe(
      'Nothing was changed. Both pages work as before once the check succeeds.',
    );
    expect(e.whatToDo).toBe('If you see this, press Try again after a moment.');
  });

  it('public request links and the order tracking page', () => {
    const e = entry(PUBLIC_LINKS);
    expect(e.title).toBe('Public request links say so when they cannot be checked');
    expect(e.whatChanged).toBe(
      "If StockPilot cannot check a public request link for a moment, the page it opens now says This page couldn't be loaded and We couldn't check this link just now, with Try again. On the order tracking page, if it cannot check whether a return can be requested, the order still shows, with a note saying so and Check again.",
    );
    expect(e.whyItMatters).toBe(
      'People who open your links can tell a passing problem from a link that no longer works.',
    );
    expect(e.howItAffectsYou).toBe('Nothing changes while StockPilot works normally.');
    expect(e.whatToDo).toBe(
      'No action needed. If someone tells you they saw this, ask them to try again in a moment.',
    );
  });

  it('the customer portal', () => {
    const e = entry(PORTAL);
    expect(e.title).toBe(
      'The customer portal asks to check orders before an order is placed again',
    );
    expect(e.whatChanged).toBe(
      "In the customer portal, if Place order sends an order and no answer comes back, the shop now says We couldn't confirm your order went through. Reload the page and check your orders before placing it again. It offers Reload and keeps Place order off until then, with the cart and note still on screen.",
    );
    expect(e.whyItMatters).toBe(
      'Pressing Place order again right away could send the same order twice.',
    );
    expect(e.howItAffectsYou).toBe(
      "When StockPilot turns an order down, the shop shows why and gives Place order back with the cart and note kept. If the portal cannot check a customer's access for a moment, its page says This page couldn't be loaded, with Try again.",
    );
    expect(e.whatToDo).toBe(
      'No action needed. If a customer asks, tell them to reload the page and check their orders before placing the order again.',
    );
  });

  it('keeps to what people see, in plain words', () => {
    const text = readerText(release()).join(' ');
    expect(text).not.toMatch(/\bbook(s|ed)?\b/i);
    expect(text).not.toMatch(/secur|vulnerab|exploit|leak|expos|attack|breach|unauthori/i);
    expect(text).not.toMatch(/[!\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
    // No links: each entry describes a rare state, not a place to go.
    for (const e of release().entries) expect(e.link, e.id).toBeUndefined();
  });
});

describe('the module check release: who is told', () => {
  it('has no release audience; the pages entry has none, and each other entry names who can use what it describes', () => {
    expect(release().audience).toBeUndefined();
    expect(entry(PAGES).audience).toBeUndefined();
    expect(entry(MODULE_SETTINGS).audience).toEqual({ anyPermission: ['organization:update'] });
    expect(entry(PUBLIC_LINKS).audience).toEqual({
      anyPermission: ['public_links:manage', 'organization:update'],
      modules: ['public_requests'],
    });
    expect(entry(PORTAL).audience).toEqual({
      anyPermission: ['customers:manage'],
      modules: ['b2b_portal'],
    });
  });

  it('reaches every member, each default role with the entries it can use', () => {
    expect(entriesFor(owner)).toEqual([PAGES, MODULE_SETTINGS, PUBLIC_LINKS, PORTAL]);
    expect(entriesFor(admin)).toEqual([PAGES, MODULE_SETTINGS, PUBLIC_LINKS, PORTAL]);
    expect(entriesFor(manager)).toEqual([PAGES, PORTAL]);
    expect(entriesFor(staff)).toEqual([PAGES]);
    expect(entriesFor(defaultViewer)).toEqual([PAGES]);
    expect(entriesFor(member)).toEqual([PAGES]);
  });

  it('leaves out the public links and portal entries where those modules are off', () => {
    expect(
      entriesFor(viewer('owner', [...PERMISSIONS], without('public_requests', 'b2b_portal'))),
    ).toEqual([PAGES, MODULE_SETTINGS]);
  });

  it('is the first notice for a reader the settings release does not reach, and the next one for a reader it does', () => {
    for (const v of [defaultViewer, member]) {
      expect(buildReleaseList(RELEASES, v, [], null).latestUnread?.id, v.role).toBe(ID);
      // An older phone build shows the newest one it has not seen: this title and summary.
      expect(legacyAnnouncementsFor(RELEASES, v, {})[0], v.role).toEqual({
        id: ID,
        date: '2026-11-15',
        title: release().title,
        body: release().summary,
      });
    }
    for (const v of [owner, admin, manager, staff]) {
      // Re-pinned by docs/whats-new-navigation-keeps-choices (2026-11-15; was: nothing read, then the settings release read): the navigation release is published later, at the top, and reaches owners and admins, so each reader reads it first, and every notice this test checks is the one it checked before. A read of a release by a reader it does not reach changes nothing.
      expect(
        buildReleaseList(RELEASES, v, [readNow(NAVIGATION_ID)], null).latestUnread?.id,
        v.role,
      ).toBe(SETTINGS_ID);
      expect(
        buildReleaseList(RELEASES, v, [readNow(NAVIGATION_ID), readNow(SETTINGS_ID)], null)
          .latestUnread?.id,
        v.role,
      ).toBe(ID);
    }
  });
});

describe('the module check release: the code the words rest on', () => {
  it('the strip above the page, drawn by the dashboard layout when the module state is unknown', () => {
    const strip = source('components/dashboard/modules-unread-banner.tsx');
    expect(strip).toContain('We couldn&apos;t check which modules are on.');
    expect(strip).toContain(
      'Some pages and menu items may be unavailable. This is usually temporary.',
    );
    expect(strip).toContain('Try again');
    expect(source('app/(dashboard)/layout.tsx')).toContain(
      '{moduleStateUnknown && <ModulesUnreadBanner />}',
    );
  });

  it("the page state: This page couldn't be loaded, for a member's access and for a link", () => {
    const states = source('lib/known-error-states.ts');
    expect(states).toContain('title: "This page couldn\'t be loaded",');
    expect(states).toContain(
      'body: "We couldn\'t check your access just now. This is usually temporary.",',
    );
    expect(states).toContain(
      'body: "We couldn\'t check this link just now. This is usually temporary.",',
    );
  });

  it("a button's answer: Your access could not be checked. Please try again.", () => {
    expect(source('lib/modules/module-state.ts')).toContain(
      "super('Your access could not be checked. Please try again.');",
    );
    expect(entry(PAGES).whatChanged).toContain(
      'Your access could not be checked. Please try again.',
    );
  });

  it('Settings, Modules and Navigation: organization:update, the two states', () => {
    const modules = source('app/(dashboard)/dashboard/settings/modules/page.tsx');
    expect(modules).toContain("if (!can(ctx, 'organization:update')) {");
    expect(modules).toContain('title="We couldn\'t load your modules"');
    const navigation = source('app/(dashboard)/dashboard/settings/navigation/page.tsx');
    expect(navigation).toContain("if (!can(ctx, 'organization:update')) {");
    expect(navigation).toContain('title="We couldn\'t check which modules are on"');
  });

  it('the order tracking page: the note and Check again', () => {
    const track = source('components/orders/track-form.tsx');
    expect(track).toContain(
      'We couldn&apos;t check whether you can request a return for this order right now.',
    );
    expect(track).toContain('Check again');
    expect(source('app/r/track/page.tsx')).toContain('TrackForm');
  });

  it('the portal shop: the words, Reload, and Place order off until then', () => {
    const shop = source('components/portal/portal-shop.tsx');
    expect(shop).toContain(
      '"We couldn\'t confirm your order went through. Reload the page and check your orders before placing it again.";',
    );
    expect(shop).toContain('Reload');
    expect(entry(PORTAL).whatChanged).toContain(
      "We couldn't confirm your order went through. Reload the page and check your orders before placing it again.",
    );
  });
});

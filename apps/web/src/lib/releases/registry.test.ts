import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  COMPLETION_CONFIRM_LABEL,
  describeOccurrence,
  COMPLETION_REVIEW_LABEL,
  describeShortPickLines,
  EXCEPTION_EVIDENCE_MAX_PHOTOS,
  EXCEPTION_EVIDENCE_NOTE_MAX,
  HOLD_AVAILABLE_STOCK_LABEL,
  MODULE_REGISTRY,
  ORDER_LINE_HIDDEN_ITEM_NAME,
  PARTIAL_RESULT_ORDER_CHANGED_COPY,
  partialActionMovedOnCopy,
  PERMISSIONS,
  PUT_AWAY_NEEDS_TRANSFER_COPY,
  PUT_AWAY_NEEDS_VIEW_ITEMS_COPY,
  releaseRegistrySchema,
  type ModuleId,
  type Release,
  type ReleaseViewer,
} from '@stockpilot/core';

import { ANNOUNCEMENTS } from '@/lib/onboarding/announcements';

import { LEGACY_ANNOUNCEMENTS } from './legacy-announcements.fixture';
import { buildReleaseList, legacyAnnouncementsFor, registryFingerprint, visibleReleases } from './logic';
import { RELEASES } from './registry';

/**
 * THE PUBLISHING GATE. Release notes ship by pull request, so this file is the
 * review a machine can do. It fails the build when content is malformed, when a
 * link points at a page that does not exist, when a legacy announcement drifted
 * by a character, or when the copy makes a claim StockPilot cannot stand behind.
 */

const DASHBOARD_APP_DIR = resolve(__dirname, '../../app/(dashboard)');

/** '/dashboard/orders?status=x' -> does app/(dashboard)/dashboard/orders/page.tsx exist? */
function pageExistsFor(href: string): boolean {
  const path = href.split('?')[0]!.replace(/\/+$/, '');
  return existsSync(resolve(DASHBOARD_APP_DIR, `.${path}`, 'page.tsx'));
}

/** Every string a reader can see in a release. */
function readerText(r: Release): string[] {
  return [
    r.title,
    r.summary,
    r.withdrawnNote ?? '',
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
 * Claims the product cannot confirm (maintenance brief §20: StockPilot prepares
 * an email, it does not send one, and it never sees a ticket), plus vague filler
 * that tells a reader nothing. Lowercase; matched case-insensitively.
 */
const FORBIDDEN = [
  'email sent',
  'ticket created',
  'ticket assigned',
  'request submitted',
  'zendesk',
  'dc4 notified',
  'andrew notified',
  'general improvements',
  'various improvements',
  'bug fixes and improvements',
  'under the hood',
  'optimized backend',
];

describe('release registry', () => {
  it('is valid against the shared schema', () => {
    const parsed = releaseRegistrySchema.safeParse(RELEASES);
    expect(
      parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    ).toEqual([]);
  });

  it('has something published', () => {
    expect(RELEASES.filter((r) => r.status === 'published').length).toBeGreaterThan(0);
  });

  it('every link points at a dashboard page that exists', () => {
    const dead = RELEASES.flatMap((r) =>
      r.entries
        .filter((e) => e.link && !pageExistsFor(e.link.href))
        .map((e) => `${r.id}/${e.id} -> ${e.link!.href}`),
    );
    expect(dead).toEqual([]);
  });

  it('every entry with a link says who can reach it, with real permission names', () => {
    // A link with no audience tells everyone about a page that may bounce them
    // straight back to the dashboard. Pages open to every member are the only
    // exception, and they are listed here by name so the exception is a decision.
    const OPEN_TO_EVERY_MEMBER = new Set([
      '/dashboard/help',
      '/dashboard/support',
      '/dashboard/settings/profile',
      '/dashboard/whats-new',
    ]);
    const ungated = RELEASES.flatMap((r) =>
      r.entries
        .filter(
          (e) =>
            e.link &&
            !OPEN_TO_EVERY_MEMBER.has(e.link.href.split('?')[0]!) &&
            !e.audience &&
            !r.audience,
        )
        .map((e) => `${r.id}/${e.id}`),
    );
    expect(ungated).toEqual([]);
    const known = new Set<string>(PERMISSIONS);
    for (const r of RELEASES) {
      for (const p of [
        ...(r.audience?.anyPermission ?? []),
        ...r.entries.flatMap((e) => e.audience?.anyPermission ?? []),
      ]) {
        expect(known.has(p), `unknown permission "${p}" in ${r.id}`).toBe(true);
      }
    }
  });

  it('makes no claim StockPilot cannot stand behind, and no empty filler, in ANY field', () => {
    const hits = RELEASES.flatMap((r) =>
      readerText(r).flatMap((text) =>
        FORBIDDEN.filter((phrase) => text.toLowerCase().includes(phrase)).map(
          (phrase) => `${r.id}: "${phrase}"`,
        ),
      ),
    );
    expect(hits).toEqual([]);
  });

  it('uses no emoji and no exclamation marks: plain professional prose', () => {
    const offenders = RELEASES.flatMap((r) =>
      readerText(r)
        .filter((t) => /[!\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(t))
        .map((t) => `${r.id}: ${t.slice(0, 60)}`),
    );
    expect(offenders).toEqual([]);
  });

  it('never answers "what do I need to do" with nothing', () => {
    // "No action needed." is a fine answer. An empty shrug is not.
    for (const r of RELEASES)
      for (const e of r.entries)
        expect(e.whatToDo.trim().length, `${r.id}/${e.id}`).toBeGreaterThan(8);
  });
});

describe('the six legacy announcements survive the move, to the character', () => {
  it.each(LEGACY_ANNOUNCEMENTS.map((a) => [a.id, a] as const))('%s', (_id, legacy) => {
    const r = RELEASES.find((x) => x.id === legacy.id);
    expect(
      r,
      `release "${legacy.id}" is missing: its id keys every user's seen-state`,
    ).toBeDefined();
    expect(r!.status).toBe('published');
    expect(r!.revision).toBe(1);
    expect(r!.title).toBe(legacy.title);
    // `summary` is what old mobile builds render as the announcement body.
    expect(r!.summary).toBe(legacy.body);
    expect(r!.publishedAt.slice(0, 10)).toBe(legacy.date);
    const link = r!.entries.find((e) => e.link)?.link;
    expect(link).toEqual({ href: legacy.href, label: legacy.label });
  });

  it('keeps them in their original relative order', () => {
    const order = RELEASES.map((r) => r.id).filter((id) =>
      LEGACY_ANNOUNCEMENTS.some((a) => a.id === id),
    );
    expect(order).toEqual(LEGACY_ANNOUNCEMENTS.map((a) => a.id));
  });
});

/**
 * F1-3's release was held as a DRAFT until its phone release (pnpm release:ota)
 * and the Demo Co walk (review 2026-09-27, M4): published in the feature
 * commit, it would have been announced to phone users on merge, before the
 * phone had the location screen. This follow-up publishes it.
 */
describe('F1-3 (last physical count and location pages) is published', () => {
  const F1_3 = 'last-physical-count-and-location-pages-2026-09-27';
  const release = () => RELEASES.find((r) => r.id === F1_3)!;
  /** A reader every audience includes. */
  const everyone: ReleaseViewer = {
    role: 'owner',
    permissions: [...PERMISSIONS],
    enabledModules: Object.keys(MODULE_REGISTRY) as ModuleId[],
  };

  it('is published after the web deploy, the phone update and the Demo Co walk, so readers are told', () => {
    expect(release().status).toBe('published');
    expect(visibleReleases(RELEASES, everyone).map((r) => r.id)).toContain(F1_3);
    // An old phone build lists at most three unread releases, newest first;
    // F1-3 comes into that list once the four newer releases are read.
    const newer = Object.fromEntries(
      RELEASES.slice(0, RELEASES.findIndex((r) => r.id === F1_3)).map((r) => [r.id, true]),
    );
    expect(legacyAnnouncementsFor(RELEASES, everyone, newer).map((a) => a.id)).toContain(F1_3);
    expect(registryFingerprint(RELEASES)).toContain(F1_3);
    expect(ANNOUNCEMENTS.map((a) => a.id)).toContain(F1_3);
    expect(Date.parse(release().publishedAt)).toBeLessThanOrEqual(Date.parse('2026-09-28T00:00:00Z'));
  });

  it('its summary (all an old phone build shows) is true on both platforms, and says who may recount', () => {
    const summary = release().summary;
    expect(summary).toMatch(/^On the web and in the mobile app, /);
    expect(summary).toContain(
      'When Cycle Counts is on, managers who can assign counts and adjust stock can recount the items at a location from its page.',
    );
    expect(summary).not.toMatch(/Locations page|item page/);
  });
});

/**
 * Owner report 2026-09-27: counts and exceptions called the quantity
 * StockPilot has on record "the book", which an organization that stocks books
 * read as the product. The wording is now "stock on record" (core
 * on-record-wording.guard.test.ts). The releases that describe those screens
 * were edited in place, without a new revision (a wording fix, not a
 * re-announcement), and the fix has a release of its own, held as a draft
 * until the phone release (pnpm release:ota) brought the phone the new words,
 * and published after it.
 */
describe('stock on record wording', () => {
  const FIX = 'stock-on-record-wording-2026-09-27';
  const release = () => RELEASES.find((r) => r.id === FIX)!;
  const everyone: ReleaseViewer = {
    role: 'owner',
    permissions: [...PERMISSIONS],
    enabledModules: Object.keys(MODULE_REGISTRY) as ModuleId[],
  };
  /** The recorded-quantity jargon, as the releases used it. */
  const JARGON = [
    /\bthe book\b/i,
    /\bBook now\b/,
    /\bbook corrected\b/i,
    /\bbook (?:qty|quantity|quantities)\b/i,
    /,\s*book\s+\d/i,
  ];

  it('is published after the web deploy and the verified phone update, so readers are told', () => {
    expect(release().status).toBe('published');
    expect(release().revision).toBe(1);
    expect(visibleReleases(RELEASES, everyone).map((r) => r.id)).toContain(FIX);
    // An old phone build lists at most three unread releases, newest first;
    // it comes into that list once the newer releases are read.
    const newer = Object.fromEntries(
      RELEASES.slice(0, RELEASES.findIndex((r) => r.id === FIX)).map((r) => [r.id, true]),
    );
    expect(legacyAnnouncementsFor(RELEASES, everyone, newer).map((a) => a.id)).toContain(FIX);
    expect(registryFingerprint(RELEASES)).toContain(FIX);
    expect(ANNOUNCEMENTS.map((a) => a.id)).toContain(FIX);
    expect(Date.parse(release().publishedAt)).toBeLessThanOrEqual(Date.parse('2026-09-28T00:00:00Z'));
  });

  it('is a fix to Inventory, for everyone who can read items', () => {
    expect(release().entries).toHaveLength(1);
    const entry = release().entries[0]!;
    expect(entry.category).toBe('fixed');
    expect(entry.area).toBe('Inventory');
    expect(entry.audience).toEqual({ anyPermission: ['items:read'] });
    expect(release().summary).toMatch(/^On the web and in the mobile app, /);
    expect(release().summary).toContain(
      'now say stock on record, not book, for the quantity StockPilot has recorded.',
    );
    expect(release().summary).toContain(
      'Book corrected from 50 to 0 (-50) now reads Stock on record corrected from 50 to 0 (-50)',
    );
    expect(entry.whatChanged).toContain('Count did not match the stock on record');
    expect(entry.howItAffectsYou).toContain('The Books section');
  });

  it('its summary says "on record" at most once a sentence', () => {
    // The first draft read "...now call the quantity StockPilot has on record
    // the stock on record, not the book", which says it twice in one breath.
    const sentences = release()
      .summary.split(/(?<=\.)\s+/)
      .filter(Boolean);
    expect(sentences.length).toBeGreaterThan(1);
    for (const sentence of sentences) {
      expect(sentence.match(/\bon record\b/gi)?.length ?? 0, sentence).toBeLessThanOrEqual(1);
    }
  });

  it('no other release calls the recorded quantity "the book"', () => {
    // This release quotes the old words on purpose, to say what changed.
    const hits = RELEASES.filter((r) => r.id !== FIX).flatMap((r) =>
      readerText(r).flatMap((text) =>
        JARGON.filter((re) => re.test(text)).map((re) => `${r.id}: ${re} in "${text.slice(0, 80)}"`),
      ),
    );
    expect(hits).toEqual([]);
  });

  it('the count and exception releases were reworded in place, not re-announced', () => {
    for (const id of [
      'count-differences-and-recounts-2026-09',
      'last-physical-count-and-location-pages-2026-09-27',
    ]) {
      const r = RELEASES.find((x) => x.id === id)!;
      expect(r.status, id).toBe('published');
      expect(r.revision, id).toBe(1);
      expect(readerText(r).join(' '), id).toContain('stock on record');
    }
  });
});

/**
 * Kits on the New order page (owner decisions 2026-09-27): anyone who can place
 * orders sees kits, with no Bundles permission, but only where the Bundles
 * module is on. The note is addressed the same way, and was held as a draft
 * until the web deploy and the Demo Co walk.
 */
describe('the kits release', () => {
  const release = () => RELEASES.find((r) => r.id === 'order-page-kits-2026-09-27')!;

  it('shipped as four releases in this order, just below F1-4 (published after them)', () => {
    // The notice offers only the top unread release a reader can see, and an
    // old phone build lists at most three. The four went out together: kits,
    // then the stock on record fix every counter sees; where Bundles is off,
    // the fix leads them. F1-4's photos release was published after them and
    // sits above (and later releases above that).
    const published = RELEASES.filter((r) => r.status !== 'draft');
    const at = published.findIndex((r) => r.id === 'exception-photos-2026-09');
    expect(published.slice(at, at + 5).map((r) => r.id)).toEqual([
      'exception-photos-2026-09',
      'order-page-kits-2026-09-27',
      'stock-on-record-wording-2026-09-27',
      'order-page-add-full-kit-removed-2026-09-27',
      'bundle-distribute-managers-2026-09-27',
    ]);
    for (const r of published.slice(at + 1, at + 5)) {
      expect(r.status, r.id).toBe('published');
      expect(registryFingerprint(RELEASES), r.id).toContain(r.id);
    }
  });

  it('is addressed to people who can place orders, where Orders and Bundles are on', () => {
    // Modules inside one audience are alternatives, so Orders sits on the
    // release and Bundles on each entry: a reader must pass both.
    expect(release().audience).toEqual({ modules: ['orders'] });
    for (const e of release().entries) {
      expect(e.area).toBe('Orders');
      expect(e.audience).toEqual({ anyPermission: ['orders:request'], modules: ['bundles'] });
    }
  });

  it('never says a raise only adds, and says what one kit less takes (verify 2026-09-27)', () => {
    // The 61st kit moves the kit's own 60 backpacks from 18-A onto 16-B, so a
    // raise does not only ever add; it never lowers a line the person changed.
    // One kit less takes one kit's worth, never every unit above the count.
    const text = readerText(release()).join(' ');
    expect(text).not.toMatch(/only (ever )?adds/i);
    const lines = release().entries.find((e) => e.id === 'order-page-kit-lines')!;
    expect(lines.whatChanged).toContain('never lowers or removes a line you changed');
    expect(lines.whatChanged).toContain('the kit may move its own units onto one rack');
    expect(lines.whatChanged).toContain("one kit's worth of each item for every kit taken out");
    expect(lines.whatChanged).toContain('never units you added by hand');
  });

  it('reaches only readers with Orders AND Bundles on who can place orders', () => {
    const published: Release = { ...release(), status: 'published' };
    const reader = (modules: ModuleId[], permissions: ReleaseViewer['permissions'] = ['orders:request']) =>
      visibleReleases([published], { role: 'viewer', permissions, enabledModules: modules }).length;
    expect(reader(['orders', 'bundles'])).toBe(1);
    expect(reader(['orders'])).toBe(0);
    expect(reader(['bundles'])).toBe(0);
    expect(reader(['orders', 'bundles'], [])).toBe(0);
  });
});

/**
 * The Add full kit button was on the New order page of every organization with
 * a category named like "New Hire", whatever its modules; kits exist only where
 * Bundles is on. So the note that the button is gone is its own release,
 * addressed to everyone who can place orders, and its words must hold for an
 * organization without Bundles (review F7, 2026-09-27).
 */
describe('the Add full kit removal release', () => {
  const REMOVED = 'order-page-add-full-kit-removed-2026-09-27';
  const KITS = 'order-page-kits-2026-09-27';
  const release = () => RELEASES.find((r) => r.id === REMOVED)!;
  const published = (id: string): Release => ({
    ...RELEASES.find((r) => r.id === id)!,
    status: 'published',
  });
  const ordersNoBundles: ReleaseViewer = {
    role: 'viewer',
    permissions: ['orders:request'],
    enabledModules: ['orders'],
  };
  const ordersWithBundles: ReleaseViewer = { ...ordersNoBundles, enabledModules: ['orders', 'bundles'] };

  it('is addressed to people who can place orders, Bundles or not', () => {
    for (const e of release().entries) {
      expect(e.audience).toEqual({ anyPermission: ['orders:request'], modules: ['orders'] });
    }
    expect(release().audience).toBeUndefined();
  });

  it('reaches an organization without Bundles, which is not told about kits', () => {
    const seen = visibleReleases([published(KITS), published(REMOVED)], ordersNoBundles).map((r) => r.id);
    expect(seen).toEqual([REMOVED]);
    const both = visibleReleases([published(KITS), published(REMOVED)], ordersWithBundles).map((r) => r.id);
    expect(both).toEqual([KITS, REMOVED]);
  });

  it('says nothing about kits that is untrue where Bundles is off', () => {
    const text = readerText(release()).join(' ');
    expect(text).not.toMatch(/kits take its place/i);
    // Every sentence that mentions kits beyond the button's own name says
    // where they exist.
    const sentences = text.split(/(?<=\.)\s+/);
    for (const sentence of sentences) {
      const withoutButton = sentence.replace(/Add full kit/g, '');
      if (/\bkits?\b/i.test(withoutButton) && !/whatever (a|the) kit/i.test(withoutButton)) {
        expect(sentence, sentence).toMatch(/where your organization uses Bundles/i);
      }
    }
  });

  it('the kits release no longer carries the removal, so no reader gets it twice', () => {
    const kits = RELEASES.find((r) => r.id === KITS)!;
    expect(readerText(kits).join(' ')).not.toMatch(/Add full kit/);
  });
});

/**
 * F1-4's release (photos on exceptions) was held as a DRAFT until its phone
 * release (pnpm release:ota) and the Demo Co walk, as F1-3's was: published
 * with the web photo panel, it would have told phone users about photos their
 * app could not add yet. This follow-up publishes it.
 */
describe('F1-4 (photos on exceptions) is published', () => {
  const F1_4 = 'exception-photos-2026-09';
  const release = () => RELEASES.find((r) => r.id === F1_4)!;
  /** A reader every audience includes. */
  const everyone: ReleaseViewer = {
    role: 'owner',
    permissions: [...PERMISSIONS],
    enabledModules: Object.keys(MODULE_REGISTRY) as ModuleId[],
  };

  it('is published after the web deploy, the phone update and the Demo Co walk, so every feed carries it', () => {
    expect(release().status).toBe('published');
    expect(visibleReleases(RELEASES, everyone).map((r) => r.id)).toContain(F1_4);
    const list = buildReleaseList(RELEASES, everyone, [], null);
    expect(list.releases.map((r) => r.id)).toContain(F1_4);
    // An old phone build lists at most three unread releases, newest first;
    // F1-4 comes into that list once the newer releases are read.
    const newer = Object.fromEntries(
      RELEASES.slice(0, RELEASES.findIndex((r) => r.id === F1_4)).map((r) => [r.id, true]),
    );
    expect(legacyAnnouncementsFor(RELEASES, everyone, newer).map((a) => a.id)).toContain(F1_4);
    expect(registryFingerprint(RELEASES)).toContain(F1_4);
    expect(ANNOUNCEMENTS.map((a) => a.id)).toContain(F1_4);
    expect(Date.parse(release().publishedAt)).toBeLessThanOrEqual(Date.parse('2026-09-29T00:00:00Z'));
  });

  it('is dated after every release below it (the releases above it were published later)', () => {
    const at = RELEASES.findIndex((r) => r.id === F1_4);
    for (const r of RELEASES.slice(0, at)) {
      expect(Date.parse(r.publishedAt), r.id).toBeGreaterThan(Date.parse(release().publishedAt));
    }
    for (const r of RELEASES.slice(at + 1)) {
      expect(Date.parse(release().publishedAt), r.id).toBeGreaterThan(Date.parse(r.publishedAt));
    }
  });

  it('is new in Inventory, addressed as the page gates it: seeing photos is items:read, adding them stock:adjust', () => {
    expect(release().audience).toBeUndefined();
    expect(release().entries.map((e) => e.id)).toEqual(['exception-photos', 'exception-photos-add-remove']);
    for (const e of release().entries) {
      expect(e.category, e.id).toBe('new');
      expect(e.area, e.id).toBe('Inventory');
      expect(e.link, e.id).toEqual({ href: '/dashboard/exceptions', label: 'Open Exceptions' });
    }
    const [see, add] = release().entries;
    expect(see!.audience).toEqual({ anyPermission: ['items:read'] });
    expect(add!.audience).toEqual({ anyPermission: ['stock:adjust'] });
  });

  it('once published, a reader who can only view is told about seeing photos, not adding them', () => {
    const published: Release = { ...release(), status: 'published' };
    const viewer: ReleaseViewer = { role: 'viewer', permissions: ['items:read'], enabledModules: [] };
    const staff: ReleaseViewer = { ...viewer, role: 'staff', permissions: ['items:read', 'stock:adjust'] };
    expect(visibleReleases([published], viewer)[0]!.entries.map((e) => e.id)).toEqual(['exception-photos']);
    expect(visibleReleases([published], staff)[0]!.entries.map((e) => e.id)).toEqual([
      'exception-photos',
      'exception-photos-add-remove',
    ]);
  });

  it("says the owner's decisions plainly: both platforms, online only, soft removal, location removed, no notifications", () => {
    const r = release();
    expect(r.summary).toMatch(/^On the web and in the mobile app, /);
    const text = readerText(r).join(' ');
    expect(text).toContain(`up to ${EXCEPTION_EVIDENCE_MAX_PHOTOS} photos`);
    expect(text).toContain(`up to ${EXCEPTION_EVIDENCE_NOTE_MAX} characters`);
    expect(text).toContain('photos are not saved offline');
    expect(text).toContain('is not deleted');
    expect(text).toContain('Location and camera details are removed from each photo when it is saved.');
    expect(text).toContain('send no notifications');
    // The web sends no capture time: never promise every photo shows one.
    expect(text).toContain('a photo added on the web shows only its upload time');
  });
});

/**
 * F1-5's release (escalate an exception to maintenance) was held as a DRAFT
 * until its phone release (pnpm release:ota) and the Demo Co walk, as F1-3's
 * and F1-4's were: published with the web screens, it would have told phone
 * users about an Escalate their app did not have yet. This follow-up
 * publishes it.
 */
describe('F1-5 (escalate an exception to maintenance) is published', () => {
  const F1_5 = 'exception-escalation-2026-09';
  const release = () => RELEASES.find((r) => r.id === F1_5)!;
  /** A reader every audience includes. */
  const everyone: ReleaseViewer = {
    role: 'owner',
    permissions: [...PERMISSIONS],
    enabledModules: Object.keys(MODULE_REGISTRY) as ModuleId[],
  };
  const published = (): Release => ({ ...release(), status: 'published' });

  it('is published after the web deploy, the phone update and the Demo Co walk, so every feed carries it', () => {
    expect(release().status).toBe('published');
    expect(visibleReleases(RELEASES, everyone).map((r) => r.id)).toContain(F1_5);
    const list = buildReleaseList(RELEASES, everyone, [], null);
    expect(list.releases.map((r) => r.id)).toContain(F1_5);
    // The notice offers the newest unread release; the maintenance review
    // wording release was published after this one (and F2-1's, F2-2's, the
    // needed-by time's, the draft POs count's, Book Order Totals', the report
    // scope fix's, the small fixes' and F2-3's after it).
    expect(list.latestUnread?.id).toBe('order-fix-holding-up-2026-10');
    // An old phone build lists at most three unread releases, newest first;
    // F1-5 comes into that list once the newer releases are read.
    const newer = Object.fromEntries(
      RELEASES.slice(0, RELEASES.findIndex((r) => r.id === F1_5)).map((r) => [r.id, true]),
    );
    expect(legacyAnnouncementsFor(RELEASES, everyone, newer).map((a) => a.id)).toContain(F1_5);
    expect(registryFingerprint(RELEASES)).toContain(F1_5);
    expect(ANNOUNCEMENTS.map((a) => a.id)).toContain(F1_5);
    expect(Date.parse(release().publishedAt)).toBeLessThanOrEqual(Date.parse('2026-09-29T00:00:00Z'));
  });

  it('is dated after every release below it (releases above it were published later)', () => {
    const at = RELEASES.findIndex((r) => r.id === F1_5);
    for (const r of RELEASES.slice(0, at)) {
      expect(Date.parse(r.publishedAt), r.id).toBeGreaterThan(Date.parse(release().publishedAt));
    }
    for (const r of RELEASES.slice(at + 1)) {
      expect(Date.parse(release().publishedAt), r.id).toBeGreaterThan(Date.parse(r.publishedAt));
    }
  });

  it('is addressed as the screens gate it: the module and items:read, and the escalate entry maintenance_requests:submit', () => {
    expect(release().audience).toEqual({ anyPermission: ['items:read'], modules: ['maintenance_requests'] });
    expect(release().entries.map((e) => e.id)).toEqual([
      'exception-escalate-to-maintenance',
      'exception-escalated-badge',
      'maintenance-request-related-location',
    ]);
    const [escalate, badge, location] = release().entries;
    expect(escalate!.audience).toEqual({
      anyPermission: ['maintenance_requests:submit'],
      modules: ['maintenance_requests'],
    });
    expect(escalate!.link).toEqual({ href: '/dashboard/exceptions', label: 'Open Exceptions' });
    expect(badge!.audience).toEqual({ anyPermission: ['items:read'], modules: ['maintenance_requests'] });
    expect(badge!.link).toEqual({ href: '/dashboard/exceptions', label: 'Open Exceptions' });
    expect(location!.audience).toEqual({
      anyPermission: ['maintenance_requests:submit', 'maintenance_requests:read_all', 'maintenance_requests:manage'],
      modules: ['maintenance_requests'],
    });
    expect(location!.link).toEqual({ href: '/dashboard/maintenance', label: 'Open Maintenance' });
  });

  it('once published, it reaches only organizations with Maintenance requests on, and Escalate only people who can submit', () => {
    const reader = (permissions: ReleaseViewer['permissions'], enabledModules: ModuleId[]) =>
      visibleReleases([published()], { role: 'viewer', permissions, enabledModules })[0]?.entries.map((e) => e.id) ??
      [];
    const submitter = ['items:read', 'maintenance_requests:submit'] as ReleaseViewer['permissions'];
    expect(reader(submitter, ['maintenance_requests'])).toEqual([
      'exception-escalate-to-maintenance',
      'exception-escalated-badge',
      'maintenance-request-related-location',
    ]);
    // The module off: nothing, whatever the permissions.
    expect(reader(submitter, [])).toEqual([]);
    // Reads exceptions, cannot submit requests: told about the badge only.
    expect(reader(['items:read'], ['maintenance_requests'])).toEqual(['exception-escalated-badge']);
    // Can submit but cannot read exceptions: the Exceptions page would bounce them.
    expect(reader(['maintenance_requests:submit'], ['maintenance_requests'])).toEqual([]);
  });

  it("says the owner's decisions plainly: both platforms, nothing emailed on save, one request, online only, no photos copied", () => {
    const r = release();
    expect(r.summary).toMatch(/^On the web and in the mobile app, /);
    expect(r.summary).toContain('Nothing is emailed when you save');
    expect(r.summary).toContain('opens only if you choose it on the next screen');
    expect(r.summary).toContain('does not acknowledge or resolve the exception');
    const text = readerText(r).join(' ');
    expect(text).toContain('creates one maintenance request linked to the exception');
    expect(text).toContain('A new one can be made only if that one is cancelled');
    expect(text).toContain('needs a connection and is not saved to try later');
    expect(text).toContain('Photos on the exception are not copied');
    expect(text).toContain('you send it yourself');
    expect(text).toContain('notifies the same people as one made from the maintenance form');
    expect(text).toContain('It does not know whether an email went out');
    // Never a claim StockPilot cannot observe.
    expect(text).not.toMatch(/\bsent\b|ticket|delivered|submitted/i);
  });

  it('says the prefill names a place only when the exception is at one (item-level rules have none)', () => {
    const escalate = release().entries.find((e) => e.id === 'exception-escalate-to-maintenance')!;
    expect(escalate.whatChanged).toContain('where it is when the exception is at a location');
    expect(escalate.whatChanged).not.toMatch(/what is wrong, where, and/);
  });

  it('says every surface shows the escalation, the item and location pages included, and a cancelled request to everyone', () => {
    const badge = release().entries.find((e) => e.id === 'exception-escalated-badge')!;
    expect(badge.whatChanged).toContain("on the open exceptions of its item's and location's pages");
    expect(badge.whatChanged).toContain('If the request is cancelled, everyone who can see the exception sees that');
    expect(badge.whatChanged).toContain('can be escalated again');
  });
});

/**
 * Maintenance photos are saved without their location and camera details
 * (fix/maintenance-photo-metadata, review 2026-09-27: the owner's rule is a
 * What's New entry for every change people can see). Held as a DRAFT until the
 * web deploy and a Demo Co check; this follow-up publishes it.
 */
describe('the maintenance photo details release is published', () => {
  const ID = 'maintenance-photo-details-2026-09';
  const release = () => RELEASES.find((r) => r.id === ID)!;
  const everyone: ReleaseViewer = {
    role: 'owner',
    permissions: [...PERMISSIONS],
    enabledModules: Object.keys(MODULE_REGISTRY) as ModuleId[],
  };

  it('is published just below F1-5\'s release, so every feed carries it', () => {
    // Pinned by id, not by index: newer releases (F2-1's readiness release)
    // sit above F1-5's release.
    expect(RELEASES.findIndex((r) => r.id === ID)).toBe(
      RELEASES.findIndex((r) => r.id === 'exception-escalation-2026-09') + 1,
    );
    expect(release().status).toBe('published');
    expect(visibleReleases(RELEASES, everyone).map((r) => r.id)).toContain(ID);
    expect(buildReleaseList(RELEASES, everyone, [], null).releases.map((r) => r.id)).toContain(ID);
    // An old phone build lists at most three unread releases, newest first;
    // it comes into that list once the newer releases are read.
    const newer = Object.fromEntries(
      RELEASES.slice(0, RELEASES.findIndex((r) => r.id === ID)).map((r) => [r.id, true]),
    );
    expect(legacyAnnouncementsFor(RELEASES, everyone, newer).map((a) => a.id)).toContain(ID);
    expect(registryFingerprint(RELEASES)).toContain(ID);
  });

  it('once published, it reaches the people Maintenance is open to, and nobody where the module is off', () => {
    const published: Release = { ...release(), status: 'published' };
    const requester: ReleaseViewer = {
      role: 'staff',
      permissions: ['maintenance_requests:submit'],
      enabledModules: ['maintenance_requests'],
    };
    expect(visibleReleases([published], requester).map((r) => r.id)).toEqual([ID]);
    expect(visibleReleases([published], { ...requester, enabledModules: [] })).toEqual([]);
    expect(visibleReleases([published], { ...requester, permissions: ['items:read'] })).toEqual([]);
  });

  it('says what the server does and what it does not: every app, older photos unchanged, the 50 megapixel limit', () => {
    const text = readerText(release()).join(' ');
    expect(release().summary).toMatch(/^On the web and in the mobile app, /);
    expect(text).toContain('Photos added before this change are not changed.');
    expect(text).toContain('whichever app or browser sent it');
    expect(text).toContain('more than 50 megapixels is now refused');
  });
});

/**
 * F2-1's release (order readiness) was held as a DRAFT until its phone release
 * (pnpm release:ota: the phone's summary, line cards and the same Approve
 * partial / Resume gates) and the Demo Co walk, as F1-3's, F1-4's and F1-5's
 * were. This follow-up publishes it.
 */
describe('F2-1 (order readiness) is published', () => {
  const F2_1 = 'order-readiness-2026-09';
  const release = () => RELEASES.find((r) => r.id === F2_1)!;
  const everyone: ReleaseViewer = {
    role: 'owner',
    permissions: [...PERMISSIONS],
    enabledModules: Object.keys(MODULE_REGISTRY) as ModuleId[],
  };
  const published = (): Release => ({ ...release(), status: 'published' });

  it('is published after the web deploy, the phone update and the Demo Co walk, so every feed carries it', () => {
    expect(release().status).toBe('published');
    expect(visibleReleases(RELEASES, everyone).map((r) => r.id)).toContain(F2_1);
    const list = buildReleaseList(RELEASES, everyone, [], null);
    expect(list.releases.map((r) => r.id)).toContain(F2_1);
    // The notice offers the newest unread release; the maintenance review
    // wording, F2-2's, the needed-by time's, the draft POs count's, Book Order
    // Totals', the report scope fix's, the small fixes' and F2-3's releases
    // were published after this one.
    expect(list.latestUnread?.id).toBe('order-fix-holding-up-2026-10');
    // An old phone build lists at most three unread releases, newest first;
    // F2-1 comes into that list once the newer releases are read.
    const newer = Object.fromEntries(
      RELEASES.slice(0, RELEASES.findIndex((r) => r.id === F2_1)).map((r) => [r.id, true]),
    );
    expect(legacyAnnouncementsFor(RELEASES, everyone, newer).map((a) => a.id)).toContain(F2_1);
    expect(registryFingerprint(RELEASES)).toContain(F2_1);
    expect(ANNOUNCEMENTS.map((a) => a.id)).toContain(F2_1);
    expect(Date.parse(release().publishedAt)).toBeLessThanOrEqual(Date.parse('2026-09-29T00:00:00Z'));
  });

  it('is dated after every release below it (the releases above it were published later)', () => {
    const at = RELEASES.findIndex((r) => r.id === F2_1);
    expect(at).toBeGreaterThanOrEqual(0);
    for (const r of RELEASES.slice(0, at)) {
      expect(Date.parse(r.publishedAt), r.id).toBeGreaterThan(Date.parse(release().publishedAt));
    }
    for (const r of RELEASES.slice(at + 1)) {
      expect(Date.parse(release().publishedAt), r.id).toBeGreaterThan(Date.parse(r.publishedAt));
    }
  });

  it('is addressed as the order page shows it: the full panel, the one sentence, the gates, the pick message and the hidden-item label', () => {
    expect(release().audience).toEqual({ modules: ['orders'] });
    expect(release().entries.map((e) => e.id)).toEqual([
      'order-readiness-lines',
      'order-readiness-holds-and-records',
      'order-readiness-requester',
      'order-stock-actions-say-why',
      'order-pick-staging-message',
      'order-line-hidden-item-name',
    ]);
    const [lines, holds, requester, gates, pick] = release().entries;
    // core readinessAudience: approvers, pickers and buyers see the full panel.
    for (const full of [lines!, holds!]) {
      expect(full.audience, full.id).toEqual({
        anyPermission: ['orders:approve', 'items:update', 'purchase_orders:manage'],
        modules: ['orders'],
      });
    }
    expect(requester!.audience).toEqual({ anyPermission: ['orders:request'], modules: ['orders'] });
    expect(gates!.audience).toEqual({ anyPermission: ['orders:approve'], modules: ['orders'] });
    expect(pick!.audience).toEqual({ anyPermission: ['items:update', 'orders:approve'], modules: ['orders'] });
    for (const e of release().entries) {
      expect(e.area, e.id).toBe('Orders');
      expect(e.link, e.id).toEqual({ href: '/dashboard/orders', label: 'View orders' });
    }
  });

  it('once published, each reader is told about what their order page shows them, and nobody where Orders is off', () => {
    const reader = (permissions: ReleaseViewer['permissions'], enabledModules: ModuleId[] = ['orders']) =>
      visibleReleases([published()], { role: 'viewer', permissions, enabledModules })[0]?.entries.map((e) => e.id) ??
      [];
    // The hidden-item label can meet anyone who opens an order.
    expect(reader(['orders:request'])).toEqual(['order-readiness-requester', 'order-line-hidden-item-name']);
    expect(reader(['items:update'])).toEqual([
      'order-readiness-lines',
      'order-readiness-holds-and-records',
      'order-pick-staging-message',
      'order-line-hidden-item-name',
    ]);
    expect(reader(['purchase_orders:manage'])).toEqual([
      'order-readiness-lines',
      'order-readiness-holds-and-records',
      'order-line-hidden-item-name',
    ]);
    expect(reader(['orders:request', 'orders:approve'])).toEqual([
      'order-readiness-lines',
      'order-readiness-holds-and-records',
      'order-readiness-requester',
      'order-stock-actions-say-why',
      'order-pick-staging-message',
      'order-line-hidden-item-name',
    ]);
    expect(reader(['orders:request', 'orders:approve', 'items:update'], [])).toEqual([]);
  });

  it('says it plainly and honestly: both platforms, on record never "book", no percentages, a PO date is expected', () => {
    const r = release();
    expect(r.summary).toMatch(/^On the web and in the mobile app, /);
    const text = readerText(r).join(' ');
    expect(text).not.toMatch(/\bbook\b/i);
    expect(text).not.toContain('%');
    expect(text).not.toMatch(/verified|guarantee|will arrive|on track/i);
    // Every mention of a date on a purchase order says it is not a promise.
    expect(text).toContain("A purchase order's date is an expected date, not a promise");
    expect(text).toContain('stock on record');
    // The labels people see, in core's words.
    for (const label of ['Ready to pick', 'Needs put-away', 'Waiting on a PO', 'Short', "Can't confirm", 'Handed over']) {
      expect(text, label).toContain(label);
    }
    // "Ready" for the order only under the rule core applies (handed-over
    // lines have nothing to pick and are not counted).
    expect(text).toContain(
      'Ready to pick is shown for the order only when every line still to be picked is ready and every number could be read',
    );
    // A failure is said, never shown as an answer; nothing is written.
    expect(r.summary).toContain("If readiness can't be checked, the order says so rather than showing an answer.");
    expect(text).toContain('Nothing on the order changes when readiness is shown.');
    // The requester's sentences, word for word as core writes them.
    expect(text).toContain('All items are in stock');
    expect(text).toContain('Some items are waiting on stock');
    expect(text).toContain("We're checking stock for some items");
    expect(text).toContain("Stock couldn't be checked just now");
  });

  it('says nothing that is false for some of its readers (review 2026-09-28)', () => {
    const text = readerText(release()).join(' ');
    // The phone offers Approve and Resume to managers only; the web by
    // permission. "The same actions for the same order" is false for a staff
    // member with an orders:approve override, so it is not claimed.
    expect(text).not.toMatch(/same actions/i);
    // A records-disagree line that is also short shows Short; one that owes
    // nothing shows Handed over. It is the sentence that says they differ.
    expect(text).not.toMatch(/says Can't confirm and gives both numbers/);
    expect(text).toContain("says the numbers don't match and gives both");
    // The requester sees a sentence, when it was checked and a button.
    expect(text).not.toMatch(/see one sentence/i);
    expect(release().summary).toContain('People who placed an order see a short summary of its stock instead.');
    // The note under Approve is not "short" (the strip's word for a
    // different count), and the pick message claims no Staging it cannot know.
    expect(text).not.toMatch(/how many lines are short/);
    expect(text).toContain('how many lines ask for more than is available now');
    expect(text).not.toMatch(/because part of an item is still in Staging/);
    expect(text).toContain("count the item if its locations don't match its stock on record");
  });

  // F2-1 local walks (web O-5, phone O4): a line whose item the reader cannot
  // read said "Deleted item" on the web and "Unknown item" on the phone, on
  // main too. Both now say core's ORDER_LINE_HIDDEN_ITEM_NAME: a fix people
  // can see, so it is announced (owner rule, 2026-09-25).
  it("announces the honest label for an item the reader can't see, on both platforms, in core's words", () => {
    const e = release().entries.find((x) => x.id === 'order-line-hidden-item-name');
    expect(e).toBeDefined();
    expect(e!.category).toBe('fixed');
    // Anyone who opens orders can meet it (a warehouse- or category-scoped
    // reader, or a requester with no warehouse yet).
    expect(e!.audience).toEqual({ modules: ['orders'] });
    expect(e!.whatChanged).toContain(ORDER_LINE_HIDDEN_ITEM_NAME);
    expect(e!.whatChanged).toContain('Deleted item on the web');
    expect(e!.whatChanged).toContain('Unknown item in the mobile app');
    // Never "deleted": a line's item cannot be deleted (ON DELETE RESTRICT).
    expect(e!.whyItMatters).toContain("items on an order can't be deleted");
    expect(e!.howItAffectsYou).toContain('Only the label changed.');
    expect(e!.whatToDo).toBe('No action needed.');
  });
});

/**
 * The maintenance review screen's wording (owner-approved, 2026-09-28). The
 * web's review screen said "Outlook will open with the email details filled
 * in", which read as if Outlook opened by itself; it opens only on Open in
 * Outlook. The sentence is web only and live with the web deploy, so the
 * release is published in the same change.
 */
describe('the maintenance review wording release is published', () => {
  const ID = 'maintenance-review-wording-2026-09';
  const release = () => RELEASES.find((r) => r.id === ID)!;
  const everyone: ReleaseViewer = {
    role: 'owner',
    permissions: [...PERMISSIONS],
    enabledModules: Object.keys(MODULE_REGISTRY) as ModuleId[],
  };
  /** The sentence the web's review screen shows when the maintenance email is set up. */
  const SENTENCE =
    'Your request has been saved in StockPilot. When you choose Open in Outlook, it opens with the email details filled in; nothing is sent until you send it.';

  it('is published, dated after every release below it (releases above it were published later)', () => {
    expect(release().status).toBe('published');
    expect(release().revision).toBe(1);
    const at = RELEASES.findIndex((r) => r.id === ID);
    for (const r of RELEASES.slice(0, at)) {
      expect(Date.parse(r.publishedAt), r.id).toBeGreaterThan(Date.parse(release().publishedAt));
    }
    for (const r of RELEASES.slice(at + 1)) {
      expect(Date.parse(release().publishedAt), r.id).toBeGreaterThan(Date.parse(r.publishedAt));
    }
    const list = buildReleaseList(RELEASES, everyone, [], null);
    expect(list.releases.map((r) => r.id)).toContain(ID);
    // An old phone build lists at most three unread releases, newest first;
    // this one comes into that list once the newer releases are read.
    const newer = Object.fromEntries(RELEASES.slice(0, at).map((r) => [r.id, true]));
    expect(legacyAnnouncementsFor(RELEASES, everyone, newer).map((a) => a.id)).toContain(ID);
    expect(registryFingerprint(RELEASES)).toContain(ID);
    expect(ANNOUNCEMENTS.map((a) => a.id)).toContain(ID);
    expect(Date.parse(release().publishedAt)).toBeLessThanOrEqual(Date.parse('2026-09-29T00:00:00Z'));
  });

  it('is addressed as the review screen is reached: Maintenance requests on, and maintenance_requests:submit', () => {
    const gate = { anyPermission: ['maintenance_requests:submit'], modules: ['maintenance_requests'] };
    expect(release().audience).toEqual(gate);
    expect(release().entries.map((e) => e.id)).toEqual(['maintenance-review-wording']);
    const [entry] = release().entries;
    expect(entry!.category).toBe('improved');
    expect(entry!.area).toBe('Maintenance');
    expect(entry!.audience).toEqual(gate);
    expect(entry!.link).toEqual({ href: '/dashboard/maintenance/new', label: 'New maintenance request' });
    const reader = (permissions: ReleaseViewer['permissions'], enabledModules: ModuleId[]) =>
      visibleReleases([release()], { role: 'staff', permissions, enabledModules }).map((r) => r.id);
    expect(reader(['maintenance_requests:submit'], ['maintenance_requests'])).toEqual([ID]);
    expect(reader(['maintenance_requests:submit'], [])).toEqual([]);
    expect(reader(['maintenance_requests:read_all', 'maintenance_requests:manage'], ['maintenance_requests'])).toEqual(
      [],
    );
  });

  // Mutation caught: the screen's sentence edited and the release left
  // quoting the old one, or the release quoting words the screen never shows.
  it('quotes the sentence the web review screen shows, word for word', () => {
    const screen = readFileSync(
      resolve(__dirname, '../../components/maintenance/maintenance-review.tsx'),
      'utf8',
    );
    expect(screen).toContain(`'${SENTENCE}'`);
    expect(screen).not.toContain('Outlook will open');
    expect(release().entries[0]!.whatChanged).toContain(`"${SENTENCE}"`);
  });

  it('says it plainly: web only, Outlook opens only when chosen, nothing sent until you send it, only the wording changed', () => {
    const r = release();
    expect(r.summary).toMatch(/^On the web, /);
    expect(r.summary).toContain('Outlook opens only when you choose Open in Outlook');
    expect(r.summary).toContain('nothing is sent until you send it');
    const text = readerText(r).join(' ');
    expect(text).toContain('Only the wording changed.');
    expect(text).toContain('Saving a request does not open Outlook');
    expect(text).not.toMatch(/mobile app|phone/i);
    expect(text).not.toMatch(/email sent|emailed|automatically sent/i);
    expect(r.entries[0]!.whatToDo).toBe('No action needed.');
  });
});

/**
 * F2-2's release (held, and caught before it leaves) was held as a DRAFT until
 * its phone release (pnpm release:ota: the digital pick confirm, the
 * departure confirms, the short-line fixes and the hold notices) and the Demo
 * Co walk, as F2-1's was. This follow-up publishes it.
 */
describe('F2-2 (held, and caught before it leaves) is published', () => {
  const F2_2 = 'order-held-and-caught-2026-10';
  const release = () => RELEASES.find((r) => r.id === F2_2)!;
  const everyone: ReleaseViewer = {
    role: 'owner',
    permissions: [...PERMISSIONS],
    enabledModules: Object.keys(MODULE_REGISTRY) as ModuleId[],
  };
  const published = (): Release => ({ ...release(), status: 'published' });

  it('is published after the web deploy, the phone update and the Demo Co walk, so every feed carries it', () => {
    expect(release()).toBeDefined();
    expect(release().status).toBe('published');
    expect(visibleReleases(RELEASES, everyone).map((r) => r.id)).toContain(F2_2);
    const list = buildReleaseList(RELEASES, everyone, [], null);
    expect(list.releases.map((r) => r.id)).toContain(F2_2);
    // The notice offers the newest unread release: the needed-by time's, the
    // draft POs count's, Book Order Totals', the report scope fix's, the small
    // fixes' and F2-3's releases were published after this one.
    expect(list.latestUnread?.id).toBe('order-fix-holding-up-2026-10');
    // An old phone build lists at most three unread releases, newest first;
    // F2-2 comes into that list once the newer releases are read.
    const newer = Object.fromEntries(
      RELEASES.slice(0, RELEASES.findIndex((r) => r.id === F2_2)).map((r) => [r.id, true]),
    );
    expect(legacyAnnouncementsFor(RELEASES, everyone, newer).map((a) => a.id)).toContain(F2_2);
    expect(registryFingerprint(RELEASES)).toContain(F2_2);
    expect(ANNOUNCEMENTS.map((a) => a.id)).toContain(F2_2);
    expect(Date.parse(release().publishedAt)).toBeLessThanOrEqual(Date.parse('2026-09-29T00:00:00Z'));
  });

  it('is dated after every release below it (the releases above it were published later)', () => {
    const at = RELEASES.findIndex((r) => r.id === F2_2);
    expect(at).toBeGreaterThanOrEqual(0);
    for (const r of RELEASES.slice(0, at)) {
      expect(Date.parse(r.publishedAt), r.id).toBeGreaterThan(Date.parse(release().publishedAt));
    }
    for (const r of RELEASES.slice(at + 1)) {
      expect(Date.parse(release().publishedAt), r.id).toBeGreaterThan(Date.parse(r.publishedAt));
    }
  });

  it("carries the plan's two entries, addressed as the screens show them", () => {
    expect(release().audience).toEqual({ modules: ['orders'] });
    expect(release().entries.map((e) => [e.id, e.title])).toEqual([
      ['order-short-lines-caught', 'Short lines are caught before an order leaves'],
      ['order-added-items-held', 'Items added to an approved order are now held'],
    ]);
    const [caught, held] = release().entries;
    // The confirms: whoever completes, stages, sends out or signs for an
    // order; the line fixes also on a requester's own order after picking.
    expect(caught!.audience).toEqual({
      anyPermission: ['items:update', 'orders:approve', 'orders:request'],
      modules: ['orders'],
    });
    // Holds: approvers hold; everyone who places orders sees less available.
    expect(held!.audience).toEqual({ anyPermission: ['orders:approve', 'orders:request'], modules: ['orders'] });
    for (const e of release().entries) {
      expect(e.area, e.id).toBe('Orders');
      expect(e.link, e.id).toEqual({ href: '/dashboard/orders', label: 'View orders' });
    }
  });

  it('once published, each reader is told what their screens show them, and nobody where Orders is off', () => {
    const reader = (permissions: ReleaseViewer['permissions'], enabledModules: ModuleId[] = ['orders']) =>
      visibleReleases([published()], { role: 'viewer', permissions, enabledModules })[0]?.entries.map((e) => e.id) ??
      [];
    expect(reader(['items:update'])).toEqual(['order-short-lines-caught']);
    expect(reader(['orders:request'])).toEqual(['order-short-lines-caught', 'order-added-items-held']);
    expect(reader(['orders:approve'])).toEqual(['order-short-lines-caught', 'order-added-items-held']);
    expect(reader(['items:read'])).toEqual([]);
    expect(reader(['orders:approve', 'items:update', 'orders:request'], [])).toEqual([]);
  });

  it('states the behaviour change: added items are held, so less shows as available', () => {
    const r = release();
    expect(r.summary).toMatch(/^On the web and in the mobile app, /);
    expect(r.summary).toContain('the storefront and other orders show fewer of those items available');
    // The top-up holds the whole order, not just the new units (review
    // 2026-09-28): the summary says so too, since availability drops for the
    // order's earlier unheld items as well.
    expect(r.summary).toContain('the new units, and anything else on it not yet held, as far as there is free stock');
    expect(r.summary).not.toMatch(/the new units are now held for the order/);
    const held = r.entries.find((e) => e.id === 'order-added-items-held')!;
    expect(held.howItAffectsYou).toMatch(/^This changes what is shown as available/);
    // Only an approver's add holds anything; a requester's line waits.
    expect(held.whatChanged).toContain('When someone who can approve orders adds items');
    expect(held.howItAffectsYou).toContain("A line added or raised by someone who can't approve orders is not held until someone who can holds it");
    // "Not held" is shown on the full readiness panel, so it is worded for
    // approvers; a requester (orders:request reads this entry) sees one
    // sentence about the order's stock, not the line's hold.
    expect(held.howItAffectsYou).toContain('On the order, people who can approve orders see such a line as Not held.');
    expect(held.howItAffectsYou).not.toMatch(/orders says Not held/);
    // A hold tops up the whole order (hold_order_stock), so an approver's add
    // or raise also holds what a requester added before (the F2-2 local e2e
    // saw it): said, not left for the reader to discover.
    expect(held.whatChanged).toContain('along with anything else on the order not yet held');
    expect(held.howItAffectsYou).toContain('with Hold available stock, or by adding or raising a line on that order');
    // Holding is a commitment: it moves nothing and never refuses an add.
    expect(held.howItAffectsYou).toContain('Holding never moves stock');
    expect(held.howItAffectsYou).toContain('never stops an item being added');
  });

  // Review 2026-09-28: the draft promised every reader the line fixes. They
  // are offered to people who can change the order's lines (before picking,
  // approvers, who see the numbers; after picking, approvers and the order's
  // own requester), on lines stock does not cover now (waiting on a PO
  // included); the digital pick's Review goes to the line's count; and a
  // packing slip scanned on the phone asks too.
  it('claims no more about the fixes than each reader gets', () => {
    const caught = release().entries.find((e) => e.id === 'order-short-lines-caught')!;
    expect(caught.howItAffectsYou).toContain(
      "In the digital pick, Review short lines puts you on the short line's count, to check what was entered.",
    );
    expect(caught.howItAffectsYou).toContain(
      'If you can approve orders, a line that stock does not cover now, including one waiting on a PO, offers Lower to what stock covers or Remove line',
    );
    expect(caught.howItAffectsYou).toContain(
      'after picking, a line not fully picked offers Lower to what was picked or Remove from order, if you can approve orders or it is your own order',
    );
    expect(caught.howItAffectsYou).not.toMatch(/takes you to the first short line, which offers/);
    expect(caught.whatChanged).toContain('from the order or from a packing slip scanned in the mobile app');
    // The summary (all an old phone shows) promises no fix to everyone.
    expect(release().summary).not.toMatch(/the fix is on the line/);
  });

  it("says it in core's words, honestly: on record never \"book\", no percentages, nothing guaranteed", () => {
    const text = readerText(release()).join(' ');
    expect(text).not.toMatch(/\bbook\b/i);
    expect(text).not.toContain('%');
    expect(text).not.toMatch(/verified|guarantee|will arrive|reserved for sure/i);
    // The buttons and the sentence the screens show, from core.
    for (const label of [
      HOLD_AVAILABLE_STOCK_LABEL,
      COMPLETION_REVIEW_LABEL,
      'Fix the order',
      'Remove line',
      'Lower to what was picked',
      'Remove from order',
      'Not held',
      'Held 20 of 40',
    ]) {
      expect(text, label).toContain(label);
    }
    expect(COMPLETION_CONFIRM_LABEL).toBe('Complete picking');
    const so100 = describeShortPickLines([{ itemName: 'L4L - Pen Black & Rose Gold', batch: 0, owed: 60 }])!;
    expect(text).toContain(so100.slice(0, so100.indexOf(' It will be owed')));
    // The server stays permissive: a confirm, never a refusal.
    expect(text).toContain('You can still go ahead: what was not picked is owed at hand-over, as before.');
  });
});

/**
 * The needed-by time and the digital pick's blank field (F2-1 and F2-2
 * production walks, 2026-09-28): web only, so published with the web deploy.
 */
describe('the needed-by time release is published', () => {
  const ID = 'order-needed-by-org-zone-2026-09';
  const release = () => RELEASES.find((r) => r.id === ID)!;
  const everyone: ReleaseViewer = {
    role: 'owner',
    permissions: [...PERMISSIONS],
    enabledModules: Object.keys(MODULE_REGISTRY) as ModuleId[],
  };

  it('is published, dated after every release below it (releases above it were published later)', () => {
    expect(release().status).toBe('published');
    expect(release().revision).toBe(1);
    const at = RELEASES.findIndex((r) => r.id === ID);
    for (const r of RELEASES.slice(0, at)) {
      expect(Date.parse(r.publishedAt), r.id).toBeGreaterThan(Date.parse(release().publishedAt));
    }
    for (const r of RELEASES.slice(at + 1)) {
      expect(Date.parse(release().publishedAt), r.id).toBeGreaterThan(Date.parse(r.publishedAt));
    }
    const list = buildReleaseList(RELEASES, everyone, [], null);
    expect(list.releases.map((r) => r.id)).toContain(ID);
    // An old phone build lists at most three unread releases, newest first;
    // this one comes into that list once the newer releases are read.
    const newer = Object.fromEntries(RELEASES.slice(0, at).map((r) => [r.id, true]));
    expect(legacyAnnouncementsFor(RELEASES, everyone, newer).map((a) => a.id)).toContain(ID);
    expect(registryFingerprint(RELEASES)).toContain(ID);
    expect(ANNOUNCEMENTS.map((a) => a.id)).toContain(ID);
  });

  it('reaches every member where Orders is on; the digital pick entry only whoever can pick', () => {
    expect(release().audience).toEqual({ modules: ['orders'] });
    expect(release().entries.map((e) => e.id)).toEqual(['order-needed-by-org-zone', 'digital-pick-blank-quantity']);
    const reader = (permissions: ReleaseViewer['permissions'], enabledModules: ModuleId[] = ['orders']) =>
      visibleReleases([release()], { role: 'viewer', permissions, enabledModules })[0]?.entries.map((e) => e.id) ?? [];
    expect(reader(['items:read'])).toEqual(['order-needed-by-org-zone']);
    expect(reader([])).toEqual(['order-needed-by-org-zone']);
    expect(reader(['items:update'])).toEqual(['order-needed-by-org-zone', 'digital-pick-blank-quantity']);
    expect(reader(['orders:approve'])).toEqual(['order-needed-by-org-zone', 'digital-pick-blank-quantity']);
    expect(reader(['orders:approve', 'items:update'], [])).toEqual([]);
  });

  it('says it plainly: web only, the example the walk saw, only how it is shown changed', () => {
    const r = release();
    // Old phone builds show only the summary: it names the platform.
    expect(r.summary).toMatch(/^On the web, /);
    expect(r.summary).toContain('an order due at 2:00 PM in a Los Angeles organization said 9:00 PM');
    const text = readerText(r).join(' ');
    expect(text).not.toMatch(/mobile app|phone/i);
    expect(text).toContain('Only how the time is shown changed.');
    expect(text).toContain('Only how the field looks changed.');
    // The digital pick field's placeholder and the words beside it, as the screen shows them.
    const pick = readFileSync(resolve(__dirname, '../../components/orders/digital-pick.tsx'), 'utf8');
    expect(pick).toContain('placeholder="Qty"');
    expect(pick).toContain('of {requested}');
    for (const e of r.entries) expect(e.whatToDo, e.id).toBe('No action needed.');
  });
});

/**
 * The draft POs count is core's copy (web and phone), so its release was held
 * as a DRAFT until the phone update carried it (OTA group 46e8f566). This
 * follow-up publishes it.
 */
describe('the draft POs count release is published', () => {
  const ID = 'order-readiness-draft-pos-2026-09';
  const release = () => RELEASES.find((r) => r.id === ID)!;
  const everyone: ReleaseViewer = {
    role: 'owner',
    permissions: [...PERMISSIONS],
    enabledModules: Object.keys(MODULE_REGISTRY) as ModuleId[],
  };

  it('is published after the phone update, so every feed carries it, dated between the needed-by release and Book Order Totals', () => {
    expect(release().status).toBe('published');
    expect(visibleReleases(RELEASES, everyone).map((r) => r.id)).toContain(ID);
    const list = buildReleaseList(RELEASES, everyone, [], null);
    expect(list.releases.map((r) => r.id)).toContain(ID);
    const at = RELEASES.findIndex((r) => r.id === ID);
    // An old phone build lists at most three unread releases, newest first;
    // this one comes into that list once the newer releases are read.
    const newer = Object.fromEntries(RELEASES.slice(0, at).map((r) => [r.id, true]));
    expect(legacyAnnouncementsFor(RELEASES, everyone, newer).map((a) => a.id)).toContain(ID);
    expect(registryFingerprint(RELEASES)).toContain(ID);
    expect(ANNOUNCEMENTS.map((a) => a.id)).toContain(ID);
    for (const r of RELEASES.slice(0, at)) {
      expect(Date.parse(r.publishedAt), r.id).toBeGreaterThan(Date.parse(release().publishedAt));
    }
    for (const r of RELEASES.slice(at + 1)) {
      expect(Date.parse(release().publishedAt), r.id).toBeGreaterThan(Date.parse(r.publishedAt));
    }
    expect(Date.parse(release().publishedAt)).toBeLessThanOrEqual(Date.parse('2026-09-30T00:00:00Z'));
  });

  it('is addressed as the full readiness panel is, and quotes the words core composes', () => {
    const gate = { anyPermission: ['orders:approve', 'items:update', 'purchase_orders:manage'], modules: ['orders'] };
    expect(release().entries.map((e) => e.audience)).toEqual([gate]);
    const text = readerText(release()).join(' ');
    expect(release().summary).toMatch(/^On the web and in the mobile app, /);
    expect(text).toContain('On 4 draft POs 100 (not ordered)');
    expect(text).toContain('4 draft POs cover 60 but have not been ordered');
    expect(text).not.toMatch(/\bbook\b/i);
  });
});

/**
 * Book Order Totals' release was held as a DRAFT until its phone release (OTA
 * group 46e8f566: the phone's Book Order Totals screens) and the Demo Co
 * production walk, as F1-3's, F1-4's, F1-5's and F2-1's were. Pinned by id,
 * never by index. This follow-up publishes it.
 */
describe('Book Order Totals is published', () => {
  const ID = 'book-order-totals-2026-09';
  const release = () => RELEASES.find((r) => r.id === ID)!;
  const everyone: ReleaseViewer = {
    role: 'owner',
    permissions: [...PERMISSIONS],
    enabledModules: Object.keys(MODULE_REGISTRY) as ModuleId[],
  };
  const published = (): Release => ({ ...release(), status: 'published' });

  it('is published after the web deploy, the phone update and the Demo Co walk, so every feed carries it', () => {
    expect(release().status).toBe('published');
    expect(visibleReleases(RELEASES, everyone).map((r) => r.id)).toContain(ID);
    const list = buildReleaseList(RELEASES, everyone, [], null);
    expect(list.releases.map((r) => r.id)).toContain(ID);
    // The notice offers the newest unread release; the report scope fix's,
    // the small fixes' and F2-3's releases were published after this one.
    expect(list.latestUnread?.id).toBe('order-fix-holding-up-2026-10');
    // An old phone build lists at most three unread releases, newest first;
    // this one comes into that list once the newer releases are read.
    const newer = Object.fromEntries(
      RELEASES.slice(0, RELEASES.findIndex((r) => r.id === ID)).map((r) => [r.id, true]),
    );
    expect(legacyAnnouncementsFor(RELEASES, everyone, newer).map((a) => a.id)).toContain(ID);
    expect(registryFingerprint(RELEASES)).toContain(ID);
    expect(ANNOUNCEMENTS.map((a) => a.id)).toContain(ID);
    expect(Date.parse(release().publishedAt)).toBeLessThanOrEqual(Date.parse('2026-09-30T00:00:00Z'));
  });

  it('is dated after every release below it (pinned by id); releases above it were published later', () => {
    const at = RELEASES.findIndex((r) => r.id === ID);
    expect(at).toBeGreaterThanOrEqual(0);
    for (const r of RELEASES.slice(0, at)) {
      expect(Date.parse(r.publishedAt), r.id).toBeGreaterThan(Date.parse(release().publishedAt));
    }
    for (const r of RELEASES.slice(at + 1)) {
      expect(Date.parse(release().publishedAt), r.id).toBeGreaterThan(Date.parse(r.publishedAt));
    }
  });

  it('is addressed as the report is reached: Orders on, then Books on with reports:read, the permission the linked page checks (both entries)', () => {
    expect(release().audience).toEqual({ modules: ['orders'] });
    expect(release().entries.map((e) => e.id)).toEqual([
      'book-order-totals-report',
      'book-order-totals-files',
    ]);
    const [report, files] = release().entries;
    expect(report!.audience).toEqual({ anyPermission: ['reports:read'], modules: ['books'] });
    // The files entry links to the page, which redirects anyone without
    // reports:read, so it is addressed by reports:read too (never by
    // reports:export alone, which would tell an export-only override about a
    // page that bounces them); its text says the buttons need export access.
    expect(files!.audience).toEqual({ anyPermission: ['reports:read'], modules: ['books'] });
    expect(files!.howItAffectsYou).toContain(
      'Only people who can export reports see the download buttons.',
    );
    for (const e of release().entries) {
      expect(e.area, e.id).toBe('Reports');
      expect(e.link, e.id).toEqual({
        href: '/dashboard/reports/book-order-totals',
        label: 'Book Order Totals',
      });
    }
    const reader = (permissions: ReleaseViewer['permissions'], enabledModules: ModuleId[]) =>
      visibleReleases([published()], { role: 'viewer', permissions, enabledModules })[0]?.entries.map(
        (e) => e.id,
      ) ?? [];
    expect(reader(['reports:read'], ['orders', 'books'])).toEqual([
      'book-order-totals-report',
      'book-order-totals-files',
    ]);
    expect(reader(['reports:read', 'reports:export'], ['orders', 'books'])).toEqual([
      'book-order-totals-report',
      'book-order-totals-files',
    ]);
    // An export-only override cannot open the page (it redirects without
    // reports:read), so nothing is announced to it.
    expect(reader(['reports:export'], ['orders', 'books'])).toEqual([]);
    expect(reader(['reports:read', 'reports:export'], ['orders'])).toEqual([]);
    expect(reader(['reports:read', 'reports:export'], ['books'])).toEqual([]);
    expect(reader(['orders:request'], ['orders', 'books'])).toEqual([]);
  });

  it('says copies requested, never purchased, stock or delivered, and never "unique titles"', () => {
    const text = readerText(release()).join(' ');
    expect(text).toContain('Total books ordered (copies requested through Orders)');
    expect(text).toContain('Distinct book entries');
    expect(text).toContain('not copies purchased, handed over or in stock');
    expect(text).toContain('a file is never cut short');
    expect(text).toContain('on an Android phone, export from the web for now');
    expect(text).not.toMatch(/\bunique titles?\b|\bdelivered\b|\bsnapshot\b|\bthe book\b|%/i);
  });
});

/**
 * The report scope fix (0380, fix/reports-scope): web only, so published with
 * the web deploy after the migration. Addressed by reports:read, the
 * permission every report page checks (reportPageGate).
 */
describe('the report scope release is published', () => {
  const ID = 'reports-caller-scope-2026-09';
  const release = () => RELEASES.find((r) => r.id === ID)!;
  const everyone: ReleaseViewer = {
    role: 'owner',
    permissions: [...PERMISSIONS],
    enabledModules: Object.keys(MODULE_REGISTRY) as ModuleId[],
  };

  it('is published, dated after every release below it (releases above it were published later)', () => {
    expect(release().status).toBe('published');
    expect(release().revision).toBe(1);
    const at = RELEASES.findIndex((r) => r.id === ID);
    for (const r of RELEASES.slice(0, at)) {
      expect(Date.parse(r.publishedAt), r.id).toBeGreaterThan(Date.parse(release().publishedAt));
    }
    for (const r of RELEASES.slice(at + 1)) {
      expect(Date.parse(release().publishedAt), r.id).toBeGreaterThan(Date.parse(r.publishedAt));
    }
    const list = buildReleaseList(RELEASES, everyone, [], null);
    expect(list.releases.map((r) => r.id)).toContain(ID);
    // The notice offers the newest unread release: the small fixes' and
    // F2-3's releases were published after this one.
    expect(list.latestUnread?.id).toBe('order-fix-holding-up-2026-10');
    // An old phone build lists at most three unread releases, newest first;
    // this one comes into that list once the newer releases are read.
    const newer = Object.fromEntries(RELEASES.slice(0, at).map((r) => [r.id, true]));
    expect(legacyAnnouncementsFor(RELEASES, everyone, newer).map((a) => a.id)).toContain(ID);
    expect(registryFingerprint(RELEASES)).toContain(ID);
    expect(ANNOUNCEMENTS.map((a) => a.id)).toContain(ID);
    expect(Date.parse(release().publishedAt)).toBeLessThanOrEqual(Date.parse('2026-09-30T00:00:00Z'));
  });

  it('reaches only report readers, as every report page checks reports:read', () => {
    expect(release().audience).toEqual({ anyPermission: ['reports:read'] });
    expect(release().entries.map((e) => e.audience)).toEqual([{ anyPermission: ['reports:read'] }]);
    expect(release().entries[0]!.link).toEqual({ href: '/dashboard/reports', label: 'Reports' });
    const reader = (permissions: ReleaseViewer['permissions']) =>
      visibleReleases([release()], { role: 'viewer', permissions, enabledModules: [] })[0]?.entries.map((e) => e.id) ?? [];
    expect(reader(['reports:read'])).toEqual(['reports-caller-scope']);
    expect(reader(['reports:export'])).toEqual([]);
    expect(reader(['items:read'])).toEqual([]);
  });

  it('says it plainly: web only, unchanged for readers who see everything, no promise it cannot keep', () => {
    const r = release();
    // Old phone builds show only the summary: it names the platform.
    expect(r.summary).toMatch(/^On the web, /);
    const text = readerText(r).join(' ');
    expect(text).toContain('your figures are unchanged');
    expect(text).not.toMatch(/mobile app|phone|%|\bbook\b/i);
    // Bundle runs and kits stay organization-wide (bundle_distributions is
    // member-wide), so the text claims only value and warehouse names there.
    expect(text).toContain('Bundle activity shows component value and warehouse names for the warehouses you can see.');
    for (const e of r.entries) expect(e.whatToDo, e.id).toBe('No action needed.');
  });
});

/**
 * F2-3's release (fix what's holding an order up: put away from the order, and
 * the approve-partial / resume preview) was held as a DRAFT until the web
 * screens, the phone update (OTA group 83d6a10f) and the Demo Co production
 * walk (SO-17 put-away, SO-21 approve partial), as F2-1's and F2-2's were.
 * Pinned by id, never by index. This follow-up publishes it.
 */
describe("F2-3 (fix what's holding an order up) is published", () => {
  const ID = 'order-fix-holding-up-2026-10';
  const release = () => RELEASES.find((r) => r.id === ID)!;
  const everyone: ReleaseViewer = {
    role: 'owner',
    permissions: [...PERMISSIONS],
    enabledModules: Object.keys(MODULE_REGISTRY) as ModuleId[],
  };
  const published = (): Release => ({ ...release(), status: 'published' });

  it('is published after the web deploy, the phone update and the Demo Co walk, so every feed carries it', () => {
    expect(release()).toBeDefined();
    expect(release().status).toBe('published');
    expect(release().revision).toBe(1);
    expect(visibleReleases(RELEASES, everyone).map((r) => r.id)).toContain(ID);
    const list = buildReleaseList(RELEASES, everyone, [], null);
    expect(list.releases.map((r) => r.id)).toContain(ID);
    expect(list.latestUnread?.id).toBe(ID);
    // An old phone build lists at most three unread releases, newest first:
    // this one, the small fixes' and the report scope fix's.
    expect(legacyAnnouncementsFor(RELEASES, everyone, {}).map((a) => a.id)).toEqual([
      ID,
      'small-fixes-2026-09',
      'reports-caller-scope-2026-09',
    ]);
    expect(registryFingerprint(RELEASES)).toContain(ID);
    expect(ANNOUNCEMENTS.map((a) => a.id)).toContain(ID);
    expect(Date.parse(release().publishedAt)).toBeLessThanOrEqual(Date.parse('2026-09-30T00:00:00Z'));
  });

  it('is dated after every release below it (pinned by id); releases above it are published later', () => {
    const at = RELEASES.findIndex((r) => r.id === ID);
    expect(at).toBeGreaterThanOrEqual(0);
    // Newest published for now (the latestUnread pins say so too); a draft
    // added at the top later does not break this.
    expect(RELEASES.slice(0, at).every((r) => r.status === 'draft')).toBe(true);
    for (const r of RELEASES.slice(0, at)) {
      expect(Date.parse(r.publishedAt), r.id).toBeGreaterThan(Date.parse(release().publishedAt));
    }
    for (const r of RELEASES.slice(at + 1)) {
      expect(Date.parse(release().publishedAt), r.id).toBeGreaterThan(Date.parse(r.publishedAt));
    }
  });

  it('is addressed by what each entry offers: put-away to the readiness panel, the preview to approvers', () => {
    expect(release().audience).toEqual({ modules: ['orders'] });
    expect(release().entries.map((e) => e.id)).toEqual(['order-put-away-from-the-order', 'order-partial-preview']);
    const [putAway, preview] = release().entries;
    expect(putAway!.audience).toEqual({
      anyPermission: ['orders:approve', 'items:update', 'purchase_orders:manage'],
      modules: ['orders'],
    });
    expect(preview!.audience).toEqual({ anyPermission: ['orders:approve'], modules: ['orders'] });
    for (const e of release().entries) {
      expect(e.area, e.id).toBe('Orders');
      expect(e.link, e.id).toEqual({ href: '/dashboard/orders', label: 'View orders' });
    }
    const reader = (permissions: ReleaseViewer['permissions'], enabledModules: ModuleId[] = ['orders']) =>
      visibleReleases([published()], { role: 'viewer', permissions, enabledModules })[0]?.entries.map(
        (e) => e.id,
      ) ?? [];
    expect(reader(['orders:approve'])).toEqual(['order-put-away-from-the-order', 'order-partial-preview']);
    expect(reader(['items:update'])).toEqual(['order-put-away-from-the-order']);
    expect(reader(['purchase_orders:manage'])).toEqual(['order-put-away-from-the-order']);
    // A requester sees one sentence of readiness and no actions: nothing here.
    expect(reader(['orders:request'])).toEqual([]);
    expect(reader(['orders:approve'], [])).toEqual([]);
  });

  it('names both platforms, the permission by its matrix name, and says the result is read, never copied', () => {
    const r = release();
    expect(r.summary).toMatch(/^On the web and in the mobile app, /);
    const text = readerText(r).join(' ');
    expect(text).toContain('needs the Transfer stock permission');
    // The same permission names the order itself shows (core), so the two
    // cannot drift apart if the owner renames one. Put away also needs View
    // items, since the Staging page and the phone's Staging route require it.
    expect(text).toContain(PUT_AWAY_NEEDS_TRANSFER_COPY.match(/the .+ permission/)![0]);
    expect(text).toContain(PUT_AWAY_NEEDS_VIEW_ITEMS_COPY.match(/the .+ permission/)![0]);
    expect(text).toContain('the order says which is missing');
    // Offered only for stock the order needs from Staging (readiness putAway:
    // what the shelf does not cover), not for every item with Staging stock.
    expect(text).toContain('When an order needs stock that is still in Staging');
    expect(text).toContain('Showing items from SO-000123');
    // Only the order's own warehouse is listed, and the list says so.
    expect(text).toContain("the stock at the order's own warehouse");
    expect(text).toContain('says when stock at other warehouses was left out');
    // Lines changed in between are not blamed on stock, in core's words.
    expect(text).toContain(
      `If the order's own lines changed in between, it says ${PARTIAL_RESULT_ORDER_CHANGED_COPY.split(',')[0]} instead.`,
    );
    // An order that moved on (another approver first): the preview goes, and
    // the sentence is core's, the same whether the server or the page noticed.
    // Each action's own words: Resume's is not Approve partial's.
    expect(text).toContain('the preview is cleared');
    expect(text).toContain(`Approve partial says ${partialActionMovedOnCopy('approve_partial').replace(/\.$/, '')},`);
    expect(text).toContain(`Resume fulfillment says ${partialActionMovedOnCopy('resume')}`);
    // Where the result is said: the dialog on the web, an Alert on the phone.
    expect(text).toContain('in the same window on the web and in a message in the mobile app');
    expect(text).toContain('Approved. Holding 36 of 40 units.');
    expect(text).toContain('2 fewer than shown because stock changed after you looked');
    expect(text).toContain('never copied from the preview');
    expect(text).toContain('shown once, with its lines combined');
    expect(text).not.toMatch(/\bbooks?\b|%|guarantee|verified|will arrive/i);
  });
});

/**
 * The small fixes from the 2026-09-28/29 walks (fix/small-walk-fixes): the web
 * top bar, breadcrumbs and page titles, and on the phone the greeting, the
 * VoiceOver names and 44pt targets, the digital pick's quantity at the largest
 * text sizes, the order screen's keyboard and "1 UNIT". Held as a DRAFT until
 * the phone update (OTA group 83d6a10f) carried the phone fixes and they were
 * walked. Pinned by id, never by index. This follow-up publishes it, just
 * before F2-3's release.
 */
describe('the small-fixes release is published', () => {
  const ID = 'small-fixes-2026-09';
  const release = () => RELEASES.find((r) => r.id === ID)!;
  const everyone: ReleaseViewer = {
    role: 'owner',
    permissions: [...PERMISSIONS],
    enabledModules: Object.keys(MODULE_REGISTRY) as ModuleId[],
  };
  const published = (): Release => ({ ...release(), status: 'published' });

  it('is published after the web deploy, the phone update and the walks, so every feed carries it', () => {
    expect(release()).toBeDefined();
    expect(release().status).toBe('published');
    expect(release().revision).toBe(1);
    expect(visibleReleases(RELEASES, everyone).map((r) => r.id)).toContain(ID);
    const list = buildReleaseList(RELEASES, everyone, [], null);
    expect(list.releases.map((r) => r.id)).toContain(ID);
    // The notice offers the newest unread release: F2-3's was published
    // after this one.
    expect(list.latestUnread?.id).toBe('order-fix-holding-up-2026-10');
    // An old phone build lists at most three unread releases, newest first;
    // this one comes into that list once the newer releases are read.
    const newer = Object.fromEntries(
      RELEASES.slice(0, RELEASES.findIndex((r) => r.id === ID)).map((r) => [r.id, true]),
    );
    expect(legacyAnnouncementsFor(RELEASES, everyone, newer).map((a) => a.id)).toContain(ID);
    expect(registryFingerprint(RELEASES)).toContain(ID);
    expect(ANNOUNCEMENTS.map((a) => a.id)).toContain(ID);
    expect(Date.parse(release().publishedAt)).toBeLessThanOrEqual(Date.parse('2026-09-30T00:00:00Z'));
  });

  it("is dated after every release below it (pinned by id); F2-3's above it was published later", () => {
    const at = RELEASES.findIndex((r) => r.id === ID);
    expect(at).toBeGreaterThanOrEqual(0);
    // Directly under F2-3's (relative, so a draft added at the top later
    // does not break it).
    expect(at).toBe(RELEASES.findIndex((r) => r.id === 'order-fix-holding-up-2026-10') + 1);
    for (const r of RELEASES.slice(0, at)) {
      expect(Date.parse(r.publishedAt), r.id).toBeGreaterThan(Date.parse(release().publishedAt));
    }
    for (const r of RELEASES.slice(at + 1)) {
      expect(Date.parse(release().publishedAt), r.id).toBeGreaterThan(Date.parse(r.publishedAt));
    }
  });

  it('is for everyone, and each order entry is addressed as the page it links to is reached', () => {
    expect(release().audience).toBeUndefined();
    expect(release().entries.map((e) => e.id)).toEqual([
      'web-top-bar-fits',
      'web-titles-narrow-screens',
      'phone-home-greeting',
      'phone-buttons-voiceover-targets',
      'phone-more-voiceover-buttons',
      'phone-pick-quantity-large-text',
      'phone-order-screen-keyboard',
      'phone-order-one-unit',
    ]);
    const [bar, titles, greeting, buttons, more, pick, keyboard, unit] = release().entries;
    // The top bar, the titles, the greeting and the accessibility fixes: every member.
    for (const e of [bar!, titles!, greeting!, buttons!, more!]) {
      expect(e.audience, e.id).toBeUndefined();
      expect(e.link, e.id).toBeUndefined();
    }
    // The pick field and the keyboard: whoever can pick, where Orders is on
    // (as the web digital pick's entry is addressed). The only field on the
    // order screen that takes typing is the digital pick's quantity (the
    // delivery text is read-only; Deny, Reopen and the driver's fields are in
    // their own windows), and it is offered only to a picker: manager and up,
    // or items:update (order/[id].tsx viewerCanPick). Review of 2026-09-29:
    // the keyboard entry was addressed to every Orders user.
    const picker = { anyPermission: ['items:update', 'orders:approve'], modules: ['orders'] };
    expect(pick!.audience).toEqual(picker);
    expect(keyboard!.audience).toEqual(picker);
    for (const e of [pick!, keyboard!]) {
      expect(e.link, e.id).toEqual({ href: '/dashboard/orders', label: 'View orders' });
    }
    // An order's unit count (phone): anyone who can open an order, where
    // Orders is on (order requests are visible to every member).
    expect(unit!.audience).toEqual({ modules: ['orders'] });
    expect(unit!.link).toEqual({ href: '/dashboard/orders', label: 'View orders' });
    const reader = (permissions: ReleaseViewer['permissions'], enabledModules: ModuleId[] = ['orders']) =>
      visibleReleases([published()], { role: 'viewer', permissions, enabledModules })[0]?.entries.map((e) => e.id) ?? [];
    expect(reader(['items:update'])).toEqual([
      'web-top-bar-fits',
      'web-titles-narrow-screens',
      'phone-home-greeting',
      'phone-buttons-voiceover-targets',
      'phone-more-voiceover-buttons',
      'phone-pick-quantity-large-text',
      'phone-order-screen-keyboard',
      'phone-order-one-unit',
    ]);
    // A requester types nothing on an order's screen: neither picker entry,
    // but they read an order's title and its unit count like anyone.
    expect(reader(['orders:request'])).toEqual([
      'web-top-bar-fits',
      'web-titles-narrow-screens',
      'phone-home-greeting',
      'phone-buttons-voiceover-targets',
      'phone-more-voiceover-buttons',
      'phone-order-one-unit',
    ]);
    expect(reader(['orders:approve'])).toEqual([
      'web-top-bar-fits',
      'web-titles-narrow-screens',
      'phone-home-greeting',
      'phone-buttons-voiceover-targets',
      'phone-more-voiceover-buttons',
      'phone-pick-quantity-large-text',
      'phone-order-screen-keyboard',
      'phone-order-one-unit',
    ]);
    expect(reader([], [])).toEqual([
      'web-top-bar-fits',
      'web-titles-narrow-screens',
      'phone-home-greeting',
      'phone-buttons-voiceover-targets',
      'phone-more-voiceover-buttons',
    ]);
  });

  it('names the platform in every entry and says it plainly', () => {
    const r = release();
    // Old phone builds show only the summary: it names both platforms.
    expect(r.summary).toMatch(/^On the web, /);
    expect(r.summary).toContain('In the mobile app, ');
    const [bar, titles, greeting, buttons, more, pick, keyboard, unit] = r.entries;
    expect(bar!.whatChanged).toMatch(/^On the web, /);
    expect(titles!.whatChanged).toMatch(/^On the web, /);
    expect(titles!.whatToDo).toBe('No action needed.');
    for (const e of [greeting!, buttons!, more!, pick!, keyboard!, unit!]) expect(e.whatChanged, e.id).toContain('mobile app');
    for (const e of [greeting!, buttons!, more!, pick!, keyboard!, unit!]) {
      expect(e.whatToDo, e.id).toBe('Update the app when it offers the new version.');
    }
    expect(bar!.whatToDo).toBe('No action needed.');
    const text = readerText(r).join(' ');
    // The words the screens use.
    expect(text).toContain('Good morning before noon, Good afternoon until 5 PM and Good evening after that');
    expect(text).toContain('Increase quantity of Blue Pens');
    expect(text).toContain('a typed 30 showed as 3');
    expect(text).toContain('Help & Learning, Support & feedback and the theme');
    // Search is in the bar wherever it was before (review of 2026-09-29), and
    // the menu scrolls on a short screen.
    expect(bar!.howItAffectsYou).toContain('Search stays in the bar wherever it was before');
    expect(bar!.howItAffectsYou).toContain('scrolls');
    // The bar adds its controls in the order the widths bring them (topbar.tsx:
    // search icon from 400 px, the breadcrumb from 520, the rest from 680), and
    // says the breadcrumb is left out on a phone, where before it was squeezed
    // to a stray slash (header-check before shots at 320-430 px).
    expect(bar!.whatChanged).toContain('it adds search, then the breadcrumb, then Keyboard shortcuts');
    expect(bar!.howItAffectsYou).toContain('On a phone held upright the breadcrumb is left out; it had no room there before either.');
    // The text Back links and the cameras' Done and Cancel; and what moved.
    expect(buttons!.whatChanged).toContain('Done and Cancel on the counting cameras');
    expect(buttons!.howItAffectsYou).toContain('a few points lower');
    expect(buttons!.howItAffectsYou).toContain('moved into its place');
    // Walk after F2-3 (found in passing, the same on main): the breadcrumb on
    // fixed pages, more controls VoiceOver could not tell were buttons, two
    // small X's, an order's title at 390 px, and "1 UNITS".
    expect(bar!.whatChanged).toContain('Inventory / Staging');
    expect(bar!.whyItMatters).toContain('Items / Detail');
    expect(more!.whatChanged).toContain("Maintenance's New, New item's Scan instead");
    expect(more!.whatChanged).toContain('Capture photo');
    expect(more!.whatChanged).toContain('All, Books and Items');
    expect(more!.whatChanged).toContain("the X that closes What's New and a screen tour");
    expect(titles!.whatChanged).toContain('an order, a bundle, a maintenance request and a procedure');
    // Not a return: returns/[id] took basis-72 too (983e8bed), but nothing
    // sits beside its title, so its title was never squeezed and nothing
    // changed there for the reader.
    expect(titles!.whatChanged).not.toMatch(/\breturn\b/i);
    expect(titles!.whatChanged).toContain('such as Cancel request and Report a problem on an order, move under');
    expect(titles!.whyItMatters).toContain('Or...');
    expect(unit!.whatChanged).toContain('1 UNIT');
    expect(r.summary).toContain("a page's title keeps its name or number on a narrow screen");
    // The breadcrumb's old trails, as the catch-alls wrote them.
    expect(bar!.whyItMatters).toContain(
      "called Staging and Labels an item's page (Items / Detail) and Recurring purchase orders a purchase order's page",
    );
    // Home keeps up while it stays open, and on Refresh (review of 2026-09-29).
    expect(greeting!.howItAffectsYou).toContain('changes by itself at noon, 5 PM and midnight while Home stays open');
    // The Staging filters say which one is on; Maintenance's New says what it makes.
    expect(more!.whatChanged).toContain('New read as New maintenance request');
    expect(more!.whatChanged).toContain('the filter in use read as selected');
    // Nothing it cannot stand behind: the keyboard entry claims room, not a
    // scroll it has not been seen to do (the iPad walk scrolled the field above
    // the docked keyboard; a floating keyboard is not avoided), and no field is
    // promised to stay out from under the keyboard; no measured claims; no "book".
    expect(keyboard!.whatChanged).toContain('can be scrolled into view above the keyboard');
    expect(r.summary).toContain('can be scrolled above the keyboard');
    expect(`${keyboard!.title} ${keyboard!.whatChanged} ${r.summary}`).not.toMatch(/no longer left under|no field is left/i);
    expect(text).not.toMatch(/\bbook\b|%|faster|always visible|guarantee/i);
  });
});

/**
 * Book Order Totals by charter and exact dates (0382) is held as a DRAFT until
 * 0382, the web deploy, the phone update (OTA), the Demo Co production walk and
 * the phone adoption check (plan R8b: an older phone ignores a charter in a
 * link) are done. Pinned by id, never by index. The follow-up that publishes it
 * sets 'published' and the real publishedAt, re-reads its words against what
 * shipped, and flips the first pin here.
 */
describe('Book Order Totals by charter and dates is held as a draft', () => {
  const ID = 'book-order-totals-charters-dates-2026-10';
  const release = () => RELEASES.find((r) => r.id === ID)!;
  const everyone: ReleaseViewer = {
    role: 'owner',
    permissions: [...PERMISSIONS],
    enabledModules: Object.keys(MODULE_REGISTRY) as ModuleId[],
  };
  const published = (): Release => ({ ...release(), status: 'published' });

  it('is a draft, so no feed carries it: not the list, the notice, the old phone list, /api/version or the announcements', () => {
    expect(release()).toBeDefined();
    expect(release().status).toBe('draft');
    expect(release().revision).toBe(1);
    expect(visibleReleases(RELEASES, everyone).map((r) => r.id)).not.toContain(ID);
    const list = buildReleaseList(RELEASES, everyone, [], null);
    expect(list.releases.map((r) => r.id)).not.toContain(ID);
    expect(list.latestUnread?.id).not.toBe(ID);
    expect(legacyAnnouncementsFor(RELEASES, everyone, {}).map((a) => a.id)).not.toContain(ID);
    expect(registryFingerprint(RELEASES)).not.toContain(ID);
    // Preparing it changes nothing a client can observe.
    expect(registryFingerprint(RELEASES)).toBe(
      registryFingerprint(RELEASES.filter((r) => r.id !== ID)),
    );
    expect(ANNOUNCEMENTS.map((a) => a.id)).not.toContain(ID);
  });

  it('sits at the top (pinned by id), dated after every other release, so publishing it makes it the newest', () => {
    const at = RELEASES.findIndex((r) => r.id === ID);
    expect(at).toBeGreaterThanOrEqual(0);
    expect(RELEASES.slice(0, at).every((r) => r.status === 'draft')).toBe(true);
    for (const r of RELEASES.filter((x) => x.id !== ID)) {
      expect(Date.parse(release().publishedAt), r.id).toBeGreaterThan(Date.parse(r.publishedAt));
    }
    // Once published it is what the notice offers.
    const list = buildReleaseList(
      [published(), ...RELEASES.filter((r) => r.id !== ID)],
      everyone,
      [],
      null,
    );
    expect(list.latestUnread?.id).toBe(ID);
  });

  it('is addressed as the report is reached: Orders on, then Books on with reports:read, the permission the linked page checks (both entries)', () => {
    expect(release().audience).toEqual({ modules: ['orders'] });
    expect(release().entries.map((e) => e.id)).toEqual([
      'book-order-totals-charter-filter',
      'book-order-totals-exact-dates',
    ]);
    for (const e of release().entries) {
      expect(e.area, e.id).toBe('Reports');
      expect(e.audience, e.id).toEqual({ anyPermission: ['reports:read'], modules: ['books'] });
      expect(e.link, e.id).toEqual({
        href: '/dashboard/reports/book-order-totals',
        label: 'Book Order Totals',
      });
    }
    const reader = (permissions: ReleaseViewer['permissions'], enabledModules: ModuleId[]) =>
      visibleReleases([published()], {
        role: 'viewer',
        permissions,
        enabledModules,
      })[0]?.entries.map((e) => e.id) ?? [];
    expect(reader(['reports:read'], ['orders', 'books'])).toEqual([
      'book-order-totals-charter-filter',
      'book-order-totals-exact-dates',
    ]);
    // The page redirects without reports:read, so an export-only override,
    // a requester and a reader without either module are told nothing.
    expect(reader(['reports:export'], ['orders', 'books'])).toEqual([]);
    expect(reader(['orders:request'], ['orders', 'books'])).toEqual([]);
    expect(reader(['reports:read'], ['orders'])).toEqual([]);
    expect(reader(['reports:read'], ['books'])).toEqual([]);
  });

  it("names both platforms, the order's charter (never the owning one), and tells phones how to load the update for charter links", () => {
    const r = release();
    // Old phone builds show only the summary: it names both platforms.
    expect(r.summary).toContain('on the web and in the mobile app');
    const [charter, dates] = r.entries;
    expect(charter!.howItAffectsYou).toContain(
      'the charter each order was placed for, its delivery site, not the charter that owns the stock',
    );
    expect(charter!.howItAffectsYou).toContain(
      'Pickup orders have no charter and are listed under No charter.',
    );
    expect(charter!.howItAffectsYou).toContain('You can choose only charters you have access to.');
    // An older phone ignores a charter in a link (plan R8b). The phone part
    // ships as an over-the-air update, not a store version, so it says how
    // such an update is loaded (the house wording), never "update the app".
    expect(charter!.howItAffectsYou).toContain(
      'In the mobile app, close the app completely and open it again to load the latest update, which opens links that choose a charter.',
    );
    expect(readerText(r).join(' ')).not.toMatch(/update the app|App Store|new version/i);
    expect(charter!.whatChanged).toContain('Books ordered by charter');
    // The week the SQL computes (plan D5) and the words the screens use.
    expect(dates!.whatChanged).toContain('Today and This week (starting Sunday)');
    expect(dates!.whatChanged).toContain('Clear filters');
    // True on both platforms: the phone's search has its own box, no chip.
    expect(dates!.whatChanged).toContain(
      'Each filter you set appears as a chip you can remove (in the mobile app, the search keeps its own box), and Clear filters resets them all.',
    );
    expect(dates!.whatChanged).not.toContain('Clear filters starts over');
    expect(dates!.howItAffectsYou).toContain('a range includes all of its last day');
    expect(dates!.howItAffectsYou).toContain('Back to Book Order Totals');
    const text = readerText(r).join(' ');
    // Copies requested, never stock on record; no percentages, no promises.
    expect(text).not.toMatch(/\bdelivered\b|\bthe book\b|\bon hand\b|%|guarantee|faster/i);
  });
});

/**
 * Count differences, release 1 (no migration): the words for what clears a
 * count difference, held as a DRAFT until the web deploy, the phone update and
 * the walk are done. Pinned by id, never by index. The follow-up that
 * publishes it sets 'published' and the real publishedAt, re-reads its words
 * against what shipped, and flips the first pin here.
 */
describe('count differences say what clears them (release 1) is held as a draft', () => {
  const ID = 'count-difference-words-2026-10';
  const release = () => RELEASES.find((r) => r.id === ID)!;
  const everyone: ReleaseViewer = {
    role: 'owner',
    permissions: [...PERMISSIONS],
    enabledModules: Object.keys(MODULE_REGISTRY) as ModuleId[],
  };
  const published = (): Release => ({ ...release(), status: 'published' });

  it('is a draft, so no feed carries it: not the list, the notice, the old phone list, /api/version or the announcements', () => {
    expect(release()).toBeDefined();
    expect(release().status).toBe('draft');
    expect(release().revision).toBe(1);
    expect(visibleReleases(RELEASES, everyone).map((r) => r.id)).not.toContain(ID);
    const list = buildReleaseList(RELEASES, everyone, [], null);
    expect(list.releases.map((r) => r.id)).not.toContain(ID);
    expect(list.latestUnread?.id).not.toBe(ID);
    expect(legacyAnnouncementsFor(RELEASES, everyone, {}).map((a) => a.id)).not.toContain(ID);
    expect(registryFingerprint(RELEASES)).not.toContain(ID);
    // Preparing it changes nothing a client can observe.
    expect(registryFingerprint(RELEASES)).toBe(registryFingerprint(RELEASES.filter((r) => r.id !== ID)));
    expect(ANNOUNCEMENTS.map((a) => a.id)).not.toContain(ID);
  });

  // Two drafts wait at the top: Book Order Totals (0382, dated a day later)
  // sits above this one, drafts newest first.
  it('sits among the drafts at the top (pinned by id), dated after every published release, so publishing it makes it the newest published', () => {
    const at = RELEASES.findIndex((r) => r.id === ID);
    expect(at).toBeGreaterThanOrEqual(0);
    expect(RELEASES.slice(0, at).every((r) => r.status === 'draft')).toBe(true);
    for (const r of RELEASES.filter((x) => x.id !== ID && x.status !== 'draft')) {
      expect(Date.parse(release().publishedAt), r.id).toBeGreaterThan(Date.parse(r.publishedAt));
    }
    for (const r of RELEASES.slice(0, at)) {
      expect(Date.parse(r.publishedAt), r.id).toBeGreaterThanOrEqual(Date.parse(release().publishedAt));
    }
    const list = buildReleaseList(
      [published(), ...RELEASES.filter((r) => r.id !== ID)],
      everyone,
      [],
      null,
    );
    expect(list.latestUnread?.id).toBe(ID);
  });

  it('is for readers of exceptions where Cycle Counts is on, linking to Exceptions', () => {
    expect(release().audience).toBeUndefined();
    expect(release().entries.map((e) => e.id)).toEqual(['count-difference-what-clears-it']);
    const [entry] = release().entries;
    expect(entry!.category).toBe('improved');
    expect(entry!.area).toBe('Inventory');
    expect(entry!.link).toEqual({ href: '/dashboard/exceptions', label: 'Open Exceptions' });
    expect(entry!.audience).toEqual({ anyPermission: ['items:read'], modules: ['cycle_counts'] });
    const reader = (permissions: ReleaseViewer['permissions'], enabledModules: ModuleId[] = ['cycle_counts']) =>
      visibleReleases([published()], { role: 'viewer', permissions, enabledModules })[0]?.entries.map((e) => e.id) ?? [];
    expect(reader(['items:read'])).toEqual(['count-difference-what-clears-it']);
    expect(reader(['items:read'], [])).toEqual([]);
    expect(reader([])).toEqual([]);
  });

  it('says what clears it in the product\'s own words, and nothing about confirming a count yet', () => {
    const r = release();
    const text = readerText(r).join(' ');
    // The example is core's row sentence, so the two cannot drift apart.
    const example = describeOccurrence('count_variance', {
      cycleCountId: 'cc-35',
      countNumber: 35,
      expected: 100,
      counted: 2,
      variance: -98,
    }).detail;
    expect(example).toBe('CC-000035 found 2 where 100 was on record (-98)');
    expect(text).toContain(`for example, ${example}, and its page says at the top what clears it`);
    // Review 2026-09-29: the audience is every reader of exceptions (most
    // L4L members are viewers), and only a manager who may assign counts
    // sees Recount; the page tells everyone else who to ask.
    expect(text).toContain('a later count that matches the stock on record, which a manager can start with Recount');
    expect(text).not.toMatch(/which you can start/);
    expect(text).toContain('the Acknowledge step says that acknowledging does not');
    expect(text).toContain('Nothing changes in when these exceptions are raised or cleared.');
    // Release 2 introduces confirming: nothing here may promise it.
    expect(text).not.toMatch(/confirm/i);
    expect(text).not.toMatch(/\bbooks?\b|%|guarantee|verified|accurate/i);
  });
});

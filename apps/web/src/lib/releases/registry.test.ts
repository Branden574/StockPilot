import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  availableReturnListFilters,
  COMPLETION_CONFIRM_LABEL,
  CONFIRM_COUNT_LABEL,
  confirmCountDialogCopy,
  CONFIRMED_ONLY_FILTER_LABEL,
  DELETED_REQUESTER_LABEL,
  DELETED_USER_LABEL,
  describeOccurrence,
  COMPLETION_REVIEW_LABEL,
  describeShortPickLines,
  EXCEPTION_ACT_REFUSED_COPY,
  EXCEPTION_EVIDENCE_MAX_PHOTOS,
  EXCEPTION_EVIDENCE_NOTE_MAX,
  EXCEPTION_RULES,
  HOLD_AVAILABLE_STOCK_LABEL,
  isDeletedRequester,
  MODULE_REGISTRY,
  ORDER_LINE_HIDDEN_ITEM_NAME,
  PARTIAL_RESULT_ORDER_CHANGED_COPY,
  partialActionMovedOnCopy,
  PERMISSION_META,
  PERMISSIONS,
  PUT_AWAY_NEEDS_TRANSFER_COPY,
  PUT_AWAY_NEEDS_VIEW_ITEMS_COPY,
  releaseRegistrySchema,
  VERIFICATION_SESSION_ENDED_COPY,
  type CountConfirmBlock,
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

/** A confirmable block, for core's dialog words the R2 release quotes. */
const WORDS_BLOCK: CountConfirmBlock = {
  state: 'confirmable',
  canConfirm: true,
  unavailableReason: null,
  cycleCountId: 'cc-35',
  countNumber: 35,
  counted: 2,
  onRecordBefore: 100,
  onRecordNow: 2,
  countedBy: null,
  postedBy: null,
  readerIsCounter: true,
  otherCount: null,
};

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
    // scope fix's, the small fixes', F2-3's, the Sports fields', the count
    // difference words', Book Order Totals by charter's, F2-4's, F2-5's, the
    // count confirm's, the session-ended fix's, the two account deletion
    // releases, the two order signature releases and the approval release after
    // it).
    expect(list.latestUnread?.id).toBe('approval-follows-permission-2026-10');
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
    // Totals', the report scope fix's, the small fixes', F2-3's, the Sports
    // fields', the count difference words', Book Order Totals by charter's,
    // F2-4's, F2-5's, the count confirm's, the session-ended fix's, the two
    // account deletion releases, the two order signature releases and the
    // approval release were published after this one.
    expect(list.latestUnread?.id).toBe('approval-follows-permission-2026-10');
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
    // fixes', F2-3's, the Sports fields', the count difference words', Book
    // Order Totals by charter's, F2-4's, F2-5's, the count confirm's, the
    // session-ended fix's, the two account deletion releases, the two order
    // signature releases and the approval release were published after this
    // one.
    expect(list.latestUnread?.id).toBe('approval-follows-permission-2026-10');
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
    // The notice offers the newest unread release; the report scope fix's, the
    // small fixes', F2-3's, the Sports fields', the count difference words',
    // Book Order Totals by charter's, F2-4's, F2-5's, the count confirm's, the
    // session-ended fix's, the two account deletion releases, the two order
    // signature releases and the approval release were published after this
    // one.
    expect(list.latestUnread?.id).toBe('approval-follows-permission-2026-10');
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
    // The notice offers the newest unread release: the small fixes', F2-3's,
    // the Sports fields', the count difference words', Book Order Totals by
    // charter's, F2-4's, F2-5's, the count confirm's, the session-ended fix's,
    // the two account deletion releases, the two order signature releases and
    // the approval release were published after this one.
    expect(list.latestUnread?.id).toBe('approval-follows-permission-2026-10');
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
    // The notice offers the newest unread release: the Sports fields', the
    // count difference words', Book Order Totals by charter's, F2-4's, F2-5's,
    // the count confirm's, the session-ended fix's, the two account deletion
    // releases, the two order signature releases and the approval release were
    // published after this one.
    expect(list.latestUnread?.id).toBe('approval-follows-permission-2026-10');
    // An old phone build lists at most three unread releases, newest first:
    // once the newer releases are read, this one, the small fixes' and the
    // report scope fix's.
    const newer = Object.fromEntries(
      RELEASES.slice(0, RELEASES.findIndex((r) => r.id === ID)).map((r) => [r.id, true]),
    );
    expect(legacyAnnouncementsFor(RELEASES, everyone, newer).map((a) => a.id)).toEqual([
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
 * The ended-session fix shipped in count differences R2 (#308, 77e5659f): on
 * the web, fail() in server/actions/exceptions.ts rethrows the sign-in
 * redirect (unstable_rethrow) instead of answering "Something went wrong";
 * in the mobile app, describeActError reads a 401 as core's
 * VERIFICATION_SESSION_ENDED_COPY in the Acknowledge, Add note and Confirm
 * this count sheets (OTA group a6a9c7e9, live). Announced on its own, dated
 * just after the count confirm's release, so that release's What to do
 * never suggests confirming needs the update (claims review 2026-10-03).
 * Pinned by id, never by index.
 */
describe('the ended-session fix on exceptions is published', () => {
  const ID = 'exceptions-session-ended-2026-10';
  const release = () => RELEASES.find((r) => r.id === ID)!;
  const everyone: ReleaseViewer = {
    role: 'owner',
    permissions: [...PERMISSIONS],
    enabledModules: Object.keys(MODULE_REGISTRY) as ModuleId[],
  };

  it('is published after the web deploy and the phone update, so every feed carries it', () => {
    expect(release()).toBeDefined();
    expect(release().status).toBe('published');
    expect(release().revision).toBe(1);
    expect(visibleReleases(RELEASES, everyone).map((r) => r.id)).toContain(ID);
    const list = buildReleaseList(RELEASES, everyone, [], null);
    expect(list.releases.map((r) => r.id)).toContain(ID);
    // The notice offers the newest unread release: the two account deletion
    // releases, the two order signature releases and the approval release were
    // published after this one.
    expect(list.latestUnread?.id).toBe('approval-follows-permission-2026-10');
    // An old phone build lists at most three unread releases, newest first:
    // once the newer releases are read, this one, the count confirm's and
    // F2-5's.
    const newer = Object.fromEntries(
      RELEASES.slice(0, RELEASES.findIndex((r) => r.id === ID)).map((r) => [r.id, true]),
    );
    expect(legacyAnnouncementsFor(RELEASES, everyone, newer).map((a) => a.id)).toEqual([
      ID,
      'count-confirm-2026-10',
      'order-shortfall-po-2026-10',
    ]);
    expect(registryFingerprint(RELEASES)).toContain(ID);
    expect(ANNOUNCEMENTS.map((a) => a.id)).toContain(ID);
    // A real time on a whole minute, at least a minute after the count
    // confirm's (2026-10-03 18:40Z), the day it was published.
    expect(release().publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/);
    expect(Date.parse(release().publishedAt)).toBeGreaterThanOrEqual(Date.parse('2026-10-03T18:41:00Z'));
    expect(Date.parse(release().publishedAt)).toBeLessThanOrEqual(Date.parse('2026-10-04T00:00:00Z'));
  });

  it('is dated after every release below it (pinned by id), directly above the count confirm; releases above it were published later', () => {
    const at = RELEASES.findIndex((r) => r.id === ID);
    expect(at).toBeGreaterThanOrEqual(0);
    expect(RELEASES.slice(at + 1).every((r) => r.status === 'published' || r.status === 'withdrawn')).toBe(true);
    for (const r of RELEASES.slice(0, at)) {
      expect(Date.parse(r.publishedAt), r.id).toBeGreaterThan(Date.parse(release().publishedAt));
    }
    for (const r of RELEASES.slice(at + 1)) {
      expect(Date.parse(release().publishedAt), r.id).toBeGreaterThan(Date.parse(r.publishedAt));
    }
    expect(RELEASES[at + 1]?.id).toBe('count-confirm-2026-10');
  });

  it('is addressed as the Exceptions pages are reached (items:read), then as the sheets and actions it names are offered (stock:adjust)', () => {
    expect(release().audience).toEqual({ anyPermission: ['items:read'] });
    expect(release().entries.map((e) => e.id)).toEqual(['exceptions-session-ended']);
    const [entry] = release().entries;
    expect(entry!.category).toBe('fixed');
    expect(entry!.area).toBe('Inventory');
    expect(entry!.link).toEqual({ href: '/dashboard/exceptions', label: 'Open Exceptions' });
    expect(entry!.audience).toEqual({ anyPermission: ['stock:adjust'] });
    const reader = (role: ReleaseViewer['role'], permissions: ReleaseViewer['permissions']) =>
      visibleReleases([release()], { role, permissions, enabledModules: [] })[0]?.entries.map((e) => e.id) ?? [];
    // Whoever can acknowledge, add a note or confirm is told, with Cycle
    // Counts on or off (Acknowledge and Add note are on every exception).
    expect(reader('staff', ['items:read', 'stock:adjust'])).toEqual(['exceptions-session-ended']);
    expect(reader('manager', ['items:read', 'stock:adjust'])).toEqual(['exceptions-session-ended']);
    // A viewer is offered none of them; nobody who cannot open Exceptions.
    expect(reader('viewer', ['items:read'])).toEqual([]);
    expect(reader('staff', ['stock:adjust'])).toEqual([]);
  });

  it("says what each platform shows, in the products' own words, and how the phone gets it", () => {
    const r = release();
    const [entry] = r.entries;
    const all = readerText(r).join(' ');
    // The web's old words are fail()'s generic answer, and the redirect now
    // passes through it (#308).
    const actions = readFileSync(resolve(__dirname, '../../server/actions/exceptions.ts'), 'utf8');
    expect(actions).toContain("unstable_rethrow(e);");
    expect(actions).toContain("'Something went wrong. Please try again.'");
    // Old phones show only the title and the summary: it stands alone and
    // names both platforms.
    expect(r.summary).toBe(
      'On the web, an action on an exception after your session has ended now takes you to the sign-in page, instead of saying "Something went wrong. Please try again." In the mobile app, after the latest update, the Acknowledge, Add note and Confirm this count sheets say "Your session has ended. Sign in again."',
    );
    expect(r.summary).toContain(`"${VERIFICATION_SESSION_ENDED_COPY}"`);
    expect(entry!.whatChanged).toContain(`"${VERIFICATION_SESSION_ENDED_COPY}"`);
    expect(entry!.whatChanged).toMatch(/^On the web, when your session has ended, an action on an exception/);
    expect(entry!.whatChanged).toContain('In the mobile app, after the latest update, the Acknowledge, Add note and Confirm this count sheets');
    // A lost permission is not announced: the phone's words for it did not
    // change, and on the web the app's own gate answers first, in its own
    // words (claims check 2026-10-03).
    expect(EXCEPTION_ACT_REFUSED_COPY).toBe('You do not have permission to act on this exception.');
    expect(all).not.toContain(EXCEPTION_ACT_REFUSED_COPY);
    expect(all).not.toMatch(/permission/i);
    // Nothing was saved: the session check comes before any write.
    expect(entry!.howItAffectsYou).toBe(
      'Nothing was saved when this happened. Sign in again, then open the exception and try again.',
    );
    // The phone part is an over-the-air update: it loads when the app is
    // opened again, with no prompt.
    expect(entry!.whatToDo).toBe(
      'No action needed on the web. In the mobile app, close the app completely and open it again to load the latest update.',
    );
    expect(all).not.toMatch(/offers the new version|update the app|App Store/i);
    expect(all).not.toMatch(/\bbooks?\b|%|guarantee|verified|always|never/i);
  });
});

/**
 * Count differences, release 2 (confirm this count, migration 0386) was held
 * as a DRAFT until 0386 was pushed and verified (2026-10-03 13:23Z), the web
 * deploy (web build 0f540fe33eae) and the Demo Co production walk (EX-000025
 * confirmed in the mobile app as the counter, its recurrence EX-000026 on the
 * web; 119 checks passed). Confirming needs no phone update (the Confirm
 * sheet shipped in release 1); the R2 phone update (OTA group a6a9c7e9) says
 * a session ended, announced on its own by exceptions-session-ended-2026-10,
 * above it. Pinned by id, never by index. This follow-up publishes it.
 */
describe('count differences release 2 (confirm this count) is published', () => {
  const ID = 'count-confirm-2026-10';
  const release = () => RELEASES.find((r) => r.id === ID)!;
  const everyone: ReleaseViewer = {
    role: 'owner',
    permissions: [...PERMISSIONS],
    enabledModules: Object.keys(MODULE_REGISTRY) as ModuleId[],
  };
  const published = (): Release => ({ ...release(), status: 'published' });

  it('is published after 0386, the web deploy, the phone update and the Demo Co walk, so every feed carries it', () => {
    expect(release()).toBeDefined();
    expect(release().status).toBe('published');
    expect(release().revision).toBe(1);
    expect(visibleReleases(RELEASES, everyone).map((r) => r.id)).toContain(ID);
    const list = buildReleaseList(RELEASES, everyone, [], null);
    expect(list.releases.map((r) => r.id)).toContain(ID);
    // The notice offers the newest unread release: the session-ended fix's, the
    // two account deletion releases, the two order signature releases and the
    // approval release were published after this one.
    expect(list.latestUnread?.id).toBe('approval-follows-permission-2026-10');
    // An old phone build lists at most three unread releases, newest first:
    // once the newer release is read, this one, F2-5's and F2-4's.
    const newer = Object.fromEntries(
      RELEASES.slice(0, RELEASES.findIndex((r) => r.id === ID)).map((r) => [r.id, true]),
    );
    expect(legacyAnnouncementsFor(RELEASES, everyone, newer).map((a) => a.id)).toEqual([
      ID,
      'order-shortfall-po-2026-10',
      'order-needed-by-change-2026-10',
    ]);
    expect(registryFingerprint(RELEASES)).toContain(ID);
    expect(ANNOUNCEMENTS.map((a) => a.id)).toContain(ID);
    // A real time on a whole minute, after the walk ended (2026-10-03 14:07Z)
    // and the phone update was published (14:17Z): never the draft's
    // placeholder date.
    expect(release().publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/);
    expect(Date.parse(release().publishedAt)).toBeGreaterThan(Date.parse('2026-10-03T14:17:00Z'));
    expect(Date.parse(release().publishedAt)).toBeLessThanOrEqual(Date.parse('2026-10-04T00:00:00Z'));
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
    // Above release 1, which it builds on, and above F2-5's.
    expect(at).toBeLessThan(RELEASES.findIndex((r) => r.id === 'count-difference-words-2026-10'));
    expect(at).toBeLessThan(RELEASES.findIndex((r) => r.id === 'order-shortfall-po-2026-10'));
  });

  it('is addressed as the page it links to is reached (Exceptions: items:read), then as confirming is offered (stock:adjust, Cycle Counts on)', () => {
    expect(release().audience).toEqual({ anyPermission: ['items:read'] });
    expect(release().entries.map((e) => e.id)).toEqual(['confirm-this-count']);
    const [entry] = release().entries;
    expect(entry!.category).toBe('new');
    expect(entry!.area).toBe('Cycle counts');
    expect(entry!.link).toEqual({ href: '/dashboard/exceptions', label: 'Open Exceptions' });
    expect(entry!.audience).toEqual({ anyPermission: ['stock:adjust'], modules: ['cycle_counts'] });
    const reader = (
      role: ReleaseViewer['role'],
      permissions: ReleaseViewer['permissions'],
      enabledModules: ModuleId[] = ['cycle_counts'],
    ) => visibleReleases([published()], { role, permissions, enabledModules })[0]?.entries.map((e) => e.id) ?? [];
    // A counter (staff with stock:adjust) and a manager, admin or owner are
    // told.
    expect(reader('staff', ['items:read', 'stock:adjust'])).toEqual(['confirm-this-count']);
    expect(reader('manager', ['items:read', 'stock:adjust', 'cycle_counts:assign'])).toEqual(['confirm-this-count']);
    expect(reader('admin', ['items:read', 'stock:adjust'])).toEqual(['confirm-this-count']);
    expect(reader('owner', ['items:read', 'stock:adjust'])).toEqual(['confirm-this-count']);
    // A viewer (items:read only) is never offered Confirm.
    expect(reader('viewer', ['items:read'])).toEqual([]);
    // Nobody where Cycle Counts is off, and nobody who cannot open Exceptions.
    expect(reader('manager', ['items:read', 'stock:adjust'], [])).toEqual([]);
    expect(reader('staff', ['stock:adjust'])).toEqual([]);
  });

  // Publish claim check 2026-10-03, against the merged code (77e5659f) and
  // the Demo Co production walk.
  it("names both platforms and who confirms, says it in the screens' own words, and states the risk plainly", () => {
    const r = release();
    const [entry] = r.entries;
    // Old phones show only the title and the summary: it stands alone, names
    // both platforms and who may confirm. The gate's manager is a manager,
    // admin or owner (core countConfirmGate isManager, 0386 has_org_role
    // manager), so never "a manager" alone.
    expect(r.summary).toBe(
      "On the web and in the mobile app, if a count difference's counted number is right, the person who counted the item, or a manager, admin or owner, can now confirm it. Confirming closes the exception without a second count. Acknowledging still leaves it open.",
    );
    expect(entry!.whatChanged).toMatch(
      /^On the web and in the mobile app, a Count did not match the stock on record exception now offers Confirm this count to the person who counted the item and to managers, admins and owners\. /,
    );
    const all = readerText(r).join(' ');
    expect(all).not.toMatch(/or a manager can now confirm|and to managers, on the web/);
    // The screens' words, from core.
    expect(all).toContain(EXCEPTION_RULES.count_variance.label);
    expect(all).toContain(CONFIRM_COUNT_LABEL);
    expect(all).toContain(confirmCountDialogCopy({ reference: null, confirm: WORDS_BLOCK }).confirmLabel);
    expect(all).toContain(CONFIRMED_ONLY_FILTER_LABEL);
    // The consequence the dialog states. The dialog says it at the moment of
    // confirming; on its own here, the entry says it holds after a confirm
    // (claims review 2026-10-03), so never the dialog's bare sentence.
    const consequenceTail = 'If a later count does not match the stock on record, a new exception opens.';
    expect(confirmCountDialogCopy({ reference: null, confirm: WORDS_BLOCK }).consequence).toContain(consequenceTail);
    expect(entry!.howItAffectsYou).not.toContain(consequenceTail);
    expect(entry!.howItAffectsYou).toMatch(
      / After you confirm, a later count that does not match opens a new exception\.$/,
    );
    // The risk the owner accepted, said plainly (D3): no second count.
    expect(entry!.howItAffectsYou).toContain(
      'Confirming closes the exception without a second count, so confirm only a number you are sure of.',
    );
    // The stock rule as the gate states it (core countConfirmState
    // stock_moved, 0386 check 13): offered only while the stock on record
    // EQUALS the counted number. A move that nets to zero still allows it, so
    // never "once the stock on record has changed since the count".
    expect(entry!.howItAffectsYou).toContain(
      'Confirm is offered only while the stock on record equals the counted number.',
    );
    expect(all).not.toContain('has changed since the count');
    // Each other rule that withholds Confirm, as the page words it (review of
    // the plan's critique: "linked", and the other count in progress). The
    // page says why in each case; for another count in progress it says what
    // happens when that count is posted, not what clears this one.
    expect(entry!.howItAffectsYou).toContain(
      'It is also not offered while a recount linked to this exception is in progress, or while another count in progress has recorded a different number for the item. In these cases the page says why.',
    );
    expect(all).not.toContain('the page then says what clears it');
    // Not every reader can start a recount (staff, the counters this entry is
    // new for, never can: Recount needs a manager who can assign counts), so
    // never "use Recount then" or "Recount is still there": every sentence
    // that names Recount says a manager starts it, as the page does.
    expect(all).not.toMatch(/use Recount/);
    expect(all).not.toMatch(/Recount is still there/);
    const recountSentences = all.split(/(?<=\.)\s+/).filter((s) => /\bRecount\b/.test(s));
    expect(recountSentences.length).toBeGreaterThan(0);
    for (const s of recountSentences) expect(s, s).toMatch(/\ba manager\b/);
    expect(entry!.howItAffectsYou).toContain(
      'If you are not sure, have it counted again; a manager can start that with Recount.',
    );
    // The act gate every confirmer passes first (stock:adjust, then access
    // to the item's live warehouse), and the phone's offline rule (a confirm
    // is never queued).
    expect(entry!.howItAffectsYou).toContain('Confirming needs permission to adjust stock and a connection.');
    // Before R2 a count difference CLEARED only when a later count matched
    // (an archived item resolves another way, never as cleared), so never
    // "only a second count could close one".
    expect(entry!.whyItMatters).toMatch(
      /^Until now a count difference cleared only when a later count matched the stock on record, /,
    );
    expect(all).not.toContain('only a second count could close');
    // The filter is web only; the phone's list shows the role in each chip.
    expect(entry!.whatChanged).toContain('On the web, Closed without a second count on the Resolved tab');
    // Confirming needs no phone update (the Confirm sheet shipped in release
    // 1), so What to do never asks for one: the R2 phone update (the session
    // ended words) is announced on its own, by exceptions-session-ended-2026-10
    // (claims review 2026-10-03).
    expect(entry!.whatToDo).toBe(
      'No action needed. To confirm, open an exception under Count did not match the stock on record, and if the counted number is right, choose Confirm this count.',
    );
    expect(all).not.toMatch(/latest update|close the app|open it again/i);
    expect(all).not.toMatch(/offers the new version|update the app|App Store|unauthenticated/i);
    // Acknowledging still does not close it.
    expect(r.summary).toContain('Acknowledging still leaves it open.');
    expect(all).toContain('stock on record');
    expect(all).not.toMatch(/\bbooks?\b|%|guarantee|verified|accurate|undo/i);
  });
});

/**
 * Approval follows the permission (migration 0390, security slice D) was held
 * as a DRAFT until 0390 was pushed and verified (2026-10-04 05:32:44Z), the
 * web deploy (#314, dcdb7ae8, web build 3e9201bd1661), the phone update that
 * shows the order screen's actions by the permission (OTA group 5b19a88a,
 * published 05:36Z, launched on phones) and the Demo Co production walk
 * (SO-000018 approved, picked, packed, staged, given a driver through
 * assign_order_delivery, marked in transit through mark_order_in_transit and
 * cancelled; the published phone bundle showed an admin Approve and Deny)
 * were done. Pinned by id, never by index. This follow-up publishes it, the
 * newest release, a minute after slice B's timeline release.
 */
describe('approval follows the permission is published', () => {
  const ID = 'approval-follows-permission-2026-10';
  const release = () => RELEASES.find((r) => r.id === ID)!;
  const everyone: ReleaseViewer = {
    role: 'owner',
    permissions: [...PERMISSIONS],
    enabledModules: Object.keys(MODULE_REGISTRY) as ModuleId[],
  };
  const LABEL = PERMISSION_META['orders:approve'].label;

  it('is published after 0390, the web deploy, the phone update and the Demo Co walk, so every feed carries it', () => {
    expect(release()).toBeDefined();
    expect(release().status).toBe('published');
    expect(release().revision).toBe(1);
    expect(visibleReleases(RELEASES, everyone).map((r) => r.id)).toContain(ID);
    const list = buildReleaseList(RELEASES, everyone, [], null);
    expect(list.releases.map((r) => r.id)).toContain(ID);
    // The newest published release: the notice offers it.
    expect(list.latestUnread?.id).toBe(ID);
    // An old phone build lists at most three unread releases, newest first:
    // this one and slice B's two.
    expect(legacyAnnouncementsFor(RELEASES, everyone, {}).map((a) => a.id)).toEqual([
      ID,
      'order-signature-timeline-2026-10',
      'order-signature-image-2026-10',
    ]);
    expect(registryFingerprint(RELEASES)).toContain(ID);
    expect(ANNOUNCEMENTS.map((a) => a.id)).toContain(ID);
    // A real time on a whole minute, after the phone update was published
    // (2026-10-04 05:36Z) and the walk ended (06:16Z): never the draft's
    // placeholder date.
    expect(release().publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/);
    expect(Date.parse(release().publishedAt)).toBeGreaterThan(Date.parse('2026-10-04T06:16:00Z'));
    expect(Date.parse(release().publishedAt)).toBeLessThanOrEqual(Date.parse('2026-10-05T00:00:00Z'));
  });

  it("is the newest release (pinned by id): only drafts sit above it, slice B's two directly below it, a minute after the first", () => {
    const at = RELEASES.findIndex((r) => r.id === ID);
    expect(at).toBeGreaterThanOrEqual(0);
    // Drafts go above the newest published release, newest first; none is
    // left below it.
    expect(RELEASES.slice(0, at).every((r) => r.status === 'draft')).toBe(true);
    expect(RELEASES.slice(at + 1).every((r) => r.status === 'published' || r.status === 'withdrawn')).toBe(true);
    for (const r of RELEASES.slice(0, at)) {
      expect(Date.parse(r.publishedAt), r.id).toBeGreaterThan(Date.parse(release().publishedAt));
    }
    for (const r of RELEASES.slice(at + 1)) {
      expect(Date.parse(release().publishedAt), r.id).toBeGreaterThan(Date.parse(r.publishedAt));
    }
    expect(RELEASES[at + 1]?.id).toBe('order-signature-timeline-2026-10');
    expect(RELEASES[at + 2]?.id).toBe('order-signature-image-2026-10');
    expect(Date.parse(release().publishedAt) - Date.parse(RELEASES[at + 1]!.publishedAt)).toBe(60_000);
  });

  it('tells each reader what changes for them', () => {
    const r = release();
    expect(r.audience).toEqual({ modules: ['orders'] });
    expect(r.entries.map((e) => e.id)).toEqual([
      'approve-permission-granted',
      'approve-permission-removed',
      'delivery-driver-actions',
    ]);
    const entriesFor = (role: ReleaseViewer['role'], permissions: ReleaseViewer['permissions'], modules: ModuleId[] = ['orders']) =>
      visibleReleases([r], { role, permissions, enabledModules: modules })[0]?.entries.map((e) => e.id) ?? [];
    // A staff member granted orders:approve: their entry and the drivers' one.
    expect(entriesFor('staff', ['orders:request', 'orders:approve'])).toEqual([
      'approve-permission-granted',
      'delivery-driver-actions',
    ]);
    // A manager whose orders:approve was removed: theirs and the drivers'.
    expect(entriesFor('manager', ['orders:request', 'orders:assign_delivery'])).toEqual([
      'approve-permission-removed',
      'delivery-driver-actions',
    ]);
    // A manager by role default, and the owner, read the managers' and the
    // drivers' entries: the granted entry describes staff only.
    expect(entriesFor('manager', ['orders:request', 'orders:approve', 'orders:assign_delivery'])).toEqual([
      'approve-permission-removed',
      'delivery-driver-actions',
    ]);
    expect(entriesFor('owner', [...PERMISSIONS])).toEqual(['approve-permission-removed', 'delivery-driver-actions']);
    // A viewer granted orders:approve is NOT told the granted entry (slice D
    // review, findings 1 and 10): the app refuses every write for a viewer,
    // so neither app offers them approving or moving orders.
    expect(entriesFor('viewer', ['orders:request', 'orders:approve'])).toEqual(['delivery-driver-actions']);
    // Staff without the grant (a possible driver) read the drivers' entry only.
    expect(entriesFor('staff', ['orders:request'])).toEqual(['delivery-driver-actions']);
    // Nobody hears about it with Orders off.
    expect(entriesFor('owner', [...PERMISSIONS], [])).toEqual([]);
    // The one link goes to the orders list, which reads orders:approve.
    const [granted, removed, driver] = r.entries;
    expect(granted!.link).toEqual({ href: '/dashboard/orders', label: 'View orders' });
    expect(granted!.audience).toEqual({ roles: ['staff'], anyPermission: ['orders:approve'], modules: ['orders'] });
    expect(removed!.link).toBeUndefined();
    expect(removed!.audience).toEqual({ roles: ['owner', 'admin', 'manager'], modules: ['orders'] });
    expect(driver!.link).toBeUndefined();
    expect(driver!.audience).toBeUndefined();
  });

  // Publish claim check 2026-10-04, against the merged code (dcdb7ae8, with
  // slice B's 9147755d below it) and the Demo Co production walk.
  it("names the permission as the settings show it, says what changes for the granted and the removed, and claims nothing else", () => {
    const r = release();
    const [granted, removed, driver] = r.entries;
    const all = readerText(r).join(' ');
    expect(LABEL).toBe('Approve / fulfill orders');
    expect(r.summary).toContain(`"${LABEL}"`);
    expect(granted!.whatChanged).toContain(`"${LABEL}"`);
    expect(removed!.whatChanged).toContain(`"${LABEL}"`);
    expect(driver!.whatChanged).toContain(`"${LABEL}"`);
    // Old phones show only the title and the summary: both changes are in it.
    // Old phone bundles still show the actions by role, so the mobile app
    // follows the permission after the latest update (OTA group 5b19a88a).
    expect(r.summary).toContain(
      `the "${LABEL}" permission on the web, in the mobile app after the latest update, and on the server.`,
    );
    expect(r.summary).toContain('A staff member who was given it sees Approve, Deny');
    expect(r.summary).toContain(
      "A manager who had it removed can no longer approve, deny, cancel other people's orders or move an order toward pickup or delivery",
    );
    expect(r.summary).not.toContain('in both apps');
    // What still goes by role in the apps is named, never "everywhere" or
    // "anywhere" (complete_picking / release_picking). The paper signature is
    // not promised (slice D review, finding 9): confirm_physical_signature
    // still admits a manager by role, and old phone bundles still offer it by
    // role, so "neither app offers" holds for the mobile app only after the
    // latest update.
    expect(r.summary).toContain('finishing or releasing picking that someone else claimed still follows the manager role');
    expect(removed!.whatChanged).toContain(
      'Finishing or releasing picking that someone else claimed still follows the manager role for now.',
    );
    expect(removed!.whatChanged).toContain(
      "Neither the web app nor the mobile app, after the latest update, offers them Collect signature or Physical signature unless they are the order's driver.",
    );
    expect(all).not.toMatch(/paper signature/i);
    expect(all).not.toMatch(/everywhere|anywhere/i);
    // The granted staff member: the phone's buttons after the update,
    // on-behalf, the picker and reopen on the web, their own cancel, and other
    // people's orders.
    expect(granted!.whatChanged).toContain(
      'the order screen in the mobile app, after the latest update, shows Approve and Deny',
    );
    expect(granted!.whatChanged).toContain("order on someone else's behalf");
    expect(granted!.whatChanged).toContain('assign who picks an order, reopen picking');
    // Assign delivery asks orders:assign_delivery as well (assignDelivery,
    // assign_order_delivery), which staff do not hold by default, and a paper
    // signature a manager or the driver: never "as managers see them".
    expect(PERMISSION_META['orders:assign_delivery'].label).toBe('Assign deliveries');
    expect(granted!.whatChanged).toContain('Assign delivery also needs the "Assign deliveries" permission.');
    expect(all).not.toContain('as managers see them');
    // Every approval-class action asks write access to the order's warehouse
    // (requireWarehouseAccess 'write'), and since slice B so does the
    // hand-over below manager rank (handOverAllowed: the web's Collect
    // signature link, the warehouse slip, the sign route's member path).
    // Cancelling asks none, so it is said apart.
    expect(granted!.howItAffectsYou).toContain(
      'You can approve orders and move them along from either app, for orders in the warehouses you have access to.',
    );
    expect(granted!.howItAffectsYou).toContain(
      "Collect signature and Print warehouse slip now follow the same rule, unless you are the order's driver.",
    );
    // Cancel: the web app for any open order; the mobile app offers Cancel
    // only on a backordered order (slice D review, finding 8).
    expect(granted!.howItAffectsYou).toContain(
      "You can cancel other people's orders from the web app; the mobile app offers Cancel on a backordered order.",
    );
    expect(all).not.toContain("cancel other people's orders from either app");
    expect(granted!.howItAffectsYou).toContain('Alerts about new orders waiting for approval still go to owners, admins and managers.');
    // The removed manager keeps the requester's own-order cancel, and loses
    // assigning and ordering on someone's behalf, which the web app itself
    // let them do by role until 0390.
    expect(removed!.howItAffectsYou).toContain(
      'A manager without it can still cancel an order they placed while it waits for approval.',
    );
    expect(removed!.whatChanged).toContain('assign a picker or a driver');
    expect(removed!.whatChanged).toContain("order on someone else's behalf");
    // Before 0390 (9147755d) the phone showed its section to a manager by role
    // and the service refused only some of it: Assign delivery asked
    // orders:assign_delivery alone and Mark in transit the driver or a manager
    // by role, and the update policy admitted a manager by role (claims
    // review). So the why never says the phone refused them all.
    expect(removed!.whyItMatters).toBe(
      "Before this change, the mobile app showed Approve, Deny and the next steps to every manager by role. A manager without the permission could still assign a driver or mark a delivery in transit there, and assign a picker or order on someone else's behalf in the web app, because the server let a manager through by role.",
    );
    expect(removed!.whyItMatters).not.toContain('refused');
    // Before 0390 the phone already offered a granted staff member Hold
    // available stock, the needed-by Change and claim and pick, and showed
    // only the approval section by role (claims review): never "only from
    // the web app".
    expect(granted!.whyItMatters).toContain(
      "The mobile app already let a staff member who was given the permission hold available stock, change an order's needed-by date, and claim and pick orders.",
    );
    expect(granted!.whyItMatters).toContain(
      'But it showed Approve, Deny and the next steps only to owners, admins and managers.',
    );
    expect(granted!.whyItMatters).not.toContain('only from the web app');
    // Owner decision O3, default: the in-transit rule, in the service's words.
    expect(driver!.whatChanged).toContain(
      'the order screen in the mobile app, after the latest update, shows Collect signature and Physical signature once the delivery is on its way',
    );
    expect(driver!.whatChanged).toContain('Marking a delivery in transit needs the');
    expect(driver!.whatChanged).toContain('is not offered Mark in transit in either app');
    // The phone part is an over-the-air update.
    expect(granted!.whatToDo).toBe(
      'No action needed in the web app. In the mobile app, close the app completely and open it again to load the latest update.',
    );
    expect(all).not.toMatch(/offers the new version|update the app|App Store/i);
    expect(all).not.toMatch(/\bbooks?\b|%|guarantee|instantly|always|notif|email/i);
  });
});

/**
 * Account deletion for people who placed orders (migration 0388, security
 * slice A2) was held as a DRAFT until 0388 was pushed and verified
 * (2026-10-03 20:26:18Z), the web deploy (web build 399eedb47aa2), the phone
 * update that names the requester "Deleted user" (OTA group 4a060cce,
 * published 23:24Z, launched on phones with no failures) and the Demo Co
 * production walk (the web and the phone refused the RESTRICT-blocked demo
 * account with the blocked sentence and changed nothing) were done. Pinned by
 * id, never by index. This follow-up publishes it, with the refusal announced
 * on its own directly below it (account-deletion-refused-2026-10). Slice B's
 * two releases and slice D's, published later, sit above it.
 */
describe('account deletion for people who placed orders is published', () => {
  const ID = 'account-deletion-orders-2026-10';
  const release = () => RELEASES.find((r) => r.id === ID)!;
  const everyone: ReleaseViewer = {
    role: 'owner',
    permissions: [...PERMISSIONS],
    enabledModules: Object.keys(MODULE_REGISTRY) as ModuleId[],
  };

  it('is published after 0388, the web deploy, the phone update and the Demo Co walk, so every feed carries it', () => {
    expect(release()).toBeDefined();
    expect(release().status).toBe('published');
    expect(release().revision).toBe(1);
    expect(visibleReleases(RELEASES, everyone).map((r) => r.id)).toContain(ID);
    const list = buildReleaseList(RELEASES, everyone, [], null);
    expect(list.releases.map((r) => r.id)).toContain(ID);
    // The notice offers the newest unread release: the two order signature
    // releases and the approval release were published after this one.
    expect(list.latestUnread?.id).toBe('approval-follows-permission-2026-10');
    // An old phone build lists at most three unread releases, newest first:
    // once the newer releases are read, this one, the refusal's and the
    // session-ended fix's.
    const newer = Object.fromEntries(
      RELEASES.slice(0, RELEASES.findIndex((r) => r.id === ID)).map((r) => [r.id, true]),
    );
    expect(legacyAnnouncementsFor(RELEASES, everyone, newer).map((a) => a.id)).toEqual([
      ID,
      'account-deletion-refused-2026-10',
      'exceptions-session-ended-2026-10',
    ]);
    expect(registryFingerprint(RELEASES)).toContain(ID);
    expect(ANNOUNCEMENTS.map((a) => a.id)).toContain(ID);
    // A real time on a whole minute, after the phone update was published
    // (2026-10-03 23:24Z) and the walk ended (23:45Z): never the draft's
    // placeholder date.
    expect(release().publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/);
    expect(Date.parse(release().publishedAt)).toBeGreaterThan(Date.parse('2026-10-03T23:45:00Z'));
    expect(Date.parse(release().publishedAt)).toBeLessThanOrEqual(Date.parse('2026-10-05T00:00:00Z'));
  });

  it('is dated after every release below it (pinned by id), the refusal directly below it; releases above it were published later', () => {
    const at = RELEASES.findIndex((r) => r.id === ID);
    expect(at).toBeGreaterThanOrEqual(0);
    // No draft is left below it; the order signature releases sit directly
    // above it.
    expect(RELEASES.slice(at + 1).every((r) => r.status === 'published' || r.status === 'withdrawn')).toBe(true);
    expect(RELEASES[at - 1]?.id).toBe('order-signature-image-2026-10');
    for (const r of RELEASES.slice(0, at)) {
      expect(Date.parse(r.publishedAt), r.id).toBeGreaterThan(Date.parse(release().publishedAt));
    }
    for (const r of RELEASES.slice(at + 1)) {
      expect(Date.parse(release().publishedAt), r.id).toBeGreaterThan(Date.parse(r.publishedAt));
    }
    expect(RELEASES[at + 1]?.id).toBe('account-deletion-refused-2026-10');
    expect(RELEASES[at + 2]?.id).toBe('exceptions-session-ended-2026-10');
  });

  it('is a fix to Account for everyone, with no link, and every reader is told', () => {
    expect(release().audience).toBeUndefined();
    expect(release().entries.map((e) => e.id)).toEqual(['account-deletion-orders']);
    const [entry] = release().entries;
    expect(entry!.category).toBe('fixed');
    expect(entry!.area).toBe('Account');
    expect(entry!.link).toBeUndefined();
    expect(entry!.audience).toBeUndefined();
    for (const role of ['viewer', 'staff', 'manager', 'admin', 'owner'] as const) {
      const seen = visibleReleases([release()], { role, permissions: [], enabledModules: [] });
      expect(seen.map((r) => r.id), role).toEqual([ID]);
    }
  });

  // Publish claim check 2026-10-04, against the merged code (562d1f0c) and
  // the Demo Co production walk.
  it('says orders no longer stop a deletion, never that every deletion now works, and where the label shows', () => {
    const r = release();
    const [entry] = r.entries;
    const all = readerText(r).join(' ');
    // Records the organization keeps (received stock, imported POs, schedule
    // entries, returns) still refuse a deletion until slice A3, with the
    // blocked sentence (walk W2 and W3), so nothing says deleting now works:
    // orders no longer stop it. Old phones show only the title and the
    // summary, so both say it that way.
    expect(r.title).toBe('Orders you placed no longer stop you deleting your account');
    expect(entry!.title).toBe(r.title);
    expect(r.summary).toMatch(
      /^Orders you placed no longer stop you deleting your account from Settings, on the web or in the mobile app\. /,
    );
    expect(entry!.whatChanged).toMatch(
      /^Deleting your account from Settings no longer fails because you placed orders\. /,
    );
    expect(all).not.toMatch(/works when you have placed orders|It now works|no longer fails for people who placed orders/);
    expect(entry!.howItAffectsYou).toContain(
      'Other records your organization keeps, such as received stock, can still stop a deletion; the app then says so and changes nothing.',
    );
    // Before 0388 an order with no email on the row refused its requester's
    // deletion (order_requests_identity_chk), which is nearly every order
    // placed in the app; "could" because a row that held an email did not.
    expect(entry!.whyItMatters).toBe(
      'Until now, an order you had placed could stop you deleting your account from Settings, because each order had to name who placed it.',
    );
    // The label the web and the phone render (core DELETED_REQUESTER_LABEL),
    // read from the row: no requester id and no email (core
    // isDeletedRequester). An order that recorded the person's name or email
    // keeps showing it (legacy internal rows and portal rows), so never "your
    // orders show Deleted user" without that.
    expect(DELETED_REQUESTER_LABEL).toBe('Deleted user');
    expect(isDeletedRequester({ requesterUserId: null, requesterEmail: null })).toBe(true);
    expect(isDeletedRequester({ requesterUserId: null, requesterEmail: 'former@example.org' })).toBe(false);
    expect(r.summary).toContain(
      `they show “${DELETED_REQUESTER_LABEL}” as the requester, unless an order recorded your name or email.`,
    );
    expect(entry!.whatChanged).toContain(`show “${DELETED_REQUESTER_LABEL}” as the requester.`);
    expect(entry!.whatChanged).toContain('An order that recorded your name or email keeps showing it.');
    // Where it shows on the web (#312: the list, the order page and print
    // through requesterDisplay, the pick page and the pick slip PDF through
    // detailRequesterName, CSV and PDF exports through orderExportCells), and
    // on the phone's two screens, which need the update (OTA group 4a060cce):
    // old bundles say "External requester".
    expect(entry!.whatChanged).toContain(
      'On the web, the orders list, the order page and its print view, the pick slip and the Orders export show',
    );
    expect(entry!.whatChanged).toContain(
      'In the mobile app, after the latest update, the orders list and the order screen show it too.',
    );
    expect(r.summary).toContain('On the web, and in the mobile app after the latest update, they show');
    // Nothing about the person is copied onto an order (the 0388 trigger
    // writes only requester_deleted_at; pgTAP D14), and open orders keep their
    // status and can still be approved or cancelled (pgTAP D15).
    expect(entry!.howItAffectsYou).toMatch(
      /^Your name and email are not copied onto your orders when you delete your account\. /,
    );
    expect(entry!.howItAffectsYou).toContain('Open orders stay open, and your organization can still approve or cancel them.');
    // What a refusal says is its own release (it needs no phone update).
    expect(all).not.toMatch(/Account deleted|Please try again|general error|could say the account was deleted/);
    // The phone's label is an over-the-air update: it loads when the app is
    // opened again, with no prompt.
    expect(entry!.whatToDo).toBe(
      'No action needed on the web. In the mobile app, close the app completely and open it again to load the latest update.',
    );
    expect(all).not.toMatch(/offers the new version|update the app|App Store/i);
    expect(all).not.toMatch(/\bbooks?\b|%|guarantee|instantly|email(ed)? you|notif|verified/i);
  });
});

/**
 * A refused account deletion says why (security slice A2, #312, 562d1f0c),
 * live with web build 399eedb47aa2. The web self-delete and the phone's POST
 * /api/v1/account/delete now ask account_deletion_check (0388) first: an
 * account linked to records the organization keeps is told
 * ACCOUNT_DELETE_BLOCKED_COPY and nothing is written, where the web used to
 * say "try again" and the phone route answered 200. The phone shows the
 * route's message for any refusal, so every installed phone has it without an
 * update; the Demo Co walk saw it on both. Published with the account deletion
 * release, dated a minute before it, directly below it.
 */
describe('a refused account deletion says why, and is published with the account deletion release', () => {
  const ID = 'account-deletion-refused-2026-10';
  const release = () => RELEASES.find((r) => r.id === ID)!;
  const everyone: ReleaseViewer = {
    role: 'owner',
    permissions: [...PERMISSIONS],
    enabledModules: Object.keys(MODULE_REGISTRY) as ModuleId[],
  };

  it('is published after the web deploy and the Demo Co walk, so every feed carries it', () => {
    expect(release()).toBeDefined();
    expect(release().status).toBe('published');
    expect(release().revision).toBe(1);
    expect(visibleReleases(RELEASES, everyone).map((r) => r.id)).toContain(ID);
    const list = buildReleaseList(RELEASES, everyone, [], null);
    expect(list.releases.map((r) => r.id)).toContain(ID);
    // The notice offers the newest unread release: the account deletion
    // release, the two order signature releases and the approval release were
    // published after this one.
    expect(list.latestUnread?.id).toBe('approval-follows-permission-2026-10');
    // An old phone build lists at most three unread releases, newest first:
    // once the newer releases are read, this one, the session-ended fix's and
    // the count confirm's.
    const newer = Object.fromEntries(
      RELEASES.slice(0, RELEASES.findIndex((r) => r.id === ID)).map((r) => [r.id, true]),
    );
    expect(legacyAnnouncementsFor(RELEASES, everyone, newer).map((a) => a.id)).toEqual([
      ID,
      'exceptions-session-ended-2026-10',
      'count-confirm-2026-10',
    ]);
    expect(registryFingerprint(RELEASES)).toContain(ID);
    expect(ANNOUNCEMENTS.map((a) => a.id)).toContain(ID);
    // A real time on a whole minute, after the walk ended (2026-10-03 23:45Z).
    expect(release().publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/);
    expect(Date.parse(release().publishedAt)).toBeGreaterThan(Date.parse('2026-10-03T23:45:00Z'));
    expect(Date.parse(release().publishedAt)).toBeLessThanOrEqual(Date.parse('2026-10-05T00:00:00Z'));
  });

  it('sits directly below the account deletion release and above the session-ended fix (pinned by id), dated between them', () => {
    const at = RELEASES.findIndex((r) => r.id === ID);
    expect(at).toBeGreaterThan(0);
    expect(RELEASES[at - 1]?.id).toBe('account-deletion-orders-2026-10');
    expect(RELEASES[at + 1]?.id).toBe('exceptions-session-ended-2026-10');
    for (const r of RELEASES.slice(0, at)) {
      expect(Date.parse(r.publishedAt), r.id).toBeGreaterThan(Date.parse(release().publishedAt));
    }
    for (const r of RELEASES.slice(at + 1)) {
      expect(Date.parse(release().publishedAt), r.id).toBeGreaterThan(Date.parse(r.publishedAt));
    }
  });

  it('is a fix to Account for everyone, with no link, and every reader is told', () => {
    expect(release().audience).toBeUndefined();
    expect(release().entries.map((e) => e.id)).toEqual(['account-deletion-refused']);
    const [entry] = release().entries;
    expect(entry!.category).toBe('fixed');
    expect(entry!.area).toBe('Account');
    expect(entry!.link).toBeUndefined();
    expect(entry!.audience).toBeUndefined();
    for (const role of ['viewer', 'staff', 'manager', 'admin', 'owner'] as const) {
      const seen = visibleReleases([release()], { role, permissions: [], enabledModules: [] });
      expect(seen.map((r) => r.id), role).toEqual([ID]);
    }
  });

  // Publish claim check 2026-10-04, against the merged code (562d1f0c) and
  // the Demo Co production walk (W2 on the web, W3 on the phone).
  it("says what the web and the phone now say, in the product's own words, and that the phone needs no update", () => {
    const r = release();
    const [entry] = r.entries;
    const all = readerText(r).join(' ');
    // The sentence the web toast and the phone alert showed in the walk.
    const BLOCKED =
      "Your account can't be deleted from the app because it is linked to records your organization keeps, such as received stock, imported purchase orders or schedule entries. Nothing was changed. Contact StockPilot support to have it removed.";
    // Re-pinned by 0393 (was: account-deletion.ts holds BLOCKED word for
    // word). These words were true against 562d1f0c when A2 published them.
    // 0393 converted every key that refused, so the code's sentence for an
    // integrity refusal (which should no longer happen) is now the support
    // sentence below, and the A3 release (account-deletion-everyone-2026-10,
    // a draft until 0393 ships) supersedes this release's claim.
    const copy = readFileSync(resolve(__dirname, '../../server/lib/account-deletion.ts'), 'utf8');
    expect(copy).not.toContain(`"${BLOCKED}"`);
    expect(copy).toContain(
      "'Your account could not be deleted because it is linked to a record that could not be released. Nothing was changed. Contact StockPilot support.'",
    );
    expect(RELEASES.map((x) => x.id)).toContain('account-deletion-everyone-2026-10');
    // Both surfaces still answer an integrity refusal with that constant, and
    // the phone route no longer answers success for a delete that did not
    // happen.
    const route = readFileSync(resolve(__dirname, '../../app/api/v1/account/delete/route.ts'), 'utf8');
    expect(route).toContain("{ error: 'account_linked_records', message: ACCOUNT_DELETE_BLOCKED_COPY }");
    expect(route).toContain("{ error: 'internal_error', message: ACCOUNT_DELETE_SIGNED_OUT_COPY }");
    const action = readFileSync(resolve(__dirname, '../../server/actions/profile.ts'), 'utf8');
    expect(action).toContain(
      "return err('conflict', ACCOUNT_DELETE_BLOCKED_COPY, { reason: 'account_linked_records' });",
    );
    // Old phones show only the title and the summary: it stands alone and
    // names both platforms.
    expect(r.summary).toBe(
      "On the web and in the mobile app, if your account can't be deleted because it is linked to records your organization keeps, such as received stock, Delete my account now says so. Nothing is changed and you stay signed in. The mobile app no longer says an account was deleted when it was not.",
    );
    // The entry gives the sentence's parts, each in its words.
    for (const part of [
      "can't be deleted from the app",
      'linked to records your organization keeps, such as received stock, imported purchase orders or schedule entries',
      'Contact StockPilot support to have it removed.',
    ]) {
      expect(BLOCKED, part).toContain(part);
    }
    expect(entry!.whatChanged).toBe(
      "If your account is linked to records your organization keeps, such as received stock, imported purchase orders or schedule entries, Delete my account now says it can't be deleted from the app, that nothing was changed, and to contact StockPilot support to have it removed. You stay signed in. The web and the mobile app say the same.",
    );
    // Before: the web wrote a tombstone and an audit row, then answered this
    // after the refused delete; the phone route answered 200, so the phone
    // signed out and said "Account deleted" while the account stayed.
    expect(entry!.whyItMatters).toBe(
      'Before, the web said “Your account could not be deleted right now. Please try again.” Trying again failed the same way. The mobile app could say “Account deleted” and sign you out while the account was still there.',
    );
    expect(entry!.howItAffectsYou).toBe(
      'This happens only to an account linked to such records. The account, your access and those records stay as they were.',
    );
    // The phone shows the route's message for any refusal (settings.tsx
    // performDelete, unchanged by A2), so no update is needed.
    expect(entry!.whatToDo).toBe('No action needed.');
    expect(all).not.toMatch(/latest update|close the app|open it again|update the app|App Store/i);
    expect(all).not.toMatch(/\bbooks?\b|%|guarantee|we (?:emailed|notified)|support (?:was|has been) (?:told|contacted)|ticket/i);
  });
});

/**
 * F2-5 (draft a PO for what an order is short, migration 0385) was held as a
 * DRAFT until the web dialog (web build 8f228006cbc3), the phone's sheet (OTA
 * group 3b457841) and the Demo Co production walk (SO-9 drafted, opened on the
 * web and the phone, then cancelled; 66 checks passed), as F2-1's to F2-4's
 * were. Pinned by id, never by index. This follow-up publishes it. It was the
 * last draft: none is left.
 */
describe('F2-5 (draft a PO for what an order is short) is published', () => {
  const ID = 'order-shortfall-po-2026-10';
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
    // The notice offers the newest unread release: the count confirm's, the
    // session-ended fix's, the two account deletion releases, the two order
    // signature releases and the approval release were published after this
    // one.
    expect(list.latestUnread?.id).toBe('approval-follows-permission-2026-10');
    // An old phone build lists at most three unread releases, newest first:
    // once the newer release is read, this one, F2-4's and Book Order Totals
    // by charter's.
    const newer = Object.fromEntries(
      RELEASES.slice(0, RELEASES.findIndex((r) => r.id === ID)).map((r) => [r.id, true]),
    );
    expect(legacyAnnouncementsFor(RELEASES, everyone, newer).map((a) => a.id)).toEqual([
      ID,
      'order-needed-by-change-2026-10',
      'book-order-totals-charters-dates-2026-10',
    ]);
    expect(registryFingerprint(RELEASES)).toContain(ID);
    expect(ANNOUNCEMENTS.map((a) => a.id)).toContain(ID);
    // A real time on a whole minute, after the walk ended (2026-09-30 16:15Z):
    // never the draft's placeholder date.
    expect(release().publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/);
    expect(Date.parse(release().publishedAt)).toBeGreaterThan(Date.parse('2026-09-30T16:15:00Z'));
    expect(Date.parse(release().publishedAt)).toBeLessThanOrEqual(Date.parse('2026-10-03T00:00:00Z'));
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
    expect(at).toBeLessThan(RELEASES.findIndex((r) => r.id === 'order-needed-by-change-2026-10'));
  });

  it('is addressed as the page it links to is reached (Orders, for approvers), then as drafting is allowed (a manager with purchase-order access, Purchase orders on)', () => {
    expect(release().audience).toEqual({ anyPermission: ['orders:approve'], modules: ['orders'] });
    expect(release().entries.map((e) => e.id)).toEqual(['order-draft-po-for-shortfall']);
    const [entry] = release().entries;
    expect(entry!.area).toBe('Orders');
    expect(entry!.link).toEqual({ href: '/dashboard/orders', label: 'View orders' });
    expect(entry!.audience).toEqual({
      roles: ['owner', 'admin', 'manager'],
      anyPermission: ['purchase_orders:manage'],
      modules: ['purchase_orders'],
    });
    const reader = (
      role: ReleaseViewer['role'],
      permissions: ReleaseViewer['permissions'],
      enabledModules: ModuleId[] = ['orders', 'purchase_orders'],
    ) => visibleReleases([published()], { role, permissions, enabledModules })[0]?.entries.map((e) => e.id) ?? [];
    expect(reader('manager', ['orders:approve', 'purchase_orders:manage'])).toEqual(['order-draft-po-for-shortfall']);
    expect(reader('admin', ['orders:approve', 'purchase_orders:manage'])).toEqual(['order-draft-po-for-shortfall']);
    expect(reader('owner', ['orders:approve', 'purchase_orders:manage'])).toEqual(['order-draft-po-for-shortfall']);
    // Staff with a purchase_orders:manage override: the database refuses them.
    expect(reader('staff', ['orders:approve', 'purchase_orders:manage'])).toEqual([]);
    // A manager without purchase_orders:manage, or without orders:approve.
    expect(reader('manager', ['orders:approve', 'purchase_orders:read'])).toEqual([]);
    expect(reader('manager', ['purchase_orders:manage'])).toEqual([]);
    // Either module off.
    expect(reader('manager', ['orders:approve', 'purchase_orders:manage'], ['orders'])).toEqual([]);
    expect(reader('manager', ['orders:approve', 'purchase_orders:manage'], ['purchase_orders'])).toEqual([]);
  });

  // Publish claim check 2026-10-02, against the merged code (16437b86) and
  // the Demo Co production walk.
  it('names both platforms and who drafts, keeps to what happens, and never says a draft covers an item for good', () => {
    const r = release();
    const [entry] = r.entries;
    // Old phone builds show only the summary: it names both platforms, who
    // may draft, the draft for items with no supplier, and that drafts are
    // not sent.
    expect(r.summary).toMatch(/^On the web and in the mobile app, managers, admins and owners who can manage purchase orders /);
    expect(r.summary).toContain('One draft is made per supplier, plus one for items with no supplier, and drafts are not sent.');
    const text = readerText(r).join(' ');
    // The words the screens say, from core.
    expect(text).toContain('Draft PO for what is short');
    expect(text).toContain('drafts are not sent');
    expect(text).toContain('one draft purchase order is made per supplier, plus one for items with no supplier');
    // Who: the database's floors (a manager or above holding
    // purchase_orders:manage), the permission by its matrix name. Owners and
    // admins draft too, so never "a manager role".
    expect(entry!.howItAffectsYou).toMatch(
      /^Drafting is for managers, admins and owners with the Manage purchase orders permission\. /,
    );
    expect(text).not.toContain('a manager role');
    // Nothing goes to a supplier and no email or in-app notification goes
    // out, but the organization's integrations hear of each new PO
    // (po.created, as for every draft PO), so never "not sent to anyone".
    expect(text).toContain('Drafts are not sent to suppliers or emailed');
    expect(text).not.toMatch(/not sent to anyone/);
    // The button shows only while something is left to draft.
    expect(entry!.whatChanged).toMatch(/^When an order is short and something is left to draft, /);
    // Covered items are not drafted again, but supply other approved orders
    // need does not count as cover: in the walk SO-9 still offered 50 after a
    // 180 draft (SO-8, backordered, needs 50 of it), by design (core
    // readiness.ts draftable, 0385 order_shortfall_draftable).
    expect(text).toContain('is not drafted again');
    expect(text).toContain(
      'What other approved orders need from them does not count as cover, so after a draft an item can still have more to draft.',
    );
    expect(entry!.whatChanged).toContain('what other approved orders already need from them');
    expect(r.summary).toContain("the part that the stock on record, open POs and drafts don't already cover, after what other approved orders need from them");
    expect(text).not.toContain('if other approved orders already need that supply, it says that too');
    // Review: the function refuses only when LESS can be drafted than was
    // chosen; a change that leaves the choice possible drafts normally. A
    // chosen item with nothing left is unticked, so "your choices are kept"
    // was too strong.
    expect(text).toContain(
      'If stock or POs change so that less can be drafted than you chose, nothing is drafted, and the most that can be drafted now is shown.',
    );
    expect(text).not.toContain('If stock or POs changed after the order was checked, nothing is drafted');
    expect(text).not.toContain('your choices are kept');
    expect(text).toContain('Pressing Draft twice drafts once.');
    expect(text).toContain('Kits are not drafted; order their components.');
    // The phone shows a draft PO for review, with Back, to order on the web.
    // Its attachments card stays, so the screen is not called read-only.
    expect(entry!.whatChanged).toContain(
      "The mobile app's order screen offers the same; there a draft PO opens for review, with Back, and is ordered on the web.",
    );
    expect(text).not.toMatch(/read-only/i);
    // Readiness already showed what was short and what covered it; the work
    // was copying it into a PO by hand, one supplier at a time.
    expect(entry!.whyItMatters).toContain('one supplier at a time');
    expect(entry!.whyItMatters).not.toContain('working out by hand what was already on order');
    // The phone part is an over-the-air update: it loads when the app is
    // opened again, with no prompt.
    expect(entry!.whatToDo).toBe(
      'No action needed on the web. In the mobile app, close the app completely and open it again to load the latest update. On a short order, choose Draft PO for what is short.',
    );
    expect(text).not.toMatch(/offers the new version|update the app|App Store/i);
    expect(text).toContain('stock on record');
    expect(text).not.toMatch(/\bbooks?\b|%|guarantee|verified|was sent|we (?:emailed|notified)|supplier (?:is|was) (?:told|notified)/i);
  });
});

/**
 * F2-4 (change an order's needed-by date; the schedule follows, migration
 * 0383) was held as a DRAFT until the web Change dialog (web build
 * a5666549db6b), the phone's sheet (OTA group e301d35b) and the Demo Co
 * production walk (SO-15 pending, SO-16 approved then cancelled, a Schedule
 * test event), as F2-1's to F2-3's were. Pinned by id, never by index. This
 * follow-up publishes it.
 */
describe("F2-4 (change an order's needed-by date) is published", () => {
  const ID = 'order-needed-by-change-2026-10';
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
    // The notice offers the newest unread release: F2-5's, the count confirm's,
    // the session-ended fix's, the two account deletion releases, the two order
    // signature releases and the approval release were published after this
    // one.
    expect(list.latestUnread?.id).toBe('approval-follows-permission-2026-10');
    // An old phone build lists at most three unread releases, newest first:
    // once the newer release is read, this one, Book Order Totals by
    // charter's and the count difference words'.
    const newer = Object.fromEntries(
      RELEASES.slice(0, RELEASES.findIndex((r) => r.id === ID)).map((r) => [r.id, true]),
    );
    expect(legacyAnnouncementsFor(RELEASES, everyone, newer).map((a) => a.id)).toEqual([
      ID,
      'book-order-totals-charters-dates-2026-10',
      'count-difference-words-2026-10',
    ]);
    expect(registryFingerprint(RELEASES)).toContain(ID);
    expect(ANNOUNCEMENTS.map((a) => a.id)).toContain(ID);
    expect(Date.parse(release().publishedAt)).toBeLessThanOrEqual(Date.parse('2026-10-01T00:00:00Z'));
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

  it('is addressed as the pages it links to are reached: the change to approvers, the Schedule fix to Schedule editors', () => {
    expect(release().audience).toBeUndefined();
    expect(release().entries.map((e) => e.id)).toEqual(['order-needed-by-change', 'schedule-move-rearms-reminders']);
    const [change, schedule] = release().entries;
    expect(change!.audience).toEqual({ anyPermission: ['orders:approve'], modules: ['orders'] });
    expect(change!.link).toEqual({ href: '/dashboard/orders', label: 'View orders' });
    expect(change!.area).toBe('Orders');
    expect(schedule!.audience).toEqual({ anyPermission: ['schedule:manage'], modules: ['schedule'] });
    expect(schedule!.link).toEqual({ href: '/dashboard/schedule', label: 'Open Schedule' });
    expect(schedule!.area).toBe('Schedule');
    const reader = (permissions: ReleaseViewer['permissions'], enabledModules: ModuleId[] = ['orders', 'schedule']) =>
      visibleReleases([published()], { role: 'viewer', permissions, enabledModules })[0]?.entries.map((e) => e.id) ?? [];
    expect(reader(['orders:approve', 'schedule:manage'])).toEqual([
      'order-needed-by-change',
      'schedule-move-rearms-reminders',
    ]);
    expect(reader(['orders:approve'])).toEqual(['order-needed-by-change']);
    expect(reader(['schedule:manage'])).toEqual(['schedule-move-rearms-reminders']);
    // A requester, a picker and a Schedule reader change nothing here.
    expect(reader(['orders:request', 'items:update', 'schedule:read'])).toEqual([]);
    expect(reader(['orders:approve', 'schedule:manage'], [])).toEqual([]);
  });

  it('names both platforms, keeps to what happens, and never claims an email', () => {
    const r = release();
    expect(r.summary).toMatch(/^On the web and in the mobile app, /);
    const text = readerText(r).join(' ');
    expect(text).toContain("your organization's time zone");
    // The order page and the phone card print the date without a zone; only
    // the Change dialog and sheet name it ("Times are in …").
    expect(text).toContain("your organization's time zone, which the Change window names");
    expect(text).not.toContain('which the order names');
    expect(text).toContain('If someone saved a different date while you were editing, nothing is changed');
    // The revision itself emails no one; the reminders it re-arms still go
    // out (the cron emails managers and the assignee near the new time).
    expect(text).toContain('The change itself sends no email');
    expect(text).toContain('Schedule reminders for the new time go out as usual.');
    // 0383 swaps only the date sentence StockPilot wrote in the entry's
    // description; a description rewritten by hand is kept as it is, so its
    // date is not promised to change (publish claim check 2026-09-30).
    expect(text).toContain('anything your team added to the description stays');
    expect(text).toContain('the date StockPilot wrote in its description changes');
    expect(text).not.toMatch(/the date in its description changes/);
    // Only an entry that has not started is reminded (the cron reminds
    // scheduled entries only), in the summary too (an in-progress entry
    // moves but is not reminded).
    expect(text).toContain("if the entry hasn't started, its reminders are set again for the new time");
    expect(r.summary).toContain("if the entry hasn't started, its reminders are set again for the new time");
    expect(text).toContain('A completed or cancelled Schedule entry stays as it is.');
    // The Schedule page's edit is web-only (the phone does not edit events).
    expect(release().entries[1]!.whatChanged).toMatch(/^On the web, /);
    // Before the fix the cron still sent the one-hour reminder after a move
    // that followed only the day-ahead one: the old wording said "never".
    expect(release().entries[1]!.whyItMatters).not.toMatch(/never reminded/);
    expect(release().entries[1]!.whyItMatters).toContain('got no day-ahead reminder for its new one');
    expect(text).not.toMatch(/\bbooks?\b|%|guarantee|verified|was sent|we (?:emailed|notified)/i);
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
    // The notice offers the newest unread release: F2-3's, the Sports fields',
    // the count difference words', Book Order Totals by charter's, F2-4's,
    // F2-5's, the count confirm's, the session-ended fix's, the two account
    // deletion releases, the two order signature releases and the approval
    // release were published after this one.
    expect(list.latestUnread?.id).toBe('approval-follows-permission-2026-10');
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
 * Book Order Totals by charter and exact dates (0382) was held as a DRAFT
 * until 0382, the web deploy (and the calendar fix, #300), the phone update
 * (OTA group 37e7ada7), the Demo Co production checks on the web and the phone
 * and the phone adoption check (plan R8b: an older phone ignores a charter in
 * a link). Pinned by id, never by index. This follow-up publishes it.
 */
describe('Book Order Totals by charter and dates is published', () => {
  const ID = 'book-order-totals-charters-dates-2026-10';
  const release = () => RELEASES.find((r) => r.id === ID)!;
  const everyone: ReleaseViewer = {
    role: 'owner',
    permissions: [...PERMISSIONS],
    enabledModules: Object.keys(MODULE_REGISTRY) as ModuleId[],
  };
  const published = (): Release => ({ ...release(), status: 'published' });

  it('is published after the web deploy, the phone update and the Demo Co checks, so every feed carries it', () => {
    expect(release()).toBeDefined();
    expect(release().status).toBe('published');
    expect(release().revision).toBe(1);
    expect(visibleReleases(RELEASES, everyone).map((r) => r.id)).toContain(ID);
    const list = buildReleaseList(RELEASES, everyone, [], null);
    expect(list.releases.map((r) => r.id)).toContain(ID);
    // The notice offers the newest unread release: F2-4's, F2-5's, the count
    // confirm's, the session-ended fix's, the two account deletion releases,
    // the two order signature releases and the approval release were published
    // after this one.
    expect(list.latestUnread?.id).toBe('approval-follows-permission-2026-10');
    // An old phone build lists at most three unread releases, newest first;
    // this one comes into that list once the newer releases are read.
    const newer = Object.fromEntries(
      RELEASES.slice(0, RELEASES.findIndex((r) => r.id === ID)).map((r) => [r.id, true]),
    );
    expect(legacyAnnouncementsFor(RELEASES, everyone, newer).map((a) => a.id)).toContain(ID);
    expect(registryFingerprint(RELEASES)).toContain(ID);
    expect(ANNOUNCEMENTS.map((a) => a.id)).toContain(ID);
    expect(Date.parse(release().publishedAt)).toBeLessThanOrEqual(Date.parse('2026-10-01T00:00:00Z'));
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
    // The same update brings the phone's Charter filter and calendar
    // (publish claim check 2026-09-30), not only charter links.
    expect(charter!.howItAffectsYou).toContain(
      'In the mobile app, close the app completely and open it again to load the latest update, which brings the Charter filter and the calendar, and opens links that choose a charter.',
    );
    expect(readerText(r).join(' ')).not.toMatch(/update the app|App Store|new version/i);
    expect(charter!.whatChanged).toContain('Books ordered by charter');
    // The week the SQL computes (plan D5) and the words the screens use.
    expect(dates!.whatChanged).toContain('Today and This week (starting Sunday)');
    // Custom range existed before (two date fields); the calendar is what is
    // new, and it opens from Custom range (or a date field on the web).
    expect(dates!.whatChanged).toContain('Custom range under Orders placed now opens a calendar');
    expect(dates!.whatChanged).not.toMatch(/^Orders placed now opens a calendar/);
    // The address and the order page's back link are the web's; the phone
    // keeps the report's state in memory.
    expect(dates!.howItAffectsYou).toContain("On the web, the page's address keeps the charter, dates, search and page");
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
 * count difference, held as a DRAFT until the web deploy, the phone update
 * (OTA group 749c0489, shared with the Sports fields) and the Demo Co walk
 * were done. Release 2 (confirming a count, migration 0386) is not live, so
 * nothing here promises it. Pinned by id, never by index. This follow-up
 * publishes it.
 */
describe('count differences say what clears them (release 1) is published', () => {
  const ID = 'count-difference-words-2026-10';
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
    // The notice offers the newest unread release: Book Order Totals by
    // charter's, F2-4's, F2-5's, the count confirm's, the session-ended fix's,
    // the two account deletion releases, the two order signature releases and
    // the approval release were published after this one.
    expect(list.latestUnread?.id).toBe('approval-follows-permission-2026-10');
    // An old phone build lists at most three unread releases, newest first;
    // this one comes into that list once the newer releases are read.
    const newer = Object.fromEntries(
      RELEASES.slice(0, RELEASES.findIndex((r) => r.id === ID)).map((r) => [r.id, true]),
    );
    expect(legacyAnnouncementsFor(RELEASES, everyone, newer).map((a) => a.id)).toContain(ID);
    expect(registryFingerprint(RELEASES)).toContain(ID);
    expect(ANNOUNCEMENTS.map((a) => a.id)).toContain(ID);
    expect(Date.parse(release().publishedAt)).toBeLessThanOrEqual(Date.parse('2026-10-01T00:00:00Z'));
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

  it('is for readers of exceptions where Cycle Counts is on, linking to Exceptions', () => {
    expect(release().audience).toBeUndefined();
    expect(release().entries.map((e) => e.id)).toEqual(['count-difference-what-clears-it', 'phone-exception-note-keyboard']);
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

  // The R1 walk's keyboard finding (iPhone 17 at the largest text size): the
  // note sheets on every exception and the photo sheets, so it is for the
  // people who can acknowledge and add photos, with or without Cycle Counts.
  it('tells the people who can act on exceptions that the note stays in view on the phone', () => {
    const entry = release().entries.find((e) => e.id === 'phone-exception-note-keyboard')!;
    expect(entry.category).toBe('fixed');
    expect(entry.area).toBe('Mobile app');
    expect(entry.link).toEqual({ href: '/dashboard/exceptions', label: 'Open Exceptions' });
    expect(entry.audience).toEqual({ anyPermission: ['stock:adjust'] });
    const reader = (permissions: ReleaseViewer['permissions'], enabledModules: ModuleId[] = []) =>
      visibleReleases([published()], { role: 'staff', permissions, enabledModules })[0]?.entries.map((e) => e.id) ?? [];
    expect(reader(['items:read', 'stock:adjust'])).toEqual(['phone-exception-note-keyboard']);
    expect(reader(['items:read'])).toEqual([]);
    const text = `${entry.title} ${entry.whatChanged} ${entry.whyItMatters} ${entry.howItAffectsYou}`;
    expect(text).toContain('stays in view above the keyboard');
    expect(text).toContain('puts the keyboard away without sending anything');
    expect(text).toContain('the photo sheets now fit above the keyboard');
    // Older phones show only the title and the summary.
    expect(release().summary).toContain('In the mobile app, the note you type on an exception stays in view above the keyboard.');
    expect(text).not.toMatch(/always|every text size|guarantee|never hidden/i);
    // Publish claim check 2026-09-30 (kb/PROGRESS.txt, main at 20:03): before
    // R1 the note field was still partly in view with the keyboard open; what
    // went off screen was the sheet's title and Close. The sheets changed with
    // the keyboard down too (height, 44 pt Close), so that is not denied.
    expect(entry.whyItMatters).not.toMatch(/a field you could not see/);
    expect(entry.whyItMatters).toContain('taking their title and Close with them');
    expect(entry.howItAffectsYou).not.toMatch(/Nothing changes until the keyboard opens/);
    // Removing a photo asks for a reason, not a note.
    expect(entry.whatChanged).toContain('the reason, when you remove a photo');
    // The phone part is an over-the-air update: it loads when the app is
    // opened again, with no prompt (use-ota-updates.ts), so never "when it
    // offers the new version".
    expect(entry.whatToDo).toBe('Close the app completely and open it again to load the latest update.');
    expect(readerText(release()).join(' ')).not.toMatch(/offers the new version/);
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
    // R1 also made Acknowledge the plain button on a count difference (web
    // occurrence-actions.tsx, phone exceptions/[id].tsx): said, not hidden.
    expect(text).toContain('on a count difference, Acknowledge is no longer the filled button');
    // Release 2 introduces confirming: nothing here may promise it.
    expect(text).not.toMatch(/confirm/i);
    expect(text).not.toMatch(/\bbooks?\b|%|guarantee|verified|accurate/i);
  });
});

/**
 * The Sports required details and New rental item fix (#302, no migration)
 * was held as a DRAFT until the web deploy, the phone update (OTA group
 * 749c0489, shared with the count difference words) and the Demo Co walk were
 * done. Pinned by id, never by index. This follow-up publishes it.
 */
describe('the Sports required details release is published', () => {
  const ID = 'sports-required-fields-2026-10';
  const release = () => RELEASES.find((r) => r.id === ID)!;
  const everyone: ReleaseViewer = {
    role: 'owner',
    permissions: [...PERMISSIONS],
    enabledModules: Object.keys(MODULE_REGISTRY) as ModuleId[],
  };

  it('is published after the web deploy, the phone update and the Demo Co walk, so every feed carries it', () => {
    expect(release()).toBeDefined();
    expect(release().status).toBe('published');
    expect(release().revision).toBe(1);
    expect(visibleReleases(RELEASES, everyone).map((r) => r.id)).toContain(ID);
    const list = buildReleaseList(RELEASES, everyone, [], null);
    expect(list.releases.map((r) => r.id)).toContain(ID);
    // The notice offers the newest unread release: the count difference words',
    // Book Order Totals by charter's, F2-4's, F2-5's, the count confirm's, the
    // session-ended fix's, the two account deletion releases, the two order
    // signature releases and the approval release were published after this
    // one.
    expect(list.latestUnread?.id).toBe('approval-follows-permission-2026-10');
    // An old phone build lists at most three unread releases, newest first;
    // this one comes into that list once the newer releases are read.
    const newer = Object.fromEntries(
      RELEASES.slice(0, RELEASES.findIndex((r) => r.id === ID)).map((r) => [r.id, true]),
    );
    expect(legacyAnnouncementsFor(RELEASES, everyone, newer).map((a) => a.id)).toContain(ID);
    expect(registryFingerprint(RELEASES)).toContain(ID);
    expect(ANNOUNCEMENTS.map((a) => a.id)).toContain(ID);
    expect(Date.parse(release().publishedAt)).toBeLessThanOrEqual(Date.parse('2026-10-01T00:00:00Z'));
  });

  it("is dated after every release below it (pinned by id), directly above F2-3's; releases above it were published later", () => {
    const at = RELEASES.findIndex((r) => r.id === ID);
    expect(at).toBeGreaterThanOrEqual(0);
    expect(RELEASES[at + 1]!.id).toBe('order-fix-holding-up-2026-10');
    for (const r of RELEASES.slice(0, at)) {
      expect(Date.parse(r.publishedAt), r.id).toBeGreaterThan(Date.parse(release().publishedAt));
    }
    for (const r of RELEASES.slice(at + 1)) {
      expect(Date.parse(release().publishedAt), r.id).toBeGreaterThan(Date.parse(r.publishedAt));
    }
  });

  it('is addressed as each page and action checks: New item and PO imports where Sports is on, New rental item where Rentals is on', () => {
    expect(release().audience).toBeUndefined();
    expect(release().entries.map((e) => e.id)).toEqual([
      'sports-new-item-required-fields',
      'sports-po-import-typed-size',
      'rental-new-item-one-at-a-time',
    ]);
    const [item, po, rental] = release().entries;
    expect(item!.audience).toEqual({ anyPermission: ['items:create'], modules: ['sports'] });
    expect(po!.audience).toEqual({ anyPermission: ['purchase_orders:manage'], modules: ['sports'] });
    expect(rental!.audience).toEqual({ anyPermission: ['items:create'], modules: ['rentals'] });
    for (const e of release().entries) expect(e.link, e.id).toBeUndefined();
    const reader = (permissions: ReleaseViewer['permissions'], enabledModules: ModuleId[]) =>
      visibleReleases([release()], { role: 'staff', permissions, enabledModules })[0]?.entries.map((e) => e.id) ?? [];
    expect(reader(['items:create'], ['sports'])).toEqual(['sports-new-item-required-fields']);
    expect(reader(['purchase_orders:manage'], ['sports'])).toEqual(['sports-po-import-typed-size']);
    expect(reader(['items:create'], ['rentals'])).toEqual(['rental-new-item-one-at-a-time']);
    expect(reader(['items:read'], ['sports', 'rentals'])).toEqual([]);
    expect(reader(['items:create', 'purchase_orders:manage'], [])).toEqual([]);
  });

  // Publish claim check 2026-09-30: the phone names a missing detail in an
  // alert, never under the field; a Sports category with a size scale
  // (Jerseys and Shoes in both Sports organizations) takes the per-size rows
  // there; Create items on a PO import and New rental item are web screens
  // (the phone's PO import sends no category, and its rentals/new makes a
  // rental, not a rental item); the phone update loads on the next launch
  // with no prompt (use-ota-updates.ts).
  it('says which platform does what, and how the phone gets it', () => {
    const r = release();
    const [item, po, rental] = r.entries;
    // Old phone builds show only the summary: it names both platforms, and
    // puts "under the field" on the web only.
    expect(r.summary).toMatch(/^On the web, New item now marks the details a Sports category needs/);
    expect(r.summary).toContain('The mobile app checks the same details before it saves and names the missing one.');
    expect(r.summary).not.toMatch(/^On the web and in the mobile app/);
    expect(r.summary).toContain('On the web, a size typed on a PO import line now answers Missing attribute');
    expect(item!.whatChanged).toMatch(/^On the web, /);
    expect(item!.whatChanged).toContain(
      'In the mobile app, New item checks the same details before it saves and names the missing one in a message, for example Size required on a category with no sizes to pick from.',
    );
    expect(item!.howItAffectsYou).toMatch(/^On the web, if a value is still refused/);
    expect(item!.howItAffectsYou).toContain('In the mobile app, a category with sizes still asks for a quantity on at least one size');
    expect(item!.whatToDo).toBe(
      'No action needed on the web. In the mobile app, close the app completely and open it again to load the latest update.',
    );
    expect(po!.whatChanged).toMatch(/^On the web, in Create items on a PO import, /);
    // A typed size that matches an existing size of the product links the
    // line to that item on Confirm rather than creating one.
    expect(po!.whatChanged).toContain('lets Confirm go ahead');
    expect(po!.whatChanged).not.toContain('lets Confirm create the item');
    expect(rental!.whatChanged).toMatch(/^On the web, New rental item no longer shows size buttons/);
    const text = readerText(r).join(' ');
    expect(text).not.toMatch(/offers the new version|update the app|App Store/i);
    expect(text).not.toMatch(/\bbooks?\b|%|guarantee|verified/i);
  });
});

/**
 * Order secrets, slice B (migration 0389) was held as a DRAFT until 0389 was
 * pushed and verified (2026-10-04 04:23:52Z), the web deploy (#313, 9147755d,
 * web build 98b64dc87a91), the phone's update (OTA group f0a24abc, published
 * 04:27Z, launched on phones) and the Demo Co walk (69 checks passed, nothing
 * signed) were done. Pinned by id, never by index. This follow-up publishes
 * it a minute before slice D's release, with the phone's View signature change
 * announced on its own directly below it (order-signature-image-2026-10).
 */
describe('order secrets slice B (a digital signature on the order timeline) is published', () => {
  const ID = 'order-signature-timeline-2026-10';
  const release = () => RELEASES.find((r) => r.id === ID)!;
  const everyone: ReleaseViewer = {
    role: 'owner',
    permissions: [...PERMISSIONS],
    enabledModules: Object.keys(MODULE_REGISTRY) as ModuleId[],
  };

  it('is published after 0389, the web deploy, the phone update and the Demo Co walk, so every feed carries it', () => {
    expect(release()).toBeDefined();
    expect(release().status).toBe('published');
    expect(release().revision).toBe(1);
    expect(visibleReleases(RELEASES, everyone).map((r) => r.id)).toContain(ID);
    const list = buildReleaseList(RELEASES, everyone, [], null);
    expect(list.releases.map((r) => r.id)).toContain(ID);
    // The notice offers the newest unread release: the approval release was
    // published after this one.
    expect(list.latestUnread?.id).toBe('approval-follows-permission-2026-10');
    // An old phone build lists at most three unread releases, newest first:
    // once the newer release is read, this one, the signature image release
    // and the account deletion release.
    const newer = Object.fromEntries(
      RELEASES.slice(0, RELEASES.findIndex((r) => r.id === ID)).map((r) => [r.id, true]),
    );
    expect(legacyAnnouncementsFor(RELEASES, everyone, newer).map((a) => a.id)).toEqual([
      ID,
      'order-signature-image-2026-10',
      'account-deletion-orders-2026-10',
    ]);
    expect(registryFingerprint(RELEASES)).toContain(ID);
    expect(ANNOUNCEMENTS.map((a) => a.id)).toContain(ID);
    // A real time on a whole minute, after the walk ended (2026-10-04 05:07Z)
    // and the account deletion release (05:35Z): never the draft's
    // placeholder date.
    expect(release().publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/);
    expect(Date.parse(release().publishedAt)).toBeGreaterThan(Date.parse('2026-10-04T05:35:00Z'));
    expect(Date.parse(release().publishedAt)).toBeLessThanOrEqual(Date.parse('2026-10-05T00:00:00Z'));
  });

  it("sits directly below slice D's release and above the signature image release (pinned by id), a minute from each", () => {
    const at = RELEASES.findIndex((r) => r.id === ID);
    expect(at).toBeGreaterThan(0);
    expect(RELEASES[at - 1]?.id).toBe('approval-follows-permission-2026-10');
    expect(RELEASES[at + 1]?.id).toBe('order-signature-image-2026-10');
    expect(RELEASES[at + 2]?.id).toBe('account-deletion-orders-2026-10');
    for (const r of RELEASES.slice(0, at)) {
      expect(Date.parse(r.publishedAt), r.id).toBeGreaterThan(Date.parse(release().publishedAt));
    }
    for (const r of RELEASES.slice(at + 1)) {
      expect(Date.parse(release().publishedAt), r.id).toBeGreaterThan(Date.parse(r.publishedAt));
    }
    expect(Date.parse(RELEASES[at - 1]!.publishedAt) - Date.parse(release().publishedAt)).toBe(60_000);
    expect(Date.parse(release().publishedAt) - Date.parse(RELEASES[at + 1]!.publishedAt)).toBe(60_000);
  });

  it('is told to the people who see the order timeline (View audit log), where Orders is on', () => {
    const r = release();
    // The timeline reads audit_logs through the viewer's own client, and its
    // policy asks activity_logs:read (0279); anyone else sees "No events
    // yet." So a staff member granted orders:approve, who does not hold it by
    // default, is not told about a line they cannot see.
    const policy = readFileSync(
      resolve(__dirname, '../../../../../supabase/migrations/0279_auditor_read_permissions.sql'),
      'utf8',
    );
    expect(policy).toContain("using (organization_id in (select public.rls_orgs_with_permission('activity_logs:read')))");
    expect(PERMISSION_META['activity_logs:read'].label).toBe('View audit log');
    expect(r.audience).toEqual({ anyPermission: ['activity_logs:read'], modules: ['orders'] });
    expect(r.entries.map((e) => e.id)).toEqual(['order-timeline-signature-collected']);
    const [entry] = r.entries;
    expect(entry!.category).toBe('improved');
    expect(entry!.area).toBe('Orders');
    expect(entry!.link).toBeUndefined();
    expect(entry!.audience).toBeUndefined();
    const seen = (role: ReleaseViewer['role'], permissions: ReleaseViewer['permissions'], modules: ModuleId[] = ['orders']) =>
      visibleReleases([r], { role, permissions, enabledModules: modules }).map((x) => x.id);
    expect(seen('manager', ['orders:request', 'orders:approve', 'activity_logs:read'])).toEqual([ID]);
    expect(seen('viewer', ['orders:request', 'activity_logs:read'])).toEqual([ID]);
    expect(seen('staff', ['orders:request', 'orders:approve'])).toEqual([]);
    expect(seen('owner', [...PERMISSIONS], [])).toEqual([]);
  });

  // Publish claim check 2026-10-04, against the merged code (9147755d), the
  // local E2E (B-NOTES: the link path and the member path each put Signature
  // collected on the timeline) and the Demo Co production walk.
  it("says the one line in the timeline's own words, promises no collector name, and needs no phone update", () => {
    const r = release();
    const [entry] = r.entries;
    const text = readerText(r).join(' ');
    // The order timeline's label for the event, which the sign route writes on
    // every digital hand-over (the link path and the member path).
    const timeline = readFileSync(resolve(__dirname, '../../components/orders/order-timeline.tsx'), 'utf8');
    expect(timeline).toContain("'order.signature_collected': 'Signature collected',");
    const route = readFileSync(resolve(__dirname, '../../app/api/orders/sign/route.ts'), 'utf8');
    expect(route).toContain("event: 'order.signature_collected',");
    // The line, not the signature image, is what the timeline shows.
    expect(r.title).toBe("A digital signature now adds Signature collected to the order's timeline");
    expect(r.summary).toBe(
      "On the web, the order's timeline now shows Signature collected when a customer signs for an order on the signature page or on the mobile app's signature pad.",
    );
    expect(entry!.whatChanged).toContain("the order's timeline on the web now shows Signature collected.");
    // A paper signature writes order_request.status_changed (a Status
    // changed entry); before 0389 the sign route wrote no audit row.
    expect(entry!.whyItMatters).toBe(
      'A paper signature left an entry on the timeline, but a digital one left none, so the timeline did not show when the order was handed over.',
    );
    // No backfill: only hand-overs since 0389 write the row.
    expect(entry!.howItAffectsYou).toBe(
      'Nothing changes in how you collect a signature. Signatures collected before this change are not added to the timeline.',
    );
    // Desk check F4: the link path (the web panel, a printed QR, the phone's
    // scan tab) records no collector, which the timeline shows as Public.
    expect(text).not.toMatch(/who collected|name of the person|collected by|signed in/i);
    // Every installed phone hands over through the same route, so the line
    // needs no update. The View signature change is its own release.
    expect(entry!.whatToDo).toBe('No action needed.');
    expect(text).not.toMatch(/latest update|close the app|View signature/i);
    expect(text).not.toMatch(/\bbooks?\b|token|hash|secret|%/i);
  });
});

/**
 * The phone's View signature (slice B, #313, 9147755d; OTA group f0a24abc)
 * reads the image through GET /api/v1/orders/<id>/signature, the web panel's
 * route, whose gate is isHandOverEntitled: the effective orders:approve or the
 * order's assigned driver. Anyone else gets the dialog's empty state, the
 * signer's name and time. It used to read signature_data_url straight from the
 * order row, which every member reads. Published with the timeline release,
 * dated a minute before it, directly below it.
 */
describe('the signature image in the mobile app is for approvers and the driver, published with slice B', () => {
  const ID = 'order-signature-image-2026-10';
  const release = () => RELEASES.find((r) => r.id === ID)!;
  const everyone: ReleaseViewer = {
    role: 'owner',
    permissions: [...PERMISSIONS],
    enabledModules: Object.keys(MODULE_REGISTRY) as ModuleId[],
  };
  const LABEL = PERMISSION_META['orders:approve'].label;

  it('is published with the timeline release, so every feed carries it', () => {
    expect(release()).toBeDefined();
    expect(release().status).toBe('published');
    expect(release().revision).toBe(1);
    expect(visibleReleases(RELEASES, everyone).map((r) => r.id)).toContain(ID);
    const list = buildReleaseList(RELEASES, everyone, [], null);
    expect(list.releases.map((r) => r.id)).toContain(ID);
    // The notice offers the newest unread release: the timeline release and
    // the approval release were published after this one.
    expect(list.latestUnread?.id).toBe('approval-follows-permission-2026-10');
    // An old phone build lists at most three unread releases, newest first:
    // once the newer releases are read, this one and the two account deletion
    // releases.
    const newer = Object.fromEntries(
      RELEASES.slice(0, RELEASES.findIndex((r) => r.id === ID)).map((r) => [r.id, true]),
    );
    expect(legacyAnnouncementsFor(RELEASES, everyone, newer).map((a) => a.id)).toEqual([
      ID,
      'account-deletion-orders-2026-10',
      'account-deletion-refused-2026-10',
    ]);
    expect(registryFingerprint(RELEASES)).toContain(ID);
    expect(ANNOUNCEMENTS.map((a) => a.id)).toContain(ID);
    // A real time on a whole minute, after the account deletion release.
    expect(release().publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/);
    expect(Date.parse(release().publishedAt)).toBeGreaterThan(Date.parse('2026-10-04T05:35:00Z'));
    expect(Date.parse(release().publishedAt)).toBeLessThanOrEqual(Date.parse('2026-10-05T00:00:00Z'));
  });

  it('sits directly below the timeline release and above the account deletion release (pinned by id), dated between them', () => {
    const at = RELEASES.findIndex((r) => r.id === ID);
    expect(at).toBeGreaterThan(0);
    expect(RELEASES[at - 1]?.id).toBe('order-signature-timeline-2026-10');
    expect(RELEASES[at + 1]?.id).toBe('account-deletion-orders-2026-10');
    for (const r of RELEASES.slice(0, at)) {
      expect(Date.parse(r.publishedAt), r.id).toBeGreaterThan(Date.parse(release().publishedAt));
    }
    for (const r of RELEASES.slice(at + 1)) {
      expect(Date.parse(release().publishedAt), r.id).toBeGreaterThan(Date.parse(r.publishedAt));
    }
  });

  it('is a fix to Orders for every member where Orders is on, with no link', () => {
    expect(release().audience).toEqual({ modules: ['orders'] });
    expect(release().entries.map((e) => e.id)).toEqual(['order-signature-image-mobile']);
    const [entry] = release().entries;
    expect(entry!.category).toBe('fixed');
    expect(entry!.area).toBe('Orders');
    expect(entry!.link).toBeUndefined();
    expect(entry!.audience).toBeUndefined();
    // Anyone can open a signed order in the mobile app, so every role is told.
    for (const role of ['viewer', 'staff', 'manager', 'admin', 'owner'] as const) {
      const seen = visibleReleases([release()], { role, permissions: [], enabledModules: ['orders'] });
      expect(seen.map((r) => r.id), role).toEqual([ID]);
    }
    expect(visibleReleases([release()], { role: 'owner', permissions: [...PERMISSIONS], enabledModules: [] })).toEqual([]);
  });

  // Publish claim check 2026-10-04, against the merged code (9147755d) and
  // the Demo Co production walk (P1: View signature on the published bundle).
  it("says who sees the image in the route's own terms, and that the phone has it after the latest update", () => {
    const r = release();
    const [entry] = r.entries;
    const text = readerText(r).join(' ');
    // The route's gate, which the phone now asks through its /api/v1 alias.
    const route = readFileSync(resolve(__dirname, '../../app/api/orders/[id]/signature/route.ts'), 'utf8');
    expect(route).toContain('if (!isHandOverEntitled(ctx, {');
    const secrets = readFileSync(resolve(__dirname, '../../server/lib/order-secrets.ts'), 'utf8');
    expect(secrets).toContain("if (can(ctx, 'orders:approve')) return true;\n  return isAssignedDriver(ctx, order);");
    expect(LABEL).toBe('Approve / fulfill orders');
    // Old phones show only the title and the summary: it stands alone.
    expect(r.title).toBe('Only approvers and the driver see a signature image in the mobile app');
    expect(entry!.title).toBe(r.title);
    expect(r.summary).toBe(entry!.whatChanged);
    expect(r.summary).toBe(
      `In the mobile app, after the latest update, View signature on an order shows the customer's signature image only to people with the "${LABEL}" permission and to the order's assigned driver. Anyone else sees who signed and when, without the image.`,
    );
    // The web app shows View signature in the actions panel, which a signed
    // (completed) order shows only to orders:approve holders.
    expect(entry!.whyItMatters).toBe(
      "A customer's signature is personal information. In the mobile app, anyone who could open the order could see it, while the web app shows it only to people with that permission.",
    );
    // The dialog's empty state (order-signature-image.ts: a refusal is "no
    // image"), the same as for a physical signature, which has no image.
    expect(entry!.howItAffectsYou).toBe(
      "If you have that permission, or you are the order's assigned driver, nothing changes for you. Otherwise View signature shows the signer's name and the time, as it does for a paper signature.",
    );
    // Old bundles still read the image from the order row until the update
    // loads, so the change is said "after the latest update"; nobody has to do
    // anything for it.
    expect(entry!.whatToDo).toBe('No action needed.');
    expect(text).not.toMatch(/offers the new version|update the app|App Store/i);
    expect(text).not.toMatch(/\bbooks?\b|token|hash|secret|%|guarantee|everyone/i);
  });
});

/**
 * Phone ordering PO-2 (migration 0391, one create path): held as a DRAFT
 * until 0391 is pushed and verified, the web deploy is READY and the
 * production smoke test that writes nothing has passed (phone-orders plan
 * 10.1). Pinned by id, never by index. The follow-up that publishes it (plan
 * PO-5) sets 'published' and the real publishedAt, re-reads its words against
 * what shipped, and flips the first pin here.
 */
describe('one order per submission (phone ordering PO-2) is held as a draft', () => {
  const ID = 'order-submit-once-2026-10';
  const release = () => RELEASES.find((r) => r.id === ID)!;
  const everyone: ReleaseViewer = {
    role: 'owner',
    permissions: [...PERMISSIONS],
    enabledModules: Object.keys(MODULE_REGISTRY) as ModuleId[],
  };

  it('is a draft, so no feed carries it, and preparing it changes nothing a client can observe', () => {
    expect(release()).toBeDefined();
    expect(release().status).toBe('draft');
    expect(release().revision).toBe(1);
    expect(visibleReleases(RELEASES, everyone).map((r) => r.id)).not.toContain(ID);
    expect(buildReleaseList(RELEASES, everyone, [], null).releases.map((r) => r.id)).not.toContain(ID);
    expect(legacyAnnouncementsFor(RELEASES, everyone, {}).map((a) => a.id)).not.toContain(ID);
    expect(registryFingerprint(RELEASES)).toBe(registryFingerprint(RELEASES.filter((r) => r.id !== ID)));
  });

  it('sits among the drafts above every published release (slices B and D, published, are below it), dated after every release', () => {
    const at = RELEASES.findIndex((r) => r.id === ID);
    expect(at).toBeGreaterThanOrEqual(0);
    expect(RELEASES.slice(0, at + 1).every((r) => r.status === 'draft')).toBe(true);
    for (const id of ['approval-follows-permission-2026-10', 'order-signature-timeline-2026-10']) {
      const i = RELEASES.findIndex((r) => r.id === id);
      expect(i, id).toBeGreaterThan(at);
      expect(RELEASES[i]?.status, id).toBe('published');
    }
    // Dated after every PUBLISHED release. PO-4's phone draft, which ships
    // after this one, sits above it and is dated later (its own block below).
    for (const r of RELEASES.filter((x) => x.id !== ID && x.status === 'published')) {
      expect(Date.parse(release().publishedAt), r.id).toBeGreaterThan(Date.parse(r.publishedAt));
    }
    // Re-pinned by 0393 (was: the only other draft is PO-4's phone draft).
    // A3's account deletion draft sits below this one and is dated earlier,
    // and returns RX-1's draft sits below A3's (dated earlier still; it
    // publishes on its own clock, RX-5).
    for (const r of RELEASES.filter((x) => x.id !== ID && x.status === 'draft')) {
      expect(
        ['phone-place-order-2026-10', 'account-deletion-everyone-2026-10', 'returns-original-rack-2026-10'],
        r.id,
      ).toContain(r.id);
    }
    const a3 = RELEASES.findIndex((r) => r.id === 'account-deletion-everyone-2026-10');
    expect(a3).toBeGreaterThan(at);
    expect(Date.parse(RELEASES[a3]!.publishedAt)).toBeLessThan(Date.parse(release().publishedAt));
  });

  it('is told to whoever can open the New order page, and links there', () => {
    const r = release();
    expect(r.audience).toEqual({ anyPermission: ['orders:request'], modules: ['orders'] });
    expect(r.entries.map((e) => e.id)).toEqual([
      'order-submit-once',
      'order-refusals-in-place',
      'order-needed-by-org-time-zone',
      'order-page-clearer-labels',
    ]);
    const [once] = r.entries;
    expect(once!.link).toEqual({ href: '/dashboard/orders/new', label: 'Place an order' });
    expect(once!.audience).toEqual({ anyPermission: ['orders:request'], modules: ['orders'] });
    const published: Release = { ...r, status: 'published' };
    const entriesFor = (role: ReleaseViewer['role'], permissions: ReleaseViewer['permissions'], modules: ModuleId[] = ['orders']) =>
      visibleReleases([published], { role, permissions, enabledModules: modules })[0]?.entries.length ?? 0;
    expect(entriesFor('viewer', ['orders:request'])).toBe(4);
    expect(entriesFor('staff', ['members:read'])).toBe(0);
    expect(entriesFor('owner', [...PERMISSIONS], [])).toBe(0);
  });

  it("uses the page's own words, claims no unmeasured number and teaches nothing about the check", () => {
    const r = release();
    const text = readerText(r).join(' ');
    for (const label of ['Check and finish', "Don't send it", 'See my orders', 'Review order', 'Submit order request', 'Most ordered here']) {
      expect(text).toContain(label);
    }
    expect(text).not.toMatch(/\d+ ?%|\bkey\b|idempotenc|hash|lock(ed)? row|database/i);
    expect(text).not.toMatch(/\bbook\b/i);
    expect(r.summary).toContain('never placed twice');
  });

  it('says what review round 1 changed a person can see: other tabs, another organization, items started from Items', () => {
    const once = release().entries[0]!;
    expect(once.howItAffectsYou).toMatch(/another tab/);
    expect(once.howItAffectsYou).toMatch(/switch to another organization, switch back to finish it/);
    expect(once.howItAffectsYou).toMatch(/start an order with from Items wait/);
  });
});

/**
 * Placing an order request in the iPhone and iPad app (phone ordering PO-4) is
 * held as a DRAFT until the OTA is out and phones launch it (plan PO-5). Pinned
 * by id, never by index. The follow-up that publishes it sets 'published' and
 * the real publishedAt, re-reads its words against what shipped, and flips
 * the first pin here.
 */
describe('placing an order in the mobile app (phone ordering PO-4) is held as a draft', () => {
  const ID = 'phone-place-order-2026-10';
  const release = () => RELEASES.find((r) => r.id === ID)!;
  const everyone: ReleaseViewer = {
    role: 'owner',
    permissions: [...PERMISSIONS],
    enabledModules: Object.keys(MODULE_REGISTRY) as ModuleId[],
  };

  it('is a draft, so no feed carries it, and preparing it changes nothing a client can observe', () => {
    expect(release()).toBeDefined();
    expect(release().status).toBe('draft');
    expect(release().revision).toBe(1);
    expect(visibleReleases(RELEASES, everyone).map((r) => r.id)).not.toContain(ID);
    expect(buildReleaseList(RELEASES, everyone, [], null).releases.map((r) => r.id)).not.toContain(ID);
    expect(legacyAnnouncementsFor(RELEASES, everyone, {}).map((a) => a.id)).not.toContain(ID);
    expect(registryFingerprint(RELEASES)).toBe(registryFingerprint(RELEASES.filter((r) => r.id !== ID)));
  });

  it('is the newest entry, above PO-2\'s draft, and dated after every release', () => {
    expect(RELEASES[0]?.id).toBe(ID);
    expect(RELEASES.findIndex((r) => r.id === 'order-submit-once-2026-10')).toBe(1);
    for (const r of RELEASES.filter((x) => x.id !== ID)) {
      expect(Date.parse(release().publishedAt), r.id).toBeGreaterThan(Date.parse(r.publishedAt));
    }
  });

  it('is told to whoever can open the New order page, and links there', () => {
    const r = release();
    expect(r.audience).toEqual({ anyPermission: ['orders:request'], modules: ['orders'] });
    expect(r.entries.map((e) => e.id)).toEqual(['phone-place-order', 'phone-place-order-once', 'phone-orders-list-current']);
    const [place] = r.entries;
    expect(place!.link).toEqual({ href: '/dashboard/orders/new', label: 'Place an order' });
    expect(place!.audience).toEqual({ anyPermission: ['orders:request'], modules: ['orders'] });
    const published: Release = { ...r, status: 'published' };
    const entriesFor = (role: ReleaseViewer['role'], permissions: ReleaseViewer['permissions'], modules: ModuleId[] = ['orders']) =>
      visibleReleases([published], { role, permissions, enabledModules: modules })[0]?.entries.length ?? 0;
    expect(entriesFor('viewer', ['orders:request'])).toBe(3);
    expect(entriesFor('staff', ['members:read'])).toBe(0);
    expect(entriesFor('owner', [...PERMISSIONS], [])).toBe(0);
  });

  it("uses the app's own words, claims no unmeasured number, says a draft for the email, and teaches nothing about the check", () => {
    const r = release();
    const text = readerText(r).join(' ');
    for (const label of ['Place an order', 'Check and finish', "Don't send it", 'See my orders', 'Review and approve', 'Frequently ordered']) {
      expect(text).toContain(label);
    }
    expect(text).toMatch(/email as a draft/);
    expect(text).not.toMatch(/\d+ ?%|\bkey\b|idempotenc|hash|lock(ed)? row|database|\bsent the email\b|email (was )?sent/i);
    expect(text).not.toMatch(/\bbook\b/i);
    expect(r.summary).toContain('never placed twice');
  });
});

/**
 * "Don't send it" cannot promise an order request is never placed: when the
 * earlier send already placed it, the withdraw answers with the order
 * instead (PO-4 desk check F6.1). Neither held draft may say otherwise.
 */
describe('the order drafts never promise that Don\'t send it stops an order already placed', () => {
  it.each(['phone-place-order-2026-10', 'order-submit-once-2026-10'])('%s', (id) => {
    const r = RELEASES.find((x) => x.id === id)!;
    const text = readerText(r).join(' ');
    expect(text).not.toMatch(/never placed and unlocks|makes? sure it(?: is|'s) never placed/i);
    expect(text).toContain("Don't send it stops it if it hasn't been placed yet (if it has, you see the order) and unlocks your cart.");
  });
});

/**
 * PO-4 review: the phone labels statuses with core's defaults (not an
 * organization's own labels, which the web badge applies), says some things
 * in its own words ("Order for someone new", "Set quantity"), and shows For
 * only to someone who may order for someone else. The phone draft claims
 * none of those.
 */
describe('the phone draft claims nothing the phone does not do', () => {
  it('no "the way the web does" for statuses, no "the same words as the web", and For is qualified', () => {
    const r = RELEASES.find((x) => x.id === 'phone-place-order-2026-10')!;
    const text = readerText(r).join(' ');
    expect(text).not.toMatch(/the way the web does|same words as the web/i);
    expect(text).toContain('who the order is for (if you can order for someone else)');
  });

  // Simulator walk D12 (M13): opened with no connection, the phone cannot
  // read what it may order, so nothing can be browsed; only a connection lost
  // while ordering keeps the items as they were last loaded.
  it('promises offline browsing only for a connection lost while ordering', () => {
    const r = RELEASES.find((x) => x.id === 'phone-place-order-2026-10')!;
    const text = readerText(r).join(' ');
    expect(text).not.toMatch(/offline you can still browse/i);
    expect(text).toContain("If the connection drops while you're ordering, you can still browse the items as they were last loaded and keep building your cart.");
  });
});

/**
 * Security slice A3 (migration 0393, every member can delete their own
 * account): held as a DRAFT until 0393 is pushed and verified, the web deploy
 * is READY, the phone update is published and launched, and the Demo Co walk
 * has run. Pinned by id, never by index. The publishing follow-up sets
 * 'published' and the real publishedAt, re-reads the words against what
 * shipped, and flips the first pin here.
 */
describe('account deletion for every member (slice A3) is held as a draft', () => {
  const ID = 'account-deletion-everyone-2026-10';
  const release = () => RELEASES.find((r) => r.id === ID)!;
  const everyone: ReleaseViewer = {
    role: 'owner',
    permissions: [...PERMISSIONS],
    enabledModules: Object.keys(MODULE_REGISTRY) as ModuleId[],
  };

  it('is a draft, so no feed carries it, and preparing it changes nothing a client can observe', () => {
    expect(release()).toBeDefined();
    expect(release().status).toBe('draft');
    expect(release().revision).toBe(1);
    expect(visibleReleases(RELEASES, everyone).map((r) => r.id)).not.toContain(ID);
    expect(buildReleaseList(RELEASES, everyone, [], null).releases.map((r) => r.id)).not.toContain(ID);
    expect(legacyAnnouncementsFor(RELEASES, everyone, {}).map((a) => a.id)).not.toContain(ID);
    expect(registryFingerprint(RELEASES)).toBe(registryFingerprint(RELEASES.filter((r) => r.id !== ID)));
  });

  it('sits among the drafts above every published release, dated after every published release and before the drafts above it', () => {
    const at = RELEASES.findIndex((r) => r.id === ID);
    expect(at).toBeGreaterThanOrEqual(0);
    expect(RELEASES.slice(0, at + 1).every((r) => r.status === 'draft')).toBe(true);
    for (const r of RELEASES.slice(0, at)) {
      expect(Date.parse(r.publishedAt), r.id).toBeGreaterThan(Date.parse(release().publishedAt));
    }
    for (const r of RELEASES.filter((x) => x.status === 'published')) {
      expect(Date.parse(release().publishedAt), r.id).toBeGreaterThan(Date.parse(r.publishedAt));
    }
    // The A2 releases it supersedes stay published below it.
    for (const id of ['account-deletion-orders-2026-10', 'account-deletion-refused-2026-10']) {
      const i = RELEASES.findIndex((r) => r.id === id);
      expect(i, id).toBeGreaterThan(at);
      expect(RELEASES[i]?.status, id).toBe('published');
    }
  });

  it('is told to every member, with no link, as one improved Account entry', () => {
    const r = release();
    expect(r.audience).toBeUndefined();
    expect(r.entries.map((e) => e.id)).toEqual(['account-deletion-everyone']);
    const [entry] = r.entries;
    expect(entry!.category).toBe('improved');
    expect(entry!.area).toBe('Account');
    expect(entry!.link).toBeUndefined();
    expect(entry!.audience).toBeUndefined();
    const published: Release = { ...r, status: 'published' };
    for (const role of ['viewer', 'staff', 'manager', 'admin', 'owner'] as const) {
      expect(visibleReleases([published], { role, permissions: [], enabledModules: [] })[0]?.entries.length, role).toBe(1);
    }
  });

  it('claims only what 0393 does: records kept as "Deleted user" where it shows, work released, the only-owner rule, the update', () => {
    const r = release();
    const entry = r.entries[0]!;
    const text = readerText(r).join(' ');
    // The label the app shows, in the app's quotes.
    expect(r.summary).toContain(`“${DELETED_USER_LABEL}”`);
    expect(entry.whatChanged).toContain(`“${DELETED_USER_LABEL}”`);
    // The one refusal a member can meet, and where ownership moves (web only).
    // Re-pinned by the A3 review (was "make another member the owner first"):
    // the Team page's control is "Transfer ownership…".
    expect(r.summary).toContain('If you are the only owner of an organization with other members, transfer ownership first.');
    expect(entry.whatToDo).toContain('on the Team page on the web');
    expect(entry.whatToDo).toContain('choose Transfer ownership on another member');
    expect(text).not.toMatch(/make another member the owner/i);
    // A3 review: the narrow scope shows "Deleted user" on some records only;
    // the words name them and never say that everything recorded shows it.
    expect(r.summary).toContain(`stock movements, received stock and the audit log show “${DELETED_USER_LABEL}” instead of your name`);
    expect(entry.howItAffectsYou).toContain(`If they do, their stock movements and received stock show “${DELETED_USER_LABEL}”`);
    expect(text).not.toMatch(/(?:records they made|what you recorded)[^.;:]*(?:shows?|shown as) “Deleted user”/i);
    // Released work, as the account trigger releases it.
    expect(entry.howItAffectsYou).toMatch(/counts, picks, deliveries, schedule entries and maintenance requests assigned to them become unassigned/);
    expect(entry.howItAffectsYou).toContain('stop being a warehouse’s manager');
    // Pending invites stop working and leave the list: never "resend".
    expect(entry.howItAffectsYou).toContain('Invitations they sent that were not yet accepted stop working');
    // Desk check F-1: no order email reaches them and no signing screen
    // suggests their address. Orders only: the maintenance resolution email
    // still goes to the address a request kept (a recorded follow-up).
    expect(entry.howItAffectsYou).toContain(
      'They are no longer emailed about orders they placed, and their address is not suggested when someone signs for one.',
    );
    expect(text).not.toMatch(/never (be )?emailed|no longer emailed about anything|not emailed at all/i);
    expect(text).not.toMatch(/\bresend/i);
    // The phone's labels need the update; deleting does not.
    expect(entry.whatChanged).toContain('In the mobile app, after the latest update,');
    expect(entry.whatToDo).toContain('close the app completely and open it again');
    // Narrow scope: records are named, never "every screen" or "everywhere";
    // never "anyone can delete" (the only owner of an organization with
    // members cannot until ownership moves).
    expect(text).not.toMatch(/every (screen|page|record)|everywhere|anyone can delete|all records/i);
    expect(text).not.toMatch(/\bbooks?\b|\d+ ?%|token|hash|database|trigger|platform admin/i);
  });
});

/**
 * Returns RX-1 (migration 0395: gated return functions, Original rack): held
 * as a DRAFT until 0395 is pushed and verified, the web deploy is READY, the
 * OTA with the phone's Returns screens is published and the Demo Co walk
 * passed (returns plan 10.1). Pinned by id, never by index. RX-5 publishes it,
 * sets the real publishedAt, re-reads its words against what shipped and
 * flips the first pin here.
 */
describe('returns remember the original rack (returns RX-1) is held as a draft', () => {
  const ID = 'returns-original-rack-2026-10';
  const release = () => RELEASES.find((r) => r.id === ID)!;
  const everyone: ReleaseViewer = {
    role: 'owner',
    permissions: [...PERMISSIONS],
    enabledModules: Object.keys(MODULE_REGISTRY) as ModuleId[],
  };

  it('is a draft, so no feed carries it, and preparing it changes nothing a client can observe', () => {
    expect(release()).toBeDefined();
    expect(release().status).toBe('draft');
    expect(release().revision).toBe(1);
    expect(visibleReleases(RELEASES, everyone).map((r) => r.id)).not.toContain(ID);
    expect(buildReleaseList(RELEASES, everyone, [], null).releases.map((r) => r.id)).not.toContain(ID);
    expect(legacyAnnouncementsFor(RELEASES, everyone, {}).map((a) => a.id)).not.toContain(ID);
    expect(registryFingerprint(RELEASES)).toBe(registryFingerprint(RELEASES.filter((r) => r.id !== ID)));
  });

  it('sits among the drafts above every published release', () => {
    const at = RELEASES.findIndex((r) => r.id === ID);
    expect(at).toBeGreaterThanOrEqual(0);
    expect(RELEASES.slice(0, at + 1).every((r) => r.status === 'draft')).toBe(true);
    expect(RELEASES[at + 1]?.status).toBe('published');
  });

  it('is told to whoever can open Returns; the request ping only to people who manage returns', () => {
    const r = release();
    expect(r.audience).toEqual({ anyPermission: ['returns:read', 'returns:manage'], modules: ['returns'] });
    expect(r.entries.map((e) => e.id)).toEqual([
      'returns-original-rack',
      'returns-list-and-phone',
      'returns-request-notification',
    ]);
    const [rack, list, ping] = r.entries;
    expect(rack!.link).toEqual({ href: '/dashboard/returns', label: 'Open Returns' });
    expect(list!.link).toEqual({ href: '/dashboard/returns', label: 'Open Returns' });
    expect(ping!.audience).toEqual({ anyPermission: ['returns:manage'], modules: ['returns'] });
    expect(ping!.link?.href).toBe('/dashboard/settings/notifications');
  });

  it('uses the words the screens print, and claims nothing the product does not do', () => {
    const r = release();
    const all = readerText(r).join(' ');
    // The copy guard's banned words (returns-copy.test.ts), plus no numbers.
    expect(all).not.toMatch(/\bbooks?\b|verified|inspected|certif|guarantee|exchange for|%/i);
    // The screens' own labels, so the note and the product never disagree.
    for (const label of ['Leave in Staging', 'Approve and receive', 'The item is here', 'Process return']) {
      expect(all).toContain(label);
    }
    for (const f of availableReturnListFilters({ exchanges: false }).filter((x) => x.id !== 'all')) {
      expect(all).toContain(f.label);
    }
    const form = readFileSync(resolve(__dirname, '../../components/settings/notification-preferences-form.tsx'), 'utf8');
    expect(form).toContain("label: 'New return and exchange requests'");
    expect(all).toContain('Notifications: New return and exchange requests');
    // Nothing moves at approval (brief 14), and the phone is online only.
    expect(r.entries[0]!.whatChanged).toContain('Nothing moves until the item is received.');
    expect(r.entries[1]!.howItAffectsYou).toContain('every return action needs a connection');
  });

  it('says what RX-1 does for the request ping, and nothing it does not (desk check F12)', () => {
    const ping = release().entries.find((e) => e.id === 'returns-request-notification')!;
    const text = readerText({ ...release(), entries: [ping] }).join(' ');
    // RX-1's requester paths are the return link and the customer portal; a
    // member asking from the app is RX-3.
    expect(ping.whatChanged).toContain('from their return link or the customer portal');
    expect(text).not.toMatch(/\bthe app\b/i);
    // A return staff create notifies nobody, not only its creator.
    expect(ping.howItAffectsYou).toContain('Returns created by staff send no notification.');
    expect(text).not.toMatch(/returns you create yourself/i);
  });
});

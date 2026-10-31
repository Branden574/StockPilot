import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  availableReturnActions,
  availableReturnListFilters,
  COMPLETION_CONFIRM_LABEL,
  CONFIRM_COUNT_LABEL,
  confirmCountDialogCopy,
  CONFIRMED_ONLY_FILTER_LABEL,
  DELETED_REQUESTER_LABEL,
  DELETED_USER_LABEL,
  describeOccurrence,
  COMPLETION_REVIEW_LABEL,
  dbPermissionRefusedCopy,
  describeReturnLine,
  describeShortPickLines,
  EXCEPTION_ACT_REFUSED_COPY,
  EXCEPTION_EVIDENCE_MAX_PHOTOS,
  EXCEPTION_EVIDENCE_NOTE_MAX,
  EXCEPTION_RULES,
  exchangeRequesterSentence,
  exchangeReviewProblem,
  FULLY_GRANTABLE_PERMISSIONS,
  GROUP_COPY,
  GROUPING_ERROR_WORDS,
  groupCoverRow,
  hasPermission,
  HOLD_AVAILABLE_STOCK_LABEL,
  isbnSearchKeys,
  isDeletedRequester,
  isManagerOrAbove,
  MODULE_REGISTRY,
  ORDER_CATALOG_MANAGE_PAGE_SIZE,
  ORDER_CATALOG_VISIBILITY_MAX_ITEMS,
  ORDER_CATALOG_VISIBILITY_PERMISSION,
  ORDER_CHECK_AND_FINISH_COPY,
  ORDER_ITEMS_MANAGE_BUTTON_COPY,
  ORDER_ITEMS_SEARCH_PLACEHOLDER_COPY,
  ORDER_ITEMS_SELECT_FAMILY_COPY,
  ORDER_ITEMS_STATE_EXPECTED_COPY,
  ORDER_ITEMS_STATE_HIDDEN_COPY,
  ORDER_ITEMS_STATE_SHOWN_COPY,
  ORDER_DONT_SEND_COPY,
  ORDER_LINE_HIDDEN_ITEM_NAME,
  ORDER_UNCONFIRMED_TITLE_COPY,
  ORDER_WAREHOUSE_WRITE_REFUSED_COPY,
  orderCancelOffer,
  ORDER_RETURN_SUMMARY_NOTE,
  ORDER_SEE_MY_ORDERS_COPY,
  orderStatusLabelForFulfillment,
  ORDER_STATUS_META,
  PARTIAL_RESULT_ORDER_CHANGED_COPY,
  partialActionMovedOnCopy,
  PERMISSION_META,
  PERMISSIONS,
  PICKUP_COMPLETED_STATUS_LABEL,
  plainAddressMailtoUrl,
  processLabelFor,
  PUT_AWAY_NEEDS_TRANSFER_COPY,
  PUT_AWAY_NEEDS_VIEW_ITEMS_COPY,
  releaseRegistrySchema,
  REPLACEMENT_ACTIONS,
  RETURN_ACTION_LABELS,
  returnActionLabel,
  returnListFilter,
  RETURN_ERROR_WORDS,
  RETURNS_COPY,
  replacementCardQuantityLabel,
  replacementCardStatusLabel,
  resolveSurface,
  returnLineLabel,
  returnToRackButton,
  REVIEW_SUBMIT_COPY,
  SECTION_ORDER,
  stagingReturnedSourceLabel,
  STOREFRONT_LINE_NOT_LISTED_COPY,
  STOREFRONT_LINE_NOT_ORDERABLE_COPY,
  STOREFRONT_TITLE_COPY,
  UNGROUP_COPY,
  VERIFICATION_SESSION_ENDED_COPY,
  type CountConfirmBlock,
  type ModuleId,
  type Release,
  type ReleaseViewer,
  type RestockOptionsLine,
} from '@stockpilot/core';

import { newOrderFromWarehouseHref, warehouseTelUrl } from '@/components/locations/warehouse-links';
import { userMenuRoleLabel } from '@/lib/auth/user-menu-role';
import { BUNDLE_DUPLICATE_COMPONENT } from '@/lib/bundles/component-set';
import {
  INSTANT_MODE_MAX_ROWS,
  planGroupAwarePage,
  type InstantModeRow,
} from '@/lib/inventory/instant-mode';
import { movementTypeLabel } from '@/lib/movements/movement-type';
import { ANNOUNCEMENTS } from '@/lib/onboarding/announcements';
import { normalizeApparelName } from '@/lib/po-scan/apparel-names';

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
 * that tells a reader nothing. Lowercase; matched case-insensitively. The
 * brief's claim that a named person was notified is matched by shape instead
 * (NAMED_PERSON_NOTIFIED), so this public file names no one.
 */
const FORBIDDEN = [
  'email sent',
  'ticket created',
  'ticket assigned',
  'request submitted',
  'zendesk',
  'dc4 notified',
  'general improvements',
  'various improvements',
  'bug fixes and improvements',
  'under the hood',
  'optimized backend',
];

/** `<Name> notified`: a capitalised word before "notified", case-sensitive. */
const NAMED_PERSON_NOTIFIED = /\b[A-Z][a-z]+ notified\b/;

/**
 * The three redesign releases (docs/whats-new-redesign-2026-10, 2026-10-20)
 * reach every member: each has entries with no audience. A test that walks
 * a reader's notices down to an older release reads or sees these first, so
 * the order it checks holds. Read stamps are matched by release and
 * revision only (logic.ts), so the time on them is arbitrary.
 */
const REDESIGN_IDS = [
  'redesign-2026-10',
  'redesign-mobile-app-2026-10',
  'redesign-web-fixes-2026-10',
];
/**
 * Added by docs/whats-new-2026-10-25 (2026-10-25): the release published that
 * day sits at the top, above the redesign releases, and reaches every member
 * too (five of its entries have no audience).
 */
const NEWEST_ID = 'unsubscribe-rack-question-fixes-2026-10';
/**
 * Added by docs/whats-new-2026-10-26 (2026-10-26): the release published that
 * day sits at the top, above NEWEST_ID's, and reaches every member too (its
 * first entry, ended-session-goes-to-sign-in, has no audience). NEWEST_ID
 * keeps its name: it is the release of 2026-10-25, now second from the top.
 */
const TOP_ID = 'ended-session-group-page-fixes-2026-10';
/**
 * Added by docs/whats-new-2026-10-30 (2026-10-30): the release published that
 * day sits at the top, above TOP_ID's, and reaches every member too (three of
 * its entries, photos-no-white-backing, app-sign-out-removes-saved-photos and
 * app-back-stays-in-the-app, have no audience). TOP_ID keeps its name: it is
 * the release of 2026-10-26, now second from the top.
 */
const LATEST_ID = 'manage-order-items-and-app-fixes-2026-10';
/**
 * Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: the three redesign
 * releases only): the newest release (NEWEST_ID) is published above them and
 * reaches every member, so it is read or seen with them, and every older
 * notice these reads lead to is the one each test checked before.
 * Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: NEWEST_ID and the
 * three redesign releases): the release at the top (TOP_ID) is published
 * above them all and reaches every member, so it is read or seen with them
 * too, and every older notice these reads lead to is the one each test
 * checked before.
 * Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: TOP_ID, NEWEST_ID
 * and the three redesign releases): the release at the top (LATEST_ID) is
 * published above them all and reaches every member, so it is read or seen
 * with them too, and every older notice these reads lead to is the one each
 * test checked before.
 */
const redesignReads = () =>
  [LATEST_ID, TOP_ID, NEWEST_ID, ...REDESIGN_IDS].map((id) => ({
    release_id: id,
    revision: 1,
    dismissed_at: null,
    opened_at: '2026-10-20T13:00:00Z',
    read_at: '2026-10-20T13:00:00Z',
  }));
const redesignSeen = (): Record<string, boolean> =>
  Object.fromEntries([LATEST_ID, TOP_ID, NEWEST_ID, ...REDESIGN_IDS].map((id) => [id, true]));
/** The newest release alone, read or seen: what a reader marks first. */
const newestRead = () => ({
  release_id: NEWEST_ID,
  revision: 1,
  dismissed_at: null,
  opened_at: '2026-10-25T17:05:00Z',
  read_at: '2026-10-25T17:05:00Z',
});
const newestSeen = (): Record<string, boolean> => ({ [NEWEST_ID]: true });
/**
 * Added by docs/whats-new-2026-10-26 (2026-10-26): the release at the top
 * (TOP_ID) alone, read or seen. A test that marks the newest release read or
 * seen first (newestRead, newestSeen) now marks this one with it, so the
 * notice it checks after them is the one it checked before.
 */
const topRead = () => ({
  release_id: TOP_ID,
  revision: 1,
  dismissed_at: null,
  opened_at: '2026-10-26T15:20:00Z',
  read_at: '2026-10-26T15:20:00Z',
});
const topSeen = (): Record<string, boolean> => ({ [TOP_ID]: true });
/**
 * Added by docs/whats-new-2026-10-30 (2026-10-30): the release at the top
 * (LATEST_ID) alone, read or seen. A test that marks the release of
 * 2026-10-26 read or seen first (topRead, topSeen) now marks this one with
 * it, so the notice it checks after them is the one it checked before.
 */
const latestRead = () => ({
  release_id: LATEST_ID,
  revision: 1,
  dismissed_at: null,
  opened_at: '2026-10-30T16:40:00Z',
  read_at: '2026-10-30T16:40:00Z',
});
const latestSeen = (): Record<string, boolean> => ({ [LATEST_ID]: true });
/**
 * Set at publish: the whole minute at which the redesign's web build was live
 * on production and the OTA's first iOS launches showed (EAS
 * update:insights), whichever came later, written like 2026-10-20T16:05:00Z.
 * The four releases at the top (the three redesign releases and the parked
 * ai-search-finds-every-item release, #367) were written before the redesign
 * was merged, with a provisional T earlier than the merge: the publish guard
 * at the end of this file fails until this is set and T is at or after it.
 */
const REDESIGN_LIVE_AT = '2026-10-20T15:37:00Z';

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
      // Each member's own email and notification choices: the page checks
      // only the session (requireSession), and every member may turn the
      // weekly digest on.
      '/dashboard/settings/notifications',
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
      readerText(r).flatMap((text) => [
        ...FORBIDDEN.filter((phrase) => text.toLowerCase().includes(phrase)).map(
          (phrase) => `${r.id}: "${phrase}"`,
        ),
        ...(NAMED_PERSON_NOTIFIED.test(text) ? [`${r.id}: a named person notified`] : []),
      ]),
    );
    expect(hits).toEqual([]);
    // The shape check bites: a named person notified, whatever the name.
    expect(NAMED_PERSON_NOTIFIED.test('Your request is saved and Morgan notified.')).toBe(true);
    expect(NAMED_PERSON_NOTIFIED.test('DC4 is not notified by StockPilot.')).toBe(false);
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
    // releases, the two order signature releases, the approval release, the
    // three releases of 2026-10-05 and slice 1's small fixes after it).
    // Re-pinned by the Items first-paint release (2026-10-06): published after the small fixes.
    // Re-pinned by the publishing of the weekly digest release (2026-10-06; was:
    // items-list-first-paint-2026-10): published after it, and every reader sees it.
    // Re-pinned by the publishing of the slice 2 release (2026-10-06; was:
    // weekly-digest-and-fixes-2026-10): published after it, and this reader
    // (an owner with every module) is told its approval, receiving and item
    // sheet entries.
    // Re-pinned by docs/whats-new-dates-link-submit (2026-10-06; was:
    // order-partial-approval-held-2026-10): the public link, dates fixes and
    // PO-2 releases are published after it, and this reader (an owner with
    // every module) is told all three, the public link release newest.
    // Re-pinned by docs/whats-new-returns-exchange (2026-10-11; was:
    // public-link-sent-request-2026-10): returns RX-2's release is published
    // after it, and this reader (an owner with every module) is told it.
    // Re-pinned by docs/whats-new-returns-requester (2026-10-12; was:
    // returns-exchange-2026-10): returns RX-3's release is published after
    // it, and this reader (an owner with every module) is told it.
    // Re-pinned by docs/whats-new-returns-close-rest (2026-10-12; was:
    // returns-requester-exchange-2026-10): returns RX-4's release is
    // published after it, and this reader (an owner with every module) is
    // told it.
    // Re-pinned by docs/whats-new-return-history-hand-over (2026-10-12; was:
    // returns-close-rest-2026-10): the return history hand-over release is
    // published after it, and this reader (an owner with every module) is
    // told it.
    // Re-pinned by the What's New publish of ungroup-2026-10 and
    // group-selected-2026-10 (2026-10-12): was returns-history-hand-over-2026-10.
    // Group selected's release is published after it (a minute after
    // Ungroup's) and reaches every member, so this reader (an owner with
    // every module) is told it first.
    // Re-pinned by docs/whats-new-ungroup-follow-ups (2026-10-12; was: group-selected-2026-10): the Ungroup follow-ups release is published after it, at the top and reaches this reader.
    // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: ungroup-follow-ups-2026-10): the pages-keep-groups-whole release is published after it, at the top, and reaches this reader.
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: pages-keep-groups-whole-2026-10): the parked ai-search-finds-every-item release (#367) and the three redesign releases are published after it, at the top, and redesign-2026-10, the newest, reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: redesign-2026-10): the unsubscribe-rack-question-fixes release is published after it, at the top, and reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: unsubscribe-rack-question-fixes-2026-10): the ended-session-group-page-fixes release is published after it, at the top, and reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: ended-session-group-page-fixes-2026-10): the manage-order-items-and-app-fixes release is published after it, at the top, and reaches every member, this reader included.
    expect(list.latestUnread?.id).toBe('manage-order-items-and-app-fixes-2026-10');
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
    // account deletion releases, the two order signature releases, the approval
    // release, the three releases of 2026-10-05 and slice 1's small fixes were
    // published after this one.
    // Re-pinned by the Items first-paint release (2026-10-06): published after the small fixes.
    // Re-pinned by the publishing of the weekly digest release (2026-10-06; was:
    // items-list-first-paint-2026-10): published after it, and every reader sees it.
    // Re-pinned by the publishing of the slice 2 release (2026-10-06; was:
    // weekly-digest-and-fixes-2026-10): published after it, and this reader
    // (an owner with every module) is told its approval, receiving and item
    // sheet entries.
    // Re-pinned by docs/whats-new-dates-link-submit (2026-10-06; was:
    // order-partial-approval-held-2026-10): the public link, dates fixes and
    // PO-2 releases are published after it, and this reader (an owner with
    // every module) is told all three, the public link release newest.
    // Re-pinned by docs/whats-new-returns-exchange (2026-10-11; was:
    // public-link-sent-request-2026-10): returns RX-2's release is published
    // after it, and this reader (an owner with every module) is told it.
    // Re-pinned by docs/whats-new-returns-requester (2026-10-12; was:
    // returns-exchange-2026-10): returns RX-3's release is published after
    // it, and this reader (an owner with every module) is told it.
    // Re-pinned by docs/whats-new-returns-close-rest (2026-10-12; was:
    // returns-requester-exchange-2026-10): returns RX-4's release is
    // published after it, and this reader (an owner with every module) is
    // told it.
    // Re-pinned by docs/whats-new-return-history-hand-over (2026-10-12; was:
    // returns-close-rest-2026-10): the return history hand-over release is
    // published after it, and this reader (an owner with every module) is
    // told it.
    // Re-pinned by the What's New publish of ungroup-2026-10 and
    // group-selected-2026-10 (2026-10-12): was returns-history-hand-over-2026-10.
    // Group selected's release is published after it (a minute after
    // Ungroup's) and reaches every member, so this reader (an owner with
    // every module) is told it first.
    // Re-pinned by docs/whats-new-ungroup-follow-ups (2026-10-12; was: group-selected-2026-10): the Ungroup follow-ups release is published after it, at the top and reaches this reader.
    // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: ungroup-follow-ups-2026-10): the pages-keep-groups-whole release is published after it, at the top, and reaches this reader.
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: pages-keep-groups-whole-2026-10): the parked ai-search-finds-every-item release (#367) and the three redesign releases are published after it, at the top, and redesign-2026-10, the newest, reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: redesign-2026-10): the unsubscribe-rack-question-fixes release is published after it, at the top, and reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: unsubscribe-rack-question-fixes-2026-10): the ended-session-group-page-fixes release is published after it, at the top, and reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: ended-session-group-page-fixes-2026-10): the manage-order-items-and-app-fixes release is published after it, at the top, and reaches every member, this reader included.
    expect(list.latestUnread?.id).toBe('manage-order-items-and-app-fixes-2026-10');
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
    // signature releases, the approval release, the three releases of
    // 2026-10-05 and slice 1's small fixes were published after this one.
    // Re-pinned by the Items first-paint release (2026-10-06): published after the small fixes.
    // Re-pinned by the publishing of the weekly digest release (2026-10-06; was:
    // items-list-first-paint-2026-10): published after it, and every reader sees it.
    // Re-pinned by the publishing of the slice 2 release (2026-10-06; was:
    // weekly-digest-and-fixes-2026-10): published after it, and this reader
    // (an owner with every module) is told its approval, receiving and item
    // sheet entries.
    // Re-pinned by docs/whats-new-dates-link-submit (2026-10-06; was:
    // order-partial-approval-held-2026-10): the public link, dates fixes and
    // PO-2 releases are published after it, and this reader (an owner with
    // every module) is told all three, the public link release newest.
    // Re-pinned by docs/whats-new-returns-exchange (2026-10-11; was:
    // public-link-sent-request-2026-10): returns RX-2's release is published
    // after it, and this reader (an owner with every module) is told it.
    // Re-pinned by docs/whats-new-returns-requester (2026-10-12; was:
    // returns-exchange-2026-10): returns RX-3's release is published after
    // it, and this reader (an owner with every module) is told it.
    // Re-pinned by docs/whats-new-returns-close-rest (2026-10-12; was:
    // returns-requester-exchange-2026-10): returns RX-4's release is
    // published after it, and this reader (an owner with every module) is
    // told it.
    // Re-pinned by docs/whats-new-return-history-hand-over (2026-10-12; was:
    // returns-close-rest-2026-10): the return history hand-over release is
    // published after it, and this reader (an owner with every module) is
    // told it.
    // Re-pinned by the What's New publish of ungroup-2026-10 and
    // group-selected-2026-10 (2026-10-12): was returns-history-hand-over-2026-10.
    // Group selected's release is published after it (a minute after
    // Ungroup's) and reaches every member, so this reader (an owner with
    // every module) is told it first.
    // Re-pinned by docs/whats-new-ungroup-follow-ups (2026-10-12; was: group-selected-2026-10): the Ungroup follow-ups release is published after it, at the top and reaches this reader.
    // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: ungroup-follow-ups-2026-10): the pages-keep-groups-whole release is published after it, at the top, and reaches this reader.
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: pages-keep-groups-whole-2026-10): the parked ai-search-finds-every-item release (#367) and the three redesign releases are published after it, at the top, and redesign-2026-10, the newest, reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: redesign-2026-10): the unsubscribe-rack-question-fixes release is published after it, at the top, and reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: unsubscribe-rack-question-fixes-2026-10): the ended-session-group-page-fixes release is published after it, at the top, and reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: ended-session-group-page-fixes-2026-10): the manage-order-items-and-app-fixes release is published after it, at the top, and reaches every member, this reader included.
    expect(list.latestUnread?.id).toBe('manage-order-items-and-app-fixes-2026-10');
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
    // signature releases, the approval release, the three releases of
    // 2026-10-05 and slice 1's small fixes were published after this one.
    // Re-pinned by the Items first-paint release (2026-10-06): published after the small fixes.
    // Re-pinned by the publishing of the weekly digest release (2026-10-06; was:
    // items-list-first-paint-2026-10): published after it, and every reader sees it.
    // Re-pinned by the publishing of the slice 2 release (2026-10-06; was:
    // weekly-digest-and-fixes-2026-10): published after it, and this reader
    // (an owner with every module) is told its approval, receiving and item
    // sheet entries.
    // Re-pinned by docs/whats-new-dates-link-submit (2026-10-06; was:
    // order-partial-approval-held-2026-10): the public link, dates fixes and
    // PO-2 releases are published after it, and this reader (an owner with
    // every module) is told all three, the public link release newest.
    // Re-pinned by docs/whats-new-returns-exchange (2026-10-11; was:
    // public-link-sent-request-2026-10): returns RX-2's release is published
    // after it, and this reader (an owner with every module) is told it.
    // Re-pinned by docs/whats-new-returns-requester (2026-10-12; was:
    // returns-exchange-2026-10): returns RX-3's release is published after
    // it, and this reader (an owner with every module) is told it.
    // Re-pinned by docs/whats-new-returns-close-rest (2026-10-12; was:
    // returns-requester-exchange-2026-10): returns RX-4's release is
    // published after it, and this reader (an owner with every module) is
    // told it.
    // Re-pinned by docs/whats-new-return-history-hand-over (2026-10-12; was:
    // returns-close-rest-2026-10): the return history hand-over release is
    // published after it, and this reader (an owner with every module) is
    // told it.
    // Re-pinned by the What's New publish of ungroup-2026-10 and
    // group-selected-2026-10 (2026-10-12): was returns-history-hand-over-2026-10.
    // Group selected's release is published after it (a minute after
    // Ungroup's) and reaches every member, so this reader (an owner with
    // every module) is told it first.
    // Re-pinned by docs/whats-new-ungroup-follow-ups (2026-10-12; was: group-selected-2026-10): the Ungroup follow-ups release is published after it, at the top and reaches this reader.
    // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: ungroup-follow-ups-2026-10): the pages-keep-groups-whole release is published after it, at the top, and reaches this reader.
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: pages-keep-groups-whole-2026-10): the parked ai-search-finds-every-item release (#367) and the three redesign releases are published after it, at the top, and redesign-2026-10, the newest, reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: redesign-2026-10): the unsubscribe-rack-question-fixes release is published after it, at the top, and reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: unsubscribe-rack-question-fixes-2026-10): the ended-session-group-page-fixes release is published after it, at the top, and reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: ended-session-group-page-fixes-2026-10): the manage-order-items-and-app-fixes release is published after it, at the top, and reaches every member, this reader included.
    expect(list.latestUnread?.id).toBe('manage-order-items-and-app-fixes-2026-10');
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
    // the two account deletion releases, the two order signature releases, the
    // approval release, the three releases of 2026-10-05 and slice 1's small
    // fixes were published after this one.
    // Re-pinned by the Items first-paint release (2026-10-06): published after the small fixes.
    // Re-pinned by the publishing of the weekly digest release (2026-10-06; was:
    // items-list-first-paint-2026-10): published after it, and every reader sees it.
    // Re-pinned by the publishing of the slice 2 release (2026-10-06; was:
    // weekly-digest-and-fixes-2026-10): published after it, and this reader
    // (an owner with every module) is told its approval, receiving and item
    // sheet entries.
    // Re-pinned by docs/whats-new-dates-link-submit (2026-10-06; was:
    // order-partial-approval-held-2026-10): the public link, dates fixes and
    // PO-2 releases are published after it, and this reader (an owner with
    // every module) is told all three, the public link release newest.
    // Re-pinned by docs/whats-new-returns-exchange (2026-10-11; was:
    // public-link-sent-request-2026-10): returns RX-2's release is published
    // after it, and this reader (an owner with every module) is told it.
    // Re-pinned by docs/whats-new-returns-requester (2026-10-12; was:
    // returns-exchange-2026-10): returns RX-3's release is published after
    // it, and this reader (an owner with every module) is told it.
    // Re-pinned by docs/whats-new-returns-close-rest (2026-10-12; was:
    // returns-requester-exchange-2026-10): returns RX-4's release is
    // published after it, and this reader (an owner with every module) is
    // told it.
    // Re-pinned by docs/whats-new-return-history-hand-over (2026-10-12; was:
    // returns-close-rest-2026-10): the return history hand-over release is
    // published after it, and this reader (an owner with every module) is
    // told it.
    // Re-pinned by the What's New publish of ungroup-2026-10 and
    // group-selected-2026-10 (2026-10-12): was returns-history-hand-over-2026-10.
    // Group selected's release is published after it (a minute after
    // Ungroup's) and reaches every member, so this reader (an owner with
    // every module) is told it first.
    // Re-pinned by docs/whats-new-ungroup-follow-ups (2026-10-12; was: group-selected-2026-10): the Ungroup follow-ups release is published after it, at the top and reaches this reader.
    // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: ungroup-follow-ups-2026-10): the pages-keep-groups-whole release is published after it, at the top, and reaches this reader.
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: pages-keep-groups-whole-2026-10): the parked ai-search-finds-every-item release (#367) and the three redesign releases are published after it, at the top, and redesign-2026-10, the newest, reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: redesign-2026-10): the unsubscribe-rack-question-fixes release is published after it, at the top, and reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: unsubscribe-rack-question-fixes-2026-10): the ended-session-group-page-fixes release is published after it, at the top, and reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: ended-session-group-page-fixes-2026-10): the manage-order-items-and-app-fixes release is published after it, at the top, and reaches every member, this reader included.
    expect(list.latestUnread?.id).toBe('manage-order-items-and-app-fixes-2026-10');
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
    // releases, the two order signature releases, the approval release, the
    // three releases of 2026-10-05 and slice 1's small fixes were published
    // after this one.
    // Re-pinned by the Items first-paint release (2026-10-06): published after the small fixes.
    // Re-pinned by the publishing of the weekly digest release (2026-10-06; was:
    // items-list-first-paint-2026-10): published after it, and every reader sees it.
    // Re-pinned by the publishing of the slice 2 release (2026-10-06; was:
    // weekly-digest-and-fixes-2026-10): published after it, and this reader
    // (an owner with every module) is told its approval, receiving and item
    // sheet entries.
    // Re-pinned by docs/whats-new-dates-link-submit (2026-10-06; was:
    // order-partial-approval-held-2026-10): the public link, dates fixes and
    // PO-2 releases are published after it, and this reader (an owner with
    // every module) is told all three, the public link release newest.
    // Re-pinned by docs/whats-new-returns-exchange (2026-10-11; was:
    // public-link-sent-request-2026-10): returns RX-2's release is published
    // after it, and this reader (an owner with every module) is told it.
    // Re-pinned by docs/whats-new-returns-requester (2026-10-12; was:
    // returns-exchange-2026-10): returns RX-3's release is published after
    // it, and this reader (an owner with every module) is told it.
    // Re-pinned by docs/whats-new-returns-close-rest (2026-10-12; was:
    // returns-requester-exchange-2026-10): returns RX-4's release is
    // published after it, and this reader (an owner with every module) is
    // told it.
    // Re-pinned by docs/whats-new-return-history-hand-over (2026-10-12; was:
    // returns-close-rest-2026-10): the return history hand-over release is
    // published after it, and this reader (an owner with every module) is
    // told it.
    // Re-pinned by the What's New publish of ungroup-2026-10 and
    // group-selected-2026-10 (2026-10-12): was returns-history-hand-over-2026-10.
    // Group selected's release is published after it (a minute after
    // Ungroup's) and reaches every member, so this reader (an owner with
    // every module) is told it first.
    // Re-pinned by docs/whats-new-ungroup-follow-ups (2026-10-12; was: group-selected-2026-10): the Ungroup follow-ups release is published after it, at the top and reaches this reader.
    // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: ungroup-follow-ups-2026-10): the pages-keep-groups-whole release is published after it, at the top, and reaches this reader.
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: pages-keep-groups-whole-2026-10): the parked ai-search-finds-every-item release (#367) and the three redesign releases are published after it, at the top, and redesign-2026-10, the newest, reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: redesign-2026-10): the unsubscribe-rack-question-fixes release is published after it, at the top, and reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: unsubscribe-rack-question-fixes-2026-10): the ended-session-group-page-fixes release is published after it, at the top, and reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: ended-session-group-page-fixes-2026-10): the manage-order-items-and-app-fixes release is published after it, at the top, and reaches every member, this reader included.
    expect(list.latestUnread?.id).toBe('manage-order-items-and-app-fixes-2026-10');
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
    // releases, the two order signature releases, the approval release, the
    // three releases of 2026-10-05 and slice 1's small fixes were published
    // after this one.
    // Re-pinned by the Items first-paint release (2026-10-06): published after the small fixes.
    // Re-pinned by the publishing of the weekly digest release (2026-10-06; was:
    // items-list-first-paint-2026-10): published after it, and every reader sees it.
    // Re-pinned by the publishing of the slice 2 release (2026-10-06; was:
    // weekly-digest-and-fixes-2026-10): published after it, and this reader
    // (an owner with every module) is told its approval, receiving and item
    // sheet entries.
    // Re-pinned by docs/whats-new-dates-link-submit (2026-10-06; was:
    // order-partial-approval-held-2026-10): the public link, dates fixes and
    // PO-2 releases are published after it, and this reader (an owner with
    // every module) is told all three, the public link release newest.
    // Re-pinned by docs/whats-new-returns-exchange (2026-10-11; was:
    // public-link-sent-request-2026-10): returns RX-2's release is published
    // after it, and this reader (an owner with every module) is told it.
    // Re-pinned by docs/whats-new-returns-requester (2026-10-12; was:
    // returns-exchange-2026-10): returns RX-3's release is published after
    // it, and this reader (an owner with every module) is told it.
    // Re-pinned by docs/whats-new-returns-close-rest (2026-10-12; was:
    // returns-requester-exchange-2026-10): returns RX-4's release is
    // published after it, and this reader (an owner with every module) is
    // told it.
    // Re-pinned by docs/whats-new-return-history-hand-over (2026-10-12; was:
    // returns-close-rest-2026-10): the return history hand-over release is
    // published after it, and this reader (an owner with every module) is
    // told it.
    // Re-pinned by the What's New publish of ungroup-2026-10 and
    // group-selected-2026-10 (2026-10-12): was returns-history-hand-over-2026-10.
    // Group selected's release is published after it (a minute after
    // Ungroup's) and reaches every member, so this reader (an owner with
    // every module) is told it first.
    // Re-pinned by docs/whats-new-ungroup-follow-ups (2026-10-12; was: group-selected-2026-10): the Ungroup follow-ups release is published after it, at the top and reaches this reader.
    // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: ungroup-follow-ups-2026-10): the pages-keep-groups-whole release is published after it, at the top, and reaches this reader.
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: pages-keep-groups-whole-2026-10): the parked ai-search-finds-every-item release (#367) and the three redesign releases are published after it, at the top, and redesign-2026-10, the newest, reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: redesign-2026-10): the unsubscribe-rack-question-fixes release is published after it, at the top, and reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: unsubscribe-rack-question-fixes-2026-10): the ended-session-group-page-fixes release is published after it, at the top, and reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: ended-session-group-page-fixes-2026-10): the manage-order-items-and-app-fixes release is published after it, at the top, and reaches every member, this reader included.
    expect(list.latestUnread?.id).toBe('manage-order-items-and-app-fixes-2026-10');
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
    // passes through it (#308), through the shared rethrowControlFlow
    // (lib/control-flow.ts, Next's unstable_rethrow) since every action's
    // catch was given it.
    const actions = readFileSync(resolve(__dirname, '../../server/actions/exceptions.ts'), 'utf8');
    expect(actions).toContain('rethrowControlFlow(e);');
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
    // two account deletion releases, the two order signature releases, the
    // approval release, the three releases of 2026-10-05 and slice 1's small
    // fixes were published after this one.
    // Re-pinned by the Items first-paint release (2026-10-06): published after the small fixes.
    // Re-pinned by the publishing of the weekly digest release (2026-10-06; was:
    // items-list-first-paint-2026-10): published after it, and every reader sees it.
    // Re-pinned by the publishing of the slice 2 release (2026-10-06; was:
    // weekly-digest-and-fixes-2026-10): published after it, and this reader
    // (an owner with every module) is told its approval, receiving and item
    // sheet entries.
    // Re-pinned by docs/whats-new-dates-link-submit (2026-10-06; was:
    // order-partial-approval-held-2026-10): the public link, dates fixes and
    // PO-2 releases are published after it, and this reader (an owner with
    // every module) is told all three, the public link release newest.
    // Re-pinned by docs/whats-new-returns-exchange (2026-10-11; was:
    // public-link-sent-request-2026-10): returns RX-2's release is published
    // after it, and this reader (an owner with every module) is told it.
    // Re-pinned by docs/whats-new-returns-requester (2026-10-12; was:
    // returns-exchange-2026-10): returns RX-3's release is published after
    // it, and this reader (an owner with every module) is told it.
    // Re-pinned by docs/whats-new-returns-close-rest (2026-10-12; was:
    // returns-requester-exchange-2026-10): returns RX-4's release is
    // published after it, and this reader (an owner with every module) is
    // told it.
    // Re-pinned by docs/whats-new-return-history-hand-over (2026-10-12; was:
    // returns-close-rest-2026-10): the return history hand-over release is
    // published after it, and this reader (an owner with every module) is
    // told it.
    // Re-pinned by the What's New publish of ungroup-2026-10 and
    // group-selected-2026-10 (2026-10-12): was returns-history-hand-over-2026-10.
    // Group selected's release is published after it (a minute after
    // Ungroup's) and reaches every member, so this reader (an owner with
    // every module) is told it first.
    // Re-pinned by docs/whats-new-ungroup-follow-ups (2026-10-12; was: group-selected-2026-10): the Ungroup follow-ups release is published after it, at the top and reaches this reader.
    // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: ungroup-follow-ups-2026-10): the pages-keep-groups-whole release is published after it, at the top, and reaches this reader.
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: pages-keep-groups-whole-2026-10): the parked ai-search-finds-every-item release (#367) and the three redesign releases are published after it, at the top, and redesign-2026-10, the newest, reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: redesign-2026-10): the unsubscribe-rack-question-fixes release is published after it, at the top, and reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: unsubscribe-rack-question-fixes-2026-10): the ended-session-group-page-fixes release is published after it, at the top, and reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: ended-session-group-page-fixes-2026-10): the manage-order-items-and-app-fixes release is published after it, at the top, and reaches every member, this reader included.
    expect(list.latestUnread?.id).toBe('manage-order-items-and-app-fixes-2026-10');
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
 * newest release, a minute after slice B's timeline release. The three
 * releases of 2026-10-05 (account deletion for every member, returns RX-1 and
 * phone ordering) were published above it later.
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
    // The notice offers the newest unread release: the three releases of
    // 2026-10-05 and slice 1's small fixes were published after this one.
    // Re-pinned by the Items first-paint release (2026-10-06): published after the small fixes.
    // Re-pinned by the publishing of the weekly digest release (2026-10-06; was:
    // items-list-first-paint-2026-10): published after it, and every reader sees it.
    // Re-pinned by the publishing of the slice 2 release (2026-10-06; was:
    // weekly-digest-and-fixes-2026-10): published after it, and this reader
    // (an owner with every module) is told its approval, receiving and item
    // sheet entries.
    // Re-pinned by docs/whats-new-dates-link-submit (2026-10-06; was:
    // order-partial-approval-held-2026-10): the public link, dates fixes and
    // PO-2 releases are published after it, and this reader (an owner with
    // every module) is told all three, the public link release newest.
    // Re-pinned by docs/whats-new-returns-exchange (2026-10-11; was:
    // public-link-sent-request-2026-10): returns RX-2's release is published
    // after it, and this reader (an owner with every module) is told it.
    // Re-pinned by docs/whats-new-returns-requester (2026-10-12; was:
    // returns-exchange-2026-10): returns RX-3's release is published after
    // it, and this reader (an owner with every module) is told it.
    // Re-pinned by docs/whats-new-returns-close-rest (2026-10-12; was:
    // returns-requester-exchange-2026-10): returns RX-4's release is
    // published after it, and this reader (an owner with every module) is
    // told it.
    // Re-pinned by docs/whats-new-return-history-hand-over (2026-10-12; was:
    // returns-close-rest-2026-10): the return history hand-over release is
    // published after it, and this reader (an owner with every module) is
    // told it.
    // Re-pinned by the What's New publish of ungroup-2026-10 and
    // group-selected-2026-10 (2026-10-12): was returns-history-hand-over-2026-10.
    // Group selected's release is published after it (a minute after
    // Ungroup's) and reaches every member, so this reader (an owner with
    // every module) is told it first.
    // Re-pinned by docs/whats-new-ungroup-follow-ups (2026-10-12; was: group-selected-2026-10): the Ungroup follow-ups release is published after it, at the top and reaches this reader.
    // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: ungroup-follow-ups-2026-10): the pages-keep-groups-whole release is published after it, at the top, and reaches this reader.
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: pages-keep-groups-whole-2026-10): the parked ai-search-finds-every-item release (#367) and the three redesign releases are published after it, at the top, and redesign-2026-10, the newest, reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: redesign-2026-10): the unsubscribe-rack-question-fixes release is published after it, at the top, and reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: unsubscribe-rack-question-fixes-2026-10): the ended-session-group-page-fixes release is published after it, at the top, and reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: ended-session-group-page-fixes-2026-10): the manage-order-items-and-app-fixes release is published after it, at the top, and reaches every member, this reader included.
    expect(list.latestUnread?.id).toBe('manage-order-items-and-app-fixes-2026-10');
    // An old phone build lists at most three unread releases, newest first:
    // once the newer releases are read, this one and slice B's two.
    const newer = Object.fromEntries(
      RELEASES.slice(0, RELEASES.findIndex((r) => r.id === ID)).map((r) => [r.id, true]),
    );
    expect(legacyAnnouncementsFor(RELEASES, everyone, newer).map((a) => a.id)).toEqual([
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

  it("is dated after every release below it (pinned by id), slice B's two directly below it, a minute after the first; releases above it were published later", () => {
    const at = RELEASES.findIndex((r) => r.id === ID);
    expect(at).toBeGreaterThanOrEqual(0);
    // No draft is left below it; the releases above it (the PO-2 draft and
    // the three releases of 2026-10-05) are dated later.
    expect(RELEASES.slice(at + 1).every((r) => r.status === 'published' || r.status === 'withdrawn')).toBe(true);
    expect(RELEASES[at - 1]?.id).toBe('account-deletion-everyone-2026-10');
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
    // releases, the approval release, the three releases of 2026-10-05 and
    // slice 1's small fixes were published after this one.
    // Re-pinned by the Items first-paint release (2026-10-06): published after the small fixes.
    // Re-pinned by the publishing of the weekly digest release (2026-10-06; was:
    // items-list-first-paint-2026-10): published after it, and every reader sees it.
    // Re-pinned by the publishing of the slice 2 release (2026-10-06; was:
    // weekly-digest-and-fixes-2026-10): published after it, and this reader
    // (an owner with every module) is told its approval, receiving and item
    // sheet entries.
    // Re-pinned by docs/whats-new-dates-link-submit (2026-10-06; was:
    // order-partial-approval-held-2026-10): the public link, dates fixes and
    // PO-2 releases are published after it, and this reader (an owner with
    // every module) is told all three, the public link release newest.
    // Re-pinned by docs/whats-new-returns-exchange (2026-10-11; was:
    // public-link-sent-request-2026-10): returns RX-2's release is published
    // after it, and this reader (an owner with every module) is told it.
    // Re-pinned by docs/whats-new-returns-requester (2026-10-12; was:
    // returns-exchange-2026-10): returns RX-3's release is published after
    // it, and this reader (an owner with every module) is told it.
    // Re-pinned by docs/whats-new-returns-close-rest (2026-10-12; was:
    // returns-requester-exchange-2026-10): returns RX-4's release is
    // published after it, and this reader (an owner with every module) is
    // told it.
    // Re-pinned by docs/whats-new-return-history-hand-over (2026-10-12; was:
    // returns-close-rest-2026-10): the return history hand-over release is
    // published after it, and this reader (an owner with every module) is
    // told it.
    // Re-pinned by the What's New publish of ungroup-2026-10 and
    // group-selected-2026-10 (2026-10-12): was returns-history-hand-over-2026-10.
    // Group selected's release is published after it (a minute after
    // Ungroup's) and reaches every member, so this reader (an owner with
    // every module) is told it first.
    // Re-pinned by docs/whats-new-ungroup-follow-ups (2026-10-12; was: group-selected-2026-10): the Ungroup follow-ups release is published after it, at the top and reaches this reader.
    // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: ungroup-follow-ups-2026-10): the pages-keep-groups-whole release is published after it, at the top, and reaches this reader.
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: pages-keep-groups-whole-2026-10): the parked ai-search-finds-every-item release (#367) and the three redesign releases are published after it, at the top, and redesign-2026-10, the newest, reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: redesign-2026-10): the unsubscribe-rack-question-fixes release is published after it, at the top, and reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: unsubscribe-rack-question-fixes-2026-10): the ended-session-group-page-fixes release is published after it, at the top, and reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: ended-session-group-page-fixes-2026-10): the manage-order-items-and-app-fixes release is published after it, at the top, and reaches every member, this reader included.
    expect(list.latestUnread?.id).toBe('manage-order-items-and-app-fixes-2026-10');
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
    // release, the two order signature releases, the approval release, the
    // three releases of 2026-10-05 and slice 1's small fixes were published
    // after this one.
    // Re-pinned by the Items first-paint release (2026-10-06): published after the small fixes.
    // Re-pinned by the publishing of the weekly digest release (2026-10-06; was:
    // items-list-first-paint-2026-10): published after it, and every reader sees it.
    // Re-pinned by the publishing of the slice 2 release (2026-10-06; was:
    // weekly-digest-and-fixes-2026-10): published after it, and this reader
    // (an owner with every module) is told its approval, receiving and item
    // sheet entries.
    // Re-pinned by docs/whats-new-dates-link-submit (2026-10-06; was:
    // order-partial-approval-held-2026-10): the public link, dates fixes and
    // PO-2 releases are published after it, and this reader (an owner with
    // every module) is told all three, the public link release newest.
    // Re-pinned by docs/whats-new-returns-exchange (2026-10-11; was:
    // public-link-sent-request-2026-10): returns RX-2's release is published
    // after it, and this reader (an owner with every module) is told it.
    // Re-pinned by docs/whats-new-returns-requester (2026-10-12; was:
    // returns-exchange-2026-10): returns RX-3's release is published after
    // it, and this reader (an owner with every module) is told it.
    // Re-pinned by docs/whats-new-returns-close-rest (2026-10-12; was:
    // returns-requester-exchange-2026-10): returns RX-4's release is
    // published after it, and this reader (an owner with every module) is
    // told it.
    // Re-pinned by docs/whats-new-return-history-hand-over (2026-10-12; was:
    // returns-close-rest-2026-10): the return history hand-over release is
    // published after it, and this reader (an owner with every module) is
    // told it.
    // Re-pinned by the What's New publish of ungroup-2026-10 and
    // group-selected-2026-10 (2026-10-12): was returns-history-hand-over-2026-10.
    // Group selected's release is published after it (a minute after
    // Ungroup's) and reaches every member, so this reader (an owner with
    // every module) is told it first.
    // Re-pinned by docs/whats-new-ungroup-follow-ups (2026-10-12; was: group-selected-2026-10): the Ungroup follow-ups release is published after it, at the top and reaches this reader.
    // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: ungroup-follow-ups-2026-10): the pages-keep-groups-whole release is published after it, at the top, and reaches this reader.
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: pages-keep-groups-whole-2026-10): the parked ai-search-finds-every-item release (#367) and the three redesign releases are published after it, at the top, and redesign-2026-10, the newest, reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: redesign-2026-10): the unsubscribe-rack-question-fixes release is published after it, at the top, and reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: unsubscribe-rack-question-fixes-2026-10): the ended-session-group-page-fixes release is published after it, at the top, and reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: ended-session-group-page-fixes-2026-10): the manage-order-items-and-app-fixes release is published after it, at the top, and reaches every member, this reader included.
    expect(list.latestUnread?.id).toBe('manage-order-items-and-app-fixes-2026-10');
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
    // published 2026-10-05 once 0393 shipped) supersedes this release's claim.
    const copy = readFileSync(resolve(__dirname, '../../server/lib/account-deletion.ts'), 'utf8');
    expect(copy).not.toContain(`"${BLOCKED}"`);
    expect(copy).toContain(
      "'Your account could not be deleted because it is linked to a record that could not be released. Nothing was changed. Contact StockPilot support.'",
    );
    expect(RELEASES.find((x) => x.id === 'account-deletion-everyone-2026-10')?.status).toBe('published');
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
    // signature releases, the approval release, the three releases of
    // 2026-10-05 and slice 1's small fixes were published after this one.
    // Re-pinned by the Items first-paint release (2026-10-06): published after the small fixes.
    // Re-pinned by the publishing of the weekly digest release (2026-10-06; was:
    // items-list-first-paint-2026-10): published after it, and every reader sees it.
    // Re-pinned by the publishing of the slice 2 release (2026-10-06; was:
    // weekly-digest-and-fixes-2026-10): published after it, and this reader
    // (an owner with every module) is told its approval, receiving and item
    // sheet entries.
    // Re-pinned by docs/whats-new-dates-link-submit (2026-10-06; was:
    // order-partial-approval-held-2026-10): the public link, dates fixes and
    // PO-2 releases are published after it, and this reader (an owner with
    // every module) is told all three, the public link release newest.
    // Re-pinned by docs/whats-new-returns-exchange (2026-10-11; was:
    // public-link-sent-request-2026-10): returns RX-2's release is published
    // after it, and this reader (an owner with every module) is told it.
    // Re-pinned by docs/whats-new-returns-requester (2026-10-12; was:
    // returns-exchange-2026-10): returns RX-3's release is published after
    // it, and this reader (an owner with every module) is told it.
    // Re-pinned by docs/whats-new-returns-close-rest (2026-10-12; was:
    // returns-requester-exchange-2026-10): returns RX-4's release is
    // published after it, and this reader (an owner with every module) is
    // told it.
    // Re-pinned by docs/whats-new-return-history-hand-over (2026-10-12; was:
    // returns-close-rest-2026-10): the return history hand-over release is
    // published after it, and this reader (an owner with every module) is
    // told it.
    // Re-pinned by the What's New publish of ungroup-2026-10 and
    // group-selected-2026-10 (2026-10-12): was returns-history-hand-over-2026-10.
    // Group selected's release is published after it (a minute after
    // Ungroup's) and reaches every member, so this reader (an owner with
    // every module) is told it first.
    // Re-pinned by docs/whats-new-ungroup-follow-ups (2026-10-12; was: group-selected-2026-10): the Ungroup follow-ups release is published after it, at the top and reaches this reader.
    // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: ungroup-follow-ups-2026-10): the pages-keep-groups-whole release is published after it, at the top, and reaches this reader.
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: pages-keep-groups-whole-2026-10): the parked ai-search-finds-every-item release (#367) and the three redesign releases are published after it, at the top, and redesign-2026-10, the newest, reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: redesign-2026-10): the unsubscribe-rack-question-fixes release is published after it, at the top, and reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: unsubscribe-rack-question-fixes-2026-10): the ended-session-group-page-fixes release is published after it, at the top, and reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: ended-session-group-page-fixes-2026-10): the manage-order-items-and-app-fixes release is published after it, at the top, and reaches every member, this reader included.
    expect(list.latestUnread?.id).toBe('manage-order-items-and-app-fixes-2026-10');
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
    // signature releases, the approval release, the three releases of
    // 2026-10-05 and slice 1's small fixes were published after this one.
    // Re-pinned by the Items first-paint release (2026-10-06): published after the small fixes.
    // Re-pinned by the publishing of the weekly digest release (2026-10-06; was:
    // items-list-first-paint-2026-10): published after it, and every reader sees it.
    // Re-pinned by the publishing of the slice 2 release (2026-10-06; was:
    // weekly-digest-and-fixes-2026-10): published after it, and this reader
    // (an owner with every module) is told its approval, receiving and item
    // sheet entries.
    // Re-pinned by docs/whats-new-dates-link-submit (2026-10-06; was:
    // order-partial-approval-held-2026-10): the public link, dates fixes and
    // PO-2 releases are published after it, and this reader (an owner with
    // every module) is told all three, the public link release newest.
    // Re-pinned by docs/whats-new-returns-exchange (2026-10-11; was:
    // public-link-sent-request-2026-10): returns RX-2's release is published
    // after it, and this reader (an owner with every module) is told it.
    // Re-pinned by docs/whats-new-returns-requester (2026-10-12; was:
    // returns-exchange-2026-10): returns RX-3's release is published after
    // it, and this reader (an owner with every module) is told it.
    // Re-pinned by docs/whats-new-returns-close-rest (2026-10-12; was:
    // returns-requester-exchange-2026-10): returns RX-4's release is
    // published after it, and this reader (an owner with every module) is
    // told it.
    // Re-pinned by docs/whats-new-return-history-hand-over (2026-10-12; was:
    // returns-close-rest-2026-10): the return history hand-over release is
    // published after it, and this reader (an owner with every module) is
    // told it.
    // Re-pinned by the What's New publish of ungroup-2026-10 and
    // group-selected-2026-10 (2026-10-12): was returns-history-hand-over-2026-10.
    // Group selected's release is published after it (a minute after
    // Ungroup's) and reaches every member, so this reader (an owner with
    // every module) is told it first.
    // Re-pinned by docs/whats-new-ungroup-follow-ups (2026-10-12; was: group-selected-2026-10): the Ungroup follow-ups release is published after it, at the top and reaches this reader.
    // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: ungroup-follow-ups-2026-10): the pages-keep-groups-whole release is published after it, at the top, and reaches this reader.
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: pages-keep-groups-whole-2026-10): the parked ai-search-finds-every-item release (#367) and the three redesign releases are published after it, at the top, and redesign-2026-10, the newest, reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: redesign-2026-10): the unsubscribe-rack-question-fixes release is published after it, at the top, and reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: unsubscribe-rack-question-fixes-2026-10): the ended-session-group-page-fixes release is published after it, at the top, and reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: ended-session-group-page-fixes-2026-10): the manage-order-items-and-app-fixes release is published after it, at the top, and reaches every member, this reader included.
    expect(list.latestUnread?.id).toBe('manage-order-items-and-app-fixes-2026-10');
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
    // deletion releases, the two order signature releases, the approval
    // release, the three releases of 2026-10-05 and slice 1's small fixes were
    // published after this one.
    // Re-pinned by the Items first-paint release (2026-10-06): published after the small fixes.
    // Re-pinned by the publishing of the weekly digest release (2026-10-06; was:
    // items-list-first-paint-2026-10): published after it, and every reader sees it.
    // Re-pinned by the publishing of the slice 2 release (2026-10-06; was:
    // weekly-digest-and-fixes-2026-10): published after it, and this reader
    // (an owner with every module) is told its approval, receiving and item
    // sheet entries.
    // Re-pinned by docs/whats-new-dates-link-submit (2026-10-06; was:
    // order-partial-approval-held-2026-10): the public link, dates fixes and
    // PO-2 releases are published after it, and this reader (an owner with
    // every module) is told all three, the public link release newest.
    // Re-pinned by docs/whats-new-returns-exchange (2026-10-11; was:
    // public-link-sent-request-2026-10): returns RX-2's release is published
    // after it, and this reader (an owner with every module) is told it.
    // Re-pinned by docs/whats-new-returns-requester (2026-10-12; was:
    // returns-exchange-2026-10): returns RX-3's release is published after
    // it, and this reader (an owner with every module) is told it.
    // Re-pinned by docs/whats-new-returns-close-rest (2026-10-12; was:
    // returns-requester-exchange-2026-10): returns RX-4's release is
    // published after it, and this reader (an owner with every module) is
    // told it.
    // Re-pinned by docs/whats-new-return-history-hand-over (2026-10-12; was:
    // returns-close-rest-2026-10): the return history hand-over release is
    // published after it, and this reader (an owner with every module) is
    // told it.
    // Re-pinned by the What's New publish of ungroup-2026-10 and
    // group-selected-2026-10 (2026-10-12): was returns-history-hand-over-2026-10.
    // Group selected's release is published after it (a minute after
    // Ungroup's) and reaches every member, so this reader (an owner with
    // every module) is told it first.
    // Re-pinned by docs/whats-new-ungroup-follow-ups (2026-10-12; was: group-selected-2026-10): the Ungroup follow-ups release is published after it, at the top and reaches this reader.
    // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: ungroup-follow-ups-2026-10): the pages-keep-groups-whole release is published after it, at the top, and reaches this reader.
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: pages-keep-groups-whole-2026-10): the parked ai-search-finds-every-item release (#367) and the three redesign releases are published after it, at the top, and redesign-2026-10, the newest, reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: redesign-2026-10): the unsubscribe-rack-question-fixes release is published after it, at the top, and reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: unsubscribe-rack-question-fixes-2026-10): the ended-session-group-page-fixes release is published after it, at the top, and reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: ended-session-group-page-fixes-2026-10): the manage-order-items-and-app-fixes release is published after it, at the top, and reaches every member, this reader included.
    expect(list.latestUnread?.id).toBe('manage-order-items-and-app-fixes-2026-10');
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
    // the two order signature releases, the approval release, the three
    // releases of 2026-10-05 and slice 1's small fixes were published after
    // this one.
    // Re-pinned by the Items first-paint release (2026-10-06): published after the small fixes.
    // Re-pinned by the publishing of the weekly digest release (2026-10-06; was:
    // items-list-first-paint-2026-10): published after it, and every reader sees it.
    // Re-pinned by the publishing of the slice 2 release (2026-10-06; was:
    // weekly-digest-and-fixes-2026-10): published after it, and this reader
    // (an owner with every module) is told its approval, receiving and item
    // sheet entries.
    // Re-pinned by docs/whats-new-dates-link-submit (2026-10-06; was:
    // order-partial-approval-held-2026-10): the public link, dates fixes and
    // PO-2 releases are published after it, and this reader (an owner with
    // every module) is told all three, the public link release newest.
    // Re-pinned by docs/whats-new-returns-exchange (2026-10-11; was:
    // public-link-sent-request-2026-10): returns RX-2's release is published
    // after it, and this reader (an owner with every module) is told it.
    // Re-pinned by docs/whats-new-returns-requester (2026-10-12; was:
    // returns-exchange-2026-10): returns RX-3's release is published after
    // it, and this reader (an owner with every module) is told it.
    // Re-pinned by docs/whats-new-returns-close-rest (2026-10-12; was:
    // returns-requester-exchange-2026-10): returns RX-4's release is
    // published after it, and this reader (an owner with every module) is
    // told it.
    // Re-pinned by docs/whats-new-return-history-hand-over (2026-10-12; was:
    // returns-close-rest-2026-10): the return history hand-over release is
    // published after it, and this reader (an owner with every module) is
    // told it.
    // Re-pinned by the What's New publish of ungroup-2026-10 and
    // group-selected-2026-10 (2026-10-12): was returns-history-hand-over-2026-10.
    // Group selected's release is published after it (a minute after
    // Ungroup's) and reaches every member, so this reader (an owner with
    // every module) is told it first.
    // Re-pinned by docs/whats-new-ungroup-follow-ups (2026-10-12; was: group-selected-2026-10): the Ungroup follow-ups release is published after it, at the top and reaches this reader.
    // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: ungroup-follow-ups-2026-10): the pages-keep-groups-whole release is published after it, at the top, and reaches this reader.
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: pages-keep-groups-whole-2026-10): the parked ai-search-finds-every-item release (#367) and the three redesign releases are published after it, at the top, and redesign-2026-10, the newest, reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: redesign-2026-10): the unsubscribe-rack-question-fixes release is published after it, at the top, and reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: unsubscribe-rack-question-fixes-2026-10): the ended-session-group-page-fixes release is published after it, at the top, and reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: ended-session-group-page-fixes-2026-10): the manage-order-items-and-app-fixes release is published after it, at the top, and reaches every member, this reader included.
    expect(list.latestUnread?.id).toBe('manage-order-items-and-app-fixes-2026-10');
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
    // the two account deletion releases, the two order signature releases, the
    // approval release, the three releases of 2026-10-05 and slice 1's small
    // fixes were published after this one.
    // Re-pinned by the Items first-paint release (2026-10-06): published after the small fixes.
    // Re-pinned by the publishing of the weekly digest release (2026-10-06; was:
    // items-list-first-paint-2026-10): published after it, and every reader sees it.
    // Re-pinned by the publishing of the slice 2 release (2026-10-06; was:
    // weekly-digest-and-fixes-2026-10): published after it, and this reader
    // (an owner with every module) is told its approval, receiving and item
    // sheet entries.
    // Re-pinned by docs/whats-new-dates-link-submit (2026-10-06; was:
    // order-partial-approval-held-2026-10): the public link, dates fixes and
    // PO-2 releases are published after it, and this reader (an owner with
    // every module) is told all three, the public link release newest.
    // Re-pinned by docs/whats-new-returns-exchange (2026-10-11; was:
    // public-link-sent-request-2026-10): returns RX-2's release is published
    // after it, and this reader (an owner with every module) is told it.
    // Re-pinned by docs/whats-new-returns-requester (2026-10-12; was:
    // returns-exchange-2026-10): returns RX-3's release is published after
    // it, and this reader (an owner with every module) is told it.
    // Re-pinned by docs/whats-new-returns-close-rest (2026-10-12; was:
    // returns-requester-exchange-2026-10): returns RX-4's release is
    // published after it, and this reader (an owner with every module) is
    // told it.
    // Re-pinned by docs/whats-new-return-history-hand-over (2026-10-12; was:
    // returns-close-rest-2026-10): the return history hand-over release is
    // published after it, and this reader (an owner with every module) is
    // told it.
    // Re-pinned by the What's New publish of ungroup-2026-10 and
    // group-selected-2026-10 (2026-10-12): was returns-history-hand-over-2026-10.
    // Group selected's release is published after it (a minute after
    // Ungroup's) and reaches every member, so this reader (an owner with
    // every module) is told it first.
    // Re-pinned by docs/whats-new-ungroup-follow-ups (2026-10-12; was: group-selected-2026-10): the Ungroup follow-ups release is published after it, at the top and reaches this reader.
    // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: ungroup-follow-ups-2026-10): the pages-keep-groups-whole release is published after it, at the top, and reaches this reader.
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: pages-keep-groups-whole-2026-10): the parked ai-search-finds-every-item release (#367) and the three redesign releases are published after it, at the top, and redesign-2026-10, the newest, reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: redesign-2026-10): the unsubscribe-rack-question-fixes release is published after it, at the top, and reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: unsubscribe-rack-question-fixes-2026-10): the ended-session-group-page-fixes release is published after it, at the top, and reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: ended-session-group-page-fixes-2026-10): the manage-order-items-and-app-fixes release is published after it, at the top, and reaches every member, this reader included.
    expect(list.latestUnread?.id).toBe('manage-order-items-and-app-fixes-2026-10');
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
    // signature releases, the approval release, the three releases of
    // 2026-10-05 and slice 1's small fixes were published after this one.
    // Re-pinned by the Items first-paint release (2026-10-06): published after the small fixes.
    // Re-pinned by the publishing of the weekly digest release (2026-10-06; was:
    // items-list-first-paint-2026-10): published after it, and every reader sees it.
    // Re-pinned by the publishing of the slice 2 release (2026-10-06; was:
    // weekly-digest-and-fixes-2026-10): published after it, and this reader
    // (an owner with every module) is told its approval, receiving and item
    // sheet entries.
    // Re-pinned by docs/whats-new-dates-link-submit (2026-10-06; was:
    // order-partial-approval-held-2026-10): the public link, dates fixes and
    // PO-2 releases are published after it, and this reader (an owner with
    // every module) is told all three, the public link release newest.
    // Re-pinned by docs/whats-new-returns-exchange (2026-10-11; was:
    // public-link-sent-request-2026-10): returns RX-2's release is published
    // after it, and this reader (an owner with every module) is told it.
    // Re-pinned by docs/whats-new-returns-requester (2026-10-12; was:
    // returns-exchange-2026-10): returns RX-3's release is published after
    // it, and this reader (an owner with every module) is told it.
    // Re-pinned by docs/whats-new-returns-close-rest (2026-10-12; was:
    // returns-requester-exchange-2026-10): returns RX-4's release is
    // published after it, and this reader (an owner with every module) is
    // told it.
    // Re-pinned by docs/whats-new-return-history-hand-over (2026-10-12; was:
    // returns-close-rest-2026-10): the return history hand-over release is
    // published after it, and this reader (an owner with every module) is
    // told it.
    // Re-pinned by the What's New publish of ungroup-2026-10 and
    // group-selected-2026-10 (2026-10-12): was returns-history-hand-over-2026-10.
    // Group selected's release is published after it (a minute after
    // Ungroup's) and reaches every member, so this reader (an owner with
    // every module) is told it first.
    // Re-pinned by docs/whats-new-ungroup-follow-ups (2026-10-12; was: group-selected-2026-10): the Ungroup follow-ups release is published after it, at the top and reaches this reader.
    // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: ungroup-follow-ups-2026-10): the pages-keep-groups-whole release is published after it, at the top, and reaches this reader.
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: pages-keep-groups-whole-2026-10): the parked ai-search-finds-every-item release (#367) and the three redesign releases are published after it, at the top, and redesign-2026-10, the newest, reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: redesign-2026-10): the unsubscribe-rack-question-fixes release is published after it, at the top, and reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: unsubscribe-rack-question-fixes-2026-10): the ended-session-group-page-fixes release is published after it, at the top, and reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: ended-session-group-page-fixes-2026-10): the manage-order-items-and-app-fixes release is published after it, at the top, and reaches every member, this reader included.
    expect(list.latestUnread?.id).toBe('manage-order-items-and-app-fixes-2026-10');
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
    // The notice offers the newest unread release: the approval release, the
    // three releases of 2026-10-05 and slice 1's small fixes were published
    // after this one.
    // Re-pinned by the Items first-paint release (2026-10-06): published after the small fixes.
    // Re-pinned by the publishing of the weekly digest release (2026-10-06; was:
    // items-list-first-paint-2026-10): published after it, and every reader sees it.
    // Re-pinned by the publishing of the slice 2 release (2026-10-06; was:
    // weekly-digest-and-fixes-2026-10): published after it, and this reader
    // (an owner with every module) is told its approval, receiving and item
    // sheet entries.
    // Re-pinned by docs/whats-new-dates-link-submit (2026-10-06; was:
    // order-partial-approval-held-2026-10): the public link, dates fixes and
    // PO-2 releases are published after it, and this reader (an owner with
    // every module) is told all three, the public link release newest.
    // Re-pinned by docs/whats-new-returns-exchange (2026-10-11; was:
    // public-link-sent-request-2026-10): returns RX-2's release is published
    // after it, and this reader (an owner with every module) is told it.
    // Re-pinned by docs/whats-new-returns-requester (2026-10-12; was:
    // returns-exchange-2026-10): returns RX-3's release is published after
    // it, and this reader (an owner with every module) is told it.
    // Re-pinned by docs/whats-new-returns-close-rest (2026-10-12; was:
    // returns-requester-exchange-2026-10): returns RX-4's release is
    // published after it, and this reader (an owner with every module) is
    // told it.
    // Re-pinned by docs/whats-new-return-history-hand-over (2026-10-12; was:
    // returns-close-rest-2026-10): the return history hand-over release is
    // published after it, and this reader (an owner with every module) is
    // told it.
    // Re-pinned by the What's New publish of ungroup-2026-10 and
    // group-selected-2026-10 (2026-10-12): was returns-history-hand-over-2026-10.
    // Group selected's release is published after it (a minute after
    // Ungroup's) and reaches every member, so this reader (an owner with
    // every module) is told it first.
    // Re-pinned by docs/whats-new-ungroup-follow-ups (2026-10-12; was: group-selected-2026-10): the Ungroup follow-ups release is published after it, at the top and reaches this reader.
    // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: ungroup-follow-ups-2026-10): the pages-keep-groups-whole release is published after it, at the top, and reaches this reader.
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: pages-keep-groups-whole-2026-10): the parked ai-search-finds-every-item release (#367) and the three redesign releases are published after it, at the top, and redesign-2026-10, the newest, reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: redesign-2026-10): the unsubscribe-rack-question-fixes release is published after it, at the top, and reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: unsubscribe-rack-question-fixes-2026-10): the ended-session-group-page-fixes release is published after it, at the top, and reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: ended-session-group-page-fixes-2026-10): the manage-order-items-and-app-fixes release is published after it, at the top, and reaches every member, this reader included.
    expect(list.latestUnread?.id).toBe('manage-order-items-and-app-fixes-2026-10');
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
    // The notice offers the newest unread release: the timeline release, the
    // approval release, the three releases of 2026-10-05 and slice 1's small
    // fixes were published after this one.
    // Re-pinned by the Items first-paint release (2026-10-06): published after the small fixes.
    // Re-pinned by the publishing of the weekly digest release (2026-10-06; was:
    // items-list-first-paint-2026-10): published after it, and every reader sees it.
    // Re-pinned by the publishing of the slice 2 release (2026-10-06; was:
    // weekly-digest-and-fixes-2026-10): published after it, and this reader
    // (an owner with every module) is told its approval, receiving and item
    // sheet entries.
    // Re-pinned by docs/whats-new-dates-link-submit (2026-10-06; was:
    // order-partial-approval-held-2026-10): the public link, dates fixes and
    // PO-2 releases are published after it, and this reader (an owner with
    // every module) is told all three, the public link release newest.
    // Re-pinned by docs/whats-new-returns-exchange (2026-10-11; was:
    // public-link-sent-request-2026-10): returns RX-2's release is published
    // after it, and this reader (an owner with every module) is told it.
    // Re-pinned by docs/whats-new-returns-requester (2026-10-12; was:
    // returns-exchange-2026-10): returns RX-3's release is published after
    // it, and this reader (an owner with every module) is told it.
    // Re-pinned by docs/whats-new-returns-close-rest (2026-10-12; was:
    // returns-requester-exchange-2026-10): returns RX-4's release is
    // published after it, and this reader (an owner with every module) is
    // told it.
    // Re-pinned by docs/whats-new-return-history-hand-over (2026-10-12; was:
    // returns-close-rest-2026-10): the return history hand-over release is
    // published after it, and this reader (an owner with every module) is
    // told it.
    // Re-pinned by the What's New publish of ungroup-2026-10 and
    // group-selected-2026-10 (2026-10-12): was returns-history-hand-over-2026-10.
    // Group selected's release is published after it (a minute after
    // Ungroup's) and reaches every member, so this reader (an owner with
    // every module) is told it first.
    // Re-pinned by docs/whats-new-ungroup-follow-ups (2026-10-12; was: group-selected-2026-10): the Ungroup follow-ups release is published after it, at the top and reaches this reader.
    // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: ungroup-follow-ups-2026-10): the pages-keep-groups-whole release is published after it, at the top, and reaches this reader.
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: pages-keep-groups-whole-2026-10): the parked ai-search-finds-every-item release (#367) and the three redesign releases are published after it, at the top, and redesign-2026-10, the newest, reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: redesign-2026-10): the unsubscribe-rack-question-fixes release is published after it, at the top, and reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: unsubscribe-rack-question-fixes-2026-10): the ended-session-group-page-fixes release is published after it, at the top, and reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: ended-session-group-page-fixes-2026-10): the manage-order-items-and-app-fixes release is published after it, at the top, and reaches every member, this reader included.
    expect(list.latestUnread?.id).toBe('manage-order-items-and-app-fixes-2026-10');
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
 * Phone ordering PO-2 (#316, migration 0391, one create path) was held as a
 * DRAFT until 0391 was pushed and verified (2026-10-04 11:31:36-40Z), the web
 * deploy was live (web build 64f2e87634bb), the production smoke test that
 * writes nothing passed with the Demo Co check (28 checks), and the first
 * Learn4Life web order after the deploy (2026-10-05 16:13:14Z) had exactly
 * one placed web submission row and one created audit row (phone-orders plan
 * 10.1 steps 5 to 9). This follow-up (plan PO-5) publishes it, with the dates
 * fixes and public link releases above it and directly above slice 2's, and
 * re-reads its words against what shipped. Pinned by id, never by index.
 *
 * Re-pinned by docs/whats-new-dates-link-submit (2026-10-06; was: "one order
 * per submission (phone ordering PO-2) is held as a draft"): the release is
 * published.
 */
describe('one order per submission (phone ordering PO-2) is published', () => {
  const ID = 'order-submit-once-2026-10';
  const release = () => RELEASES.find((r) => r.id === ID)!;
  const everyone: ReleaseViewer = {
    role: 'owner',
    permissions: [...PERMISSIONS],
    enabledModules: Object.keys(MODULE_REGISTRY) as ModuleId[],
  };

  // Re-pinned by docs/whats-new-dates-link-submit (2026-10-06; was: "is a
  // draft, so no feed carries it, and preparing it changes nothing a client
  // can observe": a draft, in no feed, no legacy list and no fingerprint).
  it('is published after 0391, the web deploy, the smoke test, the Demo Co check and the first Learn4Life web order, so every feed it reaches carries it', () => {
    expect(release()).toBeDefined();
    expect(release().status).toBe('published');
    expect(release().revision).toBe(1);
    expect(visibleReleases(RELEASES, everyone).map((r) => r.id)).toContain(ID);
    const list = buildReleaseList(RELEASES, everyone, [], null);
    expect(list.releases.map((r) => r.id)).toContain(ID);
    // The public link and dates fixes releases are published after it, so an
    // owner with every module is told the public link release first, and
    // this one once both are read. A requester is told the dates fixes
    // release first (its digest line reaches every member), then this one.
    const readNow = (id: string) => ({
      release_id: id,
      revision: 1,
      dismissed_at: null,
      opened_at: '2026-10-06T13:00:00Z',
      read_at: '2026-10-06T13:00:00Z',
    });
    // Re-pinned by docs/whats-new-returns-exchange (2026-10-11; was: the
    // public link release first, and this one once it and the dates fixes
    // release are read): returns RX-2's release is published later still,
    // so that owner is told it first, and this one once all three are read.
    // Claim kept: a requester is told the dates fixes release, then this one.
    // Re-pinned by docs/whats-new-returns-requester (2026-10-12; was: RX-2's
    // release first, this one once it, the public link and the dates fixes
    // releases are read, and a requester told this one once the dates fixes
    // release is read): returns RX-3's release is published later still and
    // reaches both readers (a requester through its busy and pickup entries),
    // so each is told it first, and this one once it is read too. Claim kept:
    // a requester is told the dates fixes release, then this one.
    // Re-pinned by docs/whats-new-returns-close-rest (2026-10-12; was: RX-3's
    // release first for that owner, this one once it and the three below it
    // are read): returns RX-4's release is published later still and reaches
    // that owner, so it is told first, and this one once it is read too. It
    // reaches no requester without Returns on, so the requester's lines are
    // unchanged. Claim kept: a requester is told the dates fixes release,
    // then this one.
    // Re-pinned by docs/whats-new-return-history-hand-over (2026-10-12; was:
    // RX-4's release first for that owner, this one once it and the four
    // below it are read): the return history hand-over release is published
    // later still and reaches that owner, so it is told first, and this one
    // once it is read too. It reaches no requester without a returns
    // permission, so the requester's lines are unchanged. Claim kept: a
    // requester is told the dates fixes release, then this one.
    // Re-pinned by the What's New publish of ungroup-2026-10 and
    // group-selected-2026-10 (2026-10-12): was returns-history-hand-over-2026-10.
    // Group selected's release is published after it (a minute after
    // Ungroup's) and reaches every member, so this reader (an owner with
    // every module) is told it first.
    // Re-pinned by docs/whats-new-ungroup-follow-ups (2026-10-12; was: group-selected-2026-10): the Ungroup follow-ups release is published after it, at the top and reaches this reader.
    // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: ungroup-follow-ups-2026-10): the pages-keep-groups-whole release is published after it, at the top, and reaches this reader.
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: pages-keep-groups-whole-2026-10): the parked ai-search-finds-every-item release (#367) and the three redesign releases are published after it, at the top, and redesign-2026-10, the newest, reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: redesign-2026-10): the unsubscribe-rack-question-fixes release is published after it, at the top, and reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: unsubscribe-rack-question-fixes-2026-10): the ended-session-group-page-fixes release is published after it, at the top, and reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: ended-session-group-page-fixes-2026-10): the manage-order-items-and-app-fixes release is published after it, at the top, and reaches every member, this reader included.
    expect(list.latestUnread?.id).toBe('manage-order-items-and-app-fixes-2026-10');
    expect(
      buildReleaseList(
        RELEASES,
        everyone,
        [
          // Re-pinned by the What's New publish of ungroup-2026-10 and
          // group-selected-2026-10 (2026-10-12; was: the four returns
          // releases, the public link and the dates fixes releases read):
          // both are newer and reach that owner, so they are read too.
          // Re-pinned by docs/whats-new-ungroup-follow-ups (2026-10-12): the Ungroup follow-ups release is published at the top and reaches this reader, so it is read or seen here too and the order this test checks holds.
          // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: the reads without it): the pages-keep-groups-whole release is published at the top and reaches this reader, so it is read here too and the order this test checks holds.
          // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: the reads without them): the three redesign releases and the parked ai-search-finds-every-item release (#367) are published at the top and reach this reader, so they are read here too and the order this test checks holds.
          // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: the reads without it): the unsubscribe-rack-question-fixes release is published at the top and reaches this reader, so it is read here too and the order this test checks holds.
          // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: the reads without it): the ended-session-group-page-fixes release is published at the top and reaches this reader, so it is read here too and the order this test checks holds.
          // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: the reads without it): the manage-order-items-and-app-fixes release is published at the top and reaches this reader, so it is read here too and the order this test checks holds.
          readNow('manage-order-items-and-app-fixes-2026-10'),
          readNow('ended-session-group-page-fixes-2026-10'),
          readNow('unsubscribe-rack-question-fixes-2026-10'),
          readNow('redesign-2026-10'),
          readNow('redesign-mobile-app-2026-10'),
          readNow('redesign-web-fixes-2026-10'),
          readNow('ai-search-finds-every-item-2026-10'),
          readNow('pages-keep-groups-whole-2026-10'),
          readNow('ungroup-follow-ups-2026-10'),
          readNow('group-selected-2026-10'),
          readNow('ungroup-2026-10'),
          readNow('returns-history-hand-over-2026-10'),
          readNow('returns-close-rest-2026-10'),
          readNow('returns-requester-exchange-2026-10'),
          readNow('returns-exchange-2026-10'),
          readNow('public-link-sent-request-2026-10'),
          readNow('dates-fixes-2026-10'),
        ],
        null,
      ).latestUnread?.id,
    ).toBe(ID);
    const requester: ReleaseViewer = { role: 'viewer', permissions: ['orders:request'], enabledModules: ['orders'] };
    expect(visibleReleases(RELEASES, requester).map((r) => r.id)).not.toContain('returns-close-rest-2026-10');
    expect(visibleReleases(RELEASES, requester).map((r) => r.id)).not.toContain('returns-history-hand-over-2026-10');
    // Re-pinned by the What's New publish of ungroup-2026-10 and
    // group-selected-2026-10 (2026-10-12; was: RX-3's release first for a
    // requester): Group selected's release reaches every member (its list
    // entries have no audience), so a requester is told it first, and the
    // rest as before once it is read. Ungroup's reaches no requester without
    // items:update or items:create. Claim kept: a requester is told the
    // dates fixes release, then this one.
    expect(visibleReleases(RELEASES, requester).map((r) => r.id)).not.toContain('ungroup-2026-10');
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: group-selected-2026-10 first for a requester, and the
    // reads below without the redesign releases): the three redesign
    // releases are published at the top and reach every member (each has
    // entries with no audience), so a requester is told redesign-2026-10
    // first and, once the three are read, the rest as before. The parked
    // ai-search-finds-every-item release (#367) reaches no requester
    // without items:update. Claim kept: a requester is told the dates fixes
    // release, then this one.
    expect(visibleReleases(RELEASES, requester).map((r) => r.id)).not.toContain(
      'ai-search-finds-every-item-2026-10',
    );
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: redesign-2026-10 first for a requester, and the reads
    // below without the newest release): the unsubscribe-rack-question-fixes release is published at the top and
    // reaches every member, so a requester is told it first, redesign-2026-10 once it is read, and the rest as before
    // once it is read with the redesign releases. Claim kept: a requester is told the dates fixes release, then this
    // one.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: unsubscribe-rack-question-fixes-2026-10 first for a
    // requester, and the reads below without the release at the top): the ended-session-group-page-fixes release is
    // published at the top and reaches every member, so a requester is told it first, the
    // unsubscribe-rack-question-fixes release once it is read, and the rest as before once it is read with them.
    // Claim kept: a requester is told the dates fixes release, then this one.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: ended-session-group-page-fixes-2026-10 first for a
    // requester, and the reads below without the release at the top): the manage-order-items-and-app-fixes release
    // is published at the top and reaches every member, so a requester is told it first, the
    // ended-session-group-page-fixes release once it is read, and the rest as before once it is read with them.
    // Claim kept: a requester is told the dates fixes release, then this one.
    expect(buildReleaseList(RELEASES, requester, [], null).latestUnread?.id).toBe(
      'manage-order-items-and-app-fixes-2026-10',
    );
    expect(buildReleaseList(RELEASES, requester, [latestRead()], null).latestUnread?.id).toBe(
      'ended-session-group-page-fixes-2026-10',
    );
    expect(
      buildReleaseList(RELEASES, requester, [latestRead(), topRead()], null).latestUnread?.id,
    ).toBe('unsubscribe-rack-question-fixes-2026-10');
    expect(
      buildReleaseList(RELEASES, requester, [latestRead(), topRead(), newestRead()], null)
        .latestUnread?.id,
    ).toBe('redesign-2026-10');
    const redesignRead = [
      readNow('manage-order-items-and-app-fixes-2026-10'),
      readNow('ended-session-group-page-fixes-2026-10'),
      readNow('unsubscribe-rack-question-fixes-2026-10'),
      readNow('redesign-2026-10'),
      readNow('redesign-mobile-app-2026-10'),
      readNow('redesign-web-fixes-2026-10'),
    ];
    expect(buildReleaseList(RELEASES, requester, redesignRead, null).latestUnread?.id).toBe(
      'group-selected-2026-10',
    );
    const groupSelectedRead = readNow('group-selected-2026-10');
    expect(
      buildReleaseList(RELEASES, requester, [...redesignRead, groupSelectedRead], null).latestUnread
        ?.id,
    ).toBe('returns-requester-exchange-2026-10');
    expect(
      buildReleaseList(
        RELEASES,
        requester,
        [...redesignRead, groupSelectedRead, readNow('returns-requester-exchange-2026-10')],
        null,
      ).latestUnread?.id,
    ).toBe('dates-fixes-2026-10');
    expect(
      buildReleaseList(
        RELEASES,
        requester,
        [
          ...redesignRead,
          groupSelectedRead,
          readNow('returns-requester-exchange-2026-10'),
          readNow('dates-fixes-2026-10'),
        ],
        null,
      ).latestUnread?.id,
    ).toBe(ID);
    // An old phone build lists at most three unread releases, newest first,
    // showing the title, the summary and the New order page link.
    // Re-pinned by docs/whats-new-returns-exchange (2026-10-11; was: with
    // nothing read): returns RX-2's release is newer, so the list is read
    // with it read; the same three, this one third.
    // Re-pinned by docs/whats-new-returns-requester (2026-10-12; was: with
    // RX-2's release read): returns RX-3's release is newer still, so the
    // list is read with both read; the same three, this one third.
    // Re-pinned by docs/whats-new-returns-close-rest (2026-10-12; was: with
    // RX-2's and RX-3's releases read): returns RX-4's release is newer
    // still, so the list is read with the three read; the same three, this
    // one third.
    // Re-pinned by docs/whats-new-return-history-hand-over (2026-10-12; was:
    // with RX-2's, RX-3's and RX-4's releases read): the return history
    // hand-over release is newer still, so the list is read with the four
    // read; the same three, this one third.
    // Re-pinned by the What's New publish of ungroup-2026-10 and
    // group-selected-2026-10 (2026-10-12; was: with the four returns
    // releases read): both are newer still, so the list is read with them
    // read too; the same three, this one third.
    const rx2Read = {
      // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: the seen set without them): the three redesign releases and the parked ai-search-finds-every-item release (#367) are published at the top and reach this reader, so they are seen here too and the order this test checks holds.
      // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: the seen set without it): the unsubscribe-rack-question-fixes release is published at the top and reaches this reader, so it is seen here too and the order this test checks holds.
      // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: the seen set without it): the ended-session-group-page-fixes release is published at the top and reaches this reader, so it is seen here too and the order this test checks holds.
      // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: the seen set without it): the manage-order-items-and-app-fixes release is published at the top and reaches this reader, so it is seen here too and the order this test checks holds.
      'manage-order-items-and-app-fixes-2026-10': true,
      'ended-session-group-page-fixes-2026-10': true,
      'unsubscribe-rack-question-fixes-2026-10': true,
      'redesign-2026-10': true,
      'redesign-mobile-app-2026-10': true,
      'redesign-web-fixes-2026-10': true,
      'ai-search-finds-every-item-2026-10': true,
      // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: the seen set without it): the pages-keep-groups-whole release is published at the top and reaches this reader, so it is seen here too and the order this test checks holds.
      'pages-keep-groups-whole-2026-10': true,
      'ungroup-follow-ups-2026-10': true,
      'group-selected-2026-10': true,
      'ungroup-2026-10': true,
      'returns-history-hand-over-2026-10': true,
      'returns-close-rest-2026-10': true,
      'returns-requester-exchange-2026-10': true,
      'returns-exchange-2026-10': true,
    };
    expect(legacyAnnouncementsFor(RELEASES, everyone, rx2Read).map((a) => a.id)).toEqual([
      'public-link-sent-request-2026-10',
      'dates-fixes-2026-10',
      ID,
    ]);
    expect(legacyAnnouncementsFor(RELEASES, everyone, rx2Read)[2]).toEqual({
      id: ID,
      date: '2026-10-06',
      title: release().title,
      body: release().summary,
      cta: { href: '/dashboard/orders/new', label: 'Place an order' },
    });
    // Publishing it changes what clients observe.
    expect(registryFingerprint(RELEASES)).toContain(`${ID}@1:published`);
    expect(registryFingerprint(RELEASES)).not.toBe(registryFingerprint(RELEASES.filter((r) => r.id !== ID)));
    expect(ANNOUNCEMENTS.map((a) => a.id)).toContain(ID);
    // A real time on a whole minute, after the read-only re-check of the
    // first Learn4Life web order (2026-10-06 12:32Z): never the draft's
    // placeholder date (2026-10-11T17:10Z).
    expect(release().publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/);
    expect(Date.parse(release().publishedAt)).toBeGreaterThan(Date.parse('2026-10-06T12:32:00Z'));
    expect(Date.parse(release().publishedAt)).toBeLessThanOrEqual(Date.parse('2026-10-07T00:00:00Z'));
  });

  // Re-pinned by docs/whats-new-dates-link-submit (2026-10-06; was: "is a
  // draft above every published release (...), below only the public link
  // and dates fixes drafts, dated after every release but those two"): it is
  // published, in the same place, and no draft is left.
  it('sits below the public link and dates fixes releases (published later) and directly above slice 2\'s release, dated after every release below it and before the two above it', () => {
    // Re-pinned by the B44 phone update draft (fix/b44-update-restart-prompt;
    // was: without it): dated after every release, it sits at the top, so
    // every position below it moves down by one, and it and slice 8's are the
    // drafts.
    // Re-pinned by the small fixes slice 8 draft (fix/small-fixes-8; was:
    // without it): dated after every release, it sits at the top, so every
    // position below it moves down by one, and it is the one draft.
    // Re-pinned by the publishing of 2026-10-05 (was: PO-4's, A3's and
    // RX-1's drafts sat beside it). It waits for the first order an
    // organization places through the new submit path, so it stays a draft
    // above the newest published release, dated after every published
    // release. Re-pinned by the weekly digest fixes (2026-10-05): their draft
    // is dated later and sits above it. Re-pinned by the Items first-paint
    // draft (2026-10-05): it is dated later still and sits at the top.
    // Re-pinned by the publishing of the small fixes (slice 1, 2026-10-05;
    // was: below their draft, at 3): they are published now, the newest
    // published release, directly below it.
    // Re-pinned by the publishing of the Items first-paint release
    // (2026-10-06; was: at 2, below the Items and weekly digest drafts): it is
    // published now, below the drafts, so only the weekly digest draft is
    // above this one.
    // Re-pinned by the publishing of the weekly digest release (2026-10-06;
    // was: at 1, below the weekly digest draft): it is published now, below
    // the drafts, so this one is the newest entry, at the top.
    // Re-pinned by the dates fixes draft (fix/dates-in-org-and-utc,
    // 2026-10-06; was: at 0, the newest entry): dated later, it sits at the
    // top, directly above this one.
    // Re-pinned by the public link draft (fix/placed-cart-draft; was: at 1,
    // below the dates fixes draft): dated later still, it sits at the top.
    // Re-pinned by returns RX-2 (2026-10-11; was: at 2, the public link and
    // dates fixes releases at 0 and 1): RX-2's draft, dated later, sits at
    // the top, above both. Claim kept: those two sit directly above this one.
    // Re-pinned by returns RX-3 (2026-10-11; was: at 3, RX-2's release at 0):
    // RX-3's draft, dated later still, sits at the top above RX-2's published
    // release. Claim kept: the public link and dates fixes releases sit
    // directly above.
    // Re-pinned by returns RX-4 (2026-10-12; was: at 4, RX-3's published
    // release at 0): RX-4's draft, dated later still, sits at the top above
    // it. Claim kept: the public link and dates fixes releases sit directly
    // above.
    // Re-pinned by the return history hand-over fix (D-H1, 2026-10-12; was:
    // at 5, RX-4's release at 0): its draft, dated later still, sits at the
    // top above RX-4's release. Claim kept: the public link and dates fixes
    // releases sit directly above.
    // Re-pinned by Ungroup G1 (2026-10-12, rebased onto #354; was: at 6, the
    // return history hand-over release at 0): Ungroup's draft, dated later
    // still, sits at the top above it. Claim kept: the public link and dates
    // fixes releases sit directly above.
    const at = RELEASES.findIndex((r) => r.id === ID);
    // Re-pinned by Group selected G2 (2026-10-12, rebased onto #351; was: at
    // 7, Ungroup's draft at 0): Group selected's draft, dated later still,
    // sits at the top above Ungroup's. Claim kept: the public link and dates
    // fixes releases sit directly above.
    // Re-pinned by docs/whats-new-ungroup-follow-ups (2026-10-12; was: 8): the Ungroup follow-ups release is published after it, at the top.
    // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: 9): the pages-keep-groups-whole release is published after it, at the top.
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: 10): the three redesign releases and the parked ai-search-finds-every-item release (#367) are published after it, at the top, so it sits four places lower.
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: 14): the unsubscribe-rack-question-fixes release is published after it, at the top, so it sits one place lower.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: 15): the ended-session-group-page-fixes release is published after it, at the top, so it sits one place lower.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: 16): the manage-order-items-and-app-fixes release is published after it, at the top, so it sits one place lower.
    expect(at).toBe(19);
    // Re-pinned by docs/whats-new-ungroup-follow-ups (2026-10-12): the Ungroup follow-ups release is published at the top, above Group selected's, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: the Ungroup follow-ups release at 0, the dates fixes release at 8): the pages-keep-groups-whole release is published at the top, above the Ungroup follow-ups release, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: the pages-keep-groups-whole release at 0, the dates fixes release at 9): the three redesign releases and the parked ai-search-finds-every-item release (#367) are published at the top, above the pages-keep-groups-whole release, so every position below them moves down by four.
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: redesign-2026-10 at 0, the dates fixes release at 13): the unsubscribe-rack-question-fixes release is published at the top, above the redesign releases, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: unsubscribe-rack-question-fixes-2026-10 at 0, the dates fixes release at 14): the ended-session-group-page-fixes release is published at the top, above it, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: ended-session-group-page-fixes-2026-10 at 0, the dates fixes release at 15): the manage-order-items-and-app-fixes release is published at the top, above it, so every position below it moves down by one.
    expect(RELEASES[2]?.id).toBe('manage-order-items-and-app-fixes-2026-10');
    expect(RELEASES[2]?.status).toBe('published');
    expect(RELEASES[3]?.id).toBe('ended-session-group-page-fixes-2026-10');
    expect(RELEASES[3]?.status).toBe('published');
    expect(RELEASES[4]?.id).toBe('unsubscribe-rack-question-fixes-2026-10');
    expect(RELEASES[4]?.status).toBe('published');
    expect(RELEASES[5]?.id).toBe('redesign-2026-10');
    expect(RELEASES[5]?.status).toBe('published');
    expect(RELEASES[6]?.id).toBe('redesign-mobile-app-2026-10');
    expect(RELEASES[6]?.status).toBe('published');
    expect(RELEASES[7]?.id).toBe('redesign-web-fixes-2026-10');
    expect(RELEASES[7]?.status).toBe('published');
    expect(RELEASES[8]?.id).toBe('ai-search-finds-every-item-2026-10');
    expect(RELEASES[8]?.status).toBe('published');
    expect(RELEASES[9]?.id).toBe('pages-keep-groups-whole-2026-10');
    expect(RELEASES[9]?.status).toBe('published');
    expect(RELEASES[10]?.id).toBe('ungroup-follow-ups-2026-10');
    expect(RELEASES[10]?.status).toBe('published');
    expect(RELEASES[11]?.id).toBe('group-selected-2026-10');
    expect(RELEASES[12]?.id).toBe('ungroup-2026-10');
    expect(RELEASES[13]?.id).toBe('returns-history-hand-over-2026-10');
    expect(RELEASES[14]?.id).toBe('returns-close-rest-2026-10');
    expect(RELEASES[15]?.id).toBe('returns-requester-exchange-2026-10');
    expect(RELEASES[16]?.id).toBe('returns-exchange-2026-10');
    expect(RELEASES[17]?.id).toBe('public-link-sent-request-2026-10');
    expect(RELEASES[18]?.id).toBe('dates-fixes-2026-10');
    // Re-pinned by 0395 (was: the Items first-paint and weekly digest drafts
    // and this one): the partial-approval draft (small fixes slice 2) sits
    // right below this one and is dated earlier.
    // Re-pinned by the publishing of the weekly digest release (2026-10-06;
    // was: the weekly digest draft, this one and the partial-approval draft).
    // Re-pinned by the dates fixes draft (2026-10-06; was: this one and the
    // partial-approval draft).
    // Re-pinned by the public link draft (fix/placed-cart-draft; was: the
    // dates fixes draft, this one and the partial-approval draft).
    // Re-pinned by the publishing of the slice 2 release (2026-10-06; was:
    // the public link draft, the dates fixes draft, this one and the
    // partial-approval draft): it is published now, so three drafts remain.
    // Re-pinned by docs/whats-new-dates-link-submit (2026-10-06; was: the
    // public link draft, the dates fixes draft and this one): all three are
    // published, in the same places, so no draft is left.
    // Re-pinned by returns RX-2 (2026-10-11; was: no draft): RX-2's draft is
    // the only one. Claim kept: these three are published.
    // Re-pinned by docs/whats-new-returns-exchange (2026-10-11; was: RX-2's
    // draft the only one): it is published, in the same place, so no draft
    // is left. Claim kept: these three are published.
    // Re-pinned by returns RX-3 (2026-10-11; was: no draft, RELEASES[1]
    // published): RX-3's draft is the only one, at the top, and RX-2's
    // release below it is published. Claim kept: these three are published.
    // Re-pinned by docs/whats-new-returns-requester (2026-10-12; was: RX-3's
    // draft the only one): it is published, in the same place, so no draft
    // is left. Claim kept: these three are published.
    // Re-pinned by returns RX-4 (2026-10-12; was: no draft, RELEASES[1] and
    // [1] published): RX-4's draft is the only one, at the top, and RX-3's and
    // RX-2's releases below it are published. Claim kept: these three are
    // published.
    // Re-pinned by docs/whats-new-returns-close-rest (2026-10-12; was: RX-4's
    // draft the only one): it is published, in the same place, so no draft
    // is left. Claim kept: these three are published.
    // Re-pinned by the return history hand-over fix (D-H1, 2026-10-12; was:
    // no draft, RELEASES[1] to [2] published): its draft is the only one, at
    // the top, and RX-4's, RX-3's and RX-2's releases below it are published.
    // Claim kept: these three are published.
    // Re-pinned by docs/whats-new-return-history-hand-over (2026-10-12; was:
    // its draft the only one): it is published, in the same place, so no
    // draft is left. Claim kept: these three are published.
    // Re-pinned by Ungroup G1 (2026-10-12, rebased onto #354; was: no draft,
    // RELEASES[1] to [3] published): Ungroup's draft is the only one, at the
    // top, and the hand-over, RX-4's, RX-3's and RX-2's releases below it are
    // published. Claim kept: these three are published.
    // Re-pinned by Group selected G2 (2026-10-12, rebased onto #351; was:
    // Ungroup's draft the only one, RELEASES[1] to [4] published): Group
    // selected's draft above it, then the same, published. Claim kept: these
    // three are published.
    // Re-pinned by the What's New publish of ungroup-2026-10 and
    // group-selected-2026-10 (2026-10-12; was: those two drafts): both are
    // published, so no draft is left.
    expect(RELEASES.filter((r) => r.status === 'draft').map((r) => r.id)).toEqual([
      'mobile-app-asks-before-restarting',
      'small-fixes-8-2026-10',
    ]);
    // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: RELEASES[3] to [6]): the same four returns releases, one place lower under the new release at the top.
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: RELEASES[4] to [7]): the same four returns releases, four places lower under the four new releases at the top.
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: RELEASES[8] to [11]): the same four returns releases, one place lower under the new release at the top.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: RELEASES[9] to [12]): the same four returns releases, one place lower under the new release at the top.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: RELEASES[10] to [13]): the same four returns releases, one place lower under the new release at the top.
    expect(RELEASES[13]?.status).toBe('published');
    expect(RELEASES[14]?.status).toBe('published');
    expect(RELEASES[15]?.status).toBe('published');
    expect(RELEASES[16]?.status).toBe('published');
    for (const id of ['public-link-sent-request-2026-10', 'dates-fixes-2026-10', ID]) {
      expect(RELEASES.find((r) => r.id === id)?.status, id).toBe('published');
    }
    // Re-pinned by the publishing of the slice 2 release (2026-10-06; was:
    // without it): it is one of the published releases below this draft.
    for (const id of [
      'order-partial-approval-held-2026-10',
      'weekly-digest-and-fixes-2026-10',
      'items-list-first-paint-2026-10',
      'small-fixes-2026-10',
      'phone-place-order-2026-10',
      'returns-original-rack-2026-10',
      'account-deletion-everyone-2026-10',
      'approval-follows-permission-2026-10',
      'order-signature-timeline-2026-10',
    ]) {
      const i = RELEASES.findIndex((r) => r.id === id);
      expect(i, id).toBeGreaterThan(at);
      expect(RELEASES[i]?.status, id).toBe('published');
    }
    // Re-pinned by the publishing of the slice 2 release (2026-10-06; was: the
    // partial-approval draft, right below this one): the same release, now
    // published, the newest published release, directly below the drafts.
    expect(RELEASES[at + 1]?.id).toBe('order-partial-approval-held-2026-10');
    expect(RELEASES[at + 1]?.status).toBe('published');
    // Re-pinned by the publishing of the weekly digest release (2026-10-06;
    // was: the Items first-paint release, then the small fixes, below the
    // partial-approval draft): the weekly digest release sits between them.
    expect(RELEASES[at + 2]?.id).toBe('weekly-digest-and-fixes-2026-10');
    expect(RELEASES[at + 3]?.id).toBe('items-list-first-paint-2026-10');
    expect(RELEASES[at + 4]?.id).toBe('small-fixes-2026-10');
    // Re-pinned by the publishing of the weekly digest release (2026-10-06;
    // was: every release but the weekly digest draft, dated later): it is
    // published now, dated before this draft, so this one is dated after
    // every other release. Re-pinned by the dates fixes draft (2026-10-06;
    // was: every release): that draft is dated later.
    // Re-pinned by the public link draft (fix/placed-cart-draft): dated later
    // too, so every release below this one is dated earlier and both drafts
    // above it later.
    // Re-pinned by docs/whats-new-dates-link-submit (2026-10-06): published,
    // all three keep that order, the dates fixes a minute after this one and
    // the public link release a minute after that.
    for (const r of RELEASES.slice(at + 1)) {
      expect(Date.parse(release().publishedAt), r.id).toBeGreaterThan(Date.parse(r.publishedAt));
    }
    for (const r of RELEASES.slice(2, at)) {
      expect(Date.parse(r.publishedAt), r.id).toBeGreaterThan(Date.parse(release().publishedAt));
    }
    // Re-pinned by returns RX-2 (2026-10-11; was: RELEASES[2] and [0]): the
    // same two releases, one place lower under RX-2's draft.
    // Re-pinned by returns RX-3 (2026-10-11; was: RELEASES[3] and [1]): the
    // same two releases, one place lower again under RX-3's draft.
    // Re-pinned by returns RX-4 (2026-10-12; was: RELEASES[4] and [2]): the
    // same two releases, one place lower again under RX-4's draft.
    // Re-pinned by the return history hand-over fix (D-H1, 2026-10-12; was:
    // RELEASES[5] and [3]): the same two releases, one place lower again
    // under its draft.
    // Re-pinned by Ungroup G1 (2026-10-12, rebased onto #354; was:
    // RELEASES[6] and [4]): the same two releases, one place lower again
    // under Ungroup's draft.
    // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: RELEASES[8] and [7]): the same two releases, one place lower again under the new release at the top.
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: RELEASES[9] and [8]): the same two releases, four places lower under the four new releases at the top.
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: RELEASES[13] and [12]): the same two releases, one place lower under the new release at the top.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: RELEASES[14] and [13]): the same two releases, one place lower under the new release at the top.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: RELEASES[15] and [14]): the same two releases, one place lower under the new release at the top.
    expect(Date.parse(RELEASES[18]!.publishedAt) - Date.parse(release().publishedAt)).toBe(60_000);
    expect(Date.parse(RELEASES[17]!.publishedAt) - Date.parse(RELEASES[18]!.publishedAt)).toBe(
      60_000,
    );
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
    // Re-pinned by docs/whats-new-dates-link-submit (2026-10-06; was: a copy
    // forced to published): the release itself is published now.
    expect(r.status).toBe('published');
    const entriesFor = (role: ReleaseViewer['role'], permissions: ReleaseViewer['permissions'], modules: ModuleId[] = ['orders']) =>
      visibleReleases([r], { role, permissions, enabledModules: modules })[0]?.entries.length ?? 0;
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

  // Publish re-read (docs/whats-new-dates-link-submit, 2026-10-06), against
  // the New order page on main.
  it('says only what the page does: a resend can be refused, a closed tab keeps no review, the pending request is kept per warehouse', () => {
    const once = release().entries[0]!;
    // A resend can be refused (an item archived since, a needed-by date now
    // past): the review then says why, as PO-4's release says for the app.
    expect(once.whatChanged).toContain("if not, it is placed now, once, or the page says why it can't be.");
    const phone = RELEASES.find((r) => r.id === 'phone-place-order-2026-10')!;
    expect(phone.entries[1]!.whatChanged).toContain("or the app says why it can't be.");
    // The examples of a lost answer are the ones the open review survives; a
    // closed tab is checked when the page is opened again.
    // Re-pinned by the claims review of #339 (2026-10-06; was: "(a slow or
    // lost connection), the review stays open"): the send has no timeout, so
    // a slow answer that arrives shows the outcome and no panel.
    expect(once.whatChanged).toContain('(for example, the connection drops), the review stays open');
    expect(once.whatChanged).not.toMatch(/closed tab|slow/);
    // The pending record is kept per account, organization and warehouse
    // (order-submission.ts orderPendingKey), and a new tab opens on the
    // first warehouse unless one is named.
    const submission = readFileSync(
      resolve(__dirname, '../../components/orders/storefront/order-submission.ts'),
      'utf8',
    );
    expect(submission).toContain('return `order-pending:v1:${userId}:${organizationId}:${warehouseId}`;');
    expect(once.howItAffectsYou).toContain(
      'If you reload the page, or open it for the same warehouse in another tab, it remembers and checks for you.',
    );
  });

  // Claims review of #339 (2026-10-06), against the New order page on main.
  it('says what else #316 changed that a person sees: the selection waits for that warehouse, the cart is per account, refusals name the items, and the corrected promises', () => {
    const r = release();
    const [once, refusals, , labels] = r.entries;
    const storefront = readFileSync(
      resolve(__dirname, '../../components/orders/storefront/orders-storefront.tsx'),
      'utf8',
    );
    // Start an order waits only on the open page's own pending request, and
    // it opens the selection's warehouse, so another warehouse's items go in
    // at once.
    expect(storefront).toContain(
      "const prefillWaits = liveKey !== null || submission.state.phase === 'placed';",
    );
    expect(once!.howItAffectsYou).toContain(
      'and, for that warehouse, items you start an order with from Items wait until then.',
    );
    // The cart draft is the signed-in account's (order-draft:v2:<user>:)
    // since #316; before it, the next person on a shared browser opened the
    // last person's cart.
    expect(storefront).toContain('draftPrefix={orderDraftPrefixFor(props.viewerUserId)}');
    expect(once!.howItAffectsYou).toContain(
      'Your cart and the pending order request are kept only for your account and organization on that browser: someone else who signs in there starts with their own cart and never sees or sends your request',
    );
    // The review lists the items; the reason for each is on its cart line.
    expect(refusals!.whatChanged).toMatch(/^When an order request can't be placed, the page now says why, in place: /);
    const cart = readFileSync(
      resolve(__dirname, '../../components/orders/storefront/storefront-cart.tsx'),
      'utf8',
    );
    // Ordering visibility (0413, design 6.5) moved the line's words to core's
    // cartLineView, the phone's rule: a refused line still says its reason by
    // the item's name (orderItemRefusalCopy inside it), never by its id.
    expect(cart).toContain('const view = cartLineView(line, item, unorderable, refusedReason);');
    expect(cart).toContain('const refusedReason = refusedItems.get(line.itemId);');
    // The success sentence names who hears about the order, Pick up at no
    // longer promises a ready time, and approvers are offered Review and
    // approve (orders:approve, not a viewer).
    const overlays = readFileSync(
      resolve(__dirname, '../../components/orders/storefront/storefront-overlays.tsx'),
      'utf8',
    );
    expect(overlays).toContain('successSentForApprovalCopy(submitted.order.requestedFor)');
    expect(overlays).toContain('{submitted && canApproveOrders && (');
    expect(storefront).toContain('{storefrontPickupHintCopy(warehouseName)}');
    const page = readFileSync(
      resolve(__dirname, '../../app/(dashboard)/dashboard/orders/new/page.tsx'),
      'utf8',
    );
    expect(page).toContain("canApproveOrders={can(ctx, 'orders:approve') && ctx.role !== 'viewer'}");
    expect(labels!.whatChanged).toContain(
      'After you submit, the page says who hears about it (on an order for someone else, emails about it go to that person) and, if you approve orders, offers Review and approve. Pick up at no longer promises a time it will be ready.',
    );
    expect(labels!.howItAffectsYou).toContain('such as For and Pickup or delivery in the setup bar');
    const text = readerText(r).join(' ');
    expect(text).not.toMatch(/business day|You'll get an email/);
  });
});

/**
 * Placing an order request in the iPhone and iPad app (phone ordering PO-4,
 * #320, 84c59c0d, merged 2026-10-05 06:15:59Z) was held as a DRAFT until the
 * web deploy (web build d6f607a6e66f), the phone update (OTA group 62d31b09,
 * iOS update 01a10ab5, launched on phones) and the Demo Co production walk
 * (SO-000023 placed from an iPhone on the published bundle, the status read,
 * Don't send it and a resend under the same key each answering that order and
 * writing nothing, then cancelled while pending) were done. Pinned by id,
 * never by index. This follow-up publishes it, the newest release, a minute
 * after returns RX-1's; PO-2's draft sits above it. Slice 1's small fixes were
 * published above it later.
 */
describe('placing an order in the mobile app (phone ordering PO-4) is published', () => {
  const ID = 'phone-place-order-2026-10';
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
    // The notice offers the newest unread release: slice 1's small fixes were
    // published after this one. Re-pinned by their publishing (was: this one,
    // the newest).
    // Re-pinned by the Items first-paint release (2026-10-06): published after the small fixes.
    // Re-pinned by the publishing of the weekly digest release (2026-10-06; was:
    // items-list-first-paint-2026-10): published after it, and every reader sees it.
    // Re-pinned by the publishing of the slice 2 release (2026-10-06; was:
    // weekly-digest-and-fixes-2026-10): published after it, and this reader
    // (an owner with every module) is told its approval, receiving and item
    // sheet entries.
    // Re-pinned by docs/whats-new-dates-link-submit (2026-10-06; was:
    // order-partial-approval-held-2026-10): the public link, dates fixes and
    // PO-2 releases are published after it, and this reader (an owner with
    // every module) is told all three, the public link release newest.
    // Re-pinned by docs/whats-new-returns-exchange (2026-10-11; was:
    // public-link-sent-request-2026-10): returns RX-2's release is published
    // after it, and this reader (an owner with every module) is told it.
    // Re-pinned by docs/whats-new-returns-requester (2026-10-12; was:
    // returns-exchange-2026-10): returns RX-3's release is published after
    // it, and this reader (an owner with every module) is told it.
    // Re-pinned by docs/whats-new-returns-close-rest (2026-10-12; was:
    // returns-requester-exchange-2026-10): returns RX-4's release is
    // published after it, and this reader (an owner with every module) is
    // told it.
    // Re-pinned by docs/whats-new-return-history-hand-over (2026-10-12; was:
    // returns-close-rest-2026-10): the return history hand-over release is
    // published after it, and this reader (an owner with every module) is
    // told it.
    // Re-pinned by the What's New publish of ungroup-2026-10 and
    // group-selected-2026-10 (2026-10-12): was returns-history-hand-over-2026-10.
    // Group selected's release is published after it (a minute after
    // Ungroup's) and reaches every member, so this reader (an owner with
    // every module) is told it first.
    // Re-pinned by docs/whats-new-ungroup-follow-ups (2026-10-12; was: group-selected-2026-10): the Ungroup follow-ups release is published after it, at the top and reaches this reader.
    // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: ungroup-follow-ups-2026-10): the pages-keep-groups-whole release is published after it, at the top, and reaches this reader.
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: pages-keep-groups-whole-2026-10): the parked ai-search-finds-every-item release (#367) and the three redesign releases are published after it, at the top, and redesign-2026-10, the newest, reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: redesign-2026-10): the unsubscribe-rack-question-fixes release is published after it, at the top, and reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: unsubscribe-rack-question-fixes-2026-10): the ended-session-group-page-fixes release is published after it, at the top, and reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: ended-session-group-page-fixes-2026-10): the manage-order-items-and-app-fixes release is published after it, at the top, and reaches every member, this reader included.
    expect(list.latestUnread?.id).toBe('manage-order-items-and-app-fixes-2026-10');
    // An old phone build lists at most three unread releases, newest first:
    // once the newer release is read, this one, returns RX-1's and account
    // deletion for every member.
    const newer = Object.fromEntries(
      RELEASES.slice(0, RELEASES.findIndex((r) => r.id === ID)).map((r) => [r.id, true]),
    );
    expect(legacyAnnouncementsFor(RELEASES, everyone, newer).map((a) => a.id)).toEqual([
      ID,
      'returns-original-rack-2026-10',
      'account-deletion-everyone-2026-10',
    ]);
    expect(registryFingerprint(RELEASES)).toContain(ID);
    expect(ANNOUNCEMENTS.map((a) => a.id)).toContain(ID);
    // A real time on a whole minute, after its walk ended (2026-10-05 07:02Z)
    // and after returns RX-1's walk (14:42Z), published in the same change:
    // never the draft's placeholder date.
    expect(release().publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/);
    expect(Date.parse(release().publishedAt)).toBeGreaterThan(Date.parse('2026-10-05T14:42:00Z'));
    expect(Date.parse(release().publishedAt)).toBeLessThanOrEqual(Date.parse('2026-10-06T00:00:00Z'));
  });

  // Re-pinned by docs/whats-new-dates-link-submit (2026-10-06; was: "...;
  // the drafts and slice 1's small fixes above it are dated later"): no
  // draft is left above it.
  // Re-pinned by returns RX-2 (2026-10-11; was: "the releases above it, all
  // published, are dated later"): RX-2's draft, dated later, sits at the top.
  // Re-pinned by docs/whats-new-returns-exchange (2026-10-11; was: "all
  // published but returns RX-2's draft at the top"): RX-2's release is
  // published, in the same place, so all of them are published again.
  // Re-pinned by returns RX-3 (2026-10-11; was: "the releases above it, all
  // published, are dated later"): RX-3's draft, dated later still, sits at
  // the top above RX-2's release.
  // Re-pinned by docs/whats-new-returns-requester (2026-10-12; was: "all
  // published but returns RX-3's draft at the top"): RX-3's release is
  // published, in the same place, so all of them are published again.
  // Re-pinned by returns RX-4 (2026-10-12; was: "the releases above it, all
  // published, are dated later"): RX-4's draft, dated later still, sits at
  // the top above RX-3's release.
  // Re-pinned by docs/whats-new-returns-close-rest (2026-10-12; was: "all
  // published but the returns RX-4 draft at the top"): RX-4's release is
  // published, in the same place, so all of them are published again.
  // Re-pinned by the return history hand-over fix (D-H1, 2026-10-12; was:
  // "the releases above it, all published, are dated later"): its draft,
  // dated later still, sits at the top above RX-4's release.
  // Re-pinned by docs/whats-new-return-history-hand-over (2026-10-12; was:
  // "all published but the return history hand-over draft at the top"): its
  // release is published, in the same place, so all of them are published
  // again.
  // Re-pinned by Ungroup G1 (2026-10-12, rebased onto #354; was: "the
  // releases above it, all published, are dated later"): Ungroup's draft,
  // dated later still, sits at the top above the return history hand-over
  // release. Claim kept: every release above it is dated later.
  // Re-pinned by Group selected G2 (2026-10-12, rebased onto #351; was: "all
  // published but the Ungroup draft at the top"): Group selected's draft,
  // dated later still, sits at the top above Ungroup's. Claim kept: every
  // release above it is dated later.
  // Re-pinned by the What's New publish of ungroup-2026-10 and
  // group-selected-2026-10 (2026-10-12; was: "... the Group selected and
  // Ungroup drafts at the top ..."): both are published in the same
  // places. Claim kept: the same place, dated as before against the
  // releases around it.
  // Renamed by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: "... (the Ungroup and Group selected releases at the top among them) ..."): the Ungroup follow-ups release (#362) and the pages-keep-groups-whole release are published above them, at the top. Claim kept: every release above it is dated later.
  // Renamed by docs/whats-new-redesign-2026-10 (2026-10-20; was: "... Ungroup follow-ups and pages-keep-groups-whole releases at the top ..."): the parked ai-search-finds-every-item release (#367) and the three redesign releases are published above them, at the top. Claim kept: every release above it is dated later.
  // Renamed by docs/whats-new-2026-10-25 (2026-10-25; was: "... ai-search-finds-every-item and three redesign releases at the top ..."): the unsubscribe-rack-question-fixes release is published above them, at the top. Claim kept: every release above it is dated later.
  // Renamed by docs/whats-new-2026-10-26 (2026-10-26; was: "... three redesign and unsubscribe-rack-question-fixes releases at the top ..."): the ended-session-group-page-fixes release is published above them, at the top. Claim kept: every release above it is dated later.
  // Renamed by docs/whats-new-2026-10-30 (2026-10-30; was: "... unsubscribe-rack-question-fixes and ended-session-group-page-fixes releases at the top ..."): the manage-order-items-and-app-fixes release is published above them, at the top. Claim kept: every release above it is dated later.
  it("is dated after every release below it (pinned by id), returns RX-1's a minute below it; the releases above it, all published (the Ungroup, Group selected, Ungroup follow-ups, pages-keep-groups-whole, ai-search-finds-every-item, three redesign, unsubscribe-rack-question-fixes, ended-session-group-page-fixes and manage-order-items-and-app-fixes releases at the top among them), are dated later", () => {
    // Re-pinned by the B44 phone update draft (fix/b44-update-restart-prompt;
    // was: without it): dated after every release, it sits at the top, so
    // every position below it moves down by one, and it and slice 8's are the
    // drafts.
    // Re-pinned by the small fixes slice 8 draft (fix/small-fixes-8; was:
    // without it): dated after every release, it sits at the top, so every
    // position below it moves down by one, and it is the one draft.
    const at = RELEASES.findIndex((r) => r.id === ID);
    expect(at).toBeGreaterThanOrEqual(0);
    // Re-pinned by the weekly digest fixes (2026-10-05): their draft sits at
    // the top. Re-pinned by the Items first-paint draft (2026-10-05): dated
    // later still, at the top. Re-pinned by the publishing of the small fixes
    // (slice 1, 2026-10-05; was: the newest published release, with only
    // drafts above it): the drafts stay at the top, newest first, and the
    // small fixes, published, sit between them and this one.
    // Re-pinned by 0395 (was: without it): the partial-approval draft (small
    // fixes slice 2) sits below PO-2's draft, above the small fixes.
    // Re-pinned by the publishing of the Items first-paint release
    // (2026-10-06; was: a draft at the top): published, below the drafts and
    // above the small fixes.
    // Re-pinned by the publishing of the weekly digest release (2026-10-06;
    // was: a draft at the top): published, below the drafts and above the
    // Items first-paint release.
    // Re-pinned by the dates fixes draft (2026-10-06; was: without it): a
    // draft dated later, at the top.
    // Re-pinned by the public link draft (fix/placed-cart-draft; was: without
    // it): a draft dated later still, at the top.
    // Re-pinned by returns RX-2 (2026-10-11; was: without it): a draft dated
    // later still, at the top.
    // Re-pinned by returns RX-3 (2026-10-11; was: without it): a draft dated
    // later still, at the top.
    // Re-pinned by returns RX-4 (2026-10-12; was: without it): a draft dated
    // later still, at the top.
    // Re-pinned by the return history hand-over fix (D-H1, 2026-10-12; was:
    // without it): a draft dated later still, at the top.
    // Re-pinned by Ungroup G1 (2026-10-12, rebased onto #354; was: without
    // it): its draft, dated later still, sits at the top above the return
    // history hand-over release.
    // Re-pinned by Group selected G2 (2026-10-12, rebased onto #351; was:
    // without it): its draft, dated later still, sits at the top above
    // Ungroup's draft.
    // Re-pinned by docs/whats-new-ungroup-follow-ups (2026-10-12; was: the list without it): the Ungroup follow-ups release is published after it, at the top.
    // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: the list without it): the pages-keep-groups-whole release is published after it, at the top.
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: the list without them): the three redesign releases and the parked ai-search-finds-every-item release (#367) are published after it, at the top.
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: the list without it): the unsubscribe-rack-question-fixes release is published after it, at the top.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: the list without it): the ended-session-group-page-fixes release is published after it, at the top.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: the list without it): the manage-order-items-and-app-fixes release is published after it, at the top.
    expect(RELEASES.slice(0, at).map((r) => r.id)).toEqual([
      'mobile-app-asks-before-restarting',
      'small-fixes-8-2026-10',
      'manage-order-items-and-app-fixes-2026-10',
      'ended-session-group-page-fixes-2026-10',
      'unsubscribe-rack-question-fixes-2026-10',
      'redesign-2026-10',
      'redesign-mobile-app-2026-10',
      'redesign-web-fixes-2026-10',
      'ai-search-finds-every-item-2026-10',
      'pages-keep-groups-whole-2026-10',
      'ungroup-follow-ups-2026-10',
      'group-selected-2026-10',
      'ungroup-2026-10',
      'returns-history-hand-over-2026-10',
      'returns-close-rest-2026-10',
      'returns-requester-exchange-2026-10',
      'returns-exchange-2026-10',
      'public-link-sent-request-2026-10',
      'dates-fixes-2026-10',
      'order-submit-once-2026-10',
      'order-partial-approval-held-2026-10',
      'weekly-digest-and-fixes-2026-10',
      'items-list-first-paint-2026-10',
      'small-fixes-2026-10',
    ]);
    // Re-pinned by the publishing of the slice 2 release (2026-10-06; was:
    // draft x4, published x3): the partial-approval release is published, in
    // the same place, so three drafts sit above four published releases.
    // Re-pinned by docs/whats-new-dates-link-submit (2026-10-06; was: draft
    // x3, published x4): the public link, dates fixes and PO-2 releases are
    // published, in the same places, so all seven above it are published.
    // Re-pinned by returns RX-2 (2026-10-11; was: published x7): RX-2's draft
    // at the top, then the same seven, published.
    // Re-pinned by docs/whats-new-returns-exchange (2026-10-11; was: draft,
    // then published x7): RX-2's release is published, so all eight are.
    // Re-pinned by returns RX-3 (2026-10-11; was: published x8): RX-3's
    // draft at the top, then the same eight, published.
    // Re-pinned by docs/whats-new-returns-requester (2026-10-12; was: draft,
    // then published x8): RX-3's release is published, so all nine are.
    // Re-pinned by returns RX-4 (2026-10-12; was: published x9): RX-4's
    // draft at the top, then the same nine, published.
    // Re-pinned by docs/whats-new-returns-close-rest (2026-10-12; was: draft,
    // then published x9): RX-4's release is published, so all ten are.
    // Re-pinned by the return history hand-over fix (D-H1, 2026-10-12; was:
    // published x10): its draft at the top, then the same ten, published.
    // Re-pinned by docs/whats-new-return-history-hand-over (2026-10-12; was:
    // draft, then published x10): its release is published, so all eleven
    // are.
    // Re-pinned by Ungroup G1 (2026-10-12, rebased onto #354; was:
    // published x11): Ungroup's draft at the top, then the same eleven,
    // published.
    // Re-pinned by Group selected G2 (2026-10-12, rebased onto #351; was:
    // Ungroup's draft at the top, then published): Group selected's draft
    // above it, then the same, published.
    // Re-pinned by the What's New publish of ungroup-2026-10 and
    // group-selected-2026-10 (2026-10-12; was: two drafts at the top, then
    // published): both are published, in the same places, so every
    // release above this one is published.
    expect(RELEASES.slice(0, at).map((r) => r.status)).toEqual([
      'draft',
      'draft',
      // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: the statuses without it): the manage-order-items-and-app-fixes release is published at the top, so one more release above this one is published.
      'published',
      // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: the statuses without it): the ended-session-group-page-fixes release is published at the top, so one more release above this one is published.
      'published',
      // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: the statuses without it): the unsubscribe-rack-question-fixes release is published at the top, so one more release above this one is published.
      'published',
      // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: the statuses without them): the three redesign releases and the parked ai-search-finds-every-item release (#367) are published at the top, so four more releases above this one are published.
      'published',
      'published',
      'published',
      'published',
      // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: the statuses without it): the pages-keep-groups-whole release is published at the top, so one more release above this one is published.
      'published',
      // Re-pinned by docs/whats-new-ungroup-follow-ups (2026-10-12): the Ungroup follow-ups release is published at the top and reaches this reader, so it is read or seen here too and the order this test checks holds.
      'published',
      'published',
      'published',
      'published',
      'published',
      'published',
      'published',
      'published',
      'published',
      'published',
      'published',
      'published',
      'published',
      'published',
    ]);
    expect(RELEASES.slice(at + 1).every((r) => r.status === 'published' || r.status === 'withdrawn')).toBe(true);
    for (const r of RELEASES.slice(0, at)) {
      expect(Date.parse(r.publishedAt), r.id).toBeGreaterThan(Date.parse(release().publishedAt));
    }
    for (const r of RELEASES.slice(at + 1)) {
      expect(Date.parse(release().publishedAt), r.id).toBeGreaterThan(Date.parse(r.publishedAt));
    }
    expect(RELEASES[at + 1]?.id).toBe('returns-original-rack-2026-10');
    expect(Date.parse(release().publishedAt) - Date.parse(RELEASES[at + 1]!.publishedAt)).toBe(60_000);
  });

  it('is told to whoever can open the New order page, and links there', () => {
    const r = release();
    expect(r.audience).toEqual({ anyPermission: ['orders:request'], modules: ['orders'] });
    expect(r.entries.map((e) => e.id)).toEqual(['phone-place-order', 'phone-place-order-once', 'phone-orders-list-current']);
    const [place] = r.entries;
    expect(place!.link).toEqual({ href: '/dashboard/orders/new', label: 'Place an order' });
    expect(place!.audience).toEqual({ anyPermission: ['orders:request'], modules: ['orders'] });
    const entriesFor = (role: ReleaseViewer['role'], permissions: ReleaseViewer['permissions'], modules: ModuleId[] = ['orders']) =>
      visibleReleases([r], { role, permissions, enabledModules: modules })[0]?.entries.length ?? 0;
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

  // Publish claim check 2026-10-05, against the merged code (84c59c0d) and
  // the Demo Co production walk.
  it('says only what the phone does today: the update, kits with Bundles, the email with routing, the iPad, the sign-out', () => {
    const r = release();
    const [place, once, list] = r.entries;
    // The phone part is an over-the-air update: it loads when the app is
    // opened again, with no prompt. Old phones show only the title and the
    // summary, so the summary says it.
    expect(r.summary).toMatch(/^After the latest update, you can place an order request in the mobile app on iPhone and iPad: /);
    expect(place!.whatToDo).toBe('Close the app completely and open it again to load the latest update.');
    expect(list!.whatToDo).toBe('Close the app completely and open it again to load the latest update.');
    expect(once!.whatToDo).toBe('No action needed.');
    expect(readerText(r).join(' ')).not.toMatch(/offers the new version|update the app|App Store/i);
    // Kits come only where Bundles is on (the storefront answer's
    // kitsEnabled), so never "a whole kit" for everyone.
    expect(r.summary).toContain('add items (or kits, where your organization uses Bundles) to your cart');
    expect(place!.whatChanged).toContain('and add items, or kits where your organization uses Bundles.');
    expect(readerText(r).join(' ')).not.toMatch(/or a whole kit/);
    // The request email is offered only when the organization's Email
    // routing for delivery requests is set (success.ts successEmailInput).
    expect(place!.whatChanged).not.toMatch(/email/i);
    expect(place!.howItAffectsYou).toContain(
      'If your organization has set up Email routing for delivery requests, you can also open a pickup or delivery request email as a draft.',
    );
    // The iPad's cart column needs a window at least 700 pt wide and text
    // below the accessibility sizes (layout.ts storefrontLayoutKind).
    expect(place!.howItAffectsYou).toContain(
      'On an iPad, the cart stays open beside the items, except at the largest text sizes or in a narrow window.',
    );
    // A sign-out removes the account's workspace keys, the cart with them.
    expect(place!.howItAffectsYou).toContain('Your cart is kept on your phone for each warehouse, for your account only, until you sign out.');
    // Check and finish can end in a refusal, which the app says.
    expect(once!.whatChanged).toContain('if not, it is placed now, once, or the app says why it can\'t be.');
    // The order page reads the status on focus, on return and on reconnect
    // (runtime.ts useStorefrontScope); a sign-out reads it first and asks only
    // when it is still unknown (sign-out-flow.ts); the Orders list says so too.
    expect(once!.howItAffectsYou).toContain('and the Orders list says the order request isn\'t confirmed yet.');
    expect(once!.howItAffectsYou).toContain('The order page checks on its own when you come back to it or the connection returns.');
    expect(once!.howItAffectsYou).toContain(
      'If you sign out before you choose, the app checks it first when it has a connection; if it still can\'t tell, it asks you, and checks again the next time you sign in on that phone.',
    );
    // Before PO-4 the list read once when it was first shown; a pull down
    // read it again.
    expect(list!.whyItMatters).toContain('a new order could stay hidden until you pulled the list down');
    expect(list!.whyItMatters).not.toMatch(/until the screen was opened again/);
  });
});

/**
 * "Don't send it" cannot promise an order request is never placed: when the
 * earlier send already placed it, the withdraw answers with the order
 * instead (PO-4 desk check F6.1). Neither the phone release nor PO-2's held
 * draft may say otherwise.
 */
describe('the order releases never promise that Don\'t send it stops an order already placed', () => {
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
 * only to someone who may order for someone else. The phone release claims
 * none of those.
 */
describe('the phone release claims nothing the phone does not do', () => {
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
 * account) was held as a DRAFT until 0393 was pushed and verified (2026-10-05
 * 10:02:00Z), the web deploy (#321, 98927216, web build 65856de9476f), the
 * phone update that shows "Deleted user" and the member's own role (OTA group
 * 58069c7e; the later group c6d13905, which launched on phones, carries the
 * same code) and the Demo Co production walk (no account deleted: the pages
 * that read the marker rendered with live names, the web dialog and the
 * phone's alert showed the new words and were cancelled) were done. Pinned by
 * id, never by index. This follow-up publishes it, the oldest of the three
 * releases of 2026-10-05: returns RX-1's sits a minute above it and phone
 * ordering's above that.
 */
describe('account deletion for every member (slice A3) is published', () => {
  const ID = 'account-deletion-everyone-2026-10';
  const release = () => RELEASES.find((r) => r.id === ID)!;
  const everyone: ReleaseViewer = {
    role: 'owner',
    permissions: [...PERMISSIONS],
    enabledModules: Object.keys(MODULE_REGISTRY) as ModuleId[],
  };

  it('is published after 0393, the web deploy, the phone update and the Demo Co walk, so every feed carries it', () => {
    expect(release()).toBeDefined();
    expect(release().status).toBe('published');
    expect(release().revision).toBe(1);
    expect(visibleReleases(RELEASES, everyone).map((r) => r.id)).toContain(ID);
    const list = buildReleaseList(RELEASES, everyone, [], null);
    expect(list.releases.map((r) => r.id)).toContain(ID);
    // The notice offers the newest unread release: returns RX-1's, phone
    // ordering's and slice 1's small fixes were published after this one. A
    // member who neither orders nor opens Returns is offered the small fixes,
    // whose fixes for everyone reach every member, and this one once they are
    // read (re-pinned by the small fixes' publishing; was: this one).
    // Re-pinned by the Items first-paint release (2026-10-06): published after the small fixes.
    // Re-pinned by the publishing of the weekly digest release (2026-10-06; was:
    // items-list-first-paint-2026-10): published after it, and every reader sees it.
    // Re-pinned by the publishing of the slice 2 release (2026-10-06; was:
    // weekly-digest-and-fixes-2026-10): published after it, and this reader
    // (an owner with every module) is told its approval, receiving and item
    // sheet entries.
    // Re-pinned by docs/whats-new-dates-link-submit (2026-10-06; was:
    // order-partial-approval-held-2026-10): the public link, dates fixes and
    // PO-2 releases are published after it, and this reader (an owner with
    // every module) is told all three, the public link release newest.
    // Re-pinned by docs/whats-new-returns-exchange (2026-10-11; was:
    // public-link-sent-request-2026-10): returns RX-2's release is published
    // after it, and this reader (an owner with every module) is told it.
    // Re-pinned by docs/whats-new-returns-requester (2026-10-12; was:
    // returns-exchange-2026-10): returns RX-3's release is published after
    // it, and this reader (an owner with every module) is told it.
    // Re-pinned by docs/whats-new-returns-close-rest (2026-10-12; was:
    // returns-requester-exchange-2026-10): returns RX-4's release is
    // published after it, and this reader (an owner with every module) is
    // told it.
    // Re-pinned by docs/whats-new-return-history-hand-over (2026-10-12; was:
    // returns-close-rest-2026-10): the return history hand-over release is
    // published after it, and this reader (an owner with every module) is
    // told it.
    // Re-pinned by the What's New publish of ungroup-2026-10 and
    // group-selected-2026-10 (2026-10-12): was returns-history-hand-over-2026-10.
    // Group selected's release is published after it (a minute after
    // Ungroup's) and reaches every member, so this reader (an owner with
    // every module) is told it first.
    // Re-pinned by docs/whats-new-ungroup-follow-ups (2026-10-12; was: group-selected-2026-10): the Ungroup follow-ups release is published after it, at the top and reaches this reader.
    // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: ungroup-follow-ups-2026-10): the pages-keep-groups-whole release is published after it, at the top, and reaches this reader.
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: pages-keep-groups-whole-2026-10): the parked ai-search-finds-every-item release (#367) and the three redesign releases are published after it, at the top, and redesign-2026-10, the newest, reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: redesign-2026-10): the unsubscribe-rack-question-fixes release is published after it, at the top, and reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: unsubscribe-rack-question-fixes-2026-10): the ended-session-group-page-fixes release is published after it, at the top, and reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: ended-session-group-page-fixes-2026-10): the manage-order-items-and-app-fixes release is published after it, at the top, and reaches every member, this reader included.
    expect(list.latestUnread?.id).toBe('manage-order-items-and-app-fixes-2026-10');
    const member: ReleaseViewer = { role: 'viewer', permissions: [], enabledModules: [] };
    // Re-pinned by the publishing of the weekly digest release (2026-10-06; was:
    // small-fixes-2026-10): its digest and warehouse entries reach every member,
    // so it is this member's notice too; the small fixes come once it is read,
    // and this one once both are.
    // Checked again at the publishing of the slice 2 release (2026-10-06):
    // unchanged, since every entry of that release needs a permission and a
    // module this member does not have, so it never reaches them.
    expect(visibleReleases(RELEASES, member).map((r) => r.id)).not.toContain(
      'order-partial-approval-held-2026-10',
    );
    // Re-pinned by docs/whats-new-dates-link-submit (2026-10-06; was:
    // weekly-digest-and-fixes-2026-10): the dates fixes release, published
    // after it, has a line for every member (the digest's send time), so it
    // is this member's notice now. The public link and PO-2 releases need a
    // permission and a module this member does not have, so they never reach
    // them. The weekly digest release comes once the dates fixes are read.
    for (const id of ['public-link-sent-request-2026-10', 'order-submit-once-2026-10']) {
      expect(visibleReleases(RELEASES, member).map((r) => r.id), id).not.toContain(id);
    }
    // Re-pinned by the What's New publish of ungroup-2026-10 and
    // group-selected-2026-10 (2026-10-12; was: dates-fixes-2026-10 with
    // nothing read): Group selected's release, published later, reaches
    // every member (its list entries have no audience), so this member is
    // told it first, and the reads below include it. Claim kept: the same
    // order after it.
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: group-selected-2026-10 with nothing read, and
    // the reads below without the redesign releases): the three redesign releases, published later still, reach
    // every member, so this member is told redesign-2026-10 first, Group selected's once the three are read, and
    // the reads below include them. Claim kept: the same order after it.
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: redesign-2026-10 with nothing read): the unsubscribe-rack-question-fixes release, published at the top, reaches every member, so this reader is told it first and redesign-2026-10 once it is read; the reads and seen sets below include it.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: unsubscribe-rack-question-fixes-2026-10 with nothing read): the ended-session-group-page-fixes release, published at the top, reaches every member, so this reader is told it first and the unsubscribe-rack-question-fixes release once it is read. Claim kept: the same order after them.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: ended-session-group-page-fixes-2026-10 with nothing read): the manage-order-items-and-app-fixes release, published at the top, reaches every member, so this reader is told it first and the ended-session-group-page-fixes release once it is read. Claim kept: the same order after them.
    expect(buildReleaseList(RELEASES, member, [], null).latestUnread?.id).toBe(
      'manage-order-items-and-app-fixes-2026-10',
    );
    expect(buildReleaseList(RELEASES, member, [latestRead()], null).latestUnread?.id).toBe(
      'ended-session-group-page-fixes-2026-10',
    );
    expect(
      buildReleaseList(RELEASES, member, [latestRead(), topRead()], null).latestUnread?.id,
    ).toBe('unsubscribe-rack-question-fixes-2026-10');
    expect(
      buildReleaseList(RELEASES, member, [latestRead(), topRead(), newestRead()], null).latestUnread
        ?.id,
    ).toBe('redesign-2026-10');
    expect(buildReleaseList(RELEASES, member, redesignReads(), null).latestUnread?.id).toBe(
      'group-selected-2026-10',
    );
    const groupSelectedSeen = {
      release_id: 'group-selected-2026-10',
      revision: 1,
      dismissed_at: null,
      opened_at: '2026-10-12T13:48:00Z',
      read_at: '2026-10-12T13:48:00Z',
    };
    expect(
      buildReleaseList(RELEASES, member, [...redesignReads(), groupSelectedSeen], null).latestUnread
        ?.id,
    ).toBe('dates-fixes-2026-10');
    const datesRead = [
      ...redesignReads(),
      groupSelectedSeen,
      {
        release_id: 'dates-fixes-2026-10',
        revision: 1,
        dismissed_at: null,
        opened_at: '2026-10-06T13:00:00Z',
        read_at: '2026-10-06T13:00:00Z',
      },
    ];
    expect(buildReleaseList(RELEASES, member, datesRead, null).latestUnread?.id).toBe(
      'weekly-digest-and-fixes-2026-10',
    );
    const digestRead = [
      {
        release_id: 'weekly-digest-and-fixes-2026-10',
        revision: 1,
        dismissed_at: null,
        opened_at: '2026-10-06T12:00:00Z',
        read_at: '2026-10-06T12:00:00Z',
      },
    ];
    // Re-pinned by docs/whats-new-dates-link-submit (2026-10-06; was: the
    // digest release read alone): the dates fixes release is read too.
    expect(buildReleaseList(RELEASES, member, [...datesRead, ...digestRead], null).latestUnread?.id).toBe(
      'small-fixes-2026-10',
    );
    const smallFixesRead = [
      {
        release_id: 'small-fixes-2026-10',
        revision: 1,
        dismissed_at: null,
        opened_at: '2026-10-05T20:00:00Z',
        read_at: '2026-10-05T20:00:00Z',
      },
    ];
    // Re-pinned by the publishing of the weekly digest release (2026-10-06; was:
    // the small fixes read alone): the digest release is read too.
    // Re-pinned by docs/whats-new-dates-link-submit (2026-10-06; was: the
    // digest and small fixes releases read): the dates fixes release is read
    // too.
    expect(
      buildReleaseList(RELEASES, member, [...datesRead, ...digestRead, ...smallFixesRead], null).latestUnread
        ?.id,
    ).toBe(ID);
    // An old phone build lists at most three unread releases, newest first:
    // once the newer releases are read, this one, the approval release and
    // slice B's timeline release.
    const newer = Object.fromEntries(
      RELEASES.slice(0, RELEASES.findIndex((r) => r.id === ID)).map((r) => [r.id, true]),
    );
    expect(legacyAnnouncementsFor(RELEASES, everyone, newer).map((a) => a.id)).toEqual([
      ID,
      'approval-follows-permission-2026-10',
      'order-signature-timeline-2026-10',
    ]);
    expect(registryFingerprint(RELEASES)).toContain(ID);
    expect(ANNOUNCEMENTS.map((a) => a.id)).toContain(ID);
    // A real time on a whole minute, after its walk ended (2026-10-05
    // 10:25Z) and after returns RX-1's walk (14:42Z), published in the same
    // change: never the draft's placeholder date.
    expect(release().publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/);
    expect(Date.parse(release().publishedAt)).toBeGreaterThan(Date.parse('2026-10-05T14:42:00Z'));
    expect(Date.parse(release().publishedAt)).toBeLessThanOrEqual(Date.parse('2026-10-06T00:00:00Z'));
  });

  it('is dated after every release below it (pinned by id), returns RX-1\'s a minute above it and phone ordering\'s two minutes above it', () => {
    const at = RELEASES.findIndex((r) => r.id === ID);
    expect(at).toBeGreaterThanOrEqual(0);
    expect(RELEASES.slice(at + 1).every((r) => r.status === 'published' || r.status === 'withdrawn')).toBe(true);
    for (const r of RELEASES.slice(0, at)) {
      expect(Date.parse(r.publishedAt), r.id).toBeGreaterThan(Date.parse(release().publishedAt));
    }
    for (const r of RELEASES.slice(at + 1)) {
      expect(Date.parse(release().publishedAt), r.id).toBeGreaterThan(Date.parse(r.publishedAt));
    }
    expect(RELEASES[at - 1]?.id).toBe('returns-original-rack-2026-10');
    expect(RELEASES[at - 2]?.id).toBe('phone-place-order-2026-10');
    expect(Date.parse(RELEASES[at - 1]!.publishedAt) - Date.parse(release().publishedAt)).toBe(60_000);
    expect(Date.parse(RELEASES[at - 2]!.publishedAt) - Date.parse(release().publishedAt)).toBe(120_000);
    expect(RELEASES[at + 1]?.id).toBe('approval-follows-permission-2026-10');
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
    for (const role of ['viewer', 'staff', 'manager', 'admin', 'owner'] as const) {
      expect(visibleReleases([r], { role, permissions: [], enabledModules: [] })[0]?.entries.length, role).toBe(1);
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
    // Publish re-read: the web shows it now; the mobile app after the update
    // (old bundles say "system" or "Unknown").
    expect(r.summary).toContain('on the web, and in the mobile app after the latest update, stock movements');
    expect(entry.whatChanged).toContain(
      `On the web, stock movements, the audit log, order timelines, received stock and the purchase order PDF, purchase order imports, schedule entries and returns show “${DELETED_USER_LABEL}” instead of the person’s name.`,
    );
    // Released work, as the account trigger releases it.
    expect(entry.howItAffectsYou).toMatch(/counts, picks, deliveries, schedule entries and maintenance requests assigned to them become unassigned/);
    expect(entry.howItAffectsYou).toContain('stop being a warehouse’s manager');
    // Pending invites stop working and leave the list: never "resend".
    expect(entry.howItAffectsYou).toContain('Invitations they sent that were not yet accepted stop working');
    // Desk check F-1: no order email reaches them and no signing screen
    // suggests their address. Orders only: the maintenance resolution email
    // still goes to the address a request kept (a recorded follow-up).
    // Re-pinned by the publish re-read (was one sentence): the phone's
    // signature pad stops suggesting it only with the update
    // (signerEmailDefault); the sign route sends that address no receipt from
    // any version.
    expect(entry.howItAffectsYou).toContain('They are no longer emailed about orders they placed.');
    expect(entry.howItAffectsYou).toContain(
      'Their address is not suggested when someone signs for one on the web, or in the mobile app after the latest update.',
    );
    expect(text).not.toMatch(/never (be )?emailed|no longer emailed about anything|not emailed at all/i);
    expect(text).not.toMatch(/\bresend/i);
    // The phone's labels need the update; deleting does not. Since RX-1 the
    // phone's Returns screens show the server's label too.
    expect(entry.whatChanged).toContain('In the mobile app, after the latest update,');
    expect(entry.whatChanged).toContain(
      'In the mobile app, after the latest update, movements, item activity, the audit log, purchase order receipts and imports, and returns show it too.',
    );
    expect(entry.whatToDo).toContain('close the app completely and open it again');
    // Narrow scope: records are named, never "every screen" or "everywhere";
    // never "anyone can delete" (the only owner of an organization with
    // members cannot until ownership moves).
    expect(text).not.toMatch(/every (screen|page|record)|everywhere|anyone can delete|all records/i);
    expect(text).not.toMatch(/\bbooks?\b|\d+ ?%|token|hash|database|trigger|platform admin/i);
  });

  // Publish re-read: two changes the draft left out, said beside the
  // only-owner rule they serve. Core labels owners and admins alike "Super
  // Admin", so the web side menu marks the owner (user-menu-role.ts); the
  // mobile app's Settings card said OWNER for every member and now shows the
  // member's own role, with the update (role-pill.ts).
  it('says how a member tells whether they are the owner, on the web and in the updated mobile app', () => {
    const entry = release().entries[0]!;
    expect(entry.whatToDo).toContain('On the web, the role under your name in the side menu now adds (Owner) for an owner.');
    expect(entry.whatToDo).toContain(
      'In the mobile app, close the app completely and open it again to load the latest update; Settings then shows your own role instead of OWNER.',
    );
    expect(userMenuRoleLabel('owner')).toBe('Super Admin (Owner)');
    expect(userMenuRoleLabel('admin')).toBe('Super Admin');
    const pill = readFileSync(resolve(__dirname, '../../../../mobile/src/lib/role-pill.ts'), 'utf8');
    expect(pill).toContain('return role ? ROLE_PILL[role] : null;');
    expect(pill).toContain("admin: { label: 'ADMIN', status: 'ok' }");
  });
});

/**
 * Returns RX-1 (migration 0394, pushed 2026-10-05 13:26:00Z: gated return
 * functions, Original rack; #322, dab3a07d) was held as a DRAFT until 0394
 * was pushed and verified, the web deploy (web build b1c2cd51477a), the phone
 * update with the Returns screens (OTA group c6d13905, iOS update 01a10c42,
 * launched on phones) and the Demo Co production walk (RMA-20261005-8AC826
 * on SO-000024: Return to original rack: 31-B preselected, approving and
 * receiving moved nothing, Process return put the unit back on 31-B; the
 * phone listed and opened it) were done. Pinned by id, never by index. The
 * owner's rule publishes What's New as soon as phones have the update, so
 * this follow-up publishes it ahead of the returns plan's RX-5: a minute after
 * A3's release and a minute before phone ordering's.
 */
describe('returns remember the original rack (returns RX-1) is published', () => {
  const ID = 'returns-original-rack-2026-10';
  const release = () => RELEASES.find((r) => r.id === ID)!;
  const everyone: ReleaseViewer = {
    role: 'owner',
    permissions: [...PERMISSIONS],
    enabledModules: Object.keys(MODULE_REGISTRY) as ModuleId[],
  };

  it('is published after 0394, the web deploy, the phone update and the Demo Co walk, so every feed carries it', () => {
    expect(release()).toBeDefined();
    expect(release().status).toBe('published');
    expect(release().revision).toBe(1);
    expect(visibleReleases(RELEASES, everyone).map((r) => r.id)).toContain(ID);
    const list = buildReleaseList(RELEASES, everyone, [], null);
    expect(list.releases.map((r) => r.id)).toContain(ID);
    // The notice offers the newest unread release: phone ordering's was
    // published a minute after this one, and slice 1's small fixes later.
    // Someone who opens Returns but does not order is offered the small
    // fixes, whose fixes for everyone reach every member, and this one once
    // they are read (re-pinned by the small fixes' publishing; was: this one).
    // Re-pinned by the Items first-paint release (2026-10-06): published after the small fixes.
    // Re-pinned by the publishing of the weekly digest release (2026-10-06; was:
    // items-list-first-paint-2026-10): published after it, and every reader sees it.
    // Re-pinned by the publishing of the slice 2 release (2026-10-06; was:
    // weekly-digest-and-fixes-2026-10): published after it, and this reader
    // (an owner with every module) is told its approval, receiving and item
    // sheet entries.
    // Re-pinned by docs/whats-new-dates-link-submit (2026-10-06; was:
    // order-partial-approval-held-2026-10): the public link, dates fixes and
    // PO-2 releases are published after it, and this reader (an owner with
    // every module) is told all three, the public link release newest.
    // Re-pinned by docs/whats-new-returns-exchange (2026-10-11; was:
    // public-link-sent-request-2026-10): returns RX-2's release is published
    // after it, and this reader (an owner with every module) is told it.
    // Re-pinned by docs/whats-new-returns-requester (2026-10-12; was:
    // returns-exchange-2026-10): returns RX-3's release is published after
    // it, and this reader (an owner with every module) is told it.
    // Re-pinned by docs/whats-new-returns-close-rest (2026-10-12; was:
    // returns-requester-exchange-2026-10): returns RX-4's release is
    // published after it, and this reader (an owner with every module) is
    // told it.
    // Re-pinned by docs/whats-new-return-history-hand-over (2026-10-12; was:
    // returns-close-rest-2026-10): the return history hand-over release is
    // published after it, and this reader (an owner with every module) is
    // told it.
    // Re-pinned by the What's New publish of ungroup-2026-10 and
    // group-selected-2026-10 (2026-10-12): was returns-history-hand-over-2026-10.
    // Group selected's release is published after it (a minute after
    // Ungroup's) and reaches every member, so this reader (an owner with
    // every module) is told it first.
    // Re-pinned by docs/whats-new-ungroup-follow-ups (2026-10-12; was: group-selected-2026-10): the Ungroup follow-ups release is published after it, at the top and reaches this reader.
    // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: ungroup-follow-ups-2026-10): the pages-keep-groups-whole release is published after it, at the top, and reaches this reader.
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: pages-keep-groups-whole-2026-10): the parked ai-search-finds-every-item release (#367) and the three redesign releases are published after it, at the top, and redesign-2026-10, the newest, reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: redesign-2026-10): the unsubscribe-rack-question-fixes release is published after it, at the top, and reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: unsubscribe-rack-question-fixes-2026-10): the ended-session-group-page-fixes release is published after it, at the top, and reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: ended-session-group-page-fixes-2026-10): the manage-order-items-and-app-fixes release is published after it, at the top, and reaches every member, this reader included.
    expect(list.latestUnread?.id).toBe('manage-order-items-and-app-fixes-2026-10');
    const returnsOnly: ReleaseViewer = { role: 'staff', permissions: ['returns:read'], enabledModules: ['returns'] };
    // Re-pinned by the publishing of the weekly digest release (2026-10-06; was:
    // small-fixes-2026-10): its digest and warehouse entries reach every member,
    // so it is this reader's notice too; the small fixes come once it is read,
    // and this one once both are.
    // Checked again at the publishing of the slice 2 release (2026-10-06):
    // unchanged, since that release's entries need Orders or Receiving, which
    // this reader does not have, so it never reaches them.
    expect(visibleReleases(RELEASES, returnsOnly).map((r) => r.id)).not.toContain(
      'order-partial-approval-held-2026-10',
    );
    // Re-pinned by docs/whats-new-dates-link-submit (2026-10-06; was:
    // weekly-digest-and-fixes-2026-10): the dates fixes release, published
    // after it, has a line for every member (the digest's send time), so it
    // is this reader's notice now. The public link release needs Public
    // requests and the PO-2 release Orders, which this reader does not have.
    // The weekly digest release comes once the dates fixes are read.
    for (const id of ['public-link-sent-request-2026-10', 'order-submit-once-2026-10']) {
      expect(visibleReleases(RELEASES, returnsOnly).map((r) => r.id), id).not.toContain(id);
    }
    // Re-pinned by docs/whats-new-returns-exchange (2026-10-11; was:
    // dates-fixes-2026-10, and each step below without it): returns RX-2's
    // release, published later and told to whoever can open Returns, is this
    // reader's notice now; the dates fixes release comes once it is read,
    // and each later step reads it too. Claim kept: the same order after it.
    // Re-pinned by docs/whats-new-returns-requester (2026-10-12; was:
    // returns-exchange-2026-10, then the dates fixes once it is read):
    // returns RX-3's release, published later still and told to whoever can
    // open Returns, is this reader's notice now; RX-2's comes once it is read,
    // the dates fixes release once both are, and each later step reads both.
    // Claim kept: the same order after it.
    // Re-pinned by docs/whats-new-returns-close-rest (2026-10-12; was:
    // returns-requester-exchange-2026-10, then RX-2's once it is read):
    // returns RX-4's release, published later still and told to whoever can
    // open Returns (Close the rest), is this reader's notice now; RX-3's comes
    // once it is read, and each later step reads it too. Claim kept: the same
    // order after it.
    // Re-pinned by docs/whats-new-return-history-hand-over (2026-10-12; was:
    // returns-close-rest-2026-10, then RX-3's once it is read): the return
    // history hand-over release, published later still and told to whoever
    // can open Returns (the people who read a return's history), is this
    // reader's notice now; RX-4's comes once it is read, and each later step
    // reads it too. Claim kept: the same order after it.
    // Re-pinned by the What's New publish of ungroup-2026-10 and
    // group-selected-2026-10 (2026-10-12; was: returns-history-hand-over-2026-10
    // with nothing read): Group selected's release, published later still,
    // reaches every member (its list entries have no audience), so it is this
    // reader's notice now; the hand-over release comes once it is read, and
    // each later step reads it too. Ungroup's reaches no one without
    // items:update or items:create. Claim kept: the same order after it.
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: group-selected-2026-10 with nothing read, and
    // the reads below without the redesign releases): the three redesign releases, published later still, reach
    // every member, so this reader is told redesign-2026-10 first, Group selected's once the three are read, and
    // each later step reads them too. The parked ai-search-finds-every-item release (#367) reaches no one without
    // items:update and the AI module. Claim kept: the same order after it.
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: redesign-2026-10 with nothing read): the unsubscribe-rack-question-fixes release, published at the top, reaches every member, so this reader is told it first and redesign-2026-10 once it is read; the reads and seen sets below include it.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: unsubscribe-rack-question-fixes-2026-10 with nothing read): the ended-session-group-page-fixes release, published at the top, reaches every member, so this reader is told it first and the unsubscribe-rack-question-fixes release once it is read. Claim kept: the same order after them.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: ended-session-group-page-fixes-2026-10 with nothing read): the manage-order-items-and-app-fixes release, published at the top, reaches every member, so this reader is told it first and the ended-session-group-page-fixes release once it is read. Claim kept: the same order after them.
    expect(buildReleaseList(RELEASES, returnsOnly, [], null).latestUnread?.id).toBe(
      'manage-order-items-and-app-fixes-2026-10',
    );
    expect(buildReleaseList(RELEASES, returnsOnly, [latestRead()], null).latestUnread?.id).toBe(
      'ended-session-group-page-fixes-2026-10',
    );
    expect(
      buildReleaseList(RELEASES, returnsOnly, [latestRead(), topRead()], null).latestUnread?.id,
    ).toBe('unsubscribe-rack-question-fixes-2026-10');
    expect(
      buildReleaseList(RELEASES, returnsOnly, [latestRead(), topRead(), newestRead()], null)
        .latestUnread?.id,
    ).toBe('redesign-2026-10');
    expect(buildReleaseList(RELEASES, returnsOnly, redesignReads(), null).latestUnread?.id).toBe(
      'group-selected-2026-10',
    );
    const groupSelectedSeen = {
      release_id: 'group-selected-2026-10',
      revision: 1,
      dismissed_at: null,
      opened_at: '2026-10-12T13:48:00Z',
      read_at: '2026-10-12T13:48:00Z',
    };
    expect(
      buildReleaseList(RELEASES, returnsOnly, [...redesignReads(), groupSelectedSeen], null)
        .latestUnread?.id,
    ).toBe('returns-history-hand-over-2026-10');
    const handOverRead = [
      ...redesignReads(),
      groupSelectedSeen,
      {
        release_id: 'returns-history-hand-over-2026-10',
        revision: 1,
        dismissed_at: null,
        opened_at: '2026-10-12T09:00:00Z',
        read_at: '2026-10-12T09:00:00Z',
      },
    ];
    expect(buildReleaseList(RELEASES, returnsOnly, handOverRead, null).latestUnread?.id).toBe(
      'returns-close-rest-2026-10',
    );
    const rx4Read = [
      ...handOverRead,
      {
        release_id: 'returns-close-rest-2026-10',
        revision: 1,
        dismissed_at: null,
        opened_at: '2026-10-12T06:00:00Z',
        read_at: '2026-10-12T06:00:00Z',
      },
    ];
    expect(buildReleaseList(RELEASES, returnsOnly, rx4Read, null).latestUnread?.id).toBe(
      'returns-requester-exchange-2026-10',
    );
    const rx3Read = [
      ...rx4Read,
      {
        release_id: 'returns-requester-exchange-2026-10',
        revision: 1,
        dismissed_at: null,
        opened_at: '2026-10-12T03:00:00Z',
        read_at: '2026-10-12T03:00:00Z',
      },
    ];
    expect(buildReleaseList(RELEASES, returnsOnly, rx3Read, null).latestUnread?.id).toBe('returns-exchange-2026-10');
    const rx2Read = [
      ...rx3Read,
      {
        release_id: 'returns-exchange-2026-10',
        revision: 1,
        dismissed_at: null,
        opened_at: '2026-10-11T23:00:00Z',
        read_at: '2026-10-11T23:00:00Z',
      },
    ];
    expect(buildReleaseList(RELEASES, returnsOnly, rx2Read, null).latestUnread?.id).toBe('dates-fixes-2026-10');
    const datesRead = [
      ...rx2Read,
      {
        release_id: 'dates-fixes-2026-10',
        revision: 1,
        dismissed_at: null,
        opened_at: '2026-10-06T13:00:00Z',
        read_at: '2026-10-06T13:00:00Z',
      },
    ];
    expect(buildReleaseList(RELEASES, returnsOnly, datesRead, null).latestUnread?.id).toBe(
      'weekly-digest-and-fixes-2026-10',
    );
    const digestRead = [
      {
        release_id: 'weekly-digest-and-fixes-2026-10',
        revision: 1,
        dismissed_at: null,
        opened_at: '2026-10-06T12:00:00Z',
        read_at: '2026-10-06T12:00:00Z',
      },
    ];
    // Re-pinned by docs/whats-new-dates-link-submit (2026-10-06; was: the
    // digest release read alone): the dates fixes release is read too.
    expect(buildReleaseList(RELEASES, returnsOnly, [...datesRead, ...digestRead], null).latestUnread?.id).toBe(
      'small-fixes-2026-10',
    );
    const smallFixesRead = [
      {
        release_id: 'small-fixes-2026-10',
        revision: 1,
        dismissed_at: null,
        opened_at: '2026-10-05T20:00:00Z',
        read_at: '2026-10-05T20:00:00Z',
      },
    ];
    // Re-pinned by the publishing of the weekly digest release (2026-10-06; was:
    // the small fixes read alone): the digest release is read too.
    // Re-pinned by docs/whats-new-dates-link-submit (2026-10-06; was: the
    // digest and small fixes releases read): the dates fixes release is read
    // too.
    expect(
      buildReleaseList(RELEASES, returnsOnly, [...datesRead, ...digestRead, ...smallFixesRead], null)
        .latestUnread?.id,
    ).toBe(ID);
    // An old phone build lists at most three unread releases, newest first:
    // once the newer releases are read, this one, A3's and the approval
    // release.
    const newer = Object.fromEntries(
      RELEASES.slice(0, RELEASES.findIndex((r) => r.id === ID)).map((r) => [r.id, true]),
    );
    expect(legacyAnnouncementsFor(RELEASES, everyone, newer).map((a) => a.id)).toEqual([
      ID,
      'account-deletion-everyone-2026-10',
      'approval-follows-permission-2026-10',
    ]);
    expect(registryFingerprint(RELEASES)).toContain(ID);
    expect(ANNOUNCEMENTS.map((a) => a.id)).toContain(ID);
    // A real time on a whole minute, after its walk ended (2026-10-05
    // 14:42Z): never the draft's placeholder date.
    expect(release().publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/);
    expect(Date.parse(release().publishedAt)).toBeGreaterThan(Date.parse('2026-10-05T14:42:00Z'));
    expect(Date.parse(release().publishedAt)).toBeLessThanOrEqual(Date.parse('2026-10-06T00:00:00Z'));
  });

  it('sits between phone ordering\'s release and A3\'s (pinned by id), a minute from each, dated after every release below it', () => {
    const at = RELEASES.findIndex((r) => r.id === ID);
    expect(at).toBeGreaterThanOrEqual(0);
    expect(RELEASES.slice(at + 1).every((r) => r.status === 'published' || r.status === 'withdrawn')).toBe(true);
    for (const r of RELEASES.slice(0, at)) {
      expect(Date.parse(r.publishedAt), r.id).toBeGreaterThan(Date.parse(release().publishedAt));
    }
    for (const r of RELEASES.slice(at + 1)) {
      expect(Date.parse(release().publishedAt), r.id).toBeGreaterThan(Date.parse(r.publishedAt));
    }
    expect(RELEASES[at - 1]?.id).toBe('phone-place-order-2026-10');
    expect(RELEASES[at + 1]?.id).toBe('account-deletion-everyone-2026-10');
    expect(Date.parse(RELEASES[at - 1]!.publishedAt) - Date.parse(release().publishedAt)).toBe(60_000);
    expect(Date.parse(release().publishedAt) - Date.parse(RELEASES[at + 1]!.publishedAt)).toBe(60_000);
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
    const entriesFor = (permissions: ReleaseViewer['permissions'], modules: ModuleId[] = ['returns']) =>
      visibleReleases([r], { role: 'staff', permissions, enabledModules: modules })[0]?.entries.map((e) => e.id) ?? [];
    expect(entriesFor(['returns:read'])).toEqual(['returns-original-rack', 'returns-list-and-phone']);
    expect(entriesFor(['returns:manage'])).toEqual(['returns-original-rack', 'returns-list-and-phone', 'returns-request-notification']);
    expect(entriesFor(['returns:manage'], [])).toEqual([]);
    expect(entriesFor(['items:read'])).toEqual([]);
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
    // Nothing moves at approval or receipt, only when the return is processed
    // (brief 14; review: the old words said stock comes back at receipt), and
    // the phone is online only.
    expect(r.entries[0]!.whatChanged).toContain(
      'Nothing moves when you approve or receive the return: processing it puts every item where you chose, in one step.',
    );
    expect(all).not.toMatch(/until (it is|the item is) received\b(?! and processed)/i);
    expect(r.entries[0]!.howItAffectsYou).toContain('use Approve and receive, then process it.');
    expect(r.entries[1]!.howItAffectsYou).toContain('every return action needs a connection');
  });

  // Publish claim check 2026-10-05, against the merged code (dab3a07d) and
  // the Demo Co production walk.
  it('says what shipped: the update for the phone screens, several racks, Staging\'s source, and what the phone could do before', () => {
    const r = release();
    const [rack, list] = r.entries;
    // The phone screens are an over-the-air update: they load when the app
    // is opened again, with no prompt. Old phones show only the summary.
    expect(r.summary).toContain('Returns also have their own screens in the mobile app after the latest update');
    expect(list!.whatChanged).toContain('In the mobile app on iPhone and iPad, after the latest update, Returns in the menu');
    expect(list!.whatToDo).toBe(
      'No action needed on the web. In the mobile app, close the app completely and open it again to load the latest update.',
    );
    expect(readerText(r).join(' ')).not.toMatch(/offers the new version|update the app|App Store/i);
    // A line picked from several racks offers those racks (core restock-view:
    // "Return to original racks", or one of them up to what is still out).
    expect(rack!.whatChanged).toContain('If it was picked from more than one rack, the return shows those racks.');
    // Staging names the RMA a return left stock in (core
    // stagingReturnedSourceLabel).
    expect(rack!.howItAffectsYou).toContain('On the Staging page, stock a return put there shows Returned and the RMA as its source.');
    expect(stagingReturnedSourceLabel('RMA-20261005-8AC826')).toBe('Returned (RMA-20261005-8AC826)');
    // Before RX-1 the mobile app could start a return from an order
    // (order-returns.ts), but not approve, receive or process one.
    expect(list!.whyItMatters).toContain('the mobile app could start a return from an order but not approve, receive or process one');
    expect(list!.whyItMatters).not.toMatch(/could not work a return at all/);
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

  // Publish claim check: the staff ping's dual link opens the RMA on the web
  // and on bundles with the returns rule (older ones open the original
  // order), and a requester of a requester return now hears about it
  // (returns-notify.ts notifyRequesterReturnEvent).
  it('says where the ping opens, and what the requester now hears, from the code', () => {
    const ping = release().entries.find((e) => e.id === 'returns-request-notification')!;
    expect(ping.whatChanged).toContain('get a notification that opens the return, on the web and in the mobile app after the latest update.');
    expect(ping.whatChanged).toContain(
      'The requester now hears when the request arrives and when it is approved, received, declined or cancelled: a member as a notification, unless they turned off Order status changes, and anyone else by email. Someone without an account can unsubscribe from these emails.',
    );
    // Claims review: no setting is only for return messages, so the words
    // name the one a member's follow and never "turned these messages off".
    expect(ping.whatChanged).not.toMatch(/turned these messages off/);
    expect(ping.howItAffectsYou).toContain('When you use The item is here at the counter, the requester gets no approved or received message.');
    const notify = readFileSync(resolve(__dirname, '../../server/services/returns-notify.ts'), 'utf8');
    // Only a requester return, and never after a counter approval or receipt.
    expect(notify).toContain("if (input.source !== 'requester') return false;");
    // Re-pinned by returns RX-2 (2026-10-05; was one condition naming
    // approved and received): the counter rule now also keeps the exchange
    // approval silent, and still covers approved and received.
    expect(notify).toContain(
      "event === 'approved' || event === 'received' || event === 'exchange_approved' || event === 'exchange_approved_short';",
    );
    expect(notify).toContain("if (counterSilent && input.channel === 'counter') return false;");
    // The five events the words name.
    for (const line of [
      'request_received: RETURNS_COPY.requesterReceivedReturnRequest,',
      'approved: RETURNS_COPY.requesterReturnApproved,',
      'received: RETURNS_COPY.requesterItemReceived,',
      'denied: RETURNS_COPY.requesterReturnDeclined,',
      'cancelled: RETURNS_COPY.requesterReturnCancelled,',
    ]) {
      expect(notify).toContain(line);
    }
    // A member as a notification under their Order status changes setting,
    // anyone else (a portal requester too) by email.
    expect(notify).toContain("if (o.requester_user_id && !isPortal) {");
    expect(notify).toContain("const flags = await prefFlags(admin, [o.requester_user_id], 'email_order_status_changed');");
    expect(notify).toContain('await sendReturnUpdateEmail(admin, {');
    // That setting is the one Notifications labels Order status changes.
    const form = readFileSync(resolve(__dirname, '../../components/settings/notification-preferences-form.tsx'), 'utf8');
    expect(form).toMatch(/key: 'email_order_status_changed',\s+label: 'Order status changes',/);
    // Only someone without an account can unsubscribe: the email checks the
    // public opt-out only for a requester with no user id, and a customer
    // portal order carries the portal user's id, so its email always goes.
    const update = readFileSync(resolve(__dirname, '../../server/email/return-update.ts'), 'utf8');
    expect(update).toContain('if (!args.isAccountHolder && (await isPublicAddressUnsubscribed(admin, args.to))) {');
    expect(notify).toContain('isAccountHolder: Boolean(o.requester_user_id),');
    const portal = readFileSync(resolve(__dirname, '../../server/services/portal.ts'), 'utf8');
    expect(portal).toMatch(/source: 'portal',\s+customer_id: ctx\.customerId,\s+requester_user_id: ctx\.userId,/);
  });

  // Claims review 2026-10-05: the list had status chips before RX-1 (All,
  // Requested, Approved, Received, Closed, Denied, Cancelled), so the words
  // say what RX-1 added instead of saying returns were hard to find.
  it('says what the returns list added, not that it had no filters (claims review)', () => {
    const list = release().entries.find((e) => e.id === 'returns-list-and-phone')!;
    expect(list.title).toBe('Returns have clearer filters, a search, and their own screens on the phone');
    expect(list.whatChanged).toContain(
      "The returns list's filters now say where each return stands (Awaiting approval, Waiting for returned item, Received, not processed, Closed). Closed now includes denied and cancelled returns.",
    );
    expect(list.whatChanged).toContain('The list has a search by RMA, SO number or requester, and shows the returning items with their photos.');
    expect(list.whyItMatters).toContain(
      'The filters were named after statuses (Requested, Approved, Received), the list had no search and did not show what was coming back',
    );
    expect(readerText(release()).join(' ')).not.toMatch(/hard to find|list has filters/i);
    // RX-1's filters are the old statuses under new names (core).
    expect(returnListFilter('awaiting_approval').statuses).toEqual(['requested']);
    expect(returnListFilter('waiting_for_return').statuses).toEqual(['approved']);
    expect(returnListFilter('received_not_processed').statuses).toEqual(['received']);
    expect(returnListFilter('closed').statuses).toEqual(['closed', 'denied', 'cancelled']);
    expect(RETURNS_COPY.listSearchPlaceholder).toBe('Search RMA, SO number or requester');
  });

  // Claims review: the process button reads Process return for several items
  // (or a destination to choose again); for one item it names where it goes.
  it('says the process button names where a single item goes, as the screens do (claims review)', () => {
    const rack = release().entries[0]!;
    expect(rack.whatChanged).toContain('Its button reads Process return, or, for a single item, names where it goes (such as Return to 31-B).');
    expect(readerText(release()).join(' ')).not.toMatch(/Process return puts|then Process return/);
    const line: RestockOptionsLine = {
      returnLineId: 'rl-1',
      itemId: 'item-1',
      quantity: 1,
      disposition: 'restock',
      applied: false,
      plan: null,
      case: 'single_source',
      notRecordedReason: null,
      sources: [
        { locationId: 'loc-31b', name: '31-B', kind: 'rack', type: null, drawn: 1, restored: 0, remaining: 1, cap: 1, valid: true, reason: null, writable: true },
      ],
      offerOriginal: true,
      offerSourceIds: [],
      preselect: 'original',
    };
    expect(processLabelFor(line, { disposition: 'restock', target: 'original', locationId: null }).button).toBe('Return to 31-B');
    expect(processLabelFor(line, { disposition: 'restock', target: 'staging', locationId: null }).button).toBe('Leave in Staging');
    expect(processLabelFor(line, { disposition: 'scrap', target: null, locationId: null }).button).toBe('Scrap');
    expect(processLabelFor(line, { disposition: 'restock', target: null, locationId: null, needsChoice: 'gone' }).button).toBe('Process return');
    expect(RETURN_ACTION_LABELS.process).toBe('Process return');
    // The web workbench and the phone use the destination label for one open
    // line only, and Process return otherwise.
    const web = readFileSync(resolve(__dirname, '../../components/returns/return-workbench.tsx'), 'utf8');
    expect(web).toContain("r.status === 'received' && openLines.length === 1 && openLines[0]!.restock");
    // Re-pinned by returns RX-2 (2026-10-05; was RETURN_ACTION_LABELS[a]):
    // core's returnActionLabel words an exchange's approval, and answers
    // RETURN_ACTION_LABELS for every other action, Process return included.
    // Re-pinned again by RX-2 fix round 1 (verification L3; claim kept): the
    // options also carry the viewer's order approval.
    expect(web).toContain("a === 'process' && processLabel ? processLabel.button : returnActionLabel(a, labelOpts);");
    expect(returnActionLabel('process', { hasExchange: true })).toBe(RETURN_ACTION_LABELS.process);
    expect(returnActionLabel('process')).toBe(RETURN_ACTION_LABELS.process);
    const phone = readFileSync(resolve(__dirname, '../../../../mobile/src/lib/returns-view.ts'), 'utf8');
    expect(phone).toContain('if (lines.length === 1) return processLabelFor(lines[0]!.restock!, choiceFor(lines[0]!, choices)).button;');
    expect(phone).toContain('return RETURNS_COPY.processReturn;');
  });

  // Claims review: before 0394 every return write needed the manager role in
  // the database, so a staff member given Manage returns was refused; 0394
  // gates every RMA write on the permission plus the order's warehouse.
  it('says a staff member given Manage returns can now work returns, in their warehouses (claims review)', () => {
    const list = release().entries.find((e) => e.id === 'returns-list-and-phone')!;
    expect(list.howItAffectsYou).toContain(
      'If an admin gives a staff member the "Manage returns" permission, they can now create, approve, receive and process returns for orders in the warehouses they are assigned to; before, only owners, admins and managers could.',
    );
    expect(PERMISSION_META['returns:manage'].label).toBe('Manage returns');
    expect(hasPermission('staff', 'returns:manage')).toBe(false);
    expect(hasPermission('manager', 'returns:manage')).toBe(true);
    // The role matrix no longer marks the grant as rolling out.
    expect(FULLY_GRANTABLE_PERMISSIONS.has('returns:manage')).toBe(true);
    const mig = readFileSync(
      resolve(__dirname, '../../../../../supabase/migrations/0394_returns_lifecycle_original_rack.sql'),
      'utf8',
    );
    expect(mig).toContain("if not public.has_permission(v_org, 'returns:manage') then");
    expect(mig).toContain("if not public.user_can_access_inventory(v_user, v_wh, null, 'write') then");
  });
});

/**
 * Small fixes slice 1 (followups triage 2026-10-05; #325, 893da840, merged
 * 2026-10-05 18:02:27Z; no migration) was held as a DRAFT until the web deploy
 * (web build dd181604197c), the phone update with its phone half (OTA group
 * c2e8f017, iOS update 01a10d3f, launched on phones) and the Demo Co
 * production walk (67 checks passed, confirmed by an independent audit) were
 * done. Pinned by id, never by index. This follow-up publishes it, the newest
 * published release; the Items first-paint, weekly digest fixes' and PO-2's
 * drafts sit above it. Each entry is told only to the people who can see its
 * change.
 */
describe('the small fixes release (slice 1) is published', () => {
  const ID = 'small-fixes-2026-10';
  const release = () => RELEASES.find((r) => r.id === ID)!;
  const entry = (id: string) => release().entries.find((e) => e.id === id)!;
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
    // Re-pinned by the Items first-paint release (2026-10-06; was: the newest
    // published release, offered to everyone): published after this one, it
    // is the notice for whoever reads the Items or purchase order pages. A
    // member with no permission at all still gets this one, since the fixes
    // for everyone reach them.
    // Re-pinned by the publishing of the weekly digest release (2026-10-06; was:
    // items-list-first-paint-2026-10, and this one for a member with no
    // permission): published after both, its digest and warehouse entries
    // reach every member, so it is the notice for everyone; once it is read, a
    // member with no permission is offered this one.
    // Re-pinned by the publishing of the slice 2 release (2026-10-06; was:
    // weekly-digest-and-fixes-2026-10): published after it, and this reader
    // (an owner with every module) is told its approval, receiving and item
    // sheet entries.
    // Re-pinned by docs/whats-new-dates-link-submit (2026-10-06; was:
    // order-partial-approval-held-2026-10): the public link, dates fixes and
    // PO-2 releases are published after it, and this reader (an owner with
    // every module) is told all three, the public link release newest.
    // Re-pinned by docs/whats-new-returns-exchange (2026-10-11; was:
    // public-link-sent-request-2026-10): returns RX-2's release is published
    // after it, and this reader (an owner with every module) is told it.
    // Re-pinned by docs/whats-new-returns-requester (2026-10-12; was:
    // returns-exchange-2026-10): returns RX-3's release is published after
    // it, and this reader (an owner with every module) is told it.
    // Re-pinned by docs/whats-new-returns-close-rest (2026-10-12; was:
    // returns-requester-exchange-2026-10): returns RX-4's release is
    // published after it, and this reader (an owner with every module) is
    // told it.
    // Re-pinned by docs/whats-new-return-history-hand-over (2026-10-12; was:
    // returns-close-rest-2026-10): the return history hand-over release is
    // published after it, and this reader (an owner with every module) is
    // told it.
    // Re-pinned by the What's New publish of ungroup-2026-10 and
    // group-selected-2026-10 (2026-10-12): was returns-history-hand-over-2026-10.
    // Group selected's release is published after it (a minute after
    // Ungroup's) and reaches every member, so this reader (an owner with
    // every module) is told it first.
    // Re-pinned by docs/whats-new-ungroup-follow-ups (2026-10-12; was: group-selected-2026-10): the Ungroup follow-ups release is published after it, at the top and reaches this reader.
    // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: ungroup-follow-ups-2026-10): the pages-keep-groups-whole release is published after it, at the top, and reaches this reader.
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: pages-keep-groups-whole-2026-10): the parked ai-search-finds-every-item release (#367) and the three redesign releases are published after it, at the top, and redesign-2026-10, the newest, reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: redesign-2026-10): the unsubscribe-rack-question-fixes release is published after it, at the top, and reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: unsubscribe-rack-question-fixes-2026-10): the ended-session-group-page-fixes release is published after it, at the top, and reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: ended-session-group-page-fixes-2026-10): the manage-order-items-and-app-fixes release is published after it, at the top, and reaches every member, this reader included.
    expect(list.latestUnread?.id).toBe('manage-order-items-and-app-fixes-2026-10');
    const member: ReleaseViewer = { role: 'viewer', permissions: [], enabledModules: [] };
    // Checked again at the publishing of the slice 2 release (2026-10-06):
    // unchanged, since none of that release's entries reaches a member with
    // no permission and no module.
    expect(visibleReleases(RELEASES, member).map((r) => r.id)).not.toContain(
      'order-partial-approval-held-2026-10',
    );
    // Re-pinned by docs/whats-new-dates-link-submit (2026-10-06; was:
    // weekly-digest-and-fixes-2026-10): the dates fixes release, published
    // after it, has a line for every member (the digest's send time), so it
    // is this member's notice now; the public link and PO-2 releases never
    // reach them. This one comes once the dates fixes and weekly digest
    // releases are read.
    for (const id of ['public-link-sent-request-2026-10', 'order-submit-once-2026-10']) {
      expect(visibleReleases(RELEASES, member).map((r) => r.id), id).not.toContain(id);
    }
    // Re-pinned by the What's New publish of ungroup-2026-10 and
    // group-selected-2026-10 (2026-10-12; was: dates-fixes-2026-10 with
    // nothing read): Group selected's release, published later, reaches
    // every member (its list entries have no audience), so this member is
    // told it first, and the reads below include it. Claim kept: the same
    // order after it.
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: group-selected-2026-10 with nothing read, and
    // the reads below without the redesign releases): the three redesign releases, published later still, reach
    // every member, so this member is told redesign-2026-10 first, Group selected's once the three are read, and
    // the reads below include them. Claim kept: the same order after it.
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: redesign-2026-10 with nothing read): the unsubscribe-rack-question-fixes release, published at the top, reaches every member, so this reader is told it first and redesign-2026-10 once it is read; the reads and seen sets below include it.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: unsubscribe-rack-question-fixes-2026-10 with nothing read): the ended-session-group-page-fixes release, published at the top, reaches every member, so this reader is told it first and the unsubscribe-rack-question-fixes release once it is read. Claim kept: the same order after them.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: ended-session-group-page-fixes-2026-10 with nothing read): the manage-order-items-and-app-fixes release, published at the top, reaches every member, so this reader is told it first and the ended-session-group-page-fixes release once it is read. Claim kept: the same order after them.
    expect(buildReleaseList(RELEASES, member, [], null).latestUnread?.id).toBe(
      'manage-order-items-and-app-fixes-2026-10',
    );
    expect(buildReleaseList(RELEASES, member, [latestRead()], null).latestUnread?.id).toBe(
      'ended-session-group-page-fixes-2026-10',
    );
    expect(
      buildReleaseList(RELEASES, member, [latestRead(), topRead()], null).latestUnread?.id,
    ).toBe('unsubscribe-rack-question-fixes-2026-10');
    expect(
      buildReleaseList(RELEASES, member, [latestRead(), topRead(), newestRead()], null).latestUnread
        ?.id,
    ).toBe('redesign-2026-10');
    expect(buildReleaseList(RELEASES, member, redesignReads(), null).latestUnread?.id).toBe(
      'group-selected-2026-10',
    );
    const groupSelectedSeen = {
      release_id: 'group-selected-2026-10',
      revision: 1,
      dismissed_at: null,
      opened_at: '2026-10-12T13:48:00Z',
      read_at: '2026-10-12T13:48:00Z',
    };
    expect(
      buildReleaseList(RELEASES, member, [...redesignReads(), groupSelectedSeen], null).latestUnread
        ?.id,
    ).toBe('dates-fixes-2026-10');
    const datesRead = [
      ...redesignReads(),
      groupSelectedSeen,
      {
        release_id: 'dates-fixes-2026-10',
        revision: 1,
        dismissed_at: null,
        opened_at: '2026-10-06T13:00:00Z',
        read_at: '2026-10-06T13:00:00Z',
      },
    ];
    const digestRead = [
      {
        release_id: 'weekly-digest-and-fixes-2026-10',
        revision: 1,
        dismissed_at: null,
        opened_at: '2026-10-06T12:00:00Z',
        read_at: '2026-10-06T12:00:00Z',
      },
    ];
    // Re-pinned by docs/whats-new-dates-link-submit (2026-10-06; was: the
    // digest release read alone): the dates fixes release is read too.
    expect(buildReleaseList(RELEASES, member, [...datesRead, ...digestRead], null).latestUnread?.id).toBe(ID);
    // An old phone build lists at most three unread releases, newest first:
    // the weekly digest release, the Items first-paint release and this one.
    // Re-pinned by the publishing of the weekly digest release (2026-10-06; was:
    // the Items first-paint release, this one and phone ordering's).
    // Re-pinned by the publishing of the slice 2 release (2026-10-06; was: the
    // weekly digest release, the Items first-paint release and this one): an
    // owner with every module is told the slice 2 release first, and this one
    // comes back into the three once that release is seen.
    // Re-pinned by docs/whats-new-dates-link-submit (2026-10-06; was: the
    // slice 2, weekly digest and Items first-paint releases, and this one
    // once slice 2's was seen): an owner with every module is told the public
    // link, dates fixes and PO-2 releases first, and this one comes back into
    // the three once those and slice 2's are seen.
    // Re-pinned by docs/whats-new-returns-exchange (2026-10-11; was: the
    // public link, dates fixes and PO-2 releases, and this one once those
    // and slice 2's were seen): returns RX-2's release, published later, is
    // first, and this one comes back once it is seen too.
    // Re-pinned by docs/whats-new-returns-requester (2026-10-12; was: RX-2's,
    // the public link and the dates fixes releases, and this one once those
    // and the releases between were seen): returns RX-3's release, published
    // later still, is first, and this one comes back once it is seen too.
    // Re-pinned by docs/whats-new-returns-close-rest (2026-10-12; was: RX-3's,
    // RX-2's and the public link releases, and this one once those and the
    // releases between were seen): returns RX-4's release, published later
    // still, is first, and this one comes back once it is seen too.
    // Re-pinned by docs/whats-new-return-history-hand-over (2026-10-12; was:
    // RX-4's, RX-3's and RX-2's releases, and this one once those and the
    // releases between were seen): the return history hand-over release,
    // published later still, is first, and this one comes back once it is
    // seen too.
    // Re-pinned by the What's New publish of ungroup-2026-10 and
    // group-selected-2026-10 (2026-10-12; was: the hand-over, RX-4's and
    // RX-3's releases, and this one once those and the releases between were
    // seen): Group selected's and Ungroup's releases, published later still,
    // are first, and this one comes back once they are seen too.
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: the pages-keep-groups-whole, Ungroup follow-ups and Group selected releases with nothing seen): the three redesign releases are published at the top and reach this reader, so they are the three with nothing seen; the same three as before lead once the four newer releases are seen, and the seen set below includes them.
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: the three redesign releases with nothing seen): the unsubscribe-rack-question-fixes release, published at the top, reaches this reader, so it leads with nothing seen; the three redesign releases are the three once it is seen, and the seen sets below include it.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: the unsubscribe-rack-question-fixes release and the first two redesign releases with nothing seen): the ended-session-group-page-fixes release, published at the top, reaches every member, so it leads with nothing seen; the same three as before are the three once it is seen, and the seen sets below include it.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: the ended-session-group-page-fixes and unsubscribe-rack-question-fixes releases and the first redesign release with nothing seen): the manage-order-items-and-app-fixes release, published at the top, reaches every member, so it leads with nothing seen; the same three as before are the three once it is seen, and the seen sets below include it.
    expect(legacyAnnouncementsFor(RELEASES, everyone, {}).map((a) => a.id)).toEqual([
      LATEST_ID,
      TOP_ID,
      NEWEST_ID,
    ]);
    expect(legacyAnnouncementsFor(RELEASES, everyone, latestSeen()).map((a) => a.id)).toEqual([
      TOP_ID,
      NEWEST_ID,
      REDESIGN_IDS[0],
    ]);
    expect(
      legacyAnnouncementsFor(RELEASES, everyone, { ...latestSeen(), ...topSeen() }).map(
        (a) => a.id,
      ),
    ).toEqual([NEWEST_ID, ...REDESIGN_IDS.slice(0, 2)]);
    expect(
      legacyAnnouncementsFor(RELEASES, everyone, {
        ...latestSeen(),
        ...topSeen(),
        ...newestSeen(),
      }).map((a) => a.id),
    ).toEqual(REDESIGN_IDS);
    const fourNewerSeen = { ...redesignSeen(), 'ai-search-finds-every-item-2026-10': true };
    expect(legacyAnnouncementsFor(RELEASES, everyone, fourNewerSeen).map((a) => a.id)).toEqual([
      // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: the Ungroup follow-ups, Group selected and Ungroup releases): the pages-keep-groups-whole release is published at the top and reaches this reader, so it leads the three and Ungroup's drops out of them.
      'pages-keep-groups-whole-2026-10',
      // Re-pinned by docs/whats-new-ungroup-follow-ups (2026-10-12): the Ungroup follow-ups release is published at the top and reaches this reader, so it is read or seen here too and the order this test checks holds.
      'ungroup-follow-ups-2026-10',
      'group-selected-2026-10',
    ]);
    expect(
      legacyAnnouncementsFor(RELEASES, everyone, {
        ...fourNewerSeen,
        // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: the seen set without it): the pages-keep-groups-whole release is published at the top and reaches this reader, so it is seen here too and the order this test checks holds.
        'pages-keep-groups-whole-2026-10': true,
        'ungroup-follow-ups-2026-10': true,
        'group-selected-2026-10': true,
        'ungroup-2026-10': true,
        'returns-history-hand-over-2026-10': true,
        'returns-close-rest-2026-10': true,
        'returns-requester-exchange-2026-10': true,
        'returns-exchange-2026-10': true,
        'public-link-sent-request-2026-10': true,
        'dates-fixes-2026-10': true,
        'order-submit-once-2026-10': true,
        'order-partial-approval-held-2026-10': true,
      }).map((a) => a.id),
    ).toEqual(['weekly-digest-and-fixes-2026-10', 'items-list-first-paint-2026-10', ID]);
    expect(registryFingerprint(RELEASES)).toContain(ID);
    expect(ANNOUNCEMENTS.map((a) => a.id)).toContain(ID);
    // A real time on a whole minute, after the walk ended (2026-10-05 19:01Z)
    // and after EAS showed the phone update launching on iOS (19:23Z):
    // never the draft's placeholder date.
    expect(release().publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/);
    expect(Date.parse(release().publishedAt)).toBeGreaterThan(Date.parse('2026-10-05T19:23:00Z'));
    expect(Date.parse(release().publishedAt)).toBeLessThanOrEqual(Date.parse('2026-10-06T00:00:00Z'));
  });

  // Re-pinned by docs/whats-new-dates-link-submit (2026-10-06; was: "...
  // with the weekly digest and slice 2 releases (published later still) and
  // the drafts above them; ..."): no draft is left above it.
  // Re-pinned by returns RX-3 (2026-10-11; was: no draft above it): RX-3's
  // draft, dated later still, sits at the top above RX-2's release. Claim
  // kept: directly below the Items first-paint release, every release above
  // it dated later.
  // Re-pinned by docs/whats-new-returns-requester (2026-10-12; was: "...
  // and returns RX-3's draft at the top"): RX-3's release is published, in
  // the same place, so no draft is left above it.
  // Re-pinned by returns RX-4 (2026-10-12; was: "...; phone ordering's below
  // it" with no draft above it): RX-4's draft, dated later still, sits at the
  // top above RX-3's release. Claim kept: directly below the Items
  // first-paint release, every release above it dated later.
  // Re-pinned by docs/whats-new-returns-close-rest (2026-10-12; was: "...
  // and the returns RX-4 draft at the top"): RX-4's release is published, in
  // the same place, so no draft is left above it.
  // Re-pinned by the return history hand-over fix (D-H1, 2026-10-12; was:
  // "...; phone ordering's below it" with no draft above it): its draft,
  // dated later still, sits at the top above RX-4's release. Claim kept:
  // directly below the Items first-paint release, every release above it
  // dated later.
  // Re-pinned by docs/whats-new-return-history-hand-over (2026-10-12; was:
  // "... and the return history hand-over draft at the top"): its release is
  // published, in the same place, so no draft is left above it.
  // Re-pinned by Ungroup G1 (2026-10-12, rebased onto #354; was: "...;
  // phone ordering's below it" with no draft above it): Ungroup's draft,
  // dated later still, sits at the top above the return history hand-over
  // release. Claim kept: directly below the Items first-paint release, every
  // release above it dated later.
  // Re-pinned by Group selected G2 (2026-10-12, rebased onto #351; was: "...
  // and the Ungroup draft at the top"): Group selected's draft, dated later
  // still, sits at the top above Ungroup's. Claim kept: directly below the
  // Items first-paint release, every release above it dated later.
  // Re-pinned by the What's New publish of ungroup-2026-10 and
  // group-selected-2026-10 (2026-10-12; was: "... the Group selected and
  // Ungroup drafts at the top ..."): both are published in the same
  // places. Claim kept: the same place, dated as before against the
  // releases around it.
  // Renamed by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: "... and the Ungroup and Group selected releases at the top ..."): the Ungroup follow-ups release (#362) and the pages-keep-groups-whole release are published above them, at the top. Claim kept: the same place, dated as before against the releases around it.
  // Renamed by docs/whats-new-redesign-2026-10 (2026-10-20; was: "... Ungroup follow-ups and pages-keep-groups-whole releases at the top ..."): the parked ai-search-finds-every-item release (#367) and the three redesign releases are published above them, at the top. Claim kept: the same place, dated as before against the releases around it.
  // Renamed by docs/whats-new-2026-10-25 (2026-10-25; was: "... ai-search-finds-every-item and three redesign releases at the top ..."): the unsubscribe-rack-question-fixes release is published above them, at the top. Claim kept: the same place, dated as before against the releases around it.
  // Renamed by docs/whats-new-2026-10-26 (2026-10-26; was: "... three redesign and unsubscribe-rack-question-fixes releases at the top ..."): the ended-session-group-page-fixes release is published above them, at the top. Claim kept: the same place, dated as before against the releases around it.
  // Renamed by docs/whats-new-2026-10-30 (2026-10-30; was: "... unsubscribe-rack-question-fixes and ended-session-group-page-fixes releases at the top ..."): the manage-order-items-and-app-fixes release is published above them, at the top. Claim kept: the same place, dated as before against the releases around it.
  it("sits directly below the Items first-paint release, published later, with the weekly digest, slice 2, PO-2, dates fixes, public link and returns RX-2, RX-3, RX-4 and return history hand-over releases above that one, published later still, and the Ungroup, Group selected, Ungroup follow-ups, pages-keep-groups-whole, ai-search-finds-every-item, three redesign, unsubscribe-rack-question-fixes, ended-session-group-page-fixes and manage-order-items-and-app-fixes releases at the top, published later still; phone ordering's below it", () => {
    // Re-pinned by the B44 phone update draft (fix/b44-update-restart-prompt;
    // was: without it): dated after every release, it sits at the top, so
    // every position below it moves down by one, and it and slice 8's are the
    // drafts.
    // Re-pinned by the small fixes slice 8 draft (fix/small-fixes-8; was:
    // without it): dated after every release, it sits at the top, so every
    // position below it moves down by one, and it is the one draft.
    const at = RELEASES.findIndex((r) => r.id === ID);
    expect(at).toBeGreaterThanOrEqual(0);
    // Drafts go above the newest published release, newest first: the Items
    // first-paint (#328), weekly digest fixes' (#326) and PO-2's stay at the
    // top, dated later. Re-pinned by 0395 (was: those three): the
    // partial-approval draft (small fixes slice 2) sits below PO-2's.
    // Re-pinned by the publishing of the Items first-paint release
    // (2026-10-06; was: the newest published release, under four drafts):
    // published later, directly above this one and below the drafts.
    // Re-pinned by the publishing of the weekly digest release (2026-10-06;
    // was: the weekly digest draft at the top, then PO-2's, the
    // partial-approval draft and the Items first-paint release): published
    // later still, below the two drafts and above the Items first-paint release.
    // Re-pinned by the dates fixes draft (2026-10-06; was: without it): a
    // draft dated later, at the top.
    // Re-pinned by the public link draft (fix/placed-cart-draft; was: without
    // it): a draft dated later still, at the top.
    // Re-pinned by returns RX-2 (2026-10-11; was: without it): a draft dated
    // later still, at the top.
    // Re-pinned by returns RX-3 (2026-10-11; was: without it): a draft dated
    // later still, at the top.
    // Re-pinned by returns RX-4 (2026-10-12; was: without it): a draft dated
    // later still, at the top.
    // Re-pinned by the return history hand-over fix (D-H1, 2026-10-12; was:
    // without it): a draft dated later still, at the top.
    // Re-pinned by Ungroup G1 (2026-10-12, rebased onto #354; was: without
    // it): its draft, dated later still, sits at the top above the return
    // history hand-over release.
    // Re-pinned by Group selected G2 (2026-10-12, rebased onto #351; was:
    // without it): its draft, dated later still, sits at the top above
    // Ungroup's draft.
    // Re-pinned by docs/whats-new-ungroup-follow-ups (2026-10-12; was: the list without it): the Ungroup follow-ups release is published after it, at the top.
    // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: the list without it): the pages-keep-groups-whole release is published after it, at the top.
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: the list without them): the three redesign releases and the parked ai-search-finds-every-item release (#367) are published after it, at the top.
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: the list without it): the unsubscribe-rack-question-fixes release is published after it, at the top.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: the list without it): the ended-session-group-page-fixes release is published after it, at the top.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: the list without it): the manage-order-items-and-app-fixes release is published after it, at the top.
    expect(RELEASES.slice(0, at).map((r) => r.id)).toEqual([
      'mobile-app-asks-before-restarting',
      'small-fixes-8-2026-10',
      'manage-order-items-and-app-fixes-2026-10',
      'ended-session-group-page-fixes-2026-10',
      'unsubscribe-rack-question-fixes-2026-10',
      'redesign-2026-10',
      'redesign-mobile-app-2026-10',
      'redesign-web-fixes-2026-10',
      'ai-search-finds-every-item-2026-10',
      'pages-keep-groups-whole-2026-10',
      'ungroup-follow-ups-2026-10',
      'group-selected-2026-10',
      'ungroup-2026-10',
      'returns-history-hand-over-2026-10',
      'returns-close-rest-2026-10',
      'returns-requester-exchange-2026-10',
      'returns-exchange-2026-10',
      'public-link-sent-request-2026-10',
      'dates-fixes-2026-10',
      'order-submit-once-2026-10',
      'order-partial-approval-held-2026-10',
      'weekly-digest-and-fixes-2026-10',
      'items-list-first-paint-2026-10',
    ]);
    // Re-pinned by the publishing of the slice 2 release (2026-10-06; was:
    // draft x4, published x2): the partial-approval release is published, in
    // the same place, below the three drafts.
    // Re-pinned by docs/whats-new-dates-link-submit (2026-10-06; was: draft
    // x3, published x3): the public link, dates fixes and PO-2 releases are
    // published, in the same places, so all six above it are published.
    // Re-pinned by returns RX-2 (2026-10-11; was: published x6): RX-2's draft
    // at the top, then the same six, published.
    // Re-pinned by docs/whats-new-returns-exchange (2026-10-11; was: draft,
    // then published x6): RX-2's release is published, so all seven are.
    // Re-pinned by returns RX-3 (2026-10-11; was: published x7): RX-3's
    // draft at the top, then the same seven, published.
    // Re-pinned by docs/whats-new-returns-requester (2026-10-12; was: draft,
    // then published x7): RX-3's release is published, so all eight are.
    // Re-pinned by returns RX-4 (2026-10-12; was: published x8): RX-4's
    // draft at the top, then the same eight, published.
    // Re-pinned by docs/whats-new-returns-close-rest (2026-10-12; was: draft,
    // then published x8): RX-4's release is published, so all nine are.
    // Re-pinned by the return history hand-over fix (D-H1, 2026-10-12; was:
    // published x9): its draft at the top, then the same nine, published.
    // Re-pinned by docs/whats-new-return-history-hand-over (2026-10-12; was:
    // draft, then published x9): its release is published, so all ten are.
    // Re-pinned by Ungroup G1 (2026-10-12, rebased onto #354; was:
    // published x10): Ungroup's draft at the top, then the same ten,
    // published.
    // Re-pinned by Group selected G2 (2026-10-12, rebased onto #351; was:
    // Ungroup's draft at the top, then published): Group selected's draft
    // above it, then the same, published.
    // Re-pinned by the What's New publish of ungroup-2026-10 and
    // group-selected-2026-10 (2026-10-12; was: two drafts at the top, then
    // published): both are published, in the same places, so every
    // release above this one is published.
    expect(RELEASES.slice(0, at).map((r) => r.status)).toEqual([
      'draft',
      'draft',
      // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: the statuses without it): the manage-order-items-and-app-fixes release is published at the top, so one more release above this one is published.
      'published',
      // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: the statuses without it): the ended-session-group-page-fixes release is published at the top, so one more release above this one is published.
      'published',
      // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: the statuses without it): the unsubscribe-rack-question-fixes release is published at the top, so one more release above this one is published.
      'published',
      // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: the statuses without them): the three redesign releases and the parked ai-search-finds-every-item release (#367) are published at the top, so four more releases above this one are published.
      'published',
      'published',
      'published',
      'published',
      // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: the statuses without it): the pages-keep-groups-whole release is published at the top, so one more release above this one is published.
      'published',
      // Re-pinned by docs/whats-new-ungroup-follow-ups (2026-10-12): the Ungroup follow-ups release is published at the top and reaches this reader, so it is read or seen here too and the order this test checks holds.
      'published',
      'published',
      'published',
      'published',
      'published',
      'published',
      'published',
      'published',
      'published',
      'published',
      'published',
      'published',
      'published',
    ]);
    expect(RELEASES.slice(at + 1).every((r) => r.status === 'published' || r.status === 'withdrawn')).toBe(true);
    for (const r of RELEASES.slice(0, at)) {
      expect(Date.parse(r.publishedAt), r.id).toBeGreaterThan(Date.parse(release().publishedAt));
    }
    for (const r of RELEASES.slice(at + 1)) {
      expect(Date.parse(release().publishedAt), r.id).toBeGreaterThan(Date.parse(r.publishedAt));
    }
    expect(RELEASES[at + 1]?.id).toBe('phone-place-order-2026-10');
  });

  it('tells each change only to the people who can see it', () => {
    expect(release().audience).toBeUndefined();
    const ids = (role: ReleaseViewer['role'], permissions: ReleaseViewer['permissions'], modules: ModuleId[]) =>
      visibleReleases([release()], { role, permissions, enabledModules: modules })[0]?.entries.map((e) => e.id) ?? [];
    // Everyone: the grouped fixes for every member only.
    expect(ids('viewer', [], [])).toEqual(['everyday-fixes']);
    // An approver with Orders, Inventory and Receiving on sees the order and stock fixes.
    const approver = ids('manager', ['orders:request', 'orders:approve', 'items:update', 'stock:adjust'], ['orders', 'inventory', 'receiving']);
    expect(approver).toContain('waiting-for-signature-link');
    expect(approver).toContain('clearer-stock-lines');
    expect(approver).toContain('app-receive-more-than-ordered');
    expect(approver).toContain('app-exception-sheet-closes-cleanly');
    expect(approver).not.toContain('auto-delete-keeps-stock');
    // Bundles: those who manage bundles, with the module on.
    expect(approver).not.toContain('bundle-components-saved-whole');
    expect(ids('manager', ['bundles:manage'], ['inventory', 'bundles'])).toContain('bundle-components-saved-whole');
    expect(ids('manager', ['bundles:manage'], ['inventory'])).not.toContain('bundle-components-saved-whole');
    // Auto-delete is for those who may delete items, with Inventory on.
    expect(ids('admin', ['items:delete'], ['inventory'])).toContain('auto-delete-keeps-stock');
    // A requester is told about cancelling, not the approver's filter.
    const requester = ids('staff', ['orders:request'], ['orders']);
    expect(requester).toContain('cancel-own-order-request');
    expect(requester).not.toContain('waiting-for-signature-link');
  });

  it('never says "book" for the recorded quantity', () => {
    const text = JSON.stringify(release()).toLowerCase();
    expect(text).not.toMatch(/\bbook\b/);
  });

  // Desk check F4: a transfer between locations keeps the stock on record, so
  // the item is still kept; only stock adjusted to zero or written off, with
  // nothing held, lets the daily run delete it (archive-cleanup.ts).
  it('says auto-delete waits for the stock to be adjusted to zero or written off, not moved', () => {
    const e = entry('auto-delete-keeps-stock');
    expect(e.howItAffectsYou).not.toMatch(/moved/);
    expect(e.howItAffectsYou).toContain('adjusted to zero or written off, nothing is held for it and nothing is due back');
  });

  // Review (2026-10-05): stock can come back to an item that holds nothing
  // today (a receipt on an open PO line, a cancel or reopen of a picked
  // batch, a return), so the run also keeps those items (archive-cleanup.ts
  // itemIdsStillHolding), and the entry says so.
  it('names the stock still due back that keeps an archived item', () => {
    expect(entry('auto-delete-keeps-stock').whatChanged).toContain(
      'nothing on an open purchase order, picked for an open order or due back on an open return',
    );
    const service = readFileSync(resolve(__dirname, '../../server/services/archive-cleanup.ts'), 'utf8');
    for (const table of ['purchase_order_items', 'order_request_lines', 'return_lines']) {
      expect(service).toContain(`.from('${table}')`);
    }
  });

  // Desk check F5 (owner rule 2026-09-25: every user-visible change gets a
  // line). The release holds at most 12 entries, so the smaller ones are
  // grouped; each change in the slice that a person can see is named here,
  // but the offline Try again (1.33), left out on purpose (pinned below).
  it('has a line for every user-visible change in the slice', () => {
    expect(release().entries).toHaveLength(12);
    const text = readerText(release()).join(' ');
    for (const phrase of [
      'archived item',                            // 1.1
      'duplicated item',                          // 1.2
      'a new bundle whose components cannot be saved is removed again', // 1.5, F1
      'Cancel request',                           // 1.8, 1.31, F3
      'Physical signature',                       // 1.9
      'Waiting for signature',                    // 1.10
      'the new order page on the web says so',    // 1.11
      'what was handed over is recorded',         // 1.12
      'so does recording a Physical signature on the web', // 1.12, review
      'emailed at the address on their profile',  // 1.13
      'SO-000049',                                // 1.14
      'Timeline',                                 // 1.15
      'delivery request notes',                   // 1.18
      "What's New notice",                        // 1.19
      'Delete account',                           // 1.20
      'held for other orders',                    // 1.22, 1.23
      'not yet confirmed by email',               // 1.25
      'PICKING',                                  // 1.26
      'Add a note form',                          // 1.29
      'add a note to the receipt',                // 1.32
      'The note field shows only on a PO with something left to receive', // 1.32, review
      'no longer shows the hint about posting a receipt', // 1.30, review
      'card shows only to people who approve orders', // F10, review
      'says so under Variance', // review: the phone's variance caption
    ]) {
      expect(text, phrase).toContain(phrase);
    }
  });

  it('quotes the words the code shows', () => {
    const text = readerText(release()).join(' ');
    // Review (2026-10-05): nobody can reach the duplicate refusal (the bundle
    // form, the only writer, refuses a second add first), so it is not told.
    expect(text).not.toContain(BUNDLE_DUPLICATE_COMPONENT);
    expect(text).not.toMatch(/adding it twice|names one item twice/);
    const timeline = readFileSync(
      resolve(__dirname, '../../components/orders/order-timeline.tsx'),
      'utf8',
    );
    const sentence = "Only people who can view the audit log can see this order's history.";
    expect(timeline).toContain(JSON.stringify(sentence));
    expect(text).toContain(sentence);
  });

  // 1.27 shipped with security slice A3 (#321), and A3's release, published
  // on 2026-10-05 (#323), tells it in What to do (pinned in the A3 block
  // above): this one must not announce it a release late.
  it("leaves the app's role pill to the account deletion release that shipped it", () => {
    const text = readerText(release()).join(' ');
    expect(text).not.toMatch(/shows your (own )?role|Owner for everyone|instead of OWNER/);
    const a3 = RELEASES.find((r) => r.id === 'account-deletion-everyone-2026-10')!;
    expect(a3.status).toBe('published');
    expect(a3.entries[0]!.whatToDo).toContain('Settings then shows your own role instead of OWNER.');
  });

  // Review (2026-10-05): the web receive dialog never asks; it takes an
  // over-receipt and captions the variance. Only the phone asks.
  it('never says the web asks before an over-receipt', () => {
    const e = entry('app-receive-more-than-ordered');
    expect(e.whatChanged).not.toMatch(/as the web does/);
    expect(e.whatChanged).toContain('The web already accepts it and shows how many are over ordered');
    const dialog = readFileSync(resolve(__dirname, '../../components/po/po-receive-dialog.tsx'), 'utf8');
    expect(dialog).not.toMatch(/more than ordered\?/);
    expect(dialog).toContain('over ordered');
  });

  // Review (2026-10-05): everyday-fixes is told to phones too, so a web-only
  // change says so; and the phone's approver action is Cancel order, not the
  // web's Cancel request, so the cancel entry names it. At publish, the
  // offline Try again came out, so every change left in that entry is on the
  // web, and its area says so.
  it("says which changes are on the web, and names the app's own cancel words", () => {
    const everyday = entry('everyday-fixes');
    expect(everyday.area).toBe('Web app');
    expect(everyday.whatChanged).toContain('On the web, a refused Delete account says why inside the dialog');
    expect(everyday.whatChanged).toContain('With Orders turned off, the new order page on the web says so.');
    const cancel = entry('cancel-own-order-request');
    expect(cancel.whatChanged).not.toMatch(/as on the web/);
    expect(cancel.whatChanged).toContain('with Cancel order');
    const phone = readFileSync(resolve(__dirname, '../../../../mobile/src/lib/order-cancel-action.ts'), 'utf8');
    expect(phone).toContain("label: 'Cancel order'");
  });

  // Review (2026-10-05): a closed order's slip refusal is reached only from a
  // stale tab or a typed address, as raw JSON, so it is not told.
  it('does not announce the slip refusal words', () => {
    const text = readerText(release()).join(' ');
    expect(text).not.toMatch(/\bslips?\b/i);
  });

  // Review (2026-10-05) gated the offline Try again sentence (1.33) on an
  // airplane-mode check on hardware at the OTA walk. The simulator shares the
  // Mac's network and cannot go offline, so the walk could not run it (P5).
  // At publish its sentence, its why, the words about the connection coming
  // back and Try again in the entry's title came out, with the gate comment.
  // The change itself shipped and stays (foreground-tick.ts).
  it('says nothing about Try again while offline, which was never seen on a device', () => {
    const text = readerText(release()).join(' ');
    expect(text).not.toMatch(/offline|spinner|connection comes back|tries again/i);
    expect(text).not.toMatch(/Try again no longer|Try again works/);
    const everyday = entry('everyday-fixes');
    expect(everyday.title).toBe("The What's New notice, Delete account and the dashboard");
    expect(everyday.howItAffectsYou).toBe('No change to what you can do.');
    const source = readFileSync(resolve(__dirname, './registry.ts'), 'utf8');
    expect(source).not.toContain('PUBLISH GATE');
    expect(source).not.toContain('airplane-mode check on hardware');
    const tick = readFileSync(resolve(__dirname, '../../../../mobile/src/lib/foreground-tick.ts'), 'utf8');
    expect(tick).toContain('if (await deps.isOnline()) await deps.retryWorkspace();');
  });

  it('offers Cancel only with orders:request, as the entry says (desk check F3)', () => {
    expect(entry('cancel-own-order-request').howItAffectsYou).toContain(
      'Cancel is offered only to people allowed to request orders',
    );
  });

  // Publish re-read: the phone half is an over-the-air update. When this
  // shipped, the app loaded it by itself when it was opened again (on a cold
  // launch it checked, fetched and reloaded), so every phone change is said
  // after the latest update, and the entries for the app's own changes, and
  // for a photo replaced in the app, say how to load it. Since B44 the app
  // asks first: "Update ready", then Restart now (use-ota-updates.ts).
  it('says every phone change after the latest update, and how to load it', () => {
    const ota = readFileSync(resolve(__dirname, '../../../../mobile/src/lib/use-ota-updates.ts'), 'utf8');
    expect(ota).toContain('await Updates.checkForUpdateAsync();');
    expect(ota).toContain('await Updates.reloadAsync({ reloadScreenOptions: RESTART_SCREEN });');
    expect(release().summary).toContain('In the mobile app, after the latest update, you can cancel');
    expect(entry('duplicate-item-photos-kept').whatChanged).toContain(
      'or replacing it in the mobile app after the latest update',
    );
    expect(entry('duplicate-item-photos-kept').howItAffectsYou).toContain(
      'on the web now, and in the mobile app after the latest update',
    );
    expect(entry('cancel-own-order-request').whatChanged).toMatch(/^After the latest update, /);
    expect(entry('waiting-for-signature-link').whatChanged).toContain(
      'In the mobile app, after the latest update, the Orders list leaves out',
    );
    expect(entry('clearer-stock-lines').howItAffectsYou).toContain('and in the mobile app after the latest update');
    expect(entry('app-order-status-words').whatChanged).toMatch(/^In the mobile app, after the latest update, /);
    expect(entry('app-receive-more-than-ordered').whatChanged).toMatch(/^After the latest update, /);
    expect(entry('app-exception-sheet-closes-cleanly').whatChanged).toMatch(/^In the mobile app, after the latest update, /);
    const reopen = 'close the app completely and open it again to load the latest update.';
    for (const id of ['app-receive-more-than-ordered', 'app-exception-sheet-closes-cleanly']) {
      expect(entry(id).whatToDo, id).toBe(`C${reopen.slice(1)}`);
    }
    for (const id of ['duplicate-item-photos-kept', 'cancel-own-order-request']) {
      expect(entry(id).whatToDo, id).toBe(`No action needed on the web. In the mobile app, ${reopen}`);
    }
  });

  // Publish re-read: on the web an approver is offered Cancel request (the
  // button's one label) at every open status (walk W3: approved, pending,
  // staged and backordered; not cancelled), so "no Cancel request once
  // approved" and the old refusal are said of people who do not approve
  // orders. Before the slice an approver could already cancel a backordered
  // order in the app, so the why does not say cancelling needed the web.
  it("says the cancel rules for the people they apply to, as core's orderCancelOffer has them", () => {
    const e = entry('cancel-own-order-request');
    expect(e.howItAffectsYou).toContain(
      'If you do not approve orders, once your order is approved only someone who approves orders can cancel it, so neither the app nor the web offers you Cancel request then.',
    );
    expect(e.whyItMatters).not.toMatch(/Cancelling needed the web/);
    expect(e.whyItMatters).toContain('only a backordered order');
    expect(e.whyItMatters).toContain('someone who does not approve orders was offered Cancel request on their own order');
    const open = { isOwnRequest: true, canRequest: true };
    for (const status of ['approved', 'pending_approval', 'staged_for_pickup', 'backordered']) {
      expect(orderCancelOffer({ status, canApprove: true, ...open }), status).toBe('approver');
    }
    expect(orderCancelOffer({ status: 'cancelled', canApprove: true, ...open })).toBeNull();
    expect(orderCancelOffer({ status: 'pending_approval', canApprove: false, ...open })).toBe('requester');
    expect(orderCancelOffer({ status: 'approved', canApprove: false, ...open })).toBeNull();
    expect(orderCancelOffer({ status: 'pending_approval', canApprove: true, isOwnRequest: true, canRequest: false })).toBeNull();
    const web = readFileSync(resolve(__dirname, '../../components/orders/cancel-order-button.tsx'), 'utf8');
    expect(web).toContain('confirmLabel="Cancel request"');
    expect(web).not.toMatch(/Cancel order/);
  });

  // Publish re-read: a Physical signature that completed the order already
  // emailed a member who placed their own order the completion receipt
  // (notifyEmail resolves their profile address); only one that left items
  // owed gave them a notification and no email. Claims review: the why says
  // "a notification", not "the notice in the app", since elsewhere in this
  // release the app is the mobile app and the notification shows on the web
  // too. The notification goes to the requester's id; the email needs an
  // address, and the paper path passed the empty requester_email column.
  it('says which Physical signature left a requester with a notification but no email', () => {
    const e = entry('sign-page-partial-handover');
    expect(e.whyItMatters).toContain(
      'After a Physical signature that left items owed, a person who placed their own order got a notification but no email.',
    );
    expect(e.whyItMatters).not.toContain('the notice in the app');
    const service = readFileSync(resolve(__dirname, '../../server/services/order-requests.ts'), 'utf8');
    expect(service).toContain("defer(() => this.notifyEmail(row, 'completed'));");
    expect(service).toContain(': await resolveRequesterContact(admin, {');
    const notify = readFileSync(resolve(__dirname, '../../server/lib/order-handover-notify.ts'), 'utf8');
    expect(notify).toContain('if (args.requesterUserId) {');
    expect(notify).toContain('if (args.requesterEmail && !args.emailOptedOut) {');
  });

  // Publish re-read: the held sentence takes the place of "Nothing is on
  // order."; a line with a draft PO, or with stock on order, says that
  // instead, so the words name the lines that changed.
  it('says which short lines now name the stock held for others', () => {
    expect(entry('clearer-stock-lines').whatChanged).toContain(
      'Where a short line said Nothing is on order while stock on the shelf is held for other orders or rentals, it now says so, for example: 10 on the shelf are held for other orders.',
    );
    const copy = readFileSync(resolve(__dirname, '../../../../../packages/core/src/orders/readiness-copy.ts'), 'utf8');
    expect(copy).toContain("const held = u.awaiting <= 0 && !takenBy && !draft ? heldForOthersSentence(item) : null;");
    expect(copy).toContain("else if (!draft && !held) parts.push('Nothing is on order.');");
    expect(copy).toContain("return `${fq(held)} on the shelf ${isOne(held) ? 'is' : 'are'} held for ${forWhom}.`;");
  });

  // Publish re-read: the Timeline's sentence shows only to someone who cannot
  // view the audit log, and the notes change is on the web.
  it("says who sees the Timeline's sentence, and that the full-width notes are on the web", () => {
    const e = entry('app-order-status-words');
    expect(e.whatChanged).toContain("On the web, if you cannot view the audit log, an order's Timeline says:");
    expect(e.whatChanged).toContain('The delivery request notes after placing an order on the web use the full width.');
    const timeline = readFileSync(resolve(__dirname, '../../components/orders/order-timeline.tsx'), 'utf8');
    expect(timeline).toContain('if (!canReadActivity) {');
  });

  // Publish re-read: the receipt's note field is new in the slice, so a
  // draft never showed it; it and the receipt hint show only while a line has
  // something left to receive.
  it('says where the note field shows, not that a draft no longer shows it', () => {
    const e = entry('app-receive-more-than-ordered');
    expect(e.whatChanged).not.toMatch(/no longer shows the note field/);
    expect(e.howItAffectsYou).toBe('Tap Receive anyway to post the receipt as entered.');
    const screen = readFileSync(resolve(__dirname, '../../../../mobile/app/po/[id].tsx'), 'utf8');
    // Re-pinned by 0395 (small fixes slice 2; was: !reviewOnly): receiving
    // also needs stock:adjust now, so the screen is read-only for a draft or
    // for someone who cannot receive, and the note field still shows only on
    // a PO with something left to receive.
    expect(screen).toContain('const readOnly = reviewOnly || !canReceive;');
    expect(screen).toContain('!readOnly && lines.some((l) => l.quantity_ordered - l.quantity_received > 0);');
    const receive = readFileSync(resolve(__dirname, '../../../../mobile/src/lib/po-receive.ts'), 'utf8');
    expect(receive).toContain("export const OVER_RECEIPT_CONFIRM_LABEL = 'Receive anyway';");
  });

  // Publish re-read: before the slice an approver's waiting for signature
  // card opened Needs approval, not their own requests.
  it('says the card opened their own requests only for people who do not approve orders', () => {
    expect(entry('everyday-fixes').whyItMatters).toContain(
      'for people who do not approve orders it opened their own requests',
    );
    expect(entry('waiting-for-signature-link').whyItMatters).toContain('The dashboard link opened the Needs approval tab.');
  });
});

// The weekly digest and fixes: #326 (b9887f2a), #331 (1d37307d) and #332
// (01001c54), web only, no migration. PUBLISHED 2026-10-06 after each went
// live and was checked in Demo Co (#326: a warehouse's page and one preview
// of the digest; #331: the calendar, the PO list's Expected date and Make
// recurring's form; #332: every line Make recurring brings over named). The
// digest cron's first run is Monday 2026-10-12 14:00Z, so the words say what
// the code does, never that a digest arrived. No phone update: none of the
// three changes the mobile app. Each change is told to the people who can see
// it; the digest and warehouse entries reach every member.
describe('the weekly digest and fixes release', () => {
  const ID = 'weekly-digest-and-fixes-2026-10';
  const release = () => RELEASES.find((r) => r.id === ID)!;
  const entry = (id: string) => release().entries.find((e) => e.id === id)!;
  const everyone: ReleaseViewer = {
    role: 'owner',
    permissions: [...PERMISSIONS],
    enabledModules: Object.keys(MODULE_REGISTRY) as ModuleId[],
  };
  const member: ReleaseViewer = { role: 'viewer', permissions: [], enabledModules: [] };

  // Re-pinned by docs/whats-new-dates-link-submit (2026-10-06; was: "...
  // below the drafts and slice 2's release ..."): no draft is left above it.
  it("is published at a real time after its production checks, below the public link, dates fixes, PO-2 and slice 2 releases and directly above the Items first-paint release", () => {
    // Re-pinned by the B44 phone update draft (fix/b44-update-restart-prompt;
    // was: without it): dated after every release, it sits at the top, so
    // every position below it moves down by one, and it and slice 8's are the
    // drafts.
    // Re-pinned by the small fixes slice 8 draft (fix/small-fixes-8; was:
    // without it): dated after every release, it sits at the top, so every
    // position below it moves down by one, and it is the one draft.
    // Re-pinned by the publishing of the weekly digest release (2026-10-06;
    // was: the newest entry, a draft dated after every release): published,
    // it sits below the drafts (PO-2's and the partial-approval one, dated
    // later) and above the Items first-paint release, dated after it.
    expect(release().status).toBe('published');
    expect(release().revision).toBe(1);
    // A whole minute after the last production check ended (K3B on #332's
    // build, 2026-10-06 03:20:49Z; #332 merged 03:16:04Z): never the draft's
    // placeholder date.
    expect(release().publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/);
    expect(Date.parse(release().publishedAt)).toBeGreaterThan(Date.parse('2026-10-06T03:20:49Z'));
    expect(Date.parse(release().publishedAt)).toBeLessThanOrEqual(Date.parse('2026-10-07T00:00:00Z'));
    const at = RELEASES.findIndex((r) => r.id === ID);
    // Re-pinned by the dates fixes draft (2026-10-06; was: PO-2's and the
    // partial-approval drafts): a draft dated later, at the top.
    // Re-pinned by the public link draft (fix/placed-cart-draft; was: the
    // dates fixes draft at the top): a draft dated later still, above it
    // (the title no longer counts the drafts).
    // Re-pinned by returns RX-2 (2026-10-11; was: without it): a draft dated
    // later still, at the top.
    // Re-pinned by returns RX-3 (2026-10-11; was: without it): a draft dated
    // later still, at the top.
    // Re-pinned by returns RX-4 (2026-10-12; was: without it): a draft dated
    // later still, at the top.
    // Re-pinned by the return history hand-over fix (D-H1, 2026-10-12; was:
    // without it): a draft dated later still, at the top.
    // Re-pinned by Ungroup G1 (2026-10-12, rebased onto #354; was: without
    // it): its draft, dated later still, sits at the top above the return
    // history hand-over release.
    // Re-pinned by Group selected G2 (2026-10-12, rebased onto #351; was:
    // without it): its draft, dated later still, sits at the top above
    // Ungroup's draft.
    // Re-pinned by docs/whats-new-ungroup-follow-ups (2026-10-12; was: the list without it): the Ungroup follow-ups release is published after it, at the top.
    // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: the list without it): the pages-keep-groups-whole release is published after it, at the top.
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: the list without them): the three redesign releases and the parked ai-search-finds-every-item release (#367) are published after it, at the top.
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: the list without it): the unsubscribe-rack-question-fixes release is published after it, at the top.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: the list without it): the ended-session-group-page-fixes release is published after it, at the top.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: the list without it): the manage-order-items-and-app-fixes release is published after it, at the top.
    expect(RELEASES.slice(0, at).map((r) => r.id)).toEqual([
      'mobile-app-asks-before-restarting',
      'small-fixes-8-2026-10',
      'manage-order-items-and-app-fixes-2026-10',
      'ended-session-group-page-fixes-2026-10',
      'unsubscribe-rack-question-fixes-2026-10',
      'redesign-2026-10',
      'redesign-mobile-app-2026-10',
      'redesign-web-fixes-2026-10',
      'ai-search-finds-every-item-2026-10',
      'pages-keep-groups-whole-2026-10',
      'ungroup-follow-ups-2026-10',
      'group-selected-2026-10',
      'ungroup-2026-10',
      'returns-history-hand-over-2026-10',
      'returns-close-rest-2026-10',
      'returns-requester-exchange-2026-10',
      'returns-exchange-2026-10',
      'public-link-sent-request-2026-10',
      'dates-fixes-2026-10',
      'order-submit-once-2026-10',
      'order-partial-approval-held-2026-10',
    ]);
    // Re-pinned by the publishing of the slice 2 release (2026-10-06; was:
    // every release above this one a draft): the partial-approval release is
    // published, later, directly above this one, and the three drafts above it.
    // Re-pinned by docs/whats-new-dates-link-submit (2026-10-06; was: draft
    // x3, published x1): the public link, dates fixes and PO-2 releases are
    // published, in the same places, so all four above it are published.
    // Re-pinned by returns RX-2 (2026-10-11; was: published x4): RX-2's draft
    // at the top, then the same four, published.
    // Re-pinned by docs/whats-new-returns-exchange (2026-10-11; was: draft,
    // then published x4): RX-2's release is published, so all five are.
    // Re-pinned by returns RX-3 (2026-10-11; was: published x5): RX-3's
    // draft at the top, then the same five, published.
    // Re-pinned by docs/whats-new-returns-requester (2026-10-12; was: draft,
    // then published x5): RX-3's release is published, so all six are.
    // Re-pinned by returns RX-4 (2026-10-12; was: published x6): RX-4's
    // draft at the top, then the same six, published.
    // Re-pinned by docs/whats-new-returns-close-rest (2026-10-12; was: draft,
    // then published x6): RX-4's release is published, so all seven are.
    // Re-pinned by the return history hand-over fix (D-H1, 2026-10-12; was:
    // published x7): its draft at the top, then the same seven, published.
    // Re-pinned by docs/whats-new-return-history-hand-over (2026-10-12; was:
    // draft, then published x7): its release is published, so all eight are.
    // Re-pinned by Ungroup G1 (2026-10-12, rebased onto #354; was:
    // published x8): Ungroup's draft at the top, then the same eight,
    // published.
    // Re-pinned by Group selected G2 (2026-10-12, rebased onto #351; was:
    // Ungroup's draft at the top, then published): Group selected's draft
    // above it, then the same, published.
    // Re-pinned by the What's New publish of ungroup-2026-10 and
    // group-selected-2026-10 (2026-10-12; was: two drafts at the top, then
    // published): both are published, in the same places, so every
    // release above this one is published.
    expect(RELEASES.slice(0, at).map((r) => r.status)).toEqual([
      'draft',
      'draft',
      // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: the statuses without it): the manage-order-items-and-app-fixes release is published at the top, so one more release above this one is published.
      'published',
      // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: the statuses without it): the ended-session-group-page-fixes release is published at the top, so one more release above this one is published.
      'published',
      // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: the statuses without it): the unsubscribe-rack-question-fixes release is published at the top, so one more release above this one is published.
      'published',
      // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: the statuses without them): the three redesign releases and the parked ai-search-finds-every-item release (#367) are published at the top, so four more releases above this one are published.
      'published',
      'published',
      'published',
      'published',
      // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: the statuses without it): the pages-keep-groups-whole release is published at the top, so one more release above this one is published.
      'published',
      // Re-pinned by docs/whats-new-ungroup-follow-ups (2026-10-12): the Ungroup follow-ups release is published at the top and reaches this reader, so it is read or seen here too and the order this test checks holds.
      'published',
      'published',
      'published',
      'published',
      'published',
      'published',
      'published',
      'published',
      'published',
      'published',
      'published',
    ]);
    expect(RELEASES[at - 1]?.id).toBe('order-partial-approval-held-2026-10');
    expect(RELEASES[at + 1]?.id).toBe('items-list-first-paint-2026-10');
    for (const r of RELEASES.slice(0, at)) {
      expect(Date.parse(r.publishedAt), r.id).toBeGreaterThan(Date.parse(release().publishedAt));
    }
    for (const r of RELEASES.slice(at + 1)) {
      expect(Date.parse(release().publishedAt), r.id).toBeGreaterThan(Date.parse(r.publishedAt));
    }
  });

  // Re-pinned by docs/whats-new-dates-link-submit (2026-10-06; was: "...;
  // it is the notice for everyone slice 2's release does not reach, and for
  // the rest once that one is read"): every member is told the dates fixes
  // release first now.
  it('reaches every member, so every feed carries it; it is the notice once the newer releases a reader is told are read', () => {
    // Re-pinned by the publishing of the weekly digest release (2026-10-06;
    // was: a draft no feed carried): the digest and warehouse entries have no
    // audience, so a member with no permission and no module is told too.
    for (const viewer of [everyone, member]) {
      expect(visibleReleases(RELEASES, viewer).map((r) => r.id)).toContain(ID);
    }
    // Re-pinned by the publishing of the slice 2 release (2026-10-06; was:
    // this one, for both readers): published later, it is the notice for an
    // owner with every module, and this one comes once it is read. A member
    // with no permission and no module is not told the slice 2 release, so
    // this one stays their notice.
    // Re-pinned by docs/whats-new-dates-link-submit (2026-10-06; was: this
    // one for the member, order-partial-approval-held-2026-10 for the
    // owner): the dates fixes release, published later, has a line for every
    // member (the digest's send time), so it is the member's notice, and
    // this one comes once it is read. An owner with every module is told the
    // public link release first, and this one once the public link, dates
    // fixes, PO-2 and slice 2 releases are read.
    // Re-pinned by the What's New publish of ungroup-2026-10 and
    // group-selected-2026-10 (2026-10-12; was: dates-fixes-2026-10 with
    // nothing read): Group selected's release, published later, reaches
    // every member (its list entries have no audience), so this member is
    // told it first, and the reads below include it. Claim kept: the same
    // order after it.
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: group-selected-2026-10 with nothing read, and the
    // reads below without the redesign releases): the three redesign releases, published later still, reach every
    // member, so this member is told redesign-2026-10 first, Group selected's once the three are read, and the
    // reads below include them. Claim kept: a member is told the dates fixes release, then this one.
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: redesign-2026-10 with nothing read): the unsubscribe-rack-question-fixes release, published at the top, reaches every member, so this reader is told it first and redesign-2026-10 once it is read; the reads and seen sets below include it.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: unsubscribe-rack-question-fixes-2026-10 with nothing read): the ended-session-group-page-fixes release, published at the top, reaches every member, so this reader is told it first and the unsubscribe-rack-question-fixes release once it is read. Claim kept: the same order after them.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: ended-session-group-page-fixes-2026-10 with nothing read): the manage-order-items-and-app-fixes release, published at the top, reaches every member, so this reader is told it first and the ended-session-group-page-fixes release once it is read. Claim kept: the same order after them.
    expect(buildReleaseList(RELEASES, member, [], null).latestUnread?.id).toBe(
      'manage-order-items-and-app-fixes-2026-10',
    );
    expect(buildReleaseList(RELEASES, member, [latestRead()], null).latestUnread?.id).toBe(
      'ended-session-group-page-fixes-2026-10',
    );
    expect(
      buildReleaseList(RELEASES, member, [latestRead(), topRead()], null).latestUnread?.id,
    ).toBe('unsubscribe-rack-question-fixes-2026-10');
    expect(
      buildReleaseList(RELEASES, member, [latestRead(), topRead(), newestRead()], null).latestUnread
        ?.id,
    ).toBe('redesign-2026-10');
    const readNow = (id: string) => ({
      release_id: id,
      revision: 1,
      dismissed_at: null,
      opened_at: '2026-10-06T13:00:00Z',
      read_at: '2026-10-06T13:00:00Z',
    });
    expect(buildReleaseList(RELEASES, member, redesignReads(), null).latestUnread?.id).toBe(
      'group-selected-2026-10',
    );
    expect(
      buildReleaseList(
        RELEASES,
        member,
        [...redesignReads(), readNow('group-selected-2026-10')],
        null,
      ).latestUnread?.id,
    ).toBe('dates-fixes-2026-10');
    expect(
      buildReleaseList(
        RELEASES,
        member,
        [...redesignReads(), readNow('group-selected-2026-10'), readNow('dates-fixes-2026-10')],
        null,
      ).latestUnread?.id,
    ).toBe(ID);
    // Re-pinned by docs/whats-new-returns-exchange (2026-10-11; was:
    // public-link-sent-request-2026-10, and this one once the public link,
    // dates fixes, PO-2 and slice 2 releases are read): returns RX-2's
    // release, published later, is that owner's notice, and this one comes
    // once it is read too. Claim kept: a member is told the dates fixes
    // release, then this one.
    // Re-pinned by docs/whats-new-returns-requester (2026-10-12; was:
    // returns-exchange-2026-10, and this one once it and the four below it
    // are read): returns RX-3's release, published later still, is that
    // owner's notice, and this one comes once it is read too. Claim kept: a
    // member is told the dates fixes release, then this one.
    // Re-pinned by docs/whats-new-returns-close-rest (2026-10-12; was:
    // returns-requester-exchange-2026-10, and this one once it and the five
    // below it are read): returns RX-4's release, published later still, is
    // that owner's notice, and this one comes once it is read too. It reaches
    // no member without a permission, so the member's lines are unchanged.
    // Claim kept: a member is told the dates fixes release, then this one.
    // Re-pinned by docs/whats-new-return-history-hand-over (2026-10-12; was:
    // returns-close-rest-2026-10, and this one once it and the six below it
    // are read): the return history hand-over release, published later
    // still, is that owner's notice, and this one comes once it is read too.
    // It reaches no member without a returns permission, so the member's
    // lines are unchanged. Claim kept: a member is told the dates fixes
    // release, then this one.
    // Re-pinned by the What's New publish of ungroup-2026-10 and
    // group-selected-2026-10 (2026-10-12): was returns-history-hand-over-2026-10.
    // Group selected's release, published a minute after Ungroup's, is that
    // owner's notice now, and the newer reads below include both. Claim kept:
    // a member is told the dates fixes release, then this one.
    // Re-pinned by docs/whats-new-ungroup-follow-ups (2026-10-12; was: group-selected-2026-10): the Ungroup follow-ups release is published after it, at the top and reaches this reader.
    // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: ungroup-follow-ups-2026-10): the pages-keep-groups-whole release is published after it, at the top, and reaches this reader; it reaches no member without items:read, so the member's lines above are unchanged.
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: pages-keep-groups-whole-2026-10): the three redesign releases and the parked ai-search-finds-every-item release (#367) are published after it, at the top, and redesign-2026-10, the newest, reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: redesign-2026-10 with nothing read): the unsubscribe-rack-question-fixes release, published at the top, reaches every member, so this reader is told it first and redesign-2026-10 once it is read; the reads and seen sets below include it.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: unsubscribe-rack-question-fixes-2026-10 with nothing read): the ended-session-group-page-fixes release, published at the top, reaches every member, so this reader is told it first and the unsubscribe-rack-question-fixes release once it is read. Claim kept: the same order after them.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: ended-session-group-page-fixes-2026-10 with nothing read): the manage-order-items-and-app-fixes release, published at the top, reaches every member, so this reader is told it first and the ended-session-group-page-fixes release once it is read. Claim kept: the same order after them.
    expect(buildReleaseList(RELEASES, everyone, [], null).latestUnread?.id).toBe(
      'manage-order-items-and-app-fixes-2026-10',
    );
    expect(buildReleaseList(RELEASES, everyone, [latestRead()], null).latestUnread?.id).toBe(
      'ended-session-group-page-fixes-2026-10',
    );
    expect(
      buildReleaseList(RELEASES, everyone, [latestRead(), topRead()], null).latestUnread?.id,
    ).toBe('unsubscribe-rack-question-fixes-2026-10');
    expect(
      buildReleaseList(RELEASES, everyone, [latestRead(), topRead(), newestRead()], null)
        .latestUnread?.id,
    ).toBe('redesign-2026-10');
    const slice2Read = [
      {
        release_id: 'order-partial-approval-held-2026-10',
        revision: 1,
        dismissed_at: null,
        opened_at: '2026-10-06T12:00:00Z',
        read_at: '2026-10-06T12:00:00Z',
      },
    ];
    // Re-pinned by the What's New publish of ungroup-2026-10 and
    // group-selected-2026-10 (2026-10-12): was: from the hand-over release
    // down): Group selected's and Ungroup's releases are newer still and reach
    // that owner, so they are read too.
    const newerRead = [
      // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: the reads without them): the three redesign releases and the parked ai-search-finds-every-item release (#367) are published at the top and reach this reader, so they are read here too and the order this test checks holds.
      // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: the reads without it): the unsubscribe-rack-question-fixes release is published at the top and reaches this reader, so it is read here too and the order this test checks holds.
      // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: the reads without it): the ended-session-group-page-fixes release is published at the top and reaches this reader, so it is read here too and the order this test checks holds.
      // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: the reads without it): the manage-order-items-and-app-fixes release is published at the top and reaches this reader, so it is read here too and the order this test checks holds.
      readNow('manage-order-items-and-app-fixes-2026-10'),
      readNow('ended-session-group-page-fixes-2026-10'),
      readNow('unsubscribe-rack-question-fixes-2026-10'),
      readNow('redesign-2026-10'),
      readNow('redesign-mobile-app-2026-10'),
      readNow('redesign-web-fixes-2026-10'),
      readNow('ai-search-finds-every-item-2026-10'),
      // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: the reads without it): the pages-keep-groups-whole release is published at the top and reaches this reader, so it is read here too and the order this test checks holds.
      readNow('pages-keep-groups-whole-2026-10'),
      // Re-pinned by docs/whats-new-ungroup-follow-ups (2026-10-12): the Ungroup follow-ups release is published at the top and reaches this reader, so it is read or seen here too and the order this test checks holds.
      readNow('ungroup-follow-ups-2026-10'),
      readNow('group-selected-2026-10'),
      readNow('ungroup-2026-10'),
      readNow('returns-history-hand-over-2026-10'),
      readNow('returns-close-rest-2026-10'),
      readNow('returns-requester-exchange-2026-10'),
      readNow('returns-exchange-2026-10'),
      readNow('public-link-sent-request-2026-10'),
      readNow('dates-fixes-2026-10'),
      readNow('order-submit-once-2026-10'),
      ...slice2Read,
    ];
    expect(buildReleaseList(RELEASES, everyone, newerRead, null).latestUnread?.id).toBe(ID);
    expect(visibleReleases(RELEASES, member).find((r) => r.id === ID)!.entries.map((e) => e.id)).toEqual([
      'weekly-digest-sent',
      'weekly-digest-your-view',
      'warehouse-page-opens',
    ]);
    expect(visibleReleases(RELEASES, everyone).find((r) => r.id === ID)!.entries).toHaveLength(7);
    // An old phone build lists it first, with the notification settings link.
    // Re-pinned by docs/whats-new-dates-link-submit (2026-10-06; was: first
    // with nothing seen): the dates fixes release comes first for a member,
    // so this one is first once that one is seen.
    // Re-pinned by the What's New publish of ungroup-2026-10 and
    // group-selected-2026-10 (2026-10-12): was: the dates fixes release first,
    // and this one once it is seen): Group selected's release comes first for
    // a member, then the dates fixes release, and this one once both are seen.
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: group-selected-2026-10 first with nothing seen,
    // and the seen sets without the redesign releases): the three redesign releases come first for a member, then
    // Group selected's and the dates fixes release, and this one once all five are seen.
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: redesign-2026-10 first with nothing seen): the unsubscribe-rack-question-fixes release, published at the top, reaches this reader and comes first until it is seen too; the seen sets below include it.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: unsubscribe-rack-question-fixes-2026-10 with nothing seen): the ended-session-group-page-fixes release, published at the top, reaches every member, so this reader is told it first and the unsubscribe-rack-question-fixes release once it is seen. Claim kept: the same order after them.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: ended-session-group-page-fixes-2026-10 with nothing seen): the manage-order-items-and-app-fixes release, published at the top, reaches every member, so this reader is told it first and the ended-session-group-page-fixes release once it is seen. Claim kept: the same order after them.
    expect(legacyAnnouncementsFor(RELEASES, member, {})[0]?.id).toBe(
      'manage-order-items-and-app-fixes-2026-10',
    );
    expect(legacyAnnouncementsFor(RELEASES, member, latestSeen())[0]?.id).toBe(
      'ended-session-group-page-fixes-2026-10',
    );
    expect(legacyAnnouncementsFor(RELEASES, member, { ...latestSeen(), ...topSeen() })[0]?.id).toBe(
      'unsubscribe-rack-question-fixes-2026-10',
    );
    expect(
      legacyAnnouncementsFor(RELEASES, member, {
        ...latestSeen(),
        ...topSeen(),
        ...newestSeen(),
      })[0]?.id,
    ).toBe('redesign-2026-10');
    expect(legacyAnnouncementsFor(RELEASES, member, redesignSeen())[0]?.id).toBe(
      'group-selected-2026-10',
    );
    expect(
      legacyAnnouncementsFor(RELEASES, member, {
        ...redesignSeen(),
        'group-selected-2026-10': true,
      })[0]?.id,
    ).toBe('dates-fixes-2026-10');
    expect(
      legacyAnnouncementsFor(RELEASES, member, {
        ...redesignSeen(),
        'group-selected-2026-10': true,
        'dates-fixes-2026-10': true,
      })[0],
    ).toEqual({
      id: ID,
      date: release().publishedAt.slice(0, 10),
      title: release().title,
      body: release().summary,
      cta: { href: '/dashboard/settings/notifications', label: 'Open notification settings' },
    });
    expect(registryFingerprint(RELEASES)).toContain(`${ID}@1:published`);
    expect(ANNOUNCEMENTS.map((a) => a.id)).toContain(ID);
  });

  it('tells each change only to the people who can see it, and links the digest to notification settings', () => {
    // Re-pinned by the publishing of the weekly digest release (2026-10-06;
    // was: a copy forced to published): the release itself is published now.
    const ids = (role: ReleaseViewer['role'], permissions: ReleaseViewer['permissions'], modules: ModuleId[]) =>
      visibleReleases([release()], { role, permissions, enabledModules: modules })[0]?.entries.map((e) => e.id) ?? [];
    // Every member may turn the digest on, and every member can open a
    // warehouse's page from search.
    expect(ids('viewer', [], [])).toEqual(['weekly-digest-sent', 'weekly-digest-your-view', 'warehouse-page-opens']);
    expect(ids('manager', ['purchase_orders:manage'], ['purchase_orders'])).toContain('make-recurring-works');
    expect(ids('manager', ['purchase_orders:manage'], [])).not.toContain('make-recurring-works');
    expect(ids('staff', ['rentals:create'], ['rentals'])).toContain('rental-member-name');
    expect(ids('staff', ['rentals:read'], ['rentals'])).not.toContain('rental-member-name');
    const sent = release().entries.find((e) => e.id === 'weekly-digest-sent')!;
    expect(sent.link).toEqual({ href: '/dashboard/settings/notifications', label: 'Open notification settings' });
  });

  it('names the settings the way the page does', () => {
    const controls = readFileSync(
      resolve(__dirname, '../../components/settings/digest-controls.tsx'),
      'utf8',
    );
    expect(controls).toContain('Email me a weekly inventory digest');
    expect(controls).toContain("'Send preview now'");
    const sent = release().entries.find((e) => e.id === 'weekly-digest-sent')!;
    expect(sent.whatToDo).toContain('Email me a weekly inventory digest');
    expect(sent.whatToDo).toContain('Send preview now');
  });

  // Publish re-read (2026-10-06), each correction against the code and the
  // production checks.
  it('says only what shipped: never "again", no digest received, the cron time, the web-only Expected date, the calendar in any zone', () => {
    const r = release();
    const text = readerText(r).join(' ');
    // A warehouse's page (0008 dropped the column it selected, before the
    // page shipped) and Make recurring (its seed read failed from the first
    // commit) never worked before these fixes.
    expect(text).not.toMatch(/\bagain\b|as before/i);
    // The cron has not run since #326: what is sent, never what arrived.
    expect(text).not.toMatch(/\barriv|\breceived\b/i);
    expect(entry('weekly-digest-sent').whyItMatters).toContain('no weekly digest came');
    // The send time is the cron's, for every organization; the footer prints
    // it in the organization's zone.
    const vercel = JSON.parse(readFileSync(resolve(__dirname, '../../../vercel.json'), 'utf8')) as {
      crons: Array<{ path: string; schedule: string }>;
    };
    expect(vercel.crons.find((c) => c.path === '/api/cron/weekly-digest')?.schedule).toBe('0 14 * * 1');
    // Claims review (2026-10-06; was: "Monday morning in US time zones"):
    // 14:00 UTC is already Tuesday on Guam and the Northern Marianas, so the
    // places where it is Monday morning are named.
    expect(entry('weekly-digest-sent').howItAffectsYou).toContain(
      'it is sent each Monday at 14:00 UTC, Monday morning in the mainland US, Alaska and Hawaii,',
    );
    // Claims review (2026-10-06): Send preview worked before #326, so only
    // the WEEKLY digest was never sent.
    expect(entry('weekly-digest-sent').whatChanged).toContain('so no weekly digest was ever sent.');
    // Claims review (2026-10-06): owners, admins and managers read every
    // warehouse whatever the Team page lists for them, so the scope line
    // speaks of what a person can see, not where they work.
    expect(entry('weekly-digest-your-view').howItAffectsYou).toContain('If you can see only some warehouses');
    expect(entry('weekly-digest-your-view').howItAffectsYou).not.toContain('work in');
    // Claims review (2026-10-06): the list printed the right day for a list
    // over 800 orders, so the why says "could", as the what does.
    expect(entry('po-list-expected-date').whyItMatters).toBe(
      "The list could disagree with the purchase order's own page by a day.",
    );
    expect(entry('weekly-digest-sent').howItAffectsYou).toContain(
      'Its footer gives that day and time in your workspace time zone.',
    );
    // An item awaiting its first receipt, in the Items badge's word.
    const badge = readFileSync(resolve(__dirname, '../../components/inventory/stock-status-badge.tsx'), 'utf8');
    expect(badge).toContain("'Expected — awaiting first receipt'");
    expect(entry('weekly-digest-your-view').whatChanged).toContain(
      'an item marked Expected, still awaiting its first receipt, is not counted as low or out of stock',
    );
    // The page's own sections.
    const page = readFileSync(
      resolve(__dirname, '../../app/(dashboard)/dashboard/warehouses/[id]/page.tsx'),
      'utf8',
    );
    for (const heading of ['Address &amp; contact', 'Manager', 'Charters serviced']) {
      expect(page, heading).toContain(heading);
    }
    expect(entry('warehouse-page-opens').howItAffectsYou).toContain(
      'its address and contact, its manager and the charters it serves',
    );
    // #332 names every line Make recurring brings over.
    expect(entry('make-recurring-works').howItAffectsYou).toContain(
      'Each line names its item, rental and archived items included.',
    );
    // #334 (claims review, 2026-10-06): a destination the recurring form
    // cannot offer (a staging area, a deleted location) opens as none, with a
    // note, never a hidden destination the save would keep.
    const recurringPage = readFileSync(
      resolve(__dirname, '../../app/(dashboard)/dashboard/purchase-orders/recurring/page.tsx'),
      'utf8',
    );
    expect(recurringPage).toContain('sitesOnly: true');
    expect(entry('make-recurring-works').howItAffectsYou).toContain(
      'such as a staging area or a deleted location, the new one opens with no destination and a note saying where the purchase order went, so you choose one.',
    );
    // The mobile app's purchase order screens still print the day in the
    // phone's zone, so the Expected date is the web's.
    expect(entry('po-list-expected-date').title).toContain('on the web');
    expect(entry('po-list-expected-date').whatChanged).toMatch(/^On the web, in US time zones, /);
    expect(r.summary).toContain('the purchase orders list on the web');
    // The server placed today by UTC's date: tomorrow late in the day west of
    // UTC, yesterday early in the day east of it.
    expect(entry('calendar-today').whatChanged).toContain('could mark the wrong day as today');
    expect(entry('calendar-today').whatChanged).toContain('the date in UTC');
    // A profile can lack a name, and then the rental keeps the sent one.
    expect(entry('rental-member-name').whatChanged).toContain('still does when the profile has no name');
    expect(text).not.toMatch(/\bbook\b/i);
  });
});

// Items first paint (owner bug 2026-10-05, #328), with the dashboard's open
// purchase order count for a picked warehouse. PUBLISHED 2026-10-06 after the
// production check in Demo Co (5 of 5 hard refreshes painted one state, audit
// CONFIRMED). Web only: the mobile app's Items list draws its page once and
// the phone has no Shift Command card. Each entry is told to whoever can open
// the page it is about, as that page checks it.
describe('the Items first-paint release', () => {
  const ID = 'items-list-first-paint-2026-10';
  const release = () => RELEASES.find((r) => r.id === ID)!;
  const everyone: ReleaseViewer = {
    role: 'owner',
    permissions: [...PERMISSIONS],
    enabledModules: Object.keys(MODULE_REGISTRY) as ModuleId[],
  };

  // Re-pinned by docs/whats-new-dates-link-submit (2026-10-06; was: "...
  // below the drafts, slice 2's release and the weekly digest release, ..."):
  // no draft is left above it.
  it("is published at a real time after its production check, below the public link, dates fixes, PO-2, slice 2 and weekly digest releases, directly above the small fixes", () => {
    // Re-pinned by the B44 phone update draft (fix/b44-update-restart-prompt;
    // was: without it): dated after every release, it sits at the top, so
    // every position below it moves down by one, and it and slice 8's are the
    // drafts.
    // Re-pinned by the small fixes slice 8 draft (fix/small-fixes-8; was:
    // without it): dated after every release, it sits at the top, so every
    // position below it moves down by one, and it is the one draft.
    expect(release().status).toBe('published');
    expect(release().revision).toBe(1);
    // A whole minute after the production check of #328 ended (2026-10-05
    // 22:03Z): never the draft's placeholder date.
    expect(release().publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/);
    expect(Date.parse(release().publishedAt)).toBeGreaterThan(Date.parse('2026-10-05T22:03:00Z'));
    expect(Date.parse(release().publishedAt)).toBeLessThanOrEqual(Date.parse('2026-10-07T00:00:00Z'));
    const at = RELEASES.findIndex((r) => r.id === ID);
    // Re-pinned by the publishing of the weekly digest release (2026-10-06;
    // was: only drafts above it): published later, it sits directly above this
    // one, below the drafts, and is dated later.
    // Re-pinned by the dates fixes draft (2026-10-06; was: without it): a
    // draft dated later, at the top.
    // Re-pinned by the public link draft (fix/placed-cart-draft; was: without
    // it): a draft dated later still, at the top.
    // Re-pinned by returns RX-2 (2026-10-11; was: without it): a draft dated
    // later still, at the top.
    // Re-pinned by returns RX-3 (2026-10-11; was: without it): a draft dated
    // later still, at the top.
    // Re-pinned by returns RX-4 (2026-10-12; was: without it): a draft dated
    // later still, at the top.
    // Re-pinned by the return history hand-over fix (D-H1, 2026-10-12; was:
    // without it): a draft dated later still, at the top.
    // Re-pinned by Ungroup G1 (2026-10-12, rebased onto #354; was: without
    // it): its draft, dated later still, sits at the top above the return
    // history hand-over release.
    // Re-pinned by Group selected G2 (2026-10-12, rebased onto #351; was:
    // without it): its draft, dated later still, sits at the top above
    // Ungroup's draft.
    // Re-pinned by docs/whats-new-ungroup-follow-ups (2026-10-12; was: the list without it): the Ungroup follow-ups release is published after it, at the top.
    // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: the list without it): the pages-keep-groups-whole release is published after it, at the top.
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: the list without them): the three redesign releases and the parked ai-search-finds-every-item release (#367) are published after it, at the top.
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: the list without it): the unsubscribe-rack-question-fixes release is published after it, at the top.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: the list without it): the ended-session-group-page-fixes release is published after it, at the top.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: the list without it): the manage-order-items-and-app-fixes release is published after it, at the top.
    expect(RELEASES.slice(0, at).map((r) => r.id)).toEqual([
      'mobile-app-asks-before-restarting',
      'small-fixes-8-2026-10',
      'manage-order-items-and-app-fixes-2026-10',
      'ended-session-group-page-fixes-2026-10',
      'unsubscribe-rack-question-fixes-2026-10',
      'redesign-2026-10',
      'redesign-mobile-app-2026-10',
      'redesign-web-fixes-2026-10',
      'ai-search-finds-every-item-2026-10',
      'pages-keep-groups-whole-2026-10',
      'ungroup-follow-ups-2026-10',
      'group-selected-2026-10',
      'ungroup-2026-10',
      'returns-history-hand-over-2026-10',
      'returns-close-rest-2026-10',
      'returns-requester-exchange-2026-10',
      'returns-exchange-2026-10',
      'public-link-sent-request-2026-10',
      'dates-fixes-2026-10',
      'order-submit-once-2026-10',
      'order-partial-approval-held-2026-10',
      'weekly-digest-and-fixes-2026-10',
    ]);
    // Re-pinned by the publishing of the slice 2 release (2026-10-06; was:
    // draft x4, published x1): the partial-approval release is published, in
    // the same place, so three drafts sit above two published releases.
    // Re-pinned by docs/whats-new-dates-link-submit (2026-10-06; was: draft
    // x3, published x2): the public link, dates fixes and PO-2 releases are
    // published, in the same places, so all five above it are published.
    // Re-pinned by returns RX-2 (2026-10-11; was: published x5): RX-2's draft
    // at the top, then the same five, published.
    // Re-pinned by docs/whats-new-returns-exchange (2026-10-11; was: draft,
    // then published x5): RX-2's release is published, so all six are.
    // Re-pinned by returns RX-3 (2026-10-11; was: published x6): RX-3's
    // draft at the top, then the same six, published.
    // Re-pinned by docs/whats-new-returns-requester (2026-10-12; was: draft,
    // then published x6): RX-3's release is published, so all seven are.
    // Re-pinned by returns RX-4 (2026-10-12; was: published x7): RX-4's
    // draft at the top, then the same seven, published.
    // Re-pinned by docs/whats-new-returns-close-rest (2026-10-12; was: draft,
    // then published x7): RX-4's release is published, so all eight are.
    // Re-pinned by the return history hand-over fix (D-H1, 2026-10-12; was:
    // published x8): its draft at the top, then the same eight, published.
    // Re-pinned by docs/whats-new-return-history-hand-over (2026-10-12; was:
    // draft, then published x8): its release is published, so all nine are.
    // Re-pinned by Ungroup G1 (2026-10-12, rebased onto #354; was:
    // published x9): Ungroup's draft at the top, then the same nine,
    // published.
    // Re-pinned by Group selected G2 (2026-10-12, rebased onto #351; was:
    // Ungroup's draft at the top, then published): Group selected's draft
    // above it, then the same, published.
    // Re-pinned by the What's New publish of ungroup-2026-10 and
    // group-selected-2026-10 (2026-10-12; was: two drafts at the top, then
    // published): both are published, in the same places, so every
    // release above this one is published.
    expect(RELEASES.slice(0, at).map((r) => r.status)).toEqual([
      'draft',
      'draft',
      // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: the statuses without it): the manage-order-items-and-app-fixes release is published at the top, so one more release above this one is published.
      'published',
      // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: the statuses without it): the ended-session-group-page-fixes release is published at the top, so one more release above this one is published.
      'published',
      // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: the statuses without it): the unsubscribe-rack-question-fixes release is published at the top, so one more release above this one is published.
      'published',
      // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: the statuses without them): the three redesign releases and the parked ai-search-finds-every-item release (#367) are published at the top, so four more releases above this one are published.
      'published',
      'published',
      'published',
      'published',
      // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: the statuses without it): the pages-keep-groups-whole release is published at the top, so one more release above this one is published.
      'published',
      // Re-pinned by docs/whats-new-ungroup-follow-ups (2026-10-12): the Ungroup follow-ups release is published at the top and reaches this reader, so it is read or seen here too and the order this test checks holds.
      'published',
      'published',
      'published',
      'published',
      'published',
      'published',
      'published',
      'published',
      'published',
      'published',
      'published',
      'published',
    ]);
    for (const r of RELEASES.slice(0, at)) {
      expect(Date.parse(r.publishedAt), r.id).toBeGreaterThan(Date.parse(release().publishedAt));
    }
    expect(RELEASES[at + 1]?.id).toBe('small-fixes-2026-10');
    for (const r of RELEASES.slice(at + 1)) {
      expect(Date.parse(release().publishedAt), r.id).toBeGreaterThan(Date.parse(r.publishedAt));
    }
    expect(visibleReleases(RELEASES, everyone).map((r) => r.id)).toContain(ID);
  });

  it('tells each entry to whoever can open its page: Items to items:read with Items on, the dashboard count to purchase_orders:read with Purchase orders on', () => {
    const r = release();
    expect(r.audience).toBeUndefined();
    expect(r.entries.map((e) => e.id)).toEqual([
      'items-list-first-paint',
      'items-active-after-auto-archived',
      'dashboard-open-po-count-warehouse',
    ]);
    const items = { anyPermission: ['items:read'], modules: ['inventory'] };
    expect(r.entries[0]!.audience).toEqual(items);
    expect(r.entries[1]!.audience).toEqual(items);
    expect(r.entries[2]!.audience).toEqual({
      anyPermission: ['purchase_orders:read'],
      modules: ['purchase_orders'],
    });
    const idsFor = (
      role: ReleaseViewer['role'],
      permissions: ReleaseViewer['permissions'],
      modules: ModuleId[],
    ) =>
      visibleReleases([r], { role, permissions, enabledModules: modules })[0]?.entries.map(
        (e) => e.id,
      ) ?? [];
    const itemEntries = ['items-list-first-paint', 'items-active-after-auto-archived'];
    expect(idsFor('manager', ['items:read'], ['inventory'])).toEqual(itemEntries);
    expect(idsFor('staff', ['items:read'], ['inventory'])).toEqual(itemEntries);
    expect(idsFor('viewer', ['purchase_orders:read'], ['purchase_orders'])).toEqual([
      'dashboard-open-po-count-warehouse',
    ]);
    expect(
      idsFor('manager', ['items:read', 'purchase_orders:read'], ['inventory', 'purchase_orders']),
    ).toHaveLength(3);
    expect(idsFor('staff', ['orders:request'], ['inventory', 'orders'])).toEqual([]);
    expect(idsFor('owner', [...PERMISSIONS], [])).toEqual([]);
  });

  it('names the dashboard line by its words and counts by the destination, the rule the purchase order list uses', () => {
    const entry = release().entries.find((e) => e.id === 'dashboard-open-po-count-warehouse')!;
    const card = readFileSync(
      resolve(__dirname, '../../components/dashboard/widgets/shift-command.tsx'),
      'utf8',
    );
    expect(card).toContain('label="Open purchase orders"');
    expect(entry.whatChanged).toContain('Open purchase orders');
    const service = readFileSync(resolve(__dirname, '../../server/services/movements.ts'), 'utf8');
    expect(service).toContain("posQ = posQ.eq('destination.warehouse_id', options.warehouseId);");
    expect(service).not.toContain("posQ = posQ.eq('warehouse_id'");
    expect(entry.howItAffectsYou).toContain('going to a location in that warehouse');
  });

  it('says it plainly: on the web, nothing was ever missing, no timing or number nobody measured, never "book"', () => {
    const r = release();
    const text = readerText(r).join(' ');
    expect(r.summary).toMatch(/^On the web, /);
    for (const e of r.entries) expect(e.whatChanged, e.id).toMatch(/^On the web, /);
    expect(r.summary).toContain('Nothing was ever missing');
    expect(text).toContain('moved to the next page');
    expect(text).toContain('the rows that moved were on the next page');
    expect(text).not.toMatch(/\d+(?:\.\d+)? ?(?:ms|seconds?|%)|half a second|faster|quicker/i);
    expect(text).not.toMatch(/\d{2,}/);
    expect(text).not.toMatch(/\bbook\b/i);
  });

  it('quotes the words the Items list shows', () => {
    const text = readerText(release()).join(' ');
    const table = readFileSync(
      resolve(__dirname, '../../components/inventory/inventory-table.tsx'),
      'utf8',
    );
    for (const words of ['Refresh to see', 'No items match your filters.', 'Auto-archived only']) {
      expect(table, words).toContain(words);
    }
    expect(text).toContain('Refresh to see more');
    expect(text).toContain('No items match your filters');
    expect(text).toContain('Auto-archived only');
    expect(text).toContain('No items yet');
  });
});

/**
 * Small fixes slice 2 (migration 0395, L86): a partly approved order's
 * notification and approval email say what is held. Held as a DRAFT until
 * 0395 is pushed and the web deploy with the email variant is live (the push
 * text comes from the database: no phone update). Pinned by id, never by
 * index. The publishing follow-up sets 'published' and the real publishedAt,
 * re-reads the words against what shipped, and flips the first pin here.
 */
/**
 * Small fixes slice 2 (migration 0395, #329) was held as a DRAFT until 0395
 * was pushed (2026-10-05 22:42:30Z), the web deploy was live (web build
 * e5f58d5f739e), phones launched the over-the-air update carrying the phone
 * half (OTA group 8a41e9eb, iOS update 01a10e3e: 2 launches, 0 failed) and
 * the Demo Co production walk (69 checks passed) was confirmed by its
 * independent audit (2026-10-06 ~03:50Z). This follow-up publishes it, below
 * the drafts and directly above the weekly digest release, and re-reads its
 * words against what shipped. Pinned by id, never by index.
 *
 * Re-pinned by the publishing of the slice 2 release (2026-10-06; was: "a
 * partly approved order says what is held (small fixes slice 2) is held as a
 * draft"): the release is published, and its words say "reserved".
 */
describe('a partly approved order says what is reserved (small fixes slice 2) is published', () => {
  const ID = 'order-partial-approval-held-2026-10';
  const release = () => RELEASES.find((r) => r.id === ID)!;
  const entryById = (id: string) => release().entries.find((e) => e.id === id)!;
  const everyone: ReleaseViewer = {
    role: 'owner',
    permissions: [...PERMISSIONS],
    enabledModules: Object.keys(MODULE_REGISTRY) as ModuleId[],
  };

  // Re-pinned by the publishing of the slice 2 release (2026-10-06; was: "is
  // a draft, so no feed carries it, and preparing it changes nothing a client
  // can observe": a draft, in no feed, no legacy list and no fingerprint).
  it('is published after 0395, the web deploy, the phone update, the Demo Co walk and its audit, so every feed it reaches carries it', () => {
    expect(release()).toBeDefined();
    expect(release().status).toBe('published');
    expect(release().revision).toBe(1);
    expect(visibleReleases(RELEASES, everyone).map((r) => r.id)).toContain(ID);
    const list = buildReleaseList(RELEASES, everyone, [], null);
    expect(list.releases.map((r) => r.id)).toContain(ID);
    // The newest published release, so it is the notice for whoever it
    // reaches: an owner with every module, and a requester. A member with no
    // permission and no module is not told it, so their notice stays the
    // weekly digest release's.
    // Re-pinned by docs/whats-new-dates-link-submit (2026-10-06; was: this
    // one for the owner and the requester, the weekly digest release's for
    // the member): the public link, dates fixes and PO-2 releases are
    // published after it. The owner is told all three, the public link
    // release first, and this one once they are read. Every member is told
    // the dates fixes release (the digest's send time), so it is the
    // requester's and the member's notice; a requester is told PO-2's next
    // and this one after that, and the member, whom this one never reaches,
    // the weekly digest release.
    const readNow = (id: string) => ({
      release_id: id,
      revision: 1,
      dismissed_at: null,
      opened_at: '2026-10-06T13:00:00Z',
      read_at: '2026-10-06T13:00:00Z',
    });
    // Re-pinned by docs/whats-new-returns-exchange (2026-10-11; was: the
    // public link release first for the owner, and this one once the three
    // are read): returns RX-2's release, published later, is the owner's
    // notice, and this one comes once it is read too. RX-2's release reaches
    // neither the requester nor the member, so their lines are unchanged.
    // Re-pinned by docs/whats-new-returns-requester (2026-10-12; was: RX-2's
    // release the owner's notice, the dates fixes release the requester's,
    // and this one once the newer ones are read): returns RX-3's release,
    // published later still, is the owner's notice and the requester's (its
    // busy and pickup entries reach them), and this one comes once it is
    // read too. It reaches no member without a permission, so the member's
    // lines are unchanged. Claim kept: a requester is told the dates fixes
    // and PO-2 releases, then this one.
    // Re-pinned by docs/whats-new-returns-close-rest (2026-10-12; was: RX-3's
    // release the owner's notice, and this one once the newer ones are read):
    // returns RX-4's release, published later still, is the owner's notice,
    // and this one comes once it is read too. It reaches neither this
    // requester (Returns is off for them) nor the member, so their lines are
    // unchanged. Claim kept: a requester is told the dates fixes and PO-2
    // releases, then this one.
    // Re-pinned by docs/whats-new-return-history-hand-over (2026-10-12; was:
    // RX-4's release the owner's notice, and this one once the newer ones
    // are read): the return history hand-over release, published later
    // still, is the owner's notice, and this one comes once it is read too.
    // It reaches neither this requester nor the member (neither can open
    // Returns), so their lines are unchanged. Claim kept: a requester is told
    // the dates fixes and PO-2 releases, then this one.
    // Re-pinned by the What's New publish of ungroup-2026-10 and
    // group-selected-2026-10 (2026-10-12): was: from the hand-over release
    // down): Group selected's and Ungroup's releases are newer still and reach
    // that owner, so they are read too.
    const newerRead = [
      // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: the reads without them): the three redesign releases and the parked ai-search-finds-every-item release (#367) are published at the top and reach this reader, so they are read here too and the order this test checks holds. The redesign releases reach the requester and the member below too, so their first notices are re-pinned below; the ai-search-finds-every-item release reaches neither.
      // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: the reads without it): the unsubscribe-rack-question-fixes release is published at the top and reaches this reader, so it is read here too and the order this test checks holds. It reaches the requester and the member below too, so their first notices are re-pinned below.
      // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: the reads without it): the ended-session-group-page-fixes release is published at the top and reaches this reader, so it is read here too and the order this test checks holds. It reaches the requester and the member below too, so their first notices are re-pinned below.
      // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: the reads without it): the manage-order-items-and-app-fixes release is published at the top and reaches this reader, so it is read here too and the order this test checks holds. It reaches the requester and the member below too, so their first notices are re-pinned below.
      readNow('manage-order-items-and-app-fixes-2026-10'),
      readNow('ended-session-group-page-fixes-2026-10'),
      readNow('unsubscribe-rack-question-fixes-2026-10'),
      readNow('redesign-2026-10'),
      readNow('redesign-mobile-app-2026-10'),
      readNow('redesign-web-fixes-2026-10'),
      readNow('ai-search-finds-every-item-2026-10'),
      // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: the reads without it): the pages-keep-groups-whole release is published at the top and reaches this reader, so it is read here too and the order this test checks holds; it reaches neither the requester nor the member below, so their lines are unchanged.
      readNow('pages-keep-groups-whole-2026-10'),
      // Re-pinned by docs/whats-new-ungroup-follow-ups (2026-10-12): the Ungroup follow-ups release is published at the top and reaches this reader, so it is read or seen here too and the order this test checks holds.
      readNow('ungroup-follow-ups-2026-10'),
      readNow('group-selected-2026-10'),
      readNow('ungroup-2026-10'),
      readNow('returns-history-hand-over-2026-10'),
      readNow('returns-close-rest-2026-10'),
      readNow('returns-requester-exchange-2026-10'),
      readNow('returns-exchange-2026-10'),
      readNow('public-link-sent-request-2026-10'),
      readNow('dates-fixes-2026-10'),
      readNow('order-submit-once-2026-10'),
    ];
    // Re-pinned by the What's New publish of ungroup-2026-10 and
    // group-selected-2026-10 (2026-10-12): was returns-history-hand-over-2026-10.
    // Group selected's release is published after it (a minute after
    // Ungroup's) and reaches every member, so this reader (an owner with
    // every module) is told it first.
    // Re-pinned by docs/whats-new-ungroup-follow-ups (2026-10-12; was: group-selected-2026-10): the Ungroup follow-ups release is published after it, at the top and reaches this reader.
    // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: ungroup-follow-ups-2026-10): the pages-keep-groups-whole release is published after it, at the top, and reaches this reader.
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: pages-keep-groups-whole-2026-10): the parked ai-search-finds-every-item release (#367) and the three redesign releases are published after it, at the top, and redesign-2026-10, the newest, reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: redesign-2026-10): the unsubscribe-rack-question-fixes release is published after it, at the top, and reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: unsubscribe-rack-question-fixes-2026-10): the ended-session-group-page-fixes release is published after it, at the top, and reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: ended-session-group-page-fixes-2026-10): the manage-order-items-and-app-fixes release is published after it, at the top, and reaches every member, this reader included.
    expect(list.latestUnread?.id).toBe('manage-order-items-and-app-fixes-2026-10');
    expect(buildReleaseList(RELEASES, everyone, newerRead, null).latestUnread?.id).toBe(ID);
    const requester: ReleaseViewer = { role: 'viewer', permissions: ['orders:request'], enabledModules: ['orders'] };
    expect(visibleReleases(RELEASES, requester).map((r) => r.id)).not.toContain('public-link-sent-request-2026-10');
    expect(visibleReleases(RELEASES, requester).map((r) => r.id)).not.toContain('returns-exchange-2026-10');
    expect(visibleReleases(RELEASES, requester).map((r) => r.id)).not.toContain('returns-close-rest-2026-10');
    expect(visibleReleases(RELEASES, requester).map((r) => r.id)).not.toContain('returns-history-hand-over-2026-10');
    // Re-pinned by the What's New publish of ungroup-2026-10 and
    // group-selected-2026-10 (2026-10-12; was: RX-3's release first for a
    // requester): Group selected's release reaches every member (its list
    // entries have no audience), so a requester is told it first, and the
    // rest as before once it is read. Claim kept: the same order after it.
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: group-selected-2026-10 first for a requester,
    // and the reads below without the redesign releases): the three redesign releases reach every member, so a
    // requester is told redesign-2026-10 first, and Group selected's once the three are read. Claim kept: the
    // same order after it.
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: redesign-2026-10 with nothing read): the unsubscribe-rack-question-fixes release, published at the top, reaches every member, so this reader is told it first and redesign-2026-10 once it is read; the reads and seen sets below include it.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: unsubscribe-rack-question-fixes-2026-10 with nothing read): the ended-session-group-page-fixes release, published at the top, reaches every member, so this reader is told it first and the unsubscribe-rack-question-fixes release once it is read. Claim kept: the same order after them.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: ended-session-group-page-fixes-2026-10 with nothing read): the manage-order-items-and-app-fixes release, published at the top, reaches every member, so this reader is told it first and the ended-session-group-page-fixes release once it is read. Claim kept: the same order after them.
    expect(buildReleaseList(RELEASES, requester, [], null).latestUnread?.id).toBe(
      'manage-order-items-and-app-fixes-2026-10',
    );
    expect(buildReleaseList(RELEASES, requester, [latestRead()], null).latestUnread?.id).toBe(
      'ended-session-group-page-fixes-2026-10',
    );
    expect(
      buildReleaseList(RELEASES, requester, [latestRead(), topRead()], null).latestUnread?.id,
    ).toBe('unsubscribe-rack-question-fixes-2026-10');
    expect(
      buildReleaseList(RELEASES, requester, [latestRead(), topRead(), newestRead()], null)
        .latestUnread?.id,
    ).toBe('redesign-2026-10');
    const redesignRead = redesignReads();
    expect(buildReleaseList(RELEASES, requester, redesignRead, null).latestUnread?.id).toBe(
      'group-selected-2026-10',
    );
    const gsRead = readNow('group-selected-2026-10');
    expect(
      buildReleaseList(RELEASES, requester, [...redesignRead, gsRead], null).latestUnread?.id,
    ).toBe('returns-requester-exchange-2026-10');
    const rx3Read = readNow('returns-requester-exchange-2026-10');
    expect(
      buildReleaseList(RELEASES, requester, [...redesignRead, gsRead, rx3Read], null).latestUnread
        ?.id,
    ).toBe('dates-fixes-2026-10');
    expect(
      buildReleaseList(
        RELEASES,
        requester,
        [...redesignRead, gsRead, rx3Read, readNow('dates-fixes-2026-10')],
        null,
      ).latestUnread?.id,
    ).toBe('order-submit-once-2026-10');
    expect(buildReleaseList(RELEASES, requester, newerRead, null).latestUnread?.id).toBe(ID);
    const member: ReleaseViewer = { role: 'viewer', permissions: [], enabledModules: [] };
    expect(visibleReleases(RELEASES, member).map((r) => r.id)).not.toContain(ID);
    // Re-pinned by the What's New publish of ungroup-2026-10 and
    // group-selected-2026-10 (2026-10-12; was: dates-fixes-2026-10 with
    // nothing read): Group selected's release reaches every member, so this
    // member is told it first, and the dates fixes release once it is read.
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: group-selected-2026-10 first, and the dates fixes
    // release once it was read): the three redesign releases reach every member, so this member is told
    // redesign-2026-10 first, Group selected's once the three are read, and the dates fixes release once that is
    // read too.
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: redesign-2026-10 with nothing read): the unsubscribe-rack-question-fixes release, published at the top, reaches every member, so this reader is told it first and redesign-2026-10 once it is read; the reads and seen sets below include it.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: unsubscribe-rack-question-fixes-2026-10 with nothing read): the ended-session-group-page-fixes release, published at the top, reaches every member, so this reader is told it first and the unsubscribe-rack-question-fixes release once it is read. Claim kept: the same order after them.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: ended-session-group-page-fixes-2026-10 with nothing read): the manage-order-items-and-app-fixes release, published at the top, reaches every member, so this reader is told it first and the ended-session-group-page-fixes release once it is read. Claim kept: the same order after them.
    expect(buildReleaseList(RELEASES, member, [], null).latestUnread?.id).toBe(
      'manage-order-items-and-app-fixes-2026-10',
    );
    expect(buildReleaseList(RELEASES, member, [latestRead()], null).latestUnread?.id).toBe(
      'ended-session-group-page-fixes-2026-10',
    );
    expect(
      buildReleaseList(RELEASES, member, [latestRead(), topRead()], null).latestUnread?.id,
    ).toBe('unsubscribe-rack-question-fixes-2026-10');
    expect(
      buildReleaseList(RELEASES, member, [latestRead(), topRead(), newestRead()], null).latestUnread
        ?.id,
    ).toBe('redesign-2026-10');
    expect(buildReleaseList(RELEASES, member, redesignRead, null).latestUnread?.id).toBe(
      'group-selected-2026-10',
    );
    expect(
      buildReleaseList(RELEASES, member, [...redesignRead, readNow('group-selected-2026-10')], null)
        .latestUnread?.id,
    ).toBe('dates-fixes-2026-10');
    expect(buildReleaseList(RELEASES, member, newerRead, null).latestUnread?.id).toBe(
      'weekly-digest-and-fixes-2026-10',
    );
    // An old phone build lists at most three unread releases, newest first,
    // showing only the title and the summary (no link: no entry has one).
    // Re-pinned by docs/whats-new-dates-link-submit (2026-10-06; was: this
    // one, the weekly digest release and the Items first-paint release): the
    // public link, dates fixes and PO-2 releases come first, and this one
    // leads the three once they are seen.
    // Re-pinned by docs/whats-new-returns-exchange (2026-10-11; was: the
    // public link, dates fixes and PO-2 releases, and this one first once
    // they are seen): returns RX-2's release, published later, leads, and
    // this one leads once the four are seen.
    // Re-pinned by docs/whats-new-returns-requester (2026-10-12; was: RX-2's,
    // the public link and the dates fixes releases, and this one first once
    // the four are seen): returns RX-3's release, published later still,
    // leads, and this one leads once the five are seen.
    // Re-pinned by docs/whats-new-returns-close-rest (2026-10-12; was: RX-3's,
    // RX-2's and the public link releases, and this one first once the five
    // are seen): returns RX-4's release, published later still, leads, and
    // this one leads once the six are seen.
    // Re-pinned by docs/whats-new-return-history-hand-over (2026-10-12; was:
    // RX-4's, RX-3's and RX-2's releases, and this one first once the six
    // are seen): the return history hand-over release, published later
    // still, leads, and this one leads once the seven are seen.
    // Re-pinned by the What's New publish of ungroup-2026-10 and
    // group-selected-2026-10 (2026-10-12; was: the hand-over, RX-4's and
    // RX-3's releases, and this one first once the seven are seen): Group
    // selected's and Ungroup's releases, published later still, lead, and
    // this one leads once the nine are seen.
    // Re-pinned by docs/whats-new-ungroup-follow-ups (2026-10-12): the Ungroup follow-ups release is published at the top and reaches this reader, so it is read or seen here too and the order this test checks holds.
    // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: the Ungroup follow-ups, Group selected and Ungroup releases, and this one first once ten are seen): the pages-keep-groups-whole release is published at the top and reaches this reader, so it leads the three, Ungroup's drops out of them, and it is seen in the set below too.
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: the pages-keep-groups-whole, Ungroup follow-ups and Group selected releases with nothing seen, and this one first once eleven are seen): the three redesign releases are published at the top and reach this reader, so they are the three with nothing seen; the same three as before lead once the four newer releases are seen, and this one first once fifteen are seen.
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: the three redesign releases with nothing seen): the unsubscribe-rack-question-fixes release, published at the top, reaches this reader, so it leads with nothing seen; the three redesign releases are the three once it is seen, and the seen sets below include it.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: the unsubscribe-rack-question-fixes release and the first two redesign releases with nothing seen): the ended-session-group-page-fixes release, published at the top, reaches every member, so it leads with nothing seen; the same three as before are the three once it is seen, and the seen sets below include it.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: the ended-session-group-page-fixes and unsubscribe-rack-question-fixes releases and the first redesign release with nothing seen): the manage-order-items-and-app-fixes release, published at the top, reaches every member, so it leads with nothing seen; the same three as before are the three once it is seen, and the seen sets below include it.
    expect(legacyAnnouncementsFor(RELEASES, everyone, {}).map((a) => a.id)).toEqual([
      LATEST_ID,
      TOP_ID,
      NEWEST_ID,
    ]);
    expect(legacyAnnouncementsFor(RELEASES, everyone, latestSeen()).map((a) => a.id)).toEqual([
      TOP_ID,
      NEWEST_ID,
      REDESIGN_IDS[0],
    ]);
    expect(
      legacyAnnouncementsFor(RELEASES, everyone, { ...latestSeen(), ...topSeen() }).map(
        (a) => a.id,
      ),
    ).toEqual([NEWEST_ID, ...REDESIGN_IDS.slice(0, 2)]);
    expect(
      legacyAnnouncementsFor(RELEASES, everyone, {
        ...latestSeen(),
        ...topSeen(),
        ...newestSeen(),
      }).map((a) => a.id),
    ).toEqual(REDESIGN_IDS);
    const fourNewerSeen = { ...redesignSeen(), 'ai-search-finds-every-item-2026-10': true };
    expect(legacyAnnouncementsFor(RELEASES, everyone, fourNewerSeen).map((a) => a.id)).toEqual([
      'pages-keep-groups-whole-2026-10',
      'ungroup-follow-ups-2026-10',
      'group-selected-2026-10',
    ]);
    const newerSeen = {
      ...fourNewerSeen,
      'pages-keep-groups-whole-2026-10': true,
      'ungroup-follow-ups-2026-10': true,
      'group-selected-2026-10': true,
      'ungroup-2026-10': true,
      'returns-history-hand-over-2026-10': true,
      'returns-close-rest-2026-10': true,
      'returns-requester-exchange-2026-10': true,
      'returns-exchange-2026-10': true,
      'public-link-sent-request-2026-10': true,
      'dates-fixes-2026-10': true,
      'order-submit-once-2026-10': true,
    };
    expect(legacyAnnouncementsFor(RELEASES, everyone, newerSeen).map((a) => a.id)).toEqual([
      ID,
      'weekly-digest-and-fixes-2026-10',
      'items-list-first-paint-2026-10',
    ]);
    expect(legacyAnnouncementsFor(RELEASES, everyone, newerSeen)[0]).toEqual({
      id: ID,
      date: '2026-10-06',
      title: release().title,
      body: release().summary,
    });
    // Publishing it changes what clients observe.
    expect(registryFingerprint(RELEASES)).toContain(`${ID}@1:published`);
    expect(registryFingerprint(RELEASES)).not.toBe(registryFingerprint(RELEASES.filter((r) => r.id !== ID)));
    expect(ANNOUNCEMENTS.map((a) => a.id)).toContain(ID);
    // A real time on a whole minute, after the walk's independent audit
    // confirmed it (2026-10-06 ~03:50Z): never the draft's placeholder date
    // (2026-10-10T17:10Z).
    expect(release().publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/);
    expect(Date.parse(release().publishedAt)).toBeGreaterThan(Date.parse('2026-10-06T03:50:00Z'));
    expect(Date.parse(release().publishedAt)).toBeLessThanOrEqual(Date.parse('2026-10-07T00:00:00Z'));
  });

  // Re-pinned by the publishing of the slice 2 release (2026-10-06; was: "sits
  // among the drafts above every published release, dated after every
  // published release and before the drafts above it"): published, it stays
  // where it was, now the newest published release, below the three drafts.
  // Re-pinned by docs/whats-new-dates-link-submit (2026-10-06; was: "sits
  // below the drafts and directly above the weekly digest release, the newest
  // published release, dated after every release below it and before the
  // drafts above it"): the three releases above it are published now, later.
  it('sits below the public link, dates fixes and PO-2 releases (published later) and directly above the weekly digest release, dated after every release below it and before the ones above it', () => {
    // Re-pinned by the B44 phone update draft (fix/b44-update-restart-prompt;
    // was: without it): dated after every release, it sits at the top, so
    // every position below it moves down by one, and it and slice 8's are the
    // drafts.
    // Re-pinned by the small fixes slice 8 draft (fix/small-fixes-8; was:
    // without it): dated after every release, it sits at the top, so every
    // position below it moves down by one, and it is the one draft.
    const at = RELEASES.findIndex((r) => r.id === ID);
    expect(at).toBeGreaterThanOrEqual(0);
    // Re-pinned by returns RX-2 (2026-10-11; was: without it): RX-2's draft,
    // dated later, sits at the top, above the three published releases.
    // Re-pinned by returns RX-3 (2026-10-11; was: without it): RX-3's draft,
    // dated later still, sits at the top, above RX-2's release.
    // Re-pinned by returns RX-4 (2026-10-12; was: without it): RX-4's draft,
    // dated later still, sits at the top, above RX-3's release.
    // Re-pinned by the return history hand-over fix (D-H1, 2026-10-12; was:
    // without it): its draft, dated later still, sits at the top, above
    // RX-4's release.
    // Re-pinned by Ungroup G1 (2026-10-12, rebased onto #354; was: without
    // it): its draft, dated later still, sits at the top, above the return
    // history hand-over release.
    // Re-pinned by Group selected G2 (2026-10-12, rebased onto #351; was:
    // without it): its draft, dated later still, sits at the top above
    // Ungroup's draft.
    // Re-pinned by docs/whats-new-ungroup-follow-ups (2026-10-12; was: the list without it): the Ungroup follow-ups release is published after it, at the top.
    // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: the list without it): the pages-keep-groups-whole release is published after it, at the top.
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: the list without them): the three redesign releases and the parked ai-search-finds-every-item release (#367) are published after it, at the top.
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: the list without it): the unsubscribe-rack-question-fixes release is published after it, at the top.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: the list without it): the ended-session-group-page-fixes release is published after it, at the top.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: the list without it): the manage-order-items-and-app-fixes release is published after it, at the top.
    expect(RELEASES.slice(0, at).map((r) => r.id)).toEqual([
      'mobile-app-asks-before-restarting',
      'small-fixes-8-2026-10',
      'manage-order-items-and-app-fixes-2026-10',
      'ended-session-group-page-fixes-2026-10',
      'unsubscribe-rack-question-fixes-2026-10',
      'redesign-2026-10',
      'redesign-mobile-app-2026-10',
      'redesign-web-fixes-2026-10',
      'ai-search-finds-every-item-2026-10',
      'pages-keep-groups-whole-2026-10',
      'ungroup-follow-ups-2026-10',
      'group-selected-2026-10',
      'ungroup-2026-10',
      'returns-history-hand-over-2026-10',
      'returns-close-rest-2026-10',
      'returns-requester-exchange-2026-10',
      'returns-exchange-2026-10',
      'public-link-sent-request-2026-10',
      'dates-fixes-2026-10',
      'order-submit-once-2026-10',
    ]);
    // Re-pinned by docs/whats-new-dates-link-submit (2026-10-06; was: every
    // release above it a draft, and this one the newest published release):
    // the three above it are published, the public link release the newest,
    // and no draft is left.
    // Re-pinned by returns RX-2 (2026-10-11; was: every release above it
    // published, and no draft): RX-2's draft is the only draft, at the top;
    // claim kept: the three published above it, the public link the newest.
    // Re-pinned by docs/whats-new-returns-exchange (2026-10-11; was: RX-2's
    // draft at the top, and the public link release the newest published):
    // RX-2's release is published, in the same place, the newest, and no
    // draft is left. Claim kept: every release above this one is published.
    // Re-pinned by returns RX-3 (2026-10-11; was: slice(0, at) all published
    // and no draft): RX-3's draft is the only draft, at the top. Claim kept:
    // every release between it and this one is published, RX-2's the newest.
    // Re-pinned by docs/whats-new-returns-requester (2026-10-12; was:
    // slice(1, at) published, RX-2's the newest, RX-3's draft the only
    // draft): RX-3's release is published, in the same place, the newest, and
    // no draft is left. Claim kept: every release above this one is published.
    // Re-pinned by returns RX-4 (2026-10-12; was: slice(0, at) all published
    // and no draft): RX-4's draft is the only draft, at the top. Claim kept:
    // every release between it and this one is published, RX-3's the newest.
    // Re-pinned by docs/whats-new-returns-close-rest (2026-10-12; was:
    // slice(1, at) published, RX-3's the newest, RX-4's draft the only
    // draft): RX-4's release is published, in the same place, the newest, and
    // no draft is left. Claim kept: every release above this one is published.
    // Re-pinned by the return history hand-over fix (D-H1, 2026-10-12; was:
    // slice(0, at) all published and no draft): its draft is the only draft,
    // at the top. Claim kept: every release between it and this one is
    // published, RX-4's the newest.
    // Re-pinned by docs/whats-new-return-history-hand-over (2026-10-12; was:
    // slice(1, at) published, RX-4's the newest, its draft the only draft):
    // its release is published, in the same place, the newest, and no draft
    // is left. Claim kept: every release above this one is published.
    // Re-pinned by Ungroup G1 (2026-10-12, rebased onto #354; was:
    // slice(0, at) all published and no draft): Ungroup's draft is the only
    // draft, at the top. Claim kept: every release between it and this one
    // is published, the return history hand-over release the newest.
    // Re-pinned by Group selected G2 (2026-10-12, rebased onto #351; was:
    // slice(1, at) published, Ungroup's draft the only draft): Group
    // selected's draft above it, so slice(2, at) is published and both are
    // drafts.
    // Re-pinned by the What's New publish of ungroup-2026-10 and
    // group-selected-2026-10 (2026-10-12; was: slice(2, at) published, the
    // hand-over release the newest published): both are published, in the
    // same places, so every release above this one is published, Group
    // selected's the newest.
    expect(RELEASES[1]?.id).toBe('small-fixes-8-2026-10');
    expect(RELEASES[1]?.status).toBe('draft');
    expect(RELEASES.slice(2, at).every((r) => r.status === 'published')).toBe(true);
    // Re-pinned by docs/whats-new-ungroup-follow-ups (2026-10-12; was: group-selected-2026-10): the Ungroup follow-ups release is published after it, at the top and reaches this reader.
    // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: ungroup-follow-ups-2026-10): the pages-keep-groups-whole release is published after it, at the top, the newest published release.
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: pages-keep-groups-whole-2026-10): the three redesign releases and the parked ai-search-finds-every-item release (#367) are published after it, at the top; redesign-2026-10 is the newest published release.
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: redesign-2026-10): the unsubscribe-rack-question-fixes release is published after it, at the top, the newest published release.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: unsubscribe-rack-question-fixes-2026-10): the ended-session-group-page-fixes release is published after it, at the top, the newest published release.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: ended-session-group-page-fixes-2026-10): the manage-order-items-and-app-fixes release is published after it, at the top, the newest published release.
    expect(RELEASES.find((r) => r.status === 'published')?.id).toBe(
      'manage-order-items-and-app-fixes-2026-10',
    );
    // Re-pinned by the What's New publish of ungroup-2026-10 and
    // group-selected-2026-10 (2026-10-12; was: those two drafts): both are
    // published, so no draft is left.
    expect(RELEASES.filter((r) => r.status === 'draft').map((r) => r.id)).toEqual([
      'mobile-app-asks-before-restarting',
      'small-fixes-8-2026-10',
    ]);
    expect(RELEASES[at + 1]?.id).toBe('weekly-digest-and-fixes-2026-10');
    expect(RELEASES.slice(at + 1).every((r) => r.status === 'published' || r.status === 'withdrawn')).toBe(true);
    for (const r of RELEASES.slice(0, at)) {
      expect(Date.parse(r.publishedAt), r.id).toBeGreaterThan(Date.parse(release().publishedAt));
    }
    for (const r of RELEASES.slice(at + 1)) {
      expect(Date.parse(release().publishedAt), r.id).toBeGreaterThan(Date.parse(r.publishedAt));
    }
  });

  // Test stage (local walk): the order service's refusal outside the caller's
  // warehouses now reads in plain words (it named the warehouse's id). Review
  // (2026-10-05): only someone who works in SOME warehouses can meet it, and
  // that is staff (owners, admins and managers work in every warehouse by
  // role, so 7 people in production were told about a refusal they can never
  // see). Staff meet it as approvers (orders:approve) and as pickers
  // (items:update: Claim, Release and Complete picking on the phone), so the
  // entry is theirs.
  // Review (2026-10-05): the slice also stops offering receiving (web Receive
  // items, phone Scan / quantities / Post receipt, web Reverse) to readers
  // without stock:adjust, and the phone's Transfer to a manager without
  // stock:transfer, so the release covers the slice and each entry carries
  // its own audience (as the slice 1 release does): no release-level
  // audience, and a reader sees the release only when an entry is theirs.
  it('tells each entry to who can see it: requesters, staff who approve or pick, and readers of purchase orders', () => {
    const r = release();
    expect(r.audience).toBeUndefined();
    expect(r.entries.map((e) => e.id)).toEqual([
      'order-partial-approval-held',
      'order-other-warehouse-words',
      'receiving-follows-permission',
      'app-order-item-refusals',
    ]);
    for (const entry of r.entries) {
      expect(entry.category, entry.id).toBe('fixed');
      expect(entry.link, entry.id).toBeUndefined();
    }
    expect(r.entries.map((e) => e.area)).toEqual(['Orders', 'Orders', 'Receiving', 'Orders']);
    expect(r.entries[3]!.audience).toEqual({ anyPermission: ['orders:request', 'orders:approve'], modules: ['orders'] });
    expect(r.entries[0]!.audience).toEqual({ anyPermission: ['orders:request'], modules: ['orders'] });
    expect(r.entries[1]!.audience).toEqual({
      roles: ['staff'],
      anyPermission: ['orders:approve', 'items:update'],
      modules: ['orders'],
    });
    expect(r.entries[2]!.audience).toEqual({ anyPermission: ['purchase_orders:read'], modules: ['receiving'] });
    // Re-pinned by the publishing of the slice 2 release (2026-10-06; was: a
    // copy forced to published): the release itself is published now.
    expect(r.status).toBe('published');
    const idsFor = (role: ReleaseViewer['role'], permissions: ReleaseViewer['permissions'], modules: ModuleId[] = ['orders']) =>
      visibleReleases([r], { role, permissions, enabledModules: modules })[0]?.entries.map((e) => e.id) ?? [];
    expect(idsFor('viewer', ['orders:request'])).toEqual(['order-partial-approval-held', 'app-order-item-refusals']);
    expect(idsFor('staff', ['orders:request', 'orders:approve'])).toEqual([
      'order-partial-approval-held',
      'order-other-warehouse-words',
      'app-order-item-refusals',
    ]);
    expect(idsFor('staff', ['orders:request', 'items:update'])).toHaveLength(3);
    expect(idsFor('staff', ['members:read'])).toEqual([]);
    // Owners, admins and managers with Orders on: never a warehouse refusal
    // their role cannot meet.
    expect(idsFor('owner', [...PERMISSIONS])).toEqual(['order-partial-approval-held', 'app-order-item-refusals']);
    expect(idsFor('admin', [...PERMISSIONS])).toEqual(['order-partial-approval-held', 'app-order-item-refusals']);
    expect(idsFor('manager', ['orders:request', 'orders:approve', 'items:update'])).toEqual([
      'order-partial-approval-held',
      'app-order-item-refusals',
    ]);
    expect(idsFor('owner', [...PERMISSIONS], [])).toEqual([]);
    // Receiving: anyone who reads purchase orders where Receiving is on (a
    // viewer reads them by default), with or without Orders.
    expect(idsFor('viewer', ['orders:request', 'purchase_orders:read'], ['orders', 'purchase_orders', 'receiving'])).toEqual([
      'order-partial-approval-held',
      'receiving-follows-permission',
      'app-order-item-refusals',
    ]);
    expect(idsFor('viewer', ['purchase_orders:read'], ['purchase_orders', 'receiving'])).toEqual(['receiving-follows-permission']);
    expect(idsFor('viewer', ['purchase_orders:read'], ['purchase_orders'])).toEqual([]);
  });

  // Review-fix walk (iPhone simulator): the phone's add-items and edit-line
  // sheets read every server refusal as "no answer" (they parsed a message
  // shape api() stopped throwing on 2026-07-31), so they said they did not hear
  // back and hid the server's reason. Told to everyone who can change an
  // order's items in the app: the person who placed it, or an approver.
  it("says the app now shows why a change to an order's items was refused, and quotes what it said before", () => {
    const entry = release().entries.find((e) => e.id === 'app-order-item-refusals')!;
    const sheet = readFileSync(resolve(__dirname, '../../../../mobile/src/components/edit-order-line.ts'), 'utf8');
    expect(sheet).toContain("'We did not hear back from the server, so this change may already have been applied. '");
    expect(entry.whyItMatters).toContain('it did not hear back from the server');
    expect(entry.whatChanged).toMatch(/mobile app/);
    expect(entry.whatToDo).toContain('close the app completely and open it again');
    expect(readerText({ ...release(), entries: [entry] }).join(' ')).not.toMatch(/\bbook\b|ApiError|status code|403|409/i);
    // Publish re-read (2026-10-06): the fix is the phone's own code, so it
    // shows only after the latest update. A quantity does not "stay open":
    // the sheet does, when another quantity fixes the change (a floor's 409
    // keeps it open; 401, 403 and 404 close it with the reason in an alert).
    // Its two examples are the server's own refusals.
    expect(entry.title).toMatch(/^The mobile app says why/);
    expect(entry.whatChanged).toMatch(/^In the mobile app, after the latest update, /);
    expect(entry.whatChanged).toContain('When a different quantity would fix it, the sheet stays open and shows the reason.');
    expect(entry.whatChanged).not.toContain('A quantity you can fix stays open');
    expect(sheet).toContain('return status === 401 || status === 403 || status === 404;');
    const helpers = readFileSync(resolve(__dirname, '../../../../mobile/src/components/add-order-items.ts'), 'utf8');
    expect(helpers).toContain("if (e instanceof Error && e.name === 'ApiError') {");
    const svc = readFileSync(resolve(__dirname, '../../server/services/order-requests.ts'), 'utf8');
    expect(svc).toContain("`${it.name} isn't stocked at this order's warehouse.`");
    expect(svc).toContain('of these are already picked and staged');
    expect(entry.whatChanged).toContain('for example that units are already picked or that an item is not stocked at that warehouse');
  });

  it("says receiving follows the permission it needs, in the server's words, and that nothing changes in who can receive", () => {
    const entry = release().entries.find((e) => e.id === 'receiving-follows-permission')!;
    expect(entry.whatChanged).toContain(`"${dbPermissionRefusedCopy('receipt_post')}"`);
    for (const word of ['Receive items', 'Post receipt', 'Scan', 'Reverse', 'Transfer', 'Adjust on-hand', 'Transfer stock']) {
      expect(entry.whatChanged, word).toContain(word);
    }
    expect(entry.howItAffectsYou).toContain('Nothing changes in who can receive');
    expect(entry.whatToDo).toContain('close the app completely and open it again');
    expect(readerText({ ...release(), entries: [entry] }).join(' ')).not.toMatch(/\bbook\b|stock:adjust|database/i);
    // Publish re-read (2026-10-06): the phone's half is its own code, so each
    // phone sentence says "after the latest update". The note shows on a
    // purchase order that is ready to receive (the web page's receivableHere,
    // the phone's outstanding lines on a PO that is not a draft), not on every
    // one. Reverse is the web's and stays with managers and up. The refusal
    // began "Missing permission" (assertPermission's words, then the key).
    // The phone's button is Transfer / put away, and the permission alone
    // now decides it, for admins too.
    expect(entry.whatChanged).toContain(
      'and so do Scan, the quantities and Post receipt in the mobile app after the latest update.',
    );
    expect(entry.whatChanged).toContain('a purchase order ready to receive');
    expect(entry.whatChanged).toContain('On the web, Reverse on a receipt shows only with it too.');
    expect(entry.whatChanged).toContain(
      'In the mobile app, after the latest update, Transfer / put away follows the Transfer stock permission for admins and managers too.',
    );
    expect(entry.howItAffectsYou).toContain('on the web now and in the mobile app after the latest update');
    expect(entry.whyItMatters).toContain('a message that began "Missing permission"');
    const page = readFileSync(resolve(__dirname, '../../app/(dashboard)/dashboard/purchase-orders/[id]/page.tsx'), 'utf8');
    expect(page).toContain('const canReverse = isManagerOrAbove(ctx.role) && canAdjustStock;');
    expect(page).toContain("const receiveRefusal = receivableHere && !canAdjustStock ? dbPermissionRefusedCopy('receipt_post') : null;");
    const context = readFileSync(resolve(__dirname, '../../server/services/context.ts'), 'utf8');
    expect(context).toContain("throw new ServiceError('forbidden', `Missing permission: ${permission}`);");
    const po = readFileSync(resolve(__dirname, '../../../../mobile/app/po/[id].tsx'), 'utf8');
    expect(po).toContain('{!reviewOnly && !canReceive && hasOutstanding ? (');
    const item = readFileSync(resolve(__dirname, '../../../../mobile/app/item/[id].tsx'), 'utf8');
    expect(item).toContain("const canTransfer = showWriteCtaForRole(role, permissions, 'stock:transfer');");
    expect(item).toContain('Transfer / put away');
  });

  it('quotes the warehouse refusal as the order service says it, names the actions, and says Cancel now follows it', () => {
    const entry = release().entries.find((e) => e.id === 'order-other-warehouse-words')!;
    expect(entry.whatChanged).toContain(`"${ORDER_WAREHOUSE_WRITE_REFUSED_COPY}"`);
    const svc = readFileSync(resolve(__dirname, '../../server/services/order-requests.ts'), 'utf8');
    expect(svc).toContain('throw new ForbiddenError(ORDER_WAREHOUSE_WRITE_REFUSED_COPY);');
    // Every change the service refuses outside the warehouse, by what a person
    // presses: the approver's steps, Cancel, items, Hold and the date, and on
    // the phone the picking steps (the web offers those only in the
    // warehouse).
    for (const word of ['Approve', 'Deny', 'Cancel', 'notes', 'pick slip', 'staging', 'items', 'Hold available stock', 'needed-by date', 'Claim', 'Release']) {
      expect(entry.whatChanged, word).toContain(word);
    }
    // Cancel is the one rule that changed: an approver's cancel now asks the
    // warehouse, as approving does; the person who placed an order still
    // cancels it while it waits for approval.
    expect(entry.howItAffectsYou).toMatch(/Cancel/);
    expect(entry.howItAffectsYou).toContain('while it waits for approval');
    expect(entry.howItAffectsYou).not.toContain('Nothing changes in who can do what');
    expect(readerText({ ...release(), entries: [entry] }).join(' ')).not.toMatch(/\bbook\b|uuid|database|policy|works there/i);
    // The phone's needed-by check and its item sheets say it only after the
    // update (44cad980, 5719842d), so the entry says to load it.
    expect(entry.whatToDo).toBe(
      'No action needed. In the mobile app, close the app completely and open it again to load the latest update.',
    );
    // Publish re-read (2026-10-06): the web's actions and the phone's are said
    // apart. The phone shows the server's sentence for its order actions
    // (runAction; Hold's describeHoldError keeps a sentence), so those say it
    // since the web deploy; its needed-by check and item sheets are its own
    // code, so those say it after the latest update. The old messages were
    // of several kinds (the warehouse's code, "needs write access", Approve
    // partial and Resume fulfillment's "Try again", the sheets' "did not hear
    // back"), so the why says "some".
    expect(entry.whatChanged).toContain('these changes to it on the web now say');
    expect(entry.whatChanged).toContain(
      'In the mobile app, Approve, Deny, Cancel, the pick slip, staging, Hold available stock and Claim and Release picking say it too',
    );
    expect(entry.whatChanged).toContain('after the latest update so do adding or changing items and the needed-by date');
    expect(entry.whyItMatters).toContain('some only to try again');
    expect(entry.whyItMatters).toContain('had not heard back from the server');
    const order = readFileSync(resolve(__dirname, '../../../../mobile/app/order/[id].tsx'), 'utf8');
    expect(order).toContain("Alert.alert('Could not update order', e instanceof Error ? e.message : 'Please try again.');");
    const neededBy = readFileSync(resolve(__dirname, '../../../../mobile/src/lib/order-needed-by.ts'), 'utf8');
    expect(neededBy).toContain(
      'message: input.isViewer ? NEEDED_BY_NO_WAREHOUSE_ACCESS_COPY : ORDER_WAREHOUSE_WRITE_REFUSED_COPY,',
    );
  });

  it('quotes the notification word for word and the email as it reads, and claims nothing else', () => {
    const r = release();
    const entry = r.entries[0]!;
    const text = readerText(r).join(' ');
    // The sentence _notify_order_request_changes writes (0395), quoted exactly.
    // Found by name: the migration's number is fixed only when it is pushed.
    const dir = resolve(__dirname, '../../../../../supabase/migrations');
    const file = readdirSync(dir).filter((f) => f.endsWith('_order_stock_guards.sql'));
    expect(file).toHaveLength(1);
    const migration = readFileSync(resolve(dir, file[0]!), 'utf8');
    // Review (2026-10-05): one verb for the requester. A full approval has
    // always said "Stock has been reserved." and the email says "reserved",
    // so the two new sentences say "reserved" too (they said "held", the
    // approver's word).
    expect(migration).toContain("v_body := 'Part of your order is reserved; the rest is waiting for stock.';");
    expect(entry.whatChanged).toContain('"Part of your order is reserved; the rest is waiting for stock."');
    // An approval that held nothing has its own sentence, quoted exactly too.
    expect(migration).toContain("v_body := 'Nothing is reserved yet; your order is waiting for stock.';");
    expect(entry.whatChanged).toContain('"Nothing is reserved yet; your order is waiting for stock."');
    expect(migration).toContain("v_body := 'Stock has been reserved.';");
    expect(migration).not.toMatch(/v_body := '[^']*\bheld\b/);
    // The email's count, as the email prints it ("6 of 8 units"), and its
    // nothing-held sentence: the notification's own words.
    expect(entry.whatChanged).toContain('for example 6 of 8');
    const email = readFileSync(resolve(__dirname, '../email/order-requests.ts'), 'utf8');
    expect(email).toContain("'Nothing is reserved yet; your order is waiting for stock.'");
    expect(entry.whatChanged).toContain('or that nothing is reserved yet');
    // What the requester reads uses one verb: the What's New says "reserved".
    expect(text).not.toMatch(/\bheld\b/);
    expect(text).not.toMatch(/\bbook\b|filled automatically|as soon as stock arrives/i);
    expect(entry.whatToDo).toBe('No action needed.');
    // Publish re-read (2026-10-06): the every-unit case quotes the
    // notification's own sentence, and the why says what each message said
    // before 0395 (the notification "Stock has been reserved." on every
    // approval, the email "every unit"), with part or none reserved.
    expect(entry.whatChanged).toContain(
      'When every unit is reserved, the notification still says "Stock has been reserved." and the email that every unit is reserved.',
    );
    expect(entry.whatChanged).not.toContain('both still say so');
    expect(entry.whyItMatters).toContain(
      'The notification said "Stock has been reserved." and the email said every unit was reserved',
    );
    expect(email).toContain('we’ve reserved every unit on this request.');
    // B9: the count's noun follows the number now (countOf: "of 1 unit" for a
    // fractional hold of one unit), so the source no longer spells "units"
    // before this sentence. The sentence as the email prints it, "we’ve
    // reserved 6 of 8 units on this request; the rest is waiting for stock.",
    // is pinned in the HTML and the text by order-requests.partial-approval.test.ts.
    expect(email).toContain(' on this request; the rest is waiting for stock.');
  });

  // Review (2026-10-05): "because the rest is not in stock yet" was wrong when
  // units are on the shelf but held for other orders (approve_partial holds
  // what is FREE), and "the order page shows where each item stands" is true
  // only for approvers, pickers and buyers: a requester's order page shows one
  // sentence (readinessAudience 'requester'), and the entry is told to every
  // requester.
  it('claims no cause it cannot know and nothing the requester\'s order page does not show', () => {
    const entry = release().entries[0]!;
    expect(entry.whatChanged).toContain("because the rest isn't available yet");
    expect(entry.whatChanged).not.toMatch(/not in stock/i);
    expect(entry.howItAffectsYou).not.toMatch(/order page|where each item stands/i);
    expect(entry.howItAffectsYou).toContain('The rest stays on your order.');
  });

  // Publish re-read (2026-10-06): the phone half is an over-the-air update,
  // which then loaded when the app was opened again with no prompt (since
  // B44 the app asks first, with "Update ready" and Restart now), so every
  // phone claim says "after the latest update" where the phone's own code
  // changed, and each entry with a phone change says how to load it. The
  // summary is all an old phone build shows, and an order's page says
  // nothing until a change is refused, so the summary says changes are
  // refused in plain words.
  it('says every phone change after the latest update, and how to load it', () => {
    const ota = readFileSync(resolve(__dirname, '../../../../mobile/src/lib/use-ota-updates.ts'), 'utf8');
    expect(ota).toContain('await Updates.checkForUpdateAsync();');
    expect(ota).toContain('await Updates.reloadAsync({ reloadScreenOptions: RESTART_SCREEN });');
    // Re-pinned by the claims review (2026-10-06; was: "On the web now, and
    // in the mobile app after the latest update, Approve and other changes
    // ... and receiving is offered only to people who can receive stock."):
    // the phone's Approve shows the server's sentence without the update
    // (runAction, unchanged by #329), and the slice gates receiving on Adjust
    // on-hand only, while posting a receipt also needs manager rank in the
    // database (0349), so a staff member with default permissions is still
    // offered it and refused. The summary says only what the slice changed.
    expect(release().summary).toContain(
      "Approve and other changes to an order in a warehouse you don't work in are now refused in plain words, and receiving is no longer offered without the Adjust on-hand permission. In the mobile app, the receiving change and the words for changing an order's items or needed-by date come with the latest update.",
    );
    expect(release().summary).not.toMatch(/offered only to people who can receive/);
    expect(release().summary).not.toMatch(/says so in plain words/);
    const reopen =
      'No action needed. In the mobile app, close the app completely and open it again to load the latest update.';
    for (const id of ['order-other-warehouse-words', 'receiving-follows-permission', 'app-order-item-refusals']) {
      expect(entryById(id).whatToDo, id).toBe(reopen);
      expect(entryById(id).whatChanged, id).toContain('after the latest update');
    }
    // The approval's words come from the database and the server, so its
    // entry needs no phone update and says none.
    const approval = entryById('order-partial-approval-held');
    expect(approval.whatToDo).toBe('No action needed.');
    for (const text of [approval.title, approval.whatChanged, approval.whyItMatters, approval.howItAffectsYou]) {
      expect(text).not.toMatch(/update|mobile app/i);
    }
  });
});

/**
 * Returns RX-2 (migration 0396: exchanges for staff and the counter): held as
 * a DRAFT until the migration is pushed and verified, the web deploy is
 * READY, the OTA with the phone's exchange screens is published and launched
 * and the Demo Co walk passed (returns plan 10.1). Pinned by id. The
 * follow-up that publishes it (RX-5) sets 'published' and the real
 * publishedAt, re-reads its words against what shipped, and flips these pins.
 *
 * Re-pinned by docs/whats-new-returns-exchange (RX-5, 2026-10-11; was:
 * "exchanges on returns (returns RX-2) is held as a draft"): 0396 was pushed
 * and verified (R5 166 of 166), #343 merged (d6469127) and its web build
 * 935b8b102a19 went live, OTA group 2a955842 (iOS 01a12cbc) was published and
 * had launched on iOS (1 launch, 0 failed, read 22:06Z), and the Demo Co walk
 * passed with its audit CONFIRMED, so the release is published.
 */
describe('exchanges on returns (returns RX-2) is published', () => {
  const ID = 'returns-exchange-2026-10';
  const release = () => RELEASES.find((r) => r.id === ID)!;
  const everyone: ReleaseViewer = {
    role: 'owner',
    permissions: [...PERMISSIONS],
    enabledModules: Object.keys(MODULE_REGISTRY) as ModuleId[],
  };

  // Re-pinned by docs/whats-new-returns-exchange (2026-10-11; was: "is a
  // draft, so no feed carries it, and preparing it changes nothing a client
  // can observe": a draft, in no feed, no legacy list and no fingerprint).
  it('is published after 0396, the web deploy, the phone update and the Demo Co walk, so every feed it reaches carries it', () => {
    expect(release()).toBeDefined();
    expect(release().status).toBe('published');
    expect(release().revision).toBe(1);
    expect(visibleReleases(RELEASES, everyone).map((r) => r.id)).toContain(ID);
    const list = buildReleaseList(RELEASES, everyone, [], null);
    expect(list.releases.map((r) => r.id)).toContain(ID);
    // The newest release, so it is the notice for whoever it reaches: an
    // owner with every module, someone who can only open Returns, and an
    // order approver without a returns permission (told the replacement
    // order's entry alone).
    // Re-pinned by docs/whats-new-returns-requester (2026-10-12; was: ID for
    // all three readers, with nothing read): returns RX-3's release,
    // published later, reaches each of them, so it is their notice, and this
    // one is once it is read. Claim kept: this one is the notice for whoever
    // it reaches, after RX-3's.
    // Re-pinned by docs/whats-new-returns-close-rest (2026-10-12; was: RX-3's
    // release the notice for all three readers, this one once it is read):
    // returns RX-4's release, published later still, reaches the owner and
    // whoever can open Returns, so it is their notice, RX-3's once it is
    // read, and this one once both are. It reaches no order approver without
    // a returns permission or Place orders, so the approver's lines are
    // unchanged. Claim kept: this one is the notice for whoever it reaches,
    // after the newer returns releases.
    // Re-pinned by docs/whats-new-return-history-hand-over (2026-10-12; was:
    // RX-4's release the notice for the owner and whoever can open Returns,
    // RX-3's once it is read, and this one once both are): the return
    // history hand-over release, published later still, reaches those two
    // readers, so it is their notice, RX-4's once it is read, RX-3's once
    // both are, and this one once the three are. It reaches no order
    // approver without a returns permission, so the approver's lines are
    // unchanged. Claim kept: this one is the notice for whoever it reaches,
    // after the newer returns releases.
    // Re-pinned by the What's New publish of ungroup-2026-10 and
    // group-selected-2026-10 (2026-10-12; was: with nothing newer read):
    // Group selected's release (reaching every member) and Ungroup's
    // (reaching whoever can edit items) are newer, so every read and seen
    // set below includes them, and a reader with nothing read is told Group
    // selected's first. Claim kept: this one is the notice for whoever it
    // reaches, after the newer releases.
    const groupingRead = [
      // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: the reads without them): the three redesign
      // releases and the parked ai-search-finds-every-item release (#367), published at the top, are read too, so the
      // releases after them keep the order this test checks. The redesign releases reach every member, returnsOnly and
      // the approver below included, so their first notices are re-pinned below; the ai-search-finds-every-item
      // release reaches neither of them.
      ...redesignReads(),
      {
        release_id: 'ai-search-finds-every-item-2026-10',
        revision: 1,
        dismissed_at: null,
        opened_at: '2026-10-20T13:00:00Z',
        read_at: '2026-10-20T13:00:00Z',
      },
      // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: the reads without it): the pages-keep-groups-whole
      // release, published at the top, is read too, so the releases after it keep the order this test checks; it reaches
      // neither returnsOnly nor the approver below, so their lines are unchanged.
      {
        release_id: 'pages-keep-groups-whole-2026-10',
        revision: 1,
        dismissed_at: null,
        opened_at: '2026-10-12T21:41:00Z',
        read_at: '2026-10-12T21:41:00Z',
      },
      // Re-pinned by docs/whats-new-ungroup-follow-ups (2026-10-12): the Ungroup follow-ups release, published at the
      // top, is read too, so the releases after it keep the order this test checks.
      {
        release_id: 'ungroup-follow-ups-2026-10',
        revision: 1,
        dismissed_at: null,
        opened_at: '2026-10-12T17:51:00Z',
        read_at: '2026-10-12T17:51:00Z',
      },
      {
        release_id: 'group-selected-2026-10',
        revision: 1,
        dismissed_at: null,
        opened_at: '2026-10-12T13:48:00Z',
        read_at: '2026-10-12T13:48:00Z',
      },
      {
        release_id: 'ungroup-2026-10',
        revision: 1,
        dismissed_at: null,
        opened_at: '2026-10-12T13:48:00Z',
        read_at: '2026-10-12T13:48:00Z',
      },
    ];
    const rx3Read = [
      {
        release_id: 'returns-requester-exchange-2026-10',
        revision: 1,
        dismissed_at: null,
        opened_at: '2026-10-12T03:00:00Z',
        read_at: '2026-10-12T03:00:00Z',
      },
      ...groupingRead,
    ];
    const rx4Read = [{ ...rx3Read[0]!, release_id: 'returns-close-rest-2026-10', opened_at: '2026-10-12T06:00:00Z', read_at: '2026-10-12T06:00:00Z' }];
    const handOverRead = [
      { ...rx3Read[0]!, release_id: 'returns-history-hand-over-2026-10', opened_at: '2026-10-12T09:00:00Z', read_at: '2026-10-12T09:00:00Z' },
      ...groupingRead,
    ];
    // Re-pinned by the What's New publish of ungroup-2026-10 and
    // group-selected-2026-10 (2026-10-12): was returns-history-hand-over-2026-10.
    // Group selected's release is published after it (a minute after
    // Ungroup's) and reaches every member, so this reader (an owner with
    // every module) is told it first.
    // Re-pinned by docs/whats-new-ungroup-follow-ups (2026-10-12; was: group-selected-2026-10): the Ungroup follow-ups release is published after it, at the top and reaches this reader.
    // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: ungroup-follow-ups-2026-10): the pages-keep-groups-whole release is published after it, at the top, and reaches this reader.
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: pages-keep-groups-whole-2026-10): the parked ai-search-finds-every-item release (#367) and the three redesign releases are published after it, at the top, and redesign-2026-10, the newest, reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: redesign-2026-10): the unsubscribe-rack-question-fixes release is published after it, at the top, and reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: unsubscribe-rack-question-fixes-2026-10): the ended-session-group-page-fixes release is published after it, at the top, and reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: ended-session-group-page-fixes-2026-10): the manage-order-items-and-app-fixes release is published after it, at the top, and reaches every member, this reader included.
    expect(list.latestUnread?.id).toBe('manage-order-items-and-app-fixes-2026-10');
    expect(buildReleaseList(RELEASES, everyone, handOverRead, null).latestUnread?.id).toBe('returns-close-rest-2026-10');
    expect(buildReleaseList(RELEASES, everyone, [...handOverRead, ...rx4Read], null).latestUnread?.id).toBe(
      'returns-requester-exchange-2026-10',
    );
    expect(buildReleaseList(RELEASES, everyone, [...handOverRead, ...rx4Read, ...rx3Read], null).latestUnread?.id).toBe(ID);
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: group-selected-2026-10 first for returnsOnly and
    // the approver with nothing read): the three redesign releases reach every member, so both are told
    // redesign-2026-10 first, and Group selected's once those are read. Claim kept: the same order after it.
    const returnsOnly: ReleaseViewer = { role: 'staff', permissions: ['returns:read'], enabledModules: ['returns'] };
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: redesign-2026-10 with nothing read): the unsubscribe-rack-question-fixes release, published at the top, reaches every member, so this reader is told it first and redesign-2026-10 once it is read; the reads and seen sets below include it.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: unsubscribe-rack-question-fixes-2026-10 with nothing read): the ended-session-group-page-fixes release, published at the top, reaches every member, so this reader is told it first and the unsubscribe-rack-question-fixes release once it is read. Claim kept: the same order after them.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: ended-session-group-page-fixes-2026-10 with nothing read): the manage-order-items-and-app-fixes release, published at the top, reaches every member, so this reader is told it first and the ended-session-group-page-fixes release once it is read. Claim kept: the same order after them.
    expect(buildReleaseList(RELEASES, returnsOnly, [], null).latestUnread?.id).toBe(
      'manage-order-items-and-app-fixes-2026-10',
    );
    expect(buildReleaseList(RELEASES, returnsOnly, [latestRead()], null).latestUnread?.id).toBe(
      'ended-session-group-page-fixes-2026-10',
    );
    expect(
      buildReleaseList(RELEASES, returnsOnly, [latestRead(), topRead()], null).latestUnread?.id,
    ).toBe('unsubscribe-rack-question-fixes-2026-10');
    expect(
      buildReleaseList(RELEASES, returnsOnly, [latestRead(), topRead(), newestRead()], null)
        .latestUnread?.id,
    ).toBe('redesign-2026-10');
    expect(buildReleaseList(RELEASES, returnsOnly, redesignReads(), null).latestUnread?.id).toBe(
      'group-selected-2026-10',
    );
    expect(buildReleaseList(RELEASES, returnsOnly, groupingRead, null).latestUnread?.id).toBe('returns-history-hand-over-2026-10');
    expect(buildReleaseList(RELEASES, returnsOnly, handOverRead, null).latestUnread?.id).toBe('returns-close-rest-2026-10');
    expect(buildReleaseList(RELEASES, returnsOnly, [...handOverRead, ...rx4Read], null).latestUnread?.id).toBe(
      'returns-requester-exchange-2026-10',
    );
    expect(buildReleaseList(RELEASES, returnsOnly, [...handOverRead, ...rx4Read, ...rx3Read], null).latestUnread?.id).toBe(
      ID,
    );
    const approver: ReleaseViewer = { role: 'staff', permissions: ['orders:approve'], enabledModules: ['returns', 'orders'] };
    expect(visibleReleases(RELEASES, approver).map((r) => r.id)).not.toContain('returns-close-rest-2026-10');
    expect(visibleReleases(RELEASES, approver).map((r) => r.id)).not.toContain('returns-history-hand-over-2026-10');
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: redesign-2026-10 with nothing read): the unsubscribe-rack-question-fixes release, published at the top, reaches every member, so this reader is told it first and redesign-2026-10 once it is read; the reads and seen sets below include it.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: unsubscribe-rack-question-fixes-2026-10 with nothing read): the ended-session-group-page-fixes release, published at the top, reaches every member, so this reader is told it first and the unsubscribe-rack-question-fixes release once it is read. Claim kept: the same order after them.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: ended-session-group-page-fixes-2026-10 with nothing read): the manage-order-items-and-app-fixes release, published at the top, reaches every member, so this reader is told it first and the ended-session-group-page-fixes release once it is read. Claim kept: the same order after them.
    expect(buildReleaseList(RELEASES, approver, [], null).latestUnread?.id).toBe(
      'manage-order-items-and-app-fixes-2026-10',
    );
    expect(buildReleaseList(RELEASES, approver, [latestRead()], null).latestUnread?.id).toBe(
      'ended-session-group-page-fixes-2026-10',
    );
    expect(
      buildReleaseList(RELEASES, approver, [latestRead(), topRead()], null).latestUnread?.id,
    ).toBe('unsubscribe-rack-question-fixes-2026-10');
    expect(
      buildReleaseList(RELEASES, approver, [latestRead(), topRead(), newestRead()], null)
        .latestUnread?.id,
    ).toBe('redesign-2026-10');
    expect(buildReleaseList(RELEASES, approver, redesignReads(), null).latestUnread?.id).toBe(
      'group-selected-2026-10',
    );
    expect(buildReleaseList(RELEASES, approver, groupingRead, null).latestUnread?.id).toBe('returns-requester-exchange-2026-10');
    expect(buildReleaseList(RELEASES, approver, rx3Read, null).latestUnread?.id).toBe(ID);
    expect(visibleReleases(RELEASES, approver).find((r) => r.id === ID)!.entries.map((e) => e.id)).toEqual([
      'returns-exchange-replacement-order',
    ]);
    // Nobody without Returns, and no requester, is told.
    const requester: ReleaseViewer = { role: 'viewer', permissions: ['orders:request'], enabledModules: ['returns', 'orders'] };
    expect(visibleReleases(RELEASES, requester).map((r) => r.id)).not.toContain(ID);
    const noReturns: ReleaseViewer = { role: 'manager', permissions: ['returns:manage', 'orders:approve'], enabledModules: ['orders'] };
    expect(visibleReleases(RELEASES, noReturns).map((r) => r.id)).not.toContain(ID);
    // An old phone build lists it first, with the Returns link for whoever
    // can open Returns, and with no link for an order approver who cannot.
    // Re-pinned by docs/whats-new-returns-requester (2026-10-12; was: first
    // with nothing seen): returns RX-3's release is newer, so the list is
    // read with it seen. Claim kept: this one first, with or without the link.
    // Re-pinned by docs/whats-new-returns-close-rest (2026-10-12; was: RX-3's
    // release seen, for both readers): returns RX-4's release is newer
    // still and reaches the owner, so the owner's list is read with both
    // seen; it never reaches the approver. Claim kept: this one first, with or
    // without the link.
    // Re-pinned by docs/whats-new-return-history-hand-over (2026-10-12; was:
    // the owner's list read with RX-3's and RX-4's releases seen): the return
    // history hand-over release is newer still and reaches the owner, so the
    // owner's list is read with the three seen; it never reaches the
    // approver. Claim kept: this one first, with or without the link.
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: the seen set without them): the three redesign releases and the ai-search-finds-every-item release are published at the top and reach the owner (the approver the redesign releases), so they are seen here too and the order this test checks holds.
    const newerSeen = { ...redesignSeen(), 'ai-search-finds-every-item-2026-10': true };
    const rx3Seen = {
      'returns-requester-exchange-2026-10': true,
      ...newerSeen,
      // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: the seen set without it): the pages-keep-groups-whole release is published at the top and reaches the owner, so it is seen here too and the order this test checks holds.
      'pages-keep-groups-whole-2026-10': true,
      'ungroup-follow-ups-2026-10': true,
      'group-selected-2026-10': true,
      'ungroup-2026-10': true,
    };
    // Re-pinned by docs/whats-new-ungroup-follow-ups (2026-10-12): the Ungroup follow-ups release is published at the top and reaches this reader, so it is read or seen here too and the order this test checks holds.
    // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: ungroup-follow-ups-2026-10): the pages-keep-groups-whole release is published at the top and reaches this reader, so it is first with nothing seen.
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: pages-keep-groups-whole-2026-10 with nothing seen): the three redesign releases are published at the top and reach this reader, so redesign-2026-10 is first with nothing seen, and the pages-keep-groups-whole release once the four newer releases are seen.
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: redesign-2026-10 first with nothing seen): the unsubscribe-rack-question-fixes release, published at the top, reaches this reader and comes first until it is seen too; the seen sets below include it.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: unsubscribe-rack-question-fixes-2026-10 with nothing seen): the ended-session-group-page-fixes release, published at the top, reaches every member, so this reader is told it first and the unsubscribe-rack-question-fixes release once it is seen. Claim kept: the same order after them.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: ended-session-group-page-fixes-2026-10 with nothing seen): the manage-order-items-and-app-fixes release, published at the top, reaches every member, so this reader is told it first and the ended-session-group-page-fixes release once it is seen. Claim kept: the same order after them.
    expect(legacyAnnouncementsFor(RELEASES, everyone, {})[0]?.id).toBe(
      'manage-order-items-and-app-fixes-2026-10',
    );
    expect(legacyAnnouncementsFor(RELEASES, everyone, latestSeen())[0]?.id).toBe(
      'ended-session-group-page-fixes-2026-10',
    );
    expect(
      legacyAnnouncementsFor(RELEASES, everyone, { ...latestSeen(), ...topSeen() })[0]?.id,
    ).toBe('unsubscribe-rack-question-fixes-2026-10');
    expect(
      legacyAnnouncementsFor(RELEASES, everyone, {
        ...latestSeen(),
        ...topSeen(),
        ...newestSeen(),
      })[0]?.id,
    ).toBe('redesign-2026-10');
    expect(legacyAnnouncementsFor(RELEASES, everyone, newerSeen)[0]?.id).toBe(
      'pages-keep-groups-whole-2026-10',
    );
    expect(legacyAnnouncementsFor(RELEASES, everyone, rx3Seen)[0]?.id).toBe('returns-history-hand-over-2026-10');
    expect(legacyAnnouncementsFor(RELEASES, everyone, { ...rx3Seen, 'returns-close-rest-2026-10': true })[0]?.id).toBe(
      'returns-history-hand-over-2026-10',
    );
    expect(
      legacyAnnouncementsFor(RELEASES, everyone, {
        ...rx3Seen,
        'returns-close-rest-2026-10': true,
        'returns-history-hand-over-2026-10': true,
      })[0],
    ).toEqual({
      id: ID,
      date: '2026-10-11',
      title: release().title,
      body: release().summary,
      cta: { href: '/dashboard/returns', label: 'Open Returns' },
    });
    expect(legacyAnnouncementsFor(RELEASES, approver, rx3Seen)[0]).toEqual({
      id: ID,
      date: '2026-10-11',
      title: release().title,
      body: release().summary,
    });
    // Publishing it changes what clients observe.
    expect(registryFingerprint(RELEASES)).toContain(`${ID}@1:published`);
    expect(registryFingerprint(RELEASES)).not.toBe(registryFingerprint(RELEASES.filter((r) => r.id !== ID)));
    expect(ANNOUNCEMENTS.map((a) => a.id)).toContain(ID);
    // A real time on a whole minute, after the walk's audit (the walk ended
    // 2026-10-11 21:41Z) and after EAS showed the phone update launching on
    // iOS (read 22:06Z): never the draft's placeholder date (2026-10-14T17:10Z).
    expect(release().publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/);
    expect(Date.parse(release().publishedAt)).toBeGreaterThan(Date.parse('2026-10-11T22:06:00Z'));
    expect(Date.parse(release().publishedAt)).toBeLessThanOrEqual(Date.parse('2026-10-12T00:00:00Z'));
  });

  // Main's rule (the publishing of 2026-10-05): drafts sit above the newest
  // published release, newest first. RX-2's is the newest draft, so it is at
  // the top, dated after every release (RX-1's among them, published).
  // Re-pinned on rebase (2026-10-06; was: above the weekly digest's, the small
  // fixes' and PO-2's drafts): slice 1's small fixes are published and small
  // fixes slice 2's partial-approval draft sits below PO-2's.
  // Re-pinned on the PR-stage rebase onto 1a483f61 (2026-10-11; was: above
  // the weekly digest's, PO-2's and small fixes slice 2's drafts): those
  // three, the dates fixes and the public order link releases are published
  // (#333, #337, #339), so RX-2's is the only draft, directly above the
  // public order link release, the newest published one.
  // Re-pinned by docs/whats-new-returns-exchange (2026-10-11; was: "is the
  // only draft, at the top above the public order link release (the newest
  // published), dated after every release"): published in the same place,
  // it is the newest release, and no draft is left. Claim kept: at the top,
  // directly above the public order link release, dated after every release.
  // Re-pinned by returns RX-3 (2026-10-11; was: "is the newest release, at
  // the top ..., and no draft is left"): RX-3's draft, dated later still,
  // sits at the top above it. Claim kept: the newest published release,
  // directly above the public order link release, dated after every release
  // but RX-3's draft.
  // Re-pinned by docs/whats-new-returns-requester (2026-10-12; was: "is the
  // newest published release, directly below returns RX-3's draft ..."):
  // RX-3's release is published, in the same place, so it is the newest
  // release and no draft is left. Claim kept: directly below RX-3's release
  // and above the public order link release, dated after every release but
  // RX-3's.
  // Re-pinned by returns RX-4 (2026-10-12; was: at 1, RX-3's release at 0,
  // "and no draft is left"): RX-4's draft, dated later still, sits at the
  // top above RX-3's release and is the only draft. Claim kept: directly
  // below RX-3's release and above the public order link release, dated
  // after every release but RX-3's and RX-4's draft.
  // Re-pinned by docs/whats-new-returns-close-rest (2026-10-12; was: "... and
  // the returns RX-4 draft at the top, the only draft"): RX-4's release is
  // published, in the same place, so it is the newest release and no draft
  // is left. Claim kept: directly below RX-3's release and above the public
  // order link release, dated after every release but RX-3's and RX-4's.
  // Re-pinned by the return history hand-over fix (D-H1, 2026-10-12; was: at
  // 2, RX-4's release at 0, "and no draft is left"): its draft, dated later
  // still, sits at the top above RX-4's release and is the only draft. Claim
  // kept: directly below RX-3's release, with RX-4's above that, and above
  // the public order link release, dated after every release but RX-3's,
  // RX-4's and that draft.
  // Re-pinned by docs/whats-new-return-history-hand-over (2026-10-12; was:
  // "... and the return history hand-over draft at the top, the only
  // draft"): its release is published, in the same place, so it is the
  // newest release and no draft is left. Claim kept: directly below RX-3's
  // release, with RX-4's and the hand-over release above that, and above the
  // public order link release, dated after every release but those three.
  // Re-pinned by Ungroup G1 (2026-10-12, rebased onto #354; was: at 3, the
  // return history hand-over release at 0, "and no draft is left"):
  // Ungroup's draft, dated later still, sits at the top above the hand-over
  // release and is the only draft. Claim kept: directly below RX-3's
  // release, with RX-4's and the hand-over release above that, and above the
  // public order link release, dated after every release but those three and
  // Ungroup's draft.
  // Re-pinned by Group selected G2 (2026-10-12, rebased onto #351; was: at
  // 4, Ungroup's draft at 0 and the only draft): Group selected's draft,
  // dated later still, sits at the top above Ungroup's, so there are two
  // drafts. Claim kept: directly below RX-3's release, with RX-4's and the
  // hand-over release above that, and above the public order link release,
  // dated after every release but those three and the two drafts.
  // Re-pinned by the What's New publish of ungroup-2026-10 and
  // group-selected-2026-10 (2026-10-12; was: "... the Group selected and
  // Ungroup drafts at the top ..."): both are published in the same
  // places. Claim kept: the same place, dated as before against the
  // releases around it.
  // Renamed by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: "... and the Ungroup and Group selected releases at the top ..."): the Ungroup follow-ups release (#362) and the pages-keep-groups-whole release are published above them, at the top. Claim kept: the same place, dated as before against the releases around it.
  // Renamed by docs/whats-new-redesign-2026-10 (2026-10-20; was: "... Ungroup follow-ups and pages-keep-groups-whole releases at the top ..."): the parked ai-search-finds-every-item release (#367) and the three redesign releases are published above them, at the top. Claim kept: the same place, dated as before against the releases around it.
  // Renamed by docs/whats-new-2026-10-25 (2026-10-25; was: "... ai-search-finds-every-item and three redesign releases at the top ..."): the unsubscribe-rack-question-fixes release is published above them, at the top. Claim kept: the same place, dated as before against the releases around it.
  // Renamed by docs/whats-new-2026-10-26 (2026-10-26; was: "... three redesign and unsubscribe-rack-question-fixes releases at the top ..."): the ended-session-group-page-fixes release is published above them, at the top. Claim kept: the same place, dated as before against the releases around it.
  // Renamed by docs/whats-new-2026-10-30 (2026-10-30; was: "... unsubscribe-rack-question-fixes and ended-session-group-page-fixes releases at the top ..."): the manage-order-items-and-app-fixes release is published above them, at the top. Claim kept: the same place, dated as before against the releases around it.
  it("sits directly below returns RX-3's release, with returns RX-4's and the return history hand-over release above that (all published later), and above the public order link release, dated after every release but those three and the Ungroup, Group selected, Ungroup follow-ups, pages-keep-groups-whole, ai-search-finds-every-item, three redesign, unsubscribe-rack-question-fixes, ended-session-group-page-fixes and manage-order-items-and-app-fixes releases at the top (published later still), and no draft is left", () => {
    // Re-pinned by the B44 phone update draft (fix/b44-update-restart-prompt;
    // was: without it): dated after every release, it sits at the top, so
    // every position below it moves down by one, and it and slice 8's are the
    // drafts.
    // Re-pinned by the small fixes slice 8 draft (fix/small-fixes-8; was:
    // without it): dated after every release, it sits at the top, so every
    // position below it moves down by one, and it is the one draft.
    // Re-pinned by the What's New publish of ungroup-2026-10 and
    // group-selected-2026-10 (2026-10-12; was: the two drafts at the top, the
    // only drafts, and the hand-over release the newest published): both are
    // published in the same places, dated after every release below them, so
    // Group selected's is the newest published release and no draft is left.
    // Re-pinned by docs/whats-new-ungroup-follow-ups (2026-10-12): the Ungroup follow-ups release is published at the top, above Group selected's, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: the Ungroup follow-ups release at 0 and this one at 6): the pages-keep-groups-whole release is published at the top, above the Ungroup follow-ups release, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: the pages-keep-groups-whole release at 0, this one at 7 and the public link release at 8): the three redesign releases and the parked ai-search-finds-every-item release (#367) are published at the top, above the pages-keep-groups-whole release, so every position below them moves down by four.
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: the redesign and ai-search-finds-every-item releases at 0 to 3, and each position below them one place higher): the unsubscribe-rack-question-fixes release is published at the top, above the redesign releases, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: the unsubscribe-rack-question-fixes release at 0, and each position and slice below it one place higher): the ended-session-group-page-fixes release is published at the top, above it, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: the ended-session-group-page-fixes release at 0, and each position and slice below it one place higher): the manage-order-items-and-app-fixes release is published at the top, above it, so every position below it moves down by one.
    expect(RELEASES[1]?.id).toBe('small-fixes-8-2026-10');
    expect(RELEASES[1]?.status).toBe('draft');
    expect(RELEASES[2]?.id).toBe('manage-order-items-and-app-fixes-2026-10');
    expect(RELEASES[2]?.status).toBe('published');
    expect(RELEASES[3]?.id).toBe('ended-session-group-page-fixes-2026-10');
    expect(RELEASES[3]?.status).toBe('published');
    expect(RELEASES[4]?.id).toBe('unsubscribe-rack-question-fixes-2026-10');
    expect(RELEASES[4]?.status).toBe('published');
    expect(RELEASES.slice(5, 9).map((r) => [r.id, r.status])).toEqual([
      ['redesign-2026-10', 'published'],
      ['redesign-mobile-app-2026-10', 'published'],
      ['redesign-web-fixes-2026-10', 'published'],
      ['ai-search-finds-every-item-2026-10', 'published'],
    ]);
    expect(RELEASES[9]?.id).toBe('pages-keep-groups-whole-2026-10');
    expect(RELEASES[9]?.status).toBe('published');
    expect(RELEASES[10]?.id).toBe('ungroup-follow-ups-2026-10');
    expect(RELEASES[10]?.status).toBe('published');
    expect(RELEASES[11]?.id).toBe('group-selected-2026-10');
    expect(RELEASES[11]?.status).toBe('published');
    expect(RELEASES[12]?.id).toBe('ungroup-2026-10');
    expect(RELEASES[12]?.status).toBe('published');
    expect(Date.parse(RELEASES[11]!.publishedAt)).toBeGreaterThan(
      Date.parse(release().publishedAt),
    );
    expect(Date.parse(RELEASES[12]!.publishedAt)).toBeGreaterThan(
      Date.parse(release().publishedAt),
    );
    expect(RELEASES[13]?.id).toBe('returns-history-hand-over-2026-10');
    expect(RELEASES[13]?.status).toBe('published');
    expect(RELEASES[14]?.id).toBe('returns-close-rest-2026-10');
    expect(RELEASES[14]?.status).toBe('published');
    expect(RELEASES[15]?.id).toBe('returns-requester-exchange-2026-10');
    expect(RELEASES[15]?.status).toBe('published');
    expect(RELEASES[16]?.id).toBe(ID);
    // Re-pinned by the What's New publish of ungroup-2026-10 and
    // group-selected-2026-10 (2026-10-12; was: those two drafts): both are
    // published, so no draft is left.
    expect(RELEASES.filter((r) => r.status === 'draft').map((r) => r.id)).toEqual([
      'mobile-app-asks-before-restarting',
      'small-fixes-8-2026-10',
    ]);
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: pages-keep-groups-whole-2026-10): redesign-2026-10 is the newest published release, at the top.
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: redesign-2026-10): the unsubscribe-rack-question-fixes release is published after it, at the top, the newest published release.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: unsubscribe-rack-question-fixes-2026-10): the ended-session-group-page-fixes release is published after it, at the top, the newest published release.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: ended-session-group-page-fixes-2026-10): the manage-order-items-and-app-fixes release is published after it, at the top, the newest published release.
    expect(RELEASES.find((r) => r.status === 'published')?.id).toBe(
      'manage-order-items-and-app-fixes-2026-10',
    );
    expect(Date.parse(RELEASES[13]!.publishedAt)).toBeGreaterThan(
      Date.parse(release().publishedAt),
    );
    expect(Date.parse(RELEASES[14]!.publishedAt)).toBeGreaterThan(
      Date.parse(release().publishedAt),
    );
    expect(Date.parse(RELEASES[15]!.publishedAt)).toBeGreaterThan(
      Date.parse(release().publishedAt),
    );
    expect(RELEASES[17]?.id).toBe('public-link-sent-request-2026-10');
    expect(RELEASES[17]?.status).toBe('published');
    const rx1 = RELEASES.findIndex((r) => r.id === 'returns-original-rack-2026-10');
    expect(RELEASES[rx1]?.status).toBe('published');
    // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: the set without it): the pages-keep-groups-whole release is published later, at the top.
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: the set without them): the three redesign releases and the parked ai-search-finds-every-item release (#367) are published later, at the top.
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: the set without it): the unsubscribe-rack-question-fixes release is published later, at the top.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: the set without it): the ended-session-group-page-fixes release is published later, at the top.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: the set without it): the manage-order-items-and-app-fixes release is published later, at the top.
    const above = new Set([
      'mobile-app-asks-before-restarting',
      'small-fixes-8-2026-10',
      ID,
      'returns-requester-exchange-2026-10',
      'returns-close-rest-2026-10',
      'returns-history-hand-over-2026-10',
      'ungroup-2026-10',
      'group-selected-2026-10',
      'ungroup-follow-ups-2026-10',
      'pages-keep-groups-whole-2026-10',
      'ai-search-finds-every-item-2026-10',
      ...REDESIGN_IDS,
      NEWEST_ID,
      TOP_ID,
      LATEST_ID,
    ]);
    for (const r of RELEASES.filter((x) => !above.has(x.id))) {
      expect(Date.parse(release().publishedAt), r.id).toBeGreaterThan(Date.parse(r.publishedAt));
    }
  });

  // Re-pinned by returns RX-2 review fix (P13; was: the release to returns:read
  // or returns:manage, and the replacement order's entry to returns:manage
  // with modules ['returns', 'orders'], which is ANY of the two, not "with
  // Orders on"). Order approvers meet a replacement on its order page (the
  // waiting line instead of Generate pick slip, the Exchange chip, the
  // banner), so they are told too. Claim kept: the exchange entry is told to
  // whoever can open Returns, and nothing reaches an organization without
  // Returns.
  it('is told to whoever can open Returns or approves orders, with Returns on; the replacement order to people who manage returns or approve orders', () => {
    const r = release();
    expect(r.audience).toEqual({ anyPermission: ['returns:read', 'returns:manage', 'orders:approve'], modules: ['returns'] });
    expect(r.entries.map((e) => e.id)).toEqual(['returns-exchange', 'returns-exchange-replacement-order']);
    const [exchange, order] = r.entries;
    expect(exchange!.audience).toEqual({ anyPermission: ['returns:read', 'returns:manage'], modules: ['returns'] });
    expect(exchange!.link).toEqual({ href: '/dashboard/returns', label: 'Open Returns' });
    expect(order!.audience).toEqual({ anyPermission: ['returns:manage', 'orders:approve'], modules: ['returns'] });
    // Nobody is sent to a page that bounces them: an order approver without
    // a returns permission cannot open Returns, so this entry links nothing.
    expect(order!.link).toBeUndefined();
    // Re-pinned by docs/whats-new-returns-exchange (2026-10-11; was: a copy
    // forced to published): the release itself is published now.
    expect(r.status).toBe('published');
    const entriesFor = (permissions: ReleaseViewer['permissions'], modules: ModuleId[] = ['returns', 'orders']) =>
      visibleReleases([r], { role: 'staff', permissions, enabledModules: modules })[0]?.entries.map((e) => e.id) ?? [];
    expect(entriesFor(['returns:read'])).toEqual(['returns-exchange']);
    expect(entriesFor(['returns:manage'])).toEqual(['returns-exchange', 'returns-exchange-replacement-order']);
    expect(entriesFor(['orders:approve'])).toEqual(['returns-exchange-replacement-order']);
    expect(entriesFor(['returns:manage', 'orders:approve'], ['orders'])).toEqual([]);
    expect(entriesFor(['orders:request'])).toEqual([]);
  });

  // Review fix (P13): the counter steps follow the screens, with this stage's
  // two shortcuts (the only returnable line starts ticked; Hand over opens
  // the replacement's order with the Physical signature dialog open).
  // Re-pinned by docs/whats-new-returns-exchange (2026-10-11; was: "starts
  // ticked"): the phone's create sheet has a quantity, not a tick (the only
  // line starts at what can come back, order-returns.ts initialReturnDraft),
  // so the words say the line is already chosen. Claim kept: the shortcut is
  // named, in screen order.
  it('walks the counter in screen order, with the real button names', () => {
    const how = release().entries[0]!.howItAffectsYou;
    const steps = [
      RETURNS_COPY.itemIsHere,
      RETURNS_COPY.approveAndReceive,
      RETURNS_COPY.getReplacementReady,
      RETURNS_COPY.processReturn,
      RETURNS_COPY.handOver,
    ];
    const at = steps.map((s) => how.indexOf(s));
    expect(at.every((i) => i >= 0), JSON.stringify(at)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(how).toContain(returnToRackButton('31-C'));
    expect(how).toContain('(when only one line can be returned, it is already chosen)');
    expect(how).not.toContain('ticked');
    expect(how).toContain('Physical signature');
    expect(how).toContain('Approving an exchange needs order approval as well as Manage returns.');
    expect(how).toContain(RETURNS_COPY.declineExchange);
  });

  // Review fix (P13): the phone needs the update; the gate holds a
  // replacement until the item is back or a manager releases it, which is
  // not "nothing goes out twice".
  // Re-pinned by docs/whats-new-returns-exchange (2026-10-11; was: "unless a
  // manager decides to, with a reason"): releasing early needs order
  // approval and Manage returns (release_return_replacement_early, 0396;
  // order-replacement.ts canReleaseEarly), so the words name both. Claim
  // kept: the why says what the gate does.
  it('tells the phone to load the update and says what the gate does', () => {
    const r = release();
    const [exchange, order] = r.entries;
    expect(r.summary).toContain('in the mobile app after the latest update');
    for (const e of [exchange!, order!]) {
      expect(e.whatToDo, e.id).toBe(
        'No action needed on the web. In the mobile app, close the app completely and open it again to load the latest update.',
      );
    }
    expect(order!.whyItMatters).toBe(
      'A replacement is not handed out while the item it replaces is still missing, unless someone with order approval and Manage returns decides to, with a reason.',
    );
    expect(order!.howItAffectsYou).toContain('instead of offering Generate pick slip');
    expect(order!.howItAffectsYou).toContain('On a delivery released early, the order shows what the driver collects.');
    expect(readerText(r).join(' ')).not.toMatch(/nothing goes out twice/i);
  });

  it("uses the screens' own words and claims nothing the product does not do", () => {
    const r = release();
    const all = readerText(r).join(' ');
    expect(all).not.toMatch(/\bbooks?\b|verified|inspected|certif|guarantee|%/i);
    for (const label of [
      RETURNS_COPY.returnOnly,
      RETURNS_COPY.exchangeStaff,
      RETURNS_COPY.approveAsRequested,
      RETURNS_COPY.changeReplacementEllipsis,
      RETURNS_COPY.declineExchange,
      RETURNS_COPY.addReplacement,
      RETURNS_COPY.approveReplacementOnBackorder,
      RETURNS_COPY.getReplacementReady,
      RETURNS_COPY.releaseEarly,
      // Fix round 1 (completeness C-7): the order page's own button too.
      RETURNS_COPY.releaseBeforeReturn,
      RETURNS_COPY.cancelReplacement,
      RETURNS_COPY.issueNewReplacement,
      RETURNS_COPY.closeAsReturnOnly,
      RETURNS_COPY.itemIsHere,
      RETURNS_COPY.approveAndReceive,
      RETURNS_COPY.processReturn,
      RETURNS_COPY.handOver,
    ]) {
      expect(all).toContain(label);
    }
    // The requester's own exchange is RX-3: nothing here says a requester can ask.
    expect(all).not.toMatch(/requesters? can (ask|request)|return link|customer portal/i);
  });

  // Corrected at publish (docs/whats-new-returns-exchange, 2026-10-11), each
  // against d6469127 and the Demo Co walk.
  it('says who can do what by permission, never by a role name, and claims no layout the phone does not have', () => {
    const r = release();
    const [exchange, order] = r.entries;
    const all = readerText(r).join(' ');
    // "Staff" is also a role, with no returns permission by default; creating
    // an exchange needs Manage returns (create_return_request, ReturnsService).
    expect(r.summary).toMatch(/^People who manage returns can now turn a return line into an exchange/);
    expect(all).not.toMatch(/\bStaff can\b/);
    // Releasing early needs order approval and Manage returns, so never "a
    // manager" (a role name too).
    expect(all).not.toMatch(/\ba manager\b/i);
    const both = 'someone with order approval and Manage returns';
    expect(r.summary).toContain(`unless ${both} releases it earlier, with a reason`);
    expect(order!.whatChanged).toContain(`unless ${both} releases it early, with a reason:`);
    expect(order!.whyItMatters).toContain(`unless ${both} decides to`);
    // The two sides stack on an iPhone, so nothing says "beside"; what
    // Exchange lists (core exchange-view candidate rows: other sizes first,
    // each with its availability, then the search) is its own sentence.
    expect(all).not.toMatch(/\bbeside\b/i);
    expect(exchange!.whatChanged).toContain(
      "Exchange lists the item's other sizes first, with what's available, then a search for other items; the return shows each replacement with the item it replaces.",
    );
    // A stale Cancel replacement is refused (return_changed) before the
    // reload, so nothing is cancelled on that click.
    expect(order!.howItAffectsYou).toContain(
      'if it was picked or sent since you opened the return, nothing is cancelled and the page reloads to show it.',
    );
    // Nothing claims the replacement card's status after the hand-over, or
    // the phone order header's word for a completed pickup (walk Lows).
    expect(all).not.toMatch(/\bdelivered\b|\bcompleted\b/i);
  });

  // Corrected by the claims review of #345 (2026-10-11), against d6469127:
  // the line said Cancel return also cancels "a replacement not picked yet".
  // At an approved RMA, core availableReturnActions (the RMA's buttons on the
  // web and the phone) offers Cancel return while the replacement waits for
  // the returned item, and not once it is released early (Ready to pick, or
  // a pick slip and picking: at an approved RMA the gate lets a pick slip
  // through only after a release), picked or sent; there Cancel replacement
  // is the path, and Cancel return comes back after it.
  it('says Cancel return cancels a waiting replacement, and one released early, picked or sent is handed over or cancelled first', () => {
    const [, order] = release().entries;
    expect(order!.howItAffectsYou).toMatch(
      /Cancelling the return also cancels a waiting replacement; once it is released early, picked or sent, hand it over first, or cancel the replacement if none was handed over\.$/,
    );
    expect(order!.howItAffectsYou).not.toMatch(/not picked yet/);
    const at = (exchangeStatus: 'waiting_for_return' | 'ready_to_pick' | 'in_progress' | 'replacement_cancelled') =>
      availableReturnActions({
        status: 'approved',
        exchangeStatus,
        hasExchange: true,
        hasApprovedExchange: true,
        replacementClass: exchangeStatus === 'replacement_cancelled' ? 'none' : 'undrawn',
        viewerCanManageReturns: true,
        viewerCanApproveOrders: true,
      });
    const offers = (a: ReturnType<typeof at>) => [a.primary, ...a.secondary];
    expect(offers(at('waiting_for_return'))).toContain('cancel');
    for (const released of ['ready_to_pick', 'in_progress'] as const) {
      expect(offers(at(released))).not.toContain('cancel');
      expect(offers(at(released))).toContain('cancel_replacement');
    }
    expect(offers(at('replacement_cancelled'))).toContain('cancel');
  });
});

/**
 * Returns RX-4 (migrations 0397 and 0398: Close the rest of a replacement
 * handed over in part, and no sizes on a used-up line): held as a DRAFT until
 * both migrations and its web deploy were live, the OTA with the phone's Close
 * the rest sheet was published and launched, and the Demo Co walk passed
 * (returns plan 10.1 and 11). Pinned by id.
 *
 * Re-pinned by docs/whats-new-returns-close-rest (RX-5, 2026-10-12; was:
 * "Close the rest (returns RX-4) is held as a draft"): 0397 and 0398 were
 * pushed (03:37Z), #348 merged (7143ec0f6) and its web build e8fc3d8bc491
 * went live, OTA group 292dd2ec (iOS 01a12e36) was published and had launched
 * on iOS (1 launch, 0 failed, read 04:58Z), and the Demo Co walk passed (its
 * audit found production matching the walk in every respect and disputed the
 * report only), so the release is published. The used-up line was not walked
 * in production (the demo account manages returns, so the requester's Return
 * or exchange is hidden from it by design); its evidence is the merged code
 * and RX-4's test stage (browser case U), recorded in the release.
 */
describe('Close the rest (returns RX-4) is published', () => {
  const ID = 'returns-close-rest-2026-10';
  const release = () => RELEASES.find((r) => r.id === ID)!;
  const everyone: ReleaseViewer = {
    role: 'owner',
    permissions: [...PERMISSIONS],
    enabledModules: Object.keys(MODULE_REGISTRY) as ModuleId[],
  };

  // Re-pinned by docs/whats-new-returns-close-rest (2026-10-12; was: "is a
  // draft, so no feed carries it, and preparing it changes nothing a client
  // can observe": a draft, in no feed, no legacy list and no fingerprint).
  it('is published after 0397 and 0398, the web deploy, the phone update and the Demo Co walk, so every feed it reaches carries it', () => {
    expect(release()).toBeDefined();
    expect(release().status).toBe('published');
    expect(release().revision).toBe(1);
    expect(visibleReleases(RELEASES, everyone).map((r) => r.id)).toContain(ID);
    const list = buildReleaseList(RELEASES, everyone, [], null);
    expect(list.releases.map((r) => r.id)).toContain(ID);
    // The newest release, so it is the notice for whoever it reaches: an
    // owner with every module, someone who can only open Returns, and a
    // member who places orders with Returns on.
    // Re-pinned by docs/whats-new-return-history-hand-over (2026-10-12; was:
    // ID for all three readers, with nothing read): the return history
    // hand-over release, published later, reaches the owner and whoever can
    // open Returns, so it is their notice, and this one is once it is read.
    // It reaches no member who only places orders, whose notice this one
    // stays. Claim kept: this one is the notice for whoever it reaches, after
    // the hand-over release.
    // Re-pinned by the What's New publish of ungroup-2026-10 and
    // group-selected-2026-10 (2026-10-12; was: with nothing newer read):
    // Group selected's release (reaching every member) and Ungroup's
    // (reaching whoever can edit items) are newer, so the reads and seen
    // sets below include them, and a reader with nothing read is told Group
    // selected's first. Claim kept: this one is the notice for whoever it
    // reaches, after the newer releases.
    const groupingRead = [
      // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: the reads without them): the three redesign
      // releases and the parked ai-search-finds-every-item release (#367), published at the top, are read too, so the
      // releases after them keep the order this test checks. The redesign releases reach every member, returnsOnly and
      // the requester below included, so their first notices are re-pinned below; the ai-search-finds-every-item
      // release reaches neither of them.
      ...redesignReads(),
      {
        release_id: 'ai-search-finds-every-item-2026-10',
        revision: 1,
        dismissed_at: null,
        opened_at: '2026-10-20T13:00:00Z',
        read_at: '2026-10-20T13:00:00Z',
      },
      // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: the reads without it): the pages-keep-groups-whole
      // release, published at the top, is read too, so the releases after it keep the order this test checks; it reaches
      // neither returnsOnly nor the requester below, so their lines are unchanged.
      {
        release_id: 'pages-keep-groups-whole-2026-10',
        revision: 1,
        dismissed_at: null,
        opened_at: '2026-10-12T21:41:00Z',
        read_at: '2026-10-12T21:41:00Z',
      },
      // Re-pinned by docs/whats-new-ungroup-follow-ups (2026-10-12): the Ungroup follow-ups release, published at the
      // top, is read too, so the releases after it keep the order this test checks.
      {
        release_id: 'ungroup-follow-ups-2026-10',
        revision: 1,
        dismissed_at: null,
        opened_at: '2026-10-12T17:51:00Z',
        read_at: '2026-10-12T17:51:00Z',
      },
      {
        release_id: 'group-selected-2026-10',
        revision: 1,
        dismissed_at: null,
        opened_at: '2026-10-12T13:48:00Z',
        read_at: '2026-10-12T13:48:00Z',
      },
      {
        release_id: 'ungroup-2026-10',
        revision: 1,
        dismissed_at: null,
        opened_at: '2026-10-12T13:48:00Z',
        read_at: '2026-10-12T13:48:00Z',
      },
    ];
    const handOverRead = [
      {
        release_id: 'returns-history-hand-over-2026-10',
        revision: 1,
        dismissed_at: null,
        opened_at: '2026-10-12T09:00:00Z',
        read_at: '2026-10-12T09:00:00Z',
      },
      ...groupingRead,
    ];
    // Re-pinned by the What's New publish of ungroup-2026-10 and
    // group-selected-2026-10 (2026-10-12): was returns-history-hand-over-2026-10.
    // Group selected's release is published after it (a minute after
    // Ungroup's) and reaches every member, so this reader (an owner with
    // every module) is told it first.
    // Re-pinned by docs/whats-new-ungroup-follow-ups (2026-10-12; was: group-selected-2026-10): the Ungroup follow-ups release is published after it, at the top and reaches this reader.
    // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: ungroup-follow-ups-2026-10): the pages-keep-groups-whole release is published after it, at the top, and reaches this reader.
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: pages-keep-groups-whole-2026-10): the parked ai-search-finds-every-item release (#367) and the three redesign releases are published after it, at the top, and redesign-2026-10, the newest, reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: redesign-2026-10): the unsubscribe-rack-question-fixes release is published after it, at the top, and reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: unsubscribe-rack-question-fixes-2026-10): the ended-session-group-page-fixes release is published after it, at the top, and reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: ended-session-group-page-fixes-2026-10): the manage-order-items-and-app-fixes release is published after it, at the top, and reaches every member, this reader included.
    expect(list.latestUnread?.id).toBe('manage-order-items-and-app-fixes-2026-10');
    expect(buildReleaseList(RELEASES, everyone, handOverRead, null).latestUnread?.id).toBe(ID);
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: group-selected-2026-10 first for returnsOnly and
    // the requester with nothing read): the three redesign releases reach every member, so both are told
    // redesign-2026-10 first, and Group selected's once those are read. Claim kept: the same order after it.
    const returnsOnly: ReleaseViewer = { role: 'staff', permissions: ['returns:read'], enabledModules: ['returns'] };
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: redesign-2026-10 with nothing read): the unsubscribe-rack-question-fixes release, published at the top, reaches every member, so this reader is told it first and redesign-2026-10 once it is read; the reads and seen sets below include it.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: unsubscribe-rack-question-fixes-2026-10 with nothing read): the ended-session-group-page-fixes release, published at the top, reaches every member, so this reader is told it first and the unsubscribe-rack-question-fixes release once it is read. Claim kept: the same order after them.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: ended-session-group-page-fixes-2026-10 with nothing read): the manage-order-items-and-app-fixes release, published at the top, reaches every member, so this reader is told it first and the ended-session-group-page-fixes release once it is read. Claim kept: the same order after them.
    expect(buildReleaseList(RELEASES, returnsOnly, [], null).latestUnread?.id).toBe(
      'manage-order-items-and-app-fixes-2026-10',
    );
    expect(buildReleaseList(RELEASES, returnsOnly, [latestRead()], null).latestUnread?.id).toBe(
      'ended-session-group-page-fixes-2026-10',
    );
    expect(
      buildReleaseList(RELEASES, returnsOnly, [latestRead(), topRead()], null).latestUnread?.id,
    ).toBe('unsubscribe-rack-question-fixes-2026-10');
    expect(
      buildReleaseList(RELEASES, returnsOnly, [latestRead(), topRead(), newestRead()], null)
        .latestUnread?.id,
    ).toBe('redesign-2026-10');
    expect(buildReleaseList(RELEASES, returnsOnly, redesignReads(), null).latestUnread?.id).toBe(
      'group-selected-2026-10',
    );
    expect(buildReleaseList(RELEASES, returnsOnly, groupingRead, null).latestUnread?.id).toBe('returns-history-hand-over-2026-10');
    expect(buildReleaseList(RELEASES, returnsOnly, handOverRead, null).latestUnread?.id).toBe(ID);
    const requester: ReleaseViewer = { role: 'viewer', permissions: ['orders:request'], enabledModules: ['returns', 'orders'] };
    expect(visibleReleases(RELEASES, requester).map((r) => r.id)).not.toContain('returns-history-hand-over-2026-10');
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: redesign-2026-10 with nothing read): the unsubscribe-rack-question-fixes release, published at the top, reaches every member, so this reader is told it first and redesign-2026-10 once it is read; the reads and seen sets below include it.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: unsubscribe-rack-question-fixes-2026-10 with nothing read): the ended-session-group-page-fixes release, published at the top, reaches every member, so this reader is told it first and the unsubscribe-rack-question-fixes release once it is read. Claim kept: the same order after them.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: ended-session-group-page-fixes-2026-10 with nothing read): the manage-order-items-and-app-fixes release, published at the top, reaches every member, so this reader is told it first and the ended-session-group-page-fixes release once it is read. Claim kept: the same order after them.
    expect(buildReleaseList(RELEASES, requester, [], null).latestUnread?.id).toBe(
      'manage-order-items-and-app-fixes-2026-10',
    );
    expect(buildReleaseList(RELEASES, requester, [latestRead()], null).latestUnread?.id).toBe(
      'ended-session-group-page-fixes-2026-10',
    );
    expect(
      buildReleaseList(RELEASES, requester, [latestRead(), topRead()], null).latestUnread?.id,
    ).toBe('unsubscribe-rack-question-fixes-2026-10');
    expect(
      buildReleaseList(RELEASES, requester, [latestRead(), topRead(), newestRead()], null)
        .latestUnread?.id,
    ).toBe('redesign-2026-10');
    expect(buildReleaseList(RELEASES, requester, redesignReads(), null).latestUnread?.id).toBe(
      'group-selected-2026-10',
    );
    expect(buildReleaseList(RELEASES, requester, groupingRead, null).latestUnread?.id).toBe(ID);
    // Nobody else: an order approver with neither a returns permission nor
    // Place orders, a member with no permission, a requester without Returns.
    const approver: ReleaseViewer = { role: 'staff', permissions: ['orders:approve'], enabledModules: ['returns', 'orders'] };
    const member: ReleaseViewer = { role: 'viewer', permissions: [], enabledModules: ['returns', 'orders'] };
    const noReturns: ReleaseViewer = { role: 'viewer', permissions: ['orders:request'], enabledModules: ['orders'] };
    for (const viewer of [approver, member, noReturns]) {
      expect(visibleReleases(RELEASES, viewer).map((r) => r.id)).not.toContain(ID);
    }
    // An old phone build lists it first, with the Returns link for whoever
    // can open Returns, and with no link for a requester, whose entry links
    // nothing.
    // Re-pinned by docs/whats-new-return-history-hand-over (2026-10-12; was:
    // first with nothing seen, for both readers): the return history
    // hand-over release is newer and reaches the owner, so the owner's list
    // is read with it seen; it never reaches the requester. Claim kept: this
    // one first, with or without the link.
    // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: the seen set without it): the pages-keep-groups-whole release is published at the top and reaches the owner, so it is seen here too and the order this test checks holds.
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: the seen set without them): the three redesign releases and the ai-search-finds-every-item release are published at the top and reach the owner (the requester the redesign releases), so they are seen here too and the order this test checks holds.
    const newerSeen = { ...redesignSeen(), 'ai-search-finds-every-item-2026-10': true };
    const groupingSeen = {
      ...newerSeen,
      'group-selected-2026-10': true,
      'ungroup-2026-10': true,
      'ungroup-follow-ups-2026-10': true,
      'pages-keep-groups-whole-2026-10': true,
    };
    // Re-pinned by docs/whats-new-ungroup-follow-ups (2026-10-12): the Ungroup follow-ups release is published at the top and reaches this reader, so it is read or seen here too and the order this test checks holds.
    // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: ungroup-follow-ups-2026-10): the pages-keep-groups-whole release is published at the top and reaches this reader, so it is first with nothing seen.
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: pages-keep-groups-whole-2026-10 with nothing seen): the three redesign releases are published at the top and reach this reader, so redesign-2026-10 is first with nothing seen, and the pages-keep-groups-whole release once the four newer releases are seen.
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: redesign-2026-10 first with nothing seen): the unsubscribe-rack-question-fixes release, published at the top, reaches this reader and comes first until it is seen too; the seen sets below include it.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: unsubscribe-rack-question-fixes-2026-10 with nothing seen): the ended-session-group-page-fixes release, published at the top, reaches every member, so this reader is told it first and the unsubscribe-rack-question-fixes release once it is seen. Claim kept: the same order after them.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: ended-session-group-page-fixes-2026-10 with nothing seen): the manage-order-items-and-app-fixes release, published at the top, reaches every member, so this reader is told it first and the ended-session-group-page-fixes release once it is seen. Claim kept: the same order after them.
    expect(legacyAnnouncementsFor(RELEASES, everyone, {})[0]?.id).toBe(
      'manage-order-items-and-app-fixes-2026-10',
    );
    expect(legacyAnnouncementsFor(RELEASES, everyone, latestSeen())[0]?.id).toBe(
      'ended-session-group-page-fixes-2026-10',
    );
    expect(
      legacyAnnouncementsFor(RELEASES, everyone, { ...latestSeen(), ...topSeen() })[0]?.id,
    ).toBe('unsubscribe-rack-question-fixes-2026-10');
    expect(
      legacyAnnouncementsFor(RELEASES, everyone, {
        ...latestSeen(),
        ...topSeen(),
        ...newestSeen(),
      })[0]?.id,
    ).toBe('redesign-2026-10');
    expect(legacyAnnouncementsFor(RELEASES, everyone, newerSeen)[0]?.id).toBe(
      'pages-keep-groups-whole-2026-10',
    );
    expect(legacyAnnouncementsFor(RELEASES, everyone, groupingSeen)[0]?.id).toBe('returns-history-hand-over-2026-10');
    expect(
      legacyAnnouncementsFor(RELEASES, everyone, { ...groupingSeen, 'returns-history-hand-over-2026-10': true })[0],
    ).toEqual({
      id: ID,
      date: '2026-10-12',
      title: release().title,
      body: release().summary,
      cta: { href: '/dashboard/returns', label: 'Open Returns' },
    });
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: group-selected-2026-10 with nothing seen): the three redesign releases reach the requester, so redesign-2026-10 is first with nothing seen, and Group selected's once they are seen.
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: redesign-2026-10 first with nothing seen): the unsubscribe-rack-question-fixes release, published at the top, reaches this reader and comes first until it is seen too; the seen sets below include it.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: unsubscribe-rack-question-fixes-2026-10 with nothing seen): the ended-session-group-page-fixes release, published at the top, reaches every member, so this reader is told it first and the unsubscribe-rack-question-fixes release once it is seen. Claim kept: the same order after them.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: ended-session-group-page-fixes-2026-10 with nothing seen): the manage-order-items-and-app-fixes release, published at the top, reaches every member, so this reader is told it first and the ended-session-group-page-fixes release once it is seen. Claim kept: the same order after them.
    expect(legacyAnnouncementsFor(RELEASES, requester, {})[0]?.id).toBe(
      'manage-order-items-and-app-fixes-2026-10',
    );
    expect(legacyAnnouncementsFor(RELEASES, requester, latestSeen())[0]?.id).toBe(
      'ended-session-group-page-fixes-2026-10',
    );
    expect(
      legacyAnnouncementsFor(RELEASES, requester, { ...latestSeen(), ...topSeen() })[0]?.id,
    ).toBe('unsubscribe-rack-question-fixes-2026-10');
    expect(
      legacyAnnouncementsFor(RELEASES, requester, {
        ...latestSeen(),
        ...topSeen(),
        ...newestSeen(),
      })[0]?.id,
    ).toBe('redesign-2026-10');
    expect(legacyAnnouncementsFor(RELEASES, requester, redesignSeen())[0]?.id).toBe(
      'group-selected-2026-10',
    );
    expect(legacyAnnouncementsFor(RELEASES, requester, groupingSeen)[0]).toEqual({
      id: ID,
      date: '2026-10-12',
      title: release().title,
      body: release().summary,
    });
    // Publishing it changes what clients observe.
    expect(registryFingerprint(RELEASES)).toContain(`${ID}@1:published`);
    expect(registryFingerprint(RELEASES)).not.toBe(registryFingerprint(RELEASES.filter((r) => r.id !== ID)));
    expect(ANNOUNCEMENTS.map((a) => a.id)).toContain(ID);
    // A real time on a whole minute, after the walk and its audit (the walk
    // ended 2026-10-12 04:45Z, the audit read production 04:51-04:53Z) and
    // after EAS showed the phone update launching on iOS (read 04:58Z): never
    // the draft's placeholder date (2026-10-16T17:10Z).
    expect(release().publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/);
    expect(Date.parse(release().publishedAt)).toBeGreaterThan(Date.parse('2026-10-12T04:58:00Z'));
    expect(Date.parse(release().publishedAt)).toBeLessThanOrEqual(Date.parse('2026-10-13T00:00:00Z'));
  });

  // Drafts sit above the newest published release, newest first. Re-pinned
  // at the returns RX-4 PR stage (2026-10-12; was: "the newest draft, at the
  // top above returns RX-3's" draft): RX-3's release is published (#347, at
  // 2026-10-12T02:07Z), so RX-4's is the only draft, at the top directly
  // above RX-3's release, the newest published one, and dated after every
  // release.
  // Re-pinned by docs/whats-new-returns-close-rest (2026-10-12; was: "is the
  // only draft, at the top directly above returns RX-3's release (the newest
  // published), dated after every release"): published in the same place, it
  // is the newest release, and no draft is left. Claim kept: at the top,
  // directly above returns RX-3's release, dated after every release.
  // Re-pinned by the return history hand-over fix (D-H1, 2026-10-12; was: "is
  // the newest release, at the top directly above returns RX-3's release,
  // dated after every release, and no draft is left"): its draft, dated later
  // still, sits at the top above this one and is the only draft. Claim kept:
  // the newest published release, directly above returns RX-3's release,
  // dated after every release but that draft.
  // Re-pinned by docs/whats-new-return-history-hand-over (2026-10-12; was:
  // "is the newest published release, directly below the return history
  // hand-over draft (the only draft) ..."): that release is published, in
  // the same place, so it is the newest release and no draft is left. Claim
  // kept: directly below it and directly above returns RX-3's release, dated
  // after every release but it.
  // Re-pinned by Ungroup G1 (2026-10-12, rebased onto #354; was: at 1, the
  // return history hand-over release at 0, "and no draft is left"):
  // Ungroup's draft, dated later still, sits at the top above that release
  // and is the only draft. Claim kept: directly below the hand-over release
  // and directly above returns RX-3's release, dated after every release
  // but it and Ungroup's draft.
  // Re-pinned by Group selected G2 (2026-10-12, rebased onto #351; was: at
  // 2, Ungroup's draft at 0 and the only draft): Group selected's draft,
  // dated later still, sits at the top above Ungroup's, so there are two
  // drafts. Claim kept: directly below the hand-over release and directly
  // above returns RX-3's release, dated after every release but it and the
  // two drafts.
  // Re-pinned by the What's New publish of ungroup-2026-10 and
  // group-selected-2026-10 (2026-10-12; was: "... the Group selected and
  // Ungroup drafts at the top ..."): both are published in the same
  // places. Claim kept: the same place, dated as before against the
  // releases around it.
  // Renamed by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: "... and the Ungroup and Group selected releases at the top ..."): the Ungroup follow-ups release (#362) and the pages-keep-groups-whole release are published above them, at the top. Claim kept: the same place, dated as before against the releases around it.
  // Renamed by docs/whats-new-redesign-2026-10 (2026-10-20; was: "... Ungroup follow-ups and pages-keep-groups-whole releases at the top ..."): the parked ai-search-finds-every-item release (#367) and the three redesign releases are published above them, at the top. Claim kept: the same place, dated as before against the releases around it.
  // Renamed by docs/whats-new-2026-10-25 (2026-10-25; was: "... ai-search-finds-every-item and three redesign releases at the top ..."): the unsubscribe-rack-question-fixes release is published above them, at the top. Claim kept: the same place, dated as before against the releases around it.
  // Renamed by docs/whats-new-2026-10-26 (2026-10-26; was: "... three redesign and unsubscribe-rack-question-fixes releases at the top ..."): the ended-session-group-page-fixes release is published above them, at the top. Claim kept: the same place, dated as before against the releases around it.
  // Renamed by docs/whats-new-2026-10-30 (2026-10-30; was: "... unsubscribe-rack-question-fixes and ended-session-group-page-fixes releases at the top ..."): the manage-order-items-and-app-fixes release is published above them, at the top. Claim kept: the same place, dated as before against the releases around it.
  it("sits directly below the return history hand-over release (published later) and directly above returns RX-3's release, dated after every release but that one and the Ungroup, Group selected, Ungroup follow-ups, pages-keep-groups-whole, ai-search-finds-every-item, three redesign, unsubscribe-rack-question-fixes, ended-session-group-page-fixes and manage-order-items-and-app-fixes releases at the top (published later still), and no draft is left", () => {
    // Re-pinned by the B44 phone update draft (fix/b44-update-restart-prompt;
    // was: without it): dated after every release, it sits at the top, so
    // every position below it moves down by one, and it and slice 8's are the
    // drafts.
    // Re-pinned by the small fixes slice 8 draft (fix/small-fixes-8; was:
    // without it): dated after every release, it sits at the top, so every
    // position below it moves down by one, and it is the one draft.
    // Re-pinned by the What's New publish of ungroup-2026-10 and
    // group-selected-2026-10 (2026-10-12; was: the two drafts at the top, the
    // only drafts, and the hand-over release the newest published): both are
    // published in the same places, dated after every release below them, so
    // Group selected's is the newest published release and no draft is left.
    // Re-pinned by docs/whats-new-ungroup-follow-ups (2026-10-12): the Ungroup follow-ups release is published at the top, above Group selected's, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: the Ungroup follow-ups release at 0 and this one at 4): the pages-keep-groups-whole release is published at the top, above the Ungroup follow-ups release, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: the pages-keep-groups-whole release at 0 and this one at 5): the three redesign releases and the parked ai-search-finds-every-item release (#367) are published at the top, above the pages-keep-groups-whole release, so every position below them moves down by four.
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: the redesign and ai-search-finds-every-item releases at 0 to 3, and each position below them one place higher): the unsubscribe-rack-question-fixes release is published at the top, above the redesign releases, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: the unsubscribe-rack-question-fixes release at 0, and each position and slice below it one place higher): the ended-session-group-page-fixes release is published at the top, above it, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: the ended-session-group-page-fixes release at 0, and each position and slice below it one place higher): the manage-order-items-and-app-fixes release is published at the top, above it, so every position below it moves down by one.
    expect(RELEASES[1]?.id).toBe('small-fixes-8-2026-10');
    expect(RELEASES[1]?.status).toBe('draft');
    expect(RELEASES[2]?.id).toBe('manage-order-items-and-app-fixes-2026-10');
    expect(RELEASES[2]?.status).toBe('published');
    expect(RELEASES[3]?.id).toBe('ended-session-group-page-fixes-2026-10');
    expect(RELEASES[3]?.status).toBe('published');
    expect(RELEASES[4]?.id).toBe('unsubscribe-rack-question-fixes-2026-10');
    expect(RELEASES[4]?.status).toBe('published');
    expect(RELEASES.slice(5, 9).map((r) => [r.id, r.status])).toEqual([
      ['redesign-2026-10', 'published'],
      ['redesign-mobile-app-2026-10', 'published'],
      ['redesign-web-fixes-2026-10', 'published'],
      ['ai-search-finds-every-item-2026-10', 'published'],
    ]);
    expect(RELEASES[9]?.id).toBe('pages-keep-groups-whole-2026-10');
    expect(RELEASES[9]?.status).toBe('published');
    expect(RELEASES[10]?.id).toBe('ungroup-follow-ups-2026-10');
    expect(RELEASES[10]?.status).toBe('published');
    expect(RELEASES[11]?.id).toBe('group-selected-2026-10');
    expect(RELEASES[11]?.status).toBe('published');
    expect(RELEASES[12]?.id).toBe('ungroup-2026-10');
    expect(RELEASES[12]?.status).toBe('published');
    expect(Date.parse(RELEASES[11]!.publishedAt)).toBeGreaterThan(
      Date.parse(release().publishedAt),
    );
    expect(Date.parse(RELEASES[12]!.publishedAt)).toBeGreaterThan(
      Date.parse(release().publishedAt),
    );
    expect(RELEASES[13]?.id).toBe('returns-history-hand-over-2026-10');
    expect(RELEASES[13]?.status).toBe('published');
    expect(RELEASES[14]?.id).toBe(ID);
    expect(RELEASES[15]?.id).toBe('returns-requester-exchange-2026-10');
    expect(RELEASES[15]?.status).toBe('published');
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: pages-keep-groups-whole-2026-10): redesign-2026-10 is the newest published release, at the top.
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: redesign-2026-10): the unsubscribe-rack-question-fixes release is published after it, at the top, the newest published release.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: unsubscribe-rack-question-fixes-2026-10): the ended-session-group-page-fixes release is published after it, at the top, the newest published release.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: ended-session-group-page-fixes-2026-10): the manage-order-items-and-app-fixes release is published after it, at the top, the newest published release.
    expect(RELEASES.find((r) => r.status === 'published')?.id).toBe(
      'manage-order-items-and-app-fixes-2026-10',
    );
    // Re-pinned by the What's New publish of ungroup-2026-10 and
    // group-selected-2026-10 (2026-10-12; was: those two drafts): both are
    // published, so no draft is left.
    expect(RELEASES.filter((r) => r.status === 'draft').map((r) => r.id)).toEqual([
      'mobile-app-asks-before-restarting',
      'small-fixes-8-2026-10',
    ]);
    expect(Date.parse(RELEASES[13]!.publishedAt)).toBeGreaterThan(
      Date.parse(release().publishedAt),
    );
    // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: the filter without it): the pages-keep-groups-whole release is published later, at the top.
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: the filter without them): the three redesign releases and the parked ai-search-finds-every-item release (#367) are published later, at the top.
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: the filter without it): the unsubscribe-rack-question-fixes release is published later, at the top.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: the filter without it): the ended-session-group-page-fixes release is published later, at the top.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: the filter without it): the manage-order-items-and-app-fixes release is published later, at the top.
    for (const r of RELEASES.filter(
      (x) =>
        x.id !== ID &&
        x.id !== 'mobile-app-asks-before-restarting' &&
        x.id !== 'small-fixes-8-2026-10' &&
        x.id !== 'returns-history-hand-over-2026-10' &&
        x.id !== 'ungroup-2026-10' &&
        x.id !== 'group-selected-2026-10' &&
        x.id !== 'ungroup-follow-ups-2026-10' &&
        x.id !== 'pages-keep-groups-whole-2026-10' &&
        x.id !== 'ai-search-finds-every-item-2026-10' &&
        x.id !== NEWEST_ID &&
        x.id !== TOP_ID &&
        x.id !== LATEST_ID &&
        !REDESIGN_IDS.includes(x.id),
    )) {
      expect(Date.parse(release().publishedAt), r.id).toBeGreaterThan(Date.parse(r.publishedAt));
    }
  });

  it('tells each change only to the people who meet it', () => {
    const r = release();
    expect(r.audience).toBeUndefined();
    expect(r.entries.map((e) => e.id)).toEqual(['returns-close-replacement-rest', 'returns-exchange-sizes-used-up']);
    // Re-pinned by docs/whats-new-returns-close-rest (2026-10-12; was: a copy
    // forced to published): the release itself is published now.
    expect(r.status).toBe('published');
    const entriesFor = (permissions: ReleaseViewer['permissions'], modules: ModuleId[] = ['returns', 'orders']) =>
      visibleReleases([r], { role: 'staff', permissions, enabledModules: modules })[0]?.entries.map((e) => e.id) ?? [];
    // Whoever can open Returns meets Close the rest (it links there).
    expect(entriesFor(['returns:read'], ['returns'])).toEqual(['returns-close-replacement-rest']);
    expect(entriesFor(['returns:manage', 'orders:approve'])).toEqual(['returns-close-replacement-rest']);
    // A member who places orders, with Returns on, meets the sizes fix.
    expect(entriesFor(['orders:request'])).toEqual(['returns-exchange-sizes-used-up']);
    // Without Returns, nothing; nor for an order approver alone.
    expect(entriesFor(['orders:request', 'returns:read'], ['orders'])).toEqual([]);
    expect(entriesFor(['orders:approve'])).toEqual([]);
    const close = r.entries[0]!;
    expect(close.link).toEqual({ href: '/dashboard/returns', label: 'Open Returns' });
    expect(close.audience).toEqual({ anyPermission: ['returns:read', 'returns:manage'], modules: ['returns'] });
    // The Returns page's own gate: the module, then returns:read or manage.
    const page = readFileSync(resolve(DASHBOARD_APP_DIR, 'dashboard/returns/page.tsx'), 'utf8');
    expect(page).toContain("const moduleAccess = await checkModuleAccess('returns');");
    expect(page).toContain("if (!can(ctx, 'returns:read') && !can(ctx, 'returns:manage')) {");
    const usedUp = r.entries[1]!;
    expect(usedUp.link).toBeUndefined();
    expect(usedUp.audience).toEqual({ anyPermission: ['orders:request'], modules: ['returns'] });
  });

  it('says what the code does: order approval, nothing moved, the reason kept from the requester, the approved return unchanged', () => {
    const r = release();
    const text = [r.title, r.summary, ...r.entries.flatMap((e) => [e.title, e.whatChanged, e.whyItMatters, e.howItAffectsYou, e.whatToDo])].join(' ');
    const close = r.entries[0]!;
    expect(close.whatChanged).toContain('Close the rest once the returned item is received');
    expect(close.howItAffectsYou).toContain('needs order approval permission');
    expect(close.howItAffectsYou).toContain('Nothing moves in stock.');
    expect(close.howItAffectsYou).toContain('never the reason');
    // Fix round 1 (desk check people I3): cancelling the return also cancels
    // the return, so the words say cancelling the return, not the button.
    expect(close.howItAffectsYou).toContain('cancelling the return closes the rest, as before');
    expect(close.howItAffectsYou).toContain('permission to manage returns');
    // Core's words: the button is "Close the rest".
    expect(text).toContain('Close the rest');
    // Fix round 1 (desk checks people M1, complete C9): the line leaves only
    // when every unit already got a replacement, and the warehouse-review
    // request there is refused too (the screens still offer it: deferred).
    const usedUp = r.entries[1]!;
    expect(usedUp.whatChanged).toContain('whose units all got a replacement on an earlier return');
    expect(usedUp.whatChanged).toContain('Choose Return only for it');
    expect(usedUp.whatChanged).toContain('asking the warehouse for a different replacement there is refused too');
    expect(usedUp.whatChanged).not.toContain('can only be returned');
    expect(r.summary).toContain('whose units all got a replacement');
    // Never "book" for a recorded quantity; no inspection claims; no emojis.
    expect(text).not.toMatch(/\bbooks?\b|verified|inspected|certif|guarantee/i);
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
    // Both phone-facing entries say what the phone needs: Close the rest came
    // in the update; the used-up line is the database's answer, so no phone
    // needs one.
    expect(close.whatToDo).toBe(
      'No action needed on the web. In the mobile app, close the app completely and open it again to load the latest update.',
    );
    expect(usedUp.whatToDo).toBe('No action needed.');
    expect(r.summary).toContain('on the web and in the mobile app after the latest update');
  });

  // Corrected at publish (docs/whats-new-returns-close-rest, 2026-10-12), each
  // against 7143ec0f6, the Demo Co walk (walk-rx4) and RX-4's test stage.
  it('says who can close the rest, what it changes and who hears, and where sizes leave, as the code does', () => {
    const r = release();
    const close = r.entries[0]!;
    const usedUp = r.entries[1]!;
    const all = readerText(r).join(' ');
    const migrations = resolve(__dirname, '../../../../../supabase/migrations');
    const sql0397 = readFileSync(resolve(migrations, '0397_returns_followups.sql'), 'utf8');
    const sql0396 = readFileSync(resolve(migrations, '0396_returns_exchange_staff.sql'), 'utf8');
    const sql0390 = readFileSync(resolve(migrations, '0390_approval_follows_permission.sql'), 'utf8');

    // Offered on a received or closed return whose replacement was handed
    // over in part with the rest on backorder; an approved return keeps
    // Cancel return, whose own close ends the rest.
    const facts = {
      exchangeStatus: 'partly_handed_over' as const,
      hasExchange: true,
      replacementClass: 'handed_over' as const,
      hasApprovedExchange: true,
      viewerCanManageReturns: true,
      viewerCanApproveOrders: true,
    };
    const offered = (status: string, replacementClass: 'handed_over' | 'undrawn' = 'handed_over') => {
      const a = availableReturnActions({ ...facts, replacementClass, status });
      return [a.primary, ...a.secondary];
    };
    expect(offered('received')).toContain('close_replacement_rest');
    expect(offered('closed')).toContain('close_replacement_rest');
    expect(offered('approved')).not.toContain('close_replacement_rest');
    expect(offered('approved')).toContain('cancel');
    expect(RETURN_ACTION_LABELS.close_replacement_rest).toBe('Close the rest');
    // Nothing handed over yet: no rest to close.
    expect(offered('closed', 'undrawn')).not.toContain('close_replacement_rest');
    const cancelHook = "elsif v_ostatus = 'backordered' then\n        -- Handed over in part, the rest on backorder: closed as delivered-partial,";
    expect(sql0396).toContain(cancelHook);
    expect(close.howItAffectsYou).toContain(
      'While the return still waits for the returned item, cancelling the return closes the rest, as before.',
    );

    // It needs order approval as well as managing returns, like every
    // replacement action; without order approval the screen says why.
    expect(REPLACEMENT_ACTIONS).toContain('close_replacement_rest');
    const readOnly = availableReturnActions({ ...facts, status: 'closed', viewerCanApproveOrders: false });
    expect([readOnly.primary, ...readOnly.secondary]).not.toContain('close_replacement_rest');
    expect(readOnly.readOnlyReason).toBe(RETURNS_COPY.noOrdersApproveCloseRest);
    expect(availableReturnActions({ ...facts, status: 'closed', viewerCanManageReturns: false }).readOnlyReason).toBe(
      RETURNS_COPY.noManagePermission,
    );
    expect(sql0397).toContain("if not public.has_permission(v_org, 'returns:manage') then");
    expect(sql0397).toContain("if not public.has_permission(v_org, 'orders:approve') then");
    expect(sql0397).toContain("if v_status not in ('received', 'closed') then");
    expect(sql0397).toContain("or public._return_replacement_class(v_live.id) <> 'handed_over' then");
    // A reason is required (1 to 1,000 characters), kept on the return.
    expect(sql0397).toContain('v_reason := public._return_exchange_reason(p_reason, 1000);');
    expect(sql0397).toContain("values (v_org, p_return_id, 'replacement_closed', 'staff', v_live.id, v_reason, v_user, 'staff');");

    // The rest is never sent, what was handed over stays, holds are freed,
    // and nothing moves: close_partial (0390's body, pinned by 0397's
    // preflight) releases the holds and completes the order, and neither
    // function writes a movement.
    expect(sql0390).toContain('md5(prosrc) 2d873a049a5584df7d3a168fb2b45e34 -> a519c3e58fb577c3ff1b30fb3a6cc0ad');
    expect(sql0397).toContain("('public.close_partial(uuid)',                                         'a519c3e58fb577c3ff1b30fb3a6cc0ad', true)");
    const closePartial = sql0390.slice(
      sql0390.indexOf('CREATE OR REPLACE FUNCTION public.close_partial(p_id uuid)'),
      sql0390.indexOf('-- hold_order_stock: restated'),
    );
    expect(closePartial).toContain("set released_at = now(), released_reason = 'closed_partial'");
    expect(closePartial).toContain("set status       = 'completed',");
    expect(closePartial).not.toMatch(/stock_movements|item_stock_levels/);
    const closeFn = sql0397.slice(
      sql0397.indexOf('create function public.close_return_replacement_rest('),
      sql0397.indexOf('revoke all on function public._return_exchange_create'),
    );
    expect(closeFn).toContain('perform public._return_replacement_close_partial(v_live.id);');
    expect(closeFn).not.toMatch(/stock_movements|item_stock_levels/);
    expect(close.whatChanged).toContain(
      'the rest of the replacement is never sent, what was already handed over stays handed over, and anything reserved for the rest is freed.',
    );
    expect(RETURNS_COPY.closeReplacementRestHelp).toBe(
      'The rest of the replacement is never sent. What was already handed over stays handed over.',
    );

    // The return's history keeps the reason; nothing here says when the
    // handed-over part went out (the audit's D-H1: the hand-over line takes
    // the close time; a later fix and its own entry).
    const history = readFileSync(resolve(__dirname, '../../server/services/return-history.ts'), 'utf8');
    expect(history).toContain("const head = so ? `Rest of replacement ${so} closed` : 'Rest of the replacement closed';");
    expect(history).toContain('return d.reason ? `${head}: ${d.reason}` : head;');
    expect(close.whatChanged).toContain('The return keeps the reason in its history.');
    for (const sentence of all.split(/(?<=\.)\s+/)) {
      if (/histor/i.test(sentence)) expect(sentence, sentence).not.toMatch(/\b(when|time|date|went out|at the)\b/i);
    }

    // The replacement order's timeline names the close, on the web only (the
    // phone shows no order timeline).
    const timeline = readFileSync(resolve(__dirname, '../../components/orders/order-timeline.tsx'), 'utf8');
    expect(timeline).toContain("if (event === 'order.closed_partial') return `Rest closed from ${rma ?? 'its RMA'}`;");
    expect(timeline).toContain("lines.push('What was handed over stays. The rest will not be sent.');");
    // Re-pinned by the claims review of #350 (2026-10-12; was: "On the web,
    // the replacement order's timeline says the rest was closed from the
    // return."): the timeline shows only to people who can view the audit
    // log (pinned in the test below). Claim kept: the entry names the
    // timeline line, on the web.
    expect(close.whatChanged).toContain(
      "If you can view the audit log, the replacement order's timeline on the web says the rest was closed from the return.",
    );

    // The requester hears it from the replacement's own notification
    // (completed: ungated) and, with an address on file, the one-time
    // replacement email; neither names the reason, and their own view of the
    // return says the same.
    expect(sql0396).toContain("v_title := 'Your replacement order was closed';");
    expect(sql0396).toContain("v_body := 'Part of it was handed over. The rest will not be sent.';");
    expect(sql0396).toContain('-- completed: ungated, as the original body');
    const service = readFileSync(resolve(__dirname, '../../server/services/returns.ts'), 'utf8');
    expect(service).toContain(
      "await this.recordClosedPartial(id, facts, result.closedOrderId, num(answer.orderNumber), 'return.replacement_closed');",
    );
    const prompt = readFileSync(resolve(__dirname, '../../server/email/return-prompt.ts'), 'utf8');
    expect(prompt).toContain("? 'replacement_closed_partial'");
    expect(exchangeRequesterSentence('completed', { replacementStatus: 'completed', replacementOwed: 1 })).toBe(
      'Part of your replacement was handed over. The rest will not be sent.',
    );
    expect(close.howItAffectsYou).toContain(
      'The requester is told that part of the replacement was handed over and the rest will not be sent, never the reason.',
    );

    // A used-up line leaves the options every requester way reads (the token
    // page, the portal and a member's own order on the web and the phone),
    // and any exchange past the budget is refused, a note-only one too.
    expect(sql0397).toContain(
      "and public._return_exchange_line_budget('00000000-0000-0000-0000-000000000000'::uuid, l.id) > 0);  -- RX-4",
    );
    const requesterReads = readFileSync(resolve(__dirname, '../../server/services/returns-requester.ts'), 'utf8');
    expect(requesterReads).toContain("await admin.rpc('return_exchange_options', { p_order_id: order.orderRequestId });");
    for (const fn of ['exchangeOptionsForToken', 'exchangeOptionsForPortal', 'exchangeOptionsForMember']) {
      expect(requesterReads, fn).toContain(`export async function ${fn}(`);
    }
    const create = sql0397.slice(
      sql0397.indexOf('create or replace function public._return_exchange_create('),
      sql0397.indexOf('-- ── 1b. Used-up lines'),
    );
    expect(create.indexOf("raise exception 'exchange_already_sent'")).toBeGreaterThan(0);
    expect(create.indexOf("raise exception 'exchange_already_sent'")).toBeLessThan(
      create.indexOf("raise exception 'exchange_item_not_eligible'"),
    );
    expect(RETURN_ERROR_WORDS.exchangeAlreadySent).toBe(
      'This item already got a replacement on an earlier return, so it can only be returned now.',
    );
    expect(usedUp.whatChanged).toBe(
      `${RETURNS_COPY.requesterReturnOrExchange} no longer offers other sizes for an item whose units all got a replacement on an earlier return. Choose ${RETURNS_COPY.returnOnly} for it: asking the warehouse for a different replacement there is refused too.`,
    );
    // The staff Create return picker ignores that budget, so the title names
    // Return or exchange and a returns manager is told Create return is
    // unchanged; and the fault was that the refusal came only after sending.
    const candidatesAt = sql0396.indexOf('create function public.return_exchange_candidates(');
    const candidates = sql0396.slice(candidatesAt, sql0396.indexOf('$$;', candidatesAt));
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates).not.toContain('_return_exchange_line_budget');
    expect(usedUp.title).toBe('Return or exchange offers no sizes once every unit of an item got a replacement');
    expect(usedUp.howItAffectsYou).toBe(
      `Every other item offers its sizes as before. If you manage returns, your own orders keep ${RETURNS_COPY.createReturn}, which is unchanged.`,
    );
    expect(usedUp.whyItMatters).toBe('Sizes were offered there, but choosing one was refused only after the request was sent.');
    expect(all).not.toMatch(/\balways\b/i);

    // No line says how a part is handed over (a replacement approved on
    // backorder offers Open replacement, not Get replacement ready).
    expect(all).not.toContain(RETURNS_COPY.getReplacementReady);
  });

  // Corrected by the claims review of #350 (2026-10-12), against 7143ec0f6:
  // the summary goes to every reader an entry reaches (an old phone shows
  // only it and the title), and the used-up entry reaches members who place
  // orders, viewers included, so the summary names who can use Close the
  // rest instead of saying the return offers it. The replacement order's
  // timeline shows only to people who can view the audit log, which Manage
  // returns or View returns does not carry, so its line says so.
  it('names who can use Close the rest in the summary every reader gets, and who sees the timeline line', () => {
    const r = release();
    const close = r.entries[0]!;
    // A member who places orders (viewers included) is told this release,
    // with this summary, and is never offered Close the rest: their own
    // return reads "The rest will follow.".
    expect(PERMISSION_META['orders:request'].description).toBe('Submit a request for goods. Includes viewers.');
    expect(hasPermission('viewer', 'orders:request')).toBe(true);
    const requester: ReleaseViewer = { role: 'viewer', permissions: ['orders:request'], enabledModules: ['returns', 'orders'] };
    expect(visibleReleases([r], requester)[0]?.entries.map((e) => e.id)).toEqual(['returns-exchange-sizes-used-up']);
    expect(buildReleaseList([r], requester, [], null).latestUnread?.id).toBe(ID);
    expect(legacyAnnouncementsFor([r], requester, {})[0]?.body).toBe(r.summary);
    expect(exchangeRequesterSentence('partly_handed_over')).toBe('Part of your replacement was handed over. The rest will follow.');
    for (const role of ['staff', 'viewer'] as const) {
      expect(hasPermission(role, 'returns:manage'), role).toBe(false);
      expect(hasPermission(role, 'orders:approve'), role).toBe(false);
    }
    // Only people who manage returns (the workbench folds in write access to
    // the warehouse) and have order approval are offered it.
    const workbench = readFileSync(resolve(__dirname, '../../server/services/returns-workbench.ts'), 'utf8');
    expect(workbench).toContain("ctx.enabledModules.has('returns') && can(ctx, 'returns:manage') && writeOk;");
    expect(workbench).toContain("canApproveOrders: can(ctx, 'orders:approve'),");
    expect(REPLACEMENT_ACTIONS).toContain('close_replacement_rest');
    expect(r.summary).toMatch(
      /^People who manage returns and have order approval can now use Close the rest when part of an exchange replacement was handed over and the rest is on backorder, once the returned item is in, on the web and in the mobile app after the latest update\. /,
    );
    expect(r.summary).not.toMatch(/the return now offers/i);

    // The order page passes activity_logs:read ("View audit log") to the
    // timeline, which shows anyone else a sentence instead. Managers hold it
    // by default; a member granted View returns or Manage returns need not.
    const orderPage = readFileSync(resolve(DASHBOARD_APP_DIR, 'dashboard/orders/[id]/page.tsx'), 'utf8');
    expect(orderPage).toContain("canReadActivity={can(ctx, 'activity_logs:read')}");
    const timeline = readFileSync(resolve(__dirname, '../../components/orders/order-timeline.tsx'), 'utf8');
    expect(timeline).toContain('if (!canReadActivity) {');
    expect(timeline).toContain(JSON.stringify("Only people who can view the audit log can see this order's history."));
    expect(PERMISSION_META['activity_logs:read'].label).toBe('View audit log');
    expect(hasPermission('manager', 'activity_logs:read')).toBe(true);
    expect(hasPermission('staff', 'activity_logs:read')).toBe(false);
    const returnsOnly: ReleaseViewer = { role: 'staff', permissions: ['returns:read'], enabledModules: ['returns'] };
    expect(visibleReleases([r], returnsOnly)[0]?.entries.map((e) => e.id)).toEqual(['returns-close-replacement-rest']);
    expect(close.whatChanged).toMatch(
      /If you can view the audit log, the replacement order's timeline on the web says the rest was closed from the return\.$/,
    );
    expect(close.whatChanged).not.toMatch(/On the web, the replacement order's timeline/);
  });
});

/**
 * Returns RX-3 (no migration: the requester's own exchange, Busy. Try again.
 * on order actions, the size S label and the PR-stage polish): held as a
 * DRAFT until its web deploy was live, the OTA with the phone's requester
 * sheet was published and launched, and the Demo Co walk passed (returns
 * plan 10.1 and 11). Pinned by id.
 *
 * Re-pinned by docs/whats-new-returns-requester (RX-5, 2026-10-12; was:
 * "requesters ask for an exchange themselves (returns RX-3) is held as a
 * draft"): #346 merged (bd37d5a30) and its web build 3dbc11a7ebb5 went live,
 * OTA group baf22731 (iOS 01a12d9b) was published and had launched on iOS (1
 * launch, 0 failed, read 01:47Z), and the Demo Co walk passed with its audit
 * CONFIRMED, so the release is published. The requester's own screens (the
 * web order page's entry, the phone's sheet and card) were not walked in
 * production (the demo account manages returns, so they are hidden from it
 * by design); their evidence is RX-3's test stage, recorded in the release.
 *
 * Moved back above its own describe by docs/whats-new-returns-close-rest
 * (2026-10-12): returns RX-4's describe had been added between this comment
 * and the describe it belongs to.
 */
describe('requesters ask for an exchange themselves (returns RX-3) is published', () => {
  const ID = 'returns-requester-exchange-2026-10';
  const release = () => RELEASES.find((r) => r.id === ID)!;
  const everyone: ReleaseViewer = {
    role: 'owner',
    permissions: [...PERMISSIONS],
    enabledModules: Object.keys(MODULE_REGISTRY) as ModuleId[],
  };

  // Re-pinned by docs/whats-new-returns-requester (2026-10-12; was: "is a
  // draft, so no feed carries it, and preparing it changes nothing a client
  // can observe": a draft, in no feed, no legacy list and no fingerprint).
  it('is published after the web deploy, the phone update and the Demo Co walk, so every feed it reaches carries it', () => {
    expect(release()).toBeDefined();
    expect(release().status).toBe('published');
    expect(release().revision).toBe(1);
    expect(visibleReleases(RELEASES, everyone).map((r) => r.id)).toContain(ID);
    const list = buildReleaseList(RELEASES, everyone, [], null);
    expect(list.releases.map((r) => r.id)).toContain(ID);
    // The newest release, so it is the notice for whoever it reaches: an
    // owner with every module, a member who places orders, someone who can
    // only open Returns, and an order approver.
    // Re-pinned by docs/whats-new-returns-close-rest (2026-10-12; was: ID
    // for all four readers, with nothing read): returns RX-4's release,
    // published later, reaches the owner, the member who places orders and
    // whoever can open Returns, so it is their notice, and this one is once it
    // is read. It reaches no order approver alone, whose notice this one
    // stays. Claim kept: this one is the notice for whoever it reaches, after
    // RX-4's.
    // Re-pinned by docs/whats-new-return-history-hand-over (2026-10-12; was:
    // RX-4's release the notice for the owner, the member who places orders
    // and whoever can open Returns, this one once it is read): the return
    // history hand-over release, published later still, reaches the owner
    // and whoever can open Returns, so it is their notice, RX-4's once it is
    // read, and this one once both are. It reaches neither the member who
    // places orders nor the order approver, so their lines are unchanged.
    // Claim kept: this one is the notice for whoever it reaches, after the
    // newer returns releases.
    // Re-pinned by the What's New publish of ungroup-2026-10 and
    // group-selected-2026-10 (2026-10-12; was: with nothing newer read):
    // Group selected's release (reaching every member) and Ungroup's
    // (reaching whoever can edit items) are newer, so the reads and seen
    // sets below include them, and a reader with nothing read is told Group
    // selected's first. Claim kept: this one is the notice for whoever it
    // reaches, after the newer releases.
    const groupingRead = [
      // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: the reads without them): the three redesign
      // releases and the parked ai-search-finds-every-item release (#367), published at the top, are read too, so the
      // releases after them keep the order this test checks. The redesign releases reach every member, the requester,
      // returnsOnly and the approver below included, so their first notices are re-pinned below; the
      // ai-search-finds-every-item release reaches none of them.
      ...redesignReads(),
      {
        release_id: 'ai-search-finds-every-item-2026-10',
        revision: 1,
        dismissed_at: null,
        opened_at: '2026-10-20T13:00:00Z',
        read_at: '2026-10-20T13:00:00Z',
      },
      // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: the reads without it): the pages-keep-groups-whole
      // release, published at the top, is read too, so the releases after it keep the order this test checks; it reaches
      // none of the requester, returnsOnly, the approver or the member below, so their lines are unchanged.
      {
        release_id: 'pages-keep-groups-whole-2026-10',
        revision: 1,
        dismissed_at: null,
        opened_at: '2026-10-12T21:41:00Z',
        read_at: '2026-10-12T21:41:00Z',
      },
      // Re-pinned by docs/whats-new-ungroup-follow-ups (2026-10-12): the Ungroup follow-ups release, published at the
      // top, is read too, so the releases after it keep the order this test checks.
      {
        release_id: 'ungroup-follow-ups-2026-10',
        revision: 1,
        dismissed_at: null,
        opened_at: '2026-10-12T17:51:00Z',
        read_at: '2026-10-12T17:51:00Z',
      },
      {
        release_id: 'group-selected-2026-10',
        revision: 1,
        dismissed_at: null,
        opened_at: '2026-10-12T13:48:00Z',
        read_at: '2026-10-12T13:48:00Z',
      },
      {
        release_id: 'ungroup-2026-10',
        revision: 1,
        dismissed_at: null,
        opened_at: '2026-10-12T13:48:00Z',
        read_at: '2026-10-12T13:48:00Z',
      },
    ];
    const rx4Read = [
      {
        release_id: 'returns-close-rest-2026-10',
        revision: 1,
        dismissed_at: null,
        opened_at: '2026-10-12T06:00:00Z',
        read_at: '2026-10-12T06:00:00Z',
      },
      ...groupingRead,
    ];
    const handOverRead = [
      { ...rx4Read[0]!, release_id: 'returns-history-hand-over-2026-10', opened_at: '2026-10-12T09:00:00Z', read_at: '2026-10-12T09:00:00Z' },
      ...groupingRead,
    ];
    // Re-pinned by the What's New publish of ungroup-2026-10 and
    // group-selected-2026-10 (2026-10-12): was returns-history-hand-over-2026-10.
    // Group selected's release is published after it (a minute after
    // Ungroup's) and reaches every member, so this reader (an owner with
    // every module) is told it first.
    // Re-pinned by docs/whats-new-ungroup-follow-ups (2026-10-12; was: group-selected-2026-10): the Ungroup follow-ups release is published after it, at the top and reaches this reader.
    // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: ungroup-follow-ups-2026-10): the pages-keep-groups-whole release is published after it, at the top, and reaches this reader.
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: pages-keep-groups-whole-2026-10): the parked ai-search-finds-every-item release (#367) and the three redesign releases are published after it, at the top, and redesign-2026-10, the newest, reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: redesign-2026-10): the unsubscribe-rack-question-fixes release is published after it, at the top, and reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: unsubscribe-rack-question-fixes-2026-10): the ended-session-group-page-fixes release is published after it, at the top, and reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: ended-session-group-page-fixes-2026-10): the manage-order-items-and-app-fixes release is published after it, at the top, and reaches every member, this reader included.
    expect(list.latestUnread?.id).toBe('manage-order-items-and-app-fixes-2026-10');
    expect(buildReleaseList(RELEASES, everyone, handOverRead, null).latestUnread?.id).toBe('returns-close-rest-2026-10');
    expect(buildReleaseList(RELEASES, everyone, [...handOverRead, ...rx4Read], null).latestUnread?.id).toBe(ID);
    const requester: ReleaseViewer = { role: 'viewer', permissions: ['orders:request'], enabledModules: ['returns', 'orders'] };
    expect(visibleReleases(RELEASES, requester).map((r) => r.id)).not.toContain('returns-history-hand-over-2026-10');
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: group-selected-2026-10 first for the requester,
    // returnsOnly and the approver with nothing read): the three redesign releases reach every member, so each is
    // told redesign-2026-10 first, and Group selected's once those are read. Claim kept: the same order after it.
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: redesign-2026-10 with nothing read): the unsubscribe-rack-question-fixes release, published at the top, reaches every member, so this reader is told it first and redesign-2026-10 once it is read; the reads and seen sets below include it.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: unsubscribe-rack-question-fixes-2026-10 with nothing read): the ended-session-group-page-fixes release, published at the top, reaches every member, so this reader is told it first and the unsubscribe-rack-question-fixes release once it is read. Claim kept: the same order after them.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: ended-session-group-page-fixes-2026-10 with nothing read): the manage-order-items-and-app-fixes release, published at the top, reaches every member, so this reader is told it first and the ended-session-group-page-fixes release once it is read. Claim kept: the same order after them.
    expect(buildReleaseList(RELEASES, requester, [], null).latestUnread?.id).toBe(
      'manage-order-items-and-app-fixes-2026-10',
    );
    expect(buildReleaseList(RELEASES, requester, [latestRead()], null).latestUnread?.id).toBe(
      'ended-session-group-page-fixes-2026-10',
    );
    expect(
      buildReleaseList(RELEASES, requester, [latestRead(), topRead()], null).latestUnread?.id,
    ).toBe('unsubscribe-rack-question-fixes-2026-10');
    expect(
      buildReleaseList(RELEASES, requester, [latestRead(), topRead(), newestRead()], null)
        .latestUnread?.id,
    ).toBe('redesign-2026-10');
    expect(buildReleaseList(RELEASES, requester, redesignReads(), null).latestUnread?.id).toBe(
      'group-selected-2026-10',
    );
    expect(buildReleaseList(RELEASES, requester, groupingRead, null).latestUnread?.id).toBe('returns-close-rest-2026-10');
    expect(buildReleaseList(RELEASES, requester, rx4Read, null).latestUnread?.id).toBe(ID);
    const returnsOnly: ReleaseViewer = { role: 'staff', permissions: ['returns:read'], enabledModules: ['returns'] };
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: redesign-2026-10 with nothing read): the unsubscribe-rack-question-fixes release, published at the top, reaches every member, so this reader is told it first and redesign-2026-10 once it is read; the reads and seen sets below include it.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: unsubscribe-rack-question-fixes-2026-10 with nothing read): the ended-session-group-page-fixes release, published at the top, reaches every member, so this reader is told it first and the unsubscribe-rack-question-fixes release once it is read. Claim kept: the same order after them.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: ended-session-group-page-fixes-2026-10 with nothing read): the manage-order-items-and-app-fixes release, published at the top, reaches every member, so this reader is told it first and the ended-session-group-page-fixes release once it is read. Claim kept: the same order after them.
    expect(buildReleaseList(RELEASES, returnsOnly, [], null).latestUnread?.id).toBe(
      'manage-order-items-and-app-fixes-2026-10',
    );
    expect(buildReleaseList(RELEASES, returnsOnly, [latestRead()], null).latestUnread?.id).toBe(
      'ended-session-group-page-fixes-2026-10',
    );
    expect(
      buildReleaseList(RELEASES, returnsOnly, [latestRead(), topRead()], null).latestUnread?.id,
    ).toBe('unsubscribe-rack-question-fixes-2026-10');
    expect(
      buildReleaseList(RELEASES, returnsOnly, [latestRead(), topRead(), newestRead()], null)
        .latestUnread?.id,
    ).toBe('redesign-2026-10');
    expect(buildReleaseList(RELEASES, returnsOnly, redesignReads(), null).latestUnread?.id).toBe(
      'group-selected-2026-10',
    );
    expect(buildReleaseList(RELEASES, returnsOnly, groupingRead, null).latestUnread?.id).toBe('returns-history-hand-over-2026-10');
    expect(buildReleaseList(RELEASES, returnsOnly, handOverRead, null).latestUnread?.id).toBe('returns-close-rest-2026-10');
    expect(buildReleaseList(RELEASES, returnsOnly, [...handOverRead, ...rx4Read], null).latestUnread?.id).toBe(ID);
    const approver: ReleaseViewer = { role: 'staff', permissions: ['orders:approve'], enabledModules: ['returns', 'orders'] };
    expect(visibleReleases(RELEASES, approver).map((r) => r.id)).not.toContain('returns-history-hand-over-2026-10');
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: redesign-2026-10 with nothing read): the unsubscribe-rack-question-fixes release, published at the top, reaches every member, so this reader is told it first and redesign-2026-10 once it is read; the reads and seen sets below include it.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: unsubscribe-rack-question-fixes-2026-10 with nothing read): the ended-session-group-page-fixes release, published at the top, reaches every member, so this reader is told it first and the unsubscribe-rack-question-fixes release once it is read. Claim kept: the same order after them.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: ended-session-group-page-fixes-2026-10 with nothing read): the manage-order-items-and-app-fixes release, published at the top, reaches every member, so this reader is told it first and the ended-session-group-page-fixes release once it is read. Claim kept: the same order after them.
    expect(buildReleaseList(RELEASES, approver, [], null).latestUnread?.id).toBe(
      'manage-order-items-and-app-fixes-2026-10',
    );
    expect(buildReleaseList(RELEASES, approver, [latestRead()], null).latestUnread?.id).toBe(
      'ended-session-group-page-fixes-2026-10',
    );
    expect(
      buildReleaseList(RELEASES, approver, [latestRead(), topRead()], null).latestUnread?.id,
    ).toBe('unsubscribe-rack-question-fixes-2026-10');
    expect(
      buildReleaseList(RELEASES, approver, [latestRead(), topRead(), newestRead()], null)
        .latestUnread?.id,
    ).toBe('redesign-2026-10');
    expect(buildReleaseList(RELEASES, approver, redesignReads(), null).latestUnread?.id).toBe(
      'group-selected-2026-10',
    );
    expect(buildReleaseList(RELEASES, approver, groupingRead, null).latestUnread?.id).toBe(ID);
    // A member with no permission is told nothing.
    const member: ReleaseViewer = { role: 'viewer', permissions: [], enabledModules: ['returns', 'orders'] };
    expect(visibleReleases(RELEASES, member).map((r) => r.id)).not.toContain(ID);
    // An old phone build lists it first, with the Returns link for whoever
    // can open Returns, and with no link for a requester, whose entries link
    // nothing (an order page is per order).
    // Re-pinned by docs/whats-new-returns-close-rest (2026-10-12; was: first
    // with nothing seen): returns RX-4's release is newer and reaches both
    // readers, so the list is read with it seen. Claim kept: this one first,
    // with or without the link.
    // Re-pinned by docs/whats-new-return-history-hand-over (2026-10-12; was:
    // the owner's list read with RX-4's release seen): the return history
    // hand-over release is newer still and reaches the owner, so the owner's
    // list is read with both seen; it never reaches the requester, whose
    // lines are unchanged. Claim kept: this one first, with or without the
    // link.
    // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: the seen set without it): the pages-keep-groups-whole release is published at the top and reaches the owner, so it is seen here too and the order this test checks holds.
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: the seen set without them): the three redesign releases and the ai-search-finds-every-item release are published at the top and reach the owner (the requester the redesign releases), so they are seen here too and the order this test checks holds.
    const newerSeen = { ...redesignSeen(), 'ai-search-finds-every-item-2026-10': true };
    const groupingSeen = {
      ...newerSeen,
      'group-selected-2026-10': true,
      'ungroup-2026-10': true,
      'ungroup-follow-ups-2026-10': true,
      'pages-keep-groups-whole-2026-10': true,
    };
    const rx4Seen = { 'returns-close-rest-2026-10': true, ...groupingSeen };
    // Re-pinned by docs/whats-new-ungroup-follow-ups (2026-10-12): the Ungroup follow-ups release is published at the top and reaches this reader, so it is read or seen here too and the order this test checks holds.
    // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: ungroup-follow-ups-2026-10): the pages-keep-groups-whole release is published at the top and reaches this reader, so it is first with nothing seen.
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: pages-keep-groups-whole-2026-10 with nothing seen): the three redesign releases are published at the top and reach this reader, so redesign-2026-10 is first with nothing seen, and the pages-keep-groups-whole release once the four newer releases are seen.
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: redesign-2026-10 first with nothing seen): the unsubscribe-rack-question-fixes release, published at the top, reaches this reader and comes first until it is seen too; the seen sets below include it.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: unsubscribe-rack-question-fixes-2026-10 with nothing seen): the ended-session-group-page-fixes release, published at the top, reaches every member, so this reader is told it first and the unsubscribe-rack-question-fixes release once it is seen. Claim kept: the same order after them.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: ended-session-group-page-fixes-2026-10 with nothing seen): the manage-order-items-and-app-fixes release, published at the top, reaches every member, so this reader is told it first and the ended-session-group-page-fixes release once it is seen. Claim kept: the same order after them.
    expect(legacyAnnouncementsFor(RELEASES, everyone, {})[0]?.id).toBe(
      'manage-order-items-and-app-fixes-2026-10',
    );
    expect(legacyAnnouncementsFor(RELEASES, everyone, latestSeen())[0]?.id).toBe(
      'ended-session-group-page-fixes-2026-10',
    );
    expect(
      legacyAnnouncementsFor(RELEASES, everyone, { ...latestSeen(), ...topSeen() })[0]?.id,
    ).toBe('unsubscribe-rack-question-fixes-2026-10');
    expect(
      legacyAnnouncementsFor(RELEASES, everyone, {
        ...latestSeen(),
        ...topSeen(),
        ...newestSeen(),
      })[0]?.id,
    ).toBe('redesign-2026-10');
    expect(legacyAnnouncementsFor(RELEASES, everyone, newerSeen)[0]?.id).toBe(
      'pages-keep-groups-whole-2026-10',
    );
    expect(legacyAnnouncementsFor(RELEASES, everyone, groupingSeen)[0]?.id).toBe('returns-history-hand-over-2026-10');
    expect(legacyAnnouncementsFor(RELEASES, everyone, rx4Seen)[0]?.id).toBe('returns-history-hand-over-2026-10');
    expect(legacyAnnouncementsFor(RELEASES, everyone, { ...rx4Seen, 'returns-history-hand-over-2026-10': true })[0]).toEqual({
      id: ID,
      date: '2026-10-12',
      title: release().title,
      body: release().summary,
      cta: { href: '/dashboard/returns', label: 'Open Returns' },
    });
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: group-selected-2026-10 with nothing seen): the three redesign releases reach the requester, so redesign-2026-10 is first with nothing seen, and Group selected's once they are seen.
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: redesign-2026-10 first with nothing seen): the unsubscribe-rack-question-fixes release, published at the top, reaches this reader and comes first until it is seen too; the seen sets below include it.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: unsubscribe-rack-question-fixes-2026-10 with nothing seen): the ended-session-group-page-fixes release, published at the top, reaches every member, so this reader is told it first and the unsubscribe-rack-question-fixes release once it is seen. Claim kept: the same order after them.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: ended-session-group-page-fixes-2026-10 with nothing seen): the manage-order-items-and-app-fixes release, published at the top, reaches every member, so this reader is told it first and the ended-session-group-page-fixes release once it is seen. Claim kept: the same order after them.
    expect(legacyAnnouncementsFor(RELEASES, requester, {})[0]?.id).toBe(
      'manage-order-items-and-app-fixes-2026-10',
    );
    expect(legacyAnnouncementsFor(RELEASES, requester, latestSeen())[0]?.id).toBe(
      'ended-session-group-page-fixes-2026-10',
    );
    expect(
      legacyAnnouncementsFor(RELEASES, requester, { ...latestSeen(), ...topSeen() })[0]?.id,
    ).toBe('unsubscribe-rack-question-fixes-2026-10');
    expect(
      legacyAnnouncementsFor(RELEASES, requester, {
        ...latestSeen(),
        ...topSeen(),
        ...newestSeen(),
      })[0]?.id,
    ).toBe('redesign-2026-10');
    expect(legacyAnnouncementsFor(RELEASES, requester, redesignSeen())[0]?.id).toBe(
      'group-selected-2026-10',
    );
    expect(legacyAnnouncementsFor(RELEASES, requester, groupingSeen)[0]?.id).toBe('returns-close-rest-2026-10');
    expect(legacyAnnouncementsFor(RELEASES, requester, rx4Seen)[0]).toEqual({
      id: ID,
      date: '2026-10-12',
      title: release().title,
      body: release().summary,
    });
    // Publishing it changes what clients observe.
    expect(registryFingerprint(RELEASES)).toContain(`${ID}@1:published`);
    expect(registryFingerprint(RELEASES)).not.toBe(registryFingerprint(RELEASES.filter((r) => r.id !== ID)));
    expect(ANNOUNCEMENTS.map((a) => a.id)).toContain(ID);
    // A real time on a whole minute, after the walk's audit (the walk ended
    // 2026-10-12 01:38:44Z) and after EAS showed the phone update launching
    // on iOS (read 01:47Z): never the draft's placeholder date
    // (2026-10-15T17:10Z).
    expect(release().publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/);
    expect(Date.parse(release().publishedAt)).toBeGreaterThan(Date.parse('2026-10-12T01:47:00Z'));
    expect(Date.parse(release().publishedAt)).toBeLessThanOrEqual(Date.parse('2026-10-13T00:00:00Z'));
  });

  // Drafts sit above the newest published release, newest first. Re-pinned
  // at the RX-3 PR stage (2026-10-11; was: "the newest draft, at the top
  // above returns RX-2's" draft): RX-2's release is published (#345), so
  // RX-3's is the only draft, at the top directly above RX-2's release, the
  // newest published one, and dated after every release.
  // Re-pinned by docs/whats-new-returns-requester (2026-10-12; was: "is the
  // only draft, at the top directly above returns RX-2's release (the newest
  // published), dated after every release"): published in the same place,
  // it is the newest release, and no draft is left. Claim kept: at the top,
  // directly above returns RX-2's release, dated after every release.
  // Re-pinned by returns RX-4 (2026-10-12; was: "is the newest release, at
  // the top ..., and no draft is left", at 0): RX-4's draft, dated later
  // still, sits at the top above it and is the only draft. Claim kept: the
  // newest published release, directly above returns RX-2's release, dated
  // after every release but RX-4's draft.
  // Re-pinned by docs/whats-new-returns-close-rest (2026-10-12; was: "is the
  // newest published release, directly below the returns RX-4 draft (the
  // only draft) ..."): RX-4's release is published, in the same place, so it
  // is the newest release and no draft is left. Claim kept: directly below
  // RX-4's release and directly above returns RX-2's release, dated after
  // every release but RX-4's.
  // Re-pinned by the return history hand-over fix (D-H1, 2026-10-12; was: at
  // 1, RX-4's release at 0, "and no draft is left"): its draft, dated later
  // still, sits at the top above RX-4's release and is the only draft. Claim
  // kept: directly below RX-4's release and directly above returns RX-2's
  // release, dated after every release but RX-4's and that draft.
  // Re-pinned by docs/whats-new-return-history-hand-over (2026-10-12; was:
  // "... and the return history hand-over draft at the top, the only
  // draft"): its release is published, in the same place, so it is the
  // newest release and no draft is left. Claim kept: directly below RX-4's
  // release and directly above returns RX-2's release, dated after every
  // release but RX-4's and the hand-over release.
  // Re-pinned by Ungroup G1 (2026-10-12, rebased onto #354; was: at 2, the
  // return history hand-over release at 0, "and no draft is left"):
  // Ungroup's draft, dated later still, sits at the top above the hand-over
  // release and is the only draft. Claim kept: directly below RX-4's release
  // and directly above returns RX-2's release, dated after every release but
  // RX-4's, the hand-over release and Ungroup's draft.
  // Re-pinned by Group selected G2 (2026-10-12, rebased onto #351; was: at
  // 3, Ungroup's draft at 0 and the only draft): Group selected's draft,
  // dated later still, sits at the top above Ungroup's, so there are two
  // drafts. Claim kept: directly below RX-4's release and directly above
  // returns RX-2's release, dated after every release but RX-4's, the
  // hand-over release and the two drafts.
  // Re-pinned by the What's New publish of ungroup-2026-10 and
  // group-selected-2026-10 (2026-10-12; was: "... the Group selected and
  // Ungroup drafts at the top ..."): both are published in the same
  // places. Claim kept: the same place, dated as before against the
  // releases around it.
  // Renamed by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: "... and the Ungroup and Group selected releases at the top ..."): the Ungroup follow-ups release (#362) and the pages-keep-groups-whole release are published above them, at the top. Claim kept: the same place, dated as before against the releases around it.
  // Renamed by docs/whats-new-redesign-2026-10 (2026-10-20; was: "... Ungroup follow-ups and pages-keep-groups-whole releases at the top ..."): the parked ai-search-finds-every-item release (#367) and the three redesign releases are published above them, at the top. Claim kept: the same place, dated as before against the releases around it.
  // Renamed by docs/whats-new-2026-10-25 (2026-10-25; was: "... ai-search-finds-every-item and three redesign releases at the top ..."): the unsubscribe-rack-question-fixes release is published above them, at the top. Claim kept: the same place, dated as before against the releases around it.
  // Renamed by docs/whats-new-2026-10-26 (2026-10-26; was: "... three redesign and unsubscribe-rack-question-fixes releases at the top ..."): the ended-session-group-page-fixes release is published above them, at the top. Claim kept: the same place, dated as before against the releases around it.
  // Renamed by docs/whats-new-2026-10-30 (2026-10-30; was: "... unsubscribe-rack-question-fixes and ended-session-group-page-fixes releases at the top ..."): the manage-order-items-and-app-fixes release is published above them, at the top. Claim kept: the same place, dated as before against the releases around it.
  it("sits directly below returns RX-4's release, with the return history hand-over release above that (both published later), and directly above returns RX-2's release, dated after every release but those two and the Ungroup, Group selected, Ungroup follow-ups, pages-keep-groups-whole, ai-search-finds-every-item, three redesign, unsubscribe-rack-question-fixes, ended-session-group-page-fixes and manage-order-items-and-app-fixes releases at the top (published later still), and no draft is left", () => {
    // Re-pinned by the B44 phone update draft (fix/b44-update-restart-prompt;
    // was: without it): dated after every release, it sits at the top, so
    // every position below it moves down by one, and it and slice 8's are the
    // drafts.
    // Re-pinned by the small fixes slice 8 draft (fix/small-fixes-8; was:
    // without it): dated after every release, it sits at the top, so every
    // position below it moves down by one, and it is the one draft.
    // Re-pinned by the What's New publish of ungroup-2026-10 and
    // group-selected-2026-10 (2026-10-12; was: the two drafts at the top, the
    // only drafts, and the hand-over release the newest published): both are
    // published in the same places, dated after every release below them, so
    // Group selected's is the newest published release and no draft is left.
    // Re-pinned by docs/whats-new-ungroup-follow-ups (2026-10-12): the Ungroup follow-ups release is published at the top, above Group selected's, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: the Ungroup follow-ups release at 0 and this one at 5): the pages-keep-groups-whole release is published at the top, above the Ungroup follow-ups release, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: the pages-keep-groups-whole release at 0 and this one at 6): the three redesign releases and the parked ai-search-finds-every-item release (#367) are published at the top, above the pages-keep-groups-whole release, so every position below them moves down by four.
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: the redesign and ai-search-finds-every-item releases at 0 to 3, and each position below them one place higher): the unsubscribe-rack-question-fixes release is published at the top, above the redesign releases, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: the unsubscribe-rack-question-fixes release at 0, and each position and slice below it one place higher): the ended-session-group-page-fixes release is published at the top, above it, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: the ended-session-group-page-fixes release at 0, and each position and slice below it one place higher): the manage-order-items-and-app-fixes release is published at the top, above it, so every position below it moves down by one.
    expect(RELEASES[1]?.id).toBe('small-fixes-8-2026-10');
    expect(RELEASES[1]?.status).toBe('draft');
    expect(RELEASES[2]?.id).toBe('manage-order-items-and-app-fixes-2026-10');
    expect(RELEASES[2]?.status).toBe('published');
    expect(RELEASES[3]?.id).toBe('ended-session-group-page-fixes-2026-10');
    expect(RELEASES[3]?.status).toBe('published');
    expect(RELEASES[4]?.id).toBe('unsubscribe-rack-question-fixes-2026-10');
    expect(RELEASES[4]?.status).toBe('published');
    expect(RELEASES.slice(5, 9).map((r) => [r.id, r.status])).toEqual([
      ['redesign-2026-10', 'published'],
      ['redesign-mobile-app-2026-10', 'published'],
      ['redesign-web-fixes-2026-10', 'published'],
      ['ai-search-finds-every-item-2026-10', 'published'],
    ]);
    expect(RELEASES[9]?.id).toBe('pages-keep-groups-whole-2026-10');
    expect(RELEASES[9]?.status).toBe('published');
    expect(RELEASES[10]?.id).toBe('ungroup-follow-ups-2026-10');
    expect(RELEASES[10]?.status).toBe('published');
    expect(RELEASES[11]?.id).toBe('group-selected-2026-10');
    expect(RELEASES[11]?.status).toBe('published');
    expect(RELEASES[12]?.id).toBe('ungroup-2026-10');
    expect(RELEASES[12]?.status).toBe('published');
    expect(Date.parse(RELEASES[11]!.publishedAt)).toBeGreaterThan(
      Date.parse(release().publishedAt),
    );
    expect(Date.parse(RELEASES[12]!.publishedAt)).toBeGreaterThan(
      Date.parse(release().publishedAt),
    );
    expect(RELEASES[13]?.id).toBe('returns-history-hand-over-2026-10');
    expect(RELEASES[13]?.status).toBe('published');
    expect(RELEASES[14]?.id).toBe('returns-close-rest-2026-10');
    expect(RELEASES[14]?.status).toBe('published');
    expect(RELEASES[15]?.id).toBe(ID);
    expect(RELEASES[16]?.id).toBe('returns-exchange-2026-10');
    expect(RELEASES[16]?.status).toBe('published');
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: pages-keep-groups-whole-2026-10): redesign-2026-10 is the newest published release, at the top.
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: redesign-2026-10): the unsubscribe-rack-question-fixes release is published after it, at the top, the newest published release.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: unsubscribe-rack-question-fixes-2026-10): the ended-session-group-page-fixes release is published after it, at the top, the newest published release.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: ended-session-group-page-fixes-2026-10): the manage-order-items-and-app-fixes release is published after it, at the top, the newest published release.
    expect(RELEASES.find((r) => r.status === 'published')?.id).toBe(
      'manage-order-items-and-app-fixes-2026-10',
    );
    // Re-pinned by the What's New publish of ungroup-2026-10 and
    // group-selected-2026-10 (2026-10-12; was: those two drafts): both are
    // published, so no draft is left.
    expect(RELEASES.filter((r) => r.status === 'draft').map((r) => r.id)).toEqual([
      'mobile-app-asks-before-restarting',
      'small-fixes-8-2026-10',
    ]);
    expect(Date.parse(RELEASES[13]!.publishedAt)).toBeGreaterThan(
      Date.parse(release().publishedAt),
    );
    expect(Date.parse(RELEASES[14]!.publishedAt)).toBeGreaterThan(
      Date.parse(release().publishedAt),
    );
    // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: the filter without it): the pages-keep-groups-whole release is published later, at the top.
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: the filter without them): the three redesign releases and the parked ai-search-finds-every-item release (#367) are published later, at the top.
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: the filter without it): the unsubscribe-rack-question-fixes release is published later, at the top.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: the filter without it): the ended-session-group-page-fixes release is published later, at the top.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: the filter without it): the manage-order-items-and-app-fixes release is published later, at the top.
    for (const r of RELEASES.filter(
      (x) =>
        x.id !== ID &&
        x.id !== 'mobile-app-asks-before-restarting' &&
        x.id !== 'small-fixes-8-2026-10' &&
        x.id !== 'returns-close-rest-2026-10' &&
        x.id !== 'returns-history-hand-over-2026-10' &&
        x.id !== 'ungroup-2026-10' &&
        x.id !== 'group-selected-2026-10' &&
        x.id !== 'ungroup-follow-ups-2026-10' &&
        x.id !== 'pages-keep-groups-whole-2026-10' &&
        x.id !== 'ai-search-finds-every-item-2026-10' &&
        x.id !== NEWEST_ID &&
        x.id !== TOP_ID &&
        x.id !== LATEST_ID &&
        !REDESIGN_IDS.includes(x.id),
    )) {
      expect(Date.parse(release().publishedAt), r.id).toBeGreaterThan(Date.parse(r.publishedAt));
    }
  });

  it('tells each change only to the people who meet it', () => {
    const r = release();
    expect(r.audience).toBeUndefined();
    // Re-pinned at the RX-3 PR stage (2026-10-11; was: four entries): the
    // PR-stage polish adds two, the exchange outcome words (polish a, b, d,
    // e) and a completed pickup's Handed over (polish c). Claim kept: each
    // change is told only to the people who meet it.
    expect(r.entries.map((e) => e.id)).toEqual([
      'returns-requester-exchange',
      'returns-requester-exchange-review',
      'order-actions-busy',
      'returns-size-s-apostrophe',
      'returns-exchange-outcome-words',
      'order-pickup-handed-over',
    ]);
    // Re-pinned by docs/whats-new-returns-requester (2026-10-12; was: a copy
    // forced to published): the release itself is published now.
    expect(r.status).toBe('published');
    const entriesFor = (permissions: ReleaseViewer['permissions'], modules: ModuleId[] = ['returns', 'orders']) =>
      visibleReleases([r], { role: 'staff', permissions, enabledModules: modules })[0]?.entries.map((e) => e.id) ?? [];
    // A member who places orders, with Returns on: their own order's sheet,
    // the busy words on their order actions and the pickup word.
    expect(entriesFor(['orders:request'])).toEqual(['returns-requester-exchange', 'order-actions-busy', 'order-pickup-handed-over']);
    // Without Returns, only the order changes.
    expect(entriesFor(['orders:request'], ['orders'])).toEqual(['order-actions-busy', 'order-pickup-handed-over']);
    // Whoever can open Returns: the requests that now ask for an exchange,
    // and the words that say how an exchange ended.
    expect(entriesFor(['returns:read'], ['returns'])).toEqual([
      'returns-requester-exchange-review',
      'returns-size-s-apostrophe',
      'returns-exchange-outcome-words',
    ]);
    // An order approver meets the size label and the original order's
    // returns section on order pages, and the pickup word.
    expect(entriesFor(['orders:approve'])).toEqual([
      'order-actions-busy',
      'returns-size-s-apostrophe',
      'returns-exchange-outcome-words',
      'order-pickup-handed-over',
    ]);
    expect(entriesFor([])).toEqual([]);
    const review = r.entries[1]!;
    expect(review.link).toEqual({ href: '/dashboard/returns', label: 'Open Returns' });
    expect(review.audience).toEqual({ anyPermission: ['returns:read', 'returns:manage'], modules: ['returns'] });
    // Only the review entry links anywhere: an order page is per order.
    expect(r.entries.filter((e) => e.link).map((e) => e.id)).toEqual(['returns-requester-exchange-review']);
  });

  it("uses the screens' own words", () => {
    const all = readerText(release()).join(' ');
    for (const label of [
      RETURNS_COPY.requesterReturnOrExchange,
      RETURNS_COPY.returnOnly,
      RETURNS_COPY.exchangeRequester,
      RETURNS_COPY.warehouseReview,
      RETURNS_COPY.requesterYourRequests,
      RETURNS_COPY.available,
      RETURNS_COPY.notInStock,
      RETURNS_COPY.approveAsRequested,
      RETURNS_COPY.changeReplacementEllipsis,
      RETURNS_COPY.declineExchange,
      RETURNS_COPY.cancelReplacement,
      RETURNS_COPY.cancelReturn,
      RETURNS_COPY.staffNewExchangeTitle,
      RETURN_ERROR_WORDS.busy,
      'New return and exchange requests',
      'Order status changes',
      // PR-stage polish (a), (c), (d).
      RETURNS_COPY.replacementHandedOver,
      RETURNS_COPY.replacementPartlyHandedOver,
      RETURNS_COPY.replacementNotSent,
      PICKUP_COMPLETED_STATUS_LABEL,
      ORDER_STATUS_META.completed.label,
    ]) {
      // A label that is a sentence is quoted mid-sentence, without its period.
      expect(all).toContain(label.replace(/\.$/, ''));
    }
    // The label fix's example is what core prints now.
    expect(returnLineLabel("Women's Polo", 'Size S')).toBe("Women's Polo, S");
    expect(release().entries[3]!.whatChanged).toContain("Women's Polo, S");
  });

  it('claims nothing the product does not do', () => {
    const r = release();
    const all = readerText(r).join(' ');
    expect(all).not.toMatch(/\bbooks?\b|verified|inspected|certif|guarantee|%/i);
    // The sizes are the line's own product group's (plan 3.6.10), never any size or the catalog.
    expect(all).not.toMatch(/any size|any item|whole catalog|browse/i);
    // Availability is two words, never a count (D6).
    expect(all).not.toMatch(/\d+ available|how many are left/i);
    // The 14-day prompt cancels nothing on its own (D28).
    expect(r.entries[1]!.howItAffectsYou).toContain('Nothing is cancelled on its own.');
    // The phone needs the update for its screens; the busy words are the server's.
    for (const id of ['returns-requester-exchange', 'returns-size-s-apostrophe', 'returns-exchange-outcome-words', 'order-pickup-handed-over']) {
      expect(r.entries.find((e) => e.id === id)!.whatToDo, id).toBe(
        'No action needed on the web. In the mobile app, close the app completely and open it again to load the latest update.',
      );
    }
    // Corrected at publish (2026-10-12): the phone's 14-day prompt came in
    // this update (returns-view.ts workbenchStillWaiting), so the review
    // entry names the update too, then how to stop its notifications.
    expect(r.entries.find((e) => e.id === 'returns-requester-exchange-review')!.whatToDo).toBe(
      'No action needed on the web. In the mobile app, close the app completely and open it again to load the latest update. To stop these notifications, turn off New return and exchange requests in Notifications.',
    );
    expect(r.entries.find((e) => e.id === 'order-actions-busy')!.whatToDo).toBe('No action needed.');
    expect(r.summary).toContain('in the mobile app after the latest update');
  });

  // PR-stage polish: each claim of the two new entries checked against core,
  // the rule both the web and the phone render.
  it('the polish entries say what core does', () => {
    const r = release();
    const outcome = r.entries.find((e) => e.id === 'returns-exchange-outcome-words')!;
    const pickup = r.entries.find((e) => e.id === 'order-pickup-handed-over')!;
    // (a) The card's words after a hand-over, all of it.
    const line = { status: 'approved' as const, approvedItemId: 'L', approvedQuantity: 1, requestedQuantity: 1 };
    const handed = { live: true, status: 'completed', lines: [{ itemId: 'L', requested: 1, fulfilled: 1 }] };
    expect(replacementCardStatusLabel(line, handed)).toBe('Handed over');
    expect(replacementCardQuantityLabel(line, handed)).toBe('Qty handed over: 1');
    expect(outcome.whatChanged).toContain('Handed over, with the quantity handed over');
    // (d) A cancelled return's line reads not returned.
    expect(describeReturnLine({ quantity: 1, itemName: 'X', disposition: 'restock', applied: false, returnStatus: 'cancelled' })).toContain(
      '· not returned',
    );
    expect(outcome.whatChanged).toContain('reads not returned instead of pending');
    // (e) The note.
    expect(ORDER_RETURN_SUMMARY_NOTE).toContain('A replacement from an exchange is its own order');
    expect(outcome.whatChanged).toContain('is its own order and is not counted');
    // (c) A completed pickup, a delivery, and an organization's own word.
    expect(orderStatusLabelForFulfillment('completed', 'Delivered', 'pickup')).toBe('Handed over');
    expect(orderStatusLabelForFulfillment('completed', 'Delivered', 'delivery')).toBe('Delivered');
    expect(orderStatusLabelForFulfillment('completed', 'Closed out', 'pickup')).toBe('Closed out');
    expect(pickup.whatChanged).toContain('A delivery still reads Delivered');
    expect(pickup.whatChanged).toContain('its own word is kept there');
    // Nothing a status filter or an export reads changes: the word only.
    expect(pickup.howItAffectsYou).toContain('Only the word changes');
    expect(r.summary).toContain('A completed pickup order now reads Handed over.');
  });

  // Corrected at publish (docs/whats-new-returns-requester, 2026-10-12), each
  // against bd37d5a30, the Demo Co walk and RX-3's test stage.
  it('says when the requester can ask, what they are offered and what they hear, as the code does', () => {
    const r = release();
    const [requesterEntry, review, busy] = r.entries;
    const all = readerText(r).join(' ');
    // The entry is offered on a completed order, a pickup or a delivery: the
    // web order page's rule and the phone's.
    const page = readFileSync(resolve(DASHBOARD_APP_DIR, 'dashboard/orders/[id]/page.tsx'), 'utf8');
    expect(page).toContain("request.status === 'completed' || (request.status as string) === 'delivered'");
    expect(page).toContain("!can(ctx, 'returns:manage') &&");
    const phone = readFileSync(resolve(__dirname, '../../../../mobile/src/lib/order-returns.ts'), 'utf8');
    expect(phone).toContain("RETURNABLE_ORDER_STATUSES = new Set<string>(['completed', 'delivered'])");
    expect(requesterEntry!.whatChanged).toMatch(/^On an order you placed that was handed over or delivered, /);
    // The sizes are the ones the warehouse offers for that line's item, and
    // a line with none to offer asks for a note, which is required.
    expect(requesterEntry!.whatChanged).toContain('Exchange shows the other sizes the warehouse offers for that item');
    expect(review!.whatChanged).toContain('one of the other sizes the warehouse offers for the item');
    expect(all).not.toMatch(/the item's other sizes/);
    expect(requesterEntry!.whatChanged).toContain(
      `When there is no other size to offer, it shows ${RETURNS_COPY.warehouseReview.replace(/\.$/, '')}, with a note to say what you need.`,
    );
    expect(RETURNS_COPY.requesterNoteRequired('X')).toBe('Tell the warehouse what you need for X.');
    // "Nothing is sent" read as no message: it is the replacement that waits.
    expect(requesterEntry!.howItAffectsYou).toContain('no replacement goes out until it is approved');
    expect(all).not.toMatch(/nothing is sent until/i);
    // What the requester hears: the RMA's messages follow Order status
    // changes and stay silent for a counter approval; the replacement's
    // ready for pickup ping follows it too and is silent after a counter
    // receipt; its hand-over message is sent whatever the setting.
    const notify = readFileSync(resolve(__dirname, '../../server/services/returns-notify.ts'), 'utf8');
    expect(notify).toContain(
      "event === 'approved' || event === 'received' || event === 'exchange_approved' || event === 'exchange_approved_short';",
    );
    expect(notify).toContain("if (counterSilent && input.channel === 'counter') return false;");
    expect(notify).toContain("prefFlags(admin, [o.requester_user_id], 'email_order_status_changed')");
    const sql = readFileSync(
      resolve(__dirname, '../../../../../supabase/migrations/0396_returns_exchange_staff.sql'),
      'utf8',
    );
    expect(sql).toContain("if v_counter and new.status = 'staged_for_pickup' then");
    expect(sql).toContain('-- completed: ungated, as the original body');
    expect(requesterEntry!.howItAffectsYou).toContain(
      'You hear when the request arrives, when it is approved, when the replacement is ready and when it is handed over. If the warehouse approves it with you and the item at the counter, the approval and ready for pickup messages are not sent. Turning off Order status changes stops all of these but the hand-over.',
    );
    // The two sides stack on an iPhone, so nothing says "beside"; the ping
    // goes to the people who manage returns for the order's warehouse.
    expect(all).not.toMatch(/\bbeside\b/i);
    expect(review!.whatChanged).toContain(`marked ${RETURNS_COPY.requestedByRequester}, with the size asked for shown with the item it replaces`);
    expect(review!.whatChanged).toContain(`the people who manage returns for its warehouse get ${RETURNS_COPY.staffNewExchangeTitle}.`);
    // A note-only request names no item, so Approve as requested refuses it.
    expect(exchangeReviewProblem({ id: 'x', requestedItemId: null, requestNote: 'A bigger one' }, { kind: 'as_requested' })).toBe(
      RETURNS_COPY.chooseReplacement,
    );
    expect(review!.howItAffectsYou).toContain(
      `A request with only a note names no item, so choose one with ${RETURNS_COPY.changeReplacementEllipsis} or decline the exchange.`,
    );
    // Busy covers a lock on the order or on its items (55P03, 57014, 40P01).
    const busyCode = readFileSync(resolve(__dirname, '../../server/services/lib/order-busy.ts'), 'utf8');
    expect(busyCode).toContain("return code === '55P03' || code === '57014' || code === '40P01';");
    expect(busy!.whatChanged).toMatch(/^When an order action runs into another change to the same order or its items at the same moment, /);
  });
});

/**
 * A return's history shows the replacement's hand-over at its signature (D-H1,
 * from the independent audit of the returns RX-4 Demo Co walk; web server
 * only, no migration): held as a DRAFT until its web deploy is live, the
 * Demo Co RMA's history (RMA-20261012-D36F7F) was re-read on the web and the
 * phone, and returns RX-4's release, which announces Close the rest, is
 * published (#350 published it at 2026-10-12T06:13Z; the guard below still
 * checks it). Pinned by id.
 *
 * Re-pinned by docs/whats-new-return-history-hand-over (2026-10-12; was: "a
 * return's history shows when the replacement was handed over (D-H1) is held
 * as a draft"): #353 merged (24dbb08db, 07:40:28Z) and its web build
 * 1d67b31ea2df went live (07:41:37Z); the production re-read (read only, as
 * the Demo Co demo account, at 07:41:51Z) went through GET
 * /api/v1/returns/[id], the phone's read of the same buildReturnWorkbench the
 * web RMA page renders, and found Replacement partly handed over (SO-000033)
 * at its signature (04:13:50Z), after the replacement's pick and before the
 * line that closed the rest (04:28:45Z); RX-4's release is published (#350),
 * so the release is published. No phone update is involved.
 */
describe("a return's history shows when the replacement was handed over (D-H1) is published", () => {
  const ID = 'returns-history-hand-over-2026-10';
  const release = () => RELEASES.find((r) => r.id === ID)!;
  const everyone: ReleaseViewer = {
    role: 'owner',
    permissions: [...PERMISSIONS],
    enabledModules: Object.keys(MODULE_REGISTRY) as ModuleId[],
  };

  // Re-pinned by docs/whats-new-return-history-hand-over (2026-10-12; was: "is
  // a draft, so no feed carries it, and preparing it changes nothing a client
  // can observe": a draft, in no feed, no legacy list and no fingerprint).
  it('is published after the web deploy and the production re-read, so every feed it reaches carries it', () => {
    expect(release()).toBeDefined();
    expect(release().status).toBe('published');
    expect(release().revision).toBe(1);
    expect(visibleReleases(RELEASES, everyone).map((r) => r.id)).toContain(ID);
    const list = buildReleaseList(RELEASES, everyone, [], null);
    expect(list.releases.map((r) => r.id)).toContain(ID);
    // The newest release, so it is the notice for whoever it reaches: an
    // owner with every module, someone who can only open Returns, and
    // someone who manages returns.
    // Re-pinned by the What's New publish of ungroup-2026-10 and
    // group-selected-2026-10 (2026-10-12; was: ID for all three readers with
    // nothing read, the newest release):
    // Group selected's release (reaching every member) and Ungroup's
    // (reaching whoever can edit items) are newer, so the reads and seen
    // sets below include them, and a reader with nothing read is told Group
    // selected's first. Claim kept: this one is the notice for whoever it
    // reaches, after the newer releases.
    const groupingRead = [
      // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: the reads without them): the three redesign
      // releases and the parked ai-search-finds-every-item release (#367), published at the top, are read too, so the
      // releases after them keep the order this test checks. The redesign releases reach every member, returnsOnly and
      // returnsManager below included, so their first notices are re-pinned below; the ai-search-finds-every-item
      // release reaches neither of them.
      ...redesignReads(),
      {
        release_id: 'ai-search-finds-every-item-2026-10',
        revision: 1,
        dismissed_at: null,
        opened_at: '2026-10-20T13:00:00Z',
        read_at: '2026-10-20T13:00:00Z',
      },
      // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: the reads without it): the pages-keep-groups-whole
      // release, published at the top, is read too, so the releases after it keep the order this test checks; it reaches
      // neither returnsOnly nor returnsManager below, so their lines are unchanged.
      {
        release_id: 'pages-keep-groups-whole-2026-10',
        revision: 1,
        dismissed_at: null,
        opened_at: '2026-10-12T21:41:00Z',
        read_at: '2026-10-12T21:41:00Z',
      },
      // Re-pinned by docs/whats-new-ungroup-follow-ups (2026-10-12): the Ungroup follow-ups release, published at the
      // top, is read too, so the releases after it keep the order this test checks.
      {
        release_id: 'ungroup-follow-ups-2026-10',
        revision: 1,
        dismissed_at: null,
        opened_at: '2026-10-12T17:51:00Z',
        read_at: '2026-10-12T17:51:00Z',
      },
      {
        release_id: 'group-selected-2026-10',
        revision: 1,
        dismissed_at: null,
        opened_at: '2026-10-12T13:48:00Z',
        read_at: '2026-10-12T13:48:00Z',
      },
      {
        release_id: 'ungroup-2026-10',
        revision: 1,
        dismissed_at: null,
        opened_at: '2026-10-12T13:48:00Z',
        read_at: '2026-10-12T13:48:00Z',
      },
    ];
    // Re-pinned by docs/whats-new-ungroup-follow-ups (2026-10-12; was: group-selected-2026-10): the Ungroup follow-ups release is published after it, at the top and reaches this reader.
    // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: ungroup-follow-ups-2026-10): the pages-keep-groups-whole release is published after it, at the top, and reaches this reader.
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: pages-keep-groups-whole-2026-10): the parked ai-search-finds-every-item release (#367) and the three redesign releases are published after it, at the top, and redesign-2026-10, the newest, reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: redesign-2026-10): the unsubscribe-rack-question-fixes release is published after it, at the top, and reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: unsubscribe-rack-question-fixes-2026-10): the ended-session-group-page-fixes release is published after it, at the top, and reaches every member, this reader included.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: ended-session-group-page-fixes-2026-10): the manage-order-items-and-app-fixes release is published after it, at the top, and reaches every member, this reader included.
    expect(list.latestUnread?.id).toBe('manage-order-items-and-app-fixes-2026-10');
    // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: groupingRead.slice(0, 2)): the pages-keep-groups-whole release's read sits first in groupingRead, so the same three newer releases are read with slice(0, 3).
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: groupingRead.slice(0, 3)): the four new releases' reads sit first in groupingRead, so the newer releases above Ungroup's are read with slice(0, 7).
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: groupingRead.slice(0, 7)): redesignReads() now reads the unsubscribe-rack-question-fixes release first too, so the same newer releases above Ungroup's are read with slice(0, 8).
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: groupingRead.slice(0, 8)): redesignReads() now reads the ended-session-group-page-fixes release first too, so the same newer releases above Ungroup's are read with slice(0, 9).
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: groupingRead.slice(0, 9)): redesignReads() now reads the manage-order-items-and-app-fixes release first too, so the same newer releases above Ungroup's are read with slice(0, 10).
    expect(
      buildReleaseList(RELEASES, everyone, groupingRead.slice(0, 10), null).latestUnread?.id,
    ).toBe('ungroup-2026-10');
    expect(buildReleaseList(RELEASES, everyone, groupingRead, null).latestUnread?.id).toBe(ID);
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: group-selected-2026-10 first for returnsOnly and
    // returnsManager with nothing read): the three redesign releases reach every member, so both are told
    // redesign-2026-10 first, and Group selected's once those are read. Claim kept: this one once the newer
    // releases are read.
    const returnsOnly: ReleaseViewer = { role: 'staff', permissions: ['returns:read'], enabledModules: ['returns'] };
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: redesign-2026-10 with nothing read): the unsubscribe-rack-question-fixes release, published at the top, reaches every member, so this reader is told it first and redesign-2026-10 once it is read; the reads and seen sets below include it.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: unsubscribe-rack-question-fixes-2026-10 with nothing read): the ended-session-group-page-fixes release, published at the top, reaches every member, so this reader is told it first and the unsubscribe-rack-question-fixes release once it is read. Claim kept: the same order after them.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: ended-session-group-page-fixes-2026-10 with nothing read): the manage-order-items-and-app-fixes release, published at the top, reaches every member, so this reader is told it first and the ended-session-group-page-fixes release once it is read. Claim kept: the same order after them.
    expect(buildReleaseList(RELEASES, returnsOnly, [], null).latestUnread?.id).toBe(
      'manage-order-items-and-app-fixes-2026-10',
    );
    expect(buildReleaseList(RELEASES, returnsOnly, [latestRead()], null).latestUnread?.id).toBe(
      'ended-session-group-page-fixes-2026-10',
    );
    expect(
      buildReleaseList(RELEASES, returnsOnly, [latestRead(), topRead()], null).latestUnread?.id,
    ).toBe('unsubscribe-rack-question-fixes-2026-10');
    expect(
      buildReleaseList(RELEASES, returnsOnly, [latestRead(), topRead(), newestRead()], null)
        .latestUnread?.id,
    ).toBe('redesign-2026-10');
    expect(buildReleaseList(RELEASES, returnsOnly, redesignReads(), null).latestUnread?.id).toBe(
      'group-selected-2026-10',
    );
    expect(buildReleaseList(RELEASES, returnsOnly, groupingRead, null).latestUnread?.id).toBe(ID);
    const returnsManager: ReleaseViewer = {
      role: 'staff',
      permissions: ['returns:manage', 'orders:approve'],
      enabledModules: ['returns', 'orders'],
    };
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: redesign-2026-10 with nothing read): the unsubscribe-rack-question-fixes release, published at the top, reaches every member, so this reader is told it first and redesign-2026-10 once it is read; the reads and seen sets below include it.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: unsubscribe-rack-question-fixes-2026-10 with nothing read): the ended-session-group-page-fixes release, published at the top, reaches every member, so this reader is told it first and the unsubscribe-rack-question-fixes release once it is read. Claim kept: the same order after them.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: ended-session-group-page-fixes-2026-10 with nothing read): the manage-order-items-and-app-fixes release, published at the top, reaches every member, so this reader is told it first and the ended-session-group-page-fixes release once it is read. Claim kept: the same order after them.
    expect(buildReleaseList(RELEASES, returnsManager, [], null).latestUnread?.id).toBe(
      'manage-order-items-and-app-fixes-2026-10',
    );
    expect(buildReleaseList(RELEASES, returnsManager, [latestRead()], null).latestUnread?.id).toBe(
      'ended-session-group-page-fixes-2026-10',
    );
    expect(
      buildReleaseList(RELEASES, returnsManager, [latestRead(), topRead()], null).latestUnread?.id,
    ).toBe('unsubscribe-rack-question-fixes-2026-10');
    expect(
      buildReleaseList(RELEASES, returnsManager, [latestRead(), topRead(), newestRead()], null)
        .latestUnread?.id,
    ).toBe('redesign-2026-10');
    expect(buildReleaseList(RELEASES, returnsManager, redesignReads(), null).latestUnread?.id).toBe(
      'group-selected-2026-10',
    );
    expect(buildReleaseList(RELEASES, returnsManager, groupingRead, null).latestUnread?.id).toBe(ID);
    // Nobody who cannot open a return's history: an order approver or a
    // member who places orders (with Returns on), a member with no
    // permission, and anyone without Returns.
    const approver: ReleaseViewer = { role: 'staff', permissions: ['orders:approve'], enabledModules: ['returns', 'orders'] };
    const requester: ReleaseViewer = { role: 'viewer', permissions: ['orders:request'], enabledModules: ['returns', 'orders'] };
    const member: ReleaseViewer = { role: 'viewer', permissions: [], enabledModules: ['returns', 'orders'] };
    const noReturns: ReleaseViewer = { role: 'manager', permissions: ['returns:read', 'returns:manage'], enabledModules: ['orders'] };
    for (const viewer of [approver, requester, member, noReturns]) {
      expect(visibleReleases(RELEASES, viewer).map((r) => r.id)).not.toContain(ID);
    }
    // An old phone build lists it first, with the Returns link.
    // Re-pinned by the same publish (2026-10-12; was: first with nothing
    // seen): Group selected's release comes first, and this one once it and
    // Ungroup's are seen.
    // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: the seen set without it): the pages-keep-groups-whole release is published at the top and reaches the owner, so it is seen here too and the order this test checks holds.
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: the seen set without them): the three redesign releases and the ai-search-finds-every-item release are published at the top and reach the owner, so they are seen here too and the order this test checks holds.
    const newerSeen = { ...redesignSeen(), 'ai-search-finds-every-item-2026-10': true };
    const groupingSeen = {
      ...newerSeen,
      'group-selected-2026-10': true,
      'ungroup-2026-10': true,
      'ungroup-follow-ups-2026-10': true,
      'pages-keep-groups-whole-2026-10': true,
    };
    for (const viewer of [everyone, returnsOnly]) {
      // Re-pinned by docs/whats-new-ungroup-follow-ups (2026-10-12): the Ungroup follow-ups release is published at the top and reaches this reader, so it is read or seen here too and the order this test checks holds.
      // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: ungroup-follow-ups-2026-10 for the owner): the pages-keep-groups-whole release is published at the top and reaches the owner, so it is the owner's first; it never reaches returnsOnly.
      // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: those firsts with nothing seen): the three redesign releases are published at the top and reach both, so redesign-2026-10 is first for both with nothing seen; once they and the ai-search-finds-every-item release (the owner's only) are seen, the firsts are as before.
      // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: redesign-2026-10 first with nothing seen): the unsubscribe-rack-question-fixes release, published at the top, reaches this reader and comes first until it is seen too; the seen sets below include it.
      // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: unsubscribe-rack-question-fixes-2026-10 with nothing seen): the ended-session-group-page-fixes release, published at the top, reaches every member, so this reader is told it first and the unsubscribe-rack-question-fixes release once it is seen. Claim kept: the same order after them.
      // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: ended-session-group-page-fixes-2026-10 with nothing seen): the manage-order-items-and-app-fixes release, published at the top, reaches every member, so this reader is told it first and the ended-session-group-page-fixes release once it is seen. Claim kept: the same order after them.
      expect(legacyAnnouncementsFor(RELEASES, viewer, {})[0]?.id).toBe(
        'manage-order-items-and-app-fixes-2026-10',
      );
      expect(legacyAnnouncementsFor(RELEASES, viewer, latestSeen())[0]?.id).toBe(
        'ended-session-group-page-fixes-2026-10',
      );
      expect(
        legacyAnnouncementsFor(RELEASES, viewer, { ...latestSeen(), ...topSeen() })[0]?.id,
      ).toBe('unsubscribe-rack-question-fixes-2026-10');
      expect(
        legacyAnnouncementsFor(RELEASES, viewer, {
          ...latestSeen(),
          ...topSeen(),
          ...newestSeen(),
        })[0]?.id,
      ).toBe('redesign-2026-10');
      expect(legacyAnnouncementsFor(RELEASES, viewer, newerSeen)[0]?.id).toBe(
        viewer === everyone ? 'pages-keep-groups-whole-2026-10' : 'group-selected-2026-10',
      );
      expect(legacyAnnouncementsFor(RELEASES, viewer, groupingSeen)[0]).toEqual({
        id: ID,
        date: '2026-10-12',
        title: release().title,
        body: release().summary,
        cta: { href: '/dashboard/returns', label: 'Open Returns' },
      });
    }
    // Publishing it changes what clients observe.
    expect(registryFingerprint(RELEASES)).toContain(`${ID}@1:published`);
    expect(registryFingerprint(RELEASES)).not.toBe(registryFingerprint(RELEASES.filter((r) => r.id !== ID)));
    expect(ANNOUNCEMENTS.map((a) => a.id)).toContain(ID);
    // A real time on a whole minute, after the web build went live
    // (07:41:37Z) and the production re-read (07:41:51Z): never the draft's
    // placeholder date (2026-10-17T17:00Z).
    expect(release().publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/);
    expect(Date.parse(release().publishedAt)).toBeGreaterThan(Date.parse('2026-10-12T07:41:51Z'));
    expect(Date.parse(release().publishedAt)).toBeLessThanOrEqual(Date.parse('2026-10-13T00:00:00Z'));
  });

  // Drafts sit above the newest published release, newest first. Re-pinned
  // at the PR stage of the return history hand-over fix (D-H1, 2026-10-12;
  // was: "is the newest draft, at the top directly above returns RX-4's"
  // draft): RX-4's release is published (#350, at 2026-10-12T06:13Z), so
  // this one is the only draft, at the top directly above RX-4's release,
  // the newest published one, and dated after every release.
  // Re-pinned by docs/whats-new-return-history-hand-over (2026-10-12; was:
  // "is the only draft, at the top directly above returns RX-4's release
  // (the newest published), dated after every release"): published in the
  // same place, it is the newest release, and no draft is left. Claim kept:
  // at the top, directly above returns RX-4's release, dated after every
  // release.
  // Re-pinned by Ungroup G1 (2026-10-12, rebased onto #354; was: "is the
  // newest release, at the top directly above returns RX-4's release, dated
  // after every release, and no draft is left", at 0): Ungroup's draft,
  // dated later still, sits at the top above it and is the only draft.
  // Claim kept: the newest published release, directly above returns RX-4's
  // release, dated after every release but Ungroup's draft.
  // Re-pinned by Group selected G2 (2026-10-12, rebased onto #351; was: at
  // 1, Ungroup's draft at 0 and the only draft): Group selected's draft,
  // dated later still, sits at the top above Ungroup's, so there are two
  // drafts. Claim kept: the newest published release, directly below
  // Ungroup's draft and directly above returns RX-4's release, dated after
  // every release but the two drafts.
  // Re-pinned by the What's New publish of ungroup-2026-10 and
  // group-selected-2026-10 (2026-10-12; was: "is the newest published
  // release, directly below the Ungroup draft ..."): Ungroup's release and
  // Group selected's above it are published, a minute apart, so this one is
  // no longer the newest. Claim kept: directly below Ungroup's release and
  // directly above returns RX-4's, dated after every release below it.
  it("sits directly below Ungroup's release (with Group selected's above it, both published later) and directly above returns RX-4's release, dated after every release below it, and no draft is left", () => {
    // Re-pinned by the B44 phone update draft (fix/b44-update-restart-prompt;
    // was: without it): dated after every release, it sits at the top, so
    // every position below it moves down by one, and it and slice 8's are the
    // drafts.
    // Re-pinned by the small fixes slice 8 draft (fix/small-fixes-8; was:
    // without it): dated after every release, it sits at the top, so every
    // position below it moves down by one, and it is the one draft.
    // Re-pinned by the What's New publish of ungroup-2026-10 and
    // group-selected-2026-10 (2026-10-12; was: the two drafts at the top, the
    // only drafts, and the hand-over release the newest published): both are
    // published in the same places, dated after every release below them, so
    // Group selected's is the newest published release and no draft is left.
    // Re-pinned by docs/whats-new-ungroup-follow-ups (2026-10-12): the Ungroup follow-ups release is published at the top, above Group selected's, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: the Ungroup follow-ups release at 0 and this one at 3): the pages-keep-groups-whole release is published at the top, above the Ungroup follow-ups release, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: the pages-keep-groups-whole release at 0 and this one at 4): the three redesign releases and the parked ai-search-finds-every-item release (#367) are published at the top, above the pages-keep-groups-whole release, so every position below them moves down by four.
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: the redesign and ai-search-finds-every-item releases at 0 to 3, and each position below them one place higher): the unsubscribe-rack-question-fixes release is published at the top, above the redesign releases, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: the unsubscribe-rack-question-fixes release at 0, and each position and slice below it one place higher): the ended-session-group-page-fixes release is published at the top, above it, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: the ended-session-group-page-fixes release at 0, and each position and slice below it one place higher): the manage-order-items-and-app-fixes release is published at the top, above it, so every position below it moves down by one.
    expect(RELEASES[1]?.id).toBe('small-fixes-8-2026-10');
    expect(RELEASES[1]?.status).toBe('draft');
    expect(RELEASES[2]?.id).toBe('manage-order-items-and-app-fixes-2026-10');
    expect(RELEASES[2]?.status).toBe('published');
    expect(RELEASES[3]?.id).toBe('ended-session-group-page-fixes-2026-10');
    expect(RELEASES[3]?.status).toBe('published');
    expect(RELEASES[4]?.id).toBe('unsubscribe-rack-question-fixes-2026-10');
    expect(RELEASES[4]?.status).toBe('published');
    expect(RELEASES.slice(5, 9).map((r) => [r.id, r.status])).toEqual([
      ['redesign-2026-10', 'published'],
      ['redesign-mobile-app-2026-10', 'published'],
      ['redesign-web-fixes-2026-10', 'published'],
      ['ai-search-finds-every-item-2026-10', 'published'],
    ]);
    expect(RELEASES[9]?.id).toBe('pages-keep-groups-whole-2026-10');
    expect(RELEASES[9]?.status).toBe('published');
    expect(RELEASES[10]?.id).toBe('ungroup-follow-ups-2026-10');
    expect(RELEASES[10]?.status).toBe('published');
    expect(RELEASES[11]?.id).toBe('group-selected-2026-10');
    expect(RELEASES[11]?.status).toBe('published');
    expect(RELEASES[12]?.id).toBe('ungroup-2026-10');
    expect(RELEASES[12]?.status).toBe('published');
    expect(Date.parse(RELEASES[11]!.publishedAt)).toBeGreaterThan(
      Date.parse(release().publishedAt),
    );
    expect(Date.parse(RELEASES[12]!.publishedAt)).toBeGreaterThan(
      Date.parse(release().publishedAt),
    );
    expect(RELEASES[13]?.id).toBe(ID);
    expect(RELEASES[14]?.id).toBe('returns-close-rest-2026-10');
    expect(RELEASES[14]?.status).toBe('published');
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: pages-keep-groups-whole-2026-10): redesign-2026-10 is the newest published release, at the top.
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: redesign-2026-10): the unsubscribe-rack-question-fixes release is published after it, at the top, the newest published release.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: unsubscribe-rack-question-fixes-2026-10): the ended-session-group-page-fixes release is published after it, at the top, the newest published release.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: ended-session-group-page-fixes-2026-10): the manage-order-items-and-app-fixes release is published after it, at the top, the newest published release.
    expect(RELEASES.find((r) => r.status === 'published')?.id).toBe(
      'manage-order-items-and-app-fixes-2026-10',
    );
    // Re-pinned by the What's New publish of ungroup-2026-10 and
    // group-selected-2026-10 (2026-10-12; was: those two drafts): both are
    // published, so no draft is left.
    expect(RELEASES.filter((r) => r.status === 'draft').map((r) => r.id)).toEqual([
      'mobile-app-asks-before-restarting',
      'small-fixes-8-2026-10',
    ]);
    // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: the filter without it): the pages-keep-groups-whole release is published later, at the top.
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: the filter without them): the three redesign releases and the parked ai-search-finds-every-item release (#367) are published later, at the top.
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: the filter without it): the unsubscribe-rack-question-fixes release is published later, at the top.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: the filter without it): the ended-session-group-page-fixes release is published later, at the top.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: the filter without it): the manage-order-items-and-app-fixes release is published later, at the top.
    for (const r of RELEASES.filter(
      (x) =>
        x.id !== ID &&
        x.id !== 'mobile-app-asks-before-restarting' &&
        x.id !== 'small-fixes-8-2026-10' &&
        x.id !== 'ungroup-2026-10' &&
        x.id !== 'group-selected-2026-10' &&
        x.id !== 'ungroup-follow-ups-2026-10' &&
        x.id !== 'pages-keep-groups-whole-2026-10' &&
        x.id !== 'ai-search-finds-every-item-2026-10' &&
        x.id !== NEWEST_ID &&
        x.id !== TOP_ID &&
        x.id !== LATEST_ID &&
        !REDESIGN_IDS.includes(x.id),
    )) {
      expect(Date.parse(release().publishedAt), r.id).toBeGreaterThan(Date.parse(r.publishedAt));
    }
  });

  // Fix round 1 (review): its whyItMatters opens with Close the rest, which
  // returns RX-4's release announces, so it is never published before that
  // release is: nobody is told about a fix to a feature they were not told of.
  // Checked again at publish (docs/whats-new-return-history-hand-over,
  // 2026-10-12): both are published, RX-4's first.
  it("is published only once returns RX-4's release, which announces Close the rest, is published", () => {
    const rx4 = RELEASES.find((r) => r.id === 'returns-close-rest-2026-10');
    expect(rx4?.entries.map((e) => e.title)).toContain('Close the rest of a replacement on backorder');
    expect(release().entries[0]!.whyItMatters).toMatch(/^After Close the rest, /);
    expect(release().status !== 'published' || rx4?.status === 'published', `${ID} is published while ${rx4?.id} is ${rx4?.status}`).toBe(true);
    expect(Date.parse(release().publishedAt)).toBeGreaterThan(Date.parse(rx4!.publishedAt));
  });

  it('is told to whoever can open Returns, where Returns is on, and links there', () => {
    const r = release();
    expect(r.audience).toBeUndefined();
    expect(r.entries.map((e) => e.id)).toEqual(['returns-history-hand-over-time']);
    const entry = r.entries[0]!;
    expect(entry.category).toBe('fixed');
    expect(entry.area).toBe('Returns');
    expect(entry.link).toEqual({ href: '/dashboard/returns', label: 'Open Returns' });
    expect(entry.audience).toEqual({ anyPermission: ['returns:read', 'returns:manage'], modules: ['returns'] });
    // Re-pinned by docs/whats-new-return-history-hand-over (2026-10-12; was: a
    // copy forced to published): the release itself is published now.
    expect(r.status).toBe('published');
    const told = (permissions: ReleaseViewer['permissions'], modules: ModuleId[] = ['returns', 'orders']) =>
      visibleReleases([r], { role: 'staff', permissions, enabledModules: modules }).length > 0;
    expect(told(['returns:read'], ['returns'])).toBe(true);
    expect(told(['returns:manage', 'orders:approve'])).toBe(true);
    // Placing or approving orders never opens a return's history.
    expect(told(['orders:request', 'orders:approve'])).toBe(false);
    // Without Returns, nobody.
    expect(told(['returns:read', 'returns:manage'], ['orders'])).toBe(false);
    // Checked at publish: the audience is the gate of every place a return's
    // history shows. The Returns page (the link) and the RMA page (the
    // history) check the module, then returns:read or returns:manage; the
    // phone reads the history through GET /api/v1/returns/[id], whose
    // RMAService.workbench checks the same (gateRead), behind a Returns
    // screen gated the same way.
    for (const page of ['dashboard/returns/page.tsx', 'dashboard/returns/[id]/page.tsx']) {
      const code = readFileSync(resolve(DASHBOARD_APP_DIR, page), 'utf8');
      expect(code, page).toContain("const moduleAccess = await checkModuleAccess('returns');");
      expect(code, page).toContain("if (!can(ctx, 'returns:read') && !can(ctx, 'returns:manage')) {");
    }
    const service = readFileSync(resolve(__dirname, '../../server/services/returns.ts'), 'utf8');
    expect(service).toContain("assertModuleEnabled(this.ctx, 'returns');");
    expect(service).toContain("assertPermission(this.ctx, can(this.ctx, 'returns:manage') ? 'returns:manage' : 'returns:read');");
    expect(service).toContain('this.gateRead();\n    return buildReturnWorkbench(this.ctx, id);');
    const route = readFileSync(resolve(__dirname, '../../app/api/v1/returns/[id]/route.ts'), 'utf8');
    expect(route).toContain('const workbench = await RMAService.forApiContext(ctx).workbench(id);');
    const phoneList = readFileSync(resolve(__dirname, '../../../../mobile/app/(drawer)/returns.tsx'), 'utf8');
    expect(phoneList).toContain("const enabled = enabledModules.has('returns');");
    expect(phoneList).toContain("const canRead = showWriteCta(perms, 'returns:read') || showWriteCta(perms, 'returns:manage');");
  });

  it("uses the history's own words and claims no more than the server does", () => {
    const r = release();
    const entry = r.entries[0]!;
    const text = [r.title, r.summary, entry.title, entry.whatChanged, entry.whyItMatters, entry.howItAffectsYou, entry.whatToDo].join(' ');
    // The two labels the history writes (return-history.ts buildReturnChainEvents).
    const history = readFileSync(resolve(__dirname, '../../server/services/return-history.ts'), 'utf8');
    expect(history).toContain("'Replacement partly handed over'");
    expect(history).toContain("'Replacement handed over'");
    expect(r.summary).toContain('the line reads Replacement partly handed over');
    expect(entry.howItAffectsYou).toContain('A replacement handed over in full reads Replacement handed over at the same time as before.');
    // Nothing is written: only the history changes.
    expect(entry.howItAffectsYou).toContain('Only the history changes. Nothing in stock, on the order or on the return changes.');
    // The phone draws the server's lines as sent (the mobile
    // returns-screen-wiring test pins it), so no update is needed.
    expect(r.summary).toContain('on the web and in the mobile app');
    expect(entry.whatToDo).toBe('No action needed. The mobile app shows the same history as the web, with no app update needed.');
    // The original order's line moves only when it was signed for (a row
    // completed with no signature keeps its completion time).
    expect(entry.whatChanged).toContain("The original order's Handed over line also uses the time it was signed for, when there is one.");
    // The order keeps only its latest signature, so nothing promises a line
    // for each of several hand-overs.
    expect(text).not.toMatch(/\b(every|each) hand-over\b/i);
    // Never "book" for a recorded quantity; no inspection claims; no emojis.
    expect(text).not.toMatch(/\bbooks?\b|verified|inspected|certif|guarantee/i);
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  // Re-read at publish (docs/whats-new-return-history-hand-over, 2026-10-12),
  // each sentence against the merged code (#353, 24dbb08db, web and phone)
  // and the production re-read; no word changed.
  it('says what shipped, as the merged code does: the signature, partly while the rest is owed or once it was closed, the same history on the phone', () => {
    const r = release();
    const entry = r.entries[0]!;
    const migrations = resolve(__dirname, '../../../../../supabase/migrations');
    const sql = (name: string) => readFileSync(resolve(migrations, name), 'utf8');
    const history = readFileSync(resolve(__dirname, '../../server/services/return-history.ts'), 'utf8');
    const workbench = readFileSync(resolve(__dirname, '../../server/services/returns-workbench.ts'), 'utf8');
    const exchange = readFileSync(resolve(__dirname, '../../server/services/returns-exchange-workbench.ts'), 'utf8');

    // "at the time it was signed for": both signature RPCs stamp signed_at at
    // every hand-over, and completed_at with the same now() only when nothing
    // is still owed; close_partial stamps completed_at alone, later.
    for (const [name, fn] of [
      ['0395_order_stock_guards.sql', 'CREATE OR REPLACE FUNCTION public.confirm_physical_signature('],
      ['0248_physical_signature.sql', 'create or replace function public.confirm_order_signature('],
    ] as const) {
      const body = sql(name).slice(sql(name).indexOf(fn));
      expect(body, name).toContain("v_new_status := case when v_owed > 0 then 'backordered' else 'completed' end;");
      expect(body, name).toMatch(/signed_at += now\(\),\n +completed_at += case when v_new_status = 'completed' then now\(\) else null end,/);
    }
    const sql0390 = sql('0390_approval_follows_permission.sql');
    const closePartial = sql0390.slice(
      sql0390.indexOf('CREATE OR REPLACE FUNCTION public.close_partial(p_id uuid)'),
      sql0390.indexOf('-- hold_order_stock: restated'),
    );
    expect(closePartial).toContain("set status       = 'completed',\n        completed_at = now(),");
    expect(closePartial).not.toContain('signed_at');
    // The history reads the signature for both lines, the replacement's and
    // the original order's, and the completion only to tell whether that
    // signature completed the order (or for a row with no signature).
    expect(history).toContain(
      'return { at: o.signedAt, whole: o.completedAt !== null && Date.parse(o.completedAt) === Date.parse(o.signedAt) };',
    );
    expect(history).toContain('return o.completedAt ? { at: o.completedAt, whole: true } : null;');
    expect(history).toContain('const handedOver = handOverOf(input);');
    expect(history).toContain('const replacementHandedOver = input.replacement ? handOverOf(input.replacement) : null;');
    expect(history).toContain(
      "label: `${replacementHandedOver.whole ? 'Replacement handed over' : 'Replacement partly handed over'}${rso ? ` (${rso})` : ''}`,",
    );
    expect(workbench).toContain('signedAt: order?.signed_at ?? null,');
    expect(workbench).toContain(
      '? { orderNumber: liveReplacement.order_number, signedAt: liveReplacement.signed_at, completedAt: liveReplacement.completed_at }',
    );
    expect(exchange).toContain(".select('id, order_number, status, fulfillment_type, warehouse_id, completed_at, signed_at, created_at')");
    // "Only the history changes": signed_at is read for the history alone
    // (its two types, its two reads and the two chain inputs), and nothing
    // is written.
    expect(workbench.match(/signed_at/g)).toHaveLength(4);
    expect(exchange.match(/signed_at/g)).toHaveLength(2);
    expect(entry.howItAffectsYou).toMatch(/^Only the history changes\. /);

    // "comes before the line that says the rest was closed or the return was
    // cancelled": Close the rest and the return's cancel close the rest in
    // their own transaction, after the signature, and write their decision
    // there (the history sorts by time).
    const sql0397 = sql('0397_returns_followups.sql');
    const closeRest = sql0397.slice(sql0397.indexOf('create function public.close_return_replacement_rest('));
    const closeAt = closeRest.indexOf('perform public._return_replacement_close_partial(v_live.id);');
    expect(closeAt).toBeGreaterThan(0);
    expect(
      closeRest.indexOf("values (v_org, p_return_id, 'replacement_closed', 'staff', v_live.id, v_reason, v_user, 'staff');"),
    ).toBeGreaterThan(closeAt);
    const sql0394 = sql('0394_returns_lifecycle_original_rack.sql');
    const cancel = sql0394.slice(sql0394.indexOf('create function public.cancel_return(p_return_id uuid'));
    const onCancelAt = cancel.indexOf('perform public._return_exchange_on_cancel(p_return_id, v_user, v_reason);');
    expect(onCancelAt).toBeGreaterThan(0);
    expect(
      cancel.indexOf("values (v_org, p_return_id, 'cancelled', 'staff', v_rev + 1, v_reason, v_user, 'staff');"),
    ).toBeGreaterThan(onCancelAt);
    const sql0396 = sql('0396_returns_exchange_staff.sql');
    const onCancel = sql0396.slice(
      sql0396.indexOf('create or replace function public._return_exchange_on_cancel(p_return_id uuid, p_user uuid, p_reason text)'),
    );
    expect(onCancel).toContain(
      "elsif v_ostatus = 'backordered' then\n        -- Handed over in part, the rest on backorder: closed as delivered-partial,",
    );
    expect(onCancel).toContain('perform public.close_partial(v_live);');
    expect(history).toContain('.sort((a, b) => (a.at === b.at ? a.order - b.order : a.at < b.at ? -1 : 1))');
    expect(history).toContain("const head = so ? `Rest of replacement ${so} closed` : 'Rest of the replacement closed';");
    expect(history).toContain("return d.reason ? `Cancelled: ${d.reason}` : 'Cancelled';");
    expect(entry.whatChanged).toContain(
      'When only part of the replacement was handed over, the line reads Replacement partly handed over: it is listed while the rest is on backorder, and it comes before the line that says the rest was closed or the return was cancelled.',
    );

    // "on the web and in the mobile app", "the same history as the web": the
    // web RMA page and the phone draw the server's chain in the server's
    // order, the phone through GET /api/v1/returns/[id].
    const webCard = readFileSync(resolve(__dirname, '../../components/returns/return-workbench.tsx'), 'utf8');
    expect(webCard).toContain('{wb.chain.map((e, i) => (');
    expect(webCard).toContain('{formatRelative(e.at)}');
    const phoneCard = readFileSync(resolve(__dirname, '../../../../mobile/src/components/return-workbench-view.tsx'), 'utf8');
    expect(phoneCard).toContain('wb.chain.map((e, i) => (');
    expect(phoneCard).toContain('{new Date(e.at).toLocaleString(');
    const phoneClient = readFileSync(resolve(__dirname, '../../../../mobile/src/lib/returns-api.ts'), 'utf8');
    expect(phoneClient).toContain('chain: raw.chain ?? [],');
    expect(r.summary).toMatch(/^A return's history now shows the replacement's hand-over at the time it was signed for, on the web and in the mobile app\. /);
  });
});

// Ungroup, slice G1 (migration 0399, confirmed at the PR stage): a DRAFT until the
// push, the web deploy, the OTA and a Demo Co walk (which needs seeded records
// and the owner's go). The publishing follow-up dates it, sets 'published' and
// re-reads the words.
describe('the Ungroup release (G1, 0399)', () => {
  const ID = 'ungroup-2026-10';
  const release = () => RELEASES.find((r) => r.id === ID)!;

  // Re-pinned by Group selected G2 (2026-10-12; was: "is a draft at the
  // top, dated after every release"): Group selected's draft, which ships
  // after Ungroup, is dated later still and sits at the top above it. Claim
  // kept: a draft, dated after every release below it.
  // Re-pinned by the What's New publish of ungroup-2026-10 and
  // group-selected-2026-10 (2026-10-12; was: "is a draft directly below Group
  // selected's draft, dated after every release below it", a placeholder
  // date): #351 merged as 640812e08 after 0399 was pushed (10:02:30Z), its
  // web build went live (10:06:26Z), its OTA was published (10:07:40Z) and
  // the Demo Co walk's stage 1 was confirmed by an independent audit
  // (10:33:11Z), so it is published, first, a minute before Group selected's
  // release. Claim kept: directly below Group selected's, dated after every
  // release below it.
  it("is published after the web deploy, the phone update and the Demo Co walk, directly below Group selected's release (published a minute later), dated after every release below it", () => {
    // Re-pinned by the B44 phone update draft (fix/b44-update-restart-prompt;
    // was: without it): dated after every release, it sits at the top, so
    // every position below it moves down by one, and it and slice 8's are the
    // drafts.
    // Re-pinned by the small fixes slice 8 draft (fix/small-fixes-8; was:
    // without it): dated after every release, it sits at the top, so every
    // position below it moves down by one, and it is the one draft.
    expect(release().status).toBe('published');
    expect(release().revision).toBe(1);
    // Re-pinned by docs/whats-new-ungroup-follow-ups (2026-10-12): the Ungroup follow-ups release is published at the top, above Group selected's, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: the Ungroup follow-ups release at 0, Group selected's at 1, this one at 2 and slice(3)): the pages-keep-groups-whole release is published at the top, above the Ungroup follow-ups release, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: the pages-keep-groups-whole release at 0, Group selected's at 2, this one at 3 and slice(4)): the three redesign releases and the parked ai-search-finds-every-item release (#367) are published at the top, above the pages-keep-groups-whole release, so every position below them moves down by four.
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: the redesign and ai-search-finds-every-item releases at 0 to 3, and each position below them one place higher): the unsubscribe-rack-question-fixes release is published at the top, above the redesign releases, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: the unsubscribe-rack-question-fixes release at 0, and each position and slice below it one place higher): the ended-session-group-page-fixes release is published at the top, above it, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: the ended-session-group-page-fixes release at 0, and each position and slice below it one place higher): the manage-order-items-and-app-fixes release is published at the top, above it, so every position below it moves down by one.
    expect(RELEASES[1]?.id).toBe('small-fixes-8-2026-10');
    expect(RELEASES[1]?.status).toBe('draft');
    expect(RELEASES[2]?.id).toBe('manage-order-items-and-app-fixes-2026-10');
    expect(RELEASES[2]?.status).toBe('published');
    expect(RELEASES[3]?.id).toBe('ended-session-group-page-fixes-2026-10');
    expect(RELEASES[3]?.status).toBe('published');
    expect(RELEASES[4]?.id).toBe('unsubscribe-rack-question-fixes-2026-10');
    expect(RELEASES[4]?.status).toBe('published');
    expect(RELEASES.slice(5, 9).map((r) => [r.id, r.status])).toEqual([
      ['redesign-2026-10', 'published'],
      ['redesign-mobile-app-2026-10', 'published'],
      ['redesign-web-fixes-2026-10', 'published'],
      ['ai-search-finds-every-item-2026-10', 'published'],
    ]);
    expect(RELEASES[9]?.id).toBe('pages-keep-groups-whole-2026-10');
    expect(RELEASES[9]?.status).toBe('published');
    expect(RELEASES[10]?.id).toBe('ungroup-follow-ups-2026-10');
    expect(RELEASES[10]?.status).toBe('published');
    expect(RELEASES[11]?.id).toBe('group-selected-2026-10');
    expect(RELEASES[12]?.id).toBe(ID);
    expect(Date.parse(RELEASES[11]!.publishedAt) - Date.parse(release().publishedAt)).toBe(60_000);
    for (const r of RELEASES.slice(13)) {
      expect(Date.parse(release().publishedAt), r.id).toBeGreaterThan(Date.parse(r.publishedAt));
    }
    // A real time on a whole minute, after the walk's audit (10:33:11Z) and
    // on the day of the publish: never the draft's placeholder date
    // (2026-10-20T17:00Z).
    expect(release().publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/);
    expect(Date.parse(release().publishedAt)).toBeGreaterThan(Date.parse('2026-10-12T10:33:11Z'));
    expect(Date.parse(release().publishedAt)).toBeLessThanOrEqual(Date.parse('2026-10-13T00:00:00Z'));
  });

  it('is carried by every feed it reaches, after Group selected\'s release, and by no member who cannot edit or create items', () => {
    const owner: ReleaseViewer = {
      role: 'owner',
      permissions: [...PERMISSIONS],
      enabledModules: Object.keys(MODULE_REGISTRY) as ModuleId[],
    };
    const editor: ReleaseViewer = { role: 'staff', permissions: ['items:read', 'items:update'], enabledModules: [] };
    const creator: ReleaseViewer = { role: 'staff', permissions: ['items:read', 'items:create'], enabledModules: [] };
    const reader: ReleaseViewer = { role: 'viewer', permissions: ['items:read'], enabledModules: [] };
    const gsRead = {
      release_id: 'group-selected-2026-10',
      revision: 1,
      dismissed_at: null,
      opened_at: '2026-10-12T13:48:00Z',
      read_at: '2026-10-12T13:48:00Z',
    };
    // Re-pinned by docs/whats-new-ungroup-follow-ups (2026-10-12): the Ungroup follow-ups release is published at the top and reaches this reader, so it is read or seen here too and the order this test checks holds.
    const followUpsRead = { ...gsRead, release_id: 'ungroup-follow-ups-2026-10' };
    // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: ungroup-follow-ups-2026-10 first, and the reads and seen set without it): the pages-keep-groups-whole release is published at the top and reaches the owner and the editor (items:read), so it is their first notice and it is read or seen here too, and the order this test checks holds.
    const pagesRead = { ...gsRead, release_id: 'pages-keep-groups-whole-2026-10' };
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: pages-keep-groups-whole-2026-10 first for both, and the reads and seen set without the newer releases): the three redesign releases are published at the top and reach every member, so both are told redesign-2026-10 first; the parked ai-search-finds-every-item release (#367) reaches the owner (items:update with the AI module) but not the editor (no AI module). Once those are read, the pages-keep-groups-whole release is first again, and they are read or seen here too, so the order this test checks holds.
    const aiSearchRead = { ...gsRead, release_id: 'ai-search-finds-every-item-2026-10' };
    for (const viewer of [owner, editor]) {
      const newerRead = viewer === owner ? [...redesignReads(), aiSearchRead] : redesignReads();
      // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: redesign-2026-10 with nothing read): the unsubscribe-rack-question-fixes release, published at the top, reaches every member, so this reader is told it first and redesign-2026-10 once it is read; the reads and seen sets below include it.
      // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: unsubscribe-rack-question-fixes-2026-10 with nothing read): the ended-session-group-page-fixes release, published at the top, reaches every member, so this reader is told it first and the unsubscribe-rack-question-fixes release once it is read. Claim kept: the same order after them.
      // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: ended-session-group-page-fixes-2026-10 with nothing read): the manage-order-items-and-app-fixes release, published at the top, reaches every member, so this reader is told it first and the ended-session-group-page-fixes release once it is read. Claim kept: the same order after them.
      expect(buildReleaseList(RELEASES, viewer, [], null).latestUnread?.id).toBe(
        'manage-order-items-and-app-fixes-2026-10',
      );
      expect(buildReleaseList(RELEASES, viewer, [latestRead()], null).latestUnread?.id).toBe(
        'ended-session-group-page-fixes-2026-10',
      );
      expect(
        buildReleaseList(RELEASES, viewer, [latestRead(), topRead()], null).latestUnread?.id,
      ).toBe('unsubscribe-rack-question-fixes-2026-10');
      expect(
        buildReleaseList(RELEASES, viewer, [latestRead(), topRead(), newestRead()], null)
          .latestUnread?.id,
      ).toBe('redesign-2026-10');
      expect(buildReleaseList(RELEASES, viewer, newerRead, null).latestUnread?.id).toBe(
        'pages-keep-groups-whole-2026-10',
      );
      expect(
        buildReleaseList(RELEASES, viewer, [...newerRead, pagesRead, followUpsRead, gsRead], null)
          .latestUnread?.id,
      ).toBe(ID);
      expect(
        legacyAnnouncementsFor(RELEASES, viewer, {
          ...redesignSeen(),
          'ai-search-finds-every-item-2026-10': true,
          'pages-keep-groups-whole-2026-10': true,
          'ungroup-follow-ups-2026-10': true,
          'group-selected-2026-10': true,
        })[0],
      ).toEqual({
        id: ID,
        date: '2026-10-12',
        title: release().title,
        body: release().summary,
        cta: { href: '/dashboard/inventory', label: 'Open Items' },
      });
    }
    // Someone who can only create items is told the fixed entry alone.
    expect(visibleReleases(RELEASES, creator).find((r) => r.id === ID)?.entries.map((e) => e.id)).toEqual([
      'sku-taken-names-the-record',
    ]);
    expect(visibleReleases(RELEASES, reader).map((r) => r.id)).not.toContain(ID);
    expect(registryFingerprint(RELEASES)).toContain(`${ID}@1:published`);
    expect(registryFingerprint(RELEASES)).not.toBe(registryFingerprint(RELEASES.filter((r) => r.id !== ID)));
    expect(ANNOUNCEMENTS.map((a) => a.id)).toContain(ID);
  });

  it('is told to whoever can edit items, and its link goes to Items for those who can Ungroup', () => {
    const r = release();
    expect(r.audience).toEqual({ anyPermission: ['items:update', 'items:create'] });
    expect(r.entries.map((e) => [e.id, e.category, e.audience?.anyPermission, e.link?.href ?? null])).toEqual([
      ['ungroup-shared-sku', 'new', ['items:update'], '/dashboard/inventory'],
      ['sku-taken-names-the-record', 'fixed', ['items:update', 'items:create'], null],
      // Test stage, decision D1: restore points remember each record, told to
      // the people who can open Backups & restore (owner/admin floor).
      ['restore-points-follow-records', 'fixed', ['organization:update'], null],
    ]);
  });

  // Test stage, decision D1 (a) and (b): new restore points carry each
  // record's id and a restore matches by it first; restoring an older point
  // names the records that changed SKU before the typed confirm. The words
  // match the restore screen's (restore-sku-warning-copy.ts) and claim no
  // more than the service does.
  it('says restore points now follow each record, and that an older point names the records that changed SKU first', () => {
    const entry = release().entries.find((e) => e.id === 'restore-points-follow-records')!;
    expect(entry.area).toBe('Settings');
    expect(entry.whatChanged).toContain('Restore points taken after this update remember each record');
    expect(entry.whatChanged).toContain('before you type RESTORE');
    expect(entry.howItAffectsYou).toContain("A restore keeps each record's current SKU.");
    expect(entry.howItAffectsYou).toContain(
      'An older restore point with no SKU change since it was taken restores as before.',
    );
    expect(entry.whatToDo).toContain('Backups & restore');
  });

  // PR stage, data review DATA-1: an older (version 1) point restored after an
  // Ungroup finds the split record when it is still on the same rack
  // (restore-points.ts planSplitMatches), so only SKU edits are named before the
  // typed confirm; an admin who cannot view the audit log is told the check
  // could not run (restore-sku-warning-copy.ts noAuditAccess).
  // Re-pinned by PR stage fix round 1 (2026-10-12, F2; was: "... finds each
  // record that got its own SKU, when it is still on the same rack."): the
  // restore finds a split record by the SKU its split left, so a record whose
  // SKU changed between the point and the Ungroup is not found that way; the
  // warning names it instead (an edited SKU). Claim kept: an older point
  // finds a split record on the same rack, and edited SKUs are named.
  // Re-pinned by the final round (2026-10-12, review DR2-1; was: "... names
  // only edited SKUs ...", the first sentence ending "... between the restore
  // point and the Ungroup."): the restore skips the split when another record
  // now has the split record's old SKU on its rack (it gives that record the
  // stock instead), so the first sentence says so, and how it affects you
  // says the warning names such a record too (whatChanged holds 600
  // characters). Claim kept: an older point finds a split record on the same
  // rack, edited SKUs are named, and it says when it cannot check.
  it('says an older point finds a record that got its own SKU unless another record has its old SKU on that rack now, names edited SKUs and such records, and says when it cannot check', () => {
    const entry = release().entries.find((e) => e.id === 'restore-points-follow-records')!;
    expect(entry.whatChanged).toContain(
      'Restoring an older restore point after an Ungroup finds each record that got its own SKU, when it is still on the same rack, its SKU was not changed between the restore point and the Ungroup, and no other record has its old SKU on that rack now.',
    );
    expect(entry.whatChanged).toContain(
      'Backups & restore names the records whose SKU was edited since it was taken, before you type RESTORE.',
    );
    expect(entry.howItAffectsYou).toContain(
      'For an older point, Backups & restore also names a record that got its own SKU when another record now has its old SKU on the same rack, since restoring can give that record the stock this one had then.',
    );
    expect(entry.howItAffectsYou).toContain(
      'If you cannot view the audit log, Backups & restore says it could not check for SKU changes.',
    );
  });

  it('says what changes and what does not, in the screens\' own words, on both platforms', () => {
    const r = release();
    const [ungroup] = r.entries;
    // Fix round 1, P3: the bulk Ungroup is on the web only (the phone's select
    // bar gets it in G3); the phone has the item screen's action.
    expect(r.summary).toContain('On the web, select them on Items or Books and choose Ungroup.');
    expect(r.summary).toContain(
      'On an item page, on the web or in the mobile app after the latest update, use Make this its own item.',
    );
    expect(r.summary).not.toMatch(/Items or Books[^.]*mobile app/);
    // Fix round 1, D2: what an old SKU label does until it is reprinted.
    expect(ungroup!.howItAffectsYou).toContain(
      'until you reprint them for the records that changed, scanning one finds the records that keep the old SKU',
    );
    expect(ungroup!.whatChanged).toContain('Ungroup');
    expect(ungroup!.whatChanged).toContain('Make this its own item');
    expect(ungroup!.howItAffectsYou).toContain(
      'Stock, charter, rack, barcode/ISBN and history stay as they are',
    );
    expect(ungroup!.howItAffectsYou).toContain('Kits and records in a product family keep their SKU');
  });

  // Claims review at publish (docs/whats-new-ungroup-group-selected,
  // 2026-10-12): since #355 (91ca32894) the bulk bar's Ungroup takes any
  // ticked records (a group, a shared SKU, a size family) and its Save counts
  // only the records that change, so this release, published first, keeps to
  // what Ungroup does for records that share a SKU, says nothing about what
  // the button counts or that Ungroup is offered only for a shared SKU, and
  // claims no production restore (none was run; the restore-points entry
  // rests on the PR's tests and labs).
  it('keeps to records that share a SKU, says nothing Group selected changed since, and claims no production restore', () => {
    const r = release();
    const [ungroup] = r.entries;
    expect(r.summary).toContain(
      'Ungroup gives the ones you choose a new SKU of their own and changes nothing else about them',
    );
    expect(r.summary).not.toContain('gives the records you choose');
    expect(ungroup!.howItAffectsYou).toContain(
      'A record that gets a new SKU changes only its SKU, and the others keep theirs.',
    );
    expect(ungroup!.howItAffectsYou).not.toContain('Only the records you choose change');
    const text = [r.title, r.summary, ...r.entries.flatMap((e) => [e.title, e.whatChanged, e.whyItMatters, e.howItAffectsYou, e.whatToDo])].join(' ');
    expect(text).not.toMatch(/\bUngroup \d+ records?\b|counts? (only )?the records/);
    expect(text).not.toMatch(/only (for|on) records that share a SKU/);
    const restore = r.entries.find((e) => e.id === 'restore-points-follow-records')!;
    expect([restore.whatChanged, restore.whyItMatters, restore.howItAffectsYou, restore.whatToDo].join(' ')).not.toMatch(
      /production|was restored|we restored|have been restored/i,
    );
  });

  it('never calls a recorded quantity "the book", and never tells anyone to change a charter or rack to get around a rule', () => {
    const text = [release().title, release().summary, ...release().entries.flatMap((e) => [e.title, e.whatChanged, e.whyItMatters, e.howItAffectsYou, e.whatToDo])].join(' ');
    expect(text).not.toMatch(/\bthe book\b|\bbook (count|quantity|stock)\b/i);
    expect(text).not.toMatch(/(change|switch|pick|choose) (the |a |another |a different )?charter (or|to)/i);
  });
});

// Group selected, slice G2 (migration 0400, placeholder number): a DRAFT until
// the push (after Ungroup's 0399), the web deploy, the OTA and a Demo Co walk
// (which waits for the owner's go). The publishing follow-up dates it, sets
// 'published' and re-reads the words against what shipped.
describe('the Group selected release (G2, 0400)', () => {
  const ID = 'group-selected-2026-10';
  const release = () => RELEASES.find((r) => r.id === ID)!;

  // Re-pinned by the What's New publish of ungroup-2026-10 and
  // group-selected-2026-10 (2026-10-12; was: "is a draft at the top, directly
  // above Ungroup's draft (it ships after it), dated after every release", a
  // placeholder date): #355 merged as 91ca32894 after 0400 was pushed
  // (12:22:30Z), its web build went live (12:33:55Z), its OTA was published
  // (12:35:07Z) and the Demo Co walk passed on the web and, with the
  // published bundle, on the iPhone simulator (13:10:33Z), so it is
  // published a minute after Ungroup's release. Claim kept: at the top,
  // directly above Ungroup's, dated after every release.
  // Renamed by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: "is published at the top ..., dated after every release, ..."): the Ungroup follow-ups release (#362) and the pages-keep-groups-whole release are published above it. Claim kept: directly above Ungroup's release, dated after every release below it.
  it("is published after the web deploy, the phone update and the Demo Co walk, directly above Ungroup's release (published a minute before), below the newer releases, dated after every release below it, and no draft is left", () => {
    // Re-pinned by the B44 phone update draft (fix/b44-update-restart-prompt;
    // was: without it): dated after every release, it sits at the top, so
    // every position below it moves down by one, and it and slice 8's are the
    // drafts.
    // Re-pinned by the small fixes slice 8 draft (fix/small-fixes-8; was:
    // without it): dated after every release, it sits at the top, so every
    // position below it moves down by one, and it is the one draft.
    expect(release().status).toBe('published');
    expect(release().revision).toBe(1);
    // Re-pinned by docs/whats-new-ungroup-follow-ups (2026-10-12): the Ungroup follow-ups release is published at the top, above Group selected's, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: the Ungroup follow-ups release at 0, this one at 1, Ungroup's at 2 and slice(2)): the pages-keep-groups-whole release is published at the top, above the Ungroup follow-ups release, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: the pages-keep-groups-whole release at 0, this one at 2, Ungroup's at 3 and slice(3)): the three redesign releases and the parked ai-search-finds-every-item release (#367) are published at the top, above the pages-keep-groups-whole release, so every position below them moves down by four.
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: the redesign and ai-search-finds-every-item releases at 0 to 3, and each position below them one place higher): the unsubscribe-rack-question-fixes release is published at the top, above the redesign releases, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: the unsubscribe-rack-question-fixes release at 0, and each position and slice below it one place higher): the ended-session-group-page-fixes release is published at the top, above it, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: the ended-session-group-page-fixes release at 0, and each position and slice below it one place higher): the manage-order-items-and-app-fixes release is published at the top, above it, so every position below it moves down by one.
    expect(RELEASES[1]?.id).toBe('small-fixes-8-2026-10');
    expect(RELEASES[1]?.status).toBe('draft');
    expect(RELEASES[2]?.id).toBe('manage-order-items-and-app-fixes-2026-10');
    expect(RELEASES[2]?.status).toBe('published');
    expect(RELEASES[3]?.id).toBe('ended-session-group-page-fixes-2026-10');
    expect(RELEASES[3]?.status).toBe('published');
    expect(RELEASES[4]?.id).toBe('unsubscribe-rack-question-fixes-2026-10');
    expect(RELEASES[4]?.status).toBe('published');
    expect(RELEASES.slice(5, 9).map((r) => [r.id, r.status])).toEqual([
      ['redesign-2026-10', 'published'],
      ['redesign-mobile-app-2026-10', 'published'],
      ['redesign-web-fixes-2026-10', 'published'],
      ['ai-search-finds-every-item-2026-10', 'published'],
    ]);
    expect(RELEASES[9]?.id).toBe('pages-keep-groups-whole-2026-10');
    expect(RELEASES[9]?.status).toBe('published');
    expect(RELEASES[10]?.id).toBe('ungroup-follow-ups-2026-10');
    expect(RELEASES[10]?.status).toBe('published');
    expect(RELEASES[11]?.id).toBe(ID);
    expect(RELEASES[12]?.id).toBe('ungroup-2026-10');
    for (const r of RELEASES.slice(12)) {
      expect(Date.parse(release().publishedAt), r.id).toBeGreaterThan(Date.parse(r.publishedAt));
    }
    expect(RELEASES.filter((r) => r.status === 'draft').map((r) => r.id)).toEqual([
      'mobile-app-asks-before-restarting',
      'small-fixes-8-2026-10',
    ]);
    // A real time on a whole minute, after the walk's phone part ended
    // (13:10:33Z) and on the day of the publish: never the draft's
    // placeholder date (2026-10-24T17:00Z).
    expect(release().publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/);
    expect(Date.parse(release().publishedAt)).toBeGreaterThan(Date.parse('2026-10-12T13:10:33Z'));
    expect(Date.parse(release().publishedAt)).toBeLessThanOrEqual(Date.parse('2026-10-13T00:00:00Z'));
  });

  // Its Ungroup entry says what Ungroup used to do (Ungroup's release
  // announces that), so it is never published before Ungroup's release is.
  it("is published only once Ungroup's release is, and after it", () => {
    const ungroup = RELEASES.find((r) => r.id === 'ungroup-2026-10')!;
    expect(release().entries.find((e) => e.id === 'ungroup-any-records')!.whyItMatters).toMatch(/^Ungroup used to work only on records that share a SKU/);
    expect(release().status !== 'published' || ungroup.status === 'published', `${ID} is published while ungroup-2026-10 is ${ungroup.status}`).toBe(true);
    expect(Date.parse(release().publishedAt)).toBeGreaterThan(Date.parse(ungroup.publishedAt));
  });

  it('is the notice for every member, an owner, someone who edits items and someone who only reads them, and its link goes to Items', () => {
    const owner: ReleaseViewer = {
      role: 'owner',
      permissions: [...PERMISSIONS],
      enabledModules: Object.keys(MODULE_REGISTRY) as ModuleId[],
    };
    const editor: ReleaseViewer = { role: 'staff', permissions: ['items:read', 'items:update'], enabledModules: [] };
    const reader: ReleaseViewer = { role: 'viewer', permissions: ['items:read'], enabledModules: [] };
    const member: ReleaseViewer = { role: 'viewer', permissions: [], enabledModules: [] };
    for (const viewer of [owner, editor, reader, member]) {
      // Re-pinned by docs/whats-new-ungroup-follow-ups (2026-10-12): the Ungroup follow-ups release is published at the top and reaches this reader, so it is read or seen here too and the order this test checks holds.
      // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: ungroup-follow-ups-2026-10 for the owner and the editor, ID for the reader and the member): the pages-keep-groups-whole release is published at the top and reaches everyone who can read items, the reader included, so it is their first notice; it reaches no member without items:read, whose notice stays this one.
      // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: the lists with nothing read): the three redesign releases are published at the top and reach every member, so each of these four is told redesign-2026-10 first; the parked ai-search-finds-every-item release (#367) reaches only the owner (items:update with the AI module). Once those are read, the notices are as before.
      // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: redesign-2026-10 with nothing read): the unsubscribe-rack-question-fixes release, published at the top, reaches every member, so this reader is told it first and redesign-2026-10 once it is read; the reads and seen sets below include it.
      // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: unsubscribe-rack-question-fixes-2026-10 with nothing read): the ended-session-group-page-fixes release, published at the top, reaches every member, so this reader is told it first and the unsubscribe-rack-question-fixes release once it is read. Claim kept: the same order after them.
      // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: ended-session-group-page-fixes-2026-10 with nothing read): the manage-order-items-and-app-fixes release, published at the top, reaches every member, so this reader is told it first and the ended-session-group-page-fixes release once it is read. Claim kept: the same order after them.
      expect(buildReleaseList(RELEASES, viewer, [], null).latestUnread?.id).toBe(
        'manage-order-items-and-app-fixes-2026-10',
      );
      expect(buildReleaseList(RELEASES, viewer, [latestRead()], null).latestUnread?.id).toBe(
        'ended-session-group-page-fixes-2026-10',
      );
      expect(
        buildReleaseList(RELEASES, viewer, [latestRead(), topRead()], null).latestUnread?.id,
      ).toBe('unsubscribe-rack-question-fixes-2026-10');
      expect(
        buildReleaseList(RELEASES, viewer, [latestRead(), topRead(), newestRead()], null)
          .latestUnread?.id,
      ).toBe('redesign-2026-10');
      const newerRead =
        viewer === owner
          ? [
              ...redesignReads(),
              {
                release_id: 'ai-search-finds-every-item-2026-10',
                revision: 1,
                dismissed_at: null,
                opened_at: '2026-10-20T13:00:00Z',
                read_at: '2026-10-20T13:00:00Z',
              },
            ]
          : redesignReads();
      expect(buildReleaseList(RELEASES, viewer, newerRead, null).latestUnread?.id).toBe(
        [owner, editor, reader].includes(viewer) ? 'pages-keep-groups-whole-2026-10' : ID,
      );
    }
    for (const viewer of [owner, editor]) {
      // Re-pinned by docs/whats-new-ungroup-follow-ups (2026-10-12): the Ungroup follow-ups release is published at the top and reaches this reader, so it is read or seen here too and the order this test checks holds.
      // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: the seen set without it): the pages-keep-groups-whole release is published at the top and reaches this reader, so it is seen here too and the order this test checks holds.
      // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: the seen set without them): the three redesign releases and the ai-search-finds-every-item release are published at the top and reach the owner (the editor all but the ai-search-finds-every-item release), so they are seen here too and the order this test checks holds.
      expect(
        legacyAnnouncementsFor(RELEASES, viewer, {
          ...redesignSeen(),
          'ai-search-finds-every-item-2026-10': true,
          'pages-keep-groups-whole-2026-10': true,
          'ungroup-follow-ups-2026-10': true,
        })[0],
      ).toEqual({
        id: ID,
        date: '2026-10-12',
        title: release().title,
        body: release().summary,
        cta: { href: '/dashboard/inventory', label: 'Open Items' },
      });
    }
    // Whoever cannot edit items is told the headers and the fix, with no link.
    // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: with nothing seen): the pages-keep-groups-whole release is published at the top and reaches the reader (items:read), so it is seen here too and the order this test checks holds.
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: the seen set without them): the three redesign releases are published at the top and reach the reader, so they are seen here too and the order this test checks holds.
    expect(
      legacyAnnouncementsFor(RELEASES, reader, {
        ...redesignSeen(),
        'pages-keep-groups-whole-2026-10': true,
      })[0],
    ).toEqual({
      id: ID,
      date: '2026-10-12',
      title: release().title,
      body: release().summary,
    });
    expect(registryFingerprint(RELEASES)).toContain(`${ID}@1:published`);
    expect(registryFingerprint(RELEASES)).not.toBe(registryFingerprint(RELEASES.filter((r) => r.id !== ID)));
    expect(ANNOUNCEMENTS.map((a) => a.id)).toContain(ID);
  });

  // Re-pinned by Ungroup anything (owner 2026-10-12; was: three entries):
  // Ungroup for any ticked records is told in its own entry, to the same
  // audience as Group selected (items:update, the bulk bar's gate), with the
  // link to Items. Claim kept: the headers and the fix go to every member.
  // Re-pinned by the group header picture entry (#357 follow-up, added to
  // docs/whats-new-ungroup-group-selected 2026-10-12; was: four entries): a
  // fifth entry, group-header-picture (improved), is told to whoever can edit
  // items, as Group selected, with no link. Claim kept: Group selected and
  // Ungroup to whoever can edit items with the link to Items, the headers and
  // the fix to every member.
  it('tells Group selected, Ungroup and the header picture to whoever can edit items, Group selected and Ungroup with the link to Items, and the headers and the fix to every member', () => {
    const r = release();
    // No release-level audience: every member who opens Items or Books sees
    // grouped records under one header.
    expect(r.audience).toBeUndefined();
    expect(r.entries.map((e) => [e.id, e.category, e.audience?.anyPermission ?? null, e.link?.href ?? null])).toEqual([
      ['group-selected', 'new', ['items:update'], '/dashboard/inventory'],
      ['ungroup-any-records', 'new', ['items:update'], '/dashboard/inventory'],
      ['groups-show-under-one-header', 'improved', null, null],
      ['sku-header-rows-stay-under-it', 'fixed', null, null],
      ['group-header-picture', 'improved', ['items:update'], null],
    ]);
    // Through the real filter, on a copy forced to published (a draft never
    // reaches anyone).
    const published = { ...r, status: 'published' as const };
    const entriesFor = (role: ReleaseViewer['role'], permissions: ReleaseViewer['permissions']) =>
      visibleReleases([published], { role, permissions, enabledModules: [] })[0]?.entries.map((e) => e.id) ?? [];
    expect(entriesFor('manager', ['items:read', 'items:update'])).toEqual([
      'group-selected',
      'ungroup-any-records',
      'groups-show-under-one-header',
      'sku-header-rows-stay-under-it',
      'group-header-picture',
    ]);
    expect(entriesFor('viewer', ['items:read'])).toEqual(['groups-show-under-one-header', 'sku-header-rows-stay-under-it']);
  });

  it("says the brief's sentence and the screens' own words, on both platforms", () => {
    const r = release();
    // Re-pinned by Ungroup anything (owner 2026-10-12; was: [group, headers]):
    // the Ungroup entry sits second. Claims kept.
    const [group, , headers] = r.entries;
    expect(r.summary).toContain(GROUP_COPY.intro);
    expect(r.summary).toMatch(/on the web, or .* on the mobile app/);
    expect(group!.howItAffectsYou).toContain(GROUP_COPY.intro);
    expect(group!.whatChanged).toContain(GROUP_COPY.bulkAction);
    expect(group!.whatChanged).toContain(GROUP_COPY.moveOne);
    expect(group!.whatChanged).toContain(GROUP_COPY.removeAction);
    expect(group!.howItAffectsYou).toContain(GROUP_COPY.addToGroup);
    expect(group!.howItAffectsYou).toContain('Group them');
    expect(group!.howItAffectsYou).toContain(
      'Each record keeps its own SKU, barcode/ISBN, charter, rack, stock and history',
    );
    expect(group!.howItAffectsYou).toContain('Kits and rentals cannot be grouped');
    expect(headers!.whatChanged).toContain('In group');
    expect(headers!.howItAffectsYou).toContain('Nothing about any record changes');
  });

  // People review P2, P5 and P7, completeness review C4: the words claim no
  // more than the screens do.
  it("names the phone's control as it reads, says where automatic same-SKU grouping still applies, and offers Group them only where it is offered", () => {
    const r = release();
    // Re-pinned by Ungroup anything (owner 2026-10-12; was: [group, headers,
    // fixed]): the Ungroup entry sits second. Claims kept.
    const [group, , headers, fixed] = r.entries;
    // P7 (a): the phone's select bar says "Group".
    expect(r.summary).toContain(
      `${GROUP_COPY.bulkAction} on the web, or ${GROUP_COPY.bulkActionShort} on the mobile app's select bar`,
    );
    expect(group!.whatChanged).toContain(
      `${GROUP_COPY.bulkAction} on the web, or ${GROUP_COPY.bulkActionShort} on the mobile app's select bar`,
    );
    expect(r.summary).not.toMatch(/Group selected, on the web or in the mobile app/);
    // P2: where automatic same-SKU grouping still applies.
    expect(group!.howItAffectsYou).toContain(
      'Records in no group that share a SKU still show together automatically;',
    );
    expect(group!.howItAffectsYou).not.toMatch(/Records that share a SKU still show together/);
    // P7 (b), C4: Group them is offered when a record's SKU is edited on the web.
    // Re-pinned by the claims review at the What's New publish of
    // ungroup-2026-10 and group-selected-2026-10 (2026-10-12; was: "... to
    // one already used in its charter and rack offers Group them."): the
    // refusal offers Group them only when it names the record holding the
    // SKU, which it reads under the editor's own access (InventoryService
    // skuTakenError; item-form skuTakenGroupIds needs conflictItemId). Claim
    // kept: offered when a record's SKU is edited on the web, and only there.
    expect(group!.howItAffectsYou).toContain(
      "Editing a record's SKU on the web to one held by a record you can see in its charter and rack offers Group them.",
    );
    expect(group!.howItAffectsYou).not.toContain('to one already used in its charter and rack offers Group them');
    expect(group!.howItAffectsYou).not.toMatch(/When a SKU you save is already used/);
    // P5: the header counts the records listed.
    expect(headers!.whatChanged).toContain('how many of its records are listed');
    // P7 (c): the fix is about a size run, by name or by product family.
    expect(fixed!.whatChanged).toContain('next to a size run');
    expect(fixed!.whatChanged).not.toMatch(/in a product family of linked sizes/);
  });

  // Ungroup anything (owner 2026-10-12, verbatim: "im supposed to be able to
  // check box whatever item and then group or ungroup it that was the
  // point."): the release tells the owner and members to tick any records and
  // Group or Ungroup, what Ungroup does for each kind of grouping, and the
  // Returns consequence for the sizes of a family, in the screens' words.
  it('says to tick any records, then Group or Ungroup, what Ungroup does for each kind, and the Returns consequence for sizes', () => {
    const r = release();
    expect(r.title).toBe('Group or ungroup any records');
    expect(r.summary).toContain('tick any records');
    expect(r.summary).toContain(UNGROUP_COPY.bulkAction);
    expect(r.summary).toContain(GROUP_COPY.intro);
    const ungroup = r.entries.find((e) => e.id === 'ungroup-any-records')!;
    expect(ungroup.whatChanged).toContain('tick any records and choose Ungroup');
    // Each kind, in the review's own words.
    expect(ungroup.whatChanged).toContain(UNGROUP_COPY.getsOwnSku);
    expect(ungroup.whatChanged).toContain('Leaves group');
    expect(ungroup.whatChanged).toContain('Leaves the');
    expect(ungroup.whatChanged).toContain('size family');
    expect(ungroup.whatChanged).toContain('the grouping it shows under on the list');
    // The Returns consequence for a family's sizes, as the review says it.
    expect(ungroup.howItAffectsYou).toContain(
      'In Returns, a size taken out of its size family is no longer listed under Other sizes for an exchange',
    );
    expect(UNGROUP_COPY.familyNote).toContain('no longer listed under Other sizes for an exchange');
    // Test stage 2026-10-12 (PR #355, MEDIUM): out of the family, sizes whose
    // names end in a size are still listed together by their name, as the
    // review and the result say.
    expect(ungroup.howItAffectsYou).toContain(UNGROUP_COPY.familyNameNote);
    expect(ungroup.howItAffectsYou).toContain('permission to manage sports products');
    expect(ungroup.howItAffectsYou).toContain('Stock, charter, rack, barcode/ISBN and history stay as they are');
    // Remove from group stays where it is: a group's header and the item page.
    // Re-pinned by the claims review at the What's New publish of
    // ungroup-2026-10 and group-selected-2026-10 (2026-10-12; was: "...
    // takes a record out from a group's header on the web or from the item
    // page on both"): a header's Remove from group reviews every record
    // listed under it (inventory-table passes the header's members to
    // RemoveFromGroupDialog), not one record. Claim kept: on a group's header
    // on the web and on the item page on both.
    const [group] = r.entries;
    expect(group!.whatChanged).toContain(
      `${GROUP_COPY.removeAction} takes records out of a group, from its header on the web or the item page on both`,
    );
    expect(group!.whatChanged).not.toContain('takes a record out from a group');
  });

  // Claims review at publish (docs/whats-new-ungroup-group-selected,
  // 2026-10-12), against 91ca32894 and the Demo Co walk: Group selected is
  // offered for two or more ticked records only (core groupingSelectionFacts
  // canGroup; one ticked record offered Ungroup alone, walk c1), and groups
  // shipped together with their Ungroup, so no build ever showed ticked
  // records in a group without one.
  it('offers Group selected for two or more ticked records and Ungroup for any, and never says records in a group used to offer no Ungroup', () => {
    const r = release();
    expect(r.summary).toContain('tick two or more records, then choose Group selected');
    expect(r.summary).toContain('or tick any records and choose Ungroup');
    expect(r.summary).not.toMatch(/tick any records, then choose Group selected/);
    const ungroup = r.entries.find((e) => e.id === 'ungroup-any-records')!;
    expect(ungroup.whyItMatters).toBe(
      'Ungroup used to work only on records that share a SKU, so the sizes of a size family could not be ungrouped from the list.',
    );
    expect(ungroup.whyItMatters).not.toMatch(/records in a group/);
    // The Save button counts only the records that change (web and phone).
    expect(ungroup.whatChanged).toContain('Ungroup counts only the records that change');
  });

  // Group selected follow-up #357 (431ab5255; owner 2026-10-12 13:50Z: "it
  // should just use the first picture of whatever was chosen for the
  // grouping"): core groupCoverRow picks the first record, in the order the
  // header lists them, with a non-blank picture; the web header
  // (inventory-table.tsx, Items and Books) and the phone's Items and Books
  // headers show it, and keep the placeholder with none. Nothing is written.
  it("says a group's header shows the first listed record's picture, on the web and the phone, keeps the placeholder with none, and changes no record's picture", () => {
    const entry = release().entries.find((e) => e.id === 'group-header-picture')!;
    expect(entry.title).toBe("A group's header shows a picture");
    expect(entry.whatChanged).toContain('On Items and Books, on the web and in the mobile app');
    expect(entry.whatChanged).toContain('the picture of the first record listed under it that has one');
    expect(entry.whatChanged).toContain('the header keeps the placeholder');
    expect(entry.howItAffectsYou).toContain('Each record keeps its own picture.');
    expect(entry.whatToDo).toContain('close the app completely and open it again');
    expect(entry.audience).toEqual({ anyPermission: ['items:update'] });
    expect(groupCoverRow([{ u: null }, { u: '  ' }, { u: 'b.jpg' }, { u: 'c.jpg' }], (r) => r.u)).toEqual({ u: 'b.jpg' });
    expect(groupCoverRow([{ u: null }, { u: '' }], (r) => r.u)).toBeNull();
  });

  it('says only a manager renames a group (security review SEC-1: apply_item_grouping refuses anyone else on the role alone)', () => {
    const [group] = release().entries;
    expect(group!.whatChanged).toContain(
      'On the web, a manager can rename a group from its header.',
    );
    expect(group!.whatChanged).not.toMatch(/a group can be renamed/);
  });

  it('never calls a recorded quantity "the book", and never tells anyone to change a charter or rack to get around a rule', () => {
    const text = [
      release().title,
      release().summary,
      ...release().entries.flatMap((e) => [e.title, e.whatChanged, e.whyItMatters, e.howItAffectsYou, e.whatToDo]),
    ].join(' ');
    expect(text).not.toMatch(/\bthe book\b|\bbook (count|quantity|stock)\b/i);
    expect(text).not.toMatch(/(change|switch|pick|choose) (the |a |another |a different )?charter (or|to)/i);
  });
});

describe('the Ungroup follow-ups release (#358 to #361)', () => {
  const ID = 'ungroup-follow-ups-2026-10';
  const release = () => RELEASES.find((r) => r.id === ID)!;
  const owner: ReleaseViewer = {
    role: 'owner',
    permissions: [...PERMISSIONS],
    enabledModules: Object.keys(MODULE_REGISTRY) as ModuleId[],
  };
  const editor: ReleaseViewer = { role: 'staff', permissions: ['items:read', 'items:update'], enabledModules: [] };
  const sportsManager: ReleaseViewer = {
    role: 'staff',
    permissions: ['items:read', 'sports:manage'],
    enabledModules: ['sports'],
  };
  const reader: ReleaseViewer = { role: 'viewer', permissions: ['items:read'], enabledModules: [] };
  const member: ReleaseViewer = { role: 'viewer', permissions: [], enabledModules: [] };

  // Published once every part was live: #358 to #361 on the web (the last,
  // #361, live 17:32:19Z), their phone parts in OTA group 281dcf15 (17:34Z,
  // verified), and the Demo Co check on the iPhone simulator with the
  // published bundle (17:38-17:43Z).
  // Renamed by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: "is published at the top ..., dated after every release, ..."): the pages-keep-groups-whole release is published after it, at the top.
  it('is published directly below the pages-keep-groups-whole release (published later), after the web deploys, the phone update and the Demo Co check, dated after every release below it, and no draft is left', () => {
    // Re-pinned by the B44 phone update draft (fix/b44-update-restart-prompt;
    // was: without it): dated after every release, it sits at the top, so
    // every position below it moves down by one, and it and slice 8's are the
    // drafts.
    // Re-pinned by the small fixes slice 8 draft (fix/small-fixes-8; was:
    // without it): dated after every release, it sits at the top, so every
    // position below it moves down by one, and it is the one draft.
    expect(release().status).toBe('published');
    expect(release().revision).toBe(1);
    // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: at 0 and slice(1)): the pages-keep-groups-whole release is published after it, at the top, so this one sits directly below it, dated after every release below it.
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: the pages-keep-groups-whole release at 0, this one at 1 and slice(2)): the three redesign releases and the parked ai-search-finds-every-item release (#367) are published at the top, above the pages-keep-groups-whole release, so this one sits four places lower, still directly below the pages-keep-groups-whole release.
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: the redesign and ai-search-finds-every-item releases at 0 to 3, and each position below them one place higher): the unsubscribe-rack-question-fixes release is published at the top, above the redesign releases, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: the unsubscribe-rack-question-fixes release at 0, and each position and slice below it one place higher): the ended-session-group-page-fixes release is published at the top, above it, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: the ended-session-group-page-fixes release at 0, and each position and slice below it one place higher): the manage-order-items-and-app-fixes release is published at the top, above it, so every position below it moves down by one.
    expect(RELEASES[1]?.id).toBe('small-fixes-8-2026-10');
    expect(RELEASES[1]?.status).toBe('draft');
    expect(RELEASES[2]?.id).toBe('manage-order-items-and-app-fixes-2026-10');
    expect(RELEASES[2]?.status).toBe('published');
    expect(RELEASES[3]?.id).toBe('ended-session-group-page-fixes-2026-10');
    expect(RELEASES[3]?.status).toBe('published');
    expect(RELEASES[4]?.id).toBe('unsubscribe-rack-question-fixes-2026-10');
    expect(RELEASES[4]?.status).toBe('published');
    expect(RELEASES.slice(5, 9).map((r) => [r.id, r.status])).toEqual([
      ['redesign-2026-10', 'published'],
      ['redesign-mobile-app-2026-10', 'published'],
      ['redesign-web-fixes-2026-10', 'published'],
      ['ai-search-finds-every-item-2026-10', 'published'],
    ]);
    expect(RELEASES[9]?.id).toBe('pages-keep-groups-whole-2026-10');
    expect(RELEASES[9]?.status).toBe('published');
    expect(RELEASES[10]?.id).toBe(ID);
    expect(release().publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/);
    expect(Date.parse(release().publishedAt)).toBeGreaterThan(Date.parse('2026-10-12T17:43:00Z'));
    expect(Date.parse(release().publishedAt)).toBeLessThanOrEqual(Date.parse('2026-10-14T00:00:00Z'));
    for (const r of RELEASES.slice(11)) {
      expect(Date.parse(release().publishedAt), r.id).toBeGreaterThan(Date.parse(r.publishedAt));
    }
    expect(RELEASES.filter((r) => r.status === 'draft').map((r) => r.id)).toEqual([
      'mobile-app-asks-before-restarting',
      'small-fixes-8-2026-10',
    ]);
  });

  it('tells the size-family entry to whoever manages sports products, and the other two to whoever can edit items, with no links', () => {
    const r = release();
    expect(r.audience).toBeUndefined();
    expect(r.entries.map((e) => [e.id, e.category, e.audience, e.link ?? null])).toEqual([
      ['size-on-several-racks-leaves-together', 'improved', { anyPermission: ['sports:manage'], modules: ['sports'] }, null],
      ['ungroup-answer-not-confirmed', 'fixed', { anyPermission: ['items:update'] }, null],
      ['group-ungroup-limit-at-the-button', 'improved', { anyPermission: ['items:update'] }, null],
    ]);
  });

  // Renamed by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: "reaches an owner and an editor first, ..."): the pages-keep-groups-whole release reaches both first, and this one once it is read.
  // Renamed by docs/whats-new-redesign-2026-10 (2026-10-20; was: "reaches an owner and an editor once the pages-keep-groups-whole release is read, ..."): the three redesign releases reach both first, and the parked ai-search-finds-every-item release (#367) reaches the owner (items:update with the AI module) before the pages-keep-groups-whole release too. Claim kept: this one once the newer releases that reach them are read.
  // Renamed by docs/whats-new-2026-10-25 (2026-10-25; was: "reaches an owner and an editor once the redesign releases, ..."): the unsubscribe-rack-question-fixes release, published at the top, reaches both first too, and redesignReads() reads it with the redesign releases. Claim kept: this one once the newer releases that reach them are read.
  // Renamed by docs/whats-new-2026-10-26 (2026-10-26; was: "reaches an owner and an editor once the unsubscribe-rack-question-fixes and redesign releases, ..."): the ended-session-group-page-fixes release, published at the top, reaches both first too, and redesignReads() reads it with them. Claim kept: this one once the newer releases that reach them are read.
  // Renamed by docs/whats-new-2026-10-30 (2026-10-30; was: "reaches an owner and an editor once the ended-session-group-page-fixes, unsubscribe-rack-question-fixes and redesign releases, ..."): the manage-order-items-and-app-fixes release, published at the top, reaches both first too, and redesignReads() reads it with them. Claim kept: this one once the newer releases that reach them are read.
  it('reaches an owner and an editor once the manage-order-items-and-app-fixes, ended-session-group-page-fixes, unsubscribe-rack-question-fixes and redesign releases, the pages-keep-groups-whole release and, for the owner, the ai-search-finds-every-item release are read, a sports manager with its size-family entry only, and nobody who cannot edit items or manage sports products', () => {
    // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: ID with nothing read): the pages-keep-groups-whole release is published after it, at the top, and reaches both readers (items:read), so it is their first notice and this one is once it is read.
    const pagesRead = {
      release_id: 'pages-keep-groups-whole-2026-10',
      revision: 1,
      dismissed_at: null,
      opened_at: '2026-10-12T21:41:00Z',
      read_at: '2026-10-12T21:41:00Z',
    };
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: pages-keep-groups-whole-2026-10 first for both, and ID once it was read): the three redesign releases are published at the top and reach every member, and the parked ai-search-finds-every-item release (#367) reaches the owner (items:update with the AI module) but not the editor (no AI module), so those are read first here; then the pages-keep-groups-whole release comes first, and this one once it is read.
    const aiSearchRead = {
      ...pagesRead,
      release_id: 'ai-search-finds-every-item-2026-10',
      opened_at: '2026-10-20T13:00:00Z',
      read_at: '2026-10-20T13:00:00Z',
    };
    const newerRead = (viewer: ReleaseViewer) =>
      viewer === owner ? [...redesignReads(), aiSearchRead] : redesignReads();
    expect(visibleReleases(RELEASES, editor).map((r) => r.id)).not.toContain(
      'ai-search-finds-every-item-2026-10',
    );
    for (const viewer of [owner, editor]) {
      // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: redesign-2026-10 with nothing read): the unsubscribe-rack-question-fixes release, published at the top, reaches every member, so this reader is told it first and redesign-2026-10 once it is read; the reads and seen sets below include it.
      // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: unsubscribe-rack-question-fixes-2026-10 with nothing read): the ended-session-group-page-fixes release, published at the top, reaches every member, so this reader is told it first and the unsubscribe-rack-question-fixes release once it is read. Claim kept: the same order after them.
      // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: ended-session-group-page-fixes-2026-10 with nothing read): the manage-order-items-and-app-fixes release, published at the top, reaches every member, so this reader is told it first and the ended-session-group-page-fixes release once it is read. Claim kept: the same order after them.
      expect(buildReleaseList(RELEASES, viewer, [], null).latestUnread?.id).toBe(
        'manage-order-items-and-app-fixes-2026-10',
      );
      expect(buildReleaseList(RELEASES, viewer, [latestRead()], null).latestUnread?.id).toBe(
        'ended-session-group-page-fixes-2026-10',
      );
      expect(
        buildReleaseList(RELEASES, viewer, [latestRead(), topRead()], null).latestUnread?.id,
      ).toBe('unsubscribe-rack-question-fixes-2026-10');
      expect(
        buildReleaseList(RELEASES, viewer, [latestRead(), topRead(), newestRead()], null)
          .latestUnread?.id,
      ).toBe('redesign-2026-10');
      expect(buildReleaseList(RELEASES, viewer, newerRead(viewer), null).latestUnread?.id).toBe(
        'pages-keep-groups-whole-2026-10',
      );
      expect(
        buildReleaseList(RELEASES, viewer, [...newerRead(viewer), pagesRead], null).latestUnread
          ?.id,
      ).toBe(ID);
    }
    expect(visibleReleases(RELEASES, editor).find((r) => r.id === ID)?.entries.map((e) => e.id)).toEqual([
      'ungroup-answer-not-confirmed',
      'group-ungroup-limit-at-the-button',
    ]);
    expect(visibleReleases(RELEASES, sportsManager).find((r) => r.id === ID)?.entries.map((e) => e.id)).toEqual([
      'size-on-several-racks-leaves-together',
    ]);
    for (const viewer of [reader, member]) {
      expect(visibleReleases(RELEASES, viewer).map((r) => r.id)).not.toContain(ID);
    }
    // Once read, the next notice is Group selected's, as before it.
    const read = { release_id: ID, revision: 1, dismissed_at: null, opened_at: '2026-10-12T18:00:00Z', read_at: '2026-10-12T18:00:00Z' };
    // Re-pinned by docs/whats-new-pages-keep-groups-whole (2026-10-12; was: with only this one read or seen): the pages-keep-groups-whole release is published at the top and reaches the owner, so it is read or seen here too and the order this test checks holds.
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: the reads and seen sets without the newer releases, and pages-keep-groups-whole-2026-10 first with nothing seen): the three redesign releases and the ai-search-finds-every-item release are published at the top and reach the owner, so redesign-2026-10 is first with nothing seen; they are read or seen here too, and the order this test checks holds.
    expect(
      buildReleaseList(RELEASES, owner, [...newerRead(owner), pagesRead, read], null).latestUnread
        ?.id,
    ).toBe('group-selected-2026-10');
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: redesign-2026-10 first with nothing seen): the unsubscribe-rack-question-fixes release, published at the top, reaches this reader and comes first until it is seen too; the seen sets below include it.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: unsubscribe-rack-question-fixes-2026-10 with nothing seen): the ended-session-group-page-fixes release, published at the top, reaches every member, so this reader is told it first and the unsubscribe-rack-question-fixes release once it is seen. Claim kept: the same order after them.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: ended-session-group-page-fixes-2026-10 with nothing seen): the manage-order-items-and-app-fixes release, published at the top, reaches every member, so this reader is told it first and the ended-session-group-page-fixes release once it is seen. Claim kept: the same order after them.
    expect(legacyAnnouncementsFor(RELEASES, owner, {})[0]?.id).toBe(
      'manage-order-items-and-app-fixes-2026-10',
    );
    expect(legacyAnnouncementsFor(RELEASES, owner, latestSeen())[0]?.id).toBe(
      'ended-session-group-page-fixes-2026-10',
    );
    expect(legacyAnnouncementsFor(RELEASES, owner, { ...latestSeen(), ...topSeen() })[0]?.id).toBe(
      'unsubscribe-rack-question-fixes-2026-10',
    );
    expect(
      legacyAnnouncementsFor(RELEASES, owner, { ...latestSeen(), ...topSeen(), ...newestSeen() })[0]
        ?.id,
    ).toBe('redesign-2026-10');
    const newerSeen = { ...redesignSeen(), 'ai-search-finds-every-item-2026-10': true };
    expect(legacyAnnouncementsFor(RELEASES, owner, newerSeen)[0]?.id).toBe(
      'pages-keep-groups-whole-2026-10',
    );
    expect(
      legacyAnnouncementsFor(RELEASES, owner, {
        ...newerSeen,
        'pages-keep-groups-whole-2026-10': true,
      })[0]?.id,
    ).toBe(ID);
    expect(registryFingerprint(RELEASES)).toContain(`${ID}@1:published`);
  });

  it("says what the product says: Not confirmed, Try again and Review again, and the 100-record words", () => {
    const [family, notConfirmed, limit] = release().entries;
    expect(UNGROUP_COPY.partUnknown('x', 'y')).toMatch(/^Not confirmed: /);
    expect(notConfirmed!.whatChanged).toContain('Not confirmed instead of Not done');
    expect(notConfirmed!.whatChanged).toContain('Review again is offered, with Try again next to it when trying again is safe');
    expect(GROUPING_ERROR_WORDS.tooMany).toContain('at most 100 records at a time');
    expect(GROUPING_ERROR_WORDS.groupTooMany).toContain('at most 100 records at a time');
    expect(limit!.whatChanged).toContain('at most 100 records at a time');
    expect(UNGROUP_COPY.familySkuNote).toContain('so the list still shows them together under it');
    expect(family!.howItAffectsYou).toContain('so the list keeps showing them together under it');
    const text = [release().title, release().summary, ...release().entries.flatMap((e) => [e.title, e.whatChanged, e.whyItMatters, e.howItAffectsYou, e.whatToDo])].join(' ');
    expect(text).not.toMatch(/\bthe book\b|\bbook (count|quantity|stock)\b/i);
  });
});

// Phase 2 of the grouping brief (owner go 2026-10-12): #364 merged as
// 0694833cc and web build c5d1efe0c64e went live at 21:26:17Z. Staff and
// viewers' Items and Books pages are planned group-aware over the whole
// filtered view, and a rack view's totals cover that rack. The Demo Co walk
// (walk-p2/WALK-P2.md, 21:33-21:36Z) passed 7 of 7. Web only, so it is
// published once the web is live and the walk passed.
describe('the pages-keep-groups-whole release (Phase 2, #364)', () => {
  const ID = 'pages-keep-groups-whole-2026-10';
  const release = () => RELEASES.find((r) => r.id === ID)!;
  const owner: ReleaseViewer = {
    role: 'owner',
    permissions: [...PERMISSIONS],
    enabledModules: Object.keys(MODULE_REGISTRY) as ModuleId[],
  };
  const staff: ReleaseViewer = { role: 'staff', permissions: ['items:read'], enabledModules: [] };
  const viewer: ReleaseViewer = { role: 'viewer', permissions: ['items:read'], enabledModules: [] };
  const member: ReleaseViewer = { role: 'viewer', permissions: [], enabledModules: [] };
  const requester: ReleaseViewer = {
    role: 'viewer',
    permissions: ['orders:request'],
    enabledModules: ['orders'],
  };
  const words = () =>
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
    ].join(' ');
  /** A source file under apps/web/src, as written. */
  const source = (rel: string) => readFileSync(resolve(__dirname, '../..', rel), 'utf8');
  /** One light list row, as the plan reads it; a later `minute` sorts first. */
  const row = (
    id: string,
    name: string,
    sku: string,
    minute: number,
    extra: Partial<InstantModeRow> = {},
  ): InstantModeRow => ({
    id,
    sku,
    name,
    status: 'active',
    quantity_on_hand: 1,
    reorder_point: 0,
    unit_cost: 1,
    category_id: null,
    primary_location_id: null,
    charter_id: null,
    updated_at: new Date(Date.UTC(2026, 9, 12, 0, minute)).toISOString(),
    ...extra,
  });

  // Published once the web build was live (21:26:17Z) and the Demo Co walk
  // had passed and signed out (21:35:57Z). There is no phone part to wait for.
  // Renamed by docs/whats-new-redesign-2026-10 (2026-10-20; was: "is published at the top ..., dated after every release, ..."): the three redesign releases and the parked ai-search-finds-every-item release (#367) are published after it, at the top. Claim kept: dated after every release below it, and no draft is left.
  it('is published directly below the three redesign releases and the ai-search-finds-every-item release (all published later), after the web deploy and the Demo Co walk, dated after every release below it, and no draft is left', () => {
    // Re-pinned by the B44 phone update draft (fix/b44-update-restart-prompt;
    // was: without it): dated after every release, it sits at the top, so
    // every position below it moves down by one, and it and slice 8's are the
    // drafts.
    // Re-pinned by the small fixes slice 8 draft (fix/small-fixes-8; was:
    // without it): dated after every release, it sits at the top, so every
    // position below it moves down by one, and it is the one draft.
    expect(release().status).toBe('published');
    expect(release().revision).toBe(1);
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: at 0 and slice(1)): the three redesign releases and the parked ai-search-finds-every-item release (#367) are published after it, at the top, so this one sits directly below them, dated after every release below it.
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: the redesign and ai-search-finds-every-item releases at 0 to 3, and each position below them one place higher): the unsubscribe-rack-question-fixes release is published at the top, above the redesign releases, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: the unsubscribe-rack-question-fixes release at 0, and each position and slice below it one place higher): the ended-session-group-page-fixes release is published at the top, above it, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: the ended-session-group-page-fixes release at 0, and each position and slice below it one place higher): the manage-order-items-and-app-fixes release is published at the top, above it, so every position below it moves down by one.
    expect(RELEASES[1]?.id).toBe('small-fixes-8-2026-10');
    expect(RELEASES[1]?.status).toBe('draft');
    expect(RELEASES[2]?.id).toBe('manage-order-items-and-app-fixes-2026-10');
    expect(RELEASES[2]?.status).toBe('published');
    expect(RELEASES[3]?.id).toBe('ended-session-group-page-fixes-2026-10');
    expect(RELEASES[3]?.status).toBe('published');
    expect(RELEASES[4]?.id).toBe('unsubscribe-rack-question-fixes-2026-10');
    expect(RELEASES[4]?.status).toBe('published');
    expect(RELEASES.slice(5, 9).map((r) => [r.id, r.status])).toEqual([
      ['redesign-2026-10', 'published'],
      ['redesign-mobile-app-2026-10', 'published'],
      ['redesign-web-fixes-2026-10', 'published'],
      ['ai-search-finds-every-item-2026-10', 'published'],
    ]);
    expect(RELEASES[9]?.id).toBe(ID);
    expect(release().publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/);
    expect(Date.parse(release().publishedAt)).toBeGreaterThan(Date.parse('2026-10-12T21:35:57Z'));
    expect(Date.parse(release().publishedAt)).toBeLessThanOrEqual(
      Date.parse('2026-10-14T00:00:00Z'),
    );
    for (const r of RELEASES.slice(10)) {
      expect(Date.parse(release().publishedAt), r.id).toBeGreaterThan(Date.parse(r.publishedAt));
    }
    expect(RELEASES[1]?.id).toBe('small-fixes-8-2026-10');
    expect(RELEASES[1]?.status).toBe('draft');
    for (const r of RELEASES.slice(2, 9)) {
      expect(Date.parse(r.publishedAt), r.id).toBeGreaterThan(Date.parse(release().publishedAt));
    }
    expect(RELEASES.filter((r) => r.status === 'draft').map((r) => r.id)).toEqual([
      'mobile-app-asks-before-restarting',
      'small-fixes-8-2026-10',
    ]);
  });

  it('tells both entries to whoever can read items, with no links and no release-wide audience', () => {
    const r = release();
    expect(r.audience).toBeUndefined();
    const itemReaders = { anyPermission: ['items:read'] };
    expect(r.entries.map((e) => [e.id, e.category, e.area, e.audience, e.link ?? null])).toEqual([
      ['pages-keep-size-families-whole', 'fixed', 'Inventory', itemReaders, null],
      ['rack-view-totals-cover-the-rack', 'fixed', 'Inventory', itemReaders, null],
    ]);
  });

  // Renamed by docs/whats-new-redesign-2026-10 (2026-10-20; was: "is the first notice for an owner and for staff and viewers who can read items, ..."): the three redesign releases, published after it, reach every member first, and the parked ai-search-finds-every-item release (#367) reaches the owner (items:update with the AI module) before this one too. Claim kept: the next notice for each of them once those are read, and nobody who cannot read items is told it.
  it('is the notice for an owner and for staff and viewers who can read items once the newer releases that reach them are read, and reaches nobody who cannot', () => {
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: ID first with nothing read or seen): the three redesign releases are published at the top and reach every member, so each reader is told redesign-2026-10 first; the ai-search-finds-every-item release reaches the owner but neither staff nor viewers here (no AI module). They are read or seen here too.
    const aiSearchRead = {
      release_id: 'ai-search-finds-every-item-2026-10',
      revision: 1,
      dismissed_at: null,
      opened_at: '2026-10-20T13:00:00Z',
      read_at: '2026-10-20T13:00:00Z',
    };
    for (const v of [owner, staff, viewer]) {
      // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: redesign-2026-10 first with nothing read): the unsubscribe-rack-question-fixes release, published at the top, reaches every member and comes first until it is read; once it is, redesign-2026-10 is next as before. The reads below include it.
      // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: unsubscribe-rack-question-fixes-2026-10 with nothing read): the ended-session-group-page-fixes release, published at the top, reaches every member, so this reader is told it first and the unsubscribe-rack-question-fixes release once it is read. Claim kept: the same order after them.
      // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: ended-session-group-page-fixes-2026-10 with nothing read): the manage-order-items-and-app-fixes release, published at the top, reaches every member, so this reader is told it first and the ended-session-group-page-fixes release once it is read. Claim kept: the same order after them.
      expect(buildReleaseList(RELEASES, v, [], null).latestUnread?.id, v.role).toBe(
        'manage-order-items-and-app-fixes-2026-10',
      );
      expect(buildReleaseList(RELEASES, v, [latestRead()], null).latestUnread?.id, v.role).toBe(
        'ended-session-group-page-fixes-2026-10',
      );
      expect(
        buildReleaseList(RELEASES, v, [latestRead(), topRead()], null).latestUnread?.id,
        v.role,
      ).toBe('unsubscribe-rack-question-fixes-2026-10');
      expect(
        buildReleaseList(RELEASES, v, [latestRead(), topRead(), newestRead()], null).latestUnread
          ?.id,
        v.role,
      ).toBe('redesign-2026-10');
      // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: redesign-2026-10 first with nothing seen): the unsubscribe-rack-question-fixes release, published at the top, reaches every member and comes first until it is seen too; the seen sets below include it.
      // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: unsubscribe-rack-question-fixes-2026-10 with nothing seen): the ended-session-group-page-fixes release, published at the top, reaches every member, so this reader is told it first and the unsubscribe-rack-question-fixes release once it is seen. Claim kept: the same order after them.
      // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: ended-session-group-page-fixes-2026-10 with nothing seen): the manage-order-items-and-app-fixes release, published at the top, reaches every member, so this reader is told it first and the ended-session-group-page-fixes release once it is seen. Claim kept: the same order after them.
      expect(legacyAnnouncementsFor(RELEASES, v, {})[0]?.id, v.role).toBe(
        'manage-order-items-and-app-fixes-2026-10',
      );
      expect(legacyAnnouncementsFor(RELEASES, v, latestSeen())[0]?.id, v.role).toBe(
        'ended-session-group-page-fixes-2026-10',
      );
      expect(
        legacyAnnouncementsFor(RELEASES, v, { ...latestSeen(), ...topSeen() })[0]?.id,
        v.role,
      ).toBe('unsubscribe-rack-question-fixes-2026-10');
      expect(
        legacyAnnouncementsFor(RELEASES, v, { ...latestSeen(), ...topSeen(), ...newestSeen() })[0]
          ?.id,
        v.role,
      ).toBe('redesign-2026-10');
    }
    expect(visibleReleases(RELEASES, staff).map((r) => r.id)).not.toContain(
      'ai-search-finds-every-item-2026-10',
    );
    expect(visibleReleases(RELEASES, viewer).map((r) => r.id)).not.toContain(
      'ai-search-finds-every-item-2026-10',
    );
    for (const v of [owner, staff, viewer]) {
      const newerRead = v === owner ? [...redesignReads(), aiSearchRead] : redesignReads();
      const newerSeen: Record<string, boolean> =
        v === owner
          ? { ...redesignSeen(), 'ai-search-finds-every-item-2026-10': true }
          : redesignSeen();
      expect(buildReleaseList(RELEASES, v, newerRead, null).latestUnread?.id, v.role).toBe(ID);
      const mine = visibleReleases(RELEASES, v).find((r) => r.id === ID);
      expect(
        mine?.entries.map((e) => e.id),
        v.role,
      ).toEqual(['pages-keep-size-families-whole', 'rack-view-totals-cover-the-rack']);
      // No entry links, so an old phone build shows the title and the summary.
      expect(legacyAnnouncementsFor(RELEASES, v, newerSeen)[0], v.role).toEqual({
        id: ID,
        date: '2026-10-12',
        title: release().title,
        body: release().summary,
      });
    }
    for (const v of [member, requester]) {
      expect(visibleReleases(RELEASES, v).map((r) => r.id)).not.toContain(ID);
    }
    // Once it is read, the owner is told the Ungroup follow-ups release, as
    // before, and a viewer who only reads items Group selected's: the
    // follow-ups release reaches nobody who cannot edit items or manage
    // sports products.
    const read = {
      release_id: ID,
      revision: 1,
      dismissed_at: null,
      opened_at: '2026-10-12T21:41:00Z',
      read_at: '2026-10-12T21:41:00Z',
    };
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: the owner's and the viewer's lists with only this one read): the newer releases that reach each of them are read too, so their next notices are as before.
    expect(
      buildReleaseList(RELEASES, owner, [...redesignReads(), aiSearchRead, read], null).latestUnread
        ?.id,
    ).toBe('ungroup-follow-ups-2026-10');
    expect(
      buildReleaseList(RELEASES, viewer, [...redesignReads(), read], null).latestUnread?.id,
    ).toBe('group-selected-2026-10');
    expect(registryFingerprint(RELEASES)).toContain(`${ID}@1:published`);
    expect(registryFingerprint(RELEASES)).not.toBe(
      registryFingerprint(RELEASES.filter((r) => r.id !== ID)),
    );
    expect(ANNOUNCEMENTS.map((a) => a.id)).toContain(ID);
  });

  // canUseSharedInventoryCaches is manager or above with items:read, so staff
  // and viewers never read the shared caches: their Items and Books lists
  // always take the live branch, which plans the page (planLivePage) and
  // reads exactly that page (readPlannedPage). Managers, admins and owners
  // take it too on Items showing every item type (?type=all, where every low
  // stock link on the dashboard goes): the awaited instant branch needs
  // itemType 'product', and the cached default view refuses any other type.
  it('is for staff and viewers on every list, and for everyone on Items showing every item type, all on the planned live branch', () => {
    expect(isManagerOrAbove('staff')).toBe(false);
    expect(isManagerOrAbove('viewer')).toBe(false);
    for (const role of ['owner', 'admin', 'manager'] as const) {
      expect(isManagerOrAbove(role), role).toBe(true);
    }
    expect(source('server/loaders/inventory-list.ts')).toContain(
      "return isManagerOrAbove(ctx.role) && can(ctx, 'items:read');",
    );
    for (const page of [
      'app/(dashboard)/dashboard/inventory/page.tsx',
      'app/(dashboard)/dashboard/books/page.tsx',
    ]) {
      const code = source(page);
      expect(code, page).toContain('const PAGE_SIZE = 30;');
      expect(code, page).toContain('await planLivePage({');
      expect(code, page).toContain(
        'readPlannedPage(inventorySvc, viewFilters, plannedPage.pageIds, planTotals)',
      );
    }
    expect(source('app/(dashboard)/dashboard/inventory/page.tsx')).toContain(
      "const awaitsInstantDataset = useSharedCaches && itemType === 'product' && !isDefaultView;",
    );
    expect(source('server/loaders/inventory-list.ts')).toContain(
      "if (view === 'items' && params.type !== undefined && params.type !== 'product') return false;",
    );
    expect(source('app/(dashboard)/dashboard/page.tsx')).toContain(
      "href: '/dashboard/inventory?stock=low&type=all',",
    );
    expect(release().summary).toMatch(/^On the web, staff and viewers now see Items and Books /);
    // The summary is capped at 500 characters, so it says in one sentence
    // what entry 1 says in two.
    expect(release().summary).toContain(
      "Managers, admins and owners already did on most lists, and now do on Items showing every item type, where the dashboard's low stock links go.",
    );
    const [pages] = release().entries;
    expect(pages!.whatChanged).toContain(
      'as managers, admins and owners already did on most lists',
    );
    expect(pages!.whatChanged).toContain(
      "Everyone now sees Items this way when it shows every item type, which is how the dashboard's low stock links open it.",
    );
    expect(words()).not.toMatch(/mobile app|\bphone\b/i);
  });

  // The words against the plan itself (planGroupAwarePage, the rule managers'
  // instant mode pages with): the reported XS, a page that ends early, a
  // group of more than 30 records, and Books, which build no size runs.
  it('pages as the words say: the XS with its sizes on Items, a page ending before 30, more than 30 on a page of their own, no size run on Books', () => {
    // A shirt's S, M, L and XL were updated last, 27 other records after
    // them, and its XS long before: the XS is the 32nd record in the list's
    // order, so a fixed 30-record page left it alone on page 2.
    const sizes = ['S', 'M', 'L', 'XL'].map((s, i) =>
      row(`tee-${s}`, `Tee - ${s}`, `TEE-${s}`, 100 - i),
    );
    const others = Array.from({ length: 27 }, (_, i) =>
      row(`other-${String(i).padStart(2, '0')}`, `Other ${i}`, `OTH-${i}`, 90 - i),
    );
    const shirtView = [...others, row('tee-XS', 'Tee - XS', 'TEE-XS', 1), ...sizes];
    const onItems = (p: number) => planGroupAwarePage(shirtView, 'updated_desc', p, 30, 'items');
    expect(onItems(1).pageIds.slice(0, 5)).toEqual(['tee-S', 'tee-M', 'tee-L', 'tee-XL', 'tee-XS']);
    expect([onItems(1).pageItemCount, onItems(2).pageItemCount]).toEqual([30, 2]);
    // Books build no size runs, so there the same records page in the list's order.
    const onBooks = (p: number) => planGroupAwarePage(shirtView, 'updated_desc', p, 30, 'books');
    expect(onBooks(1).pageIds).not.toContain('tee-XS');
    expect(onBooks(2).pageIds).toEqual(['other-26', 'tee-XS']);
    // A page ends before 30 so that records sharing a SKU stay together, on
    // Items and on Books: 29 records, then two that share a SKU.
    const singles = Array.from({ length: 29 }, (_, i) =>
      row(`one-${String(i).padStart(2, '0')}`, `Single ${i}`, `ONE-${i}`, 100 - i),
    );
    const pair = [row('pair-a', 'Pair', 'PAIR', 50), row('pair-b', 'Pair', 'PAIR', 2)];
    const pairView = [...singles, ...pair];
    // A group of more than 30 records gets a page of its own.
    const group = Array.from({ length: 35 }, (_, i) =>
      row(`g${i}`, `Grouped ${i}`, `GRP-${i}`, 100 - i, { display_group_id: 'g-1' }),
    );
    const groupView = [...group, row('after', 'After', 'AFTER', 10)];
    for (const view of ['items', 'books'] as const) {
      const first = planGroupAwarePage(pairView, 'updated_desc', 1, 30, view);
      expect(first.pageItemCount, view).toBe(29);
      const second = planGroupAwarePage(pairView, 'updated_desc', 2, 30, view);
      expect(second.pageIds, view).toEqual(['pair-a', 'pair-b']);
      // The count above the list: 31 records and 30 SKUs, since two share one.
      expect(first.distinctSkus, view).toBe(30);
      const groupPage = planGroupAwarePage(groupView, 'updated_desc', 1, 30, view);
      expect(groupPage.pageItemCount, view).toBe(35);
      const nextPage = planGroupAwarePage(groupView, 'updated_desc', 2, 30, view);
      expect(nextPage.pageIds, view).toEqual(['after']);
    }
    const [pages] = release().entries;
    expect(pages!.howItAffectsYou).toContain(
      "A page can end before 30 records so that a header's records are not cut in two, and a header of more than 30 records gets a page of its own.",
    );
    expect(pages!.whyItMatters).toContain('while its XS sat alone on page 2');
  });

  // A size stocked on more than one rack has a record for each rack, sharing
  // one SKU (the Ungroup follow-ups release). Core makeDisplayUnitKeyer takes a
  // shared SKU before a size run, so those records are a unit of their own:
  // kept together under the SKU's header, but they can land on another page
  // from the run, as in managers' instant mode. The words say so.
  it('says a size with a record for each of several racks keeps its own header, which can be on a different page from its other sizes', () => {
    const sizes = ['S', 'M', 'L', 'XL'].map((s, i) =>
      row(`tee-${s}`, `Tee - ${s}`, `TEE-${s}`, 100 - i, { group_id: 'fam-1' }),
    );
    const others = Array.from({ length: 27 }, (_, i) =>
      row(`other-${String(i).padStart(2, '0')}`, `Other ${i}`, `OTH-${i}`, 90 - i),
    );
    const xs = [
      row('tee-XS-a', 'Tee - XS', 'TEE-XS', 2, { group_id: 'fam-1' }),
      row('tee-XS-b', 'Tee - XS', 'TEE-XS', 1, { group_id: 'fam-1' }),
    ];
    const view = [...others, ...xs, ...sizes];
    const page = (p: number) => planGroupAwarePage(view, 'updated_desc', p, 30, 'items');
    expect(page(1).pageIds.slice(0, 4)).toEqual(['tee-S', 'tee-M', 'tee-L', 'tee-XL']);
    expect(page(1).pageIds).not.toContain('tee-XS-a');
    expect(page(2).pageIds).toEqual(['other-26', 'tee-XS-a', 'tee-XS-b']);
    const [pages] = release().entries;
    expect(pages!.whatChanged).toContain(
      "A size stocked on more than one rack, with a record for each rack, shows under its SKU's header, which can be on a different page from its other sizes.",
    );
  });

  // The words name the screens as they read: the table (the Books list renders
  // it too), its count and value at the end of the toolbar above it, its
  // search box, the Rack control, and the dashboard's Review low stock link.
  it("names what the screens show: Low + critical, a rack, on hand above the table, SKUs then items or rows, and the search box's 30 matches", () => {
    const table = source('components/inventory/inventory-table.tsx');
    expect(table).toContain(
      "const VIEWS = ['All items', 'Low + critical', 'Out of stock'] as const;",
    );
    const rackControl = source('components/inventory/rack-filter-dropdown.tsx');
    expect(rackControl).toContain("Rack: {current || 'Any'}");
    // The footer: the SKUs first, then the records as items on Items and as
    // rows on Books when the two differ, then the value on hand. A fixed page
    // still says N items, as every staff page, and every page of Items showing
    // every item type, did before. It sits in the toolbar, above the table.
    expect(table).toContain(
      "const rowsLabel = placementRowCount === null && !showBookFields ? 'items' : 'rows';",
    );
    expect(table).toContain('{formatNumber(skus)} SKUs ·');
    expect(table).toContain('{formatCurrency(valueOnHand)} on hand');
    expect(table).toContain('{formatNumber(total)} items · {formatCurrency(valueOnHand)} on hand');
    expect(table.indexOf('{formatCurrency(valueOnHand)} on hand')).toBeLessThan(
      table.indexOf('{/* Table */}'),
    );
    // A search on screen shows /api/items/search's first page of matches and
    // never a planned page.
    expect(table).toContain('placeholder="Search name, SKU, barcode…"');
    expect(table).toContain("url.searchParams.set('limit', String(pageSize));");
    expect(table).toContain('if (instantMode || q.trim()) return null;');
    expect(INSTANT_MODE_MAX_ROWS).toBe(2000);
    const [pages, rack] = release().entries;
    expect(pages!.howItAffectsYou).toContain(
      'The count above the list now starts with the number of SKUs, then gives the number of items (rows on Books) when some SKUs have more than one record.',
    );
    // Over the cap a Low + critical page is still list()'s 30 pre-filtered
    // records, filtered again after they are read, so the words do not
    // promise 30 records on each page there.
    expect(pages!.howItAffectsYou).toContain(
      'Lists of more than 2,000 records are still cut every 30 records, as before',
    );
    expect(pages!.howItAffectsYou).toContain(
      'a search typed into the search box still shows its first 30 matches',
    );
    // A fixed page of a list over one page marks a header of two or more
    // records with a * after On hand; a planned page keeps the unit whole.
    expect(table).toContain('if (!headerUnitCountsFull) return !singlePage && records > 1;');
    expect(pages!.whyItMatters).toContain('also showed a * after its on hand figure');
    expect(pages!.whatChanged).toContain(
      'and on Items a size run (sizes shown together by name or by product family)',
    );
    expect(release().summary).toContain(
      'the records that share a SKU or a group, and on Items a size run.',
    );
    // A size with a record for each of several racks can still land on
    // another page (the test above), so the summary does not promise it.
    expect(release().summary).not.toMatch(/sits alone/);
    expect(rack!.whatChanged).toContain('With Low + critical chosen as well');
    expect(rack!.whyItMatters).toContain('a Low + critical view of one rack');
    expect(release().summary).toContain(
      'with Low + critical the number of records, now cover only that rack',
    );
    // The draft's words that the screens and the code do not bear out. The one
    // "low stock" the words keep names the dashboard's links (Review low
    // stock), not the chip, which reads Low + critical.
    expect(source('components/dashboard/widgets/shift-command.tsx')).toContain(
      'label="Review low stock"',
    );
    expect(words().replace(/the dashboard's low stock links/g, '')).not.toMatch(
      /Low stock|where it said rows|every page/i,
    );
    expect(words()).not.toMatch(/under (the|these|a rack's) list/i);
  });

  // list()'s page query, its value scan and the plan scan take every filter
  // from applyContentFilters; the value scan used to skip the rack filter,
  // and with stock=low list() counts and pages from that scan. A fixed Low +
  // critical page is 30 records that pass the low pre-filter, filtered again
  // after they are read; the plan scan filters the whole view first, so every
  // low record is planned onto a page.
  it('rests the rack totals on the one filter method the page, the value scan and the plan scan share, and plans every Low + critical record', () => {
    const svc = source('server/services/inventory.ts');
    const at = (marker: string) => {
      const i = svc.indexOf(marker);
      expect(i, marker).toBeGreaterThanOrEqual(0);
      return i;
    };
    const filters = svc.slice(at('private applyContentFilters('), at('private filteredScanPage('));
    expect(filters).toContain('if (filters.rack && filters.rack.trim()) {');
    const scan = svc.slice(at('private filteredScanPage('), at('async listPlanRows('));
    expect(scan).toContain('sumQuery = this.applyContentFilters(sumQuery, filters);');
    const plan = svc.slice(at('async listPlanRows('), at('async list(filters'));
    expect(plan).toContain('this.filteredScanPage(filters, access, PLAN_ROW_COLUMNS');
    expect(plan).toContain('if (first.count > INSTANT_MODE_MAX_ROWS) return null;');
    expect(plan).toContain(
      'rows = rows.filter((r) => r.quantity_on_hand <= r.reorder_point || r.quantity_on_hand <= 0);',
    );
    const list = svc.slice(at('async list(filters'), at('async listByIdsForExport('));
    expect(list).toContain('query = this.applyContentFilters(query, filters);');
    expect(list).toContain('this.filteredScanPage(');
    expect(list).toContain('totalCount = sumRows.length;');
    // The fixed page is cut from the query before the rows are filtered.
    expect(list).toContain('.range(offset, offset + limit - 1);');
    expect(list.indexOf('.range(offset, offset + limit - 1);')).toBeLessThan(
      list.indexOf('const filtered = rows.filter('),
    );
    const [pages, rack] = release().entries;
    // The cap is checked on the low pre-filter's count, before the low rule.
    expect(filters).toContain("query = query.or('reorder_point.gt.0,quantity_on_hand.lte.0');");
    expect(plan.indexOf('if (first.count > INSTANT_MODE_MAX_ROWS) return null;')).toBeLessThan(
      plan.indexOf('if (filters.lowStock) {'),
    );
    expect(pages!.howItAffectsYou).toContain(
      '(for Low + critical, the 2,000 counts every record with a reorder point or no stock)',
    );
    expect(pages!.howItAffectsYou).toContain(
      'With Low + critical chosen, every low or critical record is now on a page',
    );
    expect(pages!.whyItMatters).toContain(
      'With Low + critical chosen, a page used to show only the low or critical ones among 30 records, so it could show few or none, and some could be on no page.',
    );
    expect(rack!.whatChanged).toContain(
      "the on hand value above the list now adds up only that rack's records",
    );
    expect(rack!.whatChanged).toContain('or anyone does on Items when it shows every item type');
    expect(rack!.whyItMatters).toContain('These totals used to add up every rack');
  });

  it('never calls a recorded quantity "the book" and claims no speed nobody measured', () => {
    expect(words()).not.toMatch(/\bthe book\b|\bbook (count|quantity|stock)\b/i);
    expect(words()).not.toMatch(/\bfaster\b|\bquicker\b|\bspeed\b|\binstant/i);
  });
});

// #367 merged as 36cb9b619 and web build 05dbc57aee63 went live at
// 2026-10-13T23:43:11Z; migration 0401 went live at 2026-10-14T00:22:33Z and
// the hourly sweep's first run (00:37Z) embedded every item that was
// missing one. Size runs and duplicates get their search embedding when they
// are saved, an edit that changes an item's searched text rebuilds it (the
// SKU's other records and Ungroup's records too, and 0401 clears a stale one
// in the same UPDATE), and the hourly sweep fills in what is left in
// organizations with AI switched on. The Demo Co walk
// (walk-0401/WALK-0401.md, 00:39-00:40Z) passed. No phone change: the mobile
// app's AI Assistant chats through the same route.
//
// Re-applied by hand by docs/whats-new-redesign-2026-10 (2026-10-20) from
// its parked What's New draft (a local commit on the branch
// docs/whats-new-ai-search-finds-every-item, never pushed), where the owner
// parked it on 2026-10-14 until the full-app redesign shipped. The
// release's words are unchanged. It is published with
// the redesign, a minute below the three redesign releases, so its place,
// its date and its readers' first notice are re-pinned here, and four
// labels its words name are read where they sit at 036002d43 (New item and
// Edit item are page titles, the barcode field's label is a prop, and the
// Modules entry moved to components/settings/settings-nav.tsx).
describe('the ai-search-finds-every-item release (#367, 0401)', () => {
  const ID = 'ai-search-finds-every-item-2026-10';
  const release = () => RELEASES.find((r) => r.id === ID)!;
  const owner: ReleaseViewer = {
    role: 'owner',
    permissions: [...PERMISSIONS],
    enabledModules: Object.keys(MODULE_REGISTRY) as ModuleId[],
  };
  const aiStaff: ReleaseViewer = {
    role: 'staff',
    permissions: ['items:read', 'items:update'],
    enabledModules: ['ai'],
  };
  const editorWithoutAi: ReleaseViewer = {
    role: 'staff',
    permissions: ['items:read', 'items:update'],
    enabledModules: [],
  };
  const aiViewer: ReleaseViewer = {
    role: 'viewer',
    permissions: ['items:read'],
    enabledModules: ['ai'],
  };
  const member: ReleaseViewer = { role: 'viewer', permissions: [], enabledModules: [] };
  const words = () =>
    [
      release().title,
      release().summary,
      ...release().entries.flatMap((e) => [
        e.title,
        e.area ?? '',
        e.whatChanged,
        e.whyItMatters,
        e.howItAffectsYou,
        e.whatToDo,
      ]),
    ].join(' ');
  /** A file in the repository, as written. */
  const REPO = resolve(__dirname, '../../../../..');
  const repoFile = (rel: string) => readFileSync(resolve(REPO, rel), 'utf8');
  /** A source file under apps/web/src, as written. */
  const source = (rel: string) => repoFile(`apps/web/src/${rel}`);
  /** The text of `file` from `from` up to `to`, both of which must be in it. */
  const between = (file: string, from: string, to: string) => {
    const a = file.indexOf(from);
    const b = file.indexOf(to, a + 1);
    expect(a, from).toBeGreaterThanOrEqual(0);
    expect(b, to).toBeGreaterThan(a);
    return file.slice(a, b);
  };

  // Published once the web build was live (23:43:11Z), 0401 was live
  // (00:22:33Z), the first hourly run had filled every missing item (00:37Z)
  // and the Demo Co walk had passed (00:39-00:40Z).
  // Renamed by docs/whats-new-redesign-2026-10 (2026-10-20; was: "is published at the top ..., dated after every release, ...",
  // at 0, dated by 2026-10-15): parked until the redesign shipped and
  // published with it, after the release commit 036002d43 (09:32:39Z), a
  // minute below the three redesign releases, which sit above it. Claim kept:
  // after the web deploy, 0401, the first hourly run and the Demo Co walk,
  // dated after every release below it, and no draft is left.
  // Its T is the redesign releases' T less a minute, provisional until the
  // publish PR sets it: the publish guard at the end of this file holds it at
  // or after REDESIGN_LIVE_AT. Here the release commit is the floor and T's
  // day (UTC) the ceiling, as earlier releases' tests pin theirs, so a
  // publish on a later day moves this bound and the date pins with T.
  it('is published directly below the three redesign releases (published later), after the web deploy, migration 0401, the first hourly run, the Demo Co walk and the redesign release commit, dated after every release below it, and no draft is left', () => {
    // Re-pinned by the B44 phone update draft (fix/b44-update-restart-prompt;
    // was: without it): dated after every release, it sits at the top, so
    // every position below it moves down by one, and it and slice 8's are the
    // drafts.
    // Re-pinned by the small fixes slice 8 draft (fix/small-fixes-8; was:
    // without it): dated after every release, it sits at the top, so every
    // position below it moves down by one, and it is the one draft.
    expect(release().status).toBe('published');
    expect(release().revision).toBe(1);
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: the redesign releases at 0 to 2, this one at 3, the minute measured from RELEASES[2] and slice(4)): the unsubscribe-rack-question-fixes release is published at the top, above the redesign releases, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: the unsubscribe-rack-question-fixes release at 0, and each position and slice below it one place higher): the ended-session-group-page-fixes release is published at the top, above it, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: the ended-session-group-page-fixes release at 0, and each position and slice below it one place higher): the manage-order-items-and-app-fixes release is published at the top, above it, so every position below it moves down by one.
    expect(RELEASES[1]?.id).toBe('small-fixes-8-2026-10');
    expect(RELEASES[1]?.status).toBe('draft');
    expect(RELEASES[2]?.id).toBe('manage-order-items-and-app-fixes-2026-10');
    expect(RELEASES[2]?.status).toBe('published');
    expect(RELEASES[3]?.id).toBe('ended-session-group-page-fixes-2026-10');
    expect(RELEASES[3]?.status).toBe('published');
    expect(RELEASES[4]?.id).toBe('unsubscribe-rack-question-fixes-2026-10');
    expect(RELEASES[4]?.status).toBe('published');
    expect(RELEASES.slice(5, 8).map((r) => [r.id, r.status])).toEqual([
      ['redesign-2026-10', 'published'],
      ['redesign-mobile-app-2026-10', 'published'],
      ['redesign-web-fixes-2026-10', 'published'],
    ]);
    expect(RELEASES[8]?.id).toBe(ID);
    expect(release().publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/);
    expect(Date.parse(release().publishedAt)).toBeGreaterThan(Date.parse('2026-10-14T00:40:00Z'));
    expect(Date.parse(release().publishedAt)).toBeGreaterThan(Date.parse('2026-10-20T09:32:39Z'));
    expect(Date.parse(release().publishedAt)).toBeLessThanOrEqual(
      Date.parse('2026-10-21T00:00:00Z'),
    );
    expect(Date.parse(RELEASES[7]!.publishedAt) - Date.parse(release().publishedAt)).toBe(60_000);
    for (const r of RELEASES.slice(9)) {
      expect(Date.parse(release().publishedAt), r.id).toBeGreaterThan(Date.parse(r.publishedAt));
    }
    expect(RELEASES.filter((r) => r.status === 'draft').map((r) => r.id)).toEqual([
      'mobile-app-asks-before-restarting',
      'small-fixes-8-2026-10',
    ]);
  });

  // The chat route asserts the 'ai' module and refuses anyone without
  // items:update, and so does the AI Assistant page; the mobile app's AI
  // Assistant posts to the same route. A comp turns the module on for
  // members, so they are told too (the words then say when the hourly check
  // runs).
  it('tells its one entry to whoever can use the AI Assistant (items:update with the AI module), with no link and no release-wide audience', () => {
    const r = release();
    expect(r.audience).toBeUndefined();
    const assistantUsers = { anyPermission: ['items:update'], modules: ['ai'] };
    expect(r.entries.map((e) => [e.id, e.category, e.area, e.audience, e.link ?? null])).toEqual([
      ['ai-search-finds-sizes-and-duplicates', 'fixed', 'AI Assistant', assistantUsers, null],
    ]);
    const chat = source('app/api/ai/chat/route.ts');
    expect(chat).toContain("assertModuleEnabled(ctx, 'ai');");
    expect(chat).toContain("if (!can(ctx, 'items:update')) {");
    const page = source('app/(dashboard)/dashboard/ai/page.tsx');
    expect(page).toContain("const moduleAccess = await checkModuleAccess('ai');");
    expect(page).toContain("if (!can(ctx, 'items:update')) {");
    expect(repoFile('apps/mobile/app/ai/chat.tsx')).toContain('fetch(`${API_BASE}/api/ai/chat`, {');
    // The name the screens give it.
    expect(MODULE_REGISTRY.ai.title).toBe('AI Assistant');
    expect(
      MODULE_REGISTRY.ai.placements
        .filter((p) => p.href === '/dashboard/ai' || p.href === '/ai')
        .map((p) => [p.surface, p.label, p.requires]),
    ).toEqual([
      ['web_sidebar', 'AI Assistant', 'items:update'],
      ['mobile_drawer', 'AI Assistant', 'items:update'],
    ]);
  });

  // Renamed by docs/whats-new-redesign-2026-10 (2026-10-20; was: "is the first notice for an owner and for staff who can use
  // the AI Assistant, ..."): the three redesign releases, published after it,
  // reach every member first. Claim kept: the notice for both once those are
  // read, and nobody else is told it.
  // Renamed by docs/whats-new-2026-10-25 (2026-10-25; was: "... once the three redesign releases are read, ..."): the
  // unsubscribe-rack-question-fixes release, published after them at the top, reaches every member first too, and
  // redesignReads() reads it with them. Claim kept: the notice for both once the releases above it are read, and
  // nobody else is told it.
  // Renamed by docs/whats-new-2026-10-26 (2026-10-26; was: "... once the three redesign releases and the unsubscribe-rack-question-fixes release are read, ..."): the ended-session-group-page-fixes release, published at the top, reaches every member first too, and redesignReads() reads it with them. Claim kept: the notice for both once the releases above it are read, and nobody else is told it.
  // Renamed by docs/whats-new-2026-10-30 (2026-10-30; was: "... and the unsubscribe-rack-question-fixes and ended-session-group-page-fixes releases are read, ..."): the manage-order-items-and-app-fixes release, published at the top, reaches every member first too, and redesignReads() reads it with them. Claim kept: the notice for both once the releases above it are read, and nobody else is told it.
  it('is the notice for an owner and for staff who can use the AI Assistant once the three redesign releases and the unsubscribe-rack-question-fixes, ended-session-group-page-fixes and manage-order-items-and-app-fixes releases are read, and reaches nobody else', () => {
    for (const v of [owner, aiStaff]) {
      // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: redesign-2026-10 first with nothing read): the unsubscribe-rack-question-fixes release, published at the top, reaches every member and comes first until it is read; once it is, redesign-2026-10 is next as before.
      // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: unsubscribe-rack-question-fixes-2026-10 with nothing read): the ended-session-group-page-fixes release, published at the top, reaches every member, so this reader is told it first and the unsubscribe-rack-question-fixes release once it is read. Claim kept: the same order after them.
      // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: ended-session-group-page-fixes-2026-10 with nothing read): the manage-order-items-and-app-fixes release, published at the top, reaches every member, so this reader is told it first and the ended-session-group-page-fixes release once it is read. Claim kept: the same order after them.
      expect(buildReleaseList(RELEASES, v, [], null).latestUnread?.id, v.role).toBe(
        'manage-order-items-and-app-fixes-2026-10',
      );
      expect(buildReleaseList(RELEASES, v, [latestRead()], null).latestUnread?.id, v.role).toBe(
        'ended-session-group-page-fixes-2026-10',
      );
      expect(
        buildReleaseList(RELEASES, v, [latestRead(), topRead()], null).latestUnread?.id,
        v.role,
      ).toBe('unsubscribe-rack-question-fixes-2026-10');
      expect(
        buildReleaseList(RELEASES, v, [latestRead(), topRead(), newestRead()], null).latestUnread
          ?.id,
        v.role,
      ).toBe('redesign-2026-10');
      expect(buildReleaseList(RELEASES, v, redesignReads(), null).latestUnread?.id, v.role).toBe(
        ID,
      );
      expect(
        visibleReleases(RELEASES, v)
          .find((r) => r.id === ID)
          ?.entries.map((e) => e.id),
        v.role,
      ).toEqual(['ai-search-finds-sizes-and-duplicates']);
      // No entry links, so an old phone build shows the title and the summary,
      // once the redesign releases above it are seen; its date is the day it
      // is published (T's day, set at publish with T).
      // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: redesign-2026-10 first with nothing seen): the unsubscribe-rack-question-fixes release, published at the top, reaches every member and comes first until it is seen too; the seen sets below include it.
      // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: unsubscribe-rack-question-fixes-2026-10 with nothing seen): the ended-session-group-page-fixes release, published at the top, reaches every member, so this reader is told it first and the unsubscribe-rack-question-fixes release once it is seen. Claim kept: the same order after them.
      // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: ended-session-group-page-fixes-2026-10 with nothing seen): the manage-order-items-and-app-fixes release, published at the top, reaches every member, so this reader is told it first and the ended-session-group-page-fixes release once it is seen. Claim kept: the same order after them.
      expect(legacyAnnouncementsFor(RELEASES, v, {})[0]?.id, v.role).toBe(
        'manage-order-items-and-app-fixes-2026-10',
      );
      expect(legacyAnnouncementsFor(RELEASES, v, latestSeen())[0]?.id, v.role).toBe(
        'ended-session-group-page-fixes-2026-10',
      );
      expect(
        legacyAnnouncementsFor(RELEASES, v, { ...latestSeen(), ...topSeen() })[0]?.id,
        v.role,
      ).toBe('unsubscribe-rack-question-fixes-2026-10');
      expect(
        legacyAnnouncementsFor(RELEASES, v, { ...latestSeen(), ...topSeen(), ...newestSeen() })[0]
          ?.id,
        v.role,
      ).toBe('redesign-2026-10');
      expect(legacyAnnouncementsFor(RELEASES, v, redesignSeen())[0], v.role).toEqual({
        id: ID,
        date: '2026-10-20',
        title: release().title,
        body: release().summary,
      });
    }
    // Without the module, or without items:update, the chat route refuses
    // them, so they are not told.
    for (const v of [editorWithoutAi, aiViewer, member]) {
      expect(visibleReleases(RELEASES, v).map((r) => r.id)).not.toContain(ID);
    }
    // Once it is read, the owner is told the pages-keep-groups-whole release,
    // as before (with the redesign releases above it read too).
    const read = {
      release_id: ID,
      revision: 1,
      dismissed_at: null,
      opened_at: '2026-10-14T00:46:00Z',
      read_at: '2026-10-14T00:46:00Z',
    };
    expect(
      buildReleaseList(RELEASES, owner, [...redesignReads(), read], null).latestUnread?.id,
    ).toBe('pages-keep-groups-whole-2026-10');
    expect(registryFingerprint(RELEASES)).toContain(`${ID}@1:published`);
    expect(registryFingerprint(RELEASES)).not.toBe(
      registryFingerprint(RELEASES.filter((r) => r.id !== ID)),
    );
    expect(ANNOUNCEMENTS.map((a) => a.id)).toContain(ID);
  });

  // The assistant's search by meaning reads only items with an embedding;
  // its keyword search matches name, SKU or barcode and never needed one.
  // The size-run path and Duplicate never embedded; both call
  // embedInBackground now, right after the rows are saved, in the
  // background (so the words say "when they are saved", not "as soon as").
  it("rests the size-run and Duplicate words on the two paths that now embed when saved, and on the assistant's two searches", () => {
    const tools = source('lib/ai/tools.ts');
    const semantic = between(
      tools,
      'const searchInventorySemanticTool',
      'const backfillEmbeddingsTool',
    );
    expect(semantic).toContain('Find items by MEANING, not just keyword.');
    expect(semantic).toContain('Only items that have been embedded show up');
    expect(semantic).toContain("'match_inventory_items_by_embedding'");
    const keyword = between(tools, 'const searchInventoryTool', 'categoryId: {');
    expect(keyword).toContain('Matches name, SKU, or barcode.');
    const svc = source('server/services/inventory.ts');
    const sized = between(svc, 'async bulkCreateSizedVariants(', 'async bulkCreate(input');
    expect(sized).toContain(
      'embedInBackground(\n      inserted.map((r) => r.id),\n      this.ctx,\n    );',
    );
    const duplicate = between(svc, 'async duplicateItem(', 'private async loadSizeScale(');
    expect(duplicate).toContain('embedInBackground([newId as string], this.ctx);');
    expect(source('server/services/lib/embed-in-background.ts')).toContain(
      'keepAlive(\n    (async () => {',
    );
    // The labels the words name: Sizes on New item, Add more sizes on Edit
    // item (the form shows it only when editing), Sizes & quantities in the
    // mobile app, Duplicate.
    const form = source('components/inventory/item-form.tsx');
    expect(form).toContain('<Field label="Sizes" optional={!sizeRequired}>');
    expect(form).toContain(
      '{`Pick sizes to add one item per size, or enter one size in ${profile.label} details below.`}',
    );
    expect(form).toContain('bulkCreateSizedVariantsAction({');
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: the page's own <h1>): at 036002d43 the
    // page header draws the title.
    expect(source('app/(dashboard)/dashboard/inventory/new/page.tsx')).toContain(
      'title="New item"',
    );
    expect(between(form, 'if (!isEdit) return null;', '<AddSizedVariantsButton')).not.toContain(
      '})()}',
    );
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: the page's own <h1>): at 036002d43 the
    // page header draws the title.
    expect(source('app/(dashboard)/dashboard/inventory/[id]/edit/page.tsx')).toContain(
      'title="Edit item"',
    );
    const addSizes = source('components/inventory/add-sized-variants-button.tsx');
    expect(addSizes).toContain('<Plus className="h-3.5 w-3.5" /> Add more sizes');
    expect(addSizes).toContain('await bulkCreateSizedVariantsAction({');
    expect(repoFile('apps/mobile/app/item/new.tsx')).toContain(
      '<SectionLabel>SIZES & QUANTITIES</SectionLabel>',
    );
    expect(repoFile('apps/mobile/src/lib/item-create.ts')).toContain(
      "'/api/v1/items/sized-variants',",
    );
    expect(source('app/api/v1/items/sized-variants/route.ts')).toContain(
      'bulkCreateSizedVariants(',
    );
    expect(source('components/inventory/duplicate-item-dialog.tsx')).toContain(
      '<Copy className="h-4 w-4" /> Duplicate',
    );
    const [entry] = release().entries;
    expect(entry!.whatChanged).toContain(
      'Items added as a run of sizes (under Sizes on New item, Sizes & quantities in the mobile app, or Add more sizes on Edit item) and copies made with Duplicate now get search data when they are saved. The AI Assistant uses this data to find items by what they are.',
    );
    expect(entry!.whatChanged).toContain('rather than by name or SKU, it could leave them out.');
    // Before #367 they could get it later, from Settings > AI's backfill (every
    // item still without it) or an edit of a searched field, never when saved.
    expect(source('server/actions/embeddings.ts')).toContain(
      'const result = await embedItemsBatch(ctx, { limit: input.limit });',
    );
    expect(entry!.whatChanged).toContain('Before, they did not get it when they were saved,');
    expect(words()).not.toMatch(/never got it/i);
    // Only the search by meaning left them out, so the words say "when you
    // describe items", never every request to find items. What Duplicate
    // makes is a copy: the assistant calls an item entered twice a duplicate.
    expect(entry!.howItAffectsYou).toMatch(
      /^When you describe items, the assistant includes these records\./,
    );
    expect(tools).toContain('flags duplicates already in inventory (same barcode)');
    expect(words()).not.toMatch(/duplicated/i);
    expect(entry!.howItAffectsYou).toMatch(
      /fully searchable this way\. Searching by name or SKU always finds them\.$/,
    );
    expect(release().summary).toMatch(
      /^Items added as a run of sizes, and copies made with Duplicate, are now included when you ask the AI Assistant to find items by what they are\./,
    );
    expect(words()).not.toMatch(/as soon as|the moment/i);
  });

  // update() rebuilds the record when its searched text changed, and now the
  // SKU's other records its fan-out rewrote; Ungroup rebuilds the records it
  // gave a new SKU. 0401 clears a row's old embedding in the same UPDATE when
  // that text changed, so a failed rebuild leaves the item for the sweep.
  it("rests the edit words on what the save rebuilds: the item's name, SKU, barcode/ISBN, description or author, the SKU's other records, and Ungroup's new SKUs", () => {
    const embeddings = source('lib/ai/embeddings.ts');
    const searched = between(
      embeddings,
      'export function itemEmbeddingSource(',
      'const EMBED_TIMEOUT_MS',
    );
    for (const part of [
      'parts.push(item.name.trim());',
      'parts.push(`SKU ${item.sku.trim()}`);',
      'parts.push(`Barcode ${item.barcode.trim()}`);',
      'parts.push(item.description.trim());',
      'parts.push(`Author ${cf.author.trim()}`);',
    ]) {
      expect(searched).toContain(part);
    }
    // The Books edit form labels that field ISBN, so the words say
    // barcode/ISBN, as earlier releases do.
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: "<Field label={isBook ? ..." on one line):
    // at 036002d43 the label is a prop on a line of its own.
    expect(source('components/inventory/item-form.tsx')).toContain(
      "label={isBook ? 'ISBN' : 'Barcode'}",
    );
    const update = between(
      source('server/services/inventory.ts'),
      'async update(id: string, patch: UpdateItemInput)',
      'private async assertTrackingTypeChangeAllowed(',
    );
    expect(update).toContain(
      "const EMBED_RELEVANT_KEYS = new Set([\n      'name',\n      'sku',\n      'barcode',\n      'description',\n      'custom_fields',\n    ]);",
    );
    expect(update).toContain('embedInBackground([id], this.ctx);');
    expect(update).toContain('embedInBackground(siblingIds, {');
    // The SKU's other records take the name, SKU, barcode and description
    // (shared fields), never the author (per record), so the words say
    // "other records of that SKU that the save also changes".
    expect(update).toContain('if (sharedSearchedChanged && siblingIds.length > 0) {');
    const shared = between(
      source('server/services/inventory.ts'),
      'const SHARED_ITEM_FIELDS = [',
      '] as const;',
    );
    for (const field of ["'name',", "'sku',", "'description',", "'barcode',"]) {
      expect(shared).toContain(field);
    }
    expect(shared).not.toContain('custom_fields');
    expect(source('server/services/item-grouping.ts')).toContain(
      'embedInBackground(\n          outcome.items.filter((it) => !it.kept).map((it) => it.id),\n          this.ctx,\n        );',
    );
    const migration = repoFile(
      'supabase/migrations/0401_inventory_items_clear_stale_embedding.sql',
    );
    expect(migration).toContain(
      'before update of name, sku, barcode, description, custom_fields on public.inventory_items',
    );
    expect(migration).toContain(
      "or (new.custom_fields -> 'author') is distinct from (old.custom_fields -> 'author')",
    );
    expect(migration).toContain('new.embedding := null;');
    const [entry] = release().entries;
    expect(entry!.howItAffectsYou).toContain(
      "After you change an item's name, SKU, barcode/ISBN, description or author, the assistant searches by the new words, as it does for other records of that SKU that the save also changes, and for records Ungroup gives a new SKU.",
    );
    expect(entry!.howItAffectsYou).toContain('and for any other item missing it');
    expect(release().summary).toContain(
      "The assistant's search data is also kept up to date after edits",
    );
  });

  // The hourly sweep works only where the organization's own switch for the
  // AI module is on: a comp lets members use the assistant without starting
  // it, which the Modules page tells a comped organization. At most 100
  // items per organization a run. The Books page's Bulk ISBN import
  // (InventoryService.bulkCreate) and the assistant's own book import
  // (BooksImportService.execute) insert books without embedding them. Each
  // organization's batch takes every live item still without one, whatever
  // left it so (a new item whose first embed failed, the stock row a kit's
  // assembly inserts), so the words say "any other item missing it".
  it('says when the hourly check runs and what it fills in: books from Bulk ISBN import or the assistant, and any item left without search data', () => {
    const vercel = repoFile('apps/web/vercel.json');
    expect(vercel).toContain(
      '"path": "/api/cron/embeddings-sweep",\n      "schedule": "37 * * * *"',
    );
    const sweep = source('lib/ai/embeddings-sweep.ts');
    expect(sweep).toContain('perOrgCap: 100,');
    expect(sweep).toContain(".eq('module_id', 'ai')\n        .eq('enabled', true)");
    expect(sweep).toContain(".is('deleted_at', null)\n      .is('embedding', null)");
    expect(sweep).toContain('const batch = await embedItemsBatch(');
    const batch = between(
      source('lib/ai/embeddings.ts'),
      'export async function embedItemsBatch(',
      'let embedded = 0;',
    );
    expect(batch).toContain(".is('deleted_at', null)\n    .is('embedding', null)");
    // Re-pinned by docs/whats-new-redesign-2026-10 (2026-10-20; was: the Settings page's own list): at 036002d43
    // the Settings page and its settings menu read one list of entries.
    expect(source('components/settings/settings-nav.tsx')).toContain(
      "href: '/dashboard/settings/modules',\n        title: 'Modules',",
    );
    expect(source('app/(dashboard)/dashboard/settings/modules/page.tsx')).toContain(
      'switch still controls what that module does on its own',
    );
    expect(source('app/(dashboard)/dashboard/books/page.tsx')).toContain(
      '<Link href="/dashboard/books/import">Bulk ISBN import</Link>',
    );
    expect(source('server/actions/books-bulk-import.ts')).toContain('await svc.bulkCreate({');
    const svc = source('server/services/inventory.ts');
    expect(between(svc, 'async bulkCreate(input', 'private async skuTakenError(')).not.toContain(
      'embedInBackground',
    );
    expect(source('lib/ai/tools.ts')).toContain('const result = await svc.execute(isbns, {');
    expect(source('server/services/books-import.ts')).not.toMatch(/embed/i);
    const [entry] = release().entries;
    expect(entry!.howItAffectsYou).toContain(
      'While the AI Assistant is switched on in Settings, Modules, an hourly check fills in search data for books added with Bulk ISBN import or by the assistant, and for any other item missing it, so a large import can take a few hours to be fully searchable this way.',
    );
    expect(release().summary).toContain(
      'while the AI Assistant is switched on in Settings, Modules, an hourly check fills it in for any item still missing it.',
    );
    // The draft named "the Books import" and "a bulk add"; the screens call
    // the one a member opens Bulk ISBN import.
    expect(words()).not.toMatch(/Books import|bulk add/i);
  });

  it('uses plain words: no embedding, vector, cron, trigger or Gemini, never "the book", and no speed nobody measured', () => {
    expect(words()).not.toMatch(/embedding|vector|\bcron\b|trigger|gemini/i);
    expect(words()).not.toMatch(/\bthe book\b|\bbook (count|quantity|stock)\b/i);
    expect(words()).not.toMatch(/\bfaster\b|\bquicker\b|\bspeed\b|\binstant/i);
    expect(release().entries[0]!.whatToDo).toBe('No action needed.');
  });
});

// The full-app redesign (owner brief 2026-10-14, Stages 1 to 6, release commit
// 036002d43 at 2026-10-20T09:32:39Z) is told in three releases, published a
// minute apart above the parked ai-search-finds-every-item release (#367):
// the web fixes found while redrawing every page, then the mobile app, then
// the new look itself at the top. Each has entries with no audience, so each
// reaches every member. The words were checked against the source at
// 036002d43 (docs/whats-new-redesign-2026-10, from the drafts in
// stockpilot-work/redesign-2026-10/stage7/whats-new-entries.md after four
// fact-check passes); the tests below pin the labels they name where they sit
// in that source.
describe('the web fixes found while redrawing every page (redesign-web-fixes-2026-10)', () => {
  const ID = 'redesign-web-fixes-2026-10';
  const release = () => RELEASES.find((r) => r.id === ID)!;
  const owner: ReleaseViewer = {
    role: 'owner',
    permissions: [...PERMISSIONS],
    enabledModules: Object.keys(MODULE_REGISTRY) as ModuleId[],
  };
  const member: ReleaseViewer = { role: 'viewer', permissions: [], enabledModules: [] };
  const words = () => readerText(release()).join(' ');
  /** A file in the repository, as written. */
  const REPO = resolve(__dirname, '../../../../..');
  const repoFile = (rel: string) => readFileSync(resolve(REPO, rel), 'utf8');
  /** A source file under apps/web/src, as written. */
  const source = (rel: string) => repoFile(`apps/web/src/${rel}`);
  const entry = (id: string) => release().entries.find((e) => e.id === id)!;

  // Published with the other two redesign releases at T + 1 minute, a minute
  // after #367's release and a minute before the mobile app's. T is set at
  // publish, once the redesign is merged, its web build is live and the OTA's
  // iOS launches show: until then it is provisional, and the publish guard at
  // the end of this file fails. Here the release commit (09:32:39Z) is the
  // floor and T's day (UTC) the ceiling, as earlier releases' tests pin
  // theirs, so a publish on a later day moves this bound and the date pin.
  it('is published directly above the ai-search-finds-every-item release, a minute after it, below the two other redesign releases, dated after every release below it, and no draft is left', () => {
    // Re-pinned by the B44 phone update draft (fix/b44-update-restart-prompt;
    // was: without it): dated after every release, it sits at the top, so
    // every position below it moves down by one, and it and slice 8's are the
    // drafts.
    // Re-pinned by the small fixes slice 8 draft (fix/small-fixes-8; was:
    // without it): dated after every release, it sits at the top, so every
    // position below it moves down by one, and it is the one draft.
    expect(release().status).toBe('published');
    expect(release().revision).toBe(1);
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: the two other redesign releases at 0 and 1, this one at 2, ai-search-finds-every-item at 3, the minute measured to RELEASES[3] and slice(3)): the unsubscribe-rack-question-fixes release is published at the top, above the redesign releases, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: the unsubscribe-rack-question-fixes release at 0, and each position and slice below it one place higher): the ended-session-group-page-fixes release is published at the top, above it, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: the ended-session-group-page-fixes release at 0, and each position and slice below it one place higher): the manage-order-items-and-app-fixes release is published at the top, above it, so every position below it moves down by one.
    expect(RELEASES[2]?.id).toBe('manage-order-items-and-app-fixes-2026-10');
    expect(RELEASES[2]?.status).toBe('published');
    expect(RELEASES[3]?.id).toBe('ended-session-group-page-fixes-2026-10');
    expect(RELEASES[3]?.status).toBe('published');
    expect(RELEASES[4]?.id).toBe('unsubscribe-rack-question-fixes-2026-10');
    expect(RELEASES[5]?.id).toBe('redesign-2026-10');
    expect(RELEASES[6]?.id).toBe('redesign-mobile-app-2026-10');
    expect(RELEASES[7]?.id).toBe(ID);
    expect(RELEASES[8]?.id).toBe('ai-search-finds-every-item-2026-10');
    expect(release().publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/);
    expect(Date.parse(release().publishedAt)).toBeGreaterThan(Date.parse('2026-10-20T09:32:39Z'));
    expect(Date.parse(release().publishedAt)).toBeLessThanOrEqual(
      Date.parse('2026-10-21T00:00:00Z'),
    );
    expect(Date.parse(release().publishedAt) - Date.parse(RELEASES[8]!.publishedAt)).toBe(60_000);
    for (const r of RELEASES.slice(8)) {
      expect(Date.parse(release().publishedAt), r.id).toBeGreaterThan(Date.parse(r.publishedAt));
    }
    expect(RELEASES.filter((r) => r.status === 'draft').map((r) => r.id)).toEqual([
      'mobile-app-asks-before-restarting',
      'small-fixes-8-2026-10',
    ]);
  });

  it('tells its four web-wide entries to every member and each other entry to whoever can open the page it names, with no links', () => {
    const r = release();
    expect(r.audience).toBeUndefined();
    expect(
      r.entries.map((e) => [e.id, e.category, e.area, e.audience ?? null, e.link ?? null]),
    ).toEqual([
      ['web-times-in-your-time-zone', 'fixed', 'Web app', null, null],
      ['web-hover-only-controls', 'fixed', 'Web app', null, null],
      ['web-unsaved-work-protected', 'fixed', 'Web app', null, null],
      [
        'web-contact-links-plain-only',
        'fixed',
        'Web app',
        { anyPermission: ['suppliers:read', 'locations:read'] },
        null,
      ],
      ['web-items-books-fixes', 'fixed', 'Inventory', { anyPermission: ['items:read'] }, null],
      [
        'web-orders-fixes',
        'fixed',
        'Orders',
        { anyPermission: ['orders:request', 'orders:approve'], modules: ['orders'] },
        null,
      ],
      [
        'web-ai-assistant-fixes',
        'fixed',
        'AI Assistant',
        { anyPermission: ['items:update'], modules: ['ai'] },
        null,
      ],
      [
        'web-procedures-fixes',
        'fixed',
        'Procedures',
        { anyPermission: ['items:update'], modules: ['procedures'] },
        null,
      ],
      ['web-reports-fixes', 'fixed', 'Reports', { anyPermission: ['reports:read'] }, null],
      ['web-counts-movements-fixes', 'fixed', 'Inventory', { anyPermission: ['items:read'] }, null],
      [
        'web-settings-and-admin-fixes',
        'fixed',
        'Settings',
        { anyPermission: ['organization:update', 'integrations:manage', 'public_links:manage'] },
        null,
      ],
      ['web-error-and-switched-off-pages', 'fixed', 'Web app', null, null],
    ]);
    expect(visibleReleases(RELEASES, owner).find((x) => x.id === ID)?.entries).toHaveLength(12);
    expect(
      visibleReleases(RELEASES, member)
        .find((x) => x.id === ID)
        ?.entries.map((e) => e.id),
    ).toEqual([
      'web-times-in-your-time-zone',
      'web-hover-only-controls',
      'web-unsaved-work-protected',
      'web-error-and-switched-off-pages',
    ]);
  });

  // Renamed by docs/whats-new-2026-10-25 (2026-10-25; was: "is the notice for every member once the two newer redesign
  // releases are read, ..."): the unsubscribe-rack-question-fixes release, published after them at the top, reaches
  // every member first too, so it is read or seen with them here. Claim kept: the notice for every member once the
  // releases above it are read, and an old phone build shows its title and summary.
  // Renamed by docs/whats-new-2026-10-26 (2026-10-26; was: "... once the two newer redesign releases and the unsubscribe-rack-question-fixes release are read, ..."): the ended-session-group-page-fixes release, published at the top, reaches every member, so it is read here too. Claim kept: the notice for every member once the newer releases are read, and an old phone build shows its title and summary.
  // Renamed by docs/whats-new-2026-10-30 (2026-10-30; was: "... and the unsubscribe-rack-question-fixes and ended-session-group-page-fixes releases are read, ..."): the manage-order-items-and-app-fixes release, published at the top, reaches every member, so it is read here too. Claim kept: the notice for every member once the newer releases are read, and an old phone build shows its title and summary.
  it('is the notice for every member once the two newer redesign releases and the unsubscribe-rack-question-fixes, ended-session-group-page-fixes and manage-order-items-and-app-fixes releases are read, and an old phone build shows its title and summary', () => {
    const read = (id: string) => ({
      release_id: id,
      revision: 1,
      dismissed_at: null,
      opened_at: '2026-10-20T13:00:00Z',
      read_at: '2026-10-20T13:00:00Z',
    });
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: the two newer redesign releases' reads only): the unsubscribe-rack-question-fixes release, published at the top, reaches every member, so it is read here too.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: those three reads): the ended-session-group-page-fixes release, published at the top, reaches every member, so it is read here too.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: those four reads): the manage-order-items-and-app-fixes release, published at the top, reaches every member, so it is read here too.
    const newerRead = [
      read(LATEST_ID),
      read(TOP_ID),
      read(NEWEST_ID),
      read('redesign-2026-10'),
      read('redesign-mobile-app-2026-10'),
    ];
    for (const v of [owner, member]) {
      // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: redesign-2026-10 first with nothing read, and the three redesign releases on an old phone build with nothing seen): the unsubscribe-rack-question-fixes release, published at the top, reaches every member and comes first until it is read or seen; once it is, the redesign releases lead as before.
      // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: unsubscribe-rack-question-fixes-2026-10 with nothing read): the ended-session-group-page-fixes release, published at the top, reaches every member, so this reader is told it first and the unsubscribe-rack-question-fixes release once it is read. Claim kept: the same order after them.
      // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: ended-session-group-page-fixes-2026-10 with nothing read): the manage-order-items-and-app-fixes release, published at the top, reaches every member, so this reader is told it first and the ended-session-group-page-fixes release once it is read. Claim kept: the same order after them.
      expect(buildReleaseList(RELEASES, v, [], null).latestUnread?.id, v.role).toBe(LATEST_ID);
      expect(buildReleaseList(RELEASES, v, [latestRead()], null).latestUnread?.id, v.role).toBe(
        TOP_ID,
      );
      expect(
        buildReleaseList(RELEASES, v, [latestRead(), topRead()], null).latestUnread?.id,
        v.role,
      ).toBe(NEWEST_ID);
      expect(buildReleaseList(RELEASES, v, newerRead, null).latestUnread?.id, v.role).toBe(ID);
      // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: the unsubscribe-rack-question-fixes release and the first two redesign releases with nothing seen, and this one once those three were seen): the ended-session-group-page-fixes release, published at the top, reaches every member, so it leads with nothing seen, the same three as before are the three once it is seen, and the seen set before this one's announcement includes it.
      // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: the ended-session-group-page-fixes and unsubscribe-rack-question-fixes releases and the first redesign release with nothing seen): the manage-order-items-and-app-fixes release, published at the top, reaches every member, so it leads with nothing seen; the same three as before are the three once it is seen, and the seen sets below include it.
      expect(
        legacyAnnouncementsFor(RELEASES, v, {}).map((a) => a.id),
        v.role,
      ).toEqual([LATEST_ID, TOP_ID, NEWEST_ID]);
      expect(
        legacyAnnouncementsFor(RELEASES, v, latestSeen()).map((a) => a.id),
        v.role,
      ).toEqual([TOP_ID, NEWEST_ID, REDESIGN_IDS[0]]);
      expect(
        legacyAnnouncementsFor(RELEASES, v, { ...latestSeen(), ...topSeen() }).map((a) => a.id),
        v.role,
      ).toEqual([NEWEST_ID, ...REDESIGN_IDS.slice(0, 2)]);
      expect(
        legacyAnnouncementsFor(RELEASES, v, { ...latestSeen(), ...topSeen(), ...newestSeen() }).map(
          (a) => a.id,
        ),
        v.role,
      ).toEqual(REDESIGN_IDS);
      // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: the seen set without it): the manage-order-items-and-app-fixes release, published at the top, reaches every member, so it is seen here too.
      expect(
        legacyAnnouncementsFor(RELEASES, v, {
          [LATEST_ID]: true,
          [TOP_ID]: true,
          [NEWEST_ID]: true,
          'redesign-2026-10': true,
          'redesign-mobile-app-2026-10': true,
        })[0],
        v.role,
      ).toEqual({
        id: ID,
        date: '2026-10-20',
        title: release().title,
        body: release().summary,
      });
    }
    expect(registryFingerprint(RELEASES)).toContain(`${ID}@1:published`);
    expect(ANNOUNCEMENTS.map((a) => a.id)).toContain(ID);
  });

  it('rests the touch, keyboard and unsaved-work words on the screens: the New order touch rule, the 16px boxes on phones, Keep working and the three guarded forms', () => {
    // Quick view and Remove on the New order page show where there is no hover.
    expect(source('components/orders/storefront/storefront.css')).toContain(
      '@media (hover: none) {\n  .sp-storefront .sf-qv,\n  .sp-storefront .sf-line .rm {\n    opacity: 1;',
    );
    // Text boxes are 16px on a phone, so iPhone Safari does not zoom in.
    expect(source('components/ui/input.tsx')).toContain("'max-sm:h-11 max-sm:text-base'");
    expect(entry('web-hover-only-controls').howItAffectsYou).toContain(
      'On an iPhone, tapping the Items search box or another box with small text no longer zooms the page in.',
    );
    // Refresh to update asks first while one of these forms holds unsaved work.
    for (const form of [
      'components/po/po-form.tsx',
      'components/po/recurring-templates-panel.tsx',
      'components/books/bulk-isbn-import.tsx',
    ]) {
      expect(source(form), form).toContain('useUnsavedWork(');
    }
    const drawer = source('components/updates/release-drawer.tsx');
    expect(drawer).toMatch(/>\s*Keep working\s*</);
    expect(drawer).toContain('Refresh to update');
    expect(entry('web-unsaved-work-protected').whatChanged).toMatch(
      /^New and Edit purchase order, a recurring purchase order template and Bulk ISBN import now ask before Refresh to update/,
    );
    expect(entry('web-unsaved-work-protected').howItAffectsYou).toMatch(
      /^When it asks, choose Keep working/,
    );
  });

  it('says a contact becomes a link only for one plain address or number, as the Suppliers and warehouse pages decide it', () => {
    // One rule for every stored address, the Suppliers and warehouse pages
    // included (plainAddressMailtoUrl in @stockpilot/core).
    expect(plainAddressMailtoUrl('orders@example.com')).toBe('mailto:orders@example.com');
    expect(plainAddressMailtoUrl('a@example.com, b@example.com')).toBeNull();
    expect(plainAddressMailtoUrl('dock@example.com')).toBe('mailto:dock@example.com');
    expect(plainAddressMailtoUrl('a@example.com; b@example.com')).toBeNull();
    expect(warehouseTelUrl('555-010-0100')).toBe('tel:5550100100');
    expect(warehouseTelUrl('555-010-0100 ext 12')).toBeNull();
    expect(entry('web-contact-links-plain-only').whatChanged).toContain(
      'Anything else, such as a number with an extension or two addresses, shows as plain text.',
    );
    // New order from here picks the warehouse (the storefront reads warehouseId).
    expect(newOrderFromWarehouseHref('w 1')).toBe('/dashboard/orders/new?warehouseId=w%201');
    expect(entry('web-orders-fixes').howItAffectsYou).toContain(
      "New order from here on a warehouse's page now opens the new order with that warehouse picked.",
    );
  });

  it("uses the screens' own words for the fixes it names", () => {
    expect(source('components/inventory/image-lightbox.tsx')).toContain(
      'title="Remove this image?"',
    );
    expect(source('components/inventory/inventory-table.tsx')).toContain(
      'label="Select all rows on this page"',
    );
    const chat = source('components/ai/chat-panel.tsx');
    expect(chat).toContain(
      "return { label: 'Open low-stock list', href: '/dashboard/inventory?stock=low&type=all' };",
    );
    expect(chat).toContain('aria-label="Send message"');
    // View orders on Book Order Totals: 672 px wide from 1,024 px up.
    expect(source('components/reports/book-order-totals/orders-drawer.tsx')).toContain(
      'sm:max-w-xl md:max-w-2xl lg:max-w-2xl',
    );
    expect(entry('web-reports-fixes').howItAffectsYou).toContain(
      'In a window at least 1,024 pixels wide, View orders on Book Order Totals now opens wide enough',
    );
    // Overview names each movement type as Movements does, and prints yesterday in full.
    const activity = source('components/dashboard/widgets/recent-activity.tsx');
    expect(activity).toContain('title="Today\'s activity"');
    expect(activity).toContain('{movementTypeLabel(m.movement_type)}');
    expect(activity).toContain(".replace(/\\bdays?\\b/, 'd');");
    expect(source('components/dashboard/widgets/movements-breakdown.tsx')).toContain(
      'title="Movements · 30 days"',
    );
    expect(movementTypeLabel('receive_po')).toBe('Receive PO');
    for (const [code, label] of [
      ['bundle_assembly', 'Bundle assembly'],
      ['bundle_distribution', 'Bundle distribution'],
      ['bundle_shortage', 'Bundle shortage'],
    ] as const) {
      expect(movementTypeLabel(code), code).toBe(label);
    }
    expect(entry('web-counts-movements-fixes').whatChanged).toContain(
      "On Overview, Today's activity and Movements · 30 days now name each movement type as Movements does, such as Receive PO, and Today's activity prints yesterday in full.",
    );
    // The Inventory value card's figure is new in the redesign, not a fix: it
    // is told in redesign-2026-10's overview-and-item-pages, never here.
    expect(entry('web-counts-movements-fixes').title).toBe(
      'Counts and Movements say more, and Overview names each movement type as Movements does',
    );
    expect(words()).not.toMatch(/value card/i);
    expect(source('components/auth/step-up-modal.tsx')).toMatch(
      />\s*Confirm with your authenticator\s*</,
    );
    // The shortcuts list joins keys pressed together with "+".
    const shortcuts = source('components/dashboard/keyboard-shortcuts.tsx');
    expect(shortcuts).toMatch(/keys: \['⌘', 'K'\],[\s\S]{0,160}chord: true,/);
    expect(shortcuts).toContain("{row.chord ? '+' : 'then'}");
    expect(entry('web-error-and-switched-off-pages').howItAffectsYou).toContain(
      'The keyboard shortcuts list now shows Command and K as keys pressed together, not one after the other.',
    );
  });

  it('uses plain words: no zendesk, never "book" for a quantity, no percentages and no speed nobody measured', () => {
    expect(release().entries).toHaveLength(12);
    const text = words();
    for (const phrase of FORBIDDEN) {
      expect(text.toLowerCase(), phrase).not.toContain(phrase);
    }
    expect(text).not.toMatch(
      /\bthe book\b|\bbook (count|quantity|stock|level)s?\b|\bbooked\b|\bon the books\b/i,
    );
    expect(text).not.toContain('%');
    expect(text).not.toMatch(/\bfaster\b|\bquicker\b|\bspeed\b|\binstant/i);
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
    for (const e of release().entries) expect(e.whatToDo, e.id).toBe('No action needed.');
  });
});

describe('the mobile app redesign release (redesign-mobile-app-2026-10)', () => {
  const ID = 'redesign-mobile-app-2026-10';
  const release = () => RELEASES.find((r) => r.id === ID)!;
  const owner: ReleaseViewer = {
    role: 'owner',
    permissions: [...PERMISSIONS],
    enabledModules: Object.keys(MODULE_REGISTRY) as ModuleId[],
  };
  const member: ReleaseViewer = { role: 'viewer', permissions: [], enabledModules: [] };
  const words = () => readerText(release()).join(' ');
  /** A file in the repository, as written. */
  const REPO = resolve(__dirname, '../../../../..');
  const repoFile = (rel: string) => readFileSync(resolve(REPO, rel), 'utf8');
  /** A mobile app source file, as written. */
  const phone = (rel: string) => repoFile(`apps/mobile/${rel}`);
  const entry = (id: string) => release().entries.find((e) => e.id === id)!;

  // T + 2 minutes, with T set at publish (the publish guard at the end of this
  // file fails until then); the release commit is the floor and T's day
  // (UTC) the ceiling, so a publish on a later day moves this bound and the
  // date pin with T.
  it('is published directly below the new look release (published a minute later) and a minute after the web fixes release, dated after every release below it, and no draft is left', () => {
    // Re-pinned by the B44 phone update draft (fix/b44-update-restart-prompt;
    // was: without it): dated after every release, it sits at the top, so
    // every position below it moves down by one, and it and slice 8's are the
    // drafts.
    // Re-pinned by the small fixes slice 8 draft (fix/small-fixes-8; was:
    // without it): dated after every release, it sits at the top, so every
    // position below it moves down by one, and it is the one draft.
    expect(release().status).toBe('published');
    expect(release().revision).toBe(1);
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: the new look release at 0, this one at 1, the web fixes release at 2, the minute measured to RELEASES[2] and slice(2)): the unsubscribe-rack-question-fixes release is published at the top, above the redesign releases, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: the unsubscribe-rack-question-fixes release at 0, and each position and slice below it one place higher): the ended-session-group-page-fixes release is published at the top, above it, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: the ended-session-group-page-fixes release at 0, and each position and slice below it one place higher): the manage-order-items-and-app-fixes release is published at the top, above it, so every position below it moves down by one.
    expect(RELEASES[2]?.id).toBe('manage-order-items-and-app-fixes-2026-10');
    expect(RELEASES[2]?.status).toBe('published');
    expect(RELEASES[3]?.id).toBe('ended-session-group-page-fixes-2026-10');
    expect(RELEASES[3]?.status).toBe('published');
    expect(RELEASES[4]?.id).toBe('unsubscribe-rack-question-fixes-2026-10');
    expect(RELEASES[5]?.id).toBe('redesign-2026-10');
    expect(RELEASES[6]?.id).toBe(ID);
    expect(RELEASES[7]?.id).toBe('redesign-web-fixes-2026-10');
    expect(release().publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/);
    expect(Date.parse(release().publishedAt)).toBeGreaterThan(Date.parse('2026-10-20T09:32:39Z'));
    expect(Date.parse(release().publishedAt)).toBeLessThanOrEqual(
      Date.parse('2026-10-21T00:00:00Z'),
    );
    expect(Date.parse(release().publishedAt) - Date.parse(RELEASES[7]!.publishedAt)).toBe(60_000);
    for (const r of RELEASES.slice(7)) {
      expect(Date.parse(release().publishedAt), r.id).toBeGreaterThan(Date.parse(r.publishedAt));
    }
    expect(RELEASES.filter((r) => r.status === 'draft').map((r) => r.id)).toEqual([
      'mobile-app-asks-before-restarting',
      'small-fixes-8-2026-10',
    ]);
  });

  it('tells its app-wide entries to every member and each other entry to whoever can open the screen it names, with no links', () => {
    const r = release();
    expect(r.audience).toBeUndefined();
    expect(
      r.entries.map((e) => [e.id, e.category, e.area, e.audience ?? null, e.link ?? null]),
    ).toEqual([
      ['app-new-look', 'improved', 'Mobile app', null, null],
      [
        'app-select-mode-check-boxes',
        'improved',
        'Inventory',
        { anyPermission: ['items:read'] },
        null,
      ],
      [
        'app-counts-record-what-you-type',
        'fixed',
        'Cycle counts',
        { anyPermission: ['cycle_counts:read', 'stock:adjust'], modules: ['cycle_counts'] },
        null,
      ],
      ['app-lists-say-when-not-loaded', 'fixed', 'Mobile app', null, null],
      ['app-home-sync-status', 'fixed', 'Mobile app', null, null],
      [
        'app-returns-stay-current',
        'fixed',
        'Returns',
        {
          anyPermission: ['returns:read', 'returns:manage', 'orders:approve'],
          modules: ['returns'],
        },
        null,
      ],
      [
        'app-order-screens-keyboard',
        'fixed',
        'Orders',
        { anyPermission: ['orders:request', 'orders:approve'], modules: ['orders'] },
        null,
      ],
      ['app-voiceover-names', 'fixed', 'Mobile app', null, null],
      ['app-text-size-and-motion', 'fixed', 'Mobile app', null, null],
      [
        'app-scan-and-receive-pos',
        'fixed',
        'Receiving',
        { anyPermission: ['purchase_orders:read'], modules: ['purchase_orders', 'receiving'] },
        null,
      ],
      ['app-scan-tab-cards', 'fixed', 'Scan', null, null],
      ['app-bundles-rentals-staging', 'fixed', 'Mobile app', null, null],
    ]);
    expect(visibleReleases(RELEASES, owner).find((x) => x.id === ID)?.entries).toHaveLength(12);
    expect(
      visibleReleases(RELEASES, member)
        .find((x) => x.id === ID)
        ?.entries.map((e) => e.id),
    ).toEqual([
      'app-new-look',
      'app-lists-say-when-not-loaded',
      'app-home-sync-status',
      'app-voiceover-names',
      'app-text-size-and-motion',
      'app-scan-tab-cards',
      'app-bundles-rentals-staging',
    ]);
    // The phone part is an over-the-air update, loaded when the app is opened
    // again: every entry and the summary (all an old phone build shows) say so.
    for (const e of r.entries) {
      expect(e.whatToDo, e.id).toBe(
        'Close the app completely and open it again to load the latest update.',
      );
    }
    expect(r.summary).toMatch(/Close the app completely and open it again to load the update\.$/);
  });

  // Renamed by docs/whats-new-2026-10-25 (2026-10-25; was: "is the notice for every member once the new look release
  // is read, ..."): the unsubscribe-rack-question-fixes release, published after it at the top, reaches every member
  // first too, so it is read or seen with it here. Claim kept: the notice for every member once the releases above it
  // are read, and an old phone build shows its title and summary.
  // Renamed by docs/whats-new-2026-10-26 (2026-10-26; was: "... once the new look release and the unsubscribe-rack-question-fixes release are read, ..."): the ended-session-group-page-fixes release, published at the top, reaches every member first too, so it is read or seen with them here. Claim kept: the notice for every member once the releases above it are read, and an old phone build shows its title and summary.
  // Renamed by docs/whats-new-2026-10-30 (2026-10-30; was: "... and the unsubscribe-rack-question-fixes and ended-session-group-page-fixes releases are read, ..."): the manage-order-items-and-app-fixes release, published at the top, reaches every member first too, so it is read or seen with them here. Claim kept: the notice for every member once the releases above it are read, and an old phone build shows its title and summary.
  it('is the notice for every member once the new look release and the unsubscribe-rack-question-fixes, ended-session-group-page-fixes and manage-order-items-and-app-fixes releases are read, and an old phone build shows its title and summary', () => {
    const newLookRead = {
      release_id: 'redesign-2026-10',
      revision: 1,
      dismissed_at: null,
      opened_at: '2026-10-20T13:00:00Z',
      read_at: '2026-10-20T13:00:00Z',
    };
    for (const v of [owner, member]) {
      // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: redesign-2026-10 first with nothing read, this one once it was read, and this one on an old phone build once it was seen): the unsubscribe-rack-question-fixes release, published at the top, reaches every member and comes first until it is read or seen; the reads and the seen set below include it.
      // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: unsubscribe-rack-question-fixes-2026-10 with nothing read): the ended-session-group-page-fixes release, published at the top, reaches every member, so this reader is told it first and the unsubscribe-rack-question-fixes release once it is read. Claim kept: the same order after them.
      // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: ended-session-group-page-fixes-2026-10 with nothing read): the manage-order-items-and-app-fixes release, published at the top, reaches every member, so this reader is told it first and the ended-session-group-page-fixes release once it is read; the reads and the seen set below include it. Claim kept: the same order after them.
      expect(buildReleaseList(RELEASES, v, [], null).latestUnread?.id, v.role).toBe(LATEST_ID);
      expect(buildReleaseList(RELEASES, v, [latestRead()], null).latestUnread?.id, v.role).toBe(
        TOP_ID,
      );
      expect(
        buildReleaseList(RELEASES, v, [latestRead(), topRead()], null).latestUnread?.id,
        v.role,
      ).toBe(NEWEST_ID);
      expect(
        buildReleaseList(RELEASES, v, [latestRead(), topRead(), newestRead()], null).latestUnread
          ?.id,
        v.role,
      ).toBe('redesign-2026-10');
      expect(
        buildReleaseList(RELEASES, v, [latestRead(), topRead(), newestRead(), newLookRead], null)
          .latestUnread?.id,
        v.role,
      ).toBe(ID);
      expect(
        legacyAnnouncementsFor(RELEASES, v, {
          ...latestSeen(),
          ...topSeen(),
          ...newestSeen(),
          'redesign-2026-10': true,
        })[0],
        v.role,
      ).toEqual({
        id: ID,
        date: '2026-10-20',
        title: release().title,
        body: release().summary,
      });
    }
    expect(registryFingerprint(RELEASES)).toContain(`${ID}@1:published`);
    expect(ANNOUNCEMENTS.map((a) => a.id)).toContain(ID);
  });

  it("rests the sync, scan and count words on the app's own code", () => {
    // Home's badge says what the queue holds (sync-badge.ts, read by Home).
    const badge = phone('src/lib/sync-badge.ts');
    expect(badge).toContain(
      "if (s.pendingCount === 0) return { label: 'All synced', tone: 'success', spinner: false };",
    );
    expect(badge).toContain(
      "label: s.pendingCount > 0 ? `Offline · ${s.pendingCount} queued` : 'Offline',",
    );
    expect(badge).toContain(
      "return { label: `${neverSent} not sent`, tone: 'destructive', spinner: false };",
    );
    expect(phone('app/(drawer)/(tabs)/index.tsx')).toContain(
      'const sync = syncBadgeState(useSyncStatus());',
    );
    expect(entry('app-home-sync-status').whatChanged).toContain(
      'such as All synced, Offline · 2 queued or 1 not sent, instead of always saying synced now.',
    );
    // The Scan tab's X and its Scan and Photo ID switch.
    const scan = phone('app/(drawer)/(tabs)/scan.tsx');
    expect(scan).toContain('accessibilityLabel="Close scanner"');
    expect(scan).toMatch(/>\s*Photo ID\s*</);
    expect(entry('app-new-look').howItAffectsYou).toContain(
      'with an X to close it and the Scan and Photo ID switch',
    );
    // Scan to count's switch shows both settings.
    const countScan = phone('app/cycle-count/scan/[id].tsx');
    expect(countScan).toMatch(/>\s*Burst off\s*</);
    expect(countScan).toMatch(/>\s*Burst\s*</);
    // The Counts tab: a dash, and no SYNCED pill, when the phone's store cannot be read.
    const counts = phone('app/(drawer)/(tabs)/cycle-counts.tsx');
    expect(counts).toContain("value={pendingTotal === null ? '—' : String(pendingTotal)}");
    expect(counts).toContain(') : syncUnknown ? null : (\n    <Pill status="ok">SYNCED</Pill>');
    expect(entry('app-counts-record-what-you-type').howItAffectsYou).toContain(
      'the Counts tab shows a dash instead of 0 to sync and no longer says Synced',
    );
    // Receive POs says how its list is ordered.
    expect(phone('app/(drawer)/(tabs)/receive.tsx')).toMatch(/Sort · Recently updated/);
  });

  it("uses the app's own words for VoiceOver, the Ungroup review and the screens it names", () => {
    // The Ungroup review names each Keeps SKU radio and says its outcome as the value.
    const ungroup = phone('app/ungroup-selected.tsx');
    expect(ungroup).toContain('accessibilityRole="radio"');
    expect(ungroup).toContain('accessibilityLabel={radioNames.get(rec.id)}');
    expect(ungroup).toContain('accessibilityValue={{ text: ungroupOutcomeWords(o) }}');
    expect(entry('app-select-mode-check-boxes').howItAffectsYou).toContain(
      "On the Ungroup review, VoiceOver now names each Keeps SKU choice by its record's name",
    );
    // Keep me signed in is a checkbox.
    expect(phone('app/(auth)/sign-in.tsx')).toMatch(
      /<Checkbox[\s\S]{0,200}label="Keep me signed in"/,
    );
    expect(entry('app-voiceover-names').whatChanged).toMatch(
      /^VoiceOver now reads Keep me signed in as a checkbox/,
    );
    // The AI screen's footer.
    expect(phone('app/(drawer)/ai.tsx')).toContain(
      "const AI_FOOTER = 'Native mobile chat is in beta.';",
    );
    expect(entry('app-voiceover-names').howItAffectsYou).toContain(
      "The AI screen's footer now says the mobile chat is in beta",
    );
    // New event's All-day event is a checkbox; a new checkout is Rentals' +.
    expect(phone('app/schedule/new.tsx')).toMatch(/<Checkbox[\s\S]{0,200}label="All-day event"/);
    expect(phone('app/rentals/new.tsx')).toContain('<Eyebrow>RENTALS · NEW CHECKOUT</Eyebrow>');
    expect(entry('app-bundles-rentals-staging').howItAffectsYou).toMatch(
      /^New event has All-day event as a proper checkbox/,
    );
  });

  it('uses plain words: no zendesk, never "book" for a quantity, no percentages, no speed nobody measured, and never the Group review the phone has not changed', () => {
    expect(release().entries).toHaveLength(12);
    const text = words();
    for (const phrase of FORBIDDEN) {
      expect(text.toLowerCase(), phrase).not.toContain(phrase);
    }
    expect(text).not.toMatch(
      /\bthe book\b|\bbook (count|quantity|stock|level)s?\b|\bbooked\b|\bon the books\b/i,
    );
    expect(text).not.toContain('%');
    expect(text).not.toMatch(/\bfaster\b|\bquicker\b|\bspeed\b|\binstant/i);
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
    // The phone half of Stage 6 batch F (the Group review's radio names) is
    // still to come: only the Ungroup review is named.
    expect(text).not.toMatch(/(?<!Un)group (selected )?review/i);
  });
});

describe('the new look release (redesign-2026-10)', () => {
  const ID = 'redesign-2026-10';
  const release = () => RELEASES.find((r) => r.id === ID)!;
  const owner: ReleaseViewer = {
    role: 'owner',
    permissions: [...PERMISSIONS],
    enabledModules: Object.keys(MODULE_REGISTRY) as ModuleId[],
  };
  const itemsReader: ReleaseViewer = {
    role: 'viewer',
    permissions: ['items:read'],
    enabledModules: [],
  };
  const requester: ReleaseViewer = {
    role: 'viewer',
    permissions: ['orders:request'],
    enabledModules: ['orders'],
  };
  const member: ReleaseViewer = { role: 'viewer', permissions: [], enabledModules: [] };
  const words = () => readerText(release()).join(' ');
  /** A file in the repository, as written. */
  const REPO = resolve(__dirname, '../../../../..');
  const repoFile = (rel: string) => readFileSync(resolve(REPO, rel), 'utf8');
  /** A source file under apps/web/src, as written. */
  const source = (rel: string) => repoFile(`apps/web/src/${rel}`);
  const entry = (id: string) => release().entries.find((e) => e.id === id)!;
  const sidebar = (surface: 'web_sidebar' | 'mobile_drawer') =>
    Object.fromEntries(
      resolveSurface(surface, {
        role: 'owner',
        enabledModules: new Set(Object.keys(MODULE_REGISTRY) as ModuleId[]),
        permissions: new Set(PERMISSIONS),
      }).map((s) => [s.section, s.items.map((i) => i.label)]),
    );

  // T + 3 minutes, with T set at publish (the publish guard at the end of this
  // file fails until then); the release commit is the floor and T's day
  // (UTC) the ceiling, so a publish on a later day moves this bound and the
  // date pins with T.
  // Renamed by docs/whats-new-2026-10-25 (2026-10-25; was: "is published at the top, a minute after the mobile app
  // release, dated after every release, ..."): the unsubscribe-rack-question-fixes release is published after it, at
  // the top. Claim kept: a minute after the mobile app release, dated after every release below it, and no draft is
  // left; the release above it is dated after it.
  it('is published directly below the unsubscribe-rack-question-fixes release (published later), a minute after the mobile app release, dated after every release below it, and no draft is left', () => {
    // Re-pinned by the B44 phone update draft (fix/b44-update-restart-prompt;
    // was: without it): dated after every release, it sits at the top, so
    // every position below it moves down by one, and it and slice 8's are the
    // drafts.
    // Re-pinned by the small fixes slice 8 draft (fix/small-fixes-8; was:
    // without it): dated after every release, it sits at the top, so every
    // position below it moves down by one, and it is the one draft.
    expect(release().status).toBe('published');
    expect(release().revision).toBe(1);
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: at 0, the minute measured to RELEASES[1] and slice(1)): the unsubscribe-rack-question-fixes release is published at the top, above this one, so every position from it down moves down by one.
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: the unsubscribe-rack-question-fixes release at 0, and each position and slice below it one place higher): the ended-session-group-page-fixes release is published at the top, above it, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: the ended-session-group-page-fixes release at 0, and each position and slice below it one place higher): the manage-order-items-and-app-fixes release is published at the top, above it, so every position below it moves down by one.
    expect(RELEASES[2]?.id).toBe('manage-order-items-and-app-fixes-2026-10');
    expect(RELEASES[2]?.status).toBe('published');
    expect(RELEASES[3]?.id).toBe('ended-session-group-page-fixes-2026-10');
    expect(RELEASES[3]?.status).toBe('published');
    expect(RELEASES[4]?.id).toBe('unsubscribe-rack-question-fixes-2026-10');
    expect(RELEASES[4]?.status).toBe('published');
    expect(Date.parse(RELEASES[4]!.publishedAt)).toBeGreaterThan(Date.parse(release().publishedAt));
    expect(Date.parse(RELEASES[3]!.publishedAt)).toBeGreaterThan(Date.parse(release().publishedAt));
    expect(Date.parse(RELEASES[2]!.publishedAt)).toBeGreaterThan(Date.parse(release().publishedAt));
    expect(RELEASES[5]?.id).toBe(ID);
    expect(release().publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/);
    expect(Date.parse(release().publishedAt)).toBeGreaterThan(Date.parse('2026-10-20T09:32:39Z'));
    expect(Date.parse(release().publishedAt)).toBeLessThanOrEqual(
      Date.parse('2026-10-21T00:00:00Z'),
    );
    expect(Date.parse(release().publishedAt) - Date.parse(RELEASES[6]!.publishedAt)).toBe(60_000);
    for (const r of RELEASES.slice(6)) {
      expect(Date.parse(release().publishedAt), r.id).toBeGreaterThan(Date.parse(r.publishedAt));
    }
    expect(RELEASES.filter((r) => r.status === 'draft').map((r) => r.id)).toEqual([
      'mobile-app-asks-before-restarting',
      'small-fixes-8-2026-10',
    ]);
  });

  it('tells its six app-wide entries to every member, each other entry to whoever can open the page it names, and links Items, Navigation settings, Orders and Purchase orders', () => {
    const r = release();
    expect(r.audience).toBeUndefined();
    const itemReaders = { anyPermission: ['items:read'] };
    expect(
      r.entries.map((e) => [e.id, e.category, e.area, e.audience ?? null, e.link ?? null]),
    ).toEqual([
      ['web-new-look', 'improved', 'Web app', null, null],
      ['sidebar-groups', 'improved', 'Web and mobile apps', null, null],
      [
        'items-books-grid',
        'new',
        'Inventory',
        itemReaders,
        { href: '/dashboard/inventory', label: 'Open Items' },
      ],
      ['items-books-table-fits', 'improved', 'Inventory', itemReaders, null],
      ['settings-grouped', 'improved', 'Settings', null, null],
      [
        'navigation-settings-new-groups',
        'improved',
        'Settings',
        { anyPermission: ['organization:update'] },
        { href: '/dashboard/settings/navigation', label: 'Open Navigation settings' },
      ],
      ['overview-and-item-pages', 'improved', 'Dashboard and items', null, null],
      [
        'orders-new-layout',
        'improved',
        'Orders',
        { anyPermission: ['orders:request', 'orders:approve'], modules: ['orders'] },
        { href: '/dashboard/orders', label: 'View orders' },
      ],
      [
        'purchasing-new-layout',
        'improved',
        'Purchase orders',
        { anyPermission: ['purchase_orders:read'], modules: ['purchase_orders'] },
        { href: '/dashboard/purchase-orders', label: 'View purchase orders' },
      ],
      ['stock-pages-new-layout', 'improved', 'Inventory', itemReaders, null],
      ['more-pages-new-layout', 'improved', 'Web app', null, null],
      ['sign-in-and-shared-pages', 'improved', 'Web app', null, null],
    ]);
    expect(visibleReleases(RELEASES, owner).find((x) => x.id === ID)?.entries).toHaveLength(12);
    expect(
      visibleReleases(RELEASES, member)
        .find((x) => x.id === ID)
        ?.entries.map((e) => e.id),
    ).toEqual([
      'web-new-look',
      'sidebar-groups',
      'settings-grouped',
      'overview-and-item-pages',
      'more-pages-new-layout',
      'sign-in-and-shared-pages',
    ]);
  });

  // Renamed by docs/whats-new-2026-10-25 (2026-10-25; was: "is the first notice for every member, and an old phone
  // build lists the three redesign releases, ..."): the unsubscribe-rack-question-fixes release, published after it
  // at the top, reaches every member first. Claim kept: the notice for every member once that release is read, and an
  // old phone build lists the three redesign releases once it is seen, with Open Items for whoever can read items.
  // Renamed by docs/whats-new-2026-10-26 (2026-10-26; was: "... once the unsubscribe-rack-question-fixes release is read, and an old phone build lists the three redesign releases once that release is seen, ..."): the ended-session-group-page-fixes release, published at the top, reaches every member too. Claim kept: the first notice for every member once the newer releases are read, the three redesign releases on an old phone build once they are seen, with Open Items for whoever can read items.
  // Renamed by docs/whats-new-2026-10-30 (2026-10-30; was: "... once the unsubscribe-rack-question-fixes and ended-session-group-page-fixes releases are read, ..."): the manage-order-items-and-app-fixes release, published at the top, reaches every member too. Claim kept: the first notice for every member once the newer releases are read, the three redesign releases on an old phone build once they are seen, with Open Items for whoever can read items.
  it('is the first notice for every member once the unsubscribe-rack-question-fixes, ended-session-group-page-fixes and manage-order-items-and-app-fixes releases are read, and an old phone build lists the three redesign releases once those releases are seen, with Open Items for whoever can read items', () => {
    // Re-pinned by docs/whats-new-2026-10-25 (2026-10-25; was: this one first with nothing read, and the three redesign releases with nothing seen): the unsubscribe-rack-question-fixes release, published at the top, reaches every member and comes first until it is read or seen; once it is, this one and the three redesign releases lead as before.
    for (const v of [owner, itemsReader, requester, member]) {
      // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: unsubscribe-rack-question-fixes-2026-10 with nothing read): the ended-session-group-page-fixes release, published at the top, reaches every member, so this reader is told it first and the unsubscribe-rack-question-fixes release once it is read. Claim kept: the same order after them.
      // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: ended-session-group-page-fixes-2026-10 with nothing read): the manage-order-items-and-app-fixes release, published at the top, reaches every member, so this reader is told it first and the ended-session-group-page-fixes release once it is read. Claim kept: the same order after them.
      expect(buildReleaseList(RELEASES, v, [], null).latestUnread?.id, v.role).toBe(LATEST_ID);
      expect(buildReleaseList(RELEASES, v, [latestRead()], null).latestUnread?.id, v.role).toBe(
        TOP_ID,
      );
      expect(
        buildReleaseList(RELEASES, v, [latestRead(), topRead()], null).latestUnread?.id,
        v.role,
      ).toBe(NEWEST_ID);
      expect(
        buildReleaseList(RELEASES, v, [latestRead(), topRead(), newestRead()], null).latestUnread
          ?.id,
        v.role,
      ).toBe(ID);
      // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: the unsubscribe-rack-question-fixes release and the first two redesign releases with nothing seen): the ended-session-group-page-fixes release, published at the top, reaches every member, so it leads with nothing seen, and the same three as before are the three once it is seen.
      // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: the ended-session-group-page-fixes and unsubscribe-rack-question-fixes releases and the first redesign release with nothing seen): the manage-order-items-and-app-fixes release, published at the top, reaches every member, so it leads with nothing seen; the same three as before are the three once it is seen, and the seen sets below include it.
      expect(
        legacyAnnouncementsFor(RELEASES, v, {}).map((a) => a.id),
        v.role,
      ).toEqual([LATEST_ID, TOP_ID, NEWEST_ID]);
      expect(
        legacyAnnouncementsFor(RELEASES, v, latestSeen()).map((a) => a.id),
        v.role,
      ).toEqual([TOP_ID, NEWEST_ID, REDESIGN_IDS[0]]);
      expect(
        legacyAnnouncementsFor(RELEASES, v, { ...latestSeen(), ...topSeen() }).map((a) => a.id),
        v.role,
      ).toEqual([NEWEST_ID, ...REDESIGN_IDS.slice(0, 2)]);
      expect(
        legacyAnnouncementsFor(RELEASES, v, { ...latestSeen(), ...topSeen(), ...newestSeen() }).map(
          (a) => a.id,
        ),
        v.role,
      ).toEqual(REDESIGN_IDS);
    }
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: the seen sets without it): the manage-order-items-and-app-fixes release, published at the top, reaches every member, so it is seen here too and this one's announcement is first as before.
    for (const v of [owner, itemsReader]) {
      expect(
        legacyAnnouncementsFor(RELEASES, v, { ...latestSeen(), ...topSeen(), ...newestSeen() })[0],
        v.role,
      ).toEqual({
        id: ID,
        date: '2026-10-20',
        title: release().title,
        body: release().summary,
        cta: { href: '/dashboard/inventory', label: 'Open Items' },
      });
    }
    // A requester's first linked entry is the Orders one.
    expect(
      legacyAnnouncementsFor(RELEASES, requester, {
        ...latestSeen(),
        ...topSeen(),
        ...newestSeen(),
      })[0]?.cta,
    ).toEqual({
      href: '/dashboard/orders',
      label: 'View orders',
    });
    expect(
      legacyAnnouncementsFor(RELEASES, member, {
        ...latestSeen(),
        ...topSeen(),
        ...newestSeen(),
      })[0],
    ).toEqual({
      id: ID,
      date: '2026-10-20',
      title: release().title,
      body: release().summary,
    });
    // On a phone the Grid is the web's: the summary says so before naming it.
    expect(release().summary).toContain(
      'On the web, Items and Books can show your stock as photo cards',
    );
    expect(registryFingerprint(RELEASES)).toContain(`${ID}@1:published`);
    expect(registryFingerprint(RELEASES)).not.toBe(
      registryFingerprint(RELEASES.filter((r) => r.id !== ID)),
    );
    expect(ANNOUNCEMENTS.map((a) => a.id)).toContain(ID);
  });

  it('names the sidebar groups and their links as the registry draws them, on the web and in the mobile app', () => {
    expect(SECTION_ORDER).toEqual([
      'overview',
      'inventory',
      'fulfillment',
      'purchasing',
      'insights',
      'workspace',
      'tools',
      'admin',
    ]);
    const web = sidebar('web_sidebar');
    expect(web.fulfillment).toEqual(['Orders', 'Returns', 'Rentals', 'Bundles']);
    expect(web.purchasing).toEqual([
      'Purchase orders',
      'Recurring POs',
      'Reorder Planning',
      'PO imports',
      'Suppliers',
    ]);
    expect(web.insights).toEqual(['Reports', 'Briefing', 'AI Assistant']);
    expect(source('components/dashboard/nav.ts')).toContain(
      "  inventory: 'Inventory',\n  fulfillment: 'Fulfillment',\n  purchasing: 'Purchasing',\n  insights: 'Insights',\n  workspace: 'Workspace',",
    );
    expect(entry('sidebar-groups').whatChanged).toContain(
      'Fulfillment (Orders, Returns, Rentals, Bundles), Purchasing (Purchase orders, Recurring POs, Reorder Planning, PO imports, Suppliers) and Insights (Reports, Briefing, AI Assistant)',
    );
    expect(release().summary).toContain(
      'Inventory, Fulfillment, Purchasing, Insights and Workspace',
    );
    // The mobile app's side menu: the same sections, Receive POs first under Purchasing.
    expect(sidebar('mobile_drawer').purchasing?.[0]).toBe('Receive POs');
    expect(repoFile('apps/mobile/src/lib/drawer-nav.ts')).toContain(
      "  fulfillment: 'FULFILLMENT',\n  purchasing: 'PURCHASING',\n  insights: 'INSIGHTS',",
    );
    expect(entry('sidebar-groups').howItAffectsYou).toContain(
      'with Receive POs first under Purchasing',
    );
    // Folded groups are kept in a cookie (this browser); Admin starts folded for owners and admins.
    const prefs = source('components/dashboard/sidebar-pref.ts');
    expect(prefs).toContain("export const NAV_COLLAPSED_COOKIE = 'sp_nav_collapsed';");
    expect(prefs).toContain("return isAdminRole(role) ? ['admin'] : [];");
    expect(entry('sidebar-groups').howItAffectsYou).toContain(
      'Folded groups are remembered in this browser, and for owners and admins Admin starts folded.',
    );
    // Only the web's groups fold: the phone's side menu has the same groups
    // and no fold, and a phone shows the summary, so it says "The web sidebar".
    expect(source('components/dashboard/sidebar.tsx')).toContain('aria-expanded={open}');
    expect(repoFile('apps/mobile/src/components/drawer-content.tsx')).not.toMatch(
      /\bexpanded\b|\bcollaps|\bfold/i,
    );
    expect(release().summary).toContain(
      "The web sidebar now sorts its links into Inventory, Fulfillment, Purchasing, Insights and Workspace, each group folds, and the mobile app's side menu uses the same groups.",
    );
    // Settings, Navigation shows the three new groups.
    expect(source('components/settings/nav-customizer.tsx')).toContain(
      "  fulfillment: 'Fulfillment',\n  purchasing: 'Purchasing',\n  insights: 'Insights',",
    );
    // The top bar already showed the trail on wider screens (Inventory /
    // Orders); only its group names are new.
    const crumbs = source('components/dashboard/topbar-crumbs.ts');
    expect(crumbs).toContain(
      "const SECTION_FULFILLMENT: Crumb = { label: 'Fulfillment', href: null };",
    );
    expect(crumbs).toContain('[/^\\/dashboard\\/orders$/, [SECTION_FULFILLMENT, ORDERS_LIST]],');
    // From a 520 px bar, where it has the room: the whole trail, else the
    // current page alone, else none (P68-01, topbar-trail-fit.ts).
    expect(source('components/dashboard/topbar.tsx')).toMatch(
      /<nav\s+aria-label="Breadcrumb"\s+data-slot=\{TRAIL_SLOT\}\s+className="@min-\[520px\]:flex hidden min-w-0"\s*>/,
    );
    expect(entry('web-new-look').whatChanged).toMatch(
      /On wider screens the trail in the top bar uses the new sidebar groups, such as Fulfillment \/ Orders\.$/,
    );
  });

  it("uses the screens' own words for Density, the Table and Grid switch and the Settings groups", () => {
    const menu = source('components/dashboard/user-menu.tsx');
    expect(menu).toContain(
      '<DropdownMenuLabel className={GROUP_LABEL}>Density</DropdownMenuLabel>',
    );
    expect(menu).toMatch(/>\s*Comfortable\s*</);
    expect(menu).toMatch(/>\s*Compact\s*</);
    // 48rem is 768 px: below it, Compact rows keep Comfortable's padding.
    expect(source('app/globals.css')).toContain(
      "@media (width < 48rem) {\n    [data-density='compact'] {\n      --row-py: 11px;",
    );
    expect(entry('web-new-look').howItAffectsYou).toContain(
      'Your account menu has a new Density choice for tables in this browser: Comfortable, or Compact for shorter rows. On a screen narrower than 768 pixels, such as a phone held upright, rows stay Comfortable.',
    );
    const table = source('components/inventory/inventory-table.tsx');
    expect(table).toContain(
      "const VIEWS = ['All items', 'Low + critical', 'Out of stock'] as const;",
    );
    expect(table).toContain('aria-label="Show as"');
    expect(table).toContain("{ id: 'table', label: 'Table',");
    expect(table).toContain("{ id: 'grid', label: 'Grid',");
    const grid = source('components/inventory/inventory-grid.tsx');
    expect(grid).toContain(
      "  items: 'sp_view_items',\n  books: 'sp_view_books',\n  rentalItems: 'sp_view_rental_items',",
    );
    expect(grid).toContain("return value === 'grid' ? 'grid' : 'table';");
    const card = source('components/patterns/grid-card.tsx');
    expect(card).toContain('selected || selectionActive');
    // With a mouse the check box shows on hover and with focus anywhere in its
    // card: the descendant selector that replaced Tailwind's group-focus-within
    // variant (lib/group-focus-variants.guard.test.ts; Tailwind builds a class
    // quoted in a test too). String.raw keeps the one backslash grid-card.tsx has.
    expect(card).toContain(
      String.raw`pointer-coarse:opacity-100 opacity-0 group-hover/card:opacity-100 [.group\/card:focus-within_&]:opacity-100`,
    );
    expect(entry('items-books-grid').whatChanged).toContain(
      'a Table and Grid switch at the right end of the row with All items, Low + critical and Out of stock',
    );
    expect(entry('items-books-grid').howItAffectsYou).toMatch(
      /^Each list remembers Table or Grid in this browser, and Table stays the default\./,
    );
    // The Settings page's groups, and its menu's button on a narrower screen.
    const settings = source('components/settings/settings-nav.tsx');
    expect(
      [...settings.matchAll(/^ {4}label: '([^']+)',\n {4}entries: \[/gm)].map((m) => m[1]),
    ).toEqual([
      'Account',
      'Workspace',
      'Access',
      'Requests and email',
      'Data safety',
      'Connections',
      'Plan',
    ]);
    expect(settings).toContain('xl:hidden');
    expect(settings).toContain('<span className="text-muted-foreground shrink-0">Settings</span>');
    expect(entry('settings-grouped').whatChanged).toContain(
      'Account, Workspace, Access, Requests and email, Data safety, Connections and Plan',
    );
    // The save buttons keep their words while they work.
    expect(source('components/settings/profile-name-editor.tsx')).toMatch(
      /\{busy \? <Loader2 aria-hidden className="animate-spin" \/> : null\}\s*Save name/,
    );
    expect(source('components/settings/org-name-editor.tsx')).toMatch(
      /\{busy \? <Loader2 aria-hidden className="animate-spin" \/> : null\}\s*Save name/,
    );
    expect(source('components/settings/terminology-editor.tsx')).toMatch(
      /\{isSubmitting \? <Loader2 aria-hidden className="animate-spin" \/> : null\}\s*Save labels/,
    );
    expect(source('components/settings/mfa-policy-editor.tsx')).toMatch(
      /\{pending \? <Loader2 className="animate-spin" aria-hidden \/> : null\}\s*Save policy/,
    );
  });

  it("uses the pages' own words for orders, purchase orders, Movements, counts, Maintenance, the Overview and Rentals items", () => {
    expect(source('components/orders/manager-actions-panel.tsx')).toContain(
      'title="Manager actions"',
    );
    expect(entry('orders-new-layout').whatChanged).toContain(
      'the one solid button under Manager actions',
    );
    // The cart line's quantity buttons are a fixed 108 px, where production's
    // auto width squeezed names to one word per line. The order page's lines
    // claim no more room than production gave them (P4.B1: 208 px at 1280,
    // and at 390 names still squeeze to their longest word, as before).
    expect(source('components/orders/storefront/storefront.css')).toContain(
      '.sp-storefront .sf-step.mini {\n  height: 28px;\n  grid-template-columns: 28px minmax(0, 1fr) 28px;\n  border-radius: 6px;\n  min-width: 0;\n  width: 108px;\n}',
    );
    expect(entry('orders-new-layout').whyItMatters).toContain(
      'in the New order cart the quantity buttons squeezed item names to one word per line',
    );
    expect(
      `${entry('orders-new-layout').whyItMatters} ${entry('orders-new-layout').howItAffectsYou}`,
    ).not.toMatch(/more room|a word at a time/i);
    const po = source('components/po/po-form.tsx');
    expect(po).toContain('title="PO details"');
    expect(po).toContain(
      ") : poId ? (\n                'Save changes'\n              ) : (\n                'Create PO'\n",
    );
    expect(entry('purchasing-new-layout').howItAffectsYou).toContain(
      'New and Edit purchase order use one PO details card, with the total in the bar at its foot beside Cancel and Create PO, or Save changes when you edit.',
    );
    expect(movementTypeLabel('receive_po')).toBe('Receive PO');
    expect(movementTypeLabel('transfer')).toBe('Transfer');
    expect(entry('stock-pages-new-layout').whatChanged).toContain('such as Receive PO or Transfer');
    expect(source('components/cycle-counts/selection-confirm.tsx')).toContain("'Start count'");
    expect(source('components/inventory/staging-table.tsx')).toMatch(/>\s*Place selected\s*</);
    expect(entry('stock-pages-new-layout').howItAffectsYou).toContain(
      'the number selected and Start count stay at the bottom of the window',
    );
    const maintenance = source('app/(dashboard)/dashboard/maintenance/page.tsx');
    expect(maintenance).toContain("label: 'My requests',");
    expect(maintenance).toContain("label: 'All requests',");
    expect(entry('more-pages-new-layout').whatChanged).toContain(
      'Maintenance shows My requests and All requests as a switch',
    );
    expect(source('components/dashboard/widgets/shared.tsx')).toContain('title="Needs attention"');
    expect(source('components/inventory/item-detail.tsx')).toContain(
      '<DetailSection title="By location" flush>',
    );
    // Shift command's quick links: at most three to a row.
    const shift = source('components/dashboard/widgets/shift-command.tsx');
    expect(shift).toContain('@min-[528px]:grid-cols-2 @min-[792px]:grid-cols-3 grid gap-2');
    expect(shift).not.toMatch(/grid-cols-[4-9]/);
    expect(entry('overview-and-item-pages').howItAffectsYou).toContain(
      "Shift command's quick links now sit at most three to a row, with room for their full names.",
    );
    // The Inventory value card's figure and its change over 30 days are new in
    // the redesign (production's card had no figure), so they are told here,
    // not as a fix.
    expect(source('components/dashboard/widgets/value-chart-interactive.tsx')).toContain(
      '<span className="text-muted-foreground">vs. 30 days ago</span>',
    );
    expect(entry('overview-and-item-pages').howItAffectsYou).toContain(
      'The Inventory value card now also shows the value of the line it draws and its change over 30 days, for the location, Cost or Retail and comparison you pick.',
    );
    // A Rentals items card shows how many are available and out only while
    // some of the rental is out.
    const table = source('components/inventory/inventory-table.tsx');
    expect(table).toContain('if ((reservedByItem?.get(item.id) ?? 0) > 0) return true;');
    expect(table).toContain('const rentals =\n    reserved > 0 ? (');
    expect(entry('items-books-grid').howItAffectsYou).toMatch(
      /On Rentals items, while any of a rental is checked out, its card also shows how many are available and how many are out\.$/,
    );
    // The Rentals items search box asks for rentals of every type.
    expect(source('app/api/items/search/route.ts')).toContain(
      "const rentalsOnly = params.get('rentalsOnly') === '1';",
    );
    expect(entry('items-books-table-fits').howItAffectsYou).toContain(
      'the Rentals items search box now finds a rental by its SKU or name, which it could not do before',
    );
  });

  it('uses plain words: no zendesk, never "book" for a quantity, no percentages and no speed nobody measured', () => {
    expect(release().entries).toHaveLength(12);
    const text = words();
    for (const phrase of FORBIDDEN) {
      expect(text.toLowerCase(), phrase).not.toContain(phrase);
    }
    expect(text).not.toMatch(
      /\bthe book\b|\bbook (count|quantity|stock|level)s?\b|\bbooked\b|\bon the books\b/i,
    );
    expect(text).not.toContain('%');
    expect(text).not.toMatch(/\bfaster\b|\bquicker\b|\bspeed\b|\binstant/i);
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  // Stage 6 batches C (the tablet picker label, the PO list's doubled copy,
  // the photo Grid's meta line and press targets, a contrast token), D (list
  // empty states and saved views, Clear all keeping Category, Books search
  // ignoring ?q=, the Books warehouse-filter empty state), G (a crate-held
  // record with no rack) and H (Safari focus), and the phone half of F, are
  // still to come, so no redesign release claims them.
  it('claims none of the Stage 6 work still to come, in any of the three redesign releases', () => {
    const all = REDESIGN_IDS.flatMap((id) => readerText(RELEASES.find((r) => r.id === id)!)).join(
      ' ',
    );
    expect(all).not.toMatch(/Clear all|\?q=|\bcrate\b|Safari|contrast|empty state/i);
    expect(all).not.toMatch(/doubled|meta line|press target/i);
  });
});

// SET AT PUBLISH. This change was written before the redesign was merged
// (PLAN P7.3: the What's New is merged once phones show the update), so the
// four releases at the top carry a provisional T (12:47Z to 12:50Z on
// 2026-10-20), earlier than the merge, the web build and the OTA, and their
// comments hold placeholders for the merge, the web build, the OTA group, its
// iOS launches and the Demo Co sweep, and a STILL TO CHECK line for the phone
// walks. The plan's publishedAt was not a date so that this file failed until
// the real instant was set; this guard keeps that safety without failing the
// other checks of these releases. It fails on purpose until the publish PR
// sets REDESIGN_LIVE_AT and T (a whole minute at or after it), fills in every
// placeholder, replaces each STILL TO CHECK line with its result, deletes the
// SET AT PUBLISH note and moves the bounds and days the four "is published"
// tests pin. Do not merge while it fails.
describe('the redesign publish guard (set at publish)', () => {
  it('holds no provisional publish fact: T is at or after the instant the web build was live and the OTA reached iPhones, and no placeholder, STILL TO CHECK or SET AT PUBLISH line is left (fails on purpose until the publish PR sets them)', () => {
    const registry = readFileSync(resolve(__dirname, 'registry.ts'), 'utf8');
    const top = registry.slice(0, registry.indexOf("id: 'pages-keep-groups-whole-2026-10'"));
    expect(top).toContain("id: 'ai-search-finds-every-item-2026-10'");
    const t = RELEASES.find((r) => r.id === 'ai-search-finds-every-item-2026-10')!.publishedAt;
    const liveSet = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/.test(REDESIGN_LIVE_AT);
    const open = [
      ...(liveSet ? [] : [`REDESIGN_LIVE_AT is ${REDESIGN_LIVE_AT}, so T (${t}) is provisional`]),
      ...(liveSet && Date.parse(t) < Date.parse(REDESIGN_LIVE_AT)
        ? [`T (${t}) is before REDESIGN_LIVE_AT (${REDESIGN_LIVE_AT})`]
        : []),
      ...(top.match(/<(?:merge sha|id|time|group|result)>/g) ?? []).map((p) => `placeholder ${p}`),
      ...(top.match(/\b(?:STILL TO CHECK|SET AT PUBLISH)\b[^\n]*/g) ?? []),
    ];
    expect(open).toEqual([]);
  });
});

/**
 * Added by docs/whats-new-2026-10-25 (2026-10-25). Four changes merged that
 * day are told in one release at the top: S14 #388 (75809d577), B15 #390
 * (d42b7f5b2), B16 #389 (0dc89dbcd, its web half) and B9 #391 (e84d123d9,
 * merged 15:39:38Z), all live in production web build 8008cab0e0c0. No
 * migration and no phone update are involved. The words were checked against
 * the source at e84d123d9; the tests below pin the checks its audiences and
 * its one link rest on.
 */
describe('the unsubscribe, new rack question and other-website fixes release (unsubscribe-rack-question-fixes-2026-10)', () => {
  const ID = NEWEST_ID;
  const release = () => RELEASES.find((r) => r.id === ID)!;
  const owner: ReleaseViewer = {
    role: 'owner',
    permissions: [...PERMISSIONS],
    enabledModules: Object.keys(MODULE_REGISTRY) as ModuleId[],
  };
  const member: ReleaseViewer = { role: 'viewer', permissions: [], enabledModules: [] };
  const words = () => readerText(release()).join(' ');
  /** A file in the repository, as written. */
  const REPO = resolve(__dirname, '../../../../..');
  const repoFile = (rel: string) => readFileSync(resolve(REPO, rel), 'utf8');
  /** A source file under apps/web/src, as written. */
  const source = (rel: string) => repoFile(`apps/web/src/${rel}`);
  const SETTINGS_NOTIFICATIONS = '/dashboard/settings/notifications';

  // Published once the last of the four changes had merged (B9 #391 at
  // 15:39:38Z), its web build answered on production and the walks had
  // finished; the day it was published (UTC) is the ceiling.
  // Renamed by docs/whats-new-2026-10-26 (2026-10-26; was: "is published at the top as revision 1, ..., dated after every release, ..."): the ended-session-group-page-fixes release is published above it, at the top. Claim kept: revision 1, not before the last of its four changes merged, dated after every release below it, and no draft is left; the release above it is dated after it.
  it('is published directly below the ended-session-group-page-fixes release (published later) as revision 1, not before the last of its four changes merged (15:39:38Z), dated after every release below it, and no draft is left', () => {
    // Re-pinned by the B44 phone update draft (fix/b44-update-restart-prompt;
    // was: without it): dated after every release, it sits at the top, so
    // every position below it moves down by one, and it and slice 8's are the
    // drafts.
    // Re-pinned by the small fixes slice 8 draft (fix/small-fixes-8; was:
    // without it): dated after every release, it sits at the top, so every
    // position below it moves down by one, and it is the one draft.
    expect(release()).toBeDefined();
    expect(release().id).toBe('unsubscribe-rack-question-fixes-2026-10');
    expect(release().status).toBe('published');
    expect(release().revision).toBe(1);
    // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: at 0 and slice(1)): the ended-session-group-page-fixes release is published at the top, above this one, so every position from it down moves down by one.
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: the ended-session-group-page-fixes release at 0, this one at 1 and slice(2)): the manage-order-items-and-app-fixes release is published at the top, above them, so every position from the ended-session-group-page-fixes release down moves down by one.
    expect(RELEASES[1]?.id).toBe('small-fixes-8-2026-10');
    expect(RELEASES[1]?.status).toBe('draft');
    expect(RELEASES[2]?.id).toBe(LATEST_ID);
    expect(RELEASES[2]?.status).toBe('published');
    expect(Date.parse(RELEASES[2]!.publishedAt)).toBeGreaterThan(Date.parse(release().publishedAt));
    expect(RELEASES[3]?.id).toBe(TOP_ID);
    expect(RELEASES[3]?.status).toBe('published');
    expect(Date.parse(RELEASES[3]!.publishedAt)).toBeGreaterThan(Date.parse(release().publishedAt));
    expect(RELEASES[4]?.id).toBe(ID);
    expect(release().publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/);
    expect(Date.parse(release().publishedAt)).toBeGreaterThanOrEqual(
      Date.parse('2026-10-25T15:39:38Z'),
    );
    expect(Date.parse(release().publishedAt)).toBeLessThanOrEqual(
      Date.parse('2026-10-26T00:00:00Z'),
    );
    for (const r of RELEASES.slice(5)) {
      expect(Date.parse(release().publishedAt), r.id).toBeGreaterThan(Date.parse(r.publishedAt));
    }
    expect(RELEASES.filter((r) => r.status === 'draft').map((r) => r.id)).toEqual([
      'mobile-app-asks-before-restarting',
      'small-fixes-8-2026-10',
    ]);
  });

  it('has twelve entries with unique ids, and its one link opens a page that exists', () => {
    const r = release();
    const ids = r.entries.map((e) => e.id);
    expect(ids).toHaveLength(12);
    expect(new Set(ids).size).toBe(ids.length);
    const links = r.entries.filter((e) => e.link).map((e) => [e.id, e.link!.href]);
    expect(links).toEqual([['unsubscribe-digest-and-reminder-emails', SETTINGS_NOTIFICATIONS]]);
    for (const [id, href] of links) expect(pageExistsFor(href!), id).toBe(true);
  });

  // Every linked entry names who can reach its page, except a page every
  // member can open (OPEN_TO_EVERY_MEMBER in the registry-wide test): the
  // notification settings page checks only the session, so its entry has no
  // audience, and this test fails if the page ever gains a permission or
  // module check.
  it('names an audience on every linked entry but the notification settings one, whose page checks only the session', () => {
    const r = release();
    expect(r.audience).toBeUndefined();
    expect(r.entries.filter((e) => e.link && !e.audience).map((e) => e.link!.href)).toEqual([
      SETTINGS_NOTIFICATIONS,
    ]);
    const page = source('app/(dashboard)/dashboard/settings/notifications/page.tsx');
    expect(page).toContain('const session = await requireSession();');
    expect(page).toContain('const ctx = await requireOrgContext();');
    expect(page).not.toMatch(/\bcan\(|assertPermission|assertModuleEnabled|checkModuleAccess/);
  });

  it('tells its five entries with no audience to every member and each other entry to whoever can open the page or use the action it names', () => {
    const r = release();
    const itemCreators = { anyPermission: ['items:create'] };
    expect(
      r.entries.map((e) => [e.id, e.category, e.area, e.audience ?? null, e.link ?? null]),
    ).toEqual([
      [
        'unsubscribe-digest-and-reminder-emails',
        'fixed',
        'Notifications',
        null,
        { href: SETTINGS_NOTIFICATIONS, label: 'Open notification settings' },
      ],
      ['web-asks-before-new-rack', 'fixed', 'Inventory', itemCreators, null],
      ['other-websites-cannot-sign-you-out-or-download', 'fixed', 'Web app', null, null],
      [
        'order-emails-one-unit-one-line',
        'fixed',
        'Orders',
        { anyPermission: ['orders:request', 'orders:approve'], modules: ['orders'] },
        null,
      ],
      [
        'location-archive-anyway',
        'fixed',
        'Inventory',
        { anyPermission: ['locations:manage'] },
        null,
      ],
      ['pager-numbers-with-commas', 'fixed', 'Web app', { anyPermission: ['items:read'] }, null],
      ['reset-and-email-change-pages-name-your-account', 'improved', 'Account', null, null],
      ['duplicate-says-when-stock-not-placed', 'fixed', 'Inventory', itemCreators, null],
      ['counts-same-in-every-browser-language', 'fixed', 'Web app', null, null],
      ['settings-page-error-keeps-menu', 'fixed', 'Settings', null, null],
      [
        'team-disabled-time-org-zone',
        'fixed',
        'Team',
        { roles: ['owner', 'admin'], anyPermission: ['members:invite'] },
        null,
      ],
      [
        'procedure-comment-times-org-zone',
        'fixed',
        'Procedures',
        { anyPermission: ['items:update'], modules: ['procedures'] },
        null,
      ],
    ]);
    expect(visibleReleases(RELEASES, owner).find((x) => x.id === ID)?.entries).toHaveLength(12);
    expect(
      visibleReleases(RELEASES, member)
        .find((x) => x.id === ID)
        ?.entries.map((e) => e.id),
    ).toEqual([
      'unsubscribe-digest-and-reminder-emails',
      'other-websites-cannot-sign-you-out-or-download',
      'reset-and-email-change-pages-name-your-account',
      'counts-same-in-every-browser-language',
      'settings-page-error-keeps-menu',
    ]);
    // The checks the audiences quote. New item and New book send anyone
    // without items:create back to the list, and Duplicate shows only with it.
    expect(source('app/(dashboard)/dashboard/inventory/new/page.tsx')).toContain(
      "if (!can(ctx, 'items:create')) {\n    redirect('/dashboard/inventory');",
    );
    expect(source('app/(dashboard)/dashboard/books/new/page.tsx')).toContain(
      "if (!can(ctx, 'items:create')) {\n    redirect('/dashboard/books');",
    );
    expect(source('components/inventory/item-detail.tsx')).toContain(
      "const canDuplicateItem = can(ctx, 'items:create');",
    );
    // Archive and Restore show only to whoever manages locations.
    expect(source('app/(dashboard)/dashboard/locations/page.tsx')).toContain(
      "const canManage = can(ctx, 'locations:manage');",
    );
    // The Team page needs members:invite, and only an owner or an admin sees
    // the Disabled badge.
    expect(source('app/(dashboard)/dashboard/team/page.tsx')).toContain(
      "if (!can(ctx, 'members:invite')) {",
    );
    expect(source('components/team/team-manager.tsx')).toContain(
      "const canSeeDisabledStatus = currentUserRole === 'owner' || currentUserRole === 'admin';",
    );
    // A procedure needs the Procedures module, and the sidebar shows
    // Procedures to whoever can edit items.
    expect(source('server/services/procedures.ts')).toContain(
      "async get(id: string): Promise<ProcedureDetailRow> {\n    assertModuleEnabled(this.ctx, 'procedures');",
    );
    expect(
      MODULE_REGISTRY.procedures.placements
        .filter((p) => p.surface === 'web_sidebar')
        .map((p) => [p.href, p.requires]),
    ).toEqual([['/dashboard/procedures', 'items:update']]);
  });

  // Renamed by docs/whats-new-2026-10-26 (2026-10-26; was: "is the first notice for every member, and an old phone build shows its title and summary with Open notification settings"): the ended-session-group-page-fixes release, published at the top, reaches every member and comes first. Claim kept: the first notice for every member once that release is read, and an old phone build shows its title and summary with Open notification settings once it is seen.
  // Renamed by docs/whats-new-2026-10-30 (2026-10-30; was: "... once the ended-session-group-page-fixes release is read, ... once that release is seen"): the manage-order-items-and-app-fixes release, published at the top, reaches every member and comes first, then the ended-session-group-page-fixes release. Claim kept: the first notice for every member once those releases are read, and an old phone build shows its title and summary with Open notification settings once they are seen.
  it('is the first notice for every member once the manage-order-items-and-app-fixes and ended-session-group-page-fixes releases are read, and an old phone build shows its title and summary with Open notification settings once those releases are seen', () => {
    for (const v of [owner, member]) {
      // Re-pinned by docs/whats-new-2026-10-26 (2026-10-26; was: ID with nothing read or seen): the ended-session-group-page-fixes release, published at the top, reaches every member, so this reader is told it first and this one once it is read or seen.
      // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: TOP_ID with nothing read or seen, and ID once it was read or seen): the manage-order-items-and-app-fixes release, published at the top, reaches every member, so this reader is told it first, the ended-session-group-page-fixes release once it is read or seen, and this one once both are.
      expect(buildReleaseList(RELEASES, v, [], null).latestUnread?.id, v.role).toBe(LATEST_ID);
      expect(legacyAnnouncementsFor(RELEASES, v, {})[0]?.id, v.role).toBe(LATEST_ID);
      expect(buildReleaseList(RELEASES, v, [latestRead()], null).latestUnread?.id, v.role).toBe(
        TOP_ID,
      );
      expect(legacyAnnouncementsFor(RELEASES, v, latestSeen())[0]?.id, v.role).toBe(TOP_ID);
      expect(
        buildReleaseList(RELEASES, v, [latestRead(), topRead()], null).latestUnread?.id,
        v.role,
      ).toBe(ID);
      expect(
        legacyAnnouncementsFor(RELEASES, v, { ...latestSeen(), ...topSeen() })[0],
        v.role,
      ).toEqual({
        id: ID,
        date: '2026-10-25',
        title: release().title,
        body: release().summary,
        cta: { href: SETTINGS_NOTIFICATIONS, label: 'Open notification settings' },
      });
    }
    expect(registryFingerprint(RELEASES)).toContain(`${ID}@1:published`);
    expect(registryFingerprint(RELEASES)).not.toBe(
      registryFingerprint(RELEASES.filter((r) => r.id !== ID)),
    );
    expect(ANNOUNCEMENTS.map((a) => a.id)).toContain(ID);
    expect(ANNOUNCEMENTS.find((a) => a.id === ID)?.roles).toBeUndefined();
  });

  // A phone shows only the title and the summary, and no button for a page
  // with no phone twin: the notification settings page falls through the
  // rewrite's catch-all to home, so the phone's What's New hides its button.
  // The summary says "On the web" before the changes only the web has.
  it('says On the web before the web-only changes, as a phone shows the summary without the notification settings button', () => {
    expect(release().summary).toContain(
      'On the web, adding an item asks before its stock goes onto a rack that does not exist yet',
    );
    const whatsNew = repoFile('apps/mobile/src/components/onboarding/whats-new.tsx');
    expect(whatsNew).toContain("const showCta = !!cta && rewriteWebPath(cta.href) !== '/';");
    const rewrite = repoFile('apps/mobile/src/lib/web-path-rewrite.ts');
    expect(rewrite).not.toMatch(/settings/);
    expect(rewrite).toContain("{ re: /^\\/dashboard(\\/.*)?$/, to: () => '/' },");
  });

  it('rests the words it quotes on the code that shows or sends them', () => {
    const entry = (id: string) => release().entries.find((e) => e.id === id)!;
    // The rack question (core words, the web dialog's buttons).
    const near = repoFile('packages/core/src/inventory/rack-near-match.ts');
    expect(near).toContain('let title = `Create new ${noun} ${label}?`;');
    expect(near).toContain(
      "title = `${noun === 'crate' ? 'Crate' : 'Rack'} ${label} does not exist`;",
    );
    expect(source('components/inventory/placement-confirm-dialog.tsx')).toContain(
      'Use {s} instead',
    );
    const question = source('components/inventory/new-rack-question.ts');
    expect(question).toContain("export const NEW_RACK_CONFIRM_LABEL = 'Create rack and save';");
    expect(question).toContain("export const NEW_RACK_SAVE_ANYWAY_LABEL = 'Save anyway';");
    const rack = entry('web-asks-before-new-rack');
    expect(rack.whatChanged).toContain('“Create new rack 1-B?”');
    expect(rack.whatChanged).toContain('“Use 17-B instead”');
    expect(rack.howItAffectsYou).toContain('“Rack 1-B does not exist”');
    expect(rack.howItAffectsYou).toContain('Create rack and save');
    expect(rack.howItAffectsYou).toContain('its button is Save anyway');
    // The export refusal.
    expect(source('lib/export-rate-limit.ts')).toContain(
      `"Start this download from StockPilot. A link on another website can't start it.";`,
    );
    expect(entry('other-websites-cannot-sign-you-out-or-download').whatChanged).toContain(
      "“Start this download from StockPilot. A link on another website can't start it.”",
    );
    // Added in review (2026-10-25): the refusal is a short JSON error that
    // carries those words, and every file the entry names comes from a route
    // that calls it. A report's page and the order print page are dashboard
    // pages that never do, so the entry names a report's PDF or CSV, not a
    // report or a printout.
    expect(source('lib/export-rate-limit.ts')).toContain(
      "{ error: 'cross_site_request', message: CROSS_SITE_EXPORT_MESSAGE },",
    );
    for (const route of [
      'app/api/inventory/export.csv/route.ts',
      'app/api/reports/[slug]/csv/route.ts',
      'app/api/reports/[slug]/pdf/route.tsx',
      'app/api/purchase-orders/[id]/pdf/route.tsx',
      'app/api/orders/[id]/pick-slip.pdf/route.tsx',
    ]) {
      expect(source(route), route).toMatch(
        /const limited = await exportRateLimited\((req|request), ctx\.userId, ctx\.organizationId\);/,
      );
    }
    const download = entry('other-websites-cannot-sign-you-out-or-download');
    expect(download.whatChanged).toContain(
      "A link to an export or PDF StockPilot makes, such as a CSV export, a report's PDF or CSV, a purchase order PDF or a pick slip,",
    );
    expect(download.howItAffectsYou).toContain(
      'you see a short error that contains that message instead of the file',
    );
    // Added in review (2026-10-25): the two hover times use the organization's
    // stored zone, which only owners and admins change, under Workspace
    // timezone. No sentence says an unset zone is UTC: the create form stores
    // the creator's browser zone, and an unreadable row falls back to Pacific.
    expect(source('app/(dashboard)/dashboard/team/page.tsx')).toContain(
      'timeZone={resolveOrgTimezone(orgRow.data?.timezone as string | null | undefined)}',
    );
    expect(source('app/(dashboard)/dashboard/procedures/[id]/page.tsx')).toContain(
      '.then((org) => resolveOrgTimezone(org?.timezone))',
    );
    expect(source('components/onboarding/create-organization-form.tsx')).toContain(
      "timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',",
    );
    expect(source('components/settings/org-timezone-editor.tsx')).toContain(
      '<Label htmlFor="org-timezone">Workspace timezone</Label>',
    );
    expect(source('server/actions/organization.ts')).toContain(
      "return err('forbidden', 'Only owners and admins can change the timezone.');",
    );
    for (const id of ['team-disabled-time-org-zone', 'procedure-comment-times-org-zone']) {
      expect(entry(id).howItAffectsYou, id).toContain(
        "The time uses your organization's time zone, which owners and admins can change under Workspace timezone in Settings, Organization.",
      );
      expect(entry(id).howItAffectsYou, id).not.toContain('UTC');
    }
    // The confirmation page's notice.
    const notice =
      "If this link was sent to a different account, continuing signs you in to that account instead. If you didn't ask for this link, close this page.";
    expect(source('app/auth/confirm/route.ts')).toContain(notice);
    expect(entry('reset-and-email-change-pages-name-your-account').whatChanged).toContain(
      `“${notice}”`,
    );
    // The settings error and the page-wide one it replaces there.
    expect(source('app/(dashboard)/dashboard/settings/error.tsx')).toContain(
      `title="We couldn't load this settings page"`,
    );
    expect(source('app/(dashboard)/error.tsx')).toContain('Something broke loading this page');
    // The unsubscribe link's 90 days.
    expect(source('lib/email/member-unsubscribe.ts')).toContain(
      'export const MEMBER_UNSUBSCRIBE_MAX_AGE_DAYS = 90;',
    );
    expect(entry('unsubscribe-digest-and-reminder-emails').howItAffectsYou).toContain(
      'A link works for 90 days after its email was sent',
    );
    // The order emails' counts.
    expect(source('lib/email/es/count.ts')).toContain(
      'return `${n} ${n === 1 ? singular : plural}`;',
    );
    expect(source('lib/email/es/registry.ts')).toContain(
      "`Reserved ${countOf(p.units, 'unit')} across ${countOf(p.lines, 'line')}.",
    );
    expect(source('lib/email/es/registry.ts')).toContain(
      "`${countOf(p.lines, 'line')} ${p.lines === 1 ? 'is' : 'are'} being picked and packed at",
    );
    const orders = source('lib/email/order-requests.ts');
    expect(orders).toContain("units === 1 ? 'The reserved unit went back'");
    expect(orders).toContain('return `${released} to stock;');
    expect(source('lib/email/es/families/fulfillment.ts')).toContain(
      "const remaining = oneBack ? 'The remaining unit is' : `The remaining ${p.backordered} units are`;",
    );
  });

  it('uses plain words: no claim StockPilot cannot stand behind, never "book" for a quantity, no percentages and no speed nobody measured', () => {
    const text = words();
    for (const phrase of FORBIDDEN) {
      expect(text.toLowerCase(), phrase).not.toContain(phrase);
    }
    expect(text).not.toMatch(
      /\bthe book\b|\bbook (count|quantity|stock|level)s?\b|\bbooked\b|\bon the books\b/i,
    );
    expect(text).not.toContain('%');
    expect(text).not.toContain('!');
    expect(text).not.toMatch(/\bfaster\b|\bquicker\b|\bspeed\b|\binstant/i);
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
    // Nothing says StockPilot sent an email or told someone: the emails are
    // the digest's and the reminders' own, named by what they are.
    expect(text).not.toMatch(
      /\bwe (sent|emailed|notified)\b|\bStockPilot (sent|emailed|notified)\b/i,
    );
  });
});

/**
 * Added by docs/whats-new-2026-10-26 (2026-10-26). The web parts of five
 * changes merged on 2026-10-25 and 2026-10-26 are told in one release at the
 * top: B12 #386 (a7ac4a055), B22 #392 (db31281b3), B38 #393 (e48103218), B26
 * #396 (0ad683600) and B5+B28 #397 (fcd993bee, merged 2026-10-26 02:02:23Z),
 * all live in production from web build e1ff7c74ac73. No migration. The
 * phone parts of #396 and #397 ship with the next phone update and are told
 * then. The words were checked against the source at 0132fbd25; the tests
 * below pin the checks its audiences and its four links rest on, and the
 * words it quotes.
 */
describe('the ended-session, Group selected page and other web fixes release (ended-session-group-page-fixes-2026-10)', () => {
  const ID = TOP_ID;
  const release = () => RELEASES.find((r) => r.id === ID)!;
  const entry = (id: string) => release().entries.find((e) => e.id === id)!;
  const owner: ReleaseViewer = {
    role: 'owner',
    permissions: [...PERMISSIONS],
    enabledModules: Object.keys(MODULE_REGISTRY) as ModuleId[],
  };
  /** A member who holds no permission and no module. */
  const member: ReleaseViewer = { role: 'viewer', permissions: [], enabledModules: [] };
  const words = () => readerText(release()).join(' ');
  /** A file in the repository, as written. */
  const REPO = resolve(__dirname, '../../../../..');
  const repoFile = (rel: string) => readFileSync(resolve(REPO, rel), 'utf8');
  /** A source file under apps/web/src, as written. */
  const source = (rel: string) => repoFile(`apps/web/src/${rel}`);
  /** A dashboard page's source, by its path under app/(dashboard)/dashboard. */
  const page = (rel: string) => source(`app/(dashboard)/dashboard/${rel}`);
  const STAGING = '/dashboard/inventory/staging';

  // Published once the last of the five changes had merged (#397 at
  // 02:02:23Z), its web build answered on production and the last walk had
  // ended (03:44Z to 03:54Z); the day it was published (UTC) is the ceiling.
  // Renamed by docs/whats-new-2026-10-30 (2026-10-30; was: "is published at the top as revision 1, ..., dated after every release, ..."): the manage-order-items-and-app-fixes release is published above it, at the top. Claim kept: revision 1, not before the last of its five changes merged and the last walk ended, dated after every release below it, and no draft is left; the release above it is dated after it.
  it('is published directly below the manage-order-items-and-app-fixes release (published later) as revision 1, not before the last of its five changes merged (02:02:23Z) and the last walk ended (03:54Z), dated after every release below it, and no draft is left', () => {
    // Re-pinned by the B44 phone update draft (fix/b44-update-restart-prompt;
    // was: without it): dated after every release, it sits at the top, so
    // every position below it moves down by one, and it and slice 8's are the
    // drafts.
    // Re-pinned by the small fixes slice 8 draft (fix/small-fixes-8; was:
    // without it): dated after every release, it sits at the top, so every
    // position below it moves down by one, and it is the one draft.
    expect(release()).toBeDefined();
    expect(release().status).toBe('published');
    expect(release().revision).toBe(1);
    // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: at 0 and slice(1)): the manage-order-items-and-app-fixes release is published at the top, above this one, so every position from it down moves down by one.
    expect(RELEASES[1]?.id).toBe('small-fixes-8-2026-10');
    expect(RELEASES[1]?.status).toBe('draft');
    expect(RELEASES[2]?.id).toBe(LATEST_ID);
    expect(RELEASES[2]?.status).toBe('published');
    expect(Date.parse(RELEASES[2]!.publishedAt)).toBeGreaterThan(Date.parse(release().publishedAt));
    expect(RELEASES[3]?.id).toBe(ID);
    expect(release().publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/);
    expect(Date.parse(release().publishedAt)).toBeGreaterThanOrEqual(
      Date.parse('2026-10-26T02:02:00Z'),
    );
    expect(Date.parse(release().publishedAt)).toBeGreaterThanOrEqual(
      Date.parse('2026-10-26T03:54:00Z'),
    );
    expect(Date.parse(release().publishedAt)).toBeLessThanOrEqual(
      Date.parse('2026-10-27T00:00:00Z'),
    );
    for (const r of RELEASES.slice(4)) {
      expect(Date.parse(release().publishedAt), r.id).toBeGreaterThan(Date.parse(r.publishedAt));
    }
    expect(RELEASES.filter((r) => r.status === 'draft').map((r) => r.id)).toEqual([
      'mobile-app-asks-before-restarting',
      'small-fixes-8-2026-10',
    ]);
  });

  it('has twelve entries with unique ids, and its four links open pages that exist', () => {
    const r = release();
    const ids = r.entries.map((e) => e.id);
    expect(ids).toHaveLength(12);
    expect(new Set(ids).size).toBe(ids.length);
    const links = r.entries.filter((e) => e.link).map((e) => [e.id, e.link!.href]);
    expect(links).toEqual([
      ['staging-place-stock-without-warehouse', STAGING],
      ['bulk-isbn-import-either-isbn-form', '/dashboard/books/import'],
      ['po-scan-clothing-line-names', '/dashboard/purchase-orders/imports/new'],
      ['po-import-reimport-date', '/dashboard/purchase-orders/imports'],
    ]);
    for (const [id, href] of links) expect(pageExistsFor(href!), id).toBe(true);
  });

  // The one entry with no audience (the ended session) has no link: every
  // member's buttons pass the proxy. Every linked entry names who can reach
  // its page.
  it('tells its ended-session entry to every member and each other entry to whoever can open the page or use the action it names, with an audience on every linked entry', () => {
    const r = release();
    expect(r.audience).toBeUndefined();
    expect(r.entries.filter((e) => e.link && !e.audience).map((e) => e.id)).toEqual([]);
    const itemEditors = { anyPermission: ['items:update'] };
    const poImports = { anyPermission: ['purchase_orders:manage'], modules: ['po_imports'] };
    expect(
      r.entries.map((e) => [e.id, e.category, e.area, e.audience ?? null, e.link ?? null]),
    ).toEqual([
      ['ended-session-goes-to-sign-in', 'fixed', 'Account', null, null],
      ['group-selected-shows-the-group', 'fixed', 'Inventory', itemEditors, null],
      [
        'order-timeline-paper-signature',
        'improved',
        'Orders',
        { anyPermission: ['activity_logs:read'], modules: ['orders'] },
        null,
      ],
      [
        'place-order-ended-session',
        'fixed',
        'Orders',
        { anyPermission: ['orders:request'], modules: ['orders'] },
        null,
      ],
      [
        'staging-place-stock-without-warehouse',
        'fixed',
        'Staging',
        { roles: ['owner', 'admin', 'manager', 'staff'], anyPermission: ['items:read'] },
        { href: STAGING, label: 'Open Staging' },
      ],
      [
        'duplicated-book-stock-waits-in-unplaced',
        'fixed',
        'Inventory',
        { anyPermission: ['items:create'], modules: ['books'] },
        null,
      ],
      [
        'order-tracking-signed-for-pickup-steps',
        'improved',
        'Orders',
        { modules: ['public_requests'] },
        null,
      ],
      [
        'bulk-isbn-import-either-isbn-form',
        'fixed',
        'Books',
        { anyPermission: ['items:import'], modules: ['books'] },
        { href: '/dashboard/books/import', label: 'Open Bulk ISBN import' },
      ],
      [
        'po-scan-clothing-line-names',
        'improved',
        'PO imports',
        poImports,
        { href: '/dashboard/purchase-orders/imports/new', label: 'New PO import' },
      ],
      ['sku-change-checks-all-records', 'fixed', 'Inventory', itemEditors, null],
      [
        'po-import-reimport-date',
        'improved',
        'PO imports',
        poImports,
        { href: '/dashboard/purchase-orders/imports', label: 'Open PO imports' },
      ],
      [
        'new-procedure-upload-ended-session',
        'fixed',
        'Procedures',
        { anyPermission: ['categories:manage'], modules: ['procedures'] },
        null,
      ],
    ]);
  });

  it('names in each audience the permission and the module that its page or action checks', () => {
    // The four linked pages.
    const staging = page('inventory/staging/page.tsx');
    expect(staging).toContain("if (!can(sessionCtx, 'items:read')) notFound();");
    expect(staging).toContain("const canPlace = can(sessionCtx, 'stock:transfer');");
    expect(page('books/import/page.tsx')).toContain("if (!can(ctx, 'items:import')) {");
    expect(page('purchase-orders/imports/layout.tsx')).toContain(
      "if (!can(ctx, 'purchase_orders:manage')) {",
    );
    for (const rel of [
      'purchase-orders/imports/page.tsx',
      'purchase-orders/imports/new/page.tsx',
    ]) {
      expect(page(rel), rel).toContain(
        "const moduleAccess = await checkModuleAccess('po_imports');",
      );
    }
    // The entries with no link: the button, page or action each one names.
    for (const rel of ['inventory/page.tsx', 'books/page.tsx']) {
      expect(page(rel), rel).toContain("const canUngroup = can(sessionCtx, 'items:update');");
    }
    expect(page('orders/[id]/page.tsx')).toContain(
      "canReadActivity={can(ctx, 'activity_logs:read')}",
    );
    const placeOrder = page('orders/new/page.tsx');
    expect(placeOrder).toContain("if (!can(ctx, 'orders:request')) {");
    expect(placeOrder).toContain("const moduleAccess = await checkModuleAccess('orders');");
    expect(source('components/inventory/item-detail.tsx')).toContain(
      "const canDuplicateItem = can(ctx, 'items:create');",
    );
    expect(source('app/api/v1/public/order-requests/route.ts')).toContain(
      ".eq('module_id', 'public_requests')",
    );
    expect(source('server/services/inventory.ts')).toContain(
      "async update(id: string, patch: UpdateItemInput) {\n    assertPermission(this.ctx, 'items:update');",
    );
    expect(page('procedures/new/page.tsx')).toContain("if (!can(ctx, 'categories:manage')) {");
  });

  it('reaches every member, and a member with no permission is told only the ended-session entry', () => {
    const shown = (v: ReleaseViewer) =>
      visibleReleases(RELEASES, v)
        .find((r) => r.id === ID)
        ?.entries.map((e) => e.id);
    expect(shown(owner)).toEqual(release().entries.map((e) => e.id));
    expect(shown(member)).toEqual(['ended-session-goes-to-sign-in']);
    // Staging is told to staff who can read items, and never to a viewer.
    expect(shown({ role: 'staff', permissions: ['items:read'], enabledModules: [] })).toEqual([
      'ended-session-goes-to-sign-in',
      'staging-place-stock-without-warehouse',
    ]);
    expect(shown({ role: 'viewer', permissions: ['items:read'], enabledModules: [] })).toEqual([
      'ended-session-goes-to-sign-in',
    ]);
  });

  // Renamed by docs/whats-new-2026-10-30 (2026-10-30; was: "is the first notice for every member, and an old phone build shows its title and summary, with Open Staging ..."): the manage-order-items-and-app-fixes release, published at the top, reaches every member and comes first. Claim kept: the first notice for every member once that release is read, and an old phone build shows its title and summary, with Open Staging for whoever the Staging entry reaches, once it is seen.
  it('is the first notice for every member once the manage-order-items-and-app-fixes release is read, and an old phone build shows its title and summary, with Open Staging for whoever the Staging entry reaches, once that release is seen', () => {
    for (const v of [owner, member]) {
      // Re-pinned by docs/whats-new-2026-10-30 (2026-10-30; was: ID with nothing read or seen): the manage-order-items-and-app-fixes release, published at the top, reaches every member, so this reader is told it first and this one once it is read or seen.
      expect(buildReleaseList(RELEASES, v, [], null).latestUnread?.id, v.role).toBe(LATEST_ID);
      expect(legacyAnnouncementsFor(RELEASES, v, {})[0]?.id, v.role).toBe(LATEST_ID);
      expect(buildReleaseList(RELEASES, v, [latestRead()], null).latestUnread?.id, v.role).toBe(ID);
    }
    expect(legacyAnnouncementsFor(RELEASES, owner, latestSeen())[0]).toEqual({
      id: ID,
      date: '2026-10-26',
      title: release().title,
      body: release().summary,
      cta: { href: STAGING, label: 'Open Staging' },
    });
    expect(legacyAnnouncementsFor(RELEASES, member, latestSeen())[0]).toEqual({
      id: ID,
      date: '2026-10-26',
      title: release().title,
      body: release().summary,
    });
    expect(registryFingerprint(RELEASES)).toContain(`${ID}@1:published`);
    expect(registryFingerprint(RELEASES)).not.toBe(
      registryFingerprint(RELEASES.filter((r) => r.id !== ID)),
    );
    expect(ANNOUNCEMENTS.map((a) => a.id)).toContain(ID);
  });

  // A phone shows only the title and the summary, and a button only for a
  // page with a phone twin: Open Staging opens the phone's own Staging, where
  // these rows still cannot be placed, and the other three links fall through
  // the rewrite's catch-all to home, so the phone hides their button.
  it('says On the web before its changes, and that the mobile app still cannot place the rows Open Staging leads to', () => {
    expect(release().title).toMatch(/^On the web, /);
    expect(release().summary).toMatch(/^On the web, /);
    expect(release().summary).toContain('. Also on the web, ');
    expect(release().summary).toContain(
      'Staging can place stock that is in no warehouse yet (the mobile app still cannot)',
    );
    const whatsNew = repoFile('apps/mobile/src/components/onboarding/whats-new.tsx');
    expect(whatsNew).toContain("const showCta = !!cta && rewriteWebPath(cta.href) !== '/';");
    const rewrite = repoFile('apps/mobile/src/lib/web-path-rewrite.ts');
    expect(rewrite).toContain(
      "{ re: /\\/dashboard\\/inventory\\/staging(\\?.*)?$/, to: () => '/staging' },",
    );
    expect(rewrite).toContain(
      "{ re: /\\/dashboard\\/purchase-orders(\\?.*)?$/, to: () => '/purchase-orders' },",
    );
    expect(rewrite).not.toMatch(/books|imports/);
    expect(rewrite).toContain("{ re: /^\\/dashboard(\\/.*)?$/, to: () => '/' },");
    expect(repoFile('apps/mobile/src/lib/staging-worklist.ts')).toContain(
      'return canPlace && row.warehouseId !== null;',
    );
    // A replaced PO import: the phone's own notice gives no date, so the
    // entry says the dated notice is on the web.
    const reimport = entry('po-import-reimport-date');
    expect(reimport.title).toMatch(/^On the web, /);
    expect(reimport.whatChanged).toMatch(/^On the web, /);
    const phoneImport = repoFile('apps/mobile/app/po-import/[id].tsx');
    expect(phoneImport).toContain('Replaced by a later import of this file.');
    expect(phoneImport).not.toContain('imported again on');
  });

  it('rests the words it quotes on the code that shows them', () => {
    // Every quotation in the release, so a new one is pinned below too.
    expect([...new Set(words().match(/“[^”]*”/g) ?? [])].sort()).toEqual(
      [
        '“25 - Small : Carolina Blue”',
        '“An unexpected response was received from the server”',
        '“Carolina Blue - S”',
        '“Its stock is in Unplaced, awaiting put-away.”',
        '“Physical signature recorded”',
        '“Replaced by a later import of this file”',
        '“Signed on paper by”',
        "“Some video uploads didn't finish. Re-drop the missing files.”",
        '“Something went wrong”',
        '“Status changed”',
        '“The order is marked completed.”',
        '“This file was imported again on”',
        '“What was handed over is recorded. The rest stays on backorder.”',
        '“Your order request is not confirmed”',
      ].sort(),
    );
    // An ended session: the errors a button showed before, and the proxy's
    // answer now (sign-in, naming the page, and back to it).
    expect(source('server/actions/exceptions.ts')).toContain(
      "message: 'Something went wrong. Please try again.'",
    );
    expect(source('lib/supabase/middleware.test.ts')).toMatch(
      /An unexpected response was received from the\s+\/\/ server\./,
    );
    const proxy = source('lib/supabase/middleware.ts');
    expect(proxy).toContain(
      "headers: { 'x-action-redirect': `${url.pathname}${url.search};push` },",
    );
    expect(proxy).toContain("url.searchParams.set('redirect', `${pathname}${search}`);");
    expect(source('components/auth/sign-in-form.tsx')).toContain('router.replace(redirect);');
    // An old sign-in page never caught the rejected action, so it showed no
    // message and stayed as it was.
    expect(source('components/auth/sign-in-form.tsx')).toContain(
      'const res = await signInAction(values);',
    );
    expect(entry('ended-session-goes-to-sign-in').whyItMatters).toContain(
      'Pressing Sign in on an old sign-in page left you on that page.',
    );
    // Place an order.
    expect(STOREFRONT_TITLE_COPY).toBe('Place an order');
    expect(REVIEW_SUBMIT_COPY).toBe('Submit order request');
    expect(ORDER_UNCONFIRMED_TITLE_COPY).toBe('Your order request is not confirmed');
    expect([ORDER_SEE_MY_ORDERS_COPY, ORDER_DONT_SEND_COPY, ORDER_CHECK_AND_FINISH_COPY]).toEqual([
      'See my orders',
      "Don't send it",
      'Check and finish',
    ]);
    expect(source('components/orders/storefront/order-submission.ts')).toContain(
      'if (isControlFlow(error)) return;',
    );
    expect(entry('place-order-ended-session').whatChanged).toContain(
      "which offers See my orders, Don't send it and Check and finish.",
    );
    // A paper signature on the order's timeline.
    const outcome = source('lib/orders/sign-outcome.ts');
    expect(outcome).toContain(
      "export const PHYSICAL_SIGNATURE_RECORDED = 'Physical signature recorded';",
    );
    expect(outcome).toContain("message: 'The order is marked completed.',");
    expect(outcome).toContain(
      "message: 'What was handed over is recorded. The rest stays on backorder.',",
    );
    const timeline = source('components/orders/order-timeline.tsx');
    expect(timeline).toContain(
      'if (isPaperHandOver(event, metadata)) return PHYSICAL_SIGNATURE_RECORDED;',
    );
    expect(timeline).toContain(
      "lines.push(signer ? `Signed on paper by ${signer}${stop}` : 'Signed on paper.');",
    );
    expect(timeline).toContain("'order_request.status_changed': 'Status changed',");
    // The order tracking page's steps.
    const track = source('components/orders/track-form.tsx');
    expect(track).toContain(
      "{ key: 'createdAt', label: 'Submitted' },\n    { key: 'approvedAt', label: 'Approved' },\n    { key: 'packingSlipGeneratedAt', label: 'Packed' },\n    { key: 'stagedAt', label: 'Staged' },",
    );
    expect(track).toContain("if (result.fulfillmentType !== 'pickup') {");
    expect(track).toContain("export const SIGNED_FOR_STEP_LABEL = 'Signed for';");
    expect(track).toContain("backordered: 'Backordered',");
    expect(track).toContain("completed: 'Delivered',");
    expect(PICKUP_COMPLETED_STATUS_LABEL).toBe('Handed over');
    expect(orderStatusLabelForFulfillment('completed', 'Delivered', 'pickup')).toBe('Handed over');
    expect(orderStatusLabelForFulfillment('completed', 'Delivered', 'delivery')).toBe('Delivered');
    // Staging.
    expect(source('lib/locations/place-warehouse.ts')).toContain(
      "export const NO_PLACE_WAREHOUSE_REASON = 'No warehouse to place it in';",
    );
    expect(source('components/inventory/place-from-staging-dialog.tsx')).toContain(
      '<Label id="place-warehouse-label">To warehouse</Label>',
    );
    expect(entry('staging-place-stock-without-warehouse').howItAffectsYou).toContain(
      'its hover text reads No warehouse to place it in.',
    );
    // A duplicated book.
    const duplicate = source('components/inventory/duplicate-item-dialog.tsx');
    expect(duplicate).toContain(
      'toast.success(`Duplicated "${itemName}". Its stock is in Unplaced, awaiting put-away.`);',
    );
    expect(duplicate).toContain("{isBook ? 'Quantity' : 'Quantity at this rack'}");
    // Bulk ISBN import: the two forms of one ISBN are one book.
    expect(isbnSearchKeys('0306406152')).toEqual(['0306406152', '9780306406157']);
    expect(isbnSearchKeys('9780306406157')).toEqual(['9780306406157', '0306406152']);
    expect(source('components/books/bulk-isbn-import.tsx')).toContain(
      '`Created ${created} · ${skipped} already existed (matched by ISBN/SKU).`',
    );
    expect(entry('bulk-isbn-import-either-isbn-form').whatChanged).toContain(
      'If the list gives 0306406152 for a book you already have as 9780306406157',
    );
    // Scanned clothing lines.
    expect(normalizeApparelName('25 - Small : Carolina Blue', 25, 'Small')).toBe(
      'Carolina Blue - S',
    );
    expect(normalizeApparelName('3-Ring Binder', 3, '')).toBe('3-Ring Binder');
    expect(normalizeApparelName('16:9 Widescreen Monitor', 16, '')).toBe('16:9 Widescreen Monitor');
    // A changed SKU.
    expect(source('server/services/inventory.ts')).toContain(
      "Two records can't share a SKU there, so nothing was changed.",
    );
    expect(entry('sku-change-checks-all-records').whatChanged).toContain(
      "for example: Two records can't share a SKU there, so nothing was changed.",
    );
    // A replaced PO import.
    const lineage = source('components/po-imports/po-import-lineage-notice.tsx');
    expect(lineage).toContain('Replaced by a later import of this file');
    expect(lineage).toContain("This file was imported again on{' '}");
    // A new procedure's videos.
    expect(source('components/procedures/upload-recovery-toast.tsx')).toContain(
      'toast.warning("Some video uploads didn\'t finish. Re-drop the missing files.");',
    );
    // Only a session that runs out keeps the procedure's id: a sign-out, here,
    // in another tab or by a revoke, removes it, so the entry says so and
    // sends that reader to Procedures.
    expect(source('components/dashboard/user-menu.tsx')).toContain('purgeInterruptedRuns();');
    expect(source('components/realtime/session-revocation-listener.tsx')).toContain(
      'purgeInterruptedRuns();',
    );
    expect(source('lib/interrupted-run.ts')).toContain(
      'export function listenForPurges(): () => void {',
    );
    const procedure = entry('new-procedure-upload-ended-session');
    expect(procedure.title).toContain('If your session runs out while');
    expect(procedure.whatChanged).toContain(
      'your session runs out while they upload (it expired, not a sign-out)',
    );
    expect(procedure.howItAffectsYou).toContain(
      'Signing out, in this tab, in another tab of this browser or from another device, removes it',
    );
    expect(procedure.whatToDo).toContain('open Procedures and finish the procedure already saved');
    expect(page('procedures/page.tsx')).toContain('title="Procedures"');
    // Group selected.
    expect(GROUP_COPY.showIt).toBe('Show it');
    expect(INSTANT_MODE_MAX_ROWS).toBe(2000);
    expect(entry('group-selected-shows-the-group').howItAffectsYou).toContain(
      'as on a list of more than 2,000 records',
    );
  });

  it('uses plain words: no claim StockPilot cannot stand behind, never "book" for a quantity, no percentages and no speed nobody measured', () => {
    const text = words();
    for (const phrase of FORBIDDEN) {
      expect(text.toLowerCase(), phrase).not.toContain(phrase);
    }
    expect(text).not.toMatch(
      /\bthe book\b|\bbook (count|quantity|stock|level)s?\b|\bbooked\b|\bon the books\b/i,
    );
    expect(text).not.toContain('%');
    expect(text).not.toContain('!');
    expect(text).not.toMatch(/\bfaster\b|\bquicker\b|\bspeed\b|\binstant/i);
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
    // Nothing says StockPilot sent an email or told someone.
    expect(text).not.toMatch(
      /\bwe (sent|emailed|notified)\b|\bStockPilot (sent|emailed|notified)\b/i,
    );
  });
});

/**
 * Added by docs/whats-new-2026-10-30 (2026-10-30). Ordering visibility (#411,
 * d617de0d7, migration 0413) on the web and in the mobile app, two photo fixes
 * on the web (#412, 3fe75cd1f, and #413, 64054fb3d), and the phone parts of B16
 * #389, RL1 #382, B26 #396, B28 #397, B29 #399 (with its web half), T14 #405,
 * #380 and B31 #408 are told in one release at the top. The web parts are live
 * from web build 360f0fbb6f4d; the phone parts reached phones in the one
 * over-the-air update published 2026-10-30 15:33Z from 64054fb3d. The words
 * were checked against the source at 64054fb3d; the tests below pin the checks
 * its audiences and its two links rest on, and the words it quotes.
 */
describe('the Manage order items, photos and mobile app fixes release (manage-order-items-and-app-fixes-2026-10)', () => {
  const ID = LATEST_ID;
  const release = () => RELEASES.find((r) => r.id === ID)!;
  const entry = (id: string) => release().entries.find((e) => e.id === id)!;
  const owner: ReleaseViewer = {
    role: 'owner',
    permissions: [...PERMISSIONS],
    enabledModules: Object.keys(MODULE_REGISTRY) as ModuleId[],
  };
  /** A member who holds no permission and no module. */
  const member: ReleaseViewer = { role: 'viewer', permissions: [], enabledModules: [] };
  const words = () => readerText(release()).join(' ');
  /** A file in the repository, as written. */
  const REPO = resolve(__dirname, '../../../../..');
  const repoFile = (rel: string) => readFileSync(resolve(REPO, rel), 'utf8');
  /** A source file under apps/web/src, as written. */
  const source = (rel: string) => repoFile(`apps/web/src/${rel}`);
  /** A dashboard page's source, by its path under app/(dashboard)/dashboard. */
  const page = (rel: string) => source(`app/(dashboard)/dashboard/${rel}`);
  /** A file in the mobile app, as written. */
  const phone = (rel: string) => repoFile(`apps/mobile/${rel}`);
  const MANAGE_ITEMS = '/dashboard/orders/manage-items';
  const MAINTENANCE = '/dashboard/maintenance';
  /** Every entry but the photo one has a part in the mobile app. */
  const WEB_ONLY = ['photos-no-white-backing'];

  // Published once the phone update was out (15:33Z on 2026-10-30), after the
  // last of its changes merged (#413 at 15:27:40Z) and its web build answered
  // on production (15:29Z); the day it was published (UTC) is the ceiling.
  it('is published at the top as revision 1, not before the phone update was published (15:33Z) and the last of its changes merged (15:27:40Z), dated after every release, and no draft is left', () => {
    // Re-pinned by the B44 phone update draft (fix/b44-update-restart-prompt;
    // was: without it): dated after every release, it sits at the top, so
    // every position below it moves down by one, and it and slice 8's are the
    // drafts.
    // Re-pinned by the small fixes slice 8 draft (fix/small-fixes-8; was:
    // without it): dated after every release, it sits at the top, so every
    // position below it moves down by one, and it is the one draft.
    expect(release()).toBeDefined();
    expect(release().id).toBe('manage-order-items-and-app-fixes-2026-10');
    expect(RELEASES.filter((r) => r.id === ID)).toHaveLength(1);
    expect(release().status).toBe('published');
    expect(release().revision).toBe(1);
    expect(RELEASES[1]?.id).toBe('small-fixes-8-2026-10');
    expect(RELEASES[1]?.status).toBe('draft');
    expect(RELEASES[2]?.id).toBe(ID);
    expect(release().publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/);
    expect(Date.parse(release().publishedAt)).toBeGreaterThanOrEqual(
      Date.parse('2026-10-30T15:33:00Z'),
    );
    expect(Date.parse(release().publishedAt)).toBeGreaterThanOrEqual(
      Date.parse('2026-10-30T15:27:40Z'),
    );
    expect(Date.parse(release().publishedAt)).toBeLessThanOrEqual(
      Date.parse('2026-10-31T00:00:00Z'),
    );
    for (const r of RELEASES.slice(3)) {
      expect(Date.parse(release().publishedAt), r.id).toBeGreaterThan(Date.parse(r.publishedAt));
    }
    expect(RELEASES.filter((r) => r.status === 'draft').map((r) => r.id)).toEqual([
      'mobile-app-asks-before-restarting',
      'small-fixes-8-2026-10',
    ]);
  });

  it('has twelve entries with unique ids, none of them told before, and its two links open pages that exist', () => {
    const r = release();
    const ids = r.entries.map((e) => e.id);
    expect(ids).toHaveLength(12);
    expect(new Set(ids).size).toBe(ids.length);
    // The web halves told in the two releases below it are not told again.
    for (const other of [TOP_ID, NEWEST_ID]) {
      const told = RELEASES.find((x) => x.id === other)!.entries.map((e) => e.id);
      for (const id of ids) expect(told, `${other} / ${id}`).not.toContain(id);
    }
    const links = r.entries.filter((e) => e.link).map((e) => [e.id, e.link!.href]);
    expect(links).toEqual([
      ['manage-order-items', MANAGE_ITEMS],
      ['maintenance-email-draft-open-fixes', MAINTENANCE],
    ]);
    for (const [id, href] of links) expect(pageExistsFor(href!), id).toBe(true);
  });

  // Three entries with no link reach every member (the photos, the sign-out
  // and Back). Every other entry names who it reaches, and every linked entry
  // names who can reach its page.
  it('tells three entries to every member and each other entry to whoever can open the page or use the action it names, with an audience on every linked entry', () => {
    const r = release();
    expect(r.audience).toBeUndefined();
    expect(r.entries.filter((e) => e.link && !e.audience).map((e) => e.id)).toEqual([]);
    const itemReaders = { anyPermission: ['items:read'] };
    expect(
      r.entries.map((e) => [e.id, e.category, e.area, e.audience ?? null, e.link ?? null]),
    ).toEqual([
      [
        'manage-order-items',
        'new',
        'Orders',
        { anyPermission: ['orders:manage_catalog_visibility'], modules: ['orders'] },
        { href: MANAGE_ITEMS, label: 'Open Manage order items' },
      ],
      [
        'order-items-hidden-from-place-an-order',
        'new',
        'Orders',
        { anyPermission: ['orders:request'], modules: ['orders'] },
        null,
      ],
      ['photos-no-white-backing', 'fixed', 'Orders, Rentals and Inventory', null, null],
      ['app-location-filter-matches-web', 'fixed', 'Inventory', itemReaders, null],
      [
        'app-emptied-count-box-clears-line',
        'fixed',
        'Cycle counts',
        { anyPermission: ['stock:adjust'], modules: ['cycle_counts'] },
        null,
      ],
      [
        'app-photos-small-copy-and-gif',
        'fixed',
        'Inventory',
        { anyPermission: ['items:update'] },
        null,
      ],
      ['app-sign-out-removes-saved-photos', 'improved', 'Account', null, null],
      ['app-scan-picker-shows-where-stock-is', 'fixed', 'Scan', itemReaders, null],
      [
        'app-proof-and-po-files-open-after-an-hour',
        'fixed',
        'Orders and purchase orders',
        { modules: ['orders', 'purchase_orders'] },
        null,
      ],
      [
        'app-new-rack-question-and-move-stock-note',
        'fixed',
        'Inventory',
        { anyPermission: ['items:create', 'stock:transfer'] },
        null,
      ],
      [
        'maintenance-email-draft-open-fixes',
        'fixed',
        'Maintenance',
        {
          anyPermission: [
            'maintenance_requests:submit',
            'maintenance_requests:read_all',
            'maintenance_requests:manage',
          ],
          modules: ['maintenance_requests'],
        },
        { href: MAINTENANCE, label: 'Open Maintenance' },
      ],
      ['app-back-stays-in-the-app', 'fixed', 'Mobile app', null, null],
    ]);
  });

  it('names in each audience the permission and the module that its page or action checks', () => {
    // The two linked pages.
    expect(page('orders/manage-items/page.tsx')).toContain("checkModuleAccess('orders')");
    const visibility = source('server/services/order-catalog-visibility.ts');
    expect(visibility).toContain("if (!isModuleEnabled(this.ctx, 'orders')) {");
    expect(visibility).toContain('if (!can(this.ctx, ORDER_CATALOG_VISIBILITY_PERMISSION)) {');
    expect(ORDER_CATALOG_VISIBILITY_PERMISSION).toBe('orders:manage_catalog_visibility');
    const maintenance = page('maintenance/page.tsx');
    expect(maintenance).toContain(
      "const access = await checkModuleAccess('maintenance_requests');",
    );
    expect(maintenance).toContain("const canSubmit = can(ctx, 'maintenance_requests:submit');");
    expect(maintenance).toContain(
      "const canReadAll = can(ctx, 'maintenance_requests:read_all') || can(ctx, 'maintenance_requests:manage');",
    );
    // The entries with no link: the page, screen or action each one names.
    const placeOrder = page('orders/new/page.tsx');
    expect(placeOrder).toContain("if (!can(ctx, 'orders:request')) {");
    expect(placeOrder).toContain("const moduleAccess = await checkModuleAccess('orders');");
    const counts = source('server/services/cycle-counts.ts');
    expect(counts).toContain(
      "async clearCount(input: { cycleCountId: string; lineId: string }): Promise<void> {\n    assertModuleEnabled(this.ctx, 'cycle_counts');\n    assertPermission(this.ctx, 'stock:adjust');",
    );
    expect(source('server/services/inventory.ts')).toContain(
      "assertPermission(this.ctx, 'items:create');",
    );
    expect(phone('app/item/[id].tsx')).toContain(
      "const canTransfer = showWriteCtaForRole(role, permissions, 'stock:transfer');",
    );
    expect(repoFile('supabase/migrations/0381_item_images_item_scope.sql')).toContain(
      "or public.has_permission(i.organization_id, 'items:update'))",
    );
    // The Scan tab asks for no permission.
    expect(MODULE_REGISTRY.scan.permissions).toEqual([]);
  });

  it('reaches every member, and a member with no permission is told only the three entries with no audience', () => {
    const shown = (v: ReleaseViewer) =>
      visibleReleases(RELEASES, v)
        .find((r) => r.id === ID)
        ?.entries.map((e) => e.id);
    expect(shown(owner)).toEqual(release().entries.map((e) => e.id));
    expect(shown(member)).toEqual([
      'photos-no-white-backing',
      'app-sign-out-removes-saved-photos',
      'app-back-stays-in-the-app',
    ]);
    // Someone who may place orders is told what a hidden item means for them,
    // and not about Manage order items.
    expect(
      shown({ role: 'viewer', permissions: ['orders:request'], enabledModules: ['orders'] }),
    ).toEqual([
      'order-items-hidden-from-place-an-order',
      'photos-no-white-backing',
      'app-sign-out-removes-saved-photos',
      'app-proof-and-po-files-open-after-an-hour',
      'app-back-stays-in-the-app',
    ]);
  });

  it('is the first notice for every member, and an old phone build shows its title and summary, with Open Manage order items or Open Maintenance for whoever those entries reach', () => {
    for (const v of [owner, member]) {
      expect(buildReleaseList(RELEASES, v, [], null).latestUnread?.id, v.role).toBe(ID);
    }
    expect(legacyAnnouncementsFor(RELEASES, owner, {})[0]).toEqual({
      id: ID,
      date: '2026-10-30',
      title: release().title,
      body: release().summary,
      cta: { href: MANAGE_ITEMS, label: 'Open Manage order items' },
    });
    const submitter: ReleaseViewer = {
      role: 'staff',
      permissions: ['maintenance_requests:submit'],
      enabledModules: ['maintenance_requests'],
    };
    expect(legacyAnnouncementsFor(RELEASES, submitter, {})[0]?.cta).toEqual({
      href: MAINTENANCE,
      label: 'Open Maintenance',
    });
    expect(legacyAnnouncementsFor(RELEASES, member, {})[0]).toEqual({
      id: ID,
      date: '2026-10-30',
      title: release().title,
      body: release().summary,
    });
    // Both buttons open the phone's own screens, so the phone shows them.
    const whatsNew = phone('src/components/onboarding/whats-new.tsx');
    expect(whatsNew).toContain("const showCta = !!cta && rewriteWebPath(cta.href) !== '/';");
    const rewrite = phone('src/lib/web-path-rewrite.ts');
    expect(rewrite).toContain(
      "{ re: /\\/dashboard\\/orders\\/manage-items(\\?.*)?$/, to: () => '/order/manage-items' },",
    );
    expect(rewrite).toContain(
      "{ re: /\\/dashboard\\/maintenance(\\?.*)?$/, to: () => '/maintenance' },",
    );
    expect(registryFingerprint(RELEASES)).toContain(`${ID}@1:published`);
    expect(registryFingerprint(RELEASES)).not.toBe(
      registryFingerprint(RELEASES.filter((r) => r.id !== ID)),
    );
    expect(ANNOUNCEMENTS.map((a) => a.id)).toContain(ID);
  });

  // A phone shows only the title and the summary. Each entry with a part in
  // the mobile app says so and says how to load the update; the web-only one
  // says On the web. No entry promises a store update.
  it('says on the web and in the mobile app, and tells phone readers to load the update, as a phone shows the title and summary', () => {
    const r = release();
    expect(r.summary).toContain(
      'can now choose which items and books appear in Place an order, on the web and in the mobile app;',
    );
    expect(r.summary).toContain(
      'On the web, photos on Place an order and New rental fill their box again.',
    );
    expect(r.summary).toContain('In the mobile app, the Location filter on Items matches the web');
    expect(r.summary).toMatch(/Close the app completely and open it again to load the update\.$/);
    for (const e of r.entries) {
      if (WEB_ONLY.includes(e.id)) {
        expect(e.whatChanged, e.id).toMatch(/^On the web, /);
        expect(`${e.whatChanged} ${e.whatToDo}`, e.id).not.toMatch(/mobile app/i);
        continue;
      }
      expect(e.whatChanged, e.id).toMatch(/in the mobile app/i);
      expect(e.whatToDo, e.id).toMatch(
        /close the app completely and open it again to load the latest update/i,
      );
    }
    expect(words()).not.toMatch(/App Store|TestFlight|Google Play|new version of the app/i);
    // When this shipped, the app opened from closed checked for an update and
    // loaded it then; since B44 it downloads it and asks before it restarts.
    expect(phone('app/_layout.tsx')).toContain('useOtaUpdates();');
    const ota = phone('src/lib/use-ota-updates.ts');
    expect(ota).toContain('await Updates.fetchUpdateAsync();');
    expect(ota).toContain('await Updates.reloadAsync({ reloadScreenOptions: RESTART_SCREEN });');
  });

  it('rests the words it quotes and the claims it makes on the code', () => {
    // Every quotation in the release, so a new one is pinned below too.
    expect([...new Set(words().match(/“[^”]*”/g) ?? [])].sort()).toEqual(
      [
        '“An item no longer listed here”',
        "“Can't be ordered from here anymore. Remove it.”",
        '“Check the counts”',
        '“Could not load the racks and crates to move into. Close this and try again.”',
        '“No download link is available right now. Check your connection and try again.”',
        '“Outlook could not be opened automatically.”',
        '“Rack 1-B does not exist”',
        '“Your email app could not be opened automatically.”',
      ].sort(),
    );
    // Manage order items: its words, its page size and its selection cap.
    expect(ORDER_ITEMS_MANAGE_BUTTON_COPY).toBe('Manage order items');
    expect([ORDER_ITEMS_STATE_SHOWN_COPY, ORDER_ITEMS_STATE_HIDDEN_COPY]).toEqual([
      'Shown in Orders',
      'Hidden from Orders',
    ]);
    expect(ORDER_ITEMS_STATE_EXPECTED_COPY).toBe('Expected');
    expect(ORDER_ITEMS_SEARCH_PLACEHOLDER_COPY).toBe('Search name, SKU, barcode or ISBN');
    expect(ORDER_ITEMS_SELECT_FAMILY_COPY).toBe('Select family');
    expect(ORDER_CATALOG_MANAGE_PAGE_SIZE).toBe(25);
    expect(ORDER_CATALOG_VISIBILITY_MAX_ITEMS).toBe(500);
    const manage = entry('manage-order-items');
    expect(manage.whatChanged).toContain(
      '25 to a page, each marked Shown in Orders or Hidden from Orders',
    );
    expect(manage.whatChanged).toContain('or up to 500 you select at once');
    // The phone's way in from Orders is an icon named for VoiceOver only.
    const ordersList = phone('src/screens/orders.tsx');
    expect(ordersList).toContain('icon={ListChecks}');
    expect(ordersList).toContain('accessibilityLabel={ORDER_ITEMS_MANAGE_BUTTON_COPY}');
    expect(phone('src/components/order-storefront/catalog-screen.tsx')).toContain(
      'label={ORDER_ITEMS_MANAGE_BUTTON_COPY}',
    );
    // A hidden item is offered to nobody for new orders, on the web and in the app.
    expect(source('server/loaders/orders-new-catalog.ts')).toContain(
      "// offered to nobody, a manager included (only Manage order items lists\n      // it). Caller-independent, so it is not part of the scope key.\n      .eq('order_catalog_visible', true)",
    );
    expect(phone('src/components/add-order-items-sheet.tsx')).toContain(
      ".eq('order_catalog_visible', true)",
    );
    expect(STOREFRONT_LINE_NOT_LISTED_COPY).toBe('An item no longer listed here');
    expect(STOREFRONT_LINE_NOT_ORDERABLE_COPY).toBe(
      "Can't be ordered from here anymore. Remove it.",
    );
    // A marked cart line can be lowered only on the web, whose stepper tops
    // out at what the line holds; the mobile app draws no stepper for it, only
    // Remove.
    expect(source('components/orders/storefront/storefront-cart.tsx')).toContain(
      'const ceiling = unorderable\n              ? Math.min(line.quantity,',
    );
    expect(repoFile('packages/core/src/orders/storefront/stale-cart.ts')).toContain(
      'stepper: item !== undefined && !unorderable,',
    );
    expect(phone('src/components/order-storefront/cart-panel.tsx')).toContain('{view.stepper ? (');
    expect(entry('order-items-hidden-from-place-an-order').howItAffectsYou).toContain(
      'You can remove that line, or lower it on the web, but not raise it,',
    );
    // Photos: Place an order fills its box; the Grid still shows a photo whole,
    // with no white tile behind it. If the Grid is changed to fill its square,
    // reword photos-no-white-backing in place.
    expect(source('components/orders/storefront/storefront.css')).toContain(
      '.sp-storefront .sf-ph img {\n  position: absolute;\n  inset: 0;\n  width: 100%;\n  height: 100%;\n  object-fit: cover;\n  display: block;\n}',
    );
    const table = source('components/inventory/inventory-table.tsx');
    expect(table).toContain("style={{ objectFit: 'contain' }}");
    expect(table).toContain('className="h-full w-full object-contain"');
    expect(source('components/patterns/grid-card.tsx')).toContain(
      'className="border-border relative aspect-square w-full shrink-0 overflow-hidden border-b"',
    );
    expect(entry('photos-no-white-backing').whatChanged).toContain(
      'a photo that is not square is still shown whole',
    );
    // The card's colour is a pale off-white in light mode, and hovering over a
    // Grid photo still shows its preview on white.
    expect(source('app/globals.css')).toContain('--background: 60 23.1% 97.5%;');
    expect(table).toContain(
      'if (failedSrc === thumbSrc) return <MissingPhoto className="absolute inset-0" />;\n  return (\n    <ImageHoverPreview',
    );
    expect(source('components/ui/image-hover-preview.tsx')).toContain(
      'className="block h-[280px] w-full bg-white object-contain"',
    );
    expect(entry('photos-no-white-backing').howItAffectsYou).toContain(
      'a pale off-white in light mode. Hovering over a Grid photo still shows its preview on white.',
    );
    // The mobile app's Location filter reads each item's Location.
    expect(phone('app/(drawer)/(tabs)/inventory.tsx')).toContain(
      "r = r.in('primary_location_id', f.locationIds);",
    );
    // An emptied count box clears the line; the AI shelf scan review keeps a typed decimal.
    expect(phone('app/cycle-count/[id].tsx')).toContain(
      'const cleared = await clearLocalLine(lineId);',
    );
    expect(phone('app/cycle-count/[id].tsx')).toContain(
      "Alert.alert('Check the counts', notACountMessage(notCounts.map((l) => l.itemName)));",
    );
    expect(phone('app/cycle-count/ai-scan/[id].tsx')).toContain(
      'if (rl.override !== null) return countFromText(rl.override);',
    );
    // A GIF from the library is saved as a JPEG.
    const upload = phone('src/lib/item-photo-upload.ts');
    expect(upload).toContain(
      "export const ITEM_PHOTO_UPLOAD_EXTENSIONS: readonly string[] = ['jpg', 'png', 'webp'];",
    );
    expect(upload).toContain('format: ImageManipulator.SaveFormat.JPEG,');
    // Signing out removes the photos the app kept.
    expect(phone('src/lib/auth-context.tsx')).toContain(
      'wipeCache: () => wipeWithPhotoCaches(wipeForSignOut),',
    );
    // Multiple placements found says where each record's stock is.
    expect(phone('app/(drawer)/(tabs)/scan.tsx')).toContain(
      "{c.placementLabel ?? 'No bin set'} · {c.quantityOnHand} on hand",
    );
    // A file's link lasts an hour and is signed again when it is about to run out.
    expect(phone('src/lib/stored-file-link.ts')).toContain(
      'export const STORED_FILE_LINK_SECONDS = 60 * 60;',
    );
    for (const rel of ['src/components/po-attachments.tsx', 'app/order/[id].tsx']) {
      expect(phone(rel), rel).toContain(
        "'No download link is available right now. Check your connection and try again.',",
      );
    }
    // A purchase order file with no new link says so; an order's photo falls
    // back to the link the screen holds and the copy on the phone, so there
    // only a file that is not a photo, or a photo with no link at all, says so.
    expect(phone('src/components/po-attachments.tsx')).toContain(
      'if (!link) {\n      // Signing failed (offline, or a storage-RLS denial): say so instead of',
    );
    expect(phone('app/order/[id].tsx')).toContain(
      'const url = link?.url ?? (isImage ? a.url : null);\n    if (!url) {',
    );
    expect(entry('app-proof-and-po-files-open-after-an-hour').howItAffectsYou).toContain(
      'a purchase order file, or a proof of delivery file that is not a photo, does not open',
    );
    // The new-rack question and the Move stock note.
    expect(repoFile('packages/core/src/inventory/rack-near-match.ts')).toContain(
      "title = `${noun === 'crate' ? 'Crate' : 'Rack'} ${label} does not exist`;",
    );
    expect(phone('app/item/new.tsx')).toContain(
      "text: check.kind === 'new' && check.createsRack ? 'Create rack and save' : 'Save anyway',",
    );
    expect(phone('src/lib/move-stock-form.ts')).toContain(
      "'Could not load the racks and crates to move into. Close this and try again.';",
    );
    // The maintenance email: the blocked web tab is not recorded, and the
    // mobile app names the app it tried.
    const webAction = source('components/maintenance/maintenance-email-action.tsx');
    expect(webAction).toContain(
      "const BLOCKED_HEADLINE = 'Outlook could not be opened automatically.';",
    );
    expect(webAction).toContain(
      '// NOT RECORDED (B29): recordMaintenanceDraftOpenedAction used to run here,',
    );
    const phoneActions = phone('src/lib/maintenance-email-actions.ts');
    expect(phoneActions).toContain(
      "export const MAIL_APP_BLOCKED_HEADLINE = 'Your email app could not be opened automatically.';",
    );
    expect(phoneActions).toContain(
      "return attempted === 'default-mail' ? MAIL_APP_BLOCKED_HEADLINE : BLOCKED_HEADLINE;",
    );
    // Back goes only to a place inside the app.
    expect(phone('src/lib/return-path.ts')).toContain(
      "if (router.canGoBack()) router.back();\n  else router.replace('/');",
    );
  });

  it('uses plain words: no claim StockPilot cannot stand behind, never "book" for a quantity, no percentages, no speed nobody measured and nothing only platform staff see', () => {
    const text = words();
    for (const phrase of FORBIDDEN) {
      expect(text.toLowerCase(), phrase).not.toContain(phrase);
    }
    expect(text).not.toMatch(
      /\bthe book\b|\bbook (count|quantity|stock|level)s?\b|\bbooked\b|\bon the books\b/i,
    );
    expect(text).not.toContain('%');
    expect(text).not.toContain('!');
    expect(text).not.toMatch(/\bfaster\b|\bquicker\b|\bspeed\b|\binstant|\bloads? sooner\b/i);
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
    // Nothing says StockPilot sent an email or told someone.
    expect(text).not.toMatch(
      /\bwe (sent|emailed|notified)\b|\bStockPilot (sent|emailed|notified)\b/i,
    );
    // The platform console that sets a per-person exception is never described.
    expect(text).not.toMatch(/platform console|God Admin|step-up|compare-and-set/i);
    expect(entry('manage-order-items').whatToDo).toContain(
      'to change that for one person, ask StockPilot support.',
    );
  });
});

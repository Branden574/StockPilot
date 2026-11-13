import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  MODULE_REGISTRY,
  ORDER_MAX_UNITS,
  ORDER_MAX_UNITS_PER_LINE,
  PERMISSIONS,
  addAllButtonCopy,
  addAllState,
  type ModuleId,
  type Release,
  type ReleaseViewer,
} from '@stockpilot/core';

import {
  buildReleaseList,
  legacyAnnouncementsFor,
  registryFingerprint,
  visibleReleases,
} from './logic';
import { RELEASES } from './registry';

/**
 * Added by feat/order-add-all (2026-11-10): the Add all release, published at
 * the top, above the count sheet release, in the pull request that ships the
 * button (PUBLISHING.md step 5). A release is announced by the deployment
 * that holds it, so it is never announced before the button is live.
 *
 * On the website, Place an order has an Add all button on each item and book
 * with 2 or more available: one press sets the cart line to everything
 * available. The phone's code is in the same pull request and reaches phones
 * with the next phone update, so the words say "on the website" and that the
 * mobile app gets it with its next update.
 *
 * Its own file, so the release tests other open branches edit stay as they
 * are. These tests pin the release's id, status, revision, date and order,
 * who its entry reaches, and the code its words rest on.
 */
const ID = 'order-add-all-2026-11';
const ENTRY_ID = 'order-add-all';
const COUNT_SHEET_ID = 'count-sheet-long-names-2026-11';
// Added by docs/whats-new-2026-11-13 (2026-11-13): the Release count, AI Assistant and not found
// releases, published later, at the top, read. Each reaches an owner with every permission
// and module or nobody here, so a test that expects an older notice reads or sees them first, and
// the notice it checks is the one it checked before.
const NEWER_IDS_1113 = [
  // Re-pinned by docs/whatsnew-emailed-links-1113 (2026-11-13; was: without it): the emailed links release is published later, at the top, and reaches every member (it has no audience), so it is read, seen or listed with the newer releases, and every notice this test checks is the one it checked before.
  'emailed-links-name-their-account-2026-11',
  'cycle-count-already-released-2026-11',
  'ai-assistant-plain-words-2026-11',
  'changes-that-did-not-happen-2026-11',
];
const NEWER_READS = NEWER_IDS_1113.map((id) => ({
  release_id: id,
  revision: 1,
  dismissed_at: null,
  opened_at: '2026-11-13T08:18:00Z',
  read_at: '2026-11-13T08:18:00Z',
}));
const release = () => RELEASES.find((r) => r.id === ID)!;
const entry = () => release().entries.find((e) => e.id === ENTRY_ID)!;

const ORDERS: ModuleId[] = ['orders'];
const everyone: ReleaseViewer = {
  role: 'owner',
  permissions: [...PERMISSIONS],
  enabledModules: Object.keys(MODULE_REGISTRY) as ModuleId[],
};
/** A member who holds no permission and no module. */
const member: ReleaseViewer = { role: 'viewer', permissions: [], enabledModules: [] };
/** Staff who place orders, where Orders is on. */
const requester: ReleaseViewer = {
  role: 'staff',
  permissions: ['orders:request'],
  enabledModules: ORDERS,
};
/** Someone who may place orders, where Orders is off. */
const ordersOff: ReleaseViewer = {
  role: 'staff',
  permissions: ['orders:request'],
  enabledModules: [],
};
/** Orders on, but an approver who does not place orders. */
const approverOnly: ReleaseViewer = {
  role: 'staff',
  permissions: ['orders:approve'],
  enabledModules: ORDERS,
};

/** A source file under apps/web/src, as written. */
const source = (rel: string) => readFileSync(resolve(__dirname, '../..', rel), 'utf8');

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

const told = (v: ReleaseViewer) =>
  visibleReleases(RELEASES, v)
    .find((r) => r.id === ID)
    ?.entries.map((e) => e.id);

describe('the Add all release: order, status and date', () => {
  // Renamed when main was merged into feat/liquid-glass after #493 and #494 (2026-11-10; was: "is published once, as revision 1, at the top, above the count sheet release, and no draft is left"): the Liquid Glass release is held as a draft at the top until G5. Claim kept: it is the newest published release, and no other draft is left.
  // Renamed by docs/whatsnew-returns-1112 (2026-11-12; was: "is published once, as revision 1, directly below the Liquid Glass draft at the top, above the count sheet release, and no draft but the Liquid Glass release is left"): the returns request and names release is published later, between the Liquid Glass draft and this one. Claim kept: published once, at revision 1, above the count sheet release, and no other draft is left.
  it('is published once, as revision 1, below the Liquid Glass draft and the returns request and names release at the top, above the count sheet release, and no draft but the Liquid Glass release is left', () => {
    expect(RELEASES.filter((r) => r.id === ID)).toHaveLength(1);
    expect(release().status).toBe('published');
    expect(release().revision).toBe(1);
    expect(release().withdrawnNote).toBeUndefined();
    // Re-pinned when main was merged into feat/liquid-glass after #493 and #494 (2026-11-10; was: every pinned position one place higher, and no draft): the Liquid Glass release is held as a draft at the top until G5, so every position below it moves down by one and it is the one draft.
    // Re-pinned by docs/whatsnew-returns-1112 (2026-11-12; was: every pinned position one place higher): the returns request and names release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whatsnew-phone-1112 (2026-11-12; was: every pinned position one place higher): the phone appearance and returns release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-2026-11-13 (2026-11-13; was: every pinned position three places higher): the Release count, AI Assistant and not found releases are published at the top, below the Liquid Glass draft, so every position below it moves down by three.
    // Re-pinned by docs/whatsnew-emailed-links-1113 (2026-11-13; was: every pinned position one place higher): the emailed links release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    expect(RELEASES[7]?.id).toBe(ID);
    expect(RELEASES[8]?.id).toBe(COUNT_SHEET_ID);
    // Re-pinned by docs/whatsnew-returns-1112 (2026-11-12; was: ID, the newest published): the returns request and names release is published later, directly above this one.
    // Re-pinned by docs/whats-new-2026-11-13 (2026-11-13; was: every pinned position three places higher): the Release count, AI Assistant and not found releases are published at the top, below the Liquid Glass draft, so every position below it moves down by three.
    // Re-pinned by docs/whatsnew-emailed-links-1113 (2026-11-13; was: every pinned position one place higher): the emailed links release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    expect(RELEASES[6]?.id).toBe('returns-request-email-names-2026-11');
    expect(RELEASES.find((r) => r.status === 'published')?.id).toBe(
      // Re-pinned by docs/whatsnew-phone-1112 (2026-11-12; was: the returns request and names release, the newest published): the phone appearance and returns release is published later, at the top, directly below the Liquid Glass draft.
      // Re-pinned by docs/whats-new-2026-11-13 (2026-11-13; was: the phone appearance and returns release): the Release count release is published after it, at the top, the newest published release.
      // Re-pinned by docs/whatsnew-emailed-links-1113 (2026-11-13; was: the Release count release): the emailed links release is published after it, at the top, the newest published release.
      'emailed-links-name-their-account-2026-11',
    );
    expect(RELEASES.filter((r) => r.status === 'draft').map((r) => r.id)).toEqual([
      'liquid-glass-2026-11',
    ]);
    // Permanent, unused anywhere else, and ends in the month it went out.
    expect(ID).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*-2026-11$/);
    expect(RELEASES.flatMap((r) => r.entries).filter((e) => e.id === ENTRY_ID)).toHaveLength(1);
    expect(RELEASES.some((r) => r.id === ENTRY_ID)).toBe(false);
  });

  it('is dated in the past on a whole minute, and after every release below it', () => {
    const at = Date.parse(release().publishedAt);
    expect(release().publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/);
    expect(at).toBeLessThanOrEqual(Date.now());
    // Re-pinned when main was merged into feat/liquid-glass after #493 and #494 (2026-11-10; was: every pinned position one place higher, and no draft): the Liquid Glass release is held as a draft at the top until G5, so every position below it moves down by one and it is the one draft.
    // Re-pinned by docs/whatsnew-returns-1112 (2026-11-12; was: every pinned position one place higher): the returns request and names release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whatsnew-phone-1112 (2026-11-12; was: every pinned position one place higher): the phone appearance and returns release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-2026-11-13 (2026-11-13; was: every pinned position three places higher): the Release count, AI Assistant and not found releases are published at the top, below the Liquid Glass draft, so every position below it moves down by three.
    // Re-pinned by docs/whatsnew-emailed-links-1113 (2026-11-13; was: every pinned position one place higher): the emailed links release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    for (const r of RELEASES.slice(8)) {
      expect(at, r.id).toBeGreaterThan(Date.parse(r.publishedAt));
    }
  });

  it('is in the fingerprint, so publishing it changes what clients observe', () => {
    expect(registryFingerprint(RELEASES)).toContain(`${ID}@1:published`);
  });
});

describe('the Add all release: what it says', () => {
  it('has one entry that answers the four questions, linked to Place an order, with no draft words', () => {
    expect(release().entries.map((e) => e.id)).toEqual([ENTRY_ID]);
    expect(release().audience).toBeUndefined();
    const e = entry();
    expect([e.category, e.area]).toEqual(['new', 'Orders']);
    expect(e.link).toEqual({ href: '/dashboard/orders/new', label: 'Place an order' });
    for (const answer of [e.whatChanged, e.whyItMatters, e.howItAffectsYou]) {
      expect(answer.length).toBeGreaterThan(0);
    }
    expect(e.whatToDo).toBe('No action needed.');
    const text = readerText(release()).join(' ');
    // "book" is the product here ("each item and book"), never a quantity.
    expect(text).not.toMatch(/\bbook(ed)? (qty|quantity|quantities|value|count)\b|\bbooked\b/i);
    expect(text).not.toMatch(/!|%|guarantee|verified|instantly|faster|seamless|one click/i);
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(text).not.toMatch(/\bemail(ed)?\b|\bnotif(y|ied)\b/i);
    expect(text).not.toMatch(/react|aria-|#\d+|\bbug\b|SfAddControl/i);
    expect(text).not.toMatch(/\bnever\b|\balways\b/i);
  });

  it('says where it is: on the website now, in the mobile app with its next update', () => {
    const summary = release().summary;
    // Old phone builds show only the title and the summary, so the summary
    // itself says the phone does not have the button yet.
    expect(summary).toMatch(/^On the website, Place an order now has an Add all button /);
    expect(summary).toMatch(/The mobile app gets the button with its next update\.$/);
    expect(entry().whatChanged).toMatch(/^On the website, in Place an order, /);
    expect(entry().howItAffectsYou).toContain(
      'The mobile app does not have the button yet; it comes with the app’s next update.',
    );
    // Nothing tells a phone to restart for it: no phone update carries it yet.
    expect(readerText(release()).join(' ')).not.toMatch(/Restart now|Update ready|close the app/i);
  });

  it('says what a press does: everything available, set and not added on top', () => {
    const e = entry();
    expect(e.whatChanged).toContain('each item and book with 2 or more available');
    expect(e.whatChanged).toContain('on the cards, in Compact view and in Quick view');
    expect(e.whatChanged).toContain('sets that item in your cart to everything available');
    expect(e.whatChanged).toContain('it does not add on top');
    expect(e.howItAffectsYou).toContain('dimmed once everything available is in your cart');
    expect(e.howItAffectsYou).toContain('Stock is held when the order is approved, as before.');
  });
});

describe('the Add all release: who is told', () => {
  it('reaches whoever may place orders where Orders is on, and nobody else', () => {
    expect(entry().audience).toEqual({ anyPermission: ['orders:request'], modules: ['orders'] });
    for (const v of [everyone, requester]) {
      expect(told(v), v.role).toEqual([ENTRY_ID]);
    }
    for (const [name, v] of [
      ['member', member],
      ['ordersOff', ordersOff],
      ['approverOnly', approverOnly],
    ] as const) {
      expect(told(v), name).toBeUndefined();
    }
  });

  it('is the first notice for whoever it reaches, and a member it does not reach keeps their notice', () => {
    // Re-pinned by docs/whats-new-2026-11-13 (2026-11-13; was: without them): the Release count, AI Assistant and not found releases are published later, at the top; an owner with every permission and module reads them first (NEWER_READS), and every notice this test checks is the one it checked before.
    // Re-pinned by docs/whatsnew-returns-1112 (2026-11-12; was: nothing read or seen): the returns request and names release is published later, at the top, and reaches an owner with every permission and module, so it is read or seen here first. It does not reach the requester here, where Returns is off, so its read changes nothing for them.
    const returnsRead = {
      release_id: 'returns-request-email-names-2026-11',
      revision: 1,
      dismissed_at: null,
      opened_at: '2026-11-12T09:00:00Z',
      read_at: '2026-11-12T09:00:00Z',
    };
    // Re-pinned by docs/whatsnew-phone-1112 (2026-11-12; was: the returns request and names release first for an owner with nothing read, and only its read or seen stamp below): the phone appearance and returns release is published later, at the top, and reaches every member, so it is every reader's first notice here and is read or seen with the returns release; for the requester here, whom the returns release does not reach, that read changes nothing.
    const phoneRead = { ...returnsRead, release_id: 'phone-appearance-returns-2026-11' };
    for (const v of [everyone, requester, member]) {
      expect(buildReleaseList(RELEASES, v, NEWER_READS, null).latestUnread?.id, v.role).toBe(
        'phone-appearance-returns-2026-11',
      );
    }
    expect(
      buildReleaseList(RELEASES, everyone, [...NEWER_READS, phoneRead], null).latestUnread?.id,
    ).toBe('returns-request-email-names-2026-11');
    for (const v of [everyone, requester]) {
      expect(
        buildReleaseList(RELEASES, v, [...NEWER_READS, phoneRead, returnsRead], null).latestUnread
          ?.id,
        v.role,
      ).toBe(ID);
      expect(
        legacyAnnouncementsFor(RELEASES, v, {
          // Re-pinned by docs/whats-new-2026-11-13 (2026-11-13; was: without them): the Release count, AI Assistant and not found releases are published later, at the top, and reach an owner with every permission and module, so they are read, seen or listed with the newer releases, and every notice this test checks is the one it checked before.
          // Re-pinned by docs/whatsnew-emailed-links-1113 (2026-11-13; was: without it): the emailed links release is published later, at the top, and reaches every member (it has no audience), so it is read, seen or listed with the newer releases, and every notice this test checks is the one it checked before.
          'emailed-links-name-their-account-2026-11': true,
          'cycle-count-already-released-2026-11': true,
          'ai-assistant-plain-words-2026-11': true,
          'changes-that-did-not-happen-2026-11': true,
          'phone-appearance-returns-2026-11': true,
          'returns-request-email-names-2026-11': true,
        })[0],
        v.role,
      ).toEqual({
        id: ID,
        date: release().publishedAt.slice(0, 10),
        title: release().title,
        body: release().summary,
        cta: { href: '/dashboard/orders/new', label: 'Place an order' },
      });
    }
    expect(
      buildReleaseList(RELEASES, member, [...NEWER_READS, phoneRead], null).latestUnread?.id,
    ).not.toBe(ID);
    expect(legacyAnnouncementsFor(RELEASES, member, {}).map((a) => a.id)).not.toContain(ID);
  });
});

describe('the Add all release: the code its words rest on', () => {
  const cards = () => source('components/orders/storefront/storefront-cards.tsx');

  it('the button is on the cards, in Compact view and in Quick view, through one control', () => {
    expect(cards().split('<SfAddControl').length - 1).toBe(2);
    expect(
      source('components/orders/storefront/storefront-overlays.tsx').split('<SfAddControl').length -
        1,
    ).toBe(1);
    const page = source('components/orders/storefront/orders-storefront.tsx');
    expect(page).toContain('title="Compact view"');
    expect(cards()).toContain('title="Quick view"');
  });

  it('is drawn from 2 available up, and a press sets the line to the shared target', () => {
    expect(addAllState(1, 0)).toBe('hidden');
    expect(addAllState(2, 0)).toBe('offer');
    expect(addAllState(67, 67)).toBe('full');
    expect(cards()).toContain("if (state === 'hidden') return main;");
    expect(cards()).toContain('onSetQty(item.id, addAllTarget(available))');
    expect(cards()).toContain('aria-disabled={full || undefined}');
  });

  it('says Add 10,000 above the most one order can hold, the number the server refuses above', () => {
    expect(ORDER_MAX_UNITS_PER_LINE).toBe(10_000);
    expect(ORDER_MAX_UNITS).toBe(10_000);
    expect(addAllButtonCopy(ORDER_MAX_UNITS_PER_LINE + 1)).toBe('Add 10,000');
    expect(addAllButtonCopy(ORDER_MAX_UNITS_PER_LINE)).toBe('Add all');
    expect(entry().whatChanged).toContain(
      'An item with more than 10,000 available shows Add 10,000 in its place, the most one order can hold.',
    );
  });

  it('names the page and the buttons as the page shows them', () => {
    const copy = readFileSync(
      resolve(__dirname, '../../../../../packages/core/src/orders/storefront/copy.ts'),
      'utf8',
    );
    expect(copy).toContain("export const STOREFRONT_TITLE_COPY = 'Place an order';");
    expect(cards()).toContain('<Plus size={13} /> Add to cart');
  });

  it('is told to the people the page lets in', () => {
    const page = source('app/(dashboard)/dashboard/orders/new/page.tsx');
    expect(page).toContain("if (!can(ctx, 'orders:request')) {");
    expect(page).toContain("checkModuleAccess('orders')");
  });

  it('the phone part is in the same change, so the next phone update carries it', () => {
    const mobile = (rel: string) =>
      readFileSync(resolve(__dirname, '../../../../mobile/src', rel), 'utf8');
    expect(mobile('components/order-storefront/sheets.tsx')).toContain(
      'onPress={() => onSave(addAllTarget(available))}',
    );
    expect(mobile('components/order-storefront/catalog-screen.tsx')).toContain(
      'const target = addAllTarget(availableOf(sheetItem));',
    );
  });
});

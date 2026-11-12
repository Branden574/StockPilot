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

import {
  buildReleaseList,
  legacyAnnouncementsFor,
  registryFingerprint,
  visibleReleases,
} from './logic';
import { RELEASES } from './registry';

/**
 * Added by docs/whats-new-count-sheet-long-names (2026-11-10): the count sheet
 * release, published at the top, above the S2 release.
 *
 * #492 (squash 80c3bf114; web only, live since 2026-11-10 19:41Z): on the
 * printed cycle count sheet and variance report a long item name wraps inside
 * its own column, and a row is kept whole across a page break. Keeping rows
 * whole also fixed a sheet of one-line rows that ran past its first page: it
 * printed row 1 on page 1 and left the rest of that page's rows out, 25 of
 * them with no note on the count, one or two fewer with a note, and none on
 * a sheet grouped by product
 * (lib/pdf/cycle-count.rows-across-pages.render.test.tsx renders it).
 *
 * Its own file, so the release tests other open branches edit stay as they
 * are. These tests pin the release's id, status, revision, date and order,
 * who its entry reaches, and the code its words rest on.
 */
const ID = 'count-sheet-long-names-2026-11';
const ENTRY_ID = 'count-sheet-long-names';
const S2_ID = 'approver-controls-own-warehouses-2026-11';
// Added by feat/order-add-all (2026-11-10): the Add all release, published later, at the top,
// above this one. It reaches whoever may place orders where Orders is on.
const ADD_ALL_ID = 'order-add-all-2026-11';
// Added by docs/whatsnew-returns-1112 (2026-11-12): the returns request and names release, published at the top, above the Add all release.
const RETURNS_REQUEST_ID = 'returns-request-email-names-2026-11';
// Added by docs/whatsnew-phone-1112 (2026-11-12): the phone appearance and returns release,
// published at the top, below the Liquid Glass draft and above the returns request and names
// release. It reaches every member: its Appearance entry has no audience.
const PHONE_APPEARANCE_ID = 'phone-appearance-returns-2026-11';
const release = () => RELEASES.find((r) => r.id === ID)!;
const entry = () => release().entries.find((e) => e.id === ENTRY_ID)!;

const COUNTS: ModuleId[] = ['cycle_counts'];
const everyone: ReleaseViewer = {
  role: 'owner',
  permissions: [...PERMISSIONS],
  enabledModules: Object.keys(MODULE_REGISTRY) as ModuleId[],
};
/** A member who holds no permission and no module. */
const member: ReleaseViewer = { role: 'viewer', permissions: [], enabledModules: [] };
/** A viewer granted the read-only look at counts. */
const countReader: ReleaseViewer = {
  role: 'viewer',
  permissions: ['cycle_counts:read'],
  enabledModules: COUNTS,
};
/** Staff who adjust stock, the PDF route's second way in. */
const stockAdjuster: ReleaseViewer = {
  role: 'staff',
  permissions: ['stock:adjust'],
  enabledModules: COUNTS,
};
/** Someone who could open the PDF, where Cycle Counts is off. */
const countsOff: ReleaseViewer = {
  role: 'manager',
  permissions: ['cycle_counts:read', 'stock:adjust'],
  enabledModules: [],
};
/** Cycle Counts on, but neither permission. */
const noCountPermission: ReleaseViewer = {
  role: 'staff',
  permissions: ['items:read'],
  enabledModules: COUNTS,
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

describe('the count sheet release: order, status and date', () => {
  // Renamed when main was merged into feat/liquid-glass after #493 and #494 (2026-11-10; was: "is published once, as revision 1, at the top, above the S2 release, and no draft is left"): the Liquid Glass release is held as a draft at the top until G5. Claim kept: no other draft is left.
  it('is published once, as revision 1, near the top (below the Liquid Glass draft and the Add all release), above the S2 release, and no draft but the Liquid Glass release is left', () => {
    expect(RELEASES.filter((r) => r.id === ID)).toHaveLength(1);
    expect(release().status).toBe('published');
    expect(release().revision).toBe(1);
    expect(release().withdrawnNote).toBeUndefined();
    // Re-pinned by feat/order-add-all (2026-11-10; was: every pinned position one place higher): the Add all release is published at the top, so every position below it moves down by one.
    // Re-pinned when main was merged into feat/liquid-glass after #493 and #494 (2026-11-10; was: every pinned position one place higher, and no draft): the Liquid Glass release is held as a draft at the top until G5, so every position below it moves down by one and it is the one draft.
    // Re-pinned by docs/whatsnew-returns-1112 (2026-11-12; was: every pinned position one place higher): the returns request and names release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whatsnew-phone-1112 (2026-11-12; was: every pinned position one place higher): the phone appearance and returns release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    expect(RELEASES[4]?.id).toBe(ID);
    expect(RELEASES[5]?.id).toBe(S2_ID);
    // Re-pinned by feat/order-add-all (2026-11-10; was: this release at 0, the newest published): the Add all release is published later, at the top.
    // Re-pinned when main was merged into feat/liquid-glass after #493 and #494 (2026-11-10; was: every pinned position one place higher, and no draft): the Liquid Glass release is held as a draft at the top until G5, so every position below it moves down by one and it is the one draft.
    expect(RELEASES[3]?.id).toBe(ADD_ALL_ID);
    // Re-pinned by docs/whatsnew-returns-1112 (2026-11-12; was: ADD_ALL_ID, the newest published): the returns request and names release is published later, at the top, directly above the Add all release.
    expect(RELEASES[2]?.id).toBe(RETURNS_REQUEST_ID);
    // Re-pinned by docs/whatsnew-phone-1112 (2026-11-12; was: the returns request and names release, the newest published): the phone appearance and returns release is published later, at the top, directly below the Liquid Glass draft.
    expect(RELEASES.find((r) => r.status === 'published')?.id).toBe(
      'phone-appearance-returns-2026-11',
    );
    expect(RELEASES.filter((r) => r.status === 'draft').map((r) => r.id)).toEqual([
      'liquid-glass-2026-11',
    ]);
    // Permanent, unused anywhere else, and ends in the month it went out.
    expect(ID).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*-2026-11$/);
    expect(RELEASES.flatMap((r) => r.entries).filter((e) => e.id === ENTRY_ID)).toHaveLength(1);
    expect(RELEASES.some((r) => r.id === ENTRY_ID)).toBe(false);
  });

  it('is dated in the past on a whole minute, after the fix went live, and after every release below it', () => {
    const at = Date.parse(release().publishedAt);
    expect(release().publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/);
    expect(at).toBeLessThanOrEqual(Date.now());
    // #492 was live on production from 19:41Z on 2026-11-10.
    expect(at).toBeGreaterThan(Date.parse('2026-11-10T19:41:00Z'));
    // Re-pinned by feat/order-add-all (2026-11-10; was: every pinned position one place higher): the Add all release is published at the top, so every position below it moves down by one.
    // Re-pinned when main was merged into feat/liquid-glass after #493 and #494 (2026-11-10; was: every pinned position one place higher, and no draft): the Liquid Glass release is held as a draft at the top until G5, so every position below it moves down by one and it is the one draft.
    // Re-pinned by docs/whatsnew-returns-1112 (2026-11-12; was: every pinned position one place higher): the returns request and names release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whatsnew-phone-1112 (2026-11-12; was: every pinned position one place higher): the phone appearance and returns release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    for (const r of RELEASES.slice(5)) {
      expect(at, r.id).toBeGreaterThan(Date.parse(r.publishedAt));
    }
  });

  it('is in the fingerprint, so publishing it changes what clients observe', () => {
    expect(registryFingerprint(RELEASES)).toContain(`${ID}@1:published`);
  });
});

describe('the count sheet release: what it says', () => {
  it('has one entry that answers the four questions, linked to Cycle counts, with no draft words', () => {
    expect(release().entries.map((e) => e.id)).toEqual([ENTRY_ID]);
    expect(release().audience).toBeUndefined();
    const e = entry();
    expect([e.category, e.area]).toEqual(['fixed', 'Cycle counts']);
    expect(e.link).toEqual({ href: '/dashboard/cycle-counts', label: 'Open Cycle counts' });
    for (const answer of [e.whatChanged, e.whyItMatters, e.howItAffectsYou]) {
      expect(answer.length).toBeGreaterThan(0);
    }
    expect(e.whatToDo).toMatch(/^No action needed\. Print the sheet again if /);
    const text = readerText(release()).join(' ');
    expect(text).not.toMatch(/\bbook(ed)?\b/i);
    expect(text).not.toMatch(/!|%|guarantee|verified|instantly|faster|seamless/i);
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(text).not.toMatch(/\bemail(ed)?\b|\bnotif(y|ied)\b/i);
    expect(text).not.toMatch(/react|wrap=|#\d+|\bbug\b/i);
  });

  it('has a summary that stands on its own for an old phone build: the long names and the missing items', () => {
    const summary = release().summary;
    expect(summary).toMatch(
      /^On a printed cycle count sheet or variance report, a long item name /,
    );
    expect(summary).toContain('those items now print');
    // Web only: nothing to load in the mobile app.
    expect(readerText(release()).join(' ')).not.toMatch(/mobile app|Restart now|Update ready/);
  });

  it('says of the missing items only what the reproduction showed, and does not say never', () => {
    // On the component as it was before #492, a sheet or variance report of
    // one-line rows that ran past its first page printed row 1 on page 1 and
    // left out the rest of that page's rows: rows 2 to 26 (25 rows) with no
    // note on the count, 2 to 25 with a one-line note, 2 to 24 with a
    // three-line note. Sheets of 27, 30 and 41 one-line rows in product
    // groups of 6 lost none. So the words give no exact row count.
    for (const text of [release().summary, entry().whatChanged]) {
      expect(text).toContain('longer than one page, not grouped by product, where');
      expect(text).toMatch(
        /where every item on the first page took (a single|one) line, could print/,
      );
      expect(text).toMatch(
        /only the first item on page 1 and leave out the rest of that page(’s items \(about 25\)| \(about 25 items\)); (those items|they) now print\.$/,
      );
    }
    expect(entry().whyItMatters).toContain('about 25 items could be missing from the paper');
    expect(entry().whatChanged.length).toBeLessThanOrEqual(600);
    const text = readerText(release()).join(' ');
    expect(text.replaceAll('about 25', '')).not.toMatch(/\b2[3-7]\b/);
    expect(text).not.toMatch(/27 or more|first 26|25 after it|next 25/);
    // A count over 10,000 lines is cut at PDF_MAX_LINES with a banner, so
    // nothing here says every item of a count prints.
    expect(text).not.toMatch(
      /every item (now )?prints|every item of the count|no item is left out|\ball items\b/i,
    );
    expect(source('lib/pdf/count-sheet-cap.ts')).toContain('export const PDF_MAX_LINES = 10_000;');
    expect(entry().whatToDo).toContain('or one whose first page showed a single item');
    // A row over 400 characters may still split, so the entry says "unless".
    expect(entry().whatChanged).toContain('kept on one page unless it is extremely long');
    expect(readerText(release()).join(' ')).not.toMatch(/\bnever\b|\balways\b/i);
  });
});

describe('the count sheet release: who is told', () => {
  it('reaches whoever can open the PDF where Cycle Counts is on, and nobody else', () => {
    expect(entry().audience).toEqual({
      anyPermission: ['cycle_counts:read', 'stock:adjust'],
      modules: ['cycle_counts'],
    });
    for (const v of [everyone, countReader, stockAdjuster]) {
      expect(told(v), v.role).toEqual([ENTRY_ID]);
    }
    for (const [name, v] of [
      ['member', member],
      ['countsOff', countsOff],
      ['noCountPermission', noCountPermission],
    ] as const) {
      expect(told(v), name).toBeUndefined();
    }
  });

  it('is the first notice for whoever it reaches, and a member it does not reach keeps their notice', () => {
    // Re-pinned by feat/order-add-all (2026-11-10; was: nothing read or seen): the Add all release is published later, at the top, and reaches an owner with every permission and module, so the owner is told it first and this one once it is read or seen. It reaches neither the count reader nor the stock adjuster here, who do not place orders, so its read changes nothing for them.
    const addAllRead = {
      release_id: ADD_ALL_ID,
      revision: 1,
      dismissed_at: null,
      opened_at: '2026-11-10T22:00:00Z',
      read_at: '2026-11-10T22:00:00Z',
    };
    // Re-pinned by docs/whatsnew-returns-1112 (2026-11-12; was: the Add all release first for an owner, and only its read or seen stamp below): the returns request and names release is published later, at the top, and reaches an owner with every permission and module, so it is the owner's first notice and is read or seen with the Add all release; for a reader it does not reach, its read changes nothing.
    const returnsRead = { ...addAllRead, release_id: RETURNS_REQUEST_ID };
    // Added by docs/whatsnew-phone-1112 (2026-11-12): the phone appearance and returns release, read with the newer releases.
    const phoneRead = { ...returnsRead, release_id: PHONE_APPEARANCE_ID };
    // Re-pinned by docs/whatsnew-phone-1112 (2026-11-12; was: the returns request and names release first for an owner with nothing read): the phone appearance and returns release is published later, at the top, and reaches every member, so it is the first notice and is read or seen with the newer releases below; every older notice these lead to is the one this test checked before.
    expect(buildReleaseList(RELEASES, everyone, [], null).latestUnread?.id).toBe(
      PHONE_APPEARANCE_ID,
    );
    expect(buildReleaseList(RELEASES, everyone, [phoneRead], null).latestUnread?.id).toBe(
      RETURNS_REQUEST_ID,
    );
    expect(
      buildReleaseList(RELEASES, everyone, [phoneRead, returnsRead], null).latestUnread?.id,
    ).toBe(ADD_ALL_ID);
    for (const v of [everyone, countReader, stockAdjuster]) {
      expect(
        buildReleaseList(RELEASES, v, [phoneRead, returnsRead, addAllRead], null).latestUnread?.id,
        v.role,
      ).toBe(ID);
      expect(
        legacyAnnouncementsFor(RELEASES, v, {
          [PHONE_APPEARANCE_ID]: true,
          [RETURNS_REQUEST_ID]: true,
          [ADD_ALL_ID]: true,
        })[0],
        v.role,
      ).toEqual({
        id: ID,
        date: release().publishedAt.slice(0, 10),
        title: release().title,
        body: release().summary,
        cta: { href: '/dashboard/cycle-counts', label: 'Open Cycle counts' },
      });
    }
    expect(buildReleaseList(RELEASES, member, [phoneRead], null).latestUnread?.id).not.toBe(ID);
    expect(legacyAnnouncementsFor(RELEASES, member, {}).map((a) => a.id)).not.toContain(ID);
  });
});

describe('the count sheet release: the code its words rest on', () => {
  const pdf = () => source('lib/pdf/cycle-count.tsx');

  it('names the two buttons as the count page shows them', () => {
    expect(source('app/(dashboard)/dashboard/cycle-counts/[id]/page.tsx')).toContain(
      "{header.status === 'in_progress' ? 'Print count sheet' : 'Variance report PDF'}",
    );
    expect(entry().whatChanged).toContain('Print count sheet and Variance report PDF');
  });

  it('leaves space before the next column and breaks an over-wide name, SKU or location onto lines that fit', () => {
    expect(pdf()).toContain('const CC_GUTTER_PER_SHARE = 0.25;');
    expect(pdf()).toContain('<Text style={[pdfStyles.tCell, ccCell(CC_COLS.name)]}>');
    expect(pdf()).toContain('ccTextWidthPt(CC_COLS.name)');
    expect(pdf()).toContain('ccTextWidthPt(CC_COLS.loc)');
    expect(pdf()).toMatch(/breakIdentifierLines\(\s*sku,\s*ccTextWidthPt\(CC_COLS\.sku\)/);
  });

  it('keeps a row whole across a page break unless it holds more than 400 characters', () => {
    expect(pdf()).toContain('const CC_KEEP_ROW_TOGETHER_MAX_CHARS = 400;');
    expect(pdf()).toMatch(
      /wrap=\{\s*description\.length \+ sku\.length \+ location\.length >\s*CC_KEEP_ROW_TOGETHER_MAX_CHARS\s*\}/,
    );
  });

  it('is told to the people the PDF route and the linked page let in', () => {
    expect(source('app/api/cycle-counts/[id]/pdf/route.tsx')).toContain(
      "can(ctx, 'cycle_counts:read') ? 'cycle_counts:read' : 'stock:adjust',",
    );
    const page = source('app/(dashboard)/dashboard/cycle-counts/page.tsx');
    expect(page).toContain("checkModuleAccess('cycle_counts')");
    expect(page).toContain("if (!can(ctx, 'cycle_counts:read') && !can(ctx, 'stock:adjust')) {");
  });
});

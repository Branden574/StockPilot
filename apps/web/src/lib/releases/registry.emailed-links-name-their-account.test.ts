import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  MODULE_REGISTRY,
  PERMISSIONS,
  releaseSchema,
  type ModuleId,
  type Release,
  type ReleaseViewer,
} from '@stockpilot/core';

import { buildReleaseList, legacyAnnouncementsFor, visibleReleases } from './logic';
import { RELEASES } from './registry';

/**
 * Added by docs/whatsnew-emailed-links-1113 (2026-11-13): the release for
 * emailed links that show which account they are for (S25, first of two
 * releases, #429), published at the top, directly below the Liquid Glass draft
 * and above the Release count release. Its own file, so the release tests
 * other open branches edit stay as they are. These tests pin its id, place,
 * date, its words, who it reaches, and the code its words rest on.
 */
const ID = 'emailed-links-name-their-account-2026-11';
const ENTRY = 'emailed-links-name-their-account';
const OLDER_ENTRY = 'reset-and-email-change-pages-name-your-account';
const release = () => RELEASES.find((r) => r.id === ID)!;
const entry = () => release().entries.find((e) => e.id === ENTRY)!;

const viewer = (
  role: ReleaseViewer['role'],
  permissions: ReleaseViewer['permissions'],
  enabledModules: ReleaseViewer['enabledModules'],
): ReleaseViewer => ({ role, permissions, enabledModules });
const owner = viewer('owner', [...PERMISSIONS], Object.keys(MODULE_REGISTRY) as ModuleId[]);
const member = viewer('viewer', [], []);
const staff = viewer('staff', ['items:read'], ['cycle_counts']);
const told = (v: ReleaseViewer) => visibleReleases(RELEASES, v).some((r) => r.id === ID);

/** A source file under apps/web/src, as written. */
const web = (rel: string) => readFileSync(resolve(__dirname, '../..', rel), 'utf8');

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

describe('the emailed links release', () => {
  it('is published once, as revision 1, directly below the Liquid Glass draft, the newest published release, on the whole minute after #429 went live', () => {
    expect(RELEASES.filter((r) => r.id === ID)).toHaveLength(1);
    expect(release().status).toBe('published');
    expect(release().revision).toBe(1);
    expect(release().withdrawnNote).toBeUndefined();
    expect(RELEASES[0]?.id).toBe('liquid-glass-2026-11');
    expect(RELEASES[0]?.status).toBe('draft');
    // Re-pinned by docs/whatsnew-phone-code-and-access-check (2026-11-13; was: every pinned position two places higher): the phone authenticator code and access check releases are published at the top, below the Liquid Glass draft, so every position below them moves down by two.
    // Re-pinned by docs/whats-new-phone-screens-by-access (2026-11-14; was: every pinned position one place higher): the phone screens by access release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    expect(RELEASES[4]?.id).toBe(ID);
    expect(RELEASES[5]?.id).toBe('cycle-count-already-released-2026-11');
    // Re-pinned by docs/whatsnew-phone-code-and-access-check (2026-11-13; was: this release, the newest published): the phone authenticator code and access check releases are published later, directly above it.
    // Re-pinned by docs/whats-new-phone-screens-by-access (2026-11-14; was: RELEASES.slice(1, 3), the two phone releases of 2026-11-13 alone): the phone screens by access release is published later, at the top, directly above them.
    expect(RELEASES.slice(1, 4).map((r) => [r.id, r.status])).toEqual([
      ['phone-screens-by-access-2026-11', 'published'],
      ['phone-authenticator-code-2026-11', 'published'],
      ['phone-access-check-retry-2026-11', 'published'],
    ]);
    expect(RELEASES.find((r) => r.status === 'published')?.id).toBe(
      // Re-pinned by docs/whats-new-phone-screens-by-access (2026-11-14; was: the phone authenticator code release): the phone screens by access release is published after it, at the top, the newest published release.
      'phone-screens-by-access-2026-11',
    );
    // #429's build went live on production at 2026-11-13T17:38:06Z.
    expect(release().publishedAt).toBe('2026-11-13T17:39:00Z');
    expect(Date.parse(release().publishedAt)).toBeGreaterThan(Date.parse('2026-11-13T17:38:06Z'));
    expect(Date.parse(release().publishedAt)).toBeLessThanOrEqual(Date.now());
    expect(Date.parse(RELEASES[0]!.publishedAt)).toBeGreaterThanOrEqual(
      Date.parse(release().publishedAt),
    );
    // Re-pinned by docs/whatsnew-phone-code-and-access-check (2026-11-13; was: every pinned position two places higher): the phone authenticator code and access check releases are published at the top, below the Liquid Glass draft, so every position below them moves down by two.
    // Re-pinned by docs/whats-new-phone-screens-by-access (2026-11-14; was: every pinned position one place higher): the phone screens by access release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    for (const r of RELEASES.slice(5)) {
      expect(Date.parse(release().publishedAt), r.id).toBeGreaterThanOrEqual(
        Date.parse(r.publishedAt),
      );
    }
  });

  it('parses under the shared schema, with one improved entry in Account and plain text only', () => {
    expect(releaseSchema.safeParse(release()).success).toBe(true);
    expect(release().entries.map((e) => [e.id, e.category, e.area])).toEqual([
      [ENTRY, 'improved', 'Account'],
    ]);
    expect(release().title).toBe('Emailed links show which account they are for');
    for (const text of readerText(release())) expect(text).not.toMatch(/[<>]/);
  });

  it('says what the page shows, in the words of the plan, field by field', () => {
    expect(entry().title).toBe('Emailed links show which account they are for');
    expect(entry().whatChanged).toBe(
      'When you open a password reset, email change or invite link from StockPilot, the page now shows the email address of the account the link is for, before you press the button. An email change link shows the current address and the new one. If this browser is signed in to a different account, the page names both. The button becomes active a moment after the page opens. The page now needs JavaScript: if it is turned off in your browser, the page says so and the button stays inactive.',
    );
    expect(entry().whyItMatters).toBe(
      'You can check that a link is for your own account before you use it.',
    );
    expect(entry().howItAffectsYou).toBe(
      'When you open your own link, the page shows your own address: press the button as before, once it is active. If this browser is already signed in as you, the page no longer warns you about your own link.',
    );
    expect(entry().whatToDo).toBe(
      'If the page shows an address that is not yours, close it without pressing the button. If the page says it needs JavaScript, turn JavaScript on for StockPilot or open the link from your email in another browser.',
    );
    // The summary stands on its own (old phone builds show only title and
    // summary): three sentences of whatChanged, as written there.
    for (const sentence of release().summary.split(/(?<=\.) /)) {
      expect(entry().whatChanged).toContain(sentence);
    }
  });

  it('reaches every member, with no audience and no link, and is the first notice for each', () => {
    expect(entry().audience).toBeUndefined();
    expect(entry().link).toBeUndefined();
    // Re-pinned by docs/whatsnew-phone-code-and-access-check (2026-11-13; was: nothing read or seen): the phone authenticator code release (every member) and the access check release (the owner here) are published later, at the top, so each reader reads and sees them first, and the notice this test checks is the one it checked before.
    // Re-pinned by docs/whats-new-phone-screens-by-access (2026-11-14; was: without it): the phone screens by access release is published later, at the top, and reaches every member (two of its three entries have no audience), so each reader reads and sees it first too, and the notice this test checks is the one it checked before.
    const newerIds = [
      'phone-screens-by-access-2026-11',
      'phone-authenticator-code-2026-11',
      'phone-access-check-retry-2026-11',
    ];
    const newerReads = newerIds.map((id) => ({
      release_id: id,
      revision: 1,
      dismissed_at: null,
      opened_at: '2026-11-13T21:30:00Z',
      read_at: '2026-11-13T21:30:00Z',
    }));
    const newerSeen = Object.fromEntries(newerIds.map((id) => [id, true]));
    for (const v of [owner, member, staff]) {
      expect(told(v), v.role).toBe(true);
      expect(buildReleaseList(RELEASES, v, newerReads, null).latestUnread?.id, v.role).toBe(ID);
      expect(legacyAnnouncementsFor(RELEASES, v, newerSeen)[0], v.role).toEqual({
        id: ID,
        date: '2026-11-13',
        title: release().title,
        body: release().summary,
      });
    }
  });

  it('supersedes one sentence of the older entry in its note, and leaves that entry as published', () => {
    const older = RELEASES.flatMap((r) => r.entries).find((e) => e.id === OLDER_ENTRY)!;
    expect(older.howItAffectsYou).toContain('the notice names your own address');
    const source = web('lib/releases/registry.ts');
    const block = source.slice(
      source.indexOf(`id: '${ID}'`),
      // Re-pinned by docs/whatsnew-phone-code-and-access-check (2026-11-13; was: every pinned position two places higher): the phone authenticator code and access check releases are published at the top, below the Liquid Glass draft, so every position below them moves down by two.
      // Re-pinned by docs/whats-new-phone-screens-by-access (2026-11-14; was: every pinned position one place higher): the phone screens by access release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
      source.indexOf(`id: '${RELEASES[5]!.id}'`),
    );
    expect(block).toContain(`It supersedes the howItAffectsYou sentence of the published entry`);
    expect(block).toContain(OLDER_ENTRY);
  });

  it('rests on the page as the code writes it', () => {
    const route = web('app/auth/confirm/route.ts');
    // The account line, for a password reset, an invite and an email change.
    expect(route).toContain('`This link sets a new password for ${addr(email)}. ${notYours}`');
    expect(route).toContain('`This invite is for ${addr(email)}. ${notYours}`');
    expect(route).toContain(
      '`This link changes the sign-in email of ${addr(current)} to ${addr(pending)}. If neither address is yours, close this page.`',
    );
    // A browser signed in to another account is told both addresses; one
    // signed in as the link's own account is told nothing.
    expect(route).toContain(
      '`<p class="note">${who} Continuing signs you in as ${addr(recipientEmail)} instead. If you didn\'t ask for this link, close this page.</p>`',
    );
    expect(route).toContain('!signedIn || signedIn.id === verdict.userId');
    // The button starts inactive and the page's script makes it active a
    // moment later; without scripts the page says it needs JavaScript.
    expect(route).toContain('<button type="submit" class="btn" disabled>');
    expect(route).toContain('<noscript><p class="needs-script">${NO_SCRIPT_LINE}</p></noscript>');
    expect(route).toContain(
      "'This page needs JavaScript to continue. Turn JavaScript on for this site, or open the link from your email in another browser.'",
    );
    expect(web('app/auth/confirm/press-gate.ts')).toContain(
      'export const PRESS_GATE_QUIET_MS = 1000;',
    );
  });
});

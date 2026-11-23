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
 * Added by docs/whats-new-small-fixes-1119 (2026-11-19): the What's New for
 * three fixes already live on the web: an Items or Books export refused for
 * permission says so (#619), a receipt sent again is recorded once (#621),
 * and pages say the member's access could not be checked when the
 * organization's sign-in settings could not be read (#622). Published at the
 * top, below the Liquid Glass draft and above the receiving release. #620
 * (reversing a receipt follows the manager rule) has no entry: the web
 * already showed Reverse only to the people the rule allows and the phone
 * has no Reverse, so nobody using the app sees a change. SET AT MERGE:
 * publishedAt is a stand-in until the integrator sets the whole minute after
 * the last of the three deployments went live, and the Liquid Glass draft
 * placeholder takes the same minute, so these tests pin the shape and the
 * order, not the minute itself.
 */
const ID = 'export-receipt-access-fixes-2026-11';
const EXPORT_ENTRY = 'export-refusals-say-why';
const RECEIPT_ENTRY = 'receipt-sent-again-recorded-once';
const ACCESS_ENTRY = 'access-could-not-be-checked';
const RECEIVING_ID = 'receiving-shown-to-managers-2026-11';
const RECEIVING_AT = '2026-11-19T05:20:00Z';
// Added by docs/whats-new-2026-11-19-errors (2026-11-19): the count start access check release (a manager or above who can assign counts, where Cycle Counts is on), published later, at the top, below the Liquid Glass draft.
const COUNT_START_ACCESS_ID = 'count-start-access-check-2026-11';
const countStartAccessRead = {
  release_id: COUNT_START_ACCESS_ID,
  revision: 1,
  dismissed_at: null,
  opened_at: '2026-11-19T20:42:00Z',
  read_at: '2026-11-19T20:42:00Z',
};
// Added by docs/whats-new-2026-11-21-phone (2026-11-21): the phone authenticator set-up release (every member: three of its five entries have no audience), published later, at the top, below the Liquid Glass draft.
// Added by docs/whats-new-blocked-activity (2026-11-21): the Blocked activity release (owners and Super Admins), published later, at the top, below the Liquid Glass draft.
const BLOCKED_ID = 'blocked-activity-2026-11';
const BLOCKED_CURRENT_ID = 'blocked-activity-current-password-and-set-up-code-2026-11';
const SIGNIN_ID = 'sign-in-alerts-2026-11';
const PHONE_LARGE_ID = 'phone-large-text-2026-11';
const RECOVERY_ID = 'recovery-code-signs-out-other-devices-2026-11';
const blockedRead = {
  release_id: BLOCKED_ID,
  revision: 1,
  dismissed_at: null,
  opened_at: '2026-11-21T18:20:00Z',
  read_at: '2026-11-21T18:20:00Z',
};
const blockedCurrentRead = {
  release_id: BLOCKED_CURRENT_ID,
  revision: 1,
  dismissed_at: null,
  opened_at: '2026-11-22T05:43:00Z',
  read_at: '2026-11-22T05:43:00Z',
};
const signInRead = {
  release_id: SIGNIN_ID,
  revision: 1,
  dismissed_at: null,
  opened_at: '2026-11-22T06:01:00Z',
  read_at: '2026-11-22T06:01:00Z',
};
const phoneLargeRead = {
  release_id: PHONE_LARGE_ID,
  revision: 1,
  dismissed_at: null,
  opened_at: '2026-11-23T06:01:00Z',
  read_at: '2026-11-23T06:01:00Z',
};
const recoveryRead = {
  release_id: RECOVERY_ID,
  revision: 1,
  dismissed_at: null,
  opened_at: '2026-11-23T06:31:00Z',
  read_at: '2026-11-23T06:31:00Z',
};
const PHONE_SET_UP_ID = 'phone-authenticator-set-up-2026-11';
// Re-pinned by docs/whats-new-blocked-activity (2026-11-21; was: PHONE_SET_UP_AT = '2026-11-21T02:31:00Z'): the Liquid Glass draft placeholder is now the minute of the Blocked activity release, published later, above the phone authenticator set-up release.
// Re-pinned by docs/whats-new-sign-in-alerts-and-reader (2026-11-22; was: BLOCKED_AT = '2026-11-21T18:19:00Z'): the Liquid Glass draft placeholder is now the minute of the Blocked activity current password and set-up code release, published later, above the Blocked activity release.
// Re-pinned by docs/whats-new-sign-in-alerts-and-reader (2026-11-22; was: BLOCKED_CURRENT_AT = '2026-11-22T05:42:00Z'): the Liquid Glass draft placeholder is now the minute of the sign-in alerts release, published later, above the Blocked activity current password and set-up code release.
// Re-pinned by docs/whats-new-phone-large-text (2026-11-23; was: SIGNIN_AT = '2026-11-22T06:08:00Z'): the Liquid Glass draft placeholder is now the minute of the phone large text release, published later, above this one.
const RECOVERY_AT = '2026-11-23T06:30:00Z';
const phoneSetUpRead = {
  release_id: PHONE_SET_UP_ID,
  revision: 1,
  dismissed_at: null,
  opened_at: '2026-11-21T02:32:00Z',
  read_at: '2026-11-21T02:32:00Z',
};
/** #622 merged at this instant; its deployment went live after it. */
const MERGED_622 = '2026-11-19T15:13:43Z';
/** The words the reader is quoted, as the code has them. */
const UNEXPECTED = 'Something went wrong. Please try again.';
const STRIP = "We couldn't check your access just now.";
const CARD_TITLE = "This page couldn't be loaded";
const ACTION_ANSWER = 'Your access could not be checked. Please try again.';

const release = () => RELEASES.find((r) => r.id === ID)!;
const entry = (id: string) => release().entries.find((e) => e.id === id)!;

const ALL_MODULES = Object.keys(MODULE_REGISTRY) as ModuleId[];
const viewer = (
  role: ReleaseViewer['role'],
  permissions: ReleaseViewer['permissions'],
  enabledModules: ReleaseViewer['enabledModules'] = ['receiving'],
): ReleaseViewer => ({ role, permissions, enabledModules });
const owner = viewer('owner', [...PERMISSIONS], ALL_MODULES);
const admin = viewer('admin', ROLE_PERMISSIONS.admin);
const manager = viewer('manager', ROLE_PERMISSIONS.manager);
const staff = viewer('staff', ROLE_PERMISSIONS.staff);
const member = viewer('viewer', ROLE_PERMISSIONS.viewer);
const managerReceivingOff = viewer('manager', ROLE_PERMISSIONS.manager, []);
const managerNoAdjust = viewer(
  'manager',
  ROLE_PERMISSIONS.manager.filter((p) => p !== 'stock:adjust'),
);
const staffWithExport = viewer('staff', [...ROLE_PERMISSIONS.staff, 'items:export']);
const shownEntries = (v: ReleaseViewer) =>
  visibleReleases(RELEASES, v)
    .find((r) => r.id === ID)
    ?.entries.map((e) => e.id);

const REPO = resolve(__dirname, '../../../../..');
/** A source file in the repository, as written. */
const source = (rel: string) => readFileSync(resolve(REPO, rel), 'utf8');

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

describe('the export, receipt and access release: order, status and date', () => {
  // Renamed by docs/whats-new-2026-11-19-errors (2026-11-19; was: "directly below the Liquid Glass draft and above the receiving release, the newest published release"): the count start access check release is published later, at the top, directly below the Liquid Glass draft.
  // Renamed by docs/whats-new-2026-11-21-phone (2026-11-21; was: "(published later, below the Liquid Glass draft at the top)"): the phone authenticator set-up release is published later still, directly below the Liquid Glass draft.
  it('is published once, as revision 1, directly below the count start access check release (published later, below the phone authenticator set-up release and the Liquid Glass draft at the top) and above the receiving release', () => {
    expect(RELEASES.filter((r) => r.id === ID)).toHaveLength(1);
    expect(release().status).toBe('published');
    expect(release().revision).toBe(1);
    expect(release().withdrawnNote).toBeUndefined();
    // Re-pinned by docs/whats-new-2026-11-19-errors (2026-11-19; was: RELEASES.slice(0, 4)): the count start access check release is published at the top, below the Liquid Glass draft, so the list takes one more.
    // Re-pinned by docs/whats-new-2026-11-21-phone (2026-11-21; was: RELEASES.slice(0, 5)): the phone authenticator set-up release is published at the top, below the Liquid Glass draft, so the list takes one more.
    // Re-pinned by docs/whats-new-blocked-activity (2026-11-21; was: RELEASES.slice(0, 6)): the Blocked activity release is published at the top, below the Liquid Glass draft, so the list takes one more.
    // Re-pinned by docs/whats-new-recovery-code (2026-11-23; was: RELEASES.slice(0, 9)): the recovery code release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    expect(RELEASES.slice(0, 10).map((r) => [r.id, r.status])).toEqual([
      ['liquid-glass-2026-11', 'draft'],
      // Re-pinned by docs/whats-new-2026-11-21-phone (2026-11-21; was: without it): the phone authenticator set-up release is published later, at the top, directly below the Liquid Glass draft.
      // Re-pinned by docs/whats-new-blocked-activity (2026-11-21; was: without it): the Blocked activity release is published later, at the top, directly below the Liquid Glass draft.
      // Re-pinned by docs/whats-new-recovery-code (2026-11-23; was: without it): the recovery code release is published later, at the top, and reaches every member (its entries have no audience), an owner with every permission and module included, so it is read, seen or listed with the newer releases, and every notice this test checks is the one it checked before.
      [RECOVERY_ID, 'published'],
      [PHONE_LARGE_ID, 'published'],
      [SIGNIN_ID, 'published'],
      [BLOCKED_CURRENT_ID, 'published'],
      [BLOCKED_ID, 'published'],
      [PHONE_SET_UP_ID, 'published'],
      // Re-pinned by docs/whats-new-2026-11-19-errors (2026-11-19; was: without it): the count start access check release is published later, at the top, directly below the Liquid Glass draft.
      [COUNT_START_ACCESS_ID, 'published'],
      [ID, 'published'],
      [RECEIVING_ID, 'published'],
    ]);
    // Re-pinned by docs/whats-new-2026-11-19-errors (2026-11-19; was: ID): the count start access check release is published after it, at the top, the newest published release.
    // Re-pinned by docs/whats-new-2026-11-21-phone (2026-11-21; was: COUNT_START_ACCESS_ID): the phone authenticator set-up release is published after it, at the top, the newest published release.
    // Re-pinned by docs/whats-new-blocked-activity (2026-11-21; was: PHONE_SET_UP_ID): the Blocked activity release is published after it, at the top, the newest published release.
    expect(RELEASES.find((r) => r.status === 'published')?.id).toBe(RECOVERY_ID);
  });

  // Renamed by docs/whats-new-2026-11-19-errors (2026-11-19; was: "with the draft placeholder at the same minute"): the placeholder moved to the minute of the count start access check release, published later, above this one.
  it('is dated on a whole minute, in the past, after the last of its changes merged and the release below it, with the draft placeholder at or after it and every release below it older', () => {
    const at = Date.parse(release().publishedAt);
    expect(release().publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/);
    expect(at).toBeGreaterThan(Date.parse(MERGED_622));
    expect(at).toBeGreaterThan(Date.parse(RECEIVING_AT));
    expect(at).toBeLessThanOrEqual(Date.now());
    // Re-pinned by docs/whats-new-2026-11-19-errors (2026-11-19; was: RELEASES[0].publishedAt equal to this release's): the placeholder is the minute of the count start access check release, published later, above this one.
    // Re-pinned by docs/whats-new-2026-11-21-phone (2026-11-21; was: COUNT_START_ACCESS_AT): the placeholder is the minute of the phone authenticator set-up release, published later, above this one.
    // Re-pinned by docs/whats-new-blocked-activity (2026-11-21; was: PHONE_SET_UP_AT): the placeholder is the minute of the Blocked activity release, published later, above this one.
    // Re-pinned by docs/whats-new-phone-large-text (2026-11-23; was: SIGNIN_AT): the placeholder is the minute of the phone large text release, published later, above this one.
    expect(RELEASES[0]!.publishedAt).toBe(RECOVERY_AT);
    expect(Date.parse(RELEASES[0]!.publishedAt)).toBeGreaterThanOrEqual(at);
    // Re-pinned by docs/whats-new-2026-11-19-errors (2026-11-19; was: RELEASES.slice(2)): the count start access check release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-2026-11-21-phone (2026-11-21; was: RELEASES.slice(3)): the phone authenticator set-up release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-blocked-activity (2026-11-21; was: RELEASES.slice(4)): the Blocked activity release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-phone-large-text (2026-11-23; was: RELEASES.slice(7)): the phone large text release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-recovery-code (2026-11-23; was: RELEASES.slice(8)): the recovery code release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    for (const r of RELEASES.slice(9)) {
      expect(at, r.id).toBeGreaterThan(Date.parse(r.publishedAt));
    }
  });

  it('parses under the shared schema, in plain text, with its three entries', () => {
    expect(releaseSchema.safeParse(release()).success).toBe(true);
    for (const text of readerText(release())) expect(text).not.toMatch(/[<>!]/);
    expect(release().entries.map((e) => [e.id, e.category, e.area])).toEqual([
      [EXPORT_ENTRY, 'fixed', 'Inventory'],
      [RECEIPT_ENTRY, 'fixed', 'Receiving'],
      [ACCESS_ENTRY, 'fixed', 'Account'],
    ]);
    for (const id of [EXPORT_ENTRY, RECEIPT_ENTRY, ACCESS_ENTRY]) {
      expect(RELEASES.filter((r) => r.entries.some((x) => x.id === id)).map((r) => r.id)).toEqual([
        ID,
      ]);
    }
  });

  it('has no entry for reversing a receipt, whose change nobody using the app sees', () => {
    const words = readerText(release()).join(' ');
    expect(words).not.toMatch(/revers/i);
    expect(
      RELEASES.flatMap((r) => r.entries).some((e) => /reverse a receipt/i.test(e.whatChanged)),
    ).toBe(false);
  });
});

describe('the export, receipt and access release: the words', () => {
  it('has the title, summary and entries as written', () => {
    expect(release().title).toBe(
      'Export refusals say why, a receipt sent again is recorded once, and pages say when your access could not be checked',
    );
    expect(release().summary).toBe(
      "On the web, the Customize export dialog now says so when you do not have permission to export, instead of offering Try again. A receipt sent again, for example after a slow connection, now shows once in the Audit log and reaches webhooks, Slack and Teams once. When StockPilot can't read your organization's sign-in settings for a moment, the web now says your access could not be checked and offers Try again, instead of asking you to set up an authenticator app.",
    );

    expect(entry(EXPORT_ENTRY).title).toBe('Export says why when it is refused');
    expect(entry(EXPORT_ENTRY).whatChanged).toBe(
      'In the Customize export dialog on Items and Books, when the server refuses to show a sample of the export because you do not have permission, the sample area now says so, with no Try again. When an export fails on the server, the dialog says "Something went wrong. Please try again." and the failure is recorded so it can be found and fixed.',
    );
    expect(entry(EXPORT_ENTRY).whyItMatters).toBe(
      'A refusal looked like a failure: the sample said it could not load and offered Try again, which could not help.',
    );
    expect(entry(EXPORT_ENTRY).howItAffectsYou).toBe(
      'Nothing changes for an export that works. If an export is refused, the dialog tells you why.',
    );
    expect(entry(EXPORT_ENTRY).whatToDo).toBe(
      'No action needed. If the dialog says you do not have permission, ask an admin.',
    );

    expect(entry(RECEIPT_ENTRY).title).toBe('A receipt sent again is recorded once');
    expect(entry(RECEIPT_ENTRY).whatChanged).toBe(
      'When a receipt on a purchase order is sent again, for example after a slow connection, the Audit log now shows it once, and webhooks, Slack and Teams hear about it once.',
    );
    expect(entry(RECEIPT_ENTRY).whyItMatters).toBe(
      'A receipt sent again only added stock once, but the Audit log could show it twice, and webhooks, Slack and Teams could be told about it twice.',
    );
    expect(entry(RECEIPT_ENTRY).howItAffectsYou).toBe(
      'Nothing changes in how you receive. If you use QuickBooks, its bill for the receipt was already made once.',
    );
    expect(entry(RECEIPT_ENTRY).whatToDo).toBe('No action needed.');

    expect(entry(ACCESS_ENTRY).title).toBe("Pages say when your access couldn't be checked");
    expect(entry(ACCESS_ENTRY).whatChanged).toBe(
      'If StockPilot can\'t read your organization\'s sign-in settings for a moment and you have not set up an authenticator app, the web now says "We couldn\'t check your access just now." at the top of the page, with Try again, and most pages show "This page couldn\'t be loaded" with the same words. A change made then is not saved and says "Your access could not be checked. Please try again."',
    );
    expect(entry(ACCESS_ENTRY).whyItMatters).toBe(
      'Before, the web asked you to set up an authenticator app in that moment, even if your organization does not ask for one.',
    );
    expect(entry(ACCESS_ENTRY).howItAffectsYou).toBe(
      'This is usually temporary. Press Try again a moment later. If your organization does ask for an authenticator app, you are asked to set one up once the settings can be read.',
    );
    expect(entry(ACCESS_ENTRY).whatToDo).toBe(
      'No action needed. If the message stays, try again later or tell your admin.',
    );
  });

  it('quotes the sentences people see', () => {
    expect(entry(EXPORT_ENTRY).whatChanged).toContain(`"${UNEXPECTED}"`);
    expect(entry(ACCESS_ENTRY).whatChanged).toContain(`"${STRIP}"`);
    expect(entry(ACCESS_ENTRY).whatChanged).toContain(`"${CARD_TITLE}"`);
    expect(entry(ACCESS_ENTRY).whatChanged).toContain(`"${ACTION_ANSWER}"`);
  });

  it('keeps to the wording rules: no emoji, no exclamation mark, no "book" but the Books page and QuickBooks, no internal names, and no links', () => {
    for (const text of readerText(release())) {
      expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
      expect(text.replace(/\bBooks\b/g, '').replace(/QuickBooks/g, '')).not.toMatch(/book/i);
      expect(text).not.toMatch(
        /\b[SB]\d{1,3}\b|docket|migration|database|\b04\d\d\b|Claude|\bAI\b/i,
      );
      expect(text).not.toMatch(
        /items:export|stock:adjust|ServiceError|outbox|webhook event|policy|MFA|aal2|\b40[13]\b|\b500\b/,
      );
    }
    for (const e of release().entries) expect(e.link, e.id).toBeUndefined();
  });
});

describe('the export, receipt and access release: who is told', () => {
  it('names items:export on the export entry, the receiving rule on the receipt entry, nothing on the access entry and nothing on the release', () => {
    expect(release().audience).toBeUndefined();
    expect(entry(EXPORT_ENTRY).audience).toEqual({ anyPermission: ['items:export'] });
    expect(entry(RECEIPT_ENTRY).audience).toEqual({
      roles: ['owner', 'admin', 'manager'],
      anyPermission: ['stock:adjust'],
      modules: ['receiving'],
    });
    expect(entry(ACCESS_ENTRY).audience).toBeUndefined();
  });

  it('tells every member about access, whoever can export about the export, and only a manager or above with Adjust on-hand where Receiving is on about receipts', () => {
    expect(shownEntries(owner)).toEqual([EXPORT_ENTRY, RECEIPT_ENTRY, ACCESS_ENTRY]);
    expect(shownEntries(admin)).toEqual([EXPORT_ENTRY, RECEIPT_ENTRY, ACCESS_ENTRY]);
    expect(shownEntries(manager)).toEqual([EXPORT_ENTRY, RECEIPT_ENTRY, ACCESS_ENTRY]);
    expect(shownEntries(staff)).toEqual([ACCESS_ENTRY]);
    expect(shownEntries(member)).toEqual([ACCESS_ENTRY]);
    expect(shownEntries(staffWithExport)).toEqual([EXPORT_ENTRY, ACCESS_ENTRY]);
    expect(shownEntries(managerReceivingOff)).toEqual([EXPORT_ENTRY, ACCESS_ENTRY]);
    expect(shownEntries(managerNoAdjust)).toEqual([EXPORT_ENTRY, ACCESS_ENTRY]);
  });

  // Renamed by docs/whats-new-2026-11-19-errors (2026-11-19; was: "is the first notice for every member"): the count start access check release, published later, is the first notice for whoever it reaches.
  // Renamed by docs/whats-new-2026-11-21-phone (2026-11-21; was: "is the first notice for every member the count start access check release does not reach"): the phone authenticator set-up release, published later, reaches every member and is read first.
  it('is the first notice, once the phone authenticator set-up release is read, for every member the count start access check release does not reach, and for the rest once that is read, the receiving release is next for whoever that reaches, and an old phone build lists it first with its title and summary alone', () => {
    const read = {
      release_id: ID,
      revision: 1,
      dismissed_at: null,
      opened_at: '2026-11-19T16:01:00Z',
      read_at: '2026-11-19T16:01:00Z',
    };
    // Added by docs/whats-new-2026-11-19-errors (2026-11-19): these readers have Cycle Counts off, so the count start access check release does not reach them and this release is still their first notice with nothing read.
    for (const v of [admin, manager, staff, member, managerReceivingOff]) {
      // Re-pinned by docs/whats-new-2026-11-21-phone (2026-11-21; was: nothing read): the phone authenticator set-up release is published later, at the top, and reaches every member (three of its five entries have no audience), so it is read first, and the notice this test checks is the one it checked before.
      // Re-pinned by docs/whats-new-blocked-activity (2026-11-21; was: without it): the Blocked activity release is published later, at the top, and reaches owners and Super Admins (their roles are its audience), so it is read, seen or listed with the newer releases for them, and every notice this test checks is the one it checked before. A read of a release by a reader it does not reach changes nothing.
      expect(buildReleaseList(RELEASES, v, [recoveryRead, phoneLargeRead, signInRead, blockedCurrentRead, blockedRead, phoneSetUpRead], null).latestUnread?.id, v.role).toBe(
        ID,
      );
    }
    for (const v of [owner, admin, manager, staff, member, managerReceivingOff]) {
      // Re-pinned by docs/whats-new-2026-11-19-errors (2026-11-19; was: without it): the count start access check release is published later, at the top, and reaches a manager or above who can assign counts where Cycle Counts is on (an owner with every permission and module among them), so it is read or seen first, and every notice this test checks is the one it checked before. A read of a release by a reader it does not reach changes nothing.
      expect(
        // Re-pinned by docs/whats-new-2026-11-21-phone (2026-11-21; was: without it): the phone authenticator set-up release is published later, at the top, and reaches every member (three of its five entries have no audience), an owner with every permission and module included, so it is read, seen or listed with the newer releases, and every notice this test checks is the one it checked before.
        // Re-pinned by docs/whats-new-blocked-activity (2026-11-21; was: without it): the Blocked activity release is published later, at the top, and reaches owners and Super Admins (their roles are its audience), so it is read, seen or listed with the newer releases for them, and every notice this test checks is the one it checked before. A read of a release by a reader it does not reach changes nothing.
        buildReleaseList(RELEASES, v, [recoveryRead, phoneLargeRead, signInRead, blockedCurrentRead, blockedRead, phoneSetUpRead, countStartAccessRead], null).latestUnread
          ?.id,
        v.role,
      ).toBe(ID);
      expect(
        // Re-pinned by docs/whats-new-2026-11-21-phone (2026-11-21; was: without it): the phone authenticator set-up release is published later, at the top, and reaches every member (three of its five entries have no audience), an owner with every permission and module included, so it is read, seen or listed with the newer releases, and every notice this test checks is the one it checked before.
        // Re-pinned by docs/whats-new-blocked-activity (2026-11-21; was: without it): the Blocked activity release is published later, at the top, and reaches owners and Super Admins (their roles are its audience), so it is read, seen or listed with the newer releases for them, and every notice this test checks is the one it checked before. A read of a release by a reader it does not reach changes nothing.
        buildReleaseList(RELEASES, v, [recoveryRead, phoneLargeRead, signInRead, blockedCurrentRead, blockedRead, phoneSetUpRead, countStartAccessRead, read], null)
          .latestUnread?.id,
        v.role,
      ).not.toBe(ID);
    }
    for (const v of [owner, manager, staff]) {
      // Re-pinned by docs/whats-new-2026-11-19-errors (2026-11-19; was: without it): the count start access check release is published later, at the top, and reaches a manager or above who can assign counts where Cycle Counts is on (an owner with every permission and module among them), so it is read or seen first, and every notice this test checks is the one it checked before. A read of a release by a reader it does not reach changes nothing.
      expect(
        // Re-pinned by docs/whats-new-2026-11-21-phone (2026-11-21; was: without it): the phone authenticator set-up release is published later, at the top, and reaches every member (three of its five entries have no audience), an owner with every permission and module included, so it is read, seen or listed with the newer releases, and every notice this test checks is the one it checked before.
        // Re-pinned by docs/whats-new-blocked-activity (2026-11-21; was: without it): the Blocked activity release is published later, at the top, and reaches owners and Super Admins (their roles are its audience), so it is read, seen or listed with the newer releases for them, and every notice this test checks is the one it checked before. A read of a release by a reader it does not reach changes nothing.
        buildReleaseList(RELEASES, v, [recoveryRead, phoneLargeRead, signInRead, blockedCurrentRead, blockedRead, phoneSetUpRead, countStartAccessRead, read], null)
          .latestUnread?.id,
        v.role,
      ).toBe(RECEIVING_ID);
    }
    for (const v of [owner, staff, member]) {
      // Re-pinned by docs/whats-new-2026-11-19-errors (2026-11-19; was: without it): the count start access check release is published later, at the top, and reaches a manager or above who can assign counts where Cycle Counts is on (an owner with every permission and module among them), so it is read or seen first, and every notice this test checks is the one it checked before. A read of a release by a reader it does not reach changes nothing.
      expect(
        // Re-pinned by docs/whats-new-2026-11-21-phone (2026-11-21; was: without it): the phone authenticator set-up release is published later, at the top, and reaches every member (three of its five entries have no audience), an owner with every permission and module included, so it is read, seen or listed with the newer releases, and every notice this test checks is the one it checked before.
        legacyAnnouncementsFor(RELEASES, v, {
          // Re-pinned by docs/whats-new-blocked-activity (2026-11-21; was: without it): the Blocked activity release is published later, at the top, and reaches owners and Super Admins (their roles are its audience), so it is read, seen or listed with the newer releases for them, and every notice this test checks is the one it checked before. A read of a release by a reader it does not reach changes nothing.
          // Re-pinned by docs/whats-new-recovery-code (2026-11-23; was: without it): the recovery code release is published later, at the top, and reaches every member (its entries have no audience), an owner with every permission and module included, so it is read, seen or listed with the newer releases, and every notice this test checks is the one it checked before.
          [RECOVERY_ID]: true,
          [PHONE_LARGE_ID]: true,
          [SIGNIN_ID]: true,
          [BLOCKED_CURRENT_ID]: true,
          [BLOCKED_ID]: true,
          [PHONE_SET_UP_ID]: true,
          [COUNT_START_ACCESS_ID]: true,
        })[0],
        v.role,
      ).toEqual({
        id: ID,
        date: release().publishedAt.slice(0, 10),
        title: release().title,
        body: release().summary,
      });
    }
  });
});

describe('the export, receipt and access release: the code the words rest on', () => {
  it('an export or its sample refused for permission is a refusal with its own words, and a failure is reported with the fixed sentence', () => {
    const answer = source('apps/web/src/server/lib/service-error-response.ts');
    expect(answer).toContain("if (e instanceof ServiceError && e.code !== 'internal_error') {");
    expect(answer).toContain('{ status: serviceErrorStatus(e.code) },');
    // Anything that is not a refusal goes on to forbiddenOrInternalResponse,
    // which ends in internalErrorResponse (the report and the fixed sentence).
    expect(answer).toContain('return forbiddenOrInternalResponse(e, tag, opts);');
    expect(source('apps/web/src/server/lib/api-error-response.ts')).toContain(
      'return internalErrorResponse(e, tag, opts);',
    );
    expect(source('apps/web/src/app/api/inventory/export/route.tsx')).toContain(
      "return serviceErrorResponse(e, 'inventory.export');",
    );
    expect(source('apps/web/src/app/api/inventory/export/preview/route.ts')).toContain(
      "return serviceErrorResponse(e, 'inventory.export.preview');",
    );
    expect(source('apps/web/src/server/lib/api-error-response.ts')).toContain(
      `export const UNEXPECTED_ERROR_MESSAGE = '${UNEXPECTED}';`,
    );
    const client = source('apps/web/src/lib/download-export.ts');
    expect(client).toContain("if (res.status === 403 && code === 'forbidden') {");
    const dialog = source(
      'apps/web/src/components/inventory/export-builder/export-builder-dialog.tsx',
    );
    expect(dialog).toContain('refusal: isExportRefused(e) ? e.message : null');
    expect(
      source('apps/web/src/components/inventory/export-builder/export-builder-preview.tsx'),
    ).toContain('Could not load a sample of this export. You can still export the file.');
  });

  it('a receipt sent again writes its audit row and its messages only for the call that recorded its export event', () => {
    const receiving = source('apps/web/src/server/services/receiving.ts');
    const first = receiving.indexOf('const firstAnswer = await publishOutboxEvent(this.ctx, {');
    const stop = receiving.indexOf('if (firstAnswer === false) return receipt;');
    const auditRow = receiving.indexOf("event: 'stock.receipt.posted'");
    const message = receiving.indexOf("void dispatchEvent(this.ctx.organizationId, 'po.received'");
    expect(first).toBeGreaterThan(-1);
    expect(stop).toBeGreaterThan(first);
    expect(auditRow).toBeGreaterThan(stop);
    expect(message).toBeGreaterThan(stop);
  });

  it('a page, the top strip and an action say the access could not be checked in the quoted words', () => {
    const states = source('apps/web/src/lib/known-error-states.ts');
    expect(states).toContain(`title: "${CARD_TITLE}",`);
    expect(states).toContain(`body: "${STRIP} This is usually temporary.",`);
    const strip = source('apps/web/src/components/dashboard/access-unchecked-banner.tsx');
    expect(strip).toContain('We couldn&apos;t check your access just now.');
    expect(strip).toContain('Try again');
    expect(source('apps/web/src/lib/auth/organization-row-unavailable.ts')).toContain(
      `super('${ACTION_ANSWER}');`,
    );
    const layout = source('apps/web/src/app/(dashboard)/layout.tsx');
    expect(layout).toContain('const setUpOwed = policyRead && strictestOwed;');
    expect(layout).toContain('{accessUnchecked && <AccessUncheckedBanner />}');
  });
});

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  AUTHENTICATOR_SET_UP_HOLD_COPY,
  AUTHENTICATOR_SET_UP_OWED_COPY,
  AUTHENTICATOR_SET_UP_TITLE,
  AUTHENTICATOR_SET_UP_URL,
  authenticatorSetUpHoldBody,
  DELETE_ACCOUNT_CONFIRM_COPY,
  DELETE_ACCOUNT_NEWEST_CODE_ONLY_COPY,
  isManagerOrAbove,
  MODULE_REGISTRY,
  PERMISSIONS,
  policyRequiresAuthenticator,
  RECEIVE_MANAGER_ONLY_COPY,
  releaseSchema,
  ROLE_LABELS,
  ROLE_PERMISSIONS,
  roleCanHandOutKits,
  ROLES,
  type ModuleId,
  type Release,
  type ReleaseViewer,
} from '@stockpilot/core';

import { buildReleaseList, legacyAnnouncementsFor, visibleReleases } from './logic';
import { RELEASES } from './registry';

/**
 * Added by docs/whats-new-2026-11-21-phone (2026-11-21): the What's New for the
 * phone update of 2026-11-21 (an over-the-air update for runtime 1.4.0) and
 * the web change released with it. Five entries, all about the mobile app:
 *
 *  - the set-up screen in place of the app when the organization requires an
 *    authenticator app the member has not set up, and the could-not-check
 *    screen (#604); with it, API reads refuse that member with the reason
 *    (#626), so the app shows none of that organization's records;
 *  - changes waiting on the phone kept until set-up (#601);
 *  - Delete my account on that screen, with the password or an emailed code
 *    (#599, opened from the screen by #604);
 *  - receiving on a purchase order offered only to people who can receive,
 *    the phone half of #617 that the receiving release said would follow;
 *  - archiving or restoring a customer account recorded in the Audit log
 *    (#598).
 *
 * Left out, each checked against the code: #620 (the phone has no Reverse),
 * #603 (the phone's Distribute already asked the manager role, and the phone
 * has no Mark complete), #586 (a 1.4.0 phone keeps its launch look), #573 (no
 * limit a screen meets), and #626 on the website (no page changes).
 *
 * publishedAt is the whole minute this release was dated, after the phone
 * update was launched on a phone (the integrator's record, not readable from
 * the code), and the Liquid Glass draft placeholder takes the same minute.
 *
 * "the app asks you to sign in again" rests on the lab walk of this update,
 * not on code in this repository: the sign-in service ends the account's other
 * sessions when its first authenticator is verified.
 */
const ID = 'phone-authenticator-set-up-2026-11';
const SET_UP = 'app-authenticator-set-up-screen';
const KEPT = 'app-changes-kept-until-set-up';
const DELETE = 'app-set-up-screen-delete-account';
const RECEIVE = 'app-receive-for-people-who-can-receive';
const ACCOUNTS = 'app-customer-account-change-recorded';
const COUNT_START_ACCESS_ID = 'count-start-access-check-2026-11';
// Added by docs/whats-new-blocked-activity (2026-11-21): the Blocked activity release (owners and Super Admins), published later, at the top, below the Liquid Glass draft, and the minute it is dated.
const BLOCKED_ID = 'blocked-activity-2026-11';
const BLOCKED_CURRENT_ID = 'blocked-activity-current-password-and-set-up-code-2026-11';
const SIGNIN_ID = 'sign-in-alerts-2026-11';
const PHONE_LARGE_ID = 'phone-large-text-2026-11';
// Re-pinned by docs/whats-new-sign-in-alerts-and-reader (2026-11-22; was: BLOCKED_AT = '2026-11-21T18:19:00Z'): the Liquid Glass draft placeholder is now the minute of the Blocked activity current password and set-up code release, published later, above the Blocked activity release.
// Re-pinned by docs/whats-new-sign-in-alerts-and-reader (2026-11-22; was: BLOCKED_CURRENT_AT = '2026-11-22T05:42:00Z'): the Liquid Glass draft placeholder is now the minute of the sign-in alerts release, published later, above the Blocked activity current password and set-up code release.
// Re-pinned by docs/whats-new-phone-large-text (2026-11-23; was: SIGNIN_AT = '2026-11-22T06:08:00Z'): the Liquid Glass draft placeholder is now the minute of the phone large text release, published later, above this one.
const PHONE_LARGE_AT = '2026-11-23T06:00:00Z';
const EXPORT_RECEIPT_ACCESS_ID = 'export-receipt-access-fixes-2026-11';
const RECEIVING_ID = 'receiving-shown-to-managers-2026-11';
/** #604 (which carries #598 and #599), the last of this update's phone changes, merged at this instant. */
const MERGED_604 = '2026-11-21T01:56:16Z';
/** #626, the web change released with this update, merged at this instant. */
const MERGED_626 = '2026-11-21T02:19:12Z';
/** The minute this release is dated. */
const PUBLISHED_AT = '2026-11-21T02:31:00Z';
/** The words the reader is quoted, as the code has them. */
const SET_UP_TAIL = 'Set one up on the website, then come back to this app.';
const UNCHECKED_TITLE = 'Your access could not be checked';
const QUEUED_EXAMPLE =
  '2 changes have not synced. They stay on this phone and are sent after you set up your authenticator.';
const PARKED =
  'Not sent: your organization required an authenticator before this could be saved. If it is still needed, enter it again.';
const NOT_ALLOWED = 'You do not have access to do that in this workspace.';
const UPDATE_WORDS =
  'To load the latest update, tap Restart now when the app says Update ready, or close the app completely and open it again.';

const release = () => RELEASES.find((r) => r.id === ID)!;
const entry = (id: string) => release().entries.find((e) => e.id === id)!;

const ALL_MODULES = Object.keys(MODULE_REGISTRY) as ModuleId[];
const viewer = (
  role: ReleaseViewer['role'],
  permissions: ReleaseViewer['permissions'],
  enabledModules: ReleaseViewer['enabledModules'] = ['receiving', 'b2b_portal'],
): ReleaseViewer => ({ role, permissions, enabledModules });
const owner = viewer('owner', [...PERMISSIONS], ALL_MODULES);
const admin = viewer('admin', ROLE_PERMISSIONS.admin);
const manager = viewer('manager', ROLE_PERMISSIONS.manager);
const staff = viewer('staff', ROLE_PERMISSIONS.staff);
const member = viewer('viewer', ROLE_PERMISSIONS.viewer);
const managerNoModules = viewer('manager', ROLE_PERMISSIONS.manager, []);
const staffNoPoRead = viewer(
  'staff',
  ROLE_PERMISSIONS.staff.filter((p) => p !== 'purchase_orders:read'),
);
const shownEntries = (v: ReleaseViewer) =>
  visibleReleases(RELEASES, v)
    .find((r) => r.id === ID)
    ?.entries.map((e) => e.id);
const EVERY_MEMBER = [SET_UP, KEPT, DELETE];

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

describe('the phone authenticator set-up release: order, status and date', () => {
  it('is published once, as revision 1, directly below the Liquid Glass draft and above the count start access check release, the newest published release', () => {
    expect(RELEASES.filter((r) => r.id === ID)).toHaveLength(1);
    expect(release().status).toBe('published');
    expect(release().revision).toBe(1);
    expect(release().withdrawnNote).toBeUndefined();
    // Re-pinned by docs/whats-new-blocked-activity (2026-11-21; was: RELEASES.slice(0, 4)): the Blocked activity release is published at the top, below the Liquid Glass draft, so the list takes one more.
    expect(RELEASES.slice(0, 7).map((r) => [r.id, r.status])).toEqual([
      ['liquid-glass-2026-11', 'draft'],
      // Re-pinned by docs/whats-new-blocked-activity (2026-11-21; was: without it): the Blocked activity release is published later, at the top, directly below the Liquid Glass draft.
      [PHONE_LARGE_ID, 'published'],
      [SIGNIN_ID, 'published'],
      [BLOCKED_CURRENT_ID, 'published'],
      [BLOCKED_ID, 'published'],
      [ID, 'published'],
      [COUNT_START_ACCESS_ID, 'published'],
    ]);
    // Re-pinned by docs/whats-new-blocked-activity (2026-11-21; was: ID): the Blocked activity release is published after it, at the top, the newest published release.
    expect(RELEASES.find((r) => r.status === 'published')?.id).toBe(PHONE_LARGE_ID);
  });

  it('is dated on a whole minute, in the past, after #604 and #626 merged, with the draft placeholder at the same minute and every release below it older', () => {
    const at = Date.parse(release().publishedAt);
    expect(release().publishedAt).toBe(PUBLISHED_AT);
    expect(release().publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/);
    expect(at).toBeGreaterThan(Date.parse(MERGED_604));
    expect(at).toBeGreaterThan(Date.parse(MERGED_626));
    expect(at).toBeLessThanOrEqual(Date.now());
    // Re-pinned by docs/whats-new-blocked-activity (2026-11-21; was: RELEASES[0].publishedAt equal to this release's): the placeholder is the minute of the Blocked activity release, published later, above this one.
    // Re-pinned by docs/whats-new-phone-large-text (2026-11-23; was: SIGNIN_AT): the placeholder is the minute of the phone large text release, published later, above this one.
    expect(RELEASES[0]!.publishedAt).toBe(PHONE_LARGE_AT);
    expect(Date.parse(RELEASES[0]!.publishedAt)).toBeGreaterThanOrEqual(at);
    // Re-pinned by docs/whats-new-blocked-activity (2026-11-21; was: RELEASES.slice(2)): the Blocked activity release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-phone-large-text (2026-11-23; was: RELEASES.slice(5)): the phone large text release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    for (const r of RELEASES.slice(6)) {
      expect(at, r.id).toBeGreaterThan(Date.parse(r.publishedAt));
    }
  });

  it('parses under the shared schema, in plain text, with its five entries', () => {
    expect(releaseSchema.safeParse(release()).success).toBe(true);
    for (const text of readerText(release())) expect(text).not.toMatch(/[<>!]/);
    expect(release().entries.map((e) => [e.id, e.category, e.area])).toEqual([
      [SET_UP, 'new', 'Mobile app'],
      [KEPT, 'fixed', 'Mobile app'],
      [DELETE, 'new', 'Account'],
      [RECEIVE, 'fixed', 'Receiving'],
      [ACCOUNTS, 'fixed', 'Accounts'],
    ]);
    for (const id of [SET_UP, KEPT, DELETE, RECEIVE, ACCOUNTS]) {
      expect(RELEASES.filter((r) => r.entries.some((x) => x.id === id)).map((r) => r.id)).toEqual([
        ID,
      ]);
    }
  });

  it('has no entry for reversing a receipt, handing out a kit, completing an event or the launch screen, which nobody sees change', () => {
    const words = readerText(release()).join(' ');
    expect(words).not.toMatch(/revers/i);
    expect(words).not.toMatch(/\bkits?\b|hand(ed|ing)? out|Mark complete|launch screen|splash/i);
  });

  it('announces the phone half of the receiving release, whose revision stays 1', () => {
    const receiving = RELEASES.find((r) => r.id === RECEIVING_ID)!;
    expect(receiving.revision).toBe(1);
    expect(receiving.summary).toContain('The mobile app does the same after its next update.');
  });
});

describe('the phone authenticator set-up release: the words', () => {
  it('has the title and summary as written', () => {
    expect(release().title).toBe(
      'The mobile app asks you to set up a required authenticator app first, and keeps your unsent changes',
    );
    expect(release().summary).toBe(
      'In the mobile app, after the latest update, if your organization requires an authenticator app and you have not set one up, the app shows Set up an authenticator to continue in its place, with a way to set one up on the website. Changes waiting on the phone stay there and are sent after set-up. Receiving on a purchase order shows only for people who can receive. Tap Restart now when the app says Update ready, or close the app completely and open it again.',
    );
  });

  it('has the set-up entry as written', () => {
    const e = entry(SET_UP);
    expect(e.title).toBe('The mobile app asks you to set up a required authenticator app first');
    expect(e.whatChanged).toBe(
      'In the mobile app, after the latest update, if your organization requires an authenticator app for you and you have not set one up, the app shows "Set up an authenticator to continue" in place of your workspace. It names your organization and asks you to "Set one up on the website, then come back to this app." The screen has Set up on the website, Check again, Switch workspace when you belong to another organization, Sign out and Delete my account.',
    );
    expect(e.whyItMatters).toBe(
      'Before, the app opened as usual and the changes you made there could be refused until you had set one up. Now the app tells you first, and what to do.',
    );
    expect(e.howItAffectsYou).toBe(
      "In organizations set to Required for admins this applies to owners and Super Admins, and in organizations set to Required for everyone to every member. Until you set one up, the app shows none of that organization's records. If you have none and the app can't read your organization's sign-in settings for a moment, it says \"Your access could not be checked\" and checks again every 30 seconds.",
    );
    expect(e.whatToDo).toBe(
      `If the app shows this screen, tap Set up on the website and follow the steps in Settings, Security. Back in the app, sign in again: setting up your first authenticator app signs you out everywhere else. Then enter the code from your authenticator app. ${UPDATE_WORDS}`,
    );
  });

  it('has the kept changes entry as written', () => {
    const e = entry(KEPT);
    expect(e.title).toBe(
      'Changes waiting on the phone are kept until you set up a required authenticator app',
    );
    expect(e.whatChanged).toBe(
      `In the mobile app, after the latest update, changes saved on the phone that have not been sent yet, such as counts, stock adjustments and receipts, stay on the phone while your organization asks you to set up an authenticator app, and are sent after you have set one up and signed in again. The set-up screen says how many are waiting, for example "${QUEUED_EXAMPLE}"`,
    );
    expect(e.whyItMatters).toBe(
      'Before, StockPilot refused those changes, and the app moved them to Unsent work in Settings, to be entered again by hand.',
    );
    expect(e.howItAffectsYou).toBe(
      `A change moved to Unsent work for this reason before the update now says "${PARKED}"`,
    );
    expect(e.whatToDo).toBe(
      'No action needed. If Unsent work in Settings lists a change with that sentence, enter it again if it is still needed.',
    );
  });

  it('has the delete entry as written', () => {
    const e = entry(DELETE);
    expect(e.title).toBe(
      'Delete my account on the set-up screen asks for your password or an emailed code',
    );
    expect(e.whatChanged).toBe(
      'In the mobile app, after the latest update, Delete my account on the screen that asks you to set up an authenticator app opens "Delete your account?". Type DELETE and enter your password, or choose "Email me a code instead" and enter the six-digit code we send to your sign-in email, as on the website.',
    );
    expect(e.whyItMatters).toBe(
      'Settings cannot be opened from that screen, and every member can delete their own account.',
    );
    expect(e.howItAffectsYou).toBe(
      'The code works for 10 minutes, and if you ask again, only the newest code works. Delete my account in Settings is unchanged.',
    );
    expect(e.whatToDo).toBe('No action needed.');
  });

  it('has the receiving entry as written', () => {
    const e = entry(RECEIVE);
    expect(e.title).toBe(
      'In the mobile app, receiving on a purchase order shows only for people who can receive',
    );
    expect(e.whatChanged).toBe(
      `In the mobile app, after the latest update, on a purchase order ready to receive, Scan, the quantities and Post receipt show only for managers, admins and owners with the Adjust on-hand permission, as on the website. Staff with Adjust on-hand see "${RECEIVE_MANAGER_ONLY_COPY}" in their place, and still see what was ordered and what has been received.`,
    );
    expect(e.whyItMatters).toBe(
      'Only managers, admins and owners can post a receipt. Before, the app offered staff Scan and Post receipt, and then refused the receipt.',
    );
    expect(e.howItAffectsYou).toBe(
      'Nothing changes in who can receive. If you are on staff, ask a manager to post the receipt. Without Adjust on-hand, a purchase order says what it said before.',
    );
    expect(e.whatToDo).toBe(`No action needed. ${UPDATE_WORDS}`);
  });

  it('has the Accounts entry as written', () => {
    const e = entry(ACCOUNTS);
    expect(e.title).toBe(
      'Archiving or restoring a customer account in the mobile app is recorded in the Audit log',
    );
    expect(e.whatChanged).toBe(
      `In the mobile app, after the latest update, archiving or restoring an account on the Accounts screen is recorded in your organization's Audit log, with who made the change. When a change cannot be made, "Could not update" now says why in plain words, such as "${NOT_ALLOWED}"`,
    );
    expect(e.whyItMatters).toBe(
      'Before, a change made in the app was not in the Audit log, and a refusal could show a technical error message.',
    );
    expect(e.howItAffectsYou).toBe('Nothing changes in how you archive or restore an account.');
    expect(e.whatToDo).toBe('No action needed.');
  });

  it('quotes the sentences people see', () => {
    expect(entry(SET_UP).whatChanged).toContain(`"${AUTHENTICATOR_SET_UP_TITLE}"`);
    expect(entry(SET_UP).whatChanged).toContain(`"${SET_UP_TAIL}"`);
    expect(entry(SET_UP).howItAffectsYou).toContain(`"${UNCHECKED_TITLE}"`);
    for (const button of [
      AUTHENTICATOR_SET_UP_HOLD_COPY.setUpOnWebsite,
      AUTHENTICATOR_SET_UP_HOLD_COPY.checkAgain,
      AUTHENTICATOR_SET_UP_HOLD_COPY.switchWorkspace,
      AUTHENTICATOR_SET_UP_HOLD_COPY.signOut,
      AUTHENTICATOR_SET_UP_HOLD_COPY.deleteAccount,
    ]) {
      expect(entry(SET_UP).whatChanged).toContain(button);
    }
    expect(entry(KEPT).whatChanged).toContain(`"${QUEUED_EXAMPLE}"`);
    expect(entry(KEPT).howItAffectsYou).toContain(`"${PARKED}"`);
    expect(entry(DELETE).whatChanged).toContain(`"${DELETE_ACCOUNT_CONFIRM_COPY.emailCode}"`);
    expect(entry(RECEIVE).whatChanged).toContain(`"${RECEIVE_MANAGER_ONLY_COPY}"`);
    expect(entry(ACCOUNTS).whatChanged).toContain(`"${NOT_ALLOWED}"`);
  });

  it('keeps to the wording rules: no emoji, no exclamation mark, no "book", no internal names, no jargon for an authenticator app, and no link', () => {
    for (const text of readerText(release())) {
      expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
      expect(text).not.toMatch(/book/i);
      expect(text).not.toMatch(
        /\b[SB]\d{1,3}\b|docket|migration|database|\b04\d\d\b|Claude|\bAI\b|\bB2B\b/i,
      );
      expect(text).not.toMatch(/\bMFA\b|2FA|two-factor|multi-factor|\bTOTP\b|\baal[12]\b/i);
      expect(text).not.toMatch(
        /purchase_orders:read|customers:manage|stock:adjust|mfa_required|ServiceError|\b40[13]\b|\b50[03]\b|outbox|snapshot/,
      );
    }
    for (const e of release().entries) expect(e.link, e.id).toBeUndefined();
  });
});

describe('the phone authenticator set-up release: who is told', () => {
  it('names no audience on the release or on the set-up, kept changes and delete entries, and the receiving and Accounts entries their own', () => {
    expect(release().audience).toBeUndefined();
    for (const id of EVERY_MEMBER) expect(entry(id).audience, id).toBeUndefined();
    expect(entry(RECEIVE).audience).toEqual({
      anyPermission: ['purchase_orders:read'],
      modules: ['receiving'],
    });
    expect(entry(ACCOUNTS).audience).toEqual({
      anyPermission: ['customers:manage'],
      modules: ['b2b_portal'],
    });
  });

  it('tells every member the set-up entries, whoever can open a purchase order the receiving entry, and whoever manages customer accounts the Accounts entry', () => {
    expect(shownEntries(owner)).toEqual([...EVERY_MEMBER, RECEIVE, ACCOUNTS]);
    expect(shownEntries(admin)).toEqual([...EVERY_MEMBER, RECEIVE, ACCOUNTS]);
    expect(shownEntries(manager)).toEqual([...EVERY_MEMBER, RECEIVE, ACCOUNTS]);
    expect(shownEntries(staff)).toEqual([...EVERY_MEMBER, RECEIVE]);
    expect(shownEntries(member)).toEqual([...EVERY_MEMBER, RECEIVE]);
    expect(shownEntries(managerNoModules)).toEqual(EVERY_MEMBER);
    expect(shownEntries(staffNoPoRead)).toEqual(EVERY_MEMBER);
  });

  it('is the first notice for every member, the count start access check release is next for whoever that reaches and the export, receipt and access release for the rest, and an old phone build lists it first', () => {
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
    const read = {
      release_id: ID,
      revision: 1,
      dismissed_at: null,
      opened_at: '2026-11-21T02:32:00Z',
      read_at: '2026-11-21T02:32:00Z',
    };
    // Re-pinned by docs/whats-new-blocked-activity (2026-11-21; was: every reader's first notice is this release): the Blocked activity release is published later, at the top, and its audience is the owner and admin roles, so for those two it is the first notice and a read of it brings back this one; every other reader's first notice is the one it was.
    const blockedFirst = (v: ReleaseViewer) => v === owner || v === admin;
    for (const v of [owner, admin, manager, staff, member, managerNoModules, staffNoPoRead]) {
      // Added by docs/whats-new-sign-in-alerts-and-reader (2026-11-22): the sign-in alerts release is published later, at the top; its first entry has no audience, so it is every member's first notice, and the checks below start with it read.
      expect(buildReleaseList(RELEASES, v, [], null).latestUnread?.id, v.role).toBe(PHONE_LARGE_ID);
      expect(buildReleaseList(RELEASES, v, [phoneLargeRead, signInRead], null).latestUnread?.id, v.role).toBe(blockedFirst(v) ? BLOCKED_CURRENT_ID : ID);
      expect(buildReleaseList(RELEASES, v, [phoneLargeRead, signInRead, blockedCurrentRead, blockedRead], null).latestUnread?.id, v.role).toBe(ID);
      expect(legacyAnnouncementsFor(RELEASES, v, { [PHONE_LARGE_ID]: true, [SIGNIN_ID]: true, [BLOCKED_CURRENT_ID]: true, [BLOCKED_ID]: true })[0], v.role).toEqual({
        id: ID,
        date: release().publishedAt.slice(0, 10),
        title: release().title,
        body: release().summary,
      });
    }
    // Re-pinned by docs/whats-new-blocked-activity (2026-11-21; was: without it): the Blocked activity release is read first, so the notices after it are the ones this test checked before.
    // The count start release reaches a manager or above who can assign
    // counts where Cycle Counts is on: the owner here.
    expect(buildReleaseList(RELEASES, owner, [phoneLargeRead, signInRead, blockedCurrentRead, blockedRead, read], null).latestUnread?.id).toBe(
      COUNT_START_ACCESS_ID,
    );
    for (const v of [admin, manager, staff, member, managerNoModules, staffNoPoRead]) {
      expect(buildReleaseList(RELEASES, v, [phoneLargeRead, signInRead, blockedCurrentRead, blockedRead, read], null).latestUnread?.id, v.role).toBe(
        EXPORT_RECEIPT_ACCESS_ID,
      );
    }
  });
});

describe('the phone authenticator set-up release: the code the words rest on', () => {
  it('who is held: everyone under Required for everyone, owners and admins under Required for admins, as the website labels them', () => {
    for (const role of ROLES) {
      expect(policyRequiresAuthenticator('all_required', role), role).toBe(true);
      expect(policyRequiresAuthenticator('optional', role), role).toBe(false);
      expect(policyRequiresAuthenticator('admins_required', role), role).toBe(
        role === 'owner' || role === 'admin',
      );
    }
    expect(ROLE_LABELS.admin.label).toBe('Super Admin');
    const editor = source('apps/web/src/components/settings/mfa-policy-editor.tsx');
    for (const label of ['Optional', 'Required for admins', 'Required for everyone']) {
      expect(editor).toContain(`label: '${label}',`);
    }
    const hold = source('apps/mobile/src/lib/set-up-hold.ts');
    expect(hold).toContain(
      'if (!policyRequiresAuthenticator(inputs.policy, inputs.role)) return null;',
    );
    expect(hold).toContain("return hasVerified ? null : 'owed';");
  });

  it('the app shows the set-up screen in place of everything else, after the code screen and the lock, and loads nothing for it', () => {
    const layout = source('apps/mobile/app/_layout.tsx');
    expect(layout).toContain(
      'const dataUser = session && !mfaRequired && !setUpHold ? session.user : null;',
    );
    expect(layout).toContain('  if (session && setUpHold) {');
    expect(layout).toContain('return <AuthenticatorSetUpScreen state={setUpHold} />;');
    expect(layout.indexOf('return <BiometricLockScreen />;')).toBeLessThan(
      layout.indexOf('return <AuthenticatorSetUpScreen state={setUpHold} />;'),
    );
    expect(source('apps/mobile/src/lib/sync.ts')).toContain(
      '  if (setUpHoldIn(liveUserId)) return null;',
    );
  });

  it('the screen has the quoted heading, the organization sentence and the five actions, with Set up on the website only when set-up is owed and Switch workspace only with another organization', () => {
    expect(AUTHENTICATOR_SET_UP_TITLE).toBe('Set up an authenticator to continue');
    expect(authenticatorSetUpHoldBody('North Depot', 'all_required')).toBe(
      `North Depot asks everyone to use an authenticator app. ${SET_UP_TAIL}`,
    );
    expect(authenticatorSetUpHoldBody('North Depot', 'admins_required')).toBe(
      `North Depot asks owners and admins to use an authenticator app. ${SET_UP_TAIL}`,
    );
    expect(AUTHENTICATOR_SET_UP_HOLD_COPY).toMatchObject({
      setUpOnWebsite: 'Set up on the website',
      checkAgain: 'Check again',
      switchWorkspace: 'Switch workspace',
      signOut: 'Sign out',
      deleteAccount: 'Delete my account',
    });
    expect(AUTHENTICATOR_SET_UP_URL).toBe('/dashboard/settings/security?enroll=1');
    const screen = source('apps/mobile/src/components/authenticator-set-up-screen.tsx');
    expect(screen).toContain('Linking.openURL(webLink(AUTHENTICATOR_SET_UP_URL))');
    const owedOnly = screen.indexOf("{state === 'owed' ? (");
    expect(owedOnly).toBeGreaterThan(0);
    expect(owedOnly).toBeLessThan(
      screen.indexOf('{AUTHENTICATOR_SET_UP_HOLD_COPY.setUpOnWebsite}'),
    );
    const others = screen.indexOf('{others.length > 0 ? (');
    expect(others).toBeGreaterThan(0);
    expect(others).toBeLessThan(screen.indexOf('{AUTHENTICATOR_SET_UP_HOLD_COPY.switchWorkspace}'));
    for (const key of ['checkAgain', 'signOut', 'deleteAccount']) {
      expect(screen).toContain(`{AUTHENTICATOR_SET_UP_HOLD_COPY.${key}}`);
    }
  });

  it('could not check: the heading, when it shows, and the check again every 30 seconds while it is up', () => {
    const copy = source('packages/core/src/auth/set-up-copy.ts');
    expect(copy).toContain(`title: '${UNCHECKED_TITLE}',`);
    const hold = source('apps/mobile/src/lib/set-up-hold.ts');
    expect(hold).toContain("return membershipsFrom === 'this-run' ? 'unknown' : null;");
    expect(hold).toContain('export const SET_UP_RECHECK_INTERVAL_MS = 30_000;');
    expect(hold).toContain("if (setUpHoldFor(sessionUser) === 'unknown') return true;");
    const auth = source('apps/mobile/src/lib/auth-context.tsx');
    expect(auth).toContain('}, SET_UP_RECHECK_INTERVAL_MS);');
    expect(auth).toContain("if (state === 'active') void readSetUpInputsForHold(setUpReadFor);");
  });

  it("the server sends that member none of the organization's records: every API read answers with the set-up reason first", () => {
    const reads = source('apps/web/src/server/lib/api-read-context.ts');
    expect(reads).toContain('message: AUTHENTICATOR_SET_UP_OWED_COPY,');
    expect(reads).toContain("details: { reason: 'mfa_required' },");
    expect(reads).toContain('status: 403,');
    expect(AUTHENTICATOR_SET_UP_OWED_COPY).toBe(
      'Your organization requires an authenticator for your account. Set one up on the website, then try again.',
    );
  });

  it('kept changes: a change for a workspace that owes set-up is held, the authenticator answer is never final, and the screen counts what waits', () => {
    expect(source('apps/mobile/src/lib/outbox-scope.ts')).toContain(
      "if (setUpOwedIn(live.userId, orgId) === 'owed') return { send: false, reason: 'set-up-owed' };",
    );
    const drain = source('apps/mobile/src/lib/drain-failure.ts');
    expect(drain).toContain(
      "if (reason !== null && AUTHENTICATOR_REASONS.has(reason)) return 'failed';",
    );
    expect(drain).toContain(
      'const DEFINITIVE_REFUSALS: ReadonlySet<number> = new Set([400, 409, 422]);',
    );
    const hold = source('apps/mobile/src/lib/set-up-hold.ts');
    expect(hold).toContain(
      "const head = `${count} ${one ? 'change has' : 'changes have'} not synced.`;",
    );
    expect(hold).toContain(
      ': `${head} They stay on this phone and are sent after you set up your authenticator.`;',
    );
    expect(source('apps/mobile/src/components/authenticator-set-up-screen.tsx')).toContain(
      'const queued = setUpHoldQueuedLine(state, waiting);',
    );
    const parked = source('apps/mobile/src/lib/parked-set-up-words.ts');
    expect(parked).toContain(`  '${PARKED}';`);
    expect(source('apps/mobile/src/lib/queue.ts')).toContain('lastError: shownLastError({');
  });

  it('delete: the screen opens the delete sheet, which asks an account with no authenticator for its password or an emailed code, and Settings keeps its own', () => {
    expect(source('apps/mobile/src/components/authenticator-set-up-screen.tsx')).toContain(
      'const deleteAccount = useDeleteAccountConfirm({ signOut });',
    );
    const sheet = source('apps/mobile/src/components/delete-account-confirm-sheet.tsx');
    expect(sheet).toContain('Delete your account?');
    expect(sheet).toContain('Type DELETE to confirm');
    expect(sheet).toContain('{CORE_DELETE_CONFIRM_WORDS.emailCode}');
    expect(source('apps/mobile/src/lib/account-delete.ts')).toContain(
      "const firstMethod: AccountDeleteMethod = opts.hasAuthenticator ? 'authenticator' : 'password';",
    );
    expect(DELETE_ACCOUNT_CONFIRM_COPY.emailCode).toBe('Email me a code instead');
    expect(DELETE_ACCOUNT_CONFIRM_COPY.codeSent).toContain('six-digit code to your sign-in email');
    expect(DELETE_ACCOUNT_CONFIRM_COPY.codeSent).toContain('It works for 10 minutes.');
    expect(DELETE_ACCOUNT_NEWEST_CODE_ONLY_COPY).toBe(
      'If you ask again, only the newest code works.',
    );
    expect(source('apps/mobile/app/(drawer)/settings.tsx')).not.toContain(
      'delete-account-confirm-sheet',
    );
  });

  it('receiving: Scan, the quantities and Post receipt follow core canPostReceipt, and staff read the manager sentence', () => {
    const gate = source('apps/mobile/src/lib/cta-gating.ts');
    expect(gate).toContain(
      'return canPostReceipt(perms === undefined ? { role } : { role, permissions: perms });',
    );
    expect(gate).toContain('return RECEIVE_MANAGER_ONLY_COPY;');
    const po = source('apps/mobile/app/po/[id].tsx');
    expect(po).toContain('const canReceive = showReceiveCta(role, permissions);');
    expect(po).toContain('const readOnly = reviewOnly || !canReceive;');
    expect(po).toContain('<Metric label="Ordered" value={l.quantity_ordered} />');
    expect(po).toContain('<Metric label="Already" value={l.quantity_received} />');
    expect(RECEIVE_MANAGER_ONLY_COPY).toBe('Only a manager can receive purchase orders.');
  });

  it("Accounts: archive and restore go through the status route, whose service records the change, and the alert has the screen's own sentences", () => {
    const status = source('apps/mobile/src/lib/customer-status.ts');
    expect(status).toContain(
      'return `/api/v1/customers/${encodeURIComponent(customerId)}/status`;',
    );
    expect(status).toContain("method: 'PATCH',");
    expect(status).toContain("export const CUSTOMER_STATUS_FAILED_TITLE = 'Could not update';");
    expect(status).toContain(`notAllowed: '${NOT_ALLOWED}',`);
    const screen = source('apps/mobile/app/(drawer)/customers.tsx');
    expect(screen).toContain('outcome = await changeCustomerStatus(');
    expect(screen).not.toContain('.update({ status');
    expect(source('apps/web/src/server/services/customers.ts')).toContain(
      "action: status === 'archived' ? 'customer_archived' : 'customer_restored',",
    );
  });

  it('what was left out: a 1.4.0 phone keeps its launch look, the hand-out rule asks the same role as before, and the phone does not reverse receipts', () => {
    expect(source('apps/mobile/src/lib/launch-look.ts')).toContain(
      "export const LAST_ICON_LAUNCH_RUNTIME = '1.4.0';",
    );
    expect(source('apps/mobile/app.config.ts')).toContain("version: '1.4.0',");
    for (const role of ROLES) expect(roleCanHandOutKits(role), role).toBe(isManagerOrAbove(role));
    expect(source('apps/mobile/app/po/[id].tsx')).not.toMatch(/revers/i);
  });
});

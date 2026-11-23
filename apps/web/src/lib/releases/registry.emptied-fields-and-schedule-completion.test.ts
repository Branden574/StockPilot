import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  PERMISSIONS,
  releaseSchema,
  ROLE_PERMISSIONS,
  roleCanHandOutKits,
  type ModuleId,
  type Release,
  type ReleaseViewer,
} from '@stockpilot/core';

import { buildReleaseList, legacyAnnouncementsFor, visibleReleases } from './logic';
import { RELEASES } from './registry';

/**
 * Added by docs/whats-new-emptied-fields-and-schedule-completion (2026-11-16):
 * the What's New for #595 (squash c05cf8ffa, live in production since
 * 2026-11-16 12:10:47Z) and #597 (squash 0a6215d57, live since 12:32:17Z),
 * published at the top, below the Liquid Glass draft and above the
 * Integrations and schedule event release. Web only: no phone update and no
 * migration. Its own file, so the release tests other open branches edit stay
 * as they are.
 */
const ID = 'emptied-fields-and-schedule-completion-2026-11';
const SCHEDULE_ENTRY = 'schedule-complete-kit-warehouse-refused';
const SUPPLIER_ENTRY = 'supplier-emptied-field-cleared';
const CHARTER_WAREHOUSE_ENTRY = 'charter-warehouse-emptied-field-cleared';
const LOCATION_ENTRY = 'location-emptied-notes-cleared';
const CATEGORY_ENTRY = 'category-emptied-description-cleared';
const ENTRY_IDS = [
  SCHEDULE_ENTRY,
  SUPPLIER_ENTRY,
  CHARTER_WAREHOUSE_ENTRY,
  LOCATION_ENTRY,
  CATEGORY_ENTRY,
];
const CONNECTION_SCHEDULE_ID = 'connection-and-schedule-messages-2026-11';
// Added by docs/releases-low-critical-pages (2026-11-18): the Low + critical pages and list value release (whoever can read items: every role by default), published later, at the top, below the Liquid Glass draft.
const LOW_CRITICAL_ID = 'low-critical-pages-and-list-value-2026-11';
const lowCriticalRead = {
  release_id: LOW_CRITICAL_ID,
  revision: 1,
  dismissed_at: null,
  opened_at: '2026-11-18T10:01:00Z',
  read_at: '2026-11-18T10:01:00Z',
};
// Added by docs/whats-new-2026-11-19-errors (2026-11-19): the count start access check release (a manager or above who can assign counts, where Cycle Counts is on), published later, at the top, below the Liquid Glass draft.
const COUNT_START_ACCESS_ID = 'count-start-access-check-2026-11';
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
// Added by docs/whats-new-small-fixes-1119 (2026-11-19): the export, receipt and access release (every member: its access entry has no audience), published later, at the top, below the Liquid Glass draft.
const EXPORT_RECEIPT_ACCESS_ID = 'export-receipt-access-fixes-2026-11';
const exportReceiptAccessRead = {
  release_id: EXPORT_RECEIPT_ACCESS_ID,
  revision: 1,
  dismissed_at: null,
  opened_at: '2026-11-19T15:31:00Z',
  read_at: '2026-11-19T15:31:00Z',
};
// Added by docs/whats-new-receiving-shown-to-managers (2026-11-19): the receiving release (whoever can open a purchase order where Receiving is on), published later, at the top, below the Liquid Glass draft.
const RECEIVING_ID = 'receiving-shown-to-managers-2026-11';
const DELETE_CONFIRM_ID = 'delete-account-confirm-2026-11';
const PUBLISHED_AT = '2026-11-16T12:33:00Z';
const LIVE_595 = '2026-11-16T12:10:47Z';
const LIVE_597 = '2026-11-16T12:32:17Z';
const SUPPLIERS_LINK = { href: '/dashboard/suppliers', label: 'Open Suppliers' };
const LOCATIONS_LINK = { href: '/dashboard/locations', label: 'Open Locations' };
const CATEGORIES_LINK = { href: '/dashboard/categories', label: 'Open Categories' };

/** The sentences server/services/schedule.ts answers, as the reader text quotes them. */
// Added by bundles/hand-out-follows-the-manager-rule (2026-11-16): revision 2 quotes the role refusal Mark complete answers.
const COMPLETE_ROLE_REFUSED =
  "You can't complete this event because its kit has to be handed out by a manager. Ask a manager to complete it.";
// Re-pinned by bundles/hand-out-follows-the-manager-rule (2026-11-16; was: quoted by the reader text): the warehouse refusal of completing, which revision 2 does not quote (nobody reads it from Mark complete); the code still holds it, after the role check.
const COMPLETE_REFUSED =
  "You can't complete this event because you don't have write access to the warehouse its kit comes from. Ask a manager to complete it, or to give you access to that warehouse.";
const EVENT_WAREHOUSE_REFUSED =
  "You don't have write access to the warehouse set for this event, so nothing was saved. Choose a warehouse you work in, or ask a manager.";
const KIT_WAREHOUSE_REFUSED =
  "You don't have write access to the warehouse this event's kit comes from, so nothing was saved. Choose a warehouse you work in, or ask a manager.";
const UPDATE_REFUSED = "You can't change this event. Ask a manager.";

const release = () => RELEASES.find((r) => r.id === ID)!;
const entry = (id: string) => release().entries.find((e) => e.id === id)!;

const viewer = (
  role: ReleaseViewer['role'],
  permissions: ReleaseViewer['permissions'],
  enabledModules: ModuleId[] = [],
): ReleaseViewer => ({ role, permissions, enabledModules });
const both: ModuleId[] = ['suppliers', 'schedule'];
const owner = viewer('owner', [...PERMISSIONS], both);
const admin = viewer('admin', ROLE_PERMISSIONS.admin, both);
const manager = viewer('manager', ROLE_PERMISSIONS.manager, both);
const staff = viewer('staff', ROLE_PERMISSIONS.staff, both);
const member = viewer('viewer', ROLE_PERMISSIONS.viewer, both);
const scheduleOnly = viewer('staff', ['schedule:manage'], ['schedule']);
const suppliersOnly = viewer('staff', ['suppliers:manage'], ['suppliers']);
const organizationOnly = viewer('staff', ['organization:update']);
const locationsOnly = viewer('staff', ['locations:manage']);
const categoriesOnly = viewer('staff', ['categories:manage']);
const shown = (v: ReleaseViewer) => visibleReleases(RELEASES, v).find((r) => r.id === ID);

const REPO = resolve(__dirname, '../../../../..');
/** A source file in the repository, as written. */
const source = (rel: string) => readFileSync(resolve(REPO, rel), 'utf8');
const WEB = 'apps/web/src';
const DASHBOARD = `${WEB}/app/(dashboard)/dashboard`;

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

describe('the emptied fields and schedule completion release: order, status and date', () => {
  // Re-pinned by bundles/hand-out-follows-the-manager-rule (2026-11-16; was: as revision 1): the release is told again as revision 2; its place and date stay.
  // Re-pinned by docs/releases-low-critical-pages (2026-11-18; was: directly below the Liquid Glass draft, the newest published release): the Low + critical pages and list value release is published later, at the top, directly below the Liquid Glass draft.
  it('is published once, as revision 2, directly below the Low + critical pages and list value release (published later, below the Liquid Glass draft at the top) and above the Integrations and schedule event release', () => {
    expect(RELEASES.filter((r) => r.id === ID)).toHaveLength(1);
    expect(release().status).toBe('published');
    expect(release().revision).toBe(2);
    expect(release().withdrawnNote).toBeUndefined();
    // Re-pinned by docs/releases-low-critical-pages (2026-11-18; was: RELEASES.slice(0, 5)): the Low + critical pages and list value release is published at the top, below the Liquid Glass draft, so the list takes one more.
    // Re-pinned by docs/whats-new-receiving-shown-to-managers (2026-11-19; was: RELEASES.slice(0, 6)): the receiving release is published at the top, below the Liquid Glass draft, so the list takes one more.
    // Re-pinned by docs/whats-new-small-fixes-1119 (2026-11-19; was: RELEASES.slice(0, 7)): the export, receipt and access release is published at the top, below the Liquid Glass draft, so the list takes one more.
    // Re-pinned by docs/whats-new-2026-11-19-errors (2026-11-19; was: RELEASES.slice(0, 8)): the count start access check release is published at the top, below the Liquid Glass draft, so the list takes one more.
    // Re-pinned by docs/whats-new-2026-11-21-phone (2026-11-21; was: RELEASES.slice(0, 9)): the phone authenticator set-up release is published at the top, below the Liquid Glass draft, so the list takes one more.
    // Re-pinned by docs/whats-new-blocked-activity (2026-11-21; was: RELEASES.slice(0, 10)): the Blocked activity release is published at the top, below the Liquid Glass draft, so the list takes one more.
    // Re-pinned by docs/whats-new-recovery-code (2026-11-23; was: RELEASES.slice(0, 13)): the recovery code release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    expect(RELEASES.slice(0, 14).map((r) => [r.id, r.status])).toEqual([
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
      // Re-pinned by docs/whats-new-small-fixes-1119 (2026-11-19; was: without it): the export, receipt and access release is published later, at the top, directly below the Liquid Glass draft.
      [EXPORT_RECEIPT_ACCESS_ID, 'published'],
      // Re-pinned by docs/whats-new-receiving-shown-to-managers (2026-11-19; was: without it): the receiving release is published later, at the top, directly below the Liquid Glass draft.
      [RECEIVING_ID, 'published'],
      // Re-pinned by docs/releases-low-critical-pages (2026-11-18; was: without it): the Low + critical pages and list value release is published later, at the top, directly below the Liquid Glass draft.
      [LOW_CRITICAL_ID, 'published'],
      [ID, 'published'],
      [CONNECTION_SCHEDULE_ID, 'published'],
      [DELETE_CONFIRM_ID, 'published'],
    ]);
    // Re-pinned by docs/releases-low-critical-pages (2026-11-18; was: ID): the Low + critical pages and list value release is published after it, at the top, the newest published release.
    // Re-pinned by docs/whats-new-receiving-shown-to-managers (2026-11-19; was: the Low + critical pages and list value release): the receiving release is published after it, at the top, the newest published release.
    // Re-pinned by docs/whats-new-small-fixes-1119 (2026-11-19; was: the receiving release): the export, receipt and access release is published after it, at the top, the newest published release.
    // Re-pinned by docs/whats-new-2026-11-19-errors (2026-11-19; was: the export, receipt and access release): the count start access check release is published after it, at the top, the newest published release.
    // Re-pinned by docs/whats-new-2026-11-21-phone (2026-11-21; was: COUNT_START_ACCESS_ID): the phone authenticator set-up release is published after it, at the top, the newest published release.
    // Re-pinned by docs/whats-new-blocked-activity (2026-11-21; was: PHONE_SET_UP_ID): the Blocked activity release is published after it, at the top, the newest published release.
    expect(RELEASES.find((r) => r.status === 'published')?.id).toBe(RECOVERY_ID);
  });

  // Added by bundles/hand-out-follows-the-manager-rule (2026-11-16): revision 2 is told again.
  it('is told again to whoever read revision 1, and a read of revision 2 counts as read', () => {
    const readAt = (revision: number) => ({
      release_id: ID,
      revision,
      dismissed_at: null,
      opened_at: '2026-11-16T12:34:00Z',
      read_at: '2026-11-16T12:34:00Z',
    });
    // Re-pinned at the merge of main (2026-11-18; was: only this release's read rows): the Low + critical pages
    // and list value release is newer, so it is marked read here, or it would be the latest unread.
    const newerRead = { ...readAt(1), release_id: LOW_CRITICAL_ID };
    // Re-pinned by docs/whats-new-small-fixes-1119 (2026-11-19; was: without it): the export, receipt and access release is published later, at the top, and reaches every member (its access entry has no audience), so it is read or seen first, and the notice this test checks is the one it checked before.
    const newestRead = { ...readAt(1), release_id: EXPORT_RECEIPT_ACCESS_ID };
    for (const v of [owner, admin, manager, scheduleOnly, suppliersOnly]) {
      // Re-pinned by docs/whats-new-2026-11-21-phone (2026-11-21; was: without it): the phone authenticator set-up release is published later, at the top, and reaches every member (three of its five entries have no audience), an owner with every permission and module included, so it is read, seen or listed with the newer releases, and every notice this test checks is the one it checked before.
      // Re-pinned by docs/whats-new-blocked-activity (2026-11-21; was: without it): the Blocked activity release is published later, at the top, and reaches owners and Super Admins (their roles are its audience), so it is read, seen or listed with the newer releases for them, and every notice this test checks is the one it checked before. A read of a release by a reader it does not reach changes nothing.
      expect(buildReleaseList(RELEASES, v, [readAt(1), newerRead, newestRead, recoveryRead, phoneLargeRead, signInRead, blockedCurrentRead, blockedRead, phoneSetUpRead], null).latestUnread?.id, v.role).toBe(ID);
      // Re-pinned by docs/whats-new-2026-11-21-phone (2026-11-21; was: without it): the phone authenticator set-up release is published later, at the top, and reaches every member (three of its five entries have no audience), an owner with every permission and module included, so it is read, seen or listed with the newer releases, and every notice this test checks is the one it checked before.
      // Re-pinned by docs/whats-new-blocked-activity (2026-11-21; was: without it): the Blocked activity release is published later, at the top, and reaches owners and Super Admins (their roles are its audience), so it is read, seen or listed with the newer releases for them, and every notice this test checks is the one it checked before. A read of a release by a reader it does not reach changes nothing.
      expect(buildReleaseList(RELEASES, v, [readAt(2), newerRead, newestRead, recoveryRead, phoneLargeRead, signInRead, blockedCurrentRead, blockedRead, phoneSetUpRead], null).latestUnread?.id, v.role).not.toBe(
        ID,
      );
    }
    // Its place and its date are those of its first publication.
    expect(release().publishedAt).toBe(PUBLISHED_AT);
  });

  // Re-pinned by docs/releases-low-critical-pages (2026-11-18; was: with the draft placeholder at the same minute): the placeholder moved to the minute of the Low + critical pages and list value release, published later, above this one.
  it('is dated on a whole minute after #595 and #597 went live, in the past, with the draft placeholder at or after it and every release below it older', () => {
    expect(release().publishedAt).toBe(PUBLISHED_AT);
    const at = Date.parse(release().publishedAt);
    expect(at % 60_000).toBe(0);
    expect(at).toBeGreaterThan(Date.parse(LIVE_595));
    expect(at).toBeGreaterThan(Date.parse(LIVE_597));
    expect(at).toBeLessThanOrEqual(Date.now());
    // Re-pinned by docs/releases-low-critical-pages (2026-11-18; was: RELEASES[0].publishedAt equal to this release's): the placeholder is the minute of the Low + critical pages and list value release, published later, above this one.
    // Re-pinned by docs/whats-new-receiving-shown-to-managers (2026-11-19; was: the minute of the Low + critical pages and list value release, '2026-11-18T10:00:00Z'): the placeholder is the minute of the receiving release, published later, above this one.
    // Re-pinned by docs/whats-new-small-fixes-1119 (2026-11-19; was: the minute of the receiving release, '2026-11-19T05:20:00Z'): the placeholder is the minute of the export, receipt and access release, published later, above this one.
    // Re-pinned by docs/whats-new-2026-11-19-errors (2026-11-19; was: the minute of the export, receipt and access release, '2026-11-19T16:00:00Z'): the placeholder is the minute of the count start access check release, published later, above this one.
    // Re-pinned by docs/whats-new-2026-11-21-phone (2026-11-21; was: COUNT_START_ACCESS_AT): the placeholder is the minute of the phone authenticator set-up release, published later, above this one.
    // Re-pinned by docs/whats-new-blocked-activity (2026-11-21; was: PHONE_SET_UP_AT): the placeholder is the minute of the Blocked activity release, published later, above this one.
    // Re-pinned by docs/whats-new-phone-large-text (2026-11-23; was: SIGNIN_AT): the placeholder is the minute of the phone large text release, published later, above this one.
    expect(RELEASES[0]!.publishedAt).toBe(RECOVERY_AT);
    expect(Date.parse(RELEASES[0]!.publishedAt)).toBeGreaterThanOrEqual(at);
    // Re-pinned by docs/releases-low-critical-pages (2026-11-18; was: RELEASES.slice(2)): the Low + critical pages and list value release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-receiving-shown-to-managers (2026-11-19; was: RELEASES.slice(3)): the receiving release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-small-fixes-1119 (2026-11-19; was: RELEASES.slice(4)): the export, receipt and access release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-2026-11-19-errors (2026-11-19; was: RELEASES.slice(5)): the count start access check release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-2026-11-21-phone (2026-11-21; was: RELEASES.slice(6)): the phone authenticator set-up release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-blocked-activity (2026-11-21; was: RELEASES.slice(7)): the Blocked activity release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-phone-large-text (2026-11-23; was: RELEASES.slice(10)): the phone large text release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-recovery-code (2026-11-23; was: RELEASES.slice(11)): the recovery code release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    for (const r of RELEASES.slice(12)) {
      expect(at, r.id).toBeGreaterThan(Date.parse(r.publishedAt));
    }
  });

  it('parses under the shared schema, in plain text, with its five entries', () => {
    expect(releaseSchema.safeParse(release()).success).toBe(true);
    for (const text of readerText(release())) expect(text).not.toMatch(/[<>!]/);
    expect(release().entries.map((e) => [e.id, e.category, e.area])).toEqual([
      [SCHEDULE_ENTRY, 'improved', 'Schedule'],
      [SUPPLIER_ENTRY, 'fixed', 'Suppliers'],
      [CHARTER_WAREHOUSE_ENTRY, 'fixed', 'Charters and warehouses'],
      [LOCATION_ENTRY, 'fixed', 'Locations'],
      [CATEGORY_ENTRY, 'fixed', 'Categories'],
    ]);
    for (const id of ENTRY_IDS) {
      expect(RELEASES.filter((r) => r.entries.some((x) => x.id === id)).map((r) => r.id)).toEqual([
        ID,
      ]);
    }
  });
});

describe('the emptied fields and schedule completion release: the words', () => {
  it('has the title and summary as written', () => {
    expect(release().title).toBe(
      'Emptying a field and saving clears it, and clearer messages when a schedule event is not saved',
    );
    // Re-pinned by bundles/hand-out-follows-the-manager-rule (2026-11-16; was: "Mark complete on a schedule event whose kits come from a warehouse you don't have write access to now says so before anything is saved, ..."): revision 2's schedule sentence; the field sentence is as it was.
    expect(release().summary).toBe(
      'On the website, emptying an optional field when you edit a supplier, charter, warehouse, location or category, and saving, now clears it. Mark complete on a schedule event whose kits have not been handed out yet says, before anything is saved, when the event has to be completed by a manager, and the event stays In progress. The mobile app is unchanged.',
    );
  });

  // Re-pinned by bundles/hand-out-follows-the-manager-rule (2026-11-16; was: 'says what Mark complete and the event form say when a warehouse is not yours to write to, as written', with the title "Mark complete says right away when an event's kits come from a warehouse you don't have write access to", whatChanged quoting COMPLETE_REFUSED for "a schedule event whose kits will be distributed from a warehouse you don't have write access to", "A change to an event you may not change" and whatToDo "... ask a manager to make the change or to give you access to that warehouse."): revision 2's words.
  it('says who completes an event whose kits have not been handed out yet, what anyone else reads, and what the event form says, as written', () => {
    const e = entry(SCHEDULE_ENTRY);
    expect(e.title).toBe(
      'Mark complete says right away when a schedule event has to be completed by a manager',
    );
    expect(e.whatChanged).toBe(
      `On the website, a schedule event whose kits have not been handed out yet is marked complete by a manager, an admin or an owner. When anyone else chooses Mark complete on it, the event is not completed and StockPilot says: ${COMPLETE_ROLE_REFUSED}`,
    );
    expect(readerText(release()).join(' ')).not.toContain(COMPLETE_REFUSED);
    expect(e.whyItMatters).toBe(
      'You find out before anything is saved, and the event stays In progress.',
    );
    expect(e.howItAffectsYou).toBe(
      `Saving an event on New event or Edit with a warehouse you don't have write access to now says: ${EVENT_WAREHOUSE_REFUSED} For the Distribute from warehouse, the message says the warehouse this event's kit comes from. Any other change to an event you may not change says: ${UPDATE_REFUSED} Nothing is saved in each case. The mobile app is unchanged.`,
    );
    expect(e.whatToDo).toBe(
      'If you see one of these messages, choose a warehouse you work in, or ask a manager to complete the event, to make the change or to give you access to that warehouse.',
    );
    expect(e.link).toBeUndefined();
  });

  // Re-pinned by bundles/hand-out-follows-the-manager-rule (2026-11-16; was: 'claims only the warehouse access case of completing: ...', with no "handed out" anywhere): revision 2 says whose kits "have not been handed out yet" and quotes the role refusal, which says the kit "has to be handed out by a manager". Neither says completing hands a kit out; outside those two, no "hand out" wording is allowed.
  it('claims only who completes an event whose kits have not been handed out yet: never that completing always hands a kit out, nor that a completed event always has its hand-out', () => {
    const text = readerText(release()).join(' ');
    expect(text).not.toMatch(/\b(always|never|every time)\b/i);
    const rest = text
      .split(COMPLETE_ROLE_REFUSED)
      .join(' ')
      .split('whose kits have not been handed out yet')
      .join(' ');
    expect(rest).not.toMatch(/\b(hands? out|handed out|hand it out)\b/i);
    expect(text).not.toMatch(/\bdistributed when\b/i);
    expect(text).not.toMatch(/\b(completing|Mark complete) (hands|distributes)\b/i);
  });

  it('says which supplier fields an emptied value clears, as written', () => {
    const e = entry(SUPPLIER_ENTRY);
    expect(e.title).toBe('Emptying a field on a supplier and saving clears it');
    expect(e.whatChanged).toBe(
      'On the website, when you edit a supplier, empty its Contact name, Phone, Email, Website or Notes and choose Save changes, that field is now cleared.',
    );
    expect(e.whyItMatters).toBe(
      'You can remove a contact detail or a note that is out of date without typing something in its place.',
    );
    expect(e.howItAffectsYou).toBe(
      'The fields you leave as they are keep what they hold. The mobile app is unchanged.',
    );
    expect(e.whatToDo).toBe('No action needed.');
    expect(e.link).toEqual(SUPPLIERS_LINK);
  });

  it('says which charter and warehouse fields an emptied value clears, as written', () => {
    const e = entry(CHARTER_WAREHOUSE_ENTRY);
    expect(e.title).toBe('Emptying a field on a charter or a warehouse and saving clears it');
    expect(e.whatChanged).toBe(
      'On the website, when you edit a charter and empty its Code, Description, contact name, email or phone, or Internal notes, or edit a warehouse and empty its contact name, email or phone, or Notes, then choose Save changes, that field is now cleared.',
    );
    expect(e.whyItMatters).toBe(
      'You can remove a contact detail or a note that is out of date without typing something in its place.',
    );
    expect(e.howItAffectsYou).toBe(
      'The fields you leave as they are keep what they hold. The mobile app is unchanged.',
    );
    expect(e.whatToDo).toBe('No action needed.');
    expect(e.link).toBeUndefined();
  });

  it("says a location's emptied notes and a category's emptied description are cleared, as written", () => {
    const loc = entry(LOCATION_ENTRY);
    expect(loc.title).toBe("Emptying a location's notes and saving clears them");
    expect(loc.whatChanged).toBe(
      'On the website, when you edit a location, empty its Notes and choose Save changes, the notes are now cleared.',
    );
    expect(loc.whyItMatters).toBe(
      'You can remove a note that is out of date without typing something in its place.',
    );
    expect(loc.howItAffectsYou).toBe(
      'The other fields keep what they hold. The mobile app is unchanged.',
    );
    expect(loc.whatToDo).toBe('No action needed.');
    expect(loc.link).toEqual(LOCATIONS_LINK);
    const cat = entry(CATEGORY_ENTRY);
    expect(cat.title).toBe("Emptying a category's description and saving clears it");
    expect(cat.whatChanged).toBe(
      'On the website, when you edit a category, empty its Description and choose Save changes, the description is now cleared.',
    );
    expect(cat.whyItMatters).toBe(
      'You can remove a description that is out of date without typing something in its place.',
    );
    expect(cat.howItAffectsYou).toBe(
      'The other fields keep what they hold. The mobile app is unchanged.',
    );
    expect(cat.whatToDo).toBe('No action needed.');
    expect(cat.link).toEqual(CATEGORIES_LINK);
  });

  it('keeps to the wording rules: no emoji, no exclamation mark, no "book", no claim that an email was sent, no sign-in jargon, and no reason given', () => {
    for (const text of readerText(release())) {
      expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
      expect(text).not.toMatch(/\bbook/i);
      expect(text).not.toMatch(/\b(we|StockPilot) (sent|emailed|sends|emails)\b/i);
      expect(text).not.toMatch(/\b(MFA|2FA|two-factor|multi-factor)\b/i);
      expect(text).not.toMatch(/\b(gap|fix|fixed|protect|attack|exploit|bypass|vulnerab\w*)\b/i);
      expect(text).not.toMatch(/\b(phone app|mobile app) (now|gets)\b/i);
    }
  });
});

describe('the emptied fields and schedule completion release: who is told', () => {
  it('names the permission and module each page checks, on each entry, and none on the release', () => {
    expect(release().audience).toBeUndefined();
    expect(entry(SCHEDULE_ENTRY).audience).toEqual({
      anyPermission: ['schedule:manage'],
      modules: ['schedule'],
    });
    expect(entry(SUPPLIER_ENTRY).audience).toEqual({
      anyPermission: ['suppliers:manage'],
      modules: ['suppliers'],
    });
    expect(entry(CHARTER_WAREHOUSE_ENTRY).audience).toEqual({
      anyPermission: ['organization:update'],
    });
    expect(entry(LOCATION_ENTRY).audience).toEqual({ anyPermission: ['locations:manage'] });
    expect(entry(CATEGORY_ENTRY).audience).toEqual({ anyPermission: ['categories:manage'] });
  });

  it('tells each reader only the entries they can reach, and nobody else', () => {
    expect(shown(owner)?.entries.map((e) => e.id)).toEqual(ENTRY_IDS);
    expect(shown(admin)?.entries.map((e) => e.id)).toEqual(ENTRY_IDS);
    // A manager's defaults manage the schedule, suppliers, locations and
    // categories, and not the organization (charters and warehouses).
    expect(shown(manager)?.entries.map((e) => e.id)).toEqual([
      SCHEDULE_ENTRY,
      SUPPLIER_ENTRY,
      LOCATION_ENTRY,
      CATEGORY_ENTRY,
    ]);
    expect(shown(scheduleOnly)?.entries.map((e) => e.id)).toEqual([SCHEDULE_ENTRY]);
    expect(shown(suppliersOnly)?.entries.map((e) => e.id)).toEqual([SUPPLIER_ENTRY]);
    expect(shown(organizationOnly)?.entries.map((e) => e.id)).toEqual([CHARTER_WAREHOUSE_ENTRY]);
    expect(shown(locationsOnly)?.entries.map((e) => e.id)).toEqual([LOCATION_ENTRY]);
    expect(shown(categoriesOnly)?.entries.map((e) => e.id)).toEqual([CATEGORY_ENTRY]);
    expect(shown(staff)).toBeUndefined();
    expect(shown(member)).toBeUndefined();
    // With Schedule and Suppliers off, those two entries are not told, whatever the permissions.
    expect(shown(viewer('owner', [...PERMISSIONS], []))?.entries.map((e) => e.id)).toEqual([
      CHARTER_WAREHOUSE_ENTRY,
      LOCATION_ENTRY,
      CATEGORY_ENTRY,
    ]);
    expect(shown(viewer('staff', ['schedule:manage', 'suppliers:manage'], []))).toBeUndefined();
  });

  it('is the first notice for whoever it reaches, the next notice follows, and an old phone build lists it first with a link only where a linked entry is told', () => {
    const read = {
      release_id: ID,
      // Re-pinned by bundles/hand-out-follows-the-manager-rule (2026-11-16; was: revision 1): a read of revision 2.
      revision: 2,
      dismissed_at: null,
      opened_at: '2026-11-16T12:34:00Z',
      read_at: '2026-11-16T12:34:00Z',
    };
    const next: Array<[ReleaseViewer, string]> = [
      [owner, CONNECTION_SCHEDULE_ID],
      [admin, CONNECTION_SCHEDULE_ID],
      [manager, CONNECTION_SCHEDULE_ID],
      [scheduleOnly, CONNECTION_SCHEDULE_ID],
      [suppliersOnly, DELETE_CONFIRM_ID],
      [organizationOnly, DELETE_CONFIRM_ID],
      [locationsOnly, DELETE_CONFIRM_ID],
      [categoriesOnly, DELETE_CONFIRM_ID],
    ];
    // Re-pinned by docs/releases-low-critical-pages (2026-11-18; was: nothing read, and [read]): the Low + critical pages and list value release is published later, at the top, and reaches whoever can read items (owners, admins, managers, staff and viewers by default), so each reads it first, and every notice this test checks is the one it checked before.
    for (const [v, after] of next) {
      // Re-pinned by docs/whats-new-small-fixes-1119 (2026-11-19; was: without it): the export, receipt and access release is published later, at the top, and reaches every member (its access entry has no audience), so it is read or seen first, and the notice this test checks is the one it checked before.
      // Re-pinned by docs/whats-new-2026-11-21-phone (2026-11-21; was: without it): the phone authenticator set-up release is published later, at the top, and reaches every member (three of its five entries have no audience), an owner with every permission and module included, so it is read, seen or listed with the newer releases, and every notice this test checks is the one it checked before.
      // Re-pinned by docs/whats-new-blocked-activity (2026-11-21; was: without it): the Blocked activity release is published later, at the top, and reaches owners and Super Admins (their roles are its audience), so it is read, seen or listed with the newer releases for them, and every notice this test checks is the one it checked before. A read of a release by a reader it does not reach changes nothing.
      expect(buildReleaseList(RELEASES, v, [recoveryRead, phoneLargeRead, signInRead, blockedCurrentRead, blockedRead, phoneSetUpRead, exportReceiptAccessRead, lowCriticalRead], null).latestUnread?.id, v.role).toBe(ID);
      // Re-pinned by docs/whats-new-small-fixes-1119 (2026-11-19; was: without it): the export, receipt and access release is published later, at the top, and reaches every member (its access entry has no audience), so it is read or seen first, and the notice this test checks is the one it checked before.
      // Re-pinned by docs/whats-new-2026-11-21-phone (2026-11-21; was: without it): the phone authenticator set-up release is published later, at the top, and reaches every member (three of its five entries have no audience), an owner with every permission and module included, so it is read, seen or listed with the newer releases, and every notice this test checks is the one it checked before.
      // Re-pinned by docs/whats-new-blocked-activity (2026-11-21; was: without it): the Blocked activity release is published later, at the top, and reaches owners and Super Admins (their roles are its audience), so it is read, seen or listed with the newer releases for them, and every notice this test checks is the one it checked before. A read of a release by a reader it does not reach changes nothing.
      expect(buildReleaseList(RELEASES, v, [recoveryRead, phoneLargeRead, signInRead, blockedCurrentRead, blockedRead, phoneSetUpRead, exportReceiptAccessRead, lowCriticalRead, read], null).latestUnread?.id, v.role).toBe(after);
    }
    // Re-pinned by docs/releases-low-critical-pages (2026-11-18; was: nothing read): as above.
    // Re-pinned by docs/whats-new-small-fixes-1119 (2026-11-19; was: without it): the export, receipt and access release is published later, at the top, and reaches every member (its access entry has no audience), so it is read or seen first, and the notice this test checks is the one it checked before.
    // Re-pinned by docs/whats-new-2026-11-21-phone (2026-11-21; was: without it): the phone authenticator set-up release is published later, at the top, and reaches every member (three of its five entries have no audience), an owner with every permission and module included, so it is read, seen or listed with the newer releases, and every notice this test checks is the one it checked before.
    // Re-pinned by docs/whats-new-blocked-activity (2026-11-21; was: without it): the Blocked activity release is published later, at the top, and reaches owners and Super Admins (their roles are its audience), so it is read, seen or listed with the newer releases for them, and every notice this test checks is the one it checked before. A read of a release by a reader it does not reach changes nothing.
    expect(buildReleaseList(RELEASES, member, [recoveryRead, phoneLargeRead, signInRead, blockedCurrentRead, blockedRead, phoneSetUpRead, exportReceiptAccessRead, lowCriticalRead], null).latestUnread?.id).toBe(DELETE_CONFIRM_ID);
    // Re-pinned by docs/releases-low-critical-pages (2026-11-18; was: nothing seen): the Low + critical pages and list value release is published later and reaches whoever can read items, so the phone has seen it first.
    // Re-pinned by docs/whats-new-small-fixes-1119 (2026-11-19; was: without it): the export, receipt and access release is published later, at the top, and reaches every member (its access entry has no audience), so it is read or seen first, and the notice this test checks is the one it checked before.
    // Re-pinned by docs/whats-new-2026-11-21-phone (2026-11-21; was: without it): the phone authenticator set-up release is published later, at the top, and reaches every member (three of its five entries have no audience), an owner with every permission and module included, so it is read, seen or listed with the newer releases, and every notice this test checks is the one it checked before.
    // Re-pinned by docs/whats-new-blocked-activity (2026-11-21; was: without it): the Blocked activity release is published later, at the top, and reaches owners and Super Admins (their roles are its audience), so it is read, seen or listed with the newer releases for them, and every notice this test checks is the one it checked before. A read of a release by a reader it does not reach changes nothing.
    const legacy = (v: ReleaseViewer) => legacyAnnouncementsFor(RELEASES, v, { [RECOVERY_ID]: true, [PHONE_LARGE_ID]: true, [SIGNIN_ID]: true, [BLOCKED_CURRENT_ID]: true, [BLOCKED_ID]: true, [PHONE_SET_UP_ID]: true, [EXPORT_RECEIPT_ACCESS_ID]: true, [LOW_CRITICAL_ID]: true })[0];
    const base = { id: ID, date: '2026-11-16', title: release().title, body: release().summary };
    expect(legacy(owner)).toEqual({ ...base, cta: SUPPLIERS_LINK });
    expect(legacy(manager)).toEqual({ ...base, cta: SUPPLIERS_LINK });
    expect(legacy(suppliersOnly)).toEqual({ ...base, cta: SUPPLIERS_LINK });
    expect(legacy(locationsOnly)).toEqual({ ...base, cta: LOCATIONS_LINK });
    expect(legacy(categoriesOnly)).toEqual({ ...base, cta: CATEGORIES_LINK });
    expect(legacy(scheduleOnly)).toEqual(base);
    expect(legacy(organizationOnly)).toEqual(base);
  });
});

describe('the emptied fields and schedule completion release: the code the words rest on', () => {
  it('an emptied field whose record had text is sent as an empty value, and an empty field with nothing before is left out', () => {
    const helper = source(`${WEB}/lib/edited-optional-text.ts`);
    expect(helper).toContain('export function editedOptionalText(');
    expect(helper).toContain('if (value) return value;');
    expect(helper).toContain("return before ? '' : undefined;");
  });

  it('the supplier dialog sends Contact name, Phone, Email, Website and Notes through it, and update() stores an empty one as null', () => {
    const form = source(`${WEB}/components/suppliers/suppliers-manager.tsx`);
    for (const line of [
      'contactName: editedOptionalText(values.contactName, editing?.contact_name),',
      'email: editedOptionalText(values.email, editing?.email),',
      'phone: editedOptionalText(values.phone, editing?.phone),',
      'website: editedOptionalText(values.website, editing?.website),',
      'notes: editedOptionalText(values.notes, editing?.notes),',
    ]) {
      expect(form, line).toContain(line);
    }
    for (const label of ['Contact name', 'Phone', 'Email', 'Website', 'Notes', "'Save changes'"]) {
      expect(form, label).toContain(label);
    }
    const service = source(`${WEB}/server/services/suppliers.ts`);
    for (const line of [
      'updates.contact_name = patch.contactName || null;',
      'updates.email = patch.email ? patch.email.toLowerCase() : null;',
      'updates.phone = patch.phone || null;',
      'updates.website = patch.website || null;',
      'updates.notes = patch.notes || null;',
    ]) {
      expect(service, line).toContain(line);
    }
  });

  it('the charter dialog sends Code, Description, the contact boxes and Internal notes through it, not the address, and update() stores an empty one as null', () => {
    const form = source(`${WEB}/components/admin/charters-manager.tsx`);
    for (const line of [
      'code: editedOptionalText(values.code, editing?.code),',
      'description: editedOptionalText(values.description, editing?.description),',
      'notes: editedOptionalText(values.notes, editing?.notes),',
      'contactName: editedOptionalText(values.contactName, editing?.contact_name),',
      'contactEmail: editedOptionalText(values.contactEmail, editing?.contact_email),',
      'contactPhone: editedOptionalText(values.contactPhone, editing?.contact_phone),',
      'line1: values.addressLine1 || undefined,',
    ]) {
      expect(form, line).toContain(line);
    }
    for (const label of [
      'Code',
      'Description',
      'aria-label="Contact name"',
      'aria-label="Contact email"',
      'aria-label="Contact phone"',
      'Internal notes',
      "{editing ? 'Save changes'",
    ]) {
      expect(form, label).toContain(label);
    }
    const service = source(`${WEB}/server/services/charters.ts`);
    for (const line of [
      'updates.code = patch.code || null;',
      'updates.description = patch.description || null;',
      'updates.notes = patch.notes || null;',
      'updates.contact_name = patch.contactName || null;',
      'updates.contact_email = patch.contactEmail ? patch.contactEmail.toLowerCase() : null;',
      'updates.contact_phone = patch.contactPhone || null;',
    ]) {
      expect(service, line).toContain(line);
    }
  });

  it('the warehouse dialog sends the contact boxes and Notes through it, and update() stores an empty one as null', () => {
    const form = source(`${WEB}/components/admin/warehouses-manager.tsx`);
    for (const line of [
      'contactName: editedOptionalText(values.contactName, editing?.contact_name),',
      'contactEmail: editedOptionalText(values.contactEmail, editing?.contact_email),',
      'contactPhone: editedOptionalText(values.contactPhone, editing?.contact_phone),',
      'notes: editedOptionalText(values.notes, editing?.notes),',
    ]) {
      expect(form, line).toContain(line);
    }
    for (const label of [
      'aria-label="Contact name"',
      'aria-label="Contact email"',
      'aria-label="Contact phone"',
      'Notes',
      "{editing ? 'Save changes'",
    ]) {
      expect(form, label).toContain(label);
    }
    const service = source(`${WEB}/server/services/warehouses.ts`);
    for (const line of [
      'updates.contact_name = patch.contactName || null;',
      'updates.contact_email = patch.contactEmail ? patch.contactEmail.toLowerCase() : null;',
      'updates.contact_phone = patch.contactPhone || null;',
      'updates.notes = patch.notes || null;',
    ]) {
      expect(service, line).toContain(line);
    }
  });

  it('the location dialog sends Notes and the category dialog Description through it, not the colour, and update() stores an empty one as null', () => {
    const locations = source(`${WEB}/components/locations/locations-manager.tsx`);
    expect(locations).toContain('notes: editedOptionalText(values.notes, editing?.notes),');
    expect(locations).toContain("'Save changes'");
    expect(source(`${WEB}/server/services/locations.ts`)).toContain(
      'updates.notes = patch.notes || null;',
    );
    const categories = source(`${WEB}/components/categories/categories-manager.tsx`);
    expect(categories).toContain(
      'description: editedOptionalText(values.description, editing?.description),',
    );
    expect(categories).toContain('color: values.color || undefined,');
    expect(categories).toContain("'Save changes'");
    expect(source(`${WEB}/server/services/categories.ts`)).toContain(
      'updates.description = patch.description || null;',
    );
  });

  it('each field entry is told to the permission and module its page and service check', () => {
    const suppliersPage = source(`${DASHBOARD}/suppliers/page.tsx`);
    expect(suppliersPage).toContain("const moduleAccess = await checkModuleAccess('suppliers');");
    expect(suppliersPage).toContain("const canManage = can(ctx, 'suppliers:manage');");
    const suppliers = source(`${WEB}/server/services/suppliers.ts`);
    expect(suppliers).toContain("assertModuleEnabled(this.ctx, 'suppliers');");
    expect(suppliers).toContain("assertPermission(this.ctx, 'suppliers:manage');");
    expect(source(`${DASHBOARD}/admin/layout.tsx`)).toContain(
      "if (!can(ctx, 'organization:update')) redirect('/dashboard');",
    );
    for (const name of ['charters', 'warehouses']) {
      expect(source(`${WEB}/server/services/${name}.ts`), name).toContain(
        "assertPermission(this.ctx, 'organization:update');",
      );
    }
    expect(source(`${DASHBOARD}/locations/page.tsx`)).toContain(
      "const canManage = can(ctx, 'locations:manage');",
    );
    expect(source(`${WEB}/server/services/locations.ts`)).toContain(
      "assertPermission(this.ctx, 'locations:manage');",
    );
    expect(source(`${DASHBOARD}/categories/page.tsx`)).toContain(
      "const canManage = can(ctx, 'categories:manage');",
    );
    expect(source(`${WEB}/server/services/categories.ts`)).toContain(
      "assertPermission(this.ctx, 'categories:manage');",
    );
  });

  // Re-pinned by bundles/hand-out-follows-the-manager-rule (2026-11-16; was: 'completing an in progress event checks the kit warehouse before the row is written, and refuses with the sentence quoted'): the role check comes first and its sentence is the one quoted; the warehouse check follows it, before the row is written.
  it('completing an in progress event checks the role, then the kit warehouse, before the row is written, and refuses with the sentence quoted', () => {
    const service = source(`${WEB}/server/services/schedule.ts`);
    const update = service.slice(
      service.indexOf('async update(id: string, patch: UpdateScheduleEventInput)'),
    );
    expect(service).toContain(
      `const SCHEDULE_COMPLETE_KIT_HAND_OUT_REFUSED =\n  ${JSON.stringify(COMPLETE_ROLE_REFUSED)};`,
    );
    const roleCheck = update.indexOf(
      'if (kitId && kitQuantity && kitWarehouseId && !roleCanHandOutKits(this.ctx.role)) {',
    );
    expect(roleCheck).toBeGreaterThan(0);
    expect(update.slice(roleCheck)).toMatch(
      /^[^\n]*\n\s*throw new ServiceError\('forbidden', SCHEDULE_COMPLETE_KIT_HAND_OUT_REFUSED\);/,
    );
    expect(roleCheck).toBeGreaterThan(
      update.indexOf('if (completing && !distributedBefore.has(id)) {'),
    );
    expect(roleCheck).toBeLessThan(
      update.indexOf(
        'await this.assertWarehouseWrite(kitWarehouseId, SCHEDULE_COMPLETE_KIT_WAREHOUSE_REFUSED);',
      ),
    );
    // The floor the entry names: a manager, an admin or an owner.
    expect(
      (['owner', 'admin', 'manager', 'staff', 'viewer'] as const).filter(roleCanHandOutKits),
    ).toEqual(['owner', 'admin', 'manager']);
    expect(service).toContain(
      `const SCHEDULE_COMPLETE_KIT_WAREHOUSE_REFUSED =\n  ${JSON.stringify(COMPLETE_REFUSED)};`,
    );
    expect(update).toContain(
      "const completing = patch.status === 'completed' && beforeStatus === 'in_progress';",
    );
    expect(update).toContain('if (completing && !distributedBefore.has(id)) {');
    expect(update).toContain(
      'if (kitId && kitQuantity && kitWarehouseId && kitWarehouseId !== patch.bundleWarehouseId) {',
    );
    const check = update.indexOf(
      'await this.assertWarehouseWrite(kitWarehouseId, SCHEDULE_COMPLETE_KIT_WAREHOUSE_REFUSED);',
    );
    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(update.indexOf('.update(updates)'));
    expect(service).toContain("throw new ServiceError('forbidden', refusal);");
  });

  it('Mark complete sends only the status, for an in progress event, and shows the refusal as written', () => {
    const actions = source(`${WEB}/components/schedule/schedule-status-actions.tsx`);
    expect(actions).toContain("if (currentStatus === 'in_progress') {");
    expect(actions).toContain("onClick={() => flip('completed', 'Event marked complete.')}");
    expect(actions).toContain(
      'const res = await updateScheduleEventAction(eventId, { status: next });',
    );
    expect(actions).toContain('toast.error(res.error.message);');
    expect(actions).toContain('Mark complete');
    const serverActions = source(`${WEB}/server/actions/schedule.ts`);
    expect(serverActions).toContain('await svc.update(id, parsed.data);');
    expect(serverActions).toContain("return actionErrorResult(error, 'actions.schedule');");
    expect(source(`${WEB}/server/lib/action-error-result.ts`)).toContain(
      'return err(e.code, e.message, details);',
    );
    const page = source(`${DASHBOARD}/schedule/[id]/page.tsx`);
    expect(page).toContain("const moduleAccess = await checkModuleAccess('schedule');");
    expect(page).toContain("const canManage = can(ctx, 'schedule:manage');");
    expect(page).toContain('<ScheduleStatusActions eventId={id} currentStatus={event.status} />');
    expect(page).toContain("in_progress: 'In progress',");
    expect(page).toContain('be distributed from {bundleWarehouseName ?? ');
    expect(page).toContain('when this event is marked');
  });

  it('New event and Edit send the event warehouse and the Distribute from warehouse, and their refusals and an update with no row back read as quoted', () => {
    const service = source(`${WEB}/server/services/schedule.ts`);
    expect(service).toContain(
      `const SCHEDULE_EVENT_WAREHOUSE_REFUSED =\n  ${JSON.stringify(EVENT_WAREHOUSE_REFUSED)};`,
    );
    expect(service).toContain(
      `const SCHEDULE_KIT_WAREHOUSE_REFUSED =\n  ${JSON.stringify(KIT_WAREHOUSE_REFUSED)};`,
    );
    expect(service).toContain(
      `const SCHEDULE_EVENT_UPDATE_REFUSED = ${JSON.stringify(UPDATE_REFUSED)};`,
    );
    for (const line of [
      'await this.assertWarehouseWrite(input.warehouseId, SCHEDULE_EVENT_WAREHOUSE_REFUSED);',
      'await this.assertWarehouseWrite(input.bundleWarehouseId, SCHEDULE_KIT_WAREHOUSE_REFUSED);',
      'await this.assertWarehouseWrite(patch.warehouseId, SCHEDULE_EVENT_WAREHOUSE_REFUSED);',
      'await this.assertWarehouseWrite(patch.bundleWarehouseId, SCHEDULE_KIT_WAREHOUSE_REFUSED);',
      "if (!data) throw new ServiceError('forbidden', SCHEDULE_EVENT_UPDATE_REFUSED);",
    ]) {
      expect(service, line).toContain(line);
    }
    const form = source(`${WEB}/components/schedule/schedule-event-form.tsx`);
    expect(form).toContain('warehouseId: warehouseId || null,');
    expect(form).toContain('bundleWarehouseId: wantsBundle ? bundleWarehouseId : null,');
    expect(form).toContain('Distribute from warehouse');
    expect(form).toContain('toast.error(res.error.message);');
    expect(form).toContain("{isEdit ? 'Save changes' : 'Create event'}");
    expect(source(`${DASHBOARD}/schedule/new/page.tsx`)).toContain(
      "if (!can(ctx, 'schedule:manage')) notFound();",
    );
    const edit = source(`${DASHBOARD}/schedule/[id]/edit/page.tsx`);
    expect(edit).toContain("const moduleAccess = await checkModuleAccess('schedule');");
    expect(edit).toContain("if (!can(ctx, 'schedule:manage')) notFound();");
  });

  it('the mobile app has no Mark complete and does not change events, so it is unchanged', () => {
    const list = source('apps/mobile/app/(drawer)/schedule.tsx');
    expect(list).not.toContain('Mark complete');
    expect(list).not.toContain('.update(');
    const phoneNew = source('apps/mobile/app/schedule/new.tsx');
    expect(phoneNew).toContain(".from('schedule_events').insert(");
    expect(phoneNew).not.toContain('Mark complete');
  });
});

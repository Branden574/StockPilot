import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  hasPermission,
  isManagerOrAbove,
  MODULE_REGISTRY,
  PERMISSIONS,
  releaseSchema,
  ROLE_PERMISSIONS,
  type ModuleId,
  type Release,
  type ReleaseViewer,
} from '@stockpilot/core';

import { countReadScope, mayReadCount } from '@/lib/auth/count-read-scope';

import { buildReleaseList, visibleReleases } from './logic';
import { RELEASES } from './registry';

// Added by docs/releases-low-critical-pages (2026-11-18): the Low + critical pages and list value release (whoever can read items: every role by default), published later, at the top, below the Liquid Glass draft.
const LOW_CRITICAL_ID = 'low-critical-pages-and-list-value-2026-11';
// Added by docs/whats-new-2026-11-19-errors (2026-11-19): the count start access check release (a manager or above who can assign counts, where Cycle Counts is on), published later, at the top, below the Liquid Glass draft.
const COUNT_START_ACCESS_ID = 'count-start-access-check-2026-11';
// Added by docs/whats-new-2026-11-21-phone (2026-11-21): the phone authenticator set-up release (every member: three of its five entries have no audience), published later, at the top, below the Liquid Glass draft.
// Added by docs/whats-new-blocked-activity (2026-11-21): the Blocked activity release (owners and Super Admins), published later, at the top, below the Liquid Glass draft.
const BLOCKED_ID = 'blocked-activity-2026-11';
const BLOCKED_CURRENT_ID = 'blocked-activity-current-password-and-set-up-code-2026-11';
const SIGNIN_ID = 'sign-in-alerts-2026-11';
const PHONE_LARGE_ID = 'phone-large-text-2026-11';
const PHONE_SET_UP_ID = 'phone-authenticator-set-up-2026-11';
// Added by docs/whats-new-small-fixes-1119 (2026-11-19): the export, receipt and access release (every member: its access entry has no audience), published later, at the top, below the Liquid Glass draft.
const EXPORT_RECEIPT_ACCESS_ID = 'export-receipt-access-fixes-2026-11';
// Added by docs/whats-new-receiving-shown-to-managers (2026-11-19): the receiving release (whoever can open a purchase order where Receiving is on), published later, at the top, below the Liquid Glass draft.
const RECEIVING_ID = 'receiving-shown-to-managers-2026-11';

/**
 * Added by docs/whats-new-count-read-rule (2026-11-15): the cycle counts
 * release for #558 (squash 29cb97190, web only, no phone update, no
 * migration), published at the top, directly below the Liquid Glass draft.
 * Two entries, for organizations with Cycle counts on:
 *
 *  - a viewer who can open Cycle counts sees their warehouses' counts in the
 *    count list (whoever can open Cycle counts);
 *  - a count with no warehouse of its own shows to the person it is assigned
 *    to (whoever can open Cycle counts or assigns counts).
 *
 * The other change of #558, the Email card in Settings, Profile, is its own
 * release for every organization (email-change-expired-2026-11,
 * registry.email-change-expired.test.ts). Both share one minute; this one is
 * the newer of the two, so it is the notice for a reader both reach. Its own
 * file, so the release tests other open branches edit stay as they are.
 *
 * Re-pinned by docs/whats-new-unreadable-access-and-settings (2026-11-15): the
 * settings and module check releases are published later, directly above this
 * release and below the Liquid Glass draft. Each changed line has its own note.
 *
 * Re-pinned by docs/whats-new-navigation-keeps-choices (2026-11-15): the
 * navigation release is published later still, directly below the draft and
 * above the settings release. Each changed line has its own note.
 */
const ID = 'count-read-rule-2026-11';
const LIST_ID = 'count-list-shows-readable-warehouses';
const ASSIGNEE_ID = 'count-without-warehouse-follows-assignee';
const EMAIL_RELEASE_ID = 'email-change-expired-2026-11';
const PHONE_SCREENS_ID = 'phone-screens-by-access-2026-11';
// Added by docs/whats-new-unreadable-access-and-settings (2026-11-15): the settings release (whoever can open the settings pages and panels it names) and the module check release (every member), published later, directly above this one.
const SETTINGS_ID = 'settings-not-loaded-2026-11';
const MODULE_CHECK_ID = 'module-check-try-again-2026-11';
// Added by docs/whats-new-navigation-keeps-choices (2026-11-15): the navigation release (owners and admins who can open Settings, Navigation), published later, directly above the settings release.
const NAVIGATION_ID = 'navigation-keeps-choices-2026-11';
// Added by docs/whats-new-invitation-audit (2026-11-15): the invitation audit release (whoever can view the audit log), published later, directly above the navigation release.
// Added by docs/whats-new-api-key-audit (2026-11-15): the API key audit release (whoever can view the audit log), published later, directly above the invitation audit release.
const API_KEY_AUDIT_ID = 'api-key-audit-2026-11';
// Added by docs/whats-new-authenticator-set-up-first (2026-11-15): the authenticator set-up release (every member: its entry has no audience), published later, at the top, below the Liquid Glass draft.
const AUTH_SET_UP_ID = 'authenticator-set-up-first-2026-11';
// Added by docs/whats-new-delete-account-confirm (2026-11-16): the delete account release (every member: its entry has no audience), published later, at the top, below the Liquid Glass draft.
const DELETE_CONFIRM_ID = 'delete-account-confirm-2026-11';
// Added by docs/whats-new-integrations-message-and-api-key-rows (2026-11-16): the Integrations and schedule event release (whoever can manage integrations where Integrations is on, and whoever can manage the schedule where Schedule is on), published later, at the top, below the Liquid Glass draft.
const CONNECTION_SCHEDULE_ID = 'connection-and-schedule-messages-2026-11';
// Added by docs/whats-new-emptied-fields-and-schedule-completion (2026-11-16): the emptied fields and schedule completion release (owners and admins, managers for its location and category entries, and whoever manages the schedule or suppliers with those modules on), published later, at the top, below the Liquid Glass draft.
const EMPTIED_FIELDS_ID = 'emptied-fields-and-schedule-completion-2026-11';
const INVITATION_AUDIT_ID = 'invitation-audit-2026-11';
// Re-pinned by docs/whats-new-navigation-keeps-choices (2026-11-15; was: without it): the navigation release is published later, at the top, so it is read with the newer releases.
// Re-pinned by docs/whats-new-invitation-audit (2026-11-15; was: without it): the invitation audit release is published later, at the top, and reaches whoever can view the audit log (owners, admins and managers by default), so it is read or seen with the newer releases, and every notice this test checks is the one it checked before. A read of a release by a reader it does not reach changes nothing.
// Re-pinned by docs/whats-new-api-key-audit (2026-11-15; was: without it): the API key audit release is published later, at the top, and reaches the same readers as the invitation audit release, so it is read or seen with it, and the notice this test checks is the one it checked before.
const newerRead = [
  // Re-pinned by docs/whats-new-authenticator-set-up-first (2026-11-15; was: without it): the authenticator set-up release is published later, at the top, and reaches every member (its entry has no audience), so it is read, seen or listed with the newer releases, and every notice this test checks is the one it checked before.
  // Re-pinned by docs/whats-new-delete-account-confirm (2026-11-16; was: without it): the delete account release is published later, at the top, and reaches every member (its entry has no audience), so it is read, seen or listed with the newer releases, and every notice this test checks is the one it checked before.
  // Re-pinned by docs/whats-new-integrations-message-and-api-key-rows (2026-11-16; was: without it): the Integrations and schedule event release is published later, at the top, and reaches whoever can manage integrations where Integrations is on and whoever can manage the schedule where Schedule is on, an owner with every permission and module included, so it is read, seen or listed with the newer releases, and every notice this test checks is the one it checked before.
  // Re-pinned by docs/whats-new-emptied-fields-and-schedule-completion (2026-11-16; was: without it): the emptied fields and schedule completion release is published later, at the top, and reaches owners and admins, managers for its location and category entries, and whoever manages the schedule or suppliers with those modules on, so it is read, seen or listed with the newer releases, and every notice this test checks is the one it checked before. A read of a release by a reader it does not reach changes nothing.
  // Re-pinned by docs/releases-low-critical-pages (2026-11-18; was: without it): the Low + critical pages and list value release is published later, at the top, and reaches whoever can read items (owners, admins, managers, staff and viewers by default), so it is read, seen or listed with the newer releases, and every notice this test checks is the one it checked before. A read of a release by a reader it does not reach changes nothing.
  // Re-pinned by docs/whats-new-2026-11-21-phone (2026-11-21; was: without it): the phone authenticator set-up release is published later, at the top, and reaches every member (three of its five entries have no audience), an owner with every permission and module included, so it is read, seen or listed with the newer releases, and every notice this test checks is the one it checked before.
  // Re-pinned by docs/whats-new-blocked-activity (2026-11-21; was: without it): the Blocked activity release is published later, at the top, and reaches owners and Super Admins (their roles are its audience), so it is read, seen or listed with the newer releases for them, and every notice this test checks is the one it checked before. A read of a release by a reader it does not reach changes nothing.
  // Re-pinned by docs/whats-new-phone-large-text (2026-11-23; was: without it): the phone large text release is published later, at the top, and reaches every member (its one entry has no audience), an owner with every permission and module included, so it is read, seen or listed with the newer releases, and every notice this test checks is the one it checked before.
  PHONE_LARGE_ID,
  SIGNIN_ID,
  BLOCKED_CURRENT_ID,
  BLOCKED_ID,
  PHONE_SET_UP_ID,
  // Re-pinned by docs/whats-new-2026-11-19-errors (2026-11-19; was: without it): the count start access check release is published later, at the top, and reaches a manager or above who can assign counts where Cycle Counts is on (an owner with every permission and module among them), so it is read, seen or listed with the newer releases, and every notice this test checks is the one it checked before. A read of a release by a reader it does not reach changes nothing.
  COUNT_START_ACCESS_ID,
  // Re-pinned by docs/whats-new-small-fixes-1119 (2026-11-19; was: without it): the export, receipt and access release is published later, at the top, and reaches every member (its access entry has no audience), so it is read, seen or listed with the newer releases, and every notice this test checks is the one it checked before. A read of a release by a reader it does not reach changes nothing.
  EXPORT_RECEIPT_ACCESS_ID,
  // Re-pinned by docs/whats-new-receiving-shown-to-managers (2026-11-19; was: without it): the receiving release is published later, at the top, and reaches whoever can open a purchase order where Receiving is on (owners, admins, managers, staff and viewers by default), so it is read, seen or listed with the newer releases, and every notice this test checks is the one it checked before. A read of a release by a reader it does not reach changes nothing.
  RECEIVING_ID,
  LOW_CRITICAL_ID,
  EMPTIED_FIELDS_ID,
  CONNECTION_SCHEDULE_ID,
  DELETE_CONFIRM_ID,
  AUTH_SET_UP_ID,
  API_KEY_AUDIT_ID,
  INVITATION_AUDIT_ID,
  NAVIGATION_ID,
  SETTINGS_ID,
  MODULE_CHECK_ID,
].map((releaseId) => ({
  release_id: releaseId,
  // Re-pinned by docs/whats-new-integrations-message-and-api-key-rows (2026-11-16; was: revision 1): the API key audit release is re-announced as revision 2, so a read of it is recorded at revision 2.
  // Re-pinned by bundles/hand-out-follows-the-manager-rule (2026-11-16; was: releaseId === 'api-key-audit-2026-11' ? 2 : 1): the emptied fields and schedule completion release is re-announced as revision 2, so a read of it is recorded at revision 2.
  revision: releaseId === 'api-key-audit-2026-11' || releaseId === EMPTIED_FIELDS_ID ? 2 : 1,
  dismissed_at: null,
  opened_at: '2026-11-15T04:30:00Z',
  read_at: '2026-11-15T04:30:00Z',
}));

const release = () => RELEASES.find((r) => r.id === ID)!;
const entry = (entryId: string) => release().entries.find((e) => e.id === entryId)!;

const viewer = (
  role: ReleaseViewer['role'],
  permissions: ReleaseViewer['permissions'],
  enabledModules: ReleaseViewer['enabledModules'],
): ReleaseViewer => ({ role, permissions, enabledModules });
const EVERY_MODULE = Object.keys(MODULE_REGISTRY) as ModuleId[];
const NO_CYCLE_COUNTS = EVERY_MODULE.filter((m) => m !== 'cycle_counts');
const owner = viewer('owner', [...PERMISSIONS], EVERY_MODULE);
const admin = viewer('admin', ROLE_PERMISSIONS.admin, EVERY_MODULE);
const staff = viewer('staff', ROLE_PERMISSIONS.staff, ['cycle_counts']);
const defaultViewer = viewer('viewer', ROLE_PERMISSIONS.viewer, ['cycle_counts']);
const member = viewer('viewer', [], []);
const entriesFor = (v: ReleaseViewer) =>
  visibleReleases(RELEASES, v)
    .find((r) => r.id === ID)
    ?.entries.map((e) => e.id) ?? [];

const REPO = resolve(__dirname, '../../../../..');
const repoFile = (rel: string) => readFileSync(resolve(REPO, rel), 'utf8');
/** A source file under apps/web/src, as written. */
const source = (rel: string) => repoFile(`apps/web/src/${rel}`);

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

describe('the count read rule release: order, status and date', () => {
  // Renamed by docs/whats-new-unreadable-access-and-settings (2026-11-15; was: "is published once, as revision 1, directly below the Liquid Glass draft and above the email change release of the same minute, the newest published release"): the settings and module check releases are published later, directly below the draft and above this one, and the settings release is the newest published. Claim kept: published once, as revision 1, directly above the email change release of the same minute.
  // Renamed by docs/whats-new-navigation-keeps-choices (2026-11-15; was: "is published once, as revision 1, directly below the settings and module check releases (published later, below the Liquid Glass draft at the top) and above the email change release of the same minute"): the navigation release is published later still, above the settings release. Claim kept: published once, as revision 1, directly above the email change release of the same minute.
  it('is published once, as revision 1, directly below the navigation, settings and module check releases (published later, below the Liquid Glass draft at the top) and above the email change release of the same minute', () => {
    expect(RELEASES.filter((r) => r.id === ID)).toHaveLength(1);
    expect(release().status).toBe('published');
    expect(release().revision).toBe(1);
    expect(release().withdrawnNote).toBeUndefined();
    // Re-pinned by docs/whats-new-unreadable-access-and-settings (2026-11-15; was: RELEASES.slice(0, 5), without them): the settings and module check releases are published later, at the top, directly below the Liquid Glass draft, so every position below them moves down by two.
    // Re-pinned by docs/whats-new-navigation-keeps-choices (2026-11-15; was: RELEASES.slice(0, 7), without it): the navigation release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-invitation-audit (2026-11-15; was: RELEASES.slice(0, 8), without it): the invitation audit release is published later, at the top, directly below the Liquid Glass draft.
    // Re-pinned by docs/whats-new-api-key-audit (2026-11-15; was: RELEASES.slice(0, 9), without it): the API key audit release is published later, at the top, directly below the Liquid Glass draft.
    // Re-pinned by docs/whats-new-authenticator-set-up-first (2026-11-15; was: every pinned position one place higher): the authenticator set-up release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-delete-account-confirm (2026-11-16; was: every pinned position one place higher): the delete account release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-integrations-message-and-api-key-rows (2026-11-16; was: RELEASES.slice(0, 12)): the Integrations and schedule event release is published at the top, below the Liquid Glass draft, so the list takes one more.
    // Re-pinned by docs/whats-new-emptied-fields-and-schedule-completion (2026-11-16; was: RELEASES.slice(0, 13)): the emptied fields and schedule completion release is published at the top, below the Liquid Glass draft, so the list takes one more.
    // Re-pinned by docs/releases-low-critical-pages (2026-11-18; was: RELEASES.slice(0, 14)): the Low + critical pages and list value release is published at the top, below the Liquid Glass draft, so the list takes one more.
    // Re-pinned by docs/whats-new-receiving-shown-to-managers (2026-11-19; was: RELEASES.slice(0, 15)): the receiving release is published at the top, below the Liquid Glass draft, so the list takes one more.
    // Re-pinned by docs/whats-new-small-fixes-1119 (2026-11-19; was: RELEASES.slice(0, 16)): the export, receipt and access release is published at the top, below the Liquid Glass draft, so the list takes one more.
    // Re-pinned by docs/whats-new-2026-11-19-errors (2026-11-19; was: RELEASES.slice(0, 17)): the count start access check release is published at the top, below the Liquid Glass draft, so the list takes one more.
    // Re-pinned by docs/whats-new-2026-11-21-phone (2026-11-21; was: RELEASES.slice(0, 18)): the phone authenticator set-up release is published at the top, below the Liquid Glass draft, so the list takes one more.
    // Re-pinned by docs/whats-new-blocked-activity (2026-11-21; was: RELEASES.slice(0, 19)): the Blocked activity release is published at the top, below the Liquid Glass draft, so the list takes one more.
    expect(RELEASES.slice(0, 22).map((r) => [r.id, r.status])).toEqual([
      ['liquid-glass-2026-11', 'draft'],
      // Re-pinned by docs/whats-new-2026-11-21-phone (2026-11-21; was: without it): the phone authenticator set-up release is published later, at the top, directly below the Liquid Glass draft.
      // Re-pinned by docs/whats-new-blocked-activity (2026-11-21; was: without it): the Blocked activity release is published later, at the top, directly below the Liquid Glass draft.
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
      // Re-pinned by docs/whats-new-emptied-fields-and-schedule-completion (2026-11-16; was: without it): the emptied fields and schedule completion release is published later, at the top, directly below the Liquid Glass draft.
      [EMPTIED_FIELDS_ID, 'published'],
      // Re-pinned by docs/whats-new-invitation-audit (2026-11-15; was: without it): the invitation audit release is published later, at the top, directly below the Liquid Glass draft.
      // Re-pinned by docs/whats-new-api-key-audit (2026-11-15; was: without it): the API key audit release is published later, at the top, directly below the Liquid Glass draft.
      // Re-pinned by docs/whats-new-authenticator-set-up-first (2026-11-15; was: without it): the authenticator set-up release is published later, at the top, directly below the Liquid Glass draft.
      // Re-pinned by docs/whats-new-delete-account-confirm (2026-11-16; was: without it): the delete account release is published later, at the top, directly below the Liquid Glass draft.
      // Re-pinned by docs/whats-new-integrations-message-and-api-key-rows (2026-11-16; was: without it): the Integrations and schedule event release is published later, at the top, directly below the Liquid Glass draft.
      ['connection-and-schedule-messages-2026-11', 'published'],
      ['delete-account-confirm-2026-11', 'published'],
      ['authenticator-set-up-first-2026-11', 'published'],
      ['api-key-audit-2026-11', 'published'],
      ['invitation-audit-2026-11', 'published'],
      [NAVIGATION_ID, 'published'],
      [SETTINGS_ID, 'published'],
      [MODULE_CHECK_ID, 'published'],
      [ID, 'published'],
      [EMAIL_RELEASE_ID, 'published'],
      [PHONE_SCREENS_ID, 'published'],
    ]);
    expect(RELEASES.find((r) => r.status === 'published')?.id).toBe(
      // Re-pinned by docs/whats-new-unreadable-access-and-settings (2026-11-15; was: ID): the settings release is published after it, at the top, the newest published release.
      // Re-pinned by docs/whats-new-navigation-keeps-choices (2026-11-15; was: SETTINGS_ID): the navigation release is published after it, at the top, the newest published release.
      // Re-pinned by docs/whats-new-invitation-audit (2026-11-15; was: NAVIGATION_ID): the invitation audit release is published after it, at the top, the newest published release.
      // Re-pinned by docs/whats-new-api-key-audit (2026-11-15; was: the invitation audit release): the API key audit release is published after it, at the top, the newest published release.
      // Re-pinned by docs/whats-new-authenticator-set-up-first (2026-11-15; was: the API key audit release): the authenticator set-up release is published after it, at the top, the newest published release.
      // Re-pinned by docs/whats-new-delete-account-confirm (2026-11-16; was: the authenticator set-up release): the delete account release is published after it, at the top, the newest published release.
      // Re-pinned by docs/whats-new-integrations-message-and-api-key-rows (2026-11-16; was: DELETE_CONFIRM_ID): the Integrations and schedule event release is published after it, at the top, the newest published release.
      // Re-pinned by docs/whats-new-emptied-fields-and-schedule-completion (2026-11-16; was: CONNECTION_SCHEDULE_ID): the emptied fields and schedule completion release is published after it, at the top, the newest published release.
      // Re-pinned by docs/releases-low-critical-pages (2026-11-18; was: EMPTIED_FIELDS_ID): the Low + critical pages and list value release is published after it, at the top, the newest published release.
      // Re-pinned by docs/whats-new-receiving-shown-to-managers (2026-11-19; was: the Low + critical pages and list value release): the receiving release is published after it, at the top, the newest published release.
      // Re-pinned by docs/whats-new-small-fixes-1119 (2026-11-19; was: the receiving release): the export, receipt and access release is published after it, at the top, the newest published release.
      // Re-pinned by docs/whats-new-2026-11-19-errors (2026-11-19; was: the export, receipt and access release): the count start access check release is published after it, at the top, the newest published release.
      // Re-pinned by docs/whats-new-2026-11-21-phone (2026-11-21; was: the count start access check release): the phone authenticator set-up release is published after it, at the top, the newest published release.
      // Re-pinned by docs/whats-new-blocked-activity (2026-11-21; was: PHONE_SET_UP_ID): the Blocked activity release is published after it, at the top, the newest published release.
      // Re-pinned by docs/whats-new-phone-large-text (2026-11-23; was: without it): the phone large text release is published later, at the top, and reaches every member (its one entry has no audience), an owner with every permission and module included, so it is read, seen or listed with the newer releases, and every notice this test checks is the one it checked before.
      PHONE_LARGE_ID,
    );
  });

  it('is dated the whole minute after #558 went live, in the past, the minute of the email change release, with the draft placeholder at or after it and no later release below', () => {
    // #558 is live in production since 2026-11-15 00:02Z.
    expect(release().publishedAt).toBe('2026-11-15T00:03:00Z');
    const at = Date.parse(release().publishedAt);
    expect(at).toBeGreaterThan(Date.parse('2026-11-15T00:02:00Z'));
    expect(at).toBeLessThanOrEqual(Date.now());
    // Re-pinned by docs/whats-new-unreadable-access-and-settings (2026-11-15; was: every pinned position two places higher): the settings and module check releases are published at the top, below the Liquid Glass draft, so every position below them moves down by two.
    // Re-pinned by docs/whats-new-navigation-keeps-choices (2026-11-15; was: every pinned position one place higher): the navigation release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-invitation-audit (2026-11-15; was: every pinned position one place higher): the invitation audit release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-api-key-audit (2026-11-15; was: every pinned position one place higher): the API key audit release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-authenticator-set-up-first (2026-11-15; was: every pinned position one place higher): the authenticator set-up release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-delete-account-confirm (2026-11-16; was: every pinned position one place higher): the delete account release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-integrations-message-and-api-key-rows (2026-11-16; was: every pinned position one place higher): the Integrations and schedule event release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-emptied-fields-and-schedule-completion (2026-11-16; was: every pinned position one place higher): the emptied fields and schedule completion release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/releases-low-critical-pages (2026-11-18; was: RELEASES[11]): the Low + critical pages and list value release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-receiving-shown-to-managers (2026-11-19; was: RELEASES[12]): the receiving release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-small-fixes-1119 (2026-11-19; was: RELEASES[13]): the export, receipt and access release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-2026-11-19-errors (2026-11-19; was: RELEASES[14]): the count start access check release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-2026-11-21-phone (2026-11-21; was: RELEASES[15]): the phone authenticator set-up release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-blocked-activity (2026-11-21; was: RELEASES[16]): the Blocked activity release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-phone-large-text (2026-11-23; was: RELEASES[19]): the phone large text release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    expect(RELEASES[20]!.publishedAt).toBe(release().publishedAt);
    expect(Date.parse(RELEASES[0]!.publishedAt)).toBeGreaterThanOrEqual(at);
    // Re-pinned by docs/whats-new-unreadable-access-and-settings (2026-11-15; was: every pinned position two places higher): the settings and module check releases are published at the top, below the Liquid Glass draft, so every position below them moves down by two.
    // Re-pinned by docs/whats-new-navigation-keeps-choices (2026-11-15; was: every pinned position one place higher): the navigation release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-invitation-audit (2026-11-15; was: every pinned position one place higher): the invitation audit release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-api-key-audit (2026-11-15; was: every pinned position one place higher): the API key audit release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-authenticator-set-up-first (2026-11-15; was: every pinned position one place higher): the authenticator set-up release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-delete-account-confirm (2026-11-16; was: every pinned position one place higher): the delete account release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-integrations-message-and-api-key-rows (2026-11-16; was: every pinned position one place higher): the Integrations and schedule event release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-emptied-fields-and-schedule-completion (2026-11-16; was: every pinned position one place higher): the emptied fields and schedule completion release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/releases-low-critical-pages (2026-11-18; was: RELEASES.slice(12)): the Low + critical pages and list value release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-receiving-shown-to-managers (2026-11-19; was: RELEASES.slice(13)): the receiving release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-small-fixes-1119 (2026-11-19; was: RELEASES.slice(14)): the export, receipt and access release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-2026-11-19-errors (2026-11-19; was: RELEASES.slice(15)): the count start access check release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-2026-11-21-phone (2026-11-21; was: RELEASES.slice(16)): the phone authenticator set-up release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-blocked-activity (2026-11-21; was: RELEASES.slice(17)): the Blocked activity release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-phone-large-text (2026-11-23; was: RELEASES.slice(20)): the phone large text release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    for (const r of RELEASES.slice(21)) {
      expect(at, r.id).toBeGreaterThan(Date.parse(r.publishedAt));
    }
  });

  it('parses under the shared schema, in plain text, with its two entries in order and no email entry', () => {
    expect(releaseSchema.safeParse(release()).success).toBe(true);
    for (const text of readerText(release())) expect(text).not.toMatch(/[<>]/);
    expect(release().entries.map((e) => [e.id, e.category, e.area])).toEqual([
      [LIST_ID, 'fixed', 'Cycle counts'],
      [ASSIGNEE_ID, 'improved', 'Cycle counts'],
    ]);
    expect(readerText(release()).join(' ')).not.toMatch(/email|password/i);
  });
});

describe('the count read rule release: the words', () => {
  it('has a title and a summary that stand on their own', () => {
    expect(release().title).toBe('Who sees a cycle count is now the same everywhere');
    expect(release().summary).toBe(
      "The cycle count list, a count's page and count sheet, and the mobile app's list now follow one rule. A viewer who can open Cycle counts sees the counts of their warehouses, a count with no warehouse of its own shows to the person it is assigned to, and owners, admins, managers and members with access to every warehouse see every count, as before. No app update is needed.",
    );
  });

  it("says a viewer sees their warehouses' counts in the list, and that the web list is unchanged for everyone else", () => {
    const e = entry(LIST_ID);
    expect(e.title).toBe("Viewers see their warehouses' counts in the count list");
    expect(e.whatChanged).toBe(
      'A viewer who can open Cycle counts now sees the counts of the warehouses they are assigned to in the count list, on the web and in the mobile app.',
    );
    expect(e.whyItMatters).toBe(
      "The list showed only counts in warehouses a member can change, so a viewer's list was empty, although each of those counts opened from a link.",
    );
    // Only the web list: the mobile app's downloaded list follows the second entry.
    expect(e.howItAffectsYou).toBe(
      'Staff, managers and admins see the same counts in the web list as before. Who can enter numbers in a count is unchanged.',
    );
    expect(e.whatToDo).toBe('No action needed.');
  });

  it('says a count with no warehouse of its own shows to the person it is assigned to, and what the assigner and the counter do', () => {
    const e = entry(ASSIGNEE_ID);
    expect(e.title).toBe(
      'A count with no warehouse of its own shows to the person it is assigned to',
    );
    expect(e.whatChanged).toBe(
      "A count started for All warehouses, or for a selection of items in more than one warehouse, has no warehouse of its own. It now shows only to the person it is assigned to, and to owners, admins, managers and members with access to every warehouse. The count list, the count's page, its count sheet and variance report, and the mobile app's list after its next sync all follow this.",
    );
    expect(e.whyItMatters).toBe(
      "The count list, the count's page and the mobile app each decided this in their own way, so the same count could show in one place and not in another.",
    );
    expect(e.howItAffectsYou).toBe(
      'A count of this kind that is not assigned shows only to owners, admins, managers and members with access to every warehouse. For anyone else it is not in the list and its link opens Page not found. A member with no warehouse sees no counts, including one assigned to them. A count in one warehouse shows to members who can see that warehouse, assigned or not.',
    );
    expect(e.whatToDo).toBe(
      'If you assign counts, assign such a count to the person who will count it: open the count and choose them under Assigned to. If a count you were asked to do is missing from your list or opens Page not found, ask a manager to assign it to you.',
    );
  });

  it('says what such a count shows to now, never who it showed to before', () => {
    const text = readerText(release()).join(' ');
    expect(text).not.toMatch(/no longer/i);
    expect(text).not.toMatch(/\bbook(s|ed)?\b/i);
    expect(text).not.toMatch(/secur|vulnerab|exploit|leak|expos|attack|breach|unauthori/i);
    expect(text).not.toMatch(/[!\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  });
});

describe('the count read rule release: who is told', () => {
  it('is addressed to organizations with Cycle counts on, each entry to the people it is for', () => {
    expect(release().audience).toEqual({ modules: ['cycle_counts'] });
    // The count pages' gate: the module, and cycle_counts:read or stock:adjust.
    expect(entry(LIST_ID).audience).toEqual({
      anyPermission: ['cycle_counts:read', 'stock:adjust'],
      modules: ['cycle_counts'],
    });
    // Whoever can open Cycle counts (the counter) and whoever assigns counts.
    expect(entry(ASSIGNEE_ID).audience).toEqual({
      anyPermission: ['cycle_counts:read', 'stock:adjust', 'cycle_counts:assign'],
      modules: ['cycle_counts'],
    });
    for (const e of release().entries) {
      expect(e.link, e.id).toEqual({ href: '/dashboard/cycle-counts', label: 'Open Cycle counts' });
    }
  });

  it('reaches each reader with the entries that are theirs, and nobody where Cycle counts is off', () => {
    expect(entriesFor(owner)).toEqual([LIST_ID, ASSIGNEE_ID]);
    expect(entriesFor(admin)).toEqual([LIST_ID, ASSIGNEE_ID]);
    expect(entriesFor(viewer('manager', ROLE_PERMISSIONS.manager, ['cycle_counts']))).toEqual([
      LIST_ID,
      ASSIGNEE_ID,
    ]);
    // Staff count: the second entry tells them what to do when a count is missing.
    expect(entriesFor(staff)).toEqual([LIST_ID, ASSIGNEE_ID]);
    // A viewer given "View cycle counts" is the reader the first entry is about.
    expect(entriesFor(viewer('viewer', ['cycle_counts:read'], ['cycle_counts']))).toEqual([
      LIST_ID,
      ASSIGNEE_ID,
    ]);
    // Someone who assigns counts and cannot open the list is told the second entry.
    expect(entriesFor(viewer('manager', ['cycle_counts:assign'], ['cycle_counts']))).toEqual([
      ASSIGNEE_ID,
    ]);
    // A viewer by default cannot open Cycle counts: nothing of this release.
    expect(entriesFor(defaultViewer)).toEqual([]);
    expect(entriesFor(viewer('owner', [...PERMISSIONS], NO_CYCLE_COUNTS))).toEqual([]);
    expect(entriesFor(viewer('admin', ROLE_PERMISSIONS.admin, NO_CYCLE_COUNTS))).toEqual([]);
    expect(entriesFor(member)).toEqual([]);
  });

  // Renamed by docs/whats-new-unreadable-access-and-settings (2026-11-15; was: "is the newest notice for a reader it reaches, and a reader it does not reach is told the email change release"): the settings and module check releases are published later and are read first. Claim kept: the notice for a reader it reaches, and the email change release for a reader it does not reach.
  it('is the notice for a reader it reaches once the later releases are read, and a reader it does not reach is told the email change release', () => {
    // Re-pinned by docs/whats-new-unreadable-access-and-settings (2026-11-15; was: nothing read): the settings and module check releases are published later, at the top; the module check release reaches every member and the settings release reaches each reader here but the viewers, so each reader reads them first, and the notice this test checks is the one it checked before. A read of a release by a reader it does not reach changes nothing.
    for (const v of [owner, admin, staff]) {
      expect(buildReleaseList(RELEASES, v, newerRead, null).latestUnread?.id, v.role).toBe(ID);
    }
    for (const v of [defaultViewer, member, viewer('owner', [...PERMISSIONS], NO_CYCLE_COUNTS)]) {
      expect(buildReleaseList(RELEASES, v, newerRead, null).latestUnread?.id, v.role).toBe(
        EMAIL_RELEASE_ID,
      );
    }
  });
});

describe('the count read rule release: the code the words rest on', () => {
  const all = { hasAllAccess: true, readableIds: [] };
  const some = { hasAllAccess: false, readableIds: ['w1'] };
  const noWarehouse = { hasAllAccess: false, readableIds: [] };

  it('one rule: every count for managers and members with every warehouse, else readable warehouses and a count with no warehouse only for its assignee', () => {
    // Managers and above pass no access (their role sees every warehouse).
    expect(countReadScope(null, 'u1')).toEqual({ kind: 'every' });
    expect(countReadScope(all, 'u1')).toEqual({ kind: 'every' });
    for (const role of ['owner', 'admin', 'manager'] as const) {
      expect(isManagerOrAbove(role), role).toBe(true);
    }
    const scoped = countReadScope(some, 'u1');
    expect(mayReadCount(scoped, { warehouse_id: 'w1', assigned_to: null })).toBe(true);
    expect(mayReadCount(scoped, { warehouse_id: 'w1', assigned_to: 'u2' })).toBe(true);
    expect(mayReadCount(scoped, { warehouse_id: 'w2', assigned_to: 'u1' })).toBe(false);
    expect(mayReadCount(scoped, { warehouse_id: null, assigned_to: 'u1' })).toBe(true);
    expect(mayReadCount(scoped, { warehouse_id: null, assigned_to: null })).toBe(false);
    expect(mayReadCount(scoped, { warehouse_id: null, assigned_to: 'u2' })).toBe(false);
    // A member with no warehouse sees no count, an assigned one included.
    const none = countReadScope(noWarehouse, 'u1');
    expect(none).toEqual({ kind: 'none' });
    expect(mayReadCount(none, { warehouse_id: null, assigned_to: 'u1' })).toBe(false);
  });

  it('the web list, the phone list, the count page and the phone sync all ask that rule, by the warehouses a member can read', () => {
    const service = source('server/services/cycle-counts.ts');
    expect(service).toContain('const scope = await readCountScope(this.ctx);');
    expect(service.split('await this.assertMayRead(h);').length - 1).toBe(2);
    expect(service).toContain("throw new ServiceError('not_found', 'Cycle count not found');");
    expect(source('server/services/lib/count-read-scope.ts')).toContain(
      'return countReadScope(access, ctx.userId);',
    );
    // The mobile app's online list is the same list read.
    expect(source('app/api/v1/cycle-counts/route.ts')).toContain(
      'const result = await svc.listPage(',
    );
    // Its downloaded list is what the sync is sent.
    expect(source('app/api/v1/mobile/snapshot/route.ts')).toContain(
      'const countScope = countReadScope(access, ctx.userId);',
    );
    // A viewer reads their assigned warehouses and can change none; for staff
    // the two sets are the same, so the web list is unchanged for them.
    expect(source('lib/auth/warehouse.ts')).toContain(
      "const writableIds = c.role === 'viewer' ? [] : readableIds;",
    );
    // A viewer opens Cycle counts only when given the permission.
    expect(hasPermission('viewer', 'cycle_counts:read')).toBe(false);
    expect(hasPermission('viewer', 'stock:adjust')).toBe(false);
    expect(hasPermission('staff', 'cycle_counts:read')).toBe(true);
    expect(source('lib/verification/count-page-access.ts')).toContain(
      "return can(ctx, 'cycle_counts:read') || can(ctx, 'stock:adjust');",
    );
  });

  it('the words on screen: All warehouses, Assigned to, Page not found', () => {
    expect(source('components/cycle-counts/start-cycle-count-form.tsx')).toContain(
      '<SelectItem value={ALL}>All warehouses</SelectItem>',
    );
    expect(source('components/cycle-counts/cycle-count-detail.tsx')).toContain('Assigned to:');
    expect(source('app/(dashboard)/dashboard/cycle-counts/[id]/page.tsx')).toContain(
      "if (e instanceof ServiceError && e.code === 'not_found') notFound();",
    );
    expect(source('app/not-found.tsx')).toContain('Page not found');
    // Assigning is a manager's default permission, and staff do not hold it.
    expect(hasPermission('manager', 'cycle_counts:assign')).toBe(true);
    expect(hasPermission('staff', 'cycle_counts:assign')).toBe(false);
  });
});

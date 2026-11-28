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
const RECOVERY_ID = 'recovery-code-signs-out-other-devices-2026-11';
const UPLOAD_ID = 'upload-checks-2026-11';
const VENDOR_ID = 'vendor-risk-reviews-2026-11';
const PHONE_SET_UP_ID = 'phone-authenticator-set-up-2026-11';
// Added by docs/whats-new-small-fixes-1119 (2026-11-19): the export, receipt and access release (every member: its access entry has no audience), published later, at the top, below the Liquid Glass draft.
const EXPORT_RECEIPT_ACCESS_ID = 'export-receipt-access-fixes-2026-11';
// Added by docs/whats-new-receiving-shown-to-managers (2026-11-19): the receiving release (whoever can open a purchase order where Receiving is on), published later, at the top, below the Liquid Glass draft.
const RECEIVING_ID = 'receiving-shown-to-managers-2026-11';

/**
 * Added by docs/whats-new-count-read-rule (2026-11-15): the email change
 * release for #558 (squash 29cb97190, web only, no phone update, no
 * migration): an email change still waiting when the password is changed
 * shows in Settings, Profile as Expired. One entry, no audience: the Email
 * card changed for every organization.
 *
 * It shares its minute with the count read rule release
 * (count-read-rule-2026-11, registry.count-read-rule.test.ts), which is the
 * newer of the two and sits directly above it, so a reader both reach is
 * offered that one first. Its own file, so the release tests other open
 * branches edit stay as they are.
 *
 * Re-pinned by docs/whats-new-unreadable-access-and-settings (2026-11-15): the
 * settings and module check releases are published later, above the count
 * read rule release and below the Liquid Glass draft. Each changed line has
 * its own note.
 *
 * Re-pinned by docs/whats-new-navigation-keeps-choices (2026-11-15): the
 * navigation release is published later still, directly below the draft and
 * above the settings release. Each changed line has its own note.
 */
const ID = 'email-change-expired-2026-11';
const ENTRY_ID = 'email-change-expired-after-password-change';
const COUNT_RELEASE_ID = 'count-read-rule-2026-11';
const PHONE_SCREENS_ID = 'phone-screens-by-access-2026-11';
// Added by docs/whats-new-unreadable-access-and-settings (2026-11-15): the settings release (whoever can open the settings pages and panels it names) and the module check release (every member), published later, above the count read rule release.
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
  // Re-pinned by docs/whats-new-recovery-code (2026-11-23; was: without it): the recovery code release is published later, at the top, and reaches every member (its entries have no audience), an owner with every permission and module included, so it is read, seen or listed with the newer releases, and every notice this test checks is the one it checked before.
  // Re-pinned by docs/whats-new-upload-checks (2026-11-28; was: earlier positions, lists and reads): the upload checks release is published at the top, below the Liquid Glass draft, so every position below it moves down by one and every list of newer releases takes it too.
  // Re-pinned by docs/whats-new-vendor-risk (2026-11-28; was: without it): the vendor risk reviews release is published at the top, below the Liquid Glass draft, so the list takes it too.
  VENDOR_ID,
  UPLOAD_ID,
  RECOVERY_ID,
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
// Re-pinned by docs/whats-new-navigation-keeps-choices (2026-11-15; was: without it): the navigation release is published later, at the top, so it is seen with the newer releases.
// Re-pinned by docs/whats-new-invitation-audit (2026-11-15; was: without it): the invitation audit release is published later, at the top, and reaches whoever can view the audit log (owners, admins and managers by default), so it is read or seen with the newer releases, and every notice this test checks is the one it checked before. A read of a release by a reader it does not reach changes nothing.
const newerSeen = {
  // Re-pinned by docs/whats-new-api-key-audit (2026-11-15; was: without it): the API key audit release is published later, at the top, and reaches whoever can view the audit log (owners, admins and managers by default), as the invitation audit release does, so it is read, seen or listed with the newer releases, and every notice this test checks is the one it checked before.
  // Re-pinned by docs/whats-new-authenticator-set-up-first (2026-11-15; was: without it): the authenticator set-up release is published later, at the top, and reaches every member (its entry has no audience), so it is read, seen or listed with the newer releases, and every notice this test checks is the one it checked before.
  // Re-pinned by docs/whats-new-delete-account-confirm (2026-11-16; was: without it): the delete account release is published later, at the top, and reaches every member (its entry has no audience), so it is read, seen or listed with the newer releases, and every notice this test checks is the one it checked before.
  // Re-pinned by docs/whats-new-integrations-message-and-api-key-rows (2026-11-16; was: without it): the Integrations and schedule event release is published later, at the top, and reaches whoever can manage integrations where Integrations is on and whoever can manage the schedule where Schedule is on, an owner with every permission and module included, so it is read, seen or listed with the newer releases, and every notice this test checks is the one it checked before.
  // Re-pinned by docs/whats-new-emptied-fields-and-schedule-completion (2026-11-16; was: without it): the emptied fields and schedule completion release is published later, at the top, and reaches owners and admins, managers for its location and category entries, and whoever manages the schedule or suppliers with those modules on, so it is read, seen or listed with the newer releases, and every notice this test checks is the one it checked before. A read of a release by a reader it does not reach changes nothing.
  // Re-pinned by docs/releases-low-critical-pages (2026-11-18; was: without it): the Low + critical pages and list value release is published later, at the top, and reaches whoever can read items (owners, admins, managers, staff and viewers by default), so it is read, seen or listed with the newer releases, and every notice this test checks is the one it checked before. A read of a release by a reader it does not reach changes nothing.
  // Re-pinned by docs/whats-new-2026-11-21-phone (2026-11-21; was: without it): the phone authenticator set-up release is published later, at the top, and reaches every member (three of its five entries have no audience), an owner with every permission and module included, so it is read, seen or listed with the newer releases, and every notice this test checks is the one it checked before.
  // Re-pinned by docs/whats-new-blocked-activity (2026-11-21; was: without it): the Blocked activity release is published later, at the top, and reaches owners and Super Admins (their roles are its audience), so it is read, seen or listed with the newer releases for them, and every notice this test checks is the one it checked before. A read of a release by a reader it does not reach changes nothing.
  // Re-pinned by docs/whats-new-recovery-code (2026-11-23; was: without it): the recovery code release is published later, at the top, and reaches every member (its entries have no audience), an owner with every permission and module included, so it is read, seen or listed with the newer releases, and every notice this test checks is the one it checked before.
  // Re-pinned by docs/whats-new-upload-checks (2026-11-28; was: earlier positions, lists and reads): the upload checks release is published at the top, below the Liquid Glass draft, so every position below it moves down by one and every list of newer releases takes it too.
  // Re-pinned by docs/whats-new-vendor-risk (2026-11-28; was: without it): the vendor risk reviews release is published at the top, below the Liquid Glass draft, so the read state takes it too.
  [VENDOR_ID]: true, [UPLOAD_ID]: true, [RECOVERY_ID]: true,
  [PHONE_LARGE_ID]: true,
  [SIGNIN_ID]: true,
  [BLOCKED_CURRENT_ID]: true,
  [BLOCKED_ID]: true,
  [PHONE_SET_UP_ID]: true,
  // Re-pinned by docs/whats-new-2026-11-19-errors (2026-11-19; was: without it): the count start access check release is published later, at the top, and reaches a manager or above who can assign counts where Cycle Counts is on (an owner with every permission and module among them), so it is read, seen or listed with the newer releases, and every notice this test checks is the one it checked before. A read of a release by a reader it does not reach changes nothing.
  [COUNT_START_ACCESS_ID]: true,
  // Re-pinned by docs/whats-new-small-fixes-1119 (2026-11-19; was: without it): the export, receipt and access release is published later, at the top, and reaches every member (its access entry has no audience), so it is read, seen or listed with the newer releases, and every notice this test checks is the one it checked before. A read of a release by a reader it does not reach changes nothing.
  [EXPORT_RECEIPT_ACCESS_ID]: true,
  // Re-pinned by docs/whats-new-receiving-shown-to-managers (2026-11-19; was: without it): the receiving release is published later, at the top, and reaches whoever can open a purchase order where Receiving is on (owners, admins, managers, staff and viewers by default), so it is read, seen or listed with the newer releases, and every notice this test checks is the one it checked before. A read of a release by a reader it does not reach changes nothing.
  [RECEIVING_ID]: true,
  [LOW_CRITICAL_ID]: true,
  [EMPTIED_FIELDS_ID]: true,
  [CONNECTION_SCHEDULE_ID]: true,
  [DELETE_CONFIRM_ID]: true,
  [AUTH_SET_UP_ID]: true,
  [API_KEY_AUDIT_ID]: true,
  [INVITATION_AUDIT_ID]: true,
  [NAVIGATION_ID]: true,
  [SETTINGS_ID]: true,
  [MODULE_CHECK_ID]: true,
};

const release = () => RELEASES.find((r) => r.id === ID)!;
const entry = () => release().entries.find((e) => e.id === ENTRY_ID)!;

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

/** A file in the mobile app, as written. */
const phone = (rel: string) => repoFile(`apps/mobile/${rel}`);

describe('the email change release: order, status and date', () => {
  it('is published once, as revision 1, directly below the count read rule release of the same minute and above the phone screens by access release', () => {
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
    // Re-pinned by docs/whats-new-recovery-code (2026-11-23; was: RELEASES.slice(0, 22)): the recovery code release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-upload-checks (2026-11-28; was: earlier positions, lists and reads): the upload checks release is published at the top, below the Liquid Glass draft, so every position below it moves down by one and every list of newer releases takes it too.
    // Re-pinned by docs/whats-new-vendor-risk (2026-11-28; was: RELEASES.slice(0, 24)): the vendor risk reviews release is published at the top, below the Liquid Glass draft, so every position below it moves down by one and the list takes it too.
    expect(RELEASES.slice(0, 25).map((r) => [r.id, r.status])).toEqual([
      ['liquid-glass-2026-11', 'draft'],
      // Re-pinned by docs/whats-new-2026-11-21-phone (2026-11-21; was: without it): the phone authenticator set-up release is published later, at the top, directly below the Liquid Glass draft.
      // Re-pinned by docs/whats-new-blocked-activity (2026-11-21; was: without it): the Blocked activity release is published later, at the top, directly below the Liquid Glass draft.
      // Re-pinned by docs/whats-new-recovery-code (2026-11-23; was: without it): the recovery code release is published later, at the top, and reaches every member (its entries have no audience), an owner with every permission and module included, so it is read, seen or listed with the newer releases, and every notice this test checks is the one it checked before.
      // Re-pinned by docs/whats-new-upload-checks (2026-11-28; was: earlier positions, lists and reads): the upload checks release is published at the top, below the Liquid Glass draft, so every position below it moves down by one and every list of newer releases takes it too.
      // Re-pinned by docs/whats-new-vendor-risk (2026-11-28; was: without it): the vendor risk reviews release is published at the top, below the Liquid Glass draft, so the list takes it too.
      [VENDOR_ID, 'published'],
      [UPLOAD_ID, 'published'],
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
      [COUNT_RELEASE_ID, 'published'],
      [ID, 'published'],
      [PHONE_SCREENS_ID, 'published'],
    ]);
  });

  it('is dated the whole minute after #558 went live, in the past, the minute of the count read rule release, with the draft placeholder at or after it and no later release below', () => {
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
    // Re-pinned by docs/releases-low-critical-pages (2026-11-18; was: RELEASES[10]): the Low + critical pages and list value release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-receiving-shown-to-managers (2026-11-19; was: RELEASES[11]): the receiving release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-small-fixes-1119 (2026-11-19; was: RELEASES[12]): the export, receipt and access release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-2026-11-19-errors (2026-11-19; was: RELEASES[13]): the count start access check release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-2026-11-21-phone (2026-11-21; was: RELEASES[14]): the phone authenticator set-up release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-blocked-activity (2026-11-21; was: RELEASES[15]): the Blocked activity release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-phone-large-text (2026-11-23; was: RELEASES[18]): the phone large text release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-recovery-code (2026-11-23; was: RELEASES[19]): the recovery code release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-upload-checks (2026-11-28; was: earlier positions, lists and reads): the upload checks release is published at the top, below the Liquid Glass draft, so every position below it moves down by one and every list of newer releases takes it too.
    // Re-pinned by docs/whats-new-vendor-risk (2026-11-28; was: RELEASES[21]): the vendor risk reviews release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    expect(RELEASES[22]!.publishedAt).toBe(release().publishedAt);
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
    // Re-pinned by docs/whats-new-recovery-code (2026-11-23; was: RELEASES.slice(21)): the recovery code release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-upload-checks (2026-11-28; was: earlier positions, lists and reads): the upload checks release is published at the top, below the Liquid Glass draft, so every position below it moves down by one and every list of newer releases takes it too.
    // Re-pinned by docs/whats-new-vendor-risk (2026-11-28; was: RELEASES.slice(23)): the vendor risk reviews release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    for (const r of RELEASES.slice(24)) {
      expect(at, r.id).toBeGreaterThan(Date.parse(r.publishedAt));
    }
  });

  it('parses under the shared schema, in plain text, with its one entry', () => {
    expect(releaseSchema.safeParse(release()).success).toBe(true);
    for (const text of readerText(release())) expect(text).not.toMatch(/[<>]/);
    expect(release().entries.map((e) => [e.id, e.category, e.area])).toEqual([
      [ENTRY_ID, 'fixed', 'Account'],
    ]);
    // The entry is in this release only.
    expect(
      RELEASES.filter((r) => r.entries.some((e) => e.id === ENTRY_ID)).map((r) => r.id),
    ).toEqual([ID]);
  });
});

describe('the email change release: the words', () => {
  it('has a title and a summary about the email change only, that stand on their own', () => {
    expect(release().title).toBe(
      'A waiting email change now shows as Expired after a password change',
    );
    expect(release().summary).toBe(
      "If you change your password while an email change is still waiting to be confirmed, Settings, Profile on the web now shows that change as Expired, with Resend verification, Use a different address and Cancel change. The mobile app's Email screen is unchanged, and no app update is needed.",
    );
    expect(readerText(release()).join(' ')).not.toMatch(/cycle count|warehouse/i);
  });

  it('says a waiting email change shows as Expired after a password change, with the three buttons by name', () => {
    const e = entry();
    expect(e.title).toBe(
      'An email change still waiting when you change your password now shows as Expired',
    );
    expect(e.whatChanged).toBe(
      'If you change your password while an email change is still waiting to be confirmed, Settings, Profile on the web now shows that change under Email as Expired, with Resend verification, Use a different address and Cancel change.',
    );
    expect(e.whyItMatters).toBe(
      'A password change ends the verification links that were sent, and the Email card then showed no pending change, so there was nothing to resend or cancel.',
    );
    expect(e.howItAffectsYou).toBe(
      'Your account keeps using your current address until both addresses are confirmed. Resend verification sends new links to both addresses, and Cancel change drops the change.',
    );
    expect(e.whatToDo).toBe(
      'If you changed your password while an email change was waiting, open Settings, Profile and resend or cancel it. Otherwise no action is needed.',
    );
  });

  it('keeps to what people see, in plain words', () => {
    const text = readerText(release()).join(' ');
    expect(text).not.toMatch(/\bbook(s|ed)?\b/i);
    expect(text).not.toMatch(/secur|vulnerab|exploit|leak|expos|attack|breach|unauthori/i);
    expect(text).not.toMatch(/[!\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  });
});

describe('the email change release: who is told', () => {
  it('has no audience, on the release or the entry, and links to a page open to every member', () => {
    expect(release().audience).toBeUndefined();
    expect(entry().audience).toBeUndefined();
    expect(entry().link).toEqual({
      href: '/dashboard/settings/profile',
      label: 'Open Profile settings',
    });
  });

  it('reaches every member of every organization, with Cycle counts on or off', () => {
    for (const v of [
      owner,
      admin,
      staff,
      defaultViewer,
      member,
      viewer('owner', [...PERMISSIONS], NO_CYCLE_COUNTS),
      viewer('admin', ROLE_PERMISSIONS.admin, NO_CYCLE_COUNTS),
      viewer('staff', ROLE_PERMISSIONS.staff, []),
    ]) {
      expect(entriesFor(v), v.role).toEqual([ENTRY_ID]);
    }
  });

  it('an organization without Cycle counts sees this release and not the count read rule release', () => {
    for (const v of [
      viewer('owner', [...PERMISSIONS], NO_CYCLE_COUNTS),
      viewer('admin', ROLE_PERMISSIONS.admin, NO_CYCLE_COUNTS),
      viewer('staff', ROLE_PERMISSIONS.staff, []),
      member,
    ]) {
      const ids = visibleReleases(RELEASES, v).map((r) => r.id);
      expect(ids, v.role).toContain(ID);
      expect(ids, v.role).not.toContain(COUNT_RELEASE_ID);
      // Re-pinned by docs/whats-new-unreadable-access-and-settings (2026-11-15; was: nothing read, nothing seen): the settings and module check releases are published later, at the top; the module check release reaches every member and the settings release reaches the owner, admin and staff here, so each reader reads and sees them first, and the notice this test checks is the one it checked before. A read of a release by a reader it does not reach changes nothing.
      expect(buildReleaseList(RELEASES, v, newerRead, null).latestUnread?.id, v.role).toBe(ID);
      // An older phone build shows the newest one it has not seen: this title and summary.
      expect(legacyAnnouncementsFor(RELEASES, v, newerSeen)[0], v.role).toEqual({
        id: ID,
        date: '2026-11-15',
        title: release().title,
        body: release().summary,
        cta: { href: '/dashboard/settings/profile', label: 'Open Profile settings' },
      });
    }
  });

  it('is the next notice for a reader the count read rule release reaches, once that one is read', () => {
    const countRead = {
      release_id: COUNT_RELEASE_ID,
      revision: 1,
      dismissed_at: null,
      opened_at: '2026-11-15T00:30:00Z',
      read_at: '2026-11-15T00:30:00Z',
    };
    for (const v of [owner, admin, staff]) {
      // Re-pinned by docs/whats-new-unreadable-access-and-settings (2026-11-15; was: nothing read, then the count read rule release read): the settings and module check releases are published later, at the top, and reach each reader here, so each reads them first, and the notices this test checks are the ones it checked before.
      expect(buildReleaseList(RELEASES, v, newerRead, null).latestUnread?.id, v.role).toBe(
        COUNT_RELEASE_ID,
      );
      expect(
        buildReleaseList(RELEASES, v, [...newerRead, countRead], null).latestUnread?.id,
        v.role,
      ).toBe(ID);
    }
  });
});

describe('the email change release: the code the words rest on', () => {
  it('the Email card shows a change held without a request time as Expired, with the three buttons', () => {
    const card = source('components/settings/email-settings-card.tsx');
    expect(card).toContain('if (!props.pendingEmail) return null;');
    expect(card).toContain('pending.expiresAt === null ||');
    expect(card).toContain("{expired ? 'Expired' : 'Pending'}");
    for (const label of ['Resend verification', 'Use a different address', 'Cancel change']) {
      expect(card, label).toContain(label);
      expect(entry().whatChanged, label).toContain(label);
      expect(release().summary, label).toContain(label);
    }
    expect(card).toContain('Your account keeps using ${props.email} until both are confirmed.');
    const page = source('app/(dashboard)/dashboard/settings/profile/page.tsx');
    expect(page).toContain('title="Email"');
    expect(page).toContain('<EmailSettingsCard');
  });

  it('resend sends both links again for the waiting address, and cancel clears the change', () => {
    const service = source('server/services/email-change.ts');
    expect(service).toContain(
      'const links = await mintEmailChangeLinks(user.email, pending, args.userId);',
    );
    expect(service).toContain(
      "admin.rpc('cancel_pending_email_change', { p_user_id: args.userId })",
    );
  });

  it("the mobile app's Email screen decides Expired from the link time alone, as it did before", () => {
    const screen = phone('app/(drawer)/settings/change-email.tsx');
    expect(screen).toContain('Settings → Email.');
    expect(screen).toContain(
      'const expired = status?.expiresAt ? now > new Date(status.expiresAt).getTime() : false;',
    );
  });
});

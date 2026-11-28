import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  hasPermission,
  MODULE_REGISTRY,
  PERMISSION_META,
  PERMISSIONS,
  releaseSchema,
  ROLE_PERMISSIONS,
  type ModuleId,
  type Release,
  type ReleaseViewer,
} from '@stockpilot/core';

import { buildReleaseList, visibleReleases } from './logic';
import { RELEASES } from './registry';

/**
 * Added by docs/whats-new-order-request-alerts (2026-11-14): the release for
 * docket S36, part a (#440, migration 0422), published at the top, directly
 * below the Liquid Glass draft and above the phone authenticator code release.
 * Two entries:
 *
 *  - the New order request alert stops for an admin or manager whose
 *    "Approve / fulfill orders" permission was removed;
 *  - Today's briefing and the morning briefing notification show only the
 *    lines the reader can open.
 *
 * The plan's entry for a staff member given the permission
 * (order-request-alert-approvers) is not published, so the summary does not
 * name staff members either. Its own file, so the release tests other open
 * branches edit stay as they are.
 *
 * Re-pinned by docs/whats-new-phone-screens-by-access (2026-11-14): the phone screens by
 * access release is published later, directly above this release and below
 * the Liquid Glass draft. Each changed line has its own note.
 *
 * Re-pinned by docs/whats-new-count-read-rule (2026-11-15): the count read rule and
 * email change releases are published later still, at the top, directly
 * above the phone screens by access release and below the Liquid Glass
 * draft. Each changed line has its own note.
 *
 * Re-pinned by docs/whats-new-unreadable-access-and-settings (2026-11-15): the
 * settings and module check releases are published later still, at the top,
 * directly above the count read rule release and below the Liquid Glass
 * draft. Each changed line has its own note.
 *
 * Re-pinned by docs/whats-new-navigation-keeps-choices (2026-11-15): the
 * navigation release is published later still, at the top, directly above
 * the settings release and below the Liquid Glass draft. Each changed line
 * has its own note.
 */
const ID = 'order-request-alerts-follow-approve-2026-11';
// Added by docs/whats-new-authenticator-set-up-first (2026-11-15): the authenticator set-up release (every member: its entry has no audience), published later, at the top, below the Liquid Glass draft.
const AUTH_SET_UP_ID = 'authenticator-set-up-first-2026-11';
const authSetUpRead = {
  release_id: AUTH_SET_UP_ID,
  revision: 1,
  dismissed_at: null,
  opened_at: '2026-11-15T23:45:00Z',
  read_at: '2026-11-15T23:45:00Z',
};
// Added by docs/whats-new-delete-account-confirm (2026-11-16): the delete account release (every member: its entry has no audience), published later, at the top, below the Liquid Glass draft.
const DELETE_CONFIRM_ID = 'delete-account-confirm-2026-11';
const deleteConfirmRead = {
  release_id: DELETE_CONFIRM_ID,
  revision: 1,
  dismissed_at: null,
  opened_at: '2026-11-16T04:05:00Z',
  read_at: '2026-11-16T04:05:00Z',
};
// Added by docs/whats-new-integrations-message-and-api-key-rows (2026-11-16): the Integrations and schedule event release (whoever can manage integrations with the integrations module on, or schedule events with the schedule module on), published later, at the top, below the Liquid Glass draft.
const CONNECTION_SCHEDULE_ID = 'connection-and-schedule-messages-2026-11';
// Added by docs/whats-new-emptied-fields-and-schedule-completion (2026-11-16): the emptied fields and schedule completion release (whoever can manage the schedule or suppliers where those modules are on, and whoever can manage the organization, locations or categories), published later, at the top, below the Liquid Glass draft.
const EMPTIED_FIELDS_ID = 'emptied-fields-and-schedule-completion-2026-11';
// Added by docs/releases-low-critical-pages (2026-11-18): the Low + critical pages and list value release (whoever can read items: every role by default), published later, at the top, below the Liquid Glass draft.
const LOW_CRITICAL_ID = 'low-critical-pages-and-list-value-2026-11';
const lowCriticalRead = {
  release_id: LOW_CRITICAL_ID,
  revision: 1,
  dismissed_at: null,
  opened_at: '2026-11-18T10:01:00Z',
  read_at: '2026-11-18T10:01:00Z',
};
// Added by docs/whats-new-small-fixes-1119 (2026-11-19): the export, receipt and access release (every member: its access entry has no audience), published later, at the top, below the Liquid Glass draft.
const EXPORT_RECEIPT_ACCESS_ID = 'export-receipt-access-fixes-2026-11';
// Added by docs/whats-new-receiving-shown-to-managers (2026-11-19): the receiving release (whoever can open a purchase order where Receiving is on), published later, at the top, below the Liquid Glass draft.
const RECEIVING_ID = 'receiving-shown-to-managers-2026-11';
const receivingRead = {
  release_id: RECEIVING_ID,
  revision: 1,
  dismissed_at: null,
  opened_at: '2026-11-19T04:31:00Z',
  read_at: '2026-11-19T04:31:00Z',
};
const exportReceiptAccessRead = {
  release_id: EXPORT_RECEIPT_ACCESS_ID,
  revision: 1,
  dismissed_at: null,
  opened_at: '2026-11-19T15:31:00Z',
  read_at: '2026-11-19T15:31:00Z',
};
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
const UPLOAD_ID = 'upload-checks-2026-11';
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
const uploadRead = {
  release_id: UPLOAD_ID,
  revision: 1,
  dismissed_at: null,
  opened_at: '2026-11-28T06:58:00Z',
  read_at: '2026-11-28T06:58:00Z',
};
const PHONE_SET_UP_ID = 'phone-authenticator-set-up-2026-11';
const phoneSetUpRead = {
  release_id: PHONE_SET_UP_ID,
  revision: 1,
  dismissed_at: null,
  opened_at: '2026-11-21T02:32:00Z',
  read_at: '2026-11-21T02:32:00Z',
};
const emptiedFieldsRead = {
  release_id: EMPTIED_FIELDS_ID,
  // Re-pinned by bundles/hand-out-follows-the-manager-rule (2026-11-16; was: revision 1): the emptied fields and schedule completion release is re-announced as revision 2, so a read of it is recorded at revision 2.
  revision: 2,
  dismissed_at: null,
  opened_at: '2026-11-16T12:34:00Z',
  read_at: '2026-11-16T12:34:00Z',
};
const connectionScheduleRead = {
  release_id: CONNECTION_SCHEDULE_ID,
  revision: 1,
  dismissed_at: null,
  opened_at: '2026-11-16T09:45:00Z',
  read_at: '2026-11-16T09:45:00Z',
};
const REMOVED_ID = 'order-request-alert-removed-approvers';
const BRIEFING_ID = 'briefing-follows-permissions';
const PHONE_CODE_ID = 'phone-authenticator-code-2026-11';
// Added by docs/whats-new-phone-screens-by-access (2026-11-14): the phone screens by access release, published later, directly above this one. It reaches every member.
const PHONE_SCREENS_ID = 'phone-screens-by-access-2026-11';
// Added by docs/whats-new-count-read-rule (2026-11-15): the count read rule release (whoever can open Cycle counts or assigns counts, where Cycle counts is on) and the email change release (every member), published later still, directly above the phone screens by access release.
const COUNT_READ_RULE_ID = 'count-read-rule-2026-11';
const EMAIL_EXPIRED_ID = 'email-change-expired-2026-11';
// Added by docs/whats-new-unreadable-access-and-settings (2026-11-15): the settings release (whoever can open the settings pages and panels it names) and the module check release (every member), published later still, directly above the count read rule release.
const SETTINGS_ID = 'settings-not-loaded-2026-11';
const MODULE_CHECK_ID = 'module-check-try-again-2026-11';

const release = () => RELEASES.find((r) => r.id === ID)!;
const entry = (entryId: string) => release().entries.find((e) => e.id === entryId)!;

const viewer = (
  role: ReleaseViewer['role'],
  permissions: ReleaseViewer['permissions'],
  enabledModules: ReleaseViewer['enabledModules'],
): ReleaseViewer => ({ role, permissions, enabledModules });
const EVERY_MODULE = Object.keys(MODULE_REGISTRY) as ModuleId[];
const owner = viewer('owner', [...PERMISSIONS], EVERY_MODULE);
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

describe('the order request alerts release: order, status and date', () => {
  it('is published once, as revision 1, directly below the phone screens by access release (published later, below the Liquid Glass draft at the top) and above the phone authenticator code release', () => {
    expect(RELEASES.filter((r) => r.id === ID)).toHaveLength(1);
    expect(release().status).toBe('published');
    expect(release().revision).toBe(1);
    expect(release().withdrawnNote).toBeUndefined();
    // Re-pinned by docs/whats-new-phone-screens-by-access (2026-11-14; was: RELEASES.slice(0, 4), without it): the phone screens by access release is published later, at the top, directly below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-count-read-rule (2026-11-15; was: RELEASES.slice(0, 5), without them): the count read rule and email change releases are published later, at the top, directly below the Liquid Glass draft, so every position below them moves down by two.
    // Re-pinned by docs/whats-new-unreadable-access-and-settings (2026-11-15; was: RELEASES.slice(0, 7), without them): the settings and module check releases are published later, at the top, directly below the Liquid Glass draft, so every position below them moves down by two.
    // Re-pinned by docs/whats-new-navigation-keeps-choices (2026-11-15; was: RELEASES.slice(0, 9), without it): the navigation release is published later, at the top, directly below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-invitation-audit (2026-11-15; was: RELEASES.slice(0, 10), without it): the invitation audit release is published later, at the top, directly below the Liquid Glass draft.
    // Re-pinned by docs/whats-new-api-key-audit (2026-11-15; was: RELEASES.slice(0, 11), without it): the API key audit release is published later, at the top, directly below the Liquid Glass draft.
    // Re-pinned by docs/whats-new-authenticator-set-up-first (2026-11-15; was: every pinned position one place higher): the authenticator set-up release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-delete-account-confirm (2026-11-16; was: every pinned position one place higher): the delete account release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-integrations-message-and-api-key-rows (2026-11-16; was: every pinned position one place higher): the Integrations and schedule event release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-emptied-fields-and-schedule-completion (2026-11-16; was: RELEASES.slice(0, 15)): the emptied fields and schedule completion release is published at the top, below the Liquid Glass draft, so the list takes one more.
    // Re-pinned by docs/releases-low-critical-pages (2026-11-18; was: RELEASES.slice(0, 16)): the Low + critical pages and list value release is published at the top, below the Liquid Glass draft, so the list takes one more.
    // Re-pinned by docs/whats-new-receiving-shown-to-managers (2026-11-19; was: RELEASES.slice(0, 17)): the receiving release is published at the top, below the Liquid Glass draft, so the list takes one more.
    // Re-pinned by docs/whats-new-small-fixes-1119 (2026-11-19; was: RELEASES.slice(0, 18)): the export, receipt and access release is published at the top, below the Liquid Glass draft, so the list takes one more.
    // Re-pinned by docs/whats-new-2026-11-19-errors (2026-11-19; was: RELEASES.slice(0, 19)): the count start access check release is published at the top, below the Liquid Glass draft, so the list takes one more.
    // Re-pinned by docs/whats-new-2026-11-21-phone (2026-11-21; was: RELEASES.slice(0, 20)): the phone authenticator set-up release is published at the top, below the Liquid Glass draft, so the list takes one more.
    // Re-pinned by docs/whats-new-blocked-activity (2026-11-21; was: RELEASES.slice(0, 21)): the Blocked activity release is published at the top, below the Liquid Glass draft, so the list takes one more.
    // Re-pinned by docs/whats-new-recovery-code (2026-11-23; was: RELEASES.slice(0, 24)): the recovery code release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-upload-checks (2026-11-28; was: earlier positions, lists and reads): the upload checks release is published at the top, below the Liquid Glass draft, so every position below it moves down by one and every list of newer releases takes it too.
    expect(RELEASES.slice(0, 26).map((r) => [r.id, r.status])).toEqual([
      ['liquid-glass-2026-11', 'draft'],
      // Re-pinned by docs/whats-new-2026-11-21-phone (2026-11-21; was: without it): the phone authenticator set-up release is published later, at the top, directly below the Liquid Glass draft.
      // Re-pinned by docs/whats-new-blocked-activity (2026-11-21; was: without it): the Blocked activity release is published later, at the top, directly below the Liquid Glass draft.
      // Re-pinned by docs/whats-new-recovery-code (2026-11-23; was: without it): the recovery code release is published later, at the top, and reaches every member (its entries have no audience), an owner with every permission and module included, so it is read, seen or listed with the newer releases, and every notice this test checks is the one it checked before.
      // Re-pinned by docs/whats-new-upload-checks (2026-11-28; was: earlier positions, lists and reads): the upload checks release is published at the top, below the Liquid Glass draft, so every position below it moves down by one and every list of newer releases takes it too.
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
      // Re-pinned by docs/whats-new-integrations-message-and-api-key-rows (2026-11-16; was: without it): the Integrations and schedule event release is published later, at the top, directly below the Liquid Glass draft.
      // Re-pinned by docs/whats-new-emptied-fields-and-schedule-completion (2026-11-16; was: without it): the emptied fields and schedule completion release is published later, at the top, directly below the Liquid Glass draft.
      // Re-pinned by docs/releases-low-critical-pages (2026-11-18; was: without it): the Low + critical pages and list value release is published later, at the top, directly below the Liquid Glass draft.
      [LOW_CRITICAL_ID, 'published'],
      [EMPTIED_FIELDS_ID, 'published'],
      [CONNECTION_SCHEDULE_ID, 'published'],
      // Re-pinned by docs/whats-new-invitation-audit (2026-11-15; was: without it): the invitation audit release is published later, at the top, directly below the Liquid Glass draft.
      // Re-pinned by docs/whats-new-api-key-audit (2026-11-15; was: without it): the API key audit release is published later, at the top, directly below the Liquid Glass draft.
      // Re-pinned by docs/whats-new-authenticator-set-up-first (2026-11-15; was: without it): the authenticator set-up release is published later, at the top, directly below the Liquid Glass draft.
      // Re-pinned by docs/whats-new-delete-account-confirm (2026-11-16; was: without it): the delete account release is published later, at the top, directly below the Liquid Glass draft.
      ['delete-account-confirm-2026-11', 'published'],
      ['authenticator-set-up-first-2026-11', 'published'],
      ['api-key-audit-2026-11', 'published'],
      ['invitation-audit-2026-11', 'published'],
      // Re-pinned by docs/whats-new-navigation-keeps-choices (2026-11-15; was: without it): the navigation release is published later, at the top, directly below the Liquid Glass draft.
      ['navigation-keeps-choices-2026-11', 'published'],
      [SETTINGS_ID, 'published'],
      [MODULE_CHECK_ID, 'published'],
      [COUNT_READ_RULE_ID, 'published'],
      [EMAIL_EXPIRED_ID, 'published'],
      [PHONE_SCREENS_ID, 'published'],
      [ID, 'published'],
      [PHONE_CODE_ID, 'published'],
    ]);
    expect(RELEASES.find((r) => r.status === 'published')?.id).toBe(
      // Re-pinned by docs/whats-new-phone-screens-by-access (2026-11-14; was: ID): the phone screens by access release is published after it, at the top, the newest published release.
      // Re-pinned by docs/whats-new-count-read-rule (2026-11-15; was: the phone screens by access release): the count read rule release is published after it, at the top, the newest published release.
      // Re-pinned by docs/whats-new-unreadable-access-and-settings (2026-11-15; was: the count read rule release): the settings release is published after it, at the top, the newest published release.
      // Re-pinned by docs/whats-new-navigation-keeps-choices (2026-11-15; was: the settings release): the navigation release is published after it, at the top, the newest published release.
      // Re-pinned by docs/whats-new-invitation-audit (2026-11-15; was: the navigation release): the invitation audit release is published after it, at the top, the newest published release.
      // Re-pinned by docs/whats-new-api-key-audit (2026-11-15; was: the invitation audit release): the API key audit release is published after it, at the top, the newest published release.
      // Re-pinned by docs/whats-new-authenticator-set-up-first (2026-11-15; was: the API key audit release): the authenticator set-up release is published after it, at the top, the newest published release.
      // Re-pinned by docs/whats-new-delete-account-confirm (2026-11-16; was: the authenticator set-up release): the delete account release is published after it, at the top, the newest published release.
      // Re-pinned by docs/whats-new-integrations-message-and-api-key-rows (2026-11-16; was: the delete account release): the Integrations and schedule event release is published after it, at the top, the newest published release.
      // Re-pinned by docs/whats-new-emptied-fields-and-schedule-completion (2026-11-16; was: the Integrations and schedule event release): the emptied fields and schedule completion release is published after it, at the top, the newest published release.
      // Re-pinned by docs/releases-low-critical-pages (2026-11-18; was: the emptied fields and schedule completion release): the Low + critical pages and list value release is published after it, at the top, the newest published release.
      // Re-pinned by docs/whats-new-receiving-shown-to-managers (2026-11-19; was: the Low + critical pages and list value release): the receiving release is published after it, at the top, the newest published release.
      // Re-pinned by docs/whats-new-small-fixes-1119 (2026-11-19; was: the receiving release): the export, receipt and access release is published after it, at the top, the newest published release.
      // Re-pinned by docs/whats-new-2026-11-19-errors (2026-11-19; was: the export, receipt and access release): the count start access check release is published after it, at the top, the newest published release.
      // Re-pinned by docs/whats-new-2026-11-21-phone (2026-11-21; was: the count start access check release): the phone authenticator set-up release is published after it, at the top, the newest published release.
      // Re-pinned by docs/whats-new-blocked-activity (2026-11-21; was: PHONE_SET_UP_ID): the Blocked activity release is published after it, at the top, the newest published release.
      // Re-pinned by docs/whats-new-phone-large-text (2026-11-23; was: without it): the phone large text release is published later, at the top, and reaches every member (its one entry has no audience), an owner with every permission and module included, so it is read, seen or listed with the newer releases, and every notice this test checks is the one it checked before.
      // Re-pinned by docs/whats-new-recovery-code (2026-11-23; was: the phone large text release): the recovery code release is published at the top, below the Liquid Glass draft, so it is the first published release.
      // Re-pinned by docs/whats-new-upload-checks (2026-11-28; was: the recovery code release): the upload checks release is published after it, at the top, the newest published release.
      UPLOAD_ID,
    );
  });

  it('is dated the whole minute after the web deploy and migration 0422 were both live, with the draft placeholder at or after that minute and no later release below', () => {
    // #440 was deployed at 17:24:39Z; migration 0422 went live at 17:57:33Z.
    expect(release().publishedAt).toBe('2026-11-14T17:58:00Z');
    const at = Date.parse(release().publishedAt);
    expect(at).toBeGreaterThan(Date.parse('2026-11-14T17:24:39Z'));
    expect(at).toBeGreaterThan(Date.parse('2026-11-14T17:57:33Z'));
    expect(at).toBeLessThanOrEqual(Date.now());
    // Re-pinned by docs/whats-new-phone-screens-by-access (2026-11-14; was: the draft placeholder at this minute): the placeholder moved to the minute of the phone screens by access release, published later, so it is at or after this one.
    expect(Date.parse(RELEASES[0]!.publishedAt)).toBeGreaterThanOrEqual(at);
    // Re-pinned by docs/whats-new-phone-screens-by-access (2026-11-14; was: RELEASES.slice(2)): the phone screens by access release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-count-read-rule (2026-11-15; was: RELEASES.slice(3)): the count read rule and email change releases are published at the top, below the Liquid Glass draft, so every position below them moves down by two.
    // Re-pinned by docs/whats-new-unreadable-access-and-settings (2026-11-15; was: every pinned position two places higher): the settings and module check releases are published at the top, below the Liquid Glass draft, so every position below them moves down by two.
    // Re-pinned by docs/whats-new-navigation-keeps-choices (2026-11-15; was: every pinned position one place higher): the navigation release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-invitation-audit (2026-11-15; was: every pinned position one place higher): the invitation audit release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-api-key-audit (2026-11-15; was: every pinned position one place higher): the API key audit release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-authenticator-set-up-first (2026-11-15; was: every pinned position one place higher): the authenticator set-up release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-delete-account-confirm (2026-11-16; was: every pinned position one place higher): the delete account release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-integrations-message-and-api-key-rows (2026-11-16; was: every pinned position one place higher): the Integrations and schedule event release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-emptied-fields-and-schedule-completion (2026-11-16; was: every pinned position one place higher): the emptied fields and schedule completion release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/releases-low-critical-pages (2026-11-18; was: slice(14)): the Low + critical pages and list value release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-receiving-shown-to-managers (2026-11-19; was: RELEASES.slice(15)): the receiving release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-small-fixes-1119 (2026-11-19; was: RELEASES.slice(16)): the export, receipt and access release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-2026-11-19-errors (2026-11-19; was: RELEASES.slice(17)): the count start access check release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-2026-11-21-phone (2026-11-21; was: RELEASES.slice(18)): the phone authenticator set-up release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-blocked-activity (2026-11-21; was: RELEASES.slice(19)): the Blocked activity release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-phone-large-text (2026-11-23; was: RELEASES.slice(22)): the phone large text release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-recovery-code (2026-11-23; was: RELEASES.slice(23)): the recovery code release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-upload-checks (2026-11-28; was: earlier positions, lists and reads): the upload checks release is published at the top, below the Liquid Glass draft, so every position below it moves down by one and every list of newer releases takes it too.
    for (const r of RELEASES.slice(25)) {
      expect(at, r.id).toBeGreaterThan(Date.parse(r.publishedAt));
    }
  });

  it('parses under the shared schema, in plain text, with its two entries in order', () => {
    expect(releaseSchema.safeParse(release()).success).toBe(true);
    for (const text of readerText(release())) expect(text).not.toMatch(/[<>]/);
    expect(release().entries.map((e) => [e.id, e.category, e.area])).toEqual([
      [REMOVED_ID, 'fixed', 'Orders'],
      [BRIEFING_ID, 'fixed', 'Briefing'],
    ]);
  });
});

describe('the order request alerts release: the words', () => {
  it('has the reviewed title, and a summary that covers both entries and names nothing they do not cover', () => {
    expect(release().title).toBe(
      'New order request alerts go to the people who can approve the order',
    );
    expect(release().summary).toBe(
      'The New order request alert now goes to everyone with the "Approve / fulfill orders" permission who can approve orders in the request\'s warehouse, and stops for anyone whose permission was removed. It arrives on the web and in the mobile app, with no app update needed. Today\'s briefing also shows only the lines you can open.',
    );
    // The last sentence is for a reader who sees only the briefing entry
    // (staff who can open Today's briefing): old phone builds show only the
    // title and the summary.
    expect(
      release().summary.endsWith(" Today's briefing also shows only the lines you can open."),
    ).toBe(true);
  });

  it('says the alert stops with the permission, in the reviewed words', () => {
    const e = entry(REMOVED_ID);
    expect(e.title).toBe(
      'Removing "Approve / fulfill orders" now also stops the New order request alert',
    );
    expect(e.whatChanged).toBe(
      'An admin or manager whose "Approve / fulfill orders" permission was removed no longer gets the New order request alert.',
    );
    expect(e.whyItMatters).toBe(
      'They still got the alert for every new request, although they could no longer approve one.',
    );
    expect(e.howItAffectsYou).toBe(
      'Nothing changes for an admin or manager who keeps the permission, which they have by default: they are alerted about requests in every warehouse, as before.',
    );
    expect(e.whatToDo).toBe('No action needed.');
  });

  it("says Today's briefing shows only what the reader can open, in the reviewed words", () => {
    const e = entry(BRIEFING_ID);
    expect(e.title).toBe("Today's briefing shows only what you can open");
    expect(e.whatChanged).toBe(
      'Today\'s briefing and the morning briefing notification now leave out any line about something you cannot open. "Orders awaiting approval" shows only to people with the "Approve / fulfill orders" permission, and for a staff member it counts only the requests in the warehouses they are assigned to. Lines about purchase orders, cycle counts and items show only to people who can open those pages, and a purchase order or cycle count line only while that module is on.',
    );
    expect(e.whyItMatters).toBe(
      "Everyone who could open Today's briefing saw the organization's count of orders awaiting approval, and its link took anyone who cannot approve orders to their own requests instead.",
    );
    expect(e.howItAffectsYou).toBe(
      'Owners, and admins whose permissions were not changed, still see every line for the modules that are on.',
    );
    expect(e.whatToDo).toBe('No action needed.');
  });

  it('leaves out the entry for staff approvers, and no text names them as newly alerted', () => {
    expect(release().entries).toHaveLength(2);
    expect(
      RELEASES.flatMap((r) => r.entries).some((e) => e.id === 'order-request-alert-approvers'),
    ).toBe(false);
    expect(release().summary).not.toMatch(/staff/i);
    expect(entry(REMOVED_ID).title).not.toMatch(/staff/i);
    expect(readerText(release()).join(' ')).not.toMatch(/given the permission|gave you/i);
  });

  it('names the permission as Team settings show it, never calls a recorded quantity a book, and keeps to what people see', () => {
    expect(PERMISSION_META['orders:approve'].label).toBe('Approve / fulfill orders');
    const text = readerText(release()).join(' ');
    expect(release().summary).toContain('"Approve / fulfill orders"');
    expect(entry(REMOVED_ID).whatChanged).toContain('"Approve / fulfill orders"');
    expect(entry(BRIEFING_ID).whatChanged).toContain('"Approve / fulfill orders"');
    expect(text).not.toMatch(/\bbook(s|ed)?\b/i);
    expect(text).not.toMatch(/secur|vulnerab|exploit|leak|expos|attack|breach|unauthori/i);
    expect(text).not.toMatch(/former member|act as|support session|disabled account/i);
  });
});

describe('the order request alerts release: who is told', () => {
  it('is addressed to organizations with Orders on, each entry to the people it changes something for', () => {
    expect(release().audience).toEqual({ modules: ['orders'] });
    // Admins and managers are the people whose own alert can stop; an owner
    // can always change who holds the permission, so the owner is told too.
    expect(entry(REMOVED_ID).audience).toEqual({
      roles: ['owner', 'admin', 'manager'],
      modules: ['orders'],
    });
    expect(entry(REMOVED_ID).link).toBeUndefined();
    expect(entry(BRIEFING_ID).audience).toEqual({
      anyPermission: ['items:update'],
      modules: ['ai'],
    });
    expect(entry(BRIEFING_ID).link).toEqual({
      href: '/dashboard/insights',
      label: 'Open Briefing',
    });
  });

  it('reaches owners, admins and managers where Orders is on, briefing readers where the AI module is on too, and nobody where Orders is off', () => {
    expect(entriesFor(owner)).toEqual([REMOVED_ID, BRIEFING_ID]);
    // An owner where the AI module is off still sees the alert entry.
    expect(entriesFor(viewer('owner', [...PERMISSIONS], ['orders']))).toEqual([REMOVED_ID]);
    expect(entriesFor(viewer('owner', [...PERMISSIONS], ['ai']))).toEqual([]);
    expect(entriesFor(viewer('admin', ROLE_PERMISSIONS.admin, EVERY_MODULE))).toEqual([
      REMOVED_ID,
      BRIEFING_ID,
    ]);
    expect(entriesFor(viewer('manager', ROLE_PERMISSIONS.manager, ['orders']))).toEqual([
      REMOVED_ID,
    ]);
    // An admin or manager without the permission is told too: the entry is about them.
    expect(entriesFor(viewer('manager', [], ['orders']))).toEqual([REMOVED_ID]);
    expect(entriesFor(viewer('staff', ['items:update'], ['orders', 'ai']))).toEqual([BRIEFING_ID]);
    expect(entriesFor(viewer('staff', ['orders:approve'], ['orders']))).toEqual([]);
    expect(entriesFor(viewer('staff', ['items:update'], ['ai']))).toEqual([]);
    expect(entriesFor(viewer('admin', ROLE_PERMISSIONS.admin, ['ai']))).toEqual([]);
    expect(entriesFor(member)).toEqual([]);
  });

  it('is the newest notice for a reader it reaches once the later releases are read, and changes nothing for a reader it does not', () => {
    // Re-pinned by docs/whats-new-phone-screens-by-access (2026-11-14; was: nothing read): the phone screens by access release is published later, at the top, and reaches every member (two of its three entries have no audience), so each reader reads it first, and the notice this test checks is the one it checked before.
    // Re-pinned by docs/whats-new-count-read-rule (2026-11-15; was: the read of the phone screens by access release alone): the count read rule and email change releases are published later, at the top; the email change release reaches every member and the count read rule release reaches the owner here, so each reader reads them first, and the notice this test checks is the one it checked before. A read of a release by a reader it does not reach changes nothing.
    const newerRead = [
      // Re-pinned by docs/whats-new-unreadable-access-and-settings (2026-11-15; was: without them): the settings and module check releases are published later, at the top; the module check release reaches every member and the settings release reaches the owner here, so each reader reads them first, and the notice this test checks is the one it checked before. A read of a release by a reader it does not reach changes nothing.
      // Re-pinned by docs/whats-new-navigation-keeps-choices (2026-11-15; was: without it): the navigation release is published later, at the top, and reaches owners and admins who can open Settings, Navigation, so it is read, seen or listed with the newer releases, and every notice this test checks is the one it checked before.
      // Re-pinned by docs/whats-new-invitation-audit (2026-11-15; was: without it): the invitation audit release is published later, at the top, and reaches whoever can view the audit log (owners, admins and managers by default), so it is read or seen with the newer releases, and every notice this test checks is the one it checked before. A read of a release by a reader it does not reach changes nothing.
      // Re-pinned by docs/whats-new-api-key-audit (2026-11-15; was: without it): the API key audit release is published later, at the top, and reaches the same readers as the invitation audit release, so it is read with the newer releases, and every notice this test checks is the one it checked before. A read of a release by a reader it does not reach changes nothing.
      // Re-pinned by docs/whats-new-authenticator-set-up-first (2026-11-15; was: without it): the authenticator set-up release is published later, at the top, and reaches every member, so it is read with the newer releases, and every notice this test checks is the one it checked before.
      // Re-pinned by docs/whats-new-delete-account-confirm (2026-11-16; was: without it): the delete account release is published later, at the top, and reaches every member, so it is read with the newer releases, and every notice this test checks is the one it checked before.
      // Re-pinned by docs/whats-new-integrations-message-and-api-key-rows (2026-11-16; was: without it): the Integrations and schedule event release is published later, at the top, and reaches whoever can manage integrations or schedule events with those modules on (owners and admins, and managers for its schedule entry, by default), an owner with every permission and module included, so it is read, seen or listed with the newer releases, and every notice this test checks is the one it checked before.
      // Re-pinned by docs/whats-new-emptied-fields-and-schedule-completion (2026-11-16; was: without it): the emptied fields and schedule completion release is published later, at the top, and reaches whoever can manage the schedule or suppliers where those modules are on and whoever can manage the organization, locations or categories (owners and admins, and managers for all but its charter and warehouse entry, by default), an owner with every permission and module included, so it is read, seen or listed with the newer releases, and every notice this test checks is the one it checked before.
      // Re-pinned by docs/releases-low-critical-pages (2026-11-18; was: without it): the Low + critical pages and list value release is published later, at the top, and reaches whoever can read items (every role by default), so it is read or seen first, and the notice this test checks is the one it checked before.
      // Re-pinned by docs/whats-new-receiving-shown-to-managers (2026-11-19; was: without it): the receiving release is published later, at the top, and reaches whoever can open a purchase order where Receiving is on (owners, admins, managers, staff and viewers by default), an owner with every permission and module among them, so it is read, seen or listed with the newer releases, and every notice this test checks is the one it checked before.
      // Re-pinned by docs/whats-new-small-fixes-1119 (2026-11-19; was: without it): the export, receipt and access release is published later, at the top, and reaches every member (its access entry has no audience), an owner with every permission and module among them, so it is read, seen or listed with the newer releases, and every notice this test checks is the one it checked before.
      // Re-pinned by docs/whats-new-2026-11-21-phone (2026-11-21; was: without it): the phone authenticator set-up release is published later, at the top, and reaches every member (three of its five entries have no audience), an owner with every permission and module included, so it is read, seen or listed with the newer releases, and every notice this test checks is the one it checked before.
      // Re-pinned by docs/whats-new-blocked-activity (2026-11-21; was: without it): the Blocked activity release is published later, at the top, and reaches owners and Super Admins (their roles are its audience), so it is read, seen or listed with the newer releases for them, and every notice this test checks is the one it checked before. A read of a release by a reader it does not reach changes nothing.
      // Re-pinned by docs/whats-new-upload-checks (2026-11-28; was: earlier positions, lists and reads): the upload checks release is published at the top, below the Liquid Glass draft, so every position below it moves down by one and every list of newer releases takes it too.
      uploadRead, recoveryRead, phoneLargeRead, signInRead, blockedCurrentRead, blockedRead, phoneSetUpRead,
      // Re-pinned by docs/whats-new-2026-11-19-errors (2026-11-19; was: without it): the count start access check release is published later, at the top, and reaches a manager or above who can assign counts where Cycle Counts is on (an owner with every permission and module among them), so it is read, seen or listed with the newer releases, and every notice this test checks is the one it checked before. A read of a release by a reader it does not reach changes nothing.
      countStartAccessRead,
      exportReceiptAccessRead,
      receivingRead,
      lowCriticalRead,
      emptiedFieldsRead,
      connectionScheduleRead,
      deleteConfirmRead,
      authSetUpRead,
      {
        release_id: 'api-key-audit-2026-11',
        // Re-pinned by docs/whats-new-integrations-message-and-api-key-rows (2026-11-16; was: revision 1): the API key audit release is re-announced as revision 2, so a read of it is recorded at revision 2.
        revision: 2,
        dismissed_at: null,
        opened_at: '2026-11-15T21:30:00Z',
        read_at: '2026-11-15T21:30:00Z',
      },
      {
        release_id: 'invitation-audit-2026-11',
        revision: 1,
        dismissed_at: null,
        opened_at: '2026-11-15T05:00:00Z',
        read_at: '2026-11-15T05:00:00Z',
      },
      {
        release_id: 'navigation-keeps-choices-2026-11',
        revision: 1,
        dismissed_at: null,
        opened_at: '2026-11-15T05:00:00Z',
        read_at: '2026-11-15T05:00:00Z',
      },
      {
        release_id: SETTINGS_ID,
        revision: 1,
        dismissed_at: null,
        opened_at: '2026-11-15T04:30:00Z',
        read_at: '2026-11-15T04:30:00Z',
      },
      {
        release_id: MODULE_CHECK_ID,
        revision: 1,
        dismissed_at: null,
        opened_at: '2026-11-15T04:30:00Z',
        read_at: '2026-11-15T04:30:00Z',
      },
      {
        release_id: COUNT_READ_RULE_ID,
        revision: 1,
        dismissed_at: null,
        opened_at: '2026-11-15T00:30:00Z',
        read_at: '2026-11-15T00:30:00Z',
      },
      {
        release_id: EMAIL_EXPIRED_ID,
        revision: 1,
        dismissed_at: null,
        opened_at: '2026-11-15T00:30:00Z',
        read_at: '2026-11-15T00:30:00Z',
      },
      {
        release_id: PHONE_SCREENS_ID,
        revision: 1,
        dismissed_at: null,
        opened_at: '2026-11-14T19:00:00Z',
        read_at: '2026-11-14T19:00:00Z',
      },
    ];
    expect(buildReleaseList(RELEASES, owner, newerRead, null).latestUnread?.id).toBe(ID);
    expect(
      buildReleaseList(
        RELEASES,
        viewer('manager', ROLE_PERMISSIONS.manager, ['orders']),
        newerRead,
        null,
      ).latestUnread?.id,
    ).toBe(ID);
    expect(buildReleaseList(RELEASES, member, newerRead, null).latestUnread?.id).toBe(
      PHONE_CODE_ID,
    );
  });
});

describe('the order request alerts release: the code the words rest on', () => {
  it('the alert goes to whoever holds the permission and can write in the warehouse (migration 0422)', () => {
    const migration = repoFile('supabase/migrations/0422_notice_audience_follows_permission.sql');
    expect(migration).toContain("v_title := 'New order request' ||");
    expect(migration).toContain(
      "from public._notify_recipients_with_permission(new.organization_id, 'orders:approve') r\n       where public.user_can_access_warehouse(r.user_id, new.warehouse_id, 'write')",
    );
  });

  it('an admin or manager has the permission by default and works in every warehouse', () => {
    for (const role of ['owner', 'admin', 'manager'] as const) {
      expect(hasPermission(role, 'orders:approve'), role).toBe(true);
    }
    for (const role of ['staff', 'viewer'] as const) {
      expect(hasPermission(role, 'orders:approve'), role).toBe(false);
    }
    expect(source('lib/auth/warehouse.ts')).toContain(
      'export function roleSeesEveryWarehouse(role: Role): boolean {\n  return isManagerOrAbove(role);\n}',
    );
  });

  it('each briefing line follows the gate of the page it opens', () => {
    const access = source('server/services/insights-access.ts');
    expect(access).toContain(
      "pending_approvals: (r) =>\n    isModuleEnabled(r, 'orders') && can(r, 'orders:approve') && r.role !== 'viewer',",
    );
    expect(access).toContain(
      "overdue_pos: (r) => isModuleEnabled(r, 'purchase_orders') && can(r, 'purchase_orders:read'),",
    );
    expect(access).toContain(
      "open_pos: (r) => isModuleEnabled(r, 'purchase_orders') && can(r, 'purchase_orders:read'),",
    );
    expect(access).toContain("low_stock: (r) => can(r, 'items:read'),");
    expect(access).toContain(
      "open_cycle_counts: (r) => isModuleEnabled(r, 'cycle_counts') && canOpenCountPage(r),",
    );
    const insights = source('server/services/insights.ts');
    expect(insights).toContain("'orders awaiting approval'");
    expect(insights).toContain('approvablePendingCount()');
    const orders = source('server/services/order-requests.ts');
    expect(orders).toContain(
      "if (this.ctx.role === 'viewer' || !can(this.ctx, 'orders:approve')) return 0;",
    );
    expect(orders).toContain('if (!roleSeesEveryWarehouse(this.ctx.role)) {');
  });

  it("the linked page is Today's briefing, behind the AI module and items:update", () => {
    const page = source('app/(dashboard)/dashboard/insights/page.tsx');
    expect(page).toContain("const access = await checkModuleAccess('ai');");
    expect(page).toContain("if (!can(ctx, 'items:update')) redirect('/dashboard');");
    expect(page).toContain('Today&apos;s briefing');
  });
});

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  PERMISSION_META,
  PERMISSIONS,
  releaseSchema,
  ROLE_PERMISSIONS,
  type Release,
  type ReleaseViewer,
} from '@stockpilot/core';

import { AUDIT_CATEGORIES } from '@/components/admin/audit-categories';
import { formatAuditEvent } from '@/lib/audit/format';

import { buildReleaseList, legacyAnnouncementsFor, visibleReleases } from './logic';
import { RELEASES } from './registry';

/**
 * Added by docs/whats-new-invitation-audit (2026-11-15): the What's New for
 * #579 (squash 01ead76fa, live in production since 2026-11-15 17:17:30Z),
 * published at the top, below the Liquid Glass draft and above the navigation
 * release. Web only: no phone update and no migration. Its own file, so the
 * release tests other open branches edit stay as they are.
 */
const ID = 'invitation-audit-2026-11';
const ENTRY_ID = 'invitations-in-audit-log';
const NAVIGATION_ID = 'navigation-keeps-choices-2026-11';
// Added by docs/whats-new-api-key-audit (2026-11-15): the API key audit release (whoever can view the audit log), published later, directly above this one.
const API_KEY_AUDIT_ID = 'api-key-audit-2026-11';
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
// Added by docs/whats-new-integrations-message-and-api-key-rows (2026-11-16): the Integrations and schedule event release (whoever can manage integrations where Integrations is on, and whoever can manage the schedule where Schedule is on), published later, at the top, below the Liquid Glass draft.
const CONNECTION_SCHEDULE_ID = 'connection-and-schedule-messages-2026-11';
// Added by docs/whats-new-emptied-fields-and-schedule-completion (2026-11-16): the emptied fields and schedule completion release (whoever can manage the schedule or suppliers where those modules are on, and whoever can manage the organization, locations or categories), published later, at the top, below the Liquid Glass draft.
const EMPTIED_FIELDS_ID = 'emptied-fields-and-schedule-completion-2026-11';
const emptiedFieldsRead = {
  release_id: EMPTIED_FIELDS_ID,
  // Re-pinned by bundles/hand-out-follows-the-manager-rule (2026-11-16; was: revision 1): the emptied fields and schedule completion release is re-announced as revision 2, so a read of it is recorded at revision 2.
  revision: 2,
  dismissed_at: null,
  opened_at: '2026-11-16T12:34:00Z',
  read_at: '2026-11-16T12:34:00Z',
};
const deleteConfirmRead = {
  release_id: DELETE_CONFIRM_ID,
  revision: 1,
  dismissed_at: null,
  opened_at: '2026-11-16T04:05:00Z',
  read_at: '2026-11-16T04:05:00Z',
};
const apiKeyAuditRead = {
  release_id: API_KEY_AUDIT_ID,
  // Re-pinned by docs/whats-new-integrations-message-and-api-key-rows (2026-11-16; was: revision 1): the API key audit release is re-announced as revision 2, so a read of it is recorded at revision 2.
  revision: 2,
  dismissed_at: null,
  opened_at: '2026-11-15T21:30:00Z',
  read_at: '2026-11-15T21:30:00Z',
};
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
const PUBLISHED_AT = '2026-11-15T17:39:00Z';

const release = () => RELEASES.find((r) => r.id === ID)!;
const entry = () => release().entries.find((e) => e.id === ENTRY_ID)!;

const viewer = (
  role: ReleaseViewer['role'],
  permissions: ReleaseViewer['permissions'],
  enabledModules: ReleaseViewer['enabledModules'] = [],
): ReleaseViewer => ({ role, permissions, enabledModules });
const owner = viewer('owner', [...PERMISSIONS]);
const admin = viewer('admin', ROLE_PERMISSIONS.admin);
const manager = viewer('manager', ROLE_PERMISSIONS.manager);
const staff = viewer('staff', ROLE_PERMISSIONS.staff);
const defaultViewer = viewer('viewer', ROLE_PERMISSIONS.viewer);
const member = viewer('viewer', []);
const seesIt = (v: ReleaseViewer) => visibleReleases(RELEASES, v).some((r) => r.id === ID);

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

describe('the invitation audit release: order, status and date', () => {
  // Renamed by docs/whats-new-api-key-audit (2026-11-15; was: "is published once, as revision 1, directly below the Liquid Glass draft and above the navigation release, the newest published release"): the API key audit release is published later, directly below the draft and above this one. Claim kept: published once, as revision 1, directly above the navigation release.
  it('is published once, as revision 1, directly below the API key audit release (published later, below the Liquid Glass draft at the top) and above the navigation release', () => {
    expect(RELEASES.filter((r) => r.id === ID)).toHaveLength(1);
    expect(release().status).toBe('published');
    expect(release().revision).toBe(1);
    expect(release().withdrawnNote).toBeUndefined();
    // Re-pinned by docs/whats-new-api-key-audit (2026-11-15; was: RELEASES.slice(0, 4), without it): the API key audit release is published later, at the top, directly below the Liquid Glass draft.
    // Re-pinned by docs/whats-new-authenticator-set-up-first (2026-11-15; was: every pinned position one place higher): the authenticator set-up release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-delete-account-confirm (2026-11-16; was: every pinned position one place higher): the delete account release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-integrations-message-and-api-key-rows (2026-11-16; was: RELEASES.slice(0, 7)): the Integrations and schedule event release is published at the top, below the Liquid Glass draft, so the list takes one more.
    // Re-pinned by docs/whats-new-emptied-fields-and-schedule-completion (2026-11-16; was: RELEASES.slice(0, 8)): the emptied fields and schedule completion release is published at the top, below the Liquid Glass draft, so the list takes one more.
    // Re-pinned by docs/releases-low-critical-pages (2026-11-18; was: RELEASES.slice(0, 9)): the Low + critical pages and list value release is published at the top, below the Liquid Glass draft, so the list takes one more.
    // Re-pinned by docs/whats-new-receiving-shown-to-managers (2026-11-19; was: RELEASES.slice(0, 10)): the receiving release is published at the top, below the Liquid Glass draft, so the list takes one more.
    // Re-pinned by docs/whats-new-small-fixes-1119 (2026-11-19; was: RELEASES.slice(0, 11)): the export, receipt and access release is published at the top, below the Liquid Glass draft, so the list takes one more.
    // Re-pinned by docs/whats-new-2026-11-19-errors (2026-11-19; was: RELEASES.slice(0, 12)): the count start access check release is published at the top, below the Liquid Glass draft, so the list takes one more.
    // Re-pinned by docs/whats-new-2026-11-21-phone (2026-11-21; was: RELEASES.slice(0, 13)): the phone authenticator set-up release is published at the top, below the Liquid Glass draft, so the list takes one more.
    // Re-pinned by docs/whats-new-blocked-activity (2026-11-21; was: RELEASES.slice(0, 14)): the Blocked activity release is published at the top, below the Liquid Glass draft, so the list takes one more.
    // Re-pinned by docs/whats-new-recovery-code (2026-11-23; was: RELEASES.slice(0, 17)): the recovery code release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-upload-checks (2026-11-28; was: earlier positions, lists and reads): the upload checks release is published at the top, below the Liquid Glass draft, so every position below it moves down by one and every list of newer releases takes it too.
    expect(RELEASES.slice(0, 19).map((r) => [r.id, r.status])).toEqual([
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
      // Re-pinned by docs/releases-low-critical-pages (2026-11-18; was: without it): the Low + critical pages and list value release is published later, at the top, directly below the Liquid Glass draft.
      [LOW_CRITICAL_ID, 'published'],
      // Re-pinned by docs/whats-new-api-key-audit (2026-11-15; was: without it): the API key audit release is published later, at the top, directly below the Liquid Glass draft.
      // Re-pinned by docs/whats-new-authenticator-set-up-first (2026-11-15; was: without it): the authenticator set-up release is published later, at the top, directly below the Liquid Glass draft.
      // Re-pinned by docs/whats-new-delete-account-confirm (2026-11-16; was: without it): the delete account release is published later, at the top, directly below the Liquid Glass draft.
      // Re-pinned by docs/whats-new-integrations-message-and-api-key-rows (2026-11-16; was: without it): the Integrations and schedule event release is published later, at the top, directly below the Liquid Glass draft.
      // Re-pinned by docs/whats-new-emptied-fields-and-schedule-completion (2026-11-16; was: without it): the emptied fields and schedule completion release is published later, at the top, directly below the Liquid Glass draft.
      [EMPTIED_FIELDS_ID, 'published'],
      [CONNECTION_SCHEDULE_ID, 'published'],
      [DELETE_CONFIRM_ID, 'published'],
      [AUTH_SET_UP_ID, 'published'],
      [API_KEY_AUDIT_ID, 'published'],
      [ID, 'published'],
      [NAVIGATION_ID, 'published'],
    ]);
    // Re-pinned by docs/whats-new-api-key-audit (2026-11-15; was: ID): the API key audit release is published after it, at the top, the newest published release.
    // Re-pinned by docs/whats-new-authenticator-set-up-first (2026-11-15; was: API_KEY_AUDIT_ID): the authenticator set-up release is published after it, at the top, the newest published release.
    // Re-pinned by docs/whats-new-delete-account-confirm (2026-11-16; was: AUTH_SET_UP_ID): the delete account release is published after it, at the top, the newest published release.
    // Re-pinned by docs/whats-new-integrations-message-and-api-key-rows (2026-11-16; was: DELETE_CONFIRM_ID): the Integrations and schedule event release is published after it, at the top, the newest published release.
    // Re-pinned by docs/whats-new-emptied-fields-and-schedule-completion (2026-11-16; was: the Integrations and schedule event release): the emptied fields and schedule completion release is published after it, at the top, the newest published release.
    // Re-pinned by docs/releases-low-critical-pages (2026-11-18; was: EMPTIED_FIELDS_ID): the Low + critical pages and list value release is published after it, at the top, the newest published release.
    // Re-pinned by docs/whats-new-receiving-shown-to-managers (2026-11-19; was: the Low + critical pages and list value release): the receiving release is published after it, at the top, the newest published release.
    // Re-pinned by docs/whats-new-small-fixes-1119 (2026-11-19; was: the receiving release): the export, receipt and access release is published after it, at the top, the newest published release.
    // Re-pinned by docs/whats-new-2026-11-19-errors (2026-11-19; was: the export, receipt and access release): the count start access check release is published after it, at the top, the newest published release.
    // Re-pinned by docs/whats-new-2026-11-21-phone (2026-11-21; was: COUNT_START_ACCESS_ID): the phone authenticator set-up release is published after it, at the top, the newest published release.
    // Re-pinned by docs/whats-new-blocked-activity (2026-11-21; was: PHONE_SET_UP_ID): the Blocked activity release is published after it, at the top, the newest published release.
    // Re-pinned by docs/whats-new-upload-checks (2026-11-28; was: earlier positions, lists and reads): the upload checks release is published at the top, below the Liquid Glass draft, so every position below it moves down by one and every list of newer releases takes it too.
    expect(RELEASES.find((r) => r.status === 'published')?.id).toBe(UPLOAD_ID);
  });

  // Renamed by docs/whats-new-api-key-audit (2026-11-15; was: "is dated on a whole minute after #579 went live, in the past, with the draft placeholder at the same minute and every release below it older"): the API key audit release above is dated later, and the draft placeholder moved to its minute. Claim kept: a whole minute after #579 went live, in the past, every release below it older.
  it('is dated on a whole minute after #579 went live, in the past, with the draft placeholder at or after it and every release below it older', () => {
    expect(release().publishedAt).toBe(PUBLISHED_AT);
    const at = Date.parse(release().publishedAt);
    expect(at).toBeGreaterThan(Date.parse('2026-11-15T17:17:30Z'));
    expect(at).toBeLessThanOrEqual(Date.now());
    // Re-pinned by docs/whats-new-api-key-audit (2026-11-15; was: RELEASES[0]!.publishedAt toBe this minute): the draft placeholder moved to the minute of the API key audit release, published later, directly above this one.
    expect(Date.parse(RELEASES[0]!.publishedAt)).toBeGreaterThanOrEqual(at);
    // Re-pinned by docs/whats-new-api-key-audit (2026-11-15; was: every pinned position one place higher): the API key audit release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-authenticator-set-up-first (2026-11-15; was: every pinned position one place higher): the authenticator set-up release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-delete-account-confirm (2026-11-16; was: every pinned position one place higher): the delete account release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-integrations-message-and-api-key-rows (2026-11-16; was: every pinned position one place higher): the Integrations and schedule event release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-emptied-fields-and-schedule-completion (2026-11-16; was: every pinned position one place higher): the emptied fields and schedule completion release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/releases-low-critical-pages (2026-11-18; was: every pinned position one place higher): the Low + critical pages and list value release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-receiving-shown-to-managers (2026-11-19; was: RELEASES.slice(8)): the receiving release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-small-fixes-1119 (2026-11-19; was: RELEASES.slice(9)): the export, receipt and access release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-2026-11-19-errors (2026-11-19; was: RELEASES.slice(10)): the count start access check release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-2026-11-21-phone (2026-11-21; was: RELEASES.slice(11)): the phone authenticator set-up release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-blocked-activity (2026-11-21; was: RELEASES.slice(12)): the Blocked activity release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-phone-large-text (2026-11-23; was: RELEASES.slice(15)): the phone large text release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-recovery-code (2026-11-23; was: RELEASES.slice(16)): the recovery code release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-upload-checks (2026-11-28; was: earlier positions, lists and reads): the upload checks release is published at the top, below the Liquid Glass draft, so every position below it moves down by one and every list of newer releases takes it too.
    for (const r of RELEASES.slice(18)) {
      expect(at, r.id).toBeGreaterThan(Date.parse(r.publishedAt));
    }
  });

  it('parses under the shared schema, in plain text, with its one entry', () => {
    expect(releaseSchema.safeParse(release()).success).toBe(true);
    for (const text of readerText(release())) expect(text).not.toMatch(/[<>!]/);
    expect(release().entries.map((e) => [e.id, e.category, e.area])).toEqual([
      [ENTRY_ID, 'improved', 'Audit log'],
    ]);
    expect(
      RELEASES.filter((r) => r.entries.some((x) => x.id === ENTRY_ID)).map((r) => r.id),
    ).toEqual([ID]);
  });
});

describe('the invitation audit release: the words', () => {
  it('says what the rows hold and where they are, as written', () => {
    expect(release().title).toBe('Sending and revoking an invitation now show in the Audit log');
    expect(release().summary).toBe(
      'The Audit log now records when an invitation to join your organization is sent and when one is revoked, with the invited address and role. On the web, both rows are under the Team chip. People who can view the audit log see them. No app update is needed.',
    );
    expect(entry().title).toBe('Sending and revoking an invitation now show in the Audit log');
    expect(entry().whatChanged).toBe(
      'The Audit log now has a User · Invited row for each invitation sent and a User Invite · Revoked row for each invitation revoked. The User · Invited row holds the invited address, the role, whether the invitation offers all warehouses, the ids of the warehouse and charters it names, and whether the invitation email went out. The User Invite · Revoked row holds the address and role the invitation had. Resending an invitation was already recorded as User · Invited.',
    );
    expect(entry().whyItMatters).toBe(
      'The Audit log shows who sent or revoked an invitation, and when.',
    );
    expect(entry().howItAffectsYou).toBe(
      'On the web, both rows are under the Team chip, and the link below a row opens its details. People who can view the audit log see them: owners, admins and managers by default, and anyone given View audit log. The Audit log in the mobile app lists them among its recent events as user.invited and user.invite.revoked, without the details.',
    );
    expect(entry().whatToDo).toBe(
      'No action needed. To see them on the web, open the Audit log and choose the Team chip.',
    );
    expect(entry().link).toEqual({
      href: '/dashboard/audit?category=user',
      label: 'Open the Audit log',
    });
  });

  it('keeps to the wording rules: no emoji, no exclamation mark, no "book", no claim that an email was sent', () => {
    for (const text of readerText(release())) {
      expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
      expect(text).not.toMatch(/\bbook/i);
      expect(text).not.toMatch(/\b(we|StockPilot) (sent|emailed|sends|emails)\b/i);
    }
  });
});

describe('the invitation audit release: who is told', () => {
  it('names the permission the Audit log page checks, and no module', () => {
    expect(release().audience).toBeUndefined();
    expect(entry().audience).toEqual({ anyPermission: ['activity_logs:read'] });
  });

  it('reaches owners, admins and managers by default and anyone given View audit log, and nobody else', () => {
    for (const v of [owner, admin, manager]) expect(seesIt(v), v.role).toBe(true);
    for (const v of [staff, defaultViewer, member]) expect(seesIt(v), v.role).toBe(false);
    expect(seesIt(viewer('viewer', ['activity_logs:read']))).toBe(true);
    expect(
      seesIt(
        viewer(
          'admin',
          ROLE_PERMISSIONS.admin.filter((p) => p !== 'activity_logs:read'),
        ),
      ),
    ).toBe(false);
  });

  // Renamed by docs/whats-new-api-key-audit (2026-11-15; was: "is the first notice for whoever it reaches, and the navigation release is next for owners and admins"): the API key audit release is published later and reaches the same readers, who read it first. Claim kept: the notice for whoever it reaches, and the navigation release next for owners and admins.
  // Renamed by docs/whats-new-authenticator-set-up-first (2026-11-15; was: "is the notice for whoever it reaches once the API key audit release is read, and the navigation release is next for owners and admins"): the authenticator set-up release is published later and reaches every member, who read it first. Claim kept: the notice for whoever it reaches, and the navigation release next for owners and admins.
  // Renamed by docs/whats-new-delete-account-confirm (2026-11-16; was: "is the notice for whoever it reaches once the authenticator set-up and API key audit releases are read, and the navigation release is next for owners and admins"): the delete account release is published later and reaches every member, who read it first. Claim kept: the notice for whoever it reaches, and the navigation release next for owners and admins.
  // Renamed by docs/whats-new-emptied-fields-and-schedule-completion (2026-11-16; was: "is the notice for whoever it reaches once the delete account, authenticator set-up and API key audit releases are read, and the navigation release is next for owners and admins"): the emptied fields and schedule completion release is published later, at the top, and reaches owners, admins and managers by default, so it is read first. Claim kept: the notice for whoever it reaches once the newer releases are read, and the navigation release next for owners and admins.
  it('is the notice for whoever it reaches once the emptied fields, delete account, authenticator set-up and API key audit releases are read, and the navigation release is next for owners and admins', () => {
    const read = {
      release_id: ID,
      revision: 1,
      dismissed_at: null,
      opened_at: '2026-11-15T18:00:00Z',
      read_at: '2026-11-15T18:00:00Z',
    };
    for (const v of [owner, admin, manager]) {
      // Re-pinned by docs/whats-new-api-key-audit (2026-11-15; was: nothing read): the API key audit release is published later, at the top, and reaches the same readers, so each reads it first, and the notice this test checks is the one it checked before.
      // Re-pinned by docs/whats-new-authenticator-set-up-first (2026-11-15; was: without it): the authenticator set-up release is published later, at the top, and reaches every member, so it is read or seen first, and the notice this test checks is the one it checked before.
      // Re-pinned by docs/whats-new-delete-account-confirm (2026-11-16; was: without it): the delete account release is published later, at the top, and reaches every member, so it is read or seen first, and the notice this test checks is the one it checked before.
      // Re-pinned by docs/whats-new-emptied-fields-and-schedule-completion (2026-11-16; was: without it): the emptied fields and schedule completion release is published later, at the top, and reaches owners, admins and managers by default (its location and category entries need no module), so it is read or seen first, and the notice this test checks is the one it checked before.
      expect(
        // Re-pinned by docs/releases-low-critical-pages (2026-11-18; was: without it): the Low + critical pages and list value release is published later, at the top, and reaches whoever can read items (every role by default), so it is read or seen first, and the notice this test checks is the one it checked before.
        // Re-pinned by docs/whats-new-small-fixes-1119 (2026-11-19; was: without it): the export, receipt and access release is published later, at the top, and reaches every member (its access entry has no audience), so it is read or seen first, and the notice this test checks is the one it checked before.
        // Re-pinned by docs/whats-new-2026-11-21-phone (2026-11-21; was: without it): the phone authenticator set-up release is published later, at the top, and reaches every member (three of its five entries have no audience), an owner with every permission and module included, so it is read, seen or listed with the newer releases, and every notice this test checks is the one it checked before.
        // Re-pinned by docs/whats-new-blocked-activity (2026-11-21; was: without it): the Blocked activity release is published later, at the top, and reaches owners and Super Admins (their roles are its audience), so it is read, seen or listed with the newer releases for them, and every notice this test checks is the one it checked before. A read of a release by a reader it does not reach changes nothing.
        // Re-pinned by docs/whats-new-upload-checks (2026-11-28; was: earlier positions, lists and reads): the upload checks release is published at the top, below the Liquid Glass draft, so every position below it moves down by one and every list of newer releases takes it too.
        buildReleaseList(RELEASES, v, [uploadRead, recoveryRead, phoneLargeRead, signInRead, blockedCurrentRead, blockedRead, phoneSetUpRead, exportReceiptAccessRead, lowCriticalRead, emptiedFieldsRead, deleteConfirmRead, authSetUpRead, apiKeyAuditRead], null)
          .latestUnread?.id,
        v.role,
      ).toBe(ID);
    }
    for (const v of [owner, admin]) {
      // Re-pinned by docs/whats-new-api-key-audit (2026-11-15; was: [read]): the API key audit release is read too, as above.
      expect(
        // Re-pinned by docs/whats-new-authenticator-set-up-first (2026-11-15; was: without it): the authenticator set-up release is published later, at the top, and reaches every member, so it is read or seen first, and the notice this test checks is the one it checked before.
        // Re-pinned by docs/whats-new-delete-account-confirm (2026-11-16; was: without it): the delete account release is published later, at the top, and reaches every member, so it is read or seen first, and the notice this test checks is the one it checked before.
        // Re-pinned by docs/whats-new-emptied-fields-and-schedule-completion (2026-11-16; was: without it): the emptied fields and schedule completion release is published later, at the top, and reaches owners, admins and managers by default (its location and category entries need no module), so it is read or seen first, and the notice this test checks is the one it checked before.
        buildReleaseList(
          RELEASES,
          v,
          // Re-pinned by docs/releases-low-critical-pages (2026-11-18; was: without it): the Low + critical pages and list value release is published later, at the top, and reaches whoever can read items (every role by default), so it is read or seen first, and the notice this test checks is the one it checked before.
          // Re-pinned by docs/whats-new-small-fixes-1119 (2026-11-19; was: without it): the export, receipt and access release is published later, at the top, and reaches every member (its access entry has no audience), so it is read or seen first, and the notice this test checks is the one it checked before.
          // Re-pinned by docs/whats-new-2026-11-21-phone (2026-11-21; was: without it): the phone authenticator set-up release is published later, at the top, and reaches every member (three of its five entries have no audience), an owner with every permission and module included, so it is read, seen or listed with the newer releases, and every notice this test checks is the one it checked before.
          // Re-pinned by docs/whats-new-blocked-activity (2026-11-21; was: without it): the Blocked activity release is published later, at the top, and reaches owners and Super Admins (their roles are its audience), so it is read, seen or listed with the newer releases for them, and every notice this test checks is the one it checked before. A read of a release by a reader it does not reach changes nothing.
          // Re-pinned by docs/whats-new-upload-checks (2026-11-28; was: earlier positions, lists and reads): the upload checks release is published at the top, below the Liquid Glass draft, so every position below it moves down by one and every list of newer releases takes it too.
          [uploadRead, recoveryRead, phoneLargeRead, signInRead, blockedCurrentRead, blockedRead, phoneSetUpRead, exportReceiptAccessRead, lowCriticalRead, emptiedFieldsRead, deleteConfirmRead, authSetUpRead, apiKeyAuditRead, read],
          null,
        ).latestUnread?.id,
        v.role,
      ).toBe(NAVIGATION_ID);
    }
    // A reader it does not reach keeps the notice they had.
    // Re-pinned by docs/whats-new-authenticator-set-up-first (2026-11-15; was: without it): the authenticator set-up release is published later, at the top, and reaches every member, so it is read or seen first, and the notice this test checks is the one it checked before.
    // Re-pinned by docs/whats-new-delete-account-confirm (2026-11-16; was: without it): the delete account release is published later, at the top, and reaches every member, so it is read or seen first, and the notice this test checks is the one it checked before.
    // Re-pinned by docs/releases-low-critical-pages (2026-11-18; was: without it): the Low + critical pages and list value release is published later, at the top, and reaches whoever can read items (every role by default), so it is read or seen first, and the notice this test checks is the one it checked before.
    // Re-pinned by docs/whats-new-small-fixes-1119 (2026-11-19; was: without it): the export, receipt and access release is published later, at the top, and reaches every member (its access entry has no audience), so it is read or seen first, and the notice this test checks is the one it checked before.
    // Re-pinned by docs/whats-new-2026-11-21-phone (2026-11-21; was: without it): the phone authenticator set-up release is published later, at the top, and reaches every member (three of its five entries have no audience), an owner with every permission and module included, so it is read, seen or listed with the newer releases, and every notice this test checks is the one it checked before.
    // Re-pinned by docs/whats-new-blocked-activity (2026-11-21; was: without it): the Blocked activity release is published later, at the top, and reaches owners and Super Admins (their roles are its audience), so it is read, seen or listed with the newer releases for them, and every notice this test checks is the one it checked before. A read of a release by a reader it does not reach changes nothing.
    // Re-pinned by docs/whats-new-upload-checks (2026-11-28; was: earlier positions, lists and reads): the upload checks release is published at the top, below the Liquid Glass draft, so every position below it moves down by one and every list of newer releases takes it too.
    expect(buildReleaseList(RELEASES, staff, [uploadRead, recoveryRead, phoneLargeRead, signInRead, blockedCurrentRead, blockedRead, phoneSetUpRead, exportReceiptAccessRead, lowCriticalRead, deleteConfirmRead, authSetUpRead], null).latestUnread?.id).not.toBe(ID);
    // An older phone build shows the newest one it has not seen: this title and summary, with
    // the link to the page.
    // Re-pinned by docs/whats-new-api-key-audit (2026-11-15; was: nothing seen): the API key audit release is published later and reaches managers, so the phone has seen it first.
    // Re-pinned by docs/whats-new-authenticator-set-up-first (2026-11-15; was: without it): the authenticator set-up release is published later, at the top, and reaches every member, so it is read or seen first, and the notice this test checks is the one it checked before.
    // Re-pinned by docs/whats-new-delete-account-confirm (2026-11-16; was: without it): the delete account release is published later, at the top, and reaches every member, so it is read or seen first, and the notice this test checks is the one it checked before.
    expect(
      legacyAnnouncementsFor(RELEASES, manager, {
        // Re-pinned by docs/whats-new-emptied-fields-and-schedule-completion (2026-11-16; was: without it): the emptied fields and schedule completion release is published later, at the top, and reaches owners, admins and managers by default (its location and category entries need no module), so it is read or seen first, and the notice this test checks is the one it checked before.
        // Re-pinned by docs/releases-low-critical-pages (2026-11-18; was: without it): the Low + critical pages and list value release is published later, at the top, and reaches whoever can read items (every role by default), so it is read or seen first, and the notice this test checks is the one it checked before.
        // Re-pinned by docs/whats-new-2026-11-21-phone (2026-11-21; was: without it): the phone authenticator set-up release is published later, at the top, and reaches every member (three of its five entries have no audience), an owner with every permission and module included, so it is read, seen or listed with the newer releases, and every notice this test checks is the one it checked before.
        // Re-pinned by docs/whats-new-blocked-activity (2026-11-21; was: without it): the Blocked activity release is published later, at the top, and reaches owners and Super Admins (their roles are its audience), so it is read, seen or listed with the newer releases for them, and every notice this test checks is the one it checked before. A read of a release by a reader it does not reach changes nothing.
        // Re-pinned by docs/whats-new-recovery-code (2026-11-23; was: without it): the recovery code release is published later, at the top, and reaches every member (its entries have no audience), an owner with every permission and module included, so it is read, seen or listed with the newer releases, and every notice this test checks is the one it checked before.
        // Re-pinned by docs/whats-new-upload-checks (2026-11-28; was: earlier positions, lists and reads): the upload checks release is published at the top, below the Liquid Glass draft, so every position below it moves down by one and every list of newer releases takes it too.
        [UPLOAD_ID]: true, [RECOVERY_ID]: true,
        [PHONE_LARGE_ID]: true,
        [SIGNIN_ID]: true,
        [BLOCKED_CURRENT_ID]: true,
        [BLOCKED_ID]: true,
        [PHONE_SET_UP_ID]: true,
        // Re-pinned by docs/whats-new-2026-11-19-errors (2026-11-19; was: without it): the count start access check release is published later, at the top, and reaches a manager or above who can assign counts where Cycle Counts is on (an owner with every permission and module among them), so it is read, seen or listed with the newer releases, and every notice this test checks is the one it checked before. A read of a release by a reader it does not reach changes nothing.
        [COUNT_START_ACCESS_ID]: true,
        // Re-pinned by docs/whats-new-small-fixes-1119 (2026-11-19; was: without it): the export, receipt and access release is published later, at the top, and reaches every member (its access entry has no audience), so it is read or seen first, and the notice this test checks is the one it checked before.
        [EXPORT_RECEIPT_ACCESS_ID]: true,
        [LOW_CRITICAL_ID]: true,
        [EMPTIED_FIELDS_ID]: true,
        [DELETE_CONFIRM_ID]: true,
        [AUTH_SET_UP_ID]: true,
        [API_KEY_AUDIT_ID]: true,
      })[0],
    ).toEqual({
      id: ID,
      date: '2026-11-15',
      title: release().title,
      body: release().summary,
      cta: { href: '/dashboard/audit?category=user', label: 'Open the Audit log' },
    });
  });
});

describe('the invitation audit release: the code the words rest on', () => {
  it('the Audit log page opens with activity_logs:read and checks no module', () => {
    const page = source('apps/web/src/app/(dashboard)/dashboard/audit/page.tsx');
    expect(page).toContain("if (!can(ctx, 'activity_logs:read')) {");
    expect(page).not.toMatch(/enabledModules|isModuleEnabled|requireModule/);
    expect(PERMISSION_META['activity_logs:read'].label).toBe('View audit log');
    expect(ROLE_PERMISSIONS.manager).toContain('activity_logs:read');
    expect(ROLE_PERMISSIONS.admin).toContain('activity_logs:read');
    expect(ROLE_PERMISSIONS.staff).not.toContain('activity_logs:read');
    expect(ROLE_PERMISSIONS.viewer).not.toContain('activity_logs:read');
  });

  it('sending and revoking write the two rows, with the fields the entry names', () => {
    const team = source('apps/web/src/server/services/team.ts');
    expect(team).toContain("event: 'user.invited',");
    expect(team).toContain("event: 'user.invite.revoked',");
    expect(team).toContain('email_sent: sent.ok,');
    expect(team).toContain('charter_ids: charterIds.length > 0 ? charterIds : null,');
    expect(team).toContain(".select('id, email, role')");
  });

  it('the rows read User · Invited and User Invite · Revoked, under the Team chip', () => {
    expect(formatAuditEvent('user.invited')).toBe('User · Invited');
    expect(formatAuditEvent('user.invite.revoked')).toBe('User Invite · Revoked');
    expect(AUDIT_CATEGORIES.find((c) => c.slug === 'user')).toEqual({
      slug: 'user',
      label: 'Team',
      prefixes: ['user.', 'api_key.'],
    });
  });

  it('the mobile app lists a row by its event name, without the details', () => {
    const screen = source('apps/mobile/app/(drawer)/admin/audit.tsx');
    expect(screen).toContain('{row.event}');
    expect(screen).not.toContain('MetadataDiff');
  });
});

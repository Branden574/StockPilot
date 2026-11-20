import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  PERMISSIONS,
  releaseSchema,
  ROLE_PERMISSIONS,
  type Release,
  type ReleaseViewer,
} from '@stockpilot/core';

import { buildReleaseList, legacyAnnouncementsFor, visibleReleases } from './logic';
import { RELEASES } from './registry';

/**
 * Added by docs/whats-new-navigation-keeps-choices (2026-11-15): the release
 * for #564 (squash 87b39194c, web only, no phone update, no migration).
 * Saving Settings, Navigation keeps the stored hides, renames and places of
 * the links of modules that are off, so they come back as left when the
 * module is turned on again. Reset to default still clears everything.
 *
 * It is the newest published release and sits directly below the Liquid Glass
 * draft, above the settings release for #563 (settings-not-loaded-2026-11,
 * registry.settings-not-loaded.test.ts). Its own file, so the release tests
 * other open branches edit stay as they are.
 */
const ID = 'navigation-keeps-choices-2026-11';
const ENTRY_ID = 'navigation-keeps-choices-of-modules-off';
const SETTINGS_ID = 'settings-not-loaded-2026-11';
const MODULE_CHECK_ID = 'module-check-try-again-2026-11';
// Added by docs/whats-new-invitation-audit (2026-11-15): the invitation audit release (whoever can view the audit log), published later, directly above this one.
// Added by docs/whats-new-api-key-audit (2026-11-15): the API key audit release (whoever can view the audit log), published later, directly above the invitation audit release.
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
// Added by docs/whats-new-2026-11-19-errors (2026-11-19): the count start access check release (a manager or above who can assign counts, where Cycle Counts is on), published later, at the top, below the Liquid Glass draft.
const COUNT_START_ACCESS_ID = 'count-start-access-check-2026-11';
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
const emptiedFieldsRead = {
  release_id: EMPTIED_FIELDS_ID,
  // Re-pinned by bundles/hand-out-follows-the-manager-rule (2026-11-16; was: revision 1): the emptied fields and schedule completion release is re-announced as revision 2, so a read of it is recorded at revision 2.
  revision: 2,
  dismissed_at: null,
  opened_at: '2026-11-16T12:34:00Z',
  read_at: '2026-11-16T12:34:00Z',
};
const INVITATION_AUDIT_ID = 'invitation-audit-2026-11';
const invitationAuditRead = {
  release_id: INVITATION_AUDIT_ID,
  revision: 1,
  dismissed_at: null,
  opened_at: '2026-11-15T18:00:00Z',
  read_at: '2026-11-15T18:00:00Z',
};
// Added by docs/whats-new-api-key-audit (2026-11-15): the API key audit release (whoever can view the audit log), published later, directly above the invitation audit release.
const apiKeyAuditRead = {
  release_id: API_KEY_AUDIT_ID,
  // Re-pinned by docs/whats-new-integrations-message-and-api-key-rows (2026-11-16; was: revision 1): the API key audit release is re-announced as revision 2, so a read of it is recorded at revision 2.
  revision: 2,
  dismissed_at: null,
  opened_at: '2026-11-15T21:30:00Z',
  read_at: '2026-11-15T21:30:00Z',
};

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
/** A source file under apps/web/src, as written. */
const source = (rel: string) => readFileSync(resolve(REPO, `apps/web/src/${rel}`), 'utf8');

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

describe('the navigation release: order, status and date', () => {
  // Renamed by docs/whats-new-invitation-audit (2026-11-15; was: "is published once, as revision 1, directly below the Liquid Glass draft and above the settings release, the newest published release"): the invitation audit release is published later, directly below the draft and above this one. Claim kept: published once, as revision 1, directly above the settings release.
  it('is published once, as revision 1, directly below the invitation audit release (published later, below the Liquid Glass draft at the top) and above the settings release', () => {
    expect(RELEASES.filter((r) => r.id === ID)).toHaveLength(1);
    expect(release().status).toBe('published');
    expect(release().revision).toBe(1);
    expect(release().withdrawnNote).toBeUndefined();
    // Re-pinned by docs/whats-new-invitation-audit (2026-11-15; was: RELEASES.slice(0, 4), without it): the invitation audit release is published later, at the top, directly below the Liquid Glass draft.
    // Re-pinned by docs/whats-new-api-key-audit (2026-11-15; was: RELEASES.slice(0, 5), without it): the API key audit release is published later, at the top, directly below the Liquid Glass draft.
    // Re-pinned by docs/whats-new-authenticator-set-up-first (2026-11-15; was: every pinned position one place higher): the authenticator set-up release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-delete-account-confirm (2026-11-16; was: every pinned position one place higher): the delete account release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-integrations-message-and-api-key-rows (2026-11-16; was: every pinned position one place higher): the Integrations and schedule event release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-emptied-fields-and-schedule-completion (2026-11-16; was: RELEASES.slice(0, 9)): the emptied fields and schedule completion release is published at the top, below the Liquid Glass draft, so the list takes one more.
    // Re-pinned by docs/releases-low-critical-pages (2026-11-18; was: RELEASES.slice(0, 10)): the Low + critical pages and list value release is published at the top, below the Liquid Glass draft, so the list takes one more.
    // Re-pinned by docs/whats-new-receiving-shown-to-managers (2026-11-19; was: RELEASES.slice(0, 11)): the receiving release is published at the top, below the Liquid Glass draft, so the list takes one more.
    // Re-pinned by docs/whats-new-small-fixes-1119 (2026-11-19; was: RELEASES.slice(0, 12)): the export, receipt and access release is published at the top, below the Liquid Glass draft, so the list takes one more.
    // Re-pinned by docs/whats-new-2026-11-19-errors (2026-11-19; was: RELEASES.slice(0, 13)): the count start access check release is published at the top, below the Liquid Glass draft, so the list takes one more.
    expect(RELEASES.slice(0, 14).map((r) => [r.id, r.status])).toEqual([
      ['liquid-glass-2026-11', 'draft'],
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
      [ID, 'published'],
      [SETTINGS_ID, 'published'],
      [MODULE_CHECK_ID, 'published'],
    ]);
    // Re-pinned by docs/whats-new-invitation-audit (2026-11-15; was: ID): the invitation audit release is published after it, at the top, the newest published release.
    // Re-pinned by docs/whats-new-api-key-audit (2026-11-15; was: INVITATION_AUDIT_ID): the API key audit release is published after it, at the top, the newest published release.
    // Re-pinned by docs/whats-new-authenticator-set-up-first (2026-11-15; was: API_KEY_AUDIT_ID): the authenticator set-up release is published after it, at the top, the newest published release.
    // Re-pinned by docs/whats-new-delete-account-confirm (2026-11-16; was: AUTH_SET_UP_ID): the delete account release is published after it, at the top, the newest published release.
    // Re-pinned by docs/whats-new-integrations-message-and-api-key-rows (2026-11-16; was: DELETE_CONFIRM_ID): the Integrations and schedule event release is published after it, at the top, the newest published release.
    // Re-pinned by docs/whats-new-emptied-fields-and-schedule-completion (2026-11-16; was: the Integrations and schedule event release): the emptied fields and schedule completion release is published after it, at the top, the newest published release.
    // Re-pinned by docs/releases-low-critical-pages (2026-11-18; was: EMPTIED_FIELDS_ID): the Low + critical pages and list value release is published after it, at the top, the newest published release.
    // Re-pinned by docs/whats-new-receiving-shown-to-managers (2026-11-19; was: the Low + critical pages and list value release): the receiving release is published after it, at the top, the newest published release.
    // Re-pinned by docs/whats-new-small-fixes-1119 (2026-11-19; was: the receiving release): the export, receipt and access release is published after it, at the top, the newest published release.
    // Re-pinned by docs/whats-new-2026-11-19-errors (2026-11-19; was: the export, receipt and access release): the count start access check release is published after it, at the top, the newest published release.
    expect(RELEASES.find((r) => r.status === 'published')?.id).toBe(COUNT_START_ACCESS_ID);
  });

  // Renamed by docs/whats-new-invitation-audit (2026-11-15; was: "is dated the whole minute after #564 went live, in the past, with the draft placeholder at the same minute and every release below it older"): the invitation audit release above is dated later, and the draft placeholder moved to its minute. Claim kept: the whole minute after #564 went live, in the past, every release below it older.
  it('is dated the whole minute after #564 went live, in the past, with the draft placeholder at or after it and every release below it older', () => {
    // #564 is live in production since 2026-11-15 04:44:13Z.
    expect(release().publishedAt).toBe('2026-11-15T04:45:00Z');
    const at = Date.parse(release().publishedAt);
    expect(at).toBeGreaterThan(Date.parse('2026-11-15T04:44:13Z'));
    expect(at).toBeLessThanOrEqual(Date.now());
    // Re-pinned by docs/whats-new-invitation-audit (2026-11-15; was: RELEASES[0]!.publishedAt toBe this minute): the draft placeholder moved to the minute of the invitation audit release, published later, directly above this one.
    expect(Date.parse(RELEASES[0]!.publishedAt)).toBeGreaterThanOrEqual(at);
    // Re-pinned by docs/whats-new-invitation-audit (2026-11-15; was: every pinned position one place higher): the invitation audit release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-api-key-audit (2026-11-15; was: every pinned position one place higher): the API key audit release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-authenticator-set-up-first (2026-11-15; was: every pinned position one place higher): the authenticator set-up release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-delete-account-confirm (2026-11-16; was: every pinned position one place higher): the delete account release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-integrations-message-and-api-key-rows (2026-11-16; was: every pinned position one place higher): the Integrations and schedule event release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-emptied-fields-and-schedule-completion (2026-11-16; was: every pinned position one place higher): the emptied fields and schedule completion release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/releases-low-critical-pages (2026-11-18; was: slice(8)): the Low + critical pages and list value release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-receiving-shown-to-managers (2026-11-19; was: RELEASES.slice(9)): the receiving release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-small-fixes-1119 (2026-11-19; was: RELEASES.slice(10)): the export, receipt and access release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-2026-11-19-errors (2026-11-19; was: RELEASES.slice(11)): the count start access check release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    for (const r of RELEASES.slice(12)) {
      expect(at, r.id).toBeGreaterThan(Date.parse(r.publishedAt));
    }
  });

  it('parses under the shared schema, in plain text, with its one entry', () => {
    expect(releaseSchema.safeParse(release()).success).toBe(true);
    for (const text of readerText(release())) expect(text).not.toMatch(/[<>]/);
    expect(release().entries.map((e) => [e.id, e.category, e.area])).toEqual([
      [ENTRY_ID, 'fixed', 'Settings'],
    ]);
    expect(
      RELEASES.filter((r) => r.entries.some((x) => x.id === ENTRY_ID)).map((r) => r.id),
    ).toEqual([ID]);
  });
});

describe('the navigation release: the words', () => {
  it('has a title and a summary that stand on their own', () => {
    expect(release().title).toBe('Navigation keeps your choices for modules that are off');
    expect(release().summary).toBe(
      'When you save Settings, Navigation, the hides, renames and places you set for the links of a module that is turned off are now kept, so they come back as you left them when you turn the module on again. Reset to default still clears everything. No app update is needed.',
    );
  });

  it('the entry', () => {
    const e = entry();
    expect(e.title).toBe('Navigation keeps your choices for modules that are off');
    expect(e.whatChanged).toBe(
      'When you press Save changes in Settings, Navigation, the hides, renames and places you set for the links of a module that is turned off are now kept. When you turn that module on again, its links come back hidden, renamed or in the place you left them.',
    );
    expect(e.whyItMatters).toBe(
      "Navigation lists only the links of modules that are on, and before, saving it while a module was off dropped the choices you had made for that module's links.",
    );
    expect(e.howItAffectsYou).toBe(
      'Saving with nothing changed keeps your menu as it is. Reset to default still clears every choice, including those for modules that are off.',
    );
    expect(e.whatToDo).toBe(
      "No action needed. If an earlier save lost a module's hides, renames or places, set them again in Settings, Navigation once the module is on.",
    );
    expect(e.link).toEqual({
      href: '/dashboard/settings/navigation',
      label: 'Open Navigation settings',
    });
  });

  it('keeps to what people see, in plain words', () => {
    const text = readerText(release()).join(' ');
    expect(text).not.toMatch(/\bbook(s|ed)?\b/i);
    expect(text).not.toMatch(/secur|vulnerab|exploit|leak|expos|attack|breach|unauthori/i);
    expect(text).not.toMatch(/[!\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  });
});

describe('the navigation release: who is told', () => {
  it('has no release audience; the entry names who can open the page and save it', () => {
    expect(release().audience).toBeUndefined();
    expect(entry().audience).toEqual({
      roles: ['owner', 'admin'],
      anyPermission: ['organization:update'],
    });
  });

  it('reaches owners and admins, and no other default role', () => {
    expect(seesIt(owner)).toBe(true);
    expect(seesIt(admin)).toBe(true);
    for (const v of [manager, staff, defaultViewer, member]) expect(seesIt(v), v.role).toBe(false);
  });

  it('leaves out a manager granted organization:update (the save is for owners and admins) and an admin without it (the page is closed)', () => {
    expect(seesIt(viewer('manager', [...ROLE_PERMISSIONS.manager, 'organization:update']))).toBe(
      false,
    );
    expect(
      seesIt(
        viewer(
          'admin',
          ROLE_PERMISSIONS.admin.filter((p) => p !== 'organization:update'),
        ),
      ),
    ).toBe(false);
  });

  // Renamed by docs/whats-new-invitation-audit (2026-11-15; was: "is the first notice for owners and admins, and the settings release is next; other roles are told the settings release first, as before"): the invitation audit release is published later and reaches owners, admins and managers, who read it first. Claim kept: the notice for owners and admins, the settings release next, and other roles told the settings release first.
  // Renamed by docs/whats-new-api-key-audit (2026-11-15; was: "is the notice for owners and admins once the invitation audit release is read, and the settings release is next; other roles are told the settings release first, as before"): the API key audit release is published later and reaches the same readers as the invitation audit release, who read both first. Claim kept: the notice for owners and admins, the settings release next, and other roles told the settings release first.
  // Renamed by docs/whats-new-authenticator-set-up-first (2026-11-15; was: "is the notice for owners and admins once the API key and invitation audit releases are read, and the settings release is next; other roles are told the settings release first, as before"): the authenticator set-up release is published later and reaches every member, who read it first. Claim kept: the notice for owners and admins, the settings release next, and other roles told the settings release first.
  // Renamed by docs/whats-new-delete-account-confirm (2026-11-16; was: "is the notice for owners and admins once the authenticator set-up, API key and invitation audit releases are read, and the settings release is next; other roles are told the settings release first, as before"): the delete account release is published later and reaches every member, who read it first. Claim kept: the notice for owners and admins, and the settings release next; other roles are told the settings release first.
  // Renamed by docs/whats-new-emptied-fields-and-schedule-completion (2026-11-16; was: "is the notice for owners and admins once the delete account, authenticator set-up, API key and invitation audit releases are read, and the settings release is next; other roles are told the settings release first, as before"): the emptied fields and schedule completion release is published later, at the top, and reaches owners, admins and managers by default, so it is read first. Claim kept: the notice for owners and admins once the newer releases are read, the settings release next, and the settings release first for other roles.
  it('is the notice for owners and admins once the emptied fields, delete account, authenticator set-up, API key and invitation audit releases are read, and the settings release is next; managers and staff are told the settings release once the emptied fields release is read, as before', () => {
    for (const v of [owner, admin]) {
      // Re-pinned by docs/whats-new-invitation-audit (2026-11-15; was: nothing read): the invitation audit release is published later, at the top, and reaches owners and admins, so each reads it first, and the notice this test checks is the one it checked before.
      expect(
        // Re-pinned by docs/whats-new-api-key-audit (2026-11-15; was: without it): the API key audit release is published later, at the top, and reaches the same readers as the invitation audit release, so it is read or seen with it, and the notice this test checks is the one it checked before.
        // Re-pinned by docs/whats-new-authenticator-set-up-first (2026-11-15; was: without it): the authenticator set-up release is published later, at the top, and reaches every member, so it is read or seen first, and the notice this test checks is the one it checked before.
        // Re-pinned by docs/whats-new-delete-account-confirm (2026-11-16; was: without it): the delete account release is published later, at the top, and reaches every member, so it is read or seen first, and the notice this test checks is the one it checked before.
        // Re-pinned by docs/whats-new-emptied-fields-and-schedule-completion (2026-11-16; was: without it): the emptied fields and schedule completion release is published later, at the top, and reaches owners, admins and managers by default (its location and category entries need no module), so it is read or seen first, and the notice this test checks is the one it checked before.
        // Re-pinned by docs/releases-low-critical-pages (2026-11-18; was: without it): the Low + critical pages and list value release is published later, at the top, and reaches whoever can read items (every role by default), so it is read or seen first, and the notice this test checks is the one it checked before.
        // Re-pinned by docs/whats-new-small-fixes-1119 (2026-11-19; was: without it): the export, receipt and access release is published later, at the top, and reaches every member (its access entry has no audience), so it is read or seen first, and the notice this test checks is the one it checked before.
        buildReleaseList(RELEASES, v, [exportReceiptAccessRead, lowCriticalRead, emptiedFieldsRead, deleteConfirmRead, authSetUpRead, apiKeyAuditRead, invitationAuditRead], null)
          .latestUnread?.id,
        v.role,
      ).toBe(ID);
      const read = {
        release_id: ID,
        revision: 1,
        dismissed_at: null,
        opened_at: '2026-11-15T05:00:00Z',
        read_at: '2026-11-15T05:00:00Z',
      };
      // Re-pinned by docs/whats-new-invitation-audit (2026-11-15; was: [read]): the invitation audit release is read too, as above.
      expect(
        // Re-pinned by docs/whats-new-api-key-audit (2026-11-15; was: without it): the API key audit release is published later, at the top, and reaches the same readers as the invitation audit release, so it is read or seen with it, and the notice this test checks is the one it checked before.
        // Re-pinned by docs/whats-new-authenticator-set-up-first (2026-11-15; was: without it): the authenticator set-up release is published later, at the top, and reaches every member, so it is read or seen first, and the notice this test checks is the one it checked before.
        // Re-pinned by docs/whats-new-delete-account-confirm (2026-11-16; was: without it): the delete account release is published later, at the top, and reaches every member, so it is read or seen first, and the notice this test checks is the one it checked before.
        buildReleaseList(
          RELEASES,
          v,
          // Re-pinned by docs/whats-new-emptied-fields-and-schedule-completion (2026-11-16; was: without it): the emptied fields and schedule completion release is published later, at the top, and reaches owners, admins and managers by default (its location and category entries need no module), so it is read or seen first, and the notice this test checks is the one it checked before.
          // Re-pinned by docs/releases-low-critical-pages (2026-11-18; was: without it): the Low + critical pages and list value release is published later, at the top, and reaches whoever can read items (every role by default), so it is read or seen first, and the notice this test checks is the one it checked before.
          // Re-pinned by docs/whats-new-small-fixes-1119 (2026-11-19; was: without it): the export, receipt and access release is published later, at the top, and reaches every member (its access entry has no audience), so it is read or seen first, and the notice this test checks is the one it checked before.
          [exportReceiptAccessRead, lowCriticalRead, emptiedFieldsRead, deleteConfirmRead, authSetUpRead, apiKeyAuditRead, invitationAuditRead, read],
          null,
        ).latestUnread?.id,
        v.role,
      ).toBe(SETTINGS_ID);
    }
    for (const v of [manager, staff]) {
      // Re-pinned by docs/whats-new-invitation-audit (2026-11-15; was: nothing read): the invitation audit release reaches managers, so they read it first; a read of it by staff, who it does not reach, changes nothing.
      expect(
        // Re-pinned by docs/whats-new-api-key-audit (2026-11-15; was: without it): the API key audit release is published later, at the top, and reaches the same readers as the invitation audit release, so it is read or seen with it, and the notice this test checks is the one it checked before.
        // Re-pinned by docs/whats-new-authenticator-set-up-first (2026-11-15; was: without it): the authenticator set-up release is published later, at the top, and reaches every member, so it is read or seen first, and the notice this test checks is the one it checked before.
        // Re-pinned by docs/whats-new-delete-account-confirm (2026-11-16; was: without it): the delete account release is published later, at the top, and reaches every member, so it is read or seen first, and the notice this test checks is the one it checked before.
        // Re-pinned by docs/whats-new-emptied-fields-and-schedule-completion (2026-11-16; was: without it): the emptied fields and schedule completion release is published later, at the top, and reaches owners, admins and managers by default (its location and category entries need no module), so it is read or seen first, and the notice this test checks is the one it checked before.
        // Re-pinned by docs/releases-low-critical-pages (2026-11-18; was: without it): the Low + critical pages and list value release is published later, at the top, and reaches whoever can read items (every role by default), so it is read or seen first, and the notice this test checks is the one it checked before.
        // Re-pinned by docs/whats-new-small-fixes-1119 (2026-11-19; was: without it): the export, receipt and access release is published later, at the top, and reaches every member (its access entry has no audience), so it is read or seen first, and the notice this test checks is the one it checked before.
        buildReleaseList(RELEASES, v, [exportReceiptAccessRead, lowCriticalRead, emptiedFieldsRead, deleteConfirmRead, authSetUpRead, apiKeyAuditRead, invitationAuditRead], null)
          .latestUnread?.id,
        v.role,
      ).toBe(SETTINGS_ID);
    }
    // An older phone build shows the newest one it has not seen: this title and summary, with
    // the link to the page.
    // Re-pinned by docs/whats-new-invitation-audit (2026-11-15; was: nothing seen): the invitation audit release is published later and reaches admins, so the phone has seen it first.
    // Re-pinned by docs/whats-new-api-key-audit (2026-11-15; was: without it): the API key audit release is published later, at the top, and reaches the same readers as the invitation audit release, so it is read or seen with it, and the notice this test checks is the one it checked before.
    expect(
      // Re-pinned by docs/whats-new-authenticator-set-up-first (2026-11-15; was: without it): the authenticator set-up release is published later, at the top, and reaches every member, so it is read or seen first, and the notice this test checks is the one it checked before.
      // Re-pinned by docs/whats-new-delete-account-confirm (2026-11-16; was: without it): the delete account release is published later, at the top, and reaches every member, so it is read or seen first, and the notice this test checks is the one it checked before.
      legacyAnnouncementsFor(RELEASES, admin, {
        // Re-pinned by docs/whats-new-emptied-fields-and-schedule-completion (2026-11-16; was: without it): the emptied fields and schedule completion release is published later, at the top, and reaches owners, admins and managers by default (its location and category entries need no module), so it is read or seen first, and the notice this test checks is the one it checked before.
        // Re-pinned by docs/releases-low-critical-pages (2026-11-18; was: without it): the Low + critical pages and list value release is published later, at the top, and reaches whoever can read items (every role by default), so it is read or seen first, and the notice this test checks is the one it checked before.
        // Re-pinned by docs/whats-new-2026-11-19-errors (2026-11-19; was: without it): the count start access check release is published later, at the top, and reaches a manager or above who can assign counts where Cycle Counts is on (an owner with every permission and module among them), so it is read, seen or listed with the newer releases, and every notice this test checks is the one it checked before. A read of a release by a reader it does not reach changes nothing.
        [COUNT_START_ACCESS_ID]: true,
        // Re-pinned by docs/whats-new-small-fixes-1119 (2026-11-19; was: without it): the export, receipt and access release is published later, at the top, and reaches every member (its access entry has no audience), so it is read or seen first, and the notice this test checks is the one it checked before.
        [EXPORT_RECEIPT_ACCESS_ID]: true,
        [LOW_CRITICAL_ID]: true,
        [EMPTIED_FIELDS_ID]: true,
        [DELETE_CONFIRM_ID]: true,
        [AUTH_SET_UP_ID]: true,
        [API_KEY_AUDIT_ID]: true,
        [INVITATION_AUDIT_ID]: true,
      })[0],
    ).toEqual({
      id: ID,
      date: '2026-11-15',
      title: release().title,
      body: release().summary,
      cta: { href: '/dashboard/settings/navigation', label: 'Open Navigation settings' },
    });
  });
});

describe('the navigation release: the code the words rest on', () => {
  it('Settings, Navigation opens with organization:update and lists the links of the modules that are on', () => {
    const page = source('app/(dashboard)/dashboard/settings/navigation/page.tsx');
    expect(page).toContain("if (!can(ctx, 'organization:update')) {");
    expect(page).toContain("resolveSurface('web_sidebar', { role: 'admin', enabledModules })");
  });

  it('the save is for owners and admins, and keeps the stored entries of links the editor did not list', () => {
    const action = source('server/actions/nav-settings.ts');
    expect(action).toContain("if (ctx.role !== 'owner' && ctx.role !== 'admin') {");
    expect(action).toContain('const merged = mergeNavOverrides(');
    const merge = source('lib/nav-overrides-merge.ts');
    expect(merge).toContain('export function mergeNavOverrides(');
    expect(merge).toContain('!decided.has(href)');
  });

  it('Save changes sends an empty setting when nothing is set, and Reset to default sends null', () => {
    const editor = source('components/settings/nav-customizer.tsx');
    expect(editor).toContain("{saving ? 'Saving…' : 'Save changes'}");
    expect(editor).toContain('Reset to default');
    expect(editor).toContain('const overrides = buildOverrides() ?? { v: 1 };');
    expect(editor).toContain('const res = await setNavOverridesAction(null);');
  });
});

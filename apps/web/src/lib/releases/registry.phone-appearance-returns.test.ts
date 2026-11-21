import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  MODULE_REGISTRY,
  PERMISSIONS,
  RETURN_REQUEST_COPY,
  RETURNS_COPY,
  defaultStyle,
  shownStyle,
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
 * Added by docs/whatsnew-phone-1112 (2026-11-12): the release for the phone
 * update of 2026-11-12 (runtime 1.4.0, Liquid Glass opt-in) and two web fixes
 * live the same day, published at the top, below the Liquid Glass draft and
 * above the returns request and names release:
 *
 *  - the phone's half of Send return request (#498): Email return request on
 *    the requester's own order and on the return screen, with Report a
 *    problem there; the returns release said the mobile app gets the button
 *    with its next update, and this release says it has;
 *  - Settings, Appearance in the mobile app (Design and Theme), Classic unless
 *    the person chooses Liquid Glass, saved to the account and shared with
 *    the website;
 *  - on the website, one draft per double click on Email return request
 *    (#502) and Liquid Glass toasts back in the bottom right corner (#504).
 *
 * Its own file, so the release tests other open branches edit stay as they
 * are. These tests pin the release's id, status, revision, date and order,
 * who each entry reaches, and the code its words rest on.
 */
const ID = 'phone-appearance-returns-2026-11';
const OWN_ORDER = 'app-return-request-own-order';
const RETURN_SCREEN = 'app-return-request-return-screen';
const APPEARANCE = 'app-appearance-design-theme';
const ONE_DRAFT = 'web-return-request-one-draft';
const TOASTS = 'web-glass-messages-bottom-right';
const RETURNS_REQUEST_ID = 'returns-request-email-names-2026-11';
// Added by docs/whats-new-2026-11-13 (2026-11-13): the Release count, AI Assistant and not found
// releases, published later, at the top, read or seen. Each reaches an owner with every permission
// and module or nobody here, so a test that expects an older notice reads or sees them first, and
// the notice it checks is the one it checked before.
const NEWER_IDS_1113 = [
  // Re-pinned by docs/whatsnew-emailed-links-1113 (2026-11-13; was: without it): the emailed links release is published later, at the top, and reaches every member (it has no audience), so it is read, seen or listed with the newer releases, and every notice this test checks is the one it checked before.
  // Re-pinned by docs/whatsnew-phone-code-and-access-check (2026-11-13; was: without them): the phone authenticator code and access check releases are published later, at the top; the authenticator code release reaches every member and the access check release reaches whoever can adjust stock, check out rentals or escalate exceptions, an owner with every permission and module included, so they are read, seen or listed with the newer releases, and every notice this test checks is the one it checked before.
  // Re-pinned by docs/whats-new-order-request-alerts (2026-11-14; was: without it): the order request alerts release is published later, at the top, and reaches owners, admins and managers where Orders is on and, where the AI module is on too, whoever can open Today's briefing, an owner with every permission and module included, so it is read, seen or listed with the newer releases, and every notice this test checks is the one it checked before.
  // Re-pinned by docs/whats-new-phone-screens-by-access (2026-11-14; was: without it): the phone screens by access release is published later, at the top, and reaches every member (two of its three entries have no audience), so it is read, seen or listed with the newer releases, and every notice this test checks is the one it checked before.
  // Re-pinned by docs/whats-new-count-read-rule (2026-11-15; was: without them): the count read rule and email change releases are published later, at the top; the email change release reaches every member and the count read rule release reaches whoever can open Cycle counts or assigns counts where Cycle counts is on, an owner with every permission and module included, so they are read, seen or listed with the newer releases, and every notice this test checks is the one it checked before.
  // Re-pinned by docs/whats-new-unreadable-access-and-settings (2026-11-15; was: without them): the settings and module check releases are published later, at the top; the module check release reaches every member and the settings release reaches whoever can open the settings pages and panels it names, an owner with every permission and module included, so they are read, seen or listed with the newer releases, and every notice this test checks is the one it checked before.
  // Re-pinned by docs/whats-new-navigation-keeps-choices (2026-11-15; was: without it): the navigation release is published later, at the top, and reaches owners and admins who can open Settings, Navigation, so it is read, seen or listed with the newer releases, and every notice this test checks is the one it checked before.
  // Re-pinned by docs/whats-new-invitation-audit (2026-11-15; was: without it): the invitation audit release is published later, at the top, and reaches whoever can view the audit log (owners, admins and managers by default), an owner with every permission and module included, so it is read, seen or listed with the newer releases, and every notice this test checks is the one it checked before.
  // Re-pinned by docs/whats-new-api-key-audit (2026-11-15; was: without it): the API key audit release is published later, at the top, and reaches whoever can view the audit log (owners, admins and managers by default), as the invitation audit release does, so it is read, seen or listed with the newer releases, and every notice this test checks is the one it checked before.
  // Re-pinned by docs/whats-new-authenticator-set-up-first (2026-11-15; was: without it): the authenticator set-up release is published later, at the top, and reaches every member (its entry has no audience), so it is read, seen or listed with the newer releases, and every notice this test checks is the one it checked before.
  // Re-pinned by docs/whats-new-delete-account-confirm (2026-11-16; was: without it): the delete account release is published later, at the top, and reaches every member (its entry has no audience), so it is read, seen or listed with the newer releases, and every notice this test checks is the one it checked before.
  // Re-pinned by docs/whats-new-integrations-message-and-api-key-rows (2026-11-16; was: without it): the Integrations and schedule event release is published later, at the top, and reaches whoever can manage integrations or schedule events with those modules on (owners and admins, and managers for its schedule entry, by default), an owner with every permission and module included, so it is read, seen or listed with the newer releases, and every notice this test checks is the one it checked before.
  // Re-pinned by docs/whats-new-emptied-fields-and-schedule-completion (2026-11-16; was: without it): the emptied fields and schedule completion release is published later, at the top, and reaches whoever can manage the schedule or suppliers where those modules are on and whoever can manage the organization, locations or categories (owners and admins, and managers for all but its charter and warehouse entry, by default), an owner with every permission and module included, so it is read, seen or listed with the newer releases, and every notice this test checks is the one it checked before.
  // Re-pinned by docs/releases-low-critical-pages (2026-11-18; was: without it): the Low + critical pages and list value release is published later, at the top, and reaches whoever can read items (every role by default; not a member with no permission), an owner with every permission included, so it is read, seen or listed with the newer releases, and every notice this test checks is the one it checked before.
  // Re-pinned by docs/whats-new-small-fixes-1119 (2026-11-19; was: without it): the export, receipt and access release is published later, at the top, and reaches every member (its access entry has no audience), an owner with every permission and module among them, so it is read, seen or listed with the newer releases, and every notice this test checks is the one it checked before.
  // Re-pinned by docs/whats-new-2026-11-21-phone (2026-11-21; was: without it): the phone authenticator set-up release is published later, at the top, and reaches every member (three of its five entries have no audience), an owner with every permission and module included, so it is read, seen or listed with the newer releases, and every notice this test checks is the one it checked before.
  // Re-pinned by docs/whats-new-blocked-activity (2026-11-21; was: without it): the Blocked activity release is published later, at the top, and reaches owners and Super Admins (their roles are its audience), so it is read, seen or listed with the newer releases for them, and every notice this test checks is the one it checked before. A read of a release by a reader it does not reach changes nothing.
  'blocked-activity-2026-11',
  'phone-authenticator-set-up-2026-11',
  // Re-pinned by docs/whats-new-2026-11-19-errors (2026-11-19; was: without it): the count start access check release is published later, at the top, and reaches a manager or above who can assign counts where Cycle Counts is on (an owner with every permission and module among them), so it is read, seen or listed with the newer releases, and every notice this test checks is the one it checked before. A read of a release by a reader it does not reach changes nothing.
  'count-start-access-check-2026-11',
  'export-receipt-access-fixes-2026-11',
  // Re-pinned by docs/whats-new-receiving-shown-to-managers (2026-11-19; was: without it): the receiving release is published later, at the top, and reaches whoever can open a purchase order where Receiving is on (owners, admins, managers, staff and viewers by default), an owner with every permission and module among them, so it is read, seen or listed with the newer releases, and every notice this test checks is the one it checked before.
  'receiving-shown-to-managers-2026-11',
  'low-critical-pages-and-list-value-2026-11',
  'emptied-fields-and-schedule-completion-2026-11',
  'connection-and-schedule-messages-2026-11',
  'delete-account-confirm-2026-11',
  'authenticator-set-up-first-2026-11',
  'api-key-audit-2026-11',
  'invitation-audit-2026-11',
  'navigation-keeps-choices-2026-11',
  'settings-not-loaded-2026-11',
  'module-check-try-again-2026-11',
  'count-read-rule-2026-11',
  'email-change-expired-2026-11',
  'phone-screens-by-access-2026-11',
  'order-request-alerts-follow-approve-2026-11',
  'phone-authenticator-code-2026-11',
  'phone-access-check-retry-2026-11',
  'emailed-links-name-their-account-2026-11',
  'cycle-count-already-released-2026-11',
  'ai-assistant-plain-words-2026-11',
  'changes-that-did-not-happen-2026-11',
];
const NEWER_READS = NEWER_IDS_1113.map((id) => ({
  release_id: id,
  // Re-pinned by docs/whats-new-integrations-message-and-api-key-rows (2026-11-16; was: revision 1): the API key audit release is re-announced as revision 2, so a read of it is recorded at revision 2.
  // Re-pinned by bundles/hand-out-follows-the-manager-rule (2026-11-16; was: id === 'api-key-audit-2026-11' ? 2 : 1): the emptied fields and schedule completion release is re-announced as revision 2, so a read of it is recorded at revision 2.
  revision:
    id === 'api-key-audit-2026-11' || id === 'emptied-fields-and-schedule-completion-2026-11'
      ? 2
      : 1,
  dismissed_at: null,
  opened_at: '2026-11-13T08:18:00Z',
  read_at: '2026-11-13T08:18:00Z',
}));
const NEWER_SEEN: Record<string, boolean> = Object.fromEntries(
  NEWER_IDS_1113.map((id) => [id, true]),
);
const release = () => RELEASES.find((r) => r.id === ID)!;
const entry = (id: string) => release().entries.find((e) => e.id === id)!;

const everyone: ReleaseViewer = {
  role: 'owner',
  permissions: [...PERMISSIONS],
  enabledModules: Object.keys(MODULE_REGISTRY) as ModuleId[],
};
/** A member who holds no permission and no module. */
const member: ReleaseViewer = { role: 'viewer', permissions: [], enabledModules: [] };
/** Staff who place orders, where Returns is on. */
const requester: ReleaseViewer = {
  role: 'staff',
  permissions: ['orders:request'],
  enabledModules: ['orders', 'returns'],
};
/** Staff who place orders, where Returns is off. */
const requesterReturnsOff: ReleaseViewer = {
  role: 'staff',
  permissions: ['orders:request'],
  enabledModules: ['orders'],
};
/** Someone who reads returns and places no orders, where Returns is on. */
const returnsReader: ReleaseViewer = {
  role: 'staff',
  permissions: ['returns:read'],
  enabledModules: ['returns'],
};
/** Someone who reads returns, where Returns is off. */
const returnsReaderModuleOff: ReleaseViewer = {
  role: 'staff',
  permissions: ['returns:read', 'returns:manage'],
  enabledModules: ['orders'],
};

/** A source file under apps/web/src, as written. */
const source = (rel: string) => readFileSync(resolve(__dirname, '../..', rel), 'utf8');
/** A file under apps/mobile, as written. */
const mobile = (rel: string) => readFileSync(resolve(__dirname, '../../../../mobile', rel), 'utf8');

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

const UPDATE_WORDS =
  'To load the latest update, tap Restart now when the app says Update ready, or close the app completely and open it again.';

describe('the phone appearance and returns release: order, status and date', () => {
  it('is published once, as revision 1, directly below the Liquid Glass draft at the top, above the returns request and names release, and no draft but the Liquid Glass release is left', () => {
    expect(RELEASES.filter((r) => r.id === ID)).toHaveLength(1);
    expect(release().status).toBe('published');
    expect(release().revision).toBe(1);
    expect(release().withdrawnNote).toBeUndefined();
    expect(RELEASES[0]?.id).toBe('liquid-glass-2026-11');
    // Re-pinned by docs/whats-new-2026-11-13 (2026-11-13; was: every pinned position three places higher): the Release count, AI Assistant and not found releases are published at the top, below the Liquid Glass draft, so every position below it moves down by three.
    // Re-pinned by docs/whatsnew-emailed-links-1113 (2026-11-13; was: every pinned position one place higher): the emailed links release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whatsnew-phone-code-and-access-check (2026-11-13; was: every pinned position two places higher): the phone authenticator code and access check releases are published at the top, below the Liquid Glass draft, so every position below them moves down by two.
    // Re-pinned by docs/whats-new-order-request-alerts (2026-11-14; was: every pinned position one place higher): the order request alerts release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-phone-screens-by-access (2026-11-14; was: every pinned position one place higher): the phone screens by access release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-count-read-rule (2026-11-15; was: every pinned position two places higher): the count read rule and email change releases are published at the top, below the Liquid Glass draft, so every position below them moves down by two.
    // Re-pinned by docs/whats-new-unreadable-access-and-settings (2026-11-15; was: every pinned position two places higher): the settings and module check releases are published at the top, below the Liquid Glass draft, so every position below them moves down by two.
    // Re-pinned by docs/whats-new-navigation-keeps-choices (2026-11-15; was: every pinned position one place higher): the navigation release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-invitation-audit (2026-11-15; was: every pinned position one place higher): the invitation audit release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-api-key-audit (2026-11-15; was: every pinned position one place higher): the API key audit release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-authenticator-set-up-first (2026-11-15; was: every pinned position one place higher): the authenticator set-up release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-delete-account-confirm (2026-11-16; was: every pinned position one place higher): the delete account release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-integrations-message-and-api-key-rows (2026-11-16; was: every pinned position one place higher): the Integrations and schedule event release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-emptied-fields-and-schedule-completion (2026-11-16; was: every pinned position one place higher): the emptied fields and schedule completion release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/releases-low-critical-pages (2026-11-18; was: every pinned position one place higher): the Low + critical pages and list value release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-receiving-shown-to-managers (2026-11-19; was: RELEASES[21]): the receiving release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-small-fixes-1119 (2026-11-19; was: RELEASES[22]): the export, receipt and access release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-2026-11-19-errors (2026-11-19; was: RELEASES[23]): the count start access check release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-2026-11-21-phone (2026-11-21; was: RELEASES[24]): the phone authenticator set-up release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-blocked-activity (2026-11-21; was: RELEASES[25]): the Blocked activity release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    expect(RELEASES[26]?.id).toBe(ID);
    // Re-pinned by docs/whats-new-invitation-audit (2026-11-15; was: every pinned position one place higher): the invitation audit release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-api-key-audit (2026-11-15; was: every pinned position one place higher): the API key audit release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-authenticator-set-up-first (2026-11-15; was: every pinned position one place higher): the authenticator set-up release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-delete-account-confirm (2026-11-16; was: every pinned position one place higher): the delete account release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-integrations-message-and-api-key-rows (2026-11-16; was: every pinned position one place higher): the Integrations and schedule event release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-emptied-fields-and-schedule-completion (2026-11-16; was: every pinned position one place higher): the emptied fields and schedule completion release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/releases-low-critical-pages (2026-11-18; was: every pinned position one place higher): the Low + critical pages and list value release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-receiving-shown-to-managers (2026-11-19; was: RELEASES[22]): the receiving release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-small-fixes-1119 (2026-11-19; was: RELEASES[23]): the export, receipt and access release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-2026-11-19-errors (2026-11-19; was: RELEASES[24]): the count start access check release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-2026-11-21-phone (2026-11-21; was: RELEASES[25]): the phone authenticator set-up release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-blocked-activity (2026-11-21; was: RELEASES[26]): the Blocked activity release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    expect(RELEASES[27]?.id).toBe(RETURNS_REQUEST_ID);
    // Re-pinned by docs/whats-new-2026-11-13 (2026-11-13; was: this release, the newest published): the Release count, AI Assistant and not found releases are published later, directly above it.
    // Re-pinned by docs/whatsnew-emailed-links-1113 (2026-11-13; was: RELEASES.slice(1, 4), without it): the emailed links release is published later, directly above the Release count release.
    // Re-pinned by docs/whatsnew-phone-code-and-access-check (2026-11-13; was: RELEASES.slice(1, 5), without them): the phone authenticator code and access check releases are published later, directly above the emailed links release.
    // Re-pinned by docs/whats-new-order-request-alerts (2026-11-14; was: RELEASES.slice(1, 7), without it): the order request alerts release is published later, directly above the phone authenticator code release.
    // Re-pinned by docs/whats-new-phone-screens-by-access (2026-11-14; was: RELEASES.slice(1, 8), without it): the phone screens by access release is published later, directly above the order request alerts release.
    // Re-pinned by docs/whats-new-count-read-rule (2026-11-15; was: RELEASES.slice(1, 9), without them): the count read rule and email change releases are published later, directly above the phone screens by access release.
    // Re-pinned by docs/whats-new-unreadable-access-and-settings (2026-11-15; was: RELEASES.slice(1, 11), without them): the settings and module check releases are published later, directly above the count read rule release.
    // Re-pinned by docs/whats-new-navigation-keeps-choices (2026-11-15; was: RELEASES.slice(1, 13), without it): the navigation release is published later, at the top, directly below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-invitation-audit (2026-11-15; was: RELEASES.slice(1, 14), without it): the invitation audit release is published later, at the top, directly below the Liquid Glass draft.
    // Re-pinned by docs/whats-new-api-key-audit (2026-11-15; was: RELEASES.slice(1, 15), without it): the API key audit release is published later, at the top, directly below the Liquid Glass draft.
    // Re-pinned by docs/whats-new-authenticator-set-up-first (2026-11-15; was: every pinned position one place higher): the authenticator set-up release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-delete-account-confirm (2026-11-16; was: RELEASES.slice(1, 17), without it): the delete account release is published later, at the top, directly below the Liquid Glass draft.
    // Re-pinned by docs/whats-new-integrations-message-and-api-key-rows (2026-11-16; was: RELEASES.slice(1, 18), without it): the Integrations and schedule event release is published later, at the top, directly below the Liquid Glass draft.
    // Re-pinned by docs/whats-new-emptied-fields-and-schedule-completion (2026-11-16; was: RELEASES.slice(1, 19), without it): the emptied fields and schedule completion release is published later, at the top, directly below the Liquid Glass draft, so the list takes one more.
    // Re-pinned by docs/releases-low-critical-pages (2026-11-18; was: RELEASES.slice(1, 20)): the Low + critical pages and list value release is published at the top, below the Liquid Glass draft, so the list takes one more.
    // Re-pinned by docs/whats-new-receiving-shown-to-managers (2026-11-19; was: RELEASES.slice(1, 21), without it): the receiving release is published later, at the top, directly below the Liquid Glass draft.
    // Re-pinned by docs/whats-new-small-fixes-1119 (2026-11-19; was: RELEASES.slice(1, 22), without it): the export, receipt and access release is published later, at the top, directly below the Liquid Glass draft.
    // Re-pinned by docs/whats-new-2026-11-19-errors (2026-11-19; was: RELEASES.slice(1, 23), without it): the count start access check release is published later, at the top, directly below the Liquid Glass draft, so the list starts with it and takes one more.
    // Re-pinned by docs/whats-new-2026-11-21-phone (2026-11-21; was: RELEASES.slice(1, 24)): the phone authenticator set-up release is published at the top, below the Liquid Glass draft, so the list takes one more.
    // Re-pinned by docs/whats-new-blocked-activity (2026-11-21; was: .slice(1, 25)): the Blocked activity release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    expect(RELEASES.slice(1, 26).map((r) => [r.id, r.status])).toEqual([
      // Re-pinned by docs/whats-new-2026-11-21-phone (2026-11-21; was: without it): the phone authenticator set-up release is published later, at the top, directly below the Liquid Glass draft.
      // Re-pinned by docs/whats-new-blocked-activity (2026-11-21; was: without it): the Blocked activity release is published later, at the top, directly below the Liquid Glass draft.
      ['blocked-activity-2026-11', 'published'],
      ['phone-authenticator-set-up-2026-11', 'published'],
      // Re-pinned by docs/whats-new-2026-11-19-errors (2026-11-19; was: without it): the count start access check release is published later, at the top, directly below the Liquid Glass draft.
      ['count-start-access-check-2026-11', 'published'],
      // Re-pinned by docs/whats-new-api-key-audit (2026-11-15; was: without it): the API key audit release is published later, at the top, directly below the Liquid Glass draft.
      // Re-pinned by docs/whats-new-authenticator-set-up-first (2026-11-15; was: without it): the authenticator set-up release is published later, at the top, directly below the Liquid Glass draft.
      // Re-pinned by docs/whats-new-delete-account-confirm (2026-11-16; was: without it): the delete account release is published later, at the top, directly below the Liquid Glass draft.
      // Re-pinned by docs/whats-new-integrations-message-and-api-key-rows (2026-11-16; was: without it): the Integrations and schedule event release is published later, at the top, directly below the Liquid Glass draft.
      // Re-pinned by docs/whats-new-emptied-fields-and-schedule-completion (2026-11-16; was: without it): the emptied fields and schedule completion release is published later, at the top, directly below the Liquid Glass draft.
      // Re-pinned by docs/releases-low-critical-pages (2026-11-18; was: without it): the Low + critical pages and list value release is published later, at the top, directly below the Liquid Glass draft.
      // Re-pinned by docs/whats-new-small-fixes-1119 (2026-11-19; was: without it): the export, receipt and access release is published later, at the top, directly below the Liquid Glass draft.
      ['export-receipt-access-fixes-2026-11', 'published'],
      // Re-pinned by docs/whats-new-receiving-shown-to-managers (2026-11-19; was: without it): the receiving release is published later, at the top, directly below the Liquid Glass draft.
      ['receiving-shown-to-managers-2026-11', 'published'],
      ['low-critical-pages-and-list-value-2026-11', 'published'],
      ['emptied-fields-and-schedule-completion-2026-11', 'published'],
      ['connection-and-schedule-messages-2026-11', 'published'],
      ['delete-account-confirm-2026-11', 'published'],
      ['authenticator-set-up-first-2026-11', 'published'],
      ['api-key-audit-2026-11', 'published'],
      // Re-pinned by docs/whats-new-invitation-audit (2026-11-15; was: without it): the invitation audit release is published later, at the top, directly below the Liquid Glass draft.
      ['invitation-audit-2026-11', 'published'],
      // Re-pinned by docs/whats-new-unreadable-access-and-settings (2026-11-15; was: without them): the settings and module check releases are published later, at the top, directly below the Liquid Glass draft.
      // Re-pinned by docs/whats-new-navigation-keeps-choices (2026-11-15; was: without it): the navigation release is published later, at the top, directly below the Liquid Glass draft.
      ['navigation-keeps-choices-2026-11', 'published'],
      ['settings-not-loaded-2026-11', 'published'],
      ['module-check-try-again-2026-11', 'published'],
      ['count-read-rule-2026-11', 'published'],
      ['email-change-expired-2026-11', 'published'],
      ['phone-screens-by-access-2026-11', 'published'],
      ['order-request-alerts-follow-approve-2026-11', 'published'],
      ['phone-authenticator-code-2026-11', 'published'],
      ['phone-access-check-retry-2026-11', 'published'],
      ['emailed-links-name-their-account-2026-11', 'published'],
      ['cycle-count-already-released-2026-11', 'published'],
      ['ai-assistant-plain-words-2026-11', 'published'],
      ['changes-that-did-not-happen-2026-11', 'published'],
    ]);
    expect(RELEASES.find((r) => r.status === 'published')?.id).toBe(
      // Re-pinned by docs/whatsnew-emailed-links-1113 (2026-11-13; was: the Release count release): the emailed links release is published after it, at the top, the newest published release.
      // Re-pinned by docs/whatsnew-phone-code-and-access-check (2026-11-13; was: the emailed links release): the phone authenticator code release is published after it, at the top, the newest published release.
      // Re-pinned by docs/whats-new-order-request-alerts (2026-11-14; was: the phone authenticator code release): the order request alerts release is published after it, at the top, the newest published release.
      // Re-pinned by docs/whats-new-phone-screens-by-access (2026-11-14; was: the order request alerts release): the phone screens by access release is published after it, at the top, the newest published release.
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
      // Re-pinned by docs/whats-new-2026-11-21-phone (2026-11-21; was: 'count-start-access-check-2026-11'): the phone authenticator set-up release is published after it, at the top, the newest published release.
      // Re-pinned by docs/whats-new-blocked-activity (2026-11-21; was: 'phone-authenticator-set-up-2026-11'): the Blocked activity release is published after it, at the top, the newest published release.
      'blocked-activity-2026-11',
    );
    expect(RELEASES.filter((r) => r.status === 'draft').map((r) => r.id)).toEqual([
      'liquid-glass-2026-11',
    ]);
    // Permanent, unused anywhere else, and ends in the month it went out.
    expect(ID).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*-2026-11$/);
    for (const e of [OWN_ORDER, RETURN_SCREEN, APPEARANCE, ONE_DRAFT, TOASTS]) {
      expect(
        RELEASES.flatMap((r) => r.entries).filter((x) => x.id === e),
        e,
      ).toHaveLength(1);
      expect(
        RELEASES.some((r) => r.id === e),
        e,
      ).toBe(false);
    }
  });

  it('leaves the returns request and names release as it was announced: revision 1, its words unchanged', () => {
    const returns = RELEASES.find((r) => r.id === RETURNS_REQUEST_ID)!;
    expect(returns.revision).toBe(1);
    expect(returns.summary).toContain('The mobile app gets the button with its next update.');
  });

  it('is dated in the past on a whole minute, at or after the web fixes went live and the phone update was published, and after every release below it', () => {
    const at = Date.parse(release().publishedAt);
    expect(release().publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/);
    expect(at).toBeLessThanOrEqual(Date.now());
    // #502 and #504 went live at 19:18Z; the phone update was published about 19:22Z.
    expect(at).toBeGreaterThanOrEqual(Date.parse('2026-11-12T19:18:00Z'));
    expect(at).toBeGreaterThanOrEqual(Date.parse('2026-11-12T19:22:00Z'));
    // Re-pinned by docs/whats-new-2026-11-13 (2026-11-13; was: every pinned position three places higher): the Release count, AI Assistant and not found releases are published at the top, below the Liquid Glass draft, so every position below it moves down by three.
    // Re-pinned by docs/whatsnew-emailed-links-1113 (2026-11-13; was: every pinned position one place higher): the emailed links release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whatsnew-phone-code-and-access-check (2026-11-13; was: every pinned position two places higher): the phone authenticator code and access check releases are published at the top, below the Liquid Glass draft, so every position below them moves down by two.
    // Re-pinned by docs/whats-new-order-request-alerts (2026-11-14; was: every pinned position one place higher): the order request alerts release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-phone-screens-by-access (2026-11-14; was: every pinned position one place higher): the phone screens by access release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-count-read-rule (2026-11-15; was: every pinned position two places higher): the count read rule and email change releases are published at the top, below the Liquid Glass draft, so every position below them moves down by two.
    // Re-pinned by docs/whats-new-unreadable-access-and-settings (2026-11-15; was: every pinned position two places higher): the settings and module check releases are published at the top, below the Liquid Glass draft, so every position below them moves down by two.
    // Re-pinned by docs/whats-new-navigation-keeps-choices (2026-11-15; was: every pinned position one place higher): the navigation release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-invitation-audit (2026-11-15; was: every pinned position one place higher): the invitation audit release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-api-key-audit (2026-11-15; was: every pinned position one place higher): the API key audit release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-authenticator-set-up-first (2026-11-15; was: every pinned position one place higher): the authenticator set-up release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-delete-account-confirm (2026-11-16; was: every pinned position one place higher): the delete account release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-integrations-message-and-api-key-rows (2026-11-16; was: every pinned position one place higher): the Integrations and schedule event release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-emptied-fields-and-schedule-completion (2026-11-16; was: every pinned position one place higher): the emptied fields and schedule completion release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/releases-low-critical-pages (2026-11-18; was: slice(21)): the Low + critical pages and list value release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-receiving-shown-to-managers (2026-11-19; was: RELEASES.slice(22)): the receiving release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-small-fixes-1119 (2026-11-19; was: RELEASES.slice(23)): the export, receipt and access release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-2026-11-19-errors (2026-11-19; was: RELEASES.slice(24)): the count start access check release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-2026-11-21-phone (2026-11-21; was: RELEASES.slice(25)): the phone authenticator set-up release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-blocked-activity (2026-11-21; was: RELEASES.slice(26)): the Blocked activity release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    for (const r of RELEASES.slice(27)) {
      expect(at, r.id).toBeGreaterThan(Date.parse(r.publishedAt));
    }
  });

  it('keeps the Liquid Glass draft above it no older than it, so dates never increase going down', () => {
    expect(Date.parse(RELEASES[0]!.publishedAt)).toBeGreaterThanOrEqual(
      Date.parse(release().publishedAt),
    );
  });

  it('is in the fingerprint, so publishing it changes what clients observe', () => {
    expect(registryFingerprint(RELEASES)).toContain(`${ID}@1:published`);
  });

  it('marks the two Liquid Glass draft entries it partly announces for rewording at G5', () => {
    const text = readFileSync(resolve(__dirname, 'registry.ts'), 'utf8');
    const draft = text.slice(0, text.indexOf(`id: '${ID}'`));
    for (const id of ['liquid-glass-mobile-app', 'mobile-appearance-settings']) {
      const before = draft.slice(0, draft.indexOf(`id: '${id}'`));
      const comment = before.slice(before.lastIndexOf('RECHECK'));
      expect(comment, id).toContain(`partly announced in '${ID}' on 2026-11-12`);
    }
  });
});

describe('the phone appearance and returns release: what it says', () => {
  it('has five entries that answer the four questions, the one link the returns pages open for, and no draft words', () => {
    expect(release().entries.map((e) => e.id)).toEqual([
      OWN_ORDER,
      RETURN_SCREEN,
      APPEARANCE,
      ONE_DRAFT,
      TOASTS,
    ]);
    expect(release().audience).toBeUndefined();
    expect([entry(OWN_ORDER).category, entry(OWN_ORDER).area]).toEqual(['new', 'Mobile app']);
    expect([entry(RETURN_SCREEN).category, entry(RETURN_SCREEN).area]).toEqual([
      'new',
      'Mobile app',
    ]);
    expect([entry(APPEARANCE).category, entry(APPEARANCE).area]).toEqual(['new', 'Mobile app']);
    expect([entry(ONE_DRAFT).category, entry(ONE_DRAFT).area]).toEqual(['fixed', 'Returns']);
    expect([entry(TOASTS).category, entry(TOASTS).area]).toEqual(['fixed', 'Web app']);
    expect(entry(RETURN_SCREEN).link).toEqual({
      href: '/dashboard/returns',
      label: 'Open Returns',
    });
    for (const id of [OWN_ORDER, APPEARANCE, ONE_DRAFT, TOASTS]) {
      expect(entry(id).link, id).toBeUndefined();
    }
    for (const e of release().entries) {
      for (const answer of [e.whatChanged, e.whyItMatters, e.howItAffectsYou]) {
        expect(answer.length, e.id).toBeGreaterThan(0);
      }
    }
    const text = readerText(release()).join(' ');
    expect(text).not.toMatch(/\bbook(ed)?\b/i);
    expect(text).not.toMatch(/!|%|guarantee|verified|instantly|faster|seamless|one click/i);
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(text).not.toMatch(/react|aria-|#\d+|\bbug\b|F14|toast|sonner|opt-in|rollout/i);
    // Never a claim StockPilot cannot observe: it opens a draft, the person sends it.
    expect(text).not.toMatch(
      /email sent|was sent|we sent|is sent to|notif(y|ied)|ticket (is )?created/i,
    );
    expect(text).not.toMatch(/\bnever\b|\balways\b/i);
    // Not shown under opt-in, so not told: the one-time card on Home.
    expect(text).not.toMatch(/Keep Liquid Glass|Use classic design|one-time card/i);
    // The footnote names Reduce Motion, but no glass code reads it.
    expect(text).not.toMatch(/Reduce Motion/);
  });

  it('starts the summary, all an old phone build shows, with the mobile app, and says how to get the update', () => {
    expect(release().summary).toMatch(/^In the mobile app, after the latest update, /);
    expect(release().summary).toContain(
      'It opens a prefilled email in Outlook or your email app; StockPilot does not send it, you press Send yourself.',
    );
    expect(release().summary).toMatch(
      /Tap Restart now when the app says Update ready, or close the app completely and open it again\.$/,
    );
    for (const id of [OWN_ORDER, RETURN_SCREEN]) {
      expect(entry(id).whatToDo, id).toBe(UPDATE_WORDS);
    }
    expect(entry(APPEARANCE).whatToDo.startsWith(UPDATE_WORDS)).toBe(true);
    for (const id of [ONE_DRAFT, TOASTS]) {
      expect(entry(id).whatToDo, id).toBe('No action needed.');
    }
  });

  it('says nothing is sent for the reader: the email opens in their own email app and they press Send', () => {
    expect(entry(OWN_ORDER).howItAffectsYou).toMatch(
      /^Nothing is sent for you: the email opens in Outlook or your email app, you check it and press Send yourself, and StockPilot does not create a ticket\./,
    );
    expect(entry(RETURN_SCREEN).howItAffectsYou).toMatch(
      /^Nothing is sent for you: the email opens in Outlook or your email app, and you press Send yourself\./,
    );
  });

  it('says plainly that a choice made on the website follows the account to the phone, and from when', () => {
    expect(entry(APPEARANCE).whatChanged).toContain(
      'The app stays in Classic unless you choose Liquid Glass, as on the website.',
    );
    expect(entry(APPEARANCE).howItAffectsYou).toContain(
      'If you chose Liquid Glass, Light or Dark on the website since 11 November, the app now uses that choice too',
    );
  });
});

describe('the phone appearance and returns release: who is told', () => {
  it('tells each reader only the entries they can use', () => {
    expect(entry(OWN_ORDER).audience).toEqual({
      anyPermission: ['orders:request'],
      modules: ['returns'],
    });
    expect(entry(RETURN_SCREEN).audience).toEqual({
      anyPermission: ['returns:read', 'returns:manage'],
      modules: ['returns'],
    });
    expect(entry(ONE_DRAFT).audience).toEqual({
      anyPermission: ['orders:request', 'returns:read', 'returns:manage'],
      modules: ['returns'],
    });
    // A personal setting every member has, and a look any member may choose.
    expect(entry(APPEARANCE).audience).toBeUndefined();
    expect(entry(TOASTS).audience).toBeUndefined();
    expect(told(everyone)).toEqual([OWN_ORDER, RETURN_SCREEN, APPEARANCE, ONE_DRAFT, TOASTS]);
    expect(told(requester)).toEqual([OWN_ORDER, APPEARANCE, ONE_DRAFT, TOASTS]);
    expect(told(returnsReader)).toEqual([RETURN_SCREEN, APPEARANCE, ONE_DRAFT, TOASTS]);
    for (const v of [member, requesterReturnsOff, returnsReaderModuleOff]) {
      expect(told(v), v.role).toEqual([APPEARANCE, TOASTS]);
    }
  });

  it('is the first notice for every member, and an old phone build lists it first with its title and summary', () => {
    // Re-pinned by docs/whats-new-2026-11-13 (2026-11-13; was: without them): the Release count, AI Assistant and not found releases are published later, at the top; an owner with every permission and module reads or sees them first (NEWER_READS, NEWER_SEEN), and every notice this test checks is the one it checked before.
    for (const v of [everyone, member, requester, returnsReader, requesterReturnsOff]) {
      expect(buildReleaseList(RELEASES, v, NEWER_READS, null).latestUnread?.id, v.role).toBe(ID);
    }
    // The first link the reader is told about, if any.
    for (const v of [everyone, returnsReader]) {
      expect(legacyAnnouncementsFor(RELEASES, v, NEWER_SEEN)[0], v.role).toEqual({
        id: ID,
        date: '2026-11-12',
        title: release().title,
        body: release().summary,
        cta: { href: '/dashboard/returns', label: 'Open Returns' },
      });
    }
    for (const v of [member, requester]) {
      expect(legacyAnnouncementsFor(RELEASES, v, NEWER_SEEN)[0], v.role).toEqual({
        id: ID,
        date: '2026-11-12',
        title: release().title,
        body: release().summary,
      });
    }
  });
});

describe('the phone appearance and returns release: the code its words rest on', () => {
  it('names the phone button and section as the screens show them, from the same words as the website', () => {
    expect(RETURN_REQUEST_COPY.primary).toBe('Email return request');
    expect(RETURN_REQUEST_COPY.title).toBe('Send return request');
    expect(RETURN_REQUEST_COPY.copy).toBe('Copy details');
    expect(RETURNS_COPY.requesterYourRequests).toBe('Your requests on this order');
    expect(RETURN_REQUEST_COPY.honesty).toContain(
      'StockPilot does not send it and does not create a ticket.',
    );
    const section = mobile('src/components/return-request-section.tsx');
    expect(section).toContain('{RETURN_REQUEST_COPY.primary}');
    expect(section).toContain('{RETURN_REQUEST_COPY.honesty}');
    expect(section).toContain('{RETURN_REQUEST_COPY.copy}');
    expect(section).toContain('value={prepared.clipboardText}');
  });

  it('puts the section under the requester’s own open requests, and on the return screen with Report a problem', () => {
    const order = mobile('app/order/[id].tsx');
    expect(order).toContain('<Eyebrow>{RETURNS_COPY.requesterYourRequests}</Eyebrow>');
    expect(order).toContain(
      'const content = returnRequestContentForTracking(t, returnRequestEmail);',
    );
    expect(order).toContain('viewerCanManageReturns: canManageReturns,');
    const workbench = mobile('src/components/return-workbench-view.tsx');
    expect(workbench).toContain('{requestContent && requestEmail.recipients ? (');
    expect(workbench).toContain(
      "enabledModules.has('maintenance_requests') && showWriteCta(permissions, 'maintenance_requests:submit');",
    );
    expect(workbench).toContain('{RETURN_PROBLEM_LABEL}');
    const actions = mobile('src/lib/return-request-actions.ts');
    expect(actions).toContain("export const RETURN_PROBLEM_LABEL = 'Report a problem';");
    expect(actions).toContain('subject: `Return ${ret.returnNumber}: `');
    expect(actions).toContain(
      'if (!canSendReturnRequest(workbench.return.status, workbench.return.returnNumber)) return null;',
    );
    expect(mobile('app/(drawer)/returns.tsx')).toContain(
      "const canRead = showWriteCta(perms, 'returns:read') || showWriteCta(perms, 'returns:manage');",
    );
  });

  it('replaces the Theme row with Appearance whenever Liquid Glass is not switched off, with the words the release uses', () => {
    const settings = mobile('app/(drawer)/settings.tsx');
    expect(settings).toContain('{appearance.glassEnabled ? (');
    expect(settings).toContain('title="Appearance"');
    expect(mobile('src/lib/appearance/controller.ts')).toContain('glassEnabled: !inert,');
    const labels = mobile('src/lib/appearance/labels.ts');
    for (const word of ["label: 'Liquid Glass'", "label: 'Classic'"]) {
      expect(labels, word).toContain(word);
    }
    expect(labels).toContain(
      "{ theme: 'light', label: 'Light', detail: 'Light, whatever your phone is set to.' }",
    );
    expect(labels).toContain(
      "{ theme: 'dark', label: 'Dark', detail: 'Dark, whatever your phone is set to.' }",
    );
    expect(labels).toContain(
      "{ theme: 'system', label: 'System', detail: 'Light or Dark, following your phone.' }",
    );
    expect(labels).toContain("return { text: 'Saved to your account.', retry: false };");
    expect(labels).toContain(
      "return { text: 'Saved on this phone. Not saved to your account yet.', retry: true };",
    );
    const screen = mobile('app/(drawer)/settings/appearance.tsx');
    expect(screen).toContain('Try again');
    expect(screen).toContain('accessibilityLabel="Design"');
    expect(screen).toContain('accessibilityLabel="Theme"');
  });

  it('shows Classic unless the person chose Liquid Glass under opt-in, and no Home card', () => {
    expect(defaultStyle('opt-in')).toBe('classic');
    expect(shownStyle(null, 'opt-in', false)).toBe('classic');
    expect(shownStyle('liquid-glass', 'opt-in', false)).toBe('liquid-glass');
    expect(mobile('src/lib/appearance/controller.ts')).toContain(
      "introVisible:\n        rollout === 'default' &&",
    );
  });

  it('saves to the account the website shares, and Reduce Transparency makes Liquid Glass solid', () => {
    const account = mobile('src/lib/appearance/account.ts');
    expect(account).toContain(".from('user_appearance')");
    expect(account).toContain(".upsert(values, { onConflict: 'user_id' })");
    expect(source('components/theme/theme-toggle.tsx')).toContain(
      "<DropdownMenuItem onClick={() => chooseTheme('dark')}>",
    );
    expect(mobile('src/lib/appearance/material.ts')).toContain(
      "if (inputs.reduceTransparency) return 'opaque';",
    );
  });

  it('opens one draft per double click on the website, and puts Liquid Glass toasts where Classic does', () => {
    const action = source('components/returns/return-request-action.tsx');
    expect(action).toContain('export const RETURN_REQUEST_PRESS_BURST_MS = 1000;');
    expect(action).toContain('if (burstRef.current) return; // The same press: one draft.');
    expect(action).toContain('disabled={!prepared.linkFits || opening}');
    const css = source('styles/liquid-glass/globals.glass.css');
    expect(css).not.toMatch(/ol\[data-sonner-toaster\][^{]*\{[^}]*left:\s*calc\(50%/);
    expect(css).toContain('The toast dock: bottom right, where Classic puts it');
  });
});

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

import { buildReleaseList, visibleReleases } from './logic';
import { RELEASES } from './registry';

/**
 * Added by docs/whats-new-phone-screens-by-access (2026-11-14): the release
 * for the phone update of 2026-11-14 (group 8c30f488, runtime 1.4.0, from
 * #527, squash 60f1bfe48), published at the top, directly below the Liquid
 * Glass draft and above the order request alerts release (published earlier
 * the same day) and the phone authenticator code release. One release with
 * three entries, as #527 is one phone change:
 *
 *  - the add buttons, Cycle counts and Bundles follow the member's access
 *    (every member);
 *  - after a workspace switch, the phone shows only the new workspace, and a
 *    screen still waiting for a workspace says so (every member);
 *  - a cycle count now also says Count not saved when a line is no longer
 *    in the count on the phone (whoever counts: stock:adjust, module
 *    cycle_counts).
 *
 * The suggested line about bundles coming back after access returns is left
 * out: no member notices it today.
 *
 * publishedAt was set at merge (2026-11-14) to the whole minute the first iOS
 * launch of the update showed, so these tests pin that minute with its shape
 * and its order. Its own file, so the release tests other open branches edit
 * stay as they are.
 *
 * Re-pinned by docs/whats-new-count-read-rule (2026-11-15): the count read rule and
 * email change releases are published later, directly above this release and
 * below the Liquid Glass draft. Each changed line has its own note.
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
const ID = 'phone-screens-by-access-2026-11';
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
const connectionScheduleRead = {
  release_id: CONNECTION_SCHEDULE_ID,
  revision: 1,
  dismissed_at: null,
  opened_at: '2026-11-16T09:45:00Z',
  read_at: '2026-11-16T09:45:00Z',
};
// Added by docs/whats-new-emptied-fields-and-schedule-completion (2026-11-16): the emptied fields and schedule completion release (whoever can manage the schedule or suppliers with those modules on, or the organization, locations or categories), published later, at the top, below the Liquid Glass draft.
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
const emptiedFieldsRead = {
  release_id: EMPTIED_FIELDS_ID,
  // Re-pinned by bundles/hand-out-follows-the-manager-rule (2026-11-16; was: revision 1): the emptied fields and schedule completion release is re-announced as revision 2, so a read of it is recorded at revision 2.
  revision: 2,
  dismissed_at: null,
  opened_at: '2026-11-16T12:35:00Z',
  read_at: '2026-11-16T12:35:00Z',
};
// Added by docs/whats-new-count-read-rule (2026-11-15): the count read rule release (whoever can open Cycle counts or assigns counts, where Cycle counts is on) and the email change release (every member), published later, directly above this one.
const COUNT_READ_RULE_ID = 'count-read-rule-2026-11';
const EMAIL_EXPIRED_ID = 'email-change-expired-2026-11';
// Added by docs/whats-new-unreadable-access-and-settings (2026-11-15): the settings release (whoever can open the settings pages and panels it names) and the module check release (every member), published later still, directly above the count read rule release.
const SETTINGS_ID = 'settings-not-loaded-2026-11';
const MODULE_CHECK_ID = 'module-check-try-again-2026-11';
const byId = (id: string) => RELEASES.find((r) => r.id === id)!;
const release = () => byId(ID);
const entry = (entryId: string) => release().entries.find((e) => e.id === entryId)!;

const viewer = (
  role: ReleaseViewer['role'],
  permissions: ReleaseViewer['permissions'],
  enabledModules: ReleaseViewer['enabledModules'],
): ReleaseViewer => ({ role, permissions, enabledModules });
const owner = viewer('owner', [...PERMISSIONS], Object.keys(MODULE_REGISTRY) as ModuleId[]);
const member = viewer('viewer', [], []);
const entriesFor = (v: ReleaseViewer) =>
  visibleReleases(RELEASES, v)
    .find((r) => r.id === ID)
    ?.entries.map((e) => e.id) ?? [];

/** A source file under apps/mobile/src, as written. */
const mobile = (rel: string) =>
  readFileSync(resolve(__dirname, '../../../../mobile/src', rel), 'utf8');
const mobileApp = (rel: string) =>
  readFileSync(resolve(__dirname, '../../../../mobile/app', rel), 'utf8');

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

describe('the phone screens by access release of 2026-11-14: order, status and date', () => {
  it('is published once, as revision 1, directly below the count read rule and email change releases (published later, below the Liquid Glass draft at the top) and above the order request alerts release', () => {
    expect(RELEASES.filter((r) => r.id === ID)).toHaveLength(1);
    expect(release().status).toBe('published');
    expect(release().revision).toBe(1);
    expect(release().withdrawnNote).toBeUndefined();
    // The order request alerts release, published earlier the same day (17:58Z), sits directly below.
    // Re-pinned by docs/whats-new-count-read-rule (2026-11-15; was: RELEASES.slice(0, 4), without them): the count read rule and email change releases are published later, at the top, directly below the Liquid Glass draft, so every position below them moves down by two.
    // Re-pinned by docs/whats-new-unreadable-access-and-settings (2026-11-15; was: RELEASES.slice(0, 6), without them): the settings and module check releases are published later, at the top, directly below the Liquid Glass draft, so every position below them moves down by two.
    // Re-pinned by docs/whats-new-navigation-keeps-choices (2026-11-15; was: RELEASES.slice(0, 8), without it): the navigation release is published later, at the top, directly below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-invitation-audit (2026-11-15; was: RELEASES.slice(0, 9), without it): the invitation audit release is published later, at the top, directly below the Liquid Glass draft.
    // Re-pinned by docs/whats-new-api-key-audit (2026-11-15; was: RELEASES.slice(0, 10), without it): the API key audit release is published later, at the top, directly below the Liquid Glass draft.
    // Re-pinned by docs/whats-new-authenticator-set-up-first (2026-11-15; was: every pinned position one place higher): the authenticator set-up release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-delete-account-confirm (2026-11-16; was: every pinned position one place higher): the delete account release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-integrations-message-and-api-key-rows (2026-11-16; was: every pinned position one place higher): the Integrations and schedule event release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-emptied-fields-and-schedule-completion (2026-11-16; was: RELEASES.slice(0, 14)): the emptied fields and schedule completion release is published at the top, below the Liquid Glass draft, so the list takes one more.
    // Re-pinned by docs/releases-low-critical-pages (2026-11-18; was: RELEASES.slice(0, 15)): the Low + critical pages and list value release is published at the top, below the Liquid Glass draft, so the list takes one more.
    // Re-pinned by docs/whats-new-receiving-shown-to-managers (2026-11-19; was: RELEASES.slice(0, 16)): the receiving release is published at the top, below the Liquid Glass draft, so the list takes one more.
    // Re-pinned by docs/whats-new-small-fixes-1119 (2026-11-19; was: RELEASES.slice(0, 17)): the export, receipt and access release is published at the top, below the Liquid Glass draft, so the list takes one more.
    expect(RELEASES.slice(0, 18).map((r) => [r.id, r.status])).toEqual([
      ['liquid-glass-2026-11', 'draft'],
      // Re-pinned by docs/whats-new-small-fixes-1119 (2026-11-19; was: without it): the export, receipt and access release is published later, at the top, directly below the Liquid Glass draft.
      [EXPORT_RECEIPT_ACCESS_ID, 'published'],
      // Re-pinned by docs/whats-new-receiving-shown-to-managers (2026-11-19; was: without it): the receiving release is published later, at the top, directly below the Liquid Glass draft.
      [RECEIVING_ID, 'published'],
      // Re-pinned by docs/whats-new-invitation-audit (2026-11-15; was: without it): the invitation audit release is published later, at the top, directly below the Liquid Glass draft.
      // Re-pinned by docs/whats-new-api-key-audit (2026-11-15; was: without it): the API key audit release is published later, at the top, directly below the Liquid Glass draft.
      // Re-pinned by docs/whats-new-authenticator-set-up-first (2026-11-15; was: without it): the authenticator set-up release is published later, at the top, directly below the Liquid Glass draft.
      // Re-pinned by docs/whats-new-delete-account-confirm (2026-11-16; was: without it): the delete account release is published later, at the top, directly below the Liquid Glass draft.
      // Re-pinned by docs/whats-new-integrations-message-and-api-key-rows (2026-11-16; was: without it): the Integrations and schedule event release is published later, at the top, directly below the Liquid Glass draft.
      // Re-pinned by docs/whats-new-emptied-fields-and-schedule-completion (2026-11-16; was: without it): the emptied fields and schedule completion release is published later, at the top, directly below the Liquid Glass draft.
      // Re-pinned by docs/releases-low-critical-pages (2026-11-18; was: without it): the Low + critical pages and list value release is published later, at the top, directly below the Liquid Glass draft.
      [LOW_CRITICAL_ID, 'published'],
      [EMPTIED_FIELDS_ID, 'published'],
      [CONNECTION_SCHEDULE_ID, 'published'],
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
      [ID, 'published'],
      ['order-request-alerts-follow-approve-2026-11', 'published'],
      ['phone-authenticator-code-2026-11', 'published'],
    ]);
    expect(RELEASES.find((r) => r.status === 'published')?.id).toBe(
      // Re-pinned by docs/whats-new-count-read-rule (2026-11-15; was: ID): the count read rule release is published after it, at the top, the newest published release.
      // Re-pinned by docs/whats-new-unreadable-access-and-settings (2026-11-15; was: the count read rule release): the settings release is published after it, at the top, the newest published release.
      // Re-pinned by docs/whats-new-navigation-keeps-choices (2026-11-15; was: the settings release): the navigation release is published after it, at the top, the newest published release.
      // Re-pinned by docs/whats-new-invitation-audit (2026-11-15; was: the navigation release): the invitation audit release is published after it, at the top, the newest published release.
      // Re-pinned by docs/whats-new-api-key-audit (2026-11-15; was: the invitation audit release): the API key audit release is published after it, at the top, the newest published release.
      // Re-pinned by docs/whats-new-authenticator-set-up-first (2026-11-15; was: the API key audit release): the authenticator set-up release is published after it, at the top, the newest published release.
      // Re-pinned by docs/whats-new-delete-account-confirm (2026-11-16; was: the authenticator set-up release): the delete account release is published after it, at the top, the newest published release.
      // Re-pinned by docs/whats-new-integrations-message-and-api-key-rows (2026-11-16; was: the delete account release): the Integrations and schedule event release is published after it, at the top, the newest published release.
      // Re-pinned by docs/whats-new-emptied-fields-and-schedule-completion (2026-11-16; was: CONNECTION_SCHEDULE_ID): the emptied fields and schedule completion release is published after it, at the top, the newest published release.
      // Re-pinned by docs/releases-low-critical-pages (2026-11-18; was: the emptied fields and schedule completion release): the Low + critical pages and list value release is published after it, at the top, the newest published release.
      // Re-pinned by docs/whats-new-receiving-shown-to-managers (2026-11-19; was: the Low + critical pages and list value release): the receiving release is published after it, at the top, the newest published release.
      // Re-pinned by docs/whats-new-small-fixes-1119 (2026-11-19; was: the receiving release): the export, receipt and access release is published after it, at the top, the newest published release.
      EXPORT_RECEIPT_ACCESS_ID,
    );
  });

  it('is dated on a whole minute after the phone update was published, with the draft placeholder at or after that minute and no later release below', () => {
    const at = release().publishedAt;
    expect(at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/);
    // Set at merge: the first iOS launch of the update showed between the reads of 18:34:04Z and 18:44:07Z.
    expect(at).toBe('2026-11-14T18:44:00Z');
    // Re-pinned by docs/whats-new-count-read-rule (2026-11-15; was: the draft placeholder at this minute): the placeholder moved to the minute of the count read rule and email change releases, published later, so it is at or after this one.
    expect(Date.parse(RELEASES[0]!.publishedAt)).toBeGreaterThanOrEqual(Date.parse(at));
    // The phone update (group 8c30f488) was published at 2026-11-14T05:39:05Z.
    expect(Date.parse(at)).toBeGreaterThan(Date.parse('2026-11-14T05:39:05Z'));
    // Re-pinned by docs/whats-new-count-read-rule (2026-11-15; was: RELEASES.slice(2)): the count read rule and email change releases are published at the top, below the Liquid Glass draft, so every position below them moves down by two.
    // Re-pinned by docs/whats-new-unreadable-access-and-settings (2026-11-15; was: every pinned position two places higher): the settings and module check releases are published at the top, below the Liquid Glass draft, so every position below them moves down by two.
    // Re-pinned by docs/whats-new-navigation-keeps-choices (2026-11-15; was: every pinned position one place higher): the navigation release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-invitation-audit (2026-11-15; was: every pinned position one place higher): the invitation audit release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-api-key-audit (2026-11-15; was: every pinned position one place higher): the API key audit release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-authenticator-set-up-first (2026-11-15; was: every pinned position one place higher): the authenticator set-up release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-delete-account-confirm (2026-11-16; was: every pinned position one place higher): the delete account release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-integrations-message-and-api-key-rows (2026-11-16; was: every pinned position one place higher): the Integrations and schedule event release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-emptied-fields-and-schedule-completion (2026-11-16; was: every pinned position one place higher): the emptied fields and schedule completion release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/releases-low-critical-pages (2026-11-18; was: slice(13)): the Low + critical pages and list value release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-receiving-shown-to-managers (2026-11-19; was: RELEASES.slice(14)): the receiving release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-small-fixes-1119 (2026-11-19; was: RELEASES.slice(15)): the export, receipt and access release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    for (const r of RELEASES.slice(16)) {
      expect(Date.parse(at), r.id).toBeGreaterThanOrEqual(Date.parse(r.publishedAt));
    }
  });

  it('parses under the shared schema, in plain text, with its entries in order', () => {
    expect(releaseSchema.safeParse(release()).success).toBe(true);
    for (const text of readerText(release())) expect(text).not.toMatch(/[<>]/);
    expect(release().entries.map((e) => [e.id, e.category, e.area])).toEqual([
      ['phone-add-item-and-screens-by-access', 'fixed', 'Mobile app'],
      ['phone-workspace-switch-own-lists', 'fixed', 'Mobile app'],
      ['phone-count-not-saved-line-gone', 'fixed', 'Cycle counts'],
    ]);
  });
});

describe('the phone screens by access release: the words', () => {
  const access = () => entry('phone-add-item-and-screens-by-access');
  const workspace = () => entry('phone-workspace-switch-own-lists');
  const count = () => entry('phone-count-not-saved-line-gone');

  it('says what the phone does, in the reviewed words', () => {
    expect(release().title).toBe(
      "The phone follows your access and keeps each workspace's own lists",
    );
    expect(release().summary).toBe(
      "The mobile app's add buttons, Cycle counts and Bundles now follow your access, and after a workspace switch its lists show only the new workspace. A screen still waiting for a workspace now says so, and a cycle count now also says Count not saved when a line is no longer in the count.",
    );

    expect(access().title).toBe(
      "The phone's add buttons, Cycle counts and Bundles follow your access",
    );
    expect(access().whatChanged).toBe(
      'The buttons that add an item, on Items, Books and Scan, now show only if you can add items in the workspace on screen. Cycle counts and Bundles, with the Bundles card on Home, now follow the side menu.',
    );
    expect(access().whyItMatters).toBe(
      'What the phone offers now matches the side menu and what you can save, so a button you see is one you can use.',
    );
    expect(access().howItAffectsYou).toBe(
      'If you can add items and use cycle counts and bundles, nothing changes for you once the phone has synced.',
    );
    expect(access().whatToDo).toBe(
      'No action needed. If you need one of these, ask an admin in your organization.',
    );

    expect(workspace().title).toBe(
      'After a workspace switch, the phone shows only the new workspace',
    );
    expect(workspace().whatChanged).toBe(
      "After you switch workspaces, Users, Team, Accounts, Bundles, Cycle counts and the admin lists on the phone show only the new workspace's records, and the phone uses your role in the new workspace as soon as it shows it, and your permissions there once it has synced. If a workspace has not finished loading or syncing, a screen with nothing to show says so and lets you try again.",
    );
    expect(workspace().whyItMatters).toBe(
      'Each workspace keeps its own records and your access in it, and a screen that is still waiting tells you so.',
    );
    expect(workspace().howItAffectsYou).toBe(
      'Right after a switch or a sign-in, before the phone has synced, a screen may say the phone has not finished syncing this workspace yet. Check your connection: the screen loads once the phone has synced, or when you try again.',
    );
    expect(workspace().whatToDo).toBe('No action needed.');

    expect(count().title).toBe(
      'A cycle count now also says Count not saved when a line is no longer in the count on the phone',
    );
    expect(count().whatChanged).toBe(
      'If a number you type or scan on a cycle count cannot be saved because its line is no longer in the count on the phone, the phone now says Count not saved. When you tap OK, the phone loads the count again, or closes it if it is no longer open to you.',
    );
    expect(count().whyItMatters).toBe(
      'Before, the number stayed on the line as if it had been saved.',
    );
    expect(count().howItAffectsYou).toBe(
      'This is rare: it happens when the count changes while you are counting, for example when someone posts or cancels it.',
    );
    expect(count().whatToDo).toBe('No action needed.');
  });

  it('keeps to what a member notices: three entries, no bundle refill line, plain words about what the phone does now, never "book" for a quantity', () => {
    const text = readerText(release()).join(' ');
    expect(release().entries).toHaveLength(3);
    expect(text).not.toMatch(/regain|come back|comes back/i);
    expect(text).not.toMatch(/\b(?:saw|could see|was shown|were shown|security|leak|exposed)\b/i);
    expect(text).not.toMatch(/\bbook\b/i);
    expect(text).not.toMatch(/!/);
    // Reassign changes only before the phone's first sync of a workspace: left out.
    expect(text).not.toMatch(/Reassign/);
    // The two entries every member reads say what the phone does now, never
    // what it did before: no "Before,", "used to", "previously", "the previous
    // workspace", "no longer", "anymore", "any more", "stops using", "instead
    // of", "earlier" or "until now".
    // Entry 3 (whoever counts) may say "Before," and "no longer": it describes a
    // save the phone did not make, not anyone's access.
    for (const e of [access(), workspace()]) {
      const said = [e.title, e.whatChanged, e.whyItMatters, e.howItAffectsYou].join(' ');
      expect(said, e.id).not.toMatch(
        /\bbefore,|\bused to\b|\bpreviously\b|\bprevious workspace\b|\bno longer\b|\banymore\b|\bstops? using\b|\binstead of\b|\bany more\b|\bearlier\b|\buntil now\b/i,
      );
    }
  });

  it('tells the first two entries to every member and the count entry to whoever counts, with no links', () => {
    expect(release().audience).toBeUndefined();
    expect(access().audience).toBeUndefined();
    expect(workspace().audience).toBeUndefined();
    expect(count().audience).toEqual({
      anyPermission: ['stock:adjust'],
      modules: ['cycle_counts'],
    });
    for (const e of release().entries) expect(e.link, e.id).toBeUndefined();

    expect(entriesFor(owner)).toEqual([
      'phone-add-item-and-screens-by-access',
      'phone-workspace-switch-own-lists',
      'phone-count-not-saved-line-gone',
    ]);
    expect(entriesFor(member)).toEqual([
      'phone-add-item-and-screens-by-access',
      'phone-workspace-switch-own-lists',
    ]);
    expect(entriesFor(viewer('staff', ['stock:adjust'], []))).toEqual([
      'phone-add-item-and-screens-by-access',
      'phone-workspace-switch-own-lists',
    ]);
    expect(entriesFor(viewer('staff', ['stock:adjust'], ['cycle_counts']))).toEqual([
      'phone-add-item-and-screens-by-access',
      'phone-workspace-switch-own-lists',
      'phone-count-not-saved-line-gone',
    ]);
    // Re-pinned by docs/whats-new-count-read-rule (2026-11-15; was: nothing read): the count read rule and email change releases are published later, at the top; the email change release reaches every member and the count read rule release reaches the owner here, so each reader reads them first, and the notice this test checks is the one it checked before. A read of a release by a reader it does not reach changes nothing.
    const newerRead = [
      // Re-pinned by docs/whats-new-unreadable-access-and-settings (2026-11-15; was: without them): the settings and module check releases are published later, at the top; the module check release reaches every member and the settings release reaches the owner here, so each reader reads them first, and the notice this test checks is the one it checked before. A read of a release by a reader it does not reach changes nothing.
      // Re-pinned by docs/whats-new-navigation-keeps-choices (2026-11-15; was: without it): the navigation release is published later, at the top, and reaches owners and admins who can open Settings, Navigation, so it is read, seen or listed with the newer releases, and every notice this test checks is the one it checked before.
      // Re-pinned by docs/whats-new-invitation-audit (2026-11-15; was: without it): the invitation audit release is published later, at the top, and reaches whoever can view the audit log (owners, admins and managers by default), so it is read or seen with the newer releases, and every notice this test checks is the one it checked before. A read of a release by a reader it does not reach changes nothing.
      // Re-pinned by docs/whats-new-api-key-audit (2026-11-15; was: without it): the API key audit release is published later, at the top, and reaches the same readers as the invitation audit release, so it is read with the newer releases, and every notice this test checks is the one it checked before. A read of a release by a reader it does not reach changes nothing.
      // Re-pinned by docs/whats-new-authenticator-set-up-first (2026-11-15; was: without it): the authenticator set-up release is published later, at the top, and reaches every member, so it is read with the newer releases, and every notice this test checks is the one it checked before.
      // Re-pinned by docs/whats-new-delete-account-confirm (2026-11-16; was: without it): the delete account release is published later, at the top, and reaches every member, so it is read with the newer releases, and every notice this test checks is the one it checked before.
      // Re-pinned by docs/whats-new-integrations-message-and-api-key-rows (2026-11-16; was: without it): the Integrations and schedule event release is published later, at the top, and reaches whoever can manage integrations or schedule events with those modules on (owners and admins, and managers for its schedule entry, by default), an owner with every permission and module included, so it is read, seen or listed with the newer releases, and every notice this test checks is the one it checked before.
      // Re-pinned by docs/whats-new-emptied-fields-and-schedule-completion (2026-11-16; was: without it): the emptied fields and schedule completion release is published later, at the top, and reaches whoever can manage the schedule or suppliers with those modules on, or the organization, locations or categories (owners and admins, and managers for all but its charter and warehouse entry, by default), an owner with every permission included, so it is read, seen or listed with the newer releases, and every notice this test checks is the one it checked before.
      // Re-pinned by docs/releases-low-critical-pages (2026-11-18; was: without it): the Low + critical pages and list value release is published later, at the top, and reaches whoever can read items (every role by default), so it is read or seen first, and the notice this test checks is the one it checked before.
      // Re-pinned by docs/whats-new-receiving-shown-to-managers (2026-11-19; was: without it): the receiving release is published later, at the top, and reaches whoever can open a purchase order where Receiving is on (owners, admins, managers, staff and viewers by default), an owner with every permission and module among them, so it is read, seen or listed with the newer releases, and every notice this test checks is the one it checked before.
      // Re-pinned by docs/whats-new-small-fixes-1119 (2026-11-19; was: without it): the export, receipt and access release is published later, at the top, and reaches every member (its access entry has no audience), an owner with every permission and module among them, so it is read, seen or listed with the newer releases, and every notice this test checks is the one it checked before.
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
    ];
    for (const v of [owner, member]) {
      expect(buildReleaseList(RELEASES, v, newerRead, null).latestUnread?.id, v.role).toBe(ID);
    }
  });
});

describe('the phone screens by access release rests on the phone code (#527)', () => {
  it('the buttons that add an item follow items:create on Items, Books and Scan', () => {
    for (const screen of [
      '(drawer)/(tabs)/inventory.tsx',
      '(drawer)/(tabs)/books.tsx',
      '(drawer)/(tabs)/scan.tsx',
    ]) {
      expect(mobileApp(screen), screen).toContain("useCreateControlOffer('items:create')");
    }
  });

  it('Cycle counts and Bundles ask the side menu, and say when they are not available or not synced yet', () => {
    const gate = mobile('lib/screen-access.ts');
    expect(gate).toContain(
      'return drawerOffers(href, role, input.modules.modules, input.saved.permissions)',
    );
    expect(gate).toContain("'Cycle counts are not available to you in this workspace.'");
    expect(gate).toContain(
      "export const BUNDLES_NOT_AVAILABLE = 'Bundles are not available to you in this workspace.';",
    );
    expect(gate).toContain(
      "'This phone has not finished syncing this workspace yet. Check your connection and try again.'",
    );
    expect(mobile('lib/bundles-gate-view.ts')).toContain(
      'return { spinner: false, words: BUNDLES_NOT_AVAILABLE, refresh: null };',
    );
  });

  it('a switch reads the saved access again before the new workspace is shown', () => {
    const ws = mobile('lib/use-workspace.ts');
    expect(ws).toContain('async function rereadSavedAccess(): Promise<void> {');
    expect(ws).toContain('refreshEffectivePermissions(),');
  });

  it('Count not saved for a line no longer on the phone, then the count loads again or closes', () => {
    const refusal = mobile('lib/count-save-refusal.ts');
    expect(refusal).toContain("title: 'Count not saved',");
    expect(refusal).toContain(
      "'This line is no longer in the count saved on this phone, so this number was not saved. Tap OK to load the count again, or to close it if it is no longer open to you.'",
    );
    const screen = mobileApp('cycle-count/[id].tsx');
    expect(screen).toContain('lineGoneNotice.say(() => setLineGoneAnswered((n) => n + 1));');
    expect(screen).toContain('async function reloadAfterLineGone() {');
    expect(mobileApp('cycle-count/scan/[id].tsx')).toContain(
      'async function afterScanLineGone() {',
    );
  });
});

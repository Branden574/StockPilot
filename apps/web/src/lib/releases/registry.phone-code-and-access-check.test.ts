import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
// Added by docs/whats-new-receiving-shown-to-managers (2026-11-19): the receiving release (whoever can open a purchase order where Receiving is on), published later, at the top, below the Liquid Glass draft.
const RECEIVING_ID = 'receiving-shown-to-managers-2026-11';
const receivingRead = {
  release_id: RECEIVING_ID,
  revision: 1,
  dismissed_at: null,
  opened_at: '2026-11-19T04:31:00Z',
  read_at: '2026-11-19T04:31:00Z',
};
const emptiedFieldsRead = {
  release_id: EMPTIED_FIELDS_ID,
  // Re-pinned by bundles/hand-out-follows-the-manager-rule (2026-11-16; was: revision 1): the emptied fields and schedule completion release is re-announced as revision 2, so a read of it is recorded at revision 2.
  revision: 2,
  dismissed_at: null,
  opened_at: '2026-11-16T12:35:00Z',
  read_at: '2026-11-16T12:35:00Z',
};

import { describe, expect, it } from 'vitest';

import {
  CONTEXT_UNAVAILABLE_COPY,
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
 * Added by docs/whatsnew-phone-code-and-access-check (2026-11-13): the two
 * releases for the phone update of 2026-11-13 (group c6f9ebd1, runtime
 * 1.4.0), published at the top, directly below the Liquid Glass draft and
 * above the emailed links release:
 *
 *  - S43b, release 2 of the authenticator entry, one entry: the mobile app
 *    waits for the authenticator code before it shows or loads the
 *    organization's data. The plan's second entry (the phone after an
 *    authenticator is turned on on the web) is left out: being asked to sign
 *    in again then is not a change of this update;
 *  - S26: clearer words on the phone when access cannot be checked, for a
 *    stock adjustment, a rental checkout and an escalation.
 *
 * Both share one publishedAt, set at merge to the whole minute at or after
 * the first iOS launch of the update, so these tests pin its shape and its
 * order, not the minute itself. Its own file, so the release tests other open
 * branches edit stay as they are.
 *
 * Re-pinned by docs/whats-new-order-request-alerts (2026-11-14): the order request alerts
 * release is published later, directly above the authenticator code release
 * and below the Liquid Glass draft. Each changed line has its own note.
 *
 * Re-pinned by docs/whats-new-phone-screens-by-access (2026-11-14): the phone screens by
 * access release is published later still, at the top, directly above the order
 * request alerts release and below the Liquid Glass draft. Each changed line
 * has its own note.
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
const CODE_ID = 'phone-authenticator-code-2026-11';
const ACCESS_ID = 'phone-access-check-retry-2026-11';
const byId = (id: string) => RELEASES.find((r) => r.id === id)!;
const entry = (releaseId: string, entryId: string) =>
  byId(releaseId).entries.find((e) => e.id === entryId)!;

const viewer = (
  role: ReleaseViewer['role'],
  permissions: ReleaseViewer['permissions'],
  enabledModules: ReleaseViewer['enabledModules'],
): ReleaseViewer => ({ role, permissions, enabledModules });
const owner = viewer('owner', [...PERMISSIONS], Object.keys(MODULE_REGISTRY) as ModuleId[]);
const member = viewer('viewer', [], []);
const entriesFor = (id: string, v: ReleaseViewer) =>
  visibleReleases(RELEASES, v)
    .find((r) => r.id === id)
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

describe('the phone update releases of 2026-11-13: order, status and date', () => {
  it('are published once each, as revision 1, directly below the order request alerts release (published later, below the Liquid Glass draft at the top), the authenticator code release above the access check release', () => {
    for (const id of [CODE_ID, ACCESS_ID]) {
      expect(
        RELEASES.filter((r) => r.id === id),
        id,
      ).toHaveLength(1);
      expect(byId(id).status, id).toBe('published');
      expect(byId(id).revision, id).toBe(1);
      expect(byId(id).withdrawnNote, id).toBeUndefined();
    }
    // Re-pinned by docs/whats-new-order-request-alerts (2026-11-14; was: RELEASES.slice(0, 4), without it): the order request alerts release is published later, at the top, directly below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-phone-screens-by-access (2026-11-14; was: RELEASES.slice(0, 5), without it, and the order request alerts release the newest published): the phone screens by access release is published later, at the top, directly below the Liquid Glass draft and above the order request alerts release, the newest published release.
    // Re-pinned by docs/whats-new-count-read-rule (2026-11-15; was: RELEASES.slice(0, 6), without them, and the phone screens by access release the newest published): the count read rule and email change releases are published later, at the top, directly below the Liquid Glass draft and above the phone screens by access release; the count read rule release is the newest published release.
    // Re-pinned by docs/whats-new-unreadable-access-and-settings (2026-11-15; was: RELEASES.slice(0, 8), without them, and the count read rule release the newest published): the settings and module check releases are published later, at the top, directly below the Liquid Glass draft and above the count read rule release; the settings release is the newest published release.
    // Re-pinned by docs/whats-new-navigation-keeps-choices (2026-11-15; was: RELEASES.slice(0, 10), without it): the navigation release is published later, at the top, directly below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-invitation-audit (2026-11-15; was: RELEASES.slice(0, 11), without it): the invitation audit release is published later, at the top, directly below the Liquid Glass draft.
    // Re-pinned by docs/whats-new-api-key-audit (2026-11-15; was: RELEASES.slice(0, 12), without it): the API key audit release is published later, at the top, directly below the Liquid Glass draft.
    // Re-pinned by docs/whats-new-authenticator-set-up-first (2026-11-15; was: every pinned position one place higher): the authenticator set-up release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-delete-account-confirm (2026-11-16; was: every pinned position one place higher): the delete account release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-integrations-message-and-api-key-rows (2026-11-16; was: every pinned position one place higher): the Integrations and schedule event release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-emptied-fields-and-schedule-completion (2026-11-16; was: RELEASES.slice(0, 16)): the emptied fields and schedule completion release is published at the top, below the Liquid Glass draft, so the list takes one more.
    // Re-pinned by docs/releases-low-critical-pages (2026-11-18; was: RELEASES.slice(0, 17)): the Low + critical pages and list value release is published at the top, below the Liquid Glass draft, so the list takes one more.
    // Re-pinned by docs/whats-new-receiving-shown-to-managers (2026-11-19; was: RELEASES.slice(0, 18)): the receiving release is published at the top, below the Liquid Glass draft, so the list takes one more.
    expect(RELEASES.slice(0, 19).map((r) => [r.id, r.status])).toEqual([
      ['liquid-glass-2026-11', 'draft'],
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
      // Re-pinned by docs/whats-new-unreadable-access-and-settings (2026-11-15; was: without them): the settings and module check releases are published later, at the top, directly below the Liquid Glass draft.
      // Re-pinned by docs/whats-new-navigation-keeps-choices (2026-11-15; was: without it): the navigation release is published later, at the top, directly below the Liquid Glass draft.
      ['navigation-keeps-choices-2026-11', 'published'],
      ['settings-not-loaded-2026-11', 'published'],
      ['module-check-try-again-2026-11', 'published'],
      ['count-read-rule-2026-11', 'published'],
      ['email-change-expired-2026-11', 'published'],
      ['phone-screens-by-access-2026-11', 'published'],
      ['order-request-alerts-follow-approve-2026-11', 'published'],
      [CODE_ID, 'published'],
      [ACCESS_ID, 'published'],
      ['emailed-links-name-their-account-2026-11', 'published'],
    ]);
    expect(RELEASES.find((r) => r.status === 'published')?.id).toBe(
      // Re-pinned by docs/whats-new-order-request-alerts (2026-11-14; was: CODE_ID): the order request alerts release is published after it, at the top, the newest published release.
      // Re-pinned by docs/whats-new-phone-screens-by-access (2026-11-14; was: the order request alerts release): the phone screens by access release is published after it, at the top, the newest published release.
      // Re-pinned by docs/whats-new-count-read-rule (2026-11-15; was: the phone screens by access release): the count read rule release is published after it, at the top, the newest published release.
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
      RECEIVING_ID,
    );
  });

  it('share one whole minute, after the web half went live and the phone update was published, with the draft placeholder at or after that minute and no later release below', () => {
    const at = byId(CODE_ID).publishedAt;
    expect(at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/);
    expect(byId(ACCESS_ID).publishedAt).toBe(at);
    // Re-pinned by docs/whats-new-order-request-alerts (2026-11-14; was: the draft placeholder at this minute): the placeholder moved to the minute of the order request alerts release, published later, so it is at or after this one.
    // Re-pinned by docs/whats-new-phone-screens-by-access (2026-11-14; was: the draft placeholder alone at or after this minute): the placeholder moved again, to the minute of the phone screens by access release, published later at the top, so both are at or after this minute.
    expect(Date.parse(RELEASES[0]!.publishedAt)).toBeGreaterThanOrEqual(Date.parse(at));
    // Re-pinned by docs/whats-new-count-read-rule (2026-11-15; was: RELEASES[1], the phone screens by access release): the count read rule and email change releases are published at the top, below the Liquid Glass draft, so that release is two places lower; the placeholder moved again, to their minute.
    // Re-pinned by docs/whats-new-unreadable-access-and-settings (2026-11-15; was: every pinned position two places higher): the settings and module check releases are published at the top, below the Liquid Glass draft, so every position below them moves down by two.
    // Re-pinned by docs/whats-new-navigation-keeps-choices (2026-11-15; was: every pinned position one place higher): the navigation release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-invitation-audit (2026-11-15; was: every pinned position one place higher): the invitation audit release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-api-key-audit (2026-11-15; was: every pinned position one place higher): the API key audit release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-authenticator-set-up-first (2026-11-15; was: every pinned position one place higher): the authenticator set-up release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-delete-account-confirm (2026-11-16; was: every pinned position one place higher): the delete account release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-integrations-message-and-api-key-rows (2026-11-16; was: every pinned position one place higher): the Integrations and schedule event release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-emptied-fields-and-schedule-completion (2026-11-16; was: every pinned position one place higher): the emptied fields and schedule completion release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/releases-low-critical-pages (2026-11-18; was: every pinned position one place higher): the Low + critical pages and list value release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-receiving-shown-to-managers (2026-11-19; was: RELEASES[13]): the receiving release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    expect(Date.parse(RELEASES[14]!.publishedAt)).toBeGreaterThanOrEqual(Date.parse(at));
    // #510 went live at 18:05:33Z; the phone update was published at 20:08:51Z.
    expect(Date.parse(at)).toBeGreaterThan(Date.parse('2026-11-13T18:05:33Z'));
    expect(Date.parse(at)).toBeGreaterThan(Date.parse('2026-11-13T20:08:51Z'));
    // Re-pinned by docs/whats-new-order-request-alerts (2026-11-14; was: RELEASES.slice(3)): the order request alerts release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
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
    // Re-pinned by docs/releases-low-critical-pages (2026-11-18; was: slice(16)): the Low + critical pages and list value release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-receiving-shown-to-managers (2026-11-19; was: RELEASES.slice(17)): the receiving release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    for (const r of RELEASES.slice(18)) {
      expect(Date.parse(at), r.id).toBeGreaterThanOrEqual(Date.parse(r.publishedAt));
    }
  });

  it('parse under the shared schema, in plain text, with their entries in order', () => {
    for (const id of [CODE_ID, ACCESS_ID]) {
      expect(releaseSchema.safeParse(byId(id)).success, id).toBe(true);
      for (const text of readerText(byId(id))) expect(text, id).not.toMatch(/[<>]/);
    }
    expect(byId(CODE_ID).entries.map((e) => [e.id, e.category, e.area])).toEqual([
      ['phone-waits-for-authenticator-code', 'fixed', 'Mobile app'],
    ]);
    expect(byId(ACCESS_ID).entries.map((e) => [e.id, e.category, e.area])).toEqual([
      ['phone-adjustment-access-not-checked', 'fixed', 'Inventory'],
      ['phone-rental-checkout-access-not-checked', 'fixed', 'Rentals'],
      ['phone-escalation-access-not-checked', 'fixed', 'Maintenance'],
    ]);
  });
});

describe('the mobile app waits for your authenticator code (S43b)', () => {
  const waits = () => entry(CODE_ID, 'phone-waits-for-authenticator-code');

  it('says what the phone does, in the reviewed words', () => {
    expect(byId(CODE_ID).title).toBe('The mobile app waits for your authenticator code');
    expect(byId(CODE_ID).summary).toBe(
      "If you use an authenticator app, the mobile app now shows the code screen before your organization's data and waits for your 6-digit code before it loads your items and orders or sends changes waiting on the phone.",
    );
    expect(waits().title).toBe(
      "The mobile app waits for your authenticator code before it loads your organization's data",
    );
    expect(waits().whatChanged).toBe(
      "If you use an authenticator app, the mobile app now shows the code screen first. It waits for your 6-digit code before it loads your organization's items, orders and other data, before it sends changes waiting on the phone, and before it turns on notifications for the phone. Without a connection, it shows the code screen and waits.",
    );
    expect(waits().whyItMatters).toBe(
      "The mobile app now asks for your code before it shows or loads your organization's data, as the web app does.",
    );
    expect(waits().howItAffectsYou).toBe(
      'After you enter your code, the app works as before, and changes that were waiting are sent. Entering the code needs a connection.',
    );
    expect(waits().whatToDo).toBe('No action needed.');
  });

  it('keeps to what this update changed: the organization data, one entry, nothing about passwords or signing in again', () => {
    const text = readerText(byId(CODE_ID)).join(' ');
    expect(byId(CODE_ID).entries).toHaveLength(1);
    expect(
      RELEASES.flatMap((r) => r.entries).some(
        (e) => e.id === 'phone-asks-for-code-after-turning-on-authenticator',
      ),
    ).toBe(false);
    expect(text).not.toMatch(/nothing at all|loads nothing|nothing is read/i);
    expect(text).not.toMatch(/password/i);
    expect(text).not.toMatch(/sign in again/i);
  });

  it('reaches every member, with no audience and no link', () => {
    for (const e of byId(CODE_ID).entries) {
      expect(e.audience, e.id).toBeUndefined();
      expect(e.link, e.id).toBeUndefined();
    }
    expect(byId(CODE_ID).audience).toBeUndefined();
    // Re-pinned by docs/whats-new-order-request-alerts (2026-11-14; was: nothing read): the order request alerts release is published later, at the top, and reaches the owner here, so the owner reads it first and the notice this test checks is the one it checked before. A read of it by a reader it does not reach changes nothing.
    // Re-pinned by docs/whats-new-phone-screens-by-access (2026-11-14; was: the read of the order request alerts release alone): the phone screens by access release is published later, at the top, and reaches every member (two of its three entries have no audience), so each reader reads it first, and the notice this test checks is the one it checked before.
    // Re-pinned by docs/whats-new-count-read-rule (2026-11-15; was: the reads of the phone screens by access and order request alerts releases): the count read rule and email change releases are published later, at the top; the email change release reaches every member and the count read rule release reaches the owner here, so each reader reads them first, and the notice this test checks is the one it checked before. A read of a release by a reader it does not reach changes nothing.
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
        release_id: 'settings-not-loaded-2026-11',
        revision: 1,
        dismissed_at: null,
        opened_at: '2026-11-15T04:30:00Z',
        read_at: '2026-11-15T04:30:00Z',
      },
      {
        release_id: 'module-check-try-again-2026-11',
        revision: 1,
        dismissed_at: null,
        opened_at: '2026-11-15T04:30:00Z',
        read_at: '2026-11-15T04:30:00Z',
      },
      {
        release_id: 'count-read-rule-2026-11',
        revision: 1,
        dismissed_at: null,
        opened_at: '2026-11-15T00:30:00Z',
        read_at: '2026-11-15T00:30:00Z',
      },
      {
        release_id: 'email-change-expired-2026-11',
        revision: 1,
        dismissed_at: null,
        opened_at: '2026-11-15T00:30:00Z',
        read_at: '2026-11-15T00:30:00Z',
      },
      {
        release_id: 'phone-screens-by-access-2026-11',
        revision: 1,
        dismissed_at: null,
        opened_at: '2026-11-14T19:00:00Z',
        read_at: '2026-11-14T19:00:00Z',
      },
      {
        release_id: 'order-request-alerts-follow-approve-2026-11',
        revision: 1,
        dismissed_at: null,
        opened_at: '2026-11-14T18:30:00Z',
        read_at: '2026-11-14T18:30:00Z',
      },
    ];
    for (const v of [owner, member]) {
      expect(entriesFor(CODE_ID, v), v.role).toEqual(['phone-waits-for-authenticator-code']);
      expect(buildReleaseList(RELEASES, v, newerRead, null).latestUnread?.id, v.role).toBe(CODE_ID);
    }
  });

  it('rests on the phone code: the push registration waits for the code', () => {
    const push = mobile('lib/use-push-notifications.ts');
    expect(push).toContain('async function owesAuthenticatorCode(userId: string)');
    expect(push).toContain('if (await owesAuthenticatorCode(user.id)) return;');
  });
});

describe('clearer words on the phone when your access cannot be checked (S26)', () => {
  const adjust = () => entry(ACCESS_ID, 'phone-adjustment-access-not-checked');
  const rental = () => entry(ACCESS_ID, 'phone-rental-checkout-access-not-checked');
  const escalate = () => entry(ACCESS_ID, 'phone-escalation-access-not-checked');

  it("uses the plan's words", () => {
    expect(byId(ACCESS_ID).title).toBe(
      'Clearer words on the phone when your access cannot be checked',
    );
    expect(byId(ACCESS_ID).summary).toBe(
      'If StockPilot cannot check your access for a moment, the phone app now says that a stock adjustment, a rental checkout or an escalation was not saved, and asks you to try again. An adjustment saved offline now waits and is sent later, instead of being moved to Unsent work.',
    );
    expect(adjust().whatChanged).toBe(
      'When StockPilot cannot check your access for a moment, a stock adjustment on the phone now says Adjustment not saved and that nothing was changed. An adjustment saved offline stays queued and is sent once the check works again.',
    );
    expect(adjust().whyItMatters).toBe(
      'Before, the app said the adjustment may or may not have been saved, and an adjustment saved offline was moved to Unsent work in Settings, to be entered again by hand.',
    );
    expect(adjust().howItAffectsYou).toBe(
      'This is rare. If you see Adjustment not saved, nothing was changed: try again after a moment.',
    );
    expect(rental().whatChanged).toBe(
      'A rental checkout refused for the same reason now says nothing was checked out and asks you to try again.',
    );
    expect(rental().whyItMatters).toBe(
      'Before, it said the checkout may or may not have happened and asked you to check the Rentals list first.',
    );
    expect(rental().howItAffectsYou).toBe(
      'Rarely, you may see Could not check out. Nothing was checked out: try again after a moment.',
    );
    expect(escalate().whatChanged).toBe(
      'Escalating an exception refused for the same reason now says nothing was saved and keeps your form so you can try again.',
    );
    expect(escalate().whyItMatters).toBe(
      'Before, it said it was not known whether the request was saved and asked you to check your maintenance requests first.',
    );
    expect(escalate().howItAffectsYou).toBe(
      'Rarely, you may see Could not escalate. Nothing was saved: try again after a moment.',
    );
    for (const e of byId(ACCESS_ID).entries) expect(e.whatToDo, e.id).toBe('No action needed.');
  });

  it('tells each entry to whoever the route checks, with no links', () => {
    expect(adjust().audience).toEqual({ anyPermission: ['stock:adjust'] });
    expect(rental().audience).toEqual({ anyPermission: ['rentals:create'], modules: ['rentals'] });
    expect(escalate().audience).toEqual({
      anyPermission: ['maintenance_requests:submit'],
      modules: ['maintenance_requests'],
    });
    for (const e of byId(ACCESS_ID).entries) expect(e.link, e.id).toBeUndefined();
    expect(entriesFor(ACCESS_ID, owner)).toEqual([
      'phone-adjustment-access-not-checked',
      'phone-rental-checkout-access-not-checked',
      'phone-escalation-access-not-checked',
    ]);
    expect(entriesFor(ACCESS_ID, member)).toEqual([]);
    expect(entriesFor(ACCESS_ID, viewer('staff', ['stock:adjust'], []))).toEqual([
      'phone-adjustment-access-not-checked',
    ]);
    expect(entriesFor(ACCESS_ID, viewer('staff', ['rentals:create'], []))).toEqual([]);
    expect(entriesFor(ACCESS_ID, viewer('staff', ['rentals:create'], ['rentals']))).toEqual([
      'phone-rental-checkout-access-not-checked',
    ]);
    expect(
      entriesFor(
        ACCESS_ID,
        viewer('staff', ['maintenance_requests:submit'], ['maintenance_requests']),
      ),
    ).toEqual(['phone-escalation-access-not-checked']);
  });

  it('rests on the words the phone shows', () => {
    expect(CONTEXT_UNAVAILABLE_COPY).toBe(
      'Your access could not be checked just now, so nothing was changed. Try again in a moment.',
    );
    const adjustLib = mobile('lib/item-adjust.ts');
    expect(adjustLib).toContain("title: 'Adjustment not saved',");
    expect(adjustLib).toContain('message: CONTEXT_UNAVAILABLE_COPY,');
    expect(mobile('lib/adjust-outbox.ts')).toContain(
      "if (isRefusedBeforeAnyWrite(err)) return 'refused-before-write';",
    );
    const rentalView = mobile('lib/rental-view.ts');
    expect(rentalView).toContain(
      "'Your access could not be checked just now, so nothing was checked out. Try again in a moment.'",
    );
    expect(rentalView).toContain(
      "return { title: 'Could not check out', message: RENTAL_CHECKOUT_ACCESS_NOT_CHECKED };",
    );
    const escalation = mobile('lib/exception-escalation.ts');
    expect(escalation).toContain(
      "'Your access could not be checked just now, so nothing was saved. Try again in a moment.'",
    );
    expect(escalation).toContain(
      'return { message: ESCALATE_ACCESS_NOT_CHECKED_COPY, duplicate: null, retryable: true };',
    );
    expect(mobileApp('maintenance/new.tsx')).toContain(
      "Alert.alert('Could not escalate', failure.message);",
    );
  });
});

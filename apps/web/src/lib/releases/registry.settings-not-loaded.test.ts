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

/**
 * Added by docs/whats-new-unreadable-access-and-settings (2026-11-15): the
 * settings release for #563 (squash 51ed64904, web only, no phone update, no
 * migration): a settings page or panel whose stored settings cannot be read
 * says so, with Try again, instead of a form of default values. Five entries,
 * one per page or panel, each told to whoever can open it.
 *
 * It is the newest published release and sits directly below the Liquid Glass
 * draft, above the module check release for #557
 * (module-check-try-again-2026-11, registry.module-check-try-again.test.ts).
 * Its own file, so the release tests other open branches edit stay as they
 * are.
 *
 * Re-pinned by docs/whats-new-navigation-keeps-choices (2026-11-15): the
 * navigation release is published later, directly above this release and
 * below the Liquid Glass draft. Each changed line has its own note.
 */
const ID = 'settings-not-loaded-2026-11';
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
const emptiedFieldsRead = {
  release_id: EMPTIED_FIELDS_ID,
  // Re-pinned by bundles/hand-out-follows-the-manager-rule (2026-11-16; was: revision 1): the emptied fields and schedule completion release is re-announced as revision 2, so a read of it is recorded at revision 2.
  revision: 2,
  dismissed_at: null,
  opened_at: '2026-11-16T12:35:00Z',
  read_at: '2026-11-16T12:35:00Z',
};
const MODULE_CHECK_ID = 'module-check-try-again-2026-11';
const COUNT_RELEASE_ID = 'count-read-rule-2026-11';
// Added by docs/whats-new-navigation-keeps-choices (2026-11-15): the navigation release (owners and admins who can open Settings, Navigation), published later, directly above this one.
const NAVIGATION_ID = 'navigation-keeps-choices-2026-11';
// Added by docs/whats-new-invitation-audit (2026-11-15): the invitation audit release (whoever can view the audit log), published later, directly above the navigation release.
// Added by docs/whats-new-api-key-audit (2026-11-15): the API key audit release (whoever can view the audit log), published later, directly above the invitation audit release.
const API_KEY_AUDIT_ID = 'api-key-audit-2026-11';
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
const navigationRead = {
  release_id: NAVIGATION_ID,
  revision: 1,
  dismissed_at: null,
  opened_at: '2026-11-15T05:00:00Z',
  read_at: '2026-11-15T05:00:00Z',
};

const ORGANIZATION = 'organization-settings-not-loaded';
const CLEANUP = 'inventory-cleanup-settings-not-loaded';
const MAINTENANCE = 'maintenance-settings-not-loaded';
const PLANNING = 'planning-settings-not-loaded';
const APPROVAL = 'approval-threshold-not-loaded';

const release = () => RELEASES.find((r) => r.id === ID)!;
const entry = (id: string) => release().entries.find((e) => e.id === id)!;

const viewer = (
  role: ReleaseViewer['role'],
  permissions: ReleaseViewer['permissions'],
  enabledModules: ReleaseViewer['enabledModules'],
): ReleaseViewer => ({ role, permissions, enabledModules });
const EVERY_MODULE = Object.keys(MODULE_REGISTRY) as ModuleId[];
const without = (...ids: ModuleId[]) => EVERY_MODULE.filter((m) => !ids.includes(m));
const owner = viewer('owner', [...PERMISSIONS], EVERY_MODULE);
const admin = viewer('admin', ROLE_PERMISSIONS.admin, EVERY_MODULE);
const manager = viewer('manager', ROLE_PERMISSIONS.manager, EVERY_MODULE);
const staff = viewer('staff', ROLE_PERMISSIONS.staff, EVERY_MODULE);
const defaultViewer = viewer('viewer', ROLE_PERMISSIONS.viewer, EVERY_MODULE);
const member = viewer('viewer', [], []);
const entriesFor = (v: ReleaseViewer) =>
  visibleReleases(RELEASES, v)
    .find((r) => r.id === ID)
    ?.entries.map((e) => e.id) ?? [];

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

const TRY_AGAIN = 'If you see this, press Try again after a moment.';

describe('the settings release: order, status and date', () => {
  // Renamed by docs/whats-new-navigation-keeps-choices (2026-11-15; was: "is published once, as revision 1, directly below the Liquid Glass draft and above the module check release"): the navigation release is published later, directly below the draft and above this one. Claim kept: published once, as revision 1, directly above the module check release.
  it('is published once, as revision 1, directly below the navigation release (published later, below the Liquid Glass draft at the top) and above the module check release', () => {
    expect(RELEASES.filter((r) => r.id === ID)).toHaveLength(1);
    expect(release().status).toBe('published');
    expect(release().revision).toBe(1);
    expect(release().withdrawnNote).toBeUndefined();
    // Re-pinned by docs/whats-new-navigation-keeps-choices (2026-11-15; was: RELEASES.slice(0, 4), without it): the navigation release is published later, at the top, directly below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-invitation-audit (2026-11-15; was: RELEASES.slice(0, 5), without it): the invitation audit release is published later, at the top, directly below the Liquid Glass draft.
    // Re-pinned by docs/whats-new-api-key-audit (2026-11-15; was: RELEASES.slice(0, 6), without it): the API key audit release is published later, at the top, directly below the Liquid Glass draft.
    // Re-pinned by docs/whats-new-authenticator-set-up-first (2026-11-15; was: every pinned position one place higher): the authenticator set-up release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-delete-account-confirm (2026-11-16; was: every pinned position one place higher): the delete account release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-integrations-message-and-api-key-rows (2026-11-16; was: every pinned position one place higher): the Integrations and schedule event release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-emptied-fields-and-schedule-completion (2026-11-16; was: RELEASES.slice(0, 10)): the emptied fields and schedule completion release is published at the top, below the Liquid Glass draft, so the list takes one more.
    expect(RELEASES.slice(0, 11).map((r) => [r.id, r.status])).toEqual([
      ['liquid-glass-2026-11', 'draft'],
      // Re-pinned by docs/whats-new-integrations-message-and-api-key-rows (2026-11-16; was: without it): the Integrations and schedule event release is published later, at the top, directly below the Liquid Glass draft.
      // Re-pinned by docs/whats-new-emptied-fields-and-schedule-completion (2026-11-16; was: without it): the emptied fields and schedule completion release is published later, at the top, directly below the Liquid Glass draft.
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
      [NAVIGATION_ID, 'published'],
      [ID, 'published'],
      [MODULE_CHECK_ID, 'published'],
      [COUNT_RELEASE_ID, 'published'],
    ]);
  });

  // Renamed by docs/whats-new-navigation-keeps-choices (2026-11-15; was: "is dated the whole minute after #563 went live, in the past, with the draft placeholder at the same minute and every release below it older"): the navigation release above is dated later, and the draft placeholder moved to its minute. Claim kept: the whole minute after #563 went live, in the past, every release below it older.
  it('is dated the whole minute after #563 went live, in the past, with the draft placeholder at or after it and every release below it older', () => {
    // #563 is live in production since 2026-11-15 04:12:00Z.
    expect(release().publishedAt).toBe('2026-11-15T04:13:00Z');
    const at = Date.parse(release().publishedAt);
    expect(at).toBeGreaterThan(Date.parse('2026-11-15T04:12:00Z'));
    expect(at).toBeLessThanOrEqual(Date.now());
    // Re-pinned by docs/whats-new-navigation-keeps-choices (2026-11-15; was: RELEASES[0]!.publishedAt toBe this minute): the draft placeholder moved to the minute of the navigation release, published later, directly above this one.
    expect(Date.parse(RELEASES[0]!.publishedAt)).toBeGreaterThanOrEqual(at);
    // Re-pinned by docs/whats-new-navigation-keeps-choices (2026-11-15; was: RELEASES.slice(2)): the navigation release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-invitation-audit (2026-11-15; was: every pinned position one place higher): the invitation audit release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-api-key-audit (2026-11-15; was: every pinned position one place higher): the API key audit release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-authenticator-set-up-first (2026-11-15; was: every pinned position one place higher): the authenticator set-up release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-delete-account-confirm (2026-11-16; was: every pinned position one place higher): the delete account release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-integrations-message-and-api-key-rows (2026-11-16; was: every pinned position one place higher): the Integrations and schedule event release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-emptied-fields-and-schedule-completion (2026-11-16; was: every pinned position one place higher): the emptied fields and schedule completion release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    for (const r of RELEASES.slice(9)) {
      expect(at, r.id).toBeGreaterThan(Date.parse(r.publishedAt));
    }
  });

  it('parses under the shared schema, in plain text, with its five entries', () => {
    expect(releaseSchema.safeParse(release()).success).toBe(true);
    for (const text of readerText(release())) expect(text).not.toMatch(/[<>]/);
    expect(release().entries.map((e) => [e.id, e.category, e.area])).toEqual([
      [ORGANIZATION, 'fixed', 'Settings'],
      [CLEANUP, 'fixed', 'Settings'],
      [MAINTENANCE, 'fixed', 'Settings'],
      [PLANNING, 'fixed', 'Reorder Planning'],
      [APPROVAL, 'fixed', 'Purchase orders'],
    ]);
    // Each entry is in this release only.
    for (const e of release().entries) {
      expect(
        RELEASES.filter((r) => r.entries.some((x) => x.id === e.id)).map((r) => r.id),
        e.id,
      ).toEqual([ID]);
    }
  });
});

describe('the settings release: the words', () => {
  it('has a title and a summary that stand on their own', () => {
    expect(release().title).toBe('Settings that could not be loaded now say so, with Try again');
    expect(release().summary).toBe(
      'If StockPilot cannot load your saved settings for a moment, the Organization, Inventory cleanup and Maintenance requests settings pages, the planning and automatic reordering settings on Reorder Planning, and the approval threshold on Purchase orders now say they could not be loaded and offer Try again, instead of showing a form filled with default values. Nothing changes while settings load normally, and no app update is needed.',
    );
  });

  it('Organization settings', () => {
    const e = entry(ORGANIZATION);
    expect(e.title).toBe('Organization settings say so when they could not be loaded');
    expect(e.whatChanged).toBe(
      "If Settings, Organization cannot load your saved settings, it now says We couldn't load this settings page, with Try again, instead of showing the name, time zone, labels and purchase order terms filled with default values.",
    );
    expect(e.whyItMatters).toBe(
      'Default values are not your saved settings, and saving them would have replaced what your organization had set.',
    );
    expect(e.howItAffectsYou).toBe(
      'This is rare and usually passes in a moment. Your saved settings are unchanged, and the other settings pages still work.',
    );
    expect(e.whatToDo).toBe(TRY_AGAIN);
  });

  it('Inventory cleanup', () => {
    const e = entry(CLEANUP);
    expect(e.title).toBe('Inventory cleanup says so when its settings could not be loaded');
    expect(e.whatChanged).toBe(
      "If Settings, Inventory cleanup cannot load your saved settings, it now says We couldn't load this settings page, with Try again, instead of showing automatic archiving and removal as off.",
    );
    expect(e.whyItMatters).toBe(
      'Off may not be what you saved, and saving a panel would have turned that automation off.',
    );
    expect(e.howItAffectsYou).toBe(
      'This is rare and usually passes in a moment. Your saved settings are unchanged, and the other settings pages still work.',
    );
    expect(e.whatToDo).toBe(TRY_AGAIN);
  });

  it('Maintenance requests settings', () => {
    const e = entry(MAINTENANCE);
    expect(e.title).toBe('Maintenance request settings say so when they could not be loaded');
    expect(e.whatChanged).toBe(
      "If Settings, Maintenance requests cannot load your saved settings or your organization's members, it now says We couldn't load this settings page, with Try again, instead of showing the categories, notification audiences and photo link settings filled with default values.",
    );
    expect(e.whyItMatters).toBe(
      'Default values are not your saved settings, and saving them would have replaced what your organization had set.',
    );
    expect(e.howItAffectsYou).toBe(
      'This is rare and usually passes in a moment. Your saved settings are unchanged, and the other settings pages still work.',
    );
    expect(e.whatToDo).toBe(TRY_AGAIN);
  });

  it('Reorder Planning', () => {
    const e = entry(PLANNING);
    expect(e.title).toBe(
      'Reorder Planning says so when its planning or automatic reordering settings could not be loaded',
    );
    expect(e.whatChanged).toBe(
      "On Reorder Planning, if the planning settings or the automatic reordering settings cannot be loaded, that panel now says We couldn't load the planning settings or We couldn't load the automatic reordering settings, with Try again, instead of showing default values.",
    );
    expect(e.whyItMatters).toBe(
      'Default values are not your saved settings, and saving that panel would have replaced them.',
    );
    expect(e.howItAffectsYou).toBe(
      'This is rare and usually passes in a moment. Your saved settings are unchanged. The reorder suggestions still show, and so does the other panel when its own settings load.',
    );
    expect(e.whatToDo).toBe(TRY_AGAIN);
  });

  it('Purchase orders, the approval threshold', () => {
    const e = entry(APPROVAL);
    expect(e.title).toBe('The approval threshold says so when it could not be loaded');
    expect(e.whatChanged).toBe(
      "On Purchase orders, if the approval threshold cannot be loaded, its panel now says We couldn't load the approval threshold, with Try again, instead of showing an empty amount.",
    );
    expect(e.whyItMatters).toBe(
      'An empty amount means approval is off, so saving the panel would have turned approval off.',
    );
    expect(e.howItAffectsYou).toBe(
      'This is rare and usually passes in a moment. Your saved threshold is unchanged, and the purchase order list still shows.',
    );
    expect(e.whatToDo).toBe(TRY_AGAIN);
  });

  it('keeps to what people see, in plain words', () => {
    const text = readerText(release()).join(' ');
    expect(text).not.toMatch(/\bbook(s|ed)?\b/i);
    expect(text).not.toMatch(/secur|vulnerab|exploit|leak|expos|attack|breach|unauthori/i);
    expect(text).not.toMatch(/[!\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
    // No links: each entry describes a rare state, not a place to go.
    for (const e of release().entries) expect(e.link, e.id).toBeUndefined();
  });
});

describe('the settings release: who is told', () => {
  it('has no release audience, and each entry names who can open its page or panel', () => {
    expect(release().audience).toBeUndefined();
    expect(entry(ORGANIZATION).audience).toEqual({ roles: ['owner', 'admin'] });
    expect(entry(CLEANUP).audience).toEqual({ anyPermission: ['items:update', 'items:delete'] });
    expect(entry(MAINTENANCE).audience).toEqual({
      anyPermission: ['maintenance_requests:configure'],
    });
    expect(entry(PLANNING).audience).toEqual({
      roles: ['owner', 'admin'],
      modules: ['planning'],
    });
    expect(entry(APPROVAL).audience).toEqual({
      roles: ['owner', 'admin'],
      modules: ['purchase_orders'],
    });
  });

  it('reaches each default role with the entries it can open', () => {
    expect(entriesFor(owner)).toEqual([ORGANIZATION, CLEANUP, MAINTENANCE, PLANNING, APPROVAL]);
    // An admin does not hold maintenance_requests:configure by default.
    expect(entriesFor(admin)).toEqual([ORGANIZATION, CLEANUP, PLANNING, APPROVAL]);
    expect(entriesFor(manager)).toEqual([CLEANUP]);
    expect(entriesFor(staff)).toEqual([CLEANUP]);
    expect(entriesFor(defaultViewer)).toEqual([]);
    expect(entriesFor(member)).toEqual([]);
    for (const v of [defaultViewer, member]) {
      expect(
        visibleReleases(RELEASES, v).map((r) => r.id),
        v.role,
      ).not.toContain(ID);
    }
  });

  it('leaves out the panels of a module that is off', () => {
    expect(entriesFor(viewer('admin', ROLE_PERMISSIONS.admin, without('planning')))).toEqual([
      ORGANIZATION,
      CLEANUP,
      APPROVAL,
    ]);
    expect(
      entriesFor(viewer('owner', [...PERMISSIONS], without('planning', 'purchase_orders'))),
    ).toEqual([ORGANIZATION, CLEANUP, MAINTENANCE]);
  });

  // Renamed by docs/whats-new-navigation-keeps-choices (2026-11-15; was: "is the first notice for the readers it reaches, and the module check release is next"): the navigation release is published later and reaches owners and admins, who read it first. Claim kept: the notice for the readers it reaches, and the module check release next.
  // Renamed by docs/whats-new-authenticator-set-up-first (2026-11-15; was: "is the notice for the readers it reaches once the navigation release is read, and the module check release is next"): the authenticator set-up release is published later and reaches every member, who read it first. Claim kept: the notice for the readers it reaches, and the module check release next.
  // Renamed by docs/whats-new-delete-account-confirm (2026-11-16; was: "is the notice for the readers it reaches once the authenticator set-up and navigation releases are read, and the module check release is next"): the delete account release is published later and reaches every member, who read it first. Claim kept: the notice for the readers it reaches, and the module check release next.
  it('is the notice for the readers it reaches once the delete account, authenticator set-up and navigation releases are read, and the module check release is next', () => {
    for (const v of [owner, admin, manager, staff]) {
      // Re-pinned by docs/whats-new-navigation-keeps-choices (2026-11-15; was: nothing read): the navigation release is published later, at the top, and reaches owners and admins, so each reader reads it first, and the notice this test checks is the one it checked before. A read of a release by a reader it does not reach changes nothing.
      // Re-pinned by docs/whats-new-invitation-audit (2026-11-15; was: without it): the invitation audit release is published later, at the top, and reaches whoever can view the audit log (owners, admins and managers by default), so it is read or seen with the newer releases, and every notice this test checks is the one it checked before. A read of a release by a reader it does not reach changes nothing.
      expect(
        // Re-pinned by docs/whats-new-api-key-audit (2026-11-15; was: without it): the API key audit release is published later, at the top, and reaches the same readers as the invitation audit release, so it is read or seen with it, and the notice this test checks is the one it checked before.
        // Re-pinned by docs/whats-new-authenticator-set-up-first (2026-11-15; was: without it): the authenticator set-up release is published later, at the top, and reaches every member, so it is read or seen first, and the notice this test checks is the one it checked before.
        // Re-pinned by docs/whats-new-delete-account-confirm (2026-11-16; was: without it): the delete account release is published later, at the top, and reaches every member, so it is read or seen first, and the notice this test checks is the one it checked before.
        buildReleaseList(
          RELEASES,
          v,
          // Re-pinned by docs/whats-new-integrations-message-and-api-key-rows (2026-11-16; was: without it): the Integrations and schedule event release is published later, at the top, and reaches whoever can manage integrations or schedule events with those modules on (owners and admins, and managers for its schedule entry, by default), so it is read or seen with the newer releases, and every notice this test checks is the one it checked before. A read of a release by a reader it does not reach changes nothing.
          // Re-pinned by docs/whats-new-emptied-fields-and-schedule-completion (2026-11-16; was: without it): the emptied fields and schedule completion release is published later, at the top, and reaches whoever can manage the schedule or suppliers with those modules on, or the organization, locations or categories (owners and admins, and managers for all but its charter and warehouse entry, by default), an owner with every permission included, so it is read, seen or listed with the newer releases, and every notice this test checks is the one it checked before.
          [emptiedFieldsRead, connectionScheduleRead, deleteConfirmRead, authSetUpRead, apiKeyAuditRead, invitationAuditRead, navigationRead],
          null,
        ).latestUnread?.id,
        v.role,
      ).toBe(ID);
      const read = {
        release_id: ID,
        revision: 1,
        dismissed_at: null,
        opened_at: '2026-11-15T04:30:00Z',
        read_at: '2026-11-15T04:30:00Z',
      };
      // Re-pinned by docs/whats-new-navigation-keeps-choices (2026-11-15; was: [read]): the navigation release is read too, as above.
      expect(
        // Re-pinned by docs/whats-new-invitation-audit (2026-11-15; was: without it): the invitation audit release is published later, at the top, and reaches whoever can view the audit log (owners, admins and managers by default), so it is read or seen with the newer releases, and every notice this test checks is the one it checked before. A read of a release by a reader it does not reach changes nothing.
        // Re-pinned by docs/whats-new-api-key-audit (2026-11-15; was: without it): the API key audit release is published later, at the top, and reaches the same readers as the invitation audit release, so it is read or seen with it, and the notice this test checks is the one it checked before.
        buildReleaseList(
          RELEASES,
          v,
          // Re-pinned by docs/whats-new-authenticator-set-up-first (2026-11-15; was: without it): the authenticator set-up release is published later, at the top, and reaches every member, so it is read first, and the notice this test checks is the one it checked before.
          // Re-pinned by docs/whats-new-delete-account-confirm (2026-11-16; was: without it): the delete account release is published later, at the top, and reaches every member, so it is read first, and the notice this test checks is the one it checked before.
          // Re-pinned by docs/whats-new-integrations-message-and-api-key-rows (2026-11-16; was: without it): the Integrations and schedule event release is published later, at the top, and reaches whoever can manage integrations or schedule events with those modules on (owners and admins, and managers for its schedule entry, by default), so it is read or seen with the newer releases, and every notice this test checks is the one it checked before. A read of a release by a reader it does not reach changes nothing.
          // Re-pinned by docs/whats-new-emptied-fields-and-schedule-completion (2026-11-16; was: without it): the emptied fields and schedule completion release is published later, at the top, and reaches whoever can manage the schedule or suppliers with those modules on, or the organization, locations or categories (owners and admins, and managers for all but its charter and warehouse entry, by default), an owner with every permission included, so it is read, seen or listed with the newer releases, and every notice this test checks is the one it checked before.
          [emptiedFieldsRead, connectionScheduleRead, deleteConfirmRead, authSetUpRead, apiKeyAuditRead, invitationAuditRead, navigationRead, read],
          null,
        ).latestUnread?.id,
        v.role,
      ).toBe(MODULE_CHECK_ID);
    }
    // An older phone build shows the newest one it has not seen: this title and summary.
    // Re-pinned by docs/whats-new-authenticator-set-up-first (2026-11-15; was: without it): the authenticator set-up release is published later, at the top, and reaches every member, so it is read or seen first, and the notice this test checks is the one it checked before.
    // Re-pinned by docs/whats-new-delete-account-confirm (2026-11-16; was: without it): the delete account release is published later, at the top, and reaches every member, so it is read or seen first, and the notice this test checks is the one it checked before.
    expect(legacyAnnouncementsFor(RELEASES, staff, { [DELETE_CONFIRM_ID]: true, [AUTH_SET_UP_ID]: true })[0]).toEqual({
      id: ID,
      date: '2026-11-15',
      title: release().title,
      body: release().summary,
    });
  });
});

describe('the settings release: the code the words rest on', () => {
  it("the failed state says We couldn't load this settings page, with Try again", () => {
    const state = source('components/settings/settings-read-failed.tsx');
    expect(state).toContain('title = "We couldn\'t load this settings page"');
    expect(state).toContain('The other settings pages still work.');
    expect(state).toContain('action={<TryAgainButton size="sm" />}');
  });

  it('Settings, Organization: owners and admins, the failed state in place of the editor', () => {
    const page = source('app/(dashboard)/dashboard/settings/organization/page.tsx');
    expect(page).toContain("if (ctx.role !== 'owner' && ctx.role !== 'admin') {");
    expect(page).toContain('<SettingsReadFailed />');
    for (const title of [
      'title="Name"',
      'title="Timezone"',
      'title="Labels"',
      'title="Purchase order terms"',
    ]) {
      expect(page, title).toContain(title);
    }
  });

  it('Settings, Inventory cleanup: items:update or items:delete, the failed state in place of both panels', () => {
    const page = source('app/(dashboard)/dashboard/settings/inventory-cleanup/page.tsx');
    expect(page).toContain("const canDelete = can(ctx, 'items:delete');");
    expect(page).toContain("const canUpdate = can(ctx, 'items:update');");
    expect(page).toContain("if (!canDelete && !canUpdate) redirect('/dashboard/settings');");
    expect(page).toContain('title="Inventory cleanup"');
    expect(page).toContain('<SettingsReadFailed />');
  });

  it('Settings, Maintenance requests: maintenance_requests:configure, the settings or the member list', () => {
    const page = source('app/(dashboard)/dashboard/settings/maintenance/page.tsx');
    expect(page).toContain("if (!can(ctx, 'maintenance_requests:configure')) {");
    expect(page).toContain('const readError = modError ?? membersError;');
    expect(page).toContain('title="Maintenance requests"');
    expect(page).toContain(
      'subline="Categories, notification audiences, and photo link settings."',
    );
    expect(page).toContain('<SettingsReadFailed />');
  });

  it('Reorder Planning: the two panels, for owners and admins, each replaced on its own', () => {
    const page = source('app/(dashboard)/dashboard/planning/page.tsx');
    expect(page).toContain("const moduleAccess = await checkModuleAccess('planning');");
    expect(page).toContain('title="Reorder Planning"');
    expect(page).toContain('{moduleAccess.canManage && (');
    expect(page).toContain('title="We couldn\'t load the planning settings"');
    expect(page).toContain('title="We couldn\'t load the automatic reordering settings"');
    expect(source('lib/modules/module-gate.ts')).toContain(
      "const canManage = ctx.role === 'owner' || ctx.role === 'admin';",
    );
  });

  it('Purchase orders: the approval threshold panel, for owners and admins', () => {
    const page = source('app/(dashboard)/dashboard/purchase-orders/page.tsx');
    expect(page).toContain("const moduleAccess = await checkModuleAccess('purchase_orders');");
    expect(page).toContain("const isAdmin = orgCtx.role === 'owner' || orgCtx.role === 'admin';");
    expect(page).toContain('title="We couldn\'t load the approval threshold"');
  });
});

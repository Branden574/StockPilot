import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  MODULE_REGISTRY,
  ORDER_WAREHOUSE_ACCESS_UNREADABLE_COPY,
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
 * Added by docs/whats-new-2026-11-19-errors (2026-11-19): the What's New for
 * #624, live on the web since 2026-11-19 20:24Z. One entry: starting a count
 * in the mobile app, when the member's warehouse access could not be read,
 * now says it could not be checked and to try again, where it said the
 * member had no access to a warehouse named by its id. Published at the top,
 * below the Liquid Glass draft and above the export, receipt and access
 * release; the draft placeholder takes the same minute.
 *
 * Left out, each checked against the code: connecting Zendesk and the other
 * refusals of starting a count already sent their own words (only the status
 * changed), and the phone's Cycle counts list already kept the counts saved
 * on the phone for a failed read, which #624 still answers the same way.
 */
const ID = 'count-start-access-check-2026-11';
const ENTRY = 'count-start-access-could-not-be-checked';
const EXPORT_RECEIPT_ACCESS_ID = 'export-receipt-access-fixes-2026-11';
// Added by docs/whats-new-2026-11-21-phone (2026-11-21): the phone authenticator set-up release (every member: three of its five entries have no audience), published later, at the top, below the Liquid Glass draft.
// Added by docs/whats-new-blocked-activity (2026-11-21): the Blocked activity release (owners and Super Admins), published later, at the top, below the Liquid Glass draft.
const BLOCKED_ID = 'blocked-activity-2026-11';
const BLOCKED_CURRENT_ID = 'blocked-activity-current-password-and-set-up-code-2026-11';
const SIGNIN_ID = 'sign-in-alerts-2026-11';
const PHONE_LARGE_ID = 'phone-large-text-2026-11';
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
const PHONE_SET_UP_ID = 'phone-authenticator-set-up-2026-11';
// Re-pinned by docs/whats-new-blocked-activity (2026-11-21; was: PHONE_SET_UP_AT = '2026-11-21T02:31:00Z'): the Liquid Glass draft placeholder is now the minute of the Blocked activity release, published later, above the phone authenticator set-up release.
// Re-pinned by docs/whats-new-sign-in-alerts-and-reader (2026-11-22; was: BLOCKED_AT = '2026-11-21T18:19:00Z'): the Liquid Glass draft placeholder is now the minute of the Blocked activity current password and set-up code release, published later, above the Blocked activity release.
// Re-pinned by docs/whats-new-sign-in-alerts-and-reader (2026-11-22; was: BLOCKED_CURRENT_AT = '2026-11-22T05:42:00Z'): the Liquid Glass draft placeholder is now the minute of the sign-in alerts release, published later, above the Blocked activity current password and set-up code release.
// Re-pinned by docs/whats-new-phone-large-text (2026-11-23; was: SIGNIN_AT = '2026-11-22T06:08:00Z'): the Liquid Glass draft placeholder is now the minute of the phone large text release, published later, above this one.
const PHONE_LARGE_AT = '2026-11-23T06:00:00Z';
const phoneSetUpRead = {
  release_id: PHONE_SET_UP_ID,
  revision: 1,
  dismissed_at: null,
  opened_at: '2026-11-21T02:32:00Z',
  read_at: '2026-11-21T02:32:00Z',
};
/** #624's production deployment went live at this instant. */
const LIVE_624 = '2026-11-19T20:24:00Z';
/** The words the reader is quoted, as the code has them. */
const UNREADABLE =
  "Your warehouse access couldn't be checked just now, so nothing was changed. Try again.";
const ALERT_TITLE = 'Could not start count';

const release = () => RELEASES.find((r) => r.id === ID)!;
const entry = () => release().entries.find((e) => e.id === ENTRY)!;

const ALL_MODULES = Object.keys(MODULE_REGISTRY) as ModuleId[];
const viewer = (
  role: ReleaseViewer['role'],
  permissions: ReleaseViewer['permissions'],
  enabledModules: ReleaseViewer['enabledModules'] = ['cycle_counts'],
): ReleaseViewer => ({ role, permissions, enabledModules });
const owner = viewer('owner', [...PERMISSIONS], ALL_MODULES);
const admin = viewer('admin', ROLE_PERMISSIONS.admin);
const manager = viewer('manager', ROLE_PERMISSIONS.manager);
const staff = viewer('staff', ROLE_PERMISSIONS.staff);
const member = viewer('viewer', ROLE_PERMISSIONS.viewer);
const managerCountsOff = viewer('manager', ROLE_PERMISSIONS.manager, []);
const managerNoAssign = viewer(
  'manager',
  ROLE_PERMISSIONS.manager.filter((p) => p !== 'cycle_counts:assign'),
);
const staffWithAssign = viewer('staff', [...ROLE_PERMISSIONS.staff, 'cycle_counts:assign']);
const shownEntries = (v: ReleaseViewer) =>
  visibleReleases(RELEASES, v)
    .find((r) => r.id === ID)
    ?.entries.map((e) => e.id);

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

describe('the count start access check release: order, status and date', () => {
  // Renamed by docs/whats-new-2026-11-21-phone (2026-11-21; was: "directly below the Liquid Glass draft and above the export, receipt and access release, the newest published release"): the phone authenticator set-up release is published later, at the top, directly below the Liquid Glass draft.
  it('is published once, as revision 1, directly below the phone authenticator set-up release (published later, below the Liquid Glass draft at the top) and above the export, receipt and access release', () => {
    expect(RELEASES.filter((r) => r.id === ID)).toHaveLength(1);
    expect(release().status).toBe('published');
    expect(release().revision).toBe(1);
    expect(release().withdrawnNote).toBeUndefined();
    // Re-pinned by docs/whats-new-2026-11-21-phone (2026-11-21; was: RELEASES.slice(0, 4)): the phone authenticator set-up release is published at the top, below the Liquid Glass draft, so the list takes one more.
    // Re-pinned by docs/whats-new-blocked-activity (2026-11-21; was: RELEASES.slice(0, 5)): the Blocked activity release is published at the top, below the Liquid Glass draft, so the list takes one more.
    expect(RELEASES.slice(0, 8).map((r) => [r.id, r.status])).toEqual([
      ['liquid-glass-2026-11', 'draft'],
      // Re-pinned by docs/whats-new-2026-11-21-phone (2026-11-21; was: without it): the phone authenticator set-up release is published later, at the top, directly below the Liquid Glass draft.
      // Re-pinned by docs/whats-new-blocked-activity (2026-11-21; was: without it): the Blocked activity release is published later, at the top, directly below the Liquid Glass draft.
      [PHONE_LARGE_ID, 'published'],
      [SIGNIN_ID, 'published'],
      [BLOCKED_CURRENT_ID, 'published'],
      [BLOCKED_ID, 'published'],
      [PHONE_SET_UP_ID, 'published'],
      [ID, 'published'],
      [EXPORT_RECEIPT_ACCESS_ID, 'published'],
    ]);
    // Re-pinned by docs/whats-new-2026-11-21-phone (2026-11-21; was: ID): the phone authenticator set-up release is published after it, at the top, the newest published release.
    // Re-pinned by docs/whats-new-blocked-activity (2026-11-21; was: PHONE_SET_UP_ID): the Blocked activity release is published after it, at the top, the newest published release.
    expect(RELEASES.find((r) => r.status === 'published')?.id).toBe(PHONE_LARGE_ID);
  });

  // Renamed by docs/whats-new-2026-11-21-phone (2026-11-21; was: "with the draft placeholder at the same minute"): the placeholder moved to the minute of the phone authenticator set-up release, published later, above this one.
  it('is dated on a whole minute, in the past, at or after #624 went live, with the draft placeholder at or after it and every release below it older', () => {
    const at = Date.parse(release().publishedAt);
    expect(release().publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/);
    expect(at).toBeGreaterThanOrEqual(Date.parse(LIVE_624));
    expect(at).toBeLessThanOrEqual(Date.now());
    // Re-pinned by docs/whats-new-2026-11-21-phone (2026-11-21; was: RELEASES[0].publishedAt equal to this release's): the placeholder is the minute of the phone authenticator set-up release, published later, above this one.
    // Re-pinned by docs/whats-new-blocked-activity (2026-11-21; was: PHONE_SET_UP_AT): the placeholder is the minute of the Blocked activity release, published later, above this one.
    // Re-pinned by docs/whats-new-phone-large-text (2026-11-23; was: SIGNIN_AT): the placeholder is the minute of the phone large text release, published later, above this one.
    expect(RELEASES[0]!.publishedAt).toBe(PHONE_LARGE_AT);
    expect(Date.parse(RELEASES[0]!.publishedAt)).toBeGreaterThanOrEqual(at);
    // Re-pinned by docs/whats-new-2026-11-21-phone (2026-11-21; was: RELEASES.slice(2)): the phone authenticator set-up release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-blocked-activity (2026-11-21; was: RELEASES.slice(3)): the Blocked activity release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-phone-large-text (2026-11-23; was: RELEASES.slice(6)): the phone large text release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    for (const r of RELEASES.slice(7)) {
      expect(at, r.id).toBeGreaterThan(Date.parse(r.publishedAt));
    }
  });

  it('parses under the shared schema, in plain text, with its one entry', () => {
    expect(releaseSchema.safeParse(release()).success).toBe(true);
    for (const text of readerText(release())) expect(text).not.toMatch(/[<>!]/);
    expect(release().entries.map((e) => [e.id, e.category, e.area])).toEqual([
      [ENTRY, 'fixed', 'Cycle counts'],
    ]);
    expect(RELEASES.filter((r) => r.entries.some((x) => x.id === ENTRY)).map((r) => r.id)).toEqual([
      ID,
    ]);
  });

  it('has no entry for connecting Zendesk or for the Cycle counts list, whose words nobody sees change', () => {
    const words = readerText(release()).join(' ');
    expect(words).not.toMatch(/zendesk/i);
    expect(words).not.toMatch(/counts saved|saved on (this|the|your) phone|downloaded/i);
  });
});

describe('the count start access check release: the words', () => {
  it('has the title, summary and entry as written', () => {
    expect(release().title).toBe(
      "Starting a count in the mobile app says when your access couldn't be checked",
    );
    expect(release().summary).toBe(
      'In the mobile app, when StockPilot can\'t check your warehouse access for a moment as you start a count, the app now says "Your warehouse access couldn\'t be checked just now, so nothing was changed. Try again." It used to say you do not have access to the warehouse, and named it by a long code. No app update is needed.',
    );
    expect(entry().title).toBe("Starting a count says when your access couldn't be checked");
    expect(entry().whatChanged).toBe(
      'In the mobile app, when StockPilot can\'t check your warehouse access for a moment as you start a count, the "Could not start count" message now says "Your warehouse access couldn\'t be checked just now, so nothing was changed. Try again."',
    );
    expect(entry().whyItMatters).toBe(
      'Before, the message said you do not have access to the warehouse and named it by a long code, even when you do have access and only the check had failed.',
    );
    expect(entry().howItAffectsYou).toBe(
      'This is usually temporary. Press Start count again a moment later. Nothing changes when the check works.',
    );
    expect(entry().whatToDo).toBe(
      'No action needed. No app update is needed. If the message stays, try again later or tell your admin.',
    );
  });

  it('quotes the sentences people see', () => {
    expect(release().summary).toContain(`"${UNREADABLE}"`);
    expect(entry().whatChanged).toContain(`"${UNREADABLE}"`);
    expect(entry().whatChanged).toContain(`"${ALERT_TITLE}"`);
  });

  it('keeps to the wording rules: no emoji, no exclamation mark, no "book", no internal names, and no link', () => {
    for (const text of readerText(release())) {
      expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
      expect(text).not.toMatch(/book/i);
      expect(text).not.toMatch(
        /\b[SB]\d{1,3}\b|docket|migration|database|\b04\d\d\b|Claude|\bAI\b/i,
      );
      expect(text).not.toMatch(
        /cycle_counts:assign|stock:adjust|ServiceError|ForbiddenError|check_failed|serviceErrorResponse|\b40[13]\b|\b50[03]\b/,
      );
    }
    expect(entry().link).toBeUndefined();
  });
});

describe('the count start access check release: who is told', () => {
  it('names a manager or above who can assign counts where Cycle Counts is on, on the entry, and nothing on the release', () => {
    expect(release().audience).toBeUndefined();
    expect(entry().audience).toEqual({
      roles: ['owner', 'admin', 'manager'],
      anyPermission: ['cycle_counts:assign'],
      modules: ['cycle_counts'],
    });
  });

  it('tells owners, admins and managers who can assign counts where Cycle Counts is on, and nobody else', () => {
    expect(shownEntries(owner)).toEqual([ENTRY]);
    expect(shownEntries(admin)).toEqual([ENTRY]);
    expect(shownEntries(manager)).toEqual([ENTRY]);
    expect(shownEntries(staff)).toBeUndefined();
    expect(shownEntries(member)).toBeUndefined();
    expect(shownEntries(staffWithAssign)).toBeUndefined();
    expect(shownEntries(managerCountsOff)).toBeUndefined();
    expect(shownEntries(managerNoAssign)).toBeUndefined();
  });

  // Renamed by docs/whats-new-2026-11-21-phone (2026-11-21; was: "is the first notice for whoever it reaches"): the phone authenticator set-up release, published later, reaches every member and is the first notice.
  it('is the first notice for whoever it reaches once the phone authenticator set-up release is read, the export, receipt and access release is next, a reader it does not reach keeps that one, and an old phone build lists it first for whoever it reaches once that release is seen', () => {
    const read = {
      release_id: ID,
      revision: 1,
      dismissed_at: null,
      opened_at: '2026-11-19T21:00:00Z',
      read_at: '2026-11-19T21:00:00Z',
    };
    for (const v of [owner, admin, manager]) {
      // Re-pinned by docs/whats-new-2026-11-21-phone (2026-11-21; was: without it): the phone authenticator set-up release is published later, at the top, and reaches every member (three of its five entries have no audience), so it is read or seen first, and every notice this test checks is the one it checked before.
      // Re-pinned by docs/whats-new-blocked-activity (2026-11-21; was: PHONE_SET_UP_ID for all three): the Blocked activity release is published later, at the top, and its audience is the owner and admin roles, so it is the first notice for those two; the manager it does not reach is told the phone authenticator set-up release first, as before.
      // Added by docs/whats-new-sign-in-alerts-and-reader (2026-11-22): the sign-in alerts release is published later, at the top; its first entry has no audience, so it is every member's first notice, and the checks below start with it read.
      expect(buildReleaseList(RELEASES, v, [], null).latestUnread?.id, v.role).toBe(PHONE_LARGE_ID);
      expect(buildReleaseList(RELEASES, v, [phoneLargeRead, signInRead], null).latestUnread?.id, v.role).toBe(
        v === manager ? PHONE_SET_UP_ID : BLOCKED_CURRENT_ID,
      );
      expect(buildReleaseList(RELEASES, v, [phoneLargeRead, signInRead, blockedCurrentRead, blockedRead], null).latestUnread?.id, v.role).toBe(
        PHONE_SET_UP_ID,
      );
      // Re-pinned by docs/whats-new-blocked-activity (2026-11-21; was: without it): the Blocked activity release is published later, at the top, and reaches owners and Super Admins (their roles are its audience), so it is read, seen or listed with the newer releases for them, and every notice this test checks is the one it checked before. A read of a release by a reader it does not reach changes nothing.
      expect(buildReleaseList(RELEASES, v, [phoneLargeRead, signInRead, blockedCurrentRead, blockedRead, phoneSetUpRead], null).latestUnread?.id, v.role).toBe(
        ID,
      );
      expect(
        // Re-pinned by docs/whats-new-blocked-activity (2026-11-21; was: without it): the Blocked activity release is published later, at the top, and reaches owners and Super Admins (their roles are its audience), so it is read, seen or listed with the newer releases for them, and every notice this test checks is the one it checked before. A read of a release by a reader it does not reach changes nothing.
        buildReleaseList(RELEASES, v, [phoneLargeRead, signInRead, blockedCurrentRead, blockedRead, phoneSetUpRead, read], null).latestUnread?.id,
        v.role,
      ).toBe(EXPORT_RECEIPT_ACCESS_ID);
      // Re-pinned by docs/whats-new-blocked-activity (2026-11-21; was: without it): the Blocked activity release is published later, at the top, and reaches owners and Super Admins (their roles are its audience), so it is read, seen or listed with the newer releases for them, and every notice this test checks is the one it checked before. A read of a release by a reader it does not reach changes nothing.
      expect(legacyAnnouncementsFor(RELEASES, v, { [PHONE_LARGE_ID]: true, [SIGNIN_ID]: true, [BLOCKED_CURRENT_ID]: true, [BLOCKED_ID]: true, [PHONE_SET_UP_ID]: true })[0], v.role).toEqual({
        id: ID,
        date: release().publishedAt.slice(0, 10),
        title: release().title,
        body: release().summary,
      });
    }
    for (const v of [staff, member, managerCountsOff, managerNoAssign, staffWithAssign]) {
      // Re-pinned by docs/whats-new-2026-11-21-phone (2026-11-21; was: without it): the phone authenticator set-up release is published later, at the top, and reaches every member (three of its five entries have no audience), so it is read or seen first, and every notice this test checks is the one it checked before.
      // Added by docs/whats-new-sign-in-alerts-and-reader (2026-11-22): the sign-in alerts release is published later, at the top; its first entry has no audience, so it is every member's first notice, and the checks below start with it read.
      expect(buildReleaseList(RELEASES, v, [], null).latestUnread?.id, v.role).toBe(PHONE_LARGE_ID);
      expect(buildReleaseList(RELEASES, v, [phoneLargeRead, signInRead], null).latestUnread?.id, v.role).toBe(
        PHONE_SET_UP_ID,
      );
      // Re-pinned by docs/whats-new-blocked-activity (2026-11-21; was: without it): the Blocked activity release is published later, at the top, and reaches owners and Super Admins (their roles are its audience), so it is read, seen or listed with the newer releases for them, and every notice this test checks is the one it checked before. A read of a release by a reader it does not reach changes nothing.
      expect(buildReleaseList(RELEASES, v, [phoneLargeRead, signInRead, blockedCurrentRead, blockedRead, phoneSetUpRead], null).latestUnread?.id, v.role).toBe(
        EXPORT_RECEIPT_ACCESS_ID,
      );
      // Re-pinned by docs/whats-new-blocked-activity (2026-11-21; was: without it): the Blocked activity release is published later, at the top, and reaches owners and Super Admins (their roles are its audience), so it is read, seen or listed with the newer releases for them, and every notice this test checks is the one it checked before. A read of a release by a reader it does not reach changes nothing.
      expect(legacyAnnouncementsFor(RELEASES, v, { [PHONE_LARGE_ID]: true, [SIGNIN_ID]: true, [BLOCKED_CURRENT_ID]: true, [BLOCKED_ID]: true, [PHONE_SET_UP_ID]: true })[0]?.id, v.role).toBe(
        EXPORT_RECEIPT_ACCESS_ID,
      );
    }
  });
});

describe('the count start access check release: the code the words rest on', () => {
  it('the phone starts a count through POST /api/v1/cycle-counts and shows the answer in the alert, whatever its status', () => {
    const screen = source('apps/mobile/app/cycle-count/new.tsx');
    expect(screen).toContain("await api<StartResult>('/api/v1/cycle-counts', {");
    expect(screen).toContain(`Alert.alert('${ALERT_TITLE}', countStartFailureMessage(e));`);
    const failure = source('apps/mobile/src/lib/count-select-offers.ts');
    expect(failure).toContain(
      "if (status === 403 && e.message.startsWith('Missing permission:')) {",
    );
    expect(failure).toContain('return e.message;');
    expect(source('apps/mobile/src/lib/api.ts')).toContain('let message = body.message ?? code;');
  });

  it('a count start asks the warehouse check for each picked warehouse, and that check says when the access could not be read', () => {
    expect(source('apps/web/src/server/services/cycle-counts.ts')).toContain(
      'const gate = await gateCountItems(this.ctx, ids);',
    );
    expect(source('apps/web/src/server/services/lib/count-start-preflight.ts')).toContain(
      "await assertWarehouseAccess(wh, 'write', ctx);",
    );
    const warehouse = source('apps/web/src/lib/auth/warehouse.ts');
    expect(warehouse).toContain("accessUnreadable: inOrg === 'unreadable',");
    expect(warehouse).toContain('accessUnreadable: access.unreadable === true,');
  });

  it('the count start route answers that refusal 503 with the quoted sentence, and no longer by hand as a 403', () => {
    const route = source('apps/web/src/app/api/v1/cycle-counts/route.ts');
    expect(route).toContain("return serviceErrorResponse(e, 'api.v1.cycle_counts.create');");
    expect(route).not.toContain('ForbiddenError');
    expect(source('apps/web/src/server/lib/service-error-response.ts')).toContain(
      'return forbiddenOrInternalResponse(e, tag, opts);',
    );
    const answer = source('apps/web/src/server/lib/api-error-response.ts');
    expect(answer).toContain('if (e.accessUnreadable) {');
    expect(answer).toContain(
      "{ error: 'check_failed', message: ORDER_WAREHOUSE_ACCESS_UNREADABLE_COPY },",
    );
    expect(answer).toContain("{ status: 503, headers: { 'Retry-After': '5' } },");
    expect(ORDER_WAREHOUSE_ACCESS_UNREADABLE_COPY).toBe(UNREADABLE);
  });

  it('what was left out: Zendesk on the phone shows the answer whatever its status, and the count list reads a failed access check as a fault it already kept saved counts for', () => {
    expect(source('apps/mobile/app/(drawer)/zendesk.tsx')).toContain(
      "Alert.alert('Could not connect', e instanceof Error ? e.message : String(e));",
    );
    expect(source('apps/web/src/server/services/lib/count-read-scope.ts')).toContain(
      "'internal_error',",
    );
    const list = source('apps/mobile/app/(drawer)/(tabs)/cycle-counts.tsx');
    expect(list).toContain('e.status === 403 &&');
    expect(list).toContain("(e.code === 'forbidden' || e.code === 'module_disabled')");
  });
});

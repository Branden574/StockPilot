import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ORDER_WAREHOUSE_ACCESS_UNREADABLE_COPY,
  PERMISSIONS,
  releaseSchema,
  ROLE_PERMISSIONS,
  type ModuleId,
  type Release,
  type ReleaseViewer,
} from '@stockpilot/core';

import { AUTHENTICATOR_SET_UP_PAGE } from '@/lib/auth/authenticator-set-up';

import { buildReleaseList, legacyAnnouncementsFor, visibleReleases } from './logic';
import { RELEASES } from './registry';

/**
 * Added by docs/whats-new-integrations-message-and-api-key-rows (2026-11-16):
 * the What's New for #591 (squash 7bbbbd33f, live in production since
 * 2026-11-16 09:38:20Z) and #590 (squash 30e1b4c06, live since 09:11:17Z),
 * published at the top, below the Liquid Glass draft and above the delete
 * account release. Web only: no phone update and no migration. Its own file,
 * so the release tests other open branches edit stay as they are.
 */
const ID = 'connection-and-schedule-messages-2026-11';
const CONNECTION_ENTRY = 'accounting-connection-not-finished';
const SCHEDULE_ENTRY = 'schedule-event-access-not-checked';
const DELETE_CONFIRM_ID = 'delete-account-confirm-2026-11';
// Added by docs/whats-new-emptied-fields-and-schedule-completion (2026-11-16): the emptied fields and schedule completion release, published later, at the top, below the Liquid Glass draft and above this one.
const EMPTIED_FIELDS_ID = 'emptied-fields-and-schedule-completion-2026-11';
const AUTH_SET_UP_ID = 'authenticator-set-up-first-2026-11';
// Added by docs/releases-low-critical-pages (2026-11-18): the Low + critical pages and list value release (whoever can read items: every role by default), published later, at the top, below the Liquid Glass draft.
const LOW_CRITICAL_ID = 'low-critical-pages-and-list-value-2026-11';
const lowCriticalRead = {
  release_id: LOW_CRITICAL_ID,
  revision: 1,
  dismissed_at: null,
  opened_at: '2026-11-18T10:01:00Z',
  read_at: '2026-11-18T10:01:00Z',
};
const PUBLISHED_AT = '2026-11-16T09:39:00Z';
const LIVE_591 = '2026-11-16T09:38:20Z';
const LIVE_590 = '2026-11-16T09:11:17Z';
const LINK = { href: '/dashboard/settings/integrations', label: 'Open Integrations' };

const release = () => RELEASES.find((r) => r.id === ID)!;
const entry = (id: string) => release().entries.find((e) => e.id === id)!;

const viewer = (
  role: ReleaseViewer['role'],
  permissions: ReleaseViewer['permissions'],
  enabledModules: ModuleId[] = [],
): ReleaseViewer => ({ role, permissions, enabledModules });
const both: ModuleId[] = ['integrations', 'schedule'];
const owner = viewer('owner', [...PERMISSIONS], both);
const admin = viewer('admin', ROLE_PERMISSIONS.admin, both);
const member = viewer('viewer', [], both);
const integrationsOnly = viewer('viewer', ['integrations:manage'], ['integrations']);
const scheduleOnly = viewer('viewer', ['schedule:manage'], ['schedule']);
const shown = (v: ReleaseViewer) => visibleReleases(RELEASES, v).find((r) => r.id === ID);

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

describe('the Integrations and schedule event release: order, status and date', () => {
  // Renamed by docs/whats-new-emptied-fields-and-schedule-completion (2026-11-16; was: "is published once, as revision 1, directly below the Liquid Glass draft and above the delete account release, the newest published release"): the emptied fields and schedule completion release is published later, directly below the draft and above this one. Claim kept: published once, as revision 1, directly above the delete account release.
  it('is published once, as revision 1, directly below the emptied fields and schedule completion release (published later, below the Liquid Glass draft at the top) and above the delete account release', () => {
    expect(RELEASES.filter((r) => r.id === ID)).toHaveLength(1);
    expect(release().status).toBe('published');
    expect(release().revision).toBe(1);
    expect(release().withdrawnNote).toBeUndefined();
    // Re-pinned by docs/whats-new-emptied-fields-and-schedule-completion (2026-11-16; was: RELEASES.slice(0, 4)): the emptied fields and schedule completion release is published at the top, below the Liquid Glass draft, so the list takes one more.
    // Re-pinned by docs/releases-low-critical-pages (2026-11-18; was: RELEASES.slice(0, 5)): the Low + critical pages and list value release is published at the top, below the Liquid Glass draft, so the list takes one more.
    expect(RELEASES.slice(0, 6).map((r) => [r.id, r.status])).toEqual([
      ['liquid-glass-2026-11', 'draft'],
      // Re-pinned by docs/releases-low-critical-pages (2026-11-18; was: without it): the Low + critical pages and list value release is published later, at the top, directly below the Liquid Glass draft.
      [LOW_CRITICAL_ID, 'published'],
      // Re-pinned by docs/whats-new-emptied-fields-and-schedule-completion (2026-11-16; was: without it): the emptied fields and schedule completion release is published later, at the top, directly below the Liquid Glass draft.
      [EMPTIED_FIELDS_ID, 'published'],
      [ID, 'published'],
      [DELETE_CONFIRM_ID, 'published'],
      [AUTH_SET_UP_ID, 'published'],
    ]);
    // Re-pinned by docs/whats-new-emptied-fields-and-schedule-completion (2026-11-16; was: ID): the emptied fields and schedule completion release is published after it, at the top, the newest published release.
    // Re-pinned by docs/releases-low-critical-pages (2026-11-18; was: EMPTIED_FIELDS_ID): the Low + critical pages and list value release is published after it, at the top, the newest published release.
    expect(RELEASES.find((r) => r.status === 'published')?.id).toBe(LOW_CRITICAL_ID);
  });

  // Renamed by docs/whats-new-emptied-fields-and-schedule-completion (2026-11-16; was: "is dated on a whole minute after #590 and #591 went live, in the past, with the draft placeholder at the same minute and every release below it older"): the emptied fields and schedule completion release above is dated later, and the draft placeholder moved to its minute. Claim kept: a whole minute after #590 and #591 went live, in the past, every release below it older.
  it('is dated on a whole minute after #590 and #591 went live, in the past, with the draft placeholder at or after it and every release below it older', () => {
    expect(release().publishedAt).toBe(PUBLISHED_AT);
    const at = Date.parse(release().publishedAt);
    expect(at % 60_000).toBe(0);
    expect(at).toBeGreaterThan(Date.parse(LIVE_591));
    expect(at).toBeGreaterThan(Date.parse(LIVE_590));
    expect(at).toBeLessThanOrEqual(Date.now());
    // Re-pinned by docs/whats-new-emptied-fields-and-schedule-completion (2026-11-16; was: RELEASES[0]!.publishedAt toBe this minute): the draft placeholder moved to the minute of the emptied fields and schedule completion release, published later, directly above this one.
    expect(Date.parse(RELEASES[0]!.publishedAt)).toBeGreaterThanOrEqual(at);
    // Re-pinned by docs/whats-new-emptied-fields-and-schedule-completion (2026-11-16; was: every pinned position one place higher): the emptied fields and schedule completion release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/releases-low-critical-pages (2026-11-18; was: RELEASES.slice(3)): the Low + critical pages and list value release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    for (const r of RELEASES.slice(4)) {
      expect(at, r.id).toBeGreaterThan(Date.parse(r.publishedAt));
    }
  });

  it('parses under the shared schema, in plain text, with its two entries', () => {
    expect(releaseSchema.safeParse(release()).success).toBe(true);
    for (const text of readerText(release())) expect(text).not.toMatch(/[<>!]/);
    expect(release().entries.map((e) => [e.id, e.category, e.area])).toEqual([
      [CONNECTION_ENTRY, 'improved', 'Settings'],
      [SCHEDULE_ENTRY, 'fixed', 'Schedule'],
    ]);
    for (const id of [CONNECTION_ENTRY, SCHEDULE_ENTRY]) {
      expect(RELEASES.filter((r) => r.entries.some((x) => x.id === id)).map((r) => r.id)).toEqual([
        ID,
      ]);
    }
  });
});

describe('the Integrations and schedule event release: the words', () => {
  it('says what Settings, Integrations shows and what to do, as written', () => {
    expect(release().title).toBe(
      'Clearer messages when an accounting connection or a new schedule event does not go through',
    );
    expect(release().summary).toBe(
      'On the website, Settings, Integrations now says when connecting QuickBooks or Sage Intacct was not finished because your access could not be confirmed, and that you can set up an authenticator in Settings, Security if your organization requires one. A new schedule event that could not be saved because your warehouse access could not be checked now says so, and you can try again. The mobile app is unchanged.',
    );
    const e = entry(CONNECTION_ENTRY);
    expect(e.title).toBe('Integrations says when an accounting connection was not finished');
    expect(e.whatChanged).toBe(
      'On the website, when connecting QuickBooks or Sage Intacct does not finish because your access could not be confirmed, Settings, Integrations now says: The connection was not finished because your access could not be confirmed. If your organization requires an authenticator, set one up in Settings, Security, then connect again. Settings, Security in that message is a link to the page.',
    );
    expect(e.whyItMatters).toBe(
      'Before, the page did not say why the connection was not finished.',
    );
    expect(e.howItAffectsYou).toBe(
      'The message shows with the QuickBooks and Sage Intacct cards. You connect again from the same page. The mobile app is unchanged.',
    );
    expect(e.whatToDo).toBe(
      'If you see this message and your organization requires an authenticator, set one up in Settings, Security, then connect again. Otherwise, no action needed.',
    );
    expect(e.link).toEqual(LINK);
  });

  it('says what a new schedule event shows when the warehouse access could not be checked, as written', () => {
    const e = entry(SCHEDULE_ENTRY);
    expect(e.title).toBe(
      'A new schedule event says when your warehouse access could not be checked',
    );
    expect(e.whatChanged).toBe(
      `On the website, if StockPilot cannot check your access to the event's warehouse for a moment when you choose Create event, the form now says ${ORDER_WAREHOUSE_ACCESS_UNREADABLE_COPY}`,
    );
    expect(e.whyItMatters).toBe(
      'Before, the message read as if you had no access to that warehouse.',
    );
    expect(e.howItAffectsYou).toBe(
      'This is rare and usually passes in a moment. The event was not saved, and the form keeps what you entered. The mobile app is unchanged.',
    );
    expect(e.whatToDo).toBe('If you see this, wait a moment and choose Create event again.');
    expect(e.link).toBeUndefined();
  });

  it('keeps to the wording rules: no emoji, no exclamation mark, no "book", no claim that an email was sent, no sign-in jargon, and no reason given', () => {
    for (const text of readerText(release())) {
      expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
      expect(text).not.toMatch(/\bbook/i);
      expect(text).not.toMatch(/\b(we|StockPilot) (sent|emailed|sends|emails)\b/i);
      expect(text).not.toMatch(/\b(MFA|2FA|two-factor|multi-factor)\b/i);
      expect(text).not.toMatch(/\b(gap|fix|fixed|protect|attack|exploit|bypass|vulnerab\w*)\b/i);
      expect(text).not.toMatch(/\b(phone app|mobile app) (now|gets)\b/i);
    }
  });
});

describe('the Integrations and schedule event release: who is told', () => {
  it('names the permission and module each page checks, on each entry, and none on the release', () => {
    expect(release().audience).toBeUndefined();
    expect(entry(CONNECTION_ENTRY).audience).toEqual({
      anyPermission: ['integrations:manage'],
      modules: ['integrations'],
    });
    expect(entry(SCHEDULE_ENTRY).audience).toEqual({
      anyPermission: ['schedule:manage'],
      modules: ['schedule'],
    });
  });

  it('tells each reader only the entries they can reach, and nobody else', () => {
    expect(shown(owner)?.entries.map((e) => e.id)).toEqual([CONNECTION_ENTRY, SCHEDULE_ENTRY]);
    expect(shown(integrationsOnly)?.entries.map((e) => e.id)).toEqual([CONNECTION_ENTRY]);
    expect(shown(scheduleOnly)?.entries.map((e) => e.id)).toEqual([SCHEDULE_ENTRY]);
    expect(shown(member)).toBeUndefined();
    // With the modules off, neither entry is told, whatever the permissions.
    expect(shown(viewer('owner', [...PERMISSIONS], []))).toBeUndefined();
  });

  // Renamed by docs/whats-new-emptied-fields-and-schedule-completion (2026-11-16; was: "is the first notice for whoever it reaches, the delete account release is next, and an old phone build lists it first with the Integrations link only where that entry is told"): the emptied fields and schedule completion release is published later, at the top, and reaches owners, admins and whoever manages the schedule with Schedule on, so they read it first. Claim kept: the notice for whoever it reaches, the delete account release next, and an old phone build lists it first with the Integrations link only where that entry is told.
  it('is the notice for whoever it reaches once the emptied fields and schedule completion release is read, the delete account release is next, and an old phone build lists it first with the Integrations link only where that entry is told', () => {
    // Added by docs/whats-new-emptied-fields-and-schedule-completion (2026-11-16): a read of the emptied fields and schedule completion release, published later, at the top.
    const emptiedRead = {
      release_id: EMPTIED_FIELDS_ID,
      revision: 1,
      dismissed_at: null,
      opened_at: '2026-11-16T12:34:00Z',
      read_at: '2026-11-16T12:34:00Z',
    };
    const read = {
      release_id: ID,
      revision: 1,
      dismissed_at: null,
      opened_at: '2026-11-16T09:40:00Z',
      read_at: '2026-11-16T09:40:00Z',
    };
    for (const v of [owner, admin, integrationsOnly, scheduleOnly]) {
      // Re-pinned by docs/whats-new-emptied-fields-and-schedule-completion (2026-11-16; was: nothing read, and [read]): the emptied fields and schedule completion release is published later, at the top, and reaches every reader here but integrationsOnly, so it is read first, and every notice this test checks is the one it checked before.
      // Re-pinned by docs/releases-low-critical-pages (2026-11-18; was: without it): the Low + critical pages and list value release is published later, at the top, and reaches whoever can read items (owners, admins, managers, staff and viewers by default), so each reads it first, and every notice this test checks is the one it checked before.
      expect(buildReleaseList(RELEASES, v, [lowCriticalRead, emptiedRead], null).latestUnread?.id, v.role).toBe(ID);
      expect(
        buildReleaseList(RELEASES, v, [lowCriticalRead, emptiedRead, read], null).latestUnread?.id,
        v.role,
      ).toBe(DELETE_CONFIRM_ID);
    }
    // Re-pinned by docs/releases-low-critical-pages (2026-11-18; was: nothing read): the Low + critical pages and list value release is published later, at the top, and reaches whoever can read items (owners, admins, managers, staff and viewers by default), so each reads it first, and every notice this test checks is the one it checked before.
    expect(buildReleaseList(RELEASES, member, [lowCriticalRead], null).latestUnread?.id).toBe(DELETE_CONFIRM_ID);
    // Re-pinned by docs/releases-low-critical-pages (2026-11-18; was: nothing seen): the Low + critical pages and list value release is published later and reaches whoever can read items, so the phone has seen it first.
    expect(legacyAnnouncementsFor(RELEASES, integrationsOnly, { [LOW_CRITICAL_ID]: true })[0]).toEqual({
      id: ID,
      date: '2026-11-16',
      title: release().title,
      body: release().summary,
      cta: LINK,
    });
    // Re-pinned by docs/whats-new-emptied-fields-and-schedule-completion (2026-11-16; was: nothing seen): the emptied fields and schedule completion release is published later, at the top, and reaches whoever manages the schedule with Schedule on, so it is seen first.
    expect(
      // Re-pinned by docs/releases-low-critical-pages (2026-11-18; was: without it): the Low + critical pages and list value release is published later and reaches whoever can read items, so the phone has seen it first.
      legacyAnnouncementsFor(RELEASES, scheduleOnly, { [LOW_CRITICAL_ID]: true, [EMPTIED_FIELDS_ID]: true })[0],
    ).toEqual({
      id: ID,
      date: '2026-11-16',
      title: release().title,
      body: release().summary,
    });
  });
});

describe('the Integrations and schedule event release: the code the words rest on', () => {
  it('Settings, Integrations shows the message for ?error=forbidden with the accounting cards, and links Settings > Security', () => {
    const page = source('apps/web/src/app/(dashboard)/dashboard/settings/integrations/page.tsx');
    expect(page).toContain("const connectRefused = showQbo && returnedError === 'forbidden';");
    expect(page).toContain(
      "const showQbo = integrationsAccess.enabled && can(ctx, 'integrations:manage');",
    );
    expect(page).toContain(
      'The connection was not finished because your access could not be confirmed.',
    );
    expect(page).toContain('If your organization requires an authenticator, set one up in');
    expect(page).toContain('href={AUTHENTICATOR_SET_UP_PAGE}');
    expect(page).toContain('Settings &gt; Security');
    expect(page).toContain(', then connect again.');
    expect(page).toContain('title="Integrations"');
    expect(AUTHENTICATOR_SET_UP_PAGE).toBe('/dashboard/settings/security');
    for (const provider of ['quickbooks', 'sage_intacct']) {
      const callback = source(`apps/web/src/app/api/integrations/${provider}/callback/route.ts`);
      expect(callback, provider).toContain(
        "const SETTINGS_PATH = '/dashboard/settings/integrations';",
      );
      expect(callback, provider).toContain("return redirectWithError('forbidden');");
    }
    // Connecting is on the website only: the phone's Integrations screen has no connect button.
    const phone = source('apps/mobile/app/(drawer)/settings/integrations.tsx');
    expect(phone).toContain('CONNECT IS WEB-ONLY');
  });

  it('a new schedule event answers the shared sentence when the warehouse access could not be read, and the form shows it', () => {
    expect(ORDER_WAREHOUSE_ACCESS_UNREADABLE_COPY).toBe(
      "Your warehouse access couldn't be checked just now, so nothing was changed. Try again.",
    );
    const service = source('apps/web/src/server/services/schedule.ts');
    expect(service).toContain('if (e instanceof ForbiddenError && !e.accessUnreadable) {');
    expect(service).toContain(
      'await this.assertWarehouseWrite(input.warehouseId, SCHEDULE_EVENT_WAREHOUSE_REFUSED);',
    );
    const actions = source('apps/web/src/server/actions/schedule.ts');
    expect(actions).toContain("return actionErrorResult(error, 'actions.schedule');");
    expect(actions).toContain('const ev = await svc.create(parsed.data);');
    const result = source('apps/web/src/server/lib/action-error-result.ts');
    expect(result).toContain("return err('conflict', ORDER_WAREHOUSE_ACCESS_UNREADABLE_COPY, {");
    const form = source('apps/web/src/components/schedule/schedule-event-form.tsx');
    expect(form).toContain('toast.error(res.error.message);');
    expect(form).toContain("{isEdit ? 'Save changes' : 'Create event'}");
    const newPage = source('apps/web/src/app/(dashboard)/dashboard/schedule/new/page.tsx');
    expect(newPage).toContain("if (!can(ctx, 'schedule:manage')) notFound();");
    // The phone's New event writes through its own path.
    const phone = source('apps/mobile/app/schedule/new.tsx');
    expect(phone).toContain(".from('schedule_events').insert(");
  });
});

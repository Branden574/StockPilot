import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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
  it('are published once each, as revision 1, directly below the Liquid Glass draft, the authenticator code release the newest', () => {
    for (const id of [CODE_ID, ACCESS_ID]) {
      expect(
        RELEASES.filter((r) => r.id === id),
        id,
      ).toHaveLength(1);
      expect(byId(id).status, id).toBe('published');
      expect(byId(id).revision, id).toBe(1);
      expect(byId(id).withdrawnNote, id).toBeUndefined();
    }
    expect(RELEASES.slice(0, 4).map((r) => [r.id, r.status])).toEqual([
      ['liquid-glass-2026-11', 'draft'],
      [CODE_ID, 'published'],
      [ACCESS_ID, 'published'],
      ['emailed-links-name-their-account-2026-11', 'published'],
    ]);
    expect(RELEASES.find((r) => r.status === 'published')?.id).toBe(CODE_ID);
  });

  it('share one whole minute, after the web half went live and the phone update was published, with the draft placeholder at that minute and no later release below', () => {
    const at = byId(CODE_ID).publishedAt;
    expect(at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/);
    expect(byId(ACCESS_ID).publishedAt).toBe(at);
    expect(RELEASES[0]!.publishedAt).toBe(at);
    // #510 went live at 18:05:33Z; the phone update was published at 20:08:51Z.
    expect(Date.parse(at)).toBeGreaterThan(Date.parse('2026-11-13T18:05:33Z'));
    expect(Date.parse(at)).toBeGreaterThan(Date.parse('2026-11-13T20:08:51Z'));
    for (const r of RELEASES.slice(3)) {
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
    for (const v of [owner, member]) {
      expect(entriesFor(CODE_ID, v), v.role).toEqual(['phone-waits-for-authenticator-code']);
      expect(buildReleaseList(RELEASES, v, [], null).latestUnread?.id, v.role).toBe(CODE_ID);
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

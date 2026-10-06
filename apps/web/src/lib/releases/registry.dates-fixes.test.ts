import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  MODULE_REGISTRY,
  PERMISSIONS,
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
 * fix/dates-in-org-and-utc (no migration, web and phone), told in the dates
 * fixes draft. Its own file so the release tests that other open branches edit
 * (registry.test.ts) change only where this draft moves the others.
 *
 * Held as a DRAFT until the web deploy is live and the over-the-air update
 * with the phone part has reached phones. Each entry is told to whoever can
 * open the screen it is about.
 */
const ID = 'dates-fixes-2026-10';
const release = () => RELEASES.find((r) => r.id === ID)!;
const entry = (id: string) => release().entries.find((e) => e.id === id)!;
const REPO = resolve(__dirname, '../../../../..');
const source = (rel: string) => readFileSync(resolve(REPO, rel), 'utf8');

describe('the dates fixes release is held as a draft', () => {
  const everyone: ReleaseViewer = {
    role: 'owner',
    permissions: [...PERMISSIONS],
    enabledModules: Object.keys(MODULE_REGISTRY) as ModuleId[],
  };

  it('is a draft, so no feed carries it, and preparing it changes nothing a client can observe', () => {
    expect(release()).toBeDefined();
    expect(release().status).toBe('draft');
    expect(release().revision).toBe(1);
    expect(visibleReleases(RELEASES, everyone).map((r) => r.id)).not.toContain(ID);
    expect(buildReleaseList(RELEASES, everyone, [], null).releases.map((r) => r.id)).not.toContain(
      ID,
    );
    expect(legacyAnnouncementsFor(RELEASES, everyone, {}).map((a) => a.id)).not.toContain(ID);
    expect(registryFingerprint(RELEASES)).toBe(
      registryFingerprint(RELEASES.filter((r) => r.id !== ID)),
    );
  });

  it('is the newest entry, at the top, dated after every other release', () => {
    expect(RELEASES[0]?.id).toBe(ID);
    for (const r of RELEASES.slice(1)) {
      expect(Date.parse(release().publishedAt), r.id).toBeGreaterThan(Date.parse(r.publishedAt));
    }
    expect(release().publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/);
  });
});

describe('the dates fixes release tells each change to whoever can see it', () => {
  const ids = (
    role: ReleaseViewer['role'],
    permissions: ReleaseViewer['permissions'],
    modules: ModuleId[],
  ) => {
    const published: Release = { ...release(), status: 'published' };
    return (
      visibleReleases([published], { role, permissions, enabledModules: modules })[0]?.entries.map(
        (e) => e.id,
      ) ?? []
    );
  };

  it('has no release-wide audience: each entry carries its own', () => {
    expect(release().audience).toBeUndefined();
    expect(release().entries.map((e) => e.id)).toEqual([
      'phone-po-list-expected-date',
      'phone-receive-expected-date',
      'calendar-current-month',
      'digest-send-time',
    ]);
  });

  it("the phone's Purchase orders line: purchase_orders:read with Purchase orders on, as the drawer's item asks", () => {
    expect(ids('viewer', ['purchase_orders:read'], ['purchase_orders'])).toContain(
      'phone-po-list-expected-date',
    );
    expect(ids('viewer', ['purchase_orders:read'], [])).not.toContain(
      'phone-po-list-expected-date',
    );
    expect(ids('viewer', [], ['purchase_orders'])).not.toContain('phone-po-list-expected-date');
    expect(entry('phone-po-list-expected-date').audience).toEqual({
      anyPermission: ['purchase_orders:read'],
      modules: ['purchase_orders'],
    });
  });

  it("the phone's Receive POs line: Receiving on, no permission, as its drawer item and tab ask", () => {
    expect(ids('viewer', [], ['purchase_orders', 'receiving'])).toContain(
      'phone-receive-expected-date',
    );
    expect(ids('viewer', [], ['purchase_orders'])).not.toContain('phone-receive-expected-date');
    expect(entry('phone-receive-expected-date').audience).toEqual({ modules: ['receiving'] });
  });

  it("the calendar line: the page's schedule:read or schedule:manage, Schedule on", () => {
    expect(ids('viewer', ['schedule:read'], ['schedule'])).toContain('calendar-current-month');
    expect(ids('manager', ['schedule:manage'], ['schedule'])).toContain('calendar-current-month');
    expect(ids('viewer', [], ['schedule'])).not.toContain('calendar-current-month');
    expect(ids('viewer', ['schedule:read'], [])).not.toContain('calendar-current-month');
  });

  it('the digest line: every member, linked to their notification settings', () => {
    expect(ids('viewer', [], [])).toEqual(['digest-send-time']);
    expect(entry('digest-send-time').audience).toBeUndefined();
    expect(entry('digest-send-time').link).toEqual({
      href: '/dashboard/settings/notifications',
      label: 'Open notification settings',
    });
  });
});

describe('the dates fixes release says only what shipped', () => {
  const all = () =>
    [
      release().title,
      release().summary,
      ...release().entries.flatMap((e) => [
        e.title,
        e.whatChanged,
        e.whyItMatters,
        e.howItAffectsYou,
        e.whatToDo,
      ]),
    ].join('\n');

  it('says the phone changes come with the latest update, and how to load it', () => {
    expect(release().summary).toContain(
      'In the mobile app, after the latest update, the Purchase orders and Receive POs screens',
    );
    for (const id of ['phone-po-list-expected-date', 'phone-receive-expected-date']) {
      expect(entry(id).whatChanged, id).toContain(
        'In the mobile app, after the latest update, it shows the date that was set.',
      );
      expect(entry(id).whatToDo, id).toBe(
        'Close the app completely and open it again to load the latest update.',
      );
    }
  });

  it('names the screens and the ETA the way the phone does', () => {
    const list = source('apps/mobile/src/screens/purchase-orders.tsx');
    expect(list).toContain('title="Purchase"');
    expect(list).toContain('`ETA ${formatCalendarDate(po.expected_at)}`');
    const receive = source('apps/mobile/app/(drawer)/(tabs)/receive.tsx');
    expect(receive).toContain('<SmallStat label="ETA" value={etaText} mono />');
    const registry = source('packages/core/src/modules/registry.ts');
    expect(registry).toContain("label: 'Receive POs', href: '/receive'");
  });

  it('describes the calendar as the page now works: the month in the organization zone, and Today drops the month', () => {
    const page = source('apps/web/src/app/(dashboard)/dashboard/schedule/page.tsx');
    expect(page).toContain('const today = zonedParts(new Date(), timeZone);');
    const calendar = source('apps/web/src/components/schedule/schedule-calendar.tsx');
    expect(calendar).toContain("params.delete('m');");
    expect(entry('calendar-current-month').whatChanged).toContain(
      'opening the team calendar or pressing Today showed the next month',
    );
  });

  it('quotes the card as it read, and says it now gives the footer time', () => {
    const controls = source('apps/web/src/components/settings/digest-controls.tsx');
    expect(controls).not.toContain('every Monday morning');
    expect(controls).toContain("Sent {scheduleLabel}, in your workspace's time zone.");
    expect(entry('digest-send-time').whatChanged).toContain('said it is sent every Monday morning');
    expect(entry('digest-send-time').whatChanged).toContain(
      "the same time the digest email's footer gives",
    );
  });

  it('claims nothing it cannot stand behind: no numbers, no promises, no word for a recorded quantity', () => {
    expect(all()).not.toMatch(/\bbooks?\b|%|guarantee|always|never|instantly|verified/i);
  });
});

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
 * fix/overdue-by-org-day (no migration, web and phone) adds its lines to the
 * same draft: a purchase order is overdue, and a delivery late, only after
 * its expected date has passed in the organization's zone.
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

  it('is a draft just below the public link draft, dated after every other release but that one', () => {
    // Re-pinned by the public link draft (fix/placed-cart-draft; was: the
    // newest entry, at the top, dated after every other release): it is
    // dated later and sits above this one.
    const at = RELEASES.findIndex((r) => r.id === ID);
    expect(at).toBe(1);
    expect(RELEASES[0]?.id).toBe('public-link-sent-request-2026-10');
    expect(RELEASES[0]?.status).toBe('draft');
    expect(Date.parse(RELEASES[0]!.publishedAt)).toBeGreaterThan(Date.parse(release().publishedAt));
    for (const r of RELEASES.slice(at + 1)) {
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
    // fix/overdue-by-org-day added the five overdue and on-time lines, after
    // the two expected-date lines they follow from.
    expect(release().entries.map((e) => e.id)).toEqual([
      'phone-po-list-expected-date',
      'phone-receive-expected-date',
      'phone-receive-overdue',
      'dashboard-overdue-purchase-orders',
      'briefing-overdue-purchase-orders',
      'digest-overdue-purchase-orders',
      'supplier-scorecard-on-time',
      'calendar-current-month',
      'digest-send-time',
    ]);
  });

  it("the phone's Receive POs overdue line: Receiving on, no permission, as the screen asks", () => {
    expect(ids('viewer', [], ['receiving'])).toContain('phone-receive-overdue');
    expect(ids('viewer', ['purchase_orders:read'], ['purchase_orders'])).not.toContain(
      'phone-receive-overdue',
    );
    expect(entry('phone-receive-overdue').audience).toEqual({ modules: ['receiving'] });
  });

  it("the dashboard line: purchase_orders:read with Purchase orders on, as the count's rows and its link ask", () => {
    // The count reads only the purchase orders the member may read
    // (purchase_orders_select needs purchase_orders:read), and it links to
    // the purchase orders page (Purchase orders on).
    expect(ids('viewer', ['purchase_orders:read'], ['purchase_orders'])).toContain(
      'dashboard-overdue-purchase-orders',
    );
    expect(ids('viewer', [], ['purchase_orders'])).not.toContain('dashboard-overdue-purchase-orders');
    expect(ids('viewer', ['purchase_orders:read'], [])).not.toContain(
      'dashboard-overdue-purchase-orders',
    );
    expect(entry('dashboard-overdue-purchase-orders').audience).toEqual({
      anyPermission: ['purchase_orders:read'],
      modules: ['purchase_orders'],
    });
  });

  it("the briefing line: the briefing page's items:update with AI on", () => {
    expect(ids('manager', ['items:update'], ['ai'])).toContain('briefing-overdue-purchase-orders');
    expect(ids('manager', ['items:update'], [])).not.toContain('briefing-overdue-purchase-orders');
    expect(ids('viewer', [], ['ai'])).not.toContain('briefing-overdue-purchase-orders');
    expect(entry('briefing-overdue-purchase-orders').audience).toEqual({
      anyPermission: ['items:update'],
      modules: ['ai'],
    });
  });

  it("the digest's overdue line: whoever the digest sends purchase orders to (purchase_orders:read)", () => {
    // services/digest.ts canReadPo: the purchase order section needs
    // purchase_orders:read; the digest checks no module.
    expect(ids('viewer', ['purchase_orders:read'], [])).toContain('digest-overdue-purchase-orders');
    expect(ids('viewer', [], ['purchase_orders'])).not.toContain('digest-overdue-purchase-orders');
    expect(entry('digest-overdue-purchase-orders').audience).toEqual({
      anyPermission: ['purchase_orders:read'],
    });
  });

  it("the scorecard line: the report's reports:read with Purchase orders on, linked to it", () => {
    expect(ids('viewer', ['reports:read'], ['purchase_orders'])).toContain(
      'supplier-scorecard-on-time',
    );
    expect(ids('viewer', ['reports:read'], [])).not.toContain('supplier-scorecard-on-time');
    expect(ids('viewer', [], ['purchase_orders'])).not.toContain('supplier-scorecard-on-time');
    expect(entry('supplier-scorecard-on-time').audience).toEqual({
      anyPermission: ['reports:read'],
      modules: ['purchase_orders'],
    });
    expect(entry('supplier-scorecard-on-time').link).toEqual({
      href: '/dashboard/reports/supplier-scorecard',
      label: 'Open the supplier scorecard',
    });
    // The page's own gate: reports:read and the report's modules.
    const access = source('apps/web/src/lib/reports/report-access.ts');
    expect(access).toContain("'supplier-scorecard': ['purchase_orders'],");
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
    // Re-pinned by the review of #338 (2026-10-06; was: "... the Purchase
    // orders and Receive POs screens"): the summary also says the phone's
    // Receive POs overdue count comes with the update, within 500 characters.
    expect(release().summary).toContain(
      'In the mobile app, after the latest update, Purchase orders and Receive POs show each expected date as it was set, and Receive POs counts overdue ones as the web does.',
    );
    for (const id of ['phone-po-list-expected-date', 'phone-receive-expected-date']) {
      expect(entry(id).whatChanged, id).toContain(
        'In the mobile app, after the latest update, it shows the date that was set.',
      );
      expect(entry(id).whatToDo, id).toBe(
        'Close the app completely and open it again to load the latest update.',
      );
    }
    expect(entry('phone-receive-overdue').whatChanged).toContain(
      'In the mobile app, after the latest update, a purchase order counts as overdue once its expected date has passed',
    );
    expect(entry('phone-receive-overdue').whatToDo).toBe(
      'Close the app completely and open it again to load the latest update.',
    );
    // The web lines need no update.
    for (const id of [
      'dashboard-overdue-purchase-orders',
      'briefing-overdue-purchase-orders',
      'digest-overdue-purchase-orders',
      'supplier-scorecard-on-time',
    ]) {
      expect(entry(id).whatToDo, id).toBe('No action needed.');
      expect(entry(id).whatChanged, id).not.toContain('mobile app');
    }
  });

  it('states the rule once, as the code decides it: overdue or late only after the expected date, in the organization zone', () => {
    expect(release().summary).toContain(
      "A purchase order now counts as overdue only once its expected date has passed in your organization's time zone, and a delivery received on its expected date counts as on time.",
    );
    for (const id of [
      'phone-receive-overdue',
      'dashboard-overdue-purchase-orders',
      'briefing-overdue-purchase-orders',
      'digest-overdue-purchase-orders',
    ]) {
      expect(entry(id).whatChanged, id).toContain(
        "once its expected date has passed in your organization's time zone",
      );
    }
    expect(entry('supplier-scorecard-on-time').whatChanged).toContain(
      "only when it is received after its expected date, in your organization's time zone",
    );
    // Every surface decides it through core's one rule.
    const core = source('packages/core/src/time/calendar-date.ts');
    expect(core).toContain('export function isPastExpectedDay(');
    expect(core).toContain('export function pastExpectedDayCutoff(');
    expect(source('apps/web/src/server/services/purchase-orders.ts')).toContain(
      "lt('expected_at', cutoff)",
    );
    // Re-pinned by the review of #338 (2026-10-06; was: isPastExpectedDay per
    // row): the same rule, the organization's day worked out once per list.
    expect(source('apps/web/src/server/services/digest.ts')).toContain(
      'const isPast = pastExpectedDayTest(clock.now, clock.timeZone);',
    );
    expect(source('apps/web/src/server/services/digest.ts')).toContain('isOverdue: isPast(r.expected_at),');
    expect(source('apps/web/src/server/services/reports.ts')).toContain(
      'if (!isPastExpectedDay(po.expected_at, po.received_at, timeZone)) {',
    );
    // Re-pinned by the review of #338 (2026-10-06; was: isPastExpectedDay per
    // purchase order): the same rule, the organization's day worked out once.
    expect(source('apps/mobile/src/lib/receive-overdue.ts')).toContain(
      'const isPast = pastExpectedDayTest(now, timeZone);',
    );
    expect(source('packages/core/src/time/calendar-date.ts')).toContain(
      'return pastExpectedDayTest(at, timeZone)(expectedAt);',
    );
  });

  it('names the overdue counts the way each screen does', () => {
    const receive = source('apps/mobile/app/(drawer)/(tabs)/receive.tsx');
    expect(receive).toContain("` · ${overdueCount} OVERDUE`");
    expect(entry('phone-receive-overdue').whatChanged).toContain(
      "In US time zones, the mobile app's Receive POs screen counted a purchase order as overdue",
    );
    const dashboard = source('apps/web/src/app/(dashboard)/dashboard/page.tsx');
    expect(dashboard).toContain(
      "title: `${poOverdueCount} overdue purchase order${poOverdueCount === 1 ? '' : 's'}`,",
    );
    expect(entry('dashboard-overdue-purchase-orders').whatChanged).toContain(
      "In US time zones, the dashboard's list of what needs attention counted a purchase order as overdue",
    );
    const insights = source('apps/web/src/server/services/insights.ts');
    expect(insights).toContain("'overdue inbound PO'");
    const briefingPage = source('apps/web/src/app/(dashboard)/dashboard/insights/page.tsx');
    expect(briefingPage).toContain('Today&apos;s briefing');
    // Re-pinned by the review of #338 (2026-10-06; was: "Today's briefing and
    // the morning briefing notification" counted from the day before): the
    // notification runs at 13:00 UTC on weekdays, 6 AM Pacific, so it counted
    // a purchase order due that same day; only the Insights page, opened after
    // 5 PM, counted it from the evening before.
    expect(entry('briefing-overdue-purchase-orders').whatChanged).toContain(
      "Today's briefing counted a purchase order as an overdue inbound PO from the evening before its expected date, and the morning briefing notification counted it on its expected date.",
    );
    const digest = source('apps/web/src/lib/email/es/families/digest.ts');
    expect(digest).toContain("`${plural(overdueTotal, 'purchase order')} overdue`");
    const scorecard = source('apps/web/src/app/(dashboard)/dashboard/reports/supplier-scorecard/page.tsx');
    expect(scorecard).toContain('<TableHead className="text-right">On-time</TableHead>');
    // The page's own note says the rule, not the old column comparison.
    expect(scorecard).not.toContain('received_at ≤ expected_at');
    expect(scorecard.replace(/\s+/g, ' ')).toContain(
      'On-time = received on or before the expected date (the day it was received, in your organization&apos;s time zone)',
    );
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

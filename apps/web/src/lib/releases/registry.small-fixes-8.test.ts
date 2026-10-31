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

import { formatAuditEvent } from '@/lib/audit/format';
import { ANNOUNCEMENTS } from '@/lib/onboarding/announcements';
import {
  unofferedDestinationNote,
  unofferedSupplierNote,
} from '@/lib/purchase-orders/unoffered-choice';
import { OVERDUE_PO_ATTENTION_DETAIL, TAB_LABELS } from '@/lib/purchase-orders/tabs';

import {
  buildReleaseList,
  legacyAnnouncementsFor,
  registryFingerprint,
  visibleReleases,
} from './logic';
import { RELEASES } from './registry';

/**
 * fix/small-fixes-8 (no migration, web and server only): the purchase orders
 * list's Overdue view, destinations and suppliers the purchase order and
 * recurring forms cannot offer, the recurring run saying why it created
 * nothing, the team calendar in the organization's zone and the weekly
 * digest's dates. Its own file, so the release tests other open branches edit
 * stay as they are; only the position pins that list the releases above them
 * moved, each with a note (six in registry.test.ts, one each in the public
 * link and dates fixes files).
 *
 * Held as a draft until web build 07ad9db5b89c was live (#374 merged
 * 2026-10-31 08:04:49Z; built 08:05:15Z, answering by 08:06Z) and walked in
 * Demo Co on production (08:18Z to 08:33Z, with a read-only check to
 * 08:44Z). docs/whats-new-small-fixes-8 publishes it at the top, the newest
 * release: each test that pinned it as a draft is re-pinned with a note, and
 * the tests marked "Added by docs/whats-new-small-fixes-8" pin what a
 * published release must hold (when it was published, who it reaches, the
 * notice and the old phone builds' list) and the code its re-read words rest
 * on.
 */
const ID = 'small-fixes-8-2026-10';
const release = () => RELEASES.find((r) => r.id === ID)!;
const entry = (id: string) => release().entries.find((e) => e.id === id)!;

const everyone: ReleaseViewer = {
  role: 'owner',
  permissions: [...PERMISSIONS],
  enabledModules: Object.keys(MODULE_REGISTRY) as ModuleId[],
};
/** A member who holds no permission and no module. */
const member: ReleaseViewer = { role: 'viewer', permissions: [], enabledModules: [] };

/** A file in the repository, as written. */
const REPO = resolve(__dirname, '../../../../..');
const repoFile = (rel: string) => readFileSync(resolve(REPO, rel), 'utf8');
/** A source file under apps/web/src, as written. */
const source = (rel: string) => repoFile(`apps/web/src/${rel}`);
/** A dashboard page's source, by its path under app/(dashboard)/dashboard. */
const page = (rel: string) => source(`app/(dashboard)/dashboard/${rel}`);
/** A file in the mobile app, as written. */
const phone = (rel: string) => repoFile(`apps/mobile/${rel}`);

const OVERDUE_VIEW = '/dashboard/purchase-orders?status=overdue';

/** Every string a reader can see in the release. */
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

describe('the small fixes slice 8 release', () => {
  // Re-pinned by docs/whats-new-small-fixes-8 (2026-10-31; was: "is a draft,
  // so no feed carries it, and preparing it changes nothing a client can
  // observe": a draft, in no feed, no legacy list and no fingerprint).
  it('is published after the web deploy, so every feed carries it, and publishing it changes what clients observe', () => {
    expect(release()).toBeDefined();
    expect(RELEASES.filter((r) => r.id === ID)).toHaveLength(1);
    expect(release().status).toBe('published');
    expect(release().revision).toBe(1);
    expect(visibleReleases(RELEASES, everyone).map((r) => r.id)).toContain(ID);
    expect(buildReleaseList(RELEASES, everyone, [], null).releases.map((r) => r.id)).toContain(ID);
    expect(legacyAnnouncementsFor(RELEASES, everyone, {}).map((a) => a.id)).toContain(ID);
    expect(ANNOUNCEMENTS.map((a) => a.id)).toContain(ID);
    expect(registryFingerprint(RELEASES)).toContain(`${ID}@1:published`);
    expect(registryFingerprint(RELEASES)).not.toBe(
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

  // Added by docs/whats-new-small-fixes-8 (2026-10-31): published once #374
  // had merged (08:04:49Z), its web build answered on production (by 08:06Z)
  // and the Demo Co walk's read-only check had closed (08:44:54Z); the day it
  // was published (UTC) is the ceiling.
  it('is published as revision 1, not before its web build was live (08:06Z) and walked (to 08:44:54Z), on the day it went live, and no draft is left', () => {
    const at = Date.parse(release().publishedAt);
    expect(at).toBeGreaterThanOrEqual(Date.parse('2026-10-31T08:04:49Z'));
    expect(at).toBeGreaterThanOrEqual(Date.parse('2026-10-31T08:06:00Z'));
    expect(at).toBeGreaterThanOrEqual(Date.parse('2026-10-31T08:44:54Z'));
    expect(at).toBeLessThanOrEqual(Date.parse('2026-11-01T00:00:00Z'));
    expect(release().revision).toBe(1);
    expect(RELEASES.filter((r) => r.status === 'draft').map((r) => r.id)).toEqual([]);
  });

  it('has a line for each user-visible change, in this order', () => {
    expect(release().entries.map((e) => e.id)).toEqual([
      'po-list-overdue-view',
      'po-edit-names-unoffered-choices',
      'recurring-template-names-unoffered-choices',
      'recurring-run-says-why',
      'calendar-last-evening-and-zone',
      'digest-dated-in-workspace-zone',
    ]);
    // Web only: no phone line, and the summary says so.
    expect(release().summary).toMatch(/^On the web, /);
    expect(readerText(release()).join(' ')).not.toMatch(/mobile app|phone/i);
  });

  it('tells each line to whoever can see that screen, and links where it leads', () => {
    expect(entry('po-list-overdue-view').audience).toEqual({
      anyPermission: ['purchase_orders:read'],
      modules: ['purchase_orders'],
    });
    // Labelled for both platforms: the phone opens its plain Purchase orders
    // list for this link (it has no Overdue view yet), so "overdue" in the
    // label would be false there; the web still opens the Overdue view.
    expect(entry('po-list-overdue-view').link).toEqual({
      href: OVERDUE_VIEW,
      label: 'Open purchase orders',
    });
    for (const id of [
      'po-edit-names-unoffered-choices',
      'recurring-template-names-unoffered-choices',
      'recurring-run-says-why',
    ]) {
      expect(entry(id).audience, id).toEqual({
        anyPermission: ['purchase_orders:manage'],
        modules: ['purchase_orders'],
      });
    }
    expect(entry('recurring-template-names-unoffered-choices').link?.href).toBe(
      '/dashboard/purchase-orders/recurring',
    );
    expect(entry('calendar-last-evening-and-zone').audience).toEqual({
      anyPermission: ['schedule:read', 'schedule:manage'],
      modules: ['schedule'],
    });
    // The notification settings are each member's own.
    expect(entry('digest-dated-in-workspace-zone').audience).toBeUndefined();
    expect(release().audience).toBeUndefined();

    // Re-pinned by docs/whats-new-small-fixes-8 (2026-10-31; was: a copy of
    // the release forced to published, as it was a draft): the release itself
    // is published now.
    const told = (permissions: ReleaseViewer['permissions'], modules: ModuleId[]) =>
      visibleReleases([release()], {
        role: 'staff',
        permissions,
        enabledModules: modules,
      })[0]?.entries.map((e) => e.id) ?? [];
    // A member who reads purchase orders but cannot edit them: the Overdue
    // view and the digest, not the edit lines.
    expect(told(['purchase_orders:read'], ['purchase_orders'])).toEqual([
      'po-list-overdue-view',
      'digest-dated-in-workspace-zone',
    ]);
    expect(told(['purchase_orders:read', 'purchase_orders:manage'], ['purchase_orders'])).toContain(
      'recurring-run-says-why',
    );
    expect(told(['schedule:read'], ['schedule'])).toEqual([
      'calendar-last-evening-and-zone',
      'digest-dated-in-workspace-zone',
    ]);
    expect(told(['purchase_orders:read', 'purchase_orders:manage'], [])).toEqual([
      'digest-dated-in-workspace-zone',
    ]);
  });

  // Added by docs/whats-new-small-fixes-8 (2026-10-31): every audience names
  // what its page checks, and the digest line, whose page checks only the
  // session, has none. Fails if a page's check changes.
  it('names in each audience the permission and the module its page checks', () => {
    // The purchase orders list and its Overdue view: the module (the rows are
    // what the reader may read).
    expect(page('purchase-orders/page.tsx')).toContain(
      "const moduleAccess = await checkModuleAccess('purchase_orders');",
    );
    // Edit purchase order and Recurring POs: purchase_orders:manage, and the
    // module on the Recurring page.
    expect(page('purchase-orders/[id]/edit/page.tsx')).toContain(
      "if (!can(ctx, 'purchase_orders:manage')) {",
    );
    const recurring = page('purchase-orders/recurring/page.tsx');
    expect(recurring).toContain("const moduleAccess = await checkModuleAccess('purchase_orders');");
    expect(recurring).toContain("if (!can(ctx, 'purchase_orders:manage')) {");
    // The team calendar: the module, and schedule:read or schedule:manage.
    const schedule = page('schedule/page.tsx');
    expect(schedule).toContain("const moduleAccess = await checkModuleAccess('schedule');");
    expect(schedule).toContain("if (!can(ctx, 'schedule:read') && !can(ctx, 'schedule:manage')) {");
    // Notification settings: the session only.
    const settings = page('settings/notifications/page.tsx');
    expect(settings).toContain('const session = await requireSession();');
    expect(settings).not.toMatch(/\bcan\(|assertPermission|assertModuleEnabled|checkModuleAccess/);
  });

  // Added by docs/whats-new-small-fixes-8 (2026-10-31): the digest line has no
  // audience, so the release reaches every member.
  it('reaches every member, and a member with no permission is told only the digest line', () => {
    const shown = (v: ReleaseViewer) =>
      visibleReleases(RELEASES, v)
        .find((r) => r.id === ID)
        ?.entries.map((e) => e.id);
    expect(shown(everyone)).toEqual(release().entries.map((e) => e.id));
    expect(shown(member)).toEqual(['digest-dated-in-workspace-zone']);
  });

  // Added by docs/whats-new-small-fixes-8 (2026-10-31). An old phone build
  // shows the title, the summary and the first linked line the reader can
  // reach as its button; the phone draws the button only when the link opens
  // one of its own screens (whats-new.tsx).
  it('is the first notice for every member, and an old phone build shows its title and summary, with Open purchase orders for whoever can open the list', () => {
    for (const v of [everyone, member]) {
      expect(buildReleaseList(RELEASES, v, [], null).latestUnread?.id, v.role).toBe(ID);
    }
    expect(legacyAnnouncementsFor(RELEASES, everyone, {})[0]).toEqual({
      id: ID,
      date: '2026-10-31',
      title: release().title,
      body: release().summary,
      cta: { href: OVERDUE_VIEW, label: 'Open purchase orders' },
    });
    // Whoever can open the team calendar, and not the purchase orders list.
    const scheduler: ReleaseViewer = {
      role: 'staff',
      permissions: ['schedule:read'],
      enabledModules: ['schedule'],
    };
    expect(legacyAnnouncementsFor(RELEASES, scheduler, {})[0]?.cta).toEqual({
      href: '/dashboard/schedule',
      label: 'Open the team calendar',
    });
    expect(legacyAnnouncementsFor(RELEASES, member, {})[0]).toEqual({
      id: ID,
      date: '2026-10-31',
      title: release().title,
      body: release().summary,
      cta: { href: '/dashboard/settings/notifications', label: 'Open notification settings' },
    });
    // On the phone, Open purchase orders opens its Purchase orders list (the
    // query dropped: no Overdue view there) and Open the team calendar its
    // Schedule; notification settings have no screen of their own there, so
    // a member told only the digest line gets the title and summary alone.
    expect(phone('src/components/onboarding/whats-new.tsx')).toContain(
      "const showCta = !!cta && rewriteWebPath(cta.href) !== '/';",
    );
    const rewrite = phone('src/lib/web-path-rewrite.ts');
    expect(rewrite).toContain(
      "{ re: /\\/dashboard\\/purchase-orders(\\?.*)?$/, to: () => '/purchase-orders' },",
    );
    expect(rewrite).toContain("{ re: /\\/dashboard\\/schedule(\\/.*)?$/, to: () => '/schedule' },");
    expect(rewrite).toContain("{ re: /^\\/dashboard(\\/.*)?$/, to: () => '/' },");
    expect(rewrite).not.toContain('\\/dashboard\\/settings');
  });

  it("uses the screens' own words", () => {
    const text = readerText(release()).join(' ');
    expect(text).toContain(TAB_LABELS.overdue);
    expect(text).toContain('None or No supplier');
    expect(text).toContain('Make recurring');
    // The button reads "Export" (CSV is only in its accessible name).
    expect(text).toContain('Search and Export work on it too.');
    expect(text).not.toContain('Export CSV');
    expect(text).toContain('Recurring POs');
    expect(text).toContain('Recurring purchase orders notification');
    expect(text).toContain('As of date');
    // The notes it describes say what the form had, and ask for a choice.
    expect(
      unofferedDestinationNote('purchase_order', { name: 'Staging', why: 'not_a_site' }),
    ).toMatch(/choose a destination\.$/);
    expect(unofferedSupplierNote('template', { name: 'Acme Paper', why: 'archived' })).toMatch(
      /was archived, so choose a supplier\.$/,
    );
  });

  it('claims nothing the product does not do, and never "book" for a quantity', () => {
    const text = readerText(release()).join(' ');
    expect(text).not.toMatch(/\bbook\b/i);
    expect(text).not.toMatch(/email sent|emailed|automatically sent|guarantee/i);
    // The run says why; it does not fix the template by itself.
    expect(entry('recurring-run-says-why').whatChanged).toContain('names the template and why');
    // A creator is told only while they hold purchase_orders:manage (the
    // cron's creatorsWhoEditTemplates, slice 8 review).
    expect(entry('recurring-run-says-why').howItAffectsYou).toContain(
      "The notification goes to your organization's owners and admins and to the person who created the template, if they can still edit templates.",
    );
    // The past is told as it was: a deleted destination's template DID create
    // purchase orders (the run line says so), so the template line does not
    // say it created none (slice 8 review).
    expect(entry('recurring-template-names-unoffered-choices').whyItMatters).not.toMatch(
      /creates no purchase orders/,
    );
    expect(entry('recurring-run-says-why').whatChanged).toContain(
      'still created purchase orders to that location',
    );
    // Make recurring already named a deleted destination (#334): only the
    // archived supplier is new there.
    expect(entry('recurring-template-names-unoffered-choices').whatChanged).toContain(
      'Make recurring names an archived supplier the same way',
    );
    // Saving with no choice keeps none, as the box shows: said plainly,
    // including a save made for something else, which removes an archived
    // supplier the purchase order and template saves would accept (slice 8
    // review; owner question 7).
    expect(entry('po-edit-names-unoffered-choices').howItAffectsYou).toContain(
      'If you save without choosing, even to change something else, the draft is saved with none, as the box shows.',
    );
    expect(entry('po-edit-names-unoffered-choices').howItAffectsYou).toContain(
      "An archived supplier isn't in the list, so saving the draft removes it.",
    );
    expect(entry('recurring-template-names-unoffered-choices').howItAffectsYou).toContain(
      'If you save it without choosing, even to change something else, it is saved with none.',
    );
    expect(entry('recurring-template-names-unoffered-choices').howItAffectsYou).toContain(
      "An archived supplier isn't in the list, so saving the template removes it.",
    );
  });

  // The redesign's published fixes told every web user on 2026-10-20 that
  // "the Placed date on Purchase orders now shows your own day". This branch
  // prints the organization's day in both lists (owner question 1), so its
  // line is worded as a change from that note, not as news (slice 8 review).
  it("words the Placed date as a change from the redesign's published note", () => {
    const published = RELEASES.find((r) => r.id === 'redesign-web-fixes-2026-10');
    expect(published?.status).toBe('published');
    expect(
      published?.entries.find((e) => e.id === 'web-times-in-your-time-zone')?.whatChanged,
    ).toContain('the Placed date on Purchase orders now shows your own day');
    expect(entry('po-list-overdue-view').whatChanged).toContain(
      "The list's Placed date now shows the day in your organization's time zone, not your own, so everyone sees the same date.",
    );
  });

  // Edit event kept a wall clock and converted it back on every save, so an
  // event at the other occurrence of the repeated hour moved an hour
  // unchanged (production's form too). Told in the calendar line.
  it('says that an unchanged Edit event save no longer moves an event in the hour the clocks go back', () => {
    expect(entry('calendar-last-evening-and-zone').whatChanged).toContain(
      'In the hour the clocks go back, saving Edit event without changing its time no longer moves the event by an hour.',
    );
  });

  // Added by docs/whats-new-small-fixes-8 (2026-10-31): the words changed
  // when they were re-read against 919281a1c at publish, each with the code
  // it rests on.
  it('rests the words re-read at publish on the code', () => {
    // A phone shows only the title and the summary, and its own screens did
    // not change: the forms and the calendar are said to be on the web too.
    expect(release().summary).toContain(
      "Also on the web, editing a draft purchase order or a recurring template names a destination or supplier you can't pick there, instead of keeping it out of sight, and the team calendar shows events late on its last date.",
    );
    // The dashboard's overdue line leads to the Overdue view and no longer
    // suggests updating the ETA ("Chase your suppliers or update the ETA."):
    // only a draft can be edited, and no button moves an ordered purchase
    // order back to a draft.
    const dashboard = page('page.tsx');
    expect(dashboard).toContain('detail: OVERDUE_PO_ATTENTION_DETAIL,');
    expect(dashboard).toContain("href: '/dashboard/purchase-orders?status=overdue',");
    expect(OVERDUE_PO_ATTENTION_DETAIL).toBe(
      'Expected receipt date has passed. Chase your suppliers.',
    );
    expect(page('purchase-orders/[id]/edit/page.tsx')).toContain(
      "if ((po as { status?: string }).status !== 'draft') {",
    );
    expect(source('server/services/purchase-orders.ts')).toContain(
      "throw new ServiceError('forbidden', 'Only draft purchase orders can be edited.');",
    );
    expect(source('components/po/po-actions.tsx')).not.toContain("setStatus('draft')");
    expect(entry('po-list-overdue-view').howItAffectsYou).toContain(
      "The dashboard's line no longer suggests updating the expected date, which can't be changed once a purchase order is ordered.",
    );
    // The run's notification, in its own words, and the audit log's System
    // row for a template whose purchase order could not be saved.
    const runs = source('server/services/recurring-pos.ts');
    expect(runs).toContain(
      'created its purchase order as a draft, but it could not be sent. Open it in Purchase orders and send it.',
    );
    expect(entry('recurring-run-says-why').howItAffectsYou).toContain(
      'If it says a purchase order could not be sent, open it in Purchase orders and send it.',
    );
    expect(runs).toContain("event: 'recurring_po_template.run_skipped',");
    expect(formatAuditEvent('recurring_po_template.run_skipped')).toBe(
      'Recurring PO template · Run Skipped',
    );
    expect(page('audit/page.tsx')).toContain("if (!can(ctx, 'activity_logs:read')) {");
    expect(entry('recurring-run-says-why').howItAffectsYou).toContain(
      'A template whose purchase order could not be saved is also recorded in the audit log, for people who can view it.',
    );
    // An event's page prints in the organization's zone, as the calendar
    // does, and New event and Edit event say their zone and refuse a time
    // the clocks skip, under its field, saving nothing.
    expect(page('schedule/[id]/page.tsx')).toContain(
      'subline={formatEventRange(event.startsAt, event.endsAt, event.allDay, timeZone)}',
    );
    const form = source('components/schedule/schedule-event-form.tsx');
    expect(form).toContain('Times are in {zone}.');
    expect(form).toContain("That start time doesn't exist in ");
    expect(form).toContain('(the clocks change). Pick another time.');
    expect(form).toContain('if (!startsAtIso || nextEndError) {');
    expect(entry('calendar-last-evening-and-zone').whatChanged).toContain(
      "The calendar and each event's page place each event on its date and print its time in your organization's time zone",
    );
    expect(entry('calendar-last-evening-and-zone').howItAffectsYou).toBe(
      "Every event that starts on a date the calendar shows is on it. If you enter a time that doesn't exist in your organization's time zone, in the hour the clocks go forward, New event and Edit event say so under the field and save nothing until you choose another time.",
    );
  });
});

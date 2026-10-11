import { describe, expect, it } from 'vitest';

import {
  MODULE_REGISTRY,
  PERMISSIONS,
  type ModuleId,
  type Release,
  type ReleaseViewer,
} from '@stockpilot/core';

import { unofferedDestinationNote, unofferedSupplierNote } from '@/lib/purchase-orders/unoffered-choice';
import { TAB_LABELS } from '@/lib/purchase-orders/tabs';

import { buildReleaseList, legacyAnnouncementsFor, registryFingerprint, visibleReleases } from './logic';
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
 */
const ID = 'small-fixes-8-2026-10';
const release = () => RELEASES.find((r) => r.id === ID)!;
const entry = (id: string) => release().entries.find((e) => e.id === id)!;

const everyone: ReleaseViewer = {
  role: 'owner',
  permissions: [...PERMISSIONS],
  enabledModules: Object.keys(MODULE_REGISTRY) as ModuleId[],
};

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
  it('is a draft, so no feed carries it, and preparing it changes nothing a client can observe', () => {
    expect(release()).toBeDefined();
    expect(release().status).toBe('draft');
    expect(release().revision).toBe(1);
    expect(visibleReleases(RELEASES, everyone).map((r) => r.id)).not.toContain(ID);
    expect(buildReleaseList(RELEASES, everyone, [], null).releases.map((r) => r.id)).not.toContain(ID);
    expect(legacyAnnouncementsFor(RELEASES, everyone, {}).map((a) => a.id)).not.toContain(ID);
    expect(registryFingerprint(RELEASES)).toBe(registryFingerprint(RELEASES.filter((r) => r.id !== ID)));
  });

  it('is the newest entry, at the top, dated after every other release', () => {
    expect(RELEASES[0]?.id).toBe(ID);
    for (const r of RELEASES.slice(1)) {
      expect(Date.parse(release().publishedAt), r.id).toBeGreaterThan(Date.parse(r.publishedAt));
    }
    expect(release().publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/);
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
      href: '/dashboard/purchase-orders?status=overdue',
      label: 'Open purchase orders',
    });
    for (const id of ['po-edit-names-unoffered-choices', 'recurring-template-names-unoffered-choices', 'recurring-run-says-why']) {
      expect(entry(id).audience, id).toEqual({ anyPermission: ['purchase_orders:manage'], modules: ['purchase_orders'] });
    }
    expect(entry('recurring-template-names-unoffered-choices').link?.href).toBe('/dashboard/purchase-orders/recurring');
    expect(entry('calendar-last-evening-and-zone').audience).toEqual({
      anyPermission: ['schedule:read', 'schedule:manage'],
      modules: ['schedule'],
    });
    // The notification settings are each member's own.
    expect(entry('digest-dated-in-workspace-zone').audience).toBeUndefined();
    expect(release().audience).toBeUndefined();

    const published: Release = { ...release(), status: 'published' };
    const told = (permissions: ReleaseViewer['permissions'], modules: ModuleId[]) =>
      visibleReleases([published], { role: 'staff', permissions, enabledModules: modules })[0]?.entries.map(
        (e) => e.id,
      ) ?? [];
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
    expect(told(['purchase_orders:read', 'purchase_orders:manage'], [])).toEqual(['digest-dated-in-workspace-zone']);
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
    expect(unofferedDestinationNote('purchase_order', { name: 'Staging', why: 'not_a_site' })).toMatch(/choose a destination\.$/);
    expect(unofferedSupplierNote('template', { name: 'Acme Paper', why: 'archived' })).toMatch(/was archived, so choose a supplier\.$/);
  });

  it('claims nothing the product does not do, and never "book" for a quantity', () => {
    const text = readerText(release()).join(' ');
    expect(text).not.toMatch(/\bbook\b/i);
    expect(text).not.toMatch(/email sent|emailed|automatically sent|guarantee/i);
    // The run says why; it does not fix the template by itself.
    expect(entry('recurring-run-says-why').whatChanged).toContain('names the template and why');
    expect(entry('recurring-run-says-why').whatChanged).toContain(
      "The notification goes to your organization's owners and admins and to the person who created the template.",
    );
    // The past is told as it was: a deleted destination's template DID create
    // purchase orders (the run line says so), so the template line does not
    // say it created none (slice 8 review).
    expect(entry('recurring-template-names-unoffered-choices').whyItMatters).not.toMatch(/creates no purchase orders/);
    expect(entry('recurring-run-says-why').whatChanged).toContain('still created purchase orders to that location');
    // Make recurring already named a deleted destination (#334): only the
    // archived supplier is new there.
    expect(entry('recurring-template-names-unoffered-choices').whatChanged).toContain(
      'Make recurring names an archived supplier the same way',
    );
    // Saving with no choice keeps none, as the box shows: said plainly.
    expect(entry('po-edit-names-unoffered-choices').howItAffectsYou).toContain(
      'If you save without choosing, the draft is saved with none, as the box shows.',
    );
  });
});

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  hasPermission,
  isManagerOrAbove,
  MODULE_REGISTRY,
  PERMISSIONS,
  releaseSchema,
  ROLE_PERMISSIONS,
  type ModuleId,
  type Release,
  type ReleaseViewer,
} from '@stockpilot/core';

import { countReadScope, mayReadCount } from '@/lib/auth/count-read-scope';

import { buildReleaseList, visibleReleases } from './logic';
import { RELEASES } from './registry';

/**
 * Added by docs/whats-new-count-read-rule (2026-11-15): the release for #558
 * (squash 29cb97190, web only, no phone update, no migration), published at
 * the top, directly below the Liquid Glass draft and above the phone screens
 * by access release. Three entries:
 *
 *  - a viewer who can open Cycle counts sees their warehouses' counts in the
 *    count list (whoever can open Cycle counts);
 *  - a count with no warehouse of its own shows to the person it is assigned
 *    to (whoever assigns counts);
 *  - an email change still waiting when the password is changed shows as
 *    Expired in Settings, Profile (every member of an organization the
 *    release reaches).
 *
 * The release is addressed to organizations with Cycle counts on. Its own
 * file, so the release tests other open branches edit stay as they are.
 */
const ID = 'count-read-rule-2026-11';
const LIST_ID = 'count-list-shows-readable-warehouses';
const ASSIGNEE_ID = 'count-without-warehouse-follows-assignee';
const EMAIL_ID = 'email-change-expired-after-password-change';
const PHONE_SCREENS_ID = 'phone-screens-by-access-2026-11';

const release = () => RELEASES.find((r) => r.id === ID)!;
const entry = (entryId: string) => release().entries.find((e) => e.id === entryId)!;

const viewer = (
  role: ReleaseViewer['role'],
  permissions: ReleaseViewer['permissions'],
  enabledModules: ReleaseViewer['enabledModules'],
): ReleaseViewer => ({ role, permissions, enabledModules });
const EVERY_MODULE = Object.keys(MODULE_REGISTRY) as ModuleId[];
const owner = viewer('owner', [...PERMISSIONS], EVERY_MODULE);
const member = viewer('viewer', [], []);
const entriesFor = (v: ReleaseViewer) =>
  visibleReleases(RELEASES, v)
    .find((r) => r.id === ID)
    ?.entries.map((e) => e.id) ?? [];

const REPO = resolve(__dirname, '../../../../..');
const repoFile = (rel: string) => readFileSync(resolve(REPO, rel), 'utf8');
/** A source file under apps/web/src, as written. */
const source = (rel: string) => repoFile(`apps/web/src/${rel}`);

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

describe('the count read rule release: order, status and date', () => {
  it('is published once, as revision 1, directly below the Liquid Glass draft, the newest published release', () => {
    expect(RELEASES.filter((r) => r.id === ID)).toHaveLength(1);
    expect(release().status).toBe('published');
    expect(release().revision).toBe(1);
    expect(release().withdrawnNote).toBeUndefined();
    expect(RELEASES.slice(0, 3).map((r) => [r.id, r.status])).toEqual([
      ['liquid-glass-2026-11', 'draft'],
      [ID, 'published'],
      [PHONE_SCREENS_ID, 'published'],
    ]);
    expect(RELEASES.find((r) => r.status === 'published')?.id).toBe(ID);
  });

  it('is dated the whole minute after #558 went live, in the past, with the draft placeholder at that minute and no later release below', () => {
    // #558 is live in production since 2026-11-15 00:02Z.
    expect(release().publishedAt).toBe('2026-11-15T00:03:00Z');
    const at = Date.parse(release().publishedAt);
    expect(at).toBeGreaterThan(Date.parse('2026-11-15T00:02:00Z'));
    expect(at).toBeLessThanOrEqual(Date.now());
    expect(RELEASES[0]!.publishedAt).toBe(release().publishedAt);
    for (const r of RELEASES.slice(2)) {
      expect(at, r.id).toBeGreaterThan(Date.parse(r.publishedAt));
    }
  });

  it('parses under the shared schema, in plain text, with its three entries in order', () => {
    expect(releaseSchema.safeParse(release()).success).toBe(true);
    for (const text of readerText(release())) expect(text).not.toMatch(/[<>]/);
    expect(release().entries.map((e) => [e.id, e.category, e.area])).toEqual([
      [LIST_ID, 'fixed', 'Cycle counts'],
      [ASSIGNEE_ID, 'improved', 'Cycle counts'],
      [EMAIL_ID, 'fixed', 'Account'],
    ]);
  });
});

describe('the count read rule release: the words', () => {
  it('has a title and a summary that stand on their own', () => {
    expect(release().title).toBe('Who sees a cycle count is now the same everywhere');
    expect(release().summary).toBe(
      "The cycle count list, a count's page and count sheet, and the mobile app's list now follow one rule. A viewer who can open Cycle counts sees the counts of their warehouses, a count with no warehouse of its own shows to the person it is assigned to, and owners, admins, managers and members with access to every warehouse see every count, as before. No app update is needed.",
    );
  });

  it("says a viewer sees their warehouses' counts in the list", () => {
    const e = entry(LIST_ID);
    expect(e.title).toBe("Viewers see their warehouses' counts in the count list");
    expect(e.whatChanged).toBe(
      'A viewer who can open Cycle counts now sees the counts of the warehouses they are assigned to in the count list, on the web and in the mobile app.',
    );
    expect(e.whyItMatters).toBe(
      "The list showed only counts in warehouses a member can change, so a viewer's list was empty, although each of those counts opened from a link.",
    );
    expect(e.howItAffectsYou).toBe(
      'Staff, managers and admins see the same counts in the list as before. Who can enter numbers in a count is unchanged.',
    );
    expect(e.whatToDo).toBe('No action needed.');
  });

  it('says a count with no warehouse of its own shows to the person it is assigned to, and what to do', () => {
    const e = entry(ASSIGNEE_ID);
    expect(e.title).toBe(
      'A count with no warehouse of its own shows to the person it is assigned to',
    );
    expect(e.whatChanged).toBe(
      "A count started for All warehouses, or for a selection of items in more than one warehouse, has no warehouse of its own. It now shows only to the person it is assigned to, and to owners, admins, managers and members with access to every warehouse. The count list, the count's page, its count sheet and variance report, and the mobile app's list after its next sync all follow this.",
    );
    expect(e.whyItMatters).toBe(
      "The count list, the count's page and the mobile app each decided this in their own way, so the same count could show in one place and not in another.",
    );
    expect(e.howItAffectsYou).toBe(
      'A count of this kind that is not assigned no longer shows to members limited to some warehouses, and its link opens Page not found for them. A member with no warehouse sees no counts, including one assigned to them. A count in one warehouse shows to members who can see that warehouse, assigned or not.',
    );
    expect(e.whatToDo).toBe(
      'Assign such a count to the person who will count it: open the count and choose them under Assigned to.',
    );
  });

  it('says a waiting email change shows as Expired after a password change, with the three buttons by name', () => {
    const e = entry(EMAIL_ID);
    expect(e.title).toBe(
      'An email change still waiting when you change your password now shows as Expired',
    );
    expect(e.whatChanged).toBe(
      'If you change your password while an email change is still waiting to be confirmed, Settings, Profile on the web now shows that change under Email as Expired, with Resend verification, Use a different address and Cancel change.',
    );
    expect(e.whyItMatters).toBe(
      'A password change ends the verification links that were sent, and the Email card then showed no pending change, so there was nothing to resend or cancel.',
    );
    expect(e.howItAffectsYou).toBe(
      'Your account keeps using your current address until both addresses are confirmed. Resend verification sends new links to both addresses, and Cancel change drops the change.',
    );
    expect(e.whatToDo).toBe(
      'If you changed your password while an email change was waiting, open Settings, Profile and resend or cancel it. Otherwise no action is needed.',
    );
  });

  it('never calls a recorded quantity a book, and keeps to what people see', () => {
    const text = readerText(release()).join(' ');
    expect(text).not.toMatch(/\bbook(s|ed)?\b/i);
    expect(text).not.toMatch(/secur|vulnerab|exploit|leak|expos|attack|breach|unauthori/i);
    expect(text).not.toMatch(/[!\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  });
});

describe('the count read rule release: who is told', () => {
  it('is addressed to organizations with Cycle counts on, each entry to the people it is for', () => {
    expect(release().audience).toEqual({ modules: ['cycle_counts'] });
    // The count pages' gate: the module, and cycle_counts:read or stock:adjust.
    expect(entry(LIST_ID).audience).toEqual({
      anyPermission: ['cycle_counts:read', 'stock:adjust'],
      modules: ['cycle_counts'],
    });
    expect(entry(LIST_ID).link).toEqual({
      href: '/dashboard/cycle-counts',
      label: 'Open Cycle counts',
    });
    // Whoever assigns counts.
    expect(entry(ASSIGNEE_ID).audience).toEqual({
      anyPermission: ['cycle_counts:assign'],
      modules: ['cycle_counts'],
    });
    expect(entry(ASSIGNEE_ID).link).toEqual({
      href: '/dashboard/cycle-counts',
      label: 'Open Cycle counts',
    });
    // Every member the release reaches; the page is open to every member.
    expect(entry(EMAIL_ID).audience).toBeUndefined();
    expect(entry(EMAIL_ID).link).toEqual({
      href: '/dashboard/settings/profile',
      label: 'Open Profile settings',
    });
  });

  it('reaches each reader with the entries that are theirs, and nobody where Cycle counts is off', () => {
    expect(entriesFor(owner)).toEqual([LIST_ID, ASSIGNEE_ID, EMAIL_ID]);
    expect(entriesFor(viewer('manager', ROLE_PERMISSIONS.manager, ['cycle_counts']))).toEqual([
      LIST_ID,
      ASSIGNEE_ID,
      EMAIL_ID,
    ]);
    expect(entriesFor(viewer('staff', ROLE_PERMISSIONS.staff, ['cycle_counts']))).toEqual([
      LIST_ID,
      EMAIL_ID,
    ]);
    // A viewer given "View cycle counts" is the reader the first entry is about.
    expect(entriesFor(viewer('viewer', ['cycle_counts:read'], ['cycle_counts']))).toEqual([
      LIST_ID,
      EMAIL_ID,
    ]);
    expect(entriesFor(viewer('viewer', ROLE_PERMISSIONS.viewer, ['cycle_counts']))).toEqual([
      EMAIL_ID,
    ]);
    expect(
      entriesFor(
        viewer(
          'owner',
          [...PERMISSIONS],
          EVERY_MODULE.filter((m) => m !== 'cycle_counts'),
        ),
      ),
    ).toEqual([]);
    expect(entriesFor(member)).toEqual([]);
  });

  it('is the newest notice for a reader it reaches, and changes nothing for a reader it does not', () => {
    expect(buildReleaseList(RELEASES, owner, [], null).latestUnread?.id).toBe(ID);
    expect(
      buildReleaseList(
        RELEASES,
        viewer('staff', ROLE_PERMISSIONS.staff, ['cycle_counts']),
        [],
        null,
      ).latestUnread?.id,
    ).toBe(ID);
    expect(buildReleaseList(RELEASES, member, [], null).latestUnread?.id).toBe(PHONE_SCREENS_ID);
  });
});

describe('the count read rule release: the code the words rest on', () => {
  const all = { hasAllAccess: true, readableIds: [] };
  const some = { hasAllAccess: false, readableIds: ['w1'] };
  const noWarehouse = { hasAllAccess: false, readableIds: [] };

  it('one rule: every count for managers and members with every warehouse, else readable warehouses and a count with no warehouse only for its assignee', () => {
    // Managers and above pass no access (their role sees every warehouse).
    expect(countReadScope(null, 'u1')).toEqual({ kind: 'every' });
    expect(countReadScope(all, 'u1')).toEqual({ kind: 'every' });
    for (const role of ['owner', 'admin', 'manager'] as const) {
      expect(isManagerOrAbove(role), role).toBe(true);
    }
    const scoped = countReadScope(some, 'u1');
    expect(mayReadCount(scoped, { warehouse_id: 'w1', assigned_to: null })).toBe(true);
    expect(mayReadCount(scoped, { warehouse_id: 'w1', assigned_to: 'u2' })).toBe(true);
    expect(mayReadCount(scoped, { warehouse_id: 'w2', assigned_to: 'u1' })).toBe(false);
    expect(mayReadCount(scoped, { warehouse_id: null, assigned_to: 'u1' })).toBe(true);
    expect(mayReadCount(scoped, { warehouse_id: null, assigned_to: null })).toBe(false);
    expect(mayReadCount(scoped, { warehouse_id: null, assigned_to: 'u2' })).toBe(false);
    // A member with no warehouse sees no count, an assigned one included.
    const none = countReadScope(noWarehouse, 'u1');
    expect(none).toEqual({ kind: 'none' });
    expect(mayReadCount(none, { warehouse_id: null, assigned_to: 'u1' })).toBe(false);
  });

  it('the list, the count page and the phone sync all ask that rule, by the warehouses a member can read', () => {
    const service = source('server/services/cycle-counts.ts');
    expect(service).toContain('const scope = await readCountScope(this.ctx);');
    expect(service.split('await this.assertMayRead(h);').length - 1).toBe(2);
    expect(service).toContain("throw new ServiceError('not_found', 'Cycle count not found');");
    expect(source('server/services/lib/count-read-scope.ts')).toContain(
      'return countReadScope(access, ctx.userId);',
    );
    expect(source('app/api/v1/mobile/snapshot/route.ts')).toContain(
      'const countScope = countReadScope(access, ctx.userId);',
    );
    // A viewer reads their assigned warehouses and can change none.
    expect(source('lib/auth/warehouse.ts')).toContain(
      "const writableIds = c.role === 'viewer' ? [] : readableIds;",
    );
    // A viewer opens Cycle counts only when given the permission.
    expect(hasPermission('viewer', 'cycle_counts:read')).toBe(false);
    expect(hasPermission('viewer', 'stock:adjust')).toBe(false);
    expect(hasPermission('staff', 'cycle_counts:read')).toBe(true);
    expect(source('lib/verification/count-page-access.ts')).toContain(
      "return can(ctx, 'cycle_counts:read') || can(ctx, 'stock:adjust');",
    );
  });

  it('the words on screen: All warehouses, Assigned to, Page not found', () => {
    expect(source('components/cycle-counts/start-cycle-count-form.tsx')).toContain(
      '<SelectItem value={ALL}>All warehouses</SelectItem>',
    );
    expect(source('components/cycle-counts/cycle-count-detail.tsx')).toContain('Assigned to:');
    expect(source('app/(dashboard)/dashboard/cycle-counts/[id]/page.tsx')).toContain(
      "if (e instanceof ServiceError && e.code === 'not_found') notFound();",
    );
    expect(source('app/not-found.tsx')).toContain('Page not found');
    // Assigning is a manager's default permission, and staff do not hold it.
    expect(hasPermission('manager', 'cycle_counts:assign')).toBe(true);
    expect(hasPermission('staff', 'cycle_counts:assign')).toBe(false);
  });

  it('the Email card shows a change held without a request time as Expired, with the three buttons', () => {
    const card = source('components/settings/email-settings-card.tsx');
    expect(card).toContain('if (!props.pendingEmail) return null;');
    expect(card).toContain('pending.expiresAt === null ||');
    expect(card).toContain("{expired ? 'Expired' : 'Pending'}");
    for (const label of ['Resend verification', 'Use a different address', 'Cancel change']) {
      expect(card, label).toContain(label);
      expect(entry(EMAIL_ID).whatChanged, label).toContain(label);
    }
    expect(card).toContain('Your account keeps using ${props.email} until both are confirmed.');
    const page = source('app/(dashboard)/dashboard/settings/profile/page.tsx');
    expect(page).toContain('title="Email"');
    expect(page).toContain('<EmailSettingsCard');
  });
});

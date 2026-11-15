import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  PERMISSION_META,
  PERMISSIONS,
  releaseSchema,
  ROLE_PERMISSIONS,
  type Release,
  type ReleaseViewer,
} from '@stockpilot/core';

import { AUDIT_CATEGORIES } from '@/components/admin/audit-categories';
import { formatAuditEvent } from '@/lib/audit/format';

import { buildReleaseList, legacyAnnouncementsFor, visibleReleases } from './logic';
import { RELEASES } from './registry';

/**
 * Added by docs/whats-new-invitation-audit (2026-11-15): the What's New for
 * #579 (squash 01ead76fa, live in production since 2026-11-15 17:17:30Z),
 * published at the top, below the Liquid Glass draft and above the navigation
 * release. Web only: no phone update and no migration. Its own file, so the
 * release tests other open branches edit stay as they are.
 */
const ID = 'invitation-audit-2026-11';
const ENTRY_ID = 'invitations-in-audit-log';
const NAVIGATION_ID = 'navigation-keeps-choices-2026-11';
const PUBLISHED_AT = '2026-11-15T17:39:00Z';

const release = () => RELEASES.find((r) => r.id === ID)!;
const entry = () => release().entries.find((e) => e.id === ENTRY_ID)!;

const viewer = (
  role: ReleaseViewer['role'],
  permissions: ReleaseViewer['permissions'],
  enabledModules: ReleaseViewer['enabledModules'] = [],
): ReleaseViewer => ({ role, permissions, enabledModules });
const owner = viewer('owner', [...PERMISSIONS]);
const admin = viewer('admin', ROLE_PERMISSIONS.admin);
const manager = viewer('manager', ROLE_PERMISSIONS.manager);
const staff = viewer('staff', ROLE_PERMISSIONS.staff);
const defaultViewer = viewer('viewer', ROLE_PERMISSIONS.viewer);
const member = viewer('viewer', []);
const seesIt = (v: ReleaseViewer) => visibleReleases(RELEASES, v).some((r) => r.id === ID);

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

describe('the invitation audit release: order, status and date', () => {
  it('is published once, as revision 1, directly below the Liquid Glass draft and above the navigation release, the newest published release', () => {
    expect(RELEASES.filter((r) => r.id === ID)).toHaveLength(1);
    expect(release().status).toBe('published');
    expect(release().revision).toBe(1);
    expect(release().withdrawnNote).toBeUndefined();
    expect(RELEASES.slice(0, 3).map((r) => [r.id, r.status])).toEqual([
      ['liquid-glass-2026-11', 'draft'],
      [ID, 'published'],
      [NAVIGATION_ID, 'published'],
    ]);
    expect(RELEASES.find((r) => r.status === 'published')?.id).toBe(ID);
  });

  it('is dated on a whole minute after #579 went live, in the past, with the draft placeholder at the same minute and every release below it older', () => {
    expect(release().publishedAt).toBe(PUBLISHED_AT);
    const at = Date.parse(release().publishedAt);
    expect(at).toBeGreaterThan(Date.parse('2026-11-15T17:17:30Z'));
    expect(at).toBeLessThanOrEqual(Date.now());
    expect(RELEASES[0]!.publishedAt).toBe(release().publishedAt);
    for (const r of RELEASES.slice(2)) {
      expect(at, r.id).toBeGreaterThan(Date.parse(r.publishedAt));
    }
  });

  it('parses under the shared schema, in plain text, with its one entry', () => {
    expect(releaseSchema.safeParse(release()).success).toBe(true);
    for (const text of readerText(release())) expect(text).not.toMatch(/[<>!]/);
    expect(release().entries.map((e) => [e.id, e.category, e.area])).toEqual([
      [ENTRY_ID, 'improved', 'Audit log'],
    ]);
    expect(
      RELEASES.filter((r) => r.entries.some((x) => x.id === ENTRY_ID)).map((r) => r.id),
    ).toEqual([ID]);
  });
});

describe('the invitation audit release: the words', () => {
  it('says what the rows hold and where they are, as written', () => {
    expect(release().title).toBe('Sending and revoking an invitation now show in the Audit log');
    expect(release().summary).toBe(
      'The Audit log now records when an invitation to join your organization is sent and when one is revoked, with the invited address and role. Both rows are under the Team chip, for people who can view the audit log. No app update is needed.',
    );
    expect(entry().title).toBe('Sending and revoking an invitation now show in the Audit log');
    expect(entry().whatChanged).toBe(
      'The Audit log now has a User · Invited row for each invitation sent and a User Invite · Revoked row for each invitation revoked. The User · Invited row holds the invited address, the role, the warehouse and charter access the invitation offers, and whether the invitation email went out. The User Invite · Revoked row holds the address and role the invitation had. Resending an invitation was already recorded as User · Invited.',
    );
    expect(entry().whyItMatters).toBe(
      'You can see in the Audit log who sent or revoked each invitation, and when.',
    );
    expect(entry().howItAffectsYou).toBe(
      'Both rows are under the Team chip, with their details shown below the row. People who can view the audit log see them: owners, admins and managers by default, and anyone given View audit log. In the mobile app, the Audit log lists the same rows by event name, without the details. Nothing else about inviting or revoking changes.',
    );
    expect(entry().whatToDo).toBe(
      'No action needed. To see them, open the Audit log and choose the Team chip.',
    );
    expect(entry().link).toEqual({
      href: '/dashboard/audit?category=user',
      label: 'Open the Audit log',
    });
  });

  it('keeps to the wording rules: no emoji, no exclamation mark, no "book", no claim that an email was sent', () => {
    for (const text of readerText(release())) {
      expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
      expect(text).not.toMatch(/\bbook/i);
      expect(text).not.toMatch(/\b(we|StockPilot) (sent|emailed|sends|emails)\b/i);
    }
  });
});

describe('the invitation audit release: who is told', () => {
  it('names the permission the Audit log page checks, and no module', () => {
    expect(release().audience).toBeUndefined();
    expect(entry().audience).toEqual({ anyPermission: ['activity_logs:read'] });
  });

  it('reaches owners, admins and managers by default and anyone given View audit log, and nobody else', () => {
    for (const v of [owner, admin, manager]) expect(seesIt(v), v.role).toBe(true);
    for (const v of [staff, defaultViewer, member]) expect(seesIt(v), v.role).toBe(false);
    expect(seesIt(viewer('viewer', ['activity_logs:read']))).toBe(true);
    expect(
      seesIt(
        viewer(
          'admin',
          ROLE_PERMISSIONS.admin.filter((p) => p !== 'activity_logs:read'),
        ),
      ),
    ).toBe(false);
  });

  it('is the first notice for whoever it reaches, and the navigation release is next for owners and admins', () => {
    const read = {
      release_id: ID,
      revision: 1,
      dismissed_at: null,
      opened_at: '2026-11-15T18:00:00Z',
      read_at: '2026-11-15T18:00:00Z',
    };
    for (const v of [owner, admin, manager]) {
      expect(buildReleaseList(RELEASES, v, [], null).latestUnread?.id, v.role).toBe(ID);
    }
    for (const v of [owner, admin]) {
      expect(buildReleaseList(RELEASES, v, [read], null).latestUnread?.id, v.role).toBe(
        NAVIGATION_ID,
      );
    }
    // A reader it does not reach keeps the notice they had.
    expect(buildReleaseList(RELEASES, staff, [], null).latestUnread?.id).not.toBe(ID);
    // An older phone build shows the newest one it has not seen: this title and summary, with
    // the link to the page.
    expect(legacyAnnouncementsFor(RELEASES, manager, {})[0]).toEqual({
      id: ID,
      date: '2026-11-15',
      title: release().title,
      body: release().summary,
      cta: { href: '/dashboard/audit?category=user', label: 'Open the Audit log' },
    });
  });
});

describe('the invitation audit release: the code the words rest on', () => {
  it('the Audit log page opens with activity_logs:read and checks no module', () => {
    const page = source('apps/web/src/app/(dashboard)/dashboard/audit/page.tsx');
    expect(page).toContain("if (!can(ctx, 'activity_logs:read')) {");
    expect(page).not.toMatch(/enabledModules|isModuleEnabled|requireModule/);
    expect(PERMISSION_META['activity_logs:read'].label).toBe('View audit log');
    expect(ROLE_PERMISSIONS.manager).toContain('activity_logs:read');
    expect(ROLE_PERMISSIONS.admin).toContain('activity_logs:read');
    expect(ROLE_PERMISSIONS.staff).not.toContain('activity_logs:read');
    expect(ROLE_PERMISSIONS.viewer).not.toContain('activity_logs:read');
  });

  it('sending and revoking write the two rows, with the fields the entry names', () => {
    const team = source('apps/web/src/server/services/team.ts');
    expect(team).toContain("event: 'user.invited',");
    expect(team).toContain("event: 'user.invite.revoked',");
    expect(team).toContain('email_sent: sent.ok,');
    expect(team).toContain('charter_ids: charterIds.length > 0 ? charterIds : null,');
    expect(team).toContain(".select('id, email, role')");
  });

  it('the rows read User · Invited and User Invite · Revoked, under the Team chip', () => {
    expect(formatAuditEvent('user.invited')).toBe('User · Invited');
    expect(formatAuditEvent('user.invite.revoked')).toBe('User Invite · Revoked');
    expect(AUDIT_CATEGORIES.find((c) => c.slug === 'user')).toEqual({
      slug: 'user',
      label: 'Team',
      prefix: 'user.',
    });
  });

  it('the mobile app lists a row by its event name, without the details', () => {
    const screen = source('apps/mobile/app/(drawer)/admin/audit.tsx');
    expect(screen).toContain('{row.event}');
    expect(screen).not.toContain('MetadataDiff');
  });
});

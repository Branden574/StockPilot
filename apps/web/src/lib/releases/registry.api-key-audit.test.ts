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
import { diffMetadataFields } from '@/components/audit/metadata-diff';
import {
  formatAuditEvent,
  formatEntityType,
  recordedDetailFields,
  shortId,
} from '@/lib/audit/format';

import { buildReleaseList, legacyAnnouncementsFor, visibleReleases } from './logic';
import { RELEASES } from './registry';

/**
 * Added by docs/whats-new-api-key-audit (2026-11-15): the What's New for
 * #580 (squash 4712b6918, live in production since 2026-11-15 21:18:47Z),
 * published at the top, below the Liquid Glass draft and above the invitation
 * audit release. Web only: no phone update and no migration. Its own file, so
 * the release tests other open branches edit stay as they are.
 */
const ID = 'api-key-audit-2026-11';
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
const ENTRY_ID = 'api-keys-in-audit-log';
const INVITATION_AUDIT_ID = 'invitation-audit-2026-11';
const NAVIGATION_ID = 'navigation-keeps-choices-2026-11';
const PUBLISHED_AT = '2026-11-15T21:37:00Z';

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

describe('the API key audit release: order, status and date', () => {
  // Renamed by docs/whats-new-authenticator-set-up-first (2026-11-15; was: "is published once, as revision 1, directly below the Liquid Glass draft and above the invitation audit release, the newest published release"): the authenticator set-up release is published later, directly below the draft and above this one. Claim kept: published once, as revision 1, directly above the invitation audit release.
  it('is published once, as revision 1, directly below the authenticator set-up release (published later, below the Liquid Glass draft at the top) and above the invitation audit release', () => {
    expect(RELEASES.filter((r) => r.id === ID)).toHaveLength(1);
    expect(release().status).toBe('published');
    expect(release().revision).toBe(1);
    expect(release().withdrawnNote).toBeUndefined();
    // Re-pinned by docs/whats-new-authenticator-set-up-first (2026-11-15; was: every pinned position one place higher): the authenticator set-up release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-delete-account-confirm (2026-11-16; was: every pinned position one place higher): the delete account release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    expect(RELEASES.slice(0, 6).map((r) => [r.id, r.status])).toEqual([
      ['liquid-glass-2026-11', 'draft'],
      // Re-pinned by docs/whats-new-authenticator-set-up-first (2026-11-15; was: without it): the authenticator set-up release is published later, at the top, directly below the Liquid Glass draft.
      // Re-pinned by docs/whats-new-delete-account-confirm (2026-11-16; was: without it): the delete account release is published later, at the top, directly below the Liquid Glass draft.
      [DELETE_CONFIRM_ID, 'published'],
      [AUTH_SET_UP_ID, 'published'],
      [ID, 'published'],
      [INVITATION_AUDIT_ID, 'published'],
      [NAVIGATION_ID, 'published'],
    ]);
    // Re-pinned by docs/whats-new-authenticator-set-up-first (2026-11-15; was: ID): the authenticator set-up release is published after it, at the top, the newest published release.
    // Re-pinned by docs/whats-new-delete-account-confirm (2026-11-16; was: AUTH_SET_UP_ID): the delete account release is published after it, at the top, the newest published release.
    expect(RELEASES.find((r) => r.status === 'published')?.id).toBe(DELETE_CONFIRM_ID);
  });

  // Renamed by docs/whats-new-authenticator-set-up-first (2026-11-15; was: "is dated on a whole minute after #580 went live, in the past, with the draft placeholder at the same minute and every release below it older"): the authenticator set-up release above is dated later, and the draft placeholder moved to its minute. Claim kept: a whole minute after #580 went live, in the past, every release below it older.
  it('is dated on a whole minute after #580 went live, in the past, with the draft placeholder at or after it and every release below it older', () => {
    expect(release().publishedAt).toBe(PUBLISHED_AT);
    const at = Date.parse(release().publishedAt);
    expect(at).toBeGreaterThan(Date.parse('2026-11-15T21:18:47Z'));
    expect(at).toBeLessThanOrEqual(Date.now());
    // Re-pinned by docs/whats-new-authenticator-set-up-first (2026-11-15; was: RELEASES[0]!.publishedAt toBe this minute): the draft placeholder moved to the minute of the authenticator set-up release, published later, directly above this one.
    expect(Date.parse(RELEASES[0]!.publishedAt)).toBeGreaterThanOrEqual(at);
    // Re-pinned by docs/whats-new-authenticator-set-up-first (2026-11-15; was: every pinned position one place higher): the authenticator set-up release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-delete-account-confirm (2026-11-16; was: every pinned position one place higher): the delete account release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    for (const r of RELEASES.slice(4)) {
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

describe('the API key audit release: the words', () => {
  it('says what the rows hold and where they are, as written', () => {
    expect(release().title).toBe('Creating and revoking an API key now show in the Audit log');
    expect(release().summary).toBe(
      'The Audit log now has a row when an API key is created and when one is revoked, with who did it and when. People who can view the audit log see them. No app update is needed.',
    );
    expect(entry().title).toBe('Creating and revoking an API key now show in the Audit log');
    expect(entry().whatChanged).toBe(
      'The Audit log now has an Api Key · Created row each time an API key is created and an Api Key · Revoked row each time one is revoked, under API keys in Settings, Integrations.',
    );
    expect(entry().whyItMatters).toBe(
      'The Audit log shows who created or revoked an API key, and when.',
    );
    expect(entry().howItAffectsYou).toBe(
      'On the web, both rows are under All events, with Api Key and a short record id in the Entity column. That id is not part of the key, and the page does not show the key name. People who can view the audit log see them: owners, admins and managers by default, and anyone given View audit log. The Audit log in the mobile app lists them among its recent events as api_key.created and api_key.revoked.',
    );
    expect(entry().whatToDo).toBe(
      'No action needed. To see only one kind on the web, open the Audit log, type api_key.created or api_key.revoked in the Event filter and choose Apply.',
    );
    expect(entry().link).toEqual({ href: '/dashboard/audit', label: 'Open the Audit log' });
  });

  it('keeps to the wording rules: no emoji, no exclamation mark, no "book", no claim that an email was sent', () => {
    for (const text of readerText(release())) {
      expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
      expect(text).not.toMatch(/\bbook/i);
      expect(text).not.toMatch(/\b(we|StockPilot) (sent|emailed|sends|emails)\b/i);
    }
  });
});

describe('the API key audit release: who is told', () => {
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

  // Renamed by docs/whats-new-authenticator-set-up-first (2026-11-15; was: "is the first notice for whoever it reaches, and the invitation audit release is next"): the authenticator set-up release is published later and reaches every member, who read it first. Claim kept: the notice for whoever it reaches, and the invitation audit release next.
  // Renamed by docs/whats-new-delete-account-confirm (2026-11-16; was: "is the notice for whoever it reaches once the authenticator set-up release is read, and the invitation audit release is next"): the delete account release is published later and reaches every member, who read it first. Claim kept: the notice for whoever it reaches, and the invitation audit release next.
  it('is the notice for whoever it reaches once the delete account and authenticator set-up releases are read, and the invitation audit release is next', () => {
    const read = {
      release_id: ID,
      revision: 1,
      dismissed_at: null,
      opened_at: '2026-11-15T21:30:00Z',
      read_at: '2026-11-15T21:30:00Z',
    };
    for (const v of [owner, admin, manager]) {
      // Re-pinned by docs/whats-new-authenticator-set-up-first (2026-11-15; was: nothing read): the authenticator set-up release is published later, at the top, and reaches every member, so each reads it first, and the notice this test checks is the one it checked before.
      // Re-pinned by docs/whats-new-delete-account-confirm (2026-11-16; was: nothing read): the delete account release is published later, at the top, and reaches every member, so each reads it first, and the notice this test checks is the one it checked before.
      expect(buildReleaseList(RELEASES, v, [deleteConfirmRead, authSetUpRead], null).latestUnread?.id, v.role).toBe(
        ID,
      );
      // Re-pinned by docs/whats-new-authenticator-set-up-first (2026-11-15; was: [read]): the authenticator set-up release is read too, as above.
      // Re-pinned by docs/whats-new-delete-account-confirm (2026-11-16; was: [read]): the delete account release is read too, as above.
      expect(
        buildReleaseList(RELEASES, v, [deleteConfirmRead, authSetUpRead, read], null).latestUnread?.id,
        v.role,
      ).toBe(INVITATION_AUDIT_ID);
    }
    // A reader it does not reach keeps the notice they had.
    expect(buildReleaseList(RELEASES, staff, [], null).latestUnread?.id).not.toBe(ID);
    // An older phone build shows the newest one it has not seen: this title and summary, with
    // the link to the page.
    // Re-pinned by docs/whats-new-authenticator-set-up-first (2026-11-15; was: nothing seen): the authenticator set-up release is published later and reaches managers, so the phone has seen it first.
    // Re-pinned by docs/whats-new-delete-account-confirm (2026-11-16; was: nothing seen): the delete account release is published later and reaches managers, so the phone has seen it first.
    expect(legacyAnnouncementsFor(RELEASES, manager, { [DELETE_CONFIRM_ID]: true, [AUTH_SET_UP_ID]: true })[0]).toEqual({
      id: ID,
      date: '2026-11-15',
      title: release().title,
      body: release().summary,
      cta: { href: '/dashboard/audit', label: 'Open the Audit log' },
    });
  });
});

describe('the API key audit release: the code the words rest on', () => {
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

  it('creating and revoking write the two rows, with the fields the entry names and never the key', () => {
    const keys = source('apps/web/src/server/services/api-keys.ts');
    expect(keys).toContain(
      "{ event: 'api_key.created', entityType: 'api_key', entityId: id, extra: { name, scopes } },",
    );
    expect(keys).toContain(
      "{ event: 'api_key.revoked', entityType: 'api_key', entityId: id, extra: { name } },",
    );
    // The two audit calls name no before or after: the rows' details are the
    // name and scopes they store (recordedDetailFields), and never the key.
    expect(keys).not.toMatch(/audit\(\s*\{[^}]*\b(before|after|key|prefix|hash)\b\s*[:,]/);
  });

  it('keys are created and revoked under API keys in Settings, Integrations', () => {
    const page = source('apps/web/src/app/(dashboard)/dashboard/settings/integrations/page.tsx');
    expect(page).toContain('title="Integrations"');
    expect(page).toContain('<ApiKeysPanel');
    const panel = source('apps/web/src/components/settings/api-keys-panel.tsx');
    expect(panel).toContain('API keys');
  });

  it('the rows read API key · Created and API key · Revoked, under the Team chip, with the name and scopes as details', () => {
    expect(formatAuditEvent('api_key.created')).toBe('API key · Created');
    expect(formatAuditEvent('api_key.revoked')).toBe('API key · Revoked');
    expect(formatEntityType('api_key')).toBe('API key');
    expect(shortId('0123456789abcdef')).toBe('01234567');
    expect(
      AUDIT_CATEGORIES.filter((c) => c.prefixes.some((p) => 'api_key.created'.startsWith(p))),
    ).toEqual([expect.objectContaining({ slug: 'user', label: 'Team' })]);
    expect(AUDIT_CATEGORIES.find((c) => c.prefixes.length === 0)?.label).toBe('All events');
    // audit() writes before and after as null when the caller names neither;
    // the details are the stored name and scopes, named one by one.
    expect(diffMetadataFields(null, null)).toEqual([]);
    const stored = { before: null, after: null, name: 'Example key', scopes: ['items:read'] };
    expect(recordedDetailFields('api_key.created', stored)).toEqual([
      { field: 'name', value: 'Example key' },
      { field: 'scopes', value: ['items:read'] },
    ]);
    expect(recordedDetailFields('api_key.revoked', { name: 'Example key' })).toEqual([
      { field: 'name', value: 'Example key' },
    ]);
    const page = source('apps/web/src/app/(dashboard)/dashboard/audit/page.tsx');
    expect(page).toContain('<Label htmlFor="event">Event</Label>');
    expect(page).toContain('Apply');
  });

  it('the mobile app lists a row by its event name, without the details', () => {
    const screen = source('apps/mobile/app/(drawer)/admin/audit.tsx');
    expect(screen).toContain('{row.event}');
    expect(screen).not.toContain('MetadataDiff');
  });
});

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  authenticatorSetUpOwed,
  PERMISSIONS,
  policyRequiresAuthenticator,
  releaseSchema,
  ROLE_LABELS,
  ROLE_PERMISSIONS,
  type Release,
  type ReleaseViewer,
} from '@stockpilot/core';

import {
  AUTHENTICATOR_SET_UP_URL,
  OPEN_BEFORE_AUTHENTICATOR_SET_UP,
} from '@/lib/auth/authenticator-set-up';

import { buildReleaseList, legacyAnnouncementsFor, visibleReleases } from './logic';
import { RELEASES } from './registry';

/**
 * Added by docs/whats-new-authenticator-set-up-first (2026-11-15): the What's
 * New for #582 (squash ab57012e1, live in production since 2026-11-15
 * 23:29:54Z), published at the top, below the Liquid Glass draft and above the
 * API key audit release. Web only: no phone update and no migration. Its own
 * file, so the release tests other open branches edit stay as they are.
 */
const ID = 'authenticator-set-up-first-2026-11';
// Added by docs/whats-new-delete-account-confirm (2026-11-16): the delete account release (every member: its entry has no audience), published later, at the top, below the Liquid Glass draft.
const DELETE_CONFIRM_ID = 'delete-account-confirm-2026-11';
// Added by docs/whats-new-integrations-message-and-api-key-rows (2026-11-16): the Integrations and schedule event release (whoever can manage integrations where Integrations is on, and whoever can manage the schedule where Schedule is on), published later, at the top, below the Liquid Glass draft.
const CONNECTION_SCHEDULE_ID = 'connection-and-schedule-messages-2026-11';
const deleteConfirmRead = {
  release_id: DELETE_CONFIRM_ID,
  revision: 1,
  dismissed_at: null,
  opened_at: '2026-11-16T04:05:00Z',
  read_at: '2026-11-16T04:05:00Z',
};
const ENTRY_ID = 'authenticator-set-up-before-other-pages';
const API_KEY_AUDIT_ID = 'api-key-audit-2026-11';
const INVITATION_AUDIT_ID = 'invitation-audit-2026-11';
const PUBLISHED_AT = '2026-11-15T23:48:00Z';
const LINK = { href: '/dashboard/settings/security', label: 'Open Security settings' };

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
const everyReader = [owner, admin, manager, staff, defaultViewer, member];

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

describe('the authenticator set-up release: order, status and date', () => {
  // Renamed by docs/whats-new-delete-account-confirm (2026-11-16; was: "is published once, as revision 1, directly below the Liquid Glass draft and above the API key audit release, the newest published release"): the delete account release is published later, directly below the draft and above this one. Claim kept: published once, as revision 1, directly above the API key audit release.
  // Renamed by docs/whats-new-integrations-message-and-api-key-rows (2026-11-16; was: "is published once, as revision 1, directly below the delete account release (published later, below the Liquid Glass draft at the top) and above the API key audit release"): the Integrations and schedule event release is published later, at the top, above the delete account release. Claim kept: published once, as revision 1, directly below the delete account release and above the API key audit release.
  it('is published once, as revision 1, directly below the delete account release (published later, below the Integrations and schedule event release and the Liquid Glass draft at the top) and above the API key audit release', () => {
    expect(RELEASES.filter((r) => r.id === ID)).toHaveLength(1);
    expect(release().status).toBe('published');
    expect(release().revision).toBe(1);
    expect(release().withdrawnNote).toBeUndefined();
    // Re-pinned by docs/whats-new-delete-account-confirm (2026-11-16; was: every pinned position one place higher): the delete account release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-integrations-message-and-api-key-rows (2026-11-16; was: RELEASES.slice(0, 5)): the Integrations and schedule event release is published at the top, below the Liquid Glass draft, so the list takes one more.
    expect(RELEASES.slice(0, 6).map((r) => [r.id, r.status])).toEqual([
      ['liquid-glass-2026-11', 'draft'],
      // Re-pinned by docs/whats-new-delete-account-confirm (2026-11-16; was: without it): the delete account release is published later, at the top, directly below the Liquid Glass draft.
      // Re-pinned by docs/whats-new-integrations-message-and-api-key-rows (2026-11-16; was: without it): the Integrations and schedule event release is published later, at the top, directly below the Liquid Glass draft.
      [CONNECTION_SCHEDULE_ID, 'published'],
      [DELETE_CONFIRM_ID, 'published'],
      [ID, 'published'],
      [API_KEY_AUDIT_ID, 'published'],
      [INVITATION_AUDIT_ID, 'published'],
    ]);
    // Re-pinned by docs/whats-new-delete-account-confirm (2026-11-16; was: ID): the delete account release is published after it, at the top, the newest published release.
    // Re-pinned by docs/whats-new-integrations-message-and-api-key-rows (2026-11-16; was: DELETE_CONFIRM_ID): the Integrations and schedule event release is published after it, at the top, the newest published release.
    expect(RELEASES.find((r) => r.status === 'published')?.id).toBe(CONNECTION_SCHEDULE_ID);
  });

  // Renamed by docs/whats-new-delete-account-confirm (2026-11-16; was: "is dated on a whole minute after #582 went live, in the past, with the draft placeholder at the same minute and every release below it older"): the delete account release above is dated later, and the draft placeholder moved to its minute. Claim kept: a whole minute after #582 went live, in the past, every release below it older.
  it('is dated on a whole minute after #582 went live, in the past, with the draft placeholder at or after it and every release below it older', () => {
    expect(release().publishedAt).toBe(PUBLISHED_AT);
    const at = Date.parse(release().publishedAt);
    expect(at).toBeGreaterThan(Date.parse('2026-11-15T23:29:54Z'));
    expect(at).toBeLessThanOrEqual(Date.now());
    // Re-pinned by docs/whats-new-delete-account-confirm (2026-11-16; was: RELEASES[0]!.publishedAt toBe this minute): the draft placeholder moved to the minute of the delete account release, published later, directly above this one.
    expect(Date.parse(RELEASES[0]!.publishedAt)).toBeGreaterThanOrEqual(at);
    // Re-pinned by docs/whats-new-delete-account-confirm (2026-11-16; was: every pinned position one place higher): the delete account release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-integrations-message-and-api-key-rows (2026-11-16; was: every pinned position one place higher): the Integrations and schedule event release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    for (const r of RELEASES.slice(4)) {
      expect(at, r.id).toBeGreaterThan(Date.parse(r.publishedAt));
    }
  });

  it('parses under the shared schema, in plain text, with its one entry', () => {
    expect(releaseSchema.safeParse(release()).success).toBe(true);
    for (const text of readerText(release())) expect(text).not.toMatch(/[<>!]/);
    expect(release().entries.map((e) => [e.id, e.category, e.area])).toEqual([
      [ENTRY_ID, 'improved', 'Account'],
    ]);
    expect(
      RELEASES.filter((r) => r.entries.some((x) => x.id === ENTRY_ID)).map((r) => r.id),
    ).toEqual([ID]);
  });
});

describe('the authenticator set-up release: the words', () => {
  it('says who is taken to Settings, Security, what opens until then, and what to do, as written', () => {
    expect(release().title).toBe(
      'The website opens Security first until a required authenticator is set up',
    );
    expect(release().summary).toBe(
      'On the website, a member whose organization requires an authenticator and who has not set one up is taken to Settings, Security right after signing in, and only Security and Profile open until they set one up. In organizations set to Required for admins this applies to owners and Super Admins, and in organizations set to Required for everyone to every member. No app update is needed.',
    );
    expect(entry().title).toBe('Setting up a required authenticator comes first on the website');
    expect(entry().whatChanged).toBe(
      'On the website, a member whose organization requires an authenticator and who has not set one up is taken to Settings, Security right after signing in, after switching organization and after accepting an invitation, where the page shows Enroll to continue. Until they set one up, only Settings, Security and Settings, Profile open: every other page takes them to Settings, Security, and the search in the top bar finds no items, purchase orders, suppliers or warehouses.',
    );
    expect(entry().whyItMatters).toBe(
      'Settings, Security is where an authenticator is set up, so a member who has to set one up starts there, with the reason on the page.',
    );
    expect(entry().howItAffectsYou).toBe(
      'In organizations set to Required for admins, this applies to owners and Super Admins. In organizations set to Required for everyone, it applies to every member. In organizations set to Optional, and for members who already have an authenticator, nothing changes. Until you have set one up, Profile opens but your name, avatar and sign-in email cannot be changed there. Once you have set one up, StockPilot opens the dashboard and your pages open as usual. Owners and Super Admins choose the setting under Organization MFA policy in Settings, Security.',
    );
    expect(entry().whatToDo).toBe(
      'If you are an owner or Super Admin in an organization set to Required for admins, or any member in one set to Required for everyone, and you have not set up an authenticator, open Settings, Security, choose Set up authenticator app and follow the steps. Everyone else: no action needed.',
    );
    expect(entry().link).toEqual(LINK);
  });

  it('keeps to the wording rules: no emoji, no exclamation mark, no "book", no claim that an email was sent', () => {
    for (const text of readerText(release())) {
      expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
      expect(text).not.toMatch(/\bbook/i);
      expect(text).not.toMatch(/\b(we|StockPilot) (sent|emailed|sends|emails)\b/i);
    }
  });
});

describe('the authenticator set-up release: who is told', () => {
  it('names no audience: the rule turns on the organization policy, and the linked page is open to every member', () => {
    expect(release().audience).toBeUndefined();
    expect(entry().audience).toBeUndefined();
    // The Security page asks only for the member's context, and the settings
    // navigation lists it under Account for everyone.
    const page = source('apps/web/src/app/(dashboard)/dashboard/settings/security/page.tsx');
    expect(page).toContain('const ctx = await requireOrgContext();');
    expect(page).not.toMatch(/\bcan\(|requireModule|isModuleEnabled|checkModuleAccess/);
    expect(OPEN_BEFORE_AUTHENTICATOR_SET_UP).toContain(LINK.href);
  });

  it('reaches every member, whatever their role or permissions', () => {
    for (const v of everyReader) {
      expect(
        visibleReleases(RELEASES, v).some((r) => r.id === ID),
        v.role,
      ).toBe(true);
    }
  });

  // Renamed by docs/whats-new-delete-account-confirm (2026-11-16; was: "is the first notice for every member, the API key audit release is next for whoever can view the audit log, and an old phone build lists it first with its link"): the delete account release is published later and reaches every member, who read it first. Claim kept: the notice for every member, the API key audit release next for whoever can view the audit log, and an old phone build lists it with its link.
  it('is the notice for every member once the delete account release is read, the API key audit release is next for whoever can view the audit log, and an old phone build lists it first once that release is seen, with its link', () => {
    const read = {
      release_id: ID,
      revision: 1,
      dismissed_at: null,
      opened_at: '2026-11-15T23:45:00Z',
      read_at: '2026-11-15T23:45:00Z',
    };
    for (const v of everyReader) {
      // Re-pinned by docs/whats-new-delete-account-confirm (2026-11-16; was: nothing read): the delete account release is published later, at the top, and reaches every member, so each reads it first, and the notice this test checks is the one it checked before.
      expect(buildReleaseList(RELEASES, v, [deleteConfirmRead], null).latestUnread?.id, v.role).toBe(
        ID,
      );
    }
    for (const v of [owner, admin, manager]) {
      // Re-pinned by docs/whats-new-delete-account-confirm (2026-11-16; was: [read]): the delete account release is read too, as above.
      expect(
        buildReleaseList(RELEASES, v, [deleteConfirmRead, read], null).latestUnread?.id,
        v.role,
      ).toBe(API_KEY_AUDIT_ID);
    }
    for (const v of [staff, member]) {
      // Re-pinned by docs/whats-new-delete-account-confirm (2026-11-16; was: nothing seen): the delete account release is published later and reaches every member, so the phone has seen it first.
      expect(legacyAnnouncementsFor(RELEASES, v, { [DELETE_CONFIRM_ID]: true })[0], v.role).toEqual({
        id: ID,
        date: '2026-11-15',
        title: release().title,
        body: release().summary,
        cta: LINK,
      });
    }
  });
});

describe('the authenticator set-up release: the code the words rest on', () => {
  it('who must set one up: every member under all_required, owners and admins under admins_required, no one under optional', () => {
    for (const role of ['owner', 'admin', 'manager', 'staff', 'viewer']) {
      expect(policyRequiresAuthenticator('all_required', role), role).toBe(true);
      expect(policyRequiresAuthenticator('optional', role), role).toBe(false);
      expect(policyRequiresAuthenticator('admins_required', role), role).toBe(
        role === 'owner' || role === 'admin',
      );
    }
    // A member who already has a verified authenticator owes nothing; an
    // unverified one does not count.
    expect(authenticatorSetUpOwed('all_required', 'staff', [{ status: 'verified' }])).toBe(false);
    expect(authenticatorSetUpOwed('all_required', 'staff', [{ status: 'unverified' }])).toBe(true);
    expect(authenticatorSetUpOwed('all_required', 'staff', [])).toBe(true);
  });

  it('the policy labels and the role name, as the web shows them', () => {
    const editor = source('apps/web/src/components/settings/mfa-policy-editor.tsx');
    expect(editor).toContain("label: 'Optional',");
    expect(editor).toContain("label: 'Required for admins',");
    expect(editor).toContain("description: 'Owners and Super Admins must have MFA enrolled.',");
    expect(editor).toContain("label: 'Required for everyone',");
    expect(ROLE_LABELS.owner.label).toBe('Super Admin');
    expect(ROLE_LABELS.admin.label).toBe('Super Admin');
    const page = source('apps/web/src/app/(dashboard)/dashboard/settings/security/page.tsx');
    expect(page).toContain('title="Organization MFA policy"');
    expect(page).toContain("const isAdmin = ctx.role === 'owner' || ctx.role === 'admin';");
    expect(page).toContain('{isAdmin && (');
  });

  it('every other page sends such a member to Settings, Security with Enroll to continue; Security and Profile open', () => {
    expect(OPEN_BEFORE_AUTHENTICATOR_SET_UP).toEqual([
      '/dashboard/settings/security',
      '/dashboard/settings/profile',
    ]);
    expect(AUTHENTICATOR_SET_UP_URL).toBe('/dashboard/settings/security?enroll=1');
    const session = source('apps/web/src/lib/auth/session.ts');
    expect(session).toContain('redirect(AUTHENTICATOR_SET_UP_URL);');
    const page = source('apps/web/src/app/(dashboard)/dashboard/settings/security/page.tsx');
    expect(page).toContain('title="Security"');
    expect(page).toContain("const enrollMode = params.enroll === '1';");
    expect(page).toContain('<p className="font-medium">Enroll to continue</p>');
  });

  it('the set-up button and the dashboard once one is set up', () => {
    const enrollment = source('apps/web/src/components/settings/mfa-enrollment.tsx');
    expect(enrollment).toContain('Set up authenticator app');
    expect(enrollment).toContain("window.location.assign('/dashboard');");
  });

  it('the top-bar search answers nothing for such a member', () => {
    const route = source('apps/web/src/app/api/search/route.ts');
    expect(route).toContain('if (ctx.mfaRequired && !ctx.mfaSatisfied) {');
    expect(route).toContain(
      "return NextResponse.json({ error: 'mfa_required' }, { status: 403 });",
    );
  });
});

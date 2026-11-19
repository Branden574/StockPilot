import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  PERMISSIONS,
  releaseSchema,
  ROLE_PERMISSIONS,
  type Release,
  type ReleaseViewer,
} from '@stockpilot/core';

import { OPEN_BEFORE_AUTHENTICATOR_SET_UP } from '@/lib/auth/authenticator-set-up';
import { ACCOUNT_DELETE_CODE_RE, ACCOUNT_DELETE_CODE_TTL_S } from '@/lib/auth/account-delete-code';
import {
  DELETE_ACCOUNT_CONFIRM_COPY,
  DELETE_ACCOUNT_NEWEST_CODE_ONLY_COPY,
} from '@/components/settings/delete-account-copy';

import { buildReleaseList, legacyAnnouncementsFor, visibleReleases } from './logic';
import { RELEASES } from './registry';

/**
 * Added by docs/whats-new-delete-account-confirm (2026-11-16): the What's New
 * for #587 (squash d9917b512, live in production since 2026-11-16 04:00Z),
 * published at the top, below the Liquid Glass draft and above the
 * authenticator set-up release. Web only: no phone update and no migration.
 * Its own file, so the release tests other open branches edit stay as they
 * are.
 */
const ID = 'delete-account-confirm-2026-11';
const ENTRY_ID = 'delete-account-password-or-emailed-code';
const AUTH_SET_UP_ID = 'authenticator-set-up-first-2026-11';
const API_KEY_AUDIT_ID = 'api-key-audit-2026-11';
// Added by docs/whats-new-integrations-message-and-api-key-rows (2026-11-16): the Integrations and schedule event release, published later, at the top, below the Liquid Glass draft and above this one.
const CONNECTION_SCHEDULE_ID = 'connection-and-schedule-messages-2026-11';
// Added by docs/whats-new-emptied-fields-and-schedule-completion (2026-11-16): the emptied fields and schedule completion release (owners and admins, and managers for its location and category entries, by default), published later, at the top, below the Liquid Glass draft and above the Integrations and schedule event release.
const EMPTIED_FIELDS_ID = 'emptied-fields-and-schedule-completion-2026-11';
// Added by docs/releases-low-critical-pages (2026-11-18): the Low + critical pages and list value release (whoever can read items: every role by default), published later, at the top, below the Liquid Glass draft.
const LOW_CRITICAL_ID = 'low-critical-pages-and-list-value-2026-11';
const lowCriticalRead = {
  release_id: LOW_CRITICAL_ID,
  revision: 1,
  dismissed_at: null,
  opened_at: '2026-11-18T10:01:00Z',
  read_at: '2026-11-18T10:01:00Z',
};
// Added by docs/whats-new-small-fixes-1119 (2026-11-19): the export, receipt and access release (every member: its access entry has no audience), published later, at the top, below the Liquid Glass draft.
const EXPORT_RECEIPT_ACCESS_ID = 'export-receipt-access-fixes-2026-11';
const exportReceiptAccessRead = {
  release_id: EXPORT_RECEIPT_ACCESS_ID,
  revision: 1,
  dismissed_at: null,
  opened_at: '2026-11-19T15:31:00Z',
  read_at: '2026-11-19T15:31:00Z',
};
// Added by docs/whats-new-receiving-shown-to-managers (2026-11-19): the receiving release (whoever can open a purchase order where Receiving is on), published later, at the top, below the Liquid Glass draft.
const RECEIVING_ID = 'receiving-shown-to-managers-2026-11';
const emptiedRead = {
  release_id: EMPTIED_FIELDS_ID,
  // Re-pinned by bundles/hand-out-follows-the-manager-rule (2026-11-16; was: revision 1): the emptied fields and schedule completion release is re-announced as revision 2, so a read of it is recorded at revision 2.
  revision: 2,
  dismissed_at: null,
  opened_at: '2026-11-16T12:34:00Z',
  read_at: '2026-11-16T12:34:00Z',
};
const PUBLISHED_AT = '2026-11-16T04:03:00Z';
const LIVE_AT = '2026-11-16T04:00:00Z';
const LINK = { href: '/dashboard/settings/profile', label: 'Open Profile settings' };

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

describe('the delete account release: order, status and date', () => {
  // Renamed by docs/whats-new-integrations-message-and-api-key-rows (2026-11-16; was: "is published once, as revision 1, directly below the Liquid Glass draft and above the authenticator set-up release, the newest published release"): the Integrations and schedule event release is published later, directly below the draft and above this one. Claim kept: published once, as revision 1, directly above the authenticator set-up release.
  it('is published once, as revision 1, directly below the Integrations and schedule event release (published later, below the Liquid Glass draft at the top) and above the authenticator set-up release', () => {
    expect(RELEASES.filter((r) => r.id === ID)).toHaveLength(1);
    expect(release().status).toBe('published');
    expect(release().revision).toBe(1);
    expect(release().withdrawnNote).toBeUndefined();
    // Re-pinned by docs/whats-new-integrations-message-and-api-key-rows (2026-11-16; was: every pinned position one place higher): the Integrations and schedule event release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-emptied-fields-and-schedule-completion (2026-11-16; was: RELEASES.slice(0, 5)): the emptied fields and schedule completion release is published at the top, below the Liquid Glass draft, so the list takes one more.
    // Re-pinned by docs/releases-low-critical-pages (2026-11-18; was: RELEASES.slice(0, 6)): the Low + critical pages and list value release is published at the top, below the Liquid Glass draft, so the list takes one more.
    // Re-pinned by docs/whats-new-receiving-shown-to-managers (2026-11-19; was: RELEASES.slice(0, 7)): the receiving release is published at the top, below the Liquid Glass draft, so the list takes one more.
    // Re-pinned by docs/whats-new-small-fixes-1119 (2026-11-19; was: RELEASES.slice(0, 8)): the export, receipt and access release is published at the top, below the Liquid Glass draft, so the list takes one more.
    expect(RELEASES.slice(0, 9).map((r) => [r.id, r.status])).toEqual([
      ['liquid-glass-2026-11', 'draft'],
      // Re-pinned by docs/whats-new-small-fixes-1119 (2026-11-19; was: without it): the export, receipt and access release is published later, at the top, directly below the Liquid Glass draft.
      [EXPORT_RECEIPT_ACCESS_ID, 'published'],
      // Re-pinned by docs/whats-new-receiving-shown-to-managers (2026-11-19; was: without it): the receiving release is published later, at the top, directly below the Liquid Glass draft.
      [RECEIVING_ID, 'published'],
      // Re-pinned by docs/releases-low-critical-pages (2026-11-18; was: without it): the Low + critical pages and list value release is published later, at the top, directly below the Liquid Glass draft.
      [LOW_CRITICAL_ID, 'published'],
      // Re-pinned by docs/whats-new-emptied-fields-and-schedule-completion (2026-11-16; was: without it): the emptied fields and schedule completion release is published later, at the top, directly below the Liquid Glass draft.
      [EMPTIED_FIELDS_ID, 'published'],
      // Re-pinned by docs/whats-new-integrations-message-and-api-key-rows (2026-11-16; was: without it): the Integrations and schedule event release is published later, at the top, directly below the Liquid Glass draft.
      [CONNECTION_SCHEDULE_ID, 'published'],
      [ID, 'published'],
      [AUTH_SET_UP_ID, 'published'],
      [API_KEY_AUDIT_ID, 'published'],
    ]);
    // Re-pinned by docs/whats-new-integrations-message-and-api-key-rows (2026-11-16; was: ID): the Integrations and schedule event release is published after it, at the top, the newest published release.
    // Re-pinned by docs/whats-new-emptied-fields-and-schedule-completion (2026-11-16; was: CONNECTION_SCHEDULE_ID): the emptied fields and schedule completion release is published after it, at the top, the newest published release.
    // Re-pinned by docs/releases-low-critical-pages (2026-11-18; was: EMPTIED_FIELDS_ID): the Low + critical pages and list value release is published after it, at the top, the newest published release.
    // Re-pinned by docs/whats-new-receiving-shown-to-managers (2026-11-19; was: the Low + critical pages and list value release): the receiving release is published after it, at the top, the newest published release.
    // Re-pinned by docs/whats-new-small-fixes-1119 (2026-11-19; was: the receiving release): the export, receipt and access release is published after it, at the top, the newest published release.
    expect(RELEASES.find((r) => r.status === 'published')?.id).toBe(EXPORT_RECEIPT_ACCESS_ID);
  });

  // Renamed by docs/whats-new-integrations-message-and-api-key-rows (2026-11-16; was: "is dated on a whole minute after #587 went live, in the past, with the draft placeholder at the same minute and every release below it older"): the Integrations and schedule event release above is dated later, and the draft placeholder moved to its minute. Claim kept: a whole minute after #587 went live, in the past, every release below it older.
  it('is dated on a whole minute after #587 went live, in the past, with the draft placeholder at or after it and every release below it older', () => {
    expect(release().publishedAt).toBe(PUBLISHED_AT);
    const at = Date.parse(release().publishedAt);
    expect(at % 60_000).toBe(0);
    expect(at).toBeGreaterThan(Date.parse(LIVE_AT));
    expect(at).toBeLessThanOrEqual(Date.now());
    // Re-pinned by docs/whats-new-integrations-message-and-api-key-rows (2026-11-16; was: RELEASES[0]!.publishedAt toBe this minute): the draft placeholder moved to the minute of the Integrations and schedule event release, published later, directly above this one.
    expect(Date.parse(RELEASES[0]!.publishedAt)).toBeGreaterThanOrEqual(at);
    // Re-pinned by docs/whats-new-integrations-message-and-api-key-rows (2026-11-16; was: every pinned position one place higher): the Integrations and schedule event release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-emptied-fields-and-schedule-completion (2026-11-16; was: every pinned position one place higher): the emptied fields and schedule completion release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/releases-low-critical-pages (2026-11-18; was: RELEASES.slice(4)): the Low + critical pages and list value release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-receiving-shown-to-managers (2026-11-19; was: RELEASES.slice(5)): the receiving release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-small-fixes-1119 (2026-11-19; was: RELEASES.slice(6)): the export, receipt and access release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    for (const r of RELEASES.slice(7)) {
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

describe('the delete account release: the words', () => {
  it('says what Delete account asks for, how the emailed code works, and that the phone app is unchanged, as written', () => {
    expect(release().title).toBe('Deleting your account asks for your password or an emailed code');
    expect(release().summary).toBe(
      'On the website, Delete account in Settings, Profile now asks an account with no authenticator for its password, or for a six-digit code sent to its sign-in email. An account with an authenticator confirms with its authenticator code, as before. Nothing changes in the phone app yet.',
    );
    expect(entry().title).toBe('Deleting your account asks for your password or an emailed code');
    expect(entry().whatChanged).toBe(
      'On the website, Delete account in Settings, Profile now asks an account with no authenticator for its password. You can choose "Email me a code instead" and enter the six-digit code we send to your sign-in email. An account with an authenticator confirms with its authenticator code, as before.',
    );
    expect(entry().whyItMatters).toBe(
      'Every member can confirm deleting their own account, with an authenticator or without one.',
    );
    expect(entry().howItAffectsYou).toBe(
      'If you delete your account, have your password ready or use the emailed code. The code works for 10 minutes, and only the newest one works. If your organization requires an authenticator and you have not set one up yet, you can still delete your account from Profile. Nothing changes in the phone app yet.',
    );
    expect(entry().whatToDo).toBe(
      'No action needed. To delete your account, open Settings, Profile, choose Delete my account and follow the steps.',
    );
    expect(entry().link).toEqual(LINK);
  });

  it('keeps to the wording rules: no emoji, no exclamation mark, no "book", no claim that an email was sent, and no reason given', () => {
    for (const text of readerText(release())) {
      expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
      expect(text).not.toMatch(/\bbook/i);
      expect(text).not.toMatch(/\b(we|StockPilot) (sent|emailed|sends|emails)\b/i);
      expect(text).not.toMatch(/\b(gap|fix|fixed|protect|attack|takeover|secure|security)\b/i);
    }
  });
});

describe('the delete account release: who is told', () => {
  it('names no audience: every member can delete their own account, and the linked page is open to every member', () => {
    expect(release().audience).toBeUndefined();
    expect(entry().audience).toBeUndefined();
    // The Profile page asks only for the member's context, and it is one of
    // the two pages open before a required authenticator is set up.
    const page = source('apps/web/src/app/(dashboard)/dashboard/settings/profile/page.tsx');
    expect(page).toContain('await requireOrgContext()');
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

  // Renamed by docs/whats-new-emptied-fields-and-schedule-completion (2026-11-16; was: "is the first notice for every member, the authenticator set-up release is next, and an old phone build lists it first with its link"): the emptied fields and schedule completion release is published later, at the top, and reaches owners, admins and managers by default, so they read it first. Claim kept: the notice for every member, the authenticator set-up release next, and an old phone build lists it first with its link.
  it('is the notice for every member once the emptied fields and schedule completion release is read where it reaches, the authenticator set-up release is next, and an old phone build lists it first with its link', () => {
    const read = {
      release_id: ID,
      revision: 1,
      dismissed_at: null,
      opened_at: '2026-11-16T04:05:00Z',
      read_at: '2026-11-16T04:05:00Z',
    };
    for (const v of everyReader) {
      // Re-pinned by docs/whats-new-emptied-fields-and-schedule-completion (2026-11-16; was: nothing read, and [read]): the emptied fields and schedule completion release is published later, at the top, and reaches owners, admins and managers by default, so it is read first, and every notice this test checks is the one it checked before.
      // Re-pinned by docs/releases-low-critical-pages (2026-11-18; was: without it): the Low + critical pages and list value release is published later, at the top, and reaches whoever can read items (owners, admins, managers, staff and viewers by default), so each reads it first, and every notice this test checks is the one it checked before.
      // Re-pinned by docs/whats-new-small-fixes-1119 (2026-11-19; was: without it): the export, receipt and access release is published later, at the top, and reaches every member (its access entry has no audience), so it is read or seen first, and the notice this test checks is the one it checked before.
      expect(buildReleaseList(RELEASES, v, [exportReceiptAccessRead, lowCriticalRead, emptiedRead], null).latestUnread?.id, v.role).toBe(ID);
      expect(
        // Re-pinned by docs/whats-new-small-fixes-1119 (2026-11-19; was: without it): the export, receipt and access release is published later, at the top, and reaches every member (its access entry has no audience), so it is read or seen first, and the notice this test checks is the one it checked before.
        buildReleaseList(RELEASES, v, [exportReceiptAccessRead, lowCriticalRead, emptiedRead, read], null).latestUnread?.id,
        v.role,
      ).toBe(AUTH_SET_UP_ID);
    }
    for (const v of [staff, member]) {
      // Re-pinned by docs/releases-low-critical-pages (2026-11-18; was: nothing seen): the Low + critical pages and list value release is published later and reaches whoever can read items, so the phone has seen it first.
      // Re-pinned by docs/whats-new-small-fixes-1119 (2026-11-19; was: without it): the export, receipt and access release is published later, at the top, and reaches every member (its access entry has no audience), so it is read or seen first, and the notice this test checks is the one it checked before.
      expect(legacyAnnouncementsFor(RELEASES, v, { [EXPORT_RECEIPT_ACCESS_ID]: true, [LOW_CRITICAL_ID]: true })[0], v.role).toEqual({
        id: ID,
        date: '2026-11-16',
        title: release().title,
        body: release().summary,
        cta: LINK,
      });
    }
  });
});

describe('the delete account release: the code the words rest on', () => {
  it('the dialog words: the password, "Email me a code instead", a six-digit code to the sign-in email for 10 minutes, the newest only', () => {
    expect(DELETE_ACCOUNT_CONFIRM_COPY.passwordLabel).toBe('Your password');
    expect(DELETE_ACCOUNT_CONFIRM_COPY.emailCode).toBe('Email me a code instead');
    expect(DELETE_ACCOUNT_CONFIRM_COPY.codeSent).toContain(
      'a six-digit code to your sign-in email. It works for 10 minutes.',
    );
    expect(DELETE_ACCOUNT_NEWEST_CODE_ONLY_COPY).toBe(
      'If you ask again, only the newest code works.',
    );
    expect(DELETE_ACCOUNT_CONFIRM_COPY.codeSent).toContain(DELETE_ACCOUNT_NEWEST_CODE_ONLY_COPY);
    expect(ACCOUNT_DELETE_CODE_TTL_S).toBe(10 * 60);
    expect(ACCOUNT_DELETE_CODE_RE.test('123456')).toBe(true);
    expect(ACCOUNT_DELETE_CODE_RE.test('12345')).toBe(false);
  });

  it('the Profile card and the page for an account with no workspace show Delete my account, asking by whether the account has an authenticator', () => {
    const button = source('apps/web/src/components/settings/delete-account-button.tsx');
    expect(button).toContain('Delete my account');
    expect(button).toContain('confirmLabel="Delete account"');
    expect(button).toContain("React.useState(confirmWith === 'password')");
    // Each send keeps only the newest challenge, so only the newest code works here.
    expect(button).toContain('setChallenge(res.data.challenge);');
    const method = source('apps/web/src/lib/auth/deletion-confirm-method.ts');
    expect(method).toContain(
      "return factors?.some((f) => f.status === 'verified') ? 'authenticator' : 'password';",
    );
    const profile = source('apps/web/src/app/(dashboard)/dashboard/settings/profile/page.tsx');
    expect(profile).toContain('title="Delete account"');
    expect(profile).toContain('<DeleteAccountButton confirmWith={confirmWith} />');
    const onboarding = source('apps/web/src/app/onboarding/page.tsx');
    expect(onboarding).toContain('<DeleteAccountButton confirmWith={confirmWith} />');
  });

  it('the phone app still sends only the typed word', () => {
    const settings = source('apps/mobile/app/(drawer)/settings.tsx');
    expect(settings).toContain("body: { confirm: 'DELETE' },");
    expect(settings).not.toContain('Email me a code instead');
  });
});

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  MODULE_REGISTRY,
  PERMISSIONS,
  releaseSchema,
  ROLE_PERMISSIONS,
  type ModuleId,
  type Release,
  type ReleaseViewer,
} from '@stockpilot/core';

import { buildReleaseList, legacyAnnouncementsFor, visibleReleases } from './logic';
import { RELEASES } from './registry';

/**
 * Added by docs/whats-new-count-read-rule (2026-11-15): the email change
 * release for #558 (squash 29cb97190, web only, no phone update, no
 * migration): an email change still waiting when the password is changed
 * shows in Settings, Profile as Expired. One entry, no audience: the Email
 * card changed for every organization.
 *
 * It shares its minute with the count read rule release
 * (count-read-rule-2026-11, registry.count-read-rule.test.ts), which is the
 * newer of the two and sits directly above it, so a reader both reach is
 * offered that one first. Its own file, so the release tests other open
 * branches edit stay as they are.
 *
 * Re-pinned by docs/whats-new-unreadable-access-and-settings (2026-11-15): the
 * settings and module check releases are published later, above the count
 * read rule release and below the Liquid Glass draft. Each changed line has
 * its own note.
 */
const ID = 'email-change-expired-2026-11';
const ENTRY_ID = 'email-change-expired-after-password-change';
const COUNT_RELEASE_ID = 'count-read-rule-2026-11';
const PHONE_SCREENS_ID = 'phone-screens-by-access-2026-11';
// Added by docs/whats-new-unreadable-access-and-settings (2026-11-15): the settings release (whoever can open the settings pages and panels it names) and the module check release (every member), published later, above the count read rule release.
const SETTINGS_ID = 'settings-not-loaded-2026-11';
const MODULE_CHECK_ID = 'module-check-try-again-2026-11';
const newerRead = [SETTINGS_ID, MODULE_CHECK_ID].map((releaseId) => ({
  release_id: releaseId,
  revision: 1,
  dismissed_at: null,
  opened_at: '2026-11-15T04:30:00Z',
  read_at: '2026-11-15T04:30:00Z',
}));
const newerSeen = { [SETTINGS_ID]: true, [MODULE_CHECK_ID]: true };

const release = () => RELEASES.find((r) => r.id === ID)!;
const entry = () => release().entries.find((e) => e.id === ENTRY_ID)!;

const viewer = (
  role: ReleaseViewer['role'],
  permissions: ReleaseViewer['permissions'],
  enabledModules: ReleaseViewer['enabledModules'],
): ReleaseViewer => ({ role, permissions, enabledModules });
const EVERY_MODULE = Object.keys(MODULE_REGISTRY) as ModuleId[];
const NO_CYCLE_COUNTS = EVERY_MODULE.filter((m) => m !== 'cycle_counts');
const owner = viewer('owner', [...PERMISSIONS], EVERY_MODULE);
const admin = viewer('admin', ROLE_PERMISSIONS.admin, EVERY_MODULE);
const staff = viewer('staff', ROLE_PERMISSIONS.staff, ['cycle_counts']);
const defaultViewer = viewer('viewer', ROLE_PERMISSIONS.viewer, ['cycle_counts']);
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

/** A file in the mobile app, as written. */
const phone = (rel: string) => repoFile(`apps/mobile/${rel}`);

describe('the email change release: order, status and date', () => {
  it('is published once, as revision 1, directly below the count read rule release of the same minute and above the phone screens by access release', () => {
    expect(RELEASES.filter((r) => r.id === ID)).toHaveLength(1);
    expect(release().status).toBe('published');
    expect(release().revision).toBe(1);
    expect(release().withdrawnNote).toBeUndefined();
    // Re-pinned by docs/whats-new-unreadable-access-and-settings (2026-11-15; was: RELEASES.slice(0, 4), without them): the settings and module check releases are published later, at the top, directly below the Liquid Glass draft, so every position below them moves down by two.
    expect(RELEASES.slice(0, 6).map((r) => [r.id, r.status])).toEqual([
      ['liquid-glass-2026-11', 'draft'],
      [SETTINGS_ID, 'published'],
      [MODULE_CHECK_ID, 'published'],
      [COUNT_RELEASE_ID, 'published'],
      [ID, 'published'],
      [PHONE_SCREENS_ID, 'published'],
    ]);
  });

  it('is dated the whole minute after #558 went live, in the past, the minute of the count read rule release, with the draft placeholder at or after it and no later release below', () => {
    // #558 is live in production since 2026-11-15 00:02Z.
    expect(release().publishedAt).toBe('2026-11-15T00:03:00Z');
    const at = Date.parse(release().publishedAt);
    expect(at).toBeGreaterThan(Date.parse('2026-11-15T00:02:00Z'));
    expect(at).toBeLessThanOrEqual(Date.now());
    // Re-pinned by docs/whats-new-unreadable-access-and-settings (2026-11-15; was: every pinned position two places higher): the settings and module check releases are published at the top, below the Liquid Glass draft, so every position below them moves down by two.
    expect(RELEASES[3]!.publishedAt).toBe(release().publishedAt);
    expect(Date.parse(RELEASES[0]!.publishedAt)).toBeGreaterThanOrEqual(at);
    // Re-pinned by docs/whats-new-unreadable-access-and-settings (2026-11-15; was: every pinned position two places higher): the settings and module check releases are published at the top, below the Liquid Glass draft, so every position below them moves down by two.
    for (const r of RELEASES.slice(5)) {
      expect(at, r.id).toBeGreaterThan(Date.parse(r.publishedAt));
    }
  });

  it('parses under the shared schema, in plain text, with its one entry', () => {
    expect(releaseSchema.safeParse(release()).success).toBe(true);
    for (const text of readerText(release())) expect(text).not.toMatch(/[<>]/);
    expect(release().entries.map((e) => [e.id, e.category, e.area])).toEqual([
      [ENTRY_ID, 'fixed', 'Account'],
    ]);
    // The entry is in this release only.
    expect(
      RELEASES.filter((r) => r.entries.some((e) => e.id === ENTRY_ID)).map((r) => r.id),
    ).toEqual([ID]);
  });
});

describe('the email change release: the words', () => {
  it('has a title and a summary about the email change only, that stand on their own', () => {
    expect(release().title).toBe(
      'A waiting email change now shows as Expired after a password change',
    );
    expect(release().summary).toBe(
      "If you change your password while an email change is still waiting to be confirmed, Settings, Profile on the web now shows that change as Expired, with Resend verification, Use a different address and Cancel change. The mobile app's Email screen is unchanged, and no app update is needed.",
    );
    expect(readerText(release()).join(' ')).not.toMatch(/cycle count|warehouse/i);
  });

  it('says a waiting email change shows as Expired after a password change, with the three buttons by name', () => {
    const e = entry();
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

  it('keeps to what people see, in plain words', () => {
    const text = readerText(release()).join(' ');
    expect(text).not.toMatch(/\bbook(s|ed)?\b/i);
    expect(text).not.toMatch(/secur|vulnerab|exploit|leak|expos|attack|breach|unauthori/i);
    expect(text).not.toMatch(/[!\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  });
});

describe('the email change release: who is told', () => {
  it('has no audience, on the release or the entry, and links to a page open to every member', () => {
    expect(release().audience).toBeUndefined();
    expect(entry().audience).toBeUndefined();
    expect(entry().link).toEqual({
      href: '/dashboard/settings/profile',
      label: 'Open Profile settings',
    });
  });

  it('reaches every member of every organization, with Cycle counts on or off', () => {
    for (const v of [
      owner,
      admin,
      staff,
      defaultViewer,
      member,
      viewer('owner', [...PERMISSIONS], NO_CYCLE_COUNTS),
      viewer('admin', ROLE_PERMISSIONS.admin, NO_CYCLE_COUNTS),
      viewer('staff', ROLE_PERMISSIONS.staff, []),
    ]) {
      expect(entriesFor(v), v.role).toEqual([ENTRY_ID]);
    }
  });

  it('an organization without Cycle counts sees this release and not the count read rule release', () => {
    for (const v of [
      viewer('owner', [...PERMISSIONS], NO_CYCLE_COUNTS),
      viewer('admin', ROLE_PERMISSIONS.admin, NO_CYCLE_COUNTS),
      viewer('staff', ROLE_PERMISSIONS.staff, []),
      member,
    ]) {
      const ids = visibleReleases(RELEASES, v).map((r) => r.id);
      expect(ids, v.role).toContain(ID);
      expect(ids, v.role).not.toContain(COUNT_RELEASE_ID);
      // Re-pinned by docs/whats-new-unreadable-access-and-settings (2026-11-15; was: nothing read, nothing seen): the settings and module check releases are published later, at the top; the module check release reaches every member and the settings release reaches the owner, admin and staff here, so each reader reads and sees them first, and the notice this test checks is the one it checked before. A read of a release by a reader it does not reach changes nothing.
      expect(buildReleaseList(RELEASES, v, newerRead, null).latestUnread?.id, v.role).toBe(ID);
      // An older phone build shows the newest one it has not seen: this title and summary.
      expect(legacyAnnouncementsFor(RELEASES, v, newerSeen)[0], v.role).toEqual({
        id: ID,
        date: '2026-11-15',
        title: release().title,
        body: release().summary,
        cta: { href: '/dashboard/settings/profile', label: 'Open Profile settings' },
      });
    }
  });

  it('is the next notice for a reader the count read rule release reaches, once that one is read', () => {
    const countRead = {
      release_id: COUNT_RELEASE_ID,
      revision: 1,
      dismissed_at: null,
      opened_at: '2026-11-15T00:30:00Z',
      read_at: '2026-11-15T00:30:00Z',
    };
    for (const v of [owner, admin, staff]) {
      // Re-pinned by docs/whats-new-unreadable-access-and-settings (2026-11-15; was: nothing read, then the count read rule release read): the settings and module check releases are published later, at the top, and reach each reader here, so each reads them first, and the notices this test checks are the ones it checked before.
      expect(buildReleaseList(RELEASES, v, newerRead, null).latestUnread?.id, v.role).toBe(
        COUNT_RELEASE_ID,
      );
      expect(
        buildReleaseList(RELEASES, v, [...newerRead, countRead], null).latestUnread?.id,
        v.role,
      ).toBe(ID);
    }
  });
});

describe('the email change release: the code the words rest on', () => {
  it('the Email card shows a change held without a request time as Expired, with the three buttons', () => {
    const card = source('components/settings/email-settings-card.tsx');
    expect(card).toContain('if (!props.pendingEmail) return null;');
    expect(card).toContain('pending.expiresAt === null ||');
    expect(card).toContain("{expired ? 'Expired' : 'Pending'}");
    for (const label of ['Resend verification', 'Use a different address', 'Cancel change']) {
      expect(card, label).toContain(label);
      expect(entry().whatChanged, label).toContain(label);
      expect(release().summary, label).toContain(label);
    }
    expect(card).toContain('Your account keeps using ${props.email} until both are confirmed.');
    const page = source('app/(dashboard)/dashboard/settings/profile/page.tsx');
    expect(page).toContain('title="Email"');
    expect(page).toContain('<EmailSettingsCard');
  });

  it('resend sends both links again for the waiting address, and cancel clears the change', () => {
    const service = source('server/services/email-change.ts');
    expect(service).toContain(
      'const links = await mintEmailChangeLinks(user.email, pending, args.userId);',
    );
    expect(service).toContain(
      "admin.rpc('cancel_pending_email_change', { p_user_id: args.userId })",
    );
  });

  it("the mobile app's Email screen decides Expired from the link time alone, as it did before", () => {
    const screen = phone('app/(drawer)/settings/change-email.tsx');
    expect(screen).toContain('Settings → Email.');
    expect(screen).toContain(
      'const expired = status?.expiresAt ? now > new Date(status.expiresAt).getTime() : false;',
    );
  });
});

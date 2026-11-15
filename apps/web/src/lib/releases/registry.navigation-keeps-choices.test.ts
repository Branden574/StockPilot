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

import { buildReleaseList, legacyAnnouncementsFor, visibleReleases } from './logic';
import { RELEASES } from './registry';

/**
 * Added by docs/whats-new-navigation-keeps-choices (2026-11-15): the release
 * for #564 (squash 87b39194c, web only, no phone update, no migration).
 * Saving Settings, Navigation keeps the stored hides, renames and places of
 * the links of modules that are off, so they come back as left when the
 * module is turned on again. Reset to default still clears everything.
 *
 * It is the newest published release and sits directly below the Liquid Glass
 * draft, above the settings release for #563 (settings-not-loaded-2026-11,
 * registry.settings-not-loaded.test.ts). Its own file, so the release tests
 * other open branches edit stay as they are.
 */
const ID = 'navigation-keeps-choices-2026-11';
const ENTRY_ID = 'navigation-keeps-choices-of-modules-off';
const SETTINGS_ID = 'settings-not-loaded-2026-11';
const MODULE_CHECK_ID = 'module-check-try-again-2026-11';

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
/** A source file under apps/web/src, as written. */
const source = (rel: string) => readFileSync(resolve(REPO, `apps/web/src/${rel}`), 'utf8');

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

describe('the navigation release: order, status and date', () => {
  it('is published once, as revision 1, directly below the Liquid Glass draft and above the settings release, the newest published release', () => {
    expect(RELEASES.filter((r) => r.id === ID)).toHaveLength(1);
    expect(release().status).toBe('published');
    expect(release().revision).toBe(1);
    expect(release().withdrawnNote).toBeUndefined();
    expect(RELEASES.slice(0, 4).map((r) => [r.id, r.status])).toEqual([
      ['liquid-glass-2026-11', 'draft'],
      [ID, 'published'],
      [SETTINGS_ID, 'published'],
      [MODULE_CHECK_ID, 'published'],
    ]);
    expect(RELEASES.find((r) => r.status === 'published')?.id).toBe(ID);
  });

  it('is dated the whole minute after #564 went live, in the past, with the draft placeholder at the same minute and every release below it older', () => {
    // #564 is live in production since 2026-11-15 04:44:13Z.
    expect(release().publishedAt).toBe('2026-11-15T04:45:00Z');
    const at = Date.parse(release().publishedAt);
    expect(at).toBeGreaterThan(Date.parse('2026-11-15T04:44:13Z'));
    expect(at).toBeLessThanOrEqual(Date.now());
    expect(RELEASES[0]!.publishedAt).toBe(release().publishedAt);
    for (const r of RELEASES.slice(2)) {
      expect(at, r.id).toBeGreaterThan(Date.parse(r.publishedAt));
    }
  });

  it('parses under the shared schema, in plain text, with its one entry', () => {
    expect(releaseSchema.safeParse(release()).success).toBe(true);
    for (const text of readerText(release())) expect(text).not.toMatch(/[<>]/);
    expect(release().entries.map((e) => [e.id, e.category, e.area])).toEqual([
      [ENTRY_ID, 'fixed', 'Settings'],
    ]);
    expect(
      RELEASES.filter((r) => r.entries.some((x) => x.id === ENTRY_ID)).map((r) => r.id),
    ).toEqual([ID]);
  });
});

describe('the navigation release: the words', () => {
  it('has a title and a summary that stand on their own', () => {
    expect(release().title).toBe('Navigation keeps your choices for modules that are off');
    expect(release().summary).toBe(
      'When you save Settings, Navigation, the hides, renames and places you set for the links of a module that is turned off are now kept, so they come back as you left them when you turn the module on again. Reset to default still clears everything. No app update is needed.',
    );
  });

  it('the entry', () => {
    const e = entry();
    expect(e.title).toBe('Navigation keeps your choices for modules that are off');
    expect(e.whatChanged).toBe(
      'When you press Save changes in Settings, Navigation, the hides, renames and places you set for the links of a module that is turned off are now kept. When you turn that module on again, its links come back hidden, renamed or in the place you left them.',
    );
    expect(e.whyItMatters).toBe(
      "Navigation lists only the links of modules that are on, and before, saving it while a module was off dropped the choices you had made for that module's links.",
    );
    expect(e.howItAffectsYou).toBe(
      'Saving with nothing changed keeps your menu as it is. Reset to default still clears every choice, including those for modules that are off.',
    );
    expect(e.whatToDo).toBe(
      "No action needed. If an earlier save lost a module's hides, renames or places, set them again in Settings, Navigation once the module is on.",
    );
    expect(e.link).toEqual({
      href: '/dashboard/settings/navigation',
      label: 'Open Navigation settings',
    });
  });

  it('keeps to what people see, in plain words', () => {
    const text = readerText(release()).join(' ');
    expect(text).not.toMatch(/\bbook(s|ed)?\b/i);
    expect(text).not.toMatch(/secur|vulnerab|exploit|leak|expos|attack|breach|unauthori/i);
    expect(text).not.toMatch(/[!\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  });
});

describe('the navigation release: who is told', () => {
  it('has no release audience; the entry names who can open the page and save it', () => {
    expect(release().audience).toBeUndefined();
    expect(entry().audience).toEqual({
      roles: ['owner', 'admin'],
      anyPermission: ['organization:update'],
    });
  });

  it('reaches owners and admins, and no other default role', () => {
    expect(seesIt(owner)).toBe(true);
    expect(seesIt(admin)).toBe(true);
    for (const v of [manager, staff, defaultViewer, member]) expect(seesIt(v), v.role).toBe(false);
  });

  it('leaves out a manager granted organization:update (the save is for owners and admins) and an admin without it (the page is closed)', () => {
    expect(seesIt(viewer('manager', [...ROLE_PERMISSIONS.manager, 'organization:update']))).toBe(
      false,
    );
    expect(
      seesIt(
        viewer(
          'admin',
          ROLE_PERMISSIONS.admin.filter((p) => p !== 'organization:update'),
        ),
      ),
    ).toBe(false);
  });

  it('is the first notice for owners and admins, and the settings release is next; other roles are told the settings release first, as before', () => {
    for (const v of [owner, admin]) {
      expect(buildReleaseList(RELEASES, v, [], null).latestUnread?.id, v.role).toBe(ID);
      const read = {
        release_id: ID,
        revision: 1,
        dismissed_at: null,
        opened_at: '2026-11-15T05:00:00Z',
        read_at: '2026-11-15T05:00:00Z',
      };
      expect(buildReleaseList(RELEASES, v, [read], null).latestUnread?.id, v.role).toBe(
        SETTINGS_ID,
      );
    }
    for (const v of [manager, staff]) {
      expect(buildReleaseList(RELEASES, v, [], null).latestUnread?.id, v.role).toBe(SETTINGS_ID);
    }
    // An older phone build shows the newest one it has not seen: this title and summary, with
    // the link to the page.
    expect(legacyAnnouncementsFor(RELEASES, admin, {})[0]).toEqual({
      id: ID,
      date: '2026-11-15',
      title: release().title,
      body: release().summary,
      cta: { href: '/dashboard/settings/navigation', label: 'Open Navigation settings' },
    });
  });
});

describe('the navigation release: the code the words rest on', () => {
  it('Settings, Navigation opens with organization:update and lists the links of the modules that are on', () => {
    const page = source('app/(dashboard)/dashboard/settings/navigation/page.tsx');
    expect(page).toContain("if (!can(ctx, 'organization:update')) {");
    expect(page).toContain("resolveSurface('web_sidebar', { role: 'admin', enabledModules })");
  });

  it('the save is for owners and admins, and keeps the stored entries of links the editor did not list', () => {
    const action = source('server/actions/nav-settings.ts');
    expect(action).toContain("if (ctx.role !== 'owner' && ctx.role !== 'admin') {");
    expect(action).toContain('const merged = mergeNavOverrides(');
    const merge = source('lib/nav-overrides-merge.ts');
    expect(merge).toContain('export function mergeNavOverrides(');
    expect(merge).toContain('!decided.has(href)');
  });

  it('Save changes sends an empty setting when nothing is set, and Reset to default sends null', () => {
    const editor = source('components/settings/nav-customizer.tsx');
    expect(editor).toContain("{saving ? 'Saving…' : 'Save changes'}");
    expect(editor).toContain('Reset to default');
    expect(editor).toContain('const overrides = buildOverrides() ?? { v: 1 };');
    expect(editor).toContain('const res = await setNavOverridesAction(null);');
  });
});

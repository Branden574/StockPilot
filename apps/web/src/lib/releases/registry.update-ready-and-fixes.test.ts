import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  MODULE_REGISTRY,
  PERMISSIONS,
  type ModuleId,
  type Release,
  type ReleaseViewer,
} from '@stockpilot/core';

import { ANNOUNCEMENTS } from '@/lib/onboarding/announcements';

import {
  buildReleaseList,
  legacyAnnouncementsFor,
  registryFingerprint,
  visibleReleases,
} from './logic';
import { RELEASES } from './registry';

/**
 * docs/whats-new-2026-11-02: one release for the phone update of 2026-11-02
 * (EAS update group c5b4d663, runtime 1.4.0) and the web changes live since
 * the last What's New (web build 66b26fd665c1). The phone app asks before it
 * restarts for an update (B44 #418, whose draft release,
 * mobile-app-asks-before-restarting, is folded into this one and removed), the
 * phone fixes of B10 #403 and B60 #420, Overview's approvals row (B11 Part 1
 * #422), and the plain sentences of S16 #421 on the web. It needs a web deploy
 * only.
 *
 * Its own file, so the release tests other open branches edit stay as they
 * are. These tests pin what a published release must hold (when it was
 * published, who it reaches, the notice and the old phone builds' list), the
 * phone's own words for the update message, and the audiences as written,
 * with the checks they rest on.
 */
const ID = 'update-ready-and-fixes-2026-11';
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
/** A file in the mobile app, as written. */
const phone = (rel: string) => repoFile(`apps/mobile/${rel}`);

const DASHBOARD_APP_DIR = resolve(__dirname, '../../app/(dashboard)');
/** '/dashboard/orders?status=x' -> does app/(dashboard)/dashboard/orders/page.tsx exist? */
function pageExistsFor(href: string): boolean {
  const path = href.split('?')[0]!.replace(/\/+$/, '');
  return existsSync(resolve(DASHBOARD_APP_DIR, `.${path}`, 'page.tsx'));
}

/** A string constant a source file exports, as written there. */
function exportedString(file: string, name: string): string {
  const m = file.match(new RegExp(`export const ${name} =\\s*'([^']*)';`));
  if (!m) throw new Error(`${name} is not exported as a string`);
  return m[1]!;
}

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

/** The lines about the mobile app, and the lines about the web. */
const PHONE_ENTRIES = [
  'update-ready-message',
  'app-text-size-tabs-lists-buttons',
  'app-po-received-cancelled-words',
  'app-order-current-after-refusal',
  'app-says-why-a-save-failed',
  'app-integrations-access-denied',
  'app-clears-other-workspace-again',
];
const WEB_ENTRIES = [
  'overview-approvals-follow-permission',
  'web-unexpected-failure-plain-sentence',
  'bulk-isbn-unreadable-file',
  'ai-assistant-web-message-too-long',
];

describe('the update-ready-and-fixes release', () => {
  it('is published once, at the top, at revision 1, with the B44 draft folded in and no draft left', () => {
    expect(RELEASES[0]?.id).toBe(ID);
    expect(RELEASES.filter((r) => r.id === ID)).toHaveLength(1);
    expect(release().status).toBe('published');
    expect(release().revision).toBe(1);
    expect(release().audience).toBeUndefined();
    // The draft's id is gone and is not reused; a draft never left the
    // server, so no reader's state names it.
    expect(RELEASES.map((r) => r.id)).not.toContain('mobile-app-asks-before-restarting');
    expect(RELEASES.filter((r) => r.status === 'draft').map((r) => r.id)).toEqual([]);
  });

  it('is dated on a whole minute in the past, after the web build was live and the phone update was published, and after every release below it', () => {
    const at = Date.parse(release().publishedAt);
    expect(release().publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/);
    // Web build 66b26fd665c1 went live at 02:52:02Z; the update group was
    // published at 04:02Z.
    expect(at).toBeGreaterThan(Date.parse('2026-11-02T02:52:02Z'));
    expect(at).toBeGreaterThan(Date.parse('2026-11-02T04:02:00Z'));
    expect(at).toBeLessThanOrEqual(Date.now());
    for (const r of RELEASES.slice(1)) {
      expect(at, r.id).toBeGreaterThan(Date.parse(r.publishedAt));
    }
  });

  it('has a line for each change, most widely noticed first, with unique ids, at most twelve, and every link opening a page that exists for an audience', () => {
    const ids = release().entries.map((e) => e.id);
    expect(ids).toEqual([
      'update-ready-message',
      'app-text-size-tabs-lists-buttons',
      'overview-approvals-follow-permission',
      'app-po-received-cancelled-words',
      'app-order-current-after-refusal',
      'app-says-why-a-save-failed',
      'web-unexpected-failure-plain-sentence',
      'bulk-isbn-unreadable-file',
      'ai-assistant-web-message-too-long',
      'app-integrations-access-denied',
      'app-clears-other-workspace-again',
    ]);
    expect([...PHONE_ENTRIES, ...WEB_ENTRIES].sort()).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeLessThanOrEqual(12);
    for (const e of release().entries) {
      if (!e.link) continue;
      expect(pageExistsFor(e.link.href), e.id).toBe(true);
      expect(e.audience, e.id).toBeDefined();
    }
    // No line links, so an old phone build shows the title and the summary
    // with no button.
    expect(
      release()
        .entries.filter((e) => e.link)
        .map((e) => e.id),
    ).toEqual([]);
    // S4's line (bundle-required-component) is held until its lab walk.
    expect(ids).not.toContain('bundle-required-component');
  });

  it('reaches every member and is the first notice for each with nothing read; an old phone build shows its title and summary', () => {
    const told = (v: ReleaseViewer) =>
      visibleReleases(RELEASES, v)
        .find((r) => r.id === ID)
        ?.entries.map((e) => e.id) ?? [];
    expect(told(everyone)).toEqual(release().entries.map((e) => e.id));
    // The two lines with no audience reach a member with no permission.
    expect(told(member)).toEqual(['update-ready-message', 'app-text-size-tabs-lists-buttons']);
    for (const v of [everyone, member]) {
      expect(buildReleaseList(RELEASES, v, [], null).latestUnread?.id, v.role).toBe(ID);
      expect(legacyAnnouncementsFor(RELEASES, v, {})[0], v.role).toEqual({
        id: ID,
        date: '2026-11-02',
        title: release().title,
        body: release().summary,
      });
    }
    // Publishing it changes what clients observe.
    expect(ANNOUNCEMENTS.map((a) => a.id)).toContain(ID);
    expect(registryFingerprint(RELEASES)).toContain(`${ID}@1:published`);
    expect(registryFingerprint(RELEASES)).not.toBe(
      registryFingerprint(RELEASES.filter((r) => r.id !== ID)),
    );
  });

  // The quoted message, its title and its buttons are the phone's own words,
  // so the line changes when they do.
  it("quotes the phone's update message, its title and its two buttons word for word", () => {
    const prompt = phone('src/lib/ota-update-prompt.ts');
    const title = exportedString(prompt, 'UPDATE_PROMPT_TITLE');
    const message = exportedString(prompt, 'UPDATE_PROMPT_MESSAGE');
    const restart = exportedString(prompt, 'UPDATE_PROMPT_RESTART');
    const later = exportedString(prompt, 'UPDATE_PROMPT_LATER');
    expect([title, restart, later]).toEqual(['Update ready', 'Restart now', 'Later']);
    const e = entry('update-ready-message');
    expect(e.whatChanged).toContain(
      `a message titled ${title} says “${message}” with two buttons, ${restart} and ${later}.`,
    );
    expect(e.howItAffectsYou).toContain(`Tap ${restart} and the app restarts once`);
    expect(e.howItAffectsYou).toContain(`Tap ${later} to carry on`);
    expect(e.whatToDo).toContain(
      `when ${title} appears, tap ${restart}, or ${later} if you are busy.`,
    );
    // A phone still on the older bundle restarts by itself once when it loads
    // this update, so the message is first shown with the update after it.
    expect(e.howItAffectsYou).toMatch(/You first see it with the update after this one\.$/);
    expect(e.whatToDo).toContain('This one time the app may restart by itself once.');
  });

  it('says on each line whether it is the mobile app or the web, and the summary says both', () => {
    for (const id of PHONE_ENTRIES) {
      expect(entry(id).whatChanged, id).toMatch(/^In the mobile app, /);
      expect(entry(id).whatToDo, id).toContain('Close the app completely and open it again');
    }
    for (const id of WEB_ENTRIES) {
      expect(entry(id).whatChanged, id).toMatch(/^(On the web, |In the AI Assistant on the web, )/);
    }
    // Older phones show only the title and the summary.
    expect(release().summary).toContain('In the app, ');
    expect(release().summary).toContain('On the web, ');
    expect(release().summary).toContain(
      'Close the app completely and open it again with a connection to load the update',
    );
    // The AI line is on the web only: the phone's AI chat changes later.
    const ai = entry('ai-assistant-web-message-too-long');
    expect(ai.title).toContain('on the web');
    expect(ai.howItAffectsYou).toContain('On the web, ');
    // The open tab's rows can keep the old text size (B61, not fixed), said as
    // a limit.
    expect(entry('app-text-size-tabs-lists-buttons').howItAffectsYou).toContain(
      'may keep the old size until you open another tab or pull down to refresh',
    );
    // No App Store promise and no crash claim.
    expect(readerText(release()).join(' ')).not.toMatch(/App Store|TestFlight|crash/i);
  });

  it('names in each audience the permission, role or module its screen or action checks', () => {
    expect(entry('update-ready-message').audience).toBeUndefined();
    expect(entry('app-text-size-tabs-lists-buttons').audience).toBeUndefined();
    expect(entry('overview-approvals-follow-permission').audience).toEqual({
      roles: ['owner', 'admin', 'manager', 'staff'],
      anyPermission: ['orders:approve'],
      modules: ['orders'],
    });
    expect(entry('app-po-received-cancelled-words').audience).toEqual({
      anyPermission: ['purchase_orders:read'],
      modules: ['purchase_orders'],
    });
    expect(entry('app-order-current-after-refusal').audience).toEqual({ modules: ['orders'] });
    expect(entry('app-says-why-a-save-failed').audience).toEqual({
      anyPermission: ['stock:adjust', 'bundles:distribute'],
    });
    expect(entry('web-unexpected-failure-plain-sentence').audience).toEqual({
      anyPermission: ['items:export', 'purchase_orders:manage'],
    });
    expect(entry('bulk-isbn-unreadable-file').audience).toEqual({
      anyPermission: ['items:import'],
      modules: ['books'],
    });
    expect(entry('ai-assistant-web-message-too-long').audience).toEqual({
      anyPermission: ['items:update'],
      modules: ['ai'],
    });
    expect(entry('app-integrations-access-denied').audience).toEqual({
      roles: ['owner', 'admin'],
      modules: ['integrations'],
    });
    expect(entry('app-clears-other-workspace-again').audience).toEqual({
      anyPermission: ['bundles:read', 'bundles:distribute'],
      modules: ['bundles'],
    });

    const shown = (v: ReleaseViewer) =>
      visibleReleases(RELEASES, v)
        .find((r) => r.id === ID)
        ?.entries.map((e) => e.id) ?? [];
    // Overview's row follows the permission and is never a viewer's.
    const overview = source('app/(dashboard)/dashboard/page.tsx');
    expect(overview).toContain("const canApproveOrders = can(ctx, 'orders:approve');");
    expect(overview).toContain("const approvesOrders = canApproveOrders && ctx.role !== 'viewer';");
    expect(
      shown({ role: 'staff', permissions: ['orders:approve'], enabledModules: ['orders'] }),
    ).toContain('overview-approvals-follow-permission');
    expect(
      shown({ role: 'viewer', permissions: ['orders:approve'], enabledModules: ['orders'] }),
    ).not.toContain('overview-approvals-follow-permission');
    // The phone's Integrations screen is for owners and admins where the
    // module is on: a manager given Manage integrations still sees Admins
    // only, and is not told.
    expect(phone('app/(drawer)/settings/integrations.tsx')).toContain(
      "const allowed = enabled.has('integrations') && isAdmin;",
    );
    expect(shown({ role: 'admin', permissions: [], enabledModules: ['integrations'] })).toContain(
      'app-integrations-access-denied',
    );
    expect(
      shown({
        role: 'manager',
        permissions: ['integrations:manage'],
        enabledModules: ['integrations'],
      }),
    ).not.toContain('app-integrations-access-denied');
  });
});

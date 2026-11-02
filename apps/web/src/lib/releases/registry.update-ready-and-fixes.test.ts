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

import { computeSeenViewedMap } from '@/lib/onboarding/announcement-logic';
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
 * #422), the plain sentences of S16 #421 on the web, and #431's fallback entry
 * for S27a's Integrations page (due with this batch, as its part b has not
 * deployed). It needs a web deploy only.
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
/**
 * Added when main was merged in after #461 and #471 (2026-11-02): three
 * releases published that day are dated later than this one (04:21Z) and sit
 * above it: authenticator-code-requests-2026-11 (15:43Z, every member),
 * integration-retries-2026-11 (15:42Z, whoever manages integrations with the
 * Integrations module on) and lists-delivery-sites-and-fixes-2026-11 (05:53Z,
 * every member). releaseRegistrySchema keeps dates from increasing down the
 * list, so this release is fourth, directly above the export fixes release. A
 * test that expects it to be a reader's notice, or first in an old phone
 * build's list, reads or sees those three first (a read of a release a reader
 * is not told changes nothing).
 */
const NEWER_IDS = [
  'authenticator-code-requests-2026-11',
  'integration-retries-2026-11',
  'lists-delivery-sites-and-fixes-2026-11',
];
/**
 * Added by docs/whats-new-2026-11-02c (2026-11-02): the web fixes and archived
 * charters releases, published later that evening, sit above NEWER_IDS and
 * reach an owner. They are read with NEWER_IDS (newerReads) and stamped seen in
 * each phone state below, so every notice and list these tests check is the
 * one it checked before.
 */
const LATER_IDS = ['web-fixes-2026-11-02', 'archived-charters-2026-11'];
const newerReads = [...LATER_IDS, ...NEWER_IDS].map((id) => ({
  release_id: id,
  revision: 1,
  dismissed_at: null,
  opened_at: '2026-11-02T17:40:00Z',
  read_at: '2026-11-02T17:40:00Z',
}));

/**
 * Added in the review round after that merge (2026-11-02). Every phone build's
 * What's New is the old list (GET /api/v1/me/announcements): at most three
 * unseen releases, newest first, and every way of closing it posts all:true,
 * which stamps every published release as seen. So what a phone shows depends
 * on when it last closed What's New, as each close stamped the releases
 * published then.
 */
const PUBLISHED_IDS = RELEASES.filter((r) => r.status === 'published').map((r) => r.id);
/** A phone's seen map after a close, with these releases stamped. */
const phoneSeen = (ids: readonly string[]): Record<string, unknown> =>
  Object.fromEntries(ids.map((id) => [id, { at: '2026-11-02T00:00:00Z', outcome: 'seen' }]));
/** The published releases below this one. */
const OLDER_IDS = PUBLISHED_IDS.filter(
  (id) => id !== ID && !NEWER_IDS.includes(id) && !LATER_IDS.includes(id),
);
/** Closed What's New before #461 went live (about 15:33Z): only the older releases. */
// Re-pinned by docs/whats-new-2026-11-02c (2026-11-02; was: without LATER_IDS): the releases published later are stamped seen, so the list is the one it was.
const closedBefore461 = phoneSeen([...OLDER_IDS, ...LATER_IDS]);
/** Closed it between #461 and #471 (about 17:33Z): the lists release too. */
const closedBefore471 = phoneSeen([
  ...OLDER_IDS,
  ...LATER_IDS,
  'lists-delivery-sites-and-fixes-2026-11',
]);
/** Closed it after #471 went live: every published release but this one. */
const closedAfter471 = phoneSeen(PUBLISHED_IDS.filter((id) => id !== ID));

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
  'integrations-unsaved-changes-say-so',
];
/** The one line with a link, and where it goes. */
const INTEGRATIONS_LINK = { href: '/dashboard/settings/integrations', label: 'Open Integrations' };

describe('the update-ready-and-fixes release', () => {
  // Renamed when main was merged in after #461 and #471 (2026-11-02; was: "is published once, at the top, ...", with ID at RELEASES[0]): the three releases in NEWER_IDS are dated later and sit above it. Claim kept: published once, at revision 1, with the B44 draft folded in and no draft left.
  it('is published once, directly below the lists-delivery-sites-and-fixes release and above the export fixes release, at revision 1, with the B44 draft folded in and no draft left', () => {
    // Re-pinned when main was merged in after #461 and #471 (2026-11-02; was: RELEASES[0]): the three newer releases take 0 to 2, so this one is at 3.
    expect(RELEASES[5]?.id).toBe(ID);
    expect(RELEASES.slice(2, 5).map((r) => r.id)).toEqual(NEWER_IDS);
    expect(RELEASES[6]?.id).toBe('export-fixes-2026-10');
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
    // Re-pinned when main was merged in after #461 and #471 (2026-11-02; was: RELEASES.slice(1)): this release is at 3, so the releases below it start at 4; the three above it are dated later.
    for (const r of RELEASES.slice(6)) {
      expect(at, r.id).toBeGreaterThan(Date.parse(r.publishedAt));
    }
    for (const r of RELEASES.slice(2, 5)) {
      expect(Date.parse(r.publishedAt), r.id).toBeGreaterThan(at);
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
      'integrations-unsaved-changes-say-so',
    ]);
    expect([...PHONE_ENTRIES, ...WEB_ENTRIES].sort()).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeLessThanOrEqual(12);
    for (const e of release().entries) {
      if (!e.link) continue;
      expect(pageExistsFor(e.link.href), e.id).toBe(true);
      expect(e.audience, e.id).toBeDefined();
    }
    // One line links: #431's fallback entry, to the Integrations page.
    expect(
      release()
        .entries.filter((e) => e.link)
        .map((e) => [e.id, e.link]),
    ).toEqual([['integrations-unsaved-changes-say-so', INTEGRATIONS_LINK]]);
    expect(pageExistsFor(INTEGRATIONS_LINK.href)).toBe(true);
    // S4's line (bundle-required-component) is held until its lab walk.
    expect(ids).not.toContain('bundle-required-component');
  });

  // Renamed when main was merged in after #461 and #471 (2026-11-02; was: "reaches every member and is the first notice for each with nothing read; an old phone build shows ...", with nothing read or seen): the authenticator code and lists-delivery-sites-and-fixes releases, dated later, reach every member and come first. Claim kept: every member is told it, and an old phone build shows its title and summary, with the Integrations button only for a reader that line reaches.
  // Renamed again in the review round after that merge (2026-11-02; was: "...; an old phone build shows its title and summary once they are seen, ...", with only the three newer releases seen): only a phone that closed What's New after #471 went live has every newer release seen, so the phone half now says so and uses that phone's seen map. The phone list of every other phone is pinned in the next test.
  it("reaches every member and is the notice for each once the newer releases are read; a phone that closed What's New after they were published lists only it, with its title and summary, and the Integrations button only for a reader that line reaches", () => {
    const told = (v: ReleaseViewer) =>
      visibleReleases(RELEASES, v)
        .find((r) => r.id === ID)
        ?.entries.map((e) => e.id) ?? [];
    expect(told(everyone)).toEqual(release().entries.map((e) => e.id));
    // The two lines with no audience reach a member with no permission.
    expect(told(member)).toEqual(['update-ready-message', 'app-text-size-tabs-lists-buttons']);
    // Re-pinned when main was merged in after #461 and #471 (2026-11-02; was: ID with nothing read, and ID first on an old phone build with nothing seen): the three newer releases come first; once they are read or seen, this one is the notice and first in the list.
    for (const v of [everyone, member]) {
      expect(buildReleaseList(RELEASES, v, newerReads, null).latestUnread?.id, v.role).toBe(ID);
    }
    // The phone's list takes its button from the first line with a link that
    // the reader is told.
    expect(legacyAnnouncementsFor(RELEASES, everyone, closedAfter471)).toEqual([
      {
        id: ID,
        date: '2026-11-02',
        title: release().title,
        body: release().summary,
        cta: INTEGRATIONS_LINK,
      },
    ]);
    expect(legacyAnnouncementsFor(RELEASES, member, closedAfter471)).toEqual([
      {
        id: ID,
        date: '2026-11-02',
        title: release().title,
        body: release().summary,
      },
    ]);
    // Every phone build with What's New hides that button: the Integrations
    // page has no phone screen of its own, so the rewrite sends it home.
    expect(phone('src/components/onboarding/whats-new.tsx')).toContain(
      "const showCta = !!cta && rewriteWebPath(cta.href) !== '/';",
    );
    const rewrite = phone('src/lib/web-path-rewrite.ts');
    expect(rewrite).not.toMatch(/settings/);
    expect(rewrite).toContain("{ re: /^\\/dashboard(\\/.*)?$/, to: () => '/' },");
    // Publishing it changes what clients observe.
    expect(ANNOUNCEMENTS.map((a) => a.id)).toContain(ID);
    expect(registryFingerprint(RELEASES)).toContain(`${ID}@1:published`);
    expect(registryFingerprint(RELEASES)).not.toBe(
      registryFingerprint(RELEASES.filter((r) => r.id !== ID)),
    );
  });

  // Added in the review round after the merge with main (2026-11-02). Dated
  // 04:21Z, this release is fourth, and a phone lists at most three unseen
  // releases, so a phone that has seen none of the three newer ones never
  // shows it to a member all three reach, and any close stamps it seen. This
  // pins that cost of keeping the date, and where it is a later slide.
  it('on a phone, is never shown to a member all three newer releases reach whose phone has seen none of them, is a later slide for the others, and is stamped seen by any close', () => {
    // Every phone build reads and closes the old list, never /api/v1/me/releases,
    // and every close posts all:true, which the route answers by stamping every
    // published release.
    const whatsNew = phone('src/components/onboarding/whats-new.tsx');
    expect(whatsNew).toMatch(
      /void recordAnnouncementsSeen\(\s*items\.map\(\(i\) => i\.id\),\s*outcome,\s*true,\s*\);/,
    );
    const transport = phone('src/lib/announcements.ts');
    expect(transport).toContain("api<{ items: AnnouncementItem[] }>('/api/v1/me/announcements')");
    expect(transport).toContain(
      "await api('/api/v1/me/announcements', { method: 'POST', body: { ids, outcome, all } });",
    );
    expect(transport).not.toContain('/me/releases');
    const route = source('app/api/v1/me/announcements/route.ts');
    expect(route).toContain(
      '{ items: legacyAnnouncementsFor(RELEASES, releaseViewerFor(ctx), viewed) },',
    );
    expect(route).toContain("RELEASES.filter((r) => r.status === 'published').map((r) => r.id),");

    const listed = (v: ReleaseViewer, seen: Record<string, unknown>) =>
      legacyAnnouncementsFor(RELEASES, v, seen).map((a) => a.id);
    /** The seen map after the phone shows this list and is closed in any way. */
    const close = (v: ReleaseViewer, seen: Record<string, unknown>) =>
      computeSeenViewedMap(
        seen,
        listed(v, seen),
        'seen',
        true,
        PUBLISHED_IDS,
        '2026-11-02T19:00:00Z',
      );
    const [authenticator, retries, lists] = NEWER_IDS as [string, string, string];

    // A member all three reach (whoever manages integrations with the
    // Integrations module on, here an owner with every permission and module).
    // Re-pinned by docs/whats-new-2026-11-02c (2026-11-02; was: slice(0, 4)): the web fixes and archived charters releases are published later, at the top.
    expect(
      visibleReleases(RELEASES, everyone)
        .map((r) => r.id)
        .slice(2, 6),
    ).toEqual([...NEWER_IDS, ID]);
    // Phone last closed before #461 went live (about 15:33Z): the three newer
    // releases fill the list, and the close stamps this one, never shown.
    expect(listed(everyone, closedBefore461)).toEqual(NEWER_IDS);
    expect(close(everyone, closedBefore461)[ID]).toBeTruthy();
    expect(listed(everyone, close(everyone, closedBefore461))).toEqual([]);
    // Last closed between #461 and #471 (about 17:33Z): the third slide.
    expect(listed(everyone, closedBefore471)).toEqual([authenticator, retries, ID]);
    // Last closed after #471 went live: the only slide (the test above).
    expect(listed(everyone, closedAfter471)).toEqual([ID]);

    // A member the retries release does not reach (here a viewer with no
    // permission and no module): the third slide, then the second.
    expect(visibleReleases(RELEASES, member).map((r) => r.id)).not.toContain(retries);
    expect(listed(member, closedBefore461)).toEqual([authenticator, lists, ID]);
    expect(listed(member, closedBefore471)).toEqual([authenticator, ID]);
    expect(listed(member, closedAfter471)).toEqual([ID]);

    // Whichever slide is open when the phone closes What's New, the close
    // stamps this release, so a phone that closes before reaching it does not
    // show it again.
    for (const v of [everyone, member]) {
      for (const seen of [closedBefore461, closedBefore471, closedAfter471]) {
        const after = close(v, seen);
        expect(after[ID], v.role).toBeTruthy();
        expect(listed(v, after), v.role).toEqual([]);
      }
    }
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
    // The phone has an Overview screen and an Integrations screen of its own,
    // so the titles about the web's say so, and so does the release title,
    // which an old phone build shows (2026-11-02 review).
    expect(entry('overview-approvals-follow-permission').title).toMatch(/^On the web, /);
    expect(entry('integrations-unsaved-changes-say-so').title).toMatch(/^On the web, /);
    expect(release().title).toMatch(/; web Overview counts approvals$/);
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
    expect(entry('integrations-unsaved-changes-say-so').audience).toEqual({
      anyPermission: ['integrations:manage', 'shipping:manage'],
      modules: ['integrations', 'shipping'],
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
    // The web's Integrations page opens for Manage integrations or Manage
    // shipping, and shows its module-off notice unless the integrations or the
    // shipping module is on (or API access, for owners and admins only).
    const integrationsPage = source('app/(dashboard)/dashboard/settings/integrations/page.tsx');
    expect(integrationsPage).toContain(
      "if (!can(ctx, 'integrations:manage') && !can(ctx, 'shipping:manage') && !showApiKeys) {",
    );
    expect(integrationsPage).toContain(
      'if (!integrationsAccess.enabled && !shippingAccess.enabled && !apiAccessAccess.enabled) {',
    );
    expect(integrationsPage).toContain(
      'const showApiKeys = apiAccessAccess.enabled && isAdminRole(ctx.role);',
    );
    // A manager given only Manage shipping, with both modules on, is told.
    expect(
      shown({
        role: 'manager',
        permissions: ['shipping:manage'],
        enabledModules: ['integrations', 'shipping'],
      }),
    ).toContain('integrations-unsaved-changes-say-so');
    // A member with neither key, or with neither module on, is not.
    expect(
      shown({ role: 'staff', permissions: ['items:read'], enabledModules: ['integrations'] }),
    ).not.toContain('integrations-unsaved-changes-say-so');
    expect(
      shown({ role: 'admin', permissions: ['integrations:manage'], enabledModules: ['orders'] }),
    ).not.toContain('integrations-unsaved-changes-say-so');
  });

  // #431's fallback entry quotes the services' own refusal, and each change
  // it names is one the web's cards offer and the services refuse with it.
  it("quotes the Integrations page's refusal word for word, for the changes that used to show as done", () => {
    const e = entry('integrations-unsaved-changes-say-so');
    const refused = exportedString(
      source('server/services/integration-events.ts'),
      'INTEGRATION_WRITE_REFUSED',
    );
    expect(refused).toBe(
      'This change was not saved: your access does not allow it. Ask an owner or an admin.',
    );
    expect(e.whatChanged).toContain(
      `the Integrations page now says “${refused}” Before, it showed as done.`,
    );
    // A disconnect, the QuickBooks account mapping and the Sage Intacct
    // settings each ask for the row they changed and refuse when there is none.
    const connections = source('server/services/connections.ts');
    expect(
      connections.match(
        /if \(!updated\) throw new ServiceError\('forbidden', INTEGRATION_WRITE_REFUSED\);/g,
      ),
    ).toHaveLength(3);
    // The cards call these actions, which pass a ServiceError's own words on.
    const panel = source('components/settings/integrations-panel.tsx');
    const intacct = source('components/settings/sage-intacct-card.tsx');
    expect(panel).toContain("const res = await disconnectAction({ provider: 'quickbooks' });");
    expect(panel).toContain('const res = await saveAccountMappingAction({');
    expect(panel).toContain('const res = await disconnectEasyPostAction();');
    expect(intacct).toContain("const res = await disconnectAction({ provider: 'sage_intacct' });");
    expect(intacct).toContain('const res = await saveIntacctSettingsAction({');
    expect(source('server/actions/connections.ts')).toContain(
      'if (e instanceof ServiceError) return err(e.code, e.message, e.details);',
    );
    // The plan's other example, rotating a webhook secret, has no button.
    expect(e.whatChanged).not.toMatch(/webhook|rotat/i);
    expect(source('components/settings/webhooks-panel.tsx')).not.toContain(
      'rotateIntegrationEndpointSecretAction',
    );
    // With both modules on, the page's failed-sync list takes the manage key
    // of each module that is on, so a member who holds only Manage shipping
    // opens the page.
    expect(connections).toContain(
      "if (this.ctx.enabledModules.has('shipping')) keys.push('shipping:manage');",
    );
    expect(connections).toContain('assertAnyPermission(this.ctx, keys);');
    expect(e.whatChanged).toContain(
      'A member who can manage only shipping can now open the Integrations page when Integrations is also switched on.',
    );
  });
});

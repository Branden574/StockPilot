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

import { buildReleaseList, registryFingerprint, visibleReleases } from './logic';
import { RELEASES } from './registry';

/**
 * Added by docs/whats-new-2026-11-02c (2026-11-02): two releases published
 * at the top, above the authenticator code release.
 *
 * - web-fixes-2026-11-02: B20a, #455 (squash 1ce98c290, live 18:23:56Z), the
 *   per-person New rental cart, and S45, #468 (squash 3549b480d, live
 *   20:20:50Z), a logo too large to print refused under Settings. The newest
 *   release, at the top.
 * - archived-charters-2026-11: S44, #467 (squash c4323b76a, live 18:29:46Z),
 *   archived charters named and kept on Team and the item and book forms.
 *   Directly below.
 *
 * No phone update ships with either. Its own file, so the release tests other
 * open branches edit stay as they are. These tests pin each release's ids,
 * status, revision, date and order, who each entry reaches, and the code its
 * words rest on.
 */
const WEB_FIXES_ID = 'web-fixes-2026-11-02';
const CHARTERS_ID = 'archived-charters-2026-11';
const AUTH_CODE_ID = 'authenticator-code-requests-2026-11';
const byId = (id: string) => RELEASES.find((r) => r.id === id)!;

const everyone: ReleaseViewer = {
  role: 'owner',
  permissions: [...PERMISSIONS],
  enabledModules: Object.keys(MODULE_REGISTRY) as ModuleId[],
};
/** A member who holds no permission and no module. */
const member: ReleaseViewer = { role: 'viewer', permissions: [], enabledModules: [] };
/** Staff who check out rentals where the Rentals module is on. */
const renter: ReleaseViewer = {
  role: 'staff',
  permissions: ['rentals:create'],
  enabledModules: ['rentals'],
};
/** The same, with the Rentals module off. */
const renterModuleOff: ReleaseViewer = {
  role: 'staff',
  permissions: ['rentals:create'],
  enabledModules: [],
};
/** Staff who edit items. */
const itemEditor: ReleaseViewer = {
  role: 'staff',
  permissions: ['items:update'],
  enabledModules: [],
};
/** An admin who invites members. */
const admin: ReleaseViewer = {
  role: 'admin',
  permissions: ['members:invite'],
  enabledModules: [],
};
/** A manager who holds members:invite but is not an owner or an admin. */
const managerWithInvite: ReleaseViewer = {
  role: 'manager',
  permissions: ['members:invite'],
  enabledModules: [],
};

/** A file in the repository, as written. */
const REPO = resolve(__dirname, '../../../../..');
const repoFile = (rel: string) => readFileSync(resolve(REPO, rel), 'utf8');
/** A source file under apps/web/src, as written. */
const source = (rel: string) => repoFile(`apps/web/src/${rel}`);

/** '/dashboard/orders?x=y' -> does app/(dashboard)/dashboard/orders/page.tsx exist? */
const DASHBOARD_APP_DIR = resolve(__dirname, '../../app/(dashboard)');
function pageExistsFor(href: string): boolean {
  const path = href.split('?')[0]!.replace(/\/+$/, '');
  return existsSync(resolve(DASHBOARD_APP_DIR, `.${path}`, 'page.tsx'));
}

/** Every string a reader can see in a release. */
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

/** Each entry answers all four questions, with its own id. */
function expectFourAnswers(r: Release): void {
  expect(new Set(r.entries.map((e) => e.id)).size).toBe(r.entries.length);
  for (const e of r.entries) {
    expect(e.whatChanged.length, e.id).toBeGreaterThan(0);
    expect(e.whyItMatters.length, e.id).toBeGreaterThan(0);
    expect(e.howItAffectsYou.length, e.id).toBeGreaterThan(0);
    expect(e.whatToDo.length, e.id).toBeGreaterThan(8);
  }
}

/** Every link opens a dashboard page that exists, and says who can reach it. */
function expectLinksReachable(r: Release): void {
  const known = new Set<string>(PERMISSIONS);
  for (const e of r.entries.filter((x) => x.link)) {
    expect(e.link!.href, e.id).toMatch(/^\/dashboard(\/|$)/);
    expect(pageExistsFor(e.link!.href), `${e.id} -> ${e.link!.href}`).toBe(true);
    const audience = e.audience ?? r.audience;
    expect(audience, e.id).toBeDefined();
    expect(audience?.anyPermission?.length ?? 0, e.id).toBeGreaterThan(0);
    for (const p of audience?.anyPermission ?? []) {
      expect(known.has(p), `${e.id}: ${p}`).toBe(true);
    }
    for (const m of audience?.modules ?? []) {
      expect(Object.keys(MODULE_REGISTRY), `${e.id}: ${m}`).toContain(m);
    }
  }
}

const entriesFor = (id: string, v: ReleaseViewer) =>
  visibleReleases(RELEASES, v)
    .find((r) => r.id === id)
    ?.entries.map((e) => e.id);

describe('the two releases of 2026-11-02 evening: order, status and dates', () => {
  it('are published once each, as revision 1, at the top in date order, above the authenticator code release', () => {
    for (const id of [WEB_FIXES_ID, CHARTERS_ID]) {
      expect(
        RELEASES.filter((r) => r.id === id),
        id,
      ).toHaveLength(1);
      expect(byId(id).status, id).toBe('published');
      expect(byId(id).revision, id).toBe(1);
    }
    expect(RELEASES[0]?.id).toBe(WEB_FIXES_ID);
    expect(RELEASES[1]?.id).toBe(CHARTERS_ID);
    expect(RELEASES[2]?.id).toBe(AUTH_CODE_ID);
    expect(RELEASES.find((r) => r.status === 'published')?.id).toBe(WEB_FIXES_ID);
  });

  it('are dated in the past on a whole minute, each after its changes went live, and after every release below', () => {
    const web = Date.parse(byId(WEB_FIXES_ID).publishedAt);
    const charters = Date.parse(byId(CHARTERS_ID).publishedAt);
    for (const id of [WEB_FIXES_ID, CHARTERS_ID]) {
      expect(byId(id).publishedAt, id).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/);
      expect(Date.parse(byId(id).publishedAt), id).toBeLessThanOrEqual(Date.now());
    }
    // #455 went live at 18:23:56Z and #468 at 20:20:50Z; #467 at 18:29:46Z.
    expect(web).toBeGreaterThan(Date.parse('2026-11-02T18:23:56Z'));
    expect(web).toBeGreaterThan(Date.parse('2026-11-02T20:20:50Z'));
    expect(charters).toBeGreaterThan(Date.parse('2026-11-02T18:29:46Z'));
    expect(web).toBeGreaterThan(charters);
    expect(web).toBe(Math.max(...RELEASES.map((r) => Date.parse(r.publishedAt))));
    for (const r of RELEASES.slice(2)) {
      expect(charters, r.id).toBeGreaterThan(Date.parse(r.publishedAt));
    }
  });

  it('are in the fingerprint, so publishing them changes what clients observe', () => {
    for (const id of [WEB_FIXES_ID, CHARTERS_ID]) {
      expect(registryFingerprint(RELEASES)).toContain(`${id}@1:published`);
    }
  });
});

describe('the web fixes release (B20a and S45)', () => {
  const release = () => byId(WEB_FIXES_ID);

  it('has its two entries, each answering all four questions', () => {
    expect(release().entries.map((e) => e.id)).toEqual([
      'rental-cart-per-person',
      'logo-too-large-to-print',
    ]);
    expectFourAnswers(release());
    expect(release().audience).toBeUndefined();
    expectLinksReachable(release());
    expect(release().summary).toMatch(/^On the web, /);
  });

  it('tells whoever can open New rental about the cart, with the check New rental makes', () => {
    const cart = release().entries[0]!;
    expect([cart.category, cart.area]).toEqual(['fixed', 'Rentals']);
    expect(cart.link).toEqual({ href: '/dashboard/rentals/new', label: 'Open New rental' });
    expect(cart.audience).toEqual({ anyPermission: ['rentals:create'], modules: ['rentals'] });
    expect(cart.whatToDo).toBe('No action needed.');
    const page = source('app/(dashboard)/dashboard/rentals/new/page.tsx');
    expect(page).toContain("if (!can(ctx, 'rentals:create')) {");
    expect(page).toContain("const moduleAccess = await checkModuleAccess('rentals');");
    expect(page).toContain('viewerUserId={ctx.userId}');
  });

  it('tells owners and admins about the logo, with no link', () => {
    const logo = release().entries[1]!;
    expect([logo.category, logo.area]).toEqual(['improved', 'Settings']);
    expect(logo.link).toBeUndefined();
    expect(logo.audience).toEqual({ roles: ['owner', 'admin'] });
    expect(source('app/(dashboard)/dashboard/settings/organization/page.tsx')).toContain(
      "if (ctx.role !== 'owner' && ctx.role !== 'admin') {",
    );
  });

  it('reaches each reader with only the entries they can use', () => {
    expect(entriesFor(WEB_FIXES_ID, everyone)).toEqual([
      'rental-cart-per-person',
      'logo-too-large-to-print',
    ]);
    expect(entriesFor(WEB_FIXES_ID, renter)).toEqual(['rental-cart-per-person']);
    expect(entriesFor(WEB_FIXES_ID, admin)).toEqual(['logo-too-large-to-print']);
    expect(entriesFor(WEB_FIXES_ID, renterModuleOff)).toBeUndefined();
    expect(entriesFor(WEB_FIXES_ID, member)).toBeUndefined();
    expect(buildReleaseList(RELEASES, everyone, [], null).latestUnread?.id).toBe(WEB_FIXES_ID);
  });

  it('rests on the per-person cart key and the old key removed unread', () => {
    const cart = source('components/orders/v2/cart-context.tsx');
    expect(cart).toContain(
      'export function rentalDraftPrefixFor(userId: string): string {\n  return `${RENTAL_DRAFT_PREFIX}v2:${userId}:`;',
    );
    const form = source('components/rentals/rental-create-form.tsx');
    expect(form).toContain(
      'localStorage.removeItem(`${RENTAL_DRAFT_PREFIX}${props.warehouseId}`);',
    );
    expect(form).toContain('draftPrefix={rentalDraftPrefixFor(props.viewerUserId)}');
  });

  it('rests on the upload refusing a logo over 50 million pixels with the sentence it quotes', () => {
    const action = source('server/actions/profile.ts');
    expect(action).toContain(
      'That logo is too large to print (${size.width} by ${size.height} pixels). Save a copy of at most 50 million pixels, such as 7000 by 7000, and upload it again.',
    );
    expect(action).toContain(
      "if (sniffed.kind === 'png' || sniffed.kind === 'jpeg' || sniffed.kind === 'webp') {",
    );
    expect(action).toContain('await logos.remove([objectPath]);');
    const decode = source('lib/image-decode.ts');
    for (const kind of ['png', 'jpeg', 'webp']) {
      expect(decode).toContain(`  ${kind}: 50_000_000,`);
    }
    expect(release().entries[1]!.whatToDo).toContain(
      'save a copy of at most 50 million pixels, such as 7000 by 7000, and upload it again.',
    );
  });

  it('promises no phone update and never says book for a recorded quantity', () => {
    const text = readerText(release()).join(' ');
    expect(text).not.toMatch(/mobile app|phone|App Store|TestFlight|\bbook(ed)?\b/i);
  });
});

describe('the archived charters release (S44)', () => {
  const release = () => byId(CHARTERS_ID);

  it('has its two entries, each answering all four questions', () => {
    expect(release().entries.map((e) => e.id)).toEqual([
      'team-charters-archived-kept',
      'item-form-archived-charter-named',
    ]);
    expectFourAnswers(release());
    expect(release().audience).toBeUndefined();
    expectLinksReachable(release());
    expect(release().summary).toMatch(/^On the web, /);
    for (const e of release().entries) {
      expect(e.category, e.id).toBe('fixed');
      expect(e.whatToDo, e.id).toBe('No action needed.');
    }
  });

  it('tells owners and admins who manage Team about the dialog, and item editors about the forms', () => {
    const [team, form] = release().entries;
    expect(team!.area).toBe('Team');
    expect(team!.link).toEqual({ href: '/dashboard/team', label: 'Open Team' });
    expect(team!.audience).toEqual({
      roles: ['owner', 'admin'],
      anyPermission: ['members:invite'],
    });
    expect(form!.area).toBe('Inventory');
    expect(form!.link).toEqual({ href: '/dashboard/inventory', label: 'Open Items' });
    expect(form!.audience).toEqual({ anyPermission: ['items:create', 'items:update'] });
    expect(source('app/(dashboard)/dashboard/team/page.tsx')).toContain(
      "if (!can(ctx, 'members:invite')) {",
    );
    expect(source('components/team/team-manager.tsx')).toContain(
      "const canManage =\n    (currentUserRole === 'owner' || currentUserRole === 'admin') && member.role !== 'owner';",
    );
  });

  it('reaches each reader with only the entries they can use', () => {
    expect(entriesFor(CHARTERS_ID, everyone)).toEqual([
      'team-charters-archived-kept',
      'item-form-archived-charter-named',
    ]);
    expect(entriesFor(CHARTERS_ID, admin)).toEqual(['team-charters-archived-kept']);
    expect(entriesFor(CHARTERS_ID, itemEditor)).toEqual(['item-form-archived-charter-named']);
    expect(entriesFor(CHARTERS_ID, managerWithInvite)).toBeUndefined();
    expect(entriesFor(CHARTERS_ID, member)).toBeUndefined();
  });

  it('rests on the dialog keeping every held charter and the form offering active charters only', () => {
    const team = source('components/team/team-manager.tsx');
    expect(team).toContain(
      'const [selected, setSelected] = React.useState<string[]>(() => [...new Set(currentCharterIds)]);',
    );
    expect(team).toContain(
      "if (row.status === 'archived') return { id, name: `${name} (archived)` };",
    );
    const form = source('components/inventory/item-form.tsx');
    expect(form).not.toContain('charterById.get(id) ?? id');
    expect(form).toContain(
      'const name = charterById.get(id);\n          return name === undefined ? [] : [{ id, name }];',
    );
    expect(source('components/admin/charters-manager.tsx')).toContain(
      '<strong>Archived view</strong>',
    );
  });

  it('claims nothing about who was affected, promises no phone update, and never says book for a recorded quantity', () => {
    const text = readerText(release()).join(' ');
    expect(text).not.toMatch(/mobile app|phone|App Store|TestFlight|\bbooked\b/i);
    expect(text).not.toMatch(/\d+ (members|items|records|organizations)/i);
  });
});

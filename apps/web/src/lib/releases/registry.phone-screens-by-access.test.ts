import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  MODULE_REGISTRY,
  PERMISSIONS,
  releaseSchema,
  type ModuleId,
  type Release,
  type ReleaseViewer,
} from '@stockpilot/core';

import { buildReleaseList, visibleReleases } from './logic';
import { RELEASES } from './registry';

/**
 * Added by docs/whats-new-phone-screens-by-access (2026-11-14): the release
 * for the phone update of 2026-11-14 (group 8c30f488, runtime 1.4.0, from
 * #527, squash 60f1bfe48), published at the top, directly below the Liquid
 * Glass draft and above the phone authenticator code release. One release
 * with three entries, as #527 is one phone change:
 *
 *  - the add buttons, Cycle counts and Bundles follow the member's access
 *    (every member);
 *  - after a workspace switch, the phone shows only the new workspace, and a
 *    screen still waiting for a workspace says so (every member);
 *  - a cycle count now also says Count not saved when a line is no longer
 *    in the count on the phone (whoever counts: stock:adjust, module
 *    cycle_counts).
 *
 * The suggested line about bundles coming back after access returns is left
 * out: no member notices it today.
 *
 * publishedAt is set at merge to the whole minute at or after the first iOS
 * launch of the update, so these tests pin its shape and its order, not the
 * minute itself. Its own file, so the release tests other open branches edit
 * stay as they are.
 */
const ID = 'phone-screens-by-access-2026-11';
const byId = (id: string) => RELEASES.find((r) => r.id === id)!;
const release = () => byId(ID);
const entry = (entryId: string) => release().entries.find((e) => e.id === entryId)!;

const viewer = (
  role: ReleaseViewer['role'],
  permissions: ReleaseViewer['permissions'],
  enabledModules: ReleaseViewer['enabledModules'],
): ReleaseViewer => ({ role, permissions, enabledModules });
const owner = viewer('owner', [...PERMISSIONS], Object.keys(MODULE_REGISTRY) as ModuleId[]);
const member = viewer('viewer', [], []);
const entriesFor = (v: ReleaseViewer) =>
  visibleReleases(RELEASES, v)
    .find((r) => r.id === ID)
    ?.entries.map((e) => e.id) ?? [];

/** A source file under apps/mobile/src, as written. */
const mobile = (rel: string) =>
  readFileSync(resolve(__dirname, '../../../../mobile/src', rel), 'utf8');
const mobileApp = (rel: string) =>
  readFileSync(resolve(__dirname, '../../../../mobile/app', rel), 'utf8');

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

describe('the phone screens by access release of 2026-11-14: order, status and date', () => {
  it('is published once, as revision 1, directly below the Liquid Glass draft, the newest published release', () => {
    expect(RELEASES.filter((r) => r.id === ID)).toHaveLength(1);
    expect(release().status).toBe('published');
    expect(release().revision).toBe(1);
    expect(release().withdrawnNote).toBeUndefined();
    expect(RELEASES.slice(0, 3).map((r) => [r.id, r.status])).toEqual([
      ['liquid-glass-2026-11', 'draft'],
      [ID, 'published'],
      ['phone-authenticator-code-2026-11', 'published'],
    ]);
    expect(RELEASES.find((r) => r.status === 'published')?.id).toBe(ID);
  });

  it('is dated on a whole minute after the phone update was published, with the draft placeholder at that minute and no later release below', () => {
    const at = release().publishedAt;
    expect(at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/);
    expect(RELEASES[0]!.publishedAt).toBe(at);
    // The phone update (group 8c30f488) was published at 2026-11-14T05:39:05Z.
    expect(Date.parse(at)).toBeGreaterThan(Date.parse('2026-11-14T05:39:05Z'));
    for (const r of RELEASES.slice(2)) {
      expect(Date.parse(at), r.id).toBeGreaterThanOrEqual(Date.parse(r.publishedAt));
    }
  });

  it('parses under the shared schema, in plain text, with its entries in order', () => {
    expect(releaseSchema.safeParse(release()).success).toBe(true);
    for (const text of readerText(release())) expect(text).not.toMatch(/[<>]/);
    expect(release().entries.map((e) => [e.id, e.category, e.area])).toEqual([
      ['phone-add-item-and-screens-by-access', 'fixed', 'Mobile app'],
      ['phone-workspace-switch-own-lists', 'fixed', 'Mobile app'],
      ['phone-count-not-saved-line-gone', 'fixed', 'Cycle counts'],
    ]);
  });
});

describe('the phone screens by access release: the words', () => {
  const access = () => entry('phone-add-item-and-screens-by-access');
  const workspace = () => entry('phone-workspace-switch-own-lists');
  const count = () => entry('phone-count-not-saved-line-gone');

  it('says what the phone does, in the reviewed words', () => {
    expect(release().title).toBe(
      "The phone follows your access and keeps each workspace's own lists",
    );
    expect(release().summary).toBe(
      "The mobile app's add buttons, Cycle counts and Bundles now follow your access, and after a workspace switch its lists show only the new workspace. A screen still waiting for a workspace now says so, and a cycle count now also says Count not saved when a line is no longer in the count.",
    );

    expect(access().title).toBe(
      "The phone's add buttons, Cycle counts and Bundles follow your access",
    );
    expect(access().whatChanged).toBe(
      'The buttons that add an item, on Items, Books and Scan, now show only if you can add items in the workspace on screen. Cycle counts and Bundles, with the Bundles card on Home, now follow the side menu.',
    );
    expect(access().whyItMatters).toBe(
      'What the phone offers now matches the side menu and what you can save, so a button you see is one you can use.',
    );
    expect(access().howItAffectsYou).toBe(
      'If you can add items and use cycle counts and bundles, nothing changes for you once the phone has synced.',
    );
    expect(access().whatToDo).toBe(
      'No action needed. If you need one of these, ask an admin in your organization.',
    );

    expect(workspace().title).toBe(
      'After a workspace switch, the phone shows only the new workspace',
    );
    expect(workspace().whatChanged).toBe(
      "After you switch workspaces, Users, Team, Accounts, Bundles, Cycle counts and the admin lists on the phone show only the new workspace's records, and the phone reads your role and permissions for the new workspace before it shows it. If a workspace has not finished loading or syncing, a screen with nothing to show says so and lets you try again.",
    );
    expect(workspace().whyItMatters).toBe(
      'Each workspace keeps its own records and your access in it, and a screen that is still waiting tells you so.',
    );
    expect(workspace().howItAffectsYou).toBe(
      'Right after a switch or a sign-in, before the phone has synced, a screen may say the phone has not finished syncing this workspace yet. Check your connection: the screen loads once the phone has synced, or when you try again.',
    );
    expect(workspace().whatToDo).toBe('No action needed.');

    expect(count().title).toBe(
      'A cycle count now also says Count not saved when a line is no longer in the count on the phone',
    );
    expect(count().whatChanged).toBe(
      'If a number you type or scan on a cycle count cannot be saved because its line is no longer in the count on the phone, the phone now says Count not saved. When you tap OK, the phone loads the count again, or closes it if it is no longer open to you.',
    );
    expect(count().whyItMatters).toBe(
      'Before, the number stayed on the line as if it had been saved.',
    );
    expect(count().howItAffectsYou).toBe(
      'This is rare: it happens when the count changes while you are counting, for example when someone posts or cancels it.',
    );
    expect(count().whatToDo).toBe('No action needed.');
  });

  it('keeps to what a member notices: three entries, no bundle refill line, plain words about what the phone does now, never "book" for a quantity', () => {
    const text = readerText(release()).join(' ');
    expect(release().entries).toHaveLength(3);
    expect(text).not.toMatch(/regain|come back|comes back/i);
    expect(text).not.toMatch(/\b(?:saw|could see|was shown|were shown|security|leak|exposed)\b/i);
    expect(text).not.toMatch(/\bbook\b/i);
    expect(text).not.toMatch(/!/);
    // Reassign changes only before the phone's first sync of a workspace: left out.
    expect(text).not.toMatch(/Reassign/);
    // The two entries every member reads say what the phone does now, never
    // what it did before: no "Before,", "used to", "previously", "the previous
    // workspace", "no longer", "anymore", "stops using" or "instead of".
    for (const e of [access(), workspace()]) {
      const said = [e.title, e.whatChanged, e.whyItMatters, e.howItAffectsYou].join(' ');
      expect(said, e.id).not.toMatch(
        /\bbefore,|\bused to\b|\bpreviously\b|\bprevious workspace\b|\bno longer\b|\banymore\b|\bstops? using\b|\binstead of\b/i,
      );
    }
  });

  it('tells the first two entries to every member and the count entry to whoever counts, with no links', () => {
    expect(release().audience).toBeUndefined();
    expect(access().audience).toBeUndefined();
    expect(workspace().audience).toBeUndefined();
    expect(count().audience).toEqual({
      anyPermission: ['stock:adjust'],
      modules: ['cycle_counts'],
    });
    for (const e of release().entries) expect(e.link, e.id).toBeUndefined();

    expect(entriesFor(owner)).toEqual([
      'phone-add-item-and-screens-by-access',
      'phone-workspace-switch-own-lists',
      'phone-count-not-saved-line-gone',
    ]);
    expect(entriesFor(member)).toEqual([
      'phone-add-item-and-screens-by-access',
      'phone-workspace-switch-own-lists',
    ]);
    expect(entriesFor(viewer('staff', ['stock:adjust'], []))).toEqual([
      'phone-add-item-and-screens-by-access',
      'phone-workspace-switch-own-lists',
    ]);
    expect(entriesFor(viewer('staff', ['stock:adjust'], ['cycle_counts']))).toEqual([
      'phone-add-item-and-screens-by-access',
      'phone-workspace-switch-own-lists',
      'phone-count-not-saved-line-gone',
    ]);
    for (const v of [owner, member]) {
      expect(buildReleaseList(RELEASES, v, [], null).latestUnread?.id, v.role).toBe(ID);
    }
  });
});

describe('the phone screens by access release rests on the phone code (#527)', () => {
  it('the buttons that add an item follow items:create on Items, Books and Scan', () => {
    for (const screen of [
      '(drawer)/(tabs)/inventory.tsx',
      '(drawer)/(tabs)/books.tsx',
      '(drawer)/(tabs)/scan.tsx',
    ]) {
      expect(mobileApp(screen), screen).toContain("useCreateControlOffer('items:create')");
    }
  });

  it('Cycle counts and Bundles ask the side menu, and say when they are not available or not synced yet', () => {
    const gate = mobile('lib/screen-access.ts');
    expect(gate).toContain(
      'return drawerOffers(href, role, input.modules.modules, input.saved.permissions)',
    );
    expect(gate).toContain("'Cycle counts are not available to you in this workspace.'");
    expect(gate).toContain(
      "export const BUNDLES_NOT_AVAILABLE = 'Bundles are not available to you in this workspace.';",
    );
    expect(gate).toContain(
      "'This phone has not finished syncing this workspace yet. Check your connection and try again.'",
    );
    expect(mobile('lib/bundles-gate-view.ts')).toContain(
      'return { spinner: false, words: BUNDLES_NOT_AVAILABLE, refresh: null };',
    );
  });

  it('a switch reads the saved access again before the new workspace is shown', () => {
    const ws = mobile('lib/use-workspace.ts');
    expect(ws).toContain('async function rereadSavedAccess(): Promise<void> {');
    expect(ws).toContain('refreshEffectivePermissions(),');
  });

  it('Count not saved for a line no longer on the phone, then the count loads again or closes', () => {
    const refusal = mobile('lib/count-save-refusal.ts');
    expect(refusal).toContain("title: 'Count not saved',");
    expect(refusal).toContain(
      "'This line is no longer in the count saved on this phone, so this number was not saved. Tap OK to load the count again, or to close it if it is no longer open to you.'",
    );
    const screen = mobileApp('cycle-count/[id].tsx');
    expect(screen).toContain('lineGoneNotice.say(() => setLineGoneAnswered((n) => n + 1));');
    expect(screen).toContain('async function reloadAfterLineGone() {');
    expect(mobileApp('cycle-count/scan/[id].tsx')).toContain(
      'async function afterScanLineGone() {',
    );
  });
});

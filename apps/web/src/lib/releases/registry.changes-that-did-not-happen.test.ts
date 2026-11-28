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

import { visibleReleases } from './logic';
import { RELEASES } from './registry';

/**
 * Added by docs/whats-new-2026-11-13 (2026-11-13): the not found release
 * (#507), published at the top, below the AI Assistant release and above the
 * phone appearance and returns release. These tests pin its id, place, date,
 * who it reaches, and the code and screen names its words rest on.
 */
const ID = 'changes-that-did-not-happen-2026-11';
const ENTRY = 'not-found-when-nothing-to-change';
const release = () => RELEASES.find((r) => r.id === ID)!;
const entry = () => release().entries.find((e) => e.id === ENTRY)!;

const viewer = (
  role: ReleaseViewer['role'],
  permissions: ReleaseViewer['permissions'],
): ReleaseViewer => ({
  role,
  permissions,
  enabledModules: Object.keys(MODULE_REGISTRY) as ModuleId[],
});
const told = (v: ReleaseViewer) => visibleReleases(RELEASES, v).some((r) => r.id === ID);

/** A source file under apps/web/src, or packages/core/src, as written. */
const web = (rel: string) => readFileSync(resolve(__dirname, '../..', rel), 'utf8');
const core = (rel: string) =>
  readFileSync(resolve(__dirname, '../../../../../packages/core/src', rel), 'utf8');

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

describe('the not found release', () => {
  it('is published once, as revision 1, directly below the AI Assistant release and above the phone appearance and returns release, on a whole minute after #507 went live', () => {
    expect(RELEASES.filter((r) => r.id === ID)).toHaveLength(1);
    expect(release().status).toBe('published');
    expect(release().revision).toBe(1);
    // Re-pinned by docs/whatsnew-emailed-links-1113 (2026-11-13; was: every pinned position one place higher): the emailed links release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whatsnew-phone-code-and-access-check (2026-11-13; was: every pinned position two places higher): the phone authenticator code and access check releases are published at the top, below the Liquid Glass draft, so every position below them moves down by two.
    // Re-pinned by docs/whats-new-order-request-alerts (2026-11-14; was: every pinned position one place higher): the order request alerts release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-phone-screens-by-access (2026-11-14; was: every pinned position one place higher): the phone screens by access release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-count-read-rule (2026-11-15; was: every pinned position two places higher): the count read rule and email change releases are published at the top, below the Liquid Glass draft, so every position below them moves down by two.
    // Re-pinned by docs/whats-new-unreadable-access-and-settings (2026-11-15; was: every pinned position two places higher): the settings and module check releases are published at the top, below the Liquid Glass draft, so every position below them moves down by two.
    // Re-pinned by docs/whats-new-navigation-keeps-choices (2026-11-15; was: every pinned position one place higher): the navigation release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-invitation-audit (2026-11-15; was: every pinned position one place higher): the invitation audit release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-api-key-audit (2026-11-15; was: every pinned position one place higher): the API key audit release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-authenticator-set-up-first (2026-11-15; was: every pinned position one place higher): the authenticator set-up release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-delete-account-confirm (2026-11-16; was: every pinned position one place higher): the delete account release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-integrations-message-and-api-key-rows (2026-11-16; was: every pinned position one place higher): the Integrations and schedule event release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-emptied-fields-and-schedule-completion (2026-11-16; was: every pinned position one place higher): the emptied fields and schedule completion release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/releases-low-critical-pages (2026-11-18; was: RELEASES[18]): the Low + critical pages and list value release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-receiving-shown-to-managers (2026-11-19; was: RELEASES[19]): the receiving release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-small-fixes-1119 (2026-11-19; was: RELEASES[20]): the export, receipt and access release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-2026-11-19-errors (2026-11-19; was: RELEASES[21]): the count start access check release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-2026-11-21-phone (2026-11-21; was: RELEASES[22]): the phone authenticator set-up release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-blocked-activity (2026-11-21; was: RELEASES[23]): the Blocked activity release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-phone-large-text (2026-11-23; was: RELEASES[26]): the phone large text release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-recovery-code (2026-11-23; was: RELEASES[27]): the recovery code release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-upload-checks (2026-11-28; was: earlier positions, lists and reads): the upload checks release is published at the top, below the Liquid Glass draft, so every position below it moves down by one and every list of newer releases takes it too.
    // Re-pinned by docs/whats-new-vendor-risk (2026-11-28; was: RELEASES[29]): the vendor risk reviews release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    expect(RELEASES[30]?.id).toBe('ai-assistant-plain-words-2026-11');
    // Re-pinned by docs/whats-new-invitation-audit (2026-11-15; was: every pinned position one place higher): the invitation audit release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-api-key-audit (2026-11-15; was: every pinned position one place higher): the API key audit release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-authenticator-set-up-first (2026-11-15; was: every pinned position one place higher): the authenticator set-up release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-delete-account-confirm (2026-11-16; was: every pinned position one place higher): the delete account release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-integrations-message-and-api-key-rows (2026-11-16; was: every pinned position one place higher): the Integrations and schedule event release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-emptied-fields-and-schedule-completion (2026-11-16; was: every pinned position one place higher): the emptied fields and schedule completion release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/releases-low-critical-pages (2026-11-18; was: RELEASES[19]): the Low + critical pages and list value release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-receiving-shown-to-managers (2026-11-19; was: RELEASES[20]): the receiving release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-small-fixes-1119 (2026-11-19; was: RELEASES[21]): the export, receipt and access release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-2026-11-19-errors (2026-11-19; was: RELEASES[22]): the count start access check release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-2026-11-21-phone (2026-11-21; was: RELEASES[23]): the phone authenticator set-up release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-blocked-activity (2026-11-21; was: RELEASES[24]): the Blocked activity release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-phone-large-text (2026-11-23; was: RELEASES[27]): the phone large text release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-recovery-code (2026-11-23; was: RELEASES[28]): the recovery code release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-upload-checks (2026-11-28; was: earlier positions, lists and reads): the upload checks release is published at the top, below the Liquid Glass draft, so every position below it moves down by one and every list of newer releases takes it too.
    // Re-pinned by docs/whats-new-vendor-risk (2026-11-28; was: RELEASES[30]): the vendor risk reviews release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    expect(RELEASES[31]?.id).toBe(ID);
    // Re-pinned by docs/whats-new-invitation-audit (2026-11-15; was: every pinned position one place higher): the invitation audit release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-api-key-audit (2026-11-15; was: every pinned position one place higher): the API key audit release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-authenticator-set-up-first (2026-11-15; was: every pinned position one place higher): the authenticator set-up release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-delete-account-confirm (2026-11-16; was: every pinned position one place higher): the delete account release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-integrations-message-and-api-key-rows (2026-11-16; was: every pinned position one place higher): the Integrations and schedule event release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-emptied-fields-and-schedule-completion (2026-11-16; was: every pinned position one place higher): the emptied fields and schedule completion release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/releases-low-critical-pages (2026-11-18; was: RELEASES[20]): the Low + critical pages and list value release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-receiving-shown-to-managers (2026-11-19; was: RELEASES[21]): the receiving release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-small-fixes-1119 (2026-11-19; was: RELEASES[22]): the export, receipt and access release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-2026-11-19-errors (2026-11-19; was: RELEASES[23]): the count start access check release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-2026-11-21-phone (2026-11-21; was: RELEASES[24]): the phone authenticator set-up release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-blocked-activity (2026-11-21; was: RELEASES[25]): the Blocked activity release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-phone-large-text (2026-11-23; was: RELEASES[28]): the phone large text release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-recovery-code (2026-11-23; was: RELEASES[29]): the recovery code release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-upload-checks (2026-11-28; was: earlier positions, lists and reads): the upload checks release is published at the top, below the Liquid Glass draft, so every position below it moves down by one and every list of newer releases takes it too.
    // Re-pinned by docs/whats-new-vendor-risk (2026-11-28; was: RELEASES[31]): the vendor risk reviews release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    expect(RELEASES[32]?.id).toBe('phone-appearance-returns-2026-11');
    // #507 went live at 04:08:17Z.
    expect(release().publishedAt).toBe('2026-11-13T04:09:00Z');
    // Re-pinned by docs/whatsnew-emailed-links-1113 (2026-11-13; was: every pinned position one place higher): the emailed links release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whatsnew-phone-code-and-access-check (2026-11-13; was: every pinned position two places higher): the phone authenticator code and access check releases are published at the top, below the Liquid Glass draft, so every position below them moves down by two.
    // Re-pinned by docs/whats-new-order-request-alerts (2026-11-14; was: every pinned position one place higher): the order request alerts release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-phone-screens-by-access (2026-11-14; was: every pinned position one place higher): the phone screens by access release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-count-read-rule (2026-11-15; was: every pinned position two places higher): the count read rule and email change releases are published at the top, below the Liquid Glass draft, so every position below them moves down by two.
    // Re-pinned by docs/whats-new-unreadable-access-and-settings (2026-11-15; was: every pinned position two places higher): the settings and module check releases are published at the top, below the Liquid Glass draft, so every position below them moves down by two.
    // Re-pinned by docs/whats-new-navigation-keeps-choices (2026-11-15; was: every pinned position one place higher): the navigation release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-invitation-audit (2026-11-15; was: every pinned position one place higher): the invitation audit release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-api-key-audit (2026-11-15; was: every pinned position one place higher): the API key audit release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-authenticator-set-up-first (2026-11-15; was: every pinned position one place higher): the authenticator set-up release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-delete-account-confirm (2026-11-16; was: every pinned position one place higher): the delete account release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-integrations-message-and-api-key-rows (2026-11-16; was: every pinned position one place higher): the Integrations and schedule event release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-emptied-fields-and-schedule-completion (2026-11-16; was: every pinned position one place higher): the emptied fields and schedule completion release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/releases-low-critical-pages (2026-11-18; was: RELEASES.slice(20)): the Low + critical pages and list value release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-receiving-shown-to-managers (2026-11-19; was: RELEASES.slice(21)): the receiving release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-small-fixes-1119 (2026-11-19; was: RELEASES.slice(22)): the export, receipt and access release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-2026-11-19-errors (2026-11-19; was: RELEASES.slice(23)): the count start access check release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-2026-11-21-phone (2026-11-21; was: RELEASES.slice(24)): the phone authenticator set-up release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-blocked-activity (2026-11-21; was: RELEASES.slice(25)): the Blocked activity release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-phone-large-text (2026-11-23; was: RELEASES.slice(28)): the phone large text release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-recovery-code (2026-11-23; was: RELEASES.slice(29)): the recovery code release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-upload-checks (2026-11-28; was: earlier positions, lists and reads): the upload checks release is published at the top, below the Liquid Glass draft, so every position below it moves down by one and every list of newer releases takes it too.
    // Re-pinned by docs/whats-new-vendor-risk (2026-11-28; was: RELEASES.slice(31)): the vendor risk reviews release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    for (const r of RELEASES.slice(32)) {
      expect(Date.parse(release().publishedAt), r.id).toBeGreaterThan(Date.parse(r.publishedAt));
    }
  });

  it('parses under the shared schema, with one fixed Web app entry, no link, in plain text only', () => {
    expect(releaseSchema.safeParse(release()).success).toBe(true);
    expect(release().entries.map((e) => [e.id, e.category, e.area])).toEqual([
      [ENTRY, 'fixed', 'Web app'],
    ]);
    expect(entry().link).toBeUndefined();
    for (const text of readerText(release())) expect(text).not.toMatch(/[<>]/);
  });

  it('reaches whoever can take one of the actions it names, and not a member who can take none', () => {
    expect(entry().audience).toEqual({
      anyPermission: [
        'bundles:manage',
        'organization:update',
        'categories:manage',
        'purchase_orders:manage',
        'schedule:manage',
        'members:invite',
      ],
    });
    expect(told(viewer('owner', [...PERMISSIONS]))).toBe(true);
    expect(told(viewer('manager', ['categories:manage']))).toBe(true);
    expect(told(viewer('manager', ['schedule:manage']))).toBe(true);
    expect(told(viewer('staff', ['items:read', 'items:update', 'stock:adjust']))).toBe(false);
    expect(told(viewer('viewer', []))).toBe(false);
  });

  it('names the screens as the app does and the actions that answer not found', () => {
    expect(release().title).toBe('A success message means the change was saved');
    expect(entry().whatChanged).toContain('archiving or restoring a bundle');
    expect(entry().whatChanged).not.toMatch(/\bkit\b|switching .* on or off/);
    expect(entry().whyItMatters).toContain('the audit log lists only changes that happened');
    expect(readerText(release()).join(' ')).not.toMatch(/price|catalog item|portal user/);
    const modules = core('modules/registry.ts');
    for (const label of [
      'Bundles',
      'Warehouses',
      'Charters',
      'Tags',
      'Schedule',
      'Team',
      'Audit log',
    ]) {
      expect(modules, label).toContain(`label: '${label}'`);
    }
    const notFound: Array<[string, string]> = [
      ['server/services/bundles.ts', "'Bundle not found'"],
      ['server/services/warehouses.ts', "'Warehouse not found.'"],
      ['server/services/charters.ts', "'Charter not found.'"],
      ['server/services/tags.ts', "'Tag not found'"],
      ['server/services/uom-conversions.ts', "'Unit conversion not found.'"],
      ['server/services/vendor-item-mappings.ts', "'Vendor item mapping not found.'"],
      ['server/services/schedule.ts', "'Event not found'"],
      ['server/services/team.ts', "'Invite not found'"],
      ['server/services/api-keys.ts', "'API key not found'"],
      ['server/services/order-requests.ts', "'Warehouse not found.'"],
    ];
    for (const [file, words] of notFound) {
      expect(web(file), file).toContain(`throw new ServiceError('not_found', ${words})`);
    }
    expect(web('components/team/team-manager.tsx')).toContain('Pending invites (');
    expect(web('components/settings/public-requests-global-settings.tsx')).toContain(
      'title="Public-orderable warehouses"',
    );
  });
});

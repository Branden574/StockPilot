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
 * Added by docs/whats-new-2026-11-13 (2026-11-13): the Release count release
 * (#444 and migration 0419), published at the top, directly below the Liquid
 * Glass draft and above the AI Assistant release. These tests pin its id, place,
 * date, who it reaches, and the code its words rest on.
 */
const ID = 'cycle-count-already-released-2026-11';
const ENTRY = 'release-count-already-released';
const ALREADY_RELEASED = 'This count was already released.';
const release = () => RELEASES.find((r) => r.id === ID)!;
const entry = () => release().entries.find((e) => e.id === ENTRY)!;

const viewer = (
  role: ReleaseViewer['role'],
  permissions: ReleaseViewer['permissions'],
  enabledModules: ReleaseViewer['enabledModules'],
): ReleaseViewer => ({ role, permissions, enabledModules });
const owner = viewer('owner', [...PERMISSIONS], Object.keys(MODULE_REGISTRY) as ModuleId[]);
const told = (v: ReleaseViewer) => visibleReleases(RELEASES, v).some((r) => r.id === ID);

/** A source file under apps/web/src or apps/mobile/src, as written. */
const web = (rel: string) => readFileSync(resolve(__dirname, '../..', rel), 'utf8');
const mobile = (rel: string) =>
  readFileSync(resolve(__dirname, '../../../../mobile/src', rel), 'utf8');

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

describe('the Release count release', () => {
  it('is published once, as revision 1, directly below the Liquid Glass draft, the newest published release, on a whole minute after the migration went out', () => {
    expect(RELEASES.filter((r) => r.id === ID)).toHaveLength(1);
    expect(release().status).toBe('published');
    expect(release().revision).toBe(1);
    expect(RELEASES[0]?.id).toBe('liquid-glass-2026-11');
    // Re-pinned by docs/whatsnew-emailed-links-1113 (2026-11-13; was: every pinned position one place higher): the emailed links release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whatsnew-phone-code-and-access-check (2026-11-13; was: every pinned position two places higher): the phone authenticator code and access check releases are published at the top, below the Liquid Glass draft, so every position below them moves down by two.
    expect(RELEASES[4]?.id).toBe(ID);
    expect(RELEASES[5]?.id).toBe('ai-assistant-plain-words-2026-11');
    // Re-pinned by docs/whatsnew-emailed-links-1113 (2026-11-13; was: this release, the newest published): the emailed links release is published later, directly above it.
    expect(RELEASES[3]?.id).toBe('emailed-links-name-their-account-2026-11');
    expect(RELEASES.find((r) => r.status === 'published')?.id).toBe(
      // Re-pinned by docs/whatsnew-phone-code-and-access-check (2026-11-13; was: the emailed links release): the phone authenticator code release is published after it, at the top, the newest published release.
      'phone-authenticator-code-2026-11',
    );
    // Migration 0419 reached production at 08:17:32Z; #444's web build went live at 07:54Z.
    expect(release().publishedAt).toBe('2026-11-13T08:18:00Z');
    expect(Date.parse(release().publishedAt)).toBeLessThanOrEqual(Date.now());
    expect(Date.parse(RELEASES[0]!.publishedAt)).toBeGreaterThanOrEqual(
      Date.parse(release().publishedAt),
    );
  });

  it('parses under the shared schema, with one fixed entry in Cycle counts and plain text only', () => {
    expect(releaseSchema.safeParse(release()).success).toBe(true);
    expect(release().entries.map((e) => [e.id, e.category, e.area])).toEqual([
      [ENTRY, 'fixed', 'Cycle counts'],
    ]);
    for (const text of readerText(release())) expect(text).not.toMatch(/[<>]/);
  });

  it('reaches staff and viewers who adjust stock where Cycle counts is on, and nobody else', () => {
    expect(entry().audience).toEqual({
      roles: ['staff', 'viewer'],
      anyPermission: ['stock:adjust'],
      modules: ['cycle_counts'],
    });
    expect(entry().link).toEqual({ href: '/dashboard/cycle-counts', label: 'Open Cycle counts' });
    expect(told(viewer('staff', ['stock:adjust'], ['cycle_counts']))).toBe(true);
    expect(told(viewer('viewer', ['stock:adjust'], ['cycle_counts']))).toBe(true);
    expect(told(viewer('staff', ['stock:adjust'], []))).toBe(false);
    expect(told(viewer('staff', ['items:read'], ['cycle_counts']))).toBe(false);
    expect(told(viewer('manager', ['stock:adjust'], ['cycle_counts']))).toBe(false);
    expect(told(owner)).toBe(false);
  });

  it('says what the release sheet shows, in the words the server sends and the phone shows as sent', () => {
    expect(entry().whatChanged).toContain(
      'a count you are releasing was already released, by you a moment earlier or by a manager, Release now says so instead of appearing to work again.',
    );
    expect(entry().howItAffectsYou).toContain(`"${ALREADY_RELEASED}" and stays open`);
    expect(entry().howItAffectsYou).toContain('Managers release counts as before.');
    expect(entry().whatToDo).toBe('No action needed. If you see it, close the sheet.');
    const service = web('server/services/cycle-counts.ts');
    expect(service).toContain(`throw new ServiceError('conflict', '${ALREADY_RELEASED}');`);
    expect(service).toContain('countIsAlreadyReleased(id)');
    const sheet = mobile('components/cycle-count-release-sheet.tsx');
    expect(sheet).toContain('/release`');
    expect(sheet).toMatch(/onReleased\(\);\s*\} catch \(e\) \{\s*setError\(/);
  });
});

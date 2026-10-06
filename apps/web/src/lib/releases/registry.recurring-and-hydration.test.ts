import { describe, expect, it } from 'vitest';

import type { ModuleId, ReleaseViewer } from '@stockpilot/core';

import { visibleReleases } from './logic';
import { RELEASES } from './registry';

/**
 * fix/recurring-seed-and-hydration (#331), told in the weekly digest release
 * (weekly-digest-and-fixes-2026-10, published 2026-10-06). Its own file so the
 * release tests that other open branches edit (registry.test.ts) stay as they
 * are.
 *
 * Make recurring never worked before this branch (the seed read failed from
 * its first commit, and the form dropped the seed), so no word says it works
 * "again"; the new one opens with its name blank and required. Of the React
 * #418 sweep, the two lines a person could see are told to whoever can open
 * each page.
 */
describe('the weekly digest release, for the Make recurring and hydration fixes', () => {
  const release = () => RELEASES.find((r) => r.id === 'weekly-digest-and-fixes-2026-10')!;
  const ids = (
    role: ReleaseViewer['role'],
    permissions: ReleaseViewer['permissions'],
    modules: ModuleId[],
  ) =>
    // The release itself, published since 2026-10-06 (this used to read a
    // copy forced to published, while it was a draft).
    visibleReleases([release()], { role, permissions, enabledModules: modules })[0]?.entries.map(
      (e) => e.id,
    ) ?? [];

  it('never says Make recurring works "again", and says the name is to be given', () => {
    const recurring = release().entries.find((e) => e.id === 'make-recurring-works')!;
    for (const text of [recurring.title, recurring.whatChanged, recurring.howItAffectsYou]) {
      expect(text).not.toMatch(/\bagain\b/i);
    }
    expect(release().summary).not.toMatch(/Make recurring[^,.]*again/);
    expect(recurring.howItAffectsYou).toContain('ready for you to name, review and save');
  });

  it('tells the Expected date line to readers of purchase orders, and the calendar line to readers of the schedule', () => {
    expect(ids('staff', ['purchase_orders:read'], ['purchase_orders'])).toContain(
      'po-list-expected-date',
    );
    expect(ids('staff', ['purchase_orders:read'], [])).not.toContain('po-list-expected-date');
    expect(ids('viewer', ['schedule:read'], ['schedule'])).toContain('calendar-today');
    expect(ids('viewer', [], ['schedule'])).not.toContain('calendar-today');
    // A member with neither still sees only what every member is told.
    expect(ids('viewer', [], [])).toEqual([
      'weekly-digest-sent',
      'weekly-digest-your-view',
      'warehouse-page-opens',
    ]);
  });
});

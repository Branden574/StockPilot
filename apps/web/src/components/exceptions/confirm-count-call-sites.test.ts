import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Confirm this count (count differences R2, 0386): WHERE it is called from.
 *
 * The behaviour is pinned by the dialog's, the page's and the actions' own
 * tests. This pins the call sites, so a second way in cannot appear without
 * being seen (recurring pattern #26: a second copy of a gate drifts):
 *   - the web confirms only through the dialog: confirmExceptionCountAction
 *     has exactly one caller outside the actions module;
 *   - the page and the card word and offer Confirm from ONE input
 *     (countVarianceClearCopyFor): core's countVarianceClearCopy is called in
 *     the card module only, so the card's Confirm and the Acknowledge step's
 *     "instead" can never disagree;
 *   - the card's Confirm, the Acknowledge step's "instead" and the page's
 *     provider are each rendered where the plan puts them (7.1 to 7.3), and
 *     the Resolved filter asks the service, never filters on the page.
 */

const WEB_SRC = resolve(__dirname, '../..');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

const FILES = sourceFiles(WEB_SRC).map((f) => ({ path: relative(WEB_SRC, f), text: readFileSync(f, 'utf8') }));

function filesMentioning(token: RegExp): string[] {
  return FILES.filter((f) => token.test(f.text))
    .map((f) => f.path)
    .sort();
}

const read = (path: string) => FILES.find((f) => f.path === path)!.text;

describe('Confirm this count: call sites', () => {
  it('the web confirms only through the dialog', () => {
    expect(filesMentioning(/\bconfirmExceptionCountAction\b/)).toEqual([
      'components/exceptions/confirm-count-dialog.tsx',
      'server/actions/exceptions.ts',
    ]);
  });

  it("core's countVarianceClearCopy is called in the card module only; the page asks the card's helper", () => {
    expect(filesMentioning(/\bcountVarianceClearCopy\(/)).toEqual(['components/exceptions/count-variance-clear-card.tsx']);
    const page = read('app/(dashboard)/dashboard/exceptions/[id]/page.tsx');
    expect(page).toMatch(/countVarianceClearCopyFor\(o, displayed, countConfirm\)\.offerConfirm/);
    expect(page).toMatch(/<ConfirmCountProvider[\s\S]*offered=\{offerConfirm\}/);
    expect(page).toMatch(/<ConfirmCountStatus \/>/);
  });

  it("the card's Confirm and the Acknowledge step's instead are rendered where the plan puts them", () => {
    expect(filesMentioning(/<ConfirmCountButton\b/)).toEqual(['components/exceptions/count-variance-clear-card.tsx']);
    expect(filesMentioning(/<ConfirmCountInsteadButton\b/)).toEqual(['components/exceptions/occurrence-actions.tsx']);
    expect(filesMentioning(/<ConfirmCountProvider\b/)).toEqual(['app/(dashboard)/dashboard/exceptions/[id]/page.tsx']);
    expect(read('components/exceptions/count-variance-clear-card.tsx')).toMatch(
      /copy\.offerConfirm \? <ConfirmCountButton \/> : null/,
    );
    expect(read('components/exceptions/occurrence-actions.tsx')).toMatch(
      /rule === 'count_variance' \? \(\s*<ConfirmCountInsteadButton note=\{note\}/,
    );
  });

  it('the Resolved filter asks the service for confirmed rows', () => {
    const list = read('app/(dashboard)/dashboard/exceptions/page.tsx');
    expect(list).toMatch(/confirmedOnly \? \{ status: tab, confirmedOnly: true \} : \{ status: tab \}/);
    expect(list).toMatch(/href="\/dashboard\/exceptions\?tab=resolved&confirmed=1"/);
  });
});

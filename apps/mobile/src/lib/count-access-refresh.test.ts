import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ScreenAccess } from './screen-access';

/**
 * A COUNT ON SCREEN IS REFRESHED IN PLACE WHEN THE PHONE FINISHES SYNCING
 * (S75).
 *
 * While the workspace is not synced yet for this member, the count screen and
 * the barcode scanner show a count this account fetched. When the pull lands
 * and the access turns to 'allowed', the screens read the count again. The
 * count screen used to put its spinner over everything for that read (the
 * keyboard closed and the list jumped to the top while a counter was typing),
 * and the scanner reseeded its tally from the phone's copy. Now:
 *   - the count screen, with lines on screen and the same count and
 *     workspace, reads again without the spinner and without resetting what
 *     is on screen (the typed drafts are their own state and stay);
 *   - the scanner merges what it read into its tally: a count scanned on this
 *     screen stays, a line no longer in the count goes.
 */

const COUNT = 'app/cycle-count/[id].tsx';
const SCANNER = 'app/cycle-count/scan/[id].tsx';

const code = (file: string) =>
  readFileSync(path.resolve(__dirname, '../..', file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s+/g, ' ');

describe('countReloadIsQuiet', () => {
  const key = (access: ScreenAccess, id = 'cc-1', orgId: string | null = 'org-a') => ({
    id,
    orgId,
    access,
  });

  it('not synced yet -> allowed, same count and workspace, lines on screen: quiet', async () => {
    const { countReloadIsQuiet } = await import('./count-access-refresh');
    expect(countReloadIsQuiet(key('not-synced'), key('allowed'), true)).toBe(true);
  });

  it('anything else: the full load, with its spinner', async () => {
    const { countReloadIsQuiet } = await import('./count-access-refresh');
    expect(countReloadIsQuiet(null, key('allowed'), true)).toBe(false);
    expect(countReloadIsQuiet(key('not-synced'), key('allowed'), false)).toBe(false);
    expect(countReloadIsQuiet(key('not-synced'), key('allowed', 'cc-2'), true)).toBe(false);
    expect(countReloadIsQuiet(key('not-synced'), key('allowed', 'cc-1', 'org-b'), true)).toBe(
      false,
    );
    expect(countReloadIsQuiet(key('unknown'), key('allowed'), true)).toBe(false);
    expect(countReloadIsQuiet(key('allowed'), key('not-synced'), true)).toBe(false);
    expect(countReloadIsQuiet(key('not-synced'), key('denied'), true)).toBe(false);
    expect(countReloadIsQuiet(key('allowed'), key('allowed'), true)).toBe(false);
  });
});

describe('mergeScannedCounts', () => {
  it('keeps what this screen scanned, adds what the phone holds, drops a line that is gone', async () => {
    const { mergeScannedCounts } = await import('./count-access-refresh');
    const scanned = new Map([
      ['l-1', 7],
      ['l-gone', 3],
    ]);
    const merged = mergeScannedCounts(scanned, [
      { id: 'l-1', counted: 5 },
      { id: 'l-2', counted: 2 },
      { id: 'l-3', counted: null },
    ]);
    expect([...merged.entries()].sort()).toEqual([
      ['l-1', 7],
      ['l-2', 2],
    ]);
  });

  it('with nothing scanned yet: the phone copy, as the first read always was', async () => {
    const { mergeScannedCounts } = await import('./count-access-refresh');
    expect([
      ...mergeScannedCounts(new Map(), [
        { id: 'l-1', counted: 4 },
        { id: 'l-2', counted: null },
      ]).entries(),
    ]).toEqual([['l-1', 4]]);
  });
});

describe('the count screen', () => {
  it('reads again quietly on that change, and with the spinner otherwise', () => {
    const src = code(COUNT);
    expect(src).toContain('const lastLoadKey = React.useRef<CountLoadKey | null>(null);');
    expect(src).toContain(
      'const loadKeyNow = React.useEffectEvent(() => ({ key: { id, orgId, access }, linesShown: lines.length > 0, }));',
    );
    expect(src).toMatch(
      /React\.useEffect\(\(\) => \{ const \{ key, linesShown \} = loadKeyNow\(\); const quiet = countReloadIsQuiet\(lastLoadKey\.current, key, linesShown\); lastLoadKey\.current = key; if \(quiet\) \{ void load\(\); return; \} (?:\/\/[^\n]*)?setLoading\(true\); setReadError\(null\); setEmptyState\('none'\); void load\(\); \}, \[load\]\);/,
    );
  });
});

describe('the scanner', () => {
  it('merges what it reads into its tally', () => {
    const src = code(SCANNER);
    expect(src).toContain('setScannedMap((prev) => mergeScannedCounts(prev, snap.lines));');
    // The first read and every later one: no reseed left in loadLines.
    const loadLines = src.slice(src.indexOf('async function loadLines()'));
    expect(loadLines.slice(0, loadLines.indexOf('React.useEffect('))).not.toContain(
      'setScannedMap(seed)',
    );
  });
});

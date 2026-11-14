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
  const key = (
    access: ScreenAccess,
    id = 'cc-1',
    orgId: string | null = 'org-a',
    userId: string | null = 'u-1',
  ) => ({ id, orgId, userId, access });

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

  // Round 3: the key names the account. Another account signing in under a
  // mounted screen is never the quiet case.
  it('same count and workspace, not synced yet -> allowed, another account: the full load', async () => {
    const { countReloadIsQuiet } = await import('./count-access-refresh');
    expect(
      countReloadIsQuiet(key('not-synced'), key('allowed', 'cc-1', 'org-a', 'u-2'), true),
    ).toBe(false);
    expect(countReloadIsQuiet(key('not-synced'), key('allowed', 'cc-1', 'org-a', null), true)).toBe(
      false,
    );
  });
});

describe('countLoadClearsScreen: a full load for another count, workspace or account starts empty', () => {
  const key = (
    id: string | undefined = 'cc-1',
    orgId: string | null = 'org-a',
    userId: string | null = 'u-1',
    access: ScreenAccess = 'allowed',
  ) => ({ id, orgId, userId, access });

  it('another count, workspace or account: cleared', async () => {
    const { countLoadClearsScreen } = await import('./count-access-refresh');
    expect(countLoadClearsScreen(key(), key('cc-2'))).toBe(true);
    expect(countLoadClearsScreen(key(), key('cc-1', 'org-b'))).toBe(true);
    expect(countLoadClearsScreen(key(), key('cc-1', 'org-a', 'u-2'))).toBe(true);
    expect(countLoadClearsScreen(key(), key('cc-1', 'org-a', null))).toBe(true);
  });

  it('the first load, or the same count, workspace and account (an access change): kept', async () => {
    const { countLoadClearsScreen } = await import('./count-access-refresh');
    expect(countLoadClearsScreen(null, key())).toBe(false);
    expect(countLoadClearsScreen(key(), key('cc-1', 'org-a', 'u-1', 'denied'))).toBe(false);
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
      'const loadKeyNow = React.useEffectEvent(() => ({ key: { id, orgId, userId, access }, linesShown: lines.length > 0, }));',
    );
    // Quiet: as it was. Full: another count, workspace or account than the
    // one on screen clears the header, the lines and the drafts first (the
    // drafts' waiting saves dropped or saved: count-drafts-cleared.test.ts),
    // with every other state read for that count (count-screens-keyed.test.ts);
    // and the load runs again when the account changes.
    expect(src).toMatch(
      /React\.useEffect\(\(\) => \{ const \{ key, linesShown \} = loadKeyNow\(\); const quiet = countReloadIsQuiet\(lastLoadKey\.current, key, linesShown\); const clear = countLoadClearsScreen\(lastLoadKey\.current, key\); const drafts = countLoadDraftAction\(lastLoadKey\.current, key\); lastLoadKey\.current = key; if \(quiet\) \{ void load\(\); return; \} if \(clear\) \{ if \(drafts === 'drop'\) lineSaver\.dropAll\(\); else lineSaver\.flushAll\(\); setDraft\(\{\}\); setHeader\(null\); setLines\(\[\]\); setLinked\(\{ kind: 'none' \}\); setServerLocations\(new Map\(\)\); setScope\(null\); setConflictBanner\(null\); const knownGate = rememberedCloseGate\(key\.userId, key\.orgId\); setCloseGate\(knownGate \? \{ kind: 'known', gate: knownGate \} : \{ kind: 'loading' \}\); setReassignOpen\(false\); setReleaseOpen\(false\); \} setLoading\(true\); setReadError\(null\); setEmptyState\('none'\); void load\(\); \}, \[load, userId, lineSaver\]\);/,
    );
  });
});

describe('the scanner', () => {
  it('another count, workspace or account: the lines and the tally are cleared before the read', () => {
    const src = code(SCANNER);
    expect(src).toContain('const lastLinesKey = React.useRef<CountLoadKey | null>(null);');
    expect(src).toMatch(
      /React\.useEffect\(\(\) => \{ if \(!id\) return; const key = \{ id, orgId, userId: user\?\.id \?\? null, access \}; if \(countLoadClearsScreen\(lastLinesKey\.current, key\)\) \{ if \(countLoadDraftAction\(lastLinesKey\.current, key\) === 'drop'\) setSheet\(null\); setLines\(\[\]\); setScannedMap\(new Map\(\)\); \} lastLinesKey\.current = key; if \(!user\) return; void loadLines\(\); \}, \[user, id, orgId, access\]\);/,
    );
  });

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

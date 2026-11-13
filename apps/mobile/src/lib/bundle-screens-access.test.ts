import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { screenFunction } from './__fixtures__/screen-functions';

// screen-access.ts reaches drawer-nav, which maps icon names to lucide
// components; the native package does not load under node.
vi.mock('./nav-icons', () => ({ NAV_ICONS: new Proxy({}, { get: () => () => null }) }));

/**
 * THE BUNDLE SCREENS OPEN ONLY FOR A MEMBER THE SIDE MENU OFFERS BUNDLES TO
 * (S75).
 *
 * The side menu lists Bundles only with the bundles module on and
 * bundles:read or bundles:distribute held. The Bundles list and a bundle
 * read the kits saved on this phone. Both ask the menu's own rule
 * (screen-access.ts drawerEntryAccess), and by its answer (bundlesGateView):
 *   - allowed: the kits, Refresh and the pull, as before;
 *   - denied: "Bundles are not available to you in this workspace.", no
 *     Refresh, no rows;
 *   - not synced yet for this member: nothing stored is read; the phone
 *     syncs (a spinner while that pull is out), then says it has not
 *     finished syncing this workspace; Refresh and the pull sync again;
 *   - what the phone saved about the member's access could not be read:
 *     said, and Refresh (the list) or Try again (a bundle) reads it again;
 *   - not known yet: the spinner.
 */

const LIST = 'app/bundles/index.tsx';
const DETAIL = 'app/bundles/[id].tsx';
const BUNDLES_NOT_AVAILABLE = 'Bundles are not available to you in this workspace.';
const NOT_SYNCED_YET =
  'This phone has not finished syncing this workspace yet. Check your connection and try again.';
const SAVED_ACCESS_UNREADABLE =
  'What this phone saved about your access could not be read. Try again.';

const code = (file: string) =>
  readFileSync(path.resolve(__dirname, '../..', file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s+/g, ' ');

describe('bundlesGateView: what a bundle screen shows in place of the kits', () => {
  it('by the access, and whether a pull is out', async () => {
    const { bundlesGateView } = await import('./bundles-gate-view');
    expect(bundlesGateView('allowed', false)).toEqual({
      spinner: false,
      words: null,
      refresh: 'sync',
    });
    expect(bundlesGateView('unknown', false)).toEqual({
      spinner: true,
      words: null,
      refresh: null,
    });
    expect(bundlesGateView('denied', false)).toEqual({
      spinner: false,
      words: BUNDLES_NOT_AVAILABLE,
      refresh: null,
    });
    expect(bundlesGateView('not-synced', true)).toEqual({
      spinner: true,
      words: null,
      refresh: 'sync',
    });
    expect(bundlesGateView('not-synced', false)).toEqual({
      spinner: false,
      words: NOT_SYNCED_YET,
      refresh: 'sync',
    });
    expect(bundlesGateView('unreadable', false)).toEqual({
      spinner: false,
      words: SAVED_ACCESS_UNREADABLE,
      refresh: 'reread',
    });
  });
});

describe('the Bundles list', () => {
  it("asks useDrawerEntryAccess('/bundles') and reads the phone's kits only when allowed", () => {
    const list = code(LIST);
    expect(list).toContain("const access = useDrawerEntryAccess('/bundles');");
    expect(list).toContain("const allowed = access === 'allowed';");
    expect(list).toMatch(/if \(allowed\) void load\(\); \}, \[load, allowed\]\);/);
  });

  it('Refresh (and so a pull): by the access', async () => {
    const { bundlesGateView } = await import('./bundles-gate-view');
    const cases = [
      ['allowed', 1, 1, 0],
      ['not-synced', 1, 0, 0],
      ['unreadable', 0, 0, 1],
      ['denied', 0, 0, 0],
      ['unknown', 0, 0, 0],
    ] as const;
    for (const [access, syncs, loads, rereads] of cases) {
      const syncNow = vi.fn(async () => undefined);
      const load = vi.fn(async () => undefined);
      const retrySavedAccess = vi.fn(async () => undefined);
      const refresh = screenFunction<() => Promise<void>>(LIST, 'refresh', {
        allowed: access === 'allowed',
        gate: bundlesGateView(access, false),
        syncNow,
        load,
        retrySavedAccess,
        setRefreshing: vi.fn(),
      });
      await refresh();
      expect([access, syncNow.mock.calls.length]).toEqual([access, syncs]);
      expect([access, load.mock.calls.length]).toEqual([access, loads]);
      expect([access, retrySavedAccess.mock.calls.length]).toEqual([access, rereads]);
    }
  });

  it('draws from bundlesGateView: its spinner, its words, Refresh only when it offers one, and rows only when allowed', () => {
    const list = code(LIST);
    expect(list).toContain('const waitingForPull = useNotSyncedPull(access);');
    expect(list).toContain('const gate = bundlesGateView(access, waitingForPull || refreshing);');
    expect(list).toContain(
      'const body = allowed ? bundlesListBody(read, rows.length, refreshing, pulling) : { spinner: gate.spinner && !pulling, words: null, staleNote: false };',
    );
    expect(list).toContain(
      '{gate.words ? ( <Body muted style={styles.empty}> {gate.words} </Body> ) : null}',
    );
    expect(list).toContain('{(allowed ? rows : []).map((b) => (');
    expect(list).toMatch(/\{gate\.refresh !== null \? \( <Pressable onPress=\{refresh\}/);
  });
});

describe('a bundle', () => {
  it("asks useDrawerEntryAccess('/bundles') before it reads the phone's kits", () => {
    const detail = code(DETAIL);
    expect(detail).toContain("const access = useDrawerEntryAccess('/bundles');");
    expect(detail).toMatch(/if \(!id \|\| access !== 'allowed'\) return;/);
    expect(detail).toMatch(/\}, \[id, access\]\);/);
  });

  it('draws the gate words in place of the bundle, with Try again when the saved access was unreadable', () => {
    const detail = code(DETAIL);
    expect(detail).toContain("if (!bundle || access !== 'allowed') {");
    expect(detail).toContain('const gate = bundlesGateView(access, waitingForPull);');
    expect(detail).toContain(
      "const state = access === 'allowed' ? bundleScreenState(bundle, looked || !id, failedRead === 'bundle') : gate.words !== null ? 'gate' : 'loading';",
    );
    expect(detail).toContain(
      '{state === \'gate\' ? ( <View style={[styles.body, lg && GLASS_OPS.scroll]}> <Card padding={16}> <Body size={14.5} accessibilityRole="alert"> {gate.words} </Body>',
    );
    // The gap the file already uses between a card's text and its button
    // (Distribute).
    expect(detail).toContain(
      '{gate.refresh === \'reread\' ? ( <Button variant="outline" onPress={() => void retrySavedAccess()} style={{ marginTop: space.md }} > Try again </Button> ) : null}',
    );
  });
});

describe('the words', () => {
  it('are the shared sentences', async () => {
    const access = await import('./screen-access');
    expect(access.BUNDLES_NOT_AVAILABLE).toBe(BUNDLES_NOT_AVAILABLE);
    expect(access.NOT_SYNCED_YET).toBe(NOT_SYNCED_YET);
  });
});

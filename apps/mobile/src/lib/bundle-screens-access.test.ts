import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { screenFunction } from './__fixtures__/screen-functions';

/**
 * THE BUNDLE SCREENS OPEN ONLY FOR A MEMBER THE SIDE MENU OFFERS BUNDLES TO
 * (S75).
 *
 * The side menu lists Bundles only with the bundles module on and
 * bundles:read or bundles:distribute held. The Bundles list and a bundle
 * read the kits saved on this phone, and a deep link or the Home card opened
 * them for anyone. Both now ask the menu's own rule (screen-access.ts
 * drawerEntryAccess): nothing is read before it is known, and a member who
 * may not is told that bundles are not available, with no Refresh to press.
 */

const LIST = 'app/bundles/index.tsx';
const DETAIL = 'app/bundles/[id].tsx';
const BUNDLES_NOT_AVAILABLE = 'Bundles are not available to you in this workspace.';

const code = (file: string) =>
  readFileSync(path.resolve(__dirname, '../..', file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s+/g, ' ');

describe('the Bundles list', () => {
  it("asks useDrawerEntryAccess('/bundles') and reads the phone's kits only when allowed", () => {
    const list = code(LIST);
    expect(list).toContain("const access = useDrawerEntryAccess('/bundles');");
    expect(list).toContain("const allowed = access === 'allowed';");
    expect(list).toMatch(/if \(allowed\) void load\(\); \}, \[load, allowed\]\);/);
  });

  it('Refresh (and so a pull) syncs and reads nothing for a member who may not', async () => {
    const syncNow = vi.fn(async () => undefined);
    const load = vi.fn(async () => undefined);
    const setRefreshing = vi.fn();
    for (const [allowed, calls] of [
      [false, 0],
      [true, 1],
    ] as const) {
      syncNow.mockClear();
      load.mockClear();
      const refresh = screenFunction<() => Promise<void>>(LIST, 'refresh', {
        allowed,
        syncNow,
        load,
        setRefreshing,
      });
      await refresh();
      expect(syncNow).toHaveBeenCalledTimes(calls);
      expect(load).toHaveBeenCalledTimes(calls);
    }
  });

  it('says bundles are not available, shows no rows and no Refresh, and spins only while unknown', () => {
    const list = code(LIST);
    expect(list).toContain(
      "{access === 'denied' ? ( <Body muted style={styles.empty}> {BUNDLES_NOT_AVAILABLE} </Body> ) : null}",
    );
    expect(list).toContain(
      "const body = allowed ? bundlesListBody(read, rows.length, refreshing, pulling) : { spinner: access === 'unknown', words: null, staleNote: false };",
    );
    expect(list).toContain('{(allowed ? rows : []).map((b) => (');
    expect(list).toMatch(/\{allowed \? \( <Pressable onPress=\{refresh\}/);
  });
});

describe('a bundle', () => {
  it("asks useDrawerEntryAccess('/bundles') before it reads the phone's kits", () => {
    const detail = code(DETAIL);
    expect(detail).toContain("const access = useDrawerEntryAccess('/bundles');");
    expect(detail).toMatch(/if \(!id \|\| access !== 'allowed'\) return;/);
    expect(detail).toMatch(/\}, \[id, access\]\);/);
  });

  it('shows the not-available words to a member who may not, never the bundle', () => {
    const detail = code(DETAIL);
    expect(detail).toContain("if (!bundle || access !== 'allowed') {");
    expect(detail).toContain(
      "const state = access === 'denied' ? 'denied' : bundleScreenState(bundle, looked || !id, failedRead === 'bundle');",
    );
    expect(detail).toContain(
      "{state === 'denied' ? ( <View style={[styles.body, lg && GLASS_OPS.scroll]}> <Card padding={16}> <Body size={14.5} accessibilityRole=\"alert\"> {BUNDLES_NOT_AVAILABLE} </Body>",
    );
  });
});

describe('the words', () => {
  it('are the shared sentence', async () => {
    vi.doMock('./nav-icons', () => ({ NAV_ICONS: {} }));
    const access = await import('./screen-access');
    expect((access as Record<string, unknown>).BUNDLES_NOT_AVAILABLE).toBe(BUNDLES_NOT_AVAILABLE);
  });
});

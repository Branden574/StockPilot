import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { FakeStorage } from './__fixtures__/fake-storage';
import { createAppearanceController } from './controller';
import { RECOVERY_ACTION_LABEL } from './labels';
import { isGlassStored, markCrashFallback, recoverToClassicInStorage } from './recovery';
import { PHONE_APPEARANCE_KEYS as KEYS } from './store';

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() },
}));

/**
 * Always able to switch back (plan 5.6): the error boundary's "Use classic
 * appearance" and the one-time crash fallback, against storage alone (the
 * boundary must work when the appearance layer is what threw).
 */

const glassDevice = JSON.stringify({ v: 1, mode: 'liquid-glass', lastClassic: 'dark' });
const sync = JSON.stringify({
  v: 1,
  userId: 'user-a',
  dirty: false,
  syncedAt: '2026-11-01T10:00:00Z',
});

describe('the crash fallback flag', () => {
  it('is set after a crash only when Liquid Glass is stored and this build can show it', async () => {
    const glass = new FakeStorage({ [KEYS.device]: glassDevice });
    expect(await markCrashFallback(glass, true)).toBe(true);
    expect(glass.data.get(KEYS.fallback)).toBe('1');
    // The stored choice is untouched: a passing fault never switches anyone for good.
    expect(glass.json(KEYS.device)).toMatchObject({ mode: 'liquid-glass' });

    const classic = new FakeStorage({
      [KEYS.device]: JSON.stringify({ v: 1, mode: 'dark', lastClassic: 'dark' }),
    });
    expect(await markCrashFallback(classic, true)).toBe(false);
    expect(classic.data.has(KEYS.fallback)).toBe(false);

    const flagOff = new FakeStorage({ [KEYS.device]: glassDevice });
    expect(await markCrashFallback(flagOff, false)).toBe(false);
    expect(await isGlassStored(new FakeStorage(), true)).toBe(false);
  });
});

describe('"Use classic appearance"', () => {
  it("returns the phone to the person's previous classic look and owes the account a save", async () => {
    const storage = new FakeStorage({
      [KEYS.device]: glassDevice,
      [KEYS.sync]: sync,
      [KEYS.fallback]: '1',
      'workspace.activeOrgId': 'org-1',
    });
    expect(await recoverToClassicInStorage(storage)).toBe('dark');
    expect(storage.json(KEYS.device)).toEqual({ v: 1, mode: 'dark', lastClassic: 'dark' });
    expect(storage.json(KEYS.sync)).toMatchObject({ userId: 'user-a', dirty: true });
    expect(storage.data.has(KEYS.fallback)).toBe(false);
    expect([...storage.touched].sort()).toEqual([KEYS.device, KEYS.fallback, KEYS.sync].sort());
    expect(storage.data.get('workspace.activeOrgId')).toBe('org-1');
  });

  it('with no record at all it is System, and no sync record is invented', async () => {
    const storage = new FakeStorage();
    expect(await recoverToClassicInStorage(storage)).toBe('system');
    expect(storage.data.has(KEYS.sync)).toBe(false);
  });

  it('after the reload the phone opens classic and saves the change to the account', async () => {
    const storage = new FakeStorage({ [KEYS.device]: glassDevice, [KEYS.sync]: sync });
    await recoverToClassicInStorage(storage);
    const saves: string[] = [];
    const controller = createAppearanceController({
      storage,
      account: {
        fetch: async () => ({ ok: true, row: null }),
        save: async (_userId, mode) => {
          saves.push(mode);
          return { ok: true, row: { appearance: mode, updated_at: '2026-11-02T21:00:00Z' } };
        },
      },
      now: () => Date.parse('2026-11-02T21:00:00Z'),
      glassEnabled: true,
    });
    await controller.hydrate();
    expect(controller.getSnapshot().effective).toBe('dark');
    controller.setSession('user-a');
    await new Promise((r) => setTimeout(r, 0));
    expect(saves).toEqual(['dark']);
    expect(controller.getSnapshot().state.status).toBe('synced');
  });
});

describe('the error boundary offers the way back only in Liquid Glass', () => {
  const src = readFileSync(
    path.resolve(__dirname, '../../components/error-boundary.tsx'),
    'utf8',
  ).replace(/\s+/g, ' ');

  it('shows the action under `this.state.glass`, which only storage sets, after the crash is reported', () => {
    expect(RECOVERY_ACTION_LABEL).toBe('Use classic appearance');
    expect(src).toContain('{this.state.glass ? ( <Pressable');
    expect(src).toContain('{RECOVERY_ACTION_LABEL}');
    expect(src).toContain('state: State = { error: null, glass: false };');
    expect(src).toContain('return { error, glass: false };');
    expect(src).toContain(
      'void markCrashFallback(asyncStorageAppearance, isLiquidGlassEnabled()) .then((glass) => { if (glass) this.setState({ glass: true }); })',
    );
    expect(src).toContain(
      'const classic = await recoverToClassicInStorage(asyncStorageAppearance);',
    );
    expect(src).toContain('tags: { appearance: appearanceTag() },');
  });

  it('never reads the provider or a hook: storage and the controller, if it still answers', () => {
    for (const leak of [
      'useAppearance',
      'appearance/provider',
      'appearance/context',
      'useContext',
    ]) {
      expect(src, leak).not.toContain(leak);
    }
    expect(src).toContain('peekAppearanceController()');
  });
});

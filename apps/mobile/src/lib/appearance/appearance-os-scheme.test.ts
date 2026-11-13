import type { ThemeSetting } from '@stockpilot/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const setColorScheme = vi.fn();
vi.mock('react-native', () => ({ Appearance: { setColorScheme } }));

/**
 * A fixed Light or Dark Theme tells the OS the app's scheme in BOTH Designs
 * (item 34: osSchemeFor(theme), no longer by appearance), so what the OS draws
 * for the app (Alert.alert dialogs, the keyboard, pickers, menus) matches the
 * screens: Night glass gets dark alerts and keyboards. System, or no Theme,
 * leaves the OS following the device, which is what useColorScheme() then
 * reports.
 */
async function fresh() {
  vi.resetModules();
  return import('./os-scheme');
}

beforeEach(() => setColorScheme.mockClear());

describe('the OS colour scheme', () => {
  it('Light and Dark are fixed; System and no Theme follow the device', async () => {
    const { osSchemeFor } = await fresh();
    const cases: [ThemeSetting | null, string][] = [
      ['dark', 'dark'],
      ['light', 'light'],
      ['system', 'unspecified'],
      [null, 'unspecified'],
    ];
    for (const [theme, scheme] of cases) expect(osSchemeFor(theme), String(theme)).toBe(scheme);
  });

  it('System and no Theme on a launch never call the OS at all (the off rollout: today’s phone)', async () => {
    const { applyOsScheme } = await fresh();
    applyOsScheme(null);
    applyOsScheme('system');
    applyOsScheme(null);
    expect(setColorScheme).not.toHaveBeenCalled();
  });

  it('a fixed Theme overrides the OS once, and leaving it hands the OS back to the device', async () => {
    const { applyOsScheme } = await fresh();
    applyOsScheme('dark');
    applyOsScheme('dark');
    expect(setColorScheme.mock.calls).toEqual([['dark']]);
    applyOsScheme('light');
    applyOsScheme('system');
    applyOsScheme(null);
    expect(setColorScheme.mock.calls).toEqual([['dark'], ['light'], ['unspecified']]);
  });

  it('an OS that refuses the call never breaks the appearance change', async () => {
    const { applyOsScheme } = await fresh();
    setColorScheme.mockImplementationOnce(() => {
      throw new Error('no native module');
    });
    expect(() => applyOsScheme('dark')).not.toThrow();
  });
});

import type { AppearanceMode } from '@stockpilot/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const setColorScheme = vi.fn();
vi.mock('react-native', () => ({ Appearance: { setColorScheme } }));

/**
 * Fixed Dark and Light tell the OS the app's scheme, so what the OS draws for
 * the app (Alert.alert dialogs, the keyboard, pickers, menus) matches the
 * screens; System and Liquid Glass leave the OS following the device, which
 * is what useColorScheme() then reports.
 */
async function fresh() {
  vi.resetModules();
  return import('./os-scheme');
}

beforeEach(() => setColorScheme.mockClear());

describe('the OS colour scheme', () => {
  it('Dark and Light are fixed; System and Liquid Glass follow the device', async () => {
    const { osSchemeFor } = await fresh();
    const cases: [AppearanceMode, string][] = [
      ['dark', 'dark'],
      ['light', 'light'],
      ['system', 'unspecified'],
      ['liquid-glass', 'unspecified'],
    ];
    for (const [mode, scheme] of cases) expect(osSchemeFor(mode), mode).toBe(scheme);
  });

  it('classic System and Liquid Glass on a launch never call the OS at all', async () => {
    const { applyOsScheme } = await fresh();
    applyOsScheme('system');
    applyOsScheme('liquid-glass');
    applyOsScheme('system');
    expect(setColorScheme).not.toHaveBeenCalled();
  });

  it('a fixed choice overrides the OS once, and leaving it hands the OS back to the device', async () => {
    const { applyOsScheme } = await fresh();
    applyOsScheme('dark');
    applyOsScheme('dark');
    expect(setColorScheme.mock.calls).toEqual([['dark']]);
    applyOsScheme('light');
    applyOsScheme('liquid-glass');
    applyOsScheme('system');
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

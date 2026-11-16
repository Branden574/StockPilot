import { describe, expect, it } from 'vitest';

import {
  ICON_LAUNCH_GROUND,
  LAST_ICON_LAUNCH_RUNTIME,
  launchLookFor,
  PLAIN_LAUNCH_GROUND,
  type LaunchLook,
} from './launch-look';
import { palette } from './theme';

describe('launchLookFor', () => {
  const table: [string | null | undefined, LaunchLook][] = [
    ['1.4.0', 'icon'],
    ['1.3.0', 'icon'],
    ['1.0.3', 'icon'],
    ['0.9.9', 'icon'],
    ['1.4.1', 'ground'],
    ['1.5.0', 'ground'],
    ['1.10.0', 'ground'],
    ['2.0.0', 'ground'],
    // expo-updates not running (it reports ''), or no value at all.
    [undefined, 'ground'],
    [null, 'ground'],
    ['', 'ground'],
    // Not three dot-separated numbers.
    ['1.4', 'ground'],
    ['1.4.0-beta', 'ground'],
    [' 1.4.0', 'ground'],
    ['v1.4.0', 'ground'],
    ['abc', 'ground'],
  ];

  it.each(table)('%j -> %s', (runtimeVersion, look) => {
    expect(launchLookFor(runtimeVersion)).toBe(look);
  });

  it('keeps the icon look for the last binary built with it', () => {
    expect(LAST_ICON_LAUNCH_RUNTIME).toBe('1.4.0');
  });

  it('has the two grounds of the two launch screens', () => {
    expect(ICON_LAUNCH_GROUND).toBe('#0a0f1f');
    expect(PLAIN_LAUNCH_GROUND).toBe(palette('dark').paper);
  });
});

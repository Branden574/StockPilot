import { APPEARANCE_MODES, type AppearanceMode } from '@stockpilot/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CLASSIC_FONT,
  GLASS_DAY,
  GLASS_DAY_OPAQUE,
  GLASS_FONT,
  GLASS_NIGHT,
  GLASS_NIGHT_OPAQUE,
  palette,
} from '../theme';
import { useTheme } from '../use-theme';
import { GLASS_TOKENS } from './glass-tokens.generated';
import { themeValueFor } from './theme-value';

/**
 * useTheme() (plan 5.1): the same signature and, in classic, exactly today's
 * values; one object per state, so memoised rows keep stable references; the
 * colour scheme never anything but light or dark.
 *
 * The suite has no React renderer: react-native's useColorScheme and the
 * appearance context are stand-ins, and useTheme() is called as a function.
 */
const env = vi.hoisted(() => ({
  scheme: 'light' as 'light' | 'dark' | null,
  appearance: null as null | { appearance: AppearanceMode; material: 'glass' | 'blur' | 'opaque' },
}));
vi.mock('react-native', () => ({ useColorScheme: () => env.scheme }));
vi.mock('./context', () => ({ useAppearanceTheme: () => env.appearance }));

// Called as a plain function: there is no renderer here (the hook only reads
// the two stand-ins above), so the hook rules do not apply to this harness.
const readTheme = useTheme;

beforeEach(() => {
  env.scheme = 'light';
  env.appearance = null;
});

describe('classic is exactly today', () => {
  it('outside the provider: System, following the device, today’s palettes', () => {
    for (const scheme of ['light', 'dark', null] as const) {
      env.scheme = scheme;
      const t = readTheme();
      const mode = scheme === 'dark' ? 'dark' : 'light';
      expect(t.mode).toBe(mode);
      expect(t.c).toBe(palette(mode));
      expect(t).toMatchObject({
        style: 'classic',
        material: 'opaque',
        g: null,
        ios: null,
        type: null,
      });
      expect(t.font).toBe(CLASSIC_FONT);
    }
  });

  it('System follows the device; Dark and Light are fixed whatever the device says', () => {
    for (const scheme of ['light', 'dark'] as const) {
      env.scheme = scheme;
      env.appearance = { appearance: 'system', material: 'opaque' };
      expect(readTheme().c).toBe(palette(scheme));
      env.appearance = { appearance: 'dark', material: 'opaque' };
      expect(readTheme().c).toBe(palette('dark'));
      env.appearance = { appearance: 'light', material: 'opaque' };
      expect(readTheme().c).toBe(palette('light'));
    }
  });

  it('classic ignores the material (Reduce Transparency changes nothing in classic)', () => {
    for (const material of ['glass', 'blur', 'opaque'] as const) {
      expect(themeValueFor('dark', 'dark', material)).toBe(themeValueFor('dark', 'dark', 'opaque'));
    }
  });
});

describe('Liquid Glass', () => {
  it('follows the device for Day or Night glass (plan D3)', () => {
    env.appearance = { appearance: 'liquid-glass', material: 'glass' };
    env.scheme = 'light';
    expect(readTheme()).toMatchObject({ mode: 'light', c: GLASS_DAY, style: 'liquid-glass' });
    env.scheme = 'dark';
    expect(readTheme()).toMatchObject({ mode: 'dark', c: GLASS_NIGHT, style: 'liquid-glass' });
  });

  it('the opaque material takes the opaque palettes; glass and blur the translucent ones', () => {
    expect(themeValueFor('liquid-glass', 'light', 'opaque').c).toBe(GLASS_DAY_OPAQUE);
    expect(themeValueFor('liquid-glass', 'dark', 'opaque').c).toBe(GLASS_NIGHT_OPAQUE);
    expect(themeValueFor('liquid-glass', 'light', 'blur').c).toBe(GLASS_DAY);
    expect(themeValueFor('liquid-glass', 'dark', 'glass').c).toBe(GLASS_NIGHT);
    expect(themeValueFor('liquid-glass', 'dark', 'opaque').g).toBe(GLASS_TOKENS.nightOpaque);
    expect(themeValueFor('liquid-glass', 'light', 'glass').font).toBe(GLASS_FONT);
  });
});

describe('one object per state', () => {
  it('the same reference every call for the same state, a different one when the look changes', () => {
    env.appearance = { appearance: 'liquid-glass', material: 'blur' };
    const a = readTheme();
    expect(readTheme()).toBe(a);
    env.appearance = { appearance: 'liquid-glass', material: 'opaque' };
    expect(readTheme()).not.toBe(a);
    env.appearance = { appearance: 'liquid-glass', material: 'blur' };
    expect(readTheme()).toBe(a);
  });

  it('every state is frozen, and the colour scheme is only ever light or dark', () => {
    for (const appearance of APPEARANCE_MODES) {
      for (const mode of ['light', 'dark'] as const) {
        for (const material of ['glass', 'blur', 'opaque'] as const) {
          const t = themeValueFor(appearance, mode, material);
          expect(Object.isFrozen(t)).toBe(true);
          expect(['light', 'dark']).toContain(t.mode);
          expect(t.appearance).toBe(appearance);
        }
      }
    }
  });
});

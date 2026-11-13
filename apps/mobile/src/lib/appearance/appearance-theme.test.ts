import { APPEARANCE_STYLES, type AppearanceStyle, type ThemeSetting } from '@stockpilot/core';
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
 * useTheme() (plan 5.1, revision R1/R2): the same signature and, in classic,
 * exactly today's values; one object per state, so memoised rows keep stable
 * references; the colour scheme never anything but light or dark. The Design
 * and the Theme are separate: Light gives Day glass and Dark Night glass,
 * System (or no Theme) follows the device.
 *
 * The suite has no React renderer: react-native's useColorScheme and the
 * appearance context are stand-ins, and useTheme() is called as a function.
 */
const env = vi.hoisted(() => ({
  scheme: 'light' as 'light' | 'dark' | null,
  appearance: null as null | {
    style: AppearanceStyle;
    theme: ThemeSetting | null;
    material: 'glass' | 'blur' | 'opaque';
    scene: boolean;
  },
}));
const look = (
  style: AppearanceStyle,
  theme: ThemeSetting | null,
  material: 'glass' | 'blur' | 'opaque' = 'opaque',
  scene = false,
) => ({ style, theme, material, scene });
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
        scene: false,
        g: null,
        ios: null,
        type: null,
      });
      expect(t.font).toBe(CLASSIC_FONT);
    }
  });

  it('System (or no Theme) follows the device; Dark and Light are fixed whatever the device says', () => {
    for (const scheme of ['light', 'dark'] as const) {
      env.scheme = scheme;
      env.appearance = look('classic', 'system');
      expect(readTheme().c).toBe(palette(scheme));
      env.appearance = look('classic', null);
      expect(readTheme().c).toBe(palette(scheme));
      env.appearance = look('classic', 'dark');
      expect(readTheme().c).toBe(palette('dark'));
      env.appearance = look('classic', 'light');
      expect(readTheme().c).toBe(palette('light'));
    }
  });

  it('classic ignores the material and the scene (Reduce Transparency changes nothing in classic)', () => {
    for (const material of ['glass', 'blur', 'opaque'] as const) {
      for (const scene of [true, false]) {
        expect(themeValueFor('classic', 'dark', material, scene)).toBe(
          themeValueFor('classic', 'dark', 'opaque', false),
        );
      }
    }
  });
});

describe('Liquid Glass', () => {
  it('Light gives Day glass and Dark Night glass, whatever the device says (revision R1)', () => {
    for (const scheme of ['light', 'dark'] as const) {
      env.scheme = scheme;
      env.appearance = look('liquid-glass', 'light', 'glass', true);
      expect(readTheme()).toMatchObject({ mode: 'light', c: GLASS_DAY, style: 'liquid-glass' });
      env.appearance = look('liquid-glass', 'dark', 'glass', true);
      expect(readTheme()).toMatchObject({ mode: 'dark', c: GLASS_NIGHT, style: 'liquid-glass' });
    }
  });

  it('System, or a Theme never chosen, follows the device for Day or Night glass', () => {
    for (const theme of ['system', null] as const) {
      env.appearance = look('liquid-glass', theme, 'glass', true);
      env.scheme = 'light';
      expect(readTheme()).toMatchObject({ mode: 'light', c: GLASS_DAY });
      env.scheme = 'dark';
      expect(readTheme()).toMatchObject({ mode: 'dark', c: GLASS_NIGHT });
    }
  });

  it('the opaque material takes the opaque palettes; glass and blur the translucent ones', () => {
    expect(themeValueFor('liquid-glass', 'light', 'opaque', false).c).toBe(GLASS_DAY_OPAQUE);
    expect(themeValueFor('liquid-glass', 'dark', 'opaque', false).c).toBe(GLASS_NIGHT_OPAQUE);
    expect(themeValueFor('liquid-glass', 'light', 'blur', true).c).toBe(GLASS_DAY);
    expect(themeValueFor('liquid-glass', 'dark', 'glass', true).c).toBe(GLASS_NIGHT);
    expect(themeValueFor('liquid-glass', 'dark', 'opaque', false).g).toBe(GLASS_TOKENS.nightOpaque);
    expect(themeValueFor('liquid-glass', 'light', 'glass', true).font).toBe(GLASS_FONT);
  });

  it('a low-end phone: opaque palette, scene photo kept (revision R9)', () => {
    const t = themeValueFor('liquid-glass', 'dark', 'opaque', true);
    expect(t).toMatchObject({ c: GLASS_NIGHT_OPAQUE, material: 'opaque', scene: true });
    expect(t).not.toBe(themeValueFor('liquid-glass', 'dark', 'opaque', false));
  });
});

describe('one object per state', () => {
  it('the same reference every call for the same state, a different one when the look changes', () => {
    env.appearance = look('liquid-glass', null, 'blur', true);
    const a = readTheme();
    expect(readTheme()).toBe(a);
    env.appearance = look('liquid-glass', null, 'opaque', false);
    expect(readTheme()).not.toBe(a);
    env.appearance = look('liquid-glass', null, 'blur', true);
    expect(readTheme()).toBe(a);
    // The Theme matters only through the scheme it resolves to.
    env.scheme = 'light';
    env.appearance = look('liquid-glass', 'light', 'blur', true);
    expect(readTheme()).toBe(a);
  });

  it('every state is frozen, and the colour scheme is only ever light or dark', () => {
    for (const style of APPEARANCE_STYLES) {
      for (const mode of ['light', 'dark'] as const) {
        for (const material of ['glass', 'blur', 'opaque'] as const) {
          for (const scene of [true, false]) {
            const t = themeValueFor(style, mode, material, scene);
            expect(Object.isFrozen(t)).toBe(true);
            expect(['light', 'dark']).toContain(t.mode);
            expect(t.style).toBe(style);
          }
        }
      }
    }
  });
});

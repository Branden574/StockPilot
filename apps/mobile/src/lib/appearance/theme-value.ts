import { styleOf, type AppearanceMode, type AppearanceStyle } from '@stockpilot/core';

import {
  CLASSIC_FONT,
  GLASS_FONT,
  GLASS_TYPE,
  glassPalette,
  glassTokens,
  palette,
  type FontSet,
  type GlassTypeScale,
  type Palette,
  type ThemeMode,
} from '../theme';
import { GLASS_IOS_TOKENS, type GlassIosTokens, type GlassTokens } from './glass-tokens.generated';
import { isOpaqueMaterial, type GlassMaterial } from './material';

/**
 * What useTheme() returns (plan 5.1). The classic fields keep their meaning:
 *   mode  'light' | 'dark', the colour scheme only. Never 'liquid-glass': the
 *         StatusBar, the ~30 scrims that branch on it, BlurView tints and
 *         GlassView's colorScheme all get a scheme they understand.
 *   c     the palette. In classic it is exactly palette(mode), the same two
 *         objects as ever.
 * and Liquid Glass adds:
 *   appearance  the appearance being shown (after the kill switch and the crash fallback);
 *   style       'classic' | 'liquid-glass';
 *   material    'glass' | 'blur' | 'opaque' (always 'opaque' in classic);
 *   g           the glass material tokens (glass, glassStrong, chrome, scrim, fields...), null in classic;
 *   ios         the iOS boards' component palette (grouped-list card, separators), null in classic;
 *   font        the six faces by role (classic: today's families; glass: the system face);
 *   type        the glass type scale, null in classic.
 */
export interface ThemeValue {
  readonly mode: ThemeMode;
  readonly c: Palette;
  readonly appearance: AppearanceMode;
  readonly style: AppearanceStyle;
  readonly material: GlassMaterial;
  readonly g: GlassTokens | null;
  readonly ios: GlassIosTokens | null;
  readonly font: FontSet;
  readonly type: GlassTypeScale | null;
}

const cache = new Map<string, ThemeValue>();

/**
 * The theme for one state, as ONE object per (appearance, scheme, material):
 * the same reference every time that state comes round, so a component that
 * memoises on the theme, or on `c`, re-renders only when the look really
 * changed. Classic ignores the material entirely (6 objects in all).
 */
export function themeValueFor(
  appearance: AppearanceMode,
  mode: ThemeMode,
  material: GlassMaterial,
): ThemeValue {
  const style = styleOf(appearance);
  const effectiveMaterial: GlassMaterial = style === 'classic' ? 'opaque' : material;
  const key = `${appearance}|${mode}|${effectiveMaterial}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const opaque = isOpaqueMaterial(effectiveMaterial);
  const value: ThemeValue =
    style === 'classic'
      ? Object.freeze({
          mode,
          c: palette(mode),
          appearance,
          style,
          material: effectiveMaterial,
          g: null,
          ios: null,
          font: CLASSIC_FONT,
          type: null,
        })
      : Object.freeze({
          mode,
          c: glassPalette(mode, opaque),
          appearance,
          style,
          material: effectiveMaterial,
          g: glassTokens(mode, opaque),
          ios: GLASS_IOS_TOKENS[mode],
          font: GLASS_FONT,
          type: GLASS_TYPE,
        });
  cache.set(key, value);
  return value;
}

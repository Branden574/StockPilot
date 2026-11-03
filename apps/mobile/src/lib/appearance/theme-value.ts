import type { AppearanceStyle } from '@stockpilot/core';

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
 *   style       the Design drawn, 'classic' | 'liquid-glass' (after the rollout,
 *               the crash fallback and a held adoption);
 *   material    'glass' | 'blur' | 'opaque' (always 'opaque' in classic);
 *   scene       the pre-blurred scene photo is drawn behind the content (never in classic);
 *   g           the glass material tokens (glass, glassStrong, chrome, scrim, fields...), null in classic;
 *   ios         the iOS boards' component palette (grouped-list card, separators), null in classic;
 *   font        the six faces by role (classic: today's families; glass: the system face);
 *   type        the glass type scale, null in classic.
 */
export interface ThemeValue {
  readonly mode: ThemeMode;
  readonly c: Palette;
  readonly style: AppearanceStyle;
  readonly material: GlassMaterial;
  readonly scene: boolean;
  readonly g: GlassTokens | null;
  readonly ios: GlassIosTokens | null;
  readonly font: FontSet;
  readonly type: GlassTypeScale | null;
}

const cache = new Map<string, ThemeValue>();

/**
 * The theme for one state, as ONE object per (Design drawn, resolved scheme,
 * material, scene; item 33): the same reference every time that state comes
 * round, so a component that memoises on the theme, or on `c`, re-renders
 * only when the look really changed. The Theme setting itself is not part of
 * it: Light and a light device are the same look. Classic ignores the
 * material and the scene entirely (2 objects, exactly today's palettes).
 */
export function themeValueFor(
  style: AppearanceStyle,
  mode: ThemeMode,
  material: GlassMaterial,
  scene: boolean,
): ThemeValue {
  const classic = style === 'classic';
  const effectiveMaterial: GlassMaterial = classic ? 'opaque' : material;
  const effectiveScene = classic ? false : scene;
  const key = `${style}|${mode}|${effectiveMaterial}|${effectiveScene}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const opaque = isOpaqueMaterial(effectiveMaterial);
  const value: ThemeValue = classic
    ? Object.freeze({
        mode,
        c: palette(mode),
        style,
        material: effectiveMaterial,
        scene: false,
        g: null,
        ios: null,
        font: CLASSIC_FONT,
        type: null,
      })
    : Object.freeze({
        mode,
        c: glassPalette(mode, opaque),
        style,
        material: effectiveMaterial,
        scene: effectiveScene,
        g: glassTokens(mode, opaque),
        ios: GLASS_IOS_TOKENS[mode],
        font: GLASS_FONT,
        type: GLASS_TYPE,
      });
  cache.set(key, value);
  return value;
}

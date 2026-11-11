import type { AppearanceStyle } from '@stockpilot/core';

import type { ThemeMode } from '../theme';
import type { GlassMaterial } from './material';
import { themeValueFor, type ThemeValue } from './theme-value';

/**
 * The bottom bar's geometry per style, and the height it reports
 * (plan 5.2 "Tab bar geometry").
 *
 * Every list screen pads by useBottomTabBarHeight() + 24, DataListScreen by
 * BottomTabBarHeightContext, and the count select bar sits at tabBarHeight +
 * 12 ((tabs)/_layout.tsx). So whatever the bar looks like, it reports the
 * footprint it actually draws, measured from the bottom edge of the screen.
 *
 *   classic          today's bar, unchanged: absolute, 84 iOS / 72 Android.
 *   glass on iOS     the IosTabBar board (sp.css:729-736): a floating capsule
 *                    left 16, right 88 (16 with no Scan slot), bottom 22,
 *                    height 64, radius 32, tabs 54 tall radius 27, and a
 *                    separate 64 pt Scan circle at right 16, bottom 22. The
 *                    same geometry for the glass, blur (solid fallback) and
 *                    opaque materials. Footprint 64 + 22 = 86. The board's 22
 *                    is measured from the bottom edge of the 390x844 screen and
 *                    is used as drawn; the simulator walk checks it clears the
 *                    home indicator, and any adjustment is recorded there.
 *   glass on Android the AndroidNav board (sp.css:851-856): an 80 dp Material 3
 *                    bar plus the bottom safe-area inset, opaque.
 */

export const CLASSIC_TAB_BAR = {
  ios: { height: 84, paddingBottom: 24 },
  android: { height: 72, paddingBottom: 14 },
} as const;

export const GLASS_IOS_TAB_BAR = {
  left: 16,
  /** Right edge of the capsule when the Scan circle is beside it. */
  rightWithScan: 88,
  /** Right edge of the capsule when no Scan slot is chosen. */
  right: 16,
  bottom: 22,
  height: 64,
  radius: 32,
  paddingHorizontal: 5,
  tabHeight: 54,
  tabRadius: 27,
  iconSize: 24,
  labelGap: 2,
  scanSize: 64,
  scanRight: 16,
  scanIconSize: 28,
  /** GlassContainer spacing around the capsule and the Scan circle (Handoff recipe). */
  containerSpacing: 8,
} as const;

export const GLASS_ANDROID_TAB_BAR = {
  height: 80,
  paddingTop: 12,
  paddingBottom: 16,
  indicatorWidth: 64,
  indicatorHeight: 32,
  indicatorRadius: 16,
  iconSize: 24,
  gap: 4,
} as const;

export interface TabBarFootprintInputs {
  style: AppearanceStyle;
  os: string;
  /** The bottom safe-area inset (used by the Android glass bar only). */
  bottomInset: number;
  material?: GlassMaterial;
}

/** The height the bar reports through BottomTabBarHeightContext. */
export function tabBarFootprint({ style, os, bottomInset }: TabBarFootprintInputs): number {
  if (style === 'classic') {
    return os === 'ios' ? CLASSIC_TAB_BAR.ios.height : CLASSIC_TAB_BAR.android.height;
  }
  if (os === 'ios') return GLASS_IOS_TAB_BAR.height + GLASS_IOS_TAB_BAR.bottom;
  return GLASS_ANDROID_TAB_BAR.height + Math.max(0, bottomInset);
}

/** Which bar the tabs layout draws. */
export type TabBarKind = 'classic' | 'glass-ios' | 'material-android';

export function tabBarKind(style: AppearanceStyle, os: string): TabBarKind {
  if (style === 'classic') return 'classic';
  return os === 'ios' ? 'glass-ios' : 'material-android';
}

/** The capsule's right edge: room for the Scan circle only when Scan is in the bar. */
export function glassCapsuleRight(hasScan: boolean): number {
  return hasScan ? GLASS_IOS_TAB_BAR.rightWithScan : GLASS_IOS_TAB_BAR.right;
}

/** The colours and scheme the iOS glass bar draws with. */
export interface GlassTabBarLook {
  /** The scheme the capsule's glass (or its solid fallback) is drawn in. */
  scheme: ThemeMode;
  /** Icons and labels of the tabs that are not selected. */
  ink: string;
  /** The selected tab, and the Scan glyph on glass. */
  accentText: string;
  /** The selected Scan circle's fill and the glyph on it. */
  accent: string;
  onAccent: string;
  /** A fill laid inside the capsule, under the tabs; null for none. */
  cameraFill: string | null;
}

/**
 * The bar's look (LG-1). Everywhere but over the Scan camera it is the
 * theme's own, unchanged. Over the camera the page is dark in every scheme
 * and the small capsule's system glass goes dark with it, so the bar draws
 * the Night look: Night ink and accent, the Night scheme for the surface, and
 * on the glass material the Night sheet fill (--glass-strong, ink at 70%)
 * inside the capsule. The fill is what makes the words independent of the
 * glass: pointed at something bright the glass may turn light again, and the
 * Night ink still reads at 5.5:1 on the fill over white (16.6:1 over black).
 * The solid and opaque bars are already a fixed colour and take no fill.
 */
export function glassTabBarLook(theme: ThemeValue, overCamera: boolean): GlassTabBarLook {
  const t = overCamera ? themeValueFor(theme.style, 'dark', theme.material, theme.scene) : theme;
  return {
    scheme: t.mode,
    ink: t.c.ink,
    accentText: t.g?.accentText ?? t.c.accent,
    accent: t.g?.accent ?? t.c.accent,
    onAccent: t.g?.onAccent ?? t.c.accentInk,
    cameraFill: overCamera && t.material === 'glass' && t.g ? t.g.glassStrong : null,
  };
}

import type * as React from 'react';
import { Platform, type ViewProps } from 'react-native';

import { GLASS_MIN_IOS, iosMajor } from './ios-version';

/**
 * THE ONLY FILE THAT LOADS expo-glass-effect (plan 5.5, review R21).
 *
 * expo-glass-effect 57.0.3's GlassView.ios.js calls
 * `requireNativeViewManager('ExpoGlassEffect', 'GlassView')` at module top
 * level, so an ordinary `import { GlassView } from 'expo-glass-effect'` would
 * try to resolve the native view the moment the bundle loads, before any check
 * could run. A binary without the native module would then crash at launch
 * instead of falling back. So:
 *   - nothing imports the package statically (eslint no-restricted-imports /
 *     no-restricted-syntax in eslint.config.js, and glass-module.guard.test.ts);
 *   - this file asks `requireOptionalNativeModule('ExpoGlassEffect')` first
 *     (null, never a throw, when the module is absent), and only then
 *     `require('expo-glass-effect')`, inside a try, once (memoised);
 *   - it then checks `isGlassEffectAPIAvailable()` (some iOS 26 betas lack the
 *     API and crash) and `isLiquidGlassAvailable()`.
 * Any "no" or any throw gives null, and GlassSurface draws its BlurView or
 * opaque fallback instead.
 *
 * Evidence the module is in the shipped 1.4.0 iOS binary (not a runtime proof):
 * expo-router 57.0.21's native stack (build/fork/native-stack/
 * createNativeStackNavigator.js:38,46) requires expo-glass-effect and calls
 * isLiquidGlassAvailable() -> requireNativeModule('ExpoGlassEffect') at module
 * load, and the app's root Stack loads that file on every launch. The guarded
 * path stays regardless.
 */

/** GlassView's props as expo-glass-effect 57.0.3 declares them (GlassView.types.d.ts). */
export interface GlassViewProps extends ViewProps {
  glassEffectStyle?:
    | 'clear'
    | 'regular'
    | 'none'
    | { style: 'clear' | 'regular' | 'none'; animate?: boolean; animationDuration?: number };
  tintColor?: string;
  isInteractive?: boolean;
  colorScheme?: 'auto' | 'light' | 'dark';
}

export interface GlassContainerProps extends ViewProps {
  spacing?: number;
}

export interface GlassApi {
  GlassView: React.ComponentType<GlassViewProps>;
  GlassContainer: React.ComponentType<GlassContainerProps>;
}

/** The two loads, injectable so the absent and present paths are both tested. */
export interface GlassModuleLoader {
  /** expo's requireOptionalNativeModule('ExpoGlassEffect'): the native module, or null. */
  optionalNativeModule(): unknown;
  /** require('expo-glass-effect'). */
  requirePackage(): {
    GlassView?: unknown;
    GlassContainer?: unknown;
    isGlassEffectAPIAvailable?: () => boolean;
    isLiquidGlassAvailable?: () => boolean;
  };
}

export interface GlassPlatform {
  os: string;
  /** Platform.Version: a string such as '26.0' on iOS, a number on Android. */
  version: string | number;
}

/**
 * Pure resolution: the glass components, or null for every reason not to use
 * them (not iOS 26+, native module absent, package or check throws, API or
 * Liquid Glass unavailable).
 */
export function resolveGlassModule(
  loader: GlassModuleLoader,
  platform: GlassPlatform,
): GlassApi | null {
  if (platform.os !== 'ios' || iosMajor(platform.version) < GLASS_MIN_IOS) return null;
  try {
    if (!loader.optionalNativeModule()) return null;
    const glass = loader.requirePackage();
    if (
      typeof glass.isGlassEffectAPIAvailable !== 'function' ||
      !glass.isGlassEffectAPIAvailable()
    ) {
      return null;
    }
    if (typeof glass.isLiquidGlassAvailable !== 'function' || !glass.isLiquidGlassAvailable()) {
      return null;
    }
    if (!glass.GlassView || !glass.GlassContainer) return null;
    return {
      GlassView: glass.GlassView as GlassApi['GlassView'],
      GlassContainer: glass.GlassContainer as GlassApi['GlassContainer'],
    };
  } catch {
    return null;
  }
}

const defaultLoader: GlassModuleLoader = {
  optionalNativeModule() {
    // Lazily, so a test or a non-native runtime never loads expo's native glue.
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy on purpose (see the module note)
    const expo = require('expo') as { requireOptionalNativeModule: (name: string) => unknown };
    return expo.requireOptionalNativeModule('ExpoGlassEffect');
  },
  requirePackage() {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- the one guarded, lazy load of the package
    return require('expo-glass-effect');
  },
};

let memo: { api: GlassApi | null } | null = null;

/** The glass components on this device, or null (resolved once per JS runtime). */
export function getGlassModule(): GlassApi | null {
  if (memo === null) {
    memo = {
      api: resolveGlassModule(defaultLoader, { os: Platform.OS, version: Platform.Version }),
    };
  }
  return memo.api;
}

/** GlassView, or null when the device cannot draw it. */
export function GlassViewOrNull(): GlassApi['GlassView'] | null {
  return getGlassModule()?.GlassView ?? null;
}

/** GlassContainer, or null when the device cannot draw it. */
export function GlassContainerOrNull(): GlassApi['GlassContainer'] | null {
  return getGlassModule()?.GlassContainer ?? null;
}
